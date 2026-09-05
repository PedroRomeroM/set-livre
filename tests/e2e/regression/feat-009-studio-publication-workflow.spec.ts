import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  studioCommandResultSchema,
  studioCommandSchema,
  studioDraftDiscardResultSchema,
  studioPublicationSchema,
  type StudioPublication,
} from "@set-livre/contracts";
import { expect, test, type BrowserContext } from "@playwright/test";

import {
  archiveFeat009Tag,
  cleanupFeat009QaIdentity,
  closeFeat009PageBeforeCleanup,
  createFeat009CandidateThroughUi,
  createFeat009QaIdentity,
  observeFeat009Commands,
  openFeat009Publication,
  provisionFeat009Studio,
  readFeat009PublicationEvidence,
  seedFeat009PublishedStudio,
  seedFeat009RejectedCorrection,
  seedFeat009RejectedUnpublishedCorrection,
  submitFeat009RevisionThroughUi,
} from "../../helpers/feat-009-studio-publication-workflow";

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("SL-F009-E2E-006 @p1 motivo de rejeição orienta correção e preserva publicação estável", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const identity = createFeat009QaIdentity(testInfo, "006_rejected_correction");
  const rejectionReason =
    "A descrição precisa explicar com clareza o isolamento acústico disponível no espaço.";
  const correctedName = "Estúdio QA corrigido após revisão editorial";
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "906", { complete: true });
    if (identity.userId === undefined)
      throw new Error("A identidade FEAT-009 não publicou escopo.");
    const publishedRevisionId = await seedFeat009PublishedStudio(identity.userId, editor.studioId);
    const seeded = await seedFeat009RejectedCorrection(
      identity.userId,
      editor.studioId,
      rejectionReason,
    );
    await openFeat009Publication(page, editor.studioId);

    await expect(
      page.getByRole("heading", { level: 2, name: "Publicado com alterações em revisão" }),
    ).toBeVisible();
    const rejectionAlert = page.getByRole("alert").filter({ hasText: "Revisão rejeitada" });
    await expect(rejectionAlert).toBeVisible();
    await expect(rejectionAlert).toContainText(rejectionReason);
    const currentPreview = page.getByRole("article").filter({ hasText: "Versão atual do editor" });
    const publicPreview = page.getByRole("article").filter({ hasText: "Versão pública estável" });
    await expect(currentPreview).toContainText("Rascunho editável");
    await expect(publicPreview).toContainText("Aprovada");
    await expect(publicPreview.getByRole("heading", { level: 3 })).toHaveText(editor.revision.name);
    await expect(page.getByRole("button", { name: /Aprovar|Rejeitar/iu })).toHaveCount(0);

    const beforeCorrection = await readFeat009PublicationEvidence(editor.studioId);
    expect(beforeCorrection).toMatchObject({
      draft_revision_id: seeded.correction_revision_id,
      published_revision_id: publishedRevisionId,
      status: "changes_pending",
    });
    expect(
      beforeCorrection.revisions.find((revision) => revision.id === seeded.rejected_revision_id),
    ).toMatchObject({ status: "rejected" });
    expect(
      beforeCorrection.reviews.filter(
        (review) => review.revision_id === seeded.rejected_revision_id,
      ),
    ).toEqual([
      {
        event_type: "submitted",
        rejection_reason: null,
        revision_id: seeded.rejected_revision_id,
      },
      {
        event_type: "rejected",
        rejection_reason: rejectionReason,
        revision_id: seeded.rejected_revision_id,
      },
    ]);

    const corrected = await createFeat009CandidateThroughUi(page, editor.studioId, correctedName);
    expect(corrected.revision.id).toBe(seeded.correction_revision_id);
    await openFeat009Publication(page, editor.studioId);
    await expect(page.getByRole("article", { name: correctedName })).toBeVisible();
    await expect(publicPreview.getByRole("heading", { level: 3 })).toHaveText(editor.revision.name);

    const submission = await submitFeat009RevisionThroughUi(page);
    expect(submission.response.status()).toBe(200);
    expect(submission.publication).toMatchObject({
      currentRevision: {
        id: seeded.correction_revision_id,
        name: correctedName,
        status: "pending",
      },
      publishedRevision: {
        id: publishedRevisionId,
        name: editor.revision.name,
        status: "approved",
      },
      studioStatus: "changes_pending",
    });
    await expect(page.getByText("Revisão enviada", { exact: true })).toBeVisible();
    await expect(page.getByText("Revisão pendente e imutável", { exact: true })).toBeVisible();
    await expect(publicPreview.getByRole("heading", { level: 3 })).toHaveText(editor.revision.name);

    const afterSubmission = await readFeat009PublicationEvidence(editor.studioId);
    expect(afterSubmission).toMatchObject({
      draft_revision_id: seeded.correction_revision_id,
      published_revision_id: publishedRevisionId,
      status: "changes_pending",
    });
    expect(
      afterSubmission.revisions.find((revision) => revision.id === seeded.correction_revision_id),
    ).toMatchObject({ name: correctedName, status: "pending" });
    expect(
      afterSubmission.outbox.filter((item) => item.revision_id === seeded.correction_revision_id),
    ).toHaveLength(1);
    expect(
      afterSubmission.reviews.filter(
        (review) => review.revision_id === seeded.correction_revision_id,
      ),
    ).toEqual([
      {
        event_type: "submitted",
        rejection_reason: null,
        revision_id: seeded.correction_revision_id,
      },
    ]);
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-015 @p1 descarte após primeira rejeição remove o estúdio ainda inédito", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const identity = createFeat009QaIdentity(testInfo, "015_rejected_unpublished_discard");
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "915", { complete: true });
    if (identity.userId === undefined) {
      throw new Error("A identidade FEAT-009 não publicou escopo.");
    }

    const submission = await submitFeat009RevisionThroughUi(page);
    expect(submission.response.status()).toBe(200);
    expect(submission.publication?.studioStatus).toBe("pending_review");
    await seedFeat009RejectedUnpublishedCorrection(
      identity.userId,
      editor.studioId,
      "A primeira submissão precisa de correções antes da publicação.",
    );

    const navigation = await page.goto(`/dono/estudios/${editor.studioId}/dados`);
    expect(navigation?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Dados do estúdio" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Descartar rascunho" })).toBeEnabled();

    await page.getByRole("button", { name: "Descartar rascunho" }).click();
    const confirmation = page.getByRole("group", { name: "Confirmar descarte" });
    await expect(confirmation).toBeVisible();
    const discardResponsePromise = page.waitForResponse((response) => {
      const command = studioCommandSchema.safeParse(response.request().postDataJSON());
      return command.success && command.data.action === "studio.draft.discard";
    });
    await confirmation.getByRole("button", { name: "Confirmar descarte" }).click();
    const discardResponse = await discardResponsePromise;
    expect(discardResponse.status()).toBe(200);
    expect(
      apiSuccessSchema(studioCommandResultSchema(studioDraftDiscardResultSchema)).parse(
        await discardResponse.json(),
      ).data.result,
    ).toMatchObject({ studioDeleted: true, studioId: editor.studioId });

    await expect(page.getByText("Rascunho descartado", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Abrir novo formulário" })).toBeVisible();
    expect((await page.request.get(`/api/owner/studios/${editor.studioId}`)).status()).toBe(404);
    expect(
      (await page.request.get(`/api/owner/studios/${editor.studioId}/publication`)).status(),
    ).toBe(404);
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-009 @p1 conflito ao pausar relê o estado, move foco e não repete a transição", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const identity = createFeat009QaIdentity(testInfo, "009_pause_conflict");
  const commandPosts: unknown[] = [];
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "909", { complete: true });
    if (identity.userId === undefined)
      throw new Error("A identidade FEAT-009 não publicou escopo.");
    const publishedRevisionId = await seedFeat009PublishedStudio(identity.userId, editor.studioId);
    await openFeat009Publication(page, editor.studioId);
    const beforeConflict = await readFeat009PublicationEvidence(editor.studioId);

    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        commandPosts.push(request.postDataJSON());
      }
    });
    await page.route("**/api/commands", async (route) => {
      const command = studioCommandSchema.safeParse(route.request().postDataJSON());
      if (!command.success || command.data.action !== "studio.pause") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        body: JSON.stringify({
          error: {
            code: "CONFLICT",
            message: "A publicação mudou antes da pausa. Releia o estado autoritativo.",
            requestId: "90000000-0000-4000-8000-000000000009",
          },
        }),
        contentType: "application/json",
        status: 409,
      });
    });

    await page.getByRole("button", { name: "Pausar estúdio" }).click();
    const confirmation = page.getByRole("heading", {
      level: 3,
      name: "Confirmar pausa do estúdio",
    });
    await expect(confirmation).toBeFocused();
    await page.getByRole("button", { name: "Confirmar pausa" }).click();

    const recovery = page.getByLabel("Recuperação segura da publicação", { exact: true });
    const acceptAuthoritativeState = recovery.getByRole("button", {
      name: "Usar estado autoritativo",
    });
    await expect(acceptAuthoritativeState).toBeVisible();
    await expect(recovery).toBeFocused();
    expect(commandPosts).toHaveLength(1);
    expect(studioCommandSchema.parse(commandPosts[0])).toMatchObject({
      action: "studio.pause",
      payload: {
        expectedPublicationVersion: beforeConflict.publication_version,
        studioId: editor.studioId,
      },
    });
    expect(await readFeat009PublicationEvidence(editor.studioId)).toEqual(beforeConflict);

    await acceptAuthoritativeState.click();
    const announcement = page.getByRole("status").filter({
      hasText:
        "O estado autoritativo foi carregado. Faça uma nova ação somente se ainda for necessária.",
    });
    await expect(announcement).toBeVisible();
    await expect(announcement).toBeFocused();
    await expect(page.getByRole("button", { name: "Pausar estúdio" })).toBeEnabled();
    expect(commandPosts).toHaveLength(1);

    const afterRecovery = await readFeat009PublicationEvidence(editor.studioId);
    expect(afterRecovery).toEqual(beforeConflict);
    expect(afterRecovery).toMatchObject({
      audit_actions: [],
      draft_revision_id: null,
      published_revision_id: publishedRevisionId,
      requests: [],
      status: "published",
    });
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-010 @p1 sem JavaScript a publicação privada permanece fail-closed", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const identity = createFeat009QaIdentity(testInfo, "010_no_javascript");
  let noScriptContext: BrowserContext | undefined;
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "910", { complete: true });
    noScriptContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      javaScriptEnabled: false,
      storageState: await page.context().storageState(),
      viewport: page.viewportSize() ?? { height: 900, width: 1440 },
    });
    const noScriptPage = await noScriptContext.newPage();
    const commandPosts: string[] = [];
    noScriptPage.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        commandPosts.push(request.url());
      }
    });

    const navigation = await noScriptPage.goto(`/dono/estudios/${editor.studioId}/publicacao`);
    expect(navigation?.status()).toBe(200);
    const noScriptAlert = noScriptPage
      .getByRole("alert")
      .filter({ hasText: "JavaScript necessário" });
    await expect(noScriptAlert).toHaveCount(1);
    await expect(noScriptAlert).toBeVisible();
    await expect(
      noScriptAlert.getByText(
        "Ative o JavaScript e recarregue a página para gerenciar a publicação do estúdio.",
        { exact: true },
      ),
    ).toBeVisible();
    for (const privateText of [
      editor.revision.name,
      editor.revision.description,
      editor.revision.street,
    ]) {
      await expect(noScriptPage.getByText(privateText, { exact: false })).toHaveCount(0);
    }
    await expect(
      noScriptPage.getByRole("heading", { level: 2, name: "Prévia das revisões" }),
    ).toHaveCount(0);
    await expect(
      noScriptPage.getByRole("heading", { level: 2, name: "Ações do dono" }),
    ).toHaveCount(0);
    await expect(noScriptPage.getByRole("article")).toHaveCount(0);
    await expect(
      noScriptPage.getByRole("button", {
        name: /Confirmar pausa|Enviar revisão completa|Pausar estúdio|Retomar estúdio/u,
      }),
    ).toHaveCount(0);
    expect(commandPosts).toEqual([]);
  } finally {
    if (noScriptContext !== undefined) {
      for (const contextPage of noScriptContext.pages()) {
        await closeFeat009PageBeforeCleanup(contextPage);
      }
      await noScriptContext.close();
    }
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-012 @p1 projeção divergente no mesmo fence recompõe a rota sem mutar estado", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const identity = createFeat009QaIdentity(testInfo, "012_projection_recompose");
  let commandPosts = 0;
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "912", { complete: true });
    const publicationPath = `/api/owner/studios/${editor.studioId}/publication`;
    const publicationPagePath = `/dono/estudios/${editor.studioId}/publicacao`;
    const authoritativeResponse = await page.request.get(publicationPath);
    expect(authoritativeResponse.status()).toBe(200);
    const authoritativePayload = apiSuccessSchema(studioPublicationSchema).parse(
      await authoritativeResponse.json(),
    );
    const divergentPublication = studioPublicationSchema.parse({
      ...authoritativePayload.data,
      canSubmit: false,
      checklist: authoritativePayload.data.checklist.map((item) =>
        item.key === "media"
          ? {
              ...item,
              complete: false,
              messages: [
                "A reserva temporária da mídia expirou; recarregue o estado autoritativo.",
              ],
            }
          : item,
      ),
    });
    let divergentReads = 0;
    let reloads = 0;

    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        commandPosts += 1;
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && new URL(frame.url()).pathname === publicationPagePath) {
        reloads += 1;
      }
    });
    await page.route("**/api/owner/studios/*/publication", async (route) => {
      const request = route.request();
      if (
        request.method() !== "GET" ||
        new URL(request.url()).pathname !== publicationPath ||
        divergentReads > 0
      ) {
        await route.fallback();
        return;
      }
      divergentReads += 1;
      await route.fulfill({
        body: JSON.stringify({ ...authoritativePayload, data: divergentPublication }),
        contentType: "application/json",
        status: 200,
      });
    });

    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(
      page.getByRole("heading", { level: 1, name: "Publicação do estúdio" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Checklist do anúncio" }),
    ).toBeVisible();
    expect(divergentReads).toBe(1);
    await expect.poll(() => reloads).toBeGreaterThanOrEqual(1);
    expect(commandPosts).toBe(0);
    expect(await readFeat009PublicationEvidence(editor.studioId)).toMatchObject({
      audit_actions: [],
      requests: [],
      status: "draft",
    });
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-013 @p1 taxonomia arquivada após a leitura falha fechada e relê o checklist", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const identity = createFeat009QaIdentity(testInfo, "013_archived_taxonomy");
  let commandPosts = 0;
  let reloads = 0;
  try {
    const { editor, isolatedTagId } = await provisionFeat009Studio(page, identity, "913", {
      complete: true,
      isolatedTag: true,
    });
    if (isolatedTagId === undefined) {
      throw new Error("O cenário FEAT-009 não recebeu a tag isolada esperada.");
    }
    const submitButton = page.getByRole("button", { name: "Enviar revisão completa" });
    const publicationPath = `/dono/estudios/${editor.studioId}/publicacao`;
    await expect(submitButton).toBeEnabled();
    const beforeArchive = await readFeat009PublicationEvidence(editor.studioId);
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        commandPosts += 1;
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && new URL(frame.url()).pathname === publicationPath) {
        reloads += 1;
      }
    });

    await archiveFeat009Tag(isolatedTagId);
    const submission = await submitFeat009RevisionThroughUi(page);
    expect(submission.response.status()).toBe(422);
    expect(submission.payload).toMatchObject({
      error: { code: "STUDIO_SUBMISSION_INCOMPLETE" },
    });
    expect(commandPosts).toBe(1);
    await expect(
      page.getByRole("heading", { level: 1, name: "Publicação do estúdio" }),
    ).toBeVisible();
    await expect(page.getByText("Revise as tags arquivadas antes de enviar.")).toBeVisible();
    await expect(page.getByLabel("Recuperação segura da publicação", { exact: true })).toHaveCount(
      0,
    );
    await expect(submitButton).toHaveCount(0);
    await expect.poll(() => reloads).toBeGreaterThanOrEqual(1);
    expect(commandPosts).toBe(1);
    expect(await readFeat009PublicationEvidence(editor.studioId)).toEqual(beforeArchive);
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-014 @p1 releitura autoritativa encerra resposta ambígua sem novo comando", async ({
  page,
}, testInfo) => {
  test.setTimeout(260_000);
  const identity = createFeat009QaIdentity(testInfo, "014_ambiguous_authoritative_read");
  let responseLost = false;
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "914", { complete: true });
    const commands = observeFeat009Commands(page);
    await page.route("**/api/commands", async (route) => {
      const parsed = studioCommandSchema.safeParse(route.request().postDataJSON());
      if (!responseLost && parsed.success && parsed.data.action === "studio.revision.submit") {
        responseLost = true;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });

    await page.getByRole("button", { name: "Enviar revisão completa" }).click();
    await expect(page.getByText("A resposta não confirmou a ação", { exact: true })).toBeVisible();
    await expect.poll(() => commands.length).toBe(1);

    await page.getByRole("button", { name: "Verificar estado atual" }).click();
    const recovery = page.getByLabel("Recuperação segura da publicação", { exact: true });
    const acceptAuthoritativeState = recovery.getByRole("button", {
      name: "Usar estado autoritativo",
    });
    await expect(acceptAuthoritativeState).toBeVisible();
    await expect(recovery).toBeFocused();
    expect(commands).toHaveLength(1);

    await acceptAuthoritativeState.click();
    await expect(page.getByRole("heading", { level: 2, name: "Em revisão" })).toBeVisible();
    const announcement = page.getByRole("status").filter({
      hasText: "O estado autoritativo foi carregado sem enviar um novo comando.",
    });
    await expect(announcement).toBeVisible();
    await expect(announcement).toBeFocused();
    await expect(recovery).toHaveCount(0);
    expect(commands).toHaveLength(1);

    const evidence = await readFeat009PublicationEvidence(editor.studioId);
    expect(evidence.reviews).toHaveLength(1);
    expect(evidence.outbox).toHaveLength(1);
    expect(evidence.requests).toHaveLength(1);
    expect(evidence.audit_actions).toEqual(["studio.revision_submitted"]);
    expect(evidence.reviews[0]).toMatchObject({ event_type: "submitted" });
    expect(evidence.requests[0]?.idempotency_key).toBe(commands[0]?.idempotencyKey);
    expect(evidence.status).toBe("pending_review");
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-017 @p1 publicação rejeita outra tentativa ou transição sem perder o replay", async ({
  page,
}, testInfo) => {
  test.setTimeout(260_000);
  const identity = createFeat009QaIdentity(testInfo, "017_command_response_identity");
  let mismatchedResponses = 0;
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "917", { complete: true });
    const commands = observeFeat009Commands(page);
    const commandResponseSchema = apiSuccessSchema(
      studioCommandResultSchema(studioPublicationSchema),
    );
    await page.route("**/api/commands", async (route) => {
      const parsed = studioCommandSchema.safeParse(route.request().postDataJSON());
      if (!parsed.success || parsed.data.action !== "studio.revision.submit") {
        await route.fallback();
        return;
      }
      const command = parsed.data;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const payload = commandResponseSchema.parse(await response.json());
      expect(payload.data).toMatchObject({
        action: command.action,
        idempotencyKey: command.idempotencyKey,
        result: { scope: identity.userId, studioId: editor.studioId },
      });
      if (mismatchedResponses < 2) {
        // Keep the committed DTO intact and isolate each wire identity check.
        const wrongIdentity =
          mismatchedResponses === 0 ? { idempotencyKey: randomUUID() } : { action: "studio.pause" };
        mismatchedResponses += 1;
        await route.fulfill({
          response,
          json: commandResponseSchema.parse({
            ...payload,
            data: { ...payload.data, ...wrongIdentity },
          }),
        });
        return;
      }
      await route.fulfill({ response });
    });

    const completed = page.getByRole("status").filter({
      hasText: "A revisão foi enviada uma vez e agora permanece imutável durante a análise.",
    });
    await page.getByRole("button", { name: "Enviar revisão completa" }).click();
    for (const attempt of [1, 2]) {
      await expect(
        page.getByText("A resposta não confirmou a ação", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("O servidor enviou dados de estúdio inesperados.")).toBeVisible();
      expect(mismatchedResponses).toBe(attempt);
      expect(commands).toHaveLength(attempt);
      await expect(completed).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Enviar revisão completa" })).toBeDisabled();
      const retryResponse = page.waitForResponse((response) => {
        if (
          response.request().method() !== "POST" ||
          new URL(response.url()).pathname !== "/api/commands"
        )
          return false;
        const command = studioCommandSchema.safeParse(response.request().postDataJSON());
        return command.success && command.data.action === "studio.revision.submit";
      });
      await page.getByRole("button", { name: "Repetir exatamente a mesma ação" }).click();
      expect((await retryResponse).status()).toBe(200);
    }
    await expect(completed).toBeVisible();
    await expect(completed).toBeFocused();
    await expect(page.getByRole("heading", { level: 2, name: "Em revisão" })).toBeVisible();
    await expect(page.getByText("A resposta não confirmou a ação", { exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(3);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[2]).toEqual(commands[0]);
    const evidence = await readFeat009PublicationEvidence(editor.studioId);
    expect(evidence.reviews).toHaveLength(1);
    expect(evidence.outbox).toHaveLength(1);
    expect(evidence.requests).toHaveLength(1);
    expect(evidence.audit_actions).toEqual(["studio.revision_submitted"]);
    expect(evidence.requests[0]?.idempotency_key).toBe(commands[0]?.idempotencyKey);
    expect(evidence.status).toBe("pending_review");
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-016 @p1 resposta tardia anuncia a publicação mais nova preservada", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const identity = createFeat009QaIdentity(testInfo, "016_late_pause_feedback");
  const publicationReadCaptured = deferredSignal();
  const releasePublicationRead = deferredSignal();
  const publicationReadDelivered = deferredSignal();
  const pauseApplied = deferredSignal();
  const releasePauseResponse = deferredSignal();
  let pausedPublication: StudioPublication | undefined;

  try {
    const { editor } = await provisionFeat009Studio(page, identity, "916", { complete: true });
    if (identity.userId === undefined) {
      throw new Error("A identidade FEAT-009 não publicou escopo.");
    }
    await seedFeat009PublishedStudio(identity.userId, editor.studioId);
    await openFeat009Publication(page, editor.studioId);
    const publicationApiPath = `/api/owner/studios/${editor.studioId}/publication`;

    let publicationReadIntercepted = false;
    await page.route("**/api/owner/studios/*/publication", async (route) => {
      const request = route.request();
      if (
        publicationReadIntercepted ||
        request.method() !== "GET" ||
        new URL(request.url()).pathname !== publicationApiPath
      ) {
        await route.fallback();
        return;
      }
      publicationReadIntercepted = true;
      publicationReadCaptured.resolve();
      await releasePublicationRead.promise;
      const response = await route.fetch();
      await route.fulfill({ body: await response.body(), response });
      publicationReadDelivered.resolve();
    });

    await page.route("**/api/commands", async (route) => {
      const command = studioCommandSchema.safeParse(route.request().postDataJSON());
      if (!command.success || command.data.action !== "studio.pause") {
        await route.fallback();
        return;
      }
      try {
        const response = await route.fetch();
        const body = await response.body();
        if (response.status() !== 200) {
          throw new Error(`A pausa concorrente retornou HTTP ${response.status()}.`);
        }
        const payload: unknown = JSON.parse(body.toString("utf8"));
        pausedPublication = apiSuccessSchema(
          studioCommandResultSchema(studioPublicationSchema),
        ).parse(payload).data.result;
        pauseApplied.resolve();
        await releasePauseResponse.promise;
        await route.fulfill({ body, response });
      } finally {
        pauseApplied.resolve();
      }
    });

    await page.getByRole("button", { name: "Pausar estúdio" }).click();
    const confirmation = page.getByRole("heading", {
      level: 3,
      name: "Confirmar pausa do estúdio",
    });
    await expect(confirmation).toBeFocused();
    await page.getByRole("button", { name: "Confirmar pausa" }).evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("A confirmação de pausa não apontou para um botão HTML.");
      }
      window.dispatchEvent(new Event("visibilitychange"));
      button.click();
    });

    await Promise.all([publicationReadCaptured.promise, pauseApplied.promise]);
    if (pausedPublication === undefined) {
      throw new Error("A pausa concorrente não retornou sua projeção autoritativa.");
    }
    const resumeResponse = await page.request.post("/api/commands", {
      data: {
        action: "studio.resume",
        expectedScope: identity.userId,
        idempotencyKey: randomUUID(),
        payload: {
          expectedPublicationVersion: pausedPublication.publicationVersion,
          studioId: editor.studioId,
        },
      },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(resumeResponse.status()).toBe(200);
    const resumedPublication = apiSuccessSchema(
      studioCommandResultSchema(studioPublicationSchema),
    ).parse(await resumeResponse.json()).data.result;
    expect(resumedPublication.studioStatus).toBe("published");

    releasePublicationRead.resolve();
    await publicationReadDelivered.promise;
    await expect(
      page.getByText(`Versão ${resumedPublication.publicationVersion}`, { exact: true }),
    ).toBeVisible();
    releasePauseResponse.resolve();

    const retainedStateAnnouncement = page.getByRole("status").filter({
      hasText: "O estado mais recente da publicação foi preservado: Publicado.",
    });
    await expect(retainedStateAnnouncement).toBeVisible();
    await expect(retainedStateAnnouncement).toBeFocused();
    await expect(
      page.getByText(
        "O estúdio foi pausado e o estado editorial foi registrado. Esta ação não altera reservas existentes.",
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Publicado" })).toBeVisible();

    expect(await readFeat009PublicationEvidence(editor.studioId)).toMatchObject({
      audit_actions: ["studio.paused", "studio.resumed"],
      publication_version: resumedPublication.publicationVersion,
      status: "published",
    });
  } finally {
    releasePublicationRead.resolve();
    releasePauseResponse.resolve();
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});
