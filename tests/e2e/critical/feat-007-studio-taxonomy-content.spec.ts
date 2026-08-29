import { randomUUID } from "node:crypto";

import { expect, test, type BrowserContext } from "@playwright/test";

import { switchFeat003SessionWithoutNavigation } from "../../helpers/feat-003-profile-account";
import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
} from "../../helpers/feat-006-studio-core-revision";
import {
  activateFeat007Tag,
  cleanupFeat007QaTag,
  createFeat007QaIdentity,
  createFeat007QaTag,
  deactivateFeat007Tag,
  expectFeat007EditorVersion,
  feat007DefaultContent,
  provisionFeat007Studio,
  readFeat007Evidence,
  saveFeat007ContentThroughUi,
  saveFeat007TaxonomyThroughUi,
} from "../../helpers/feat-007-studio-taxonomy-content";

function createDeferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal de fronteira do conteúdo comercial não foi inicializado.");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("SL-F007-E2E-001 @p0 salva taxonomias, regras e FAQ na revisão privada", async ({
  page,
}, testInfo) => {
  test.setTimeout(170_000);
  const identity = createFeat007QaIdentity(testInfo, "001_content");
  try {
    const editor = await provisionFeat007Studio(page, identity, "701");
    await page.getByRole("checkbox", { name: feat007DefaultContent.tagName }).check();
    await page.getByRole("checkbox", { name: feat007DefaultContent.amenityName }).check();

    const taxonomy = await saveFeat007TaxonomyThroughUi(page);
    expect(taxonomy.response.status()).toBe(200);
    expectFeat007EditorVersion(taxonomy.editor, 2);
    await expect(
      page.getByText("Tags e comodidades foram salvas na revisão em rascunho."),
    ).toBeVisible();

    await page
      .getByRole("textbox", { name: "Regras de uso" })
      .fill(feat007DefaultContent.usageRules);
    await page.getByRole("button", { name: "Adicionar pergunta" }).click();
    await page.getByRole("textbox", { name: "Pergunta 1" }).fill(feat007DefaultContent.faqQuestion);
    await page.getByRole("textbox", { name: "Resposta 1" }).fill(feat007DefaultContent.faqAnswer);

    const content = await saveFeat007ContentThroughUi(page);
    expect(content.response.status()).toBe(200);
    expectFeat007EditorVersion(content.editor, 3);
    await expect(
      page.getByText("Regras, FAQ e vídeo foram salvos na revisão em rascunho."),
    ).toBeVisible();

    const evidence = await readFeat007Evidence(editor.revision.id);
    expect(evidence).toMatchObject({
      amenity_names: [feat007DefaultContent.amenityName],
      faqs: [
        {
          answer: feat007DefaultContent.faqAnswer,
          position: 1,
          question: feat007DefaultContent.faqQuestion,
        },
      ],
      revision_version: 3,
      tag_names: [feat007DefaultContent.tagName],
      usage_rules: feat007DefaultContent.usageRules,
      youtube_video_id: null,
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("checkbox", { name: feat007DefaultContent.tagName })).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: feat007DefaultContent.amenityName }),
    ).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Pergunta 1" })).toHaveValue(
      feat007DefaultContent.faqQuestion,
    );
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F007-E2E-003 @p0 rejeita taxonomia desativada ou externa e recupera a UI", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat007QaIdentity(testInfo, "003_inactive");
  const qaTag = await createFeat007QaTag();
  try {
    const editor = await provisionFeat007Studio(page, identity, "703");
    await page.getByRole("checkbox", { name: feat007DefaultContent.tagName }).check();
    await page.getByRole("checkbox", { name: qaTag.name }).check();
    await deactivateFeat007Tag(qaTag.id);
    await page.route("**/api/studio-taxonomies", (route) => route.abort("failed"), { times: 1 });

    const inactive = await saveFeat007TaxonomyThroughUi(page);
    expect(inactive.response.status()).toBe(409);
    expect(inactive.payload).toMatchObject({ error: { code: "STUDIO_TAXONOMY_UNAVAILABLE" } });
    await expect(
      page.getByRole("alert").filter({ hasText: "Não foi possível carregar a comparação" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Tentar carregar a comparação novamente" }).click();
    await expect(
      page.getByRole("heading", { level: 3, name: "Compare as taxonomias antes de continuar" }),
    ).toBeVisible();
    const archivedTag = page.getByRole("checkbox", { name: `${qaTag.name} — arquivada` });
    await expect(archivedTag).toBeChecked();
    await expect(page.getByRole("checkbox", { name: feat007DefaultContent.tagName })).toBeChecked();
    await page.getByRole("button", { name: "Continuar com minhas seleções" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Remova as opções arquivadas" }),
    ).toBeVisible();
    await archivedTag.click();
    await expect(archivedTag).toHaveCount(0);
    const recovered = await saveFeat007TaxonomyThroughUi(page);
    expect(recovered.response.status()).toBe(200);
    expectFeat007EditorVersion(recovered.editor, 2);
    if (recovered.editor === undefined) {
      throw new Error("A recuperação da taxonomia não retornou o editor esperado.");
    }

    const external = await page.request.post("/api/commands", {
      data: {
        action: "studio.revision.updateTaxonomy",
        expectedScope: identity.userId,
        idempotencyKey: randomUUID(),
        payload: {
          amenityIds: [],
          expectedRevisionId: recovered.editor.revision.id,
          expectedRevisionVersion: recovered.editor.revision.version,
          studioId: editor.studioId,
          tagIds: [randomUUID()],
        },
      },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(external.status()).toBe(409);
    await expect(external.json()).resolves.toMatchObject({
      error: { code: "STUDIO_TAXONOMY_UNAVAILABLE" },
    });

    await activateFeat007Tag(qaTag.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("checkbox", { name: qaTag.name }).check();
    const referenced = await saveFeat007TaxonomyThroughUi(page);
    expect(referenced.response.status()).toBe(200);
    expectFeat007EditorVersion(referenced.editor, 3);

    await deactivateFeat007Tag(qaTag.id);
    await page.reload({ waitUntil: "domcontentloaded" });
    const archivedReference = page.getByRole("checkbox", {
      name: `${qaTag.name} — arquivada`,
    });
    await expect(archivedReference).toBeChecked();
    await expect(
      page.getByRole("alert").filter({ hasText: "Remova as opções arquivadas" }),
    ).toBeVisible();
    await archivedReference.click();
    await expect(
      page.getByRole("group", { name: "Tags" }).getByText("1 de 20 selecionadas", { exact: true }),
    ).toBeVisible();
    const removedArchive = await saveFeat007TaxonomyThroughUi(page);
    expect(removedArchive.response.status()).toBe(200);
    expectFeat007EditorVersion(removedArchive.editor, 4);

    const evidence = await readFeat007Evidence(editor.revision.id);
    expect(evidence).toMatchObject({
      revision_version: 4,
      tag_names: [feat007DefaultContent.tagName],
    });
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
    await cleanupFeat007QaTag(qaTag.id);
  }
});

test("SL-F007-E2E-005 @p0 preserva texto hostil como plain text sem execução", async ({
  page,
}, testInfo) => {
  test.setTimeout(170_000);
  const identity = createFeat007QaIdentity(testInfo, "005_plain_text");
  const hostile =
    '<img src="x" onerror="document.documentElement.dataset.feat007Xss=\'executed\'">';
  const hostileQuestion = `<script>document.documentElement.dataset.feat007Xss='executed'</script>`;
  try {
    const editor = await provisionFeat007Studio(page, identity, "705");
    await page.getByRole("textbox", { name: "Regras de uso" }).fill(hostile);
    await page.getByRole("button", { name: "Adicionar pergunta" }).click();
    await page.getByRole("textbox", { name: "Pergunta 1" }).fill(hostileQuestion);
    await page.getByRole("textbox", { name: "Resposta 1" }).fill(hostile);

    const preview = page.getByRole("region", { name: "Prévia segura do texto" });
    await expect(preview.getByText(hostile, { exact: true })).toHaveCount(2);
    await expect(preview.getByText(hostileQuestion, { exact: true })).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.dataset.feat007Xss ?? null),
    ).toBeNull();

    const saved = await saveFeat007ContentThroughUi(page);
    expect(saved.response.status()).toBe(200);
    expectFeat007EditorVersion(saved.editor, 2);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(preview.getByText(hostile, { exact: true })).toHaveCount(2);
    await expect(preview.getByText(hostileQuestion, { exact: true })).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.dataset.feat007Xss ?? null),
    ).toBeNull();
    const evidence = await readFeat007Evidence(editor.revision.id);
    expect(evidence).toMatchObject({
      faqs: [{ answer: hostile, position: 1, question: hostileQuestion }],
      usage_rules: hostile,
    });
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F007-E2E-009 @p0 troca de sessão oculta conteúdo comercial antes da releitura", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(220_000);
  const identityA = createFeat007QaIdentity(testInfo, "008_scope_a");
  const identityB = createFeat007QaIdentity(testInfo, "008_scope_b");
  const editorReadCaptured = createDeferredSignal();
  const releaseEditorRead = createDeferredSignal();
  const privateUsageRules = "Regras ultraprivadas ainda não salvas do escopo A";
  let contextB: BrowserContext | undefined;
  try {
    const editorA = await provisionFeat007Studio(page, identityA, "708");
    await page.getByRole("textbox", { name: "Regras de uso" }).fill(privateUsageRules);

    contextB = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { height: 900, width: 1440 },
    });
    const pageB = await contextB.newPage();
    await provisionFeat007Studio(pageB, identityB, "808");
    await contextB.close();
    contextB = undefined;

    await page.route(
      `**/api/owner/studios/${editorA.studioId}`,
      async (route) => {
        const response = await route.fetch();
        editorReadCaptured.resolve();
        await releaseEditorRead.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );

    const switched = await switchFeat003SessionWithoutNavigation(page, identityB);
    expect(switched.session).toMatchObject({ authenticated: true, userId: identityB.userId });
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await editorReadCaptured.promise;

    await expect(page.getByText("Verificando o editor seguro", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Verificando o conteúdo comercial seguro", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveCount(0);
    await expect(page.getByText(privateUsageRules, { exact: true })).toHaveCount(0);

    const reload = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    releaseEditorRead.resolve();
    await reload;
    await expect(
      page.getByRole("heading", { level: 1, name: "Estúdio não encontrado" }),
    ).toBeVisible();
    await expect(page.getByText(privateUsageRules, { exact: true })).toHaveCount(0);
  } finally {
    releaseEditorRead.resolve();
    await contextB?.close();
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identityB);
    await cleanupFeat006QaIdentity(identityA);
  }
});
