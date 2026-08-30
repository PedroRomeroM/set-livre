import { apiSuccessSchema, backofficeSessionSchema } from "@set-livre/contracts";
import { expect, test, type Page } from "@playwright/test";

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
} from "../../helpers/feat-031-backoffice-users-taxonomy";
import { safeE2EEnvironment } from "../../helpers/e2e-environment";

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
    await expect(page.getByRole("status")).toContainText("Usuário suspenso");
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
    await expect(page.getByRole("status")).toContainText("Usuário restaurado");
    expect(await readFeat031UserStatus(target.userId)).toMatchObject({
      account_version: 2,
      profile_version: 1,
      status: "active",
    });
    expect(await readFeat031Audit("backoffice.user_restored", target.userId)).toHaveLength(1);
  } finally {
    await cleanupFeat031Users({ direct: [target], operators: [operator] });
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
        action: "backoffice.access.setRole",
        expectedScope: supportSession.scope,
        idempotencyKey: crypto.randomUUID(),
        payload: { enabled: true, expectedRoles: [], role: "support", userId: target.userId },
      },
    );
    expect(forbidden).toBe(403);

    await page.getByRole("button", { name: "Sair" }).click();
    await expect(page).toHaveURL(/\/entrar\?saida=sucesso$/u);
    await loginFeat031Backoffice(page, admin);
    await page.getByRole("link", { name: "Acessos" }).click();
    const adminCard = await searchUser(page, target.email, target.userId);
    await adminCard.getByRole("button", { name: "Conceder support" }).click();
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await expect(page.getByRole("status")).toContainText("Papéis atualizados");
    expect(await readFeat031Roles(target.userId)).toEqual([{ role: "support" }]);
    expect(await readFeat031Audit("backoffice.role_granted", target.userId)).toHaveLength(1);
  } finally {
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
    await card.getByRole("button", { name: "Revogar admin" }).click();
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await expect(page.getByRole("region", { name: "Acessos" }).getByRole("alert")).toContainText(
      "salvaguarda",
    );
    expect(await readFeat031Roles(admin.userId ?? "")).toEqual([{ role: "admin" }]);
  } finally {
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
    await expect(page.getByRole("status")).toContainText("salva na versão 0");
    await expect(page.getByRole("textbox", { name: "Nome" })).toHaveValue("");

    const createdCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Arquivo histórico QA" }) });
    await createdCard.getByRole("button", { name: "Editar" }).click();
    await page.getByRole("textbox", { name: "Nome" }).fill("Arquivo histórico editado QA");
    await page.getByRole("textbox", { name: "Slug" }).fill(editedSlug);
    await page.getByRole("spinbutton", { name: "Ordem" }).fill("311");
    await page.getByRole("button", { name: "Salvar edição" }).click();
    await expect(page.getByRole("status")).toContainText("salva na versão 1");

    const history = await linkFeat031TagToHistory(owner.userId, editedSlug);
    tagId = history.tagId;
    await page.reload();
    const card = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Arquivo histórico editado QA" }) });
    await expect(card).toContainText("1 uso");
    await card.getByRole("button", { name: "Revisar arquivamento" }).click();
    const impact = page.getByRole("region", { name: "Impacto da desativação" });
    await expect(impact).toContainText("1 referências");
    await impact.getByRole("button", { name: "Confirmar arquivamento" }).click();
    await expect(page.getByRole("status")).toContainText("referências históricas preservadas");
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
    await expect(page.getByRole("status")).toContainText("reativada para novas seleções");
  } finally {
    await cleanupFeat031Users({ direct: [owner], operators: [admin] });
    await cleanupFeat031Taxonomy(tagId);
  }
});
