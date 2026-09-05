import { expect, test, type Page } from "@playwright/test";
import {
  apiSuccessSchema,
  backofficeTaxonomyItemSchema,
  backofficeTaxonomyListSchema,
  backofficeUserListSchema,
  backofficeUserSummarySchema,
} from "@set-livre/contracts";

import {
  cleanupFeat031Users,
  cleanupFeat031Taxonomy,
  createFeat031BulkUsers,
  createFeat031DirectIdentity,
  createFeat031IncompleteIdentity,
  createFeat031Operator,
  failFeat031ReadsAfterConfirmedCommands,
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

test("SL-F031-E2E-035 @p1 confirmação incoerente preserva a tentativa de conta e taxonomia até replay", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const admin = createFeat031Operator(testInfo, "035_command_outcomes");
  const target = await createFeat031DirectIdentity("Resultado de conta QA");
  const slug = `qa-f031-outcome-${Date.now().toString(36)}`;
  const commands: unknown[] = [];
  let tagId: string | undefined;
  try {
    await provisionFeat031Operator(page, admin, "admin", "031035");
    await loginFeat031Backoffice(page, admin);
    const userCard = await searchUser(page, target.email, target.userId);
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/commands") {
        commands.push(request.postDataJSON());
      }
    });
    let userResponses = 0;
    await page.route(
      "**/api/commands",
      async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const result = apiSuccessSchema(backofficeUserSummarySchema).parse(await response.json());
        expect(result.data).toMatchObject({
          id: target.userId,
          status: "suspended",
          accountVersion: 1,
        });
        userResponses += 1;
        await route.fulfill({
          response,
          json: {
            ...result,
            data: {
              ...result.data,
              ...(userResponses === 1 ? { status: "active" } : { accountVersion: 0 }),
            },
          },
        });
      },
      { times: 2 },
    );
    await userCard.getByRole("button", { name: "Revisar suspensão" }).click();
    const confirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    await confirmation.getByRole("checkbox", { name: "Revisei o impacto desta alteração" }).check();
    await confirmation.getByRole("button", { name: "Confirmar", exact: true }).click();
    const userReplay = confirmation.getByRole("button", { name: "Repetir mesma tentativa" });
    for (const responseCount of [1, 2]) {
      await expect.poll(() => userResponses).toBe(responseCount);
      await expect(confirmation.getByRole("alert")).toContainText(
        "O resultado não pôde ser confirmado",
      );
      await expect(userReplay).toBeEnabled();
      await expect(page.getByRole("textbox", { name: "Buscar usuários" })).toBeDisabled();
      await expect(confirmation.getByRole("button", { name: "Cancelar" })).toBeDisabled();
      await expect(page.getByRole("status").filter({ hasText: "Usuário suspenso" })).toHaveCount(0);
      expect(userResponses).toBe(responseCount);
      expect(commands).toHaveLength(responseCount);
      await userReplay.click();
    }
    await expect(confirmation).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Usuário suspenso" })).toBeVisible();
    expect(commands).toHaveLength(3);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[2]).toEqual(commands[0]);
    expect(await readFeat031Audit("backoffice.user_suspended", target.userId)).toHaveLength(1);

    await page.getByRole("link", { name: "Taxonomias" }).click();
    await page.getByRole("combobox", { name: "Grupo" }).selectOption("tag");
    await page.getByRole("textbox", { name: "Nome" }).fill("Taxonomia QA anterior");
    await page.getByRole("textbox", { name: "Slug" }).fill(slug);
    await page.getByRole("button", { name: "Criar taxonomia" }).click();
    const taxonomyCard = page
      .getByRole("article")
      .filter({ has: page.getByText(slug, { exact: true }) });
    await taxonomyCard.getByRole("button", { name: "Editar", exact: true }).click();
    const nextName = "Taxonomia QA confirmada";
    await page.getByRole("textbox", { name: "Nome" }).fill(` ${nextName} `);
    const beforeEdit = commands.length;
    let taxonomyResponses = 0;
    await page.route(
      "**/api/commands",
      async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const result = apiSuccessSchema(backofficeTaxonomyItemSchema).parse(await response.json());
        expect(result.data).toMatchObject({ name: nextName, slug, version: 1, active: true });
        tagId = result.data.id;
        taxonomyResponses += 1;
        await route.fulfill({
          response,
          json: {
            ...result,
            data: {
              ...result.data,
              ...(taxonomyResponses === 1 ? { name: "Taxonomia QA anterior" } : { version: 0 }),
            },
          },
        });
      },
      { times: 2 },
    );
    await page.getByRole("button", { name: "Salvar edição" }).click();
    const manager = page.getByRole("region", { name: "Taxonomias" });
    const taxonomyReplay = manager.getByRole("button", { name: "Repetir mesma tentativa" });
    for (const responseCount of [1, 2]) {
      await expect.poll(() => taxonomyResponses).toBe(responseCount);
      await expect(manager.getByRole("alert")).toContainText("O resultado não pôde ser confirmado");
      await expect(taxonomyReplay).toBeEnabled();
      await expect(page.getByRole("textbox", { name: "Nome" })).toHaveValue(` ${nextName} `);
      await expect(page.getByRole("textbox", { name: "Nome" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Cancelar edição" })).toBeDisabled();
      await expect(
        taxonomyCard.getByRole("button", { name: "Editar", exact: true }),
      ).toBeDisabled();
      await expect(page.getByRole("status").filter({ hasText: "salva na versão 1" })).toHaveCount(
        0,
      );
      expect(taxonomyResponses).toBe(responseCount);
      expect(commands).toHaveLength(beforeEdit + responseCount);
      await taxonomyReplay.click();
    }
    await expect(taxonomyReplay).toHaveCount(0);
    await expect(taxonomyCard.getByRole("heading", { name: nextName, exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "salva na versão 1" })).toBeVisible();
    expect(commands).toHaveLength(beforeEdit + 3);
    expect(commands[beforeEdit + 1]).toEqual(commands[beforeEdit]);
    expect(commands[beforeEdit + 2]).toEqual(commands[beforeEdit]);
    if (tagId === undefined) throw new Error("A resposta real não identificou a taxonomia QA.");
    expect(await readFeat031Audit("backoffice.taxonomy_updated", tagId)).toHaveLength(1);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Taxonomy(undefined, slug);
    await cleanupFeat031Users({ direct: [target], operators: [admin] });
  }
});

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
    await page
      .getByRole("textbox", { name: "Buscar usuários" })
      .fill(`  ${bulk.query.toUpperCase()}  `);
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByRole("article")).toHaveCount(50);
    await page.getByRole("textbox", { name: "Buscar usuários" }).fill(bulk.query);
    await page.getByRole("button", { name: "Buscar" }).click();
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

test("SL-F031-E2E-027 @p1 repetir o mesmo filtro recupera uma busca que falhou", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "027_search_retry");
  const target = await createFeat031DirectIdentity("Retry da busca");
  let filteredReads = 0;
  let rejectFilteredReads = true;
  try {
    await provisionFeat031Operator(page, support, "support", "031027");
    await loginFeat031Backoffice(page, support);
    await page.route("**/api/users", async (route) => {
      const body = route.request().postDataJSON() as { query?: unknown } | null;
      if (body?.query !== target.email) {
        await route.continue();
        return;
      }
      filteredReads += 1;
      if (rejectFilteredReads) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    const searchInput = page.getByRole("textbox", { name: "Buscar usuários" });
    const searchButton = page.getByRole("button", { name: "Buscar" });
    const directory = page.getByRole("region", { name: "Usuários" });
    await searchInput.fill(target.email);
    await searchButton.click();
    await expect(directory.getByRole("alert")).toContainText(
      "Não foi possível conectar ao backoffice",
    );
    const failedReadCount = filteredReads;
    expect(failedReadCount).toBeGreaterThanOrEqual(2);

    rejectFilteredReads = false;
    await searchButton.click();
    const card = page.getByRole("article").filter({
      has: page.getByText(`Identificador …${target.userId.slice(-8)}`, { exact: true }),
    });
    await expect(card).toBeVisible();
    await expect(directory.getByRole("alert")).toHaveCount(0);
    expect(filteredReads).toBe(failedReadCount + 1);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ direct: [target], operators: [support] });
  }
});

test("SL-F031-E2E-017 @p1 nova busca descarta confirmação de status ainda não enviada", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const support = createFeat031Operator(testInfo, "017_search_status_boundary");
  const firstTarget = await createFeat031DirectIdentity("Busca status anterior");
  const nextTarget = await createFeat031DirectIdentity("Busca status atual");
  try {
    await provisionFeat031Operator(page, support, "support", "031017");
    await loginFeat031Backoffice(page, support);
    const firstCard = await searchUser(page, firstTarget.email, firstTarget.userId);
    await firstCard.getByRole("button", { name: "Revisar suspensão" }).click();
    const firstConfirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    await firstConfirmation
      .getByRole("checkbox", { name: "Revisei o impacto desta alteração" })
      .check();

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

test("SL-F031-E2E-030 @p1 acesso confirmado aguarda RSC autoritativo e recupera leitura sem repetir comando", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const admin = createFeat031Operator(testInfo, "030_access_refresh");
  const target = await createFeat031DirectIdentity("Verificação dos acessos");
  let markRefreshHeld: () => void = () => undefined;
  let releaseRefresh: () => void = () => undefined;
  const heldRefresh = new Promise<void>((resolve) => {
    markRefreshHeld = resolve;
  });
  const refreshRelease = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let holdRefresh = true;
  let commandRequests = 0;
  try {
    await provisionFeat031Operator(page, admin, "admin", "031030");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Acessos" }).click();
    const card = await searchUser(page, target.email, target.userId);
    await card.getByRole("link", { name: "Gerenciar acesso" }).click();
    await page.getByRole("button", { name: "Revisar concessão de suporte" }).click();
    await page.route("**/acessos/**", async (route) => {
      if (route.request().headers()["rsc"] !== "1" || !holdRefresh) {
        await route.continue();
        return;
      }
      markRefreshHeld();
      await refreshRelease;
      await route.abort("failed");
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/commands") commandRequests += 1;
    });
    const confirmationStartedAt = performance.now();
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await heldRefresh;
    await expect(
      page.getByRole("status").filter({ hasText: "Verificando o estado atual" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Estado atual", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Revisar concessão de suporte" })).toBeDisabled();
    await expect(
      page.getByText("Acesso atualizado e sessões incompatíveis encerradas.", { exact: true }),
    ).toHaveCount(0);

    // O prazo real não avança os deadlines das leituras de sessão concorrentes.
    const accessDetail = page.getByRole("region", { name: /^Acessos da conta /u });
    await expect(accessDetail.getByRole("alert")).toContainText(
      "Não foi possível verificar o estado atual",
      { timeout: 15_000 },
    );
    expect(performance.now() - confirmationStartedAt).toBeGreaterThanOrEqual(10_000);
    holdRefresh = false;
    await page.getByRole("button", { name: "Tentar verificar acessos novamente" }).click();
    await expect(page.getByRole("button", { name: "Revisar revogação de suporte" })).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Estado atual", exact: true })).toBeVisible();
    await expect(
      page.getByText("Acesso atualizado e sessões incompatíveis encerradas.", { exact: true }),
    ).toBeVisible();
    expect(commandRequests).toBe(1);
    expect(await readFeat031Roles(target.userId)).toEqual([{ role: "support" }]);
  } finally {
    releaseRefresh();
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

test("SL-F031-E2E-028 @p1 erro inicial de taxonomias oferece recuperação na página", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const admin = createFeat031Operator(testInfo, "028_taxonomy_retry");
  let taxonomyReads = 0;
  let rejectTaxonomyReads = true;
  try {
    await provisionFeat031Operator(page, admin, "admin", "031028");
    await loginFeat031Backoffice(page, admin);
    await page.route("**/api/taxonomies", async (route) => {
      taxonomyReads += 1;
      if (rejectTaxonomyReads) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.getByRole("link", { name: "Taxonomias" }).click();
    const manager = page.getByRole("region", { name: "Taxonomias" });
    const retry = page.getByRole("button", { name: "Tentar carregar taxonomias novamente" });
    await expect(manager.getByRole("alert")).toContainText(
      "Não foi possível conectar ao backoffice",
    );
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    const failedReadCount = taxonomyReads;
    expect(failedReadCount).toBeGreaterThanOrEqual(2);

    rejectTaxonomyReads = false;
    await retry.click();
    await expect(page.getByRole("article").first()).toBeVisible();
    await expect(manager.getByRole("alert")).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    expect(taxonomyReads).toBe(failedReadCount + 1);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ operators: [admin] });
  }
});

test("SL-F031-E2E-031 @p1 criação e edição confirmadas recuperam somente a leitura do catálogo", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const admin = createFeat031Operator(testInfo, "031_upsert_read_recovery");
  const slug = `qa-f031-recovery-${Date.now().toString(36)}`;
  try {
    await provisionFeat031Operator(page, admin, "admin", "031031");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Taxonomias" }).click();
    await expect(page.getByRole("button", { name: "Criar taxonomia" })).toBeEnabled();
    const faults = await failFeat031ReadsAfterConfirmedCommands(page, "/api/taxonomies");
    const manager = page.getByRole("region", { name: "Taxonomias" });
    const retry = manager.getByRole("button", { name: "Tentar carregar taxonomias novamente" });
    const card = page.getByRole("article").filter({ has: page.getByText(slug, { exact: true }) });
    const form = page.locator("form").filter({ has: page.getByRole("textbox", { name: "Slug" }) });

    for (const editing of [false, true]) {
      if (editing) await card.getByRole("button", { name: "Editar", exact: true }).click();
      else {
        await page.getByRole("combobox", { name: "Grupo" }).selectOption("tag");
        await page.getByRole("textbox", { name: "Slug" }).fill(slug);
      }
      const name = editing ? "Taxonomia QA recuperada editada" : "Taxonomia QA recuperada";
      await page.getByRole("textbox", { name: "Nome" }).fill(name);
      const submit = page.getByRole("button", {
        name: editing ? "Salvar edição" : "Criar taxonomia",
      });
      await submit.click();
      const error = manager.getByRole("alert").filter({ hasText: "Alteração confirmada" });
      await expect(error).toContainText("o comando não será reenviado");
      await expect(retry).toBeEnabled();
      const confirmed = apiSuccessSchema(backofficeTaxonomyItemSchema).parse(
        faults.results.at(-1),
      ).data;
      expect(confirmed).toMatchObject({ name, slug, active: true });
      const commandCount = editing ? 2 : 1;
      expect(faults.commands).toHaveLength(commandCount);
      await expect(submit).toBeDisabled();
      await expect(page.getByRole("textbox", { name: "Nome" })).toHaveValue(name);
      await expect(page.getByRole("textbox", { name: "Nome" })).toBeDisabled();
      await expect(page.getByRole("textbox", { name: "Slug" })).toHaveValue(slug);
      await expect(
        manager.getByRole("button", { name: "Editar", exact: true }).first(),
      ).toBeDisabled();
      await expect(
        manager.getByRole("button", { name: "Revisar arquivamento" }).first(),
      ).toBeDisabled();
      if (editing)
        await expect(page.getByRole("button", { name: "Cancelar edição" })).toBeDisabled();
      await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
      await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
      // Uma segunda falha da leitura não libera o formulário nem converte sucesso em replay.
      await retry.click();
      await expect(error).toBeVisible();
      await expect(retry).toBeEnabled();
      await expect(submit).toBeDisabled();
      expect(faults.commands).toHaveLength(commandCount);

      const failedReadCount = faults.reads.length;
      faults.allowReads();
      const readResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/taxonomies" && response.status() === 200,
      );
      await retry.click();
      const refreshed = apiSuccessSchema(backofficeTaxonomyListSchema).parse(
        await (await readResponse).json(),
      ).data;
      expect(refreshed.scope).toBe(admin.userId);
      expect(refreshed.items.filter((item) => item.slug === slug)).toEqual([confirmed]);
      await expect(error).toHaveCount(0);
      await expect(card.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(card).toContainText(`versão ${confirmed.version}`);
      await expect(card.getByRole("button", { name: "Editar", exact: true })).toBeEnabled();
      await expect(page.getByRole("textbox", { name: "Nome" })).toHaveValue("");
      expect(faults.reads).toHaveLength(failedReadCount + 1);
      expect(faults.reads.every((read) => read.method === "GET")).toBe(true);
      expect(faults.commands).toHaveLength(commandCount);
      expect(
        await readFeat031Audit(
          editing ? "backoffice.taxonomy_updated" : "backoffice.taxonomy_created",
          confirmed.id,
        ),
      ).toHaveLength(1);
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Taxonomy(undefined, slug);
    await cleanupFeat031Users({ operators: [admin] });
  }
});

test("SL-F031-E2E-032 @p1 arquivamento e reativação confirmados preservam o impacto até reler o catálogo", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const admin = createFeat031Operator(testInfo, "032_taxonomy_status_read_recovery");
  const slug = `qa-f031-status-${Date.now().toString(36)}`;
  try {
    await provisionFeat031Operator(page, admin, "admin", "031032");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Taxonomias" }).click();
    await page.getByRole("combobox", { name: "Grupo" }).selectOption("tag");
    await page.getByRole("textbox", { name: "Nome" }).fill("Taxonomia QA estado verificado");
    await page.getByRole("textbox", { name: "Slug" }).fill(slug);
    await page.getByRole("button", { name: "Criar taxonomia" }).click();
    const card = page.getByRole("article").filter({ has: page.getByText(slug, { exact: true }) });
    await expect(card.getByRole("button", { name: "Editar", exact: true })).toBeEnabled();
    const faults = await failFeat031ReadsAfterConfirmedCommands(page, "/api/taxonomies");

    for (const archiving of [true, false]) {
      await card
        .getByRole("button", { name: archiving ? "Revisar arquivamento" : "Revisar reativação" })
        .click();
      const confirmation = page.getByRole("region", { name: /^Impacto do/u });
      const submit = confirmation.getByRole("button", { name: /^Confirmar/u });
      await submit.click();
      const error = page.getByRole("alert").filter({ hasText: "Alteração confirmada" });
      const retry = page.getByRole("button", { name: "Tentar carregar taxonomias novamente" });
      await expect(error).toContainText("o comando não será reenviado");
      await expect(retry).toBeEnabled();
      const confirmed = apiSuccessSchema(backofficeTaxonomyItemSchema).parse(
        faults.results.at(-1),
      ).data;
      expect(confirmed.active).toBe(!archiving);
      await expect(
        card.getByText(archiving ? "Ativa" : "Arquivada", { exact: true }),
      ).toBeVisible();
      await expect(submit).toBeDisabled();
      await expect(
        confirmation.getByRole("button", { name: "Cancelar", exact: true }),
      ).toBeDisabled();
      await expect(card.getByRole("button", { name: "Editar", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Criar taxonomia" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Repetir mesma tentativa" })).toHaveCount(0);
      const failedReadCount = faults.reads.length;
      faults.allowReads();
      await retry.click();
      await expect(confirmation).toHaveCount(0);
      await expect(error).toHaveCount(0);
      await expect(
        card.getByText(archiving ? "Arquivada" : "Ativa", { exact: true }),
      ).toBeVisible();
      await expect(card).toContainText(`versão ${confirmed.version}`);
      await expect(card.getByRole("button", { name: "Editar", exact: true })).toBeEnabled();
      expect(faults.reads).toHaveLength(failedReadCount + 1);
      expect(faults.commands).toHaveLength(archiving ? 1 : 2);
      expect(
        await readFeat031Audit(
          archiving ? "backoffice.taxonomy_archived" : "backoffice.taxonomy_reactivated",
          confirmed.id,
        ),
      ).toHaveLength(1);
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Taxonomy(undefined, slug);
    await cleanupFeat031Users({ operators: [admin] });
  }
});

test("SL-F031-E2E-033 @p1 status confirmado bloqueia busca e paginação até recuperar a leitura sem repetir comando", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const support = createFeat031Operator(testInfo, "033_user_status_read_recovery");
  const bulk = await createFeat031BulkUsers(`033_${testInfo.project.name}`);
  try {
    await provisionFeat031Operator(page, support, "support", "031033");
    await loginFeat031Backoffice(page, support);
    const firstRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/users" &&
        response.request().postDataJSON()?.query === bulk.query &&
        response.status() === 200,
    );
    const search = page.getByRole("textbox", { name: "Buscar usuários" });
    await search.fill(bulk.query);
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    const initial = apiSuccessSchema(backofficeUserListSchema).parse(
      await (await firstRead).json(),
    ).data;
    const target = initial.items[0];
    if (target === undefined) throw new Error("A lista QA precisa conter a conta alvo.");
    const card = page.getByRole("article").filter({
      has: page.getByText(`Identificador …${target.id.slice(-8)}`, { exact: true }),
    });
    await expect(card).toBeVisible();
    const loadMore = page.getByRole("button", { name: "Carregar mais" });
    await expect(loadMore).toBeEnabled();
    const faults = await failFeat031ReadsAfterConfirmedCommands(page, "/api/users");
    for (const suspending of [true, false]) {
      await card
        .getByRole("button", { name: suspending ? "Revisar suspensão" : "Revisar restauração" })
        .click();
      const confirmation = page.getByRole("region", {
        name: suspending ? "Confirmar suspensão" : "Confirmar restauração",
      });
      const impact = confirmation.getByRole("checkbox", {
        name: "Revisei o impacto desta alteração",
      });
      await impact.check();
      const submit = confirmation.getByRole("button", { name: "Confirmar", exact: true });
      await submit.click();
      const error = page.getByRole("alert").filter({ hasText: "Alteração confirmada" });
      const retry = page.getByRole("button", { name: "Tentar carregar usuários novamente" });
      await expect(error).toContainText("o comando não será reenviado");
      await expect(retry).toBeEnabled();
      const confirmed = apiSuccessSchema(backofficeUserSummarySchema).parse(
        faults.results.at(-1),
      ).data;
      expect(confirmed).toMatchObject({
        id: target.id,
        status: suspending ? "suspended" : "active",
      });
      await expect(
        card.getByText(suspending ? "Ativo" : "Suspenso", { exact: true }),
      ).toBeVisible();
      await expect(submit).toBeDisabled();
      await expect(impact).toBeChecked();
      await expect(impact).toBeDisabled();
      await expect(
        confirmation.getByRole("button", { name: "Cancelar", exact: true }),
      ).toBeDisabled();
      await expect(search).toBeDisabled();
      await expect(page.getByRole("button", { name: "Buscar", exact: true })).toBeDisabled();
      await expect(loadMore).toBeDisabled();
      await expect(page.getByRole("button", { name: "Revisar suspensão" }).last()).toBeDisabled();
      await expect(
        card.getByRole("button", { name: "Revelar dados por 60 segundos" }),
      ).toBeDisabled();
      await page
        .locator("form")
        .filter({ has: search })
        .evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(search).toHaveValue(bulk.query);
      await retry.click();
      await expect(error).toBeVisible();
      await expect(retry).toBeEnabled();
      await expect(submit).toBeDisabled();
      expect(faults.commands).toHaveLength(suspending ? 1 : 2);

      const failedReadCount = faults.reads.length;
      faults.allowReads();
      await retry.click();
      await expect(error).toHaveCount(0);
      await expect(confirmation).toHaveCount(0);
      await expect(
        card.getByText(suspending ? "Suspenso" : "Ativo", { exact: true }),
      ).toBeVisible();
      await expect(card).toContainText(`versão ${confirmed.accountVersion}`);
      await expect(search).toBeEnabled();
      await expect(loadMore).toBeEnabled();
      expect(faults.reads).toHaveLength(failedReadCount + 1);
      expect(faults.reads.every((read) => read.method === "POST" && read.search === "")).toBe(true);
      for (const read of faults.reads)
        expect(read.body).toMatchObject({ query: bulk.query, cursor: null });
      expect(faults.commands).toHaveLength(suspending ? 1 : 2);
      expect(await readFeat031UserStatus(target.id)).toMatchObject({
        account_version: confirmed.accountVersion,
        status: confirmed.status,
      });
      expect(
        await readFeat031Audit(
          suspending ? "backoffice.user_suspended" : "backoffice.user_restored",
          target.id,
        ),
      ).toHaveLength(1);
    }
    await loadMore.click();
    await expect(page.getByRole("article")).toHaveCount(52);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({ bulk: bulk.identities, operators: [support] });
  }
});

test("SL-F031-E2E-034 @p0 alvo deslocado de página recupera status por UUID sem perder filtro nem repetir suspensão", async ({
  page,
}, testInfo) => {
  test.setTimeout(210_000);
  const support = createFeat031Operator(testInfo, "034_displaced_status_target");
  const bulk = await createFeat031BulkUsers(`034_${testInfo.project.name}`);
  const concurrentUsers: typeof bulk.identities = [];
  const commands: unknown[] = [];
  const results: unknown[] = [];
  const reads: Array<{ body: unknown; method: string; search: string }> = [];
  const readResults: Array<ReturnType<typeof backofficeUserListSchema.parse>> = [];
  let failExactRead = true;
  try {
    await provisionFeat031Operator(page, support, "support", "031034");
    await loginFeat031Backoffice(page, support);
    const firstRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/users" &&
        response.request().postDataJSON()?.query === bulk.query &&
        response.status() === 200,
    );
    const search = page.getByRole("textbox", { name: "Buscar usuários" });
    const searchSubmit = page.getByRole("button", { name: "Buscar", exact: true });
    await search.fill(bulk.query);
    await searchSubmit.click();
    const initial = apiSuccessSchema(backofficeUserListSchema).parse(
      await (await firstRead).json(),
    ).data;
    expect(bulk.identities).toHaveLength(52);
    expect(initial.items).toHaveLength(50);
    expect(initial.nextCursor).not.toBeNull();
    const target = initial.items.at(-1);
    if (target === undefined) throw new Error("A página QA precisa conter sua última conta.");
    const cards = page.getByRole("article");
    const targetLabel = `Identificador …${target.id.slice(-8)}`;
    const targetCard = cards.filter({ has: page.getByText(targetLabel, { exact: true }) });
    await expect(cards).toHaveCount(50);
    await expect(cards.last()).toContainText(targetLabel);

    await page.route("**/api/commands", async (route) => {
      const command = route.request().postDataJSON() as { action?: unknown } | null;
      if (command?.action !== "backoffice.user.suspend") {
        await route.continue();
        return;
      }
      commands.push(command);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      results.push(await response.json());
      // O comando real já commitou; a nova identidade entra antes da releitura do browser.
      const inserted = await createFeat031BulkUsers("concurrent", 1, bulk.query);
      concurrentUsers.push(...inserted.identities);
      await route.fulfill({ response });
    });
    await page.route(
      (url) => url.pathname === "/api/users",
      async (route) => {
        const request = route.request();
        const body: unknown = request.method() === "POST" ? request.postDataJSON() : null;
        reads.push({ body, method: request.method(), search: new URL(request.url()).search });
        if (
          failExactRead &&
          typeof body === "object" &&
          body !== null &&
          "query" in body &&
          body.query === target.id
        ) {
          await route.abort("failed");
          return;
        }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        readResults.push(
          apiSuccessSchema(backofficeUserListSchema).parse(await response.json()).data,
        );
        await route.fulfill({ response });
      },
    );

    await targetCard.getByRole("button", { name: "Revisar suspensão" }).click();
    const confirmation = page.getByRole("region", { name: "Confirmar suspensão" });
    const impact = confirmation.getByRole("checkbox", {
      name: "Revisei o impacto desta alteração",
    });
    const submit = confirmation.getByRole("button", { name: "Confirmar", exact: true });
    const loadMore = page.getByRole("button", { name: "Carregar mais" });
    await impact.check();
    await submit.click();
    const error = page.getByRole("alert").filter({ hasText: "Alteração confirmada" });
    const retry = page.getByRole("button", { name: "Tentar carregar usuários novamente" });
    await expect(error).toContainText("o comando não será reenviado");
    await expect(retry).toBeEnabled();
    const confirmed = apiSuccessSchema(backofficeUserSummarySchema).parse(results[0]).data;
    expect(confirmed).toMatchObject({ id: target.id, status: "suspended" });
    expect(confirmed.accountVersion).toBeGreaterThan(target.accountVersion);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ payload: { userId: target.id } });
    expect(concurrentUsers).toHaveLength(1);
    const expectedFirstPageIds = [
      concurrentUsers[0]?.id,
      ...initial.items.slice(0, -1).map((user) => user.id),
    ];
    expect(readResults).toHaveLength(1);
    expect(readResults[0]?.items.map((user) => user.id)).toEqual(expectedFirstPageIds);
    expect(reads.slice(1).length).toBeGreaterThan(0);
    expect(reads[0]?.body).toEqual({ query: bulk.query, cursor: null });
    for (const read of reads.slice(1))
      expect(read.body).toEqual({ query: target.id, cursor: null });
    await expect(cards).toHaveCount(50);
    await expect(targetCard).toHaveCount(0);
    await expect(confirmation).toContainText("O histórico permanece.");
    await expect(impact).toBeChecked();
    await expect(impact).toBeDisabled();
    await expect(submit).toBeDisabled();
    await expect(
      confirmation.getByRole("button", { name: "Cancelar", exact: true }),
    ).toBeDisabled();
    await expect(search).toBeDisabled();
    await expect(search).toHaveValue(bulk.query);
    await expect(searchSubmit).toBeDisabled();
    await expect(loadMore).toBeDisabled();
    await expect(cards.first().getByRole("button", { name: "Revisar suspensão" })).toBeDisabled();
    await expect(
      cards.first().getByRole("button", { name: "Revelar dados por 60 segundos" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Repetir mesma tentativa" })).toHaveCount(0);
    expect(await readFeat031UserStatus(target.id)).toMatchObject({
      account_version: confirmed.accountVersion,
      status: "suspended",
    });
    expect(await readFeat031Audit("backoffice.user_suspended", target.id)).toHaveLength(1);

    const failedReadCount = reads.length;
    failExactRead = false;
    await retry.click();
    await expect(error).toHaveCount(0);
    await expect(confirmation).toHaveCount(0);
    await expect(
      page.getByText("Usuário suspenso e sessões operacionais encerradas.", { exact: true }),
    ).toBeVisible();
    await expect(search).toBeEnabled();
    await expect(search).toHaveValue(bulk.query);
    await expect(searchSubmit).toBeEnabled();
    await expect(loadMore).toBeEnabled();
    await expect(cards.first().getByRole("button", { name: "Revisar suspensão" })).toBeEnabled();
    await expect(cards).toHaveCount(50);
    await expect(targetCard).toHaveCount(0);
    expect(reads.slice(failedReadCount).map((read) => read.body)).toEqual([
      { query: bulk.query, cursor: null },
      { query: target.id, cursor: null },
    ]);
    expect(readResults[1]?.items.map((user) => user.id)).toEqual(expectedFirstPageIds);
    expect(readResults[2]?.items).toEqual([confirmed]);
    expect(readResults[2]?.nextCursor).toBeNull();
    expect(commands).toHaveLength(1);

    const nextCursor = readResults[1]?.nextCursor;
    expect(nextCursor).toEqual(expect.any(String));
    await loadMore.click();
    await expect(cards).toHaveCount(53);
    await expect(targetCard.getByText("Suspenso", { exact: true })).toBeVisible();
    await expect(targetCard).toContainText(`versão ${confirmed.accountVersion}`);
    await expect(targetCard.getByRole("button", { name: "Revisar restauração" })).toBeEnabled();
    await expect(loadMore).toHaveCount(0);
    await expect(search).toHaveValue(bulk.query);
    expect(reads.at(-1)?.body).toEqual({ query: bulk.query, cursor: nextCursor });
    expect(readResults).toHaveLength(4);
    expect(readResults[3]?.items[0]).toEqual(confirmed);
    expect(readResults[3]?.nextCursor).toBeNull();
    const loadedIds = [...(readResults[1]?.items ?? []), ...(readResults[3]?.items ?? [])].map(
      (user) => user.id,
    );
    expect(loadedIds).toHaveLength(53);
    expect(new Set(loadedIds)).toEqual(
      new Set([...bulk.identities, ...concurrentUsers].map((user) => user.id)),
    );
    expect(reads.every((read) => read.method === "POST" && read.search === "")).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/usuarios");
    expect(new URL(page.url()).search).toBe("");
    expect(commands).toHaveLength(1);
    expect(await readFeat031Audit("backoffice.user_suspended", target.id)).toHaveLength(1);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closePageBeforeDatabaseCleanup(page);
    await cleanupFeat031Users({
      bulk: [...bulk.identities, ...concurrentUsers],
      operators: [support],
    });
  }
});
