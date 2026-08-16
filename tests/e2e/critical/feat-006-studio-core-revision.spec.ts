import {
  apiErrorSchema,
  apiSuccessSchema,
  ownerStudioEditorExpectedScopeHeader,
  ownerStudioEditorResultSchema,
  type StudioCoreInput,
} from "@set-livre/contracts";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

import {
  assertFeat003PrivateValuesAbsentFromDom,
  switchFeat003SessionWithoutNavigation,
} from "../../helpers/feat-003-profile-account";
import {
  cleanupFeat006QaIdentity,
  createFeat006QaIdentity,
  createFeat006Studio,
  createFeat006StudioCore,
  discardFeat006StudioDraft,
  fillFeat006StudioCore,
  gotoFeat006NewStudio,
  provisionFeat006Owner,
  publishFeat006StudioFixture,
  readFeat006StudioDatabaseState,
  updateFeat006Studio,
} from "../../helpers/feat-006-studio-core-revision";

test.use({ screenshot: "off", trace: "off", video: "off" });

function deferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal assíncrono FEAT-006 não foi inicializado.");
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function parseFeat006JsonBody(body: Buffer) {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("A resposta retida da FEAT-006 não contém JSON válido.");
  }
}

function privateFeat006CoreValues(core: StudioCoreInput) {
  return [
    core.name,
    core.description,
    core.address.street,
    core.address.streetNumber,
    core.address.complement ?? "",
    core.address.neighborhood,
    core.address.postalCode,
  ].filter((value) => value !== "");
}

async function expectFeat006RawCore(
  page: Page,
  core: StudioCoreInput,
  options: Readonly<{ disabled: boolean }>,
) {
  const controls = [
    [page.getByRole("textbox", { name: "Nome do estúdio" }), core.name],
    [page.getByRole("combobox", { name: "Tipo de estúdio" }), core.studioTypeId],
    [page.getByRole("textbox", { name: "Descrição" }), core.description],
    [page.getByRole("textbox", { name: "Logradouro" }), core.address.street],
    [page.getByRole("textbox", { name: "Número" }), core.address.streetNumber],
    [page.getByRole("textbox", { name: "Complemento" }), core.address.complement ?? ""],
    [page.getByRole("textbox", { name: "Bairro" }), core.address.neighborhood],
    [page.getByRole("textbox", { name: "CEP" }), core.address.postalCode],
    [page.getByRole("spinbutton", { name: "Capacidade máxima de pessoas" }), String(core.capacity)],
  ] as const;
  for (const [control, value] of controls) {
    await expect(control).toHaveValue(value);
    if (options.disabled) await expect(control).toBeDisabled();
  }
}

test("SL-F006-E2E-001 @p0 cria estúdio e salva revisão em rascunho", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat006QaIdentity(testInfo, "001_create_draft");
  const core = createFeat006StudioCore("001_create_draft");
  const createCommitted = deferredSignal();
  const releaseCreateResponse = deferredSignal();
  const sameScopeReadFetched = deferredSignal();
  const releaseSameScopeRead = deferredSignal();
  let createOperation: ReturnType<typeof createFeat006Studio> | undefined;
  let createPosts = 0;
  let createRouteFailure: string | undefined;
  let sameScopeReadFailure: string | undefined;
  let sameScopeReadPayload: unknown;
  let sameScopeReadStatus: number | undefined;

  try {
    await provisionFeat006Owner(page, identity);
    await gotoFeat006NewStudio(page);
    await fillFeat006StudioCore(page, core);

    if (identity.userId === undefined) {
      throw new Error("O dono do cenário não possui escopo autenticado para o probe privado.");
    }
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return;
      }
      const body: unknown = request.postDataJSON();
      if (z.object({ action: z.string() }).safeParse(body).data?.action === "studio.create") {
        createPosts += 1;
      }
    });
    await page.route(
      "**/api/commands",
      async (route) => {
        const body: unknown = route.request().postDataJSON();
        if (z.object({ action: z.string() }).safeParse(body).data?.action !== "studio.create") {
          await route.continue();
          return;
        }
        try {
          const response = await route.fetch();
          const responseBody = await response.body();
          const parsed = apiSuccessSchema(ownerStudioEditorResultSchema).safeParse(
            parseFeat006JsonBody(responseBody),
          );
          if (response.status() !== 200 || !parsed.success || parsed.data.data.mode !== "edit") {
            createRouteFailure = "O POST create retido não confirmou o agregado esperado.";
          }
          createCommitted.resolve();
          await releaseCreateResponse.promise;
          await route.fulfill({ body: responseBody, response });
        } catch {
          createRouteFailure = "O POST create retido falhou antes de publicar sua resposta.";
          createCommitted.resolve();
          await route.abort("failed");
        }
      },
      { times: 1 },
    );
    createOperation = createFeat006Studio(page);
    await createCommitted.promise;
    expect(createRouteFailure).toBeUndefined();
    expect(createPosts).toBe(1);

    await page.route(
      "**/api/owner/studio-editor*",
      async (route) => {
        try {
          if (route.request().headers()[ownerStudioEditorExpectedScopeHeader] !== identity.userId) {
            sameScopeReadFailure = "O probe pending não carregou o escopo montado no controller.";
          }
          const response = await route.fetch();
          const responseBody = await response.body();
          sameScopeReadStatus = response.status();
          sameScopeReadPayload = parseFeat006JsonBody(responseBody);
          sameScopeReadFetched.resolve();
          await releaseSameScopeRead.promise;
          await route.fulfill({ body: responseBody, response });
        } catch {
          sameScopeReadFailure = "O GET same-scope retido falhou antes de publicar sua resposta.";
          sameScopeReadFetched.resolve();
          await route.abort("failed");
        }
      },
      { times: 1 },
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sameScopeReadFetched.promise;
    expect(sameScopeReadFailure).toBeUndefined();
    expect(sameScopeReadStatus).toBe(200);
    const sameScopeEditor = apiSuccessSchema(ownerStudioEditorResultSchema).parse(
      sameScopeReadPayload,
    ).data;
    expect(sameScopeEditor).toMatchObject({ mode: "create", scope: identity.userId });
    await expect(
      page.getByText("Validando o editor privado do estúdio…", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Identificação" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Pré-visualização" })).toHaveCount(0);
    await assertFeat003PrivateValuesAbsentFromDom(page, privateFeat006CoreValues(core));

    releaseSameScopeRead.resolve();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeVisible();
    await expectFeat006RawCore(page, core, { disabled: true });
    const pendingForm = page.locator("form").filter({
      has: page.getByRole("button", { name: "Salvando rascunho" }),
    });
    await expect(pendingForm).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: "Salvando rascunho" })).toBeDisabled();
    expect(createPosts).toBe(1);

    releaseCreateResponse.resolve();
    const result = await createOperation;
    expect(result.studio).toMatchObject({
      draft: {
        core: {
          ...core,
          city: "Curitiba",
          state: "PR",
          studioTypeName: "Podcast",
        },
        revisionNumber: 1,
      },
      editVersion: 1,
      published: null,
      status: "draft",
    });
    await page.waitForURL(`/dono/estudios/${result.studio.id}/dados`);
    await expect(page.getByRole("heading", { level: 1, name: "Dados do estúdio" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 3, name: "Rascunho · revisão 1" }),
    ).toBeVisible();
    await expect(page.getByText(core.name, { exact: true })).toBeVisible();
    expect(page.url()).not.toContain(encodeURIComponent(core.description));
    expect(page.url()).not.toContain(encodeURIComponent(core.address.street));
    expect(createPosts).toBe(1);
    const aggregate = await readFeat006StudioDatabaseState(identity, result.studio.id);
    expect(aggregate).toMatchObject({
      draft_revision_number: 1,
      edit_version: 1,
      published_revision_id: null,
      published_revision_number: null,
      studio_status: "draft",
    });

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  } finally {
    releaseSameScopeRead.resolve();
    releaseCreateResponse.resolve();
    await createOperation?.catch(() => undefined);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-002 @p0 editar publicado cria e descarta rascunho sem alterar a versão aprovada", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const identity = createFeat006QaIdentity(testInfo, "002_clone_published");
  const approvedCore = createFeat006StudioCore("002_approved");
  const editedCore = {
    ...approvedCore,
    address: {
      ...approvedCore.address,
      street: `${approvedCore.address.street} editado`,
    },
    capacity: 12,
    description: `${approvedCore.description} Edição qa_f006_002.`,
    name: `${approvedCore.name}_editado`,
  };

  try {
    await provisionFeat006Owner(page, identity);
    await gotoFeat006NewStudio(page);
    await fillFeat006StudioCore(page, approvedCore);
    const created = await createFeat006Studio(page);
    await page.waitForURL(`/dono/estudios/${created.studio.id}/dados`);

    await publishFeat006StudioFixture(identity, created.studio.id);
    const before = await readFeat006StudioDatabaseState(identity, created.studio.id);
    expect(before).toMatchObject({
      draft_revision_id: null,
      published_description: approvedCore.description,
      published_name: approvedCore.name,
      published_revision_number: 1,
      studio_status: "published",
    });

    await page.reload();
    await expect(
      page.getByRole("heading", { level: 3, name: "Versão aprovada · revisão 1" }),
    ).toBeVisible();
    await fillFeat006StudioCore(page, editedCore);
    const updated = await updateFeat006Studio(page);
    expect(updated.studio.draft).toMatchObject({
      core: { capacity: editedCore.capacity, name: editedCore.name },
      revisionNumber: 2,
    });
    expect(updated.studio.published).toMatchObject({
      core: { description: approvedCore.description, name: approvedCore.name },
      revisionNumber: 1,
    });
    await expect(page.getByText("Rascunho salvo com segurança.", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 3, name: "Rascunho · revisão 2" }),
    ).toBeVisible();

    const after = await readFeat006StudioDatabaseState(identity, created.studio.id);
    expect(after.published_revision_id).toBe(before.published_revision_id);
    expect(after.published_revision_number).toBe(before.published_revision_number);
    expect(after.published_name).toBe(before.published_name);
    expect(after.published_description).toBe(before.published_description);
    expect(after.draft_revision_number).toBe(2);

    let discardPosts = 0;
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return;
      }
      const body: unknown = request.postDataJSON();
      if (
        z.object({ action: z.string() }).safeParse(body).data?.action === "studio.draft.discard"
      ) {
        discardPosts += 1;
      }
    });
    await page.getByRole("button", { name: "Descartar rascunho" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Confirme o descarte", { exact: true }) }),
    ).toContainText("Somente o rascunho será removido. A versão aprovada continuará inalterada.");

    const discarded = await discardFeat006StudioDraft(page);
    expect(discardPosts).toBe(1);
    expect(discarded.outcome).toBe("draft_removed");
    if (discarded.outcome !== "draft_removed") {
      throw new Error("O descarte do publicado não preservou o estúdio aprovado.");
    }
    expect(discarded.scope).toBe(updated.scope);
    expect(discarded.studioId).toBe(created.studio.id);
    expect(discarded.editor).toMatchObject({
      mode: "edit",
      scope: updated.scope,
      studio: {
        draft: null,
        id: created.studio.id,
        published: {
          core: {
            description: approvedCore.description,
            name: approvedCore.name,
          },
          revisionNumber: 1,
        },
        status: "published",
      },
    });
    expect(discarded.editor.studio.editVersion).toBe(updated.studio.editVersion + 1);
    await expect(
      page.getByText("Rascunho descartado com segurança.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Rascunho · revisão 2" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("heading", { level: 3, name: "Versão aprovada · revisão 1" }),
    ).toBeVisible();

    const afterDiscard = await readFeat006StudioDatabaseState(identity, created.studio.id);
    expect(afterDiscard).toMatchObject({
      draft_revision_id: null,
      draft_revision_number: null,
      edit_version: after.edit_version + 1,
      published_description: before.published_description,
      published_name: before.published_name,
      published_revision_id: before.published_revision_id,
      published_revision_number: before.published_revision_number,
      studio_status: "published",
    });
    expect(discardPosts).toBe(1);
  } finally {
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-003 @p0 dono A não edita estúdio B", async ({ browser, page }, testInfo) => {
  test.setTimeout(300_000);
  const identityA = createFeat006QaIdentity(testInfo, "003_owner_a");
  const identityB = createFeat006QaIdentity(testInfo, "003_owner_b");
  const coreA = createFeat006StudioCore("003_owner_a");
  const dirtyCoreA: StudioCoreInput = {
    ...coreA,
    address: {
      ...coreA.address,
      complement: `${coreA.address.complement ?? ""} dirty-a`,
      street: `${coreA.address.street} dirty-a`,
    },
    capacity: 13,
    description: `${coreA.description} Alteração privada dirty-a ainda não salva.`,
    name: `${coreA.name}_dirty_a`,
  };
  const scopeReadFetched = deferredSignal();
  const releaseScopeRead = deferredSignal();
  let contextB: BrowserContext | undefined;
  let scopeReadFailure: string | undefined;
  let scopeReadHeader: string | undefined;
  let scopeReadPayload: unknown;
  let scopeReadStatus: number | undefined;

  try {
    await provisionFeat006Owner(page, identityA);
    await gotoFeat006NewStudio(page);
    await fillFeat006StudioCore(page, coreA);
    const created = await createFeat006Studio(page);
    const editorPath = `/dono/estudios/${created.studio.id}/dados`;
    await page.waitForURL(editorPath);

    contextB = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const pageB = await contextB.newPage();
    await provisionFeat006Owner(pageB, identityB);
    await contextB.close();
    contextB = undefined;
    expect(
      identityA.userId !== undefined &&
        identityB.userId !== undefined &&
        identityA.userId !== identityB.userId,
    ).toBe(true);

    if (identityA.userId === undefined || identityB.userId === undefined) {
      throw new Error("Os donos adversariais não possuem escopos autenticados distintos.");
    }
    await fillFeat006StudioCore(page, dirtyCoreA);
    await expectFeat006RawCore(page, dirtyCoreA, { disabled: false });

    await page.route(
      "**/api/owner/studio-editor*",
      async (route) => {
        try {
          scopeReadHeader = route.request().headers()[ownerStudioEditorExpectedScopeHeader];
          const response = await route.fetch();
          const responseBody = await response.body();
          scopeReadStatus = response.status();
          scopeReadPayload = parseFeat006JsonBody(responseBody);
          scopeReadFetched.resolve();
          await releaseScopeRead.promise;
          await route.fulfill({ body: responseBody, response });
        } catch {
          scopeReadFailure = "O probe A→B retido falhou antes de publicar sua resposta.";
          scopeReadFetched.resolve();
          await route.abort("failed");
        }
      },
      { times: 1 },
    );
    const switched = await switchFeat003SessionWithoutNavigation(page, identityB);
    expect(switched.session).toMatchObject({ authenticated: true, userId: identityB.userId });
    expect(new URL(page.url()).pathname).toBe(editorPath);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await scopeReadFetched.promise;
    expect(scopeReadFailure).toBeUndefined();
    expect(scopeReadHeader).toBe(identityA.userId);
    expect(scopeReadStatus).toBe(409);
    const rejectedScopeRead = apiErrorSchema.parse(scopeReadPayload);
    expect(rejectedScopeRead.error.code).toBe("SESSION_CHANGED");
    expect(new URL(page.url()).pathname).toBe(editorPath);
    await expect(
      page.getByText("Validando o editor privado do estúdio…", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Identificação" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Pré-visualização" })).toHaveCount(0);
    const privateValuesA = [
      ...privateFeat006CoreValues(coreA),
      ...privateFeat006CoreValues(dirtyCoreA),
    ];
    await assertFeat003PrivateValuesAbsentFromDom(page, privateValuesA);
    await page.evaluate((forbiddenValues) => {
      const key = "sl-qa-f006-studio-scope-transition";
      const inspect = () => {
        const text = document.body.textContent ?? "";
        const values = [
          ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "input, select, textarea",
          ),
        ].map((control) => control.value);
        const leak = forbiddenValues.findIndex(
          (value) => text.includes(value) || values.some((entry) => entry.includes(value)),
        );
        if (leak !== -1) sessionStorage.setItem(key, `leak:value-${String(leak)}`);
      };
      sessionStorage.setItem(key, "armed");
      const observer = new MutationObserver(inspect);
      observer.observe(document.body, {
        attributeFilter: ["value"],
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      window.addEventListener(
        "pagehide",
        () => {
          inspect();
          if (sessionStorage.getItem(key) === "armed") sessionStorage.setItem(key, "clear");
          observer.disconnect();
        },
        { once: true },
      );
    }, privateValuesA);

    const transitionReload = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    releaseScopeRead.resolve();
    await transitionReload;
    expect(scopeReadFailure).toBeUndefined();
    await expect(
      page.getByRole("heading", { level: 1, name: "Estúdio não encontrado" }),
    ).toBeVisible();
    const transitionEvidence = await page.evaluate(() => {
      const key = "sl-qa-f006-studio-scope-transition";
      const evidence = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      return evidence;
    });
    expect(transitionEvidence).toBe("clear");
    await assertFeat003PrivateValuesAbsentFromDom(page, privateValuesA);

    const apiResponse = await page.request.get(
      `/api/owner/studio-editor?studioId=${created.studio.id}`,
      { headers: { [ownerStudioEditorExpectedScopeHeader]: identityB.userId } },
    );
    expect(apiResponse.status()).toBe(404);
    const apiBody = await apiResponse.text();
    expect(apiErrorSchema.parse(JSON.parse(apiBody) as unknown).error.code).toBe("NOT_FOUND");
    expect(apiBody.includes(coreA.description) || apiBody.includes(coreA.address.street)).toBe(
      false,
    );

    await page.goto(editorPath);
    expect(new URL(page.url()).pathname === editorPath).toBe(true);
    await expect(
      page.getByRole("heading", { level: 1, name: "Estúdio não encontrado" }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(page.getByText(coreA.description, { exact: true })).toHaveCount(0);
  } finally {
    releaseScopeRead.resolve();
    await contextB?.close();
    await cleanupFeat006QaIdentity(identityA);
    await cleanupFeat006QaIdentity(identityB);
  }
});
