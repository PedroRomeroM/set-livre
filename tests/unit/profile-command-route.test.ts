import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  executeIdentityCommand: vi.fn(),
  readRouteIdentitySession: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-command-registry", () => ({
  executeIdentityCommand: mocks.executeIdentityCommand,
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

const userId = "11111111-1111-4111-8111-111111111111";

function commandRequest(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/commands", {
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
    mocks.executeIdentityCommand.mockResolvedValue({ scope: userId });
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("authenticates a private action before strict payload parsing", async () => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: {},
      responseHeaders: new Headers(),
      session: { authenticated: false },
    });
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(commandRequest({ action: "profile.update", payload: {} }));
    expect(response.status).toBe(401);
    expect(mocks.readRouteIdentitySession).toHaveBeenCalledOnce();
    expect(mocks.executeIdentityCommand).not.toHaveBeenCalled();
  });

  it("does not create an authenticated session dependency for guest registration", async () => {
    mocks.executeIdentityCommand.mockResolvedValueOnce({ confirmationRequired: true });
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
    expect(response.status).toBe(202);
    expect(mocks.readRouteIdentitySession).not.toHaveBeenCalled();
  });

  it("passes only the server session to an authenticated profile command", async () => {
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "profile.update",
        payload: {
          colorScheme: "dark",
          expectedPreferencesVersion: 0,
          section: "appearance",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.executeIdentityCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: "profile.update" }),
      expect.objectContaining({ session: expect.objectContaining({ userId }) }),
    );
  });

  it("returns the profile validation contract after authenticating", async () => {
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({ action: "profile.complete", payload: { status: "active" } }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    expect(mocks.readRouteIdentitySession).toHaveBeenCalledOnce();
    expect(mocks.executeIdentityCommand).not.toHaveBeenCalled();
  });

  it("maps nested document validation to stable form field names", async () => {
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "profile.update",
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
    expect(mocks.executeIdentityCommand).not.toHaveBeenCalled();
  });
});
