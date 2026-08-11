import { stringToBase64URL } from "@supabase/ssr";
import type * as SupabaseSsr from "@supabase/ssr";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type CookieToSet = Readonly<{
  name: string;
  options: Readonly<Record<string, unknown>>;
  value: string;
}>;

const mocks = vi.hoisted(() => ({
  authPresentAtSignOut: vi.fn(),
  closeIdentityRecoverySession: vi.fn(),
  createServerClient: vi.fn(),
  forwardGetAll: vi.fn(),
  forwardSetAll: vi.fn(),
  getClaims: vi.fn(),
  getSession: vi.fn(),
  inspectIdentityRecoverySession: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@supabase/ssr", async (importOriginal) => ({
  ...(await importOriginal<typeof SupabaseSsr>()),
  createServerClient: mocks.createServerClient,
}));

vi.mock("@/lib/supabase/config", () => ({
  readSupabaseEnvironment: () => ({
    anonKey: "public-anon-key",
    cookieOptions: { httpOnly: true, path: "/", sameSite: "lax", secure: false },
    supabaseOrigin: "http://127.0.0.1:54321",
  }),
}));

vi.mock("../../src/domains/identity/server/identity-dal", () => ({
  closeIdentityRecoverySession: mocks.closeIdentityRecoverySession,
  inspectIdentityRecoverySession: mocks.inspectIdentityRecoverySession,
}));

import { proxy } from "../../src/proxy";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const recoveryToken = "33333333-3333-4333-8333-333333333333";
const recoveryScope = "44444444-4444-4444-8444-444444444444";
const sessionCookie = `base64-${stringToBase64URL(
  JSON.stringify({ access_token: "opaque-access-token", refresh_token: "opaque-refresh" }),
)}`;

function requestFor(pathname: string, auxiliaryCookies: string) {
  return new NextRequest(`http://127.0.0.1:3000${pathname}`, {
    headers: {
      cookie: `${auxiliaryCookies}; sb-127-auth-token=${sessionCookie}`,
    },
  });
}

describe("proxy recovery session fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerClient.mockImplementation(
      (
        _origin: string,
        _key: string,
        options: {
          cookies: {
            getAll: () => readonly { name: string; value: string }[];
            setAll: (
              cookies: readonly CookieToSet[],
              headers: Readonly<Record<string, string>>,
            ) => void;
          };
        },
      ) => {
        mocks.forwardGetAll.mockImplementation(options.cookies.getAll);
        mocks.forwardSetAll.mockImplementation(options.cookies.setAll);
        return {
          auth: {
            getClaims: mocks.getClaims,
            getSession: mocks.getSession,
            signOut: mocks.signOut,
          },
        };
      },
    );
    mocks.getClaims.mockResolvedValue({
      data: {
        claims: {
          exp: 4_102_444_800,
          session_id: sessionId,
          sub: userId,
        },
      },
      error: null,
    });
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mocks.signOut.mockImplementation(async () => {
      const cookies = mocks.forwardGetAll();
      mocks.authPresentAtSignOut(
        Array.isArray(cookies) && cookies.some((cookie) => cookie.name === "sb-127-auth-token"),
      );
      return { error: null };
    });
    mocks.closeIdentityRecoverySession.mockResolvedValue(true);
    mocks.inspectIdentityRecoverySession.mockResolvedValue({
      active: true,
      grantAllowed: true,
      sessionScope: recoveryScope,
    });
  });

  it("closes a proven recovery binding before /entrar can use it as ordinary Auth", async () => {
    const response = await proxy(
      requestFor(
        "/entrar",
        `sl-recovery-session=${recoveryScope}; sl-recovery-grant=${recoveryToken}`,
      ),
    );

    expect(mocks.getClaims).toHaveBeenCalledWith("opaque-access-token");
    expect(mocks.closeIdentityRecoverySession).toHaveBeenCalledWith({
      authSessionId: sessionId,
      userId,
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.authPresentAtSignOut).toHaveBeenCalledWith(true);
    expect(response.cookies.get("sl-recovery-session")?.value).toBe("");
    expect(response.cookies.get("sl-recovery-grant")?.value).toBe("");
    expect(response.cookies.get("sb-127-auth-token")?.value).toBe("");
  });

  it("keeps a valid binding anonymous and alive on the session read endpoint", async () => {
    const response = await proxy(
      requestFor(
        "/api/auth/session",
        `sl-recovery-session=${recoveryScope}; sl-recovery-grant=${recoveryToken}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.getClaims).toHaveBeenCalledWith("opaque-access-token");
    expect(mocks.closeIdentityRecoverySession).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("preserves refreshed ordinary Auth cookies while removing a stale auxiliary grant", async () => {
    mocks.inspectIdentityRecoverySession.mockResolvedValueOnce(undefined);
    mocks.getClaims.mockImplementationOnce(async () => {
      mocks.forwardSetAll(
        [
          {
            name: "sb-127-auth-token",
            options: { httpOnly: true, path: "/", sameSite: "lax" },
            value: "refreshed-ordinary-session",
          },
        ],
        { "x-supabase-refresh": "preserved" },
      );
      return {
        data: {
          claims: {
            exp: 4_102_444_800,
            session_id: sessionId,
            sub: userId,
          },
        },
        error: null,
      };
    });

    const response = await proxy(requestFor("/entrar", `sl-recovery-grant=${recoveryToken}`));

    expect(mocks.getClaims).toHaveBeenCalledWith(undefined);
    expect(response.cookies.get("sb-127-auth-token")?.value).toBe("refreshed-ordinary-session");
    expect(response.cookies.get("sl-recovery-grant")?.value).toBe("");
    expect(response.headers.get("x-supabase-refresh")).toBe("preserved");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("fails closed on DAL drift without allowing a marker to sign out ordinary Auth", async () => {
    mocks.inspectIdentityRecoverySession.mockRejectedValueOnce(new Error("private-binding-drift"));

    const response = await proxy(
      requestFor(
        "/entrar",
        `sl-recovery-session=${recoveryScope}; sl-recovery-grant=${recoveryToken}`,
      ),
    );

    expect(response.status).toBe(500);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.closeIdentityRecoverySession).not.toHaveBeenCalled();
    expect(response.cookies.get("sl-recovery-session")?.value).toBe("");
    expect(response.cookies.get("sb-127-auth-token")).toBeUndefined();
  });

  it("keeps exact cookie cleanup but returns 500 when sign-out cannot be proven", async () => {
    mocks.signOut.mockImplementationOnce(async () => {
      const cookies = mocks.forwardGetAll();
      mocks.authPresentAtSignOut(
        Array.isArray(cookies) && cookies.some((cookie) => cookie.name === "sb-127-auth-token"),
      );
      throw new Error("private-signout-failure");
    });
    mocks.getSession.mockResolvedValueOnce({
      data: { session: { access_token: "still-present" } },
      error: null,
    });

    const response = await proxy(
      requestFor(
        "/entrar",
        `sl-recovery-session=${recoveryScope}; sl-recovery-grant=${recoveryToken}`,
      ),
    );

    expect(response.status).toBe(500);
    expect(mocks.authPresentAtSignOut).toHaveBeenCalledWith(true);
    expect(response.cookies.get("sl-recovery-session")?.value).toBe("");
    expect(response.cookies.get("sl-recovery-grant")?.value).toBe("");
    expect(response.cookies.get("sb-127-auth-token")?.value).toBe("");
  });
});
