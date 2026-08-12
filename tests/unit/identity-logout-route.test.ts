import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  logoutIdentity: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-service", () => ({
  logoutIdentity: mocks.logoutIdentity,
}));

const expectedScope = "11111111-1111-4111-8111-111111111111";

function logoutRequest(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/auth/logout", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
    },
    method: "POST",
  });
}

describe("identity logout route composition", () => {
  beforeEach(async () => {
    process.env.APP_ENV = "test";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3000";
    mocks.logoutIdentity.mockReset();
    mocks.logoutIdentity.mockResolvedValue({ data: { signedOut: true } });
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes only the strict expected scope to the logout service", async () => {
    const { POST } = await import("../../src/app/api/auth/logout/route");
    const response = await POST(logoutRequest({ expectedScope }));

    expect(response.status).toBe(200);
    expect(mocks.logoutIdentity).toHaveBeenCalledOnce();
    expect(mocks.logoutIdentity).toHaveBeenCalledWith(expectedScope);
  });

  it.each([
    ["missing", {}],
    ["invalid", { expectedScope: "anonymous" }],
    ["extra", { expectedScope, userId: expectedScope }],
  ])("rejects a %s scope envelope before logout side effects", async (_case, body) => {
    const { POST } = await import("../../src/app/api/auth/logout/route");
    const response = await POST(logoutRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INPUT_INVALID" } });
    expect(mocks.logoutIdentity).not.toHaveBeenCalled();
  });
});
