import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { StorageApiError } from "@supabase/storage-js";
import { describe, expect, it, vi } from "vitest";

import {
  assertActiveWebReleaseHealth,
  assertCleanupResult,
  assertDefaultSecretKey,
  assertImmutableCleanupSlug,
  assertProductionMediaBucket,
  assertReleaseSha,
  configureProductionMediaCleanup,
  createProductionStorageClient,
  isConfirmedStorageObjectAbsence,
  readActivePublicReleaseSha,
  selectCleanupFunctionRetention,
  selectDefaultSecretKey,
  writeEphemeralDefaultSecretKey,
} from "../../scripts/configure-production-media-cleanup.mjs";

const projectRef = "oirvvnojgkzdppkdvhej";
const supabaseUrl = `https://${projectRef}.supabase.co`;
const runtimeUrl =
  "postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:runtime%23secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%20role%3Dapp_dal";
const secretKey = "sb_secret_defaultProductionKey123";
const activeReleaseSha = "a".repeat(40);
const immutableCleanupBootstrapReleaseSha = "a6549f558133a76f559a1c94ded73aca558786e5";
const candidateSha = "c".repeat(40);
const activeSlug = `media-cleanup-${activeReleaseSha}`;
const candidateSlug = `media-cleanup-${candidateSha}`;
const failedSlugs = ["b", "d", "e", "f", "9"].map(
  (character) => `media-cleanup-${character.repeat(40)}`,
);
const repositoryRoot = resolve(import.meta.dirname, "../..");

function environment() {
  return {
    ACTIVE_PUBLIC_RELEASE_SHA: activeReleaseSha,
    MEDIA_CLEANUP_FUNCTION_SLUG: candidateSlug,
    PRD_DATABASE_URL_APP_DAL: runtimeUrl,
    PRD_SUPABASE_SECRET_KEY: secretKey,
    SUPABASE_ACCESS_TOKEN: "sbp_management_access_token",
    SUPABASE_DB_PASSWORD: "admin-secret",
    SUPABASE_PROJECT_REF: projectRef,
  };
}

function privateBucket() {
  return {
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/avif"],
    fileSizeLimit: "15728640",
    id: "studio-media",
    isPublic: false,
    name: "studio-media",
  };
}

function immutableFunction(slug, timestamp) {
  return {
    created_at: new Date(timestamp).toISOString(),
    slug,
    status: "ACTIVE",
    verify_jwt: false,
  };
}

function legacyMutableFunction() {
  return {
    created_at: "2026-08-01T12:00:00.000Z",
    slug: "media-cleanup",
    status: "ACTIVE",
    verify_jwt: false,
  };
}

function functionInventory() {
  return [
    immutableFunction(candidateSlug, Date.UTC(2026, 7, 31, 18)),
    immutableFunction(failedSlugs[4], Date.UTC(2026, 7, 31, 17)),
    immutableFunction(failedSlugs[3], Date.UTC(2026, 7, 31, 16)),
    immutableFunction(failedSlugs[2], Date.UTC(2026, 7, 31, 15)),
    immutableFunction(failedSlugs[1], Date.UTC(2026, 7, 31, 14)),
    immutableFunction(failedSlugs[0], Date.UTC(2026, 7, 31, 13)),
    immutableFunction(activeSlug, Date.UTC(2026, 7, 30, 12)),
  ];
}

function probeFor(runId, status, mediaId = "87000000-0000-4000-8000-000000000002") {
  const prefix = `owners/${runId}/studios/${runId}/revisions/${runId}`;
  return {
    bucket: "studio-media",
    mediaId,
    paths: [`${prefix}/${mediaId}.webp`, `${prefix}/${mediaId}.preview.webp`],
    runId,
    status,
  };
}

function createProductionHarness({
  cleanupHttpStatus = 200,
  cleanupResult = { claimed: 1, deleted: 1, failed: 0 },
  deletionPayload = {},
  deletionStatus = 200,
  inventory = functionInventory(),
  ledgerFunctionSlug = candidateSlug,
  lockAcquired = true,
  staleProbes = [],
  storageAbsenceError = new StorageApiError("Object not found", 404, "404", "storage", "NoSuchKey"),
} = {}) {
  const statements = [];
  const probes = new Map();
  const runs = new Map();
  const aborts = [];
  const deletedSlugs = [];
  const staleProbeRunIds = new Set(staleProbes.map((probe) => probe.runId));
  let currentInventory = [...inventory];
  for (const probe of staleProbes) probes.set(probe.runId, probe);

  const query = vi.fn(async (statement, parameters = []) => {
    const sql = String(statement);
    statements.push(sql);
    if (sql.includes("pg_try_advisory_lock")) {
      return { rowCount: 1, rows: [{ acquired: lockAcquired }] };
    }
    if (sql.includes("from storage.buckets")) {
      return { rowCount: 1, rows: [privateBucket()] };
    }
    if (sql.includes("from maintenance.studio_media_cleanup_probes as probe")) {
      const rows = [...staleProbeRunIds].map((runId) => ({ probe: probes.get(runId) }));
      return { rowCount: rows.length, rows };
    }
    if (sql.includes("prepare_studio_media_cleanup_probe")) {
      const probe = probeFor(parameters[0], "prepared");
      probes.set(parameters[0], probe);
      return { rowCount: 1, rows: [{ probe }] };
    }
    if (sql.includes("arm_studio_media_cleanup_probe")) {
      const probe = { ...probes.get(parameters[0]), status: "queued" };
      probes.set(parameters[0], probe);
      return { rowCount: 1, rows: [{ probe }] };
    }
    if (sql.includes("get_studio_media_cleanup_probe")) {
      return {
        rowCount: 1,
        rows: [{ probe: probes.get(parameters[0]) }],
      };
    }
    if (sql.includes("abort_studio_media_cleanup_probe")) {
      aborts.push({ errorCode: parameters[1], runId: parameters[0] });
      staleProbeRunIds.delete(parameters[0]);
      const probe = probes.get(parameters[0]);
      if (probe !== undefined) probes.set(parameters[0], { ...probe, status: "aborted" });
      return { rowCount: 1, rows: [{}] };
    }
    if (sql.includes("from maintenance.studio_media_cleanup_runs as run")) {
      const run = runs.get(parameters[0]);
      return run === undefined ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ run }] };
    }
    throw new Error(`SQL inesperado no harness: ${sql}`);
  });
  const client = {
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query,
  };

  const upload = vi.fn(async () => ({ data: { path: "probe" }, error: null }));
  const remove = vi.fn(async () => ({ data: [], error: null }));
  const download = vi.fn(async () => ({ data: null, error: storageAbsenceError }));
  const bucket = { download, remove, upload };
  const storage = { from: vi.fn(() => bucket) };

  const fetchImplementation = vi.fn(async (input, options = {}) => {
    const url = String(input);
    if (url === `${supabaseUrl}/functions/v1/${candidateSlug}`) {
      const body = JSON.parse(options.body);
      if (cleanupHttpStatus === 200) {
        runs.set(body.runId, {
          claimed: cleanupResult.claimed,
          deleted: cleanupResult.deleted,
          errorCode: null,
          failed: cleanupResult.failed,
          functionSlug: ledgerFunctionSlug,
          runId: body.runId,
          status: "succeeded",
        });
        probes.set(body.runId, { ...probes.get(body.runId), status: "deleted" });
        return Response.json(cleanupResult);
      }
      return Response.json(
        { claimed: 1, deleted: 0, errorCode: "probe_failed", failed: 1 },
        { status: cleanupHttpStatus },
      );
    }
    if (url.endsWith(`/v1/projects/${projectRef}/functions`) && options.method !== "DELETE") {
      return Response.json(currentInventory);
    }
    if (options.method === "DELETE") {
      const slug = decodeURIComponent(url.split("/").at(-1));
      if (deletionStatus !== 200) {
        return new Response(null, { status: deletionStatus });
      }
      deletedSlugs.push(slug);
      currentInventory = currentInventory.filter((candidate) => candidate.slug !== slug);
      return Response.json(deletionPayload);
    }
    throw new Error(`HTTP inesperado no harness: ${url}`);
  });

  return {
    aborts,
    bucket,
    client,
    deletedSlugs,
    fetchImplementation,
    statements,
    storage,
  };
}

describe("production media cleanup configuration", () => {
  it("deploys and checks the canonical TypeScript source without scheduler or extension rename", () => {
    const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const packageConfiguration = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    );
    const supabaseConfig = readFileSync(resolve(repositoryRoot, "supabase/config.toml"), "utf8");
    const functionDirectory = resolve(repositoryRoot, "supabase/functions/media-cleanup");

    expect(existsSync(resolve(functionDirectory, "index.ts"))).toBe(true);
    expect(existsSync(resolve(functionDirectory, "cleanup-core.ts"))).toBe(true);
    expect(existsSync(resolve(functionDirectory, "deno.json"))).toBe(true);
    expect(existsSync(resolve(functionDirectory, "deno.lock"))).toBe(true);
    expect(existsSync(resolve(functionDirectory, "index.js"))).toBe(false);
    expect(existsSync(resolve(functionDirectory, "cleanup-core.mjs"))).toBe(false);
    expect(supabaseConfig).toContain('entrypoint = "./functions/media-cleanup/index.ts"');
    expect(packageConfiguration.scripts.typecheck).toContain("npm run typecheck:edge");
    expect(packageConfiguration.scripts["typecheck:edge"]).toBe(
      "deno check --frozen --config supabase/functions/media-cleanup/deno.json " +
        "supabase/functions/media-cleanup/index.ts",
    );
    expect(packageConfiguration.devDependencies.deno).toBe("2.9.5");
    expect(workflow).toContain("run: npm run typecheck");
    expect(workflow).not.toContain("denoland/setup-deno");
    expect(workflow).toContain("--read-active-release-sha");
    expect(workflow).toContain(
      "ACTIVE_PUBLIC_RELEASE_SHA: ${{ steps.active_public_release.outputs.sha }}",
    );
    expect(workflow).not.toMatch(/mv[^\n]*index\.js[^\n]*index\.ts/u);
    expect(workflow).not.toMatch(/\b(?:pg_net|vault|cron|scheduler)\b/iu);
  });

  it("selects and materializes only the modern default secret key", async () => {
    expect(
      selectDefaultSecretKey([
        {
          api_key: "sb_publishable_publicKey123",
          name: "default",
          type: "publishable",
        },
        { api_key: secretKey, name: "default", type: "secret" },
      ]),
    ).toBe(secretKey);
    expect(assertDefaultSecretKey(secretKey)).toBe(secretKey);
    expect(() => assertDefaultSecretKey("legacy.service.role")).toThrow("PRD_SUPABASE_SECRET_KEY");

    const runnerTemp = resolve("C:/runner-temp");
    const destination = resolve(runnerTemp, "set-livre-supabase-secret-key");
    const file = {
      close: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
    };
    const openFile = vi.fn(async () => file);
    const fetchImplementation = vi.fn(async () =>
      Response.json([{ api_key: secretKey, name: "default", type: "secret" }]),
    );
    await expect(
      writeEphemeralDefaultSecretKey(
        {
          RUNNER_TEMP: runnerTemp,
          SUPABASE_ACCESS_TOKEN: "sbp_management_access_token",
          SUPABASE_PROJECT_REF: projectRef,
        },
        destination,
        { fetchImplementation, openFile },
      ),
    ).resolves.toBe(destination);
    expect(openFile).toHaveBeenCalledWith(destination, "wx", 0o600);
    expect(file.writeFile).toHaveBeenCalledWith(`${secretKey}\n`, {
      encoding: "utf8",
    });
  });

  it("sends a modern secret to Storage only in apikey and proves absence by NoSuchKey", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json(
        { code: "NoSuchKey", error: "not_found", message: "Object not found", statusCode: "404" },
        { status: 404 },
      ),
    );
    const storage = createProductionStorageClient({ fetchImplementation, secretKey });

    await storage.from("studio-media").download("owners/probe.webp");

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [input, init] = fetchImplementation.mock.calls[0];
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    expect(headers.get("apikey")).toBe(secretKey);
    expect(headers.has("authorization")).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);

    expect(
      isConfirmedStorageObjectAbsence(
        new StorageApiError("Object not found", 404, "404", "storage", "NoSuchKey"),
      ),
    ).toBe(true);
    for (const error of [
      new StorageApiError("Invalid", 400, "400", "storage", "InvalidRequest"),
      new StorageApiError("Denied", 404, "404", "storage", "AccessDenied"),
      { code: "NoSuchKey", status: 404 },
    ]) {
      expect(isConfirmedStorageObjectAbsence(error)).toBe(false);
    }
  });

  it.each(["upload", "remove", "download"])(
    "actively aborts a stalled canary Storage %s request at its deadline",
    async (operation) => {
      vi.useFakeTimers();
      try {
        let observedSignal;
        let notifyRequestStarted;
        const requestStarted = new Promise((resolve) => {
          notifyRequestStarted = resolve;
        });
        const fetchImplementation = vi.fn(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              observedSignal = init?.signal;
              if (!(observedSignal instanceof AbortSignal)) {
                reject(new Error("missing canary Storage abort signal"));
                return;
              }
              notifyRequestStarted();
              const rejectOnAbort = () =>
                reject(
                  observedSignal.reason ??
                    new DOMException("canary_storage_request_aborted", "AbortError"),
                );
              if (observedSignal.aborted) rejectOnAbort();
              else observedSignal.addEventListener("abort", rejectOnAbort, { once: true });
            }),
        );
        const bucket = createProductionStorageClient({ fetchImplementation, secretKey }).from(
          "studio-media",
        );
        const request =
          operation === "upload"
            ? bucket.upload("owners/probe.webp", new Uint8Array([1]), {
                contentType: "image/webp",
                upsert: false,
              })
            : operation === "remove"
              ? bucket.remove(["owners/probe.webp"])
              : bucket.download("owners/probe.webp");
        const outcome = Promise.resolve(request);

        await requestStarted;
        expect(observedSignal).toBeInstanceOf(AbortSignal);
        expect(observedSignal.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(15_000);

        await expect(outcome).resolves.toMatchObject({
          data: null,
          error: {
            name: "StorageUnknownError",
            originalError: {
              message: "O request do canário ao Storage excedeu o prazo.",
              name: "TimeoutError",
            },
          },
        });
        expect(observedSignal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rejects project drift before retrieving or writing a key", async () => {
    const runnerTemp = resolve("C:/runner-temp");
    const fetchImplementation = vi.fn();
    const openFile = vi.fn();
    await expect(
      writeEphemeralDefaultSecretKey(
        {
          RUNNER_TEMP: runnerTemp,
          SUPABASE_ACCESS_TOKEN: "sbp_management_access_token",
          SUPABASE_PROJECT_REF: "aaaaaaaaaaaaaaaaaaaa",
        },
        resolve(runnerTemp, "set-livre-supabase-secret-key"),
        { fetchImplementation, openFile },
      ),
    ).rejects.toThrow("projeto canônico");
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("reads the active release only from a strict HTTPS liveness response", async () => {
    const payload = {
      application: "web",
      checkedAt: "2026-08-31T12:00:00.000Z",
      release: activeReleaseSha,
      requestId: "87000000-0000-4000-8000-000000000001",
      status: "live",
    };
    expect(assertActiveWebReleaseHealth(payload)).toBe(activeReleaseSha);
    for (const invalid of [
      { ...payload, release: "unknown" },
      { ...payload, status: "ready" },
      { ...payload, dependency: "database" },
    ]) {
      expect(() => assertActiveWebReleaseHealth(invalid)).toThrow();
    }

    const fetchImplementation = vi.fn(async () => Response.json(payload));
    await expect(readActivePublicReleaseSha({ fetchImplementation })).resolves.toBe(
      activeReleaseSha,
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL("https://147.15.97.227/api/health/live"),
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("validates immutable identities, accounting and the private bucket", () => {
    expect(assertImmutableCleanupSlug(candidateSlug)).toBe(candidateSlug);
    expect(assertReleaseSha(activeReleaseSha)).toBe(activeReleaseSha);
    expect(assertCleanupResult({ claimed: 2, deleted: 2, failed: 0 })).toEqual({
      claimed: 2,
      deleted: 2,
      failed: 0,
    });
    expect(assertProductionMediaBucket([privateBucket()])).toEqual(privateBucket());
    expect(() => assertCleanupResult({ claimed: 1, deleted: 0, failed: 0 })).toThrow(
      "terminal saudável",
    );
    expect(() => assertImmutableCleanupSlug("media-cleanup")).toThrow();
    expect(() => assertReleaseSha("unknown")).toThrow();
  });

  it("protects the active Function and candidate after several failed attempts", () => {
    const retention = selectCleanupFunctionRetention(functionInventory(), {
      activeReleaseSha,
      candidateSlug,
    });
    expect(retention.retained).toHaveLength(4);
    expect(retention.retained).toContain(candidateSlug);
    expect(retention.retained).toContain(activeSlug);
    expect(retention.deleted).not.toContain(activeSlug);
    expect(retention.deleted).not.toContain(candidateSlug);
    expect(retention.deleted).toHaveLength(3);
  });

  it("permits only the known pre-cleanup release to bootstrap the first immutable Function", () => {
    const bootstrapInventory = [
      immutableFunction(candidateSlug, Date.UTC(2026, 8, 4, 12)),
      legacyMutableFunction(),
    ];
    const retention = selectCleanupFunctionRetention(bootstrapInventory, {
      activeReleaseSha: immutableCleanupBootstrapReleaseSha,
      candidateSlug,
    });

    expect(retention).toEqual({
      activeSlug: `media-cleanup-${immutableCleanupBootstrapReleaseSha}`,
      deleted: ["media-cleanup"],
      retained: [candidateSlug],
    });
    expect(() =>
      selectCleanupFunctionRetention(bootstrapInventory, {
        activeReleaseSha: "8".repeat(40),
        candidateSlug,
      }),
    ).toThrow("ativa");
  });

  it("retires one valid mutable legacy surface and rejects ambiguous migration state", () => {
    const retention = selectCleanupFunctionRetention(
      [...functionInventory(), legacyMutableFunction()],
      { activeReleaseSha, candidateSlug },
    );
    expect(retention.deleted).toContain("media-cleanup");

    for (const invalidLegacy of [
      [legacyMutableFunction(), legacyMutableFunction()],
      [{ ...legacyMutableFunction(), status: "FAILED" }],
      [{ ...legacyMutableFunction(), verify_jwt: true }],
    ]) {
      expect(() =>
        selectCleanupFunctionRetention([...functionInventory(), ...invalidLegacy], {
          activeReleaseSha,
          candidateSlug,
        }),
      ).toThrow("legada");
    }
    expect(() =>
      selectCleanupFunctionRetention(
        functionInventory().filter((candidate) => candidate.slug !== candidateSlug),
        { activeReleaseSha, candidateSlug },
      ),
    ).toThrow("candidata");
    expect(() =>
      selectCleanupFunctionRetention(
        functionInventory().filter((candidate) => candidate.slug !== activeSlug),
        { activeReleaseSha, candidateSlug },
      ),
    ).toThrow("ativa");

    expect(
      selectCleanupFunctionRetention(functionInventory(), {
        activeReleaseSha: candidateSha,
        candidateSlug,
      }).retained,
    ).toContain(candidateSlug);
  });

  it("proves the candidate by direct HTTPS, ledger and Storage before pruning", async () => {
    const harness = createProductionHarness({
      inventory: [...functionInventory(), legacyMutableFunction()],
    });
    await expect(
      configureProductionMediaCleanup(environment(), {
        createClient: () => harness.client,
        createStorageClient: () => harness.storage,
        fetchImplementation: harness.fetchImplementation,
      }),
    ).resolves.toEqual({
      activeReleaseSha,
      candidateSlug,
      deletedFunctions: 4,
      retainedFunctions: 4,
    });

    const functionCall = harness.fetchImplementation.mock.calls.find(
      ([input]) => String(input) === `${supabaseUrl}/functions/v1/${candidateSlug}`,
    );
    expect(functionCall).toBeDefined();
    expect(functionCall[1]).toMatchObject({
      cache: "no-store",
      headers: {
        Accept: "application/json",
        apikey: secretKey,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
    });
    expect(JSON.parse(functionCall[1].body)).toEqual({
      runId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      ),
    });
    expect(harness.bucket.upload).toHaveBeenCalledTimes(2);
    expect(harness.bucket.download).toHaveBeenCalledTimes(2);
    expect(harness.deletedSlugs).not.toContain(activeSlug);
    expect(harness.deletedSlugs).not.toContain(candidateSlug);
    expect(harness.deletedSlugs).toContain("media-cleanup");
    expect(harness.statements.join("\n")).not.toMatch(/\b(?:pg_net|vault|cron|scheduler)\b/iu);
  });

  it("recovers stale prepared and queued probes before creating the next canary", async () => {
    const prepared = probeFor(
      "87000000-0000-4000-8000-000000000010",
      "prepared",
      "87000000-0000-4000-8000-000000000011",
    );
    const queued = probeFor(
      "87000000-0000-4000-8000-000000000012",
      "queued",
      "87000000-0000-4000-8000-000000000013",
    );
    const harness = createProductionHarness({ staleProbes: [prepared, queued] });

    await configureProductionMediaCleanup(environment(), {
      createClient: () => harness.client,
      createStorageClient: () => harness.storage,
      fetchImplementation: harness.fetchImplementation,
    });

    expect(harness.aborts).toEqual([
      { errorCode: "probe_abandoned", runId: prepared.runId },
      { errorCode: "probe_abandoned", runId: queued.runId },
    ]);
    expect(harness.bucket.remove).toHaveBeenCalledTimes(2);
    const staleRead = harness.statements.findIndex((sql) =>
      sql.includes("from maintenance.studio_media_cleanup_probes as probe"),
    );
    const nextPrepare = harness.statements.findIndex((sql) =>
      sql.includes("prepare_studio_media_cleanup_probe"),
    );
    expect(staleRead).toBeGreaterThan(-1);
    expect(nextPrepare).toBeGreaterThan(staleRead);
  });

  it.each([
    new StorageApiError("Invalid request", 400, "400", "storage", "InvalidRequest"),
    new StorageApiError("Wrong absence", 404, "404", "storage", "AccessDenied"),
  ])(
    "does not terminalize a canary without exact physical absence",
    async (storageAbsenceError) => {
      const harness = createProductionHarness({ storageAbsenceError });

      await expect(
        configureProductionMediaCleanup(environment(), {
          createClient: () => harness.client,
          createStorageClient: () => harness.storage,
          fetchImplementation: harness.fetchImplementation,
        }),
      ).rejects.toThrow("canário de cleanup falhou");
      expect(harness.aborts).toEqual([]);
      expect(harness.deletedSlugs).toEqual([]);
    },
  );

  it("fails closed when another production cleanup configuration holds the lock", async () => {
    const harness = createProductionHarness({ lockAcquired: false });

    await expect(
      configureProductionMediaCleanup(environment(), {
        createClient: () => harness.client,
        createStorageClient: () => harness.storage,
        fetchImplementation: harness.fetchImplementation,
      }),
    ).rejects.toThrow("Outra configuração de cleanup");
    expect(harness.bucket.upload).not.toHaveBeenCalled();
    expect(harness.deletedSlugs).toEqual([]);
  });

  it("aborts and removes the disposable probe when direct HTTP fails, without pruning", async () => {
    const harness = createProductionHarness({
      cleanupHttpStatus: 503,
      inventory: [...functionInventory(), legacyMutableFunction()],
    });
    await expect(
      configureProductionMediaCleanup(environment(), {
        createClient: () => harness.client,
        createStorageClient: () => harness.storage,
        fetchImplementation: harness.fetchImplementation,
      }),
    ).rejects.toThrow("operação (503)");
    expect(harness.bucket.remove).toHaveBeenCalledOnce();
    expect(harness.aborts).toEqual([{ errorCode: "probe_failed", runId: expect.any(String) }]);
    expect(harness.deletedSlugs).toEqual([]);
    expect(
      harness.fetchImplementation.mock.calls.some(([input]) =>
        String(input).includes(`/v1/projects/${projectRef}/functions`),
      ),
    ).toBe(false);
  });

  it("recovers and refuses pruning when the ledger binds a different slug", async () => {
    const harness = createProductionHarness({ ledgerFunctionSlug: failedSlugs[0] });
    await expect(
      configureProductionMediaCleanup(environment(), {
        createClient: () => harness.client,
        createStorageClient: () => harness.storage,
        fetchImplementation: harness.fetchImplementation,
      }),
    ).rejects.toThrow("ledger durável");
    expect(harness.bucket.remove).toHaveBeenCalledOnce();
    expect(harness.aborts).toHaveLength(1);
    expect(harness.deletedSlugs).toEqual([]);
  });

  it("requires exact Management API deletion status and confirmation", async () => {
    for (const scenario of [
      {
        expectedError: "204",
        harness: createProductionHarness({ deletionStatus: 204 }),
      },
      {
        expectedError: "confirmou exatamente",
        harness: createProductionHarness({ deletionPayload: { deleted: true } }),
      },
    ]) {
      await expect(
        configureProductionMediaCleanup(environment(), {
          createClient: () => scenario.harness.client,
          createStorageClient: () => scenario.harness.storage,
          fetchImplementation: scenario.harness.fetchImplementation,
        }),
      ).rejects.toThrow(scenario.expectedError);
      expect(scenario.harness.deletedSlugs).not.toContain(activeSlug);
      expect(scenario.harness.deletedSlugs).not.toContain(candidateSlug);
    }
  });

  it("fails before opening Postgres when liveness identity or secret is invalid", async () => {
    const createClient = vi.fn();
    for (const invalidEnvironment of [
      { ...environment(), ACTIVE_PUBLIC_RELEASE_SHA: "unknown" },
      { ...environment(), PRD_SUPABASE_SECRET_KEY: "invalid" },
    ]) {
      await expect(
        configureProductionMediaCleanup(invalidEnvironment, {
          createClient,
          fetchImplementation: vi.fn(),
        }),
      ).rejects.toThrow();
    }
    expect(createClient).not.toHaveBeenCalled();
  });
});
