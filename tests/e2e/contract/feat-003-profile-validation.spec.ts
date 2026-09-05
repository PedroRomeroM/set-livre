import { expect, test } from "@playwright/test";

import {
  assertFeat003SecretsAbsentFromDom,
  cleanupFeat003QaIdentity,
  createFeat003ProfileSecrets,
  createFeat003QaIdentity,
  fillFeat003PhoneWithoutReportValue,
  formatFeat003PhoneForDisplay,
  registerAndConfirmFeat003Identity,
  stageFeat003SensitiveValue,
} from "../../helpers/feat-003-profile-account";
import { gotoExpectedPage } from "../../helpers/expected-page";

function invalidateVerificationDigit(value: string) {
  const replacement = value.endsWith("0") ? "1" : "0";
  return `${value.slice(0, -1)}${replacement}`;
}

test("SL-F003-E2E-003 @p1 valida telefone, CPF e CNPJ localmente no mobile de 320 px", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 720, width: 320 });
  expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
  const identity = createFeat003QaIdentity(testInfo, "003_invalidos");
  const validCpf = createFeat003ProfileSecrets("individual").taxId;
  const invalidCpf = invalidateVerificationDigit(validCpf);
  const invalidCnpj = invalidateVerificationDigit(createFeat003ProfileSecrets("company").taxId);
  const invalidForeignPrefix = "+54 9 2222-2222";
  const invalidFormattedExcess = "+55 (41) 99999-12345";
  let commandRequests = 0;

  try {
    await registerAndConfirmFeat003Identity(page, identity, "individual");
    await gotoExpectedPage(page, "/conta", "Minha conta");
    page.on("request", (request) => {
      const address = new URL(request.url());
      if (address.pathname === "/api/commands" && request.method() === "POST") {
        commandRequests += 1;
      }
    });
    const individualChoice = page.getByRole("radio", { name: "Pessoa física" });
    await individualChoice.check();
    await page.getByRole("textbox", { name: "Nome completo" }).fill("Pessoa QA Inválida");
    const phoneControl = page.getByRole("textbox", { name: "Telefone" });
    await fillFeat003PhoneWithoutReportValue(phoneControl, invalidForeignPrefix);
    await expect(phoneControl).toHaveValue(formatFeat003PhoneForDisplay(invalidForeignPrefix));
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CPF" }), validCpf);
    await expect(individualChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(
      page.getByText("Informe um telefone brasileiro válido.", { exact: true }),
    ).toBeVisible();

    await fillFeat003PhoneWithoutReportValue(phoneControl, invalidFormattedExcess);
    await expect(phoneControl).toHaveValue(formatFeat003PhoneForDisplay(invalidFormattedExcess));
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CPF" }), validCpf);
    await expect(individualChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(
      page.getByText("Informe um telefone brasileiro válido.", { exact: true }),
    ).toBeVisible();

    await fillFeat003PhoneWithoutReportValue(phoneControl, "(41) 99999-1003");
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CPF" }), invalidCpf);
    await expect(individualChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(page.getByText("Informe um CPF válido.", { exact: true })).toBeVisible();

    const companyChoice = page.getByRole("radio", { name: "Pessoa jurídica" });
    await companyChoice.check();
    await page.getByRole("textbox", { name: "Nome empresarial" }).fill("Empresa QA Inválida");
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CNPJ" }), invalidCnpj);
    await expect(companyChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(page.getByText("Informe um CNPJ válido.", { exact: true })).toBeVisible();

    expect(commandRequests).toBe(0);
    await assertFeat003SecretsAbsentFromDom(page, [validCpf, invalidCpf, invalidCnpj]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await cleanupFeat003QaIdentity(identity);
  }
});
