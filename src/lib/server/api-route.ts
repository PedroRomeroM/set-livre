import "server-only";

import { apiErrorSchema, resolveRequestId } from "@set-livre/contracts";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const trustedEnvironmentSchema = z.object({
  APP_ENV: z.enum(["development", "local", "production", "test"]),
  NEXT_PUBLIC_APP_URL: z.url(),
});
const canonicalRouteUuidSchema = z.uuid().transform((value) => value.toLowerCase());

export function canonicalRouteUuid(value: string) {
  const parsed = canonicalRouteUuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type ApiRouteErrorCode =
  | "AUTH_INVALID"
  | "AUTH_RESTART_REQUIRED"
  | "AUTH_SESSION_RECHECK_REQUIRED"
  | "ACCOUNT_SUSPENDED"
  | "BODY_TOO_LARGE"
  | "CONFLICT"
  | "CONTENT_TYPE_INVALID"
  | "FORBIDDEN"
  | "INPUT_INVALID"
  | "MEDIA_COVER_REPLACEMENT_REQUIRED"
  | "MEDIA_LIMIT_REACHED"
  | "MEDIA_ORDER_CHANGED"
  | "METHOD_NOT_ALLOWED"
  | "NOT_FOUND"
  | "ORIGIN_INVALID"
  | "OWNER_CONTRACT_CHANGED"
  | "PAYMENT_PROVIDER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "RECOVERY_INVALID"
  | "RECOVERY_RESTART_REQUIRED"
  | "SERVICE_UNAVAILABLE"
  | "SESSION_CHANGED"
  | "STUDIO_SUBMISSION_INCOMPLETE"
  | "STUDIO_TAXONOMY_UNAVAILABLE"
  | "STUDIO_TYPE_UNAVAILABLE"
  | "UNAUTHENTICATED"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_OBJECT_MISSING"
  | "VALIDATION_FAILED";

export class ApiRouteError extends Error {
  readonly code: ApiRouteErrorCode;
  readonly fieldErrors: Readonly<Record<string, string>> | undefined;
  readonly status: number;

  constructor(
    status: number,
    code: ApiRouteErrorCode,
    message: string,
    fieldErrors?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "ApiRouteError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

function trustedApplicationOrigin() {
  const environment = trustedEnvironmentSchema.parse(process.env);
  const parsed = new URL(environment.NEXT_PUBLIC_APP_URL);

  if (parsed.origin !== environment.NEXT_PUBLIC_APP_URL || parsed.pathname !== "/") {
    throw new Error("NEXT_PUBLIC_APP_URL precisa ser uma origem sem path, query ou fragmento.");
  }

  const isLocalRuntime = environment.APP_ENV === "local" || environment.APP_ENV === "test";
  if (isLocalRuntime && parsed.origin !== "http://127.0.0.1:3000") {
    throw new Error("O runtime local de Auth exige a origem HTTP IPv4 literal documentada.");
  }
  if (!isLocalRuntime && parsed.protocol !== "https:") {
    throw new Error("O runtime não local de Auth exige a origem HTTPS da aplicação.");
  }

  return { environment: environment.APP_ENV, url: parsed };
}

export function assertTrustedRequestOrigin(request: Request) {
  const trusted = trustedApplicationOrigin();
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin !== trusted.url.origin || host !== trusted.url.host) {
    throw new ApiRouteError(403, "ORIGIN_INVALID", "A origem da solicitação não é permitida.");
  }
  if (
    trusted.environment === "production" &&
    (request.headers.get("x-forwarded-host") !== trusted.url.host ||
      request.headers.get("x-forwarded-proto") !== "https")
  ) {
    throw new ApiRouteError(403, "ORIGIN_INVALID", "A origem da solicitação não é permitida.");
  }
}

function assertJsonContentType(request: Request) {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !jsonContentTypePattern.test(contentType)) {
    throw new ApiRouteError(
      415,
      "CONTENT_TYPE_INVALID",
      "Envie os dados no formato JSON esperado.",
    );
  }
}

export async function readLimitedJson(request: Request, maximumBytes = 16 * 1024) {
  assertJsonContentType(request);

  const announcedLength = request.headers.get("content-length");
  if (announcedLength !== null) {
    const parsedLength = Number(announcedLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new ApiRouteError(413, "BODY_TOO_LARGE", "A solicitação excede o limite permitido.");
    }
  }

  if (request.body === null) {
    throw new ApiRouteError(400, "INPUT_INVALID", "Envie os campos obrigatórios.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new ApiRouteError(413, "BODY_TOO_LARGE", "A solicitação excede o limite permitido.");
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
    throw new ApiRouteError(400, "INPUT_INVALID", "O JSON enviado é inválido.");
  }
}

function zodFieldErrors(error: z.ZodError) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.includes("taxIdChange")
      ? "taxId"
      : issue.path.includes("documentChange")
        ? "additionalDocument"
        : issue.path.findLast(
            (candidate): candidate is number | string =>
              typeof candidate === "string" || typeof candidate === "number",
          );
    if (
      (typeof field === "string" || typeof field === "number") &&
      fieldErrors[field] === undefined
    ) {
      fieldErrors[String(field)] = issue.message;
    }
  }
  return fieldErrors;
}

export function parseOrInputError<T>(
  schema: z.ZodType<T>,
  value: unknown,
  options: Readonly<{
    code?: "INPUT_INVALID" | "VALIDATION_FAILED";
    status?: 400 | 422;
  }> = {},
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiRouteError(
      options.status ?? 400,
      options.code ?? "INPUT_INVALID",
      "Revise os campos destacados.",
      zodFieldErrors(result.error),
    );
  }
  return result.data;
}

export function requestIdFrom(request: Request) {
  return resolveRequestId(request.headers.get("x-request-id"));
}

export function hashPrivateRateLimitValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function requestRateLimitDiscriminator(request: Request) {
  const environment = trustedEnvironmentSchema.parse(process.env);
  if (environment.APP_ENV !== "production") {
    return hashPrivateRateLimitValue("local-direct");
  }

  const forwardedAddress = request.headers.get("x-forwarded-for");
  if (
    forwardedAddress === null ||
    forwardedAddress !== forwardedAddress.trim() ||
    isIP(forwardedAddress) === 0
  ) {
    throw new ApiRouteError(
      503,
      "SERVICE_UNAVAILABLE",
      "Não foi possível validar a origem de rede da solicitação.",
    );
  }
  return hashPrivateRateLimitValue(forwardedAddress);
}

export function apiSuccessResponse(
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

export function apiErrorResponse(
  error: unknown,
  requestId: string,
  additionalHeaders?: HeadersInit,
) {
  const routeError =
    error instanceof ApiRouteError
      ? error
      : new ApiRouteError(
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

const observableActionSchema = z.enum([
  "identity.callback",
  "identity.login",
  "identity.logout",
  "identity.recovery.request",
  "identity.recovery.status",
  "identity.recovery.update",
  "identity.register",
  "identity.session",
  "owner.activate",
  "owner.read",
  "private.command",
  "profile.complete",
  "profile.read",
  "profile.update",
  "recipient.onboarding.refresh",
  "recipient.onboarding.start",
  "studio.create",
  "studio.draft.discard",
  "studio.media.cover.set",
  "studio.media.delete",
  "studio.media.read",
  "studio.media.reorder",
  "studio.media.upload.finalize",
  "studio.media.upload.prepare",
  "studio.pause",
  "studio.publication.read",
  "studio.read",
  "studio.resume",
  "studio.revision.submit",
  "studio.revision.updateContent",
  "studio.revision.updateCore",
  "studio.revision.updateTaxonomy",
  "studio.taxonomies.read",
  "studio.types.read",
]);
const observableOutcomeSchema = z.enum(["accepted", "rejected", "unavailable"]);
const observableEventSchema = z.enum([
  "identity.request",
  "owner.request",
  "private.command",
  "studio.request",
]);

export function writeSafeOperationalEvent(event: {
  action: z.infer<typeof observableActionSchema>;
  durationMs: number;
  event: z.infer<typeof observableEventSchema>;
  outcome: z.infer<typeof observableOutcomeSchema>;
  requestId: string;
  status: number;
}) {
  const safeEvent = z
    .strictObject({
      action: observableActionSchema,
      durationMs: z.number().int().nonnegative(),
      event: observableEventSchema,
      outcome: observableOutcomeSchema,
      requestId: z.uuid(),
      status: z.number().int().min(100).max(599),
    })
    .parse({
      ...event,
      durationMs: Math.max(0, Math.round(event.durationMs)),
    });
  process.stdout.write(`${JSON.stringify(safeEvent)}\n`);
}
