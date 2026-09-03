import AxeBuilder from "@axe-core/playwright";
import { apiSuccessSchema, identityRecoveryRequestResultSchema } from "@set-livre/contracts";
import { expect, test, type Page } from "@playwright/test";

import {
  captureFeat002AuthEmailFence,
  cleanupFeat002QaIdentity,
  confirmFeat002Registration,
  createFeat002QaIdentity,
  getFeat002PasswordControl,
  logoutFeat002Identity,
  navigateFeat002AuthCallback,
  stageFeat002PasswordForSubmission,
  submitFeat002Registration,
  trackFeat002AuthEmail,
} from "../../helpers/feat-002-authentication";
import { gotoExpectedPage } from "../../helpers/expected-page";
import { srgbContrastRatio } from "../../helpers/srgb-contrast";

async function requestRecoveryThroughUi(page: Page, email: string) {
  const responsePromise = page.waitForResponse((response) => {
    const address = new URL(response.url());
    return (
      address.pathname === "/api/auth/recovery/request" && response.request().method() === "POST"
    );
  });
  await page.getByRole("textbox", { name: "E-mail" }).fill(email);
  await page.getByRole("button", { name: "Enviar instruções" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const payload: unknown = await response.json();
  const data = apiSuccessSchema(identityRecoveryRequestResultSchema).parse(payload).data;
  const status = page.getByRole("status");
  await expect(status).toContainText("Se existir uma conta para o endereço informado");
  return { data, message: await status.innerText(), status: response.status() };
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
}

async function expectNonTextContrastTokens(page: Page) {
  const colors = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      canvas: root.getPropertyValue("--sl-color-canvas").trim(),
      controlBorder: root.getPropertyValue("--sl-color-control-border").trim(),
      panelBorder: root.getPropertyValue("--sl-color-panel-border").trim(),
      surface: root.getPropertyValue("--sl-color-surface").trim(),
    };
  });
  expect(srgbContrastRatio(colors.controlBorder, colors.surface)).toBeGreaterThanOrEqual(3);
  expect(srgbContrastRatio(colors.panelBorder, colors.canvas)).toBeGreaterThanOrEqual(3);
}

test("SL-F002-E2E-004 @p1 recuperação não enumera e-mail inexistente", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  expect(page.viewportSize()).toEqual({ height: 900, width: 1440 });
  const existingIdentity = createFeat002QaIdentity(testInfo, "004_existing");
  const missingIdentity = createFeat002QaIdentity(testInfo, "004_missing");

  try {
    const signupEmailFence = await submitFeat002Registration(page, existingIdentity);
    await confirmFeat002Registration(page, existingIdentity, signupEmailFence);
    await logoutFeat002Identity(page);

    await gotoExpectedPage(page, "/recuperar-senha", "Recupere seu acesso");
    const recoveryEmailFence = await captureFeat002AuthEmailFence(existingIdentity);
    const existingResponse = await requestRecoveryThroughUi(page, existingIdentity.email);
    await trackFeat002AuthEmail(existingIdentity, "recovery", recoveryEmailFence);

    await page.getByRole("button", { name: "Informar outro e-mail" }).click();
    const missingResponse = await requestRecoveryThroughUi(page, missingIdentity.email);

    expect(missingResponse).toEqual(existingResponse);
  } finally {
    try {
      await cleanupFeat002QaIdentity(missingIdentity);
    } finally {
      await cleanupFeat002QaIdentity(existingIdentity);
    }
  }
});

test("SL-F002-E2E-006 @p1 formulários mobile passam axe e navegação por teclado", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ height: 720, width: 320 });
  expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
  const missingIdentity = createFeat002QaIdentity(testInfo, "006_missing");

  try {
    await gotoExpectedPage(page, "/cadastro", "Crie sua conta");
    const individualChoice = page.getByRole("radio", { name: "Pessoa física" });
    const companyChoice = page.getByRole("radio", { name: "Pessoa jurídica" });
    await expect(individualChoice).toBeEnabled();
    await expect(companyChoice).toBeEnabled();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expectNonTextContrastTokens(page);
      await expectAxeClean(page);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await expectNoHorizontalOverflow(page);

    await page.keyboard.press("Tab");
    await expect(individualChoice).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(companyChoice).toBeFocused();
    await expect(companyChoice).toBeChecked();
    await page.keyboard.press("Tab");
    const registrationEmail = page.getByRole("textbox", { name: "E-mail" });
    const registrationPassword = getFeat002PasswordControl(page, "Senha");
    const registrationPasswordConfirmation = getFeat002PasswordControl(page, "Confirme a senha");
    const registrationPasswordToggles = page.getByRole("button", { name: "Mostrar senha" });
    await expect(registrationEmail).toBeFocused();
    await page.keyboard.type("email-invalido");
    await page.keyboard.press("Tab");
    await expect(registrationPassword).toBeFocused();
    await stageFeat002PasswordForSubmission(registrationPassword, missingIdentity.password);
    await page.keyboard.press("Tab");
    await expect(registrationPasswordToggles.first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(registrationPasswordConfirmation).toBeFocused();
    await stageFeat002PasswordForSubmission(
      registrationPasswordConfirmation,
      `${missingIdentity.password}Z7`,
    );
    await page.keyboard.press("Tab");
    await expect(registrationPasswordToggles.last()).toBeFocused();
    await page.keyboard.press("Tab");
    const termsAcceptance = page.getByRole("checkbox", {
      name: /Li e aceito os Termos de Uso/u,
    });
    await expect(termsAcceptance).toBeFocused();
    await page.keyboard.press("Space");
    await expect(termsAcceptance).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: /Ler os Termos de Uso/u })).toBeFocused();
    await page.keyboard.press("Tab");
    const privacyAcceptance = page.getByRole("checkbox", {
      name: /Li e aceito a Política de Privacidade/u,
    });
    await expect(privacyAcceptance).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: /Ler a Política de Privacidade/u })).toBeFocused();
    await page.keyboard.press("Tab");
    const createAccount = page.getByRole("button", { name: "Criar conta" });
    await expect(createAccount).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(registrationEmail).toHaveAttribute("aria-invalid", "true");
    await expect(privacyAcceptance).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Informe um e-mail válido.", { exact: true })).toBeVisible();
    await expectAxeClean(page);

    await registrationEmail.fill(missingIdentity.email);
    await privacyAcceptance.check();
    await stageFeat002PasswordForSubmission(registrationPassword, missingIdentity.password);
    await stageFeat002PasswordForSubmission(
      registrationPasswordConfirmation,
      `${missingIdentity.password}Z7`,
    );
    await createAccount.focus();
    await page.keyboard.press("Enter");
    await expect(registrationPasswordConfirmation).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("As senhas precisam ser iguais.", { exact: true })).toBeVisible();
    await expectAxeClean(page);

    await gotoExpectedPage(page, "/entrar", "Entre na sua conta");
    const loginEmail = page.getByRole("textbox", { name: "E-mail" });
    const loginPassword = getFeat002PasswordControl(page, "Senha");
    await expect(loginEmail).toBeEnabled();
    await expect(loginPassword).toBeEnabled();
    await expectAxeClean(page);
    await expectNoHorizontalOverflow(page);

    await page.keyboard.press("Tab");
    await expect(loginEmail).toBeFocused();
    await page.keyboard.type(missingIdentity.email);
    await page.keyboard.press("Tab");
    await expect(loginPassword).toBeFocused();
    await stageFeat002PasswordForSubmission(loginPassword, missingIdentity.password);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Mostrar senha" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Ocultar senha" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(loginPassword).toHaveAttribute("type", "text");
    await page.keyboard.press("Tab");
    const submitLogin = page.getByRole("button", { name: "Entrar" });
    await expect(submitLogin).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Não foi possível entrar", { exact: true }) }),
    ).toContainText("Não foi possível entrar");
    await expect(loginEmail).toHaveValue(missingIdentity.email);
    await expectAxeClean(page);

    await gotoExpectedPage(page, "/recuperar-senha", "Recupere seu acesso");
    const recoveryEmail = page.getByRole("textbox", { name: "E-mail" });
    await expect(recoveryEmail).toBeEnabled();
    await expectAxeClean(page);
    await expectNoHorizontalOverflow(page);

    await page.keyboard.press("Tab");
    await expect(recoveryEmail).toBeFocused();
    await page.keyboard.type(missingIdentity.email);
    await page.keyboard.press("Tab");
    const submitRecovery = page.getByRole("button", { name: "Enviar instruções" });
    await expect(submitRecovery).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText(
      "Se existir uma conta para o endereço informado",
    );
    await expectAxeClean(page);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Informar outro e-mail" })).toBeFocused();

    const invalidCallback = new URL("/auth/callback", page.url());
    invalidCallback.hash = "token_hash=invalid&type=recovery";
    await navigateFeat002AuthCallback(page, invalidCallback.toString());
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Link não confirmado", { exact: true }) }),
    ).toContainText("Link não confirmado");
    await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
    await expectAxeClean(page);
    await expectNoHorizontalOverflow(page);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Solicitar recuperação de senha" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Voltar ao login" })).toBeFocused();
  } finally {
    await cleanupFeat002QaIdentity(missingIdentity);
  }
});
