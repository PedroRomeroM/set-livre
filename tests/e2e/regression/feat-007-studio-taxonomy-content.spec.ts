import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  studioDraftDiscardResultSchema,
  studioEditorSchema,
} from "@set-livre/contracts";
import { expect, test } from "@playwright/test";
import { z } from "zod";

import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
  publishFeat006Studio,
  saveFeat006StudioThroughUi,
} from "../../helpers/feat-006-studio-core-revision";
import {
  createFeat007QaIdentity,
  expectFeat007EditorVersion,
  feat007DefaultContent,
  provisionFeat007Studio,
  readFeat007Evidence,
  saveFeat007ContentThroughUi,
  saveFeat007TaxonomyThroughUi,
} from "../../helpers/feat-007-studio-taxonomy-content";
import {
  installFeat008MediaHarness,
  uploadFeat008Photos,
} from "../../helpers/feat-008-studio-media";

test("SL-F007-E2E-002 @p1 reordena FAQ no mobile e preserva o conteúdo", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat007QaIdentity(testInfo, "002_faq_order");
  const first = { answer: "Resposta que deve ficar em segundo.", question: "Pergunta inicial?" };
  const second = { answer: "Resposta que deve ficar em primeiro.", question: "Pergunta final?" };
  try {
    const editor = await provisionFeat007Studio(page, identity, "702");
    await page.getByRole("button", { name: "Adicionar pergunta" }).click();
    await page.getByRole("textbox", { name: "Pergunta 1" }).fill(first.question);
    await page.getByRole("textbox", { name: "Resposta 1" }).fill(first.answer);
    await page.getByRole("button", { name: "Adicionar pergunta" }).click();
    await page.getByRole("textbox", { name: "Pergunta 2" }).fill(second.question);
    await page.getByRole("textbox", { name: "Resposta 2" }).fill(second.answer);
    await page.getByRole("button", { name: "Mover FAQ 2 para cima" }).click();
    await expect(page.getByRole("textbox", { name: "Pergunta 1" })).toHaveValue(second.question);
    await expect(page.getByRole("textbox", { name: "Pergunta 2" })).toHaveValue(first.question);

    const saved = await saveFeat007ContentThroughUi(page);
    expect(saved.response.status()).toBe(200);
    expectFeat007EditorVersion(saved.editor, 2);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("textbox", { name: "Pergunta 1" })).toHaveValue(second.question);
    await expect(page.getByRole("textbox", { name: "Pergunta 2" })).toHaveValue(first.question);

    const evidence = await readFeat007Evidence(editor.revision.id);
    expect(evidence.faqs).toEqual([
      { ...second, position: 1 },
      { ...first, position: 2 },
    ]);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F007-E2E-004 @p1 aceita YouTube permitido e bloqueia host externo antes do POST", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat007QaIdentity(testInfo, "004_youtube");
  let contentPosts = 0;
  try {
    const editor = await provisionFeat007Studio(page, identity, "704");
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands")
        return;
      const body = z.object({ action: z.string() }).safeParse(request.postDataJSON());
      if (body.success && body.data.action === "studio.revision.updateContent") contentPosts += 1;
    });

    const video = page.getByRole("textbox", { name: "Vídeo do YouTube" });
    await video.fill(`https://example.test/watch?v=${feat007DefaultContent.youtubeId}`);
    await page.getByRole("button", { name: "Salvar regras, FAQ e vídeo" }).click();
    await expect(page.getByText("Use um ID ou uma URL HTTPS válida do YouTube.")).toBeVisible();
    expect(contentPosts).toBe(0);
    await expect(page.getByTitle("Prévia do vídeo do estúdio")).toHaveCount(0);

    await video.fill(
      `https://www.youtube.com/watch?v=${feat007DefaultContent.youtubeId}&feature=shared`,
    );
    const frame = page.getByTitle("Prévia do vídeo do estúdio");
    await expect(frame).toHaveAttribute(
      "src",
      `https://www.youtube-nocookie.com/embed/${feat007DefaultContent.youtubeId}`,
    );
    const saved = await saveFeat007ContentThroughUi(page);
    expect(saved.response.status()).toBe(200);
    expect(contentPosts).toBe(1);
    expectFeat007EditorVersion(saved.editor, 2);
    await expect(video).toHaveValue(feat007DefaultContent.youtubeId);

    const evidence = await readFeat007Evidence(editor.revision.id);
    expect(evidence.youtube_video_id).toBe(feat007DefaultContent.youtubeId);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F007-E2E-008 @p1 descarte restaura conteúdo e remove a galeria da draft", async ({
  page,
}, testInfo) => {
  test.setTimeout(220_000);
  const identity = createFeat007QaIdentity(testInfo, "008_discard_reset");
  const publishedRules = "Regras publicadas que devem sobreviver ao descarte do rascunho.";
  const discardedRules = "Conteúdo exclusivo do rascunho que será descartado.";
  const publishedQuestion = "Qual conteúdo está publicado?";
  const discardedQuestion = "Esta pergunta pertence apenas ao rascunho?";
  try {
    await provisionFeat007Studio(page, identity, "708");
    await page.getByRole("checkbox", { name: feat007DefaultContent.tagName }).check();
    const initialTaxonomy = await saveFeat007TaxonomyThroughUi(page);
    expect(initialTaxonomy.response.status()).toBe(200);

    await page.getByRole("textbox", { name: "Regras de uso" }).fill(publishedRules);
    await page.getByRole("button", { name: "Adicionar pergunta" }).click();
    await page.getByRole("textbox", { name: "Pergunta 1" }).fill(publishedQuestion);
    await page.getByRole("textbox", { name: "Resposta 1" }).fill("Conteúdo aprovado.");
    const initialContent = await saveFeat007ContentThroughUi(page);
    expect(initialContent.response.status()).toBe(200);
    if (initialContent.editor === undefined) {
      throw new Error("O conteúdo inicial não retornou o editor publicado esperado.");
    }
    await publishFeat006Studio(initialContent.editor);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Versão publicada aprovada", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Regras de uso" }).fill(discardedRules);
    const coreResponsePromise = page.waitForResponse((response) => {
      if (
        response.request().method() !== "POST" ||
        new URL(response.url()).pathname !== "/api/commands"
      ) {
        return false;
      }
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return body.success && body.data.action === "studio.revision.updateCore";
    });
    await page.getByRole("textbox", { name: "Nome do estúdio" }).fill("Estúdio integrado 708");
    await page.getByRole("button", { name: "Criar rascunho e salvar" }).click();
    expect((await coreResponsePromise).status()).toBe(200);
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveValue(discardedRules);

    await page.getByRole("checkbox", { name: feat007DefaultContent.tagName }).uncheck();
    const draftTaxonomy = await saveFeat007TaxonomyThroughUi(page);
    expect(draftTaxonomy.response.status()).toBe(200);
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveValue(discardedRules);
    await page.getByRole("textbox", { name: "Pergunta 1" }).fill(discardedQuestion);
    const draftContent = await saveFeat007ContentThroughUi(page);
    expect(draftContent.response.status()).toBe(200);
    expect(draftContent.editor?.revision.id).not.toBe(initialContent.editor?.revision.id);
    if (draftContent.editor === undefined) {
      throw new Error("O conteúdo da draft não retornou o editor esperado para a galeria.");
    }

    const mediaHarness = await installFeat008MediaHarness(page, draftContent.editor);
    const mediaNavigation = await page.goto(`/dono/estudios/${draftContent.editor.studioId}/midia`);
    expect(mediaNavigation?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Fotos do estúdio" })).toBeVisible();
    await uploadFeat008Photos(page, ["draft-removida.png"]);
    await expect(page.getByText("1 de 20 fotos", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Dados e conteúdo" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dados do estúdio" })).toBeVisible();

    const discardResponsePromise = page.waitForResponse((response) => {
      if (
        response.request().method() !== "POST" ||
        new URL(response.url()).pathname !== "/api/commands"
      ) {
        return false;
      }
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return body.success && body.data.action === "studio.draft.discard";
    });
    await page.getByRole("button", { name: "Descartar rascunho" }).click();
    await page.getByRole("button", { name: "Confirmar descarte" }).click();
    const discardResponse = await discardResponsePromise;
    expect(discardResponse.status()).toBe(200);
    const discardResult = apiSuccessSchema(studioDraftDiscardResultSchema).parse(
      await discardResponse.json(),
    ).data;
    if (discardResult.studioDeleted) {
      throw new Error("O descarte da segunda revisão não deveria excluir o estúdio publicado.");
    }
    mediaHarness.replaceGalleryBoundary(discardResult.editor);

    await expect(
      page.getByText("O rascunho foi descartado; a versão publicada permaneceu intacta."),
    ).toBeVisible();
    await expect(page.getByText("Versão publicada aprovada", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: feat007DefaultContent.tagName })).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveValue(publishedRules);
    await expect(page.getByRole("textbox", { name: "Pergunta 1" })).toHaveValue(publishedQuestion);

    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Fotos do estúdio" })).toBeVisible();
    await expect(page.getByText("0 de 20 fotos", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Visualizar foto/iu })).toHaveCount(0);
    await page.getByRole("link", { name: "Dados e conteúdo" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dados do estúdio" })).toBeVisible();

    const recreatedTaxonomy = await saveFeat007TaxonomyThroughUi(page);
    expect(recreatedTaxonomy.response.status()).toBe(200);
    const recreatedContent = await saveFeat007ContentThroughUi(page);
    expect(recreatedContent.response.status()).toBe(200);
    if (recreatedContent.editor === undefined) {
      throw new Error("O conteúdo recriado não retornou o editor esperado.");
    }
    const evidence = await readFeat007Evidence(recreatedContent.editor.revision.id);
    expect(evidence).toMatchObject({
      tag_names: [feat007DefaultContent.tagName],
      usage_rules: publishedRules,
    });
    expect(evidence.faqs[0]?.question).toBe(publishedQuestion);
    expect(evidence.usage_rules).not.toBe(discardedRules);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F007-E2E-010 @p1 retry ambíguo congela os dois formulários e preserva o comando", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat007QaIdentity(testInfo, "010_ambiguous");
  const submittedCommands: unknown[] = [];
  const savedRules = "Regras confirmadas apesar da resposta perdida.";
  try {
    await provisionFeat007Studio(page, identity, "710");
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return;
      }
      const body = z.object({ action: z.string() }).safeParse(request.postDataJSON());
      if (body.success && body.data.action === "studio.revision.updateContent") {
        submittedCommands.push(request.postDataJSON());
      }
    });
    await page.route(
      "**/api/commands",
      async (route) => {
        const body = z.object({ action: z.string() }).parse(route.request().postDataJSON());
        expect(body.action).toBe("studio.revision.updateContent");
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("failed");
      },
      { times: 1 },
    );

    await page.getByRole("textbox", { name: "Regras de uso" }).fill(savedRules);
    await page.getByRole("button", { name: "Salvar regras, FAQ e vídeo" }).click();
    await expect(
      page.getByText("Não foi possível conectar. Verifique sua internet e tente novamente."),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar tags e comodidades" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar regras, FAQ e vídeo" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();

    const retryResponse = page.waitForResponse((response) => {
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/commands" &&
        body.success &&
        body.data.action === "studio.revision.updateContent"
      );
    });
    await page.getByRole("button", { name: "Repetir a mesma solicitação com segurança" }).click();
    expect((await retryResponse).status()).toBe(200);
    await expect.poll(() => submittedCommands.length).toBe(2);
    expect(submittedCommands[1]).toEqual(submittedCommands[0]);
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveValue(savedRules);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeEnabled();
    await expect(
      page.getByText("Regras, FAQ e vídeo foram salvos na revisão em rascunho."),
    ).toBeVisible();
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F007-E2E-011 @p1 refetch não ignora conflito nem sobrescreve conteúdo concorrente", async ({
  page,
}, testInfo) => {
  test.setTimeout(190_000);
  const identity = createFeat007QaIdentity(testInfo, "011_refetch_conflict");
  const localRules = "Valores locais preservados até o conflito ficar explícito.";
  const remoteRules = "Conteúdo concorrente salvo por outra sessão.";
  const sharedQuestion = "Qual resposta deve prevalecer?";
  const localAnswer = "A resposta preservada no formulário local.";
  const remoteAnswer = "A resposta salva pela sessão concorrente.";
  const submittedVersions: number[] = [];
  try {
    const editor = await provisionFeat007Studio(page, identity, "711");
    await page.getByRole("textbox", { name: "Regras de uso" }).fill(localRules);
    await page.getByRole("button", { name: "Adicionar pergunta" }).click();
    await page.getByRole("textbox", { name: "Pergunta 1" }).fill(sharedQuestion);
    await page.getByRole("textbox", { name: "Resposta 1" }).fill(localAnswer);
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return;
      }
      const command = z
        .object({
          action: z.literal("studio.revision.updateContent"),
          payload: z.object({ expectedRevisionVersion: z.number().int().positive() }),
        })
        .safeParse(request.postDataJSON());
      if (command.success) submittedVersions.push(command.data.payload.expectedRevisionVersion);
    });

    const concurrentResponse = await page.request.post("/api/commands", {
      data: {
        action: "studio.revision.updateContent",
        expectedScope: identity.userId,
        idempotencyKey: randomUUID(),
        payload: {
          expectedRevisionId: editor.revision.id,
          expectedRevisionVersion: editor.revision.version,
          faqs: [{ answer: remoteAnswer, question: sharedQuestion }],
          studioId: editor.studioId,
          usageRules: remoteRules,
          youtubeVideoId: null,
        },
      },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(concurrentResponse.status()).toBe(200);
    const concurrentEditor = apiSuccessSchema(studioEditorSchema).parse(
      await concurrentResponse.json(),
    ).data;
    expectFeat007EditorVersion(concurrentEditor, 2);

    const backgroundRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/owner/studios/${editor.studioId}` &&
        response.status() === 200,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await backgroundRead;
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveValue(localRules);

    await page.getByRole("textbox", { name: "Nome do estúdio" }).fill("Nome local ainda não salvo");
    const coreConflict = page.waitForResponse((response) => {
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return body.success && body.data.action === "studio.revision.updateCore";
    });
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    expect((await coreConflict).status()).toBe(409);
    await expect(
      page.getByRole("heading", { level: 2, name: "Compare antes de continuar" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continuar com minhas alterações" }).click();

    await page.getByRole("button", { name: "Descartar rascunho" }).click();
    const discardConflict = page.waitForResponse((response) => {
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return body.success && body.data.action === "studio.draft.discard";
    });
    await page.getByRole("button", { name: "Confirmar descarte" }).click();
    expect((await discardConflict).status()).toBe(409);
    await expect(page.getByRole("group", { name: "Confirmar descarte" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveValue(localRules);
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Revise o rascunho atual antes de descartar",
      }),
    ).toBeVisible();
    await expect(page.getByText(/versão de edição 1 para 2/iu)).toBeVisible();
    await expect(page.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();

    await page.getByRole("button", { name: "Recarregar rascunho atual" }).click();
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Revise o rascunho atual antes de descartar",
      }),
    ).toHaveCount(0);
    await expect(page.getByText("Versão de edição 2", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Nome do estúdio" }).fill("Nome local ainda não salvo");
    await page.getByRole("textbox", { name: "Regras de uso" }).fill(localRules);
    await page.getByRole("textbox", { name: "Resposta 1" }).fill(localAnswer);

    const savedCore = await saveFeat006StudioThroughUi(page);
    expect(savedCore.response.status()).toBe(200);
    expect(savedCore.editor?.revision.version).toBe(3);
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveValue(localRules);
    await expect(page.getByRole("textbox", { name: "Resposta 1" })).toHaveValue(localAnswer);

    const latestConcurrentResponse = await page.request.post("/api/commands", {
      data: {
        action: "studio.revision.updateContent",
        expectedScope: identity.userId,
        idempotencyKey: randomUUID(),
        payload: {
          expectedRevisionId: editor.revision.id,
          expectedRevisionVersion: 3,
          faqs: [{ answer: remoteAnswer, question: sharedQuestion }],
          studioId: editor.studioId,
          usageRules: remoteRules,
          youtubeVideoId: null,
        },
      },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(latestConcurrentResponse.status()).toBe(200);
    expectFeat007EditorVersion(
      apiSuccessSchema(studioEditorSchema).parse(await latestConcurrentResponse.json()).data,
      4,
    );

    await page.route(`**/api/owner/studios/${editor.studioId}`, (route) => route.abort("failed"), {
      times: 1,
    });
    const conflicted = await saveFeat007ContentThroughUi(page);
    expect(conflicted.response.status()).toBe(409);
    await expect(
      page.getByRole("alert").filter({ hasText: "Não foi possível carregar a comparação" }),
    ).toBeVisible();
    expect(submittedVersions).toEqual([3]);

    await page.getByRole("button", { name: "Tentar carregar a comparação novamente" }).click();
    await expect(
      page.getByRole("heading", { level: 3, name: "Compare o conteúdo antes de continuar" }),
    ).toBeVisible();
    const comparison = page.getByRole("table", { name: "Comparação de conteúdo" });
    await expect(comparison.getByRole("cell", { exact: true, name: localRules })).toBeVisible();
    await expect(comparison.getByRole("cell", { exact: true, name: remoteRules })).toBeVisible();
    await expect(comparison.getByText(localAnswer, { exact: false })).toBeVisible();
    await expect(comparison.getByText(remoteAnswer, { exact: false })).toBeVisible();
    if ((page.viewportSize()?.width ?? 0) <= 576) {
      await expect(
        comparison.locator('[aria-hidden="true"]', { hasText: "Sua versão" }).first(),
      ).toBeVisible();
      await expect(
        comparison.locator('[aria-hidden="true"]', { hasText: "Versão salva" }).first(),
      ).toBeVisible();
    }
    await page.getByRole("button", { name: "Continuar com meu conteúdo" }).click();

    const rebased = await saveFeat007ContentThroughUi(page);
    expect(rebased.response.status()).toBe(200);
    expectFeat007EditorVersion(rebased.editor, 5);
    expect(submittedVersions).toEqual([3, 4]);
    const evidence = await readFeat007Evidence(editor.revision.id);
    expect(evidence.usage_rules).toBe(localRules);
    expect(evidence.faqs).toEqual([
      expect.objectContaining({ answer: localAnswer, question: sharedQuestion }),
    ]);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});
