import { expect, test, type Page } from "@playwright/test";

import { saveFeat006StudioThroughUi } from "../../helpers/feat-006-studio-core-revision";
import {
  cleanupFeat009QaIdentity,
  closeFeat009PageBeforeCleanup,
  createFeat009QaIdentity,
  openFeat009Publication,
  provisionFeat009Studio,
  submitFeat009RevisionThroughUi,
} from "../../helpers/feat-009-studio-publication-workflow";

async function expectFeat009Reflow(page: Page) {
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

test("SL-F009-E2E-008 @p2 publicação permanece operável em reflow de 200%", async ({
  page,
}, testInfo) => {
  test.setTimeout(280_000);
  expect(page.viewportSize()).toEqual({ height: 360, width: 160 });
  const identity = createFeat009QaIdentity(testInfo, "008_reflow");
  try {
    const fixture = await provisionFeat009Studio(page, identity, "908", { complete: true });
    await page.goto(`/dono/estudios/${fixture.editor.studioId}/dados`);
    const description = page.getByRole("textbox", { name: "Descrição" });
    await expect(description).toBeEnabled();
    await description.fill("A".repeat(5_000));
    const saved = await saveFeat006StudioThroughUi(page);
    expect(saved.response.status()).toBe(200);
    await openFeat009Publication(page, fixture.editor.studioId);
    await expectFeat009Reflow(page);
    await expect(page.getByRole("button", { name: "Enviar revisão completa" })).toBeVisible();

    const submitted = await submitFeat009RevisionThroughUi(page);
    expect(submitted.response.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 2, name: "Em revisão" })).toBeVisible();
    await expect(page.getByText("Revisão pendente e imutável", { exact: true })).toBeVisible();
    await expectFeat009Reflow(page);
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});
