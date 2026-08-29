import { expect, test, type Page } from "@playwright/test";

import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
  createFeat006QaIdentity,
  createFeat006StudioThroughUi,
  fillFeat006Core,
  provisionFeat006Owner,
} from "../../helpers/feat-006-studio-core-revision";

async function expectFeat006Reflow(page: Page) {
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

test("SL-F006-E2E-007 @p2 criação e editor preservam reflow em 200%", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  expect(page.viewportSize()).toEqual({ height: 360, width: 160 });
  const identity = createFeat006QaIdentity(testInfo, "007_reflow");
  try {
    await provisionFeat006Owner(page, identity, "007");
    await expectFeat006Reflow(page);
    await fillFeat006Core(page);
    await expectFeat006Reflow(page);
    await createFeat006StudioThroughUi(page);
    await expect(page.getByText("Rascunho privado", { exact: true })).toBeVisible();
    await expectFeat006Reflow(page);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});
