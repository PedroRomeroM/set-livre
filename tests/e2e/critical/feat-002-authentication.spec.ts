import { expect, test } from "@playwright/test";

import {
  cleanupFeat002QaIdentity,
  confirmFeat002Registration,
  createFeat002QaIdentity,
  expectUnauthenticatedSession,
  getFeat002PasswordControl,
  logoutFeat002Identity,
  navigateFeat002AuthCallback,
  readFeat002AuthenticatedSession,
  readFeat002IdentitySession,
  submitFeat002Registration,
  stageFeat002PasswordForSubmission,
  trackFeat002AuthEmail,
} from "../../helpers/feat-002-authentication";
import { gotoExpectedPage } from "../../helpers/expected-page";

test.use({ screenshot: "off", trace: "off", video: "off" });

function createDeferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal assíncrono do cenário Auth não foi inicializado.");
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectCurrentPath(page: Parameters<typeof gotoExpectedPage>[0], expected: string) {
  await expect
    .poll(() => {
      const address = new URL(page.url());
      return `${address.pathname}${address.search}`;
    })
    .toBe(expected);
}

test("SL-F002-E2E-001 @p0 cadastro completo envia confirmação e aceita termos", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const identity = createFeat002QaIdentity(testInfo, "001");

  try {
    const notBefore = await submitFeat002Registration(page, identity);
    const session = await confirmFeat002Registration(page, identity, notBefore);

    expect(identity.emails[0]?.subject).toBe("Confirme seu cadastro na Set Livre");
    expect(session).toMatchObject({
      authenticated: true,
      email: identity.email,
      personType: "company",
      profileCompleted: false,
      status: "active",
    });
    await expect(page.getByText(identity.email, { exact: true })).toBeVisible();
    await expect(page.getByText("Pessoa jurídica", { exact: true })).toBeVisible();
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});

test("SL-F002-E2E-002 @p0 login e logout controlam a sessão SSR em entrar", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const identity = createFeat002QaIdentity(testInfo, "002");

  try {
    const notBefore = await submitFeat002Registration(page, identity, "Pessoa física");
    const confirmedSession = await confirmFeat002Registration(page, identity, notBefore);
    await logoutFeat002Identity(page);

    await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
    await stageFeat002PasswordForSubmission(
      getFeat002PasswordControl(page, "Senha"),
      identity.password,
    );
    await page.getByRole("button", { name: "Entrar" }).click();

    await expectCurrentPath(page, "/entrar?sessao=ativa");
    await expect(page.getByRole("status")).toContainText("Sessão ativa");
    const loggedInSession = await readFeat002AuthenticatedSession(page);
    expect(loggedInSession.userId).toBe(confirmedSession.userId);
    await expect(page.getByText(identity.email, { exact: true })).toBeVisible();

    await logoutFeat002Identity(page);
    expectUnauthenticatedSession(await readFeat002IdentitySession(page));
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});

test("SL-F002-E2E-003 @p0 recuperação mobile define e autentica com a nova senha", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 720, width: 320 });
  expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
  const identity = createFeat002QaIdentity(testInfo, "003");
  const newPassword = `${identity.password}Z7`;

  try {
    const signupNotBefore = await submitFeat002Registration(page, identity, "Pessoa física");
    await confirmFeat002Registration(page, identity, signupNotBefore);
    await logoutFeat002Identity(page);

    await gotoExpectedPage(page, "/recuperar-senha", "Recupere seu acesso");
    await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
    const recoveryNotBefore = new Date(Date.now() - 1_000);
    await page.getByRole("button", { name: "Enviar instruções" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Se existir uma conta para o endereço informado",
    );

    const recoveryEmail = await trackFeat002AuthEmail(identity, "recovery", recoveryNotBefore);
    expect(recoveryEmail.subject).toBe("Redefina sua senha da Set Livre");
    await navigateFeat002AuthCallback(page, recoveryEmail.callbackUrl);
    await expectCurrentPath(page, "/recuperar-senha?modo=nova-senha");

    const newPasswordInput = getFeat002PasswordControl(page, "Nova senha");
    const confirmNewPasswordInput = getFeat002PasswordControl(page, "Confirme a nova senha");
    const passwordToggles = page.getByRole("button", { name: "Mostrar senha" });
    await expect(newPasswordInput).toBeEnabled();
    await newPasswordInput.focus();
    await expect(newPasswordInput).toBeFocused();
    await stageFeat002PasswordForSubmission(newPasswordInput, newPassword);
    await page.keyboard.press("Tab");
    await expect(passwordToggles.first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirmNewPasswordInput).toBeFocused();
    await stageFeat002PasswordForSubmission(confirmNewPasswordInput, newPassword);
    await page.keyboard.press("Tab");
    await expect(passwordToggles.last()).toBeFocused();
    await page.keyboard.press("Tab");
    const saveNewPassword = page.getByRole("button", { name: "Salvar nova senha" });
    await expect(saveNewPassword).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("Senha atualizada");

    const recoveryStatusStarted = createDeferredSignal();
    const releaseRecoveryStatus = createDeferredSignal();
    await page.route(
      "**/api/auth/recovery/status",
      async (route) => {
        recoveryStatusStarted.resolve();
        await releaseRecoveryStatus.promise;
        await route.continue();
      },
      { times: 1 },
    );

    try {
      await page.getByRole("link", { name: "Entrar com a nova senha" }).click();
      await expectCurrentPath(page, "/entrar");
      await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
      expectUnauthenticatedSession(await readFeat002IdentitySession(page));

      await page.getByRole("link", { name: "Esqueci minha senha" }).click();
      await expectCurrentPath(page, "/recuperar-senha");
      await recoveryStatusStarted.promise;
      await expect(page.getByRole("textbox", { name: "E-mail" })).toBeVisible();
      await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
    } finally {
      releaseRecoveryStatus.resolve();
    }

    await expect(page.getByRole("textbox", { name: "E-mail" })).toBeVisible();
    await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
    await page.getByRole("link", { name: "Voltar ao login" }).click();
    await expectCurrentPath(page, "/entrar");

    await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
    await stageFeat002PasswordForSubmission(getFeat002PasswordControl(page, "Senha"), newPassword);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expectCurrentPath(page, "/entrar?sessao=ativa");
    await expect(page.getByRole("status")).toContainText("Sessão ativa");

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    await navigateFeat002AuthCallback(page, recoveryEmail.callbackUrl);
    await expectCurrentPath(page, "/auth/callback");
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Link não confirmado", { exact: true }) }),
    ).toContainText("Link não confirmado");
    await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Solicitar recuperação de senha" })).toBeVisible();
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});

test("SL-F002-E2E-005 @p0 returnTo externo é rejeitado com fallback literal", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const identity = createFeat002QaIdentity(testInfo, "005");
  const externalOrigin = "https://outside.invalid";
  let externalRequests = 0;
  await page.route(`${externalOrigin}/**`, async (route) => {
    externalRequests += 1;
    await route.abort("blockedbyclient");
  });

  try {
    const notBefore = await submitFeat002Registration(page, identity);
    const signupEmail = await trackFeat002AuthEmail(identity, "signup", notBefore);
    const adversarialCallback = new URL(signupEmail.callbackUrl);
    const callbackFragment = new URLSearchParams(adversarialCallback.hash.slice(1));
    callbackFragment.set("returnTo", `${externalOrigin}/capture`);
    adversarialCallback.hash = callbackFragment.toString();

    await navigateFeat002AuthCallback(page, adversarialCallback.toString());
    await expectCurrentPath(page, "/entrar?sessao=ativa");
    await expect(page.getByRole("status")).toContainText("Sessão ativa");
    identity.userId = (await readFeat002AuthenticatedSession(page)).userId;
    expect(externalRequests).toBe(0);
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});
