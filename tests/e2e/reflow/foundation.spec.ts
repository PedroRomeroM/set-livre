import { expect, test } from "@playwright/test";

import { gotoExpectedPage } from "../../helpers/expected-page";

const publicBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const backofficeBaseUrl = process.env.E2E_BACKOFFICE_URL ?? "http://127.0.0.1:3001";

test("FOUNDATION-E2E-011 zoom 200% preserva reflow nos dois apps", async ({ page }) => {
  for (const [url, heading] of [
    [publicBaseUrl, "Set Livre"],
    [backofficeBaseUrl, "Operação Set Livre"],
  ] as const) {
    await gotoExpectedPage(page, url, heading);

    await expect
      .poll(async () => {
        try {
          return await page.evaluate(() => ({
            bodyFitsViewport: document.body.scrollWidth <= window.innerWidth,
            documentClientWidth: document.documentElement.clientWidth,
            documentFitsViewport:
              document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            innerWidth: window.innerWidth,
            readyState: document.readyState,
            visualViewportWidth: window.visualViewport?.width,
          }));
        } catch {
          return null;
        }
      })
      .toMatchObject({
        bodyFitsViewport: true,
        documentClientWidth: 160,
        documentFitsViewport: true,
        innerWidth: 160,
        readyState: "complete",
        visualViewportWidth: 160,
      });

    const finalNote = page.getByText(
      "Esta tela comprova somente a fundação técnica. Nenhuma feature de produto é simulada.",
    );
    await expect
      .poll(async () =>
        finalNote.evaluate((element) => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          const bounds = element.getBoundingClientRect();

          return bounds.bottom > 0 && bounds.top < window.innerHeight;
        }),
      )
      .toBe(true);
  }
});
