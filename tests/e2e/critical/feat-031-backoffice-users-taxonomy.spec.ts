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

    const form = page.locator("form", {
      has: page.locator('input[name="runtimeUnlockKey"]'),
    });
    await expect(form).toHaveAttribute("inert", "");
    await expect(form).toHaveAttribute("method", "post");
    await expect(form.locator("fieldset")).toHaveAttribute("disabled", "");
    await expect(form.locator('input[name="runtimeUnlockKey"]')).toHaveAttribute("disabled", "");
    await expect(form.locator('button[type="submit"]')).toHaveAttribute("disabled", "");
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

test("SL-F031-E2E-015 @p0 segredos ficam fechados antes da hidratação", async ({
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
    await page.getByRole("link", { name: "Acessos" }).click();
    const adminCard = await searchUser(page, target.email, target.userId);
    await adminCard.getByRole("link", { name: "Gerenciar acesso" }).click();
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

test("SL-F031-E2E-003 @p0 salvaguarda impede remover o último admin", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const admin = createFeat031Operator(testInfo, "003_last_admin");
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
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [admin] });
  }
});

test("SL-F031-E2E-004 @p0 arquivar taxonomia preserva histórico e bloqueia nova seleção", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const admin = createFeat031Operator(testInfo, "004_taxonomy");
  const owner = await createFeat031DirectIdentity("Dono taxonomia", true);
  const slug = `arquivo-qa-${Date.now().toString(36)}`;
  const editedSlug = `${slug}-editado`;
  const lostArchiveResponse = createHeldResponseGate({ outcome: "abort" });
  let tagId: string | undefined;
  try {
    await provisionFeat031Operator(page, admin, "admin", "031004");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Taxonomias" }).click();
    await page.getByRole("combobox", { name: "Grupo" }).selectOption("tag");
    await page.getByRole("textbox", { name: "Nome" }).fill("Arquivo histórico QA");
    await page.getByRole("textbox", { name: "Slug" }).fill(slug);
    await page.getByRole("spinbutton", { name: "Ordem" }).fill("310");
    await page.getByRole("button", { name: "Criar taxonomia" }).click();
    await expect(page.getByRole("status").filter({ hasText: "salva na versão 0" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome" })).toHaveValue("");

    const createdCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Arquivo histórico QA" }) });
    await createdCard.getByRole("button", { name: "Editar" }).click();
    await page.getByRole("textbox", { name: "Nome" }).fill("Arquivo histórico editado QA");
    await page.getByRole("textbox", { name: "Slug" }).fill(editedSlug);
    await page.getByRole("spinbutton", { name: "Ordem" }).fill("311");
    await page.getByRole("button", { name: "Salvar edição" }).click();
    await expect(page.getByRole("status").filter({ hasText: "salva na versão 1" })).toBeVisible();

    const history = await linkFeat031TagToHistory(owner.userId, editedSlug);
    tagId = history.tagId;
    await page.reload();
    const card = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Arquivo histórico editado QA" }) });
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
      .filter({ has: page.getByRole("heading", { name: "Arquivo histórico editado QA" }) });
    await archivedCard.getByRole("button", { name: "Revisar reativação" }).click();
    await page.getByRole("button", { name: "Confirmar reativação" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "reativada para novas seleções" }),
    ).toBeVisible();
  } finally {
    lostArchiveResponse.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [owner], operators: [admin] });
    await cleanupFeat031Taxonomy(tagId);
  }
});
