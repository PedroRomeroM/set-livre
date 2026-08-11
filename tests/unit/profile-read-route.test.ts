import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  cookieStore: {},
  readOwnProfile: vi.fn(),
  readRouteIdentitySession: vi.fn(),
  writeProfilePreferenceCookie: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => mocks.cookieStore }));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/identity/server/profile-read-model", () => ({
  readOwnProfile: mocks.readOwnProfile,
}));

vi.mock("../../src/domains/identity/server/profile-preference-cookie", () => ({
  writeProfilePreferenceCookie: mocks.writeProfilePreferenceCookie,
}));

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "11111111-1111-4111-8111-111111111111";
const safeProfile = {
  profile: {
    additionalDocumentMasked: "***-9",
    colorScheme: "dark",
    completed: true,
    name: "Pessoa Exemplo",
    personType: "individual",
    phone: "+5541999991234",
    preferencesVersion: 2,
    profileVersion: 3,
    status: "active",
    taxIdMasked: "***.***.***-25",
  },
  scope: userId,
};

function profileRequest() {
  return new Request("http://127.0.0.1:3000/api/account/profile", {
    headers: { "x-request-id": requestId },
  });
}

describe("profile read route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readRouteIdentitySession.mockResolvedValue({
      client: {},
      responseHeaders: new Headers({ "x-profile-session": "refreshed" }),
      session: {
        authenticated: true,
        email: "qa-profile@example.test",
        personType: "individual",
        profileCompleted: true,
        status: "active",
        userId,
      },
    });
    mocks.readOwnProfile.mockResolvedValue(safeProfile);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("returns only the authenticated user's masked profile and propagates session headers", async () => {
    const { GET } = await import("../../src/app/api/account/profile/route");
    const response = await GET(profileRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("x-profile-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({ data: safeProfile, requestId });
    expect(mocks.readOwnProfile).toHaveBeenCalledWith(userId);
    expect(mocks.writeProfilePreferenceCookie).toHaveBeenCalledWith(mocks.cookieStore, "dark");
    expect(JSON.stringify(await mocks.readOwnProfile.mock.results[0]?.value)).not.toContain(
      "52998224725",
    );
  });

  it("rejects guests before reading any profile row", async () => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: {},
      responseHeaders: new Headers(),
      session: { authenticated: false },
    });
    const { GET } = await import("../../src/app/api/account/profile/route");
    const response = await GET(profileRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHENTICATED", requestId },
    });
    expect(mocks.readOwnProfile).not.toHaveBeenCalled();
  });

  it("keeps cookie projection failures non-authoritative", async () => {
    mocks.writeProfilePreferenceCookie.mockImplementationOnce(() => {
      throw new Error("private cookie detail");
    });
    const { GET } = await import("../../src/app/api/account/profile/route");
    const response = await GET(profileRequest());

    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("private cookie detail");
  });
});
