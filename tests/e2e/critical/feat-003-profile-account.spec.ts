import {
  apiErrorSchema,
  apiSuccessSchema,
  identitySessionSchema,
  myProfileResultSchema,
  profileUpdateCommandSchema,
} from "@set-livre/contracts";
import { expect, test, type BrowserContext } from "@playwright/test";

import { logoutFeat002Identity } from "../../helpers/feat-002-authentication";
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
  loginFeat003Identity,
  maskedFeat003AdditionalDocument,
  registerAndConfirmFeat003Identity,
  stageFeat003SensitiveValue,
  switchFeat003SessionWithoutNavigation,
} from "../../helpers/feat-003-profile-account";
import { gotoExpectedPage } from "../../helpers/expected-page";

test.use({ screenshot: "off", trace: "off", video: "off" });

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

function createDeferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal assíncrono do cenário de isolamento não foi inicializado.");
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("SL-F003-E2E-001 @p0 completa perfil PF e retorna ao destino /conta", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const identity = createFeat003QaIdentity(testInfo, "001_pf");
  const secrets = createFeat003ProfileSecrets("individual");

  try {
    await registerAndConfirmFeat003Identity(page, identity, "individual");
    await logoutFeat002Identity(page);

    const redirected = await page.goto("/conta");
    expect(redirected?.status()).toBe(200);
    await expectCurrentPath(page, "/entrar?retorno=%2Fconta");
    await expect(page.getByRole("heading", { level: 1, name: "Entre na sua conta" })).toBeVisible();

    await loginFeat003Identity(page, identity, "/conta");
    await expect(page.getByRole("heading", { level: 1, name: "Minha conta" })).toBeVisible();
    const profile = await completeFeat003Profile(page, {
      name: "Pessoa QA Perfil Individual",
      personType: "individual",
      phone: "(41) 99999-1001",
      secrets,
    });

    expect(profile.profile).toMatchObject({
      completed: true,
      personType: "individual",
      status: "active",
      taxIdMasked: `***.***.***-${secrets.taxId.slice(-2)}`,
    });
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText("Pessoa física");
    await expect(page.getByText("Perfil concluído com segurança.", { exact: true })).toBeVisible();
  } finally {
    await cleanupFeat003QaIdentity(identity);
  }
});

test("SL-F003-E2E-002 @p0 completa perfil PJ com CNPJ alfanumérico", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const identity = createFeat003QaIdentity(testInfo, "002_pj");
  const secrets = createFeat003ProfileSecrets("company");

  try {
    await registerAndConfirmFeat003Identity(page, identity, "company");
    await gotoExpectedPage(page, "/conta", "Minha conta");
    const profile = await completeFeat003Profile(page, {
      name: "Estúdio QA Empresa Audiovisual",
      personType: "company",
      phone: "(41) 99999-1002",
      secrets,
    });

    if (!/[A-Z]/u.test(secrets.taxId.slice(0, 12))) {
      throw new Error("O cenário PJ não recebeu um CNPJ alfanumérico sintético.");
    }
    expect(profile.profile).toMatchObject({
      completed: true,
      personType: "company",
      status: "active",
      taxIdMasked: `**.***.***/****-${secrets.taxId.slice(-2)}`,
    });
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText("Pessoa jurídica");
    await expect(page.getByText("Perfil concluído com segurança.", { exact: true })).toBeVisible();
  } finally {
    await cleanupFeat003QaIdentity(identity);
  }
});

test("SL-F003-E2E-004 @p0 revalida A→B no mesmo QueryClient sem publicar cache cruzado", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const identityA = createFeat003QaIdentity(testInfo, "004_a");
  const identityB = createFeat003QaIdentity(testInfo, "004_b");
  const secretsA = createFeat003ProfileSecrets("individual");
  const secretsB = createFeat003ProfileSecrets("company");
  const staleSecretsA = createFeat003ProfileSecrets("individual");
  const nameA = "Pessoa QA Isolamento Alfa";
  const nameB = "Empresa QA Isolamento Beta";
  const staleNameA = "Pessoa QA Alteração Stale";
  const phoneA = "+55 (41) 99999-1004";
  const phoneB = "+55 (41) 99999-2004";
  const stalePhoneA = "+55 (41) 99999-3004";
  const transitionRequestStarted = createDeferredSignal();
  const releaseTransitionRequest = createDeferredSignal();
  let pageErrorCount = 0;
  let reactBoundaryConsoleErrorCount = 0;
  let contextB: BrowserContext | undefined;

  page.on("pageerror", () => {
    pageErrorCount += 1;
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /flushSync|hydration|removeChild|not a child/iu.test(message.text())
    ) {
      reactBoundaryConsoleErrorCount += 1;
    }
  });

  try {
    const sessionA = await registerAndConfirmFeat003Identity(page, identityA, "individual");
    const localOrigin = new URL(page.url()).origin;
    await gotoExpectedPage(page, "/conta", "Minha conta");
    const profileA = await completeFeat003Profile(page, {
      name: nameA,
      personType: "individual",
      phone: phoneA,
      secrets: secretsA,
    });
    if (profileA.scope !== sessionA.userId) {
      throw new Error("O perfil A não corresponde ao escopo local provisionado.");
    }

    contextB = await browser.newContext({
      baseURL: localOrigin,
      viewport: { height: 900, width: 1440 },
    });
    const pageB = await contextB.newPage();
    const sessionB = await registerAndConfirmFeat003Identity(pageB, identityB, "company");
    await gotoExpectedPage(pageB, "/conta", "Minha conta");
    const profileB = await completeFeat003Profile(pageB, {
      name: nameB,
      personType: "company",
      phone: phoneB,
      secrets: secretsB,
    });
    if (profileB.scope !== sessionB.userId) {
      throw new Error("O perfil B não corresponde ao escopo local provisionado.");
    }
    await contextB.close();
    contextB = undefined;

    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText(nameA);
    await expect(page.getByLabel("Resumo do perfil salvo")).not.toContainText(nameB);
    const privateValuesA = [
      nameA,
      formatFeat003PhoneForDisplay(phoneA),
      `***.***.***-${secretsA.taxId.slice(-2)}`,
      maskedFeat003AdditionalDocument(secretsA.additionalDocument),
    ];
    const privateValuesB = [
      nameB,
      formatFeat003PhoneForDisplay(phoneB),
      `**.***.***/****-${secretsB.taxId.slice(-2)}`,
      maskedFeat003AdditionalDocument(secretsB.additionalDocument),
    ];
    await page.route(
      "**/api/account/profile",
      async (route) => {
        transitionRequestStarted.resolve();
        await releaseTransitionRequest.promise;
        await route.continue();
      },
      { times: 1 },
    );
    const transitionSession = await switchFeat003SessionWithoutNavigation(page, identityB);
    if (
      transitionSession.session.authenticated !== true ||
      transitionSession.session.userId !== sessionB.userId
    ) {
      throw new Error("A sessão B não foi publicada para a revalidação do QueryClient.");
    }
    await expectCurrentPath(page, "/conta");
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await transitionRequestStarted.promise;
    await expect(page.getByText("Validando seus dados privados…", { exact: true })).toBeVisible();
    await assertFeat003PrivateValuesAbsentFromDom(page, [...privateValuesA, ...privateValuesB]);
    await assertFeat003SecretsAbsentFromDom(page, [
      secretsA.taxId,
      secretsA.additionalDocument,
      secretsB.taxId,
      secretsB.additionalDocument,
    ]);
    await page.evaluate(
      (forbiddenValues) => {
        const key = "sl-qa-f003-scope-transition";
        const forbiddenLabels = [
          "scope-a-name",
          "scope-a-phone",
          "scope-a-tax-mask",
          "scope-a-document-mask",
          "scope-b-name",
          "scope-b-phone",
          "scope-b-tax-mask",
          "scope-b-document-mask",
        ];
        sessionStorage.setItem(key, "armed");
        if (forbiddenValues.length !== forbiddenLabels.length) {
          sessionStorage.setItem(key, "probe-error:value-catalog");
          return;
        }
        const privateSurface = document.querySelector<HTMLElement>("main");
        if (privateSurface === null) {
          sessionStorage.setItem(key, "probe-error:surface-missing");
          return;
        }
        privateSurface.dataset.slQaPrivateSurface = "scope-transition";
        const inspect = () => {
          const renderedSurface = document.querySelector<HTMLElement>(
            'main[data-sl-qa-private-surface="scope-transition"]',
          );
          if (renderedSurface === null) {
            sessionStorage.setItem(key, "probe-error:surface-detached");
            return;
          }
          const text = renderedSurface.textContent ?? "";
          const values = [
            ...renderedSurface.querySelectorAll<
              HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
            >("input, select, textarea"),
          ].map((control) => control.value);
          const textLeak = forbiddenValues.findIndex((value) => text.includes(value));
          if (textLeak !== -1) {
            sessionStorage.setItem(key, `leak:value-text:${forbiddenLabels[textLeak]}`);
            return;
          }
          const controlLeak = forbiddenValues.findIndex((value) =>
            values.some((entry) => entry.includes(value)),
          );
          if (controlLeak !== -1) {
            sessionStorage.setItem(key, `leak:value-control:${forbiddenLabels[controlLeak]}`);
          }
        };
        const observer = new MutationObserver(inspect);
        observer.observe(privateSurface, {
          attributeFilter: ["value"],
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        window.addEventListener(
          "pagehide",
          () => {
            inspect();
            if (sessionStorage.getItem(key) === "armed") {
              sessionStorage.setItem(key, "clear");
            }
            observer.disconnect();
          },
          { once: true },
        );
      },
      [...privateValuesA, ...privateValuesB],
    );
    const transitionReload = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    releaseTransitionRequest.resolve();
    await transitionReload;
    await expect(page.getByRole("heading", { level: 1, name: "Minha conta" })).toBeVisible();
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText(nameB);
    await expect(page.getByLabel("Resumo do perfil salvo")).not.toContainText(nameA);
    const transitionLeak = await page.evaluate(() => {
      const key = "sl-qa-f003-scope-transition";
      const result = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      return result;
    });
    expect(transitionLeak).toBe("clear");
    await assertFeat003PrivateValuesAbsentFromDom(page, privateValuesA);

    const returnedSession = await switchFeat003SessionWithoutNavigation(page, identityA);
    if (
      returnedSession.session.authenticated !== true ||
      returnedSession.session.userId !== sessionA.userId
    ) {
      throw new Error("A sessão A não foi restaurada para preparar a tentativa stale.");
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Minha conta" })).toBeVisible();
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText(nameA);
    await expect(page.getByLabel("Resumo do perfil salvo")).not.toContainText(nameB);

    await page.getByRole("textbox", { name: "Nome completo" }).fill(staleNameA);
    await fillFeat003PhoneWithoutReportValue(
      page.getByRole("textbox", { name: "Telefone" }),
      stalePhoneA,
    );
    await page.getByRole("combobox", { name: "Alterar CPF" }).selectOption("replace");
    await stageFeat003SensitiveValue(
      page.getByRole("textbox", { name: "Novo CPF" }),
      staleSecretsA.taxId,
    );
    await page
      .getByRole("combobox", { name: "Alterar documento adicional" })
      .selectOption("replace");
    await stageFeat003SensitiveValue(
      page.getByRole("textbox", { name: "Novo documento adicional" }),
      staleSecretsA.additionalDocument,
    );

    const switchedSession = await switchFeat003SessionWithoutNavigation(page, identityB);
    if (
      switchedSession.session.authenticated !== true ||
      switchedSession.session.userId !== sessionB.userId
    ) {
      throw new Error("A sessão B não foi publicada antes da tentativa stale.");
    }
    await expectCurrentPath(page, "/conta");
    await page.evaluate(
      (forbiddenValues) => {
        const key = "sl-qa-f003-stale-command-reload";
        const forbiddenLabels = [
          "scope-a-name",
          "scope-a-phone",
          "scope-a-tax-mask",
          "scope-a-document-mask",
          "scope-b-name",
          "scope-b-phone",
          "scope-b-tax-mask",
          "scope-b-document-mask",
          "stale-a-name",
          "stale-a-phone",
          "stale-a-tax-id",
          "stale-a-document",
        ];
        sessionStorage.setItem(key, "armed");
        if (forbiddenValues.length !== forbiddenLabels.length) {
          sessionStorage.setItem(key, "probe-error:value-catalog");
          return;
        }
        const privateSurface = document.querySelector<HTMLElement>("main");
        const summary = privateSurface?.querySelector<HTMLElement>(
          '[aria-label="Resumo do perfil salvo"]',
        );
        const profileSection = summary?.closest("section");
        const heading = profileSection?.querySelector<HTMLHeadingElement>("h2");
        const form = profileSection?.querySelector<HTMLFormElement>("form");
        const controls =
          form === null || form === undefined
            ? []
            : [
                ...form.querySelectorAll<
                  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
                >("input, select, textarea"),
              ];
        if (
          privateSurface === null ||
          summary === null ||
          summary === undefined ||
          profileSection === null ||
          profileSection === undefined ||
          heading === null ||
          heading === undefined ||
          heading.textContent?.trim() !== "Dados do perfil" ||
          form === null ||
          form === undefined ||
          controls.length === 0
        ) {
          sessionStorage.setItem(key, "probe-error:profile-surface-missing");
          return;
        }
        privateSurface.dataset.slQaPrivateSurface = "stale-command";
        const inspect = () => {
          const connectedNodes = [
            heading.isConnected ? "heading" : undefined,
            summary.isConnected ? "summary" : undefined,
            form.isConnected ? "form" : undefined,
            controls.some((control) => control.isConnected) ? "control" : undefined,
          ].filter((node): node is string => node !== undefined);
          if (connectedNodes.length > 0) {
            sessionStorage.setItem(key, `leak:nodes:${connectedNodes.join(",")}`);
            return;
          }
          const renderedSurface = document.querySelector<HTMLElement>(
            'main[data-sl-qa-private-surface="stale-command"]',
          );
          if (renderedSurface === null) {
            sessionStorage.setItem(key, "probe-error:surface-detached");
            return;
          }
          const text = renderedSurface.textContent ?? "";
          const values = [
            ...renderedSurface.querySelectorAll<
              HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
            >("input, select, textarea"),
          ].map((control) => control.value);
          const textLeak = forbiddenValues.findIndex((value) => text.includes(value));
          if (textLeak !== -1) {
            sessionStorage.setItem(key, `leak:value-text:${forbiddenLabels[textLeak]}`);
            return;
          }
          const controlLeak = forbiddenValues.findIndex((value) =>
            values.some((entry) => entry.includes(value)),
          );
          if (controlLeak !== -1) {
            sessionStorage.setItem(key, `leak:value-control:${forbiddenLabels[controlLeak]}`);
          }
        };
        window.addEventListener(
          "pagehide",
          () => {
            inspect();
            if (sessionStorage.getItem(key) === "armed") {
              sessionStorage.setItem(key, "clear");
            }
          },
          { once: true },
        );
      },
      [
        ...privateValuesA,
        ...privateValuesB,
        staleNameA,
        formatFeat003PhoneForDisplay(stalePhoneA),
        staleSecretsA.taxId,
        staleSecretsA.additionalDocument,
      ],
    );

    let staleCommandEvidence:
      | {
          payload: unknown;
          requestBody: string | null;
          status: number;
        }
      | undefined;
    await page.route(
      "**/api/commands",
      async (route) => {
        const response = await route.fetch();
        staleCommandEvidence = {
          payload: (await response.json()) as unknown,
          requestBody: route.request().postData(),
          status: response.status(),
        };
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    const reload = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Salvar alterações" }).click();
    await reload;
    if (staleCommandEvidence === undefined) {
      throw new Error("O comando stale não foi capturado antes da recomposição SSR.");
    }
    const { payload: rejectedPayload, requestBody, status } = staleCommandEvidence;
    if (status !== 409) {
      throw new Error("O comando stale não foi rejeitado com conflito de sessão.");
    }
    let rejectedCommandBody: unknown;
    try {
      rejectedCommandBody = JSON.parse(requestBody ?? "null") as unknown;
    } catch {
      throw new Error("O comando stale não publicou um envelope JSON válido.");
    }
    const submittedCommand = profileUpdateCommandSchema.safeParse(rejectedCommandBody);
    if (
      !submittedCommand.success ||
      submittedCommand.data.expectedScope !== sessionA.userId ||
      submittedCommand.data.payload.section !== "identity" ||
      submittedCommand.data.payload.taxIdChange.action !== "replace" ||
      submittedCommand.data.payload.taxIdChange.value !== staleSecretsA.taxId ||
      submittedCommand.data.payload.documentChange.action !== "replace" ||
      submittedCommand.data.payload.documentChange.value !== staleSecretsA.additionalDocument
    ) {
      throw new Error("O POST stale não preservou o escopo A e o payload one-shot esperado.");
    }
    const rejected = apiErrorSchema.safeParse(rejectedPayload);
    if (!rejected.success || rejected.data.error.code !== "SESSION_CHANGED") {
      throw new Error("O comando stale não retornou o erro público de sessão esperada.");
    }
    await expect(page.getByRole("heading", { level: 1, name: "Minha conta" })).toBeVisible();
    await expect(page.getByLabel("Resumo do perfil salvo")).toContainText(nameB);
    await expect(page.getByLabel("Resumo do perfil salvo")).not.toContainText(nameA);
    await expect(page.getByLabel("Resumo do perfil salvo")).not.toContainText(staleNameA);
    const reloadEvidence = await page.evaluate(() => {
      const key = "sl-qa-f003-stale-command-reload";
      const result = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      return result;
    });
    expect(reloadEvidence).toBe("clear");
    await assertFeat003PrivateValuesAbsentFromDom(page, [
      ...privateValuesA,
      staleNameA,
      formatFeat003PhoneForDisplay(stalePhoneA),
    ]);
    await assertFeat003SecretsAbsentFromDom(page, [
      secretsA.taxId,
      secretsA.additionalDocument,
      secretsB.taxId,
      secretsB.additionalDocument,
      staleSecretsA.taxId,
      staleSecretsA.additionalDocument,
    ]);
    const currentProfileResponse = await page.request.get("/api/account/profile");
    if (currentProfileResponse.status() !== 200) {
      throw new Error("O perfil B não pôde ser relido após a recomposição SSR.");
    }
    const currentProfilePayload: unknown = await currentProfileResponse.json();
    const currentProfileEnvelope =
      apiSuccessSchema(myProfileResultSchema).safeParse(currentProfilePayload);
    if (!currentProfileEnvelope.success) {
      throw new Error("O perfil B recomposto não atende ao contrato público.");
    }
    const currentProfile = assertFeat003SafeProfileResult(currentProfileEnvelope.data.data, [
      secretsA.taxId,
      secretsA.additionalDocument,
      secretsB.taxId,
      secretsB.additionalDocument,
      staleSecretsA.taxId,
      staleSecretsA.additionalDocument,
    ]);
    if (JSON.stringify(currentProfile) !== JSON.stringify(profileB)) {
      throw new Error("O comando stale alterou o estado autoritativo do perfil B.");
    }
    const staleLogout = await page.evaluate(async (expectedScope) => {
      const response = await fetch("/api/auth/logout", {
        body: JSON.stringify({ expectedScope }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { payload: (await response.json()) as unknown, status: response.status };
    }, sessionA.userId);
    const staleLogoutError = apiErrorSchema.safeParse(staleLogout.payload);
    if (
      staleLogout.status !== 409 ||
      !staleLogoutError.success ||
      staleLogoutError.data.error.code !== "SESSION_CHANGED"
    ) {
      throw new Error("O logout stale de A não foi rejeitado antes de alcançar a sessão B.");
    }
    const sessionAfterStaleLogoutResponse = await page.request.get("/api/auth/session");
    if (sessionAfterStaleLogoutResponse.status() !== 200) {
      throw new Error("A sessão B foi encerrada pelo logout stale de A.");
    }
    const sessionAfterStaleLogoutPayload: unknown = await sessionAfterStaleLogoutResponse.json();
    const sessionAfterStaleLogout = apiSuccessSchema(identitySessionSchema).safeParse(
      sessionAfterStaleLogoutPayload,
    );
    if (
      !sessionAfterStaleLogout.success ||
      sessionAfterStaleLogout.data.data.authenticated !== true ||
      sessionAfterStaleLogout.data.data.userId !== sessionB.userId
    ) {
      throw new Error("O logout stale de A alterou o escopo autoritativo de B.");
    }
    const profileAfterStaleLogoutResponse = await page.request.get("/api/account/profile");
    if (profileAfterStaleLogoutResponse.status() !== 200) {
      throw new Error("O perfil B ficou inacessível após o logout stale de A.");
    }
    const profileAfterStaleLogoutPayload: unknown = await profileAfterStaleLogoutResponse.json();
    const profileAfterStaleLogout = apiSuccessSchema(myProfileResultSchema).safeParse(
      profileAfterStaleLogoutPayload,
    );
    if (
      !profileAfterStaleLogout.success ||
      JSON.stringify(profileAfterStaleLogout.data.data) !== JSON.stringify(profileB)
    ) {
      throw new Error("O logout stale de A alterou o perfil autoritativo de B.");
    }
    expect(pageErrorCount).toBe(0);
    expect(reactBoundaryConsoleErrorCount).toBe(0);
    await assertFeat003PrivateValuesAbsentFromDom(page, privateValuesA);
  } finally {
    releaseTransitionRequest.resolve();
    await contextB?.close();
    try {
      await cleanupFeat003QaIdentity(identityB);
    } finally {
      await cleanupFeat003QaIdentity(identityA);
    }
  }
});
