import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
  createFeat006QaIdentity,
  fillFeat006Core,
  provisionFeat006Owner,
} from "../../helpers/feat-006-studio-core-revision";

async function expectAxeClean(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
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

test("SL-F006-E2E-006 @p1 editor principal passa axe, teclado, toque e mobile", async ({
  page,
}, testInfo) => {
  test.setTimeout(170_000);
  expect([
    "axe-dark-chromium",
    "axe-desktop-chromium",
    "axe-mobile-chromium",
    "axe-narrow-chromium",
  ]).toContain(testInfo.project.name);
  const identity = createFeat006QaIdentity(testInfo, "006_accessibility");
  try {
    await provisionFeat006Owner(page, identity, "006");
    const createButton = page.getByRole("button", { name: "Criar estúdio em rascunho" });
    const studioNavigation = page.getByRole("link", { exact: true, name: "Novo estúdio" });
    await expectTouchTarget(createButton);
    await expectTouchTarget(studioNavigation);
    await expectAxeClean(page);
    await expectNoHorizontalOverflow(page);

    const name = page.getByRole("textbox", { name: "Nome do estúdio" });
    await name.focus();
    await expect(name).toBeFocused();
    await fillFeat006Core(page);
    await createButton.focus();
    await expect(createButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dono\/estudios\/[0-9a-f-]+\/dados$/u);
    await expect(page.getByText("Rascunho privado", { exact: true })).toBeVisible();
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
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});
