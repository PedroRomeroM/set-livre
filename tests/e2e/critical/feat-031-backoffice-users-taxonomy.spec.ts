import { apiSuccessSchema, backofficeSessionSchema } from "@set-livre/contracts";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

import {
  cleanupFeat031Taxonomy,
  cleanupFeat031Users,
  createFeat031DirectIdentity,
  createFeat031Operator,
  expectFeat031OwnerCommandBlocked,
  linkFeat031TagToHistory,
  loginFeat031Backoffice,
  provisionFeat031Operator,
  readFeat031Audit,
  readFeat031Roles,
  readFeat031TaxonomyHistory,
  readFeat031UserStatus,
  unlockFeat031Backoffice,
} from "../../helpers/feat-031-backoffice-users-taxonomy";
import { withE2EAdminClient } from "../../helpers/e2e-database-preflight";
import { closePageBeforeDatabaseCleanup } from "../../helpers/page-cleanup";
import { readSafeE2EEnvironment } from "../../helpers/e2e-environment";

const safeE2EEnvironment = readSafeE2EEnvironment();
type BrowserCookies = Awaited<ReturnType<BrowserContext["cookies"]>>;

function createHeldResponseGate(options: { outcome: "abort" | "fulfill" }) {
  let releaseResponse: () => void = () => undefined;
  let reportResponseReady: () => void = () => undefined;
  let responseHandled = false;
  const responseReady = new Promise<void>((resolve) => {
    reportResponseReady = () => resolve();
  });
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = () => resolve();
  });

  return {
    handle: async (route: Route) => {
      if (responseHandled) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      responseHandled = true;
      reportResponseReady();
      await responseReleased;
      if (options.outcome === "abort") {
        await route.abort("failed");
      } else {
        await route.fulfill({ response });
      }
    },
    release: () => releaseResponse(),
    waitUntilReady: () => responseReady,
    wasHandled: () => responseHandled,
  };
}

function createHeldOfflineNavigationGate() {
  let releaseNavigation: () => void = () => undefined;
  const navigationReleased = new Promise<void>((resolve) => {
    releaseNavigation = () => resolve();
  });

  return {
    handle: async (route: Route) => {
      await navigationReleased;
      await route.abort("internetdisconnected");
    },
    release: () => releaseNavigation(),
  };
}

async function holdAuthoritativeNavigation(
  page: Page,
  gate: Readonly<{ handle: (route: Route) => Promise<void> }>,
) {
  await page.route(
    (url) =>
      url.origin === new URL(safeE2EEnvironment.backofficeBaseUrl).origin &&
      (url.pathname === "/" || url.pathname === "/entrar"),
    gate.handle,
  );
}

async function expectBackofficeLoginClosedWithoutHydration(browser: Browser) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    const navigation = await page.goto(`${safeE2EEnvironment.backofficeBaseUrl}/entrar`);
    expect(navigation?.status()).toBe(200);
    await expect(page.locator("h1", { hasText: /^Operação Set Livre$/u })).toBeAttached();
    await expect(
      page.locator('[role="status"]', { hasText: /^Preparando o acesso seguro…$/u }),
    ).toBeAttached();

    const form = page.locator("form", { has: page.locator('input[name="email"]') });
    await expect(form).toBeAttached();
    await expect(form).toHaveAttribute("inert", "");
    await expect(form).toHaveAttribute("method", "post");
    await expect(form.locator("fieldset")).toHaveAttribute("disabled", "");
    await expect(form.locator('input[name="email"]')).toHaveAttribute("disabled", "");
    await expect(form.locator('input[name="password"]')).toHaveAttribute("disabled", "");
    await expect(form.locator('button[type="submit"]')).toHaveAttribute("disabled", "");
    await expect(page.getByRole("alert")).toContainText(
      "Habilite o JavaScript neste navegador e recarregue a página",
    );
    expect(new URL(page.url()).pathname).toBe("/entrar");
  } finally {
    await context.close();
  }
}

async function expectBackofficeRuntimeClosedWithoutHydration(
  browser: Browser,
  cookies: BrowserCookies,
) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies(cookies);
  const page = await context.newPage();
  try {
    const navigation = await page.goto(`${safeE2EEnvironment.backofficeBaseUrl}/usuarios`);
    expect(navigation?.status()).toBe(200);
    await expect(page.locator("h1", { hasText: /^Usuários$/u })).toBeAttached();
    await expect(
      page.getByRole("alert").filter({
        hasText: "Habilite o JavaScript e recarregue a página para desbloquear operações críticas",
      }),
    ).toBeAttached();

    const logout = page.getByRole("button", { name: "Sair" });
    await expect(logout).toBeDisabled();
    const logoutClickDispatched = await logout.evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("O controle de logout precisa permanecer um button nativo.");
      }
      let clickDispatched = false;
      button.addEventListener("click", () => {
        clickDispatched = true;
      });
      button.click();
      return clickDispatched;
    });
    expect(logoutClickDispatched).toBe(false);
    expect(new URL(page.url()).pathname).toBe("/usuarios");

    const form = page.locator("form", {
      has: page.locator('input[name="runtimeUnlockKey"]'),
    });
    await expect(form).toHaveAttribute("inert", "");
    await expect(form).toHaveAttribute("method", "post");
    await expect(form.locator("fieldset")).toHaveAttribute("disabled", "");
    await expect(form.locator('input[name="runtimeUnlockKey"]')).toHaveAttribute("disabled", "");
    await expect(form.locator('button[type="submit"]')).toHaveAttribute("disabled", "");

    const searchForm = page.locator("form", {
      has: page.locator('input[name="query"]'),
    });
    await expect(searchForm).toHaveAttribute("inert", "");
    await expect(searchForm).toHaveAttribute("method", "post");
    await expect(searchForm.locator("fieldset")).toHaveAttribute("disabled", "");
    await expect(searchForm.locator('input[name="query"]')).toHaveAttribute("disabled", "");
    await expect(searchForm.locator('button[type="submit"]')).toHaveAttribute("disabled", "");

    const taxonomyNavigation = await page.goto(
      `${safeE2EEnvironment.backofficeBaseUrl}/taxonomias`,
    );
    expect(taxonomyNavigation?.status()).toBe(200);
    await expect(page.locator("h1", { hasText: /^Taxonomias$/u })).toBeAttached();
    const taxonomyForm = page.locator("form", {
      has: page.locator('input[name="slug"]'),
    });
    await expect(taxonomyForm).toHaveAttribute("inert", "");
    await expect(taxonomyForm).toHaveAttribute("method", "post");
    await expect(taxonomyForm.locator("fieldset")).toHaveAttribute("disabled", "");
    await expect(taxonomyForm.locator('select[name="kind"]')).toHaveAttribute("disabled", "");
    await expect(taxonomyForm.locator('input[name="sortOrder"]')).toHaveAttribute("disabled", "");
    await expect(taxonomyForm.locator('input[name="name"]')).toHaveAttribute("disabled", "");
    await expect(taxonomyForm.locator('input[name="slug"]')).toHaveAttribute("disabled", "");
    await expect(taxonomyForm.locator('button[type="submit"]')).toHaveAttribute("disabled", "");
  } finally {
    await context.close();
  }
}

async function searchUser(page: Page, query: string, userId: string | undefined) {
  if (userId === undefined) throw new Error("A busca FEAT-031 exige o UUID do usuário-alvo.");
  await page.getByRole("textbox", { name: "Buscar usuários" }).fill(query);
  await page.getByRole("button", { name: "Buscar" }).click();
  const card = page
    .getByRole("article")
    .filter({ has: page.getByText(`Identificador …${userId.slice(-8)}`, { exact: true }) });
  await expect(card).toBeVisible();
  return card;
}

async function expireStrongAuthentication(userId: string | undefined) {
  if (userId === undefined) {
    throw new Error("A expiração de autenticação forte exige o operador provisionado.");
  }
  await withE2EAdminClient(async (client) => {
    const result = await client.query(
      `update private.backoffice_sessions
       set opened_at = least(opened_at, pg_catalog.clock_timestamp() - interval '6 minutes')
       where user_id = $1::uuid and closed_at is null
       returning auth_session_id`,
      [userId],
    );
    if (result.rowCount !== 1) {
      throw new Error("A sessão administrativa corrente não foi encontrada para expiração forte.");
    }
  });
}

test("SL-F031-E2E-001 @p0 support suspende e restaura conta enquanto comandos ficam bloqueados", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const operator = createFeat031Operator(testInfo, "001_support_status");
  const target = await createFeat031DirectIdentity("Status alvo", true);
  try {
    await provisionFeat031Operator(page, operator, "support", "031001");
    await loginFeat031Backoffice(page, operator);
    let card = await searchUser(page, target.email, target.userId);
    await card.getByRole("button", { name: "Revisar suspensão" }).click();
    const confirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    const confirm = confirmation.getByRole("button", { name: "Confirmar" });
    await expect(confirm).toBeDisabled();
    await confirmation.getByRole("checkbox", { name: "Revisei o impacto desta alteração" }).check();
    await confirm.click();
    await expect(page.getByRole("status").filter({ hasText: "Usuário suspenso" })).toBeVisible();
    expect(await readFeat031UserStatus(target.userId)).toMatchObject({
      account_version: 1,
      profile_version: 1,
      status: "suspended",
    });
    await expectFeat031OwnerCommandBlocked(target.userId);
    expect(await readFeat031Audit("backoffice.user_suspended", target.userId)).toHaveLength(1);

    card = await searchUser(page, target.email, target.userId);
    await card.getByRole("button", { name: "Revisar restauração" }).click();
    const restoration = page.getByRole("region", { name: "Confirmar restauração" });
    await restoration.getByRole("checkbox", { name: "Revisei o impacto desta alteração" }).check();
    await restoration.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Usuário restaurado" })).toBeVisible();
    expect(await readFeat031UserStatus(target.userId)).toMatchObject({
      account_version: 2,
      profile_version: 1,
      status: "active",
    });
    expect(await readFeat031Audit("backoffice.user_restored", target.userId)).toHaveLength(1);
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [target], operators: [operator] });
  }
});

test("SL-F031-E2E-020 @p0 auto-suspensão fecha o shell antes da recomposição", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "020_self_suspension");
  const heldNavigation = createHeldResponseGate({ outcome: "fulfill" });
  try {
    await provisionFeat031Operator(page, support, "support", "031020");
    await loginFeat031Backoffice(page, support);
    await holdAuthoritativeNavigation(page, heldNavigation);

    const card = await searchUser(page, support.email, support.userId);
    await card.getByRole("button", { name: "Revisar suspensão" }).click();
    const confirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    await confirmation.getByRole("checkbox", { name: "Revisei o impacto desta alteração" }).check();
    const response = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/api/commands" &&
        candidate.request().method() === "POST",
    );
    await confirmation.getByRole("button", { name: "Confirmar" }).click();
    expect((await response).status()).toBe(200);
    await heldNavigation.waitUntilReady();

    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Encerrando a visualização privada" }),
    ).toBeVisible();
    expect(await readFeat031UserStatus(support.userId ?? "")).toMatchObject({
      account_version: 2,
      status: "suspended",
    });
  } finally {
    heldNavigation.release();
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [support] });
  }
});

test("SL-F031-E2E-022 @p0 auto-suspensão com resposta perdida fecha o shell", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "022_lost_self_suspension");
  const lostResponse = createHeldResponseGate({ outcome: "abort" });
  const heldNavigation = createHeldResponseGate({ outcome: "fulfill" });
  try {
    await provisionFeat031Operator(page, support, "support", "031022");
    await loginFeat031Backoffice(page, support);
    await page.route("**/api/commands", lostResponse.handle);
    await holdAuthoritativeNavigation(page, heldNavigation);

    const card = await searchUser(page, support.email, support.userId);
    await card.getByRole("button", { name: "Revisar suspensão" }).click();
    const confirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    await confirmation.getByRole("checkbox", { name: "Revisei o impacto desta alteração" }).check();
    await confirmation.getByRole("button", { name: "Confirmar" }).click();
    await lostResponse.waitUntilReady();
    lostResponse.release();
    await heldNavigation.waitUntilReady();

    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Encerrando a visualização privada" }),
    ).toBeVisible();
    expect(await readFeat031UserStatus(support.userId ?? "")).toMatchObject({
      account_version: 2,
      status: "suspended",
    });
    expect(await readFeat031Audit("backoffice.user_suspended", support.userId ?? "")).toHaveLength(
      1,
    );
  } finally {
    lostResponse.release();
    heldNavigation.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [support] });
  }
});

test("SL-F031-E2E-021 @p0 reautenticação inconclusiva fecha a sessão privada", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const admin = createFeat031Operator(testInfo, "021_ambiguous_reauthentication");
  const target = await createFeat031DirectIdentity("Reautenticação alvo");
  const heldNavigation = createHeldResponseGate({ outcome: "fulfill" });
  try {
    await provisionFeat031Operator(page, admin, "admin", "031021");
    await loginFeat031Backoffice(page, admin);
    await expireStrongAuthentication(admin.userId);
    await page.getByRole("link", { name: "Acessos" }).click();
    const card = await searchUser(page, target.email, target.userId);
    await card.getByRole("link", { name: "Gerenciar acesso" }).click();
    await page.getByRole("button", { name: "Revisar concessão de suporte" }).click();
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    const reauthentication = page.getByRole("heading", { name: "Confirme sua identidade" });
    await expect(reauthentication).toBeVisible();

    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        json: {
          error: {
            code: "AUTH_SESSION_RECHECK_REQUIRED",
            message: "Não foi possível confirmar a entrada.",
            requestId: "10000000-0000-4000-8000-000000000021",
          },
        },
        status: 503,
      }),
    );
    await holdAuthoritativeNavigation(page, heldNavigation);

    await page.getByLabel("Senha atual").fill(admin.password);
    const response = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/api/auth/login",
    );
    await page.getByRole("button", { name: "Confirmar identidade" }).click();
    expect((await response).status()).toBe(503);
    await heldNavigation.waitUntilReady();

    await expect(reauthentication).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Encerrando a visualização privada" }),
    ).toBeVisible();
  } finally {
    heldNavigation.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [target], operators: [admin] });
  }
});

test("SL-F031-E2E-023 @p0 expiração autoritativa oculta o shell offline", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "023_offline_expiration");
  const heldNavigation = createHeldOfflineNavigationGate();
  try {
    await provisionFeat031Operator(page, support, "support", "031023");
    await loginFeat031Backoffice(page, support, { unlockRuntime: false });
    await page.clock.install({ time: Date.now() });
    const payload = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      return response.json() as Promise<unknown>;
    });
    const parsed = apiSuccessSchema(backofficeSessionSchema).parse(payload).data;
    if (!parsed.authenticated) throw new Error("A sessão FEAT-031 expirável não está autenticada.");
    const browserNow = await page.evaluate(() => Date.now());
    const expiringSession = {
      ...parsed,
      expiresAt: new Date(browserNow + 15_000).toISOString(),
      runtimeUnlockExpiresAt: new Date(browserNow + 10_000).toISOString(),
    };
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: {
          data: expiringSession,
          requestId: "10000000-0000-4000-8000-000000000023",
        },
        status: 200,
      }),
    );
    const revalidation = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/session",
    );
    await page.evaluate(() => {
      const channel = new BroadcastChannel("set-livre-backoffice-session-v1");
      channel.postMessage("changed");
      channel.close();
    });
    expect((await revalidation).status()).toBe(200);
    await expect(
      page.getByRole("status").filter({ hasText: "Operações desbloqueadas até" }),
    ).toBeVisible();
    const sessionEffectsSettled = page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.clock.runFor(34);
    await sessionEffectsSettled;
    await holdAuthoritativeNavigation(page, heldNavigation);
    await page.context().setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.clock.runFor(15_001);

    await expect(page.getByRole("heading", { level: 1, name: "Usuários" })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByText(support.email, { exact: true })).toHaveCount(0);
  } finally {
    heldNavigation.release();
    await page
      .context()
      .setOffline(false)
      .catch(() => undefined);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [support] });
  }
});

test("SL-F031-E2E-013 @p0 resposta perdida preserva replay idempotente e bloqueia abandono", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const operator = createFeat031Operator(testInfo, "013_ambiguous_status");
  const target = await createFeat031DirectIdentity("Status ambíguo", true);
  const lostResponse = createHeldResponseGate({ outcome: "abort" });
  try {
    await provisionFeat031Operator(page, operator, "support", "031013");
    await loginFeat031Backoffice(page, operator);
    const card = await searchUser(page, target.email, target.userId);
    await card.getByRole("button", { name: "Revisar suspensão" }).click();
    const confirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    await confirmation.getByRole("checkbox", { name: "Revisei o impacto desta alteração" }).check();

    await page.route("**/api/commands", lostResponse.handle);

    await confirmation.getByRole("button", { name: "Confirmar" }).click();
    await lostResponse.waitUntilReady();
    await expect(confirmation.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Revisar suspensão" })).toBeDisabled();
    lostResponse.release();
    await expect(confirmation.getByRole("alert")).toContainText(
      "O resultado não pôde ser confirmado. Repita a mesma tentativa",
    );
    await expect(confirmation.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Revisar suspensão" })).toBeDisabled();
    const replay = confirmation.getByRole("button", { name: "Repetir mesma tentativa" });
    await expect(replay).toBeEnabled();
    expect(lostResponse.wasHandled()).toBe(true);
    expect(await readFeat031UserStatus(target.userId)).toMatchObject({
      account_version: 1,
      status: "suspended",
    });

    await replay.click();
    await expect(page.getByRole("status").filter({ hasText: "Usuário suspenso" })).toBeVisible();
    expect(await readFeat031Audit("backoffice.user_suspended", target.userId)).toHaveLength(1);
  } finally {
    lostResponse.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [target], operators: [operator] });
  }
});

test("SL-F031-E2E-014 @p0 resposta perdida de acesso exige replay da mesma transição", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const admin = createFeat031Operator(testInfo, "014_ambiguous_access");
  const target = await createFeat031DirectIdentity("Acesso ambíguo");
  const lostResponse = createHeldResponseGate({ outcome: "abort" });
  try {
    await provisionFeat031Operator(page, admin, "admin", "031014");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Acessos" }).click();
    const card = await searchUser(page, target.email, target.userId);
    await card.getByRole("link", { name: "Gerenciar acesso" }).click();
    const transition = page.getByRole("button", { name: "Revisar concessão de suporte" });
    await transition.click();
    const confirmation = page.getByRole("region", { name: "Confirmar alteração de acesso" });

    await page.route("**/api/commands", lostResponse.handle);

    await confirmation.getByRole("button", { name: "Confirmar alteração" }).click();
    await lostResponse.waitUntilReady();
    await expect(confirmation.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await expect(transition).toBeDisabled();
    lostResponse.release();
    await expect(confirmation.getByRole("alert")).toContainText(
      "O resultado não pôde ser confirmado. Repita a mesma tentativa",
    );
    await expect(confirmation.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await expect(transition).toBeDisabled();
    const replay = confirmation.getByRole("button", { name: "Repetir mesma tentativa" });
    await expect(replay).toBeEnabled();
    expect(lostResponse.wasHandled()).toBe(true);
    expect(await readFeat031Roles(target.userId)).toEqual([{ role: "support" }]);

    await replay.click();
    await expect(page.getByRole("status").filter({ hasText: "Acesso atualizado" })).toBeVisible();
    expect(await readFeat031Audit("backoffice.role_granted", target.userId)).toHaveLength(1);
  } finally {
    lostResponse.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [target], operators: [admin] });
  }
});

test("SL-F031-E2E-015 @p0 ações SSR ficam fechadas antes da hidratação", async ({
  browser,
  page,
}, testInfo) => {
  const admin = createFeat031Operator(testInfo, "015_hydration_boundaries");
  try {
    await expectBackofficeLoginClosedWithoutHydration(browser);
    await provisionFeat031Operator(page, admin, "admin", "031015");
    await loginFeat031Backoffice(page, admin, { unlockRuntime: false });
    await expectBackofficeRuntimeClosedWithoutHydration(browser, await page.context().cookies());
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [admin] });
  }
});

test("SL-F031-E2E-011 @p0 runtime bloqueado rejeita mutação até desbloqueio local", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "011_runtime_unlock");
  const target = await createFeat031DirectIdentity("Interlock alvo");
  const sessionResponse = createHeldResponseGate({ outcome: "fulfill" });
  try {
    await provisionFeat031Operator(page, support, "support", "031011");
    await page.route(
      `${safeE2EEnvironment.backofficeBaseUrl}/api/auth/session`,
      sessionResponse.handle,
    );
    await loginFeat031Backoffice(page, support, { unlockRuntime: false });
    await sessionResponse.waitUntilReady();
    const runtimeKey = page.getByLabel("Chave local de desbloqueio");
    const runtimeSubmit = page.getByRole("button", { name: "Desbloquear operações" });
    await expect(runtimeKey).toBeDisabled();
    await expect(runtimeSubmit).toBeDisabled();
    sessionResponse.release();
    await expect(runtimeKey).toBeEnabled();
    await expect(runtimeSubmit).toBeEnabled();

    const card = await searchUser(page, target.email, target.userId);
    await card.getByRole("button", { name: "Revisar suspensão" }).click();
    const confirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    await confirmation.getByRole("checkbox", { name: "Revisei o impacto desta alteração" }).check();
    const lockedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/commands" && response.status() === 423,
    );
    await confirmation.getByRole("button", { name: "Confirmar" }).click();
    await lockedResponse;
    await expect(confirmation).toContainText("Desbloqueie operações com a chave local");
    expect(await readFeat031UserStatus(target.userId)).toMatchObject({
      account_version: 0,
      status: "active",
    });

    await unlockFeat031Backoffice(page);
    await confirmation.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Usuário suspenso" })).toBeVisible();
    expect(await readFeat031UserStatus(target.userId)).toMatchObject({
      account_version: 1,
      status: "suspended",
    });
  } finally {
    sessionResponse.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [target], operators: [support] });
  }
});

test("SL-F031-E2E-002 @p0 somente admin gerencia papéis", async ({ browser, page }, testInfo) => {
  test.setTimeout(240_000);
  const support = createFeat031Operator(testInfo, "002_support");
  const admin = createFeat031Operator(testInfo, "002_admin");
  const target = await createFeat031DirectIdentity("Acesso alvo");
  const adminContext = await browser.newContext({ baseURL: safeE2EEnvironment.publicBaseUrl });
  const adminProvisioningPage = await adminContext.newPage();
  try {
    await provisionFeat031Operator(page, support, "support", "031021");
    await provisionFeat031Operator(adminProvisioningPage, admin, "admin", "031022");
    await adminContext.close();

    await loginFeat031Backoffice(page, support);
    await expect(page.getByRole("link", { name: "Acessos" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Taxonomias" })).toHaveCount(0);
    await page.goto(`${safeE2EEnvironment.backofficeBaseUrl}/taxonomias`);
    await expect(page).toHaveURL(/\/usuarios$/u);
    const forbiddenTaxonomies = await page.evaluate(async () =>
      fetch("/api/taxonomies", { cache: "no-store" }).then((response) => response.status),
    );
    expect(forbiddenTaxonomies).toBe(403);
    const sessionPayload = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      return { body: await response.json(), status: response.status };
    });
    expect(sessionPayload.status).toBe(200);
    const supportSession = apiSuccessSchema(backofficeSessionSchema).parse(
      sessionPayload.body,
    ).data;
    if (!supportSession.authenticated)
      throw new Error("A sessão support não permaneceu autenticada.");
    const forbidden = await page.evaluate(
      async (command) => {
        const response = await fetch("/api/commands", {
          body: JSON.stringify(command),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return response.status;
      },
      {
        action: "backoffice.access.grantSupport",
        expectedScope: supportSession.scope,
        idempotencyKey: crypto.randomUUID(),
        payload: { expectedAccountVersion: 0, userId: target.userId },
      },
    );
    expect(forbidden).toBe(403);

    await page.getByRole("button", { name: "Sair" }).click();
    await expect(page).toHaveURL(/\/entrar\?saida=sucesso$/u);
    await loginFeat031Backoffice(page, admin);
    await expireStrongAuthentication(admin.userId);
    await page.getByRole("link", { name: "Acessos" }).click();
    const adminCard = await searchUser(page, target.email, target.userId);
    await adminCard.getByRole("link", { name: "Gerenciar acesso" }).click();
    await page.getByRole("button", { name: "Revisar concessão de suporte" }).click();
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    const reauthentication = page.getByRole("heading", { name: "Confirme sua identidade" });
    await expect(reauthentication).toBeVisible();
    await page.getByLabel("Senha atual").fill(admin.password);
    await page.getByRole("button", { name: "Confirmar identidade" }).click();
    await expect(reauthentication).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Identidade confirmada" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Backoffice" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: /Acessos da conta/u })).toBeVisible();
    await expect(page.getByText("Operações críticas bloqueadas neste runtime.")).toBeVisible();
    await unlockFeat031Backoffice(page);
    await page.getByRole("button", { name: "Revisar concessão de suporte" }).click();
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Acesso atualizado" })).toBeVisible();
    expect(await readFeat031Roles(target.userId)).toEqual([{ role: "support" }]);
    expect(await readFeat031Audit("backoffice.role_granted", target.userId)).toHaveLength(1);
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await adminContext.close().catch(() => undefined);
    await cleanupFeat031Users({ direct: [target], operators: [support, admin] });
  }
});

test("SL-F031-E2E-003 @p0 salvaguarda protege o último admin e autoriza revogação própria segura", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const admin = createFeat031Operator(testInfo, "003_last_admin");
  const keeper = createFeat031Operator(testInfo, "003_keeper_admin");
  const keeperContext = await browser.newContext({ baseURL: safeE2EEnvironment.publicBaseUrl });
  const keeperPage = await keeperContext.newPage();
  const heldNavigation = createHeldResponseGate({ outcome: "fulfill" });
  try {
    await provisionFeat031Operator(page, admin, "admin", "031003");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Acessos" }).click();
    const card = await searchUser(page, admin.email, admin.userId);
    await card.getByRole("link", { name: "Gerenciar acesso" }).click();
    await page.getByRole("button", { name: "Revisar revogação administrativa" }).click();
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await expect(
      page.getByRole("region", { name: "Ações de acesso" }).getByRole("alert"),
    ).toContainText("salvaguarda");
    expect(await readFeat031Roles(admin.userId ?? "")).toEqual([{ role: "admin" }]);

    await provisionFeat031Operator(keeperPage, keeper, "admin", "031003b");
    await keeperContext.close();
    await holdAuthoritativeNavigation(page, heldNavigation);
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await heldNavigation.waitUntilReady();

    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Encerrando a visualização privada" }),
    ).toBeVisible();
    expect(await readFeat031Roles(admin.userId ?? "")).toEqual([]);
    expect(await readFeat031Roles(keeper.userId ?? "")).toEqual([{ role: "admin" }]);
    expect(await readFeat031Audit("backoffice.role_revoked", admin.userId ?? "")).toHaveLength(1);
  } finally {
    heldNavigation.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await keeperContext.close().catch(() => undefined);
    await cleanupFeat031Users({ operators: [admin, keeper] });
  }
});

test("SL-F031-E2E-024 @p0 revogação administrativa própria perdida fecha o shell", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const admin = createFeat031Operator(testInfo, "024_lost_self_admin_revoke");
  const keeper = createFeat031Operator(testInfo, "024_keeper_admin");
  const keeperContext = await browser.newContext({ baseURL: safeE2EEnvironment.publicBaseUrl });
  const keeperPage = await keeperContext.newPage();
  const lostResponse = createHeldResponseGate({ outcome: "abort" });
  const heldNavigation = createHeldResponseGate({ outcome: "fulfill" });
  try {
    await provisionFeat031Operator(page, admin, "admin", "031024a");
    await provisionFeat031Operator(keeperPage, keeper, "admin", "031024b");
    await keeperContext.close();
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Acessos" }).click();
    const card = await searchUser(page, admin.email, admin.userId);
    await card.getByRole("link", { name: "Gerenciar acesso" }).click();
    await page.getByRole("button", { name: "Revisar revogação administrativa" }).click();
    await page.route("**/api/commands", lostResponse.handle);
    await holdAuthoritativeNavigation(page, heldNavigation);
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await lostResponse.waitUntilReady();
    lostResponse.release();
    await heldNavigation.waitUntilReady();

    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Encerrando a visualização privada" }),
    ).toBeVisible();
    expect(await readFeat031Roles(admin.userId ?? "")).toEqual([]);
    expect(await readFeat031Roles(keeper.userId ?? "")).toEqual([{ role: "admin" }]);
    expect(await readFeat031Audit("backoffice.role_revoked", admin.userId ?? "")).toHaveLength(1);
  } finally {
    lostResponse.release();
    heldNavigation.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await keeperContext.close().catch(() => undefined);
    await cleanupFeat031Users({ operators: [admin, keeper] });
  }
});

test("SL-F031-E2E-004 @p0 arquivar taxonomia preserva histórico e bloqueia nova seleção", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const admin = createFeat031Operator(testInfo, "004_taxonomy");
  const owner = await createFeat031DirectIdentity("Dono taxonomia", true);
  const suffix = Date.now().toString(36);
  const name = `Arquivo histórico QA ${suffix}`;
  const editedName = `Arquivo histórico editado QA ${suffix}`;
  const slug = `arquivo-qa-${suffix}`;
  const editedSlug = `${slug}-editado`;
  const lostCreateResponse = createHeldResponseGate({ outcome: "abort" });
  const lostEditResponse = createHeldResponseGate({ outcome: "abort" });
  const lostArchiveResponse = createHeldResponseGate({ outcome: "abort" });
  let tagId: string | undefined;
  try {
    await provisionFeat031Operator(page, admin, "admin", "031004");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Taxonomias" }).click();
    await page.getByRole("combobox", { name: "Grupo" }).selectOption("tag");
    await page.getByRole("textbox", { name: "Nome" }).fill(name);
    await page.getByRole("textbox", { name: "Slug" }).fill(slug);
    await page.getByRole("spinbutton", { name: "Ordem" }).fill("310");
    await page.route("**/api/commands", lostCreateResponse.handle);
    await page.getByRole("button", { name: "Criar taxonomia" }).click();
    await lostCreateResponse.waitUntilReady();
    await expect(page.getByRole("textbox", { name: "Nome" })).toBeDisabled();
    lostCreateResponse.release();
    await expect(page.getByRole("region", { name: "Taxonomias" }).getByRole("alert")).toContainText(
      "O resultado não pôde ser confirmado. Repita a mesma tentativa",
    );
    const createReplay = page.getByRole("button", { name: "Repetir mesma tentativa" });
    await expect(createReplay).toBeEnabled();
    await createReplay.click();
    await expect(page.getByRole("status").filter({ hasText: "salva na versão 0" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome" })).toHaveValue("");
    await page.unroute("**/api/commands", lostCreateResponse.handle);

    const createdCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { exact: true, name }) });
    await createdCard.getByRole("button", { name: "Editar" }).click();
    await page.getByRole("textbox", { name: "Nome" }).fill(editedName);
    await page.getByRole("textbox", { name: "Slug" }).fill(editedSlug);
    await page.getByRole("spinbutton", { name: "Ordem" }).fill("311");
    await page.route("**/api/commands", lostEditResponse.handle);
    await page.getByRole("button", { name: "Salvar edição" }).click();
    await lostEditResponse.waitUntilReady();
    await expect(page.getByRole("textbox", { name: "Nome" })).toBeDisabled();
    lostEditResponse.release();
    await expect(page.getByRole("region", { name: "Taxonomias" }).getByRole("alert")).toContainText(
      "O resultado não pôde ser confirmado. Repita a mesma tentativa",
    );
    const editReplay = page.getByRole("button", { name: "Repetir mesma tentativa" });
    await expect(editReplay).toBeEnabled();
    await editReplay.click();
    await expect(page.getByRole("status").filter({ hasText: "salva na versão 1" })).toBeVisible();
    await page.unroute("**/api/commands", lostEditResponse.handle);

    const history = await linkFeat031TagToHistory(owner.userId, editedSlug);
    tagId = history.tagId;
    await page.reload();
    const card = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { exact: true, name: editedName }) });
    await expect(card).toContainText("1 uso");
    await card.getByRole("button", { name: "Revisar arquivamento" }).click();
    const impact = page.getByRole("region", { name: "Impacto do arquivamento" });
    await expect(impact).toContainText("1 referências");

    await page.route("**/api/commands", lostArchiveResponse.handle);

    await impact.getByRole("button", { name: "Confirmar arquivamento" }).click();
    await lostArchiveResponse.waitUntilReady();
    await expect(impact.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Editar" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Revisar arquivamento" })).toBeDisabled();
    lostArchiveResponse.release();
    await expect(impact.getByRole("alert")).toContainText(
      "O resultado não pôde ser confirmado. Repita a mesma tentativa",
    );
    await expect(impact.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Editar" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Revisar arquivamento" })).toBeDisabled();
    const archiveReplay = impact.getByRole("button", { name: "Repetir mesma tentativa" });
    await expect(archiveReplay).toBeEnabled();
    expect(lostArchiveResponse.wasHandled()).toBe(true);
    expect(await readFeat031Audit("backoffice.taxonomy_archived", history.tagId)).toHaveLength(1);

    await archiveReplay.click();
    await expect(
      page.getByRole("status").filter({ hasText: "referências históricas preservadas" }),
    ).toBeVisible();
    expect(await readFeat031TaxonomyHistory(history.tagId, history.revisionId)).toMatchObject({
      absent_from_new_selection: true,
      active: false,
      historical_reference: true,
      taxonomy_version: 2,
    });
    expect(await readFeat031Audit("backoffice.taxonomy_archived", history.tagId)).toHaveLength(1);

    const archivedCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { exact: true, name: editedName }) });
    await archivedCard.getByRole("button", { name: "Revisar reativação" }).click();
    await page.getByRole("button", { name: "Confirmar reativação" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "reativada para novas seleções" }),
    ).toBeVisible();
  } finally {
    lostCreateResponse.release();
    lostEditResponse.release();
    lostArchiveResponse.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [owner], operators: [admin] });
    await cleanupFeat031Taxonomy(tagId, editedSlug);
    await cleanupFeat031Taxonomy(undefined, slug);
  }
});
