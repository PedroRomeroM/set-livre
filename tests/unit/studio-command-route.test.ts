import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createStudio: vi.fn(),
  discardStudio: vi.fn(),
  readRouteIdentitySession: vi.fn(),
  updateStudioCore: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/studios/server/studio-service", () => ({
  createStudio: mocks.createStudio,
  discardStudio: mocks.discardStudio,
  updateStudioCore: mocks.updateStudioCore,
}));

import { studioCoreFixture, studioEditorFixture, studioTestIds } from "./studio-test-fixture";

function commandRequest(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/commands", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "x-request-id": studioTestIds.requestId,
    },
    method: "POST",
  });
}

describe("studio command route", () => {
  beforeEach(async () => {
    process.env.APP_ENV = "test";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3000";
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
    mocks.createStudio.mockResolvedValue(studioEditorFixture);
    mocks.updateStudioCore.mockResolvedValue(studioEditorFixture);
    mocks.discardStudio.mockResolvedValue({
      scope: studioTestIds.userId,
      studioDeleted: true,
      studioId: studioTestIds.studioId,
    });
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("authenticates before consuming a private studio body", async () => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: {},
      responseHeaders: new Headers(),
      session: { authenticated: false },
    });
    const request = commandRequest({ action: "studio.create", private: "untrusted" });
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.createStudio).not.toHaveBeenCalled();
  });

  it("dispatches create with authoritative context and redacted telemetry", async () => {
    const events: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      events.push(String(chunk));
      return true;
    });
    const command = {
      action: "studio.create",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: studioCoreFixture,
    } as const;
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(commandRequest(command));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-studio-session")).toBe("refreshed");
    expect(mocks.createStudio).toHaveBeenCalledWith(
      command,
      expect.objectContaining({
        requestId: studioTestIds.requestId,
        session: expect.objectContaining({ userId: studioTestIds.userId }),
      }),
    );
    const telemetry = events.join("");
    expect(telemetry).toContain('"action":"studio.create"');
    expect(telemetry).not.toContain(studioTestIds.idempotencyKey);
    expect(telemetry).not.toContain(studioCoreFixture.street);
  });

  it("accepts a valid maximum studio core encoded with multibyte characters", async () => {
    const command = {
      action: "studio.create",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: {
        ...studioCoreFixture,
        addressComplement: "界".repeat(120),
        description: "界".repeat(5_000),
        name: "界".repeat(120),
        neighborhood: "界".repeat(120),
        street: "界".repeat(160),
        streetNumber: "界".repeat(20),
      },
    } as const;
    const request = commandRequest(command);
    expect(new TextEncoder().encode(await request.clone().text()).byteLength).toBeGreaterThan(
      16 * 1024,
    );

    const { POST, privateCommandMaximumBytes } = await import("../../src/app/api/commands/route");
    expect(privateCommandMaximumBytes).toBe(32 * 1024);
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.createStudio).toHaveBeenCalledWith(command, expect.any(Object));
  });

  it("rejects a stale scope before the studio service", async () => {
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "studio.create",
        expectedScope: studioTestIds.otherUserId,
        idempotencyKey: studioTestIds.idempotencyKey,
        payload: studioCoreFixture,
      }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SESSION_CHANGED" } });
    expect(mocks.createStudio).not.toHaveBeenCalled();
  });

  it("rejects client-owned state and malformed optimistic tokens", async () => {
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "studio.revision.updateCore",
        expectedScope: studioTestIds.userId,
        idempotencyKey: studioTestIds.idempotencyKey,
        payload: {
          ...studioCoreFixture,
          expectedRevisionId: studioTestIds.revisionId,
          expectedRevisionVersion: 0,
          ownerUserId: studioTestIds.userId,
          status: "published",
          studioId: studioTestIds.studioId,
        },
      }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    expect(mocks.updateStudioCore).not.toHaveBeenCalled();
  });
});
