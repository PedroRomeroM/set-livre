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
  let updatePosts = 0;
  try {
    await provisionFeat006Owner(page, identity, "005");
    await fillFeat006Core(page);
    const editor = await createFeat006StudioThroughUi(page);
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/commands")
        return;
      const action = z.object({ action: z.string() }).safeParse(request.postDataJSON());
      if (action.success && action.data.action === "studio.revision.updateCore") updatePosts += 1;
    });

    await page.getByRole("textbox", { name: "Nome do estúdio" }).fill(localName);
    await page.getByRole("textbox", { name: "Número" }).fill("150");
    await mutateFeat006DraftForConflict(editor, {
      description: remoteDescription,
      name: remoteName,
    });

    const conflict = await saveFeat006StudioThroughUi(page);
    expect(conflict.response.status()).toBe(409);
    await expect(
      page.getByRole("heading", { level: 2, name: "Compare antes de continuar" }),
    ).toBeVisible();
    const comparison = page.getByRole("table", { name: "Diferenças do estúdio" });
    await expect(comparison.getByText(localName, { exact: true })).toBeVisible();
    await expect(comparison.getByText(remoteName, { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(localName);
    expect(updatePosts).toBe(1);

    await page.getByRole("button", { name: "Continuar com minhas alterações" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Compare antes de continuar" }),
    ).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Nome do estúdio" })).toHaveValue(localName);
    expect(updatePosts).toBe(1);

    const saved = await saveFeat006StudioThroughUi(page);
    expect(saved.response.status()).toBe(200);
    expect(saved.editor?.revision).toMatchObject({ name: localName, version: 3 });
    expect(updatePosts).toBe(2);
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
