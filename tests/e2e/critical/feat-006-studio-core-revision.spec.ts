import { expect, test, type BrowserContext } from "@playwright/test";

import { readFeat002IdentitySession } from "../../helpers/feat-002-authentication";
import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
  createFeat006QaIdentity,
  createFeat006StudioThroughUi,
  feat006DefaultCore,
  fillFeat006Core,
  provisionFeat006Owner,
  publishFeat006Studio,
  readFeat006StudioEvidence,
  saveFeat006StudioThroughUi,
} from "../../helpers/feat-006-studio-core-revision";

test("SL-F006-E2E-001 @p0 cria estúdio e primeira revisão draft atomicamente", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat006QaIdentity(testInfo, "001_create");
  try {
    await provisionFeat006Owner(page, identity, "001");
    await expect(page.getByText("Prévia local — não publicada", { exact: true })).toBeVisible();
    await fillFeat006Core(page);
    await expect(
      page.getByRole("heading", { level: 2, name: feat006DefaultCore.name }),
    ).toBeVisible();

    const editor = await createFeat006StudioThroughUi(page);
    expect(editor).toMatchObject({
      hasDraft: true,
      revision: {
        name: feat006DefaultCore.name,
        number: 1,
        status: "draft",
        version: 1,
      },
      scope: identity.userId,
      studioStatus: "draft",
    });
    await expect(page.getByText("Rascunho privado", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(
      feat006DefaultCore.name,
    );

    const evidence = await readFeat006StudioEvidence(editor.studioId);
    expect(evidence).toMatchObject({
      draft_revision_id: editor.revision.id,
      owner_user_id: identity.userId,
      published_revision_id: null,
      revisions: [
        {
          id: editor.revision.id,
          name: feat006DefaultCore.name,
          number: 1,
          status: "draft",
          version: 1,
        },
      ],
      status: "draft",
    });
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-002 @p0 editar publicado cria novo draft e preserva a revisão aprovada", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat006QaIdentity(testInfo, "002_clone");
  const updatedName = "Estúdio Aurora QA — nova revisão";
  let reactBoundaryErrors = 0;
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /flushSync|hydration|removeChild|not a child/iu.test(message.text())
    ) {
      reactBoundaryErrors += 1;
    }
  });
  try {
    await provisionFeat006Owner(page, identity, "002");
    await fillFeat006Core(page);
    const publishedEditor = await createFeat006StudioThroughUi(page);
    await publishFeat006Studio(publishedEditor);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Versão publicada aprovada", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Nome do estúdio" }).fill(updatedName);
    await page.getByRole("textbox", { name: "Número" }).fill("202");
    const result = await saveFeat006StudioThroughUi(page);
    expect(result.response.status()).toBe(200);
    expect(result.editor).toMatchObject({
      hasDraft: true,
      publishedRevisionId: publishedEditor.revision.id,
      revision: { name: updatedName, number: 2, status: "draft", version: 1 },
    });
    await expect(
      page.getByText("Rascunho salvo com a versão canônica mais recente."),
    ).toBeVisible();

    const evidence = await readFeat006StudioEvidence(publishedEditor.studioId);
    expect(evidence.status).toBe("published");
    expect(evidence.published_revision_id).toBe(publishedEditor.revision.id);
    expect(evidence.draft_revision_id).toBe(result.editor?.revision.id);
    expect(evidence.revisions).toEqual([
      expect.objectContaining({
        id: publishedEditor.revision.id,
        name: feat006DefaultCore.name,
        number: 1,
        status: "approved",
        version: 2,
      }),
      expect.objectContaining({ name: updatedName, number: 2, status: "draft", version: 1 }),
    ]);
    expect(reactBoundaryErrors).toBe(0);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-003 @p0 dono B não lê nem altera o estúdio do dono A", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(220_000);
  const identityA = createFeat006QaIdentity(testInfo, "003_owner_a");
  const identityB = createFeat006QaIdentity(testInfo, "003_owner_b");
  let contextB: BrowserContext | undefined;
  try {
    await provisionFeat006Owner(page, identityA, "003");
    await fillFeat006Core(page, { name: "Estúdio privado do dono A" });
    const editorA = await createFeat006StudioThroughUi(page);

    contextB = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { height: 900, width: 1440 },
    });
    const pageB = await contextB.newPage();
    await provisionFeat006Owner(pageB, identityB, "103");
    const sessionB = await readFeat002IdentitySession(pageB);
    expect(sessionB).toMatchObject({ authenticated: true, userId: identityB.userId });
    const readResponse = await pageB.request.get(`/api/owner/studios/${editorA.studioId}`);
    expect(readResponse.status()).toBe(404);

    const navigation = await pageB.goto(`/dono/estudios/${editorA.studioId}/dados`);
    expect(navigation).not.toBeNull();
    await expect(
      pageB.getByRole("heading", { level: 1, name: "Estúdio não encontrado" }),
    ).toBeVisible();
    await expect(pageB.locator('head meta[name="robots"]')).toHaveAttribute("content", /noindex/u);
    await expect(pageB.getByText("Estúdio privado do dono A", { exact: true })).toHaveCount(0);
    await expect(pageB.getByText(feat006DefaultCore.street, { exact: true })).toHaveCount(0);

    const writeResponse = await pageB.request.post("/api/commands", {
      data: {
        action: "studio.revision.updateCore",
        expectedScope: identityB.userId,
        idempotencyKey: "90909090-0000-4000-8000-000000000003",
        payload: {
          addressComplement: feat006DefaultCore.addressComplement,
          capacity: Number(feat006DefaultCore.capacity),
          city: "Curitiba",
          description: feat006DefaultCore.description,
          expectedRevisionId: editorA.revision.id,
          expectedRevisionVersion: editorA.revision.version,
          name: "Tentativa do dono B",
          neighborhood: feat006DefaultCore.neighborhood,
          postalCode: "80010000",
          state: "PR",
          street: feat006DefaultCore.street,
          streetNumber: feat006DefaultCore.streetNumber,
          studioId: editorA.studioId,
          studioTypeId: feat006DefaultCore.studioTypeId,
        },
      },
      headers: { origin: new URL(pageB.url()).origin },
    });
    expect(writeResponse.status()).toBe(404);

    const evidence = await readFeat006StudioEvidence(editorA.studioId);
    expect(evidence.revisions).toHaveLength(1);
    expect(evidence.revisions[0]?.name).toBe("Estúdio privado do dono A");
    expect(evidence.owner_user_id).toBe(identityA.userId);
  } finally {
    if (contextB !== undefined) {
      for (const contextPage of contextB.pages()) {
        await closeFeat006PageBeforeCleanup(contextPage);
      }
      await contextB.close();
    }
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identityB);
    await cleanupFeat006QaIdentity(identityA);
  }
});
