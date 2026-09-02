import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  cleanupFeat030Scenario,
  createFeat030Operator,
  expectFeat030PreviewsInspectable,
  openFeat030StudioReview,
  provisionAndLoginFeat030Operator,
  provisionFeat030PendingStudio,
  type Feat030Owner,
} from "../../helpers/feat-030-backoffice-studio-review";

const signedPreviewPattern = "**/storage/v1/object/sign/**";
const extremePortraitPreview =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="8192" viewBox="0 0 1 8192"><path fill="#64748b" d="M0 0h1v8192H0z"/></svg>';

async function tabTo(page: Page, target: Locator) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("O controle esperado não foi alcançado pela ordem real de tabulação.");
}

async function expectTouchTarget(target: Locator) {
  const bounds = await target.boundingBox();
  if (bounds === null) throw new Error("O alvo interativo não possui geometria verificável.");
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.width).toBeGreaterThanOrEqual(44);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      body: document.body.scrollWidth <= window.innerWidth,
      document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    })),
  ).toEqual({ body: true, document: true });
}

async function expectAxeClean(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

test("SL-F030-E2E-007 @p1 confirmação passa axe, teclado real, foco, toque e 320 px", async ({
  page,
}, testInfo) => {
  test.setTimeout(280_000);
  expect([
    "axe-dark-chromium",
    "axe-desktop-chromium",
    "axe-mobile-chromium",
    "axe-narrow-chromium",
  ]).toContain(testInfo.project.name);
  const reviewer = createFeat030Operator(testInfo, "007_accessibility");
  let owner: Feat030Owner | undefined;
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "007_accessibility",
      "3007",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030007");
    await page.route(signedPreviewPattern, async (route) => {
      await route.fulfill({
        body: extremePortraitPreview,
        contentType: "image/svg+xml",
        status: 200,
      });
    });
    await openFeat030StudioReview(page, pending.studioId, pending.name);
    await expectFeat030PreviewsInspectable(page);

    if (testInfo.project.name === "axe-narrow-chromium") {
      const mediaGeometry = await page
        .getByRole("img", { name: /foto \d+(?:, capa)?$/u })
        .first()
        .evaluate((image) => {
          if (!(image instanceof HTMLImageElement)) {
            throw new Error("A prévia não foi renderizada como imagem.");
          }
          return {
            frameHeight: image.parentElement?.getBoundingClientRect().height ?? 0,
            height: image.getBoundingClientRect().height,
            maximumFrameHeight: Math.min(512, Math.max(160, window.innerHeight * 0.6)) + 2,
            naturalHeight: image.naturalHeight,
            naturalWidth: image.naturalWidth,
          };
        });
      expect(mediaGeometry).toMatchObject({ naturalHeight: 8192, naturalWidth: 1 });
      expect(mediaGeometry.frameHeight).toBeLessThanOrEqual(mediaGeometry.maximumFrameHeight);
      expect(mediaGeometry.height).toBeLessThanOrEqual(mediaGeometry.frameHeight);
    }

    const approve = page.getByRole("button", { name: "Aprovar e publicar" });
    await expect(approve).toBeEnabled();
    await expectTouchTarget(approve);
    await expectNoHorizontalOverflow(page);
    await expectAxeClean(page);

    await tabTo(page, approve);
    await expect(approve).toBeFocused();
    await page.keyboard.press("Enter");

    const confirmation = page.getByRole("heading", { name: "Confirmar impacto" }).locator("..");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toBeFocused();
    const checkbox = page.getByRole("checkbox", {
      name: "Revisei a candidata, a versão vigente e o impacto desta ação",
    });
    const confirm = page.getByRole("button", { name: "Confirmar ação", exact: true });
    const cancel = page.getByRole("button", { name: "Cancelar", exact: true });
    await expectTouchTarget(checkbox.locator(".."));
    await expectTouchTarget(confirm);
    await expectTouchTarget(cancel);
    await expectNoHorizontalOverflow(page);
    await expectAxeClean(page);

    await tabTo(page, checkbox);
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    await tabTo(page, cancel);
    await page.keyboard.press("Enter");
    await expect(confirmation).toHaveCount(0);
    await expect(approve).toBeFocused();

    await page.keyboard.press("Enter");
    const reopenedConfirmation = page
      .getByRole("heading", { name: "Confirmar impacto" })
      .locator("..");
    await expect(reopenedConfirmation).toBeFocused();
    const reopenedCheckbox = page.getByRole("checkbox", {
      name: "Revisei a candidata, a versão vigente e o impacto desta ação",
    });
    await tabTo(page, reopenedCheckbox);
    await page.keyboard.press("Space");
    await expect(reopenedCheckbox).toBeChecked();
    const reopenedConfirm = page.getByRole("button", { name: "Confirmar ação", exact: true });
    await tabTo(page, reopenedConfirm);
    await page.keyboard.press("Enter");

    const completion = page.locator('[aria-labelledby="studio-review-complete"]');
    await expect(completion).toBeVisible();
    await expect(completion).toBeFocused();
    await expectAxeClean(page);

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
    await page.unroute(signedPreviewPattern);
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});
