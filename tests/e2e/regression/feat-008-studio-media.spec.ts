import { expect, test, type BrowserContext } from "@playwright/test";

import {
  closeFeat008PageBeforeCleanup,
  cleanupFeat008QaIdentity,
  createFeat008QaIdentity,
  createFeat008StudioFixture,
  feat008PngFile,
  installFeat008MediaHarness,
  provisionFeat008StudioWithHarness,
  uploadFeat008Photos,
} from "../../helpers/feat-008-studio-media";

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("SL-F008-E2E-004 @p1 prévia expirada e cancelamento preservam recuperação e foco", async ({
  page,
}, testInfo) => {
  test.setTimeout(190_000);
  const identity = createFeat008QaIdentity(testInfo, "004_accessibility");
  try {
    await provisionFeat008StudioWithHarness(page, identity, "805");
    await uploadFeat008Photos(page, ["recuperavel.png"]);
    const firstThumbnail = page.getByRole("button", { name: /Visualizar foto 1/iu });
    await page.route("**/__qa/feat008-expired-preview", (route) =>
      route.fulfill({ body: "expired", status: 403 }),
    );
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await firstThumbnail.locator("img").evaluate((element) => {
      const image = element as HTMLImageElement;
      image.removeAttribute("srcset");
      image.src = "/__qa/feat008-expired-preview";
    });
    await expect(page.getByText("Uma foto precisa de uma nova URL temporária.")).toBeVisible();
    await page.getByRole("button", { name: "Renovar prévias" }).click();
    await expect(page.getByText("Uma foto precisa de uma nova URL temporária.")).toHaveCount(0);
    await expect(page.getByText("Prévias privadas renovadas.", { exact: true })).toBeVisible();

    const deleteButton = page.getByRole("button", { name: "Excluir foto 1" });
    await deleteButton.click();
    await page.getByRole("button", { name: "Manter foto" }).click();
    await expect(deleteButton).toBeFocused();
  } finally {
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});

test("SL-F008-E2E-005 @p1 proporção e dimensões reservadas mantêm CLS da prévia estável", async ({
  page,
}, testInfo) => {
  test.setTimeout(190_000);
  const identity = createFeat008QaIdentity(testInfo, "005_layout_stability");
  const delayedPreviewRequested = deferredSignal();
  const releaseDelayedPreview = deferredSignal();
  try {
    const { harness } = await provisionFeat008StudioWithHarness(page, identity, "805");
    await uploadFeat008Photos(page, ["estavel.png"]);
    await expect(page.getByText("1 de 20 fotos", { exact: true })).toBeVisible();
    const thumbnail = page.getByRole("button", { name: /Visualizar foto 1/iu });
    const image = thumbnail.locator("img");
    await expect(image).toHaveAttribute("width", "1");
    await expect(image).toHaveAttribute("height", "1");
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).complete))
      .toBe(true);
    expect(
      await image.evaluate((element) => getComputedStyle(element.parentElement!).aspectRatio),
    ).toBe("4 / 3");
    const beforeDecode = await thumbnail.boundingBox();
    expect(beforeDecode).not.toBeNull();

    await page.evaluate(() => {
      const state = { value: 0 };
      Object.defineProperty(window, "__setLivreFeat008Cls", {
        configurable: true,
        value: state,
      });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
          if (shift.hadRecentInput !== true && typeof shift.value === "number") {
            state.value += shift.value;
          }
        }
      }).observe({ buffered: false, type: "layout-shift" });
    });

    await page.route("**/__qa/feat008-delayed-preview.png", async (route) => {
      delayedPreviewRequested.resolve();
      await releaseDelayedPreview.promise;
      await route.fulfill({
        body: feat008PngFile("preview-atrasada.png").buffer,
        contentType: "image/png",
        status: 200,
      });
    });
    await image.evaluate((element) => {
      const preview = element as HTMLImageElement;
      preview.removeAttribute("srcset");
      preview.src = "/__qa/feat008-delayed-preview.png";
    });
    await delayedPreviewRequested.promise;
    expect(await thumbnail.boundingBox()).toEqual(beforeDecode);
    releaseDelayedPreview.resolve();
    await expect
      .poll(() =>
        image.evaluate((element) => {
          const preview = element as HTMLImageElement;
          return preview.complete && preview.naturalWidth > 0;
        }),
      )
      .toBe(true);
    expect(await thumbnail.boundingBox()).toEqual(beforeDecode);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __setLivreFeat008Cls: { value: number };
              }
            ).__setLivreFeat008Cls.value,
        ),
      )
      .toBeLessThanOrEqual(0.01);
    expect(harness.gallery().items).toHaveLength(1);
  } finally {
    releaseDelayedPreview.resolve();
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});

test("SL-F008-E2E-007 @p1 hidratação oculta dados e resposta perdida é verificada sem duplicar comando", async ({
  page,
}, testInfo) => {
  test.setTimeout(200_000);
  const identity = createFeat008QaIdentity(testInfo, "007_fail_closed");
  const readCaptured = deferredSignal();
  const releaseRead = deferredSignal();
  let holdReads = true;
  try {
    const { editor } = await createFeat008StudioFixture(page, identity, "806");
    const harness = await installFeat008MediaHarness(page, editor);
    await page.route(`**/api/owner/studios/${editor.studioId}/media`, async (route) => {
      if (holdReads) {
        readCaptured.resolve();
        await releaseRead.promise;
      }
      await route.fallback();
    });
    const navigation = await page.goto(`/dono/estudios/${editor.studioId}/midia`);
    expect(navigation?.status()).toBe(200);
    await readCaptured.promise;
    await expect(
      page.getByText(/Preparando a galeria segura|Verificando a galeria segura/iu),
    ).toBeVisible();
    await expect(page.getByLabel("Selecionar fotos")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Visualizar foto/iu })).toHaveCount(0);
    holdReads = false;
    releaseRead.resolve();
    await expect(page.getByText("0 de 20 fotos", { exact: true })).toBeVisible();

    await uploadFeat008Photos(page, ["ambigua-a.png", "ambigua-b.png"]);
    harness.loseNextResponse("studio.media.cover.set");
    await page.getByRole("button", { name: "Definir foto 2 como capa" }).click();
    await expect(page.getByText("A ação precisa de confirmação", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Verificar estado atual" }).click();
    await expect(
      page.getByText("A ação já estava confirmada na galeria canônica.", { exact: true }),
    ).toBeVisible();
    expect(harness.actions.filter((action) => action === "studio.media.cover.set")).toHaveLength(1);

    const secondMediaId = harness.gallery().items[1]?.id;
    if (harness.gallery().items.length !== 2 || secondMediaId === undefined) {
      throw new Error("O cenário de replay exige duas fotos canônicas.");
    }
    harness.loseNextResponse("studio.media.cover.set");
    await page.getByRole("button", { name: "Definir foto 1 como capa" }).click();
    await expect(page.getByText("A ação precisa de confirmação", { exact: true })).toBeVisible();
    harness.replaceCoverRemotely(secondMediaId);
    await page.getByRole("button", { name: "Verificar estado atual" }).click();
    await page.getByRole("button", { name: "Repetir a mesma solicitação" }).click();
    await expect(
      page.getByText(/solicitação antiga foi reconhecida.+versão mais recente/iu),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Definir foto 1 como capa" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Definir foto 2 como capa" })).toHaveCount(0);
    expect(harness.actions.filter((action) => action === "studio.media.cover.set")).toHaveLength(3);
  } finally {
    releaseRead.resolve();
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});

test("SL-F008-E2E-008 @p1 conflito bloqueia a galeria e exige nova ação após aceitar a versão salva", async ({
  page,
}, testInfo) => {
  test.setTimeout(190_000);
  const identity = createFeat008QaIdentity(testInfo, "008_conflict");
  try {
    const { harness } = await provisionFeat008StudioWithHarness(page, identity, "807");
    await uploadFeat008Photos(page, ["conflito-a.png", "conflito-b.png"]);
    harness.conflictNext("studio.media.reorder");
    await page.getByRole("button", { name: "Mover foto 2 para cima" }).click();
    await expect(page.getByText("A galeria mudou em outra sessão", { exact: true })).toBeVisible();
    const acceptSaved = page.getByRole("button", { name: "Usar versão salva" });
    await expect(acceptSaved).toBeVisible();
    await expect(page.getByRole("button", { name: "Mover foto 2 para cima" })).toBeDisabled();
    expect(harness.actions.filter((action) => action === "studio.media.reorder")).toHaveLength(1);

    await acceptSaved.click();
    await expect(
      page.getByText("Versão salva aceita. Faça uma nova ação se ainda for necessária.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Mover foto 2 para cima" }).click();
    await expect(
      page.getByText("Foto movida para a posição 1 de 2.", { exact: true }),
    ).toBeVisible();
    expect(harness.actions.filter((action) => action === "studio.media.reorder")).toHaveLength(2);
  } finally {
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});

test("SL-F008-E2E-012 @p1 conflito no upload exige aceitar a versão salva e cria uma reserva nova", async ({
  page,
}, testInfo) => {
  test.setTimeout(190_000);
  const identity = createFeat008QaIdentity(testInfo, "010_upload_conflict");
  try {
    const { harness } = await provisionFeat008StudioWithHarness(page, identity, "810");
    harness.conflictNext("studio.media.upload.finalize");

    await page
      .getByLabel("Selecionar fotos")
      .setInputFiles(feat008PngFile("conflito-no-upload.png"));
    await expect(page.getByText("A galeria mudou em outra sessão", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "A galeria mudou durante esta tentativa. Aceite a versão salva e renove o envio.",
        { exact: true },
      ),
    ).toBeVisible();
    const renewUpload = page.getByRole("button", { name: "Renovar envio" });
    await expect(renewUpload).toBeDisabled();

    await page.getByRole("button", { name: "Usar versão salva" }).click();
    await expect(renewUpload).toBeEnabled();
    await renewUpload.click();

    await expect(page.getByText("1 de 20 fotos", { exact: true })).toBeVisible();
    expect(
      harness.actions.filter((action) => action === "studio.media.upload.prepare"),
    ).toHaveLength(2);
    expect(
      harness.actions.filter((action) => action === "studio.media.upload.finalize"),
    ).toHaveLength(2);
    expect(harness.uploadAttempts).toHaveLength(2);
    expect(new Set(harness.uploadAttempts).size).toBe(2);
  } finally {
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});

test("SL-F008-E2E-009 @p1 sem JavaScript nenhuma mídia ou controle privado é renderizado", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(190_000);
  const identity = createFeat008QaIdentity(testInfo, "009_no_javascript");
  let noScriptContext: BrowserContext | undefined;
  try {
    const { editor } = await createFeat008StudioFixture(page, identity, "808");
    noScriptContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      javaScriptEnabled: false,
      storageState: await page.context().storageState(),
      viewport: page.viewportSize() ?? { height: 900, width: 1440 },
    });
    const noScriptPage = await noScriptContext.newPage();
    const navigation = await noScriptPage.goto(`/dono/estudios/${editor.studioId}/midia`);
    expect(navigation?.status()).toBe(200);
    await expect(
      noScriptPage.getByText("Validando sua área do dono…", { exact: true }),
    ).toBeVisible();
    await expect(noScriptPage.getByLabel("Selecionar fotos")).toHaveCount(0);
    await expect(noScriptPage.getByRole("button", { name: /Visualizar foto/iu })).toHaveCount(0);
  } finally {
    if (noScriptContext !== undefined) {
      for (const contextPage of noScriptContext.pages()) {
        await closeFeat008PageBeforeCleanup(contextPage);
      }
      await noScriptContext.close();
    }
    await closeFeat008PageBeforeCleanup(page);
    await cleanupFeat008QaIdentity(identity);
  }
});
