import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readOwnerStudioEditor: vi.fn(),
  readRouteIdentitySession: vi.fn(),
}));

class MockStudioNotFoundError extends Error {}

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
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
});
