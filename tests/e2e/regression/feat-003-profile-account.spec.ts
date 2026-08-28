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
  fillFeat003PhoneWithoutReportValue,
  formatFeat003PhoneForDisplay,
  maskedFeat003AdditionalDocument,
  registerAndConfirmFeat003Identity,
  stageFeat003SensitiveValue,
} from "../../helpers/feat-003-profile-account";
import { gotoExpectedPage } from "../../helpers/expected-page";

test.use({ screenshot: "off", trace: "off", video: "off" });

function createDeferredSignal() {
  let resolved = false;
  let resolve: () => void = () => {
    throw new Error("O sinal assíncrono do cenário de perfil não foi inicializado.");
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = () => {
      resolved = true;
      resolvePromise();
    };
  });
  return { isResolved: () => resolved, promise, resolve };
}

async function waitForDeferredSignal(
  signal: ReturnType<typeof createDeferredSignal>,
  description: string,
) {
  await expect
    .poll(signal.isResolved, {
      message: `A barreira assíncrona não iniciou: ${description}.`,
      timeout: 15_000,
    })
    .toBe(true);
}

async function triggerVisibilityRefetch(
  page: Page,
  signal: ReturnType<typeof createDeferredSignal>,
  description: string,
) {
  await expect
    .poll(
      async () => {
        if (!signal.isResolved()) {
          await page.evaluate(() => {
            window.dispatchEvent(new Event("visibilitychange"));
          });
        }
        return signal.isResolved();
      },
      {
        intervals: [100, 250, 500],
        message: `A revalidação por visibilidade não iniciou: ${description}.`,
        timeout: 5_000,
      },
    )
    .toBe(true);
}

async function installPendingProfileRead(page: Page) {
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    const nativeSetTimeout = window.setTimeout.bind(window);

    Object.defineProperty(window, "setTimeout", {
      configurable: true,
      value: (handler: TimerHandler, timeout?: number) =>
        nativeSetTimeout(handler, timeout === 10_000 ? 250 : timeout),
    });
    window.fetch = (input, init) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      const address = new URL(requestUrl, window.location.origin);
      if (address.pathname !== "/api/account/profile") {
        return nativeFetch(input, init);
      }

      Reflect.set(window, "__setLivreQaProfileTimeoutStarted", true);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal === undefined || signal === null) {
        return Promise.reject(new Error("A leitura de perfil não recebeu AbortSignal."));
      }
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) {
          rejectOnAbort();
          return;
        }
        signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
    };
  });

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const started = Reflect.get(window, "__setLivreQaProfileTimeoutStarted") === true;
          if (!started) {
            window.dispatchEvent(new Event("visibilitychange"));
          }
          return started;
        }),
      {
        intervals: [100, 250, 500],
        message: "A revalidação privada com timeout não iniciou.",
        timeout: 5_000,
      },
    )
    .toBe(true);
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
    await fillFeat003PhoneWithoutReportValue(phoneControl, invalidForeignPrefix);
    await expect(phoneControl).toHaveValue(formatFeat003PhoneForDisplay(invalidForeignPrefix));
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CPF" }), validCpf);
    await expect(individualChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(
      page.getByText("Informe um telefone brasileiro válido.", { exact: true }),
    ).toBeVisible();

    await fillFeat003PhoneWithoutReportValue(phoneControl, invalidFormattedExcess);
    await expect(phoneControl).toHaveValue(formatFeat003PhoneForDisplay(invalidFormattedExcess));
    await stageFeat003SensitiveValue(page.getByRole("textbox", { name: "CPF" }), validCpf);
    await expect(individualChoice).toBeChecked();
    await page.getByRole("button", { name: "Concluir perfil" }).click();
    await expect(
      page.getByText("Informe um telefone brasileiro válido.", { exact: true }),
    ).toBeVisible();

    await fillFeat003PhoneWithoutReportValue(phoneControl, "(41) 99999-1003");
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

test("SL-F003-E2E-009 @p1 fecha PII, rejeita fila offline e recupera timeout/conflito", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat003QaIdentity(testInfo, "009_estados");
  const secrets = createFeat003ProfileSecrets("individual");
  const offlineSecrets = createFeat003ProfileSecrets("individual");
  const profileName = "Pessoa QA Boundary Privado";
  const profilePhone = "+55 (41) 99999-1009";
  const offlineName = "Pessoa QA Alteração Offline";
  const offlinePhone = "+55 (41) 99999-2009";
  const recoveredName = "Pessoa QA Recuperação Online";
  const recoveredPhone = "+55 (41) 99999-3009";
  const fetchRequestStarted = createDeferredSignal();
  const releaseFetchRequest = createDeferredSignal();
  const logoutRequestStarted = createDeferredSignal();
  const releaseLogoutRequest = createDeferredSignal();
  let profileCommandRequests = 0;
  let logoutRequests = 0;

  try {
    await registerAndConfirmFeat003Identity(page, identity, "individual");
    await gotoExpectedPage(page, "/conta", "Minha conta");
    const initialProfile = await completeFeat003Profile(page, {
      name: profileName,
      personType: "individual",
      phone: profilePhone,
      secrets,
    });
    page.on("request", (request) => {
      const address = new URL(request.url());
      if (address.pathname === "/api/commands" && request.method() === "POST") {
        profileCommandRequests += 1;
      }
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
    await triggerVisibilityRefetch(page, fetchRequestStarted, "revalidação privada inicial");
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

    await page.getByRole("textbox", { name: "Nome completo" }).fill(offlineName);
    await fillFeat003PhoneWithoutReportValue(
      page.getByRole("textbox", { name: "Telefone" }),
      offlinePhone,
    );
    await page.getByRole("combobox", { name: "Alterar CPF" }).selectOption("replace");
    const replacementTaxId = page.getByRole("textbox", { name: "Novo CPF" });
    await stageFeat003SensitiveValue(replacementTaxId, offlineSecrets.taxId);
    await page
      .getByRole("combobox", { name: "Alterar documento adicional" })
      .selectOption("replace");
    const replacementDocument = page.getByRole("textbox", {
      name: "Novo documento adicional",
    });
    await stageFeat003SensitiveValue(replacementDocument, offlineSecrets.additionalDocument);
    await page.context().setOffline(true);
    let commandsAfterOfflineFailure = 0;
    try {
      await page.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
      });
      await page.getByRole("button", { name: "Salvar alterações" }).click();
      await expect(
        page
          .getByRole("alert")
          .filter({ has: page.getByText("Não foi possível salvar", { exact: true }) }),
      ).toContainText("Não foi possível conectar. Verifique sua internet e tente novamente.");
      await expect(page.getByRole("button", { name: "Salvar alterações" })).toBeEnabled();
      await expect(replacementTaxId).toHaveValue("");
      await expect(replacementDocument).toHaveValue("");
      await assertFeat003SecretsAbsentFromDom(page, [
        secrets.taxId,
        secrets.additionalDocument,
        offlineSecrets.taxId,
        offlineSecrets.additionalDocument,
      ]);
      commandsAfterOfflineFailure = profileCommandRequests;
    } finally {
      await page.context().setOffline(false);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("online"));
      });
    }
    const reconnectBarrier = await page.evaluate(async () => {
      try {
        const response = await fetch("/api/account/profile", {
          cache: "no-store",
          credentials: "same-origin",
        });
        return response.status;
      } catch {
        return 0;
      }
    });
    if (reconnectBarrier !== 200) {
      throw new Error("A barreira de rede após o reconnect da mutação não foi concluída.");
    }
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    if (profileCommandRequests !== commandsAfterOfflineFailure) {
      throw new Error("Uma mutação pausada enviou POST tardio após o reconnect.");
    }
    await expect(page.getByRole("heading", { level: 2, name: "Dados do perfil" })).toBeVisible();
    await page.getByRole("combobox", { name: "Alterar CPF" }).selectOption("keep");
    await page.getByRole("combobox", { name: "Alterar documento adicional" }).selectOption("keep");
    await page.getByRole("textbox", { name: "Nome completo" }).fill(recoveredName);
    await fillFeat003PhoneWithoutReportValue(
      page.getByRole("textbox", { name: "Telefone" }),
      recoveredPhone,
    );
    await page.getByRole("button", { name: "Salvar alterações" }).click();
    await expect(page.getByText("Dados do perfil atualizados.", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => profileCommandRequests, {
        message: "A recuperação online deve enviar exatamente um novo comando de perfil.",
        timeout: 15_000,
      })
      .toBe(commandsAfterOfflineFailure + 1);
    const recoveryResponse = await page.request.get("/api/account/profile");
    if (recoveryResponse.status() !== 200) {
      throw new Error("A recuperação online do perfil não pôde ser relida de forma autoritativa.");
    }
    const recoveryPayload: unknown = await recoveryResponse.json();
    const recoveredProfile = assertFeat003SafeProfileResult(
      apiSuccessSchema(myProfileResultSchema).parse(recoveryPayload).data,
      [
        secrets.taxId,
        secrets.additionalDocument,
        offlineSecrets.taxId,
        offlineSecrets.additionalDocument,
      ],
    );
    if (
      profileCommandRequests !== commandsAfterOfflineFailure + 1 ||
      recoveredProfile.profile.profileVersion !== initialProfile.profile.profileVersion + 1
    ) {
      throw new Error("A tentativa offline foi retomada ou alterou a versão autoritativa.");
    }
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText(recoveredName);
    await expect(page.getByLabel("Resumo do perfil salvo")).not.toContainText(offlineName);
    const recoveredPrivateValues = [
      recoveredName,
      formatFeat003PhoneForDisplay(recoveredPhone),
      `***.***.***-${secrets.taxId.slice(-2)}`,
      maskedFeat003AdditionalDocument(secrets.additionalDocument),
    ];
    await assertFeat003SecretsAbsentFromDom(page, [
      secrets.taxId,
      secrets.additionalDocument,
      offlineSecrets.taxId,
      offlineSecrets.additionalDocument,
    ]);

    await installPendingProfileRead(page);
    await expect(page.getByText("Validando seus dados privados…", { exact: true })).toBeVisible();
    await assertFeat003PrivateValuesAbsentFromDom(page, recoveredPrivateValues);
    await assertFeat003SecretsAbsentFromDom(page, [
      secrets.taxId,
      secrets.additionalDocument,
      offlineSecrets.taxId,
      offlineSecrets.additionalDocument,
    ]);
    await expect(
      page
        .getByRole("alert")
        .filter({ has: page.getByText("Perfil indisponível", { exact: true }) }),
    ).toContainText("A solicitação demorou mais que o esperado");
    await assertFeat003PrivateValuesAbsentFromDom(page, recoveredPrivateValues);
    await assertFeat003SecretsAbsentFromDom(page, [
      secrets.taxId,
      secrets.additionalDocument,
      offlineSecrets.taxId,
      offlineSecrets.additionalDocument,
    ]);
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
    await assertFeat003SecretsAbsentFromDom(page, [
      secrets.taxId,
      secrets.additionalDocument,
      offlineSecrets.taxId,
      offlineSecrets.additionalDocument,
    ]);

    await gotoExpectedPage(page, "/conta/seguranca", "Segurança da conta");
    await expect(page.getByText(identity.email, { exact: true })).toBeVisible();
    page.on("request", (request) => {
      const address = new URL(request.url());
      if (address.pathname === "/api/auth/logout" && request.method() === "POST") {
        logoutRequests += 1;
      }
    });
    await page.route(
      "**/api/auth/logout",
      async (route) => {
        logoutRequestStarted.resolve();
        await releaseLogoutRequest.promise;
        await route.fulfill({
          body: JSON.stringify({
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Não foi possível confirmar a saída agora.",
              requestId: "30000000-0000-4000-8000-000000000019",
            },
          }),
          contentType: "application/json",
          status: 503,
        });
      },
      { times: 1 },
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await page.getByRole("button", { name: "Sair desta conta" }).click();
    await waitForDeferredSignal(logoutRequestStarted, "logout com resultado ambíguo");
    expect(logoutRequests).toBe(1);
    await expect(
      page.getByText("Validando sua sessão antes de exibir dados privados…", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(identity.email, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Saindo" })).toHaveCount(0);
    releaseLogoutRequest.resolve();
    await expect
      .poll(() => {
        const address = new URL(page.url());
        return `${address.pathname}${address.search}`;
      })
      .toBe("/entrar?saida=verificar");
    await expect(page.getByText("A sessão ainda está ativa", { exact: true })).toBeVisible();
    await expect(page.getByText(identity.email, { exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("online"));
    });
    const logoutReconnectBarrier = await page.evaluate(async () => {
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "same-origin",
        });
        return response.status;
      } catch {
        return 0;
      }
    });
    if (logoutReconnectBarrier !== 200) {
      throw new Error("A barreira de rede após o reconnect do logout não foi concluída.");
    }
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    if (logoutRequests !== 1) {
      throw new Error("Um logout pausado enviou POST tardio após o reconnect.");
    }
    await expectNoHorizontalOverflow(page);
  } finally {
    releaseFetchRequest.resolve();
    releaseLogoutRequest.resolve();
    await cleanupFeat003QaIdentity(identity);
  }
});
