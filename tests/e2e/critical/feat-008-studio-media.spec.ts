import { expect, test, type BrowserContext } from "@playwright/test";

import {
  closeFeat008PageBeforeCleanup,
  cleanupFeat008QaIdentity,
  createFeat008QaIdentity,
  expectFeat008StorageIsolation,
  feat008OversizedPngFile,
  feat008PngFile,
  feat008SpoofedPngFile,
  observeFeat008MediaActions,
  provisionFeat008Studio,
  provisionFeat008StudioWithHarness,
  uploadFeat008Photos,
} from "../../helpers/feat-008-studio-media";
import { provisionFeat006Owner } from "../../helpers/feat-006-studio-core-revision";

test("SL-F008-E2E-001 @p0 upload sequencial, capa, ordem e exclusão usam a UI privada", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat008QaIdentity(testInfo, "001_owner_journey");
  try {
    await provisionFeat008Studio(page, identity, "801");
    const actions = observeFeat008MediaActions(page);
    await page.evaluate(() => {
      const announcements: string[] = [];
      Object.defineProperty(window, "__setLivreFeat008Announcements", {
        configurable: true,
        value: announcements,
      });
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const candidates = [
              ...(node.matches('[role="status"][aria-live="polite"]') ? [node] : []),
              ...node.querySelectorAll<HTMLElement>('[role="status"][aria-live="polite"]'),
            ];
            for (const candidate of candidates) {
              const text = candidate.textContent?.trim();
              if (text?.includes("adicionada à galeria privada") === true) {
                announcements.push(text);
              }
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page
      .getByLabel("Selecionar fotos")
      .setInputFiles([feat008PngFile("sala-a.png"), feat008PngFile("sala-b.png")]);
    await expect(page.getByText("2 de 20 fotos", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __setLivreFeat008Announcements: string[];
            }
          ).__setLivreFeat008Announcements,
      ),
    ).toEqual([
      "Foto sala-a.png adicionada à galeria privada.",
      "Foto sala-b.png adicionada à galeria privada.",
    ]);
    expect(actions).toEqual([
      "studio.media.upload.prepare",
      "studio.media.upload.finalize",
      "studio.media.upload.prepare",
      "studio.media.upload.finalize",
    ]);
    await expect(page.getByText("Capa do rascunho", { exact: true })).toHaveCount(1);

    await page.getByRole("button", { name: "Definir foto 2 como capa" }).click();
    await expect(page.getByText("Capa atualizada com sucesso.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Definir foto 1 como capa" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Definir foto 2 como capa" })).toHaveCount(0);

    await page.getByRole("button", { name: "Mover foto 2 para cima" }).click();
    await expect(
      page.getByText("Foto movida para a posição 1 de 2.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Definir foto 2 como capa" })).toBeVisible();

    await page.getByRole("button", { name: "Excluir foto 2" }).click();
    const confirmation = page.getByRole("group", { name: "Confirmar exclusão da foto 2" });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Confirmar exclusão" }).click();
    await expect(page.getByText("1 de 20 fotos", { exact: true })).toBeVisible();
    expect(actions).toEqual([
      "studio.media.upload.prepare",
      "studio.media.upload.finalize",
      "studio.media.upload.prepare",
      "studio.media.upload.finalize",
      "studio.media.cover.set",
      "studio.media.reorder",
      "studio.media.delete",
    ]);
    await expect(page.getByText(/publicar|reviewer|SEO/iu)).toHaveCount(0);
  } finally {
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});

test("SL-F008-E2E-002 @p0 valida tamanho localmente e mantém rejeição de bytes forjados por arquivo", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat008QaIdentity(testInfo, "002_validation");
  try {
    await provisionFeat008Studio(page, identity, "802");
    const actions = observeFeat008MediaActions(page);
    await page
      .getByLabel("Selecionar fotos")
      .setInputFiles([
        feat008SpoofedPngFile("forjada.png"),
        feat008PngFile("valida-depois-da-forjada.png"),
      ]);
    await expect(
      page.getByText("A foto enviada não corresponde ao tipo, tamanho ou conteúdo informado.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("1 de 20 fotos", { exact: true })).toBeVisible();
    await expect(page.getByText("valida-depois-da-forjada.png", { exact: true })).toBeVisible();
    expect(actions).toEqual([
      "studio.media.upload.prepare",
      "studio.media.upload.finalize",
      "studio.media.upload.prepare",
      "studio.media.upload.finalize",
    ]);

    await page.getByLabel("Selecionar fotos").setInputFiles(feat008OversizedPngFile("grande.png"));
    await expect(
      page.getByText("Cada foto pode ter no máximo 15 MB.", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => actions.length).toBe(4);
  } finally {
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});

test("SL-F008-E2E-003 @p0 resposta de upload perdida recupera estados antes e depois da persistência", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat008QaIdentity(testInfo, "003_upload_recovery");
  try {
    const { harness } = await provisionFeat008StudioWithHarness(page, identity, "803");

    harness.loseNextUploadBeforePersistence();
    await page.getByLabel("Selecionar fotos").setInputFiles(feat008PngFile("antes.png"));
    await expect(
      page.getByText(
        "O resultado não foi confirmado. Verifique o estado atual antes de repetir qualquer etapa.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Verificar estado atual" }).click();
    await expect(
      page.getByText(/O arquivo não chegou ao armazenamento.+nova reserva/iu),
    ).toBeVisible();
    await page.getByRole("button", { name: "Renovar envio" }).click();
    await expect(page.getByText("1 de 20 fotos", { exact: true })).toBeVisible();
    expect(harness.uploadAttempts).toHaveLength(2);
    expect(new Set(harness.uploadAttempts).size).toBe(2);

    harness.loseNextUploadAfterPersistence();
    await page.getByLabel("Selecionar fotos").setInputFiles(feat008PngFile("depois.png"));
    await expect(
      page.getByText(
        "O resultado não foi confirmado. Verifique o estado atual antes de repetir qualquer etapa.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Verificar estado atual" }).click();
    await expect(page.getByText("2 de 20 fotos", { exact: true })).toBeVisible();
    expect(harness.uploadAttempts).toHaveLength(3);
    expect(new Set(harness.uploadAttempts).size).toBe(3);

    harness.expireNextFinalize();
    await page.getByLabel("Selecionar fotos").setInputFiles(feat008PngFile("expirada.png"));
    await expect(page.getByRole("button", { name: "Renovar envio" })).toBeVisible();
    await page.getByRole("button", { name: "Renovar envio" }).click();
    await expect(page.getByText("3 de 20 fotos", { exact: true })).toBeVisible();
    expect(harness.uploadAttempts).toHaveLength(5);
    expect(new Set(harness.uploadAttempts).size).toBe(5);
  } finally {
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});

test("SL-F008-E2E-006 @p0 dono B recebe 404 segura e não vê a mídia privada do dono A", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const identityA = createFeat008QaIdentity(testInfo, "006_owner_a");
  const identityB = createFeat008QaIdentity(testInfo, "006_owner_b");
  let contextB: BrowserContext | undefined;
  try {
    const { editor } = await provisionFeat008Studio(page, identityA, "806");
    await uploadFeat008Photos(page, ["privada-do-dono-a.png"]);

    contextB = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { height: 900, width: 1440 },
    });
    const pageB = await contextB.newPage();
    await provisionFeat006Owner(pageB, identityB, "807");
    const navigation = await pageB.goto(`/dono/estudios/${editor.studioId}/midia`);
    expect(navigation).not.toBeNull();
    await expect(
      pageB.getByRole("heading", { level: 1, name: "Estúdio não encontrado" }),
    ).toBeVisible();
    await expect(pageB.getByText("privada-do-dono-a.png", { exact: true })).toHaveCount(0);
    await expect(pageB.getByRole("button", { name: /Visualizar foto/iu })).toHaveCount(0);
    if (identityB.userId === undefined) throw new Error("O dono B não foi provisionado.");
    const directBoundary = await pageB.evaluate(
      async ({ revisionId, revisionVersion, studioId, userId }) => {
        const readResponse = await fetch(`/api/owner/studios/${studioId}/media`, {
          cache: "no-store",
        });
        const prepareResponse = await fetch("/api/commands", {
          body: JSON.stringify({
            action: "studio.media.upload.prepare",
            expectedScope: userId,
            idempotencyKey: crypto.randomUUID(),
            payload: {
              declaredByteSize: 1,
              declaredChecksumSha256: null,
              declaredMimeType: "image/png",
              expectedRevisionId: revisionId,
              expectedRevisionVersion: revisionVersion,
              studioId,
            },
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return {
          prepare: { body: await prepareResponse.json(), status: prepareResponse.status },
          read: { body: await readResponse.json(), status: readResponse.status },
        };
      },
      {
        revisionId: editor.revision.id,
        revisionVersion: editor.revision.version,
        studioId: editor.studioId,
        userId: identityB.userId,
      },
    );
    expect(directBoundary).toMatchObject({
      prepare: { body: { error: { code: "NOT_FOUND" } }, status: 404 },
      read: { body: { error: { code: "NOT_FOUND" } }, status: 404 },
    });
    await expectFeat008StorageIsolation(identityA, identityB);
  } finally {
    if (contextB !== undefined) {
      for (const contextPage of contextB.pages()) await closeFeat008PageBeforeCleanup(contextPage);
      await contextB.close();
    }
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identityB);
    await cleanupFeat008QaIdentity(identityA);
  }
});
