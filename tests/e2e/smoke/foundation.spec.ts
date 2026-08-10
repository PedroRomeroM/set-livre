import { expect, test } from "@playwright/test";

import { gotoExpectedPage } from "../../helpers/expected-page";

const backofficeBaseUrl = process.env.E2E_BACKOFFICE_URL ?? "http://127.0.0.1:3001";

test("FOUNDATION-E2E-001 plataforma pública expõe apenas o status da fundação", async ({
  page,
}) => {
  await gotoExpectedPage(page, "/", "Set Livre");

  await expect(page.getByRole("status")).toContainText("Fundação executável");
  await expect(page.getByText("Nenhuma feature de produto é simulada.")).toBeVisible();
});

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

test("FOUNDATION-E2E-006 composições respeitam o viewport configurado", async ({ page }) => {
  for (const [url, heading] of [
    ["/", "Set Livre"],
    [backofficeBaseUrl, "Operação Set Livre"],
  ] as const) {
    await gotoExpectedPage(page, url, heading);
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    const finalNote = page.getByText(
      "Esta tela comprova somente a fundação técnica. Nenhuma feature de produto é simulada.",
    );
    await finalNote.scrollIntoViewIfNeeded();
    await expect(finalNote).toBeInViewport();
  }
});
