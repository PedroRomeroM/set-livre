import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as StudioMediaStorageModule from "../../src/domains/studios/server/studio-media-storage";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  assertMutableAccount: vi.fn(),
  confirmStudioMediaUploadToken: vi.fn(),
  createUploadToken: vi.fn(),
  deleteStudioMedia: vi.fn(),
  download: vi.fn(),
  enforceStudioMutationRateLimit: vi.fn(),
  finalizeStudioMediaUpload: vi.fn(),
  handleStudioDatabaseError: vi.fn((error: unknown) => {
    throw error;
  }),
  prepareStudioMediaUpload: vi.fn(),
  rejectUnsignedStudioMediaUpload: vi.fn(),
  rejectStudioMediaUpload: vi.fn(),
  renewStudioMediaFinalizeClaim: vi.fn(),
  reorderStudioMedia: vi.fn(),
  setStudioMediaCover: vi.fn(),
  signGalleryPreviews: vi.fn(),
  uploadPreview: vi.fn(),
  verifyStudioMediaImage: vi.fn(),
  withStudioMediaFinalizeClaim: vi.fn(),
  withStudioMediaImageCapacity: vi.fn(),
}));

vi.mock("../../src/domains/studios/server/studio-service", () => ({
  studioServiceBoundary: {
    assertMutableAccount: mocks.assertMutableAccount,
    enforceStudioMutationRateLimit: mocks.enforceStudioMutationRateLimit,
    handleStudioDatabaseError: mocks.handleStudioDatabaseError,
  },
}));

vi.mock("../../src/domains/studios/server/studio-media-dal", () => {
  class StudioMediaFinalizeClaimBusyError extends Error {}
  return {
    confirmStudioMediaUploadToken: mocks.confirmStudioMediaUploadToken,
    deleteStudioMedia: mocks.deleteStudioMedia,
    finalizeStudioMediaUpload: mocks.finalizeStudioMediaUpload,
    prepareStudioMediaUpload: mocks.prepareStudioMediaUpload,
    rejectUnsignedStudioMediaUpload: mocks.rejectUnsignedStudioMediaUpload,
    rejectStudioMediaUpload: mocks.rejectStudioMediaUpload,
    renewStudioMediaFinalizeClaim: mocks.renewStudioMediaFinalizeClaim,
    reorderStudioMedia: mocks.reorderStudioMedia,
    setStudioMediaCover: mocks.setStudioMediaCover,
    StudioMediaFinalizeClaimBusyError,
    withStudioMediaFinalizeClaim: mocks.withStudioMediaFinalizeClaim,
  };
});

vi.mock("../../src/domains/studios/server/studio-media-image", () => {
  class StudioMediaCapacityError extends Error {}
  class StudioMediaDeadlineError extends Error {}
  class StudioMediaImageError extends Error {
    constructor(readonly reason: string) {
      super("invalid image");
      this.name = "StudioMediaImageError";
    }
  }
  return {
    StudioMediaCapacityError,
    StudioMediaDeadlineError,
    StudioMediaImageError,
    verifyStudioMediaImage: mocks.verifyStudioMediaImage,
    withStudioMediaImageCapacity: mocks.withStudioMediaImageCapacity,
  };
});

vi.mock("../../src/domains/studios/server/studio-media-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof StudioMediaStorageModule>();
  return { ...actual, studioMediaPreviewSigningDeadlineMs: 2_000 };
});

import { executeStudioMediaCommand } from "../../src/domains/studios/server/studio-media-service";
import { StudioMediaFinalizeClaimBusyError } from "../../src/domains/studios/server/studio-media-dal";
import {
  StudioMediaCapacityError,
  StudioMediaDeadlineError,
  StudioMediaImageError,
} from "../../src/domains/studios/server/studio-media-image";
import { StudioMediaStorageError } from "../../src/domains/studios/server/studio-media-storage";
import { studioTestIds } from "./studio-test-fixture";

const mediaId = "77777777-7777-4777-8777-777777777777";
const claimToken = "77777777-7777-4777-8777-777777777778";
const leaseExpiresAt = () => new Date(Date.now() + 30_000).toISOString();
const mediaPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.jpg`;
const previewPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.preview.webp`;
const checksumSha256 = "7".repeat(64);
const preparation = {
  bucket: "studio-media" as const,
  expiresAt: "2099-08-31T12:00:00.000Z",
  mediaId,
  path: mediaPath,
  revisionId: studioTestIds.revisionId,
  revisionVersion: 3,
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
};
const candidate = {
  ...preparation,
  declaredByteSize: 512,
  declaredChecksumSha256: null,
  declaredMimeType: "image/jpeg" as const,
  previewPath,
};
const galleryRecord = {
  canEdit: true,
  items: [
    {
      byteSize: 512,
      checksumSha256,
      height: 720,
      id: mediaId,
      isCover: true,
      mimeType: "image/jpeg" as const,
      position: 1,
      previewStoragePath: previewPath,
      width: 1280,
    },
  ],
  revisionId: studioTestIds.revisionId,
  revisionNumber: 1,
  revisionStatus: "draft" as const,
  revisionVersion: 4,
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
};
const gallery = {
  ...galleryRecord,
  items: galleryRecord.items.map((item) => ({
    byteSize: item.byteSize,
    checksumSha256: item.checksumSha256,
    height: item.height,
    id: item.id,
    isCover: item.isCover,
    mimeType: item.mimeType,
    position: item.position,
    previewUrl: "https://storage.example.test/signed-preview",
    width: item.width,
  })),
  previewExpiresAt: "2026-08-31T12:05:00.000Z",
};
const context = {
  requestId: studioTestIds.requestId,
  session: {
    authenticated: true as const,
    email: "owner@example.test",
    personType: "individual" as const,
    profileCompleted: true,
    status: "active" as const,
    userId: studioTestIds.userId,
  },
  studioMediaStorage: {
    createUploadToken: mocks.createUploadToken,
    download: mocks.download,
    signGalleryPreviews: mocks.signGalleryPreviews,
    uploadPreview: mocks.uploadPreview,
  },
  userAgent: "private-agent",
};
const boundary = {
  expectedRevisionId: studioTestIds.revisionId,
  expectedRevisionVersion: 3,
  studioId: studioTestIds.studioId,
};
const galleryMutationCommands = [
  {
    action: "studio.media.reorder",
    expectedScope: studioTestIds.userId,
    idempotencyKey: studioTestIds.idempotencyKey,
    payload: { ...boundary, orderedMediaIds: [mediaId] },
  },
  {
    action: "studio.media.cover.set",
    expectedScope: studioTestIds.userId,
    idempotencyKey: studioTestIds.idempotencyKey,
    payload: { ...boundary, mediaId },
  },
  {
    action: "studio.media.delete",
    expectedScope: studioTestIds.userId,
    idempotencyKey: studioTestIds.idempotencyKey,
    payload: { ...boundary, mediaId },
  },
] satisfies readonly Parameters<typeof executeStudioMediaCommand>[0][];

describe("studio media service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirmStudioMediaUploadToken.mockResolvedValue({
      issuedAt: "2026-09-01T03:55:00.000Z",
      mediaId,
      revisionId: studioTestIds.revisionId,
      revisionVersion: 3,
      scope: studioTestIds.userId,
      state: "issued",
      studioId: studioTestIds.studioId,
    });
    mocks.createUploadToken.mockResolvedValue("signed-upload-token");
    mocks.download.mockResolvedValue(new Blob([new Uint8Array(512)]));
    mocks.finalizeStudioMediaUpload.mockResolvedValue(galleryRecord);
    mocks.prepareStudioMediaUpload.mockResolvedValue(preparation);
    mocks.rejectUnsignedStudioMediaUpload.mockResolvedValue({
      mediaId,
      rejectedAt: "2026-09-01T03:55:01.000Z",
      revisionId: studioTestIds.revisionId,
      revisionVersion: 3,
      scope: studioTestIds.userId,
      state: "rejected",
      studioId: studioTestIds.studioId,
    });
    mocks.renewStudioMediaFinalizeClaim.mockImplementation(async () => ({
      leaseExpiresAt: leaseExpiresAt(),
    }));
    mocks.signGalleryPreviews.mockResolvedValue(gallery);
    mocks.withStudioMediaFinalizeClaim.mockImplementation(
      (
        _input: unknown,
        work: (claim: {
          candidate: typeof candidate;
          claimToken: string;
          leaseExpiresAt: string;
          state: "acquired";
        }) => Promise<unknown>,
      ) => work({ candidate, claimToken, leaseExpiresAt: leaseExpiresAt(), state: "acquired" }),
    );
    mocks.withStudioMediaImageCapacity.mockImplementation(
      (work: (deadline: { deadlineAt: number; signal: AbortSignal }) => Promise<unknown>) =>
        work({ deadlineAt: Date.now() + 15_000, signal: new AbortController().signal }),
    );
    mocks.verifyStudioMediaImage.mockResolvedValue({
      previewBytes: new Uint8Array([1, 2, 3]),
      verification: {
        byteSize: 512,
        checksumSha256,
        height: 720,
        mimeType: "image/jpeg",
        width: 1280,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepares the canonical path with identities derived from the authenticated context", async () => {
    const command = {
      action: "studio.media.upload.prepare",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: {
        ...boundary,
        declaredByteSize: 512,
        declaredChecksumSha256: null,
        declaredMimeType: "image/jpeg",
      },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).resolves.toEqual({
      ...preparation,
      signedToken: "signed-upload-token",
    });
    expect(mocks.prepareStudioMediaUpload).toHaveBeenCalledWith({
      ...command.payload,
      idempotencyKey: studioTestIds.idempotencyKey,
      requestId: studioTestIds.requestId,
      userId: studioTestIds.userId,
    });
    expect(mocks.createUploadToken).toHaveBeenCalledWith(mediaPath);
    expect(mocks.confirmStudioMediaUploadToken).toHaveBeenCalledWith({
      expectedRevisionId: studioTestIds.revisionId,
      expectedRevisionVersion: 3,
      mediaId,
      studioId: studioTestIds.studioId,
      userId: studioTestIds.userId,
    });
    expect(mocks.rejectUnsignedStudioMediaUpload).not.toHaveBeenCalled();
  });

  it("verifies the stored bytes before finalizing and returns only signed browser data", async () => {
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).resolves.toEqual(gallery);
    expect(mocks.download).toHaveBeenCalledWith(mediaPath, expect.any(AbortSignal));
    const processingSignal = mocks.download.mock.calls[0]?.[1];
    expect(mocks.verifyStudioMediaImage).toHaveBeenCalledWith(
      expect.any(Blob),
      candidate,
      expect.objectContaining({ signal: processingSignal }),
    );
    expect(mocks.uploadPreview).toHaveBeenCalledWith(
      previewPath,
      new Uint8Array([1, 2, 3]),
      processingSignal,
    );
    expect(mocks.finalizeStudioMediaUpload).toHaveBeenCalledWith({
      claimToken,
      requestId: studioTestIds.requestId,
      verification: {
        byteSize: 512,
        checksumSha256,
        height: 720,
        mimeType: "image/jpeg",
        width: 1280,
      },
    });
    expect(mocks.renewStudioMediaFinalizeClaim).toHaveBeenCalledWith({ claimToken });
    expect(mocks.renewStudioMediaFinalizeClaim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.uploadPreview.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.signGalleryPreviews).toHaveBeenCalledWith(galleryRecord, expect.any(AbortSignal));
    expect(JSON.stringify(gallery)).not.toContain(mediaPath);
  });

  it("replays a completed finalize before touching Storage or decoding bytes", async () => {
    mocks.withStudioMediaFinalizeClaim.mockImplementationOnce(
      (
        _input: unknown,
        work: (claim: { result: typeof galleryRecord; state: "replay" }) => Promise<unknown>,
      ) => work({ result: galleryRecord, state: "replay" }),
    );
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).resolves.toEqual(gallery);
    expect(mocks.withStudioMediaFinalizeClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: studioTestIds.idempotencyKey,
        mediaId,
        userId: studioTestIds.userId,
      }),
      expect.any(Function),
    );
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.verifyStudioMediaImage).not.toHaveBeenCalled();
    expect(mocks.uploadPreview).not.toHaveBeenCalled();
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
    expect(mocks.signGalleryPreviews).toHaveBeenCalledWith(galleryRecord, expect.any(AbortSignal));
  });

  it("replays a terminal rejection without reopening Storage work", async () => {
    mocks.withStudioMediaFinalizeClaim.mockImplementationOnce(
      (
        _input: unknown,
        work: (claim: {
          rejectionCode: "validation_failed";
          state: "rejected";
        }) => Promise<unknown>,
      ) => work({ rejectionCode: "validation_failed", state: "rejected" }),
    );
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 422,
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.rejectStudioMediaUpload).not.toHaveBeenCalled();
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
  });

  it("signs only after the finalize claim scope has completed its release", async () => {
    let claimScopeCompleted = false;
    mocks.withStudioMediaFinalizeClaim.mockImplementationOnce(
      async (
        _input: unknown,
        work: (claim: {
          candidate: typeof candidate;
          claimToken: string;
          leaseExpiresAt: string;
          state: "acquired";
        }) => Promise<unknown>,
      ) => {
        const result = await work({
          candidate,
          claimToken,
          leaseExpiresAt: leaseExpiresAt(),
          state: "acquired",
        });
        claimScopeCompleted = true;
        return result;
      },
    );
    mocks.signGalleryPreviews.mockImplementationOnce(async () => {
      expect(claimScopeCompleted).toBe(true);
      return gallery;
    });

    await expect(
      executeStudioMediaCommand(
        {
          action: "studio.media.upload.finalize",
          expectedScope: studioTestIds.userId,
          idempotencyKey: studioTestIds.idempotencyKey,
          payload: { ...boundary, mediaId },
        },
        context,
      ),
    ).resolves.toEqual(gallery);
  });

  it("fails recoverably without touching Storage when another finalize owns the claim", async () => {
    mocks.withStudioMediaFinalizeClaim.mockRejectedValueOnce(
      new StudioMediaFinalizeClaimBusyError(),
    );
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.verifyStudioMediaImage).not.toHaveBeenCalled();
    expect(mocks.uploadPreview).not.toHaveBeenCalled();
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
  });

  it("fails closed before queueing image work when the lease lacks its full execution budget", async () => {
    mocks.withStudioMediaFinalizeClaim.mockImplementationOnce(
      (
        _input: unknown,
        work: (claim: {
          candidate: typeof candidate;
          claimToken: string;
          leaseExpiresAt: string;
          state: "acquired";
        }) => Promise<unknown>,
      ) =>
        work({
          candidate,
          claimToken,
          leaseExpiresAt: new Date(Date.now() + 21_999).toISOString(),
          state: "acquired",
        }),
    );

    await expect(
      executeStudioMediaCommand(
        {
          action: "studio.media.upload.finalize",
          expectedScope: studioTestIds.userId,
          idempotencyKey: studioTestIds.idempotencyKey,
          payload: { ...boundary, mediaId },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    expect(mocks.withStudioMediaImageCapacity).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("tombstones a rejected upload and exposes no decoder detail", async () => {
    mocks.verifyStudioMediaImage.mockRejectedValueOnce(new StudioMediaImageError("MIME_MISMATCH"));
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "A foto enviada não corresponde ao tipo, tamanho ou conteúdo informado.",
      status: 422,
    });
    expect(mocks.rejectStudioMediaUpload).toHaveBeenCalledWith({
      claimToken,
      rejectionCode: "validation_failed",
      requestId: studioTestIds.requestId,
    });
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
  });

  it("tombstones a missing Storage object before authorizing a renewed reservation", async () => {
    mocks.download.mockRejectedValueOnce(new StudioMediaStorageError("download", "not-found"));
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).rejects.toMatchObject({
      code: "UPLOAD_OBJECT_MISSING",
      status: 409,
    });
    expect(mocks.rejectStudioMediaUpload).toHaveBeenCalledWith({
      claimToken,
      rejectionCode: "object_missing",
      requestId: studioTestIds.requestId,
    });
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
  });

  it("terminalizes a prepared upload before exposing a concurrent revision conflict", async () => {
    const conflict = {
      code: "40001",
      message: "studio_revision_conflict",
    };
    mocks.withStudioMediaFinalizeClaim.mockImplementationOnce(
      (
        _input: unknown,
        work: (claim: {
          claimToken: string;
          leaseExpiresAt: string;
          state: "superseded";
        }) => Promise<unknown>,
      ) => work({ claimToken, leaseExpiresAt: leaseExpiresAt(), state: "superseded" }),
    );
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).rejects.toMatchObject(conflict);
    expect(mocks.rejectStudioMediaUpload).toHaveBeenCalledWith({
      claimToken,
      rejectionCode: "superseded",
      requestId: studioTestIds.requestId,
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
    expect(mocks.handleStudioDatabaseError).toHaveBeenCalledWith(expect.objectContaining(conflict));
  });

  it("fails closed when the terminal lease cannot be renewed before preview upload", async () => {
    mocks.renewStudioMediaFinalizeClaim.mockRejectedValueOnce({
      code: "40001",
      message: "studio_media_finalize_claim_lost",
    });

    await expect(
      executeStudioMediaCommand(
        {
          action: "studio.media.upload.finalize",
          expectedScope: studioTestIds.userId,
          idempotencyKey: studioTestIds.idempotencyKey,
          payload: { ...boundary, mediaId },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    expect(mocks.uploadPreview).not.toHaveBeenCalled();
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
  });

  it("maps a Storage outage to a recoverable service response", async () => {
    mocks.createUploadToken.mockRejectedValueOnce(new StudioMediaStorageError("upload-token"));
    const command = {
      action: "studio.media.upload.prepare",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: {
        ...boundary,
        declaredByteSize: 512,
        declaredChecksumSha256: null,
        declaredMimeType: "image/jpeg",
      },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    expect(mocks.rejectUnsignedStudioMediaUpload).toHaveBeenCalledWith({
      expectedRevisionId: studioTestIds.revisionId,
      expectedRevisionVersion: 3,
      mediaId,
      requestId: studioTestIds.requestId,
      studioId: studioTestIds.studioId,
      userId: studioTestIds.userId,
    });
    expect(mocks.confirmStudioMediaUploadToken).not.toHaveBeenCalled();
  });

  it("does not return a signed token when its database confirmation fails", async () => {
    const confirmationError = {
      code: "40001",
      message: "studio_media_upload_token_rejected",
    };
    mocks.confirmStudioMediaUploadToken.mockRejectedValueOnce(confirmationError);

    await expect(
      executeStudioMediaCommand(
        {
          action: "studio.media.upload.prepare",
          expectedScope: studioTestIds.userId,
          idempotencyKey: studioTestIds.idempotencyKey,
          payload: {
            ...boundary,
            declaredByteSize: 512,
            declaredChecksumSha256: null,
            declaredMimeType: "image/jpeg",
          },
        },
        context,
      ),
    ).rejects.toBe(confirmationError);
    expect(mocks.createUploadToken).toHaveBeenCalledWith(mediaPath);
    expect(mocks.rejectUnsignedStudioMediaUpload).toHaveBeenCalledWith({
      expectedRevisionId: studioTestIds.revisionId,
      expectedRevisionVersion: 3,
      mediaId,
      requestId: studioTestIds.requestId,
      studioId: studioTestIds.studioId,
      userId: studioTestIds.userId,
    });
  });

  it("terminalizes an expired replay before asking Storage for another token", async () => {
    mocks.prepareStudioMediaUpload.mockResolvedValueOnce({
      ...preparation,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    await expect(
      executeStudioMediaCommand(
        {
          action: "studio.media.upload.prepare",
          expectedScope: studioTestIds.userId,
          idempotencyKey: studioTestIds.idempotencyKey,
          payload: {
            ...boundary,
            declaredByteSize: 512,
            declaredChecksumSha256: null,
            declaredMimeType: "image/jpeg",
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_EXPIRED", status: 409 });
    expect(mocks.rejectUnsignedStudioMediaUpload).toHaveBeenCalledOnce();
    expect(mocks.createUploadToken).not.toHaveBeenCalled();
    expect(mocks.confirmStudioMediaUploadToken).not.toHaveBeenCalled();
  });

  it("fails recoverably before downloading when the bounded image worker is saturated", async () => {
    mocks.withStudioMediaImageCapacity.mockRejectedValueOnce(new StudioMediaCapacityError());
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("maps an exhausted server verification deadline without rejecting the reservation", async () => {
    mocks.withStudioMediaImageCapacity.mockRejectedValueOnce(new StudioMediaDeadlineError());
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.rejectStudioMediaUpload).not.toHaveBeenCalled();
  });

  it.each(galleryMutationCommands)("bounds preview signing for $action", async (command) => {
    const mutationResult =
      command.action === "studio.media.reorder"
        ? mocks.reorderStudioMedia
        : command.action === "studio.media.cover.set"
          ? mocks.setStudioMediaCover
          : mocks.deleteStudioMedia;
    mutationResult.mockResolvedValueOnce(galleryRecord);

    await expect(executeStudioMediaCommand(command, context)).resolves.toEqual(gallery);
    expect(mocks.signGalleryPreviews).toHaveBeenCalledWith(galleryRecord, expect.any(AbortSignal));
  });

  it("aborts command preview signing when the Storage adapter ignores its deadline", async () => {
    vi.useFakeTimers();
    mocks.reorderStudioMedia.mockResolvedValueOnce(galleryRecord);
    mocks.signGalleryPreviews.mockImplementationOnce(() => new Promise(() => undefined));
    const operation = executeStudioMediaCommand(
      {
        action: "studio.media.reorder",
        expectedScope: studioTestIds.userId,
        idempotencyKey: studioTestIds.idempotencyKey,
        payload: { ...boundary, orderedMediaIds: [mediaId] },
      },
      context,
    );
    const rejection = expect(operation).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(mocks.signGalleryPreviews.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
  });

  it.each([
    ["23514", "studio_media_limit_reached", 409, "MEDIA_LIMIT_REACHED"],
    ["23514", "studio_media_order_set_mismatch", 409, "MEDIA_ORDER_CHANGED"],
    ["23514", "studio_media_cover_replacement_required", 409, "MEDIA_COVER_REPLACEMENT_REQUIRED"],
    ["23514", "studio_media_metadata_mismatch", 422, "VALIDATION_FAILED"],
    ["40001", "studio_media_upload_expired", 409, "UPLOAD_EXPIRED"],
  ])(
    "maps known media database errors without exposing SQL",
    async (code, message, status, apiCode) => {
      mocks.reorderStudioMedia.mockRejectedValueOnce({ code, message });
      const command = {
        action: "studio.media.reorder",
        expectedScope: studioTestIds.userId,
        idempotencyKey: studioTestIds.idempotencyKey,
        payload: { ...boundary, orderedMediaIds: [mediaId] as string[] },
      } as const;

      await expect(executeStudioMediaCommand(command, context)).rejects.toMatchObject({
        code: apiCode,
        status,
      });
    },
  );
});
