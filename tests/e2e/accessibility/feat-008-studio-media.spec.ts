import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  closeFeat008PageBeforeCleanup,
  cleanupFeat008QaIdentity,
  createFeat008QaIdentity,
  provisionFeat008StudioWithHarness,
  uploadFeat008Photos,
} from "../../helpers/feat-008-studio-media";

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

test("SL-F008-E2E-010 @p1 galeria passa axe, teclado, foco, tema escuro e viewports móveis", async ({
  page,
}, testInfo) => {
  test.setTimeout(190_000);
  expect([
    "axe-dark-chromium",
    "axe-desktop-chromium",
    "axe-mobile-chromium",
    "axe-narrow-chromium",
  ]).toContain(testInfo.project.name);
  const identity = createFeat008QaIdentity(testInfo, "010_accessibility_matrix");
  try {
    await provisionFeat008StudioWithHarness(page, identity, "810");
    await uploadFeat008Photos(page, ["acessibilidade-a.png", "acessibilidade-b.png"]);
    const thumbnail = page.getByRole("button", { name: /Visualizar foto 1/iu });
    const reorder = page.getByRole("button", { name: "Mover foto 1 para baixo" });
    await expectTouchTarget(thumbnail);
    await expectTouchTarget(reorder);
    await expectNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await reorder.focus();
    await expect(reorder).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Foto movida para a posição 2 de 2.", { exact: true }),
    ).toBeVisible();
    const currentFirst = page.getByRole("button", { name: /Visualizar foto 1/iu });
    await currentFirst.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Foto 1 de 2" });
    await expect(dialog).toBeVisible();
    await expectTouchTarget(dialog.getByRole("button", { name: "Fechar visualização" }));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(currentFirst).toBeFocused();
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
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});
