import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  cleanupFeat003QaIdentity,
  createFeat003QaIdentity,
  registerAndConfirmFeat003Identity,
} from "../../helpers/feat-003-profile-account";
import { gotoExpectedPage } from "../../helpers/expected-page";

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    bodyFits: document.body.scrollWidth <= window.innerWidth,
    documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  }));
  expect(geometry).toEqual({ bodyFits: true, documentFits: true });
}

test("SL-F003-E2E-006 @p1 conta passa axe e teclado em claro, escuro e mobile", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  expect([
    "axe-dark-chromium",
    "axe-desktop-chromium",
    "axe-mobile-chromium",
    "axe-narrow-chromium",
  ]).toContain(testInfo.project.name);
  const identity = createFeat003QaIdentity(testInfo, "006_a11y");

  try {
    await registerAndConfirmFeat003Identity(page, identity, "individual");
    await gotoExpectedPage(page, "/conta", "Minha conta");
    await expect(page.getByRole("navigation", { name: "Configurações da conta" })).toBeVisible();
    await expectAxeClean(page);
    await expectNoHorizontalOverflow(page);

    const individualChoice = page.getByRole("radio", { name: "Pessoa física" });
    const companyChoice = page.getByRole("radio", { name: "Pessoa jurídica" });
    await individualChoice.focus();
    await expect(individualChoice).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(companyChoice).toBeFocused();
    await expect(companyChoice).toBeChecked();
    await page.keyboard.press("ArrowLeft");
    await expect(individualChoice).toBeFocused();
    await expect(individualChoice).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("textbox", { name: "Nome completo" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("textbox", { name: "Telefone" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("textbox", { name: "CPF" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("textbox", { name: "Documento adicional" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Concluir perfil" })).toBeFocused();

    const appearance = page.getByRole("combobox", { name: "Tema da interface" });
    await appearance.focus();
    await expect(appearance).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expectAxeClean(page);

    await page.getByRole("link", { name: "Segurança" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Segurança da conta" })).toBeVisible();
    await expect(page.getByText(identity.email, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Recuperar ou trocar senha" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sair desta conta" })).toBeVisible();
    await expectAxeClean(page);
    await expectNoHorizontalOverflow(page);

    if (testInfo.project.name === "axe-dark-chromium") {
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
        true,
      );
    }
    if (testInfo.project.name === "axe-mobile-chromium") {
      expect(page.viewportSize()).toEqual({ height: 844, width: 390 });
    }
    if (testInfo.project.name === "axe-narrow-chromium") {
      expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
    }
  } finally {
    await cleanupFeat003QaIdentity(identity);
  }
});
