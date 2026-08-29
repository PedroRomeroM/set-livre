import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { gotoExpectedPage } from "../../helpers/expected-page";

const publicBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const backofficeBaseUrl = process.env.E2E_BACKOFFICE_URL ?? "http://127.0.0.1:3001";

function scriptDirective(contentSecurityPolicy: string) {
  return (
    contentSecurityPolicy
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src ")) ?? ""
  );
}

function policyNonce(contentSecurityPolicy: string) {
  const scriptSource = scriptDirective(contentSecurityPolicy);
  const matches = [...scriptSource.matchAll(/'nonce-([a-f0-9]{32})'/gu)];
  expect(matches, "script-src deve declarar exatamente um nonce por request.").toHaveLength(1);
  expect(scriptSource).toContain("'strict-dynamic'");
  expect(scriptSource).toContain("'unsafe-eval'");
  expect(scriptSource).not.toContain("'unsafe-inline'");
  return matches[0]?.[1] ?? "";
}

function expectRawHtmlScriptsUseNonce(html: string, nonce: string) {
  const scriptTags = html.match(/<script(?:\s[^>]*)?>/gu) ?? [];
  expect(
    scriptTags.length,
    "O HTML precisa conter o bootstrap JavaScript do Next.",
  ).toBeGreaterThan(0);
  expect(
    scriptTags.every((scriptTag) => scriptTag.includes(`nonce="${nonce}"`)),
    "Todo script do HTML precisa usar o nonce da mesma response.",
  ).toBe(true);
}

function expectPresentRawHtmlScriptsUseNonce(html: string, nonce: string) {
  const scriptTags = html.match(/<script(?:\s[^>]*)?>/gu) ?? [];
  expect(
    scriptTags.every((scriptTag) => scriptTag.includes(`nonce="${nonce}"`)),
    "Todo script presente no HTML de erro precisa usar o nonce da mesma response.",
  ).toBe(true);
}

function expectDevelopmentHtmlRequiresRevalidation(cacheControl: string) {
  expect(cacheControl).toContain("no-cache");
  expect(cacheControl).toContain("must-revalidate");
}

async function expectNonceProtectedDevelopmentDocument(
  request: APIRequestContext,
  url: string,
  expectedStatus: number,
  headers: Record<string, string> = {},
) {
  const response = await request.get(url, { headers });
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()["content-type"]).toContain("text/html");
  const nonce = policyNonce(response.headers()["content-security-policy"] ?? "");
  expectDevelopmentHtmlRequiresRevalidation(response.headers()["cache-control"] ?? "");
  expectRawHtmlScriptsUseNonce(await response.text(), nonce);
}

async function expectNonceProtectedGlobalError(request: APIRequestContext, baseUrl: string) {
  const response = await request.get(new URL("/_global-error", baseUrl).toString());
  expect(response.status()).toBe(500);
  expect(response.headers()["content-type"]).toContain("text/html");
  policyNonce(response.headers()["content-security-policy"] ?? "");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const html = await response.text();
  expect(html.match(/<script(?:\s[^>]*)?>/gu) ?? []).toHaveLength(0);
  expect(html).toContain("Tente novamente");
}

function staticAssetUrl(html: string, baseUrl: string) {
  const source = html.match(/<script\s[^>]*src="([^"]*\/_next\/static\/[^"]+)"[^>]*>/u)?.[1];
  expect(source, "O documento precisa referenciar um asset estático real do Next.").toBeDefined();
  return new URL((source ?? "").replaceAll("&amp;", "&"), baseUrl).toString();
}

async function expectStaticAssetErrorsCannotBypassDevelopmentPolicy(
  request: APIRequestContext,
  baseUrl: string,
) {
  const documentResponse = await request.get(baseUrl);
  await expect(documentResponse).toBeOK();
  const assetUrl = staticAssetUrl(await documentResponse.text(), baseUrl);
  const assetResponse = await request.get(assetUrl);
  await expect(assetResponse).toBeOK();
  const nonces = [policyNonce(assetResponse.headers()["content-security-policy"] ?? "")];
  expectDevelopmentHtmlRequiresRevalidation(assetResponse.headers()["cache-control"] ?? "");

  const adversarialResponses = [
    await request.post(assetUrl),
    await request.get(assetUrl, { headers: { range: "bytes=999999999999999999-" } }),
    await request.get(new URL("/_next/static/%2F", baseUrl).toString()),
  ];
  for (const response of adversarialResponses) {
    expect(response.status()).toBeGreaterThanOrEqual(400);
    const nonce = policyNonce(response.headers()["content-security-policy"] ?? "");
    nonces.push(nonce);
    if ((response.headers()["content-type"] ?? "").includes("text/html")) {
      expectDevelopmentHtmlRequiresRevalidation(response.headers()["cache-control"] ?? "");
      expectPresentRawHtmlScriptsUseNonce(await response.text(), nonce);
    }
  }

  expect(new Set(nonces).size, "Assets e seus erros precisam receber nonces independentes.").toBe(
    nonces.length,
  );
}

async function expectNonceProtectedDevelopmentPage(
  page: Page,
  request: APIRequestContext,
  url: string,
  heading: string,
) {
  const navigation = await gotoExpectedPage(page, url, heading);
  const firstPolicy = navigation.headers()["content-security-policy"] ?? "";
  const firstNonce = policyNonce(firstPolicy);
  expectDevelopmentHtmlRequiresRevalidation(navigation.headers()["cache-control"] ?? "");

  const browserScriptNonces = await page
    .locator("script")
    .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).nonce));
  expect(browserScriptNonces.length).toBeGreaterThan(0);
  const browserNonces = browserScriptNonces.filter((nonce) => nonce !== "");
  expect(browserNonces.length).toBeGreaterThan(0);
  expect(browserNonces.every((nonce) => nonce === firstNonce)).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const nextRuntime = window as typeof window & {
          __next_f?: unknown[];
          __setLivreCspViolations?: number;
          next?: { appDir?: boolean; version?: string };
        };
        return (
          Array.isArray(nextRuntime.__next_f) &&
          nextRuntime.next?.appDir === true &&
          typeof nextRuntime.next.version === "string" &&
          nextRuntime.__setLivreCspViolations === 0
        );
      }),
    )
    .toBe(true);

  const secondResponse = await request.get(url);
  await expect(secondResponse).toBeOK();
  const secondPolicy = secondResponse.headers()["content-security-policy"] ?? "";
  const secondNonce = policyNonce(secondPolicy);
  expectDevelopmentHtmlRequiresRevalidation(secondResponse.headers()["cache-control"] ?? "");
  expect(secondNonce).not.toBe(firstNonce);
  expectRawHtmlScriptsUseNonce(await secondResponse.text(), secondNonce);
}

test("FOUNDATION-E2E-001 plataforma pública expõe apenas o status da fundação", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const cspWindow = window as typeof window & { __setLivreCspViolations?: number };
    cspWindow.__setLivreCspViolations = 0;
    document.addEventListener("securitypolicyviolation", () => {
      cspWindow.__setLivreCspViolations = (cspWindow.__setLivreCspViolations ?? 0) + 1;
    });
  });

  await expectNonceProtectedDevelopmentPage(page, request, backofficeBaseUrl, "Operação Set Livre");
  await expect(page.getByText("Backoffice · fundação técnica", { exact: true })).toBeVisible();
  await expect(page.getByText(/ambiente local|base local/iu)).toHaveCount(0);

  await expectNonceProtectedDevelopmentPage(page, request, "/", "Set Livre");
  await expect(
    page.getByText("Plataforma pública · fundação técnica", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A fundação de aplicações, contratos, qualidade e segurança está ativa. A experiência pública será construída na FEAT-001.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(/ambiente local|base local/iu)).toHaveCount(0);

  for (const baseUrl of [publicBaseUrl, backofficeBaseUrl]) {
    await expectNonceProtectedDevelopmentDocument(request, baseUrl, 200, {
      purpose: "prefetch",
    });
    await expectNonceProtectedDevelopmentDocument(request, baseUrl, 200, {
      "next-router-prefetch": "1",
    });
    for (const path of [
      "/apiary",
      "/api-public",
      "/faviconXico",
      "/favicon.ico/extra",
      "/_next/imageish",
    ]) {
      await expectNonceProtectedDevelopmentDocument(
        request,
        new URL(path, baseUrl).toString(),
        404,
      );
    }
    await expectNonceProtectedGlobalError(request, baseUrl);
    await expectStaticAssetErrorsCannotBypassDevelopmentPolicy(request, baseUrl);
  }

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
