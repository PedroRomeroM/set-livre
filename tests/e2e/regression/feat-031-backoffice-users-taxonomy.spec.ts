import { expect, test, type Page, type Route } from "@playwright/test";

import {
  cleanupFeat031Users,
  cleanupFeat031Taxonomy,
  createFeat031BulkUsers,
  createFeat031DirectIdentity,
  createFeat031IncompleteIdentity,
  createFeat031Operator,
  loginFeat031Backoffice,
  provisionFeat031Operator,
  readFeat031Audit,
  readFeat031Roles,
  readFeat031UserStatus,
  setFeat031RolesConcurrently,
  setFeat031UserStatusConcurrently,
  updateFeat031TagConcurrently,
} from "../../helpers/feat-031-backoffice-users-taxonomy";
import { closePageBeforeDatabaseCleanup } from "../../helpers/page-cleanup";

async function searchUser(page: Page, query: string, userId: string) {
  await page.getByRole("textbox", { name: "Buscar usuários" }).fill(query);
  await page.getByRole("button", { name: "Buscar" }).click();
  const card = page
    .getByRole("article")
    .filter({ has: page.getByText(`Identificador …${userId.slice(-8)}`, { exact: true }) });
  await expect(card).toBeVisible();
  return card;
}

async function holdNextBackofficeFingerprint(page: Page) {
  await page.evaluate(() => {
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Reflect.set(window, "__releaseFeat031Fingerprint", release);
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
        Object.defineProperty(crypto.subtle, "digest", {
          configurable: true,
          value: originalDigest,
        });
        await gate;
        return originalDigest(...args);
      },
    });
  });
  return () =>
    page.evaluate(() => {
      const release = Reflect.get(window, "__releaseFeat031Fingerprint") as unknown;
      if (typeof release !== "function") {
        throw new Error("A busca FEAT-031 não publicou o gate de fingerprint.");
      }
      release();
    });
}

async function emulateDocumentVisibility(page: Page, visibilityState: "hidden" | "visible") {
  await page.evaluate((nextVisibilityState) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => nextVisibilityState,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibilityState);
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe(visibilityState);
}

test("SL-F031-E2E-005 @p1 PII fica mascarada até revelação justificada e auditada", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "005_pii");
  const target = await createFeat031DirectIdentity("PII alvo");
  try {
    await provisionFeat031Operator(page, support, "support", "031005");
    await loginFeat031Backoffice(page, support);
    const card = await searchUser(page, target.email, target.userId);
    await expect(card).not.toContainText(target.name);
    await expect(card).not.toContainText(target.email);
    await expect(card).not.toContainText(target.taxId);
    const reason = card.getByRole("combobox", { name: "Motivo auditado" });
    await reason.selectOption("identity_verification");
    await card.getByRole("button", { name: "Revelar dados por 60 segundos" }).click();
    await expect(card.getByText(target.email, { exact: true })).toBeVisible();
    await expect(card.getByText(target.name, { exact: true })).toBeVisible();
    await expect(card.getByText(target.taxId, { exact: true })).toBeVisible();
    const audit = await readFeat031Audit("backoffice.user_pii_revealed", target.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_role: "support",
      metadata: { reason: "identity_verification" },
    });
    expect(JSON.stringify(audit)).not.toContain(target.email);
    expect(JSON.stringify(audit)).not.toContain(target.taxId);

    await reason.selectOption("legal_request");
    await expect(card).not.toContainText(target.email);
    await expect(card).not.toContainText(target.name);
    await expect(card).not.toContainText(target.taxId);
    await card.getByRole("button", { name: "Revelar dados por 60 segundos" }).click();
    await expect(card.getByText(target.email, { exact: true })).toBeVisible();
    const renewedAudit = await readFeat031Audit("backoffice.user_pii_revealed", target.userId);
    expect(renewedAudit).toHaveLength(2);
    expect(renewedAudit[0]).toMatchObject({
      actor_role: "support",
      metadata: { reason: "legal_request" },
    });
    await card.getByRole("button", { name: "Ocultar agora" }).click();
    await expect(card).not.toContainText(target.email);
    await expect(card).not.toContainText(target.name);
    await expect(card).not.toContainText(target.taxId);
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [target], operators: [support] });
  }
});

test("SL-F031-E2E-012 @p1 resposta de PII concluída em aba oculta é descartada", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "012_hidden_pii");
  const target = await createFeat031DirectIdentity("PII oculta");
  let releaseResponse: () => void = () => undefined;
  let markResponseHeld: () => void = () => undefined;
  const responseRelease = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const responseHeld = new Promise<void>((resolve) => {
    markResponseHeld = resolve;
  });
  try {
    await provisionFeat031Operator(page, support, "support", "031012");
    await loginFeat031Backoffice(page, support);
    const card = await searchUser(page, target.email, target.userId);
    await page.route("**/api/commands", async (route) => {
      const command = route.request().postDataJSON() as { action?: unknown } | null;
      if (command?.action !== "backoffice.user.revealPii") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      markResponseHeld();
      await responseRelease;
      await route.fulfill({ response });
    });
    const reason = card.getByRole("combobox", { name: "Motivo auditado" });
    await reason.selectOption("security_investigation");
    await card.getByRole("button", { name: "Revelar dados por 60 segundos" }).click();
    await responseHeld;
    await expect(reason).toBeDisabled();
    await expect(reason).toHaveValue("security_investigation");

    await emulateDocumentVisibility(page, "hidden");
    const delivered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/commands" && response.status() === 200,
    );
    releaseResponse();
    await delivered;
    await expect(card).not.toContainText(target.email);
    await expect(card).not.toContainText(target.name);
    await expect(card).not.toContainText(target.taxId);

    await emulateDocumentVisibility(page, "visible");
    await expect(card).not.toContainText(target.email);
    await expect(card).not.toContainText(target.name);
    await expect(card).not.toContainText(target.taxId);
    expect(await readFeat031Audit("backoffice.user_pii_revealed", target.userId)).toHaveLength(1);
  } finally {
    releaseResponse();
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [target], operators: [support] });
  }
});

test("SL-F031-E2E-006 @p1 busca e cursor permanecem no servidor sem filtro na URL", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const support = createFeat031Operator(testInfo, "006_cursor");
  const bulk = await createFeat031BulkUsers(`${testInfo.project.name}_${Date.now().toString(36)}`);
  const requests: Array<{ body: unknown; method: string; search: string }> = [];
  try {
    await provisionFeat031Operator(page, support, "support", "031006");
    await loginFeat031Backoffice(page, support);
    page.on("request", (request) => {
      const address = new URL(request.url());
      if (address.pathname === "/api/users") {
        requests.push({
          body: request.postDataJSON(),
          method: request.method(),
          search: address.search,
        });
      }
    });
    await page.getByRole("textbox", { name: "Buscar usuários" }).fill(bulk.query);
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByRole("article")).toHaveCount(50);
    const loadMore = page.getByRole("button", { name: "Carregar mais" });
    await loadMore.scrollIntoViewIfNeeded();
    const hitEvidence = await loadMore.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      );
      const clientWidth = document.documentElement.clientWidth;
      const measuredElements = [...document.querySelectorAll("body *")].map((element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          className: element.getAttribute("class"),
          left: rectangle.left,
          right: rectangle.right,
          tag: element.tagName,
          width: rectangle.width,
        };
      });
      return {
        bodyScrollWidth: document.body.scrollWidth,
        buttonBottom: Math.round(bounds.bottom),
        buttonTop: Math.round(bounds.top),
        clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        hitInsideButton: hit === button || (hit !== null && button.contains(hit)),
        hitTag: hit?.tagName ?? null,
        overflowing: measuredElements
          .filter((element) => element.left < 0 || element.right > clientWidth)
          .map((element) => ({
            ...element,
            left: Math.round(element.left * 1000) / 1000,
            right: Math.round(element.right * 1000) / 1000,
            width: Math.round(element.width * 1000) / 1000,
          }))
          .slice(0, 12),
        viewportHeight: window.innerHeight,
        windowInnerWidth: window.innerWidth,
      };
    });
    const hitEvidenceJson = JSON.stringify(hitEvidence, null, 2);
    expect(hitEvidence.overflowing, hitEvidenceJson).toEqual([]);
    expect(hitEvidence).toMatchObject({
      bodyScrollWidth: hitEvidence.clientWidth,
      documentScrollWidth: hitEvidence.clientWidth,
      hitInsideButton: true,
      windowInnerWidth: hitEvidence.clientWidth,
    });
    await loadMore.click();
    await expect(page.getByRole("article")).toHaveCount(52);

    const filteredRequests = requests.filter((request) => {
      const parsed = request.body as { query?: unknown } | undefined;
      return parsed?.query === bulk.query;
    });
    expect(filteredRequests).toHaveLength(2);
    expect(
      filteredRequests.every((request) => request.method === "POST" && request.search === ""),
    ).toBe(true);
    expect(filteredRequests[0]?.body).toMatchObject({ query: bulk.query });
    expect(filteredRequests[1]?.body).toMatchObject({
      cursor: expect.any(String),
      query: bulk.query,
    });
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ bulk: bulk.identities, operators: [support] });
  }
});

test("SL-F031-E2E-017 @p1 nova busca descarta confirmação e tentativa de status anteriores", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "017_search_status_boundary");
  const firstTarget = await createFeat031DirectIdentity("Busca status anterior");
  const nextTarget = await createFeat031DirectIdentity("Busca status atual");
  const abortCommand = async (route: Route) => route.abort("failed");
  try {
    await provisionFeat031Operator(page, support, "support", "031017");
    await loginFeat031Backoffice(page, support);
    const firstCard = await searchUser(page, firstTarget.email, firstTarget.userId);
    await firstCard.getByRole("button", { name: "Revisar suspensão" }).click();
    const firstConfirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    await firstConfirmation
      .getByRole("checkbox", { name: "Revisei o impacto desta alteração" })
      .check();
    await page.route("**/api/commands", abortCommand);
    await firstConfirmation.getByRole("button", { name: "Confirmar" }).click();
    await expect(firstConfirmation.getByRole("alert")).toContainText(
      "O resultado não pôde ser confirmado. Repita a mesma tentativa",
    );
    await page.unroute("**/api/commands", abortCommand);

    const releaseFingerprint = await holdNextBackofficeFingerprint(page);
    const searchForm = page.locator("form").filter({
      has: page.getByRole("textbox", { name: "Buscar usuários" }),
    });
    const searchInput = searchForm.getByRole("textbox", { name: "Buscar usuários" });
    const searchButton = searchForm.getByRole("button");
    await searchInput.fill(nextTarget.email);
    await searchButton.click();
    await expect(searchForm).toHaveAttribute("aria-busy", "true");
    await expect(searchInput).toBeDisabled();
    await expect(searchButton).toBeDisabled();
    await searchForm.evaluate((form: HTMLFormElement) => form.requestSubmit());
    await releaseFingerprint();
    const nextCard = page.getByRole("article").filter({
      has: page.getByText(`Identificador …${nextTarget.userId.slice(-8)}`, { exact: true }),
    });
    await expect(nextCard).toBeVisible();
    await expect(page.getByRole("region", { name: "Confirmar suspensão" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Repetir mesma tentativa" })).toHaveCount(0);
    expect(await readFeat031UserStatus(firstTarget.userId)).toMatchObject({ status: "active" });

    await nextCard.getByRole("button", { name: "Revisar suspensão" }).click();
    const nextConfirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    await expect(
      nextConfirmation.getByRole("checkbox", { name: "Revisei o impacto desta alteração" }),
    ).not.toBeChecked();
    await expect(nextConfirmation.getByRole("button", { name: "Confirmar" })).toBeDisabled();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [firstTarget, nextTarget], operators: [support] });
  }
});

test("SL-F031-E2E-018 @p1 concessões refletem status ativo e perfil completo", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const admin = createFeat031Operator(testInfo, "018_access_eligibility");
  const suspendedTarget = await createFeat031DirectIdentity("Acesso suspenso");
  const incompleteTarget = await createFeat031IncompleteIdentity("Acesso incompleto");
  try {
    await setFeat031RolesConcurrently(suspendedTarget.userId, ["support"]);
    await setFeat031UserStatusConcurrently(suspendedTarget.userId, "suspended");
    await provisionFeat031Operator(page, admin, "admin", "031018");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Acessos" }).click();

    let card = await searchUser(page, suspendedTarget.email, suspendedTarget.userId);
    await card.getByRole("link", { name: "Gerenciar acesso" }).click();
    await expect(page.getByText("Suspensa", { exact: true })).toBeVisible();
    await expect(page.getByText("Completo", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "A conta está suspensa" }),
    ).toContainText("Restaure-a antes de conceder novos acessos");
    await expect(page.getByRole("button", { name: "Revisar revogação de suporte" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Revisar concessão/u })).toHaveCount(0);
    expect(await readFeat031Roles(suspendedTarget.userId)).toEqual([{ role: "support" }]);

    const backToAccessSearch = page.getByRole("link", { name: "Voltar à busca de acessos" });
    const configuredViewport = page.viewportSize();
    if (configuredViewport === null) {
      throw new Error("O cenário responsivo exige uma viewport explícita.");
    }
    const expectedViewportWidth = configuredViewport.width;
    await backToAccessSearch.scrollIntoViewIfNeeded();
    const backLinkLayout = await backToAccessSearch.evaluate((link) => {
      const bounds = link.getBoundingClientRect();
      const clientWidth = document.documentElement.clientWidth;
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      );
      return {
        bodyScrollWidth: document.body.scrollWidth,
        clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        hitInsideLink: hit === link || (hit !== null && link.contains(hit)),
        hitTag: hit?.tagName ?? null,
        linkBottom: bounds.bottom,
        linkLeft: bounds.left,
        linkRight: bounds.right,
        linkTop: bounds.top,
        viewportHeight: window.innerHeight,
        visualViewportScale: window.visualViewport?.scale ?? 1,
        visualViewportWidth: window.visualViewport?.width ?? window.innerWidth,
        windowInnerWidth: window.innerWidth,
      };
    });
    const backLinkLayoutEvidence = JSON.stringify(backLinkLayout, null, 2);
    expect(backLinkLayout, backLinkLayoutEvidence).toMatchObject({
      bodyScrollWidth: expectedViewportWidth,
      clientWidth: expectedViewportWidth,
      documentScrollWidth: expectedViewportWidth,
      hitInsideLink: true,
      windowInnerWidth: expectedViewportWidth,
    });
    expect(backLinkLayout.visualViewportScale, backLinkLayoutEvidence).toBeCloseTo(1, 5);
    expect(backLinkLayout.visualViewportWidth, backLinkLayoutEvidence).toBeCloseTo(
      expectedViewportWidth,
      5,
    );
    expect(backLinkLayout.linkLeft, backLinkLayoutEvidence).toBeGreaterThanOrEqual(0);
    expect(backLinkLayout.linkRight, backLinkLayoutEvidence).toBeLessThanOrEqual(
      expectedViewportWidth,
    );
    expect(backLinkLayout.linkTop, backLinkLayoutEvidence).toBeGreaterThanOrEqual(0);
    expect(backLinkLayout.linkBottom, backLinkLayoutEvidence).toBeLessThanOrEqual(
      backLinkLayout.viewportHeight,
    );
    await backToAccessSearch.click();
    card = await searchUser(page, incompleteTarget.email, incompleteTarget.userId);
    await card.getByRole("link", { name: "Gerenciar acesso" }).click();
    await expect(page.getByText("Ativa", { exact: true })).toBeVisible();
    await expect(page.getByText("Incompleto", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "O perfil está incompleto" }),
    ).toContainText("precisa concluir o perfil antes de receber novos acessos");
    await expect(page.getByRole("button", { name: /^Revisar concessão/u })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Ações de acesso" })).toHaveCount(0);
    expect(await readFeat031Roles(incompleteTarget.userId)).toEqual([]);
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [suspendedTarget, incompleteTarget], operators: [admin] });
  }
});

test("SL-F031-E2E-019 @p1 conta inexistente usa a fronteira contextual de 404", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const admin = createFeat031Operator(testInfo, "019_access_not_found");
  try {
    await provisionFeat031Operator(page, admin, "admin", "031019");
    await loginFeat031Backoffice(page, admin);

    const accessUrl = new URL(
      "/acessos/31000000-0000-4000-8000-000000000019",
      page.url(),
    ).toString();
    const response = await page.goto(accessUrl);
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Conta não encontrada", { exact: true })).toBeVisible();
    await expect(page.getByText("Nenhum acesso privado foi exibido.")).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Acessos da conta/u })).toHaveCount(0);
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [admin] });
  }
});

test("SL-F031-E2E-008 @p1 mudança de papel encerra a composição privada anterior", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const admin = createFeat031Operator(testInfo, "008_session_scope");
  const boundaryEvidenceKey = "sl-f031-008-private-boundary";
  try {
    await provisionFeat031Operator(page, admin, "admin", "031008");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Taxonomias" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Taxonomias" })).toBeVisible();
    await page.evaluate((evidenceKey) => {
      window.sessionStorage.removeItem(evidenceKey);
      const captureClosedBoundary = () => {
        const privateHeadingVisible = Array.from(document.querySelectorAll("h1")).some(
          (heading) => heading.textContent?.trim() === "Taxonomias",
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
    await setFeat031RolesConcurrently(admin.userId ?? "", ["support"]);

    const revalidation = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/session",
    );
    await page.evaluate(() => {
      const channel = new BroadcastChannel("set-livre-backoffice-session-v1");
      channel.postMessage("changed");
      channel.close();
    });
    expect((await revalidation).status()).toBe(200);

    await expect(page).toHaveURL(/\/usuarios$/u);
    await expect
      .poll(() =>
        page.evaluate(
          (evidenceKey) => window.sessionStorage.getItem(evidenceKey),
          boundaryEvidenceKey,
        ),
      )
      .toBe("closed-before-navigation");
    await expect(page.getByRole("heading", { level: 1, name: "Taxonomias" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Taxonomias" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Acessos" })).toHaveCount(0);
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [admin] });
  }
});

test("SL-F031-E2E-009 @p1 conflitos de conta e papel exigem nova revisão", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const admin = createFeat031Operator(testInfo, "009_user_conflicts");
  const target = await createFeat031DirectIdentity("Concorrência de conta");
  try {
    await provisionFeat031Operator(page, admin, "admin", "031009");
    await loginFeat031Backoffice(page, admin);
    let card = await searchUser(page, target.email, target.userId);
    await card.getByRole("button", { name: "Revisar suspensão" }).click();
    await page
      .getByRole("region", { name: "Confirmar suspensão" })
      .getByRole("checkbox", { name: "Revisei o impacto desta alteração" })
      .check();
    await setFeat031UserStatusConcurrently(target.userId, "suspended");
    await page
      .getByRole("region", { name: "Confirmar suspensão" })
      .getByRole("button", { name: "Confirmar" })
      .click();
    await expect(page.getByRole("region", { name: "Confirmar suspensão" })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "A conta mudou" })).toContainText(
      "A conta mudou",
    );
    await expect(card.getByRole("button", { name: "Revisar restauração" })).toBeVisible();

    await setFeat031UserStatusConcurrently(target.userId, "active");
    await page.getByRole("link", { name: "Acessos" }).click();
    card = await searchUser(page, target.email, target.userId);
    await card.getByRole("link", { name: "Gerenciar acesso" }).click();
    await page.getByRole("button", { name: "Revisar concessão de suporte" }).click();
    await setFeat031RolesConcurrently(target.userId, ["support"]);
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await expect(page.getByRole("region", { name: "Confirmar alteração de acesso" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("status").filter({ hasText: "Os acessos mudaram" })).toContainText(
      "Os acessos mudaram",
    );
    await expect(page.getByRole("button", { name: "Revisar revogação de suporte" })).toBeVisible();
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [target], operators: [admin] });
  }
});

test("SL-F031-E2E-010 @p1 conflito de taxonomia descarta o editor obsoleto", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const admin = createFeat031Operator(testInfo, "010_taxonomy_conflict");
  const slug = `conflito-${Date.now().toString(36)}`;
  const remoteName = "Taxonomia remota atualizada";
  try {
    await provisionFeat031Operator(page, admin, "admin", "031010");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Taxonomias" }).click();
    await page.getByRole("combobox", { name: "Grupo" }).selectOption("tag");
    await page.getByRole("textbox", { name: "Nome" }).fill("Taxonomia concorrente");
    await page.getByRole("textbox", { name: "Slug" }).fill(slug);
    await page.getByRole("spinbutton", { name: "Ordem" }).fill("310");
    await page.getByRole("button", { name: "Criar taxonomia" }).click();
    const card = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Taxonomia concorrente" }) });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Editar" }).click();
    await page.getByRole("textbox", { name: "Nome" }).fill("Edição local obsoleta");
    await updateFeat031TagConcurrently(slug, remoteName);
    await page.getByRole("button", { name: "Salvar edição" }).click();

    await expect(page.getByRole("heading", { name: "Nova taxonomia" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "A taxonomia mudou" })).toContainText(
      "A taxonomia mudou",
    );
    await expect(page.getByRole("heading", { name: remoteName })).toBeVisible();
    await expect(page.getByText("Edição local obsoleta", { exact: true })).toHaveCount(0);
  } finally {
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Taxonomy(undefined, slug);
    await cleanupFeat031Users({ operators: [admin] });
  }
});
