import { expect, test, type Page } from "@playwright/test";

import {
  cleanupFeat031Users,
  cleanupFeat031Taxonomy,
  createFeat031BulkUsers,
  createFeat031DirectIdentity,
  createFeat031Operator,
  loginFeat031Backoffice,
  provisionFeat031Operator,
  readFeat031Audit,
  setFeat031RolesConcurrently,
  setFeat031UserStatusConcurrently,
  updateFeat031TagConcurrently,
} from "../../helpers/feat-031-backoffice-users-taxonomy";

async function searchUser(page: Page, query: string, userId: string) {
  await page.getByRole("textbox", { name: "Buscar usuários" }).fill(query);
  await page.getByRole("button", { name: "Buscar" }).click();
  const card = page
    .getByRole("article")
    .filter({ has: page.getByText(`Identificador …${userId.slice(-8)}`, { exact: true }) });
  await expect(card).toBeVisible();
  return card;
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
    await card
      .getByRole("combobox", { name: "Motivo auditado" })
      .selectOption("identity_verification");
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
    await card.getByRole("button", { name: "Ocultar agora" }).click();
    await expect(card).not.toContainText(target.email);
    await expect(card).not.toContainText(target.name);
    await expect(card).not.toContainText(target.taxId);
  } finally {
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
      return {
        bodyScrollWidth: document.body.scrollWidth,
        buttonBottom: Math.round(bounds.bottom),
        buttonTop: Math.round(bounds.top),
        clientWidth,
        hitInsideButton: hit === button || (hit !== null && button.contains(hit)),
        hitTag: hit?.tagName ?? null,
        overflowing: [...document.querySelectorAll("body *")]
          .map((element) => {
            const rectangle = element.getBoundingClientRect();
            return {
              className: element.getAttribute("class"),
              left: Math.round(rectangle.left),
              right: Math.round(rectangle.right),
              tag: element.tagName,
              width: Math.round(rectangle.width),
            };
          })
          .filter((element) => element.left < 0 || element.right > clientWidth)
          .slice(0, 12),
        viewportHeight: window.innerHeight,
      };
    });
    expect(hitEvidence.overflowing).toEqual([]);
    expect(hitEvidence).toMatchObject({
      bodyScrollWidth: hitEvidence.clientWidth,
      hitInsideButton: true,
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
    await cleanupFeat031Users({ bulk: bulk.identities, operators: [support] });
  }
});

test("SL-F031-E2E-008 @p1 mudança de papel encerra a composição privada anterior", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const admin = createFeat031Operator(testInfo, "008_session_scope");
  try {
    await provisionFeat031Operator(page, admin, "admin", "031008");
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Taxonomias" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Taxonomias" })).toBeVisible();
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
    await expect(page.getByRole("heading", { level: 1, name: "Taxonomias" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Taxonomias" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Acessos" })).toHaveCount(0);
  } finally {
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
    await card.getByRole("button", { name: "Conceder support" }).click();
    await setFeat031RolesConcurrently(target.userId, ["support"]);
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await expect(page.getByRole("region", { name: "Confirmar alteração de papel" })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Os papéis mudaram" })).toContainText(
      "Os papéis mudaram",
    );
    await expect(card.getByRole("button", { name: "Revogar support" })).toBeVisible();
  } finally {
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
    await cleanupFeat031Taxonomy(undefined, slug);
    await cleanupFeat031Users({ operators: [admin] });
  }
});
