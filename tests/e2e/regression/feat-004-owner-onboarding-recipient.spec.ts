import {
  apiSuccessSchema,
  ownerActivationResultSchema,
  ownerRecipientStatusSchema,
} from "@set-livre/contracts";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  activateFeat004Owner,
  assertFeat004PrivateValuesAbsent,
  cleanupFeat004QaIdentity,
  createFeat004QaIdentity,
  gotoFeat004Recipient,
  provisionFeat004Profile,
  seedFeat004RecipientTestFixture,
  startFeat004Recipient,
} from "../../helpers/feat-004-owner-onboarding-recipient";

async function publishRecipientOnboardingCapability(
  page: Page,
  capability: "local_adapter" | "unavailable",
) {
  const responseMarker = "x-set-livre-e2e-recipient-capability";
  let routeHits = 0;
  await page.route(
    "**/api/owner/recipient",
    async (route) => {
      routeHits += 1;
      const response = await route.fetch();
      const payload: unknown = await response.json();
      const parsed = apiSuccessSchema(ownerRecipientStatusSchema).parse(payload);
      const data = ownerRecipientStatusSchema.parse({
        ...parsed.data,
        recipientOnboardingCapability: capability,
      });
      await route.fulfill({
        body: JSON.stringify({ data, requestId: parsed.requestId }),
        headers: {
          ...response.headers(),
          [responseMarker]: capability,
        },
        response,
      });
    },
    { times: 1 },
  );
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "GET" &&
      new URL(candidate.url()).pathname === "/api/owner/recipient" &&
      candidate.headers()[responseMarker] === capability,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  expect((await response).status()).toBe(200);
  expect(routeHits).toBe(1);
}

async function publishOwnerActivationCapability(
  page: Page,
  capability: "available" | "unavailable",
) {
  const responseMarker = "x-set-livre-e2e-activation-capability";
  let routeHits = 0;
  await page.route(
    "**/api/owner/activation",
    async (route) => {
      routeHits += 1;
      const response = await route.fetch();
      const payload: unknown = await response.json();
      const parsed = apiSuccessSchema(ownerActivationResultSchema).parse(payload);
      expect(parsed.data.ownerContract.source).toBe("local_fixture");
      const data = ownerActivationResultSchema.parse({
        ...parsed.data,
        ownerActivationCapability: capability,
      });
      await route.fulfill({
        body: JSON.stringify({ data, requestId: parsed.requestId }),
        headers: {
          ...response.headers(),
          [responseMarker]: capability,
        },
        response,
      });
    },
    { times: 1 },
  );
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "GET" &&
      new URL(candidate.url()).pathname === "/api/owner/activation" &&
      candidate.headers()[responseMarker] === capability,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  expect((await response).status()).toBe(200);
  expect(routeHits).toBe(1);
}

test("SL-F004-E2E-004 @p1 recupera estado concorrente e falha ambígua sem repetir POST", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  expect([
    "compact-height-chromium",
    "desktop-chromium",
    "mobile-chromium-390",
    "narrow-chromium-320",
  ]).toContain(testInfo.project.name);
  const identity = createFeat004QaIdentity(testInfo, "004_provider_recovery");
  let concurrentContext: BrowserContext | undefined;
  let ownerPostRequests = 0;
  let ownerGetRequests = 0;

  try {
    await provisionFeat004Profile(page, identity, {
      name: "Pessoa QA Dono Recuperação",
      phone: "(41) 99999-4004",
    });
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/api/commands") ownerPostRequests += 1;
    });

    await expect(
      page.getByRole("checkbox", { name: /Li e aceito o Contrato do Dono/iu }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Ativar perfil de dono" })).toBeEnabled();
    await publishOwnerActivationCapability(page, "unavailable");
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Contrato do dono — fixture local",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Contrato não aprovado para produção", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Conteúdo exclusivo para desenvolvimento e testes locais. Não constitui contrato jurídico aprovado para produção.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Ativação como dono indisponível");
    await expect(page.getByRole("status")).toContainText(
      "A versão aprovada do contrato do dono ainda não está disponível neste ambiente. O contrato atual permanece somente para consulta.",
    );
    await expect(
      page.getByRole("checkbox", { name: /Li e aceito o Contrato do Dono/iu }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ativar perfil de dono" })).toHaveCount(0);
    expect(ownerPostRequests).toBe(0);

    await publishOwnerActivationCapability(page, "available");
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByText("Contrato não aprovado para produção", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: /Li e aceito o Contrato do Dono/iu }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Ativar perfil de dono" })).toBeEnabled();
    expect(ownerPostRequests).toBe(0);

    await activateFeat004Owner(page);
    expect(ownerPostRequests).toBe(1);
    ownerPostRequests = 0;
    await gotoFeat004Recipient(page);
    const recipientStartButton = page.getByRole("button", {
      name: "Iniciar validação local",
    });
    await expect(recipientStartButton).toBeVisible();
    await expect(recipientStartButton).toBeEnabled();
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname === "/api/owner/recipient"
      ) {
        ownerGetRequests += 1;
      }
    });
    await publishRecipientOnboardingCapability(page, "unavailable");
    await expect(page.getByRole("status")).toContainText("Cadastro de recebimentos indisponível");
    await expect(page.getByRole("status")).toContainText(
      "A integração de recebimentos ainda não está disponível neste ambiente. O estado atual permanece somente para consulta.",
    );
    await expect(
      page.getByText("Validação exclusiva do ambiente local", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 3, name: "Não iniciado" })).toBeVisible();
    await expect(recipientStartButton).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Atualizar status" })).toHaveCount(0);
    expect(ownerPostRequests).toBe(0);

    await publishRecipientOnboardingCapability(page, "local_adapter");
    await expect(
      page.getByText("Validação exclusiva do ambiente local", { exact: true }),
    ).toBeVisible();
    await expect(recipientStartButton).toBeVisible();
    await expect(recipientStartButton).toBeEnabled();
    expect(ownerPostRequests).toBe(0);
    ownerGetRequests = 0;

    concurrentContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      storageState: await page.context().storageState(),
    });
    const concurrentPage = await concurrentContext.newPage();
    const concurrentNavigation = await concurrentPage.goto("/dono/recebimentos");
    expect(concurrentNavigation?.status()).toBe(200);
    await expect(
      concurrentPage.getByRole("heading", { level: 1, name: "Cadastro de recebimentos" }),
    ).toBeVisible();
    await startFeat004Recipient(concurrentPage);
    expect(ownerGetRequests).toBe(0);

    const conflictResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/commands",
    );
    await recipientStartButton.click();
    const conflictResponse = await conflictResponsePromise;
    expect(conflictResponse.status()).toBe(409);
    expect(ownerGetRequests).toBe(0);

    await expect(page.getByText("O cadastro mudou em outro lugar", { exact: true })).toBeVisible();
    await expect(recipientStartButton).toBeDisabled();
    expect(ownerPostRequests).toBe(1);

    await page.getByRole("button", { name: "Verificar estado atual" }).click();
    await expect(page.getByText("O cadastro mudou em outro lugar", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atualizar status" })).toBeEnabled();
    await expect(
      page.getByRole("heading", { level: 2, name: "Etapas para receber reservas" }),
    ).toBeFocused();
    expect(ownerGetRequests).toBe(1);
    expect(ownerPostRequests).toBe(1);

    await publishRecipientOnboardingCapability(page, "unavailable");
    await expect(page.getByRole("status")).toContainText("Cadastro de recebimentos indisponível");
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toBeVisible();
    await expect(recipientStartButton).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Atualizar status" })).toHaveCount(0);
    expect(ownerPostRequests).toBe(1);

    await publishRecipientOnboardingCapability(page, "local_adapter");
    await expect(
      page.getByText("Validação exclusiva do ambiente local", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Atualizar status" })).toBeEnabled();
    expect(ownerGetRequests).toBe(3);
    expect(ownerPostRequests).toBe(1);
    const ownerGetRequestsBeforeAmbiguousRecovery = ownerGetRequests;

    await seedFeat004RecipientTestFixture(
      identity,
      testInfo.project.name === "narrow-chromium-320" ||
        testInfo.project.name === "mobile-chromium-390"
        ? "timeout"
        : "unavailable",
    );

    const failedResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/commands",
    );
    await page.getByRole("button", { name: "Atualizar status" }).click();
    const failedResponse = await failedResponsePromise;
    expect(failedResponse.status()).toBe(503);
    await expect(
      page.getByText("Confirme o estado atual antes de tentar novamente", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atualizar status" })).toBeDisabled();
    expect(ownerPostRequests).toBe(2);

    await page.getByRole("button", { name: "Verificar estado atual" }).click();
    await expect(
      page.getByText("Confirme o estado atual antes de tentar novamente", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atualizar status" })).toBeEnabled();
    await expect(
      page.getByRole("heading", { level: 2, name: "Etapas para receber reservas" }),
    ).toBeFocused();
    expect(ownerGetRequests).toBe(ownerGetRequestsBeforeAmbiguousRecovery + 1);
    expect(ownerPostRequests).toBe(2);
    await assertFeat004PrivateValuesAbsent(page);

    if (testInfo.project.name === "mobile-chromium-390") {
      expect(page.viewportSize()).toEqual({ height: 844, width: 390 });
    }
    if (testInfo.project.name === "narrow-chromium-320") {
      expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
    }
  } finally {
    await concurrentContext?.close();
    await cleanupFeat004QaIdentity(identity);
  }
});
