import {
  apiSuccessSchema,
  myProfileResultSchema,
  ownerActivationResultSchema,
} from "@set-livre/contracts";
import { expect, test, type BrowserContext } from "@playwright/test";

import {
  activateFeat004Owner,
  assertFeat004PrivateValuesAbsent,
  cleanupFeat004QaIdentity,
  createFeat004QaIdentity,
  gotoFeat004Recipient,
  provisionFeat004Profile,
  readFeat004OwnerRecipient,
  refreshFeat004Recipient,
  startFeat004Recipient,
} from "../../helpers/feat-004-owner-onboarding-recipient";
import { switchFeat003SessionWithoutNavigation } from "../../helpers/feat-003-profile-account";

function deferredSignal() {
  let resolve: () => void = () => {
    throw new Error("O sinal assíncrono FEAT-004 não foi inicializado.");
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("SL-F004-E2E-001 @p0 ativa dono somente após aceite explícito do contrato vigente", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat004QaIdentity(testInfo, "001_activation");
  let ownerCommandRequests = 0;

  try {
    await provisionFeat004Profile(page, identity, {
      name: "Pessoa QA Dono Ativação",
      phone: "(41) 99999-4001",
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands") {
        ownerCommandRequests += 1;
      }
    });
    await expect(
      page.getByText("Contrato não aprovado para produção", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Este texto é uma fixture local para desenvolvimento e testes. Não constitui contrato jurídico aprovado.",
        { exact: true },
      ),
    ).toBeVisible();
    const checkbox = page.getByRole("checkbox", { name: /Li e aceito o Contrato do Dono/iu });
    await expect(checkbox).not.toBeChecked();

    await page.getByRole("button", { name: "Ativar perfil de dono" }).click();
    await expect(checkbox).toHaveAttribute("aria-invalid", "true");
    expect(ownerCommandRequests).toBe(0);

    const result = await activateFeat004Owner(page);
    expect(result.acceptedOwnerContractVersionId).toBe(result.ownerContract.id);
    expect(JSON.stringify(result)).not.toMatch(/admin|platformRole/iu);
    expect(ownerCommandRequests).toBe(1);
    await expect(
      page.getByRole("heading", { level: 2, name: "Perfil de dono ativo" }),
    ).toBeVisible();

    const firstRenewal = ownerActivationResultSchema.parse({
      ...result,
      acceptedOwnerContractVersionId: result.ownerContract.id,
      nextAction: "activate_owner",
      ownerContract: {
        ...result.ownerContract,
        effectiveAt: new Date(Date.parse(result.ownerContract.effectiveAt) + 1_000).toISOString(),
        id: "40040001-0000-4000-8000-000000000001",
        version: "local-renewal-a",
      },
      ownerContractAccepted: false,
      reservationsEligible: false,
    });
    const secondRenewal = ownerActivationResultSchema.parse({
      ...firstRenewal,
      ownerContract: {
        ...firstRenewal.ownerContract,
        effectiveAt: new Date(
          Date.parse(firstRenewal.ownerContract.effectiveAt) + 1_000,
        ).toISOString(),
        id: "40040002-0000-4000-8000-000000000002",
        version: "local-renewal-b",
      },
    });
    const publishRenewal = async (renewal: typeof firstRenewal, requestId: string) => {
      await page.route(
        "**/api/owner/activation",
        (route) =>
          route.fulfill({
            body: JSON.stringify({ data: renewal, requestId }),
            contentType: "application/json",
            status: 200,
          }),
        { times: 1 },
      );
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "GET" &&
          new URL(candidate.url()).pathname === "/api/owner/activation",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await response;
    };

    await publishRenewal(firstRenewal, "40040001-0000-4000-8000-000000000011");
    const renewalCheckbox = page.getByRole("checkbox", {
      name: /Li e aceito o Contrato do Dono, versão local-renewal-a/iu,
    });
    await renewalCheckbox.check();
    await expect(renewalCheckbox).toBeChecked();

    await publishRenewal(secondRenewal, "40040002-0000-4000-8000-000000000012");
    const currentContractCheckbox = page.getByRole("checkbox", {
      name: /Li e aceito o Contrato do Dono, versão local-renewal-b/iu,
    });
    await expect(currentContractCheckbox).not.toBeChecked();
    await page.getByRole("button", { name: "Aceitar contrato vigente" }).click();
    await expect(currentContractCheckbox).toHaveAttribute("aria-invalid", "true");
    expect(ownerCommandRequests).toBe(1);
    await currentContractCheckbox.check();
    await expect(currentContractCheckbox).toBeChecked();
    await assertFeat004PrivateValuesAbsent(page);
  } finally {
    await cleanupFeat004QaIdentity(identity);
  }
});

test("SL-F004-E2E-002 @p0 inicia adapter local e publica somente o estado pendente seguro", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const identity = createFeat004QaIdentity(testInfo, "002_start");

  try {
    await provisionFeat004Profile(page, identity, {
      name: "Pessoa QA Dono Início",
      phone: "(41) 99999-4002",
    });
    await activateFeat004Owner(page);
    await gotoFeat004Recipient(page);
    await expect(
      page.getByText("Validação exclusiva do ambiente local", { exact: true }),
    ).toBeVisible();

    const result = await startFeat004Recipient(page);
    expect(result.requirements).toEqual(["identity_review"]);
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toBeVisible();
    await expect(page.getByText("Análise de identidade", { exact: true })).toBeVisible();
    await assertFeat004PrivateValuesAbsent(page);
  } finally {
    await cleanupFeat004QaIdentity(identity);
  }
});

test("SL-F004-E2E-003 @p0 ativa recebedor e fecha elegibilidade após drift do perfil", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const identity = createFeat004QaIdentity(testInfo, "003_eligibility");

  try {
    await provisionFeat004Profile(page, identity, {
      name: "Pessoa QA Dono Elegibilidade",
      phone: "(41) 99999-4003",
    });
    await activateFeat004Owner(page);
    await gotoFeat004Recipient(page);
    await startFeat004Recipient(page);
    const active = await refreshFeat004Recipient(page);
    expect(active.profileVersionSynced).toBe(active.profileVersion);
    await expect(page.getByRole("heading", { level: 3, name: "Ativo" })).toBeVisible();
    await expect(page.getByText(/elegibilidade local está liberada/iu)).toBeVisible();

    await page.goto("/conta");
    await expect(page.getByRole("heading", { level: 2, name: "Dados do perfil" })).toBeVisible();
    await page.getByRole("textbox", { name: "Nome completo" }).fill("Pessoa QA Perfil Alterado");
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/commands",
    );
    await page.getByRole("button", { name: "Salvar alterações" }).click();
    const profileResponse = await responsePromise;
    expect(profileResponse.status()).toBe(200);
    const profilePayload: unknown = await profileResponse.json();
    const profile = apiSuccessSchema(myProfileResultSchema).parse(profilePayload).data;

    await page.goto("/dono/recebimentos");
    await expect(
      page.getByRole("heading", { level: 1, name: "Cadastro de recebimentos" }),
    ).toBeVisible();
    const drifted = await readFeat004OwnerRecipient(page);
    expect(drifted).toMatchObject({
      profileVersion: profile.profile.profileVersion,
      recipientStatus: "active",
      reservationsEligible: false,
    });
    expect(drifted.profileVersionSynced).not.toBe(drifted.profileVersion);
    await expect(
      page.getByRole("heading", { level: 3, name: "Atualização necessária" }),
    ).toBeVisible();
    await expect(page.getByText(/perfil mudou desde a última sincronização/iu)).toBeVisible();

    const resynchronized = await refreshFeat004Recipient(page);
    expect(resynchronized.reservationsEligible).toBe(true);
    expect(resynchronized.profileVersionSynced).toBe(resynchronized.profileVersion);
  } finally {
    await cleanupFeat004QaIdentity(identity);
  }
});

test("SL-F004-E2E-005 @p0 fecha A antes de publicar B e preserva o estado de B", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const identityA = createFeat004QaIdentity(testInfo, "005_a");
  const identityB = createFeat004QaIdentity(testInfo, "005_b");
  const getCaptured = deferredSignal();
  const releaseGet = deferredSignal();
  let contextB: BrowserContext | undefined;
  let pageErrors = 0;
  let reactBoundaryErrors = 0;

  page.on("pageerror", () => {
    pageErrors += 1;
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /flushSync|hydration|removeChild|not a child/iu.test(message.text())
    ) {
      reactBoundaryErrors += 1;
    }
  });

  try {
    await provisionFeat004Profile(page, identityA, {
      name: "Pessoa QA Owner Escopo A",
      phone: "(41) 99999-4005",
    });
    await activateFeat004Owner(page);
    await gotoFeat004Recipient(page);
    await startFeat004Recipient(page);
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toBeVisible();

    contextB = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      viewport: { height: 900, width: 1440 },
    });
    const pageB = await contextB.newPage();
    await provisionFeat004Profile(pageB, identityB, {
      name: "Pessoa QA Owner Escopo B",
      phone: "(41) 99999-5005",
    });
    await activateFeat004Owner(pageB);
    await contextB.close();
    contextB = undefined;

    await page.route(
      "**/api/owner/recipient",
      async (route) => {
        const response = await route.fetch();
        getCaptured.resolve();
        await releaseGet.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await page.evaluate(() => {
      const key = "sl-qa-f004-owner-scope-transition";
      const main = document.querySelector<HTMLElement>("main");
      const statusHeading = main?.querySelector<HTMLHeadingElement>("h3");
      const action = main?.querySelector<HTMLButtonElement>("button");
      if (
        main === null ||
        main === undefined ||
        statusHeading === null ||
        statusHeading === undefined ||
        action === null ||
        action === undefined
      ) {
        sessionStorage.setItem(key, "probe-error:surface-missing");
        return;
      }
      sessionStorage.setItem(key, "armed");
      main.dataset.slQaPrivateSurface = "owner-scope-transition";
      window.addEventListener(
        "pagehide",
        () => {
          const connectedNodes = [
            statusHeading.isConnected ? "status" : undefined,
            action.isConnected ? "action" : undefined,
          ].filter((node): node is string => node !== undefined);
          const renderedMain = document.querySelector<HTMLElement>(
            'main[data-sl-qa-private-surface="owner-scope-transition"]',
          );
          const privateText = renderedMain?.textContent ?? "";
          if (connectedNodes.length > 0) {
            sessionStorage.setItem(key, `leak:nodes:${connectedNodes.join(",")}`);
          } else if (/Em análise local|Atualizar status/iu.test(privateText)) {
            sessionStorage.setItem(key, "leak:private-copy");
          } else {
            sessionStorage.setItem(key, "clear");
          }
        },
        { once: true },
      );
    });
    const switched = await switchFeat003SessionWithoutNavigation(page, identityB);
    expect(switched.session).toMatchObject({ authenticated: true, userId: identityB.userId });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await getCaptured.promise;
    const reload = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    releaseGet.resolve();
    await expect(
      page.getByText("Validando o estado privado da área do dono…", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toHaveCount(0);
    await reload;
    await expect(
      page.getByRole("heading", { level: 1, name: "Cadastro de recebimentos" }),
    ).toBeVisible();
    const transitionEvidence = await page.evaluate(() => {
      const key = "sl-qa-f004-owner-scope-transition";
      const value = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      return value;
    });
    expect(transitionEvidence).toBe("clear");
    await expect(page.getByRole("heading", { level: 3, name: "Não iniciado" })).toBeVisible();
    const visibleB = await readFeat004OwnerRecipient(page);
    expect(visibleB).toMatchObject({
      recipientStatus: "not_started",
      scope: identityB.userId,
    });
    expect(visibleB.scope).not.toBe(identityA.userId);
    expect(pageErrors).toBe(0);
    expect(reactBoundaryErrors).toBe(0);
  } finally {
    releaseGet.resolve();
    await contextB?.close();
    await cleanupFeat004QaIdentity(identityA);
    await cleanupFeat004QaIdentity(identityB);
  }
});
