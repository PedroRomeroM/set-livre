import { ownerStudioEditorExpectedScopeHeader } from "@set-livre/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readOwnerStudioEditor: vi.fn(),
  readRouteIdentitySession: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/studios/server/studio-read-model", () => ({
  readOwnerStudioEditor: mocks.readOwnerStudioEditor,
}));

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "44444444-4444-4444-8444-444444444444";
const studioId = "22222222-2222-4222-8222-222222222222";
const studioTypeId = "33333333-3333-4333-8333-333333333333";
const createResult = {
  mode: "create",
  projection: "studio_editor",
  scope: userId,
  studio: null,
  studioTypes: [{ id: studioTypeId, name: "Fotografia" }],
} as const;

function studioRequest(query = "", expectedScope: string | null = userId) {
  const headers = new Headers({ "x-request-id": requestId });
  if (expectedScope !== null) headers.set(ownerStudioEditorExpectedScopeHeader, expectedScope);
  return new Request(`http://127.0.0.1:3000/api/owner/studio-editor${query}`, {
    headers,
  });
}

describe("studio editor read route", () => {
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
        userId,
      },
    });
    mocks.readOwnerStudioEditor.mockResolvedValue(createResult);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("returns create mode with refreshed session headers and an abortable read", async () => {
    const request = studioRequest();
    const { GET } = await import("../../src/app/api/owner/studio-editor/route");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-studio-session")).toBe("refreshed");
    await expect(response.json()).resolves.toEqual({ data: createResult, requestId });
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledWith(userId, undefined, request.signal);
  });

  it("passes one strict studio UUID and emits only safe studio telemetry", async () => {
    const events: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      events.push(String(chunk));
      return true;
    });
    const request = studioRequest(`?studioId=${studioId}`);
    const { GET } = await import("../../src/app/api/owner/studio-editor/route");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.readOwnerStudioEditor).toHaveBeenCalledWith(userId, studioId, request.signal);
    const serializedEvents = events.join("");
    expect(serializedEvents).toContain('"event":"studio.request"');
    expect(serializedEvents).toContain('"action":"studio.read"');
    expect(serializedEvents).toContain(`"requestId":"${requestId}"`);
    expect(serializedEvents).not.toContain(studioId);
    expect(serializedEvents).not.toContain(userId);
  });

  it.each([
    "?studioId=invalid",
    `?studioId=${studioId}&studioId=${studioId}`,
    "?unexpected=value",
    "?studioId=",
  ])("rejects strict query drift with 422: %s", async (query) => {
    const { GET } = await import("../../src/app/api/owner/studio-editor/route");
    const response = await GET(studioRequest(query));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", requestId },
    });
    expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["invalid", "not-a-uuid"],
  ] as const)(
    "rejects an active session with a %s expected scope before query parsing",
    async (_case, expectedScope) => {
      const { GET } = await import("../../src/app/api/owner/studio-editor/route");
      const response = await GET(studioRequest("?studioId=private-invalid-value", expectedScope));

      expect(response.status).toBe(422);
      expect(response.headers.get("x-studio-session")).toBe("refreshed");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED", requestId },
      });
      expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();
    },
  );

  it("rejects a changed session scope before query parsing or a private read", async () => {
    const { GET } = await import("../../src/app/api/owner/studio-editor/route");
    const response = await GET(studioRequest("?studioId=private-invalid-value", otherUserId));

    expect(response.status).toBe(409);
    expect(response.headers.get("x-studio-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "SESSION_CHANGED",
        message: "Sua sessão mudou. Recarregue a página antes de continuar.",
        requestId,
      },
    });
    expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();
  });

  it("rejects a guest before validating or reading private studio data", async () => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: {},
      responseHeaders: new Headers({ "x-studio-session": "guest-refreshed" }),
      session: { authenticated: false },
    });
    const { GET } = await import("../../src/app/api/owner/studio-editor/route");
    const response = await GET(studioRequest("?studioId=private-invalid-value", null));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-studio-session")).toBe("guest-refreshed");
    expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();
  });

  it("rejects a suspended account before validating or reading private studio data", async () => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: {},
      responseHeaders: new Headers({ "x-studio-session": "suspended-refreshed" }),
      session: {
        authenticated: true,
        email: "owner@example.test",
        personType: "individual",
        profileCompleted: true,
        status: "suspended",
        userId,
      },
    });
    const { GET } = await import("../../src/app/api/owner/studio-editor/route");
    const response = await GET(studioRequest("?studioId=private-invalid-value", null));

    expect(response.status).toBe(403);
    expect(response.headers.get("x-studio-session")).toBe("suspended-refreshed");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ACCOUNT_SUSPENDED", requestId },
    });
    expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();
  });

  it("rejects an incomplete profile before validating or reading private studio data", async () => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: {},
      responseHeaders: new Headers({ "x-studio-session": "incomplete-refreshed" }),
      session: {
        authenticated: true,
        email: "owner@example.test",
        personType: "individual",
        profileCompleted: false,
        status: "active",
        userId,
      },
    });
    const { GET } = await import("../../src/app/api/owner/studio-editor/route");
    const response = await GET(studioRequest("?studioId=private-invalid-value", null));

    expect(response.status).toBe(403);
    expect(response.headers.get("x-studio-session")).toBe("incomplete-refreshed");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN", requestId },
    });
    expect(mocks.readOwnerStudioEditor).not.toHaveBeenCalled();
  });

  it("preserves a uniform NOT_FOUND and refreshed session headers", async () => {
    const { ApiRouteError } = await import("../../src/lib/server/api-route");
    mocks.readOwnerStudioEditor.mockRejectedValueOnce(
      new ApiRouteError(404, "NOT_FOUND", "O estúdio não foi encontrado."),
    );
    const { GET } = await import("../../src/app/api/owner/studio-editor/route");
    const response = await GET(studioRequest(`?studioId=${studioId}`));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-studio-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND", requestId },
    });
  });
});
