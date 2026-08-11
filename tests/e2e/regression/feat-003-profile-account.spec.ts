import { apiSuccessSchema, myProfileResultSchema } from "@set-livre/contracts";
import { expect, test, type Page } from "@playwright/test";

import {
  assertFeat003PrivateValuesAbsentFromDom,
  assertFeat003SafeProfileResult,
  assertFeat003SecretsAbsentFromDom,
  cleanupFeat003QaIdentity,
  completeFeat003Profile,
  createFeat003ProfileSecrets,
  createFeat003QaIdentity,
  formatFeat003PhoneForDisplay,
  maskedFeat003AdditionalDocument,
  registerAndConfirmFeat003Identity,
  stageFeat003SensitiveValue,
} from "../../helpers/feat-003-profile-account";
import { gotoExpectedPage } from "../../helpers/expected-page";

test.use({ screenshot: "off", trace: "off", video: "off" });

function createDeferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal assíncrono do cenário de perfil não foi inicializado.");
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function invalidateVerificationDigit(value: string) {
  const replacement = value.endsWith("0") ? "1" : "0";
  return `${value.slice(0, -1)}${replacement}`;
}

async function expectNoHorizontalOverflow(page: Page) {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
}

async function saveDarkAppearance(page: Page) {
  const responsePromise = page.waitForResponse((response) => {
    const address = new URL(response.url());
    return address.pathname === "/api/commands" && response.request().method() === "POST";
  });
  await page.getByRole("combobox", { name: "Tema da interface" }).selectOption("dark");
  await page.getByRole("button", { name: "Salvar aparência" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload: unknown = await response.json();
  return apiSuccessSchema(myProfileResultSchema).parse(payload).data;
}

test("SL-F003-E2E-003 @p1 valida telefone, CPF e CNPJ localmente no mobile de 320 px", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 720, width: 320 });
  expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
  const identity = createFeat003QaIdentity(testInfo, "003_invalidos");
  const validCpf = createFeat003ProfileSecrets("individual").taxId;
  const invalidCpf = invalidateVerificationDigit(validCpf);
  const invalidCnpj = invalidateVerificationDigit(createFeat003ProfileSecrets("company").taxId);
  const invalidForeignPrefix = "+54 9 2222-2222";
  const invalidFormattedExcess = "+55 (41) 99999-12345";
  let commandRequests = 0;

  try {
    await registerAndConfirmFeat003Identity(page, identity, "individual");
    await gotoExpectedPage(page, "/conta", "Minha conta");
    page.on("request", (request) => {
      const address = new URL(request.url());
      if (address.pathname === "/api/commands" && request.method() === "POST") {
        commandRequests += 1;
      }
    });
    const individualChoice = page.getByRole("radio", { name: "Pessoa física" });
    await individualChoice.check();
    await page.getByRole("textbox", { name: "Nome completo" }).fill("Pessoa QA Inválida");
    const phoneControl = page.getByRole("textbox", { name: "Telefone" });
    await phoneControl.fill(invalidForeignPrefix);
    await expect(phoneControl).toHaveValue(formatFeat003PhoneForDisplay(invalidForeignPrefix));
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CPF" }), validCpf);
    await expect(individualChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(
      page.getByText("Informe um telefone brasileiro válido.", { exact: true }),
    ).toBeVisible();

    await phoneControl.fill(invalidFormattedExcess);
    await expect(phoneControl).toHaveValue(formatFeat003PhoneForDisplay(invalidFormattedExcess));
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CPF" }), validCpf);
    await expect(individualChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(
      page.getByText("Informe um telefone brasileiro válido.", { exact: true }),
    ).toBeVisible();

    await phoneControl.fill("(41) 99999-1003");
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CPF" }), invalidCpf);
    await expect(individualChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(page.getByText("Informe um CPF válido.", { exact: true })).toBeVisible();

    const companyChoice = page.getByRole("radio", { name: "Pessoa jurídica" });
    await companyChoice.check();
    await page.getByRole("textbox", { name: "Nome empresarial" }).fill("Empresa QA Inválida");
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CNPJ" }), invalidCnpj);
    await expect(companyChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(page.getByText("Informe um CNPJ válido.", { exact: true })).toBeVisible();

    expect(commandRequests).toBe(0);
    await assertFeat003SecretsAbsentFromDom(page, [validCpf, invalidCpf, invalidCnpj]);
    await expectNoHorizontalOverflow(page);
  } finally {
    await cleanupFeat003QaIdentity(identity);
  }
});

test("SL-F003-E2E-005 @p1 mantém CPF e documento somente mascarados após salvar", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const identity = createFeat003QaIdentity(testInfo, "005_mascara");
  const secrets = createFeat003ProfileSecrets("individual");

  try {
    await registerAndConfirmFeat003Identity(page, identity, "individual");
    await gotoExpectedPage(page, "/conta", "Minha conta");
    const profile = await completeFeat003Profile(page, {
      name: "Pessoa QA Documento Mascarado",
      personType: "individual",
      phone: "(41) 99999-1005",
      secrets,
    });
    const expectedDocumentMask = maskedFeat003AdditionalDocument(secrets.additionalDocument);
    expect(profile.profile).toMatchObject({
      additionalDocumentMasked: expectedDocumentMask,
      completed: true,
      taxIdMasked: `***.***.***-${secrets.taxId.slice(-2)}`,
    });
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText(expectedDocumentMask);
    await assertFeat003SecretsAbsentFromDom(page, [secrets.taxId, secrets.additionalDocument]);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Minha conta" })).toBeVisible();
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText(expectedDocumentMask);
    const response = await page.request.get("/api/account/profile");
    expect(response.status()).toBe(200);
    const payload: unknown = await response.json();
    const result = apiSuccessSchema(myProfileResultSchema).parse(payload).data;
    assertFeat003SafeProfileResult(result, [secrets.taxId, secrets.additionalDocument]);
    await assertFeat003SecretsAbsentFromDom(page, [secrets.taxId, secrets.additionalDocument]);
  } finally {
    await cleanupFeat003QaIdentity(identity);
  }
});

test("SL-F003-E2E-008 @p1 persiste o tema e o projeta no HTML antes da hidratação", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const identity = createFeat003QaIdentity(testInfo, "008_tema");

  try {
    await registerAndConfirmFeat003Identity(page, identity, "individual");
    await gotoExpectedPage(page, "/conta", "Minha conta");
    const result = await saveDarkAppearance(page);
    expect(result.profile.colorScheme).toBe("dark");
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    await expect(page.getByText("Preferência visual atualizada.", { exact: true })).toBeVisible();

    const preferenceCookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "sl-color-scheme",
    );
    expect(preferenceCookie).toMatchObject({
      httpOnly: true,
      name: "sl-color-scheme",
      sameSite: "Lax",
      value: "dark",
    });
    const serverResponse = await page.request.get("/conta");
    expect(serverResponse.status()).toBe(200);
    const serverHtml = await serverResponse.text();
    if (!serverHtml.includes('data-color-scheme="dark"')) {
      throw new Error("A projeção SSR da preferência visual não foi aplicada.");
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    await expect(page.getByRole("combobox", { name: "Tema da interface" })).toHaveValue("dark");
  } finally {
    await cleanupFeat003QaIdentity(identity);
  }
});

test("SL-F003-E2E-009 @p1 fecha PII em fetching/paused e recupera timeout/conflito", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat003QaIdentity(testInfo, "009_estados");
  const secrets = createFeat003ProfileSecrets("individual");
  const profileName = "Pessoa QA Boundary Privado";
  const profilePhone = "+55 (41) 99999-1009";
  const fetchRequestStarted = createDeferredSignal();
  const releaseFetchRequest = createDeferredSignal();
  const timeoutRequestStarted = createDeferredSignal();
  const releaseTimeoutRequest = createDeferredSignal();

  try {
    await registerAndConfirmFeat003Identity(page, identity, "individual");
    await gotoExpectedPage(page, "/conta", "Minha conta");
    await completeFeat003Profile(page, {
      name: profileName,
      personType: "individual",
      phone: profilePhone,
      secrets,
    });
    const privateValues = [
      profileName,
      formatFeat003PhoneForDisplay(profilePhone),
      `***.***.***-${secrets.taxId.slice(-2)}`,
      maskedFeat003AdditionalDocument(secrets.additionalDocument),
    ];
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText(profileName);
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText(
      formatFeat003PhoneForDisplay(profilePhone),
    );
    await page.route(
      "**/api/account/profile",
      async (route) => {
        fetchRequestStarted.resolve();
        await releaseFetchRequest.promise;
        await route.continue();
      },
      { times: 1 },
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await fetchRequestStarted.promise;
    await expect(page.getByText("Validando seus dados privados…", { exact: true })).toBeVisible();
    await assertFeat003PrivateValuesAbsentFromDom(page, privateValues);
    await assertFeat003SecretsAbsentFromDom(page, [secrets.taxId, secrets.additionalDocument]);
    releaseFetchRequest.resolve();
    await expect(page.getByRole("heading", { level: 2, name: "Dados do perfil" })).toBeVisible();

    await page.context().setOffline(true);
    try {
      await page.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(page.getByText("Validando seus dados privados…", { exact: true })).toBeVisible();
      await assertFeat003PrivateValuesAbsentFromDom(page, privateValues);
      await assertFeat003SecretsAbsentFromDom(page, [secrets.taxId, secrets.additionalDocument]);
    } finally {
      await page.context().setOffline(false);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("online"));
        window.dispatchEvent(new Event("visibilitychange"));
      });
    }
    await expect(page.getByRole("heading", { level: 2, name: "Dados do perfil" })).toBeVisible();

    await page.evaluate(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      Object.defineProperty(window, "setTimeout", {
        configurable: true,
        value: (handler: TimerHandler, timeout?: number) =>
          nativeSetTimeout(handler, timeout === 10_000 ? 25 : timeout),
      });
    });
    await page.route(
      "**/api/account/profile",
      async (route) => {
        timeoutRequestStarted.resolve();
        await releaseTimeoutRequest.promise;
        try {
          await route.continue();
        } catch {
          return;
        }
      },
      { times: 1 },
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await timeoutRequestStarted.promise;
    await expect(page.getByText("Validando seus dados privados…", { exact: true })).toBeVisible();
    await assertFeat003PrivateValuesAbsentFromDom(page, privateValues);
    await assertFeat003SecretsAbsentFromDom(page, [secrets.taxId, secrets.additionalDocument]);
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Perfil indisponível", { exact: true }) }),
    ).toContainText("A solicitação demorou mais que o esperado");
    await assertFeat003PrivateValuesAbsentFromDom(page, privateValues);
    await assertFeat003SecretsAbsentFromDom(page, [secrets.taxId, secrets.additionalDocument]);
    releaseTimeoutRequest.resolve();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 2, name: "Dados do perfil" })).toBeVisible();
    await page.route(
      "**/api/commands",
      async (route) => {
        await route.fulfill({
          body: JSON.stringify({
            error: {
              code: "CONFLICT",
              message: "O perfil mudou. Carregue a versão atual e tente novamente.",
              requestId: "30000000-0000-4000-8000-000000000009",
            },
          }),
          contentType: "application/json",
          status: 409,
        });
      },
      { times: 1 },
    );
    await page.getByRole("combobox", { name: "Tema da interface" }).selectOption("dark");
    await page.getByRole("button", { name: "Salvar aparência" }).click();
    await expect(page.getByText("Este perfil mudou em outro lugar", { exact: true })).toBeVisible();
    const recovery = page.getByRole("button", { name: "Carregar versão atual" });
    await expect(recovery).toBeVisible();
    await recovery.click();
    await expect(page.getByText("Este perfil mudou em outro lugar", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("combobox", { name: "Tema da interface" })).toHaveValue("system");
    await assertFeat003SecretsAbsentFromDom(page, [secrets.taxId, secrets.additionalDocument]);
    await expectNoHorizontalOverflow(page);
  } finally {
    releaseFetchRequest.resolve();
    releaseTimeoutRequest.resolve();
    await cleanupFeat003QaIdentity(identity);
  }
});
