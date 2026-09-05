import { createClient } from "@supabase/supabase-js";

import {
  type CleanupDependencies,
  type CleanupResult,
  type CleanupRunCompletionContext,
  CleanupRunError,
  parseCleanupFunctionSlug,
  parseCleanupRunRequest,
  runStudioMediaCleanup,
} from "./cleanup-core.ts";

const encoder = new TextEncoder();
const secretKeyPattern = /^sb_secret_[A-Za-z0-9_-]{12,}$/u;
const cleanupStorageRemovalDeadlineMs = 10_000;
const cleanupRpcDeadlineMs = 5_000;
const cleanupRequestBodyDeadlineMs = 5_000;
const cleanupWorkDeadlineMs = 90_000;
const cleanupInvocationDeadlineMs = 100_000;
const cleanupResponseMaximumBytes = 64 * 1024;

type CleanupFetch = typeof fetch;

interface CleanupConfiguration {
  secretKey: string;
  url: string;
}

interface CleanupRpcResponse {
  data: unknown;
  error: unknown | null;
}

interface CleanupStorageResponse {
  error: unknown | null;
}

interface CleanupStorageBucket {
  remove(paths: string[]): PromiseLike<CleanupStorageResponse>;
}

interface CleanupSupabaseClient {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<CleanupRpcResponse>;
  storage: {
    from(bucket: string): CleanupStorageBucket;
  };
}

interface CleanupClientOptions {
  auth: {
    autoRefreshToken: false;
    persistSession: false;
  };
  global: {
    fetch: CleanupFetch;
  };
}

type CreateCleanupSupabaseClient = (
  url: string,
  secretKey: string,
  options: CleanupClientOptions,
) => CleanupSupabaseClient;

interface CleanupHandlerDependencies {
  createSupabaseClient: CreateCleanupSupabaseClient;
  fetchImplementation?: CleanupFetch;
  readConfiguration?: () => CleanupConfiguration;
}

interface CleanupFailureBody extends CleanupResult {
  errorCode: string;
}

interface EdgeRuntime {
  getEnvironmentVariable(name: string): string | undefined;
  serve(handler: (request: Request) => Promise<Response>): void;
}

interface RawEdgeRuntime {
  env: {
    get(name: string): unknown;
  };
  serve(handler: (request: Request) => Promise<Response>): unknown;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRawEdgeRuntime(value: unknown): value is RawEdgeRuntime {
  return (
    isRecord(value) &&
    isRecord(value.env) &&
    typeof value.env.get === "function" &&
    typeof value.serve === "function"
  );
}

function readEdgeRuntime(): EdgeRuntime {
  const runtime: unknown = Reflect.get(globalThis, "Deno");
  if (!isRawEdgeRuntime(runtime)) {
    throw new Error("missing_edge_runtime");
  }
  return {
    getEnvironmentVariable(name) {
      const value = runtime.env.get(name);
      if (typeof value !== "string" && value !== undefined) {
        throw new Error("invalid_edge_runtime_environment");
      }
      return value;
    },
    serve(handler) {
      runtime.serve(handler);
    },
  };
}

function responseBody(
  result: CleanupResult,
  errorCode?: string,
): CleanupFailureBody | CleanupResult {
  if (result.claimed !== result.deleted + result.failed) {
    throw new Error("cleanup_result_invariant_failed");
  }
  return errorCode === undefined ? result : { ...result, errorCode };
}

function terminalResponse(result: CleanupResult, status: number, errorCode?: string): Response {
  return Response.json(responseBody(result, errorCode), {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function failureResponse(
  errorCode: string,
  status = 503,
  result: CleanupResult | null = { claimed: 0, deleted: 0, failed: 0 },
): Response {
  if (result === null) {
    return Response.json(
      { errorCode },
      {
        headers: { "cache-control": "no-store" },
        status,
      },
    );
  }
  return terminalResponse(result, status, errorCode);
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function secretsMatch(left: string | null, right: string): Promise<boolean> {
  if (left === null) return false;
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  if (leftDigest.length !== rightDigest.length) return false;
  let difference = 0;
  for (const [index, leftByte] of leftDigest.entries()) {
    const rightByte = rightDigest.at(index);
    if (rightByte === undefined) return false;
    difference |= leftByte ^ rightByte;
  }
  return difference === 0;
}

async function readCleanupBody(
  message: Request | Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const reader = message.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        cancel();
        throw new Error("cleanup_body_too_large");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function createCleanupFetch(
  fetchImplementation: CleanupFetch,
  supabaseUrl: string,
  invocationSignal: AbortSignal,
  invocationStartedAt: number,
): CleanupFetch {
  const storageObjectEndpoint = new URL("/storage/v1/object/", supabaseUrl);

  return async (input, init) => {
    const endpoint = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const isStorageRemoval =
      method === "DELETE" &&
      endpoint.origin === storageObjectEndpoint.origin &&
      endpoint.pathname.startsWith(storageObjectEndpoint.pathname);

    const isRunCompletion =
      method === "POST" &&
      endpoint.origin === storageObjectEndpoint.origin &&
      endpoint.pathname === "/rest/v1/rpc/complete_studio_media_cleanup_run";
    const isItemCompletion =
      method === "POST" &&
      endpoint.origin === storageObjectEndpoint.origin &&
      endpoint.pathname === "/rest/v1/rpc/complete_studio_media_cleanup";
    // Setup: 5s input + two 5s begins + two 5s claims. Three items need at most 60s.
    // One 5s batch reconciliation fits the 90s work budget; two 5s finishes fit 100s.
    const remainingMs =
      invocationStartedAt +
      (isRunCompletion ? cleanupInvocationDeadlineMs : cleanupWorkDeadlineMs) -
      performance.now();
    if (remainingMs <= 0) {
      throw new Error("cleanup_invocation_deadline_exceeded");
    }
    const deadlineController = new AbortController();
    const signal = AbortSignal.any([
      // Disconnect stops physical work, not bounded item reconciliation or run finalization.
      ...(isRunCompletion || isItemCompletion ? [] : [invocationSignal]),
      ...(input instanceof Request ? [input.signal] : []),
      ...(init?.signal ? [init.signal] : []),
      deadlineController.signal,
    ]);
    signal.throwIfAborted();
    const deadlineError = new DOMException(
      isStorageRemoval
        ? "cleanup_storage_remove_deadline_exceeded"
        : "cleanup_rpc_deadline_exceeded",
      "TimeoutError",
    );
    const deadline = setTimeout(
      () => deadlineController.abort(deadlineError),
      Math.min(
        remainingMs,
        isStorageRemoval ? cleanupStorageRemovalDeadlineMs : cleanupRpcDeadlineMs,
      ),
    );
    try {
      const response = await fetchImplementation(input, {
        ...init,
        redirect: "error",
        signal,
      });
      // The SDK parses the buffered response only after the entire HTTP body is bounded.
      const body = await readCleanupBody(response, signal, cleanupResponseMaximumBytes);
      return new Response(response.body === null ? null : body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    } finally {
      clearTimeout(deadline);
    }
  };
}

function environment(): CleanupConfiguration {
  const runtime = readEdgeRuntime();
  const url = runtime.getEnvironmentVariable("SUPABASE_URL");
  const encodedKeys = runtime.getEnvironmentVariable("SUPABASE_SECRET_KEYS");
  if (url === undefined || encodedKeys === undefined) {
    throw new Error("missing_supabase_configuration");
  }
  let keys: unknown;
  try {
    keys = JSON.parse(encodedKeys);
  } catch {
    throw new Error("invalid_supabase_key_configuration");
  }
  const secretKey = isRecord(keys) ? keys.default : undefined;
  if (typeof secretKey !== "string" || !secretKeyPattern.test(secretKey)) {
    throw new Error("missing_default_secret_key");
  }
  return { secretKey, url };
}

async function parseRunRequest(request: Request): Promise<string> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () =>
      controller.abort(new DOMException("cleanup_request_body_deadline_exceeded", "TimeoutError")),
    cleanupRequestBodyDeadlineMs,
  );
  try {
    const body = await readCleanupBody(
      request,
      AbortSignal.any([request.signal, controller.signal]),
      256,
    );
    return parseCleanupRunRequest({
      contentType: request.headers.get("content-type"),
      rawBody: new TextDecoder().decode(body),
    });
  } finally {
    clearTimeout(deadline);
  }
}

function assertCompleteRunResult(value: unknown, expected: CleanupRunCompletionContext): void {
  const expectedStatus = expected.errorCode === null ? "succeeded" : "failed";
  if (
    !isExactObject(value, [
      "claimed",
      "deleted",
      "errorCode",
      "failed",
      "functionSlug",
      "runId",
      "status",
    ]) ||
    value.runId !== expected.runId ||
    value.status !== expectedStatus ||
    value.claimed !== expected.claimed ||
    value.deleted !== expected.deleted ||
    value.failed !== expected.failed ||
    value.functionSlug !== expected.functionSlug ||
    value.errorCode !== expected.errorCode
  ) {
    throw new Error("cleanup_run_complete_contract_failed");
  }
}

export function createCleanupRequestHandler({
  createSupabaseClient,
  fetchImplementation = fetch,
  readConfiguration = environment,
}: CleanupHandlerDependencies): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const invocationStartedAt = performance.now();
    if (request.method !== "POST") {
      return failureResponse("method_not_allowed", 405);
    }

    let config: CleanupConfiguration;
    try {
      config = readConfiguration();
    } catch {
      return failureResponse("service_unavailable");
    }
    if (!(await secretsMatch(request.headers.get("apikey"), config.secretKey))) {
      return failureResponse("unauthenticated", 401);
    }

    let runId: string;
    let functionSlug: string;
    try {
      functionSlug = parseCleanupFunctionSlug(request.url);
      runId = await parseRunRequest(request);
    } catch {
      return failureResponse("invalid_request", 400);
    }

    const client = createSupabaseClient(config.url, config.secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: createCleanupFetch(
          fetchImplementation,
          config.url,
          request.signal,
          invocationStartedAt,
        ),
      },
    });
    const dependencies: CleanupDependencies = {
      async beginRun(context) {
        const { data, error } = await client.rpc("begin_studio_media_cleanup_run", {
          p_function_slug: context.functionSlug,
          p_run_id: context.runId,
        });
        if (error !== null) throw new Error("cleanup_run_begin_failed");
        return data;
      },
      async claim({ batchSize, workerId }) {
        const { data, error } = await client.rpc("claim_studio_media_cleanup", {
          p_claim_token: workerId,
          p_limit: batchSize,
        });
        if (error !== null) throw new Error("cleanup_claim_failed");
        return data;
      },
      async complete({ errorCode, mediaId, succeeded, workerId }) {
        const { error } = await client.rpc("complete_studio_media_cleanup", {
          p_claim_token: workerId,
          p_error_code: errorCode,
          p_media_id: mediaId,
          p_succeeded: succeeded,
        });
        if (error !== null) throw new Error("cleanup_item_complete_failed");
      },
      async completeRun(context) {
        const { data, error } = await client.rpc("complete_studio_media_cleanup_run", {
          p_claimed: context.claimed,
          p_deleted: context.deleted,
          p_error_code: context.errorCode,
          p_failed: context.failed,
          p_run_id: context.runId,
          p_status: context.errorCode === null ? "succeeded" : "failed",
        });
        if (error !== null) throw new Error("cleanup_run_complete_failed");
        assertCompleteRunResult(data, context);
      },
      async remove({ bucket, paths }) {
        const { error } = await client.storage.from(bucket).remove(paths);
        if (error !== null) throw new Error("cleanup_storage_failed");
      },
    };

    try {
      const result = await runStudioMediaCleanup(dependencies, {
        functionSlug,
        runId,
      });
      return terminalResponse(result, 200);
    } catch (error) {
      if (error instanceof CleanupRunError) {
        return failureResponse(error.errorCode, 503, error.result);
      }
      return failureResponse("service_unavailable");
    }
  };
}

if (Reflect.get(import.meta, "main") === true) {
  readEdgeRuntime().serve(createCleanupRequestHandler({ createSupabaseClient: createClient }));
}
