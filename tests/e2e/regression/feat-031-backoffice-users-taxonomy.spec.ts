import { expect, test, type Page } from "@playwright/test";

import {
  cleanupFeat031Users,
  createFeat031BulkUsers,
  createFeat031DirectIdentity,
  createFeat031Operator,
  loginFeat031Backoffice,
  provisionFeat031Operator,
  readFeat031Audit,
} from "../../helpers/feat-031-backoffice-users-taxonomy";

async function searchUser(page: Page, query: string, heading: string) {
  await page.getByRole("textbox", { name: "Buscar usuários" }).fill(query);
  await page.getByRole("button", { name: "Buscar" }).click();
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: heading }) });
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
    const card = await searchUser(page, target.email, target.name);
    await expect(card).not.toContainText(target.email);
    await expect(card).not.toContainText(target.taxId);
    await card
      .getByRole("combobox", { name: "Motivo auditado" })
      .selectOption("identity_verification");
    await card.getByRole("button", { name: "Revelar dados por 60 segundos" }).click();
    await expect(card.getByText(target.email, { exact: true })).toBeVisible();
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
