const uuidSource = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uuidPattern = new RegExp(`^${uuidSource}$`, "u");
const cleanupFunctionSlugPattern = /^media-cleanup-[0-9a-f]{40}$/u;
const originalPathPattern = new RegExp(
  `^owners\\/(${uuidSource})\\/studios\\/(${uuidSource})\\/revisions\\/(${uuidSource})\\/(${uuidSource})\\.(avif|jpeg|jpg|png|webp)$`,
  "u",
);
const previewPathPattern = new RegExp(
  `^owners\\/(${uuidSource})\\/studios\\/(${uuidSource})\\/revisions\\/(${uuidSource})\\/(${uuidSource})\\.preview\\.webp$`,
  "u",
);
const safeErrorCodePattern = /^[a-z0-9_]{2,80}$/u;

export interface CleanupResult {
  claimed: number;
  deleted: number;
  failed: number;
}

interface CleanupRunContext {
  functionSlug: string;
  runId: string;
  workerId: string;
}

interface CleanupClaimContext extends CleanupRunContext {
  batchSize: number;
}

interface CleanupItemCompletionContext extends CleanupRunContext {
  errorCode: string | null;
  mediaId: string;
  succeeded: boolean;
}

export interface CleanupRunCompletionContext extends CleanupResult, CleanupRunContext {
  errorCode: string | null;
}

interface CleanupRemovalContext {
  bucket: "studio-media";
  paths: [string, string];
}

export interface CleanupDependencies {
  beginRun(context: CleanupRunContext): Promise<unknown>;
  claim(context: CleanupClaimContext): Promise<unknown>;
  complete(context: CleanupItemCompletionContext): Promise<void>;
  completeRun(context: CleanupRunCompletionContext): Promise<void>;
  remove(context: CleanupRemovalContext): Promise<void>;
}

interface CleanupCandidate extends CleanupRemovalContext {
  attempt: number;
  mediaId: string;
}

interface CleanupClaim {
  claimed: number;
  items: CleanupCandidate[];
}

interface RunningCleanupLedgerState {
  claimed: null;
  deleted: null;
  errorCode: null;
  failed: null;
  functionSlug: string;
  runId: string;
  status: "running";
}

interface SucceededCleanupLedgerState extends CleanupResult {
  errorCode: null;
  functionSlug: string;
  runId: string;
  status: "succeeded";
}

interface FailedCleanupLedgerState extends CleanupResult {
  errorCode: string;
  functionSlug: string;
  runId: string;
  status: "failed";
}

type CleanupLedgerState =
  FailedCleanupLedgerState | RunningCleanupLedgerState | SucceededCleanupLedgerState;

interface CleanupRunOptions {
  batchSize?: number;
  functionSlug: string;
  runId: string;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function parseCleanupRunRequest({
  contentType,
  rawBody,
}: {
  contentType: string | null | undefined;
  rawBody: unknown;
}): string {
  const normalizedContentType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedContentType !== "application/json") {
    throw new Error("A execução de cleanup exige JSON.");
  }
  if (typeof rawBody !== "string" || new TextEncoder().encode(rawBody).byteLength > 256) {
    throw new Error("O corpo da execução de cleanup é inválido.");
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new Error("O corpo da execução de cleanup é inválido.");
  }
  if (
    !isExactObject(body, ["runId"]) ||
    typeof body.runId !== "string" ||
    !uuidPattern.test(body.runId)
  ) {
    throw new Error("O corpo da execução de cleanup é inválido.");
  }
  return body.runId;
}

export function parseCleanupFunctionSlug(requestUrl: string): string {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    throw new Error("A URL da execução de cleanup é inválida.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("A URL da execução de cleanup é inválida.");
  }
  const match = /^\/functions\/v1\/(media-cleanup-[0-9a-f]{40})$/u.exec(url.pathname);
  const functionSlug = match?.[1];
  if (functionSlug === undefined || !cleanupFunctionSlugPattern.test(functionSlug)) {
    throw new Error("A URL da execução de cleanup é inválida.");
  }
  return functionSlug;
}

function parseCleanupRunLedgerState(
  value: unknown,
  runId: string,
  functionSlug: string,
): CleanupLedgerState {
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
    value.runId !== runId ||
    value.functionSlug !== functionSlug
  ) {
    throw new Error("O ledger retornou uma execução de cleanup inválida.");
  }
  if (value.status === "running") {
    if (
      value.claimed !== null ||
      value.deleted !== null ||
      value.failed !== null ||
      value.errorCode !== null
    ) {
      throw new Error("O ledger retornou uma execução de cleanup contraditória.");
    }
    return {
      claimed: null,
      deleted: null,
      errorCode: null,
      failed: null,
      functionSlug,
      runId,
      status: "running",
    };
  }

  const { claimed, deleted, errorCode, failed, status } = value;
  if (
    (status !== "succeeded" && status !== "failed") ||
    !isNonNegativeInteger(claimed) ||
    !isNonNegativeInteger(deleted) ||
    !isNonNegativeInteger(failed) ||
    claimed !== deleted + failed
  ) {
    throw new Error("O ledger retornou uma execução de cleanup contraditória.");
  }
  if (status === "succeeded") {
    if (failed !== 0 || deleted !== claimed || errorCode !== null) {
      throw new Error("O ledger retornou uma execução de cleanup contraditória.");
    }
    return {
      claimed,
      deleted,
      errorCode: null,
      failed,
      functionSlug,
      runId,
      status,
    };
  }
  if (typeof errorCode !== "string" || !safeErrorCodePattern.test(errorCode)) {
    throw new Error("O ledger retornou uma execução de cleanup contraditória.");
  }
  return {
    claimed,
    deleted,
    errorCode,
    failed,
    functionSlug,
    runId,
    status,
  };
}

function terminalResult(claimed: number, deleted: number, failed: number): CleanupResult {
  if (claimed !== deleted + failed) {
    throw new Error("O resultado de cleanup não fecha contabilmente.");
  }
  return { claimed, deleted, failed };
}

export class CleanupRunError extends Error {
  readonly errorCode: string;
  readonly result: CleanupResult;

  constructor(errorCode: string, result: CleanupResult, options?: ErrorOptions) {
    super(errorCode, options);
    this.name = "CleanupRunError";
    this.errorCode = errorCode;
    this.result = result;
  }
}

function parseCandidate(candidate: unknown): CleanupCandidate {
  if (
    !isExactObject(candidate, ["attempt", "bucket", "mediaId", "paths"]) ||
    typeof candidate.mediaId !== "string" ||
    !uuidPattern.test(candidate.mediaId) ||
    candidate.bucket !== "studio-media" ||
    !Array.isArray(candidate.paths) ||
    candidate.paths.length !== 2 ||
    !isPositiveInteger(candidate.attempt)
  ) {
    throw new Error("A fila de cleanup retornou um candidato inválido.");
  }

  const [originalPath, previewPath] = candidate.paths;
  if (typeof originalPath !== "string" || typeof previewPath !== "string") {
    throw new Error("A fila de cleanup retornou um candidato inválido.");
  }
  const original = originalPathPattern.exec(originalPath);
  const preview = previewPathPattern.exec(previewPath);
  if (original === null || preview === null) {
    throw new Error("A fila de cleanup retornou um candidato inválido.");
  }

  const originalIdentity = original.slice(1, 5);
  const previewIdentity = preview.slice(1, 5);
  if (
    originalIdentity.some((part, index) => part !== previewIdentity[index]) ||
    originalIdentity[3] !== candidate.mediaId
  ) {
    throw new Error("A fila de cleanup retornou um candidato inválido.");
  }
  return {
    attempt: candidate.attempt,
    bucket: "studio-media",
    mediaId: candidate.mediaId,
    paths: [originalPath, previewPath],
  };
}

function parseCleanupClaim(value: unknown, workerId: string): CleanupClaim {
  if (
    !isExactObject(value, ["claimToken", "items"]) ||
    value.claimToken !== workerId ||
    !Array.isArray(value.items)
  ) {
    throw new Error("A fila de cleanup retornou um payload inválido.");
  }
  return {
    claimed: value.items.length,
    items: value.items.map(parseCandidate),
  };
}

function claimedCardinality(value: unknown): number {
  if (isExactObject(value, ["claimToken", "items"]) && Array.isArray(value.items)) {
    return value.items.length;
  }
  return 0;
}

async function completeRun(
  dependencies: CleanupDependencies,
  context: CleanupRunContext,
  result: CleanupResult,
  errorCode: string | null,
): Promise<CleanupResult> {
  try {
    await dependencies.completeRun({
      ...context,
      ...result,
      errorCode,
    });
  } catch (cause) {
    throw new CleanupRunError("cleanup_run_complete_failed", result, { cause });
  }
  if (errorCode !== null) {
    throw new CleanupRunError(errorCode, result);
  }
  return result;
}

async function completeItem(
  dependencies: CleanupDependencies,
  context: CleanupItemCompletionContext,
): Promise<void> {
  try {
    await dependencies.complete(context);
  } catch {
    await dependencies.complete(context);
  }
}

export async function runStudioMediaCleanup(
  dependencies: CleanupDependencies,
  { batchSize = 25, functionSlug, runId }: CleanupRunOptions,
): Promise<CleanupResult> {
  if (!isPositiveInteger(batchSize) || batchSize > 100) {
    throw new Error("O lote de cleanup precisa estar entre 1 e 100.");
  }
  if (!uuidPattern.test(runId)) {
    throw new Error("A execução de cleanup precisa de um UUID.");
  }
  if (!cleanupFunctionSlugPattern.test(functionSlug)) {
    throw new Error("A execução de cleanup precisa de um slug imutável.");
  }
  const workerId = runId;
  const context = { functionSlug, runId, workerId };

  let ledgerState: CleanupLedgerState;
  try {
    ledgerState = parseCleanupRunLedgerState(
      await dependencies.beginRun(context),
      runId,
      functionSlug,
    );
  } catch (cause) {
    throw new CleanupRunError("cleanup_run_begin_failed", terminalResult(0, 0, 0), {
      cause,
    });
  }
  if (ledgerState.status !== "running") {
    const result = terminalResult(ledgerState.claimed, ledgerState.deleted, ledgerState.failed);
    if (ledgerState.status === "succeeded") return result;
    throw new CleanupRunError(ledgerState.errorCode, result);
  }

  let rawClaim: unknown;
  try {
    rawClaim = await dependencies.claim({ batchSize, ...context });
  } catch {
    return completeRun(dependencies, context, terminalResult(0, 0, 0), "cleanup_claim_failed");
  }

  let claim: CleanupClaim;
  try {
    claim = parseCleanupClaim(rawClaim, workerId);
  } catch {
    const claimed = claimedCardinality(rawClaim);
    return completeRun(
      dependencies,
      context,
      terminalResult(claimed, 0, claimed),
      "cleanup_claim_payload_invalid",
    );
  }

  let deleted = 0;
  let failed = 0;
  let runErrorCode: string | null = null;
  for (const candidate of claim.items) {
    let succeeded = false;
    try {
      await dependencies.remove({
        bucket: candidate.bucket,
        paths: candidate.paths,
      });
      succeeded = true;
    } catch {
      runErrorCode ??= "cleanup_storage_remove_failed";
    }

    try {
      await completeItem(dependencies, {
        errorCode: succeeded ? null : "storage_remove_failed",
        functionSlug,
        mediaId: candidate.mediaId,
        runId,
        succeeded,
        workerId,
      });
      if (succeeded) deleted += 1;
      else failed += 1;
    } catch {
      failed += 1;
      runErrorCode = "cleanup_item_complete_failed";
    }
  }

  const result = terminalResult(claim.claimed, deleted, failed);
  return completeRun(dependencies, context, result, runErrorCode);
}
