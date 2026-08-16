import { expect, test, type Page } from "@playwright/test";

import {
  cleanupFeat006QaIdentity,
  createFeat006QaIdentity,
  createFeat006Studio,
  createFeat006StudioCore,
  fillFeat006StudioCore,
  gotoFeat006NewStudio,
  provisionFeat006Owner,
} from "../../helpers/feat-006-studio-core-revision";

test.use({ screenshot: "off", trace: "off", video: "off" });

async function expectFeat006Reflow(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const interactiveElements = [
          ...document.querySelectorAll<HTMLElement>("a, button, input, select, textarea"),
        ];
        return {
          allInteractiveElementsFit: interactiveElements.every((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              bounds.left >= -0.5 && bounds.right <= document.documentElement.clientWidth + 0.5
            );
          }),
          bodyFitsViewport: document.body.scrollWidth <= window.innerWidth,
          documentClientWidth: document.documentElement.clientWidth,
          documentFitsViewport:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          innerWidth: window.innerWidth,
          readyState: document.readyState,
          visualViewportWidth: window.visualViewport?.width,
        };
      }),
    )
    .toMatchObject({
      allInteractiveElementsFit: true,
      bodyFitsViewport: true,
      documentClientWidth: 160,
      documentFitsViewport: true,
      innerWidth: 160,
      readyState: "complete",
      visualViewportWidth: 160,
    });
}

test("SL-F006-E2E-006 @p1 editor preserva operação no reflow do zoom de 200%", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  expect([
    "zoom-200-reflow-chromium",
    "zoom-200-reflow-firefox",
    "zoom-200-reflow-webkit",
  ]).toContain(testInfo.project.name);
  expect(page.viewportSize()).toEqual({ height: 360, width: 160 });
  const identity = createFeat006QaIdentity(testInfo, "006_reflow");
  const core = createFeat006StudioCore("006_reflow");

  try {
    await provisionFeat006Owner(page, identity);
    await gotoFeat006NewStudio(page);
    await expectFeat006Reflow(page);

    await fillFeat006StudioCore(page, core);
    await expectFeat006Reflow(page);

    const created = await createFeat006Studio(page);
    expect(created.studio).toMatchObject({
      draft: {
        core: { capacity: core.capacity, name: core.name },
        revisionNumber: 1,
      },
      published: null,
      status: "draft",
    });
    await page.waitForURL(`/dono/estudios/${created.studio.id}/dados`);
    await expect(page.getByRole("heading", { level: 1, name: "Dados do estúdio" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 3, name: "Rascunho · revisão 1" }),
    ).toBeVisible();
    await expectFeat006Reflow(page);
  } finally {
    await cleanupFeat006QaIdentity(identity);
  }
});
