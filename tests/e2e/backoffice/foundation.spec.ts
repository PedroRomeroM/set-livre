import { expect, test } from "@playwright/test";

import { gotoExpectedPage } from "../../helpers/expected-page";

test("FOUNDATION-E2E-002 backoffice permanece em aplicação separada", async ({ page }) => {
  await gotoExpectedPage(page, "/", "Operação Set Livre");

  await expect(page.getByText("Acesso restrito a operadores autorizados")).toBeVisible();
  await expect(page.getByRole("button", { name: "Entrar no backoffice" })).toBeVisible();
});
