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

test("SL-F031-E2E-025 @p0 resposta perdida do logout fecha o shell e recompõe a sessão", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "025_ambiguous_logout_boundary");
  let upstreamLogoutStatus: number | undefined;
  const boundaryEvidenceKey = "sl-f031-025-private-boundary";
  try {
    await provisionFeat031Operator(page, support, "support", "031025");
    await loginFeat031Backoffice(page, support, { unlockRuntime: false });
    await page.evaluate((evidenceKey) => {
      window.sessionStorage.removeItem(evidenceKey);
      const captureClosedBoundary = () => {
        const privateHeadingVisible = Array.from(document.querySelectorAll("h1")).some(
          (heading) => heading.textContent?.trim() === "Usuários",
        );
        const transitionVisible = Array.from(document.querySelectorAll('[role="status"]')).some(
          (status) => status.textContent?.includes("Encerrando a visualização privada"),
        );
        if (transitionVisible && !privateHeadingVisible && document.querySelector("nav") === null) {
          window.sessionStorage.setItem(evidenceKey, "closed-before-navigation");
        }
      };
      const observer = new MutationObserver(captureClosedBoundary);
      observer.observe(document.body, { childList: true, subtree: true });
      captureClosedBoundary();
    }, boundaryEvidenceKey);
    await page.route(
      "**/api/auth/logout",
      async (route) => {
        const upstreamResponse = await route.fetch();
        upstreamLogoutStatus = upstreamResponse.status();
        await route.abort("failed");
      },
      { times: 1 },
    );

    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toBeVisible();
    await page.getByRole("button", { name: "Sair" }).click();
    await expect.poll(() => upstreamLogoutStatus).toBe(200);
    await expect(page).toHaveURL(/\/entrar$/u);
    await expect
      .poll(() =>
        page.evaluate(
          (evidenceKey) => window.sessionStorage.getItem(evidenceKey),
          boundaryEvidenceKey,
        ),
      )
      .toBe("closed-before-navigation");
  } finally {
    await page.unroute("**/api/auth/logout");
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [support] });
  }
});
