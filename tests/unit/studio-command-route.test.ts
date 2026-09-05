import {
  apiErrorSchema,
  studioMediaUploadPreparationSchema,
  type StudioCommand,
} from "@set-livre/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createStudio: vi.fn(),
  createTrustedStudioMediaStorage: vi.fn(),
  discardStudio: vi.fn(),
  executeStudioMediaCommand: vi.fn(),
  executeStudioPublicationCommand: vi.fn(),
  readRouteIdentitySession: vi.fn(),
  updateStudioContent: vi.fn(),
  updateStudioCore: vi.fn(),
  updateStudioTaxonomy: vi.fn(),
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/studios/server/studio-service", () => ({
  createStudio: mocks.createStudio,
  discardStudio: mocks.discardStudio,
  updateStudioContent: mocks.updateStudioContent,
  updateStudioCore: mocks.updateStudioCore,
  updateStudioTaxonomy: mocks.updateStudioTaxonomy,
}));

vi.mock("../../src/domains/studios/server/studio-media-service", () => ({
  executeStudioMediaCommand: mocks.executeStudioMediaCommand,
}));

vi.mock("../../src/domains/studios/server/studio-publication-service", () => ({
  executeStudioPublicationCommand: mocks.executeStudioPublicationCommand,
}));

vi.mock("../../src/domains/studios/server/studio-media-storage", () => ({
  createTrustedStudioMediaStorage: mocks.createTrustedStudioMediaStorage,
}));

import { ApiRouteError } from "../../src/lib/server/api-route";
import { createStudioPublicationFixture } from "./studio-publication-test-fixture";
import { studioCoreFixture, studioEditorFixture, studioTestIds } from "./studio-test-fixture";

const commandIdentity = {
  expectedScope: studioTestIds.userId,
  idempotencyKey: studioTestIds.idempotencyKey,
};
const revision = {
  expectedRevisionId: studioTestIds.revisionId,
  expectedRevisionVersion: 1,
  studioId: studioTestIds.studioId,
};
const mediaId = "88888888-8888-4888-8888-888888888888";
const commandCases = [
  {
    command: { ...commandIdentity, action: "studio.create", payload: studioCoreFixture },
    result: studioEditorFixture,
    service: mocks.createStudio,
  },
  {
    command: { ...commandIdentity, action: "studio.revision.submit", payload: revision },
    result: createStudioPublicationFixture(),
    service: mocks.executeStudioPublicationCommand,
  },
  {
    command: {
      ...commandIdentity,
      action: "studio.media.upload.prepare",
      payload: {
        ...revision,
        declaredByteSize: 120_000,
        declaredChecksumSha256: null,
        declaredMimeType: "image/jpeg",
      },
    },
    result: studioMediaUploadPreparationSchema.parse({
      bucket: "studio-media",
      expiresAt: "2026-09-05T20:05:00.000Z",
      mediaId,
      path: `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.jpg`,
      revisionId: studioTestIds.revisionId,
      revisionVersion: 1,
      scope: studioTestIds.userId,
      signedToken: "qa-unit-signed-token",
      studioId: studioTestIds.studioId,
    }),
    service: mocks.executeStudioMediaCommand,
  },
] satisfies readonly {
  command: StudioCommand;
  result: unknown;
  service: ReturnType<typeof vi.fn>;
}[];

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
    mocks.createTrustedStudioMediaStorage.mockReturnValue({
      createUploadToken: vi.fn(),
      download: vi.fn(),
      signGalleryPreviews: vi.fn(),
      uploadPreview: vi.fn(),
    });
    mocks.updateStudioCore.mockResolvedValue(studioEditorFixture);
    mocks.updateStudioContent.mockResolvedValue(studioEditorFixture);
    mocks.updateStudioTaxonomy.mockResolvedValue(studioEditorFixture);
    mocks.discardStudio.mockResolvedValue({
      scope: studioTestIds.userId,
      studioDeleted: true,
      studioId: studioTestIds.studioId,
    });
    const { resetIdentityRateLimitForTests } = await import("../../src/lib/server/rate-limit");
    resetIdentityRateLimitForTests();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => vi.restoreAllMocks());

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
    await expect(response.json()).resolves.toEqual({
      data: {
        action: command.action,
        idempotencyKey: command.idempotencyKey,
        result: studioEditorFixture,
      },
      requestId: studioTestIds.requestId,
    });
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

  it.each(
    commandCases.map((entry) => ({
      ...entry,
      command: { ...entry.command, idempotencyKey: crypto.randomUUID() },
    })),
  )(
    "echoes $command.action and key $command.idempotencyKey only after plain DTO service success",
    async ({ command, result, service }) => {
      let resolveService: ((value: unknown) => void) | undefined;
      service.mockImplementationOnce(
        () =>
          new Promise<unknown>((resolve) => {
            resolveService = resolve;
          }),
      );
      const { POST } = await import("../../src/app/api/commands/route");
      let responded = false;
      const responsePromise = POST(commandRequest(command)).then((response) => {
        responded = true;
        return response;
      });

      await vi.waitFor(() => expect(service).toHaveBeenCalledOnce());
      expect(responded).toBe(false);
      expect(service).toHaveBeenCalledWith(
        command,
        expect.objectContaining({
          requestId: studioTestIds.requestId,
          session: expect.objectContaining({ userId: studioTestIds.userId }),
        }),
      );
      if (resolveService === undefined)
        throw new Error("O serviço precisa iniciar antes da resposta.");
      resolveService(result);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.headers.get("x-studio-session")).toBe("refreshed");
      await expect(response.json()).resolves.toEqual({
        data: { action: command.action, idempotencyKey: command.idempotencyKey, result },
        requestId: studioTestIds.requestId,
      });
    },
  );

  describe.each(commandCases)("$command.action service failure", ({ command, service, result }) => {
    it.each([
      {
        name: "known conflict",
        failure: new ApiRouteError(409, "CONFLICT", "Atualize antes de continuar."),
        code: "CONFLICT",
        status: 409,
      },
      {
        name: "unknown failure",
        failure: Object.assign(new Error("qa-private@example.test qa-unit-signed-token"), {
          result,
        }),
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      },
    ])("returns no result or success identity for $name", async ({ failure, code, status }) => {
      service.mockRejectedValueOnce(failure);
      const { POST } = await import("../../src/app/api/commands/route");

      const response = await POST(commandRequest(command));
      const payload: unknown = await response.json();

      expect(service).toHaveBeenCalledOnce();
      expect(response.status).toBe(status);
      expect(response.headers.get("x-studio-session")).toBe("refreshed");
      expect(apiErrorSchema.parse(payload)).toMatchObject({
        error: { code, requestId: studioTestIds.requestId },
      });
      expect(payload).not.toHaveProperty("data");
      expect(payload).not.toHaveProperty("result");
      expect(payload).not.toHaveProperty("action");
      expect(payload).not.toHaveProperty("idempotencyKey");
      const serialized = JSON.stringify(payload);
      const telemetry = vi
        .mocked(process.stdout.write)
        .mock.calls.map(([chunk]) => String(chunk))
        .join("");
      for (const privateValue of [
        "qa-private@example.test",
        "qa-unit-signed-token",
        studioTestIds.idempotencyKey,
        studioCoreFixture.street,
      ]) {
        expect(serialized).not.toContain(privateValue);
        expect(telemetry).not.toContain(privateValue);
      }
    });
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
    expect(privateCommandMaximumBytes).toBe(384 * 1024);
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.createStudio).toHaveBeenCalledWith(command, expect.any(Object));
  });

  it("accepts the largest valid studio content envelope encoded with multibyte characters", async () => {
    const command = {
      action: "studio.revision.updateContent",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: {
        expectedRevisionId: studioTestIds.revisionId,
        expectedRevisionVersion: 3,
        faqs: Array.from({ length: 20 }, () => ({
          answer: "界".repeat(2_000),
          question: "界".repeat(160),
        })),
        studioId: studioTestIds.studioId,
        usageRules: "界".repeat(5_000),
        youtubeVideoId: null,
      },
    } as const;
    const request = commandRequest(command);
    expect(new TextEncoder().encode(await request.clone().text()).byteLength).toBeGreaterThan(
      128 * 1024,
    );

    const { POST, privateCommandMaximumBytes } = await import("../../src/app/api/commands/route");
    expect(privateCommandMaximumBytes).toBe(384 * 1024);
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.updateStudioContent).toHaveBeenCalledWith(command, expect.any(Object));
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

  it.each([
    [
      "studio.revision.updateTaxonomy",
      { amenityIds: [studioTestIds.amenityId], tagIds: [studioTestIds.tagId] },
      mocks.updateStudioTaxonomy,
    ],
    [
      "studio.revision.updateContent",
      {
        faqs: [{ answer: "Resposta.", question: "Pergunta?" }],
        usageRules: "Regras seguras.",
        youtubeVideoId: null,
      },
      mocks.updateStudioContent,
    ],
  ] as const)(
    "dispatches %s only after strict revision validation",
    async (action, payload, handler) => {
      const command = {
        action,
        expectedScope: studioTestIds.userId,
        idempotencyKey: studioTestIds.idempotencyKey,
        payload: {
          ...payload,
          expectedRevisionId: studioTestIds.revisionId,
          expectedRevisionVersion: 3,
          studioId: studioTestIds.studioId,
        },
      };
      const { POST } = await import("../../src/app/api/commands/route");
      const response = await POST(commandRequest(command));
      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledWith(
        command,
        expect.objectContaining({ requestId: studioTestIds.requestId }),
      );
    },
  );
});
