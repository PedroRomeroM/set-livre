import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readOwnerRecipient: vi.fn(),
  readRouteIdentitySession: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/owners/server/owner-read-model", () => ({
  readOwnerRecipient: mocks.readOwnerRecipient,
}));

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "11111111-1111-4111-8111-111111111111";
const result = { scope: userId };

function ownerRequest() {
  return new Request("http://127.0.0.1:3000/api/owner/recipient", {
    headers: { "x-request-id": requestId },
  });
}

describe("owner recipient read route", () => {
  beforeEach(() => {
    process.env.APP_ENV = "test";
    vi.clearAllMocks();
    mocks.readRouteIdentitySession.mockResolvedValue({
      client: {},
      responseHeaders: new Headers({ "x-owner-session": "refreshed" }),
      session: {
        authenticated: true,
        email: "owner@example.test",
        personType: "individual",
        profileCompleted: true,
        status: "active",
        userId,
      },
    });
    mocks.readOwnerRecipient.mockResolvedValue(result);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("returns the authenticated projection with refreshed session headers", async () => {
    const { GET } = await import("../../src/app/api/owner/recipient/route");
    const response = await GET(ownerRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-owner-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({ data: result, requestId });
    expect(mocks.readOwnerRecipient).toHaveBeenCalledWith(userId);
  });

  it("rejects guests before reading owner data", async () => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: {},
      responseHeaders: new Headers({ "x-owner-session": "guest-refreshed" }),
      session: { authenticated: false },
    });
    const { GET } = await import("../../src/app/api/owner/recipient/route");
    const response = await GET(ownerRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get("x-owner-session")).toBe("guest-refreshed");
    expect(mocks.readOwnerRecipient).not.toHaveBeenCalled();
  });

  it("preserves refreshed session headers when the owner read fails", async () => {
    mocks.readOwnerRecipient.mockRejectedValueOnce(new Error("private provider reference"));
    const { GET } = await import("../../src/app/api/owner/recipient/route");
    const response = await GET(ownerRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("x-owner-session")).toBe("refreshed");
    expect(JSON.stringify(await response.json())).not.toContain("provider reference");
  });

  it("fails safely when production refuses a local fixture read", async () => {
    process.env.APP_ENV = "production";
    mocks.readOwnerRecipient.mockRejectedValueOnce(
      new Error("O contrato local do dono é proibido fora de local/test. # corpo privado"),
    );
    const { GET } = await import("../../src/app/api/owner/recipient/route");
    const response = await GET(ownerRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("x-owner-session")).toBe("refreshed");
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain("corpo privado");
    expect(serialized).not.toContain("local/test");
  });
});
