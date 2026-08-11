import "server-only";

import {
  identityRecoverySessionScopeSchema,
  type IdentityRecoverySessionScope,
} from "@set-livre/contracts";
import { cookies } from "next/headers";

export const recoveryGrantCookieName = "sl-recovery-grant";
export const recoveryGrantMaximumAgeSeconds = 15 * 60;
export const recoverySessionCookieName = "sl-recovery-session";
const recoverySessionRetentionMarginSeconds = 5 * 60;

type RecoveryCookieReader = Readonly<{
  get: (name: string) => { value: string } | undefined;
}>;

export function recoverySessionScopeFromCookieStore(
  cookieStore: RecoveryCookieReader,
): IdentityRecoverySessionScope {
  const parsed = identityRecoverySessionScopeSchema.safeParse(
    cookieStore.get(recoverySessionCookieName)?.value,
  );
  return parsed.success ? parsed.data : "anonymous";
}

export async function readRecoverySessionScope(): Promise<IdentityRecoverySessionScope> {
  return recoverySessionScopeFromCookieStore(await cookies());
}

export function recoverySessionCookieMaximumAgeSeconds(
  authExpiresAtEpochSeconds: number,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
) {
  const remainingLifetime = authExpiresAtEpochSeconds - nowEpochSeconds;
  if (
    !Number.isSafeInteger(authExpiresAtEpochSeconds) ||
    !Number.isSafeInteger(nowEpochSeconds) ||
    remainingLifetime <= 0
  ) {
    throw new Error("A expiração da sessão Auth de recovery é inválida.");
  }
  return remainingLifetime + recoverySessionRetentionMarginSeconds;
}
