import { expect, test, type Page } from "@playwright/test";

import {
  cleanupFeat003QaIdentity,
  createFeat003QaIdentity,
  registerAndConfirmFeat003Identity,
} from "../../helpers/feat-003-profile-account";
import { gotoExpectedPage } from "../../helpers/expected-page";

test.use({ screenshot: "off", trace: "off", video: "off" });

function createDeferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal assíncrono do cenário de reflow não foi inicializado.");
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectFeat003Reflow(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const interactiveElements = [
          ...document.querySelectorAll<HTMLElement>("a, button, input, select"),
        ];
        const allInteractiveElementsFit = interactiveElements.every((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= -0.5 && bounds.right <= document.documentElement.clientWidth + 0.5;
        });
        return {
          allInteractiveElementsFit,
          bodyFitsViewport: document.body.scrollWidth <= window.innerWidth,
          documentClientWidth: document.documentElement.clientWidth,
          documentFitsViewport:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          innerWidth: window.innerWidth,
          readyState: document.readyState,
          visualViewportWidth: window.visualViewport?.width,
        };
      }),
    )
    .toMatchObject({
      allInteractiveElementsFit: true,
      bodyFitsViewport: true,
      documentClientWidth: 160,
      documentFitsViewport: true,
      innerWidth: 160,
      readyState: "complete",
      visualViewportWidth: 160,
    });
}

test("SL-F003-E2E-007 @p1 conta preserva operação no reflow de 160x360", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(page.viewportSize()).toEqual({ height: 360, width: 160 });
  const identity = createFeat003QaIdentity(testInfo, "007_reflow");
  const requestStarted = createDeferredSignal();
  const releaseRequest = createDeferredSignal();

  try {
    await registerAndConfirmFeat003Identity(page, identity, "individual");
    await gotoExpectedPage(page, "/conta", "Minha conta");
    await expect(
      page.getByRole("heading", { level: 2, name: "Complete seu perfil" }),
    ).toBeVisible();
    await expectFeat003Reflow(page);

    await page.getByRole("link", { name: "Segurança" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Segurança da conta" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sair desta conta" })).toBeVisible();
    await expectFeat003Reflow(page);

    await page.getByRole("link", { name: "Perfil e aparência" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Minha conta" })).toBeVisible();
    await page.route(
      "**/api/commands",
      async (route) => {
        requestStarted.resolve();
        await releaseRequest.promise;
        await route.abort("timedout");
      },
      { times: 1 },
    );
    await page.getByRole("combobox", { name: "Tema da interface" }).selectOption("dark");
    await page.getByRole("button", { name: "Salvar aparência" }).click();
    await requestStarted.promise;
    const loadingButton = page.getByRole("button", { name: "Salvando tema" });
    await expect(loadingButton).toBeVisible();
    await expectFeat003Reflow(page);
    releaseRequest.resolve();
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Não foi possível salvar", { exact: true }) }),
    ).toContainText("Não foi possível conectar");
    await expectFeat003Reflow(page);
  } finally {
    releaseRequest.resolve();
    await cleanupFeat003QaIdentity(identity);
  }
});
