import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  ownerActivationResultSchema,
  ownerRecipientStatusSchema,
  type OwnerActivationResult,
  type OwnerRecipientStatus,
  type PersonType,
} from "@set-livre/contracts";
import { expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { z } from "zod";

import {
  cleanupFeat003QaIdentity,
  completeFeat003Profile,
  createFeat003ProfileSecrets,
  registerAndConfirmFeat003Identity,
  type Feat003QaIdentity,
} from "./feat-003-profile-account";
import { assertQaAuthEmail } from "./local-auth-mailpit";

const passwordSentinelSchema = z
  .string()
  .min(8)
  .max(32)
  .regex(/^[A-Za-z0-9!#$%&*+._-]+$/u);
const cleanupInputSchema = z.strictObject({ email: z.email(), userId: z.uuid() });
const cleanupEvidenceSchema = z.strictObject({
  audit_event_exists: z.boolean(),
  auth_user_exists: z.boolean(),
  owner_profile_exists: z.boolean(),
  owner_recipient_exists: z.boolean(),
  private_operation_exists: z.boolean(),
  profile_exists: z.boolean(),
  terms_acceptance_exists: z.boolean(),
});
const localRecipientTestFixtureSchema = z.enum([
  "blocked",
  "refused",
  "suspended",
  "timeout",
  "unavailable",
]);

export type Feat004QaIdentity = Feat003QaIdentity;
export type Feat004CleanupPool = Readonly<{
  end: () => Promise<void>;
  query: (text: string, values: readonly string[]) => Promise<Readonly<{ rows: unknown[] }>>;
}>;

function safeNamespace(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

export function createFeat004QaIdentity(
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
): Feat004QaIdentity {
  const passwordSentinel = passwordSentinelSchema.safeParse(
    process.env["FEAT004_REPORT_SECRET_SENTINEL"] ??
      `Sl${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  );
  if (!passwordSentinel.success) {
    throw new Error("A sentinela QA da FEAT-004 não atende ao contrato seguro esperado.");
  }
  const namespace = [
    "qa_f004",
    safeNamespace(scenario),
    safeNamespace(testInfo.project.name),
    Date.now().toString(36),
    randomUUID().replaceAll("-", "").slice(0, 12),
  ].join("_");
  return {
    email: assertQaAuthEmail(`${namespace}@example.test`),
    emails: [],
    password: `${passwordSentinel.data}${randomUUID().replaceAll("-", "").slice(0, 20)}Aa9`,
  };
}

export function assertFeat004SafeOwnerRecipient(value: unknown): OwnerRecipientStatus {
  const parsed = ownerRecipientStatusSchema.parse(value);
  const serialized = JSON.stringify(value);
  if (
    /"(?:bankAccount|bodyMarkdown|contentHash|kind|providerPayload|providerRecipientId|providerReference|routingNumber|title|version)"\s*:/u.test(
      serialized,
    )
  ) {
    throw new Error("A projeção de recebimentos expôs documento jurídico ou campo privado.");
  }
  return parsed;
}

export function assertFeat004SafeOwnerActivation(value: unknown): OwnerActivationResult {
  const parsed = ownerActivationResultSchema.parse(value);
  const serialized = JSON.stringify(value);
  if (
    /providerRecipientId|providerReference|providerPayload|bankAccount|routingNumber/iu.test(
      serialized,
    )
  ) {
    throw new Error("A projeção de ativação expôs um campo privado do provider.");
  }
  return parsed;
}

export async function readFeat004OwnerRecipient(page: Page) {
  const response = await page.request.get("/api/owner/recipient");
  expect(response.status()).toBe(200);
  const payload: unknown = await response.json();
  return assertFeat004SafeOwnerRecipient(
    apiSuccessSchema(ownerRecipientStatusSchema).parse(payload).data,
  );
}

async function expectOwnerActivationCommand(page: Page, click: () => Promise<void>) {
  const responsePromise = page.waitForResponse(async (response) => {
    if (
      new URL(response.url()).pathname !== "/api/commands" ||
      response.request().method() !== "POST"
    ) {
      return false;
    }
    const body: unknown = response.request().postDataJSON();
    return z.object({ action: z.string() }).safeParse(body).data?.action === "owner.activate";
  });
  await click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload: unknown = await response.json();
  return assertFeat004SafeOwnerActivation(
    apiSuccessSchema(ownerActivationResultSchema).parse(payload).data,
  );
}

async function expectOwnerRecipientCommand(
  page: Page,
  action: "recipient.onboarding.refresh" | "recipient.onboarding.start",
  click: () => Promise<void>,
) {
  const responsePromise = page.waitForResponse(async (response) => {
    if (
      new URL(response.url()).pathname !== "/api/commands" ||
      response.request().method() !== "POST"
    ) {
      return false;
    }
    const body: unknown = response.request().postDataJSON();
    return z.object({ action: z.string() }).safeParse(body).data?.action === action;
  });
  await click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload: unknown = await response.json();
  return assertFeat004SafeOwnerRecipient(
    apiSuccessSchema(ownerRecipientStatusSchema).parse(payload).data,
  );
}

export async function provisionFeat004Profile(
  page: Page,
  identity: Feat004QaIdentity,
  input: Readonly<{ name: string; personType?: PersonType; phone: string }>,
) {
  const personType = input.personType ?? "individual";
  await registerAndConfirmFeat003Identity(page, identity, personType);
  const navigation = await page.goto("/conta");
  expect(navigation?.status()).toBe(200);
  await completeFeat003Profile(page, {
    name: input.name,
    personType,
    phone: input.phone,
    secrets: createFeat003ProfileSecrets(personType),
  });
  const ownerNavigation = await page.goto("/dono");
  expect(ownerNavigation?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Ativação como dono" })).toBeVisible();
}

export async function activateFeat004Owner(page: Page) {
  const checkbox = page.getByRole("checkbox", { name: /Li e aceito o Contrato do Dono/iu });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  const result = await expectOwnerActivationCommand(page, () =>
    page.getByRole("button", { name: /Ativar perfil de dono|Aceitar contrato vigente/iu }).click(),
  );
  expect(result).toMatchObject({
    ownerContractAccepted: true,
    ownerStatus: "active",
    reservationsEligible: false,
  });
  await expect(
    page.getByText("Perfil de dono ativado com segurança.", { exact: true }),
  ).toBeVisible();
  return result;
}

export async function startFeat004Recipient(page: Page) {
  const result = await expectOwnerRecipientCommand(page, "recipient.onboarding.start", () =>
    page.getByRole("button", { name: "Iniciar validação local" }).click(),
  );
  expect(result).toMatchObject({
    nextAction: "refresh_status",
    recipientStatus: "pending",
    reservationsEligible: false,
  });
  await expect(page.getByText("Validação local iniciada.", { exact: true })).toBeVisible();
  return result;
}

export async function refreshFeat004Recipient(page: Page) {
  const result = await expectOwnerRecipientCommand(page, "recipient.onboarding.refresh", () =>
    page.getByRole("button", { name: "Atualizar status" }).click(),
  );
  expect(result).toMatchObject({
    nextAction: "none",
    recipientStatus: "active",
    reservationsEligible: true,
  });
  await expect(page.getByText("Status de recebimentos atualizado.", { exact: true })).toBeVisible();
  return result;
}

export async function refreshFeat004RecipientToTestState(
  page: Page,
  expectedStatus: "blocked" | "refused" | "suspended",
) {
  const result = await expectOwnerRecipientCommand(page, "recipient.onboarding.refresh", () =>
    page.getByRole("button", { name: "Atualizar status" }).click(),
  );
  expect(result).toMatchObject({
    recipientStatus: expectedStatus,
    reservationsEligible: false,
  });
  await expect(page.getByText("Status de recebimentos atualizado.", { exact: true })).toBeVisible();
  return result;
}

export async function gotoFeat004Recipient(page: Page) {
  await page.getByRole("link", { exact: true, name: "Recebimentos" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Cadastro de recebimentos" }),
  ).toBeVisible();
}

export async function assertFeat004PrivateValuesAbsent(page: Page) {
  const privateFieldDetected = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main");
    const body = `${main?.textContent ?? ""}\n${main?.innerHTML ?? ""}`;
    const controls = [
      ...(main?.querySelectorAll<HTMLElement>("a, button, input, select, textarea") ?? []),
    ].map((control) => control.outerHTML);
    return /providerRecipientId|provider_recipient_id|providerReference|provider_reference|providerPayload|provider_payload|bankAccount|bank_account|routingNumber|routing_number|local-recipient:|local-test-fixture:/iu.test(
      `${body}\n${controls.join("\n")}`,
    );
  });
  expect(privateFieldDetected).toBe(false);
}

export async function seedFeat004RecipientTestFixture(
  identity: Readonly<{ userId?: string }>,
  fixture: "blocked" | "refused" | "suspended" | "timeout" | "unavailable",
) {
  const userId = z.uuid().safeParse(identity.userId);
  const parsedFixture = localRecipientTestFixtureSchema.safeParse(fixture);
  if (!userId.success || !parsedFixture.success) {
    throw new Error("A fixture privada FEAT-004 recebeu um escopo inválido.");
  }
  await withFeat004AdminPool(async (pool) => {
    const update = await pool.query(
      `with latest_applied as (
         select operation.id
           from private.owner_recipient_operations as operation
          where operation.owner_user_id = $1::uuid
            and operation.applied_at is not null
          order by operation.operation_sequence desc
          limit 1
          for update
       )
       update private.owner_recipient_operations as operation
          set provider_reference = $2
         from latest_applied
        where operation.id = latest_applied.id
       returning operation.id`,
      [userId.data, `local-test-fixture:${parsedFixture.data}`],
    );
    if (update.rows.length !== 1) {
      throw new Error("A fixture privada FEAT-004 não encontrou uma operação aplicada exata.");
    }
  });
}

export async function verifyFeat004CleanupWithDependencies(
  input: Readonly<{ email: string; userId: string }>,
  pool: Feat004CleanupPool,
) {
  const parsed = cleanupInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("A evidência de limpeza FEAT-004 recebeu uma identidade inválida.");
  }
  const result = await pool.query(
    `select
       exists (
         select 1 from auth.users where id = $1::uuid and email = $2
       ) as auth_user_exists,
       exists (
         select 1 from public.profiles where id = $1::uuid
       ) as profile_exists,
       exists (
         select 1 from public.owner_profiles where user_id = $1::uuid
       ) as owner_profile_exists,
       exists (
         select 1 from public.owner_payment_recipients where owner_user_id = $1::uuid
       ) as owner_recipient_exists,
       exists (
         select 1 from public.terms_acceptances where user_id = $1::uuid
       ) as terms_acceptance_exists,
       exists (
         select 1 from private.owner_recipient_operations where owner_user_id = $1::uuid
       ) as private_operation_exists,
       exists (
         select 1
           from audit.events
          where actor_user_id = $1::uuid
             or target_id = $1::uuid
       ) as audit_event_exists`,
    [parsed.data.userId, parsed.data.email],
  );
  const evidence = cleanupEvidenceSchema.safeParse(result.rows[0]);
  if (!evidence.success || result.rows.length !== 1 || Object.values(evidence.data).some(Boolean)) {
    throw new Error("A limpeza exata da FEAT-004 deixou linhas residuais.");
  }
}

async function withFeat004AdminPool<T>(operation: (pool: Pool) => Promise<T>) {
  const [{ default: e2eDatabasePreflight }, { safeE2EEnvironment }] = await Promise.all([
    import("./e2e-database-preflight"),
    import("./e2e-environment"),
  ]);
  await e2eDatabasePreflight();
  const pool = new Pool({
    allowExitOnIdle: true,
    connectionString: safeE2EEnvironment.adminDatabaseUrl,
    connectionTimeoutMillis: 1_000,
    max: 1,
    query_timeout: 1_000,
    statement_timeout: 1_000,
  });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

async function removeFeat004OwnedRows(input: Readonly<{ email: string; userId: string }>) {
  const parsed = cleanupInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("A limpeza FEAT-004 recebeu uma identidade inválida.");
  }
  await withFeat004AdminPool(async (pool) => {
    await pool.query("begin");
    try {
      await pool.query(
        `delete from audit.events
          where actor_user_id = $1::uuid
             or target_id = $1::uuid`,
        [parsed.data.userId],
      );
      await pool.query(
        `delete from private.owner_recipient_operations where owner_user_id = $1::uuid`,
        [parsed.data.userId],
      );
      await pool.query(
        `delete from public.owner_payment_recipients where owner_user_id = $1::uuid`,
        [parsed.data.userId],
      );
      await pool.query(`delete from public.owner_profiles where user_id = $1::uuid`, [
        parsed.data.userId,
      ]);
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  });
}

async function verifyFeat004Cleanup(input: Readonly<{ email: string; userId: string }>) {
  await withFeat004AdminPool((pool) => verifyFeat004CleanupWithDependencies(input, pool));
}

export async function cleanupFeat004QaIdentity(identity: Feat004QaIdentity) {
  const userId = identity.userId;
  const failures: Error[] = [];
  if (userId !== undefined) {
    try {
      await removeFeat004OwnedRows({ email: identity.email, userId });
    } catch {
      failures.push(new Error("Não foi possível remover os fatos locais exatos da FEAT-004."));
    }
  }
  try {
    await cleanupFeat003QaIdentity(identity);
  } catch {
    failures.push(new Error("Não foi possível remover Auth/Mailpit da identidade FEAT-004."));
  }
  if (userId !== undefined) {
    try {
      await verifyFeat004Cleanup({ email: identity.email, userId });
    } catch {
      failures.push(new Error("Não foi possível comprovar a limpeza exata da FEAT-004."));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "A limpeza exata do cenário FEAT-004 falhou.");
  }
}
