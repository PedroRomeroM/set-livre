import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readOwnerActivation: vi.fn(),
  readOwnerStudioMedia: vi.fn(),
  readRouteIdentitySession: vi.fn(),
}));

class MockStudioMediaNotFoundError extends Error {}
class MockStudioMediaStorageError extends Error {}

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/owners/server/owner-read-model", () => ({
  readOwnerActivation: mocks.readOwnerActivation,
}));

vi.mock("../../src/domains/studios/server/studio-media-read-model", () => ({
  readOwnerStudioMedia: mocks.readOwnerStudioMedia,
  StudioMediaNotFoundError: MockStudioMediaNotFoundError,
}));

vi.mock("../../src/domains/studios/server/studio-media-storage", () => ({
  StudioMediaStorageError: MockStudioMediaStorageError,
}));

import { studioTestIds } from "./studio-test-fixture";

const identityClient = { boundary: "authenticated-client" };
const gallery = {
  canEdit: true,
  items: [],
  previewExpiresAt: "2026-08-31T12:05:00.000Z",
  revisionId: studioTestIds.revisionId,
  revisionNumber: 1,
  revisionStatus: "draft" as const,
  revisionVersion: 3,
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
};

function request(studioId: string = studioTestIds.studioId) {
  return new Request(`http://127.0.0.1:3000/api/owner/studios/${studioId}/media`, {
    headers: { "x-request-id": studioTestIds.requestId },
  });
}

describe("studio media read route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readRouteIdentitySession.mockResolvedValue({
      client: identityClient,
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
    mocks.readOwnerStudioMedia.mockResolvedValue(gallery);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("returns an authenticated no-store gallery through the trusted server boundary", async () => {
    const currentRequest = request();
    const { GET } = await import("../../src/app/api/owner/studios/[studioId]/media/route");
    const response = await GET(currentRequest, {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-studio-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({ data: gallery });
    expect(mocks.readOwnerStudioMedia).toHaveBeenCalledWith(
      studioTestIds.userId,
      studioTestIds.studioId,
      currentRequest.signal,
    );
  });

  it("rejects an invalid identifier as safe not-found before private reads", async () => {
    const { GET } = await import("../../src/app/api/owner/studios/[studioId]/media/route");
    const response = await GET(request(), { params: Promise.resolve({ studioId: "invalid" }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(mocks.readOwnerActivation).not.toHaveBeenCalled();
    expect(mocks.readOwnerStudioMedia).not.toHaveBeenCalled();
  });

  it("normalizes an uppercase UUID before the private media read", async () => {
    const { GET } = await import("../../src/app/api/owner/studios/[studioId]/media/route");
    const response = await GET(request(studioTestIds.studioId.toUpperCase()), {
      params: Promise.resolve({ studioId: studioTestIds.studioId.toUpperCase() }),
    });

    expect(response.status).toBe(200);
    expect(mocks.readOwnerStudioMedia).toHaveBeenCalledWith(
      studioTestIds.userId,
      studioTestIds.studioId,
      expect.any(AbortSignal),
    );
  });

  it("keeps inaccessible studios indistinguishable and maps Storage outages safely", async () => {
    const { GET } = await import("../../src/app/api/owner/studios/[studioId]/media/route");
    mocks.readOwnerStudioMedia.mockRejectedValueOnce(new MockStudioMediaNotFoundError());
    const hidden = await GET(request(), {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });
    expect(hidden.status).toBe(404);
    await expect(hidden.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });

    mocks.readOwnerStudioMedia.mockRejectedValueOnce(new MockStudioMediaStorageError());
    const unavailable = await GET(request(), {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });

    mocks.readOwnerStudioMedia.mockRejectedValueOnce(
      new DOMException("A leitura expirou.", "AbortError"),
    );
    const timedOut = await GET(request(), {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });
    expect(timedOut.status).toBe(503);
    await expect(timedOut.json()).resolves.toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });
});
