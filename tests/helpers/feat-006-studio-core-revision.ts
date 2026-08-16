import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  ownerStudioEditorResultSchema,
  studioDraftDiscardResultSchema,
  type OwnerStudioEditorEditResult,
  type StudioCoreInput,
  type StudioDraftDiscardResult,
} from "@set-livre/contracts";
import { expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { z } from "zod";

import {
  activateFeat004Owner,
  cleanupFeat004QaIdentity,
  provisionFeat004Profile,
  type Feat004QaIdentity,
} from "./feat-004-owner-onboarding-recipient";
import { assertQaAuthEmail } from "./local-auth-mailpit";

const passwordSentinelSchema = z
  .string()
  .min(8)
  .max(32)
  .regex(/^[A-Za-z0-9!#$%&*+._-]+$/u);
const qaIdentitySchema = z.strictObject({ email: z.email(), userId: z.uuid() });
const studioDatabaseStateSchema = z.strictObject({
  draft_capacity: z.coerce.number().int().positive().nullable(),
  draft_complement: z.string().nullable(),
  draft_description: z.string().nullable(),
  draft_name: z.string().nullable(),
  draft_neighborhood: z.string().nullable(),
  draft_postal_code: z.string().nullable(),
  draft_revision_id: z.uuid().nullable(),
  draft_revision_number: z.coerce.number().int().positive().nullable(),
  draft_revision_rows: z.coerce.number().int().nonnegative(),
  draft_street: z.string().nullable(),
  draft_street_number: z.string().nullable(),
  draft_studio_type_id: z.uuid().nullable(),
  edit_version: z.coerce.number().int().positive(),
  owner_studio_rows: z.coerce.number().int().nonnegative(),
  published_description: z.string().nullable(),
  published_name: z.string().nullable(),
  published_revision_id: z.uuid().nullable(),
  published_revision_number: z.coerce.number().int().positive().nullable(),
  studio_status: z.enum(["draft", "published"]),
});
const cleanupEvidenceSchema = z.strictObject({
  command_exists: z.boolean(),
  revision_exists: z.boolean(),
  studio_exists: z.boolean(),
});

export type Feat006QaIdentity = Feat004QaIdentity;
export type Feat006StudioDatabaseState = z.infer<typeof studioDatabaseStateSchema>;

type StudioCommandTrigger = () => Promise<void>;

function safeNamespace(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

export function createFeat006QaIdentity(
  testInfo: Readonly<{ project: Readonly<{ name: string }> }>,
  scenario: string,
): Feat006QaIdentity {
  const passwordSentinel = passwordSentinelSchema.safeParse(
    process.env["FEAT006_REPORT_SECRET_SENTINEL"] ??
      `Sl${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  );
  if (!passwordSentinel.success) {
    throw new Error("A sentinela QA da FEAT-006 não atende ao contrato seguro esperado.");
  }
  const namespace = [
    "qa_f006",
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

export function createFeat006StudioCore(scenario: string): StudioCoreInput {
  const namespace = `qa_f006_${safeNamespace(scenario)}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 8)}`;
  return {
    address: {
      complement: `Sala ${namespace}`,
      neighborhood: `Bairro ${namespace}`,
      postalCode: "80000000",
      street: `Rua ${namespace}`,
      streetNumber: "6006",
    },
    capacity: 6,
    description: `Descrição sintética ${namespace} usada exclusivamente pelo cenário local da FEAT-006.`,
    name: namespace,
    studioTypeId: "00000000-0000-4000-8000-000000000603",
  };
}

export async function provisionFeat006Owner(page: Page, identity: Feat006QaIdentity) {
  await provisionFeat004Profile(page, identity, {
    name: identity.email.slice(0, identity.email.indexOf("@")),
    phone: "(41) 99999-6006",
  });
  await activateFeat004Owner(page);
}

export async function gotoFeat006NewStudio(page: Page) {
  await page.getByRole("link", { exact: true, name: "Cadastrar estúdio" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cadastrar estúdio" })).toBeVisible();
}

export async function fillFeat006StudioCore(page: Page, core: StudioCoreInput) {
  await page.getByRole("textbox", { name: "Nome do estúdio" }).fill(core.name);
  await page.getByRole("combobox", { name: "Tipo de estúdio" }).selectOption(core.studioTypeId);
  await page.getByRole("textbox", { name: "Descrição" }).fill(core.description);
  await page.getByRole("textbox", { name: "Logradouro" }).fill(core.address.street);
  await page.getByRole("textbox", { name: "Número" }).fill(core.address.streetNumber);
  await page.getByRole("textbox", { name: "Complemento" }).fill(core.address.complement ?? "");
  await page.getByRole("textbox", { name: "Bairro" }).fill(core.address.neighborhood);
  await page.getByRole("textbox", { name: "CEP" }).fill(core.address.postalCode);
  await page
    .getByRole("spinbutton", { name: "Capacidade máxima de pessoas" })
    .fill(String(core.capacity));
}

function assertFeat006SafeEditor(value: unknown): OwnerStudioEditorEditResult {
  const parsed = ownerStudioEditorResultSchema.parse(value);
  if (parsed.mode !== "edit") {
    throw new Error("O comando FEAT-006 não retornou um editor de estúdio existente.");
  }
  if (
    /ownerUserId|createdAt|updatedAt|studioTypeSlug|providerPayload|sql|stack/iu.test(
      JSON.stringify(value),
    )
  ) {
    throw new Error("O editor FEAT-006 expôs um campo privado ou não contratado.");
  }
  return parsed;
}

async function executeStudioEditorCommand(
  page: Page,
  action: "studio.create" | "studio.revision.updateCore",
  trigger?: StudioCommandTrigger,
) {
  let responsePayload: unknown;
  const responsePromise = page.waitForResponse(async (response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/commands"
    ) {
      return false;
    }
    const body: unknown = response.request().postDataJSON();
    if (z.object({ action: z.string() }).safeParse(body).data?.action !== action) return false;
    responsePayload = await response.json();
    return true;
  });
  const executeTrigger =
    trigger ?? (() => page.getByRole("button", { name: "Salvar rascunho" }).click());
  await executeTrigger();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  return assertFeat006SafeEditor(
    apiSuccessSchema(ownerStudioEditorResultSchema).parse(responsePayload).data,
  );
}

export function createFeat006Studio(page: Page, trigger?: StudioCommandTrigger) {
  return executeStudioEditorCommand(page, "studio.create", trigger);
}

export function updateFeat006Studio(page: Page, trigger?: StudioCommandTrigger) {
  return executeStudioEditorCommand(page, "studio.revision.updateCore", trigger);
}

function assertFeat006SafeDiscard(value: unknown): StudioDraftDiscardResult {
  const parsed = studioDraftDiscardResultSchema.parse(value);
  if (
    /ownerUserId|createdAt|updatedAt|studioTypeSlug|providerPayload|sql|stack/iu.test(
      JSON.stringify(value),
    )
  ) {
    throw new Error("O descarte FEAT-006 expôs um campo privado ou não contratado.");
  }
  if (parsed.outcome === "draft_removed") {
    assertFeat006SafeEditor(parsed.editor);
  }
  return parsed;
}

export async function discardFeat006StudioDraft(page: Page) {
  let responsePayload: unknown;
  const responsePromise = page.waitForResponse(async (response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/commands"
    ) {
      return false;
    }
    const body: unknown = response.request().postDataJSON();
    if (z.object({ action: z.string() }).safeParse(body).data?.action !== "studio.draft.discard") {
      return false;
    }
    responsePayload = await response.json();
    return true;
  });
  await page.getByRole("button", { name: "Confirmar descarte" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  return assertFeat006SafeDiscard(
    apiSuccessSchema(studioDraftDiscardResultSchema).parse(responsePayload).data,
  );
}

async function withFeat006AdminPool<T>(operation: (pool: Pool) => Promise<T>) {
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

export async function publishFeat006StudioFixture(
  identity: Readonly<{ email: string; userId?: string }>,
  studioId: string,
) {
  const parsed = qaIdentitySchema.safeParse({ email: identity.email, userId: identity.userId });
  const parsedStudioId = z.uuid().safeParse(studioId);
  if (!parsed.success || !parsed.data.email.startsWith("qa_f006_") || !parsedStudioId.success) {
    throw new Error("A promoção local FEAT-006 recebeu uma identidade ou estúdio inválido.");
  }
  await withFeat006AdminPool(async (pool) => {
    await pool.query("begin");
    try {
      await pool.query(
        "alter table public.studio_revisions disable trigger studio_revisions_enforce_lifecycle",
      );
      const promoted = await pool.query(
        `update public.studio_revisions as revision
            set status = 'approved'
           from public.studios as studio
          where studio.id = $1::uuid
            and studio.owner_user_id = $2::uuid
            and revision.id = studio.draft_revision_id
            and revision.studio_id = studio.id
            and revision.status = 'draft'
        returning revision.id`,
        [parsedStudioId.data, parsed.data.userId],
      );
      if (promoted.rows.length !== 1) {
        throw new Error("A promoção local FEAT-006 não encontrou um único rascunho.");
      }
      const aggregate = await pool.query(
        `update public.studios
            set status = 'published',
                published_revision_id = draft_revision_id,
                draft_revision_id = null,
                edit_version = edit_version + 1,
                updated_at = pg_catalog.clock_timestamp()
          where id = $1::uuid
            and owner_user_id = $2::uuid
        returning id`,
        [parsedStudioId.data, parsed.data.userId],
      );
      if (aggregate.rows.length !== 1) {
        throw new Error("A promoção local FEAT-006 não encontrou o agregado exato.");
      }
      await pool.query("set constraints all immediate");
      await pool.query(
        "alter table public.studio_revisions enable trigger studio_revisions_enforce_lifecycle",
      );
      await pool.query("set constraints all deferred");
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  });
}

export async function readFeat006StudioDatabaseState(
  identity: Readonly<{ email: string; userId?: string }>,
  studioId: string,
): Promise<Feat006StudioDatabaseState> {
  const parsed = qaIdentitySchema.safeParse({ email: identity.email, userId: identity.userId });
  const parsedStudioId = z.uuid().safeParse(studioId);
  if (!parsed.success || !parsed.data.email.startsWith("qa_f006_") || !parsedStudioId.success) {
    throw new Error("A leitura local FEAT-006 recebeu uma identidade ou estúdio inválido.");
  }
  return withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `select
         studio.status as studio_status,
         studio.edit_version,
         studio.draft_revision_id,
         draft.revision_number as draft_revision_number,
         draft.name as draft_name,
         draft.description as draft_description,
         draft.street as draft_street,
         draft.street_number as draft_street_number,
         draft.address_complement as draft_complement,
         draft.neighborhood as draft_neighborhood,
         draft.postal_code as draft_postal_code,
         draft.capacity as draft_capacity,
         draft.studio_type_id as draft_studio_type_id,
         (
           select pg_catalog.count(*)
             from public.studio_revisions as active_draft
            where active_draft.studio_id = studio.id
              and active_draft.status = 'draft'
         ) as draft_revision_rows,
         (
           select pg_catalog.count(*)
             from public.studios as owned_studio
            where owned_studio.owner_user_id = studio.owner_user_id
         ) as owner_studio_rows,
         studio.published_revision_id,
         published.revision_number as published_revision_number,
         published.name as published_name,
         published.description as published_description
       from public.studios as studio
       left join public.studio_revisions as draft
         on draft.id = studio.draft_revision_id
        and draft.studio_id = studio.id
       left join public.studio_revisions as published
         on published.id = studio.published_revision_id
        and published.studio_id = studio.id
      where studio.id = $1::uuid
        and studio.owner_user_id = $2::uuid`,
      [parsedStudioId.data, parsed.data.userId],
    );
    if (result.rows.length !== 1) {
      throw new Error("A leitura local FEAT-006 não encontrou o agregado exato.");
    }
    return studioDatabaseStateSchema.parse(result.rows[0]);
  });
}

async function removeFeat006OwnedRows(input: Readonly<{ email: string; userId: string }>) {
  const parsed = qaIdentitySchema.safeParse(input);
  if (!parsed.success || !parsed.data.email.startsWith("qa_f006_")) {
    throw new Error("A limpeza FEAT-006 recusou uma identidade fora do namespace QA.");
  }
  await withFeat006AdminPool(async (pool) => {
    await pool.query("begin");
    try {
      await pool.query(
        `delete from audit.events
          where actor_user_id = $1::uuid
             or target_id in (
               select studio.id
                 from public.studios as studio
                where studio.owner_user_id = $1::uuid
             )`,
        [parsed.data.userId],
      );
      await pool.query(
        "delete from private.studio_command_requests where owner_user_id = $1::uuid",
        [parsed.data.userId],
      );
      await pool.query(
        "alter table public.studio_revisions disable trigger studio_revisions_enforce_lifecycle",
      );
      await pool.query("delete from public.studios where owner_user_id = $1::uuid", [
        parsed.data.userId,
      ]);
      await pool.query("set constraints all immediate");
      await pool.query(
        "alter table public.studio_revisions enable trigger studio_revisions_enforce_lifecycle",
      );
      await pool.query("set constraints all deferred");
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  });
}

async function verifyFeat006Cleanup(input: Readonly<{ email: string; userId: string }>) {
  const parsed = qaIdentitySchema.parse(input);
  await withFeat006AdminPool(async (pool) => {
    const result = await pool.query(
      `select
         exists (
           select 1 from public.studios where owner_user_id = $1::uuid
         ) as studio_exists,
         exists (
           select 1
             from public.studio_revisions as revision
             join public.studios as studio on studio.id = revision.studio_id
            where studio.owner_user_id = $1::uuid
         ) as revision_exists,
         exists (
           select 1
             from private.studio_command_requests
            where owner_user_id = $1::uuid
         ) as command_exists`,
      [parsed.userId],
    );
    const evidence = cleanupEvidenceSchema.safeParse(result.rows[0]);
    if (
      !evidence.success ||
      result.rows.length !== 1 ||
      Object.values(evidence.data).some(Boolean)
    ) {
      throw new Error("A limpeza exata da FEAT-006 deixou linhas residuais.");
    }
  });
}

export async function cleanupFeat006QaIdentity(identity: Feat006QaIdentity) {
  const failures: Error[] = [];
  if (identity.userId !== undefined) {
    try {
      await removeFeat006OwnedRows({ email: identity.email, userId: identity.userId });
    } catch {
      failures.push(new Error("Não foi possível remover os estúdios exatos da FEAT-006."));
    }
  }
  try {
    await cleanupFeat004QaIdentity(identity);
  } catch {
    failures.push(new Error("Não foi possível remover a identidade dona da FEAT-006."));
  }
  if (identity.userId !== undefined) {
    try {
      await verifyFeat006Cleanup({ email: identity.email, userId: identity.userId });
    } catch {
      failures.push(new Error("Não foi possível comprovar a limpeza exata da FEAT-006."));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "A limpeza exata do cenário FEAT-006 falhou.");
  }
}
