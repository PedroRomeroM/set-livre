import { expect, test } from "@playwright/test";

test("SL-F030-E2E-006 @p0 aplicação pública não expõe rota administrativa", async ({ page }) => {
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: /administra|backoffice|estúdios/u })).toHaveCount(
    0,
  );
});
