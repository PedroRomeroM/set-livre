import { expect, test, type Page } from "@playwright/test";

import {
  cleanupFeat002QaIdentity,
  createFeat002QaIdentity,
  getFeat002PasswordControl,
  navigateFeat002AuthCallback,
} from "../../helpers/feat-002-authentication";
import { gotoExpectedPage } from "../../helpers/expected-page";

function createDeferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal assíncrono do cenário de reflow não foi inicializado.");
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectFeat002Reflow(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const interactiveElements = [...document.querySelectorAll<HTMLElement>("a, button, input")];
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

test("SL-F002-E2E-007 @p1 autenticação preserva reflow no zoom de 200%", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  expect(page.viewportSize()).toEqual({ height: 360, width: 160 });
  const identity = createFeat002QaIdentity(testInfo, "007_reflow");

  try {
    await gotoExpectedPage(page, "/cadastro", "Crie sua conta");
    await expect(page.getByRole("textbox", { name: "E-mail" })).toBeVisible();
    await expectFeat002Reflow(page);

    const password = getFeat002PasswordControl(page, "Senha");
    const passwordToggle = page.getByRole("button", { name: "Mostrar senha" }).first();
    const [passwordBounds, toggleBounds] = await Promise.all([
      password.boundingBox(),
      passwordToggle.boundingBox(),
    ]);
    expect(passwordBounds).not.toBeNull();
    expect(toggleBounds).not.toBeNull();
    if (passwordBounds === null || toggleBounds === null) {
      throw new Error("Os controles de senha não possuem geometria verificável no reflow.");
    }
    expect(toggleBounds.y).toBeGreaterThanOrEqual(passwordBounds.y + passwordBounds.height);

    await gotoExpectedPage(page, "/entrar", "Entre na sua conta");
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
    await expectFeat002Reflow(page);

    await gotoExpectedPage(page, "/recuperar-senha", "Recupere seu acesso");
    const recoveryEmail = page.getByRole("textbox", { name: "E-mail" });
    await expect(recoveryEmail).toBeVisible();
    await expectFeat002Reflow(page);

    const requestStarted = createDeferredSignal();
    const releaseRequest = createDeferredSignal();
    await page.route("**/api/auth/recovery/request", async (route) => {
      requestStarted.resolve();
      await releaseRequest.promise;
      await route.abort("timedout");
    });

    try {
      await recoveryEmail.fill(identity.email);
      await page.getByRole("button", { name: "Enviar instruções" }).click();
      await requestStarted.promise;
      const loadingButton = page.getByRole("button", { name: "Enviando instruções" });
      await expect(loadingButton).toBeVisible();
      await expect(loadingButton).toContainText("Enviando instruções");
      const loadingLayout = await loadingButton.evaluate((button) => {
        const label = button.querySelector<HTMLElement>("span:last-child");
        if (label === null) {
          return null;
        }
        const style = getComputedStyle(label);
        return {
          fitsWidth: label.scrollWidth <= label.clientWidth,
          overflowWrap: style.overflowWrap,
          whiteSpace: style.whiteSpace,
        };
      });
      expect(loadingLayout).toEqual({
        fitsWidth: true,
        overflowWrap: "anywhere",
        whiteSpace: "normal",
      });
      await expectFeat002Reflow(page);
    } finally {
      releaseRequest.resolve();
    }
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Não foi possível solicitar agora", { exact: true }) }),
    ).toContainText("Não foi possível solicitar agora");
    await expectFeat002Reflow(page);

    const invalidCallback = new URL("/auth/callback", page.url());
    invalidCallback.hash = "token_hash=invalid&type=recovery";
    await navigateFeat002AuthCallback(page, invalidCallback.toString());
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Link não confirmado", { exact: true }) }),
    ).toContainText("Link não confirmado");
    await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
    await expectFeat002Reflow(page);
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});
