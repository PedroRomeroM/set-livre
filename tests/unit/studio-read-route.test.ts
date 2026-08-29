import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readOwnerActivation: vi.fn(),
  readOwnerStudioEditor: vi.fn(),
  readRouteIdentitySession: vi.fn(),
}));

class MockStudioNotFoundError extends Error {}

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/owners/server/owner-read-model", () => ({
  readOwnerActivation: mocks.readOwnerActivation,
}));

vi.mock("../../src/domains/studios/server/studio-read-model", () => ({
  readOwnerStudioEditor: mocks.readOwnerStudioEditor,
  StudioNotFoundError: MockStudioNotFoundError,
}));

import { studioEditorFixture, studioTestIds } from "./studio-test-fixture";

function request() {
  return new Request(`http://127.0.0.1:3000/api/owner/studios/${studioTestIds.studioId}`, {
    headers: { "x-request-id": studioTestIds.requestId },
  });
}

describe("studio read route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readRouteIdentitySession.mockResolvedValue({
      client: {},
      responseHeaders: new Headers({ "x-studio-session": "refreshed" }),
      session: {
        authenticated: true,
        email: "owner@example.test",
        personType: "individual",
        profileCompleted: true,
        status: "active",
        userId: studioTestIds.userId,
      },
    });
    mocks.readOwnerActivation.mockResolvedValue({
      ownerContractAccepted: true,
      ownerStatus: "active",
    });
    mocks.readOwnerStudioEditor.mockResolvedValue(studioEditorFixture);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("rejects an invalid identifier as not-found before querying", async () => {
    const { GET } = await import("../../src/app/api/owner/studios/[studioId]/route");
    const response = await GET(request(), { params: Promise.resolve({ studioId: "not-a-uuid" }) });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-studio-session")).toBe("refreshed");
    expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();
  });

  it("returns the same safe not-found result for an inaccessible studio", async () => {
    mocks.readOwnerStudioEditor.mockRejectedValueOnce(new MockStudioNotFoundError());
    const { GET } = await import("../../src/app/api/owner/studios/[studioId]/route");
    const response = await GET(request(), {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledWith(
      studioTestIds.userId,
      studioTestIds.studioId,
    );
  });

  it.each([
    ["suspended account", { status: "suspended" }, "ACCOUNT_SUSPENDED", 403],
    ["incomplete profile", { profileCompleted: false }, "FORBIDDEN", 403],
  ] as const)(
    "revalidates a %s before reading private studio data",
    async (_scenario, sessionOverride, code, status) => {
      const current = await mocks.readRouteIdentitySession();
      mocks.readRouteIdentitySession.mockResolvedValueOnce({
        ...current,
        session: { ...current.session, ...sessionOverride },
      });
      const { GET } = await import("../../src/app/api/owner/studios/[studioId]/route");
      const response = await GET(request(), {
        params: Promise.resolve({ studioId: studioTestIds.studioId }),
      });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
      expect(mocks.readOwnerActivation).not.toHaveBeenCalled();
      expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["inactive owner", { ownerStatus: "inactive" }, "FORBIDDEN", 403],
    ["blocked owner", { ownerStatus: "blocked" }, "FORBIDDEN", 403],
    ["superseded contract", { ownerContractAccepted: false }, "OWNER_CONTRACT_CHANGED", 409],
  ] as const)(
    "revalidates an %s before reading private studio data",
    async (_scenario, ownerOverride, code, status) => {
      mocks.readOwnerActivation.mockResolvedValueOnce({
        ownerContractAccepted: true,
        ownerStatus: "active",
        ...ownerOverride,
      });
      const { GET } = await import("../../src/app/api/owner/studios/[studioId]/route");
      const response = await GET(request(), {
        params: Promise.resolve({ studioId: studioTestIds.studioId }),
      });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
      expect(mocks.readOwnerActivation).toHaveBeenCalledWith(studioTestIds.userId);
      expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();
    },
  );
});
