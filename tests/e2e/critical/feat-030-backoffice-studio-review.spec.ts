import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import {
  cleanupFeat030Scenario,
  createFeat030Operator,
  expectFeat030PreviewsInspectable,
  loginFeat030Operator,
  openFeat030StudioReview,
  prepareFeat030Decision,
  provisionAndLoginFeat030Operator,
  provisionFeat030ChangesPendingStudio,
  provisionFeat030Operator,
  provisionFeat030PendingStudio,
  readFeat030Evidence,
  type Feat030Owner,
} from "../../helpers/feat-030-backoffice-studio-review";

test("SL-F030-E2E-001 @p0 reviewer aprova e publica a candidata atomicamente", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const reviewer = createFeat030Operator(testInfo, "001_approve");
  let owner: Feat030Owner | undefined;
  try {
    const pending = await provisionFeat030PendingStudio(page, testInfo, "001_approve", "3001");
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030001");
    await openFeat030StudioReview(page, pending.studioId, pending.name);
    await expect(
      page.getByRole("heading", { level: 2, name: "Checklist de publicação" }),
    ).toBeVisible();
    await prepareFeat030Decision(page, "Aprovar e publicar");
    await page.getByRole("button", { name: "Confirmar ação" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Operação confirmada" })).toContainText(
      "Operação confirmada",
    );

    const evidence = await readFeat030Evidence(pending.studioId);
    expect(evidence).toMatchObject({
      draft_revision_id: null,
      published_revision_id: pending.revisionId,
      status: "published",
    });
    expect(evidence.review_events).toEqual(["submitted", "approved"]);
    expect(evidence.outbox_templates).toEqual([
      "studio.review.submitted",
      "studio.review.approved",
    ]);
    expect(evidence.audit_actions).toEqual(["backoffice.studio_approved"]);
  } finally {
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

test("SL-F030-E2E-002 @p0 rejeitar alteração mantém a versão pública", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const reviewer = createFeat030Operator(testInfo, "002_reject");
  let owner: Feat030Owner | undefined;
  try {
    const pending = await provisionFeat030ChangesPendingStudio(
      page,
      testInfo,
      "002_reject",
      "3002",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030002");
    await openFeat030StudioReview(page, pending.studioId, pending.candidateName);

    await prepareFeat030Decision(
      page,
      "Rejeitar e devolver para correção",
      "Confirme o endereço e envie novamente para revisão.",
    );
    await page.getByRole("button", { name: "Confirmar ação" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Operação confirmada" })).toContainText(
      "Operação confirmada",
    );

    const evidence = await readFeat030Evidence(pending.studioId);
    expect(evidence.status).toBe("changes_pending");
    expect(evidence.published_revision_id).toBe(pending.publishedRevisionId);
    expect(evidence.draft_revision_id).not.toBe(pending.candidateRevisionId);
    expect(evidence.revisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pending.publishedRevisionId,
          status: "approved",
        }),
        expect.objectContaining({
          id: pending.candidateRevisionId,
          status: "rejected",
        }),
        expect.objectContaining({
          id: evidence.draft_revision_id,
          status: "draft",
        }),
      ]),
    );
    expect(evidence.review_events).toEqual(["submitted", "approved", "submitted", "rejected"]);
    expect(evidence.audit_actions).toEqual(["backoffice.studio_rejected"]);
  } finally {
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

test("SL-F030-E2E-003 @p0 support autenticado é recusado na UI, rota e API editorial", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const support = createFeat030Operator(testInfo, "003_support_boundary");
  let owner: Feat030Owner | undefined;
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "003_support_boundary",
      "3003",
    );
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, support, "support", "030003");
    await expect(page.getByRole("link", { name: "Estúdios" })).toHaveCount(0);
    const apiStatuses = await page.evaluate(async (studioId) => {
      const [queue, detail] = await Promise.all([
        fetch("/api/studios", {
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        fetch(`/api/studios/${encodeURIComponent(studioId)}`),
      ]);
      return { detail: detail.status, queue: queue.status };
    }, pending.studioId);
    expect(apiStatuses).toEqual({ detail: 403, queue: 403 });

    const direct = await page.goto(
      `${new URL(page.url()).origin}/estudios/${encodeURIComponent(pending.studioId)}`,
    );
    expect(direct?.status()).toBe(200);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/usuarios");
    await expect(page.getByRole("heading", { level: 1, name: pending.name })).toHaveCount(0);
    await expect(page.getByRole("img", { name: /foto/u })).toHaveCount(0);
  } finally {
    await cleanupFeat030Scenario(page, { operators: [support], owner });
  }
});

test("SL-F030-E2E-004 @p0 duas decisões concorrentes preservam uma única transição", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const reviewer = createFeat030Operator(testInfo, "004_concurrency");
  let owner: Feat030Owner | undefined;
  let concurrentPage: Page | undefined;
  let releaseBarrier: (() => void) | undefined;
  const bothRequestsArrived = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const outcomes = new Map<Page, number>();
  let requestsAtBarrier = 0;
  try {
    const pending = await provisionFeat030PendingStudio(page, testInfo, "004_concurrency", "3004");
    owner = pending.owner;
    await provisionAndLoginFeat030Operator(page, reviewer, "reviewer", "030004");
    await openFeat030StudioReview(page, pending.studioId, pending.name);

    concurrentPage = await page.context().newPage();
    const secondPage = concurrentPage;
    await secondPage.goto(page.url());
    await expect(secondPage.getByRole("heading", { level: 1, name: pending.name })).toBeVisible();

    await Promise.all([
      prepareFeat030Decision(page, "Aprovar e publicar"),
      prepareFeat030Decision(secondPage, "Aprovar e publicar"),
    ]);

    await page.context().route("**/api/commands", async (route) => {
      const command = z.object({ action: z.string() }).safeParse(route.request().postDataJSON());
      if (!command.success || command.data.action !== "backoffice.studio.approve") {
        await route.continue();
        return;
      }
      requestsAtBarrier += 1;
      if (requestsAtBarrier === 2) releaseBarrier?.();
      await bothRequestsArrived;
      const requestPage = route.request().frame().page();
      const response = await route.fetch();
      outcomes.set(requestPage, response.status());
      await route.fulfill({ response });
    });

    await Promise.all([
      page.getByRole("button", { name: "Confirmar ação" }).click(),
      secondPage.getByRole("button", { name: "Confirmar ação" }).click(),
    ]);
    await expect.poll(() => requestsAtBarrier).toBe(2);
    await expect
      .poll(() => [...outcomes.values()].sort((left, right) => left - right))
      .toEqual([200, 409]);
    const successfulPage = [...outcomes].find(([, status]) => status === 200)?.[0];
    const stalePage = [...outcomes].find(([, status]) => status === 409)?.[0];
    if (successfulPage === undefined || stalePage === undefined) {
      throw new Error(
        "A corrida editorial não identificou exatamente uma aba vencedora e uma stale.",
      );
    }
    await expect(
      successfulPage.getByRole("status").filter({ hasText: "Operação confirmada" }),
    ).toBeVisible();
    await expect(
      stalePage.getByRole("status").filter({ hasText: "O caso deixou de estar disponível" }),
    ).toBeVisible();
    await expect(
      stalePage.getByRole("alert").filter({ hasText: "Revisão não disponível" }),
    ).toBeVisible();
    await expect(stalePage.getByRole("heading", { level: 1, name: pending.name })).toHaveCount(0);
    await expect(stalePage.getByRole("button", { name: "Confirmar ação" })).toHaveCount(0);

    const evidence = await readFeat030Evidence(pending.studioId);
    expect(evidence).toMatchObject({
      draft_revision_id: null,
      published_revision_id: pending.revisionId,
      status: "published",
    });
    expect(evidence.review_events).toEqual(["submitted", "approved"]);
    expect(evidence.audit_actions).toEqual(["backoffice.studio_approved"]);
  } finally {
    await page.context().unroute("**/api/commands");
    await concurrentPage?.close();
    await cleanupFeat030Scenario(page, { operators: [reviewer], owner });
  }
});

test("SL-F030-E2E-009 @p0 concessão e revogação de reviewer pela UI atualizam acesso aberto", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const admin = createFeat030Operator(testInfo, "009_role_lifecycle_admin");
  const support = createFeat030Operator(testInfo, "009_role_lifecycle_support");
  let owner: Feat030Owner | undefined;
  let supportContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const pending = await provisionFeat030PendingStudio(
      page,
      testInfo,
      "009_role_lifecycle",
      "3009",
    );
    owner = pending.owner;
    await provisionFeat030Operator(page, support, "support", "0300091");
    await provisionFeat030Operator(page, admin, "admin", "0300092");
    await loginFeat030Operator(page, admin, "/usuarios");
    if (support.userId === undefined) throw new Error("O support FEAT-030 não publicou userId.");

    const accessUrl = `${new URL(page.url()).origin}/acessos/${support.userId}`;
    const access = await page.goto(accessUrl);
    expect(access?.status()).toBe(200);
    await page.getByRole("button", { name: "Revisar concessão de revisão" }).click();
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Acesso atualizado" })).toBeVisible();

    supportContext = await browser.newContext();
    const supportPage = await supportContext.newPage();
    await loginFeat030Operator(supportPage, support, "/usuarios");
    await supportPage.getByRole("link", { name: "Estúdios" }).click();
    await openFeat030StudioReview(supportPage, pending.studioId, pending.name);
    await expectFeat030PreviewsInspectable(supportPage);

    await page.goto(accessUrl);
    await page.getByRole("button", { name: "Revisar revogação de revisão" }).click();
    await page.getByRole("button", { name: "Confirmar alteração" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Acesso atualizado" })).toBeVisible();

    await supportPage.bringToFront();
    await supportPage.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => new URL(supportPage.url()).pathname).toBe("/usuarios");
    await expect(supportPage.getByRole("heading", { level: 1, name: pending.name })).toHaveCount(0);
    await expect(supportPage.getByRole("img", { name: /foto/u })).toHaveCount(0);
    const denied = await supportPage.evaluate(
      async (studioId) =>
        fetch(`/api/studios/${encodeURIComponent(studioId)}`).then((response) => response.status),
      pending.studioId,
    );
    expect(denied).toBe(403);
  } finally {
    await supportContext?.close();
    await cleanupFeat030Scenario(page, { operators: [admin, support], owner });
  }
});
