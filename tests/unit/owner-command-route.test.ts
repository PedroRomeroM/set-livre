import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  activateOwner: vi.fn(),
  completeProfile: vi.fn(),
  createStudio: vi.fn(),
  discardStudioDraft: vi.fn(),
  readRouteIdentitySession: vi.fn(),
  refreshRecipientOnboarding: vi.fn(),
  startRecipientOnboarding: vi.fn(),
  updateStudioCore: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/profile-service", () => ({
  completeProfile: mocks.completeProfile,
  updateProfile: mocks.updateProfile,
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/owners/server/owner-service", () => ({
  activateOwner: mocks.activateOwner,
  refreshRecipientOnboarding: mocks.refreshRecipientOnboarding,
  startRecipientOnboarding: mocks.startRecipientOnboarding,
}));

vi.mock("../../src/domains/studios/server/studio-service", () => ({
  createStudio: mocks.createStudio,
  discardStudioDraft: mocks.discardStudioDraft,
  updateStudioCore: mocks.updateStudioCore,
}));

const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const contractId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const studioId = "66666666-6666-4666-8666-666666666666";
const studioTypeId = "77777777-7777-4777-8777-777777777777";
const privateUserAgent = "private-user-agent/provider-reference";

function commandRequest(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/commands", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "x-request-id": requestId,
      "user-agent": privateUserAgent,
    },
    method: "POST",
  });
}

describe("owner command route", () => {
  beforeEach(async () => {
    process.env.APP_ENV = "test";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3000";
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
    mocks.activateOwner.mockResolvedValue({ scope: userId });
    mocks.createStudio.mockResolvedValue({ scope: userId });
    mocks.startRecipientOnboarding.mockResolvedValue({ scope: userId });
    mocks.refreshRecipientOnboarding.mockResolvedValue({ scope: userId });
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
  });

  it("authenticates before consuming a private owner body", async () => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: {},
      responseHeaders: new Headers(),
      session: { authenticated: false },
    });
    const request = commandRequest({
      action: "owner.activate",
      expectedScope: userId,
      idempotencyKey,
      payload: { acceptOwnerContract: true, ownerContractVersionId: contractId },
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.activateOwner).not.toHaveBeenCalled();
  });

  it("rejects a stale SSR scope before the owner service", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "recipient.onboarding.start",
        expectedScope: otherUserId,
        idempotencyKey,
        payload: {},
      }),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("x-owner-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SESSION_CHANGED" } });
    expect(mocks.startRecipientOnboarding).not.toHaveBeenCalled();
  });

  it("preserves refreshed session headers on a safe service failure", async () => {
    mocks.refreshRecipientOnboarding.mockRejectedValueOnce(new Error("private provider payload"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "recipient.onboarding.refresh",
        expectedScope: userId,
        idempotencyKey,
        payload: {},
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("x-owner-session")).toBe("refreshed");
    expect(JSON.stringify(await response.json())).not.toContain("provider payload");
  });

  it("publishes an authoritative stale-transition conflict as 409", async () => {
    const { ApiRouteError } = await import("../../src/lib/server/api-route");
    mocks.startRecipientOnboarding.mockRejectedValueOnce(
      new ApiRouteError(
        409,
        "CONFLICT",
        "O cadastro foi atualizado por outra solicitação. Recarregue o estado atual.",
      ),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(
      commandRequest({
        action: "recipient.onboarding.start",
        expectedScope: userId,
        idempotencyKey,
        payload: {},
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("x-owner-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "CONFLICT" } });
  });

  it.each([
    ["missing key", { action: "recipient.onboarding.start", expectedScope: userId, payload: {} }],
    [
      "provider input",
      {
        action: "recipient.onboarding.refresh",
        expectedScope: userId,
        idempotencyKey,
        payload: { status: "active", providerReference: "private" },
      },
    ],
    [
      "owner authority input",
      {
        action: "owner.activate",
        expectedScope: userId,
        idempotencyKey,
        ownerUserId: userId,
        payload: { acceptOwnerContract: true, ownerContractVersionId: contractId },
      },
    ],
  ])("rejects strict contract drift: %s", async (_name, command) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(commandRequest(command));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(mocks.activateOwner).not.toHaveBeenCalled();
    expect(mocks.startRecipientOnboarding).not.toHaveBeenCalled();
    expect(mocks.refreshRecipientOnboarding).not.toHaveBeenCalled();
  });

  it("dispatches owner activation with authoritative context and a redacted owner event", async () => {
    const events: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      events.push(String(chunk));
      return true;
    });
    const command = {
      action: "owner.activate",
      expectedScope: userId,
      idempotencyKey,
      payload: { acceptOwnerContract: true, ownerContractVersionId: contractId },
    } as const;
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(commandRequest(command));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-owner-session")).toBe("refreshed");
    expect(mocks.activateOwner).toHaveBeenCalledWith(
      command,
      expect.objectContaining({
        requestId,
        session: expect.objectContaining({ userId }),
        userAgent: privateUserAgent,
      }),
    );
    const serializedEvents = events.join("");
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(serializedEvents).toContain(`"requestId":"${requestId}"`);
    expect(serializedEvents).toContain('"event":"private.command"');
    expect(serializedEvents).toContain('"action":"owner.activate"');
    expect(serializedEvents).not.toContain(idempotencyKey);
    expect(serializedEvents).not.toContain(contractId);
    expect(serializedEvents).not.toContain(privateUserAgent);
    expect(serializedEvents).not.toContain("provider-reference");
  });

  it("dispatches studio creation without logging its private editor payload", async () => {
    const events: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      events.push(String(chunk));
      return true;
    });
    const privateStudioName = "Estúdio QA privado para telemetria";
    const privateDescription =
      "Descrição sintética privada que não pode aparecer no evento operacional do comando.";
    const privateComplement = "Sala QA privada para telemetria";
    const privateNeighborhood = "Bairro QA privado para telemetria";
    const privatePostalCode = "80000000";
    const privateStreet = "Rua QA Privada da Telemetria";
    const privateStreetNumber = "QA-1200-privado";
    const command = {
      action: "studio.create",
      expectedScope: userId,
      idempotencyKey,
      payload: {
        core: {
          address: {
            complement: privateComplement,
            neighborhood: privateNeighborhood,
            postalCode: privatePostalCode,
            street: privateStreet,
            streetNumber: privateStreetNumber,
          },
          capacity: 12,
          description: privateDescription,
          name: privateStudioName,
          studioTypeId,
        },
        studioId,
      },
    } as const;
    const { POST } = await import("../../src/app/api/commands/route");
    const response = await POST(commandRequest(command));

    expect(response.status).toBe(200);
    expect(mocks.createStudio).toHaveBeenCalledWith(
      command,
      expect.objectContaining({
        requestId,
        session: expect.objectContaining({ userId }),
        userAgent: privateUserAgent,
      }),
    );
    const serializedEvents = events.join("");
    expect(serializedEvents).toContain(`"requestId":"${requestId}"`);
    expect(serializedEvents).toContain('"event":"private.command"');
    expect(serializedEvents).toContain('"action":"studio.create"');
    for (const privateValue of [
      idempotencyKey,
      privateComplement,
      privateDescription,
      privateNeighborhood,
      privatePostalCode,
      privateStreet,
      privateStreetNumber,
      privateStudioName,
      privateUserAgent,
      studioId,
      studioTypeId,
    ]) {
      expect(serializedEvents).not.toContain(privateValue);
    }
  });
});
