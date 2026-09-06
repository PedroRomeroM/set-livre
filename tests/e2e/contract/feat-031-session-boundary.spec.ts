import { apiSuccessSchema, backofficeSessionSchema } from "@set-livre/contracts";
import { expect, test, type Page } from "@playwright/test";

import {
  getFeat002PasswordControl,
  stageFeat002PasswordForSubmission,
} from "../../helpers/feat-002-authentication";
import { readSafeE2EEnvironment } from "../../helpers/e2e-environment";
import {
  e2eDatabaseSafetyPreflight,
  withE2EAdminClient,
  withE2EDalClient,
} from "../../helpers/e2e-database-preflight";
import {
  cleanupFeat031Users,
  createFeat031DirectIdentity,
  createFeat031Operator,
  loginFeat031Backoffice,
  provisionFeat031Operator,
} from "../../helpers/feat-031-backoffice-users-taxonomy";
import {
  cleanupLocalAuthUser,
  cleanupLocalAuthUserWithDependencies,
} from "../../helpers/local-auth-cleanup";
import { closePageBeforeDatabaseCleanup } from "../../helpers/page-cleanup";

test("SL-F031-E2E-036 @p1 limpeza Auth QA aguarda leitores de sessão antes do cascade", async () => {
  const target = await createFeat031DirectIdentity("Limpeza concorrente QA");
  try {
    await withE2EDalClient(async (reader) => {
      await reader.query("begin");
      let readerOpen = true;
      try {
        await reader.query(
          "select pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0))",
        );
        await withE2EAdminClient(async (cleaner) => {
          const identity = await cleaner.query<{ pid: number }>("select pg_backend_pid() as pid");
          const pid = identity.rows[0]?.pid;
          if (pid === undefined) throw new Error("O backend de limpeza QA não foi identificado.");
          const pending = cleanupLocalAuthUserWithDependencies(
            { email: target.email, userId: target.userId },
            {
              preflight: e2eDatabaseSafetyPreflight,
              withClient: (operation) =>
                operation({
                  query: async (text, values) => {
                    const result = await cleaner.query(text, [...values]);
                    return { rowCount: result.rowCount, rows: result.rows };
                  },
                }),
            },
          ).then(
            (deleted) => ({ deleted, failed: false }),
            () => ({ deleted: false, failed: true }),
          );
          try {
            await expect
              .poll(async () => {
                const locks = await reader.query<{ waiting: boolean }>(
                  `select exists (
                    select 1 from pg_catalog.pg_locks
                    where pid = $1 and locktype = 'advisory'
                      and mode = 'ExclusiveLock' and not granted
                  ) as waiting`,
                  [pid],
                );
                return locks.rows[0]?.waiting;
              })
              .toBe(true);
          } finally {
            await reader.query("rollback");
            readerOpen = false;
            expect(await pending).toEqual({ deleted: true, failed: false });
          }
        });
      } finally {
        if (readerOpen) await reader.query("rollback");
      }
    });
    await expect(
      cleanupLocalAuthUser({ email: target.email, userId: target.userId }),
    ).resolves.toBe(false);
  } finally {
    await cleanupFeat031Users({ direct: [target] });
  }
});

async function recordPrivateBoundaryClosure(page: Page, evidenceKey: string) {
  await page.evaluate((key) => {
    window.sessionStorage.removeItem(key);
    const captureClosedBoundary = () => {
      const privateHeadingVisible = Array.from(document.querySelectorAll("h1")).some(
        (heading) => heading.textContent?.trim() === "Usuários",
      );
      const transitionVisible = Array.from(document.querySelectorAll('[role="status"]')).some(
        (status) => status.textContent?.includes("Encerrando a visualização privada"),
      );
      if (transitionVisible && !privateHeadingVisible && document.querySelector("nav") === null) {
        window.sessionStorage.setItem(key, "closed-before-navigation");
      }
    };
    const observer = new MutationObserver(captureClosedBoundary);
    observer.observe(document.body, { childList: true, subtree: true });
    captureClosedBoundary();
  }, evidenceKey);
}

async function expectRecordedPrivateBoundaryClosure(page: Page, evidenceKey: string) {
  await expect
    .poll(() => page.evaluate((key) => window.sessionStorage.getItem(key), evidenceKey))
    .toBe("closed-before-navigation");
}

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
    await recordPrivateBoundaryClosure(page, boundaryEvidenceKey);
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
    await expectRecordedPrivateBoundaryClosure(page, boundaryEvidenceKey);
  } finally {
    await page.unroute("**/api/auth/logout");
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [support] });
  }
});

test("SL-F031-E2E-029 @p0 logout offline fecha imediatamente a composição privada", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "029_offline_logout_boundary");
  const safeEnvironment = readSafeE2EEnvironment();
  const backofficeOrigin = new URL(safeEnvironment.backofficeBaseUrl).origin;
  let releaseNavigation: () => void = () => undefined;
  const navigationRelease = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  let offline = false;
  try {
    await provisionFeat031Operator(page, support, "support", "031029");
    await loginFeat031Backoffice(page, support, { unlockRuntime: false });
    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toBeVisible();
    await page.route(
      (url) =>
        url.origin === backofficeOrigin && (url.pathname === "/" || url.pathname === "/entrar"),
      async (route) => {
        await navigationRelease;
        await route.continue();
      },
    );

    await page.context().setOffline(true);
    offline = true;
    const failedLogout = page.waitForEvent("requestfailed", (request) => {
      const address = new URL(request.url());
      return address.pathname === "/api/auth/logout" && request.method() === "POST";
    });
    await page.getByRole("button", { name: "Sair" }).click();
    await failedLogout;

    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Encerrando a visualização privada" }),
    ).toBeVisible();

    const sessionResponse = page.waitForResponse((response) => {
      const address = new URL(response.url());
      return (
        address.origin === backofficeOrigin &&
        address.pathname === "/api/auth/session" &&
        response.request().method() === "GET"
      );
    });
    await page.context().setOffline(false);
    offline = false;
    releaseNavigation();
    const recoveredResponse = await sessionResponse;
    expect(recoveredResponse.status()).toBe(200);
    const recoveredSession = apiSuccessSchema(backofficeSessionSchema).parse(
      await recoveredResponse.json(),
    ).data;
    expect(recoveredSession).toMatchObject({ authenticated: true, email: support.email });
    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toBeVisible();
  } finally {
    releaseNavigation();
    if (offline) await page.context().setOffline(false);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [support] });
  }
});
