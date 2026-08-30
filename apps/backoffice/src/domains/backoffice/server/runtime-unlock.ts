import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import {
  backofficeRuntimeUnlockPayloadSchema,
  backofficeRuntimeUnlockResultSchema,
} from "@set-livre/contracts";
import { cookies } from "next/headers";

import { BackofficeApiError } from "@/lib/server/api-route";

import type { BackofficeAuthContext } from "./auth-context";
import {
  backofficeRuntimeUnlockDurationMs,
  createBackofficeRuntimeUnlockToken,
  validateBackofficeRuntimeUnlockToken,
} from "./runtime-unlock-token";

const backofficeRuntimeUnlockCookieName = "set_livre_backoffice_runtime_unlock";

type RuntimeUnlockIdentity = Pick<BackofficeAuthContext, "authSessionId" | "userId">;

function optionalRuntimeUnlockKey(environment: NodeJS.ProcessEnv) {
  const parsed = backofficeRuntimeUnlockPayloadSchema.shape.key.safeParse(
    environment.BACKOFFICE_RUNTIME_UNLOCK_KEY,
  );
  return parsed.success ? parsed.data : undefined;
}

function requiredRuntimeUnlockKey(environment: NodeJS.ProcessEnv) {
  const key = optionalRuntimeUnlockKey(environment);
  if (key === undefined) {
    throw new BackofficeApiError(
      503,
      "RUNTIME_UNLOCK_UNAVAILABLE",
      "O desbloqueio local deste runtime não está configurado.",
    );
  }
  return key;
}

function constantTimeKeyMatches(expected: string, received: string) {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const receivedDigest = createHash("sha256").update(received, "utf8").digest();
  return timingSafeEqual(expectedDigest, receivedDigest);
}

function secureRuntimeCookie(environment: NodeJS.ProcessEnv) {
  try {
    return new URL(environment.NEXT_PUBLIC_APP_URL ?? "").protocol === "https:";
  } catch {
    return false;
  }
}

export async function readBackofficeRuntimeUnlockExpiration(
  identity: RuntimeUnlockIdentity,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const key = optionalRuntimeUnlockKey(environment);
  if (key === undefined) return null;
  const token = (await cookies()).get(backofficeRuntimeUnlockCookieName)?.value;
  if (token === undefined) return null;
  const expiresAt = validateBackofficeRuntimeUnlockToken({ identity, key, token });
  return expiresAt === undefined ? null : new Date(expiresAt).toISOString();
}

export async function unlockBackofficeRuntime(
  identity: RuntimeUnlockIdentity,
  payloadInput: unknown,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const payload = backofficeRuntimeUnlockPayloadSchema.parse(payloadInput);
  const key = requiredRuntimeUnlockKey(environment);
  if (!constantTimeKeyMatches(key, payload.key)) {
    throw new BackofficeApiError(
      403,
      "RUNTIME_UNLOCK_DENIED",
      "A chave local de desbloqueio é inválida.",
    );
  }
  const unlock = createBackofficeRuntimeUnlockToken({ identity, key });
  (await cookies()).set({
    httpOnly: true,
    maxAge: Math.floor(backofficeRuntimeUnlockDurationMs / 1_000),
    name: backofficeRuntimeUnlockCookieName,
    path: "/",
    sameSite: "strict",
    secure: secureRuntimeCookie(environment),
    value: unlock.token,
  });
  return backofficeRuntimeUnlockResultSchema.parse({
    expiresAt: new Date(unlock.expiresAt).toISOString(),
  });
}

export async function requireBackofficeRuntimeUnlock(
  identity: RuntimeUnlockIdentity,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const key = requiredRuntimeUnlockKey(environment);
  const token = (await cookies()).get(backofficeRuntimeUnlockCookieName)?.value;
  if (
    token !== undefined &&
    validateBackofficeRuntimeUnlockToken({ identity, key, token }) !== undefined
  ) {
    return;
  }
  throw new BackofficeApiError(
    423,
    "RUNTIME_LOCKED",
    "Desbloqueie operações com a chave local deste runtime antes de continuar.",
  );
}

export async function clearBackofficeRuntimeUnlock() {
  try {
    (await cookies()).delete(backofficeRuntimeUnlockCookieName);
  } catch {
    // Um token residual permanece inútil sem a mesma identidade + session_id Auth.
  }
}
