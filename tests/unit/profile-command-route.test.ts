import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  completeProfile: vi.fn(),
  readRouteIdentitySession: vi.fn(),
  registerIdentity: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-service", () => ({
  registerIdentity: mocks.registerIdentity,
}));

vi.mock("../../src/domains/identity/server/profile-service", () => ({
  completeProfile: mocks.completeProfile,
  updateProfile: mocks.updateProfile,
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const appearancePayload = {
  colorScheme: "dark",
  expectedPreferencesVersion: 0,
  section: "appearance",
} as const;
const completionPayload = {
  additionalDocument: null,
  expectedProfileVersion: 0,
  name: "Pessoa Exemplo",
  personType: "individual",
  phone: "+5541999991234",
  taxId: "52998224725",
} as const;

function commandRequest(body: unknown, path = "/api/commands") {
  return new Request(`http://127.0.0.1:3000${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
    },
    method: "POST",
  });
}

describe("profile command route", () => {
  beforeEach(async () => {
    process.env.APP_ENV = "test";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3000";
    vi.clearAllMocks();
    mocks.readRouteIdentitySession.mockResolvedValue({
      client: {},
      responseHeaders: new Headers(),
      session: {
        authenticated: true,
        email: "qa-profile@example.test",
        personType: "individual",
        profileCompleted: false,
        status: "active",
        userId,
      },
    });
    mocks.completeProfile.mockResolvedValue({ scope: userId });
    mocks.registerIdentity.mockResolvedValue({ confirmationRequired: true });
    mocks.updateProfile.mockResolvedValue({ scope: userId });
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it.each([
    ["private action", { action: "profile.update", payload: {} }],
    ["unknown action", { action: "admin.user.suspend", payload: {} }],
    [
      "registration action on the private route",
      { action: "identity.register", payload: { unexpected: true } },
    ],
  ])(
    "rejects an unauthenticated %s without consuming or validating its body",
    async (_case, body) => {
      mocks.readRouteIdentitySession.mockResolvedValueOnce({
        client: {},
        responseHeaders: new Headers(),
        session: { authenticated: false },
      });
      const request = commandRequest(body);
      const { POST } = await import("../../src/app/api/commands/route");
      const response = await POST(request);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "UNAUTHENTICATED" },
      });
      expect(request.bodyUsed).toBe(false);
      expect(mocks.readRouteIdentitySession).toHaveBeenCalledOnce();
      expect(mocks.completeProfile).not.toHaveBeenCalled();
      expect(mocks.registerIdentity).not.toHaveBeenCalled();
      expect(mocks.updateProfile).not.toHaveBeenCalled();
    },
  );

  it("does not create an authenticated session dependency for guest registration", async () => {
    const { POST } = await import("../../src/app/api/auth/register/route");
    const response = await POST(
      commandRequest(
        {
          action: "identity.register",
          payload: {
            acceptPrivacy: true,
            acceptTerms: true,
            email: "qa-register@example.test",
            password: "ValidPassword9",
            personType: "individual",
            privacyVersionId: "22222222-2222-4222-8222-222222222222",
            termsVersionId: "33333333-3333-4333-8333-333333333333",
          },
        },
        "/api/auth/register",
      ),
    );
    expect(response.status).toBe(202);
    expect(mocks.readRouteIdentitySession).not.toHaveBeenCalled();
    expect(mocks.registerIdentity).toHaveBeenCalledOnce();
  });

  it("keeps the public registration route strict and registration-only", async () => {
    const { POST } = await import("../../src/app/api/auth/register/route");
    const response = await POST(
      commandRequest(
        {
          action: "profile.update",
          expectedScope: userId,
          payload: appearancePayload,
        },
        "/api/auth/register",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INPUT_INVALID" },
    });
    expect(mocks.readRouteIdentitySession).not.toHaveBeenCalled();
    expect(mocks.registerIdentity).not.toHaveBeenCalled();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it("rejects registration on the authenticated private command route", async () => {
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "identity.register",
        payload: {
          acceptPrivacy: true,
          acceptTerms: true,
          email: "qa-register@example.test",
          password: "ValidPassword9",
          personType: "individual",
          privacyVersionId: "22222222-2222-4222-8222-222222222222",
          termsVersionId: "33333333-3333-4333-8333-333333333333",
        },
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    expect(mocks.readRouteIdentitySession).toHaveBeenCalledOnce();
    expect(mocks.registerIdentity).not.toHaveBeenCalled();
  });

  it("passes only the server session after matching the SSR scope assertion", async () => {
    const events: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      events.push(String(chunk));
      return true;
    });
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "profile.update",
        expectedScope: userId,
        payload: appearancePayload,
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.updateProfile).toHaveBeenCalledWith(
      appearancePayload,
      expect.objectContaining({ userId }),
    );
    expect(events.join("")).toContain('"event":"private.command"');
    expect(events.join("")).toContain('"action":"profile.update"');
    expect(events.join("")).not.toContain('"event":"owner.request"');
  });

  it.each([
    ["missing", { action: "profile.update", payload: appearancePayload }],
    [
      "extra",
      {
        action: "profile.update",
        expectedScope: userId,
        payload: appearancePayload,
        userId,
      },
    ],
  ])("rejects a %s profile scope envelope before the service", async (_case, command) => {
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(commandRequest(command));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    expect(mocks.completeProfile).not.toHaveBeenCalled();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["profile.complete", completionPayload],
    ["profile.update", appearancePayload],
  ] as const)(
    "fails closed for %s when scope A is submitted under authenticated session B",
    async (action, payload) => {
      const { POST } = await import("../../src/app/api/commands/route");
      const response = await POST(commandRequest({ action, expectedScope: otherUserId, payload }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "SESSION_CHANGED",
          message: "Sua sessão mudou. Recarregue a página antes de continuar.",
        },
      });
      expect(mocks.completeProfile).not.toHaveBeenCalled();
      expect(mocks.updateProfile).not.toHaveBeenCalled();
    },
  );

  it("returns the profile validation contract after authenticating", async () => {
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "profile.complete",
        expectedScope: userId,
        payload: { status: "active" },
      }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    expect(mocks.readRouteIdentitySession).toHaveBeenCalledOnce();
    expect(mocks.completeProfile).not.toHaveBeenCalled();
  });

  it("maps nested document validation to stable form field names", async () => {
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "profile.update",
        expectedScope: userId,
        payload: {
          documentChange: { action: "replace", value: "<>" },
          expectedProfileVersion: 1,
          name: "Pessoa Exemplo",
          phone: "+5541999991234",
          section: "identity",
          taxIdChange: { action: "replace", value: "11111111111" },
        },
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        fieldErrors: {
          additionalDocument: expect.any(String),
          taxId: expect.any(String),
        },
      },
    });
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });
});
