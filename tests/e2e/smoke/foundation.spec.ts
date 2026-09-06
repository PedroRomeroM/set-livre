import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  expectPresentRawHtmlScriptsUseNonce,
  expectRawHtmlScriptsUseNonce,
  policyNonce,
} from "../../helpers/content-security-policy";
import { readSafeE2EEnvironment } from "../../helpers/e2e-environment";
import { gotoExpectedPage } from "../../helpers/expected-page";

const { publicBaseUrl, backofficeBaseUrl } = readSafeE2EEnvironment();

function expectHtmlIsNotStored(cacheControl: string) {
  expect(cacheControl).toContain("no-store");
  expect(cacheControl).not.toContain("immutable");
}

async function expectNonceProtectedDocument(
  request: APIRequestContext,
  url: string,
  expectedStatus: number,
  headers: Record<string, string> = {},
) {
  const response = await request.get(url, { headers });
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()["content-type"]).toContain("text/html");
  const nonce = policyNonce(response.headers()["content-security-policy"] ?? "");
  expectHtmlIsNotStored(response.headers()["cache-control"] ?? "");
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

async function expectStaticAssetErrorsCannotBypassPolicy(
  request: APIRequestContext,
  baseUrl: string,
) {
  const documentResponse = await request.get(baseUrl);
  await expect(documentResponse).toBeOK();
  const assetUrl = staticAssetUrl(await documentResponse.text(), baseUrl);
  const assetResponse = await request.get(assetUrl);
  await expect(assetResponse).toBeOK();
  const nonces = [policyNonce(assetResponse.headers()["content-security-policy"] ?? "")];
  const assetCacheControl = assetResponse.headers()["cache-control"] ?? "";
  if (baseUrl === backofficeBaseUrl) {
    expectHtmlIsNotStored(assetCacheControl);
    expect(assetCacheControl).toContain("private");
  } else {
    expect(assetCacheControl).toBe("public, max-age=31536000, immutable");
  }

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
      expectHtmlIsNotStored(response.headers()["cache-control"] ?? "");
      expectPresentRawHtmlScriptsUseNonce(await response.text(), nonce);
    }
  }

  expect(new Set(nonces).size, "Assets e seus erros precisam receber nonces independentes.").toBe(
    nonces.length,
  );
}

async function expectNonceProtectedPage(
  page: Page,
  request: APIRequestContext,
  url: string,
  heading: string,
) {
  const navigation = await gotoExpectedPage(page, url, heading);
  const firstPolicy = navigation.headers()["content-security-policy"] ?? "";
  const firstNonce = policyNonce(firstPolicy);
  expectHtmlIsNotStored(navigation.headers()["cache-control"] ?? "");

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
          __setLivreCspViolations?: Array<{
            blockedURI: string;
            directive: string;
            source: string;
          }>;
          next?: { appDir?: boolean; version?: string };
        };
        return {
          appRouter: nextRuntime.next?.appDir === true,
          cspViolations: nextRuntime.__setLivreCspViolations,
          flightData: Array.isArray(nextRuntime.__next_f),
          runtimeVersion: typeof nextRuntime.next?.version === "string",
        };
      }),
    )
    .toEqual({ appRouter: true, cspViolations: [], flightData: true, runtimeVersion: true });

  const secondResponse = await request.get(url);
  await expect(secondResponse).toBeOK();
  const secondPolicy = secondResponse.headers()["content-security-policy"] ?? "";
  const secondNonce = policyNonce(secondPolicy);
  expectHtmlIsNotStored(secondResponse.headers()["cache-control"] ?? "");
  expect(secondNonce).not.toBe(firstNonce);
  expectRawHtmlScriptsUseNonce(await secondResponse.text(), secondNonce);
}

test("FOUNDATION-E2E-001 fronteiras expõem somente superfícies autorizadas", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const cspWindow = window as typeof window & {
      __setLivreCspViolations?: Array<{ blockedURI: string; directive: string; source: string }>;
    };
    cspWindow.__setLivreCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      cspWindow.__setLivreCspViolations?.push({
        blockedURI: event.blockedURI.split("?")[0] ?? "",
        directive: event.effectiveDirective,
        source: event.sourceFile.split("?")[0] ?? "",
      });
    });
  });

  await expectNonceProtectedPage(page, request, backofficeBaseUrl, "Operação Set Livre");
  await expect(page.getByText("Acesso restrito a operadores autorizados")).toBeVisible();
  await expect(page.getByRole("button", { name: "Entrar no backoffice" })).toBeVisible();
  await expect(page.getByText("Backoffice · fundação técnica", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/ambiente local|base local/iu)).toHaveCount(0);

  await expectNonceProtectedPage(page, request, "/", "Set Livre");
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
    await expectNonceProtectedDocument(request, baseUrl, 200, {
      purpose: "prefetch",
    });
    await expectNonceProtectedDocument(request, baseUrl, 200, {
      "next-router-prefetch": "1",
    });
    for (const path of [
      "/apiary",
      "/api-public",
      "/faviconXico",
      "/favicon.ico/extra",
      "/_next/imageish",
    ]) {
      await expectNonceProtectedDocument(request, new URL(path, baseUrl).toString(), 404);
    }
    await expectNonceProtectedGlobalError(request, baseUrl);
    await expectStaticAssetErrorsCannotBypassPolicy(request, baseUrl);
  }

  await expect(page.getByRole("status")).toContainText("Fundação executável");
  await expect(page.getByText("Nenhuma feature de produto é simulada.")).toBeVisible();
});

test("FOUNDATION-E2E-006 composições respeitam o viewport configurado", async ({ page }) => {
  for (const [surface, url, heading] of [
    ["public", "/", "Set Livre"],
    ["backoffice", backofficeBaseUrl, "Operação Set Livre"],
  ] as const) {
    await gotoExpectedPage(page, url, heading);
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    const finalContent =
      surface === "public"
        ? page.getByText(
            "Esta tela comprova somente a fundação técnica. Nenhuma feature de produto é simulada.",
          )
        : page.getByRole("button", { name: "Entrar no backoffice" });
    await finalContent.scrollIntoViewIfNeeded();
    await expect(finalContent).toBeInViewport();
  }
});
