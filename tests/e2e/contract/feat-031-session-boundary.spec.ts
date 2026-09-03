import { expect, test } from "@playwright/test";

import {
  cleanupFeat031Users,
  createFeat031Operator,
  loginFeat031Backoffice,
  provisionFeat031Operator,
} from "../../helpers/feat-031-backoffice-users-taxonomy";
import { closePageBeforeDatabaseCleanup } from "../../helpers/page-cleanup";

test("SL-F031-E2E-016 @p0 logout confirmado oculta o shell antes da navegação", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "016_logout_boundary");
  let releaseNavigation: () => void = () => undefined;
  let markNavigationHeld: () => void = () => undefined;
  let navigationWasHeld = false;
  const navigationRelease = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  const navigationHeld = new Promise<void>((resolve) => {
    markNavigationHeld = resolve;
  });
  try {
    await provisionFeat031Operator(page, support, "support", "031016");
    await loginFeat031Backoffice(page, support, { unlockRuntime: false });
    await page.route("**/entrar**", async (route) => {
      const address = new URL(route.request().url());
      if (
        navigationWasHeld ||
        address.pathname !== "/entrar" ||
        address.searchParams.get("saida") !== "sucesso"
      ) {
        await route.continue();
        return;
      }
      navigationWasHeld = true;
      markNavigationHeld();
      await navigationRelease;
      await route.continue();
    });

    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toBeVisible();
    const logoutResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/logout" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sair" }).click();
    expect((await logoutResponse).status()).toBe(200);
    await navigationHeld;

    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Encerrando a visualização privada" }),
    ).toBeVisible();

    releaseNavigation();
    await expect(page).toHaveURL(/\/entrar\?saida=sucesso/u);
  } finally {
    releaseNavigation();
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [support] });
  }
});
