import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { gotoExpectedPage } from "../../helpers/expected-page";
import { readSafeE2EEnvironment } from "../../helpers/e2e-environment";

const { publicBaseUrl, backofficeBaseUrl } = readSafeE2EEnvironment();

async function expectRenderedTheme(page: Parameters<typeof gotoExpectedPage>[0]) {
  const renderedTheme = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);

    return {
      canvas: rootStyle.getPropertyValue("--sl-color-canvas").trim(),
      colorScheme: rootStyle.colorScheme,
      ink: rootStyle.getPropertyValue("--sl-color-ink-strong").trim(),
    };
  });
  const expectsDarkTheme = test.info().project.name === "axe-dark-chromium";

  expect(renderedTheme).toEqual(
    expectsDarkTheme
      ? { canvas: "#0e1914", colorScheme: "dark", ink: "#f2f7f4" }
      : { canvas: "#eaf0ec", colorScheme: "light", ink: "#15241e" },
  );
}

test("FOUNDATION-E2E-004 @a11y aplicação pública não possui violações axe", async ({ page }) => {
  await gotoExpectedPage(page, publicBaseUrl, "Set Livre");
  await expectRenderedTheme(page);

  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations).toEqual([]);
});

test("FOUNDATION-E2E-007 @a11y backoffice não possui violações axe", async ({ page }) => {
  await gotoExpectedPage(page, backofficeBaseUrl, "Operação Set Livre");
  await expectRenderedTheme(page);

  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations).toEqual([]);
});

test("FOUNDATION-E2E-009 @a11y conteúdo aceita texto ampliado a 200%", async ({ page }) => {
  for (const [surface, url, heading] of [
    ["public", publicBaseUrl, "Set Livre"],
    ["backoffice", backofficeBaseUrl, "Operação Set Livre"],
  ] as const) {
    await gotoExpectedPage(page, url, heading);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    const finalContent =
      surface === "public"
        ? page.getByText(
            "Esta tela comprova somente a fundação técnica. Nenhuma feature de produto é simulada.",
          )
        : page.getByRole("button", { name: "Entrar no backoffice" });
    await finalContent.scrollIntoViewIfNeeded();
    await expect(finalContent).toBeInViewport();
  }
});
