import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { StorageApiError } from "@supabase/storage-js";
import { describe, expect, it, vi } from "vitest";

import {
  assertCleanupResult,
  assertDefaultSecretKey,
  assertImmutableCleanupSlug,
  assertProductionMediaBucket,
  assertReleaseSha,
  configureProductionMediaCleanup,
  createProductionStorageClient,
  isConfirmedStorageObjectAbsence,
  pruneProductionMediaCleanupFunctions,
  selectDefaultSecretKey,
  writeEphemeralDefaultSecretKey,
} from "../../scripts/configure-production-media-cleanup.mjs";

const projectRef = "oirvvnojgkzdppkdvhej";
const supabaseUrl = `https://${projectRef}.supabase.co`;
const runtimeUrl =
  "postgresql://app_runtime_production.oirvvnojgkzdppkdvhej:runtime%23secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&options=-c%20role%3Dapp_dal";
const secretKey = "sb_secret_defaultProductionKey123";
const rollbackReleaseSha = "a".repeat(40);
const candidateSha = "c".repeat(40);
const rollbackSlug = `media-cleanup-${rollbackReleaseSha}`;
const candidateSlug = `media-cleanup-${candidateSha}`;
const failedSlugs = ["b", "d", "e", "f", "9"].map(
  (character) => `media-cleanup-${character.repeat(40)}`,
);
const repositoryRoot = resolve(import.meta.dirname, "../..");

function environment() {
  return {
    MEDIA_CLEANUP_FUNCTION_SLUG: candidateSlug,
    PRD_DATABASE_URL_APP_DAL: runtimeUrl,
    PRD_SUPABASE_SECRET_KEY: secretKey,
    SUPABASE_ACCESS_TOKEN: "sbp_management_access_token",
    SUPABASE_DB_PASSWORD: "admin-secret",
    SUPABASE_PROJECT_REF: projectRef,
  };
}

function retainedReleaseInventory(
  releases = [
    { sha: candidateSha, mediaCleanup: true },
    { sha: rollbackReleaseSha, mediaCleanup: true },
  ],
) {
  return { version: 1, activeReleaseSha: candidateSha, releases };
}

function retentionEnvironment(inventory = retainedReleaseInventory()) {
  return {
    MEDIA_CLEANUP_FUNCTION_SLUG: candidateSlug,
    RETAINED_RELEASE_INVENTORY: JSON.stringify(inventory),
    SUPABASE_ACCESS_TOKEN: "sbp_management_access_token",
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
    immutableFunction(rollbackSlug, Date.UTC(2026, 7, 30, 12)),
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
  let currentInventory = inventory;
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
  it.each([24_000, null])(
    "bounds the candidate invocation body with its 110s budget (%s)",
    async (duration) => {
      vi.useFakeTimers();
      try {
        const contract = createProductionHarness();
        const started = Promise.withResolvers();
        let signal;
        const fetchImplementation = async (input, init) => {
          const response = await contract.fetchImplementation(input, init);
          if (!String(input).includes("/functions/v1/")) return response;
          signal = init.signal;
          const payload = await response.text();
          const body = new ReadableStream({
            start(controller) {
              const abort = () => controller.error(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
              if (duration !== null)
                setTimeout(() => {
                  signal.removeEventListener("abort", abort);
                  controller.enqueue(new TextEncoder().encode(payload));
                  controller.close();
                }, duration);
            },
          });
          started.resolve();
          return new Response(body, { headers: { "content-type": "application/json" } });
        };
        const invocation = configureProductionMediaCleanup(environment(), {
          createClient: () => contract.client,
          createStorageClient: () => contract.storage,
          fetchImplementation,
        });
        const outcome =
          duration === null
            ? expect(invocation).rejects.toThrow("A candidata de cleanup retornou JSON inválido")
            : expect(invocation).resolves.toMatchObject({ candidateSlug });
        await started.promise;
        await vi.advanceTimersByTimeAsync(20_001);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync((duration ?? 110_000) - 20_001);
        await outcome;
        expect(signal.aborted).toBe(duration === null);
        expect(contract.aborts).toHaveLength(duration === null ? 1 : 0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["upload", "remove", "download"])(
    "keeps the canary Storage %s deadline active while reading a body",
    async (operation) => {
      vi.useFakeTimers();
      try {
        const started = Promise.withResolvers();
        let signal;
        const client = createProductionStorageClient({
          secretKey,
          fetchImplementation: async (_input, init) => {
            signal = init.signal;
            const body = new ReadableStream({
              start(controller) {
                signal.addEventListener("abort", () => controller.error(signal.reason), {
                  once: true,
                });
              },
            });
            started.resolve();
            return new Response(body, { headers: { "content-type": "application/json" } });
          },
        });
        const bucket = client.from("studio-media");
        const invocation = Promise.resolve(
          operation === "upload"
            ? bucket.upload("owners/probe.webp", new Uint8Array([1]), { upsert: false })
            : operation === "remove"
              ? bucket.remove(["owners/probe.webp"])
              : bucket.download("owners/probe.webp"),
        );
        await started.promise;
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(invocation).resolves.toMatchObject({
          data: null,
          error: { name: "StorageUnknownError" },
        });
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
    expect(workflow).not.toContain("--read-active-release-sha");
    expect(workflow).not.toContain("ACTIVE_PUBLIC_RELEASE_SHA");
    expect(workflow).toContain("--prune-functions");
    expect(workflow).toContain('RETAINED_RELEASE_INVENTORY="$inventory"');
    expect(workflow).toContain('"retained-releases ${GITHUB_SHA}"');
    expect(workflow).toMatch(/concurrency:\s+group: production\s+cancel-in-progress: false/u);
    const canary = workflow.indexOf("- name: Run immutable media cleanup canary");
    const activation = workflow.indexOf("- name: Activate staged release on Oracle VM");
    const ready = workflow.indexOf("- name: Verify public web health");
    const prune = workflow.indexOf("- name: Prune unreferenced media cleanup functions");
    expect(canary).toBeGreaterThan(-1);
    expect(activation).toBeGreaterThan(canary);
    expect(ready).toBeGreaterThan(activation);
    expect(prune).toBeGreaterThan(ready);
    expect(workflow.slice(prune)).not.toContain("SUPABASE_DB_PASSWORD");
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

  it.each([404, 400])(
    "sends a modern secret only in apikey and confirms the SDK NoSuchKey envelope over HTTP %s",
    async (status) => {
      // Legacy envelope: supabase/storage@c015666ee13ee29faab50cf76ac513d73bdb6bfc,
      // src/http/error-handler.test.ts; HTTP status and body statusCode are distinct.
      const fetchImplementation = vi.fn(async () =>
        Response.json(
          { code: "NoSuchKey", error: "not_found", message: "Object not found", statusCode: "404" },
          { status },
        ),
      );
      const storage = createProductionStorageClient({ fetchImplementation, secretKey });

      const { data, error } = await storage.from("studio-media").download("owners/probe.webp");

      expect(fetchImplementation).toHaveBeenCalledOnce();
      const [input, init] = fetchImplementation.mock.calls[0];
      expect(input).toBe(`${supabaseUrl}/storage/v1/object/studio-media/owners/probe.webp`);
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      expect(headers.get("apikey")).toBe(secretKey);
      expect(headers.has("authorization")).toBe(false);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal.aborted).toBe(false);
      expect(data).toBeNull();
      expect(error).toBeInstanceOf(StorageApiError);
      expect(error).toMatchObject({ code: "NoSuchKey", status, statusCode: "404" });
      expect(isConfirmedStorageObjectAbsence(error)).toBe(true);
    },
  );

  it("rejects ambiguous, unauthorized and malformed absence envelopes through the SDK", async () => {
    const rejectedEnvelopes = [
      [400, { code: "InvalidRequest", statusCode: "400" }],
      [400, { error: "not_found", statusCode: "404" }],
      [404, { error: "not_found", statusCode: "404" }],
      [400, { code: "NoSuchBucket", statusCode: "404" }],
      [404, { code: "NoSuchBucket", statusCode: "404" }],
      [400, { code: "AccessDenied", statusCode: "404" }],
      [404, { code: "AccessDenied", statusCode: "404" }],
      [401, { code: "InvalidJWT", statusCode: "401" }],
      [403, { code: "AccessDenied", statusCode: "403" }],
      [401, { code: "NoSuchKey", statusCode: "404" }],
      [403, { code: "NoSuchKey", statusCode: "404" }],
      [400, { code: "NoSuchKey", statusCode: "400" }],
      [400, { code: "NoSuchKey", statusCode: 404 }],
      [400, { code: "NoSuchKey", statusCode: null }],
      [400, { code: "NoSuchKey" }],
      [400, { code: ["NoSuchKey"], statusCode: "404" }],
      [400, null],
      [404, null],
    ];
    for (const [status, body] of rejectedEnvelopes) {
      const fetchImplementation = vi.fn(async () => Response.json(body, { status }));
      const storage = createProductionStorageClient({ fetchImplementation, secretKey });
      const { data, error } = await storage.from("studio-media").download("owners/probe.webp");

      expect(data).toBeNull();
      expect(error).toBeInstanceOf(StorageApiError);
      expect(isConfirmedStorageObjectAbsence(error), JSON.stringify({ status, body })).toBe(false);
    }
    for (const status of [400, 404]) {
      const fetchImplementation = vi.fn(async () => new Response("not JSON", { status }));
      const storage = createProductionStorageClient({ fetchImplementation, secretKey });
      const { error } = await storage.from("studio-media").download("owners/probe.webp");

      expect(error).toBeInstanceOf(StorageApiError);
      expect(isConfirmedStorageObjectAbsence(error)).toBe(false);
    }
  });

  it("requires a StorageApiError instance to confirm absence", () => {
    for (const error of [
      { code: "NoSuchKey", status: 404 },
      { code: "NoSuchKey", status: 400, statusCode: "404" },
      null,
      undefined,
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
        expect(isConfirmedStorageObjectAbsence((await outcome).error)).toBe(false);
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

  it("validates immutable identities, accounting and the private bucket", () => {
    expect(assertImmutableCleanupSlug(candidateSlug)).toBe(candidateSlug);
    expect(assertReleaseSha(candidateSha)).toBe(candidateSha);
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

  it("prunes only unreferenced Functions and preserves all four artifact references regardless of timestamps", async () => {
    const protectedSlugs = [candidateSlug, rollbackSlug, ...failedSlugs.slice(0, 2)];
    const inventory = retainedReleaseInventory(
      protectedSlugs.map((slug) => ({
        sha: slug.slice("media-cleanup-".length),
        mediaCleanup: true,
      })),
    );
    const unrelated = { slug: "other-function", status: "ACTIVE", verify_jwt: true };
    const harness = createProductionHarness({
      inventory: [...functionInventory(), legacyMutableFunction(), unrelated],
    });

    await expect(
      pruneProductionMediaCleanupFunctions(retentionEnvironment(inventory), {
        fetchImplementation: harness.fetchImplementation,
      }),
    ).resolves.toEqual({
      activeReleaseSha: candidateSha,
      candidateSlug,
      deletedFunctions: 4,
      retainedFunctions: 4,
      missingReferencedFunctions: 0,
      unavailableReferencedFunctions: 0,
    });
    expect(harness.deletedSlugs).toEqual(["media-cleanup", ...failedSlugs.slice(2)].sort());
    expect(harness.client.connect).not.toHaveBeenCalled();
    expect(harness.statements).toEqual([]);
    expect(harness.storage.from).not.toHaveBeenCalled();
    expect(harness.fetchImplementation).toHaveBeenCalledTimes(6);
    for (const [input, init] of harness.fetchImplementation.mock.calls) {
      expect(String(input)).toMatch(
        new RegExp(`^https://api\\.supabase\\.com/v1/projects/${projectRef}/functions(?:/|$)`, "u"),
      );
      expect(["GET", "DELETE"]).toContain(init.method);
      expect(init.headers.Authorization).toBe("Bearer sbp_management_access_token");
    }
    await expect(
      pruneProductionMediaCleanupFunctions(retentionEnvironment(inventory), {
        fetchImplementation: harness.fetchImplementation,
      }),
    ).resolves.toMatchObject({ deletedFunctions: 0, retainedFunctions: 4 });
    expect(harness.fetchImplementation).toHaveBeenCalledTimes(7);
  });

  it("accepts pre-cleanup artifacts without a Function and keeps exactly the protected set", async () => {
    const inventory = retainedReleaseInventory([
      { sha: candidateSha, mediaCleanup: true },
      { sha: "6".repeat(40), mediaCleanup: false },
      { sha: rollbackReleaseSha, mediaCleanup: false },
    ]);
    const harness = createProductionHarness({
      inventory: [
        ...functionInventory().map((version) => ({
          ...version,
          created_at: undefined,
          status: version.slug === candidateSlug ? "ACTIVE" : "FAILED",
        })),
        legacyMutableFunction(),
      ],
    });
    const result = await pruneProductionMediaCleanupFunctions(retentionEnvironment(inventory), {
      fetchImplementation: harness.fetchImplementation,
    });
    expect(result).toMatchObject({ deletedFunctions: 7, retainedFunctions: 1 });
    expect(harness.deletedSlugs).toEqual(["media-cleanup", rollbackSlug, ...failedSlugs].sort());
  });

  it.each(["missing", "inactive", "jwt-mismatch"])(
    "does not block healthy active B when staged release A has a %s Function",
    async (state) => {
      const inventory = functionInventory().filter((version) => version.slug !== rollbackSlug);
      if (state !== "missing") {
        inventory.push({
          ...functionInventory().at(-1),
          status: state === "inactive" ? "FAILED" : "ACTIVE",
          verify_jwt: state === "jwt-mismatch",
        });
      }
      const harness = createProductionHarness({ inventory });
      await expect(
        pruneProductionMediaCleanupFunctions(retentionEnvironment(), {
          fetchImplementation: harness.fetchImplementation,
        }),
      ).resolves.toEqual({
        activeReleaseSha: candidateSha,
        candidateSlug,
        deletedFunctions: 5,
        retainedFunctions: state === "missing" ? 1 : 2,
        missingReferencedFunctions: state === "missing" ? 1 : 0,
        unavailableReferencedFunctions: state === "missing" ? 0 : 1,
      });
      expect(harness.deletedSlugs).toEqual([...failedSlugs].sort());
      expect(harness.statements).toEqual([]);
      expect(harness.storage.from).not.toHaveBeenCalled();
    },
  );

  it("prints missing and unavailable references in the GC CLI without claiming rollback or exposing a token", async () => {
    const releases = retainedReleaseInventory([
      { sha: candidateSha, mediaCleanup: true },
      { sha: rollbackReleaseSha, mediaCleanup: true },
      { sha: "b".repeat(40), mediaCleanup: true },
    ]);
    const harness = createProductionHarness({
      inventory: functionInventory()
        .filter((version) => version.slug !== rollbackSlug)
        .map((version) => ({
          ...version,
          status: version.slug === failedSlugs[0] ? "FAILED" : "ACTIVE",
        })),
    });
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const [key, value] of Object.entries(retentionEnvironment(releases))) {
        vi.stubEnv(key, value);
      }
      vi.stubGlobal("fetch", harness.fetchImplementation);
      process.argv = [
        process.execPath,
        resolve(repositoryRoot, "scripts/configure-production-media-cleanup.mjs"),
        "--prune-functions",
      ];
      vi.resetModules();
      await import("../../scripts/configure-production-media-cleanup.mjs");
      expect(stderr).not.toHaveBeenCalled();
      expect(stdout).toHaveBeenCalledWith(
        "Retenção de cleanup: 2 Functions referenciadas presentes, 4 removidas; " +
          "missingReferencedFunctions=1, unavailableReferencedFunctions=1. " +
          "Disponibilidade de rollback não comprovada.\n",
      );
      expect(stdout.mock.calls.flat().join("")).not.toContain(
        retentionEnvironment().SUPABASE_ACCESS_TOKEN,
      );
      expect(harness.deletedSlugs).toEqual(failedSlugs.slice(1).sort());
      expect(harness.statements).toEqual([]);
      expect(harness.storage.from).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it.each([
    undefined,
    "",
    "{",
    "null",
    "[]",
    JSON.stringify({ ...retainedReleaseInventory(), extra: true }),
    JSON.stringify({ ...retainedReleaseInventory(), version: 2 }),
    JSON.stringify({ releases: retainedReleaseInventory().releases, version: 1 }),
    JSON.stringify({ ...retainedReleaseInventory(), activeReleaseSha: rollbackReleaseSha }),
    JSON.stringify({ ...retainedReleaseInventory(), activeReleaseSha: candidateSha.toUpperCase() }),
    ...[
      [],
      [{ sha: rollbackReleaseSha, mediaCleanup: true }],
      [{ sha: candidateSha, mediaCleanup: false }],
      [{ sha: candidateSha, mediaCleanup: "true" }],
      [{ sha: candidateSha }],
      [{ sha: candidateSha, mediaCleanup: true, slug: "media-cleanup" }],
      [
        { sha: candidateSha, mediaCleanup: true },
        { sha: candidateSha, mediaCleanup: false },
      ],
      [
        { sha: candidateSha, mediaCleanup: true },
        { sha: "invalid", mediaCleanup: false },
      ],
      [null],
      [candidateSha, "a".repeat(40), "b".repeat(40), "d".repeat(40), "e".repeat(40)].map((sha) => ({
        sha,
        mediaCleanup: true,
      })),
    ].map((releases) => JSON.stringify(retainedReleaseInventory(releases))),
  ])(
    "refuses invalid retained inventory before any provider request (%#)",
    async (serializedInventory) => {
      const fetchImplementation = vi.fn();
      await expect(
        pruneProductionMediaCleanupFunctions(
          {
            ...retentionEnvironment(),
            RETAINED_RELEASE_INVENTORY: serializedInventory,
          },
          { fetchImplementation },
        ),
      ).rejects.toThrow();
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {},
    [],
    functionInventory().filter((version) => version.slug !== candidateSlug),
    [...functionInventory(), functionInventory()[0]],
    [...functionInventory(), functionInventory().at(-1)],
    [...functionInventory(), { ...functionInventory()[0], slug: [candidateSlug] }],
    [...functionInventory(), legacyMutableFunction(), legacyMutableFunction()],
    ...["status", "verify_jwt"].map((field) =>
      functionInventory().map((version) =>
        version.slug === candidateSlug
          ? { ...version, [field]: field === "status" ? "FAILED" : true }
          : version,
      ),
    ),
  ])(
    "does not DELETE anything when the active Function is invalid or identities are ambiguous (%#)",
    async (inventory) => {
      const harness = createProductionHarness({ inventory });
      await expect(
        pruneProductionMediaCleanupFunctions(retentionEnvironment(), {
          fetchImplementation: harness.fetchImplementation,
        }),
      ).rejects.toThrow();
      expect(harness.deletedSlugs).toEqual([]);
      expect(harness.fetchImplementation).toHaveBeenCalledOnce();
    },
  );

  it("re-verifies retention and fails if the active Function disappears from the provider", async () => {
    const harness = createProductionHarness();
    let inventoryReads = 0;
    await expect(
      pruneProductionMediaCleanupFunctions(retentionEnvironment(), {
        fetchImplementation: async (input, init) => {
          if (init.method === "GET" && ++inventoryReads > 1) {
            return Response.json([functionInventory().at(-1)]);
          }
          return harness.fetchImplementation(input, init);
        },
      }),
    ).rejects.toThrow("Function ativa");
    expect(inventoryReads).toBe(2);
    expect(harness.deletedSlugs).not.toContain(candidateSlug);
    expect(harness.deletedSlugs).not.toContain(rollbackSlug);
  });

  it.each(["missing", "inactive", "appeared"])(
    "checks observed reference preservation and final diagnostics (%s)",
    async (state) => {
      const harness = createProductionHarness({
        inventory: functionInventory().filter(
          (version) => state !== "appeared" || version.slug !== rollbackSlug,
        ),
      });
      let inventoryReads = 0;
      const result = pruneProductionMediaCleanupFunctions(retentionEnvironment(), {
        fetchImplementation: async (input, init) => {
          if (init.method === "GET" && ++inventoryReads > 1) {
            const finalInventory = [functionInventory()[0]];
            if (state !== "missing") {
              finalInventory.push({
                ...functionInventory().at(-1),
                status: state === "inactive" ? "FAILED" : "ACTIVE",
              });
            }
            return Response.json(finalInventory);
          }
          return harness.fetchImplementation(input, init);
        },
      });
      if (state === "missing") {
        await expect(result).rejects.toThrow("não preservou uma Function referenciada");
      } else {
        await expect(result).resolves.toMatchObject({
          deletedFunctions: 5,
          retainedFunctions: 2,
          missingReferencedFunctions: 0,
          unavailableReferencedFunctions: state === "inactive" ? 1 : 0,
        });
      }
      expect(inventoryReads).toBe(2);
      expect(harness.deletedSlugs).toEqual([...failedSlugs].sort());
    },
  );

  it("proves the candidate by direct HTTPS, ledger and Storage without pruning", async () => {
    const harness = createProductionHarness({
      inventory: [...functionInventory(), legacyMutableFunction()],
    });
    const result = await configureProductionMediaCleanup(environment(), {
      createClient: () => harness.client,
      createStorageClient: () => harness.storage,
      fetchImplementation: harness.fetchImplementation,
    });
    expect(harness.deletedSlugs).toEqual([]);
    expect(result).toEqual({ candidateSlug });
    expect(harness.fetchImplementation).toHaveBeenCalledOnce();

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
    expect(harness.statements.join("\n")).not.toMatch(/\b(?:pg_net|vault|cron|scheduler)\b/iu);
  });

  it("runs the pre-activation canary without old public health or a retention inventory", async () => {
    const harness = createProductionHarness();
    const canaryEnvironment = environment();
    delete canaryEnvironment.SUPABASE_ACCESS_TOKEN;

    await expect(
      configureProductionMediaCleanup(canaryEnvironment, {
        createClient: () => harness.client,
        createStorageClient: () => harness.storage,
        fetchImplementation: harness.fetchImplementation,
      }),
    ).resolves.toEqual({ candidateSlug });
    expect(harness.deletedSlugs).toEqual([]);
    expect(harness.fetchImplementation).toHaveBeenCalledOnce();
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
        pruneProductionMediaCleanupFunctions(retentionEnvironment(), {
          fetchImplementation: scenario.harness.fetchImplementation,
        }),
      ).rejects.toThrow(scenario.expectedError);
      expect(scenario.harness.deletedSlugs).not.toContain(rollbackSlug);
      expect(scenario.harness.deletedSlugs).not.toContain(candidateSlug);
    }
  });

  it("fails before opening Postgres when candidate identity or secret is invalid", async () => {
    const createClient = vi.fn();
    for (const invalidEnvironment of [
      { ...environment(), MEDIA_CLEANUP_FUNCTION_SLUG: "media-cleanup" },
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

  it("refuses GC with missing authority, wrong project or candidate identity before any provider request", async () => {
    const fetchImplementation = vi.fn();
    for (const invalidEnvironment of [
      { ...retentionEnvironment(), SUPABASE_ACCESS_TOKEN: undefined },
      { ...retentionEnvironment(), SUPABASE_PROJECT_REF: "a".repeat(20) },
      { ...retentionEnvironment(), MEDIA_CLEANUP_FUNCTION_SLUG: rollbackSlug },
      { ...retentionEnvironment(), MEDIA_CLEANUP_FUNCTION_SLUG: "media-cleanup" },
    ]) {
      await expect(
        pruneProductionMediaCleanupFunctions(invalidEnvironment, {
          fetchImplementation,
        }),
      ).rejects.toThrow();
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
