import { expect, test } from "@playwright/test";

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

test("SL-F004-E2E-004 @p1 recupera falha ambígua do provider sem repetir o POST", async ({
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
  let ownerPostRequests = 0;
  let ownerGetRequests = 0;

  try {
    await provisionFeat004Profile(page, identity, {
      name: "Pessoa QA Dono Recuperação",
      phone: "(41) 99999-4004",
    });
    await activateFeat004Owner(page);
    await gotoFeat004Recipient(page);
    await startFeat004Recipient(page);
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/api/commands") ownerPostRequests += 1;
      if (request.method() === "GET" && path === "/api/owner/recipient") ownerGetRequests += 1;
    });
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
    expect(ownerPostRequests).toBe(1);

    await page.getByRole("button", { name: "Verificar estado atual" }).click();
    await expect(
      page.getByText("Confirme o estado atual antes de tentar novamente", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 3, name: "Em análise local" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atualizar status" })).toBeEnabled();
    await expect(
      page.getByRole("heading", { level: 2, name: "Etapas para receber reservas" }),
    ).toBeFocused();
    expect(ownerGetRequests).toBe(1);
    expect(ownerPostRequests).toBe(1);
    await assertFeat004PrivateValuesAbsent(page);

    if (testInfo.project.name === "mobile-chromium-390") {
      expect(page.viewportSize()).toEqual({ height: 844, width: 390 });
    }
    if (testInfo.project.name === "narrow-chromium-320") {
      expect(page.viewportSize()).toEqual({ height: 720, width: 320 });
    }
  } finally {
    await cleanupFeat004QaIdentity(identity);
  }
});
