import {
  studioPublicationRecordSchema,
  type StudioMediaGallery,
  type StudioMediaGalleryRecord,
  type StudioPublicationRecord,
} from "@set-livre/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createTrustedStudioMediaStorage: vi.fn(),
  query: vi.fn(),
  readOwnerActivation: vi.fn(),
  readRouteIdentitySession: vi.fn(),
  signGalleryPreviews: vi.fn(),
}));

vi.mock("../../src/lib/server/dal-pool", () => ({
  commandDalPool: () => ({ query: mocks.query }),
}));

vi.mock("../../src/domains/identity/server/identity-read-model", () => ({
  readRouteIdentitySession: mocks.readRouteIdentitySession,
}));

vi.mock("../../src/domains/owners/server/owner-read-model", () => ({
  readOwnerActivation: mocks.readOwnerActivation,
}));

vi.mock("../../src/domains/studios/server/studio-media-storage", () => {
  class StudioMediaStorageError extends Error {}
  return {
    createTrustedStudioMediaStorage: mocks.createTrustedStudioMediaStorage,
    StudioMediaStorageError,
  };
});

import { GET as readPublicationRoute } from "../../src/app/api/owner/studios/[studioId]/publication/route";
import type { PrivateCommandContext } from "../../src/domains/commands/server/private-command-context";
import type { StudioCommandResult } from "../../src/domains/studios/server/studio-command-result";
import {
  pauseStudio,
  readOwnerStudioPublicationRecord,
  resumeStudio,
  submitStudioRevision,
} from "../../src/domains/studios/server/studio-publication-dal";
import {
  readOwnerStudioPublication,
  StudioPublicationNotFoundError,
} from "../../src/domains/studios/server/studio-publication-read-model";
import {
  createStudioPublicationService,
  type StudioPublicationServiceDependencies,
} from "../../src/domains/studios/server/studio-publication-service";
import type { StudioMediaStorage } from "../../src/domains/studios/server/studio-media-storage";
import { studioTestIds } from "./studio-test-fixture";

const currentMediaId = "88888888-8888-4888-8888-888888888888";
const publishedMediaId = "89898989-8989-4989-8989-898989898989";
const previewExpiresAt = "2026-08-31T12:05:00.000Z";
const activeIdentitySession = {
  authenticated: true,
  email: "owner@example.test",
  personType: "individual",
  profileCompleted: true,
  status: "active",
  userId: studioTestIds.userId,
} as const;

function previewPath(revisionId: string, mediaId: string) {
  return `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${revisionId}/${mediaId}.preview.webp`;
}

function publicationRevision(
  input: Readonly<{
    cover: boolean;
    id: string;
    mediaId: string;
    status: "approved" | "draft" | "pending";
  }>,
) {
  return {
    addressComplement: null,
    amenities: [
      {
        active: true,
        id: studioTestIds.amenityId,
        name: "Wi-Fi",
        sortOrder: 10,
      },
    ],
    capacity: 12,
    city: "Curitiba" as const,
    cover: input.cover
      ? {
          byteSize: 512,
          checksumSha256: "8".repeat(64),
          height: 720,
          id: input.mediaId,
          isCover: true,
          mimeType: "image/jpeg" as const,
          position: 1,
          previewStoragePath: previewPath(input.id, input.mediaId),
          width: 1_280,
        }
      : null,
    description: "Estúdio completo para ensaios fotográficos e gravações audiovisuais.",
    faqs: [
      {
        answer: "Use o formulário de reserva para consultar os horários disponíveis.",
        id: "99999999-9999-4999-8999-999999999999",
        position: 1,
        question: "Como consultar horários?",
      },
    ],
    id: input.id,
    mediaCount: input.cover ? 1 : 0,
    name: "Estúdio Aurora",
    neighborhood: "Centro",
    number: input.id === studioTestIds.publishedRevisionId ? 1 : 2,
    postalCode: "80010000",
    state: "PR" as const,
    status: input.status,
    street: "Rua das Flores",
    streetNumber: "100",
    studioType: {
      id: studioTestIds.studioTypeId,
      name: "Estúdio audiovisual",
    },
    tags: [
      {
        active: true,
        id: studioTestIds.tagId,
        name: "Podcast",
        sortOrder: 10,
      },
    ],
    usageRules: "Respeite o horário reservado e preserve os equipamentos do espaço.",
    version: 3,
    youtubeVideoId: "dQw4w9WgXcQ",
  };
}

const completeChecklist = [
  { complete: true, key: "details" as const, messages: [] },
  { complete: true, key: "content" as const, messages: [] },
  { complete: true, key: "media" as const, messages: [] },
];

function draftPublicationRecord(): StudioPublicationRecord {
  return studioPublicationRecordSchema.parse({
    canPause: false,
    canResume: false,
    canSubmit: true,
    checklist: completeChecklist,
    currentRevision: publicationRevision({
      cover: true,
      id: studioTestIds.revisionId,
      mediaId: currentMediaId,
      status: "draft",
    }),
    latestReview: null,
    publicationVersion: 1,
    publishedRevision: null,
    scope: studioTestIds.userId,
    studioId: studioTestIds.studioId,
    studioStatus: "draft",
  });
}

function publishedPublicationRecord(
  options: Readonly<{ distinctCandidate?: boolean; withCover?: boolean }> = {},
): StudioPublicationRecord {
  const withCover = options.withCover ?? true;
  const publishedRevision = publicationRevision({
    cover: withCover,
    id: studioTestIds.publishedRevisionId,
    mediaId: publishedMediaId,
    status: "approved",
  });
  const distinctCandidate = options.distinctCandidate ?? false;
  return studioPublicationRecordSchema.parse({
    canPause: true,
    canResume: false,
    canSubmit: false,
    checklist: withCover
      ? completeChecklist
      : [
          ...completeChecklist.slice(0, 2),
          { complete: false, key: "media", messages: ["Adicione uma foto de capa."] },
        ],
    currentRevision: distinctCandidate
      ? publicationRevision({
          cover: withCover,
          id: studioTestIds.revisionId,
          mediaId: currentMediaId,
          status: "pending",
        })
      : publishedRevision,
    latestReview: distinctCandidate
      ? {
          eventType: "submitted",
          occurredAt: "2026-08-31T12:00:00.000Z",
          rejectionReason: null,
          revisionId: studioTestIds.revisionId,
        }
      : {
          eventType: "approved",
          occurredAt: "2026-08-30T12:00:00.000Z",
          rejectionReason: null,
          revisionId: studioTestIds.publishedRevisionId,
        },
    publicationVersion: 4,
    publishedRevision,
    scope: studioTestIds.userId,
    studioId: studioTestIds.studioId,
    studioStatus: distinctCandidate ? "changes_pending" : "published",
  });
}

function pausedPublicationRecord(): StudioPublicationRecord {
  const published = publishedPublicationRecord({ withCover: false });
  return studioPublicationRecordSchema.parse({
    ...published,
    canPause: false,
    canResume: true,
    publicationVersion: 5,
    studioStatus: "paused",
  });
}

function signGallery(gallery: StudioMediaGalleryRecord): StudioMediaGallery {
  return {
    canEdit: gallery.canEdit,
    items: gallery.items.map((item) => ({
      byteSize: item.byteSize,
      checksumSha256: item.checksumSha256,
      height: item.height,
      id: item.id,
      isCover: item.isCover,
      mimeType: item.mimeType,
      position: item.position,
      previewUrl: `https://storage.example.test/${item.id}`,
      width: item.width,
    })),
    previewExpiresAt,
    revisionId: gallery.revisionId,
    revisionNumber: gallery.revisionNumber,
    revisionStatus: gallery.revisionStatus,
    revisionVersion: gallery.revisionVersion,
    scope: gallery.scope,
    studioId: gallery.studioId,
  };
}

function publicationStorage(): StudioMediaStorage {
  return {
    createUploadToken: vi.fn(),
    download: vi.fn(),
    signGalleryPreviews: mocks.signGalleryPreviews,
    uploadPreview: vi.fn(),
  };
}

function commandContext(storage = publicationStorage()): PrivateCommandContext {
  return {
    requestId: studioTestIds.requestId,
    session: {
      authenticated: true,
      email: "owner@example.test",
      personType: "individual",
      profileCompleted: true,
      status: "active",
      userId: studioTestIds.userId,
    },
    studioMediaStorage: storage,
    userAgent: "publication-test",
  };
}

function serviceDependencies(): StudioPublicationServiceDependencies {
  return {
    pauseStudio: vi.fn<typeof pauseStudio>(),
    resumeStudio: vi.fn<typeof resumeStudio>(),
    submitStudioRevision: vi.fn<typeof submitStudioRevision>(),
  };
}

function commandResult(
  action: "studio.revision.submit" | "studio.pause" | "studio.resume",
  result: StudioPublicationRecord,
): StudioCommandResult<StudioPublicationRecord> {
  return { action, idempotencyKey: studioTestIds.idempotencyKey, result };
}

function publicationRequest(signal?: AbortSignal) {
  return new Request(
    `http://127.0.0.1:3000/api/owner/studios/${studioTestIds.studioId}/publication`,
    {
      headers: { "x-request-id": studioTestIds.requestId },
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

describe("studio publication server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const record = draftPublicationRecord();
    mocks.query.mockResolvedValue({ rows: [{ result: record }] });
    mocks.signGalleryPreviews.mockImplementation(async (gallery: StudioMediaGalleryRecord) =>
      signGallery(gallery),
    );
    mocks.createTrustedStudioMediaStorage.mockReturnValue(publicationStorage());
    mocks.readRouteIdentitySession.mockResolvedValue({
      client: { boundary: "authenticated-route-client" },
      responseHeaders: new Headers({ "x-studio-session": "refreshed" }),
      session: activeIdentitySession,
    });
    mocks.readOwnerActivation.mockResolvedValue({
      ownerContractAccepted: true,
      ownerStatus: "active",
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls only the four typed private app_dal functions with server-derived identities", async () => {
    const common = {
      idempotencyKey: studioTestIds.idempotencyKey,
      requestId: studioTestIds.requestId,
      studioId: studioTestIds.studioId,
      userId: studioTestIds.userId,
    };

    await readOwnerStudioPublicationRecord({
      studioId: studioTestIds.studioId,
      userId: studioTestIds.userId,
    });
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ result: commandResult("studio.revision.submit", draftPublicationRecord()) }],
      })
      .mockResolvedValueOnce({
        rows: [{ result: commandResult("studio.pause", pausedPublicationRecord()) }],
      })
      .mockResolvedValueOnce({
        rows: [{ result: commandResult("studio.resume", publishedPublicationRecord()) }],
      });
    await submitStudioRevision({
      ...common,
      expectedRevisionId: studioTestIds.revisionId,
      expectedRevisionVersion: 3,
    });
    await pauseStudio({ ...common, expectedPublicationVersion: 4 });
    await resumeStudio({ ...common, expectedPublicationVersion: 5 });

    const statements = mocks.query.mock.calls.map(([statement]) =>
      String(statement).replaceAll(/\s+/gu, " ").trim(),
    );
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain("select private.get_owner_studio_publication(");
    expect(statements[1]).toContain("private.submit_studio_revision(");
    expect(statements[2]).toContain("private.pause_studio(");
    expect(statements[3]).toContain("private.resume_studio(");
    for (const statement of statements.slice(1)) {
      expect(statement).toContain("select private.bind_studio_command_result(");
    }
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(?:auth|public|storage)\./u);
    }
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([studioTestIds.userId, studioTestIds.studioId]);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      studioTestIds.userId,
      studioTestIds.studioId,
      studioTestIds.revisionId,
      3,
      studioTestIds.idempotencyKey,
      studioTestIds.requestId,
    ]);
  });

  it("normalizes the owner projection, deduplicates one published cover and hides its path", async () => {
    const record = publishedPublicationRecord();
    mocks.query.mockResolvedValueOnce({ rows: [{ result: record }] });

    const publication = await readOwnerStudioPublication(
      studioTestIds.userId,
      studioTestIds.studioId,
    );

    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("private.get_owner"), [
      studioTestIds.userId,
      studioTestIds.studioId,
    ]);
    expect(mocks.signGalleryPreviews).toHaveBeenCalledTimes(1);
    expect(mocks.signGalleryPreviews).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: studioTestIds.publishedRevisionId }),
      expect.any(AbortSignal),
    );
    expect(publication.currentRevision.cover?.previewUrl).toContain(publishedMediaId);
    expect(publication.publishedRevision?.cover?.previewUrl).toContain(publishedMediaId);
    expect(JSON.stringify(publication)).not.toContain("previewStoragePath");
  });

  it("deduplicates one immutable cover while preserving each revision position", async () => {
    const record = publishedPublicationRecord({ distinctCandidate: true });
    const publishedCover = record.publishedRevision?.cover;
    if (publishedCover === undefined || publishedCover === null) {
      throw new Error("A fixture publicada precisa de capa.");
    }
    const reorderedRecord = studioPublicationRecordSchema.parse({
      ...record,
      currentRevision: {
        ...record.currentRevision,
        cover: { ...publishedCover, position: 2 },
      },
    });
    mocks.query.mockResolvedValueOnce({ rows: [{ result: reorderedRecord }] });

    const publication = await readOwnerStudioPublication(
      studioTestIds.userId,
      studioTestIds.studioId,
    );

    expect(mocks.signGalleryPreviews).toHaveBeenCalledTimes(1);
    expect(publication.currentRevision.cover).toMatchObject({
      id: publishedCover.id,
      isCover: true,
      position: 2,
    });
    expect(publication.publishedRevision?.cover).toMatchObject({
      id: publishedCover.id,
      isCover: true,
      position: 1,
    });
  });

  it("keeps inaccessible studios indistinguishable and rejects projection boundary drift", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ result: null }] });
    await expect(
      readOwnerStudioPublication(studioTestIds.userId, studioTestIds.studioId),
    ).rejects.toBeInstanceOf(StudioPublicationNotFoundError);

    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { ...draftPublicationRecord(), scope: studioTestIds.otherUserId } }],
    });
    await expect(
      readOwnerStudioPublication(studioTestIds.userId, studioTestIds.studioId),
    ).rejects.toThrow("fronteira diferente");
    expect(mocks.signGalleryPreviews).not.toHaveBeenCalled();
  });

  it.each([
    { drift: { scope: studioTestIds.otherUserId }, label: "owner scope" },
    { drift: { studioId: studioTestIds.otherStudioId }, label: "studio identity" },
  ])("rejects $label drift in command results before signing covers", async ({ drift }) => {
    const dependencies = serviceDependencies();
    vi.mocked(dependencies.resumeStudio).mockResolvedValue(
      commandResult("studio.resume", {
        ...publishedPublicationRecord(),
        ...drift,
      }),
    );
    const service = createStudioPublicationService(dependencies);

    await expect(
      service.execute(
        {
          action: "studio.resume",
          expectedScope: studioTestIds.userId,
          idempotencyKey: studioTestIds.idempotencyKey,
          payload: {
            expectedPublicationVersion: 4,
            studioId: studioTestIds.studioId,
          },
        },
        commandContext(),
      ),
    ).rejects.toThrow("fronteira diferente");
    expect(mocks.signGalleryPreviews).not.toHaveBeenCalled();
  });

  it("enforces the absolute Storage deadline when the underlying adapter ignores cancellation", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    mocks.signGalleryPreviews.mockImplementationOnce(
      (_gallery: StudioMediaGalleryRecord, signal?: AbortSignal) => {
        if (signal === undefined) throw new Error("A assinatura precisa receber o deadline.");
        observedSignal = signal;
        return new Promise<StudioMediaGallery>(() => undefined);
      },
    );
    const operation = readOwnerStudioPublication(studioTestIds.userId, studioTestIds.studioId);
    let outerSettled = false;
    void operation.then(
      () => {
        outerSettled = true;
      },
      () => {
        outerSettled = true;
      },
    );
    const rejection = expect(operation).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(outerSettled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not impose the Storage deadline on a delayed database command", async () => {
    vi.useFakeTimers();
    const dependencies = serviceDependencies();
    vi.mocked(dependencies.pauseStudio).mockImplementation(
      () =>
        new Promise<StudioCommandResult<StudioPublicationRecord>>((resolve) => {
          setTimeout(
            () => resolve(commandResult("studio.pause", pausedPublicationRecord())),
            2_500,
          );
        }),
    );
    const service = createStudioPublicationService(dependencies);
    const operation = service.execute(
      {
        action: "studio.pause",
        expectedScope: studioTestIds.userId,
        idempotencyKey: studioTestIds.idempotencyKey,
        payload: {
          expectedPublicationVersion: 4,
          studioId: studioTestIds.studioId,
        },
      },
      commandContext(),
    );
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(2_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(499);
    await expect(operation).resolves.toMatchObject({
      action: "studio.pause",
      idempotencyKey: studioTestIds.idempotencyKey,
      result: { studioStatus: "paused" },
    });
    expect(mocks.signGalleryPreviews).not.toHaveBeenCalled();
  });

  it("maps incomplete submission and ownership failures without leaking database details", async () => {
    const dependencies = serviceDependencies();
    const service = createStudioPublicationService(dependencies);
    const command = {
      action: "studio.revision.submit" as const,
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: {
        expectedRevisionId: studioTestIds.revisionId,
        expectedRevisionVersion: 3,
        studioId: studioTestIds.studioId,
      },
    };
    vi.mocked(dependencies.submitStudioRevision).mockRejectedValueOnce({
      code: "23514",
      detail: "private.media_path=/sensitive/object",
      message: "studio_submission_incomplete",
    });
    await expect(service.execute(command, commandContext())).rejects.toMatchObject({
      code: "STUDIO_SUBMISSION_INCOMPLETE",
      message: expect.not.stringContaining("sensitive"),
      status: 422,
    });

    vi.mocked(dependencies.submitStudioRevision).mockRejectedValueOnce({
      code: "P0002",
      detail: "owner=private@example.test",
      message: "studio_not_found",
    });
    await expect(service.execute(command, commandContext())).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.not.stringContaining("private@example.test"),
      status: 404,
    });
  });

  it("serves the owner projection no-store and records the allowlisted publication action", async () => {
    const output = vi.mocked(process.stdout.write);
    const currentRequest = publicationRequest();
    const response = await readPublicationRoute(currentRequest, {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-studio-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({
      data: { scope: studioTestIds.userId, studioId: studioTestIds.studioId },
    });
    expect(mocks.readOwnerActivation).toHaveBeenCalledWith(
      studioTestIds.userId,
      currentRequest.signal,
    );
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join("\n")).toContain(
      '"action":"studio.publication.read"',
    );
  });

  it.each([
    {
      code: "UNAUTHENTICATED",
      label: "anonymous session",
      session: { authenticated: false },
      status: 401,
    },
    {
      code: "ACCOUNT_SUSPENDED",
      label: "suspended account",
      session: { ...activeIdentitySession, status: "suspended" },
      status: 403,
    },
    {
      code: "FORBIDDEN",
      label: "incomplete profile",
      session: { ...activeIdentitySession, profileCompleted: false },
      status: 403,
    },
  ])("rejects $label before owner or publication reads", async ({ code, session, status }) => {
    mocks.readRouteIdentitySession.mockResolvedValueOnce({
      client: { boundary: "guarded-route-client" },
      responseHeaders: new Headers({ "x-studio-session": "guard-refreshed" }),
      session,
    });

    const response = await readPublicationRoute(publicationRequest(), {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });

    expect(response.status).toBe(status);
    expect(response.headers.get("x-studio-session")).toBe("guard-refreshed");
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(mocks.readOwnerActivation).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createTrustedStudioMediaStorage).not.toHaveBeenCalled();
  });

  it.each([
    {
      activation: { ownerContractAccepted: true, ownerStatus: "inactive" },
      code: "FORBIDDEN",
      label: "inactive owner",
      status: 403,
    },
    {
      activation: { ownerContractAccepted: false, ownerStatus: "active" },
      code: "OWNER_CONTRACT_CHANGED",
      label: "stale owner contract",
      status: 409,
    },
  ])("rejects $label before the publication DAL", async ({ activation, code, status }) => {
    mocks.readOwnerActivation.mockResolvedValueOnce(activation);

    const response = await readPublicationRoute(publicationRequest(), {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });

    expect(response.status).toBe(status);
    expect(response.headers.get("x-studio-session")).toBe("refreshed");
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createTrustedStudioMediaStorage).not.toHaveBeenCalled();
  });

  it("returns the same safe 404 for invalid or inaccessible studio identifiers", async () => {
    const invalid = await readPublicationRoute(publicationRequest(), {
      params: Promise.resolve({ studioId: "invalid" }),
    });
    expect(invalid.status).toBe(404);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(mocks.readOwnerActivation).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();

    mocks.query.mockResolvedValueOnce({ rows: [{ result: null }] });
    const inaccessible = await readPublicationRoute(publicationRequest(), {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });
    expect(inaccessible.status).toBe(404);
    await expect(inaccessible.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("normalizes an uppercase UUID before the private publication read", async () => {
    const response = await readPublicationRoute(publicationRequest(), {
      params: Promise.resolve({ studioId: studioTestIds.studioId.toUpperCase() }),
    });

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("private.get_owner"), [
      studioTestIds.userId,
      studioTestIds.studioId,
    ]);
  });

  it("maps request cancellation promptly when Storage ignores cancellation", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    mocks.signGalleryPreviews.mockImplementationOnce(
      (_gallery: StudioMediaGalleryRecord, signal?: AbortSignal) => {
        if (signal === undefined) throw new Error("A assinatura precisa receber cancelamento.");
        observedSignal = signal;
        return new Promise<StudioMediaGallery>(() => undefined);
      },
    );
    const responsePromise = readPublicationRoute(publicationRequest(controller.signal), {
      params: Promise.resolve({ studioId: studioTestIds.studioId }),
    });
    await vi.waitFor(() => expect(mocks.signGalleryPreviews).toHaveBeenCalledOnce());
    controller.abort();
    const response = await responsePromise;

    expect(observedSignal?.aborted).toBe(true);
    expect(response.status).toBe(503);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("SERVICE_UNAVAILABLE");
    expect(serialized).not.toContain("StorageUnknownError");
  });
});
