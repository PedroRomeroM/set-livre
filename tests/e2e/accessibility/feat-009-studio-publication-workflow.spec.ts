import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  cleanupFeat009QaIdentity,
  closeFeat009PageBeforeCleanup,
  createFeat009QaIdentity,
  provisionFeat009Studio,
} from "../../helpers/feat-009-studio-publication-workflow";

async function expectFeat009AxeClean(page: Page) {
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

test("SL-F009-E2E-007 @p1 publicação passa axe, teclado, foco, toque, 320 px e tema escuro", async ({
  page,
}, testInfo) => {
  test.setTimeout(280_000);
  expect([
    "axe-dark-chromium",
    "axe-desktop-chromium",
    "axe-mobile-chromium",
    "axe-narrow-chromium",
  ]).toContain(testInfo.project.name);
  const identity = createFeat009QaIdentity(testInfo, "007_accessibility_matrix");
  try {
    await provisionFeat009Studio(page, identity, "907", { complete: true });
    const submit = page.getByRole("button", { name: "Enviar revisão completa" });
    const publicationNavigation = page.getByRole("link", { exact: true, name: "Publicação" });
    const mediaNavigation = page.getByRole("link", { exact: true, name: "Fotos" });
    await expect(publicationNavigation).toHaveAttribute("aria-current", "page");
    await expectTouchTarget(submit);
    await expectTouchTarget(publicationNavigation);
    await expectTouchTarget(mediaNavigation);
    await expectNoHorizontalOverflow(page);
    await expectFeat009AxeClean(page);

    if (
      testInfo.project.name === "axe-mobile-chromium" ||
      testInfo.project.name === "axe-narrow-chromium"
    ) {
      await submit.tap();
    } else {
      await submit.focus();
      await expect(submit).toBeFocused();
      await page.keyboard.press("Enter");
    }

    const announcement = page.getByRole("status").filter({
      hasText: "A revisão foi enviada uma vez e agora permanece imutável durante a análise.",
    });
    await expect(announcement).toBeVisible();
    await expect(announcement).toBeFocused();
    await expect(page.getByRole("heading", { level: 2, name: "Em revisão" })).toBeVisible();
    await expect(page.getByText("Revisão pendente e imutável", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectFeat009AxeClean(page);

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
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});
