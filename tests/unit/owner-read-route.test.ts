import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readOwnerActivation: vi.fn(),
  readOwnerRecipient: vi.fn(),
  readRouteIdentitySession: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/owners/server/owner-read-model", () => ({
  readOwnerActivation: mocks.readOwnerActivation,
  readOwnerRecipient: mocks.readOwnerRecipient,
}));

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "11111111-1111-4111-8111-111111111111";
const result = {
  ownerContract: {
    effectiveAt: "2026-08-12T00:00:00.000Z",
    id: "33333333-3333-4333-8333-333333333333",
    source: "local_fixture",
  },
  projection: "recipient",
  recipientOnboardingCapability: "local_adapter",
  scope: userId,
};
const activationResult = {
  ...result,
  ownerContract: {
    ...result.ownerContract,
    bodyMarkdown: "# Contrato integral somente na ativação",
    contentHash: "a".repeat(64),
    kind: "owner_contract",
    title: "Contrato do dono",
    version: "local-1",
  },
  projection: "activation",
};

function ownerRequest() {
  return new Request("http://127.0.0.1:3000/api/owner/recipient", {
    headers: { "x-request-id": requestId },
  });
}

function ownerActivationRequest() {
  return new Request("http://127.0.0.1:3000/api/owner/activation", {
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
    mocks.readOwnerActivation.mockResolvedValue(activationResult);
    mocks.readOwnerRecipient.mockResolvedValue(result);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("returns the authenticated projection with refreshed session headers", async () => {
    const { GET } = await import("../../src/app/api/owner/recipient/route");
    const response = await GET(ownerRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-owner-session")).toBe("refreshed");
    const payload = await response.json();
    expect(payload).toMatchObject({ data: result, requestId });
    expect(payload.data.recipientOnboardingCapability).toBe("local_adapter");
    expect(JSON.stringify(payload)).not.toContain("bodyMarkdown");
    expect(JSON.stringify(payload)).not.toContain("Contrato integral");
    expect(mocks.readOwnerRecipient).toHaveBeenCalledWith(userId);
  });

  it("returns the complete legal document only from the authenticated activation route", async () => {
    const { GET } = await import("../../src/app/api/owner/activation/route");
    const response = await GET(ownerActivationRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: activationResult, requestId });
    expect(mocks.readOwnerActivation).toHaveBeenCalledWith(userId);
    expect(mocks.readOwnerRecipient).not.toHaveBeenCalled();
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
