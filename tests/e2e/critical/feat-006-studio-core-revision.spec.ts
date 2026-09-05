import {
  apiSuccessSchema,
  studioCreateCommandSchema,
  studioCreateResultSchema,
} from "@set-livre/contracts";
import { expect, test, type BrowserContext } from "@playwright/test";

import { readFeat002IdentitySession } from "../../helpers/feat-002-authentication";
import { switchFeat003SessionWithoutNavigation } from "../../helpers/feat-003-profile-account";
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
  setFeat006OwnerStatus,
} from "../../helpers/feat-006-studio-core-revision";

function createDeferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal de fronteira do editor não foi inicializado.");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("SL-F006-E2E-001 @p0 cria estúdio e primeira revisão draft atomicamente", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat006QaIdentity(testInfo, "001_create");
  try {
    await provisionFeat006Owner(page, identity, "001");
    await expect(page.getByRole("link", { exact: true, name: "Novo estúdio" })).toHaveAttribute(
      "aria-current",
      "page",
    );
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
    await expect(page.getByRole("link", { exact: true, name: "Novo estúdio" })).not.toHaveAttribute(
      "aria-current",
      "page",
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
    expect(evidence.status).toBe("changes_pending");
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

test("SL-F006-E2E-018 @p0 reload reconcilia criação ambígua com a mesma identidade", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat006QaIdentity(testInfo, "018_create_reload_recovery");
  const submittedCommands: unknown[] = [];
  let committedStudioId: string | undefined;
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
      return;
    }
    const command = studioCreateCommandSchema.safeParse(request.postDataJSON());
    if (command.success) submittedCommands.push(command.data);
  });
  try {
    await provisionFeat006Owner(page, identity, "018");
    await fillFeat006Core(page, { name: "Estúdio recuperado após reload" });
    await page.route(
      "**/api/commands",
      async (route) => {
        const command = studioCreateCommandSchema.parse(route.request().postDataJSON());
        expect(command.action).toBe("studio.create");
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const result = apiSuccessSchema(studioCreateResultSchema).parse(await response.json()).data;
        expect(result.idempotencyKey).toBe(command.idempotencyKey);
        committedStudioId = result.editor.studioId;
        await route.abort("failed");
      },
      { times: 1 },
    );

    await page.getByRole("button", { name: "Criar estúdio em rascunho" }).click();
    await expect(
      page.getByText("Não foi possível conectar. Verifique sua internet e tente novamente."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Criar estúdio em rascunho" })).toBeDisabled();

    const replayResponse = page.waitForResponse((response) => {
      if (response.request().method() !== "POST") return false;
      const command = studioCreateCommandSchema.safeParse(response.request().postDataJSON());
      return (
        new URL(response.url()).pathname === "/api/commands" &&
        command.success &&
        response.status() === 200
      );
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await replayResponse;

    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(
      "Estúdio recuperado após reload",
    );
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
    expect(submittedCommands).toHaveLength(2);
    expect(submittedCommands[1]).toEqual(submittedCommands[0]);
    if (committedStudioId === undefined) {
      throw new Error("A resposta perdida não publicou a identidade do estúdio criado.");
    }
    const evidence = await readFeat006StudioEvidence(committedStudioId);
    expect(evidence.revisions).toHaveLength(1);

    await page.getByRole("button", { name: "Abrir editor criado" }).click();
    await expect(page).toHaveURL(new RegExp(`/dono/estudios/${committedStudioId}/dados$`, "u"));
    await expect(page.getByText("Rascunho privado", { exact: true })).toBeVisible();
    await page.goto("/dono/estudios/novo");
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue("");
    expect(submittedCommands).toHaveLength(2);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-019 @p0 rejeição conclusiva libera uma nova tentativa na mesma aba", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat006QaIdentity(testInfo, "019_conclusive_create_rejection");
  try {
    await provisionFeat006Owner(page, identity, "019");
    await fillFeat006Core(page, { name: "Estúdio após rejeição conclusiva" });
    await page.route(
      "**/api/commands",
      (route) =>
        route.fulfill({
          json: {
            error: {
              code: "RATE_LIMITED",
              message: "Aguarde antes de criar outro estúdio.",
              requestId: "90909090-0000-4000-8000-000000000019",
            },
          },
          status: 429,
        }),
      { times: 1 },
    );

    const create = page.getByRole("button", { name: "Criar estúdio em rascunho" });
    await create.click();

    await expect(
      page.getByText("Aguarde antes de criar outro estúdio.", { exact: true }),
    ).toBeVisible();
    await expect(create).toBeEnabled();
    await expect(
      page.getByRole("alert", { name: "Criação protegida contra duplicação" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        Object.keys(window.sessionStorage).filter((key) =>
          key.startsWith("set-livre:studio-create:v1:"),
        ),
      ),
    ).toEqual([]);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-008 @p0 troca de sessão oculta editor privado antes da releitura", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(220_000);
  const identityA = createFeat006QaIdentity(testInfo, "008_scope_a");
  const identityB = createFeat006QaIdentity(testInfo, "008_scope_b");
  const editorReadCaptured = createDeferredSignal();
  const releaseEditorRead = createDeferredSignal();
  let contextB: BrowserContext | undefined;
  try {
    await provisionFeat006Owner(page, identityA, "008");
    await fillFeat006Core(page, { name: "Estúdio ultraprivado do escopo A" });
    const editorA = await createFeat006StudioThroughUi(page);

    contextB = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { height: 900, width: 1440 },
    });
    const pageB = await contextB.newPage();
    await provisionFeat006Owner(pageB, identityB, "108");
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
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(page.getByText("Estúdio ultraprivado do escopo A", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText(feat006DefaultCore.street, { exact: true })).toHaveCount(0);

    releaseEditorRead.resolve();
    await expect(
      page.getByRole("heading", { level: 1, name: "Estúdio não encontrado" }),
    ).toBeVisible();
    await expect(page.getByText("Estúdio ultraprivado do escopo A", { exact: true })).toHaveCount(
      0,
    );
  } finally {
    releaseEditorRead.resolve();
    await contextB?.close();
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identityB);
    await cleanupFeat006QaIdentity(identityA);
  }
});

test("SL-F006-E2E-016 @p0 troca de sessão oculta e apaga criação ainda não salva", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(220_000);
  const identityA = createFeat006QaIdentity(testInfo, "016_create_scope_a");
  const identityB = createFeat006QaIdentity(testInfo, "016_create_scope_b");
  const sameScopeReadCaptured = createDeferredSignal();
  const releaseSameScopeRead = createDeferredSignal();
  const sessionReadCaptured = createDeferredSignal();
  const releaseSessionRead = createDeferredSignal();
  const privateName = "Estúdio não salvo do escopo A";
  const privateStreet = "Rua privada da criação A";
  let contextB: BrowserContext | undefined;
  try {
    await provisionFeat006Owner(page, identityA, "016");
    await fillFeat006Core(page, { name: privateName, street: privateStreet });

    await page.route(
      "**/api/auth/session",
      async (route) => {
        const response = await route.fetch();
        sameScopeReadCaptured.resolve();
        await releaseSameScopeRead.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    const sameScopeReadFinished = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/session",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await sameScopeReadCaptured.promise;
    await expect(
      page.getByText("Validando sua sessão e seu cadastro de dono antes de criar o estúdio…", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    releaseSameScopeRead.resolve();
    await sameScopeReadFinished;
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(privateName);
    await expect(page.getByRole("textbox", { name: "Rua ou avenida" })).toHaveValue(privateStreet);

    contextB = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { height: 900, width: 1440 },
    });
    const pageB = await contextB.newPage();
    await provisionFeat006Owner(pageB, identityB, "116");
    await contextB.close();
    contextB = undefined;

    await page.route(
      "**/api/auth/session",
      async (route) => {
        const response = await route.fetch();
        sessionReadCaptured.resolve();
        await releaseSessionRead.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );

    const switched = await switchFeat003SessionWithoutNavigation(page, identityB);
    expect(switched.session).toMatchObject({ authenticated: true, userId: identityB.userId });
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await sessionReadCaptured.promise;

    await expect(
      page.getByText("Validando sua sessão e seu cadastro de dono antes de criar o estúdio…", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
    await expect(page.getByText(privateStreet, { exact: true })).toHaveCount(0);

    releaseSessionRead.resolve();

    await expect(page.getByRole("heading", { level: 1, name: "Novo estúdio" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue("");
    await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
    await expect(page.getByText(privateStreet, { exact: true })).toHaveCount(0);
  } finally {
    releaseSameScopeRead.resolve();
    releaseSessionRead.resolve();
    await contextB?.close();
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identityB);
    await cleanupFeat006QaIdentity(identityA);
  }
});

test("SL-F006-E2E-017 @p0 revogação do dono oculta e apaga criação ainda não salva", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat006QaIdentity(testInfo, "017_create_owner_boundary");
  const ownerReadCaptured = createDeferredSignal();
  const releaseOwnerRead = createDeferredSignal();
  const privateName = "Estúdio não salvo do dono revogado";
  const privateStreet = "Rua privada do dono revogado";
  try {
    await provisionFeat006Owner(page, identity, "017");
    await fillFeat006Core(page, { name: privateName, street: privateStreet });
    if (identity.userId === undefined) {
      throw new Error("A identidade FEAT-006 não publicou o escopo do dono.");
    }
    await setFeat006OwnerStatus(identity.userId, "blocked");

    await page.route(
      "**/api/owner/activation",
      async (route) => {
        const response = await route.fetch();
        ownerReadCaptured.resolve();
        await releaseOwnerRead.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await ownerReadCaptured.promise;

    await expect(
      page.getByText("Validando sua sessão e seu cadastro de dono antes de criar o estúdio…", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
    await expect(page.getByText(privateStreet, { exact: true })).toHaveCount(0);

    releaseOwnerRead.resolve();

    await expect(page.getByText("Ative seu cadastro de dono", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(page.getByText(privateName, { exact: true })).toHaveCount(0);
    await expect(page.getByText(privateStreet, { exact: true })).toHaveCount(0);
  } finally {
    releaseOwnerRead.resolve();
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});
