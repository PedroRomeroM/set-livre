import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  claimIdentityRecoveryGrant: vi.fn(),
  consumeIdentityRecoveryGrant: vi.fn(),
  cookieDelete: vi.fn(),
  cookieGet: vi.fn(),
  createRouteSupabaseClient: vi.fn(),
  getClaims: vi.fn(),
  getSession: vi.fn(),
  readIdentitySessionWithClient: vi.fn(),
  releaseIdentityRecoveryGrant: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  setSession: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  transientSignOut: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@/lib/server/api-route", () => ({
  ApiRouteError: class ApiRouteError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  hashPrivateRateLimitValue: () => "private-discriminator",
}));

vi.mock("@/lib/server/rate-limit", () => ({
  enforceIdentityRateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/config", () => ({
  readSupabaseEnvironment: () => ({ appOrigin: "http://127.0.0.1:3000" }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAnonymousSupabaseClient: () => ({
    auth: {
      resetPasswordForEmail: mocks.resetPasswordForEmail,
      signInWithPassword: mocks.signInWithPassword,
      signOut: mocks.transientSignOut,
    },
  }),
  createRouteSupabaseClient: mocks.createRouteSupabaseClient,
}));

vi.mock("../../src/domains/identity/server/identity-dal", () => ({
  claimIdentityRecoveryGrant: mocks.claimIdentityRecoveryGrant,
  consumeIdentityRecoveryGrant: mocks.consumeIdentityRecoveryGrant,
  createSignupLegalIntent: vi.fn(),
  hasIdentityRecoveryGrant: vi.fn(),
  issueIdentityRecoveryGrant: vi.fn(),
  releaseIdentityRecoveryGrant: mocks.releaseIdentityRecoveryGrant,
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readIdentitySessionWithClient: mocks.readIdentitySessionWithClient,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ delete: mocks.cookieDelete, get: mocks.cookieGet }),
}));

import {
  loginIdentity,
  logoutIdentity,
  requestIdentityRecovery,
  updateRecoveredIdentityPassword,
} from "../../src/domains/identity/server/identity-service";

const recoveryToken = "22222222-2222-4222-8222-222222222222";
const recoveryUserId = "11111111-1111-4111-8111-111111111111";
const authenticatedSession = {
  authenticated: true as const,
  email: "qa-login@example.test",
  personType: "individual" as const,
  profileCompleted: false,
  status: "active" as const,
  userId: recoveryUserId,
};
const providerSession = {
  access_token: "opaque-access-token",
  refresh_token: "opaque-refresh-token",
};

describe("identity recovery service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieGet.mockReturnValue({ value: recoveryToken });
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: recoveryUserId } }, error: null });
    mocks.claimIdentityRecoveryGrant.mockResolvedValue(true);
    mocks.releaseIdentityRecoveryGrant.mockResolvedValue(true);
    mocks.consumeIdentityRecoveryGrant.mockResolvedValue(true);
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mocks.transientSignOut.mockResolvedValue({ error: null });
    mocks.signInWithPassword.mockResolvedValue({
      data: { session: providerSession, user: { id: recoveryUserId } },
      error: null,
    });
    mocks.readIdentitySessionWithClient.mockResolvedValue(authenticatedSession);
    mocks.setSession.mockResolvedValue({ data: { session: providerSession }, error: null });
    mocks.createRouteSupabaseClient.mockResolvedValue({
      client: {
        auth: {
          getClaims: mocks.getClaims,
          getSession: mocks.getSession,
          setSession: mocks.setSession,
          signOut: mocks.signOut,
          updateUser: mocks.updateUser,
        },
      },
      responseHeaders: new Headers(),
    });
  });

  it("validates the identity context before publishing browser session cookies", async () => {
    const result = await loginIdentity({
      email: "qa-login@example.test",
      password: "ValidPassword9",
    });

    expect(mocks.readIdentitySessionWithClient).toHaveBeenCalledOnce();
    expect(mocks.createRouteSupabaseClient).toHaveBeenCalledOnce();
    expect(mocks.setSession).toHaveBeenCalledWith(providerSession);
    expect(result.data).toEqual({
      redirectTo: "/entrar?sessao=ativa",
      session: authenticatedSession,
    });
  });

  it("does not publish cookies when identity context validation fails", async () => {
    mocks.readIdentitySessionWithClient.mockRejectedValueOnce(
      new Error("private-read-model-failure"),
    );

    await expect(
      loginIdentity({
        email: "qa-login@example.test",
        password: "ValidPassword9",
      }),
    ).rejects.toThrow("private-read-model-failure");

    expect(mocks.transientSignOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.createRouteSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it("fails closed and clears local sessions when cookie publication is ambiguous", async () => {
    mocks.setSession.mockRejectedValueOnce(new Error("private-cookie-publication-failure"));

    await expect(
      loginIdentity({
        email: "qa-login@example.test",
        password: "ValidPassword9",
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });

    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.transientSignOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("accepts an errored provider logout only after proving the local session is absent", async () => {
    mocks.signOut.mockResolvedValueOnce({ error: { code: "provider_unavailable" } });

    await expect(logoutIdentity()).resolves.toMatchObject({ data: { signedOut: true } });

    expect(mocks.getSession).toHaveBeenCalledOnce();
  });

  it("keeps logout fail-closed when a provider error leaves the local session present", async () => {
    mocks.signOut.mockResolvedValueOnce({ error: { code: "provider_unavailable" } });
    mocks.getSession.mockResolvedValueOnce({
      data: { session: providerSession },
      error: null,
    });

    await expect(logoutIdentity()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("keeps the public recovery result indistinguishable when the provider throws", async () => {
    mocks.resetPasswordForEmail.mockRejectedValueOnce(
      new Error("provider-private-transport-failure"),
    );

    const result = await requestIdentityRecovery("qa-recovery-throw@example.test");

    expect(result).toEqual({
      data: { accepted: true },
      operationalOutcome: "unavailable",
    });
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith("qa-recovery-throw@example.test", {
      redirectTo: "http://127.0.0.1:3000/auth/callback",
    });
    expect(JSON.stringify(result)).not.toContain("provider-private-transport-failure");
  });

  it("keeps an ambiguous password update claim terminal", async () => {
    mocks.updateUser.mockRejectedValueOnce(new Error("ambiguous-provider-outcome"));

    await expect(updateRecoveredIdentityPassword("NewPassword9A")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });

    expect(mocks.claimIdentityRecoveryGrant).toHaveBeenCalledOnce();
    expect(mocks.releaseIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.consumeIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("keeps an ambiguous update terminal when the recovery session cannot be removed", async () => {
    mocks.updateUser.mockRejectedValueOnce(new Error("ambiguous-provider-outcome"));
    mocks.signOut.mockRejectedValueOnce(new Error("ambiguous-signout-outcome"));
    mocks.getSession.mockResolvedValueOnce({ data: { session: providerSession }, error: null });

    await expect(updateRecoveredIdentityPassword("NewPassword9A")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });

    expect(mocks.releaseIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.consumeIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
  });

  it("releases a grant only after a provider rejection with no password effect", async () => {
    mocks.updateUser.mockResolvedValueOnce({ error: { code: "weak_password" } });

    await expect(updateRecoveredIdentityPassword("WeakPassword9")).rejects.toMatchObject({
      code: "INPUT_INVALID",
      status: 400,
    });

    expect(mocks.releaseIdentityRecoveryGrant).toHaveBeenCalledOnce();
    expect(mocks.consumeIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it("closes the recovery session when a retry-safe rejection cannot release its grant", async () => {
    mocks.updateUser.mockResolvedValueOnce({ error: { code: "weak_password" } });
    mocks.releaseIdentityRecoveryGrant.mockResolvedValueOnce(false);

    await expect(updateRecoveredIdentityPassword("WeakPassword9")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });

    expect(mocks.consumeIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("finishes a consumed recovery when sign-out throws after removing the local session", async () => {
    mocks.updateUser.mockResolvedValueOnce({ error: null });
    mocks.signOut.mockRejectedValueOnce(new Error("provider-signout-transport-failure"));

    await expect(updateRecoveredIdentityPassword("NewPassword9A")).resolves.toMatchObject({
      data: { updated: true },
    });

    expect(mocks.consumeIdentityRecoveryGrant).toHaveBeenCalledOnce();
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
  });

  it("fails closed when consumed recovery cannot prove the local session was removed", async () => {
    mocks.updateUser.mockResolvedValueOnce({ error: null });
    mocks.signOut.mockRejectedValueOnce(new Error("provider-signout-transport-failure"));
    mocks.getSession.mockResolvedValueOnce({ data: { session: providerSession }, error: null });

    await expect(updateRecoveredIdentityPassword("NewPassword9A")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });

    expect(mocks.consumeIdentityRecoveryGrant).toHaveBeenCalledOnce();
    expect(mocks.releaseIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
  });
});
