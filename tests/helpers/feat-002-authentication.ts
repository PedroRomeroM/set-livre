import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  identitySessionSchema,
  type IdentitySession,
} from "@set-livre/contracts";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { Pool } from "pg";
import { z } from "zod";

import { gotoExpectedPage } from "./expected-page";
import { cleanupLocalAuthUser } from "./local-auth-cleanup";
import {
  assertQaAuthEmail,
  deleteAllExactLocalAuthEmails,
  deleteExactLocalAuthEmail,
  waitForLocalAuthEmail,
  type LocalAuthEmail,
  type LocalAuthEmailType,
} from "./local-auth-mailpit";

const authUserRowsSchema = z.array(z.strictObject({ id: z.uuid() })).max(1);
const passwordSentinelSchema = z
  .string()
  .min(8)
  .max(32)
  .regex(/^[A-Za-z0-9!#$%&*+._-]+$/u);
const feat002PasswordLabelPatterns = {
  "Confirme a nova senha": /^Confirme a nova senha\*?$/u,
  "Confirme a senha": /^Confirme a senha\*?$/u,
  "Nova senha": /^Nova senha\*?$/u,
  Senha: /^Senha\*?$/u,
} as const;

export type Feat002QaIdentity = {
  email: string;
  emails: LocalAuthEmail[];
  password: string;
  userId?: string;
};

function safeNamespace(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

export function createFeat002QaIdentity(testInfo: TestInfo, scenario: string): Feat002QaIdentity {
  const entropy = randomUUID().replaceAll("-", "").slice(0, 12);
  const passwordEntropy = randomUUID().replaceAll("-", "").slice(0, 20);
  const passwordSentinel = passwordSentinelSchema.safeParse(
    process.env["FEAT002_REPORT_SECRET_SENTINEL"] ??
      `Sl${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  );
  if (!passwordSentinel.success) {
    throw new Error("A sentinela QA de senha não atende ao contrato seguro esperado.");
  }
  const namespace = [
    "qa_f002",
    safeNamespace(scenario),
    safeNamespace(testInfo.project.name),
    Date.now().toString(36),
    entropy,
  ].join("_");

  return {
    email: assertQaAuthEmail(`${namespace}@example.test`),
    emails: [],
    password: `${passwordSentinel.data}${passwordEntropy}Aa9`,
  };
}

export function getFeat002PasswordControl(
  page: Page,
  label: keyof typeof feat002PasswordLabelPatterns,
) {
  return page.getByLabel(feat002PasswordLabelPatterns[label]);
}

export async function stageFeat002PasswordForSubmission(control: Locator, password: string) {
  try {
    // `fill`/`type` include their value in Playwright step titles; `evaluate` keeps the title static.
    await control.waitFor({ state: "visible", timeout: 5_000 });
    const staging = await control.evaluate((element, secret) => {
      const inputConstructor = element.ownerDocument.defaultView?.HTMLInputElement;
      if (inputConstructor === undefined || !(element instanceof inputConstructor)) {
        return { code: "not-input" as const };
      }
      if (element.form === null) {
        return { code: "form-missing" as const };
      }
      if (element.name !== "password" && element.name !== "confirmPassword") {
        return { code: "name-not-allowed" as const };
      }
      if (element.value !== "") {
        return { code: "input-not-empty" as const };
      }
      const name = element.name;
      element.form.addEventListener(
        "formdata",
        (event) => {
          event.formData.set(name, secret);
        },
        { once: true },
      );
      return { code: "staged" as const };
    }, password);
    if (staging.code !== "staged") {
      throw new Error(`O staging QA de senha falhou: code=${staging.code}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("O staging QA de senha falhou:")) {
      throw error;
    }
    throw new Error("O staging QA de senha falhou: code=evaluate-failed.");
  }
}

export async function navigateFeat002AuthCallback(page: Page, callbackUrl: string) {
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw new Error("O callback Auth QA não atende ao endereço local esperado.");
  }
  if (
    callback.origin !== "http://127.0.0.1:3000" ||
    callback.pathname !== "/auth/callback" ||
    callback.search !== "" ||
    callback.username !== "" ||
    callback.password !== "" ||
    !callback.hash.startsWith("#")
  ) {
    throw new Error("O callback Auth QA não atende ao endereço local esperado.");
  }

  try {
    // `goto` includes the address in its step title; the callback fragment is intentionally redacted.
    await page.evaluate((address) => {
      window.location.assign(address);
    }, callback.toString());
  } catch {
    throw new Error("Não foi possível navegar pelo callback Auth QA local.");
  }
}

export async function submitFeat002Registration(
  page: Page,
  identity: Feat002QaIdentity,
  personType: "Pessoa física" | "Pessoa jurídica" = "Pessoa jurídica",
) {
  await gotoExpectedPage(page, "/cadastro", "Crie sua conta");
  await page.getByRole("radio", { name: personType }).check();
  await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
  await stageFeat002PasswordForSubmission(
    getFeat002PasswordControl(page, "Senha"),
    identity.password,
  );
  await stageFeat002PasswordForSubmission(
    getFeat002PasswordControl(page, "Confirme a senha"),
    identity.password,
  );
  const termsAcceptance = page.getByRole("checkbox", {
    name: /Li e aceito os Termos de Uso/u,
  });
  const privacyAcceptance = page.getByRole("checkbox", {
    name: /Li e aceito a Política de Privacidade/u,
  });
  await termsAcceptance.check();
  await privacyAcceptance.check();
  await expect(termsAcceptance).toBeChecked();
  await expect(privacyAcceptance).toBeChecked();

  const notBefore = new Date(Date.now() - 1_000);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByRole("status")).toContainText("Confira seu e-mail");
  return notBefore;
}

export async function trackFeat002AuthEmail(
  identity: Feat002QaIdentity,
  emailType: LocalAuthEmailType,
  notBefore: Date,
) {
  const email = await waitForLocalAuthEmail({
    emailType,
    notBefore,
    recipientEmail: identity.email,
  });
  identity.emails.push(email);
  return email;
}

export async function readFeat002AuthenticatedSession(page: Page) {
  const session = await readFeat002IdentitySession(page);
  if (!session.authenticated) {
    throw new Error("A superfície autorizada não confirmou a sessão Auth esperada.");
  }
  return session;
}

export async function readFeat002IdentitySession(page: Page) {
  const response = await page.request.get("/api/auth/session");
  await expect(response).toBeOK();
  const payload: unknown = await response.json();
  return apiSuccessSchema(identitySessionSchema).parse(payload).data;
}

export async function confirmFeat002Registration(
  page: Page,
  identity: Feat002QaIdentity,
  notBefore: Date,
) {
  const email = await trackFeat002AuthEmail(identity, "signup", notBefore);
  await navigateFeat002AuthCallback(page, email.callbackUrl);
  await expect
    .poll(() => {
      const address = new URL(page.url());
      return `${address.pathname}${address.search}`;
    })
    .toBe("/entrar?confirmacao=sucesso");
  await expect(page.getByRole("status")).toContainText("Sessão ativa");
  const session = await readFeat002AuthenticatedSession(page);
  identity.userId = session.userId;
  return session;
}

async function findExactLocalAuthUserId(email: string) {
  const recipientEmail = assertQaAuthEmail(email);
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
    const result = await pool.query<{ id: string }>(
      `select id
         from auth.users
        where email = $1
        limit 2`,
      [recipientEmail],
    );
    const rows = authUserRowsSchema.safeParse(result.rows);
    if (!rows.success || rows.data.length !== result.rowCount) {
      throw new Error("O lookup local de limpeza Auth não retornou uma identidade exata.");
    }
    return rows.data[0]?.id;
  } catch {
    throw new Error("Não foi possível resolver a identidade Auth local para limpeza exata.");
  } finally {
    try {
      await pool.end();
    } catch {
      throw new Error("Não foi possível encerrar a conexão local de limpeza Auth.");
    }
  }
}

export async function cleanupFeat002QaIdentity(identity: Feat002QaIdentity) {
  const cleanupFailures: Error[] = [];

  for (const email of identity.emails) {
    try {
      await deleteExactLocalAuthEmail({
        messageId: email.messageId,
        recipientEmail: identity.email,
      });
    } catch {
      cleanupFailures.push(new Error("Não foi possível remover um e-mail Auth QA exato."));
    }
  }

  try {
    await deleteAllExactLocalAuthEmails({ recipientEmail: identity.email });
  } catch {
    cleanupFailures.push(new Error("Não foi possível remover os e-mails Auth QA residuais."));
  }

  try {
    const userId = identity.userId ?? (await findExactLocalAuthUserId(identity.email));
    if (userId !== undefined) {
      await cleanupLocalAuthUser({ email: identity.email, userId });
    }
  } catch {
    cleanupFailures.push(new Error("Não foi possível remover a identidade Auth QA exata."));
  }

  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "A limpeza exata do cenário FEAT-002 falhou.");
  }
}

export function expectUnauthenticatedSession(session: IdentitySession) {
  expect(session).toEqual({ authenticated: false });
}
