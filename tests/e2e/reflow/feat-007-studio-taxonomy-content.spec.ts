import { expect, test, type Page } from "@playwright/test";

import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
} from "../../helpers/feat-006-studio-core-revision";
import {
  createFeat007QaIdentity,
  provisionFeat007Studio,
} from "../../helpers/feat-007-studio-taxonomy-content";

async function expectFeat007Reflow(page: Page) {
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

test("SL-F007-E2E-007 @p2 editor comercial preserva reflow em 200%", async ({ page }, testInfo) => {
  test.setTimeout(190_000);
  expect(page.viewportSize()).toEqual({ height: 360, width: 160 });
  const identity = createFeat007QaIdentity(testInfo, "007_reflow");
  try {
    await provisionFeat007Studio(page, identity, "707");
    await expectFeat007Reflow(page);
    await page.getByRole("button", { name: "Adicionar pergunta" }).click();
    await expect(page.getByRole("textbox", { name: "Pergunta 1" })).toBeVisible();
    await page.getByRole("textbox", { name: "Pergunta 1", exact: true }).fill("A".repeat(160));
    await page.getByRole("textbox", { name: "Resposta 1", exact: true }).fill("A".repeat(2_000));
    await page.getByRole("textbox", { name: "Regras de uso" }).fill("A".repeat(5_000));
    await expectFeat007Reflow(page);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});
