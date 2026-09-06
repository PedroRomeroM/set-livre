import { expect, test } from "@playwright/test";

import { gotoExpectedPage } from "../../helpers/expected-page";
import { readSafeE2EEnvironment } from "../../helpers/e2e-environment";

const { publicBaseUrl, backofficeBaseUrl } = readSafeE2EEnvironment();

test("FOUNDATION-E2E-010 safe areas preservam as duas superfícies", async ({ context, page }) => {
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { bottom: 34, left: 19, right: 21, top: 47 },
  });

  try {
    for (const [url, heading] of [
      [publicBaseUrl, "Set Livre"],
      [backofficeBaseUrl, "Operação Set Livre"],
    ] as const) {
      await gotoExpectedPage(page, url, heading);

      const viewportMetadata = await page.locator('meta[name="viewport"]').getAttribute("content");
      expect(viewportMetadata).toContain("viewport-fit=cover");

      const layout = await page.getByRole("main").evaluate((main) => {
        const style = getComputedStyle(main);

        return {
          hasHorizontalOverflow:
            document.documentElement.scrollWidth > document.documentElement.clientWidth,
          paddingBottom: Number.parseFloat(style.paddingBottom),
          paddingLeft: Number.parseFloat(style.paddingLeft),
          paddingRight: Number.parseFloat(style.paddingRight),
          paddingTop: Number.parseFloat(style.paddingTop),
        };
      });

      expect(layout).toEqual({
        hasHorizontalOverflow: false,
        paddingBottom: 34,
        paddingLeft: 19,
        paddingRight: 21,
        paddingTop: 47,
      });
    }
  } finally {
    await session.detach();
  }
});
