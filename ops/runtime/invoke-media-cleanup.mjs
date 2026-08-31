import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const productionSupabaseOrigin = "https://oirvvnojgkzdppkdvhej.supabase.co";
const releaseShaPattern = /^[0-9a-f]{40}$/u;
const secretKeyPattern = /^sb_secret_[A-Za-z0-9_-]{12,}$/u;
const responseKeys = Object.freeze(["claimed", "deleted", "failed"]);
const requestTimeoutMilliseconds = 20_000;

function fail(code) {
  throw new Error(code);
}

function requireRuntimeConfiguration(environment) {
  const releaseSha = environment.APP_RELEASE_SHA;
  const secretKey = environment.SUPABASE_SECRET_KEY;
  const supabaseUrl = environment.NEXT_PUBLIC_SUPABASE_URL;

  if (supabaseUrl !== productionSupabaseOrigin) fail("invalid-supabase-origin");
  if (typeof secretKey !== "string" || !secretKeyPattern.test(secretKey)) {
    fail("invalid-supabase-secret");
  }
  if (typeof releaseSha !== "string" || !releaseShaPattern.test(releaseSha)) {
    fail("invalid-release-sha");
  }

  return { releaseSha, secretKey };
}

function requireExactSuccessPayload(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-response");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== responseKeys.length ||
    keys.some((key, index) => key !== responseKeys[index])
  ) {
    fail("invalid-response");
  }
  const { claimed, deleted, failed } = value;
  if (
    !Number.isSafeInteger(claimed) ||
    claimed < 0 ||
    !Number.isSafeInteger(deleted) ||
    deleted < 0 ||
    !Number.isSafeInteger(failed) ||
    failed < 0 ||
    claimed !== deleted ||
    failed !== 0
  ) {
    fail("invalid-response");
  }
}

export async function invokeProductionMediaCleanup({
  environment = process.env,
  fetchImplementation = globalThis.fetch,
  makeRunId = randomUUID,
} = {}) {
  const { releaseSha, secretKey } = requireRuntimeConfiguration(environment);
  const runId = makeRunId();
  if (
    typeof runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)
  ) {
    fail("invalid-run-id");
  }

  let response;
  try {
    response = await fetchImplementation(
      `${productionSupabaseOrigin}/functions/v1/media-cleanup-${releaseSha}`,
      {
        body: JSON.stringify({ runId }),
        headers: {
          apikey: secretKey,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      },
    );
  } catch {
    fail("request-failed");
  }

  if (response.status !== 200) fail("unexpected-status");
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;[^\r\n]*)?$/iu.test(contentType)) {
    fail("invalid-response-content-type");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("invalid-response");
  }
  requireExactSuccessPayload(payload);
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  invokeProductionMediaCleanup().catch((error) => {
    const code = error instanceof Error ? error.message : "unknown-failure";
    process.stderr.write(`media-cleanup: ${code}\n`);
    process.exitCode = 1;
  });
}
