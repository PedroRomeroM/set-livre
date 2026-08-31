import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";

import {
  cleanupFeat002QaIdentity,
  confirmFeat002Registration,
  createFeat002QaIdentity,
  expectUnauthenticatedSession,
  getFeat002PasswordControl,
  logoutFeat002Identity,
  navigateFeat002AuthCallback,
  readFeat002AuthenticatedSession,
  readFeat002IdentitySession,
  submitFeat002Registration,
  stageFeat002PasswordForSubmission,
  trackFeat002AuthEmail,
} from "../../helpers/feat-002-authentication";
import { gotoExpectedPage } from "../../helpers/expected-page";
import {
  assertExactLocalRecoverySessionClosed,
  expireExactLocalRecoveryGrant,
} from "../../helpers/local-recovery-grant";

function createDeferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal assíncrono do cenário Auth não foi inicializado.");
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectCurrentPath(page: Parameters<typeof gotoExpectedPage>[0], expected: string) {
  await expect
    .poll(
      () => {
        const address = new URL(page.url());
        return `${address.pathname}${address.search}`;
      },
      { timeout: 15_000 },
    )
    .toBe(expected);
}

const loginFormRedactionMarker = "sl-qa-f002-login-form-redacted";

async function expectRegistrationClosedWithoutHydration(browser: Browser, testInfo: TestInfo) {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") {
    throw new Error("A origem QA do cadastro não está disponível no projeto Playwright.");
  }

  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    const navigation = await page.goto(new URL("/cadastro", baseURL).toString());
    expect(navigation?.status()).toBe(200);
    await expect(page.locator("h1", { hasText: /^Crie sua conta$/u })).toBeAttached();
    await expect(
      page.locator('[role="status"]', {
        hasText: /^Preparando o formulário seguro…$/u,
      }),
    ).toBeAttached();

    const form = page.locator("form", {
      has: page.locator('input[name="email"]'),
    });
    await expect(form).toBeAttached();
    await expect(form).toBeHidden();
    await expect(form).toHaveAttribute("inert", "");
    await expect(form).toHaveAttribute("method", "post");
    await expect(form.locator("fieldset").first()).toHaveAttribute("disabled", "");
    await expect(form.locator('input[name="email"]')).toHaveAttribute("disabled", "");
    await expect(form.locator('input[name="password"]')).toHaveAttribute("disabled", "");
    await expect(form.locator('input[name="confirmPassword"]')).toHaveAttribute("disabled", "");
    await expect(form.locator('button[type="submit"]')).toHaveAttribute("disabled", "");

    const address = new URL(page.url());
    expect(address.pathname).toBe("/cadastro");
    expect(address.search).toBe("");
  } finally {
    await context.close();
  }
}

async function armLoginFormRedactionObservation(page: Page) {
  await page
    .getByRole("button", { name: "Entrar", exact: true })
    .evaluate((submitButton, marker) => {
      const form = submitButton.closest("form");
      const emailControl = form?.elements.namedItem("email");
      const passwordControl = form?.elements.namedItem("password");
      if (
        form === null ||
        !(emailControl instanceof HTMLInputElement) ||
        !(passwordControl instanceof HTMLInputElement)
      ) {
        throw new Error("O formulário de login QA não atende ao contrato observado.");
      }

      window.sessionStorage.removeItem(marker);
      window.addEventListener(
        "pagehide",
        () => {
          const wasRedacted =
            form.hidden && emailControl.value === "" && passwordControl.value === "";
          window.sessionStorage.setItem(marker, wasRedacted ? "yes" : "no");
        },
        { once: true },
      );
    }, loginFormRedactionMarker);
}

async function expectLoginFormRedactedBeforeReload(page: Page) {
  await expect
    .poll(() =>
      page.evaluate((marker) => window.sessionStorage.getItem(marker), loginFormRedactionMarker),
    )
    .toBe("yes");
}

async function corruptNextSuccessfulLoginPayload(page: Page) {
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const requestUrl =
        input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const address = new URL(requestUrl, window.location.href);

      if (address.pathname !== "/api/auth/login" || !response.ok) {
        return response;
      }

      window.fetch = originalFetch;
      await response.arrayBuffer();
      return new Response("{}", {
        headers: { "content-type": "application/json" },
        status: response.status,
        statusText: response.statusText,
      });
    };
  });
}

test("SL-F002-E2E-001 @p0 cadastro completo envia confirmação e aceita termos", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const identity = createFeat002QaIdentity(testInfo, "001");

  try {
    await expectRegistrationClosedWithoutHydration(browser, testInfo);
    const notBefore = await submitFeat002Registration(page, identity);
    const session = await confirmFeat002Registration(page, identity, notBefore);

    expect(identity.emails[0]?.subject).toBe("Confirme seu cadastro na Set Livre");
    expect(session).toMatchObject({
      authenticated: true,
      email: identity.email,
      personType: "company",
      profileCompleted: false,
      status: "active",
    });
    await expect(page.getByText(identity.email, { exact: true })).toBeVisible();
    await expect(page.getByText("Pessoa jurídica", { exact: true })).toBeVisible();
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});

test("SL-F002-E2E-002 @p0 login e logout controlam a sessão SSR em entrar", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const identity = createFeat002QaIdentity(testInfo, "002");

  try {
    const notBefore = await submitFeat002Registration(page, identity, "Pessoa física");
    const confirmedSession = await confirmFeat002Registration(page, identity, notBefore);
    await logoutFeat002Identity(page);

    await corruptNextSuccessfulLoginPayload(page);
    await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
    await stageFeat002PasswordForSubmission(
      getFeat002PasswordControl(page, "Senha"),
      identity.password,
    );
    await armLoginFormRedactionObservation(page);
    const publishedLoginSession = page.waitForResponse((response) => {
      const address = new URL(response.url());
      return response.request().method() === "POST" && address.pathname === "/api/auth/login";
    });
    const publishedSessionReload = page.waitForRequest((request) => {
      const address = new URL(request.url());
      return (
        request.method() === "GET" &&
        request.resourceType() === "document" &&
        address.pathname === "/entrar" &&
        address.search === "?entrada=verificar"
      );
    });
    await page.getByRole("button", { name: "Entrar" }).click();

    expect((await publishedLoginSession).status()).toBe(200);
    await publishedSessionReload;
    await expectCurrentPath(page, "/entrar?entrada=verificar");
    await expectLoginFormRedactedBeforeReload(page);
    await expect(page.getByRole("button", { name: "Entrar", exact: true })).toHaveCount(0);
    await expect(getFeat002PasswordControl(page, "Senha")).toHaveCount(0);
    await expect(page.getByText("Não foi possível entrar", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("Sessão ativa");
    const loggedInSession = await readFeat002AuthenticatedSession(page);
    expect(loggedInSession.userId).toBe(confirmedSession.userId);
    await expect(page.getByText(identity.email, { exact: true })).toBeVisible();

    await logoutFeat002Identity(page);
    expectUnauthenticatedSession(await readFeat002IdentitySession(page));

    const ambiguousLoginStarted = createDeferredSignal();
    await page.route(
      "**/api/auth/login",
      async (route) => {
        ambiguousLoginStarted.resolve();
        await route.fulfill({
          body: "{",
          contentType: "application/json",
          status: 200,
        });
      },
      { times: 1 },
    );
    await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
    await stageFeat002PasswordForSubmission(
      getFeat002PasswordControl(page, "Senha"),
      identity.password,
    );
    await armLoginFormRedactionObservation(page);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
    });
    const absentSessionReload = page.waitForRequest((request) => {
      const address = new URL(request.url());
      return (
        request.method() === "GET" &&
        request.resourceType() === "document" &&
        address.pathname === "/entrar" &&
        address.search === "?entrada=verificar"
      );
    });
    await page.getByRole("button", { name: "Entrar" }).click();

    await ambiguousLoginStarted.promise;
    await absentSessionReload;
    await expectCurrentPath(page, "/entrar?entrada=verificar");
    await expectLoginFormRedactedBeforeReload(page);
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Entrada não confirmada", { exact: true }) }),
    ).toContainText("A revalidação confirmou que não há uma sessão ativa");
    await expect(page.getByRole("textbox", { name: "E-mail" })).toHaveValue("");
    await expect(getFeat002PasswordControl(page, "Senha")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Entrar", exact: true })).toBeVisible();
    expectUnauthenticatedSession(await readFeat002IdentitySession(page));
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});

test("SL-F002-E2E-003 @p0 recuperação mobile define e autentica com a nova senha", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 720, width: 320 });
  expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
  const identity = createFeat002QaIdentity(testInfo, "003");
  const newPassword = `${identity.password}Z7`;

  try {
    const signupNotBefore = await submitFeat002Registration(page, identity, "Pessoa física");
    const confirmedSession = await confirmFeat002Registration(page, identity, signupNotBefore);
    await logoutFeat002Identity(page);

    await gotoExpectedPage(page, "/recuperar-senha", "Recupere seu acesso");
    await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
    const recoveryNotBefore = new Date(Date.now() - 1_000);
    await page.getByRole("button", { name: "Enviar instruções" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Se existir uma conta para o endereço informado",
    );

    const recoveryEmail = await trackFeat002AuthEmail(identity, "recovery", recoveryNotBefore);
    expect(recoveryEmail.subject).toBe("Redefina sua senha da Set Livre");
    await navigateFeat002AuthCallback(page, recoveryEmail.callbackUrl);
    await expectCurrentPath(page, "/recuperar-senha?modo=nova-senha");

    const newPasswordInput = getFeat002PasswordControl(page, "Nova senha");
    const confirmNewPasswordInput = getFeat002PasswordControl(page, "Confirme a nova senha");
    await expect(newPasswordInput).toBeEnabled();

    await page.context().setOffline(true);
    try {
      await page.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(page.getByRole("status")).toContainText(
        "Verificando se o link de recuperação é válido",
      );
      await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Salvar nova senha" })).toHaveCount(0);
    } finally {
      await page.context().setOffline(false);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("online"));
      });
    }

    await expect(newPasswordInput).toBeEnabled();
    const saveNewPassword = page.getByRole("button", { name: "Salvar nova senha" });
    const recoveryStatusRefetchStarted = createDeferredSignal();
    const releaseRecoveryStatusRefetch = createDeferredSignal();
    await page.route(
      "**/api/auth/recovery/status",
      async (route) => {
        recoveryStatusRefetchStarted.resolve();
        await releaseRecoveryStatusRefetch.promise;
        await route.continue();
      },
      { times: 1 },
    );
    const rejectedPasswordUpdate = page.waitForResponse((response) => {
      const address = new URL(response.url());
      return (
        address.pathname === "/api/auth/recovery/update" && response.request().method() === "POST"
      );
    });
    await stageFeat002PasswordForSubmission(newPasswordInput, identity.password);
    await stageFeat002PasswordForSubmission(confirmNewPasswordInput, identity.password);
    await saveNewPassword.click();
    expect((await rejectedPasswordUpdate).status()).toBe(400);

    await recoveryStatusRefetchStarted.promise;
    try {
      await expect(page.getByRole("status")).toContainText(
        "Verificando se o link de recuperação é válido",
      );
      await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
      await expect(saveNewPassword).toHaveCount(0);
    } finally {
      releaseRecoveryStatusRefetch.resolve();
    }

    await expect(newPasswordInput).toBeEnabled();
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Não foi possível atualizar a senha", { exact: true }) }),
    ).toContainText("Revise os campos destacados");
    await expect(
      page.getByText("A nova senha não atende aos requisitos de segurança.", { exact: true }),
    ).toBeVisible();

    const passwordToggles = page.getByRole("button", { name: "Mostrar senha" });
    await newPasswordInput.focus();
    await expect(newPasswordInput).toBeFocused();
    await stageFeat002PasswordForSubmission(newPasswordInput, newPassword);
    await page.keyboard.press("Tab");
    await expect(passwordToggles.first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirmNewPasswordInput).toBeFocused();
    await stageFeat002PasswordForSubmission(confirmNewPasswordInput, newPassword);
    await page.keyboard.press("Tab");
    await expect(passwordToggles.last()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(saveNewPassword).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("Senha atualizada");

    const recoveryStatusStarted = createDeferredSignal();
    const releaseRecoveryStatus = createDeferredSignal();
    await page.route(
      "**/api/auth/recovery/status",
      async (route) => {
        recoveryStatusStarted.resolve();
        await releaseRecoveryStatus.promise;
        await route.continue();
      },
      { times: 1 },
    );

    try {
      await page.getByRole("link", { name: "Entrar com a nova senha" }).click();
      await expectCurrentPath(page, "/entrar");
      await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
      expectUnauthenticatedSession(await readFeat002IdentitySession(page));

      await page.getByRole("link", { name: "Esqueci minha senha" }).click();
      await expectCurrentPath(page, "/recuperar-senha");
      await recoveryStatusStarted.promise;
      await expect(page.getByRole("status")).toContainText(
        "Verificando se o link de recuperação é válido",
      );
      await expect(page.getByRole("textbox", { name: "E-mail" })).toHaveCount(0);
      await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
    } finally {
      releaseRecoveryStatus.resolve();
    }

    await expect(page.getByRole("textbox", { name: "E-mail" })).toBeVisible();
    await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
    await page.getByRole("link", { name: "Voltar ao login" }).click();
    await expectCurrentPath(page, "/entrar");

    await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
    await stageFeat002PasswordForSubmission(getFeat002PasswordControl(page, "Senha"), newPassword);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expectCurrentPath(page, "/entrar?sessao=ativa");
    await expect(page.getByRole("status")).toContainText("Sessão ativa");

    await logoutFeat002Identity(page);
    await gotoExpectedPage(page, "/recuperar-senha", "Recupere seu acesso");
    await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
    const expiringRecoveryNotBefore = new Date(Date.now() - 1_000);
    await page.getByRole("button", { name: "Enviar instruções" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Se existir uma conta para o endereço informado",
    );
    const expiringRecoveryEmail = await trackFeat002AuthEmail(
      identity,
      "recovery",
      expiringRecoveryNotBefore,
    );
    await navigateFeat002AuthCallback(page, expiringRecoveryEmail.callbackUrl);
    await expectCurrentPath(page, "/recuperar-senha?modo=nova-senha");
    await expect(getFeat002PasswordControl(page, "Nova senha")).toBeEnabled();

    await expireExactLocalRecoveryGrant({
      email: identity.email,
      userId: confirmedSession.userId,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectCurrentPath(page, "/recuperar-senha");
    await expect(page.getByRole("textbox", { name: "E-mail" })).toBeVisible();
    await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Salvar nova senha" })).toHaveCount(0);
    expectUnauthenticatedSession(await readFeat002IdentitySession(page));

    const remainingRecoveryCookieNames = (await page.context().cookies())
      .map((cookie) => cookie.name)
      .filter(
        (name) =>
          name === "sl-recovery-grant" ||
          name === "sl-recovery-session" ||
          /^sb-127-auth-token(?:\.(?:0|[1-9][0-9]*))?$/u.test(name),
      );
    expect(remainingRecoveryCookieNames).toEqual([]);
    await assertExactLocalRecoverySessionClosed({
      email: identity.email,
      userId: confirmedSession.userId,
    });

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    await navigateFeat002AuthCallback(page, expiringRecoveryEmail.callbackUrl);
    await expectCurrentPath(page, "/auth/callback");
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Link não confirmado", { exact: true }) }),
    ).toContainText("Link não confirmado");
    await expect(getFeat002PasswordControl(page, "Nova senha")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Solicitar recuperação de senha" })).toBeVisible();
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});

test("SL-F002-E2E-005 @p0 returnTo externo é rejeitado com fallback literal", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const identity = createFeat002QaIdentity(testInfo, "005");
  const externalOrigin = "https://outside.invalid";
  let externalRequests = 0;
  await page.route(`${externalOrigin}/**`, async (route) => {
    externalRequests += 1;
    await route.abort("blockedbyclient");
  });

  try {
    const notBefore = await submitFeat002Registration(page, identity);
    const signupEmail = await trackFeat002AuthEmail(identity, "signup", notBefore);
    const adversarialCallback = new URL(signupEmail.callbackUrl);
    const callbackFragment = new URLSearchParams(adversarialCallback.hash.slice(1));
    callbackFragment.set("returnTo", `${externalOrigin}/capture`);
    adversarialCallback.hash = callbackFragment.toString();

    await navigateFeat002AuthCallback(page, adversarialCallback.toString());
    await expectCurrentPath(page, "/entrar?sessao=ativa");
    await expect(page.getByRole("status")).toContainText("Sessão ativa");
    identity.userId = (await readFeat002AuthenticatedSession(page)).userId;
    expect(externalRequests).toBe(0);
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});

test("SL-F002-E2E-008 @p0 login preserva o retorno privado de criação e edição de estúdio", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const identity = createFeat002QaIdentity(testInfo, "006_studio_return");
  const targets = [
    {
      heading: "Novo estúdio",
      path: "/dono/estudios/novo",
      requestedPath: "/dono/estudios/novo",
    },
    {
      heading: "Dados do estúdio",
      path: "/dono/estudios/11111111-1111-4111-8111-111111111111/dados",
      requestedPath: "/dono/estudios/11111111-1111-4111-8111-111111111111/dados",
    },
    {
      heading: "Dados do estúdio",
      path: "/dono/estudios/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/dados",
      requestedPath: "/dono/estudios/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/dados",
    },
  ] as const;

  try {
    const notBefore = await submitFeat002Registration(page, identity, "Pessoa física");
    await confirmFeat002Registration(page, identity, notBefore);
    await logoutFeat002Identity(page);

    for (const [index, target] of targets.entries()) {
      if (index > 0) {
        await gotoExpectedPage(page, "/entrar", "Entre na sua conta");
        await logoutFeat002Identity(page);
      }

      const navigation = await page.goto(target.requestedPath);
      expect(navigation?.status()).toBe(200);
      await expectCurrentPath(page, `/entrar?retorno=${encodeURIComponent(target.path)}`);

      await page.getByRole("textbox", { name: "E-mail" }).fill(identity.email);
      await stageFeat002PasswordForSubmission(
        getFeat002PasswordControl(page, "Senha"),
        identity.password,
      );
      const loginResponse = page.waitForResponse((response) => {
        const address = new URL(response.url());
        return response.request().method() === "POST" && address.pathname === "/api/auth/login";
      });
      await page.getByRole("button", { exact: true, name: "Entrar" }).click();

      expect((await loginResponse).status()).toBe(200);
      await expectCurrentPath(page, target.path);
      await expect(
        page.getByRole("heading", { exact: true, level: 1, name: target.heading }),
      ).toBeVisible();
    }
  } finally {
    await cleanupFeat002QaIdentity(identity);
  }
});
