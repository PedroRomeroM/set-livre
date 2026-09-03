"use client";

import {
  apiErrorSchema,
  apiSuccessSchema,
  backofficeSessionSchema,
  backofficeRuntimeUnlockResultSchema,
  backofficeStudioCommandResultSchema,
  backofficeStudioReviewDetailSchema,
  backofficeStudioReviewQueueSchema,
  backofficeStudioReadActivityHeader,
  backofficeTaxonomyItemSchema,
  backofficeTaxonomyListSchema,
  backofficeUserListSchema,
  backofficeUserPiiSchema,
  backofficeUserSummarySchema,
  type BackofficeCommand,
  type BackofficeLoginPayload,
  type BackofficeRuntimeUnlockPayload,
  type BackofficeStudioCommand,
  type BackofficeStudioCommandResult,
  type BackofficeStudioReviewDetail,
  type BackofficeStudioReviewQueue,
  type BackofficeStudioReviewQueueQuery,
  type BackofficeStudioReadActivity,
  type BackofficeTaxonomyItem,
  type BackofficeTaxonomyList,
  type BackofficeUserList,
  type BackofficeUserPii,
  type BackofficeUserQuery,
  type BackofficeUserSummary,
} from "@set-livre/contracts";
import { z } from "zod";

import { notifyBackofficeSessionChanged } from "./session-events";

const backofficeMutationRequestTimeoutMs = 10_000;

export class BackofficeClientError extends Error {
  readonly code: string;
  readonly fieldErrors: Readonly<Record<string, string>> | undefined;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(input: {
    code: string;
    fieldErrors?: Readonly<Record<string, string>> | undefined;
    message: string;
    requestId?: string | undefined;
    status: number;
  }) {
    super(input.message);
    this.name = "BackofficeClientError";
    this.code = input.code;
    this.fieldErrors = input.fieldErrors;
    this.requestId = input.requestId;
    this.status = input.status;
  }
}

export function isAmbiguousBackofficeError(error: unknown) {
  return (
    !(error instanceof BackofficeClientError) ||
    error.status >= 500 ||
    error.code === "RESPONSE_INVALID"
  );
}

export function isStaleBackofficeError(error: unknown) {
  return error instanceof BackofficeClientError && error.code === "STALE_STATE";
}

function rejectBackofficePrivateBoundary(): never {
  notifyBackofficeSessionChanged();
  throw new BackofficeClientError({
    code: "RESPONSE_INVALID",
    message: "A resposta privada não corresponde à sessão ou ao registro solicitado.",
    status: 200,
  });
}

async function responsePayload(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new BackofficeClientError({
      code: "RESPONSE_INVALID",
      message: "O servidor retornou uma resposta inválida.",
      status: response.status,
    });
  }
}

async function backofficeRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: RequestInit,
  timeoutMs?: number,
): Promise<T> {
  const deadlineController = timeoutMs === undefined ? undefined : new AbortController();
  const externalSignal = options?.signal;
  const signal = deadlineController
    ? externalSignal === undefined || externalSignal === null
      ? deadlineController.signal
      : AbortSignal.any([externalSignal, deadlineController.signal])
    : externalSignal;
  const deadline =
    deadlineController === undefined
      ? undefined
      : globalThis.setTimeout(
          () =>
            deadlineController.abort(
              new DOMException("O prazo da solicitação ao backoffice expirou.", "TimeoutError"),
            ),
          timeoutMs,
        );
  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
        ...options?.headers,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    payload = await responsePayload(response);
  } catch (error) {
    if (deadlineController?.signal.aborted === true) {
      throw new BackofficeClientError({
        code: "REQUEST_TIMEOUT",
        message: "A solicitação demorou mais que o esperado. Verifique o estado antes de repetir.",
        status: 504,
      });
    }
    if (externalSignal?.aborted === true) throw error;
    if (error instanceof BackofficeClientError) throw error;
    throw new BackofficeClientError({
      code: "NETWORK_UNAVAILABLE",
      message: "Não foi possível conectar ao backoffice. Verifique sua conexão e tente novamente.",
      status: 503,
    });
  } finally {
    if (deadline !== undefined) globalThis.clearTimeout(deadline);
  }
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(payload);
    if (!error.success) {
      throw new BackofficeClientError({
        code: "RESPONSE_INVALID",
        message: "Não foi possível concluir agora.",
        status: response.status,
      });
    }
    if (
      error.data.error.code === "FORBIDDEN" ||
      error.data.error.code === "SESSION_CHANGED" ||
      error.data.error.code === "UNAUTHENTICATED"
    ) {
      notifyBackofficeSessionChanged();
    }
    throw new BackofficeClientError({
      code: error.data.error.code,
      fieldErrors: error.data.error.fieldErrors,
      message: error.data.error.message,
      requestId: error.data.error.requestId,
      status: response.status,
    });
  }
  const parsed = apiSuccessSchema(schema).safeParse(payload);
  if (!parsed.success) {
    throw new BackofficeClientError({
      code: "RESPONSE_INVALID",
      message: "O servidor retornou uma resposta fora do contrato.",
      status: response.status,
    });
  }
  return parsed.data.data;
}

function backofficeMutationRequest<T>(path: string, schema: z.ZodType<T>, options: RequestInit) {
  return backofficeRequest(path, schema, options, backofficeMutationRequestTimeoutMs);
}

export function loginBackofficeClient(payload: BackofficeLoginPayload) {
  return backofficeMutationRequest("/api/auth/login", backofficeSessionSchema, {
    body: JSON.stringify(payload),
    method: "POST",
  });
}

export function logoutBackofficeClient(expectedScope: string) {
  return backofficeMutationRequest(
    "/api/auth/logout",
    z.strictObject({ signedOut: z.literal(true) }),
    {
      body: JSON.stringify({ expectedScope }),
      method: "POST",
    },
  );
}

export function readBackofficeSessionClient() {
  return backofficeRequest("/api/auth/session", backofficeSessionSchema);
}

export function unlockBackofficeRuntimeClient(payload: BackofficeRuntimeUnlockPayload) {
  return backofficeMutationRequest("/api/auth/unlock", backofficeRuntimeUnlockResultSchema, {
    body: JSON.stringify(payload),
    method: "POST",
  });
}

export async function listBackofficeUsersClient(
  input: Readonly<{ expectedScope: string; query: BackofficeUserQuery }>,
  signal?: AbortSignal,
): Promise<BackofficeUserList> {
  const users = await backofficeRequest("/api/users", backofficeUserListSchema, {
    body: JSON.stringify(input.query),
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  });
  if (users.scope !== input.expectedScope) rejectBackofficePrivateBoundary();
  return users;
}

export async function listBackofficeTaxonomiesClient(
  expectedScope: string,
  signal?: AbortSignal,
): Promise<BackofficeTaxonomyList> {
  const taxonomies = await backofficeRequest("/api/taxonomies", backofficeTaxonomyListSchema, {
    ...(signal === undefined ? {} : { signal }),
  });
  if (taxonomies.scope !== expectedScope) rejectBackofficePrivateBoundary();
  return taxonomies;
}

export async function listBackofficeStudioReviewsClient(
  input: Readonly<{
    expectedScope: string;
    query: BackofficeStudioReviewQueueQuery;
  }>,
  signal?: AbortSignal,
): Promise<BackofficeStudioReviewQueue> {
  const queue = await backofficeRequest("/api/studios", backofficeStudioReviewQueueSchema, {
    body: JSON.stringify(input.query),
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  });
  if (queue.scope !== input.expectedScope) rejectBackofficePrivateBoundary();
  return queue;
}

export async function readBackofficeStudioReviewClient(
  input: Readonly<{
    activity: BackofficeStudioReadActivity;
    expectedScope: string;
    studioId: string;
  }>,
  signal?: AbortSignal,
): Promise<BackofficeStudioReviewDetail> {
  const detail = await backofficeRequest(
    `/api/studios/${encodeURIComponent(input.studioId)}`,
    backofficeStudioReviewDetailSchema,
    {
      headers: { [backofficeStudioReadActivityHeader]: input.activity },
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (detail.scope !== input.expectedScope || detail.studioId !== input.studioId) {
    rejectBackofficePrivateBoundary();
  }
  return detail;
}

export function executeBackofficeStudioCommand(
  command: BackofficeStudioCommand,
): Promise<BackofficeStudioCommandResult> {
  return backofficeMutationRequest("/api/commands", backofficeStudioCommandResultSchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
}

export function executeBackofficeUserCommand(
  command: Extract<
    BackofficeCommand,
    {
      action:
        | "backoffice.access.grantAdmin"
        | "backoffice.access.grantReviewer"
        | "backoffice.access.grantSupport"
        | "backoffice.access.revokeAdmin"
        | "backoffice.access.revokeReviewer"
        | "backoffice.access.revokeSupport"
        | "backoffice.user.restore"
        | "backoffice.user.suspend";
    }
  >,
): Promise<BackofficeUserSummary> {
  return backofficeMutationRequest("/api/commands", backofficeUserSummarySchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
}

export function executeBackofficeTaxonomyCommand(
  command: Extract<
    BackofficeCommand,
    {
      action:
        | "backoffice.taxonomy.archive"
        | "backoffice.taxonomy.reactivate"
        | "backoffice.taxonomy.upsert";
    }
  >,
): Promise<BackofficeTaxonomyItem> {
  return backofficeMutationRequest("/api/commands", backofficeTaxonomyItemSchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
}

export async function revealBackofficePiiWithoutCaching(
  command: Extract<BackofficeCommand, { action: "backoffice.user.revealPii" }>,
  consume: (pii: BackofficeUserPii) => void,
) {
  const pii = await backofficeMutationRequest("/api/commands", backofficeUserPiiSchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
  consume(pii);
  return { revealed: true as const };
}
