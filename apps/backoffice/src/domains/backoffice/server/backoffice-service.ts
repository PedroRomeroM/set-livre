import "server-only";

import {
  backofficeStudioReviewDetailSchema,
  backofficeStudioReviewQueueQuerySchema,
  backofficeCommandSchema,
  backofficeUserQuerySchema,
  type BackofficeStudioReviewDetailRecord,
  type BackofficeCommand,
  type BackofficeStudioReadActivity,
  type BackofficeStudioReviewQueueQuery,
  type BackofficeUserQuery,
} from "@set-livre/contracts";
import { StorageClient } from "@supabase/storage-js";
import { z } from "zod";

import { BackofficeApiError } from "../../../lib/server/api-route";
import { readBackofficeSupabaseEnvironment } from "../../../lib/supabase/config";

import type { BackofficeAuthContext } from "./auth-context";
import {
  BackofficeCursorError,
  getBackofficeUserAccess,
  getBackofficeStudioReview,
  listBackofficeStudioReviews,
  listBackofficeTaxonomies,
  listBackofficeUsers,
  revealBackofficeUserPii,
  executeBackofficeStudioCommand,
  transitionBackofficeTaxonomy,
  setBackofficeUserRole,
  setBackofficeUserStatus,
  upsertBackofficeTaxonomy,
} from "./backoffice-dal";
import type { RequiredRouteBackofficeSession } from "./backoffice-session";
import { requireBackofficeRuntimeUnlock } from "./runtime-unlock";

const databaseErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});
const staleStateMessages = new Set([
  "backoffice_account_version_conflict",
  "backoffice_role_result_stale",
  "backoffice_roles_conflict",
  "backoffice_studio_conflict",
  "backoffice_studio_result_stale",
  "backoffice_taxonomy_result_stale",
  "backoffice_taxonomy_version_conflict",
  "backoffice_user_status_result_stale",
]);

const backofficeStudioPreviewLifetimeSeconds = 5 * 60;
export const backofficeStudioPreviewSigningDeadlineMs = 2_000;

type BackofficeStudioSigningClient = Readonly<{
  auth: Readonly<{
    getSession: () => Promise<{
      data: { session: { access_token: string } | null };
      error: unknown;
    }>;
  }>;
}>;
type BackofficeStudioSigningClientFactory = (
  signal: AbortSignal,
) => BackofficeStudioSigningClient | Promise<BackofficeStudioSigningClient>;
type BackofficeStudioSigningFetch = NonNullable<ConstructorParameters<typeof StorageClient>[2]>;

function backofficeStudioPreviewUnavailable() {
  return new BackofficeApiError(
    503,
    "SERVICE_UNAVAILABLE",
    "Não foi possível carregar as prévias privadas agora.",
  );
}

function createBackofficeStudioSigningFetch(
  fetchImplementation: BackofficeStudioSigningFetch,
  signingSignal: AbortSignal,
): BackofficeStudioSigningFetch {
  return (input, init) => {
    const requestSignal = init?.signal;
    const signal =
      requestSignal === undefined || requestSignal === null || requestSignal === signingSignal
        ? signingSignal
        : AbortSignal.any([signingSignal, requestSignal]);
    return fetchImplementation(input, { ...init, signal });
  };
}

function signingAbortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("A assinatura das prévias privadas foi interrompida.", "AbortError");
}

async function withBackofficeStudioSigningDeadline<T>(
  requestSignal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
) {
  const deadlineController = new AbortController();
  const signal =
    requestSignal === undefined
      ? deadlineController.signal
      : AbortSignal.any([requestSignal, deadlineController.signal]);
  let rejectAbort: ((reason: Error) => void) | undefined;
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(signingAbortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  const deadlineError = new DOMException(
    "A assinatura das prévias privadas excedeu o prazo.",
    "AbortError",
  );
  const deadline = setTimeout(
    () => deadlineController.abort(deadlineError),
    backofficeStudioPreviewSigningDeadlineMs,
  );

  try {
    if (signal.aborted) throw signingAbortError(signal);
    return await Promise.race([execute(signal), abortOutcome]);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBackofficeStudioStorageAccessToken(client: BackofficeStudioSigningClient) {
  const session = await client.auth.getSession();
  const accessToken = session.data.session?.access_token;
  if (session.error !== null || typeof accessToken !== "string" || accessToken.length === 0) {
    throw backofficeStudioPreviewUnavailable();
  }
  return accessToken;
}

function parseBackofficeRouteUuid(value: string) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) {
    throw new BackofficeApiError(404, "NOT_FOUND", "O registro solicitado não existe mais.");
  }
  return parsed.data;
}

function signedBackofficeStudioRevision(
  revision: BackofficeStudioReviewDetailRecord["candidateRevision"],
  signedUrls: ReadonlyMap<string, string>,
) {
  return {
    ...revision,
    media: revision.media.map(({ previewStoragePath, ...media }) => ({
      ...media,
      previewUrl: signedUrls.get(previewStoragePath) ?? "",
    })),
  };
}

async function signBackofficeStudioReviewMedia(
  record: BackofficeStudioReviewDetailRecord,
  createSigningClient: BackofficeStudioSigningClientFactory,
  requestSignal?: AbortSignal,
) {
  const paths = [
    ...new Set([
      ...record.candidateRevision.media.map((media) => media.previewStoragePath),
      ...(record.publishedRevision?.media.map((media) => media.previewStoragePath) ?? []),
    ]),
  ];
  if (paths.length === 0) {
    return backofficeStudioReviewDetailSchema.parse({
      ...record,
      candidateRevision: signedBackofficeStudioRevision(record.candidateRevision, new Map()),
      previewExpiresAt: null,
      publishedRevision:
        record.publishedRevision === null
          ? null
          : signedBackofficeStudioRevision(record.publishedRevision, new Map()),
    });
  }

  const environment = readBackofficeSupabaseEnvironment();
  const storageOrigin = new URL("/storage/v1", environment.supabaseOrigin).href.replace(/\/$/u, "");
  const signingStartedAt = Date.now();
  let signing: Awaited<ReturnType<ReturnType<StorageClient["from"]>["createSignedUrls"]>>;
  try {
    signing = await withBackofficeStudioSigningDeadline(requestSignal, async (signal) => {
      const client = await createSigningClient(signal);
      const accessToken = await readBackofficeStudioStorageAccessToken(client);
      return new StorageClient(
        storageOrigin,
        { apikey: environment.anonKey, authorization: `Bearer ${accessToken}` },
        createBackofficeStudioSigningFetch(globalThis.fetch, signal),
      )
        .from("studio-media")
        .createSignedUrls(paths, backofficeStudioPreviewLifetimeSeconds);
    });
  } catch {
    throw backofficeStudioPreviewUnavailable();
  }
  if (signing.error !== null || signing.data === null || signing.data.length !== paths.length) {
    throw backofficeStudioPreviewUnavailable();
  }
  const signedUrls = new Map<string, string>();
  for (const [index, path] of paths.entries()) {
    const signed = signing.data[index];
    if (
      signed === undefined ||
      signed.error !== null ||
      signed.path !== path ||
      typeof signed.signedUrl !== "string"
    ) {
      throw backofficeStudioPreviewUnavailable();
    }
    signedUrls.set(path, signed.signedUrl);
  }
  return backofficeStudioReviewDetailSchema.parse({
    ...record,
    candidateRevision: signedBackofficeStudioRevision(record.candidateRevision, signedUrls),
    previewExpiresAt: new Date(
      signingStartedAt + backofficeStudioPreviewLifetimeSeconds * 1_000,
    ).toISOString(),
    publishedRevision:
      record.publishedRevision === null
        ? null
        : signedBackofficeStudioRevision(record.publishedRevision, signedUrls),
  });
}

function translateBackofficeDatabaseError(error: unknown): never {
  if (error instanceof BackofficeApiError) throw error;
  if (error instanceof BackofficeCursorError) {
    throw new BackofficeApiError(
      422,
      "VALIDATION_FAILED",
      "O cursor não é válido para esta listagem. Recarregue a primeira página.",
      { cursor: "Use somente um cursor emitido por esta listagem." },
    );
  }
  const parsed = databaseErrorSchema.safeParse(error);
  if (!parsed.success) throw error;
  const { code, message } = parsed.data;
  if (code === "P0002") {
    throw new BackofficeApiError(404, "NOT_FOUND", "O registro solicitado não existe mais.");
  }
  if (message === "backoffice_reauthentication_required") {
    throw new BackofficeApiError(
      409,
      "REAUTHENTICATION_REQUIRED",
      "Confirme sua senha novamente para alterar acessos.",
    );
  }
  if (
    message === "backoffice_session_expired" ||
    message === "backoffice_auth_session_invalid" ||
    message === "backoffice_profile_ineligible"
  ) {
    throw new BackofficeApiError(401, "UNAUTHENTICATED", "Entre novamente para continuar.");
  }
  if (code === "42501") {
    throw new BackofficeApiError(403, "FORBIDDEN", "Você não possui permissão para esta ação.");
  }
  if (code === "40001" && message !== undefined && staleStateMessages.has(message)) {
    throw new BackofficeApiError(
      409,
      "STALE_STATE",
      "Os dados mudaram. O estado atual será recarregado para uma nova revisão.",
    );
  }
  if (code === "40001" || code === "23505" || code === "23514") {
    throw new BackofficeApiError(
      409,
      "CONFLICT",
      "Os dados mudaram ou a operação viola uma salvaguarda. Recarregue e revise o impacto.",
    );
  }
  if (code === "22023") {
    throw new BackofficeApiError(
      422,
      "VALIDATION_FAILED",
      "Os dados enviados não atendem ao contrato da operação.",
    );
  }
  throw error;
}

export async function readBackofficeUsers(
  route: RequiredRouteBackofficeSession,
  query: BackofficeUserQuery,
) {
  try {
    return {
      data: await listBackofficeUsers({
        auth: route.auth,
        ...backofficeUserQuerySchema.parse(query),
      }),
      responseHeaders: route.responseHeaders,
    };
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}

export async function readBackofficeTaxonomies(route: RequiredRouteBackofficeSession) {
  try {
    return {
      data: await listBackofficeTaxonomies(route.auth),
      responseHeaders: route.responseHeaders,
    };
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}

export async function readBackofficeUserAccess(input: {
  auth: BackofficeAuthContext;
  userId: string;
}) {
  try {
    return await getBackofficeUserAccess({
      auth: input.auth,
      userId: parseBackofficeRouteUuid(input.userId),
    });
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}

export async function readBackofficeStudioReviews(
  route: RequiredRouteBackofficeSession,
  query: BackofficeStudioReviewQueueQuery,
) {
  try {
    return {
      data: await listBackofficeStudioReviews({
        auth: route.auth,
        query: backofficeStudioReviewQueueQuerySchema.parse(query),
      }),
      responseHeaders: route.responseHeaders,
    };
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}

export async function readBackofficeStudioReview(input: {
  activity: BackofficeStudioReadActivity;
  auth: BackofficeAuthContext;
  createSigningClient: BackofficeStudioSigningClientFactory;
  signal?: AbortSignal;
  studioId: string;
}) {
  try {
    const studioId = parseBackofficeRouteUuid(input.studioId);
    const record = await getBackofficeStudioReview({
      auth: input.auth,
      studioId,
      touchActivity: input.activity === "interactive",
    });
    if (record.scope !== input.auth.userId || record.studioId !== studioId) {
      throw new Error("backoffice_studio_response_boundary_violation");
    }
    return await signBackofficeStudioReviewMedia(record, input.createSigningClient, input.signal);
  } catch (error) {
    if (error instanceof BackofficeApiError) throw error;
    translateBackofficeDatabaseError(error);
  }
}

export async function executeBackofficeCommand(
  commandInput: BackofficeCommand,
  context: { requestId: string; route: RequiredRouteBackofficeSession },
) {
  const command = backofficeCommandSchema.parse(commandInput);
  const { requestId, route } = context;
  if (command.expectedScope !== route.session.scope) {
    throw new BackofficeApiError(
      409,
      "SESSION_CHANGED",
      "A sessão mudou. Recarregue antes de continuar.",
    );
  }
  await requireBackofficeRuntimeUnlock(route.auth);
  try {
    let data: unknown;
    switch (command.action) {
      case "backoffice.user.restore":
      case "backoffice.user.suspend":
        data = await setBackofficeUserStatus({ auth: route.auth, command, requestId });
        break;
      case "backoffice.user.revealPii":
        data = await revealBackofficeUserPii({ auth: route.auth, command, requestId });
        break;
      case "backoffice.access.grantAdmin":
      case "backoffice.access.grantReviewer":
      case "backoffice.access.grantSupport":
      case "backoffice.access.revokeAdmin":
      case "backoffice.access.revokeReviewer":
      case "backoffice.access.revokeSupport":
        data = await setBackofficeUserRole({ auth: route.auth, command, requestId });
        break;
      case "backoffice.taxonomy.upsert":
        data = await upsertBackofficeTaxonomy({ auth: route.auth, command, requestId });
        break;
      case "backoffice.taxonomy.archive":
      case "backoffice.taxonomy.reactivate":
        data = await transitionBackofficeTaxonomy({ auth: route.auth, command, requestId });
        break;
      case "backoffice.studio.approve":
      case "backoffice.studio.reject":
      case "backoffice.studio.disable":
      case "backoffice.studio.restore":
        data = await executeBackofficeStudioCommand({ auth: route.auth, command, requestId });
        break;
    }
    return { data, responseHeaders: route.responseHeaders };
  } catch (error) {
    translateBackofficeDatabaseError(error);
  }
}
