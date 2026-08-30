import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import {
  cleanupFeat031Users,
  createFeat031DirectIdentity,
  createFeat031Operator,
  loginFeat031Backoffice,
  provisionFeat031Operator,
} from "../../helpers/feat-031-backoffice-users-taxonomy";

test("SL-F031-E2E-007 @p1 backoffice passa axe, teclado, toque e 320 px sem revelar PII", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "007_accessibility");
  const target = await createFeat031DirectIdentity("Acessibilidade alvo");
  try {
    await provisionFeat031Operator(page, support, "support", "031007");
    await loginFeat031Backoffice(page, support);
    const search = page.getByRole("textbox", { name: "Buscar usuários" });
    await search.focus();
    await expect(search).toBeFocused();
    await search.fill(target.email);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Buscar" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: target.name })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() => ({
        body: document.body.scrollWidth <= window.innerWidth,
        document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        rawSensitiveControls: document.querySelectorAll(
          'input[name="taxId"], input[name="additionalDocument"]',
        ).length,
      })),
    ).toEqual({ body: true, document: true, rawSensitiveControls: 0 });
    await expect(page.locator("body")).not.toContainText(target.email);
    await expect(page.locator("body")).not.toContainText(target.taxId);
    const statusButton = page.getByRole("button", { name: "Revisar suspensão" });
    const box = await statusButton.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  } finally {
    await cleanupFeat031Users({ direct: [target], operators: [support] });
  }
});
