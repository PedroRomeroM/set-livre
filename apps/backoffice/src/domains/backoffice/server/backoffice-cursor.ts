import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const cursorSigningEnvironmentSchema = z.object({
  BACKOFFICE_RUNTIME_UNLOCK_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  DATABASE_URL_APP_DAL: z.string().min(1).max(4_096),
});
const encodedCursorPartPattern = /^[A-Za-z0-9_-]+$/u;
const cursorSignaturePattern = /^[A-Za-z0-9_-]{43}$/u;

const userCursorPayloadSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  kind: z.literal("users"),
  version: z.literal(1),
});

const studioReviewCursorPayloadSchema = z.strictObject({
  kind: z.literal("studio-reviews"),
  sequence: z.number().int().nonnegative().safe(),
  studioId: z.uuid(),
  version: z.literal(1),
});

type CursorContext = Readonly<{
  authSessionId: string;
  filter: string | null;
  kind: "studio-reviews" | "users";
  scope: string;
}>;

function cursorSigningKey(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = cursorSigningEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("A assinatura de cursores do backoffice não está configurada.");
  }
  return createHmac("sha256", parsed.data.BACKOFFICE_RUNTIME_UNLOCK_KEY)
    .update("set-livre-backoffice-cursor-key-v1\0", "utf8")
    .update(parsed.data.DATABASE_URL_APP_DAL, "utf8")
    .digest();
}

function cursorSignature(encodedPayload: string, context: CursorContext, key: Buffer) {
  const boundContext = JSON.stringify({
    authSessionId: context.authSessionId,
    filter: context.filter,
    kind: context.kind,
    scope: context.scope,
    version: 1,
  });
  return createHmac("sha256", key)
    .update("set-livre-backoffice-cursor-v1\0", "utf8")
    .update(boundContext, "utf8")
    .update("\0", "utf8")
    .update(encodedPayload, "ascii")
    .digest("base64url");
}

function encodeCursor(payload: unknown, context: CursorContext) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${cursorSignature(encodedPayload, context, cursorSigningKey())}`;
}

function decodeCursor(value: string, context: CursorContext) {
  if (value.length > 512) return undefined;
  const parts = value.split(".");
  if (parts.length !== 2) return undefined;
  const [encodedPayload, suppliedSignature] = parts;
  if (
    encodedPayload === undefined ||
    suppliedSignature === undefined ||
    !encodedCursorPartPattern.test(encodedPayload) ||
    !cursorSignaturePattern.test(suppliedSignature)
  ) {
    return undefined;
  }

  let payloadBytes: Buffer;
  let suppliedSignatureBytes: Buffer;
  try {
    payloadBytes = Buffer.from(encodedPayload, "base64url");
    suppliedSignatureBytes = Buffer.from(suppliedSignature, "base64url");
    if (
      payloadBytes.toString("base64url") !== encodedPayload ||
      suppliedSignatureBytes.toString("base64url") !== suppliedSignature
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const expectedSignatureBytes = Buffer.from(
    cursorSignature(encodedPayload, context, cursorSigningKey()),
    "base64url",
  );
  if (
    suppliedSignatureBytes.length !== expectedSignatureBytes.length ||
    !timingSafeEqual(suppliedSignatureBytes, expectedSignatureBytes)
  ) {
    return undefined;
  }

  try {
    return JSON.parse(payloadBytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function encodeBackofficeUserCursor(input: {
  authSessionId: string;
  createdAt: string;
  id: string;
  query: string | null;
  scope: string;
}) {
  const payload = userCursorPayloadSchema.parse({
    createdAt: input.createdAt,
    id: input.id,
    kind: "users",
    version: 1,
  });
  return encodeCursor(payload, {
    authSessionId: input.authSessionId,
    filter: input.query,
    kind: "users",
    scope: input.scope,
  });
}

export function decodeBackofficeUserCursor(input: {
  authSessionId: string;
  query: string | null;
  scope: string;
  value: string;
}) {
  const decoded = decodeCursor(input.value, {
    authSessionId: input.authSessionId,
    filter: input.query,
    kind: "users",
    scope: input.scope,
  });
  const parsed = userCursorPayloadSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

export function encodeBackofficeStudioReviewCursor(input: {
  authSessionId: string;
  scope: string;
  sequence: number;
  studioId: string;
}) {
  const payload = studioReviewCursorPayloadSchema.parse({
    kind: "studio-reviews",
    sequence: input.sequence,
    studioId: input.studioId,
    version: 1,
  });
  return encodeCursor(payload, {
    authSessionId: input.authSessionId,
    filter: null,
    kind: "studio-reviews",
    scope: input.scope,
  });
}

export function decodeBackofficeStudioReviewCursor(input: {
  authSessionId: string;
  scope: string;
  value: string;
}) {
  const decoded = decodeCursor(input.value, {
    authSessionId: input.authSessionId,
    filter: null,
    kind: "studio-reviews",
    scope: input.scope,
  });
  const parsed = studioReviewCursorPayloadSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}
