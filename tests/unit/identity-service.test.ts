import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  claimIdentityRecoveryGrant: vi.fn(),
  consumeIdentityRecoveryGrant: vi.fn(),
  cookieDelete: vi.fn(),
  cookieGet: vi.fn(),
  cookieGetAll: vi.fn(),
  cookieSet: vi.fn(),
  createRouteSupabaseClient: vi.fn(),
  getClaims: vi.fn(),
  getSession: vi.fn(),
  issueIdentityRecoveryGrant: vi.fn(),
  readIdentitySessionWithClient: vi.fn(),
  releaseIdentityRecoveryGrant: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  setSession: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  transientSignOut: vi.fn(),
  updateUser: vi.fn(),
  verifyOtp: vi.fn(),
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
  readSupabaseEnvironment: () => ({
    appOrigin: "http://127.0.0.1:3000",
    cookieOptions: { httpOnly: true, path: "/", sameSite: "lax", secure: false },
    supabaseOrigin: "http://127.0.0.1:54321",
  }),
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
  issueIdentityRecoveryGrant: mocks.issueIdentityRecoveryGrant,
  releaseIdentityRecoveryGrant: mocks.releaseIdentityRecoveryGrant,
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readIdentitySessionWithClient: mocks.readIdentitySessionWithClient,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    delete: mocks.cookieDelete,
    get: mocks.cookieGet,
    getAll: mocks.cookieGetAll,
    set: mocks.cookieSet,
  }),
}));

import {
  loginIdentity,
  logoutIdentity,
  requestIdentityRecovery,
  updateRecoveredIdentityPassword,
  verifyIdentityCallback,
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
    mocks.cookieDelete.mockImplementation(() => undefined);
    mocks.cookieGet.mockReturnValue({ value: recoveryToken });
    mocks.cookieGetAll.mockReturnValue([
      { name: "sb-127-auth-token", value: "opaque-session" },
      { name: "sb-127-auth-token.0", value: "opaque-session-chunk-zero" },
      { name: "sb-127-auth-token.1", value: "opaque-session-chunk-one" },
      { name: "sb-127-auth-token.backup", value: "preserve" },
      { name: "unrelated-cookie", value: "preserve" },
    ]);
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
    mocks.verifyOtp.mockResolvedValue({
      data: { session: providerSession, user: { id: recoveryUserId } },
      error: null,
    });
    mocks.createRouteSupabaseClient.mockResolvedValue({
      client: {
        auth: {
          getClaims: mocks.getClaims,
          getSession: mocks.getSession,
          setSession: mocks.setSession,
          signOut: mocks.signOut,
          updateUser: mocks.updateUser,
          verifyOtp: mocks.verifyOtp,
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

  it("clears partially published login cookies without masking setSession when sign-out fails", async () => {
    mocks.setSession.mockRejectedValueOnce(new Error("private-cookie-publication-failure"));
    mocks.signOut.mockRejectedValueOnce(new Error("private-login-signout-failure"));
    mocks.getSession.mockResolvedValueOnce({ data: { session: providerSession }, error: null });
    mocks.cookieDelete.mockImplementation((name: string) => {
      if (name === "sb-127-auth-token") {
        throw new Error("private-login-cookie-cleanup-failure");
      }
    });

    const outcome = loginIdentity({
      email: "qa-login@example.test",
      password: "ValidPassword9",
    }).catch((error: unknown) => error);

    await expect(outcome).resolves.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.transientSignOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.1");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token.backup");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    const serializedOutcome = JSON.stringify(await outcome);
    expect(serializedOutcome).not.toContain("private-cookie-publication-failure");
    expect(serializedOutcome).not.toContain("private-login-signout-failure");
    expect(serializedOutcome).not.toContain("private-login-cookie-cleanup-failure");
  });

  it("preserves the login publication error when exact cookie enumeration also fails", async () => {
    mocks.setSession.mockRejectedValueOnce(new Error("private-cookie-publication-failure"));
    mocks.signOut.mockRejectedValueOnce(new Error("private-login-signout-failure"));
    mocks.getSession.mockResolvedValueOnce({ data: { session: providerSession }, error: null });
    mocks.cookieGetAll.mockImplementationOnce(() => {
      throw new Error("private-login-cookie-enumeration-failure");
    });

    const outcome = loginIdentity({
      email: "qa-login@example.test",
      password: "ValidPassword9",
    }).catch((error: unknown) => error);

    await expect(outcome).resolves.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.transientSignOut).toHaveBeenCalledWith({ scope: "local" });
    const serializedOutcome = JSON.stringify(await outcome);
    expect(serializedOutcome).not.toContain("private-cookie-publication-failure");
    expect(serializedOutcome).not.toContain("private-login-signout-failure");
    expect(serializedOutcome).not.toContain("private-login-cookie-enumeration-failure");
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

  it("makes a retryable provider failure terminal after recovery OTP verification starts", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: {
        message: "private-retryable-provider-failure",
        name: "AuthRetryableFetchError",
        status: 0,
      },
    });

    const outcome = verifyIdentityCallback({
      tokenHash: "opaque-recovery-token-hash",
      type: "recovery",
    }).catch((error: unknown) => error);

    await expect(outcome).resolves.toMatchObject({
      code: "RECOVERY_RESTART_REQUIRED",
      message: "Não foi possível preparar a recuperação agora. Solicite um novo link.",
      status: 503,
    });
    expect(mocks.issueIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(JSON.stringify(await outcome)).not.toContain("private-retryable-provider-failure");
  });

  it("makes an ambiguous signup provider result terminal after OTP verification starts", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: {
        message: "private-signup-provider-failure",
        name: "AuthRetryableFetchError",
        status: 0,
      },
    });

    const outcome = verifyIdentityCallback({
      tokenHash: "opaque-signup-token-hash",
      type: "signup",
    }).catch((error: unknown) => error);

    await expect(outcome).resolves.toMatchObject({
      code: "AUTH_RESTART_REQUIRED",
      message:
        "Não foi possível confirmar o cadastro com segurança. Solicite um novo link de confirmação.",
      status: 503,
    });
    expect(mocks.verifyOtp).toHaveBeenCalledOnce();
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.1");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token.backup");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(JSON.stringify(await outcome)).not.toContain("private-signup-provider-failure");
  });

  it("makes a thrown signup cookie publication outcome terminal and redacted", async () => {
    mocks.verifyOtp.mockRejectedValueOnce(new Error("private-signup-cookie-publication-failure"));

    const outcome = verifyIdentityCallback({
      tokenHash: "opaque-signup-token-hash",
      type: "signup",
    }).catch((error: unknown) => error);

    await expect(outcome).resolves.toMatchObject({
      code: "AUTH_RESTART_REQUIRED",
      status: 503,
    });
    expect(mocks.verifyOtp).toHaveBeenCalledOnce();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.1");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token.backup");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    const serializedOutcome = JSON.stringify(await outcome);
    expect(serializedOutcome).not.toContain("opaque-signup-token-hash");
    expect(serializedOutcome).not.toContain("private-signup-cookie-publication-failure");
  });

  it("preserves a proven signup OTP rejection without ambiguous session cleanup", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { code: "otp_expired", message: "private-signup-expired-token-detail" },
    });

    const outcome = verifyIdentityCallback({
      tokenHash: "opaque-signup-token-hash",
      type: "signup",
    }).catch((error: unknown) => error);

    await expect(outcome).resolves.toMatchObject({
      code: "AUTH_INVALID",
      message: "Este link é inválido ou expirou. Solicite um novo link.",
      status: 400,
    });
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(JSON.stringify(await outcome)).not.toContain("private-signup-expired-token-detail");
  });

  it("preserves an explicit expired-OTP rejection without ambiguous cleanup", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { code: "otp_expired", message: "private-expired-token-detail" },
    });

    await expect(
      verifyIdentityCallback({
        tokenHash: "opaque-recovery-token-hash",
        type: "recovery",
      }),
    ).rejects.toMatchObject({
      code: "RECOVERY_INVALID",
      message: "Este link é inválido ou expirou. Solicite um novo link.",
      status: 400,
    });
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("cleans a recovery session when verifyOtp throws during cookie publication", async () => {
    mocks.verifyOtp.mockRejectedValueOnce(new Error("private-auth-cookie-publication-failure"));

    const outcome = verifyIdentityCallback({
      tokenHash: "opaque-recovery-token-hash",
      type: "recovery",
    }).catch((error: unknown) => error);

    await expect(outcome).resolves.toMatchObject({
      code: "RECOVERY_RESTART_REQUIRED",
      message: "Não foi possível preparar a recuperação agora. Solicite um novo link.",
      status: 503,
    });
    expect(mocks.issueIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(JSON.stringify(await outcome)).not.toContain("private-auth-cookie-publication-failure");
  });

  it("continues deleting exact auth chunks when one cookie deletion fails", async () => {
    mocks.verifyOtp.mockRejectedValueOnce(new Error("private-auth-cookie-publication-failure"));
    mocks.cookieGetAll.mockReturnValueOnce([
      { name: "sb-127-auth-token.0", value: "opaque-session-chunk-zero" },
      { name: "sb-127-auth-token.1", value: "opaque-session-chunk-one" },
      { name: "sb-127-auth-token.backup", value: "preserve" },
      { name: "unrelated-cookie", value: "preserve" },
    ]);
    mocks.cookieDelete.mockImplementation((name: string) => {
      if (name === "sl-recovery-grant" || name === "sb-127-auth-token.0") {
        throw new Error("private-cookie-delete-failure");
      }
    });

    await expect(
      verifyIdentityCallback({
        tokenHash: "opaque-recovery-token-hash",
        type: "recovery",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_RESTART_REQUIRED", status: 503 });

    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.1");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token.backup");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("makes a recovery callback terminal after OTP verification when grant issue fails", async () => {
    mocks.issueIdentityRecoveryGrant.mockRejectedValueOnce(
      new Error("private-recovery-grant-failure"),
    );

    await expect(
      verifyIdentityCallback({
        tokenHash: "opaque-recovery-token-hash",
        type: "recovery",
      }),
    ).rejects.toMatchObject({
      code: "RECOVERY_RESTART_REQUIRED",
      message: "Não foi possível preparar a recuperação agora. Solicite um novo link.",
      status: 503,
    });

    expect(mocks.verifyOtp).toHaveBeenCalledOnce();
    expect(mocks.issueIdentityRecoveryGrant).toHaveBeenCalledWith(recoveryUserId);
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("keeps the verified recovery terminal when local sign-out cannot be proven", async () => {
    mocks.issueIdentityRecoveryGrant.mockRejectedValueOnce(
      new Error("private-recovery-grant-failure"),
    );
    mocks.signOut.mockRejectedValueOnce(new Error("private-signout-failure"));
    mocks.getSession.mockResolvedValueOnce({ data: { session: providerSession }, error: null });

    const outcome = verifyIdentityCallback({
      tokenHash: "opaque-recovery-token-hash",
      type: "recovery",
    }).catch((error: unknown) => error);

    await expect(outcome).resolves.toMatchObject({
      code: "RECOVERY_RESTART_REQUIRED",
      status: 503,
    });
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    expect(JSON.stringify(await outcome)).not.toContain("private-signout-failure");
  });

  it("revokes an issued recovery grant when its cookie cannot be published", async () => {
    mocks.issueIdentityRecoveryGrant.mockResolvedValueOnce(recoveryToken);
    mocks.cookieSet.mockImplementationOnce(() => {
      throw new Error("private-cookie-publication-failure");
    });

    await expect(
      verifyIdentityCallback({
        tokenHash: "opaque-recovery-token-hash",
        type: "recovery",
      }),
    ).rejects.toMatchObject({
      code: "RECOVERY_RESTART_REQUIRED",
      status: 503,
    });

    expect(mocks.claimIdentityRecoveryGrant).toHaveBeenCalledWith({
      attemptId: expect.any(String),
      token: recoveryToken,
      userId: recoveryUserId,
    });
    expect(mocks.consumeIdentityRecoveryGrant).toHaveBeenCalledWith({
      attemptId: expect.any(String),
      token: recoveryToken,
      userId: recoveryUserId,
    });
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
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

    const outcome = updateRecoveredIdentityPassword("NewPassword9A").catch(
      (error: unknown) => error,
    );

    await expect(outcome).resolves.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });

    expect(mocks.releaseIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.consumeIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.1");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token.backup");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    const serializedOutcome = JSON.stringify(await outcome);
    expect(serializedOutcome).not.toContain("ambiguous-provider-outcome");
    expect(serializedOutcome).not.toContain("ambiguous-signout-outcome");
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
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.1");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token.backup");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
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
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.1");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token.backup");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
  });

  it("fails closed when consumed recovery cannot prove the local session was removed", async () => {
    mocks.updateUser.mockResolvedValueOnce({ error: null });
    mocks.signOut.mockRejectedValueOnce(new Error("provider-signout-transport-failure"));
    mocks.getSession.mockResolvedValueOnce({ data: { session: providerSession }, error: null });
    mocks.cookieDelete.mockImplementation((name: string) => {
      if (name === "sb-127-auth-token") {
        throw new Error("private-final-cookie-cleanup-failure");
      }
    });

    const outcome = updateRecoveredIdentityPassword("NewPassword9A").catch(
      (error: unknown) => error,
    );

    await expect(outcome).resolves.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });

    expect(mocks.consumeIdentityRecoveryGrant).toHaveBeenCalledOnce();
    expect(mocks.releaseIdentityRecoveryGrant).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sl-recovery-grant");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.0");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("sb-127-auth-token.1");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("sb-127-auth-token.backup");
    expect(mocks.cookieDelete).not.toHaveBeenCalledWith("unrelated-cookie");
    const serializedOutcome = JSON.stringify(await outcome);
    expect(serializedOutcome).not.toContain("provider-signout-transport-failure");
    expect(serializedOutcome).not.toContain("private-final-cookie-cleanup-failure");
  });
});
