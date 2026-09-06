import { expect, test } from "@playwright/test";

import { gotoExpectedPage } from "../../helpers/expected-page";
import { readSafeE2EEnvironment } from "../../helpers/e2e-environment";

const { publicBaseUrl, backofficeBaseUrl } = readSafeE2EEnvironment();

test("FOUNDATION-E2E-011 zoom 200% preserva reflow nos dois apps", async ({ page }) => {
  for (const [surface, url, heading] of [
    ["public", publicBaseUrl, "Set Livre"],
    ["backoffice", backofficeBaseUrl, "Operação Set Livre"],
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

    const finalContent =
      surface === "public"
        ? page.getByText(
            "Esta tela comprova somente a fundação técnica. Nenhuma feature de produto é simulada.",
          )
        : page.getByRole("button", { name: "Entrar no backoffice" });
    await expect
      .poll(async () =>
        finalContent.evaluate((element) => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          const bounds = element.getBoundingClientRect();

          return bounds.bottom > 0 && bounds.top < window.innerHeight;
        }),
      )
      .toBe(true);
  }
});
