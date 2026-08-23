import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAXIMUM_JSON_BODY_BYTES,
  MINIMUM_TLS_CERTIFICATE_VALIDITY_MS,
  runProductionSmoke,
} from "../../scripts/production-smoke.mjs";

const release = "a".repeat(40);
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const wallClock = Date.parse("2026-08-18T12:00:00.000Z");
const redirectProbePath = "/__set_livre_production_smoke__?contract=redirect-v1";
const exactSubjectAlternativeNames = "DNS:ops.setlivre.com, DNS:setlivre.com, DNS:www.setlivre.com";
let nonceSequence = 0;

function nextNonce() {
  nonceSequence += 1;
  return nonceSequence.toString(16).padStart(32, "0");
}

function contentSecurityPolicy(nonce = nextNonce()) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "connect-src 'self'",
  ].join("; ");
}

function applicationSecurityHeaders(application, mutate, context) {
  const headers = new Headers({
    "content-security-policy": contentSecurityPolicy(),
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy":
      application === "backoffice" ? "no-referrer" : "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
  });
  mutate?.(headers, context);
  return headers;
}

function transportSecurityHeaders() {
  return new Headers({ "strict-transport-security": "max-age=31536000" });
}

function secureTextResponse(body, status, application, mutate, context) {
  return new Response(body, {
    headers: applicationSecurityHeaders(application, mutate, context),
    status,
  });
}

function secureJsonResponse(payload, status, application, mutate, context, additionalHeaders = {}) {
  const headers = applicationSecurityHeaders(application, mutate, context);
  headers.set("content-type", "application/json");
  for (const [name, value] of Object.entries(additionalHeaders)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(payload), { headers, status });
}

function health(application, status, releaseValue, mutate, context) {
  return secureJsonResponse(
    {
      application,
      checkedAt: "2026-08-18T12:00:00.000Z",
      release: releaseValue,
      requestId,
      status,
    },
    200,
    application,
    mutate,
    context,
  );
}

function unauthenticated(mutate, context) {
  return secureJsonResponse(
    { error: { code: "UNAUTHENTICATED", message: "safe", requestId } },
    401,
    "web",
    mutate,
    context,
    {
      "cache-control": "private, no-store",
      "x-request-id": requestId,
    },
  );
}

function environment(overrides = {}) {
  return {
    PRD_BACKOFFICE_APP_URL: "https://ops.setlivre.com",
    PRD_PUBLIC_APP_URL: "https://setlivre.com",
    RELEASE_SHA: release,
    SMOKE_ATTEMPTS: "1",
    SMOKE_INTERVAL_MS: "0",
    ...overrides,
  };
}

function createTlsProbe(mutate) {
  return vi.fn(async (request) => ({
    authorized: true,
    protocol: request.protocol,
    subjectAltName: exactSubjectAlternativeNames,
    validFrom: new Date(wallClock - 24 * 60 * 60 * 1000).toISOString(),
    validTo: new Date(wallClock + 14 * 24 * 60 * 60 * 1000).toISOString(),
    ...mutate?.(request),
  }));
}

function createFetch({
  healthRelease = release,
  httpDestination,
  mutateSecurityHeaders,
  httpsWwwDestination,
} = {}) {
  return vi.fn(async (input, init) => {
    const url = new URL(String(input));
    const context = { init, url };
    if (url.protocol === "http:") {
      if (url.pathname.startsWith("/.well-known/acme-challenge/")) {
        return new Response("not found", { status: 404 });
      }
      const canonicalHostname = url.hostname === "ops.setlivre.com" ? url.hostname : "setlivre.com";
      const destination =
        httpDestination?.(url) ?? `https://${canonicalHostname}${url.pathname}${url.search}`;
      return new Response(null, { headers: { location: destination }, status: 308 });
    }
    if (url.hostname === "www.setlivre.com") {
      const headers = transportSecurityHeaders();
      headers.set(
        "location",
        httpsWwwDestination ?? `https://setlivre.com${url.pathname}${url.search}`,
      );
      return new Response(null, { headers, status: 308 });
    }
    const application = url.hostname === "ops.setlivre.com" ? "backoffice" : "web";
    if (url.pathname === "/api/account/profile" || url.pathname === "/api/commands") {
      return unauthenticated(mutateSecurityHeaders, context);
    }
    if (url.pathname === "/api/health/live") {
      return health(application, "live", healthRelease, mutateSecurityHeaders, context);
    }
    if (url.pathname === "/api/health/ready") {
      return health(application, "ready", healthRelease, mutateSecurityHeaders, context);
    }
    if (application === "backoffice") {
      return secureTextResponse("forbidden", 403, application, mutateSecurityHeaders, context);
    }
    return secureTextResponse("ok", 200, application, mutateSecurityHeaders, context);
  });
}

function runSmoke({
  environmentOverrides,
  fetchImplementation = createFetch(),
  monotonicNow,
  sleep = vi.fn(),
  tlsProbeImplementation = createTlsProbe(),
  wallClockNow = () => wallClock,
} = {}) {
  return runProductionSmoke({
    environment: environment(environmentOverrides),
    fetchImplementation,
    monotonicNow,
    sleep,
    tlsProbeImplementation,
    wallClockNow,
  });
}

beforeEach(() => {
  nonceSequence = 0;
});

describe("production smoke", () => {
  it("checks canonical redirects, hardened surfaces and TLS 1.2/1.3 on every hostname", async () => {
    const fetchImplementation = createFetch();
    const tlsProbeImplementation = createTlsProbe();
    const sleep = vi.fn();

    await runSmoke({
      environmentOverrides: { SMOKE_ATTEMPTS: "2" },
      fetchImplementation,
      sleep,
      tlsProbeImplementation,
    });

    const calls = fetchImplementation.mock.calls.map(([input, init]) => {
      const url = new URL(String(input));
      return `${init?.method ?? "GET"} ${url.href}`;
    });
    expect(calls).toHaveLength(32);
    expect(calls).toContain(`GET http://setlivre.com${redirectProbePath}`);
    expect(calls).toContain(`GET http://www.setlivre.com${redirectProbePath}`);
    expect(calls).toContain(`GET http://ops.setlivre.com${redirectProbePath}`);
    expect(calls).toContain(`GET https://www.setlivre.com${redirectProbePath}`);
    expect(calls).toContain(
      "GET http://setlivre.com/.well-known/acme-challenge/set-livre-smoke-not-found",
    );
    expect(calls).toContain("GET https://setlivre.com/entrar");
    expect(calls).toContain("GET https://ops.setlivre.com/");
    expect(calls).toContain("POST https://setlivre.com/api/commands");
    expect(calls.filter((value) => value.includes("/api/health/ready"))).toHaveLength(4);
    for (const [, init] of fetchImplementation.mock.calls) {
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }

    expect(tlsProbeImplementation).toHaveBeenCalledTimes(12);
    const tlsIdentities = tlsProbeImplementation.mock.calls.map(
      ([request]) => `${request.hostname}/${request.protocol}`,
    );
    for (const hostname of ["setlivre.com", "www.setlivre.com", "ops.setlivre.com"]) {
      expect(tlsIdentities.filter((value) => value === `${hostname}/TLSv1.2`)).toHaveLength(2);
      expect(tlsIdentities.filter((value) => value === `${hostname}/TLSv1.3`)).toHaveLength(2);
    }
    for (const [{ timeoutMs }] of tlsProbeImplementation.mock.calls) {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(10_000);
    }
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it.each([
    ["HSTS ausente", (headers) => headers.delete("strict-transport-security")],
    ["HSTS fraco", (headers) => headers.set("strict-transport-security", "max-age=300")],
    ["CSP ausente", (headers) => headers.delete("content-security-policy")],
    [
      "CSP fraca",
      (headers) =>
        headers.set(
          "content-security-policy",
          headers
            .get("content-security-policy")
            .replace("'strict-dynamic'", "'strict-dynamic' 'unsafe-eval'"),
        ),
    ],
    ["nosniff ausente", (headers) => headers.delete("x-content-type-options")],
    ["referrer policy fraca", (headers) => headers.set("referrer-policy", "unsafe-url")],
    ["permissions policy fraca", (headers) => headers.set("permissions-policy", "camera=*")],
    ["X-Powered-By presente", (headers) => headers.set("x-powered-by", "framework")],
  ])("fails closed when the public home has %s", async (_name, mutate) => {
    const fetchImplementation = createFetch({
      mutateSecurityHeaders(headers, { url }) {
        if (url.hostname === "setlivre.com" && url.pathname === "/") {
          mutate(headers);
        }
      },
    });

    await expect(runSmoke({ fetchImplementation })).rejects.toThrow("web/home");
  });

  it("fails closed when an HTTPS www redirect does not use the exact canonical target", async () => {
    await expect(
      runSmoke({
        fetchImplementation: createFetch({
          httpsWwwDestination: `https://www.setlivre.com${redirectProbePath}`,
        }),
      }),
    ).rejects.toThrow("https/www");
  });

  it("fails closed when an HTTP redirect does not preserve the exact canonical request URI", async () => {
    await expect(
      runSmoke({
        fetchImplementation: createFetch({
          httpDestination: () => "https://setlivre.com/",
        }),
      }),
    ).rejects.toThrow("http/setlivre");
  });

  it("rejects a certificate that is too close to expiration", async () => {
    const tlsProbeImplementation = createTlsProbe(({ hostname, protocol }) =>
      hostname === "setlivre.com" && protocol === "TLSv1.2"
        ? {
            validTo: new Date(wallClock + MINIMUM_TLS_CERTIFICATE_VALIDITY_MS - 1).toISOString(),
          }
        : {},
    );

    await expect(runSmoke({ tlsProbeImplementation })).rejects.toThrow("tls/setlivre.com/tlsv1.2");
  });

  it("rejects a certificate whose SAN set is not exactly the three canonical hostnames", async () => {
    const tlsProbeImplementation = createTlsProbe(({ hostname, protocol }) =>
      hostname === "setlivre.com" && protocol === "TLSv1.2"
        ? { subjectAltName: `${exactSubjectAlternativeNames}, DNS:extra.setlivre.com` }
        : {},
    );

    await expect(runSmoke({ tlsProbeImplementation })).rejects.toThrow("tls/setlivre.com/tlsv1.2");
  });

  it("rejects a TLS handshake that does not negotiate the forced modern protocol", async () => {
    const tlsProbeImplementation = createTlsProbe(({ hostname, protocol }) =>
      hostname === "setlivre.com" && protocol === "TLSv1.2" ? { protocol: "TLSv1.3" } : {},
    );

    await expect(runSmoke({ tlsProbeImplementation })).rejects.toThrow("tls/setlivre.com/tlsv1.2");
  });

  it("uses one shared monotonic deadline and starts no network operation after it expires", async () => {
    const fetchImplementation = vi.fn();
    const tlsProbeImplementation = vi.fn();
    let firstRead = true;
    const monotonicNow = () => {
      if (firstRead) {
        firstRead = false;
        return 0;
      }
      return 40_000;
    };

    await expect(
      runSmoke({ fetchImplementation, monotonicNow, tlsProbeImplementation }),
    ).rejects.toThrow("http/setlivre");
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(tlsProbeImplementation).not.toHaveBeenCalled();
  });

  it("fails closed when a health endpoint reports another release", async () => {
    await expect(
      runSmoke({ fetchImplementation: createFetch({ healthRelease: "b".repeat(40) }) }),
    ).rejects.toThrow("web/live");
  });

  it("rejects non-origin, plaintext and shared public/backoffice targets before probing", async () => {
    const fetchImplementation = vi.fn();
    const tlsProbeImplementation = vi.fn();
    await expect(
      runSmoke({
        environmentOverrides: { PRD_PUBLIC_APP_URL: "http://setlivre.com" },
        fetchImplementation,
        tlsProbeImplementation,
      }),
    ).rejects.toThrow("web/origin");
    await expect(
      runSmoke({
        environmentOverrides: { PRD_BACKOFFICE_APP_URL: "https://setlivre.com" },
        fetchImplementation,
        tlsProbeImplementation,
      }),
    ).rejects.toThrow("origins");
    await expect(
      runSmoke({
        environmentOverrides: { PRD_PUBLIC_APP_URL: "https://other.example" },
        fetchImplementation,
        tlsProbeImplementation,
      }),
    ).rejects.toThrow("canonical-origins");
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(tlsProbeImplementation).not.toHaveBeenCalled();
  });

  it("rejects reuse of a CSP nonce without exposing the nonce", async () => {
    const fixedNonce = "f".repeat(32);
    const fetchImplementation = createFetch({
      mutateSecurityHeaders(headers) {
        headers.set("content-security-policy", contentSecurityPolicy(fixedNonce));
      },
    });

    await expect(runSmoke({ fetchImplementation })).rejects.toThrow(
      "O smoke de produção falhou em headers/csp-nonce.",
    );
  });

  it("redacts TLS implementation errors from the public diagnostic", async () => {
    const tlsProbeImplementation = vi.fn(async () => {
      throw new Error("token=secret-value subject=person@example.com");
    });

    let captured;
    try {
      await runSmoke({ tlsProbeImplementation });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe("O smoke de produção falhou em tls/setlivre.com/tlsv1.2.");
    expect(captured.message).not.toContain("secret-value");
    expect(captured.message).not.toContain("person@example.com");
  });

  it("rejects an oversized declared JSON body before reading its stream", async () => {
    let bodyAccessed = false;
    let bodyCancelled = false;
    let readerCreated = false;
    const headers = applicationSecurityHeaders("web");
    headers.set("content-length", String(MAXIMUM_JSON_BODY_BYTES + 1));
    headers.set("content-type", "application/json");
    const oversizedResponse = {
      status: 401,
      headers,
      get body() {
        bodyAccessed = true;
        return {
          async cancel() {
            bodyCancelled = true;
          },
          getReader() {
            readerCreated = true;
            throw new Error("um reader não deve ser criado");
          },
        };
      },
    };
    const fallback = createFetch();
    const fetchImplementation = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/account/profile") {
        return oversizedResponse;
      }
      return fallback(input, init);
    });

    await expect(runSmoke({ fetchImplementation })).rejects.toThrow("web/private-rejection");
    expect(bodyAccessed).toBe(true);
    expect(bodyCancelled).toBe(true);
    expect(readerCreated).toBe(false);
  });

  it("cancels an unbounded JSON stream as soon as the byte limit is crossed", async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(4096).fill(0x20);
    const oversizedStream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const fallback = createFetch();
    const fetchImplementation = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/account/profile") {
        const headers = applicationSecurityHeaders("web");
        headers.set("content-type", "application/json");
        return new Response(oversizedStream, { headers, status: 401 });
      }
      return fallback(input, init);
    });

    await expect(runSmoke({ fetchImplementation })).rejects.toThrow("web/private-rejection");
    expect(cancelled).toBe(true);
    expect(pulls).toBeGreaterThan(0);
    expect(pulls).toBeLessThanOrEqual(6);
  });
});
