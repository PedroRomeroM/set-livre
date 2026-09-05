import { expect, test, type Page } from "@playwright/test";

import {
  closeFeat008PageBeforeCleanup,
  cleanupFeat008QaIdentity,
  createFeat008QaIdentity,
  provisionFeat008StudioWithHarness,
  uploadFeat008Photos,
} from "../../helpers/feat-008-studio-media";

async function expectFeat008Reflow(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const controls = [
          ...document.querySelectorAll<HTMLElement>("a, button, input, select, textarea"),
        ];
        return {
          allControlsFit: controls.every((control) => {
            const bounds = control.getBoundingClientRect();
            return (
              bounds.left >= -0.5 && bounds.right <= document.documentElement.clientWidth + 0.5
            );
          }),
          bodyFits: document.body.scrollWidth <= window.innerWidth,
          clientWidth: document.documentElement.clientWidth,
          documentFits:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          innerWidth: window.innerWidth,
          visualViewportWidth: window.visualViewport?.width,
        };
      }),
    )
    .toEqual({
      allControlsFit: true,
      bodyFits: true,
      clientWidth: 160,
      documentFits: true,
      innerWidth: 160,
      visualViewportWidth: 160,
    });
}

test("SL-F008-E2E-011 @p2 galeria, fila e lightbox preservam reflow em 200%", async ({
  page,
}, testInfo) => {
  test.setTimeout(190_000);
  expect(page.viewportSize()).toEqual({ height: 360, width: 160 });
  const identity = createFeat008QaIdentity(testInfo, "011_reflow");
  try {
    await provisionFeat008StudioWithHarness(page, identity, "811");
    await expectFeat008Reflow(page);
    await uploadFeat008Photos(page, ["reflow-a.png", "reflow-b.png"]);
    await expectFeat008Reflow(page);
    await page.getByRole("button", { name: "Mover foto 2 para cima" }).click();
    await expect(
      page.getByText("Foto movida para a posição 1 de 2.", { exact: true }),
    ).toBeVisible();
    await expectFeat008Reflow(page);
    await page.getByRole("button", { name: /Visualizar foto 1/iu }).click();
    await expect(page.getByRole("dialog", { name: "Foto 1 de 2" })).toBeVisible();
    await expectFeat008Reflow(page);
  } finally {
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});
