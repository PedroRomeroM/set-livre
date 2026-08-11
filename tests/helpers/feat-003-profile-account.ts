import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  cnpjSchema,
  cpfSchema,
  formatBrazilianPhoneForDisplay,
  identityLoginResultSchema,
  myProfileResultSchema,
  type MyProfileResult,
  type PersonType,
} from "@set-livre/contracts";
import { expect, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";
import { z } from "zod";

import {
  cleanupFeat002QaIdentity,
  confirmFeat002Registration,
  getFeat002PasswordControl,
  submitFeat002Registration,
  stageFeat002PasswordForSubmission,
  type Feat002QaIdentity,
} from "./feat-002-authentication";
import { assertQaAuthEmail } from "./local-auth-mailpit";

const passwordSentinelSchema = z
  .string()
  .min(8)
  .max(32)
  .regex(/^[A-Za-z0-9!#$%&*+._-]+$/u);
const cleanupInputSchema = z.strictObject({
  email: z.email(),
  userId: z.uuid(),
});
const cleanupEvidenceSchema = z.strictObject({
  auth_user_exists: z.boolean(),
  preference_exists: z.boolean(),
  profile_exists: z.boolean(),
});
const sensitiveControlNames = new Set(["additionalDocument", "taxId"]);

type QaProject = Readonly<{ project: Readonly<{ name: string }> }>;

export type Feat003QaIdentity = Feat002QaIdentity;
export type Feat003ProfileSecrets = Readonly<{
  additionalDocument: string;
  taxId: string;
}>;
export type Feat003CleanupPool = Readonly<{
  end: () => Promise<void>;
  query: (
    text: string,
    values: readonly [string, string],
  ) => Promise<Readonly<{ rows: unknown[] }>>;
}>;

function safeNamespace(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function decimalEntropy(length: number) {
  const entropy = randomUUID().replaceAll("-", "");
  return [...entropy]
    .map((character) => (Number.parseInt(character, 16) % 10).toString())
    .join("")
    .slice(0, length);
}

function cpfDigit(base: string, factor: number) {
  let total = 0;
  for (const character of base) {
    total += Number(character) * factor;
    factor -= 1;
  }
  const remainder = (total * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

function syntheticCpf() {
  const base = `987${decimalEntropy(6)}`;
  const first = cpfDigit(base, 10);
  const second = cpfDigit(`${base}${first}`, 11);
  return cpfSchema.parse(`${base}${first}${second}`);
}

function cnpjCharacterValue(character: string) {
  const value = character.codePointAt(0);
  if (value === undefined) {
    throw new Error("Não foi possível gerar o CNPJ sintético local.");
  }
  return value - 48;
}

function cnpjDigit(base: string, weights: readonly number[]) {
  const total = [...base].reduce(
    (sum, character, index) => sum + cnpjCharacterValue(character) * (weights[index] ?? 0),
    0,
  );
  const remainder = total % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

function syntheticAlphanumericCnpj() {
  const base = `QA${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const first = cnpjDigit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = cnpjDigit(`${base}${first}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return cnpjSchema.parse(`${base}${first}${second}`);
}

export function createFeat003QaIdentity(testInfo: QaProject, scenario: string): Feat003QaIdentity {
  const namespace = [
    "qa_f003",
    safeNamespace(scenario),
    safeNamespace(testInfo.project.name),
    Date.now().toString(36),
    randomUUID().replaceAll("-", "").slice(0, 12),
  ].join("_");
  const passwordSentinel = passwordSentinelSchema.safeParse(
    process.env["FEAT003_REPORT_SECRET_SENTINEL"] ??
      `Sl${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  );
  if (!passwordSentinel.success) {
    throw new Error("A sentinela QA da FEAT-003 não atende ao contrato seguro esperado.");
  }

  return {
    email: assertQaAuthEmail(`${namespace}@example.test`),
    emails: [],
    password: `${passwordSentinel.data}${randomUUID().replaceAll("-", "").slice(0, 20)}Aa9`,
  };
}

export function createFeat003ProfileSecrets(personType: PersonType): Feat003ProfileSecrets {
  return {
    additionalDocument: `QA-DOC-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
    taxId: personType === "individual" ? syntheticCpf() : syntheticAlphanumericCnpj(),
  };
}

export async function stageFeat003SensitiveValue(control: Locator, secret: string) {
  try {
    // O valor fica fora do DOM e o título do step permanece estático, como no helper de senha.
    await control.waitFor({ state: "visible", timeout: 5_000 });
    const staging = await control.evaluate((element, sensitiveValue) => {
      const inputConstructor = element.ownerDocument.defaultView?.HTMLInputElement;
      if (inputConstructor === undefined || !(element instanceof inputConstructor)) {
        return { code: "not-input" as const };
      }
      if (element.form === null) {
        return { code: "form-missing" as const };
      }
      if (element.name !== "taxId" && element.name !== "additionalDocument") {
        return { code: "name-not-allowed" as const };
      }
      if (element.value !== "") {
        return { code: "input-not-empty" as const };
      }
      const name = element.name;
      element.form.addEventListener(
        "formdata",
        (event) => {
          event.formData.set(name, sensitiveValue);
        },
        { once: true },
      );
      return { code: "staged" as const };
    }, secret);
    if (staging.code !== "staged") {
      throw new Error(`O staging QA de documento falhou: code=${staging.code}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("O staging QA de documento falhou:")) {
      throw error;
    }
    throw new Error("O staging QA de documento falhou: code=evaluate-failed.");
  }
}

export async function assertFeat003SecretsAbsentFromDom(page: Page, secrets: readonly string[]) {
  await assertFeat003PrivateValuesAbsentFromDom(page, secrets);
}

export async function assertFeat003PrivateValuesAbsentFromDom(
  page: Page,
  privateValues: readonly string[],
) {
  const safe = await page.evaluate((sensitiveValues) => {
    const visibleText = document.body.textContent ?? "";
    const formValues = [
      ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input, select, textarea",
      ),
    ].map((control) => control.value);
    return sensitiveValues.every(
      (value) => !visibleText.includes(value) && !formValues.some((entry) => entry.includes(value)),
    );
  }, privateValues);
  if (!safe) {
    throw new Error("Um valor privado QA apareceu no DOM durante o boundary fechado.");
  }
}

export function formatFeat003PhoneForDisplay(value: string) {
  return formatBrazilianPhoneForDisplay(value);
}

export async function switchFeat003SessionWithoutNavigation(
  page: Page,
  identity: Feat003QaIdentity,
) {
  const previousAddress = await page.evaluate(
    () => `${window.location.pathname}${window.location.search}`,
  );
  let response: Readonly<{ payload: unknown; status: number }>;
  try {
    response = await page.evaluate(
      async (credentials) => {
        try {
          const loginResponse = await fetch("/api/auth/login", {
            body: JSON.stringify(credentials),
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            method: "POST",
          });
          const payload: unknown = await loginResponse.json();
          return { payload, status: loginResponse.status };
        } catch {
          return { payload: null, status: 0 };
        }
      },
      { email: identity.email, password: identity.password, returnTo: "/conta" },
    );
  } catch {
    throw new Error("A troca local de sessão FEAT-003 não pôde ser executada.");
  }
  if (response.status !== 200) {
    throw new Error("A troca local de sessão FEAT-003 não foi aceita.");
  }
  const parsed = apiSuccessSchema(identityLoginResultSchema).safeParse(response.payload);
  if (
    !parsed.success ||
    parsed.data.data.session.authenticated !== true ||
    identity.userId === undefined ||
    parsed.data.data.session.userId !== identity.userId
  ) {
    throw new Error("A troca local de sessão FEAT-003 não publicou o escopo esperado.");
  }
  const currentAddress = await page.evaluate(
    () => `${window.location.pathname}${window.location.search}`,
  );
  if (currentAddress !== previousAddress) {
    throw new Error("A troca local de sessão FEAT-003 navegou antes de revalidar o cache montado.");
  }
  return parsed.data.data;
}

export function assertFeat003SafeProfileResult(
  value: unknown,
  secrets: readonly string[],
): MyProfileResult {
  const result = myProfileResultSchema.parse(value);
  const serialized = JSON.stringify(value);
  if (secrets.some((secret) => serialized.includes(secret))) {
    throw new Error("O DTO de perfil expôs um documento QA bruto.");
  }
  return result;
}

export async function registerAndConfirmFeat003Identity(
  page: Page,
  identity: Feat003QaIdentity,
  personType: PersonType,
) {
  const notBefore = await submitFeat002Registration(
    page,
    identity,
    personType === "individual" ? "Pessoa física" : "Pessoa jurídica",
  );
  return confirmFeat002Registration(page, identity, notBefore);
}

export async function loginFeat003Identity(
  page: Page,
  identity: Feat003QaIdentity,
  expectedPath: "/conta" | "/conta/seguranca" | "/entrar?sessao=ativa",
) {
  await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
  await stageFeat002PasswordForSubmission(
    getFeat002PasswordControl(page, "Senha"),
    identity.password,
  );
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect
    .poll(
      () => {
        const address = new URL(page.url());
        return `${address.pathname}${address.search}`;
      },
      { timeout: 15_000 },
    )
    .toBe(expectedPath);
}

export async function completeFeat003Profile(
  page: Page,
  input: Readonly<{
    name: string;
    personType: PersonType;
    phone: string;
    secrets: Feat003ProfileSecrets;
  }>,
) {
  await expect(page.getByRole("heading", { level: 2, name: "Complete seu perfil" })).toBeVisible();
  const personTypeChoice = page.getByRole("radio", {
    name: input.personType === "individual" ? "Pessoa física" : "Pessoa jurídica",
  });
  await personTypeChoice.check();
  await page
    .getByRole("textbox", {
      name: input.personType === "individual" ? "Nome completo" : "Nome empresarial",
    })
    .fill(input.name);
  await page.getByRole("textbox", { name: "Telefone" }).fill(input.phone);
  await stageFeat003SensitiveValue(
    page.getByRole("textbox", { name: input.personType === "individual" ? "CPF" : "CNPJ" }),
    input.secrets.taxId,
  );
  await stageFeat003SensitiveValue(
    page.getByRole("textbox", { name: "Documento adicional" }),
    input.secrets.additionalDocument,
  );
  await expect(personTypeChoice).toBeChecked();

  const responsePromise = page.waitForResponse((response) => {
    const address = new URL(response.url());
    return address.pathname === "/api/commands" && response.request().method() === "POST";
  });
  await page.getByRole("button", { name: "Concluir perfil" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload: unknown = await response.json();
  const data = apiSuccessSchema(myProfileResultSchema).parse(payload).data;
  const safeResult = assertFeat003SafeProfileResult(data, [
    input.secrets.taxId,
    input.secrets.additionalDocument,
  ]);
  await expect(page.getByRole("heading", { level: 2, name: "Dados do perfil" })).toBeVisible();
  await assertFeat003SecretsAbsentFromDom(page, [
    input.secrets.taxId,
    input.secrets.additionalDocument,
  ]);
  return safeResult;
}

export function maskedFeat003AdditionalDocument(value: string) {
  return `${"*".repeat(value.length - 2)}${value.slice(-2)}`;
}

export async function verifyFeat003CleanupWithDependencies(
  input: Readonly<{ email: string; userId: string }>,
  pool: Feat003CleanupPool,
) {
  const parsed = cleanupInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("A evidência de limpeza FEAT-003 recebeu uma identidade inválida.");
  }
  const result = await pool.query(
    `select
       exists (
         select 1
           from auth.users as auth_user
          where auth_user.id = $1::uuid
            and auth_user.email = $2
       ) as auth_user_exists,
       exists (
         select 1
           from public.profiles as profile
          where profile.id = $1::uuid
       ) as profile_exists,
       exists (
         select 1
           from public.user_preferences as preference
          where preference.user_id = $1::uuid
       ) as preference_exists`,
    [parsed.data.userId, parsed.data.email],
  );
  const evidence = cleanupEvidenceSchema.safeParse(result.rows[0]);
  if (
    !evidence.success ||
    result.rows.length !== 1 ||
    evidence.data.auth_user_exists ||
    evidence.data.profile_exists ||
    evidence.data.preference_exists
  ) {
    throw new Error("A limpeza exata da identidade FEAT-003 deixou linhas residuais.");
  }
}

async function verifyFeat003Cleanup(input: Readonly<{ email: string; userId: string }>) {
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
    await verifyFeat003CleanupWithDependencies(input, pool);
  } finally {
    await pool.end();
  }
}

export async function cleanupFeat003QaIdentity(identity: Feat003QaIdentity) {
  const cleanupFailures: Error[] = [];
  try {
    await cleanupFeat002QaIdentity(identity);
  } catch {
    cleanupFailures.push(
      new Error("Não foi possível remover Auth/Mailpit da identidade FEAT-003."),
    );
  }

  if (identity.userId !== undefined) {
    try {
      await verifyFeat003Cleanup({ email: identity.email, userId: identity.userId });
    } catch {
      cleanupFailures.push(new Error("Não foi possível comprovar a limpeza das linhas FEAT-003."));
    }
  }

  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "A limpeza exata do cenário FEAT-003 falhou.");
  }
}

export function isFeat003SensitiveControlName(value: string) {
  return sensitiveControlNames.has(value);
}
