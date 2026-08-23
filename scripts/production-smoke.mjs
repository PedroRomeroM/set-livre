import { performance } from "node:perf_hooks";
import { connect as connectTls } from "node:tls";
import { pathToFileURL } from "node:url";

const releasePattern = /^[0-9a-f]{40}$/u;
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const contentSecurityPolicyNoncePattern = /^'nonce-([a-f0-9]{32})'$/u;
const canonicalTlsHostnames = ["setlivre.com", "www.setlivre.com", "ops.setlivre.com"];
const expectedSubjectAlternativeNames = new Set(canonicalTlsHostnames);
const supportedTlsProtocols = ["TLSv1.2", "TLSv1.3"];
const maximumSecurityHeaderBytes = 8 * 1024;
const maximumProbeDurationMs = 10_000;
const probeBudgetPerAttemptMs = 5_000;
const deadlineMarginMs = 30_000;
const maximumSmokeDurationMs = 19 * 60 * 1000;
const minimumHstsMaxAgeSeconds = 31_536_000;
const redirectProbePath = "/__set_livre_production_smoke__?contract=redirect-v1";
export const MAXIMUM_JSON_BODY_BYTES = 16 * 1024;
export const MINIMUM_TLS_CERTIFICATE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

function fail(label) {
  throw new Error(`O smoke de produção falhou em ${label}.`);
}

function parseHttpsOrigin(candidate, label) {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    fail(label);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== candidate ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    fail(label);
  }
  return parsed;
}

function readMonotonicTime(monotonicNow, label) {
  let value;
  try {
    value = monotonicNow();
  } catch {
    fail(label);
  }
  if (!Number.isFinite(value) || value < 0) {
    fail(label);
  }
  return value;
}

function remainingDuration(deadline, label, maximumDurationMs = maximumProbeDurationMs) {
  const remainingMs = Math.floor(
    deadline.expiresAt - readMonotonicTime(deadline.monotonicNow, label),
  );
  if (remainingMs <= 0) {
    fail(label);
  }
  return Math.max(1, Math.min(remainingMs, maximumDurationMs));
}

async function beforeDeadline(operation, deadline, label, maximumDurationMs) {
  const timeoutMs = remainingDuration(deadline, label, maximumDurationMs);
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("deadline")), timeoutMs);
      }),
    ]);
  } catch {
    fail(label);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function request(fetchImplementation, url, expectedStatus, label, deadline, method = "GET") {
  const timeoutMs = remainingDuration(deadline, label);
  let response;
  try {
    response = await beforeDeadline(
      () =>
        fetchImplementation(url, {
          headers: { "user-agent": "set-livre-production-smoke/1" },
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        }),
      deadline,
      label,
      timeoutMs,
    );
  } catch {
    fail(label);
  }
  if (response.status !== expectedStatus) {
    await discardResponseBody(response, label, deadline);
    fail(label);
  }
  return response;
}

async function discardResponseBody(response, label, deadline) {
  let body;
  try {
    body = response.body;
  } catch {
    fail(label);
  }
  if (body === null) {
    return;
  }
  await beforeDeadline(() => body.cancel(), deadline, label);
}

function responseHeaders(response, label) {
  let headers;
  try {
    headers = response.headers;
  } catch {
    fail(label);
  }
  if (headers === null || typeof headers !== "object" || typeof headers.get !== "function") {
    fail(label);
  }
  return headers;
}

function readHeader(headers, name, label) {
  let value;
  try {
    value = headers.get(name);
  } catch {
    fail(label);
  }
  if (value !== null && (value.length === 0 || value.length > maximumSecurityHeaderBytes)) {
    fail(label);
  }
  return value;
}

function assertHsts(headers, label) {
  const value = readHeader(headers, "strict-transport-security", label);
  if (value === null) {
    fail(label);
  }
  const directives = value.split(";").map((directive) => directive.trim());
  const maxAgeDirectives = directives.filter((directive) => /^max-age=/iu.test(directive));
  if (directives.some((directive) => directive.length === 0) || maxAgeDirectives.length !== 1) {
    fail(label);
  }
  const maxAge = maxAgeDirectives[0].slice(maxAgeDirectives[0].indexOf("=") + 1);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(maxAge)) {
    fail(label);
  }
  const seconds = Number(maxAge);
  if (!Number.isSafeInteger(seconds) || seconds < minimumHstsMaxAgeSeconds) {
    fail(label);
  }
}

function parseContentSecurityPolicy(value, label) {
  if (value === null) {
    fail(label);
  }
  const directives = new Map();
  for (const source of value.split(";")) {
    const parts = source.trim().split(/\s+/u);
    const name = parts.shift()?.toLowerCase() ?? "";
    if (!/^[a-z][a-z0-9-]*$/u.test(name) || parts.length === 0 || directives.has(name)) {
      fail(label);
    }
    directives.set(name, parts);
  }
  return directives;
}

function assertContentSecurityPolicy(headers, label) {
  const directives = parseContentSecurityPolicy(
    readHeader(headers, "content-security-policy", label),
    label,
  );
  const expected = new Map([
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["object-src", ["'none'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["connect-src", ["'self'"]],
  ]);
  if (directives.size !== expected.size + 1) {
    fail(label);
  }
  for (const [name, values] of expected) {
    if (JSON.stringify(directives.get(name)) !== JSON.stringify(values)) {
      fail(label);
    }
  }
  const scriptSources = directives.get("script-src");
  const nonceMatch = scriptSources?.[1]?.match(contentSecurityPolicyNoncePattern);
  if (
    scriptSources?.length !== 3 ||
    scriptSources[0] !== "'self'" ||
    nonceMatch === null ||
    nonceMatch === undefined ||
    scriptSources[2] !== "'strict-dynamic'" ||
    scriptSources.includes("'unsafe-inline'") ||
    scriptSources.includes("'unsafe-eval'")
  ) {
    fail(label);
  }
  return nonceMatch[1];
}

function assertPermissionsPolicy(headers, label) {
  const value = readHeader(headers, "permissions-policy", label);
  if (value === null) {
    fail(label);
  }
  const directives = new Map();
  for (const source of value.split(",")) {
    const match = source.trim().match(/^([a-z][a-z0-9-]*)=(\([^)]*\)|\*)$/u);
    if (match === null || directives.has(match[1])) {
      fail(label);
    }
    directives.set(match[1], match[2]);
  }
  for (const feature of ["camera", "microphone", "geolocation"]) {
    if (directives.get(feature) !== "()") {
      fail(label);
    }
  }
}

function assertNoPoweredBy(headers, label) {
  if (readHeader(headers, "x-powered-by", label) !== null) {
    fail(label);
  }
}

function assertTransportSecurityHeaders(response, label) {
  const headers = responseHeaders(response, label);
  assertHsts(headers, label);
  assertNoPoweredBy(headers, label);
}

function assertApplicationSecurityHeaders(response, application, label) {
  const headers = responseHeaders(response, label);
  assertHsts(headers, label);
  const nonce = assertContentSecurityPolicy(headers, label);
  if (readHeader(headers, "x-content-type-options", label)?.toLowerCase() !== "nosniff") {
    fail(label);
  }
  const expectedReferrerPolicy =
    application === "backoffice" ? "no-referrer" : "strict-origin-when-cross-origin";
  if (readHeader(headers, "referrer-policy", label)?.toLowerCase() !== expectedReferrerPolicy) {
    fail(label);
  }
  assertPermissionsPolicy(headers, label);
  assertNoPoweredBy(headers, label);
  return nonce;
}

function hasBoundedJsonResponseHeaders(response, label) {
  const headers = responseHeaders(response, label);
  const contentType = readHeader(headers, "content-type", label);
  const declaredLength = readHeader(headers, "content-length", label);
  if (contentType?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return false;
  }
  if (declaredLength === null) {
    return true;
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
    return false;
  }
  const length = Number(declaredLength);
  return Number.isSafeInteger(length) && length <= MAXIMUM_JSON_BODY_BYTES;
}

async function readJson(response, label, deadline) {
  if (!hasBoundedJsonResponseHeaders(response, label)) {
    await discardResponseBody(response, label, deadline);
    fail(label);
  }
  let body;
  try {
    body = response.body;
  } catch {
    fail(label);
  }
  if (body === null) {
    fail(label);
  }

  let reader;
  try {
    reader = body.getReader();
  } catch {
    fail(label);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let receivedBytes = 0;
  let source = "";
  for (;;) {
    const result = await beforeDeadline(() => reader.read(), deadline, label);
    if (result.done) {
      break;
    }
    if (!(result.value instanceof Uint8Array)) {
      await beforeDeadline(() => reader.cancel(), deadline, label);
      fail(label);
    }
    if (result.value.byteLength > MAXIMUM_JSON_BODY_BYTES - receivedBytes) {
      await beforeDeadline(() => reader.cancel(), deadline, label);
      fail(label);
    }
    receivedBytes += result.value.byteLength;
    try {
      source += decoder.decode(result.value, { stream: true });
    } catch {
      await beforeDeadline(() => reader.cancel(), deadline, label);
      fail(label);
    }
  }
  try {
    reader.releaseLock();
    source += decoder.decode();
    return JSON.parse(source);
  } catch {
    fail(label);
  }
}

function assertHealthPayload(payload, { application, release, status }, label) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    fail(label);
  }
  const keys = Object.keys(payload).sort();
  const expectedKeys = ["application", "checkedAt", "release", "requestId", "status"];
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    payload.application !== application ||
    payload.release !== release ||
    payload.status !== status ||
    typeof payload.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(payload.checkedAt)) ||
    typeof payload.requestId !== "string" ||
    !requestIdPattern.test(payload.requestId)
  ) {
    fail(label);
  }
}

async function assertHealth(fetchImplementation, origin, application, release, kind, deadline) {
  const label = `${application}/${kind}`;
  const response = await request(
    fetchImplementation,
    new URL(`/api/health/${kind}`, origin),
    200,
    label,
    deadline,
  );
  const nonce = assertApplicationSecurityHeaders(response, application, label);
  assertHealthPayload(
    await readJson(response, label, deadline),
    { application, release, status: kind === "live" ? "live" : "ready" },
    label,
  );
  return nonce;
}

async function assertRedirect(
  fetchImplementation,
  source,
  destination,
  label,
  deadline,
  secureTransport,
) {
  const response = await request(fetchImplementation, new URL(source), 308, label, deadline);
  const headers = responseHeaders(response, label);
  const location = readHeader(headers, "location", label);
  if (secureTransport) {
    assertTransportSecurityHeaders(response, label);
  }
  await discardResponseBody(response, label, deadline);
  if (location !== destination) {
    fail(label);
  }
}

async function assertAcmeChallengeNotFound(fetchImplementation, hostname, deadline) {
  const label = `http/acme/${hostname}`;
  const response = await request(
    fetchImplementation,
    new URL(`http://${hostname}/.well-known/acme-challenge/set-livre-smoke-not-found`),
    404,
    label,
    deadline,
  );
  await discardResponseBody(response, label, deadline);
}

async function assertUnauthenticatedRejection(
  fetchImplementation,
  url,
  label,
  deadline,
  method = "GET",
) {
  const response = await request(fetchImplementation, url, 401, label, deadline, method);
  const nonce = assertApplicationSecurityHeaders(response, "web", label);
  const payload = await readJson(response, label, deadline);
  const headers = responseHeaders(response, label);
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(["error"]) ||
    typeof payload.error !== "object" ||
    payload.error === null ||
    Array.isArray(payload.error) ||
    JSON.stringify(Object.keys(payload.error).sort()) !==
      JSON.stringify(["code", "message", "requestId"]) ||
    payload.error.code !== "UNAUTHENTICATED" ||
    typeof payload.error.message !== "string" ||
    payload.error.message.length === 0 ||
    typeof payload.error.requestId !== "string" ||
    !requestIdPattern.test(payload.error.requestId) ||
    readHeader(headers, "x-request-id", label) !== payload.error.requestId ||
    readHeader(headers, "cache-control", label) !== "private, no-store"
  ) {
    fail(label);
  }
  return nonce;
}

async function assertPublicSurface(
  fetchImplementation,
  url,
  expectedStatus,
  application,
  label,
  deadline,
) {
  const response = await request(fetchImplementation, url, expectedStatus, label, deadline);
  const nonce = assertApplicationSecurityHeaders(response, application, label);
  await discardResponseBody(response, label, deadline);
  return nonce;
}

function defaultTlsProbe({ hostname, protocol, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const rejectSafely = () => {
      if (settled) {
        return;
      }
      settled = true;
      socket?.destroy();
      reject(new Error("tls"));
    };
    const resolveSafely = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    try {
      socket = connectTls(
        {
          host: hostname,
          maxVersion: protocol,
          minVersion: protocol,
          port: 443,
          rejectUnauthorized: true,
          servername: hostname,
        },
        () => {
          try {
            const certificate = socket.getPeerCertificate();
            resolveSafely({
              authorized: socket.authorized,
              protocol: socket.getProtocol(),
              subjectAltName: certificate.subjectaltname,
              validFrom: certificate.valid_from,
              validTo: certificate.valid_to,
            });
          } catch {
            rejectSafely();
          }
        },
      );
      socket.setTimeout(timeoutMs, rejectSafely);
      socket.once("error", rejectSafely);
    } catch {
      rejectSafely();
    }
  });
}

function parseExactSubjectAlternativeNames(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    fail(label);
  }
  const names = value.split(/,\s*/u).map((entry) => {
    const match = entry.match(/^DNS:([a-z0-9.-]+)$/u);
    if (match === null) {
      fail(label);
    }
    return match[1];
  });
  if (
    names.length !== expectedSubjectAlternativeNames.size ||
    new Set(names).size !== names.length ||
    names.some((name) => !expectedSubjectAlternativeNames.has(name))
  ) {
    fail(label);
  }
}

async function assertTlsEndpoint(
  tlsProbeImplementation,
  hostname,
  protocol,
  deadline,
  wallClockNow,
) {
  const label = `tls/${hostname}/${protocol.toLowerCase()}`;
  const timeoutMs = remainingDuration(deadline, label);
  const result = await beforeDeadline(
    () => tlsProbeImplementation({ hostname, protocol, timeoutMs }),
    deadline,
    label,
    timeoutMs,
  );
  if (
    typeof result !== "object" ||
    result === null ||
    result.authorized !== true ||
    result.protocol !== protocol
  ) {
    fail(label);
  }
  parseExactSubjectAlternativeNames(result.subjectAltName, label);
  const validFrom = Date.parse(result.validFrom);
  const validTo = Date.parse(result.validTo);
  let now;
  try {
    now = wallClockNow();
  } catch {
    fail(label);
  }
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    validFrom > now ||
    validTo - now < MINIMUM_TLS_CERTIFICATE_VALIDITY_MS
  ) {
    fail(label);
  }
}

function productionProbes({
  backofficeOrigin,
  deadline,
  fetchImplementation,
  publicOrigin,
  release,
  tlsProbeImplementation,
  wallClockNow,
}) {
  return [
    {
      label: "http/setlivre",
      run: () =>
        assertRedirect(
          fetchImplementation,
          `http://setlivre.com${redirectProbePath}`,
          `https://setlivre.com${redirectProbePath}`,
          "http/setlivre",
          deadline,
          false,
        ),
    },
    {
      label: "http/www",
      run: () =>
        assertRedirect(
          fetchImplementation,
          `http://www.setlivre.com${redirectProbePath}`,
          `https://setlivre.com${redirectProbePath}`,
          "http/www",
          deadline,
          false,
        ),
    },
    {
      label: "http/ops",
      run: () =>
        assertRedirect(
          fetchImplementation,
          `http://ops.setlivre.com${redirectProbePath}`,
          `https://ops.setlivre.com${redirectProbePath}`,
          "http/ops",
          deadline,
          false,
        ),
    },
    {
      label: "https/www",
      run: () =>
        assertRedirect(
          fetchImplementation,
          `https://www.setlivre.com${redirectProbePath}`,
          `https://setlivre.com${redirectProbePath}`,
          "https/www",
          deadline,
          true,
        ),
    },
    ...canonicalTlsHostnames.flatMap((hostname) =>
      supportedTlsProtocols.map((protocol) => ({
        label: `tls/${hostname}/${protocol.toLowerCase()}`,
        run: () =>
          assertTlsEndpoint(tlsProbeImplementation, hostname, protocol, deadline, wallClockNow),
      })),
    ),
    ...canonicalTlsHostnames.map((hostname) => ({
      label: `http/acme/${hostname}`,
      run: () => assertAcmeChallengeNotFound(fetchImplementation, hostname, deadline),
    })),
    {
      label: "web/home",
      run: () =>
        assertPublicSurface(
          fetchImplementation,
          new URL("/", publicOrigin),
          200,
          "web",
          "web/home",
          deadline,
        ),
    },
    {
      label: "web/login",
      run: () =>
        assertPublicSurface(
          fetchImplementation,
          new URL("/entrar", publicOrigin),
          200,
          "web",
          "web/login",
          deadline,
        ),
    },
    {
      label: "backoffice/protected",
      run: () =>
        assertPublicSurface(
          fetchImplementation,
          new URL("/", backofficeOrigin),
          403,
          "backoffice",
          "backoffice/protected",
          deadline,
        ),
    },
    {
      label: "web/private-rejection",
      run: () =>
        assertUnauthenticatedRejection(
          fetchImplementation,
          new URL("/api/account/profile", publicOrigin),
          "web/private-rejection",
          deadline,
        ),
    },
    {
      label: "web/command-rejection",
      run: () =>
        assertUnauthenticatedRejection(
          fetchImplementation,
          new URL("/api/commands", publicOrigin),
          "web/command-rejection",
          deadline,
          "POST",
        ),
    },
    {
      label: "web/live",
      run: () => assertHealth(fetchImplementation, publicOrigin, "web", release, "live", deadline),
    },
    {
      label: "web/ready",
      run: () => assertHealth(fetchImplementation, publicOrigin, "web", release, "ready", deadline),
    },
    {
      label: "backoffice/live",
      run: () =>
        assertHealth(
          fetchImplementation,
          backofficeOrigin,
          "backoffice",
          release,
          "live",
          deadline,
        ),
    },
    {
      label: "backoffice/ready",
      run: () =>
        assertHealth(
          fetchImplementation,
          backofficeOrigin,
          "backoffice",
          release,
          "ready",
          deadline,
        ),
    },
  ];
}

async function runProbeBatch(probes, seenContentSecurityPolicyNonces) {
  const results = await Promise.allSettled(probes.map(({ run }) => run()));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "rejected") {
      fail(probes[index].label);
    }
  }
  for (const result of results) {
    if (result.status !== "fulfilled" || typeof result.value !== "string") {
      continue;
    }
    if (seenContentSecurityPolicyNonces.has(result.value)) {
      fail("headers/csp-nonce");
    }
    seenContentSecurityPolicyNonces.add(result.value);
  }
}

export async function runProductionSmoke({
  environment = process.env,
  fetchImplementation = fetch,
  monotonicNow = () => performance.now(),
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  tlsProbeImplementation = defaultTlsProbe,
  wallClockNow = () => Date.now(),
} = {}) {
  const release = environment.RELEASE_SHA ?? "";
  if (!releasePattern.test(release)) {
    fail("release");
  }
  const publicOrigin = parseHttpsOrigin(environment.PRD_PUBLIC_APP_URL ?? "", "web/origin");
  const backofficeOrigin = parseHttpsOrigin(
    environment.PRD_BACKOFFICE_APP_URL ?? "",
    "backoffice/origin",
  );
  if (publicOrigin.origin === backofficeOrigin.origin) {
    fail("origins");
  }
  if (
    publicOrigin.origin !== "https://setlivre.com" ||
    backofficeOrigin.origin !== "https://ops.setlivre.com"
  ) {
    fail("canonical-origins");
  }

  const attempts = Number.parseInt(environment.SMOKE_ATTEMPTS ?? "37", 10);
  const intervalMs = Number.parseInt(environment.SMOKE_INTERVAL_MS ?? "25000", 10);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
    fail("attempts");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) {
    fail("interval");
  }

  const deadlineDurationMs =
    deadlineMarginMs + (attempts - 1) * intervalMs + attempts * probeBudgetPerAttemptMs;
  if (!Number.isSafeInteger(deadlineDurationMs) || deadlineDurationMs > maximumSmokeDurationMs) {
    fail("deadline");
  }
  const deadline = {
    expiresAt: readMonotonicTime(monotonicNow, "deadline") + deadlineDurationMs,
    monotonicNow,
  };
  const seenContentSecurityPolicyNonces = new Set();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await runProbeBatch(
      productionProbes({
        backofficeOrigin,
        deadline,
        fetchImplementation,
        publicOrigin,
        release,
        tlsProbeImplementation,
        wallClockNow,
      }),
      seenContentSecurityPolicyNonces,
    );
    if (attempt < attempts) {
      await beforeDeadline(
        () => sleep(intervalMs),
        deadline,
        "interval",
        Math.max(1, intervalMs + 1_000),
      );
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runProductionSmoke();
  process.stdout.write("Smoke HTTPS e monitoramento pós-deploy concluídos.\n");
}
