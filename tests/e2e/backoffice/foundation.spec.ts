import { expect, test } from "@playwright/test";

import { gotoExpectedPage } from "../../helpers/expected-page";

test("FOUNDATION-E2E-002 backoffice permanece em aplicação separada", async ({ page }) => {
  await gotoExpectedPage(page, "/", "Operação Set Livre");

  await expect(page.getByText("A fronteira administrativa está isolada")).toBeVisible();
});
