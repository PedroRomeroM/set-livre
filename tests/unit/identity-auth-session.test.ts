import { stringToBase64URL } from "@supabase/ssr";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  parseAuthSessionContext,
  readSupabaseAccessTokenFromCookies,
  supabaseAuthCookieNames,
} from "../../src/domains/identity/server/identity-auth-session";
import { recoverySessionCookieMaximumAgeSeconds } from "../../src/domains/identity/server/recovery-grant";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("identity Auth session boundary", () => {
  it("extracts an access token from the exact chunked Supabase cookie without refreshing", async () => {
    const serialized = `base64-${stringToBase64URL(
      JSON.stringify({ access_token: "opaque-access-token", refresh_token: "opaque-refresh" }),
    )}`;
    const splitAt = Math.floor(serialized.length / 2);
    const cookieStore = {
      getAll: () => [
        { name: "sb-127-auth-token.0", value: serialized.slice(0, splitAt) },
        { name: "sb-127-auth-token.1", value: serialized.slice(splitAt) },
        { name: "sb-127-auth-token.backup", value: "must-not-be-read" },
      ],
    };

    await expect(
      readSupabaseAccessTokenFromCookies(cookieStore, "http://127.0.0.1:54321"),
    ).resolves.toBe("opaque-access-token");
  });

  it("rejects malformed cookie storage instead of treating it as signed Auth", async () => {
    await expect(
      readSupabaseAccessTokenFromCookies(
        {
          getAll: () => [{ name: "sb-127-auth-token", value: "base64-invalid" }],
        },
        "http://127.0.0.1:54321",
      ),
    ).resolves.toBeUndefined();
  });

  it("enumerates only the exact Supabase Auth cookie and numeric chunks", () => {
    expect(
      supabaseAuthCookieNames(
        {
          getAll: () => [
            { name: "sb-127-auth-token" },
            { name: "sb-127-auth-token.0" },
            { name: "sb-127-auth-token.10" },
            { name: "sb-127-auth-token.01" },
            { name: "sb-127-auth-token.backup" },
            { name: "unrelated" },
          ],
        },
        "http://127.0.0.1:54321",
      ),
    ).toEqual(["sb-127-auth-token", "sb-127-auth-token.0", "sb-127-auth-token.10"]);
  });

  it("accepts only UUID session_id, UUID subject and an integer JWT expiration", () => {
    expect(
      parseAuthSessionContext({ exp: 4_102_444_800, session_id: sessionId, sub: userId }),
    ).toEqual({
      authExpiresAt: "2100-01-01T00:00:00.000Z",
      authExpiresAtEpochSeconds: 4_102_444_800,
      authSessionId: sessionId,
      userId,
    });
    expect(
      parseAuthSessionContext({ exp: 4_102_444_800, session_id: "invalid", sub: userId }),
    ).toBeUndefined();
    expect(
      parseAuthSessionContext({ exp: 4_102_444_800.5, session_id: sessionId, sub: userId }),
    ).toBeUndefined();
  });

  it("refuses to publish a recovery marker for an expired or invalid Auth exp", () => {
    expect(recoverySessionCookieMaximumAgeSeconds(2_000, 1_000)).toBe(1_300);
    expect(() => recoverySessionCookieMaximumAgeSeconds(1_000, 1_000)).toThrow(
      "expiração da sessão Auth de recovery é inválida",
    );
    expect(() => recoverySessionCookieMaximumAgeSeconds(Number.NaN, 1_000)).toThrow(
      "expiração da sessão Auth de recovery é inválida",
    );
  });
});
