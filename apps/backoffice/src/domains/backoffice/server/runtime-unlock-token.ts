import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export const backofficeRuntimeUnlockDurationMs = 5 * 60_000;

const tokenPayloadSchema = z.strictObject({
  authSessionId: z.uuid(),
  expiresAt: z.number().int().positive().safe(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  scope: z.uuid(),
  version: z.literal(1),
});

type RuntimeUnlockIdentity = Readonly<{ authSessionId: string; userId: string }>;

function tokenSignature(payload: string, key: string) {
  return createHmac("sha256", key).update(payload, "ascii").digest("base64url");
}

export function createBackofficeRuntimeUnlockToken(input: {
  identity: RuntimeUnlockIdentity;
  key: string;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const payload = tokenPayloadSchema.parse({
    authSessionId: input.identity.authSessionId,
    expiresAt: now + backofficeRuntimeUnlockDurationMs,
    nonce: randomBytes(16).toString("base64url"),
    scope: input.identity.userId,
    version: 1,
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    expiresAt: payload.expiresAt,
    token: `${encodedPayload}.${tokenSignature(encodedPayload, input.key)}`,
  };
}

export function validateBackofficeRuntimeUnlockToken(input: {
  identity: RuntimeUnlockIdentity;
  key: string;
  now?: number;
  token: string;
}) {
  const parts = input.token.split(".");
  if (parts.length !== 2) return undefined;
  const [encodedPayload, suppliedSignature] = parts;
  if (
    encodedPayload === undefined ||
    suppliedSignature === undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(encodedPayload) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(suppliedSignature)
  ) {
    return undefined;
  }
  let suppliedSignatureBytes: Buffer;
  try {
    const payloadBytes = Buffer.from(encodedPayload, "base64url");
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
    tokenSignature(encodedPayload, input.key),
    "base64url",
  );
  if (
    suppliedSignatureBytes.length !== expectedSignatureBytes.length ||
    !timingSafeEqual(suppliedSignatureBytes, expectedSignatureBytes)
  ) {
    return undefined;
  }
  try {
    const payload = tokenPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown,
    );
    const now = input.now ?? Date.now();
    if (
      payload.scope !== input.identity.userId ||
      payload.authSessionId !== input.identity.authSessionId ||
      payload.expiresAt <= now ||
      payload.expiresAt > now + backofficeRuntimeUnlockDurationMs
    ) {
      return undefined;
    }
    return payload.expiresAt;
  } catch {
    return undefined;
  }
}
