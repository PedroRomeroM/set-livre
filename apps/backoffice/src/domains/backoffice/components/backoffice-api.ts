"use client";

import {
  apiErrorSchema,
  apiSuccessSchema,
  backofficeSessionSchema,
  backofficeTaxonomyItemSchema,
  backofficeTaxonomyListSchema,
  backofficeUserListSchema,
  backofficeUserPiiSchema,
  backofficeUserSummarySchema,
  type BackofficeCommand,
  type BackofficeLoginPayload,
  type BackofficeTaxonomyItem,
  type BackofficeTaxonomyList,
  type BackofficeUserList,
  type BackofficeUserPii,
  type BackofficeUserQuery,
  type BackofficeUserSummary,
} from "@set-livre/contracts";
import { z } from "zod";

import { notifyBackofficeSessionChanged } from "./session-events";

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
): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
      ...options?.headers,
    },
  });
  const payload = await responsePayload(response);
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

export function loginBackofficeClient(payload: BackofficeLoginPayload) {
  return backofficeRequest("/api/auth/login", backofficeSessionSchema, {
    body: JSON.stringify(payload),
    method: "POST",
  });
}

export function logoutBackofficeClient(expectedScope: string) {
  return backofficeRequest("/api/auth/logout", z.strictObject({ signedOut: z.literal(true) }), {
    body: JSON.stringify({ expectedScope }),
    method: "POST",
  });
}

export function readBackofficeSessionClient() {
  return backofficeRequest("/api/auth/session", backofficeSessionSchema);
}

export function listBackofficeUsersClient(query: BackofficeUserQuery): Promise<BackofficeUserList> {
  return backofficeRequest("/api/users", backofficeUserListSchema, {
    body: JSON.stringify(query),
    method: "POST",
  });
}

export function listBackofficeTaxonomiesClient(): Promise<BackofficeTaxonomyList> {
  return backofficeRequest("/api/taxonomies", backofficeTaxonomyListSchema);
}

export function executeBackofficeUserCommand(
  command: Extract<
    BackofficeCommand,
    {
      action: "backoffice.access.setRole" | "backoffice.user.restore" | "backoffice.user.suspend";
    }
  >,
): Promise<BackofficeUserSummary> {
  return backofficeRequest("/api/commands", backofficeUserSummarySchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
}

export function executeBackofficeTaxonomyCommand(
  command: Extract<
    BackofficeCommand,
    { action: "backoffice.taxonomy.setActive" | "backoffice.taxonomy.upsert" }
  >,
): Promise<BackofficeTaxonomyItem> {
  return backofficeRequest("/api/commands", backofficeTaxonomyItemSchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
}

export async function revealBackofficePiiWithoutCaching(
  command: Extract<BackofficeCommand, { action: "backoffice.user.revealPii" }>,
  consume: (pii: BackofficeUserPii) => void,
) {
  const pii = await backofficeRequest("/api/commands", backofficeUserPiiSchema, {
    body: JSON.stringify(command),
    method: "POST",
  });
  consume(pii);
  return { revealed: true as const };
}
