import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  identitySessionSchema,
  type IdentitySession,
} from "@set-livre/contracts";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";

import { withE2EAdminClient } from "./e2e-database-preflight";
import { gotoExpectedPage } from "./expected-page";
import { cleanupLocalAuthUser } from "./local-auth-cleanup";
import {
  assertQaAuthEmail,
  captureLocalAuthEmailFence,
  deleteAllExactLocalAuthEmails,
  deleteExactLocalAuthEmail,
  waitForLocalAuthEmail,
  type LocalAuthEmail,
  type LocalAuthEmailFence,
  type LocalAuthEmailType,
} from "./local-auth-mailpit";

const authUserRowsSchema = z.array(z.strictObject({ id: z.uuid() })).max(1);
const browserSessionReadSchema = z.discriminatedUnion("connected", [
  z.strictObject({ connected: z.literal(false) }),
  z.strictObject({
    connected: z.literal(true),
    source: z.string(),
    status: z.number().int().min(100).max(599),
  }),
]);
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

export async function stageFeat002PasswordForSubmission(
  control: Locator,
  password: string,
  allowedControlNames: readonly string[] = ["password", "confirmPassword"],
) {
  try {
    // `fill`/`type` include their value in Playwright step titles; `evaluate` keeps the title static.
    await control.waitFor({ state: "visible", timeout: 5_000 });
    const staging = await control.evaluate(
      (element, input) => {
        const inputConstructor = element.ownerDocument.defaultView?.HTMLInputElement;
        if (inputConstructor === undefined || !(element instanceof inputConstructor)) {
          return { code: "not-input" as const };
        }
        if (element.form === null) {
          return { code: "form-missing" as const };
        }
        if (!input.allowedControlNames.includes(element.name)) {
          return { code: "name-not-allowed" as const };
        }
        if (element.value !== "") {
          return { code: "input-not-empty" as const };
        }
        const name = element.name;
        element.form.addEventListener(
          "formdata",
          (event) => {
            event.formData.set(name, input.secret);
          },
          { once: true },
        );
        return { code: "staged" as const };
      },
      { allowedControlNames: [...allowedControlNames], secret: password },
    );
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
  const personTypeChoice = page.getByRole("radio", { name: personType });
  await personTypeChoice.check();
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
  await expect(personTypeChoice).toBeChecked();

  const emailFence = await captureFeat002AuthEmailFence(identity);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByRole("status")).toContainText("Confira seu e-mail");
  return emailFence;
}

export async function captureFeat002AuthEmailFence(identity: Feat002QaIdentity) {
  return captureLocalAuthEmailFence({ recipientEmail: identity.email });
}

export async function trackFeat002AuthEmail(
  identity: Feat002QaIdentity,
  emailType: LocalAuthEmailType,
  emailFence: LocalAuthEmailFence,
) {
  if (emailFence.recipientEmail !== identity.email) {
    throw new Error("O fence de e-mail Auth QA não corresponde à identidade exata.");
  }
  const email = await waitForLocalAuthEmail({
    emailType,
    fence: emailFence,
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
  const response = browserSessionReadSchema.parse(
    await page.evaluate(async () => {
      try {
        const result = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        return {
          connected: true as const,
          source: await result.text(),
          status: result.status,
        };
      } catch {
        return { connected: false as const };
      }
    }),
  );
  if (!response.connected) {
    throw new Error("A leitura da sessão Auth pelo navegador não alcançou o servidor local.");
  }
  expect(response.status).toBe(200);
  let payload: unknown;
  try {
    payload = JSON.parse(response.source);
  } catch {
    throw new Error("A leitura da sessão Auth não retornou JSON válido.");
  }
  return apiSuccessSchema(identitySessionSchema).parse(payload).data;
}

export async function confirmFeat002Registration(
  page: Page,
  identity: Feat002QaIdentity,
  emailFence: LocalAuthEmailFence,
) {
  const email = await trackFeat002AuthEmail(identity, "signup", emailFence);
  await navigateFeat002AuthCallback(page, email.callbackUrl);
  await expect
    .poll(
      () => {
        const address = new URL(page.url());
        return `${address.pathname}${address.search}`;
      },
      { timeout: 15_000 },
    )
    .toBe("/entrar?confirmacao=sucesso");
  await expect(page.getByRole("status")).toContainText("Sessão ativa", { timeout: 15_000 });
  const session = await readFeat002AuthenticatedSession(page);
  identity.userId = session.userId;
  return session;
}

export async function logoutFeat002Identity(page: Page) {
  const logoutResponsePromise = page.waitForResponse((response) => {
    const address = new URL(response.url());
    return address.pathname === "/api/auth/logout" && response.request().method() === "POST";
  });

  await page.getByRole("button", { name: "Sair" }).click();
  const logoutResponse = await logoutResponsePromise;
  expect(logoutResponse.status()).toBe(200);
  await page.waitForURL((address) => address.pathname === "/entrar" && address.search === "", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
}

async function findExactLocalAuthUserId(email: string) {
  const recipientEmail = assertQaAuthEmail(email);
  try {
    return await withE2EAdminClient(async (client) => {
      const result = await client.query<{ id: string }>(
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
    });
  } catch {
    throw new Error("Não foi possível resolver a identidade Auth local para limpeza exata.");
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
