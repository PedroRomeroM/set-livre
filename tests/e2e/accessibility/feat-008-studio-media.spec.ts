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

async function holdPageAnimationFrames(page: Page) {
  return page.evaluateHandle(() => {
    const requestFrame = window.requestAnimationFrame;
    const cancelFrame = window.cancelAnimationFrame;
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = -1;
    let restored = false;
    window.requestAnimationFrame = (callback) => {
      const id = nextId--;
      pending.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!pending.delete(id)) cancelFrame.call(window, id);
    };
    return {
      async restore() {
        if (restored) return;
        restored = true;
        window.requestAnimationFrame = requestFrame;
        window.cancelAnimationFrame = cancelFrame;
        for (const callback of pending.values()) requestFrame.call(window, callback);
        pending.clear();
        await new Promise<void>((resolve) => {
          requestFrame.call(window, () => requestFrame.call(window, () => resolve()));
        });
      },
    };
  });
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

    const currentFirst = page.getByRole("button", { name: /Visualizar foto 1/iu });
    const reorderFrames = await holdPageAnimationFrames(page);
    try {
      await reorder.focus();
      await expect(reorder).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(
        page.getByText("Foto movida para a posição 2 de 2.", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /Visualizar foto 2/iu })).toBeFocused();
      await currentFirst.focus();
      await expect(currentFirst).toBeFocused();
      await reorderFrames.evaluate((frames) => frames.restore());
      await expect(currentFirst).toBeFocused();
    } finally {
      await reorderFrames.evaluate((frames) => frames.restore());
      await reorderFrames.dispose();
    }
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Foto 1 de 2" });
    await expect(dialog).toBeVisible();
    await expectTouchTarget(dialog.getByRole("button", { name: "Fechar visualização" }));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(currentFirst).toBeFocused();
    const cancelFrames = await holdPageAnimationFrames(page);
    try {
      const deleteButton = page.getByRole("button", { name: "Excluir foto 1" });
      await deleteButton.click();
      await page.getByRole("button", { name: "Manter foto" }).click();
      await expect(deleteButton).toBeFocused();
      await currentFirst.focus();
      await cancelFrames.evaluate((frames) => frames.restore());
      await expect(currentFirst).toBeFocused();
    } finally {
      await cancelFrames.evaluate((frames) => frames.restore());
      await cancelFrames.dispose();
    }
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
