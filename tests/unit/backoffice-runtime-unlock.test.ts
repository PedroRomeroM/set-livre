import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  backofficeRuntimeUnlockDurationMs,
  createBackofficeRuntimeUnlockToken,
  validateBackofficeRuntimeUnlockToken,
} from "../../apps/backoffice/src/domains/backoffice/server/runtime-unlock-token";

const key = "A".repeat(43);
const now = Date.UTC(2026, 7, 30, 12, 0, 0);
const identity = {
  authSessionId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
};

describe("backoffice runtime unlock token", () => {
  it("fails as unavailable before reading cookies when the runtime key is missing", () => {
    const source = readFileSync(
      resolve(process.cwd(), "apps/backoffice/src/domains/backoffice/server/runtime-unlock.ts"),
      "utf8",
    );
    const guardStart = source.indexOf("export async function requireBackofficeRuntimeUnlock");
    const keyRequirement = source.indexOf("requiredRuntimeUnlockKey(environment)", guardStart);
    const cookieRead = source.indexOf("(await cookies()).get", guardStart);

    expect(source).toContain('503,\n      "RUNTIME_UNLOCK_UNAVAILABLE"');
    expect(guardStart).toBeGreaterThan(-1);
    expect(keyRequirement).toBeGreaterThan(guardStart);
    expect(cookieRead).toBeGreaterThan(keyRequirement);
  });

  it("binds a short-lived token to the current user and auth session", () => {
    const unlock = createBackofficeRuntimeUnlockToken({ identity, key, now });

    expect(unlock.expiresAt).toBe(now + backofficeRuntimeUnlockDurationMs);
    expect(
      validateBackofficeRuntimeUnlockToken({ identity, key, now: now + 1, token: unlock.token }),
    ).toBe(unlock.expiresAt);
    expect(
      validateBackofficeRuntimeUnlockToken({
        identity: { ...identity, userId: "10000000-0000-4000-8000-000000000003" },
        key,
        now: now + 1,
        token: unlock.token,
      }),
    ).toBeUndefined();
    expect(
      validateBackofficeRuntimeUnlockToken({
        identity: {
          ...identity,
          authSessionId: "10000000-0000-4000-8000-000000000004",
        },
        key,
        now: now + 1,
        token: unlock.token,
      }),
    ).toBeUndefined();
  });

  it("rejects a wrong key, tampering, malformed encoding and expiration", () => {
    const unlock = createBackofficeRuntimeUnlockToken({ identity, key, now });
    const tampered = `${unlock.token.slice(0, -1)}${unlock.token.endsWith("A") ? "B" : "A"}`;

    expect(
      validateBackofficeRuntimeUnlockToken({
        identity,
        key: "B".repeat(43),
        now: now + 1,
        token: unlock.token,
      }),
    ).toBeUndefined();
    expect(
      validateBackofficeRuntimeUnlockToken({ identity, key, now: now + 1, token: tampered }),
    ).toBeUndefined();
    expect(
      validateBackofficeRuntimeUnlockToken({ identity, key, now: now + 1, token: "%%%...." }),
    ).toBeUndefined();
    expect(
      validateBackofficeRuntimeUnlockToken({
        identity,
        key,
        now: unlock.expiresAt,
        token: unlock.token,
      }),
    ).toBeUndefined();
  });
});
