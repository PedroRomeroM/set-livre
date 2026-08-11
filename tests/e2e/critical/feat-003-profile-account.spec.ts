import { expect, test, type BrowserContext } from "@playwright/test";

import { logoutFeat002Identity } from "../../helpers/feat-002-authentication";
import {
  assertFeat003PrivateValuesAbsentFromDom,
  assertFeat003SecretsAbsentFromDom,
  cleanupFeat003QaIdentity,
  completeFeat003Profile,
  createFeat003ProfileSecrets,
  createFeat003QaIdentity,
  formatFeat003PhoneForDisplay,
  loginFeat003Identity,
  maskedFeat003AdditionalDocument,
  registerAndConfirmFeat003Identity,
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
  test.setTimeout(180_000);
  const identityA = createFeat003QaIdentity(testInfo, "004_a");
  const identityB = createFeat003QaIdentity(testInfo, "004_b");
  const secretsA = createFeat003ProfileSecrets("individual");
  const secretsB = createFeat003ProfileSecrets("company");
  const nameA = "Pessoa QA Isolamento Alfa";
  const nameB = "Empresa QA Isolamento Beta";
  const phoneA = "+55 (41) 99999-1004";
  const phoneB = "+55 (41) 99999-2004";
  const transitionRequestStarted = createDeferredSignal();
  const releaseTransitionRequest = createDeferredSignal();
  let contextB: BrowserContext | undefined;

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
    expect(profileA.scope).toBe(sessionA.userId);

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
    expect(profileB.scope).toBe(sessionB.userId);
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

    const switchedSession = await switchFeat003SessionWithoutNavigation(page, identityB);
    expect(switchedSession.session).toMatchObject({
      authenticated: true,
      userId: sessionB.userId,
    });
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
        sessionStorage.setItem(key, "armed");
        const inspect = () => {
          const text = document.body.textContent ?? "";
          const values = [
            ...document.querySelectorAll<
              HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
            >("input, select, textarea"),
          ].map((control) => control.value);
          if (
            forbiddenValues.some(
              (value) => text.includes(value) || values.some((entry) => entry.includes(value)),
            )
          ) {
            sessionStorage.setItem(key, "leak");
          }
        };
        const observer = new MutationObserver(inspect);
        observer.observe(document.documentElement, {
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
            if (sessionStorage.getItem(key) !== "leak") {
              sessionStorage.setItem(key, "clear");
            }
            observer.disconnect();
          },
          { once: true },
        );
      },
      [...privateValuesA, ...privateValuesB],
    );

    const reload = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    releaseTransitionRequest.resolve();
    await reload;
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
    await assertFeat003SecretsAbsentFromDom(page, [
      secretsA.taxId,
      secretsA.additionalDocument,
      secretsB.taxId,
      secretsB.additionalDocument,
    ]);
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
