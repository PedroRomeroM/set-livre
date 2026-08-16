import {
  apiSuccessSchema,
  ownerStudioEditorResultSchema,
  studioCommandSchema,
  studioCreateCommandSchema,
  studioRevisionUpdateCoreCommandSchema,
  type StudioCoreInput,
} from "@set-livre/contracts";
import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { z } from "zod";

import {
  cleanupFeat006QaIdentity,
  createFeat006QaIdentity,
  createFeat006Studio,
  createFeat006StudioCore,
  fillFeat006StudioCore,
  gotoFeat006NewStudio,
  provisionFeat006Owner,
  readFeat006StudioDatabaseState,
  type Feat006StudioDatabaseState,
  updateFeat006Studio,
} from "../../helpers/feat-006-studio-core-revision";

test.use({ screenshot: "off", trace: "off", video: "off" });

function waitForStudioCommandResponse(
  page: Page,
  action: "studio.create" | "studio.revision.updateCore",
) {
  return page.waitForResponse(async (response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/commands"
    ) {
      return false;
    }
    const body: unknown = response.request().postDataJSON();
    return z.object({ action: z.string() }).safeParse(body).data?.action === action;
  });
}

async function waitForStudioCommand(
  page: Page,
  action: "studio.create" | "studio.revision.updateCore",
  click: () => Promise<void>,
) {
  const responsePromise = waitForStudioCommandResponse(page, action);
  await click();
  return responsePromise;
}

function parseFeat006JsonBody(body: Buffer) {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("A resposta retida da FEAT-006 não contém JSON válido.");
  }
}

function assertLocalFeat006CommandTarget(value: string, expectedOrigin: string) {
  const target = new URL(value);
  if (
    expectedOrigin !== "http://127.0.0.1:3000" ||
    target.origin !== expectedOrigin ||
    target.pathname !== "/api/commands" ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new Error("O replay controlado da FEAT-006 recusou um destino fora da origem local.");
  }
  return target;
}

async function expectFeat006FormCore(page: Page, core: StudioCoreInput) {
  await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(core.name);
  await expect(page.getByRole("combobox", { name: "Tipo de estúdio" })).toHaveValue(
    core.studioTypeId,
  );
  await expect(page.getByRole("textbox", { name: "Descrição" })).toHaveValue(core.description);
  await expect(page.getByRole("textbox", { name: "Logradouro" })).toHaveValue(core.address.street);
  await expect(page.getByRole("textbox", { name: "Número" })).toHaveValue(
    core.address.streetNumber,
  );
  await expect(page.getByRole("textbox", { name: "Complemento" })).toHaveValue(
    core.address.complement ?? "",
  );
  await expect(page.getByRole("textbox", { name: "Bairro" })).toHaveValue(
    core.address.neighborhood,
  );
  await expect(page.getByRole("textbox", { name: "CEP" })).toHaveValue(core.address.postalCode);
  await expect(page.getByRole("spinbutton", { name: "Capacidade máxima de pessoas" })).toHaveValue(
    String(core.capacity),
  );
}

function feat006CoreMatches(actual: StudioCoreInput, expected: StudioCoreInput) {
  return (
    actual.name === expected.name &&
    actual.description === expected.description &&
    actual.studioTypeId === expected.studioTypeId &&
    actual.capacity === expected.capacity &&
    actual.address.street === expected.address.street &&
    actual.address.streetNumber === expected.address.streetNumber &&
    actual.address.complement === expected.address.complement &&
    actual.address.neighborhood === expected.address.neighborhood &&
    actual.address.postalCode === expected.address.postalCode
  );
}

function expectFeat006DraftDatabaseCore(state: Feat006StudioDatabaseState, core: StudioCoreInput) {
  expect(
    state.draft_capacity === core.capacity &&
      state.draft_complement === core.address.complement &&
      state.draft_description === core.description &&
      state.draft_name === core.name &&
      state.draft_neighborhood === core.address.neighborhood &&
      state.draft_postal_code === core.address.postalCode &&
      state.draft_revision_rows === 1 &&
      state.draft_street === core.address.street &&
      state.draft_street_number === core.address.streetNumber &&
      state.draft_studio_type_id === core.studioTypeId,
  ).toBe(true);
}

async function runAmbiguousCreateFoundRecovery(
  browser: Browser,
  origin: string,
  testInfo: TestInfo,
) {
  const identity = createFeat006QaIdentity(testInfo, "005_ambiguous_create_found");
  const coreA = createFeat006StudioCore("005_ambiguous_a");
  const coreB: StudioCoreInput = {
    ...coreA,
    address: {
      ...coreA.address,
      complement: `${coreA.address.complement ?? ""} tentativa-b`,
      street: `${coreA.address.street} tentativa-b`,
    },
    capacity: 23,
    description: `${coreA.description} Tentativa B preservada qa_f006_005.`,
    name: `${coreA.name}_tentativa_b`,
  };
  let context: BrowserContext | undefined;
  let capturedBody: Buffer | undefined;
  let capturedContentType: string | undefined;
  let capturedUrl: string | undefined;
  let captureFailure: string | undefined;
  let recoveryStudioId: string | undefined;
  let browserCreatePosts = 0;
  let browserUpdatePosts = 0;
  let directCommitPosts = 0;
  let recoveryReads = 0;

  try {
    context = await browser.newContext({ baseURL: origin });
    const recoveryPage = await context.newPage();
    await provisionFeat006Owner(recoveryPage, identity);
    await gotoFeat006NewStudio(recoveryPage);
    await fillFeat006StudioCore(recoveryPage, coreA);
    if (identity.userId === undefined) {
      throw new Error("O cenário ambíguo FEAT-006 não possui escopo autenticado.");
    }

    recoveryPage.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() === "GET" &&
        url.pathname === "/api/owner/studio-editor" &&
        recoveryStudioId !== undefined &&
        url.searchParams.get("studioId") === recoveryStudioId
      ) {
        recoveryReads += 1;
        return;
      }
      if (request.method() !== "POST" || url.pathname !== "/api/commands") return;
      const parsed = studioCommandSchema.safeParse(request.postDataJSON());
      if (!parsed.success) return;
      if (parsed.data.action === "studio.create") browserCreatePosts += 1;
      if (parsed.data.action === "studio.revision.updateCore") browserUpdatePosts += 1;
    });
    await recoveryPage.route(
      "**/api/commands",
      async (route) => {
        const request = route.request();
        const body = request.postDataBuffer();
        const parsed =
          body === null
            ? undefined
            : studioCreateCommandSchema.safeParse(parseFeat006JsonBody(body));
        if (body === null || parsed === undefined || !parsed.success) {
          captureFailure = "O primeiro create não continha o envelope estrito esperado.";
        } else {
          const target = assertLocalFeat006CommandTarget(request.url(), origin);
          const contentType = request.headers()["content-type"];
          if (contentType === undefined || !contentType.startsWith("application/json")) {
            captureFailure = "O primeiro create não declarou o conteúdo JSON esperado.";
          } else {
            capturedBody = Buffer.from(body);
            capturedContentType = contentType;
            capturedUrl = target.href;
            recoveryStudioId = parsed.data.payload.studioId;
          }
        }
        await route.abort("failed");
      },
      { times: 1 },
    );

    await recoveryPage.getByRole("button", { name: "Salvar rascunho" }).click();
    await expect(
      recoveryPage.getByText("Confirme o estado atual antes de tentar novamente", { exact: true }),
    ).toBeVisible();
    expect(captureFailure).toBeUndefined();
    if (
      capturedBody === undefined ||
      capturedContentType === undefined ||
      capturedUrl === undefined ||
      recoveryStudioId === undefined
    ) {
      throw new Error("O primeiro create ambíguo não foi capturado integralmente em memória.");
    }
    const commandK1 = studioCreateCommandSchema.parse(parseFeat006JsonBody(capturedBody));
    expect(
      commandK1.expectedScope === identity.userId &&
        commandK1.payload.studioId === recoveryStudioId &&
        feat006CoreMatches(commandK1.payload.core, coreA),
    ).toBe(true);
    expect(browserCreatePosts).toBe(1);
    expect(browserUpdatePosts).toBe(0);
    await expect(recoveryPage.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();

    const missingReadPromise = recoveryPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/owner/studio-editor" &&
        url.searchParams.get("studioId") === recoveryStudioId
      );
    });
    await recoveryPage.getByRole("button", { name: "Verificar e comparar" }).click();
    const missingRead = await missingReadPromise;
    expect(missingRead.status()).toBe(404);
    expect(missingRead.request().headers()["x-set-livre-expected-scope"] === identity.userId).toBe(
      true,
    );
    expect(recoveryReads).toBe(1);
    const comparisonMissing = recoveryPage.getByRole("region", {
      name: "Compare antes de continuar",
      exact: true,
    });
    await expect(
      comparisonMissing.getByText("Criação não encontrada", { exact: true }),
    ).toBeVisible();
    await expect(comparisonMissing.getByText(coreA.name, { exact: true })).toBeVisible();
    expect(browserCreatePosts).toBe(1);

    const corePersistedOutsideMemory = await recoveryPage.evaluate(
      (privateValues) => {
        const storageValues = [localStorage, sessionStorage].flatMap((storage) =>
          Array.from({ length: storage.length }, (_, index) => storage.key(index))
            .filter((key): key is string => key !== null)
            .map((key) => `${key}:${storage.getItem(key) ?? ""}`),
        );
        return privateValues.some(
          (value) =>
            window.location.href.includes(encodeURIComponent(value)) ||
            storageValues.some((stored) => stored.includes(value)),
        );
      },
      [
        commandK1.idempotencyKey,
        commandK1.payload.studioId,
        coreA.name,
        coreA.description,
        coreA.address.street,
      ],
    );
    expect(corePersistedOutsideMemory).toBe(false);

    await recoveryPage.getByRole("button", { name: "Reaplicar meus campos ao formulário" }).click();
    await expectFeat006FormCore(recoveryPage, coreA);
    await fillFeat006StudioCore(recoveryPage, coreB);

    const target = assertLocalFeat006CommandTarget(capturedUrl, origin);
    directCommitPosts += 1;
    const committedResponse = await recoveryPage.request.fetch(target.href, {
      data: capturedBody,
      headers: {
        "content-type": capturedContentType,
        host: target.host,
        origin: target.origin,
      },
      maxRedirects: 0,
      maxRetries: 0,
      method: "POST",
    });
    expect(directCommitPosts).toBe(1);
    expect(committedResponse.status()).toBe(200);
    const committedPayload = apiSuccessSchema(ownerStudioEditorResultSchema).parse(
      parseFeat006JsonBody(await committedResponse.body()),
    ).data;
    if (committedPayload.mode !== "edit") {
      throw new Error("O commit controlado de K1 não retornou o editor factual.");
    }
    expect(
      committedPayload.scope === identity.userId &&
        committedPayload.studio.id === recoveryStudioId &&
        committedPayload.studio.editVersion === 1 &&
        committedPayload.studio.status === "draft" &&
        committedPayload.studio.published === null &&
        committedPayload.studio.draft !== null &&
        committedPayload.studio.draft.revisionNumber === 1 &&
        feat006CoreMatches(committedPayload.studio.draft.core, coreA),
    ).toBe(true);

    const conflictResponse = await waitForStudioCommand(recoveryPage, "studio.create", () =>
      recoveryPage.getByRole("button", { name: "Salvar rascunho" }).click(),
    );
    expect(conflictResponse.status()).toBe(409);
    const commandK2 = studioCreateCommandSchema.parse(conflictResponse.request().postDataJSON());
    expect(
      commandK2.payload.studioId === recoveryStudioId &&
        feat006CoreMatches(commandK2.payload.core, coreB),
    ).toBe(true);
    expect(commandK2.expectedScope === identity.userId).toBe(true);
    expect(commandK2.idempotencyKey !== commandK1.idempotencyKey).toBe(true);
    expect(browserCreatePosts).toBe(2);
    expect(browserUpdatePosts).toBe(0);
    expect(recoveryReads).toBe(1);
    await expect(
      recoveryPage.getByText("O rascunho mudou em outro lugar", { exact: true }),
    ).toBeVisible();

    const foundReadPromise = recoveryPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/owner/studio-editor" &&
        url.searchParams.get("studioId") === recoveryStudioId
      );
    });
    await recoveryPage.getByRole("button", { name: "Verificar e comparar" }).click();
    const foundRead = await foundReadPromise;
    expect(foundRead.status()).toBe(200);
    expect(foundRead.request().headers()["x-set-livre-expected-scope"] === identity.userId).toBe(
      true,
    );
    expect(recoveryReads).toBe(2);
    const comparisonFound = recoveryPage.getByRole("region", {
      name: "Compare antes de continuar",
      exact: true,
    });
    const currentSummary = comparisonFound.getByRole("article").filter({
      has: recoveryPage.getByRole("heading", { level: 3, name: "Versão atual", exact: true }),
    });
    const attemptedSummary = comparisonFound.getByRole("article").filter({
      has: recoveryPage.getByRole("heading", { level: 3, name: "Sua tentativa", exact: true }),
    });
    await expect(currentSummary.getByText(coreA.name, { exact: true })).toBeVisible();
    await expect(attemptedSummary.getByText(coreB.name, { exact: true })).toBeVisible();
    expect(browserCreatePosts).toBe(2);
    expect(browserUpdatePosts).toBe(0);

    await recoveryPage.getByRole("button", { name: "Reaplicar meus campos ao formulário" }).click();
    await expectFeat006FormCore(recoveryPage, coreB);
    const updateRequestPromise = recoveryPage.waitForRequest((request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return false;
      }
      return (
        z.object({ action: z.string() }).safeParse(request.postDataJSON()).data?.action ===
        "studio.revision.updateCore"
      );
    });
    const recoveredResponsePromise = waitForStudioCommandResponse(
      recoveryPage,
      "studio.revision.updateCore",
    );
    const recovered = await updateFeat006Studio(recoveryPage);
    expect((await recoveredResponsePromise).status()).toBe(200);
    const updateRequest = await updateRequestPromise;
    const commandK3 = studioRevisionUpdateCoreCommandSchema.parse(updateRequest.postDataJSON());
    expect(
      commandK3.expectedScope === identity.userId &&
        commandK3.payload.studioId === recoveryStudioId &&
        commandK3.payload.expectedEditVersion === committedPayload.studio.editVersion &&
        feat006CoreMatches(commandK3.payload.core, coreB),
    ).toBe(true);
    expect(commandK3.idempotencyKey !== commandK1.idempotencyKey).toBe(true);
    expect(commandK3.idempotencyKey !== commandK2.idempotencyKey).toBe(true);
    expect(browserCreatePosts).toBe(2);
    expect(browserUpdatePosts).toBe(1);
    expect(
      recovered.scope === identity.userId &&
        recovered.studio.id === recoveryStudioId &&
        recovered.studio.editVersion === committedPayload.studio.editVersion + 1 &&
        recovered.studio.status === "draft" &&
        recovered.studio.published === null &&
        recovered.studio.draft !== null &&
        recovered.studio.draft.revisionNumber === 1 &&
        feat006CoreMatches(recovered.studio.draft.core, coreB),
    ).toBe(true);

    await expect(
      recoveryPage.getByRole("heading", { level: 3, name: "Rascunho · revisão 1" }),
    ).toBeVisible();
    expect(
      new URL(recoveryPage.url()).pathname === `/dono/estudios/${recoveryStudioId}/dados`,
    ).toBe(true);
    await expectFeat006FormCore(recoveryPage, coreB);
    const aggregate = await readFeat006StudioDatabaseState(identity, recoveryStudioId);
    expect(
      aggregate.draft_revision_number === 1 &&
        aggregate.edit_version === 2 &&
        aggregate.owner_studio_rows === 1 &&
        aggregate.published_revision_id === null &&
        aggregate.published_revision_number === null &&
        aggregate.studio_status === "draft",
    ).toBe(true);
    expectFeat006DraftDatabaseCore(aggregate, coreB);
    expect(
      commandK1.payload.studioId === recoveryStudioId &&
        commandK2.payload.studioId === recoveryStudioId &&
        commandK3.payload.studioId === recoveryStudioId,
    ).toBe(true);
  } finally {
    await context?.close();
    await cleanupFeat006QaIdentity(identity);
  }
}

test("SL-F006-E2E-004 @p1 valida endereço e capacidade por teclado no mobile", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  expect([
    "compact-height-chromium",
    "desktop-chromium",
    "mobile-chromium-390",
    "narrow-chromium-320",
  ]).toContain(testInfo.project.name);
  const identity = createFeat006QaIdentity(testInfo, "004_mobile_validation");
  const core = createFeat006StudioCore("004_mobile_validation");
  let commandRequests = 0;

  try {
    await provisionFeat006Owner(page, identity);
    await gotoFeat006NewStudio(page);
    await fillFeat006StudioCore(page, core);
    await page.getByRole("textbox", { name: "Logradouro" }).fill("");
    const capacity = page.getByRole("spinbutton", { name: "Capacidade máxima de pessoas" });
    const save = page.getByRole("button", { name: "Salvar rascunho" });
    await capacity.fill("0");
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        commandRequests += 1;
      }
    });

    await capacity.focus();
    await expect(capacity).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Revise a seção Endereço", { exact: true })).toBeVisible();
    await expect(
      page.getByText("O logradouro precisa ter pelo menos 2 caracteres.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("A capacidade mínima é 1 pessoa.", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Logradouro" })).toBeFocused();
    expect(commandRequests).toBe(0);

    const geometry = await page.evaluate(() => ({
      body: document.body.scrollWidth <= window.innerWidth,
      document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }));
    expect(geometry).toEqual({ body: true, document: true });
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await page.getByRole("textbox", { name: "Logradouro" }).fill(core.address.street);
    await capacity.fill(String(core.capacity));
    const created = await createFeat006Studio(page, async () => {
      await capacity.focus();
      await expect(capacity).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(save).toBeFocused();
      await page.keyboard.press("Enter");
    });
    expect(commandRequests).toBe(1);
    await page.waitForURL(`/dono/estudios/${created.studio.id}/dados`);
  } finally {
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-005 @p1 conflito otimista mostra comparação e recuperação explícita", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  expect([
    "compact-height-chromium",
    "desktop-chromium",
    "mobile-chromium-390",
    "narrow-chromium-320",
  ]).toContain(testInfo.project.name);
  const identity = createFeat006QaIdentity(testInfo, "005_conflict");
  const initialCore = createFeat006StudioCore("005_initial");
  const concurrentCore = {
    ...initialCore,
    description: `${initialCore.description} Alteração concorrente qa_f006_005.`,
    name: `${initialCore.name}_concorrente`,
  };
  const attemptedCore = {
    ...initialCore,
    capacity: 15,
    description: `${initialCore.description} Minha tentativa qa_f006_005.`,
    name: `${initialCore.name}_tentativa`,
  };
  let concurrentContext: BrowserContext | undefined;
  let mainPosts = 0;

  try {
    await provisionFeat006Owner(page, identity);
    await gotoFeat006NewStudio(page);
    await fillFeat006StudioCore(page, initialCore);
    const created = await createFeat006Studio(page);
    const editorPath = `/dono/estudios/${created.studio.id}/dados`;
    await page.waitForURL(editorPath);
    await fillFeat006StudioCore(page, attemptedCore);

    concurrentContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      storageState: await page.context().storageState(),
    });
    const concurrentPage = await concurrentContext.newPage();
    const concurrentNavigation = await concurrentPage.goto(editorPath);
    expect(concurrentNavigation?.status()).toBe(200);
    await fillFeat006StudioCore(concurrentPage, concurrentCore);
    const concurrent = await updateFeat006Studio(concurrentPage);
    await expect(
      concurrentPage.getByText("Rascunho salvo com segurança.", { exact: true }),
    ).toBeVisible();

    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        mainPosts += 1;
      }
    });
    const conflictResponse = await waitForStudioCommand(page, "studio.revision.updateCore", () =>
      page.getByRole("button", { name: "Salvar rascunho" }).click(),
    );
    expect(conflictResponse.status()).toBe(409);
    expect(mainPosts).toBe(1);
    await expect(page.getByText("O rascunho mudou em outro lugar", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();

    await page.getByRole("button", { name: "Verificar e comparar" }).click();
    const comparison = page.getByRole("region", {
      name: "Compare antes de continuar",
      exact: true,
    });
    const currentSummary = comparison.getByRole("article").filter({
      has: page.getByRole("heading", { level: 3, name: "Versão atual", exact: true }),
    });
    const attemptedSummary = comparison.getByRole("article").filter({
      has: page.getByRole("heading", { level: 3, name: "Sua tentativa", exact: true }),
    });
    await expect(
      comparison.getByRole("heading", {
        level: 2,
        name: "Compare antes de continuar",
        exact: true,
      }),
    ).toBeFocused();
    await expect(currentSummary.getByText(concurrentCore.name, { exact: true })).toBeVisible();
    await expect(attemptedSummary.getByText(attemptedCore.name, { exact: true })).toBeVisible();
    expect(mainPosts).toBe(1);

    await page.getByRole("button", { name: "Reaplicar meus campos ao formulário" }).click();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(
      attemptedCore.name,
    );
    expect(mainPosts).toBe(1);

    const recoveredResponsePromise = waitForStudioCommandResponse(
      page,
      "studio.revision.updateCore",
    );
    const recovered = await updateFeat006Studio(page);
    expect((await recoveredResponsePromise).status()).toBe(200);
    expect(mainPosts).toBe(2);
    expect(
      recovered.scope === created.scope &&
        recovered.studio.id === created.studio.id &&
        recovered.studio.editVersion === concurrent.studio.editVersion + 1 &&
        recovered.studio.status === "draft" &&
        recovered.studio.draft !== null &&
        feat006CoreMatches(recovered.studio.draft.core, attemptedCore),
    ).toBe(true);
    await expect(page.getByText("Rascunho salvo com segurança.", { exact: true })).toBeVisible();
    await expectFeat006FormCore(page, attemptedCore);
    const recoveredAggregate = await readFeat006StudioDatabaseState(identity, created.studio.id);
    expect(
      recoveredAggregate.edit_version === concurrent.studio.editVersion + 1 &&
        recoveredAggregate.owner_studio_rows === 1 &&
        recoveredAggregate.studio_status === "draft",
    ).toBe(true);
    expectFeat006DraftDatabaseCore(recoveredAggregate, attemptedCore);

    await concurrentContext.close();
    concurrentContext = undefined;
    if (testInfo.project.name === "desktop-chromium") {
      await runAmbiguousCreateFoundRecovery(browser, new URL(page.url()).origin, testInfo);
    }
  } finally {
    await concurrentContext?.close();
    await cleanupFeat006QaIdentity(identity);
  }
});
