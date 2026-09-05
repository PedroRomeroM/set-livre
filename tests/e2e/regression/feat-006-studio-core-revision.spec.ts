import { randomUUID } from "node:crypto";

import {
  apiSuccessSchema,
  studioCreateCommandSchema,
  studioCommandResultSchema,
  studioEditorSchema,
  studioDraftDiscardCommandSchema,
  studioDraftDiscardResultSchema,
} from "@set-livre/contracts";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";

import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
  createFeat006QaIdentity,
  createFeat006StudioThroughUi,
  disableFeat006PublishedStudio,
  feat006DefaultCore,
  fillFeat006Core,
  mutateFeat006DraftForConflict,
  publishFeat006Studio,
  provisionFeat006Owner,
  readFeat006OwnedStudioCount,
  readFeat006StudioEvidence,
  saveFeat006StudioThroughUi,
  setFeat006ProfileStatus,
  setFeat006StudioTypeActive,
} from "../../helpers/feat-006-studio-core-revision";

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      body: document.body.scrollWidth <= window.innerWidth,
      document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    })),
  ).toEqual({ body: true, document: true });
}

test("SL-F006-E2E-004 @p1 valida endereço e capacidade sem sanitizar entrada inválida", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat006QaIdentity(testInfo, "004_validation");
  let studioPosts = 0;
  try {
    await provisionFeat006Owner(page, identity, "004");
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/commands" &&
        z.object({ action: z.string() }).safeParse(request.postDataJSON()).data?.action ===
          "studio.create"
      ) {
        studioPosts += 1;
      }
    });
    await fillFeat006Core(page, {
      capacity: "0",
      description: "Curta",
      name: "A",
      postalCode: "80010A000",
    });
    await page.getByRole("button", { name: "Criar estúdio em rascunho" }).click();

    await expect(page.getByText("Informe um nome com pelo menos 2 caracteres.")).toBeVisible();
    await expect(page.getByText("Descreva o estúdio com pelo menos 20 caracteres.")).toBeVisible();
    await expect(page.getByText("A capacidade mínima é 1 pessoa.")).toBeVisible();
    await expect(page.getByText("Informe um CEP válido com 8 dígitos.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "CEP" })).toHaveValue("80010A000");
    expect(studioPosts).toBe(0);
    await expectNoHorizontalOverflow(page);

    await fillFeat006Core(page);
    const editor = await createFeat006StudioThroughUi(page);
    expect(studioPosts).toBe(1);
    expect(editor.revision).toMatchObject({ capacity: 12, postalCode: "80010000" });
    await expectNoHorizontalOverflow(page);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-025 @p1 criação offline oferece recuperação antes de liberar o formulário", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat006QaIdentity(testInfo, "025_offline_creation");
  let sessionUnavailable = true;
  let sessionReads = 0;
  let createPosts = 0;
  try {
    await provisionFeat006Owner(page, identity, "025");
    await page.addInitScript(() => {
      if (window.location.pathname !== "/dono/estudios/novo") return;
      const addEventListener = window.addEventListener.bind(window);
      Object.defineProperty(window, "addEventListener", {
        configurable: true,
        value(
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) {
          addEventListener(type, listener, options);
          if (type === "offline") {
            window.addEventListener = addEventListener;
            window.dispatchEvent(new Event("offline"));
          }
        },
      });
    });
    await page.route("**/api/auth/session", async (route) => {
      sessionReads += 1;
      if (sessionUnavailable) await route.abort("failed");
      else await route.continue();
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        createPosts += 1;
      }
    });

    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Novo estúdio" })).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "Acesso de dono indisponível" }),
    ).toBeVisible();
    expect(sessionReads).toBeGreaterThan(0);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeEnabled();
    expect(createPosts).toBe(0);

    sessionUnavailable = false;
    await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeEnabled();
    await fillFeat006Core(page);
    await page.getByRole("button", { name: "Criar estúdio em rascunho" }).click();
    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toBeVisible();
    expect(createPosts).toBe(1);
    await expectNoHorizontalOverflow(page);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-027 @p1 editor e tipos recuperam offline e revalidam ao reconectar", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat006QaIdentity(testInfo, "027_offline_editor");
  let editorUnavailable = true;
  let typesUnavailable = true;
  let editorReads = 0;
  let typesReads = 0;
  let commandPosts = 0;
  try {
    await provisionFeat006Owner(page, identity, "027");
    await fillFeat006Core(page);
    const editor = await createFeat006StudioThroughUi(page);
    const editorPath = `/api/owner/studios/${editor.studioId}`;
    // SSR/session still work. Signal offline when TanStack subscribes, before hydrated queries.
    await page.addInitScript(() => {
      const addEventListener = window.addEventListener.bind(window);
      addEventListener("online", () => {
        document.documentElement.dataset.qaFeat006Network = "online";
      });
      Object.defineProperty(window, "addEventListener", {
        configurable: true,
        value(
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) {
          addEventListener(type, listener, options);
          if (type === "offline") {
            window.addEventListener = addEventListener;
            document.documentElement.dataset.qaFeat006Network = "offline";
            window.dispatchEvent(new Event("offline"));
          }
        },
      });
    });
    await page.route(`**${editorPath}`, async (route) => {
      editorReads += 1;
      if (editorUnavailable) await route.abort("failed");
      else await route.continue();
    });
    await page.route("**/api/studio-types", async (route) => {
      typesReads += 1;
      if (typesUnavailable) await route.abort("failed");
      else await route.continue();
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        commandPosts += 1;
      }
    });

    const navigation = await page.reload({ waitUntil: "domcontentloaded" });
    expect(navigation?.status()).toBe(200);
    const error = page
      .getByRole("alert")
      .filter({ hasText: "Não foi possível verificar o editor" });
    const retry = page.getByRole("button", { name: "Verificar novamente", exact: true });
    await expect(error).toBeVisible();
    // A paused query can show the same error without ever calling fetch: require real attempts.
    expect(editorReads).toBeGreaterThan(0);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(page.getByText(editor.revision.name, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Salvar rascunho" })).toHaveCount(0);
    await expect(retry).toBeEnabled();

    const readsBeforeFailure = editorReads;
    await retry.click();
    await expect.poll(() => editorReads).toBe(readsBeforeFailure + 1);
    await expect(error).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    await expect(retry).toBeEnabled();

    editorUnavailable = false;
    const readsBeforeRecovery = editorReads;
    await retry.click();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(
      editor.revision.name,
    );
    await expect(error).toHaveCount(0);
    expect(editorReads).toBe(readsBeforeRecovery + 1);

    // The editor is authoritative now, but cached types cannot unlock editing without their GET.
    expect(typesReads).toBeGreaterThan(0);
    const typesError = page
      .getByRole("alert")
      .filter({ hasText: "Não foi possível confirmar os tipos ativos" });
    const retryTypes = page.getByRole("button", {
      name: "Atualizar tipos de estúdio",
      exact: true,
    });
    const studioType = page.getByRole("combobox", { name: "Tipo de estúdio" });
    const save = page.getByRole("button", { name: "Salvar rascunho" });
    await expect(typesError).toBeVisible();
    await expect(studioType).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(retryTypes).toBeEnabled();

    const typesReadsBeforeFailure = typesReads;
    await retryTypes.click();
    await expect.poll(() => typesReads).toBe(typesReadsBeforeFailure + 1);
    await expect(typesError).toBeVisible();
    await expect(studioType).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(retryTypes).toBeEnabled();

    typesUnavailable = false;
    const typesReadsBeforeRecovery = typesReads;
    await retryTypes.click();
    await expect(studioType).toBeEnabled();
    await expect(studioType).toHaveValue(editor.studioType.id);
    await expect(save).toBeEnabled();
    await expect(typesError).toHaveCount(0);
    expect(typesReads).toBe(typesReadsBeforeRecovery + 1);
    expect(commandPosts).toBe(0);
    expect(await page.evaluate(() => document.documentElement.dataset.qaFeat006Network)).toBe(
      "offline",
    );

    // Network-always must retain automatic reconnect revalidation, without a focus event or click.
    const editorReadsBeforeReconnect = editorReads;
    const typesReadsBeforeReconnect = typesReads;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => editorReads).toBe(editorReadsBeforeReconnect + 1);
    await expect.poll(() => typesReads).toBe(typesReadsBeforeReconnect + 1);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(
      editor.revision.name,
    );
    await expect(studioType).toBeEnabled();
    await expect(studioType).toHaveValue(editor.studioType.id);
    await expect(save).toBeEnabled();
    expect(commandPosts).toBe(0);
    expect(await page.evaluate(() => document.documentElement.dataset.qaFeat006Network)).toBe(
      "online",
    );
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-005 @p1 conflito otimista compara versões e preserva a escolha local", async ({
  page,
}, testInfo) => {
  test.setTimeout(160_000);
  const identity = createFeat006QaIdentity(testInfo, "005_conflict");
  const localName = "Nome preservado pelo dono";
  const remoteName = "Nome salvo por outra sessão";
  const remoteDescription =
    "Descrição atualizada por outra sessão para produzir um conflito otimista verificável.";
  const submittedVersions: number[] = [];
  try {
    await provisionFeat006Owner(page, identity, "005");
    await fillFeat006Core(page);
    const editor = await createFeat006StudioThroughUi(page);
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands")
        return;
      const command = z
        .object({
          action: z.literal("studio.revision.updateCore"),
          payload: z.object({ expectedRevisionVersion: z.number().int().positive() }),
        })
        .safeParse(request.postDataJSON());
      if (command.success) submittedVersions.push(command.data.payload.expectedRevisionVersion);
    });

    await page.getByRole("textbox", { name: "Nome do estúdio" }).fill(localName);
    await page.getByRole("textbox", { name: "Número" }).fill("150");
    await mutateFeat006DraftForConflict(editor, {
      description: remoteDescription,
      name: remoteName,
      studioTypeId: "60000000-0000-4000-8000-000000000002",
    });

    const backgroundRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/owner/studios/${editor.studioId}` &&
        response.status() === 200,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await backgroundRead;
    await expect(page.getByText("Versão de edição 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(localName);

    let failedRecoveryReads = 0;
    await page.route(`**/api/owner/studios/${editor.studioId}`, async (route) => {
      if (route.request().method() === "GET" && failedRecoveryReads === 0) {
        failedRecoveryReads += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    const conflict = await saveFeat006StudioThroughUi(page);
    expect(conflict.response.status()).toBe(409);
    await expect(
      page.getByRole("heading", { level: 2, name: "Compare antes de continuar" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Verificar novamente" })).toBeVisible();
    const recoveredRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/owner/studios/${editor.studioId}` &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "Verificar novamente" }).click();
    await recoveredRead;
    expect(failedRecoveryReads).toBe(1);
    await expect(
      page.getByRole("heading", { level: 2, name: "Compare antes de continuar" }),
    ).toBeVisible();
    const comparison = page.getByRole("table", { name: "Diferenças do estúdio" });
    await expect(comparison.getByText(localName, { exact: true })).toBeVisible();
    await expect(comparison.getByText(remoteName, { exact: true })).toBeVisible();
    await expect(comparison.getByText("Estúdio audiovisual", { exact: true })).toBeVisible();
    await expect(comparison.getByText("Estúdio fotográfico", { exact: true })).toBeVisible();
    await expect(
      comparison.getByText("60000000-0000-4000-8000-000000000002", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(localName);
    if ((page.viewportSize()?.width ?? 0) <= 576) {
      await expect(
        comparison.locator('[aria-hidden="true"]', { hasText: "Sua versão" }).first(),
      ).toBeVisible();
      await expect(
        comparison.locator('[aria-hidden="true"]', { hasText: "Versão salva" }).first(),
      ).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
    expect(submittedVersions).toEqual([1]);

    await page.getByRole("button", { name: "Continuar com minhas alterações" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Compare antes de continuar" }),
    ).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(localName);
    expect(submittedVersions).toEqual([1]);

    const saved = await saveFeat006StudioThroughUi(page);
    expect(saved.response.status()).toBe(200);
    expect(saved.editor?.revision).toMatchObject({ name: localName, version: 3 });
    expect(submittedVersions).toEqual([1, 2]);
    await expect(
      page.getByText("Rascunho salvo com a versão canônica mais recente."),
    ).toBeVisible();

    const evidence = await readFeat006StudioEvidence(editor.studioId);
    expect(evidence.revisions).toEqual([
      expect.objectContaining({
        description: feat006DefaultCore.description,
        name: localName,
        status: "draft",
        version: 3,
      }),
    ]);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-009 @p1 criação concluída entra em estado terminal antes de navegar", async ({
  page,
}, testInfo) => {
  test.setTimeout(170_000);
  const identity = createFeat006QaIdentity(testInfo, "009_navigation");
  let allowEditorNavigation = false;
  let blockedNavigations = 0;
  let createPosts = 0;
  try {
    await provisionFeat006Owner(page, identity, "009");
    await fillFeat006Core(page);
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return;
      }
      const body = z.object({ action: z.string() }).safeParse(request.postDataJSON());
      if (body.success && body.data.action === "studio.create") createPosts += 1;
    });
    await page.route("**/dono/estudios/*/dados*", async (route) => {
      if (route.request().method() !== "GET" || allowEditorNavigation) {
        await route.continue();
        return;
      }
      blockedNavigations += 1;
      await route.abort("failed");
    });

    const createResponse = page.waitForResponse((response) => {
      if (response.request().method() !== "POST") return false;
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return (
        new URL(response.url()).pathname === "/api/commands" &&
        body.success &&
        body.data.action === "studio.create"
      );
    });
    await page.getByRole("button", { name: "Criar estúdio em rascunho" }).click();
    const response = await createResponse;
    expect(response.status()).toBe(200);
    const payload: unknown = await response.json();
    const editor = apiSuccessSchema(studioCommandResultSchema(studioEditorSchema)).parse(payload)
      .data.result;

    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Criar estúdio em rascunho" })).toBeDisabled();
    expect(createPosts).toBe(1);
    expect(blockedNavigations).toBe(0);

    allowEditorNavigation = true;
    await page.getByRole("button", { name: "Abrir editor criado" }).click();
    await expect(page).toHaveURL(new RegExp(`/dono/estudios/${editor.studioId}/dados$`, "u"));
    await expect(page.getByText("Rascunho privado", { exact: true })).toBeVisible();
    expect(createPosts).toBe(1);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-026 @p1 criação resolvida descartada em outra aba permite novo cadastro explícito sem duplicar", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat006QaIdentity(testInfo, "026_stale_resolved_creation");
  const submittedCommands: Array<z.infer<typeof studioCreateCommandSchema>> = [];
  let createdStudioId: string | undefined;
  let otherTab: Page | undefined;
  try {
    await provisionFeat006Owner(page, identity, "026");
    const userId = z.uuid().parse(identity.userId);
    const storageKey = `set-livre:studio-create:v1:${userId}`;
    const readRecovery = () =>
      page.evaluate((key) => {
        const value = window.sessionStorage.getItem(key);
        return value === null ? null : (JSON.parse(value) as unknown);
      }, storageKey);
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return;
      }
      const command = studioCreateCommandSchema.safeParse(request.postDataJSON());
      if (command.success) submittedCommands.push(command.data);
    });
    await fillFeat006Core(page);
    await page.route(
      "**/api/commands",
      async (route) => {
        const command = studioCreateCommandSchema.parse(route.request().postDataJSON());
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const result = apiSuccessSchema(studioCommandResultSchema(studioEditorSchema)).parse(
          await response.json(),
        ).data;
        expect(result.idempotencyKey).toBe(command.idempotencyKey);
        expect(result.result.scope).toBe(userId);
        createdStudioId = result.result.studioId;
        // Only the real response is lost; the production command has already committed.
        await route.abort("failed");
      },
      { times: 1 },
    );

    await page.getByRole("button", { name: "Criar estúdio em rascunho" }).click();
    await expect(
      page.getByText("Não foi possível conectar. Verifique sua internet e tente novamente."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Iniciar outro cadastro" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Criar estúdio em rascunho" })).toBeDisabled();
    expect(await readRecovery()).toEqual({
      command: submittedCommands[0],
      createdStudioId: null,
      version: 1,
    });
    expect(submittedCommands).toHaveLength(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toBeVisible();
    const studioId = z.uuid().parse(createdStudioId);
    const resolved = { command: submittedCommands[0], createdStudioId: studioId, version: 1 };
    expect(await readRecovery()).toEqual(resolved);
    expect(submittedCommands).toHaveLength(2);
    expect(submittedCommands[1]).toEqual(submittedCommands[0]);
    expect(await readFeat006OwnedStudioCount(userId)).toBe(1);

    // Same real login, separate tab storage: consuming the editor here cannot clear the first tab.
    otherTab = await page.context().newPage();
    await otherTab.goto(`/dono/estudios/${studioId}/dados`);
    await expect(otherTab.getByRole("textbox", { name: "Nome do estúdio" })).toBeEnabled();
    expect(
      await otherTab.evaluate((key) => window.sessionStorage.getItem(key), storageKey),
    ).toBeNull();
    const discardResponse = otherTab.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/commands" &&
        studioDraftDiscardCommandSchema.safeParse(response.request().postDataJSON()).success,
    );
    await otherTab.getByRole("button", { name: "Descartar rascunho" }).click();
    await otherTab.getByRole("button", { name: "Confirmar descarte" }).click();
    const discarded = await discardResponse;
    expect(discarded.status()).toBe(200);
    expect(
      apiSuccessSchema(studioCommandResultSchema(studioDraftDiscardResultSchema)).parse(
        await discarded.json(),
      ).data.result,
    ).toMatchObject({ scope: userId, studioDeleted: true, studioId });
    await expect(otherTab.getByText("Rascunho descartado", { exact: true })).toBeVisible();
    expect(await readFeat006OwnedStudioCount(userId)).toBe(0);
    expect(await readRecovery()).toEqual(resolved);

    await page.getByRole("button", { name: "Abrir editor criado" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Estúdio não encontrado" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Edição do estúdio" })).toHaveCount(0);
    await page.getByRole("link", { name: "Criar outro estúdio" }).click();
    await expect(page).toHaveURL(/\/dono\/estudios\/novo$/u);
    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
    expect(await readRecovery()).toEqual(resolved);
    expect(submittedCommands).toHaveLength(2);

    const startAnother = page.getByRole("button", { name: "Iniciar outro cadastro" });
    await expect(startAnother).toBeEnabled();
    await startAnother.click();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue("");
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeFocused();
    expect(await readRecovery()).toBeNull();
    expect(submittedCommands).toHaveLength(2);
    expect(await readFeat006OwnedStudioCount(userId)).toBe(0);
    await expectNoHorizontalOverflow(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue("");
    expect(submittedCommands).toHaveLength(2);

    await fillFeat006Core(page, { name: "Estúdio QA após descarte em outra aba" });
    const newEditor = await createFeat006StudioThroughUi(page);
    expect(newEditor.studioId).not.toBe(studioId);
    expect(submittedCommands).toHaveLength(3);
    expect(submittedCommands[2]?.idempotencyKey).not.toBe(submittedCommands[0]?.idempotencyKey);
    expect(await readFeat006OwnedStudioCount(userId)).toBe(1);
    expect((await readFeat006StudioEvidence(newEditor.studioId)).revisions).toHaveLength(1);
    await expect.poll(readRecovery).toBeNull();
  } finally {
    if (otherTab !== undefined) await closeFeat006PageBeforeCleanup(otherTab);
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-010 @p1 retry ambíguo congela campos e reutiliza o payload original", async ({
  page,
}, testInfo) => {
  test.setTimeout(170_000);
  const identity = createFeat006QaIdentity(testInfo, "010_ambiguous");
  const submittedCommands: unknown[] = [];
  try {
    await provisionFeat006Owner(page, identity, "010");
    await fillFeat006Core(page);
    await createFeat006StudioThroughUi(page);
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return;
      }
      const body = z.object({ action: z.string() }).safeParse(request.postDataJSON());
      if (body.success && body.data.action === "studio.revision.updateCore") {
        submittedCommands.push(request.postDataJSON());
      }
    });
    await page.route(
      "**/api/commands",
      async (route) => {
        const body = z.object({ action: z.string() }).parse(route.request().postDataJSON());
        expect(body.action).toBe("studio.revision.updateCore");
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("failed");
      },
      { times: 1 },
    );

    const savedName = "Nome confirmado apesar da resposta perdida";
    await page.getByRole("textbox", { name: "Nome do estúdio" }).fill(savedName);
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await expect(
      page.getByText("Não foi possível conectar. Verifique sua internet e tente novamente."),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar tags e comodidades" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar regras, FAQ e vídeo" })).toBeDisabled();

    const retryResponse = page.waitForResponse((response) => {
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/commands" &&
        body.success &&
        body.data.action === "studio.revision.updateCore"
      );
    });
    await page.getByRole("button", { name: "Repetir a mesma solicitação com segurança" }).click();
    expect((await retryResponse).status()).toBe(200);
    await expect.poll(() => submittedCommands.length).toBe(2);
    expect(submittedCommands[1]).toEqual(submittedCommands[0]);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(savedName);
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toBeEnabled();
    await expect(
      page.getByText("Rascunho salvo com a versão canônica mais recente."),
    ).toBeVisible();
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-011 @p1 conflito de descarte exige releitura e nova confirmação", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat006QaIdentity(testInfo, "011_discard_conflict");
  const discardCommands: Array<{ expectedRevisionVersion: number; idempotencyKey: string }> = [];
  try {
    await provisionFeat006Owner(page, identity, "011");
    await fillFeat006Core(page);
    const editor = await createFeat006StudioThroughUi(page);
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return;
      }
      const body = z
        .object({
          action: z.string(),
          idempotencyKey: z.string(),
          payload: z.object({ expectedRevisionVersion: z.number().int().positive() }),
        })
        .safeParse(request.postDataJSON());
      if (body.success && body.data.action === "studio.draft.discard") {
        discardCommands.push({
          expectedRevisionVersion: body.data.payload.expectedRevisionVersion,
          idempotencyKey: body.data.idempotencyKey,
        });
      }
    });

    await page.getByRole("button", { name: "Descartar rascunho" }).click();
    await mutateFeat006DraftForConflict(editor, {
      description: "Versão concorrente usada para invalidar a primeira confirmação de descarte.",
      name: "Rascunho concorrente para descarte",
    });
    const backgroundRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/owner/studios/${editor.studioId}` &&
        response.status() === 200,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    const backgroundPayload = z
      .object({ data: z.object({ revision: z.object({ version: z.number().int().positive() }) }) })
      .parse(await (await backgroundRead).json());
    expect(backgroundPayload.data.revision.version).toBe(2);
    await expect(page.getByText("Versão de edição 1", { exact: true })).toBeVisible();
    const conflictResponse = page.waitForResponse((response) => {
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return body.success && body.data.action === "studio.draft.discard";
    });
    let failedDiscardRecoveryReads = 0;
    await page.route(`**/api/owner/studios/${editor.studioId}`, async (route) => {
      if (route.request().method() === "GET" && failedDiscardRecoveryReads === 0) {
        failedDiscardRecoveryReads += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "Confirmar descarte" }).click();
    expect((await conflictResponse).status()).toBe(409);
    await expect(page.getByRole("group", { name: "Confirmar descarte" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Verificar novamente" })).toBeVisible();
    const recoveredDiscardRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/owner/studios/${editor.studioId}` &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: "Verificar novamente" }).click();
    await recoveredDiscardRead;
    expect(failedDiscardRecoveryReads).toBe(1);
    await expect(page.getByText("Versão de edição 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(
      feat006DefaultCore.name,
    );
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Revise o rascunho atual antes de descartar",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Diferenças do rascunho antes do descarte" }),
    ).toContainText("Rascunho concorrente para descarte");
    await expect(page.getByRole("button", { name: "Descartar rascunho" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toBeDisabled();
    expect(discardCommands).toHaveLength(1);

    await page.getByRole("button", { name: "Recarregar rascunho atual" }).click();
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Revise o rascunho atual antes de descartar",
      }),
    ).toHaveCount(0);
    await expect(page.getByText("Versão de edição 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(
      "Rascunho concorrente para descarte",
    );
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toBeEnabled();

    await page.getByRole("button", { name: "Descartar rascunho" }).click();
    const successResponse = page.waitForResponse((response) => {
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return body.success && body.data.action === "studio.draft.discard";
    });
    await page.getByRole("button", { name: "Confirmar descarte" }).click();
    expect((await successResponse).status()).toBe(200);
    await expect(page.getByText("Rascunho descartado", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Edição do estúdio" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveCount(0);
    const newFormLink = page.getByRole("link", { name: "Abrir novo formulário" });
    await expect(newFormLink).toBeVisible();
    await newFormLink.click();
    await expect(page).toHaveURL(/\/dono\/estudios\/novo$/u);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue("");
    expect(discardCommands).toHaveLength(2);
    expect(discardCommands.map((command) => command.expectedRevisionVersion)).toEqual([1, 2]);
    expect(discardCommands[1]?.idempotencyKey).not.toBe(discardCommands[0]?.idempotencyKey);
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-012 @p1 estúdio desabilitado permanece estritamente somente leitura", async ({
  page,
}, testInfo) => {
  test.setTimeout(160_000);
  const identity = createFeat006QaIdentity(testInfo, "012_disabled");
  try {
    await provisionFeat006Owner(page, identity, "012");
    await fillFeat006Core(page);
    const editor = await createFeat006StudioThroughUi(page);
    await publishFeat006Studio(editor);
    await disableFeat006PublishedStudio(editor.studioId);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByText("Estúdio desabilitado", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /Criar rascunho e salvar|Salvar rascunho/iu }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Descartar rascunho" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar tags e comodidades" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar regras, FAQ e vídeo" })).toBeDisabled();
    await expect(page.getByRole("link", { exact: true, name: "Novo estúdio" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-013 @p1 arquivamento concorrente recupera editor e exige seleção ativa", async ({
  page,
}, testInfo) => {
  test.setTimeout(170_000);
  const identity = createFeat006QaIdentity(testInfo, "013_archived_type");
  let typeArchived = false;
  try {
    await provisionFeat006Owner(page, identity, "013");
    await fillFeat006Core(page);
    await createFeat006StudioThroughUi(page);
    await setFeat006StudioTypeActive(feat006DefaultCore.studioTypeId, false);
    typeArchived = true;

    const rejected = await saveFeat006StudioThroughUi(page);
    expect(rejected.response.status()).toBe(409);
    expect(rejected.payload).toMatchObject({ error: { code: "STUDIO_TYPE_UNAVAILABLE" } });
    await expect(
      page.getByText(
        "O tipo de estúdio foi arquivado. Atualize as opções e escolha um tipo ativo.",
      ),
    ).toBeVisible();

    const typeSelect = page.getByRole("combobox", { name: "Tipo de estúdio" });
    await expect(typeSelect).toHaveValue("");
    await expect(typeSelect.getByRole("option", { name: /arquivado/iu })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();

    await typeSelect.selectOption("60000000-0000-4000-8000-000000000002");
    const saved = await saveFeat006StudioThroughUi(page);
    expect(saved.response.status()).toBe(200);
    expect(saved.editor?.revision.studioTypeId).toBe("60000000-0000-4000-8000-000000000002");
  } finally {
    if (typeArchived) {
      await setFeat006StudioTypeActive(feat006DefaultCore.studioTypeId, true);
    }
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-014 @p1 arquivamento concorrente recupera criação sem repetir falha", async ({
  page,
}, testInfo) => {
  test.setTimeout(170_000);
  const identity = createFeat006QaIdentity(testInfo, "014_create_archived_type");
  let typeArchived = false;
  try {
    await provisionFeat006Owner(page, identity, "014");
    await fillFeat006Core(page);
    await setFeat006StudioTypeActive(feat006DefaultCore.studioTypeId, false);
    typeArchived = true;

    const rejectedResponse = page.waitForResponse((response) => {
      if (
        response.request().method() !== "POST" ||
        new URL(response.url()).pathname !== "/api/commands"
      ) {
        return false;
      }
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return body.success && body.data.action === "studio.create";
    });
    await page.getByRole("button", { name: "Criar estúdio em rascunho" }).click();
    const rejected = await rejectedResponse;
    expect(rejected.status()).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "STUDIO_TYPE_UNAVAILABLE" },
    });

    const typeSelect = page.getByRole("combobox", { name: "Tipo de estúdio" });
    await expect(typeSelect).toHaveValue("");
    await expect(page.getByRole("button", { name: "Criar estúdio em rascunho" })).toBeDisabled();
    await typeSelect.selectOption("60000000-0000-4000-8000-000000000002");
    const editor = await createFeat006StudioThroughUi(page);
    expect(editor.revision.studioTypeId).toBe("60000000-0000-4000-8000-000000000002");
  } finally {
    if (typeArchived) {
      await setFeat006StudioTypeActive(feat006DefaultCore.studioTypeId, true);
    }
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

test("SL-F006-E2E-015 @p1 revogação de conta recompõe o editor antes de nova ação", async ({
  page,
}, testInfo) => {
  test.setTimeout(170_000);
  const identity = createFeat006QaIdentity(testInfo, "015_revoked_account");
  let profileSuspended = false;
  try {
    await provisionFeat006Owner(page, identity, "015");
    await fillFeat006Core(page);
    const editor = await createFeat006StudioThroughUi(page);
    if (identity.userId === undefined) throw new Error("A identidade FEAT-006 não possui escopo.");
    await setFeat006ProfileStatus(identity.userId, "suspended");
    profileSuspended = true;

    const rejectedRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/owner/studios/${editor.studioId}` &&
        response.status() === 403,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await rejectedRead;
    await expect(page.getByText("Conta suspensa", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
  } finally {
    if (profileSuspended && identity.userId !== undefined) {
      await setFeat006ProfileStatus(identity.userId, "active");
    }
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});

async function expectCreationResponseBoundary(
  page: Page,
  testInfo: TestInfo,
  scenario: "020" | "022",
) {
  test.setTimeout(180_000);
  const identity = createFeat006QaIdentity(testInfo, `${scenario}_create_response_boundary`);
  const submittedCommands: unknown[] = [];
  let unrelatedStudioId: string = randomUUID();
  let committedStudioId: string | undefined;
  page.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") return;
    const command = studioCreateCommandSchema.safeParse(request.postDataJSON());
    if (command.success) submittedCommands.push(command.data);
  });
  try {
    await provisionFeat006Owner(page, identity, scenario);
    if (identity.userId === undefined)
      throw new Error("A criação QA não possui escopo autenticado.");
    await fillFeat006Core(page);
    if (scenario === "022") {
      const uppercaseKey = `ABCDEF01${randomUUID().slice(8).toUpperCase()}`;
      await page.evaluate((key) => {
        Object.defineProperty(window.crypto, "randomUUID", {
          configurable: true,
          value: () => key,
        });
      }, uppercaseKey);
    }
    await page.route(
      "**/api/commands",
      async (route) => {
        const command = studioCreateCommandSchema.parse(route.request().postDataJSON());
        const response = await route.fetch();
        if (scenario === "022")
          expect(await readFeat006OwnedStudioCount(command.expectedScope)).toBe(1);
        expect(response.status()).toBe(200);
        const payload = apiSuccessSchema(studioCommandResultSchema(studioEditorSchema)).parse(
          await response.json(),
        );
        committedStudioId = payload.data.result.studioId;
        expect(payload.data.action).toBe(command.action);
        expect(payload.data.idempotencyKey).toBe(command.idempotencyKey.toLowerCase());
        if (scenario === "022") {
          expect(command.idempotencyKey).toMatch(/^ABCDEF01-/u);
          const unrelatedResponse = await route.fetch({
            postData: JSON.stringify({ ...command, idempotencyKey: randomUUID() }),
          });
          expect(unrelatedResponse.status()).toBe(200);
          const unrelated = apiSuccessSchema(studioCommandResultSchema(studioEditorSchema)).parse(
            await unrelatedResponse.json(),
          );
          expect(unrelated.data.result.scope).toBe(identity.userId);
          expect(unrelated.data.idempotencyKey).not.toBe(command.idempotencyKey.toLowerCase());
          unrelatedStudioId = unrelated.data.result.studioId;
          expect(unrelatedStudioId).not.toBe(committedStudioId);
          await route.fulfill({ response: unrelatedResponse });
          return;
        }
        await route.fulfill({
          response,
          json: {
            ...payload,
            data: {
              ...payload.data,
              result: {
                ...payload.data.result,
                scope: randomUUID(),
                studioId: unrelatedStudioId,
              },
            },
          },
        });
      },
      { times: 1 },
    );

    await page.getByRole("button", { name: "Criar estúdio em rascunho" }).click();
    await expect(page.getByText("O servidor enviou dados de estúdio inesperados.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Criar estúdio em rascunho" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
    expect(submittedCommands).toHaveLength(1);
    const recovery = await page.evaluate((scope) => {
      const serialized = window.sessionStorage.getItem(`set-livre:studio-create:v1:${scope}`);
      return serialized === null ? null : (JSON.parse(serialized) as unknown);
    }, identity.userId);
    expect(recovery).toEqual({
      command: submittedCommands[0],
      createdStudioId: null,
      version: 1,
    });
    expect(JSON.stringify(recovery)).not.toContain(unrelatedStudioId);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toBeVisible();
    expect(submittedCommands).toHaveLength(2);
    expect(submittedCommands[1]).toEqual(submittedCommands[0]);
    if (committedStudioId === undefined)
      throw new Error("A criação QA não publicou a identidade canônica.");
    expect((await readFeat006StudioEvidence(committedStudioId)).revisions).toHaveLength(1);
    const resolvedRecovery = await page.evaluate((scope) => {
      const serialized = window.sessionStorage.getItem(`set-livre:studio-create:v1:${scope}`);
      return serialized === null ? null : (JSON.parse(serialized) as unknown);
    }, identity.userId);
    expect(resolvedRecovery).toEqual({
      command: submittedCommands[0],
      createdStudioId: committedStudioId,
      version: 1,
    });
    await page.getByRole("button", { name: "Abrir editor criado" }).click();
    await expect(page).toHaveURL(new RegExp(`/dono/estudios/${committedStudioId}/dados$`, "u"));
    await expect(page.getByRole("navigation", { name: "Edição do estúdio" })).toBeVisible();
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
}

test("SL-F006-E2E-020 @p1 criação rejeita escopo alheio sem contaminar recovery e reconcilia após reload", async ({
  page,
}, testInfo) => {
  await expectCreationResponseBoundary(page, testInfo, "020");
});

test("SL-F006-E2E-022 @p1 criação rejeita outra tentativa do mesmo dono e recupera a intenção original", async ({
  page,
}, testInfo) => {
  await expectCreationResponseBoundary(page, testInfo, "022");
});

async function expectCreationStorageRecovery(
  page: Page,
  testInfo: TestInfo,
  scenario: "023" | "024",
) {
  test.setTimeout(180_000);
  const identity = createFeat006QaIdentity(testInfo, `${scenario}_creation_storage_quota`);
  const submittedCommands: Array<z.infer<typeof studioCreateCommandSchema>> = [];
  const failedConfirmations = scenario === "024" ? 2 : 1;
  let committedStudioId: string | undefined;
  try {
    await provisionFeat006Owner(page, identity, scenario);
    const userId = z.uuid().parse(identity.userId);
    const storageKey = `set-livre:studio-create:v1:${userId}`;
    const readRecovery = () =>
      page.evaluate((key) => {
        const serialized = window.sessionStorage.getItem(key);
        return serialized === null ? null : (JSON.parse(serialized) as unknown);
      }, storageKey);
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands") {
        return;
      }
      const command = studioCreateCommandSchema.safeParse(request.postDataJSON());
      if (command.success) submittedCommands.push(command.data);
    });
    await fillFeat006Core(page);
    await page.route(
      "**/api/commands",
      async (route) => {
        const command = studioCreateCommandSchema.parse(route.request().postDataJSON());
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const result = apiSuccessSchema(studioCommandResultSchema(studioEditorSchema)).parse(
          await response.json(),
        ).data;
        expect(result.action).toBe(command.action);
        expect(result.idempotencyKey).toBe(command.idempotencyKey);
        expect(result.result.scope).toBe(userId);
        committedStudioId ??= result.result.studioId;
        expect(result.result.studioId).toBe(committedStudioId);
        expect(await readRecovery()).toEqual({ command, createdStudioId: null, version: 1 });

        // The pending command is durable and the real POST has committed before quota fails.
        await page.evaluate((key) => {
          const originalSetItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function (itemKey: string, value: string) {
            if (this === window.sessionStorage && itemKey === key) {
              throw new DOMException("QA storage quota exhausted", "QuotaExceededError");
            }
            originalSetItem.call(this, itemKey, value);
          };
          window.addEventListener(
            "qa:restore-studio-creation-storage",
            () => {
              Storage.prototype.setItem = originalSetItem;
            },
            { once: true },
          );
        }, storageKey);
        await route.fulfill({ response });
      },
      { times: failedConfirmations },
    );

    await page.getByRole("button", { name: "Criar estúdio em rascunho" }).click();
    const blocked = page
      .getByRole("alert")
      .filter({ hasText: "Criação protegida contra duplicação" });
    await expect(blocked).toBeVisible();
    if (scenario === "024") {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(blocked).toBeVisible();
    }
    await expect(blocked).toContainText("Seu estúdio foi criado");
    await expect(page.getByText("Estúdio salvo", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Criar estúdio em rascunho" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Iniciar outro cadastro" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveCount(0);
    expect(submittedCommands).toHaveLength(failedConfirmations);
    for (const command of submittedCommands) expect(command).toEqual(submittedCommands[0]);
    expect(await readFeat006OwnedStudioCount(userId)).toBe(1);

    const retry = page.getByRole("button", { name: "Tentar concluir recuperação" });
    await retry.click();
    await expect(blocked).toBeVisible();
    expect(await readRecovery()).toEqual({
      command: submittedCommands[0],
      createdStudioId: null,
      version: 1,
    });
    expect(submittedCommands).toHaveLength(failedConfirmations);

    await page.evaluate(() =>
      window.dispatchEvent(new Event("qa:restore-studio-creation-storage")),
    );
    await retry.click();
    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toBeVisible();
    await expect(blocked).toHaveCount(0);
    expect(await readRecovery()).toEqual({
      command: submittedCommands[0],
      createdStudioId: committedStudioId,
      version: 1,
    });
    expect(submittedCommands).toHaveLength(failedConfirmations);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Abrir editor criado" })).toBeVisible();
    expect(submittedCommands).toHaveLength(failedConfirmations);
    await page.getByRole("button", { name: "Abrir editor criado" }).click();
    await expect(page).toHaveURL(new RegExp(`/dono/estudios/${committedStudioId}/dados$`, "u"));
    await expect(page.getByRole("navigation", { name: "Edição do estúdio" })).toBeVisible();
    await expect.poll(readRecovery).toBeNull();

    await page.goto("/dono/estudios/novo");
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue("");
    await fillFeat006Core(page, { name: "Novo estúdio QA independente após recuperação" });
    const independentEditor = await createFeat006StudioThroughUi(page);
    expect(independentEditor.studioId).not.toBe(committedStudioId);
    expect(independentEditor.revision.name).toBe("Novo estúdio QA independente após recuperação");
    expect(submittedCommands).toHaveLength(failedConfirmations + 1);
    expect(submittedCommands.at(-1)?.idempotencyKey).not.toBe(submittedCommands[0]?.idempotencyKey);
    expect(await readFeat006OwnedStudioCount(userId)).toBe(2);
    await expect.poll(readRecovery).toBeNull();
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
}

test("SL-F006-E2E-023 @p0 quota após POST bloqueia confirmação e recupera sem reenviar criação", async ({
  page,
}, testInfo) => {
  await expectCreationStorageRecovery(page, testInfo, "023");
});

test("SL-F006-E2E-024 @p0 reload durante falha de quota reconcilia o comando original sem duplicar", async ({
  page,
}, testInfo) => {
  await expectCreationStorageRecovery(page, testInfo, "024");
});

test("SL-F006-E2E-021 @p1 descarte rejeita escopo e estúdio divergentes antes de remover painéis", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat006QaIdentity(testInfo, "021_discard_response_boundary");
  const submittedCommands: unknown[] = [];
  let corruptedResponses = 0;
  try {
    await provisionFeat006Owner(page, identity, "021");
    await fillFeat006Core(page);
    const editor = await createFeat006StudioThroughUi(page);
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands")
        return;
      const command = studioDraftDiscardCommandSchema.safeParse(request.postDataJSON());
      if (command.success) submittedCommands.push(command.data);
    });
    await page.route(
      "**/api/commands",
      async (route) => {
        studioDraftDiscardCommandSchema.parse(route.request().postDataJSON());
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const payload = apiSuccessSchema(
          studioCommandResultSchema(studioDraftDiscardResultSchema),
        ).parse(await response.json());
        expect(payload.data.result).toMatchObject({
          scope: identity.userId,
          studioDeleted: true,
          studioId: editor.studioId,
        });
        const wrongBoundary =
          corruptedResponses === 0 ? { scope: randomUUID() } : { studioId: randomUUID() };
        corruptedResponses += 1;
        await route.fulfill({
          response,
          json: {
            ...payload,
            data: { ...payload.data, result: { ...payload.data.result, ...wrongBoundary } },
          },
        });
      },
      { times: 2 },
    );

    await page.getByRole("button", { name: "Descartar rascunho" }).click();
    await page.getByRole("button", { name: "Confirmar descarte" }).click();
    for (const attempt of [1, 2]) {
      await expect(page.getByText("O servidor enviou dados de estúdio inesperados.")).toBeVisible();
      expect(corruptedResponses).toBe(attempt);
      await expect(page.getByText("Rascunho descartado", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Edição do estúdio" })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(
        feat006DefaultCore.name,
      );
      await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
      await expect(page.getByRole("textbox", { name: "Regras de uso" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Salvar tags e comodidades" })).toBeDisabled();
      const replay = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/commands" &&
          studioDraftDiscardCommandSchema.safeParse(response.request().postDataJSON()).success,
      );
      await page.getByRole("button", { name: "Repetir a mesma solicitação com segurança" }).click();
      expect((await replay).status()).toBe(200);
    }
    await expect(page.getByText("Rascunho descartado", { exact: true })).toBeVisible();
    expect(submittedCommands).toHaveLength(3);
    expect(submittedCommands[1]).toEqual(submittedCommands[0]);
    expect(submittedCommands[2]).toEqual(submittedCommands[0]);
    await expect(page.getByRole("navigation", { name: "Edição do estúdio" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Regras de uso" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Abrir novo formulário" })).toHaveAttribute(
      "href",
      "/dono/estudios/novo",
    );
    await page.getByRole("link", { name: "Abrir novo formulário" }).click();
    await expect(page).toHaveURL(/\/dono\/estudios\/novo$/u);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue("");
  } finally {
    await closeFeat006PageBeforeCleanup(page);
    await cleanupFeat006QaIdentity(identity);
  }
});
