import { expect, test } from "@playwright/test";

import { readSafeE2EEnvironment } from "../../helpers/e2e-environment";

const { backofficeBaseUrl } = readSafeE2EEnvironment();

test("FOUNDATION-E2E-003 health endpoints retornam contrato autoritativo", async ({ request }) => {
  const propagatedRequestId = "e65fe64c-3788-4cf0-beb3-c344025b0bb0";
  const publicHealth = await request.get("/api/health/live", {
    headers: { "x-request-id": propagatedRequestId },
  });
  const backofficeHealth = await request.get(`${backofficeBaseUrl}/api/health/live`);
  const publicReadiness = await request.get("/api/health/ready");
  const backofficeReadiness = await request.get(`${backofficeBaseUrl}/api/health/ready`);

  await expect(publicHealth).toBeOK();
  await expect(backofficeHealth).toBeOK();
  await expect(publicReadiness).toBeOK();
  await expect(backofficeReadiness).toBeOK();
  expect(publicHealth.headers()["x-request-id"]).toBe(propagatedRequestId);
  expect(publicHealth.headers()["cache-control"]).toContain("no-store");
  expect(backofficeHealth.headers()["cache-control"]).toContain("no-store");
  await expect(publicHealth.json()).resolves.toMatchObject({
    application: "web",
    release: "local",
    requestId: propagatedRequestId,
    status: "live",
  });
  await expect(backofficeHealth.json()).resolves.toMatchObject({
    application: "backoffice",
    status: "live",
  });
  await expect(publicReadiness.json()).resolves.toMatchObject({
    application: "web",
    status: "ready",
  });
  await expect(backofficeReadiness.json()).resolves.toMatchObject({
    application: "backoffice",
    status: "ready",
  });
});

test("FOUNDATION-E2E-005 app público não expõe rota administrativa", async ({ page }) => {
  const response = await page.goto("/admin");

  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Operação Set Livre" })).toHaveCount(0);
});
