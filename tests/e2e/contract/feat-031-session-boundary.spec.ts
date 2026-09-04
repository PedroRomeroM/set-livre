import { expect, test, type Page } from "@playwright/test";

import {
  getFeat002PasswordControl,
  stageFeat002PasswordForSubmission,
} from "../../helpers/feat-002-authentication";
import { readSafeE2EEnvironment } from "../../helpers/e2e-environment";
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

test("SL-F031-E2E-026 @p0 login ambíguo fecha a sessão privada nas outras abas", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const firstOperator = createFeat031Operator(testInfo, "026_first_operator");
  const secondOperator = createFeat031Operator(testInfo, "026_second_operator");
  const safeEnvironment = readSafeE2EEnvironment();
  const setupContext = await browser.newContext({ baseURL: safeEnvironment.publicBaseUrl });
  const setupPage = await setupContext.newPage();
  let staleLoginPage: Page | undefined;
  let releaseNavigation: () => void = () => undefined;
  let markNavigationHeld: () => void = () => undefined;
  let upstreamLoginStatus: number | undefined;
  const navigationRelease = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  const navigationHeld = new Promise<void>((resolve) => {
    markNavigationHeld = resolve;
  });
  try {
    await provisionFeat031Operator(page, firstOperator, "support", "031026a");
    await provisionFeat031Operator(setupPage, secondOperator, "support", "031026b");
    await setupContext.close();

    staleLoginPage = await page.context().newPage();
    const staleLogin = await staleLoginPage.goto(`${safeEnvironment.backofficeBaseUrl}/entrar`);
    expect(staleLogin?.status()).toBe(200);
    await expect(
      staleLoginPage.getByRole("heading", { level: 1, name: "Operação Set Livre" }),
    ).toBeVisible();
    await loginFeat031Backoffice(page, firstOperator, { unlockRuntime: false });

    await page.route(
      (url) =>
        url.origin === new URL(safeEnvironment.backofficeBaseUrl).origin &&
        (url.pathname === "/" || url.pathname === "/entrar"),
      async (route) => {
        markNavigationHeld();
        await navigationRelease;
        await route.continue();
      },
    );
    await staleLoginPage.route(
      "**/api/auth/login",
      async (route) => {
        const response = await route.fetch();
        upstreamLoginStatus = response.status();
        await route.abort("failed");
      },
      { times: 1 },
    );

    const email = staleLoginPage.getByRole("textbox", { name: "E-mail" });
    const password = getFeat002PasswordControl(staleLoginPage, "Senha");
    await email.fill(secondOperator.email);
    await stageFeat002PasswordForSubmission(password, secondOperator.password);
    await staleLoginPage.getByRole("button", { name: "Entrar no backoffice" }).click();
    await expect.poll(() => upstreamLoginStatus).toBe(200);
    await navigationHeld;

    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Encerrando a visualização privada" }),
    ).toBeVisible();
  } finally {
    releaseNavigation();
    await setupContext.close().catch(() => undefined);
    if (staleLoginPage !== undefined) {
      await staleLoginPage.unrouteAll({ behavior: "ignoreErrors" });
      await closePageBeforeDatabaseCleanup(staleLoginPage);
    }
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [firstOperator, secondOperator] });
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
