import { expect, test, type Page } from "@playwright/test";

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

test.use({ screenshot: "off", trace: "off", video: "off" });

async function expectFeat004Reflow(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const interactiveElements = [...document.querySelectorAll<HTMLElement>("a, button, input")];
        return {
          allInteractiveElementsFit: interactiveElements.every((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              bounds.left >= -0.5 && bounds.right <= document.documentElement.clientWidth + 0.5
            );
          }),
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

test("SL-F004-E2E-007 @p1 contrato, checklist, status e recuperação operam em 160x360", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  expect(page.viewportSize()).toEqual({ height: 360, width: 160 });
  const identity = createFeat004QaIdentity(testInfo, "007_reflow");

  try {
    await provisionFeat004Profile(page, identity, {
      name: "Pessoa QA Dono Reflow",
      phone: "(41) 99999-4007",
    });
    await expect(
      page.getByRole("heading", { level: 2, name: "Etapas para receber reservas" }),
    ).toBeVisible();
    await expect(
      page.getByText("Contrato não aprovado para produção", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: /Li e aceito o Contrato do Dono/iu }),
    ).toBeVisible();
    await expectFeat004Reflow(page);

    await activateFeat004Owner(page);
    await expect(
      page.getByRole("heading", { level: 2, name: "Perfil de dono ativo" }),
    ).toBeVisible();
    await expectFeat004Reflow(page);

    await gotoFeat004Recipient(page);
    await expect(page.getByRole("heading", { level: 3, name: "Não iniciado" })).toBeVisible();
    await startFeat004Recipient(page);
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toBeVisible();
    await expectFeat004Reflow(page);

    await seedFeat004RecipientTestFixture(identity, "unavailable");
    const failedResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/commands",
    );
    await page.getByRole("button", { name: "Atualizar status" }).click();
    const failedResponse = await failedResponsePromise;
    expect(failedResponse.status()).toBe(503);
    await expect(page.getByRole("button", { name: "Verificar estado atual" })).toBeVisible();
    await expect(
      page.getByText("Confirme o estado atual antes de tentar novamente", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Atualizar status" })).toBeDisabled();
    await assertFeat004PrivateValuesAbsent(page);
    await expectFeat004Reflow(page);

    const verificationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/owner/recipient",
    );
    await page.getByRole("button", { name: "Verificar estado atual" }).click();
    const verificationResponse = await verificationResponsePromise;
    expect(verificationResponse.status()).toBe(200);
    await expect(
      page.getByText("Confirme o estado atual antes de tentar novamente", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atualizar status" })).toBeEnabled();
    await expect(
      page.getByRole("heading", { level: 2, name: "Etapas para receber reservas" }),
    ).toBeFocused();
    await expectFeat004Reflow(page);

    await page.route(
      "**/api/owner/recipient",
      (route) =>
        route.fulfill({
          body: JSON.stringify({
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Não foi possível validar a área do dono agora.",
              requestId: "40040007-0000-4000-8000-000000000007",
            },
          }),
          contentType: "application/json",
          status: 503,
        }),
      { times: 1 },
    );
    const failedReadPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/owner/recipient",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    expect((await failedReadPromise).status()).toBe(503);
    const readError = page.getByText("Área do dono indisponível", { exact: true });
    await expect(readError).toBeVisible();

    const retriedReadPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/owner/recipient",
    );
    await page.getByRole("button", { name: "Tentar novamente" }).click();
    expect((await retriedReadPromise).status()).toBe(200);
    await expect(readError).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 2, name: "Etapas para receber reservas" }),
    ).toBeFocused();
    await expectFeat004Reflow(page);
  } finally {
    await cleanupFeat004QaIdentity(identity);
  }
});
