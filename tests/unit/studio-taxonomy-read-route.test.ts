import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readActiveStudioTaxonomies: vi.fn(),
  readRouteIdentitySession: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/studios/server/studio-read-model", () => ({
  readActiveStudioTaxonomies: mocks.readActiveStudioTaxonomies,
}));

import { studioTestIds } from "./studio-test-fixture";

const taxonomies = {
  amenities: [{ id: studioTestIds.amenityId, name: "Wi-Fi", sortOrder: 10 }],
  tags: [{ id: studioTestIds.tagId, name: "Podcast", sortOrder: 10 }],
};

describe("studio taxonomy read route", () => {
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
    mocks.readActiveStudioTaxonomies.mockResolvedValue(taxonomies);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("returns only the authenticated active projection", async () => {
    const { GET } = await import("../../src/app/api/studio-taxonomies/route");
    const response = await GET(
      new Request("http://127.0.0.1:3000/api/studio-taxonomies", {
        headers: { "x-request-id": studioTestIds.requestId },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-studio-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({ data: taxonomies });
  });

  it("rejects before querying when the session is absent", async () => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: {},
      responseHeaders: new Headers(),
      session: { authenticated: false },
    });
    const { GET } = await import("../../src/app/api/studio-taxonomies/route");
    const response = await GET(new Request("http://127.0.0.1:3000/api/studio-taxonomies"));
    expect(response.status).toBe(401);
    expect(mocks.readActiveStudioTaxonomies).not.toHaveBeenCalled();
  });
});
