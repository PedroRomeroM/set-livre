import { apiSuccessSchema, studioEditorSchema } from "@set-livre/contracts";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import {
  closeFeat006PageBeforeCleanup,
  cleanupFeat006QaIdentity,
  createFeat006QaIdentity,
  createFeat006StudioThroughUi,
  feat006DefaultCore,
  fillFeat006Core,
  mutateFeat006DraftForConflict,
  provisionFeat006Owner,
  readFeat006StudioEvidence,
  saveFeat006StudioThroughUi,
  setFeat006ProfileStatus,
  setFeat006StudioStatus,
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
    const editor = apiSuccessSchema(studioEditorSchema).parse(payload).data;

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
  const updateVersions: number[] = [];
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
      if (body.success && body.data.action === "studio.revision.updateCore") {
        updateVersions.push(body.data.payload.expectedRevisionVersion);
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

    const updateConflict = page.waitForResponse((response) => {
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return body.success && body.data.action === "studio.revision.updateCore";
    });
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    expect((await updateConflict).status()).toBe(409);
    expect(updateVersions).toEqual([1]);
    await expect(
      page.getByRole("heading", { level: 2, name: "Compare antes de continuar" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Usar versão salva" }).click();
    await expect(page.getByText("Versão de edição 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(
      "Rascunho concorrente para descarte",
    );

    await page.getByRole("button", { name: "Descartar rascunho" }).click();
    const successResponse = page.waitForResponse((response) => {
      const body = z.object({ action: z.string() }).safeParse(response.request().postDataJSON());
      return body.success && body.data.action === "studio.draft.discard";
    });
    await page.getByRole("button", { name: "Confirmar descarte" }).click();
    expect((await successResponse).status()).toBe(200);
    await expect(page.getByText("Rascunho descartado", { exact: true })).toBeVisible();
    const newFormLink = page.getByRole("link", { name: "Abrir novo formulário" });
    await expect(newFormLink).toBeVisible();
    await newFormLink.click();
    await expect(page).toHaveURL(/\/dono\/estudios\/novo$/u);
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
    await setFeat006StudioStatus(editor.studioId, "disabled");
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.getByText("Estúdio desabilitado", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Descartar rascunho" })).toHaveCount(0);
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
    const response = await rejectedRead;
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ACCOUNT_SUSPENDED" },
    });
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
