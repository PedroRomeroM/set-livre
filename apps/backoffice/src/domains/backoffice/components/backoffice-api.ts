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
  backofficeTaxonomyUpsertCommandSchema,
  backofficeTaxonomyListSchema,
  backofficeUserListSchema,
  backofficeUserPiiSchema,
  backofficeUserCommandResultSchema,
  backofficeTaxonomyCommandResultSchema,
  matchesBackofficeStudioAttempt,
  matchesBackofficePiiAttempt,
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

import {
  notifyBackofficeActivityCompleted,
  notifyBackofficeSessionChanged,
} from "./session-events";

const backofficeMutationRequestTimeoutMs = 10_000;
const backofficeReadRequestTimeoutMs = 10_000;

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
  timeoutMs = backofficeReadRequestTimeoutMs,
): Promise<T> {
  const deadlineController = new AbortController();
  const externalSignal = options?.signal;
  const signal =
    externalSignal === undefined || externalSignal === null
      ? deadlineController.signal
      : AbortSignal.any([externalSignal, deadlineController.signal]);
  const deadline = globalThis.setTimeout(
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
      signal,
    });
    payload = await responsePayload(response);
  } catch (error) {
    if (externalSignal?.aborted === true && signal.reason === externalSignal.reason) {
      throw externalSignal.reason;
    }
    if (deadlineController.signal.aborted) {
      throw new BackofficeClientError({
        code: "REQUEST_TIMEOUT",
        message: "A solicitação demorou mais que o esperado. Verifique o estado antes de repetir.",
        status: 504,
      });
    }
    if (error instanceof BackofficeClientError) throw error;
    throw new BackofficeClientError({
      code: "NETWORK_UNAVAILABLE",
      message: "Não foi possível conectar ao backoffice. Verifique sua conexão e tente novamente.",
      status: 503,
    });
  } finally {
    globalThis.clearTimeout(deadline);
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

export function readBackofficeSessionClient(signal?: AbortSignal) {
  return backofficeRequest("/api/auth/session", backofficeSessionSchema, {
    ...(signal === undefined ? {} : { signal }),
  });
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
  notifyBackofficeActivityCompleted();
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
  notifyBackofficeActivityCompleted();
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
  notifyBackofficeActivityCompleted();
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
  if (input.activity === "interactive") notifyBackofficeActivityCompleted();
  return detail;
}

export async function executeBackofficeStudioCommand(
  command: BackofficeStudioCommand,
): Promise<BackofficeStudioCommandResult> {
  const result = await backofficeMutationRequest(
    "/api/commands",
    backofficeStudioCommandResultSchema,
    {
      body: JSON.stringify(command),
      method: "POST",
    },
  );
  if (!matchesBackofficeStudioAttempt(command, result)) {
    throw new BackofficeClientError({
      code: "RESPONSE_INVALID",
      message: "O servidor retornou uma confirmação que não corresponde à tentativa enviada.",
      status: 200,
    });
  }
  notifyBackofficeActivityCompleted();
  return result;
}

export async function executeBackofficeUserCommand(
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
  const { action, idempotencyKey, scope, ...user } = await backofficeMutationRequest(
    "/api/commands",
    backofficeUserCommandResultSchema,
    {
      body: JSON.stringify(command),
      method: "POST",
    },
  );
  if (scope !== command.expectedScope || user.id !== command.payload.userId)
    rejectBackofficePrivateBoundary();
  if (
    action !== command.action ||
    idempotencyKey !== command.idempotencyKey.toLowerCase() ||
    user.accountVersion !== command.payload.expectedAccountVersion + 1 ||
    (command.action === "backoffice.user.suspend" && user.status !== "suspended") ||
    ((command.action === "backoffice.user.restore" ||
      command.action === "backoffice.access.grantAdmin" ||
      command.action === "backoffice.access.grantReviewer" ||
      command.action === "backoffice.access.grantSupport") &&
      user.status !== "active")
  ) {
    throw new BackofficeClientError({
      code: "RESPONSE_INVALID",
      message: "O servidor retornou uma confirmação que não corresponde à tentativa enviada.",
      status: 200,
    });
  }
  notifyBackofficeActivityCompleted();
  return user;
}

export async function executeBackofficeTaxonomyCommand(
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
  const { action, idempotencyKey, scope, ...item } = await backofficeMutationRequest(
    "/api/commands",
    backofficeTaxonomyCommandResultSchema,
    {
      body: JSON.stringify(command),
      method: "POST",
    },
  );
  if (
    scope !== command.expectedScope ||
    item.kind !== command.payload.kind ||
    (command.payload.id !== undefined && item.id !== command.payload.id)
  ) {
    rejectBackofficePrivateBoundary();
  }
  const submitted =
    command.action === "backoffice.taxonomy.upsert"
      ? backofficeTaxonomyUpsertCommandSchema.parse(command).payload
      : undefined;
  if (
    action !== command.action ||
    idempotencyKey !== command.idempotencyKey.toLowerCase() ||
    item.version !==
      (command.payload.expectedVersion === undefined ? 0 : command.payload.expectedVersion + 1) ||
    (command.action === "backoffice.taxonomy.archive" && item.active) ||
    (command.action === "backoffice.taxonomy.reactivate" && !item.active) ||
    (submitted !== undefined &&
      (item.name !== submitted.name ||
        item.slug !== submitted.slug ||
        item.sortOrder !== submitted.sortOrder ||
        (submitted.id === undefined && !item.active)))
  ) {
    throw new BackofficeClientError({
      code: "RESPONSE_INVALID",
      message: "O servidor retornou uma confirmação que não corresponde à tentativa enviada.",
      status: 200,
    });
  }
  notifyBackofficeActivityCompleted();
  return item;
}

export async function revealBackofficePiiWithoutCaching(
  command: Extract<BackofficeCommand, { action: "backoffice.user.revealPii" }>,
  consume: (pii: BackofficeUserPii) => void,
) {
  const pii = await backofficeMutationRequest("/api/commands", backofficeUserPiiSchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
  if (pii.scope !== command.expectedScope || pii.userId !== command.payload.userId) {
    rejectBackofficePrivateBoundary();
  }
  if (!matchesBackofficePiiAttempt(pii, command)) {
    throw new BackofficeClientError({
      code: "RESPONSE_INVALID",
      message: "O servidor retornou uma confirmação que não corresponde à tentativa enviada.",
      status: 200,
    });
  }
  notifyBackofficeActivityCompleted();
  consume(pii);
  return { revealed: true as const };
}
