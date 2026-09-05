import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  activateFeat004Owner,
  cleanupFeat004QaIdentity,
  createFeat004QaIdentity,
  gotoFeat004Recipient,
  provisionFeat004Profile,
  refreshFeat004RecipientToTestState,
  seedFeat004RecipientTestFixture,
  startFeat004Recipient,
} from "../../helpers/feat-004-owner-onboarding-recipient";

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      body: document.body.scrollWidth <= window.innerWidth,
      document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    })),
  ).toEqual({ body: true, document: true });
}

async function expectTouchTarget(control: Locator) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(44);
}

test("SL-F004-E2E-006 @p1 dono passa axe, teclado, foco e nomes nas duas rotas", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  expect([
    "axe-dark-chromium",
    "axe-desktop-chromium",
    "axe-mobile-chromium",
    "axe-narrow-chromium",
  ]).toContain(testInfo.project.name);
  const identity = createFeat004QaIdentity(testInfo, "006_accessibility");

  try {
    await provisionFeat004Profile(page, identity, {
      name: "Pessoa QA Dono Acessível",
      phone: "(41) 99999-4006",
    });
    await expect(page.getByRole("navigation", { name: "Área do dono" })).toBeVisible();
    await expectAxeClean(page);
    await expectNoHorizontalOverflow(page);

    const activationLink = page.getByRole("link", { exact: true, name: "Ativação" });
    const recipientLink = page.getByRole("link", { exact: true, name: "Recebimentos" });
    const checkbox = page.getByRole("checkbox", { name: /Li e aceito o Contrato do Dono/iu });
    const activationButton = page.getByRole("button", { name: "Ativar perfil de dono" });
    await expectTouchTarget(activationLink);
    await expectTouchTarget(recipientLink);
    await expectTouchTarget(activationButton);

    await activationLink.focus();
    await expect(activationLink).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(recipientLink).toBeFocused();
    await checkbox.focus();
    await expect(checkbox).toBeFocused();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    await page.keyboard.press("Space");
    await expect(checkbox).not.toBeChecked();
    await activationButton.focus();
    await page.keyboard.press("Enter");
    const fieldError = page.getByText(/Aceite|Invalid/iu).last();
    await expect(fieldError).toBeVisible();
    await expect(fieldError.locator("xpath=ancestor::*[@tabindex='-1'][1]")).toBeFocused();
    await expectAxeClean(page);

    await recipientLink.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { level: 1, name: "Cadastro de recebimentos" }),
    ).toBeVisible();
    await expect(
      page.getByText("Ative seu perfil de dono primeiro", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { exact: true, name: "Ir para ativação" })).toBeVisible();
    await expectAxeClean(page);
    await expectNoHorizontalOverflow(page);

    await page.getByRole("link", { exact: true, name: "Ativação" }).click();
    await activateFeat004Owner(page);
    await gotoFeat004Recipient(page);
    await startFeat004Recipient(page);
    const fixture =
      testInfo.project.name === "axe-mobile-chromium"
        ? "suspended"
        : testInfo.project.name === "axe-narrow-chromium"
          ? "blocked"
          : "refused";
    const expectedHeading = {
      blocked: "Bloqueado",
      refused: "Não aprovado",
      suspended: "Suspenso",
    }[fixture];
    await seedFeat004RecipientTestFixture(identity, fixture);
    await refreshFeat004RecipientToTestState(page, fixture);
    await expect(page.getByRole("heading", { level: 3, name: expectedHeading })).toBeVisible();
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
    await cleanupFeat004QaIdentity(identity);
  }
});
