import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  registerIdentity: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-service", () => ({
  registerIdentity: mocks.registerIdentity,
}));

vi.mock("../../src/domains/identity/server/profile-service", () => ({
  completeProfile: vi.fn(),
  updateProfile: vi.fn(),
}));

const validRegistration = {
  action: "identity.register",
  payload: {
    acceptPrivacy: true,
    acceptTerms: true,
    email: "qa-register-route@example.test",
    password: "ValidPassword9",
    personType: "individual",
    privacyVersionId: "22222222-2222-4222-8222-222222222222",
    termsVersionId: "33333333-3333-4333-8333-333333333333",
  },
} as const;

function registrationRequest(body: string, headers: Readonly<Record<string, string>> = {}) {
  return new Request("http://127.0.0.1:3000/api/auth/register", {
    body,
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      ...headers,
    },
    method: "POST",
  });
}

describe("public identity registration route composition", () => {
  beforeEach(async () => {
    process.env.APP_ENV = "test";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3000";
    mocks.registerIdentity.mockReset();
    mocks.registerIdentity.mockResolvedValue({ confirmationRequired: true });
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a hostile Origin before consuming or executing registration", async () => {
    const request = registrationRequest("not-json", {
      origin: "https://attacker.example",
    });
    const { POST } = await import("../../src/app/api/auth/register/route");

    const response = await POST(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ORIGIN_INVALID" },
    });
    expect(request.bodyUsed).toBe(false);
    expect(mocks.registerIdentity).not.toHaveBeenCalled();
  });

  it("rejects an invalid content type before consuming or executing registration", async () => {
    const request = registrationRequest(JSON.stringify(validRegistration), {
      "content-type": "text/plain",
    });
    const { POST } = await import("../../src/app/api/auth/register/route");

    const response = await POST(request);

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CONTENT_TYPE_INVALID" },
    });
    expect(request.bodyUsed).toBe(false);
    expect(mocks.registerIdentity).not.toHaveBeenCalled();
  });

  it("rejects an announced oversized body before consuming or executing registration", async () => {
    const request = registrationRequest(JSON.stringify(validRegistration), {
      "content-length": String(16 * 1024 + 1),
    });
    const { POST } = await import("../../src/app/api/auth/register/route");

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BODY_TOO_LARGE" },
    });
    expect(request.bodyUsed).toBe(false);
    expect(mocks.registerIdentity).not.toHaveBeenCalled();
  });

  it("enforces the streaming limit despite an understated Content-Length", async () => {
    const request = registrationRequest(
      JSON.stringify({ ...validRegistration, padding: "x".repeat(17 * 1024) }),
      { "content-length": "10" },
    );
    const { POST } = await import("../../src/app/api/auth/register/route");

    const response = await POST(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BODY_TOO_LARGE" },
    });
    expect(request.bodyUsed).toBe(true);
    expect(mocks.registerIdentity).not.toHaveBeenCalled();
  });

  it("rejects an exhausted facade bucket before consuming or executing registration", async () => {
    const request = registrationRequest(JSON.stringify(validRegistration));
    const { requestRateLimitDiscriminator } = await import("../../src/lib/server/api-route");
    const { enforceIdentityRateLimit } = await import("../../src/lib/server/rate-limit");
    const discriminator = requestRateLimitDiscriminator(request);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      enforceIdentityRateLimit("identity.register.request", discriminator, {
        limit: 300,
        windowMs: 60_000,
      });
    }
    const { POST } = await import("../../src/app/api/auth/register/route");

    const response = await POST(request);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
    expect(request.bodyUsed).toBe(false);
    expect(mocks.registerIdentity).not.toHaveBeenCalled();
  });
});
