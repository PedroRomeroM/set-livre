import { studioCommandSchema } from "@set-livre/contracts";
import { expect, test } from "@playwright/test";

import {
  cleanupFeat009QaIdentity,
  closeFeat009PageBeforeCleanup,
  createFeat009CandidateThroughUi,
  createFeat009QaIdentity,
  observeFeat009Commands,
  openFeat009Publication,
  pauseFeat009StudioThroughUi,
  provisionFeat009Studio,
  readFeat009PublicationEvidence,
  resumeFeat009StudioThroughUi,
  seedFeat009PublishedStudio,
  submitFeat009RevisionThroughUi,
} from "../../helpers/feat-009-studio-publication-workflow";

test("SL-F009-E2E-001 @p0 envio completo ocorre uma vez, vira pendente e bloqueia edição", async ({
  page,
}, testInfo) => {
  test.setTimeout(260_000);
  const identity = createFeat009QaIdentity(testInfo, "001_submit_once");
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "901", { complete: true });
    const before = await readFeat009PublicationEvidence(editor.studioId);
    expect(before).toMatchObject({
      draft_revision_id: editor.revision.id,
      outbox: [],
      published_revision_id: null,
      requests: [],
      reviews: [],
      status: "draft",
    });

    const submitted = await submitFeat009RevisionThroughUi(page);
    expect(submitted.response.status()).toBe(200);
    expect(submitted.publication).toMatchObject({
      canSubmit: false,
      currentRevision: { id: before.draft_revision_id, status: "pending" },
      publishedRevision: null,
      studioStatus: "pending_review",
    });
    await expect(page.getByRole("heading", { level: 2, name: "Em revisão" })).toBeVisible();
    await expect(page.getByText("Revisão pendente e imutável", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar revisão completa" })).toHaveCount(0);

    const after = await readFeat009PublicationEvidence(editor.studioId);
    expect(after.publication_version).toBe(before.publication_version + 1);
    expect(after).toMatchObject({
      audit_actions: ["studio.revision_submitted"],
      draft_revision_id: before.draft_revision_id,
      published_revision_id: null,
      status: "pending_review",
    });
    expect(
      after.revisions.find((revision) => revision.id === before.draft_revision_id),
    ).toMatchObject({ status: "pending", version: before.revisions[0]!.version + 1 });
    expect(after.reviews).toEqual([
      {
        event_type: "submitted",
        rejection_reason: null,
        revision_id: before.draft_revision_id,
      },
    ]);
    expect(after.outbox).toEqual([
      {
        deduplication_key: `studio.review.submitted:${before.draft_revision_id}`,
        revision_id: before.draft_revision_id,
        status: "pending",
        template_key: "studio.review.submitted",
      },
    ]);
    expect(after.requests).toEqual([
      expect.objectContaining({
        action: "studio.revision.submit",
        idempotency_key: submitted.command.idempotencyKey,
        resulting_revision_id: before.draft_revision_id,
      }),
    ]);

    await page.getByRole("link", { name: "Dados e conteúdo" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dados do estúdio" })).toBeVisible();
    await expect(
      page.getByText("Esta revisão não pode ser editada", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Descartar rascunho" })).toHaveCount(0);

    await page.getByRole("link", { name: "Fotos" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Fotos do estúdio" })).toBeVisible();
    await expect(page.getByText("Revisão pendente e imutável", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fotos enviadas para análise" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Mover foto|Definir foto|Excluir foto/u }),
    ).toHaveCount(0);
    const submittedCover = page.getByRole("button", {
      name: "Visualizar foto 1, capa enviada para análise",
    });
    await expect(submittedCover).toBeEnabled();
    await submittedCover.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Fechar visualização" }).click();
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-002 @p0 incompleto aponta seções sem POST, transição, evento ou outbox", async ({
  page,
}, testInfo) => {
  test.setTimeout(220_000);
  const identity = createFeat009QaIdentity(testInfo, "002_incomplete");
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "902", { complete: false });
    const commands = observeFeat009Commands(page);
    const mediaItem = page.getByRole("listitem").filter({ hasText: "Fotos" });
    await expect(mediaItem.getByText("Precisa de atenção", { exact: true })).toBeVisible();
    await expect(mediaItem.getByText("Adicione ao menos uma foto.", { exact: true })).toBeVisible();
    await expect(mediaItem.getByText("Escolha uma foto de capa.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar revisão completa" })).toHaveCount(0);

    const evidence = await readFeat009PublicationEvidence(editor.studioId);
    expect(evidence).toMatchObject({
      audit_actions: [],
      outbox: [],
      requests: [],
      reviews: [],
      status: "draft",
    });
    expect(evidence.revisions).toEqual([
      expect.objectContaining({ id: editor.revision.id, status: "draft" }),
    ]);
    expect(commands).toEqual([]);

    await mediaItem.getByRole("link", { name: "Corrigir seção" }).click();
    await expect(page).toHaveURL(new RegExp(`/dono/estudios/${editor.studioId}/midia$`, "u"));
    await expect(page.getByRole("heading", { level: 1, name: "Fotos do estúdio" })).toBeVisible();
    expect(commands).toEqual([]);
    expect(await readFeat009PublicationEvidence(editor.studioId)).toMatchObject({
      outbox: [],
      requests: [],
      reviews: [],
      status: "draft",
    });

    await page.getByRole("link", { name: "Publicação" }).click();
    await expect(page).toHaveURL(new RegExp(`/dono/estudios/${editor.studioId}/publicacao$`, "u"));
    await expect(page.getByRole("heading", { level: 2, name: "Rascunho" })).toBeVisible();
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-003 @p0 candidata publicada vira changes_pending sem trocar a versão pública", async ({
  page,
}, testInfo) => {
  test.setTimeout(280_000);
  const identity = createFeat009QaIdentity(testInfo, "003_stable_publication");
  const candidateName = "Estúdio QA com alteração editorial pendente";
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "903", { complete: true });
    if (identity.userId === undefined)
      throw new Error("A identidade FEAT-009 não publicou escopo.");
    const publishedRevisionId = await seedFeat009PublishedStudio(identity.userId, editor.studioId);
    await openFeat009Publication(page, editor.studioId);
    await expect(page.getByRole("heading", { level: 2, name: "Publicado" })).toBeVisible();
    await expect(page.getByRole("article", { name: editor.revision.name })).toHaveCount(2);

    const candidate = await createFeat009CandidateThroughUi(page, editor.studioId, candidateName);
    await openFeat009Publication(page, editor.studioId);
    await expect(
      page.getByRole("heading", { level: 2, name: "Publicado com alterações em revisão" }),
    ).toBeVisible();
    await expect(page.getByRole("article", { name: candidateName })).toBeVisible();
    await expect(page.getByRole("article", { name: editor.revision.name })).toBeVisible();

    const beforeSubmit = await readFeat009PublicationEvidence(editor.studioId);
    expect(beforeSubmit).toMatchObject({
      draft_revision_id: candidate.revision.id,
      published_revision_id: publishedRevisionId,
      status: "changes_pending",
    });
    const submitted = await submitFeat009RevisionThroughUi(page);
    expect(submitted.response.status()).toBe(200);
    expect(submitted.publication).toMatchObject({
      currentRevision: { id: candidate.revision.id, status: "pending" },
      publishedRevision: { id: publishedRevisionId, status: "approved" },
      studioStatus: "changes_pending",
    });

    const afterSubmit = await readFeat009PublicationEvidence(editor.studioId);
    expect(afterSubmit).toMatchObject({
      draft_revision_id: candidate.revision.id,
      published_revision_id: publishedRevisionId,
      status: "changes_pending",
    });
    expect(
      afterSubmit.revisions.find((revision) => revision.id === publishedRevisionId),
    ).toMatchObject({ name: editor.revision.name, status: "approved" });
    expect(
      afterSubmit.revisions.find((revision) => revision.id === candidate.revision.id),
    ).toMatchObject({ name: candidateName, status: "pending" });
    expect(
      afterSubmit.reviews.filter((review) => review.revision_id === candidate.revision.id),
    ).toEqual([
      {
        event_type: "submitted",
        rejection_reason: null,
        revision_id: candidate.revision.id,
      },
    ]);
    expect(
      afterSubmit.outbox.filter((item) => item.revision_id === candidate.revision.id),
    ).toHaveLength(1);
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});

test("SL-F009-E2E-004 @p0 resposta ambígua repete chave e payload sem duplicar evento ou outbox", async ({
  page,
}, testInfo) => {
  test.setTimeout(260_000);
  const identity = createFeat009QaIdentity(testInfo, "004_ambiguous_replay");
  let responseLost = false;
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "904", { complete: true });
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
    await expect(page.getByRole("button", { name: "Enviar revisão completa" })).toBeDisabled();
    const retryResponse = page.waitForResponse((response) => {
      const command = studioCommandSchema.safeParse(response.request().postDataJSON());
      return (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/commands" &&
        command.success &&
        command.data.action === "studio.revision.submit"
      );
    });
    await page.getByRole("button", { name: "Repetir exatamente a mesma ação" }).click();
    expect((await retryResponse).status()).toBe(200);
    await expect(page.getByRole("heading", { level: 2, name: "Em revisão" })).toBeVisible();
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).toEqual(commands[0]);

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

test("SL-F009-E2E-005 @p0 pausa e retomada preservam ponteiros e derivam published ou changes_pending", async ({
  page,
}, testInfo) => {
  test.setTimeout(340_000);
  const identity = createFeat009QaIdentity(testInfo, "005_pause_resume");
  const candidateName = "Estúdio QA com candidata durante a pausa";
  try {
    const { editor } = await provisionFeat009Studio(page, identity, "905", { complete: true });
    if (identity.userId === undefined)
      throw new Error("A identidade FEAT-009 não publicou escopo.");
    const publishedRevisionId = await seedFeat009PublishedStudio(identity.userId, editor.studioId);
    await openFeat009Publication(page, editor.studioId);

    const firstPause = await pauseFeat009StudioThroughUi(page);
    expect(firstPause.response.status()).toBe(200);
    expect(firstPause.publication).toMatchObject({
      currentRevision: { id: publishedRevisionId },
      publishedRevision: { id: publishedRevisionId },
      studioStatus: "paused",
    });
    let evidence = await readFeat009PublicationEvidence(editor.studioId);
    expect(evidence).toMatchObject({
      draft_revision_id: null,
      published_revision_id: publishedRevisionId,
      status: "paused",
    });

    const firstResume = await resumeFeat009StudioThroughUi(page);
    expect(firstResume.response.status()).toBe(200);
    expect(firstResume.publication?.studioStatus).toBe("published");
    evidence = await readFeat009PublicationEvidence(editor.studioId);
    expect(evidence).toMatchObject({
      draft_revision_id: null,
      published_revision_id: publishedRevisionId,
      status: "published",
    });

    const candidate = await createFeat009CandidateThroughUi(page, editor.studioId, candidateName);
    await openFeat009Publication(page, editor.studioId);
    const secondPause = await pauseFeat009StudioThroughUi(page);
    expect(secondPause.response.status()).toBe(200);
    expect(secondPause.publication).toMatchObject({
      currentRevision: { id: candidate.revision.id, status: "draft" },
      publishedRevision: { id: publishedRevisionId, status: "approved" },
      studioStatus: "paused",
    });
    const pausedWithDraft = await readFeat009PublicationEvidence(editor.studioId);
    expect(pausedWithDraft).toMatchObject({
      draft_revision_id: candidate.revision.id,
      published_revision_id: publishedRevisionId,
      status: "paused",
    });

    const secondResume = await resumeFeat009StudioThroughUi(page);
    expect(secondResume.response.status()).toBe(200);
    expect(secondResume.publication).toMatchObject({
      canSubmit: true,
      currentRevision: { id: candidate.revision.id, status: "draft" },
      publishedRevision: { id: publishedRevisionId, status: "approved" },
      studioStatus: "published",
    });
    evidence = await readFeat009PublicationEvidence(editor.studioId);
    expect(evidence).toMatchObject({
      draft_revision_id: candidate.revision.id,
      published_revision_id: publishedRevisionId,
      status: "published",
    });

    const submission = await submitFeat009RevisionThroughUi(page);
    expect(submission.response.status()).toBe(200);
    expect(submission.publication).toMatchObject({
      currentRevision: { id: candidate.revision.id, status: "pending" },
      publishedRevision: { id: publishedRevisionId },
      studioStatus: "changes_pending",
    });

    const thirdPause = await pauseFeat009StudioThroughUi(page);
    expect(thirdPause.response.status()).toBe(200);
    expect(thirdPause.publication?.studioStatus).toBe("paused");
    const pausedWithPendingCandidate = await readFeat009PublicationEvidence(editor.studioId);
    expect(pausedWithPendingCandidate).toMatchObject({
      draft_revision_id: candidate.revision.id,
      published_revision_id: publishedRevisionId,
      status: "paused",
    });

    const thirdResume = await resumeFeat009StudioThroughUi(page);
    expect(thirdResume.response.status()).toBe(200);
    expect(thirdResume.publication).toMatchObject({
      currentRevision: { id: candidate.revision.id, status: "pending" },
      publishedRevision: { id: publishedRevisionId },
      studioStatus: "changes_pending",
    });
    const resumedWithCandidate = await readFeat009PublicationEvidence(editor.studioId);
    expect(resumedWithCandidate).toMatchObject({
      draft_revision_id: candidate.revision.id,
      published_revision_id: publishedRevisionId,
      status: "changes_pending",
    });
    expect(resumedWithCandidate.audit_actions).toEqual([
      "studio.paused",
      "studio.resumed",
      "studio.paused",
      "studio.resumed",
      "studio.revision_submitted",
      "studio.paused",
      "studio.resumed",
    ]);
    expect(resumedWithCandidate.requests.map((request) => request.action)).toEqual([
      "studio.pause",
      "studio.resume",
      "studio.pause",
      "studio.resume",
      "studio.revision.submit",
      "studio.pause",
      "studio.resume",
    ]);
    expect(resumedWithCandidate.publication_version).toBeGreaterThan(
      pausedWithPendingCandidate.publication_version,
    );
  } finally {
    await closeFeat009PageBeforeCleanup(page);
    await cleanupFeat009QaIdentity(identity);
  }
});
