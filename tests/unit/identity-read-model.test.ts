import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  closeIdentityRecoverySession: vi.fn(),
  cookieDelete: vi.fn(),
  cookieGet: vi.fn(),
  cookieGetAll: vi.fn(),
  getClaims: vi.fn(),
  getSession: vi.fn(),
  inspectIdentityRecoverySession: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/supabase/config", () => ({
  readSupabaseEnvironment: () => ({ supabaseOrigin: "http://127.0.0.1:54321" }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAnonymousSupabaseClient: vi.fn(),
  createComponentSupabaseClient: async () => client,
  createRouteSupabaseClient: async () => ({ client, responseHeaders: new Headers() }),
}));

vi.mock("../../src/domains/identity/server/identity-dal", () => ({
  closeIdentityRecoverySession: mocks.closeIdentityRecoverySession,
  inspectIdentityRecoverySession: mocks.inspectIdentityRecoverySession,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    delete: mocks.cookieDelete,
    get: mocks.cookieGet,
    getAll: mocks.cookieGetAll,
  }),
}));

const client = {
  auth: {
    getClaims: mocks.getClaims,
    getSession: mocks.getSession,
    signOut: mocks.signOut,
  },
  rpc: mocks.rpc,
};

import {
  readComponentIdentitySession,
  readRouteIdentitySession,
} from "../../src/domains/identity/server/identity-read-model";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const recoveryToken = "33333333-3333-4333-8333-333333333333";
const recoveryScope = "44444444-4444-4444-8444-444444444444";
const expiresAtEpochSeconds = 4_102_444_800;

describe("identity recovery session read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieDelete.mockImplementation(() => undefined);
    mocks.cookieGet.mockImplementation((name: string) =>
      name === "sl-recovery-grant"
        ? { value: recoveryToken }
        : name === "sl-recovery-session"
          ? { value: recoveryScope }
          : undefined,
    );
    mocks.cookieGetAll.mockReturnValue([
      { name: "sb-127-auth-token", value: "opaque" },
      { name: "sb-127-auth-token.0", value: "opaque-chunk" },
      { name: "sb-127-auth-token.backup", value: "preserve" },
    ]);
    mocks.getClaims.mockResolvedValue({
      data: {
        claims: {
          email: "qa-session@example.test",
          exp: expiresAtEpochSeconds,
          session_id: sessionId,
          sub: userId,
        },
      },
      error: null,
    });
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.closeIdentityRecoverySession.mockResolvedValue(true);
    mocks.inspectIdentityRecoverySession.mockResolvedValue({
      active: true,
      grantAllowed: true,
      sessionScope: recoveryScope,
    });
    mocks.maybeSingle.mockResolvedValue({
      data: {
        is_complete: false,
        person_type: "individual",
        status: "active",
        user_id: userId,
      },
      error: null,
    });
    mocks.rpc.mockReturnValue({ maybeSingle: mocks.maybeSingle });
  });

  it("terminates even a valid recovery binding when /entrar reads the ordinary session", async () => {
    await expect(readComponentIdentitySession()).resolves.toEqual({ authenticated: false });

    expect(mocks.closeIdentityRecoverySession).toHaveBeenCalledWith({
      authSessionId: sessionId,
      userId,
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-session");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token.backup");
  });

  it("keeps a valid recovery alive but anonymous on /api/auth/session", async () => {
    await expect(readRouteIdentitySession()).resolves.toMatchObject({
      session: { authenticated: false },
    });

    expect(mocks.closeIdentityRecoverySession).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it("terminates a bound recovery when the grant is missing or expired", async () => {
    mocks.inspectIdentityRecoverySession.mockResolvedValueOnce({
      active: true,
      grantAllowed: false,
      sessionScope: recoveryScope,
    });

    await expect(readRouteIdentitySession()).resolves.toMatchObject({
      session: { authenticated: false },
    });

    expect(mocks.closeIdentityRecoverySession).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token");
  });

  it("preserves an ordinary session that only carries stale auxiliary cookies", async () => {
    mocks.inspectIdentityRecoverySession.mockResolvedValueOnce(undefined);

    await expect(readComponentIdentitySession()).resolves.toEqual({
      authenticated: true,
      email: "qa-session@example.test",
      personType: "individual",
      profileCompleted: false,
      status: "active",
      userId,
    });

    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-session");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.closeIdentityRecoverySession).not.toHaveBeenCalled();
  });

  it("fails closed on DAL drift without letting a stale marker sign out ordinary Auth", async () => {
    mocks.inspectIdentityRecoverySession.mockRejectedValueOnce(
      new Error("private-binding-shape-drift"),
    );

    await expect(readComponentIdentitySession()).rejects.toThrow("private-binding-shape-drift");

    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-session");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.closeIdentityRecoverySession).not.toHaveBeenCalled();
  });

  it("returns anonymous on claims failure without letting a stale marker delete Auth", async () => {
    mocks.getClaims.mockResolvedValueOnce({
      data: null,
      error: new Error("private-claims-failure"),
    });

    await expect(readComponentIdentitySession()).resolves.toEqual({ authenticated: false });

    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-session");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.inspectIdentityRecoverySession).not.toHaveBeenCalled();
  });
});
