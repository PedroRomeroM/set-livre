import "server-only";

import { apiErrorSchema, resolveRequestId } from "@set-livre/contracts";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

import { readBackofficeSupabaseEnvironment } from "@/lib/supabase/config";

const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

export type BackofficeApiErrorCode =
  | "AUTH_INVALID"
  | "AUTH_SESSION_RECHECK_REQUIRED"
  | "BODY_TOO_LARGE"
  | "CONFLICT"
  | "CONTENT_TYPE_INVALID"
  | "FORBIDDEN"
  | "INPUT_INVALID"
  | "NOT_FOUND"
  | "ORIGIN_INVALID"
  | "RATE_LIMITED"
  | "REAUTHENTICATION_REQUIRED"
  | "SERVICE_UNAVAILABLE"
  | "SESSION_CHANGED"
  | "UNAUTHENTICATED"
  | "VALIDATION_FAILED";

export class BackofficeApiError extends Error {
  readonly code: BackofficeApiErrorCode;
  readonly fieldErrors: Readonly<Record<string, string>> | undefined;
  readonly status: number;

  constructor(
    status: number,
    code: BackofficeApiErrorCode,
    message: string,
    fieldErrors?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "BackofficeApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

function trustedBackofficeOrigin() {
  const environment = readBackofficeSupabaseEnvironment();
  return { environment: environment.environment, url: new URL(environment.appOrigin) };
}

function assertTrustedBackofficeRequest(request: Request, options?: { origin?: boolean }) {
  const trusted = trustedBackofficeOrigin();
  const host = request.headers.get("host");
  if (
    host !== trusted.url.host ||
    (options?.origin !== false && request.headers.get("origin") !== trusted.url.origin)
  ) {
    throw new BackofficeApiError(403, "ORIGIN_INVALID", "A origem da solicitação não é permitida.");
  }
  if (
    trusted.environment === "production" &&
    (request.headers.get("x-forwarded-host") !== trusted.url.host ||
      request.headers.get("x-forwarded-proto") !== "https")
  ) {
    throw new BackofficeApiError(403, "ORIGIN_INVALID", "A origem da solicitação não é permitida.");
  }
}

function assertJsonContentType(request: Request) {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !jsonContentTypePattern.test(contentType)) {
    throw new BackofficeApiError(
      415,
      "CONTENT_TYPE_INVALID",
      "Envie os dados no formato JSON esperado.",
    );
  }
}

export async function readLimitedJson(request: Request, maximumBytes = 16 * 1_024) {
  assertJsonContentType(request);
  const announcedLength = request.headers.get("content-length");
  if (announcedLength !== null) {
    const parsedLength = Number(announcedLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new BackofficeApiError(
        413,
        "BODY_TOO_LARGE",
        "A solicitação excede o limite permitido.",
      );
    }
  }
  if (request.body === null) {
    throw new BackofficeApiError(400, "INPUT_INVALID", "Envie os campos obrigatórios.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new BackofficeApiError(
          413,
          "BODY_TOO_LARGE",
          "A solicitação excede o limite permitido.",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new BackofficeApiError(400, "INPUT_INVALID", "O JSON enviado é inválido.");
  }
}

function zodFieldErrors(error: z.ZodError) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.findLast(
      (candidate): candidate is number | string =>
        typeof candidate === "string" || typeof candidate === "number",
    );
    if (field !== undefined && fieldErrors[String(field)] === undefined) {
      fieldErrors[String(field)] = issue.message;
    }
  }
  return fieldErrors;
}

export function parseOrBackofficeInputError<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BackofficeApiError(
      422,
      "VALIDATION_FAILED",
      "Revise os campos destacados.",
      zodFieldErrors(parsed.error),
    );
  }
  return parsed.data;
}

function backofficeRequestId(request: Request) {
  return resolveRequestId(request.headers.get("x-request-id"));
}

export function hashBackofficePrivateValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function backofficeNetworkDiscriminator(request: Request) {
  const environment = readBackofficeSupabaseEnvironment();
  if (environment.environment !== "production") {
    return hashBackofficePrivateValue("local-direct");
  }
  const forwardedAddress = request.headers.get("x-forwarded-for");
  if (
    forwardedAddress === null ||
    forwardedAddress !== forwardedAddress.trim() ||
    isIP(forwardedAddress) === 0
  ) {
    throw new BackofficeApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "Não foi possível validar a origem de rede da solicitação.",
    );
  }
  return hashBackofficePrivateValue(forwardedAddress);
}

function backofficeSuccessResponse(
  data: unknown,
  requestId: string,
  status = 200,
  additionalHeaders?: HeadersInit,
) {
  const headers = new Headers(additionalHeaders);
  headers.set("cache-control", "private, no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-request-id", requestId);
  return Response.json({ data, requestId }, { headers, status });
}

function backofficeErrorResponse(
  error: unknown,
  requestId: string,
  additionalHeaders?: HeadersInit,
) {
  const routeError =
    error instanceof BackofficeApiError
      ? error
      : new BackofficeApiError(
          503,
          "SERVICE_UNAVAILABLE",
          "Não foi possível concluir agora. Tente novamente.",
        );
  const payload = apiErrorSchema.parse({
    error: {
      code: routeError.code,
      ...(routeError.fieldErrors === undefined ? {} : { fieldErrors: routeError.fieldErrors }),
      message: routeError.message,
      requestId,
    },
  });
  const headers = new Headers(additionalHeaders);
  headers.set("cache-control", "private, no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-request-id", requestId);
  return Response.json(payload, { headers, status: routeError.status });
}

const actionSchema = z.enum([
  "backoffice.access.setRole",
  "backoffice.auth.login",
  "backoffice.auth.logout",
  "backoffice.auth.session",
  "backoffice.taxonomies.read",
  "backoffice.taxonomy.setActive",
  "backoffice.taxonomy.upsert",
  "backoffice.user.revealPii",
  "backoffice.user.setStatus",
  "backoffice.users.read",
]);

export type BackofficeOperationalAction = z.infer<typeof actionSchema>;

function writeBackofficeOperationalEvent(event: {
  action: BackofficeOperationalAction;
  durationMs: number;
  outcome: "accepted" | "rejected" | "unavailable";
  requestId: string;
  status: number;
}) {
  const safeEvent = z
    .strictObject({
      action: actionSchema,
      durationMs: z.number().int().nonnegative(),
      event: z.literal("backoffice.request"),
      outcome: z.enum(["accepted", "rejected", "unavailable"]),
      requestId: z.uuid(),
      status: z.number().int().min(100).max(599),
    })
    .parse({
      ...event,
      durationMs: Math.max(0, Math.round(event.durationMs)),
      event: "backoffice.request",
    });
  process.stdout.write(`${JSON.stringify(safeEvent)}\n`);
}

export async function runBackofficeRoute(
  request: Request,
  action: BackofficeOperationalAction,
  execute: (
    requestId: string,
    setAction: (action: BackofficeOperationalAction) => void,
  ) => Promise<{
    data: unknown;
    responseHeaders?: HeadersInit | undefined;
    status?: number | undefined;
  }>,
  options?: { origin?: boolean },
) {
  const startedAt = performance.now();
  const requestId = backofficeRequestId(request);
  let status = 503;
  let outcome: "accepted" | "rejected" | "unavailable" = "unavailable";
  let operationalAction = action;
  try {
    assertTrustedBackofficeRequest(request, options);
    const result = await execute(requestId, (nextAction) => {
      operationalAction = nextAction;
    });
    status = result.status ?? 200;
    outcome = "accepted";
    return backofficeSuccessResponse(result.data, requestId, status, result.responseHeaders);
  } catch (error) {
    const response = backofficeErrorResponse(error, requestId);
    status = response.status;
    outcome = status >= 500 ? "unavailable" : "rejected";
    return response;
  } finally {
    writeBackofficeOperationalEvent({
      action: operationalAction,
      durationMs: performance.now() - startedAt,
      outcome,
      requestId,
      status,
    });
  }
}
