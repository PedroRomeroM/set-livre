import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  assertMutableAccount: vi.fn(),
  createUploadToken: vi.fn(),
  deleteStudioMedia: vi.fn(),
  download: vi.fn(),
  enforceStudioMutationRateLimit: vi.fn(),
  finalizeStudioMediaUpload: vi.fn(),
  handleStudioDatabaseError: vi.fn((error: unknown) => {
    throw error;
  }),
  prepareStudioMediaUpload: vi.fn(),
  readStudioMediaUploadCandidate: vi.fn(),
  rejectStudioMediaUpload: vi.fn(),
  replayStudioMediaFinalize: vi.fn(),
  reorderStudioMedia: vi.fn(),
  setStudioMediaCover: vi.fn(),
  signGalleryPreviews: vi.fn(),
  uploadPreview: vi.fn(),
  verifyStudioMediaImage: vi.fn(),
  withStudioMediaImageCapacity: vi.fn(),
}));

vi.mock("../../src/domains/studios/server/studio-service", () => ({
  studioServiceBoundary: {
    assertMutableAccount: mocks.assertMutableAccount,
    enforceStudioMutationRateLimit: mocks.enforceStudioMutationRateLimit,
    handleStudioDatabaseError: mocks.handleStudioDatabaseError,
  },
}));

vi.mock("../../src/domains/studios/server/studio-media-dal", () => ({
  deleteStudioMedia: mocks.deleteStudioMedia,
  finalizeStudioMediaUpload: mocks.finalizeStudioMediaUpload,
  prepareStudioMediaUpload: mocks.prepareStudioMediaUpload,
  readStudioMediaUploadCandidate: mocks.readStudioMediaUploadCandidate,
  rejectStudioMediaUpload: mocks.rejectStudioMediaUpload,
  replayStudioMediaFinalize: mocks.replayStudioMediaFinalize,
  reorderStudioMedia: mocks.reorderStudioMedia,
  setStudioMediaCover: mocks.setStudioMediaCover,
}));

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

import { executeStudioMediaCommand } from "../../src/domains/studios/server/studio-media-service";
import {
  StudioMediaCapacityError,
  StudioMediaDeadlineError,
  StudioMediaImageError,
} from "../../src/domains/studios/server/studio-media-image";
import { StudioMediaStorageError } from "../../src/domains/studios/server/studio-media-storage";
import { studioTestIds } from "./studio-test-fixture";

const mediaId = "77777777-7777-4777-8777-777777777777";
const mediaPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.jpg`;
const previewPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.preview.webp`;
const checksumSha256 = "7".repeat(64);
const preparation = {
  bucket: "studio-media" as const,
  expiresAt: "2026-08-31T12:00:00.000Z",
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

describe("studio media service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createUploadToken.mockResolvedValue("signed-upload-token");
    mocks.download.mockResolvedValue(new Blob([new Uint8Array(512)]));
    mocks.finalizeStudioMediaUpload.mockResolvedValue(galleryRecord);
    mocks.prepareStudioMediaUpload.mockResolvedValue(preparation);
    mocks.readStudioMediaUploadCandidate.mockResolvedValue(candidate);
    mocks.replayStudioMediaFinalize.mockResolvedValue(null);
    mocks.signGalleryPreviews.mockResolvedValue(gallery);
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
    expect(mocks.finalizeStudioMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaId,
        requestId: studioTestIds.requestId,
        userId: studioTestIds.userId,
      }),
    );
    expect(mocks.signGalleryPreviews).toHaveBeenCalledWith(galleryRecord);
    expect(JSON.stringify(gallery)).not.toContain(mediaPath);
  });

  it("replays a completed finalize before touching Storage or decoding bytes", async () => {
    mocks.replayStudioMediaFinalize.mockResolvedValueOnce(galleryRecord);
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).resolves.toEqual(gallery);
    expect(mocks.replayStudioMediaFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: studioTestIds.idempotencyKey,
        mediaId,
        userId: studioTestIds.userId,
      }),
    );
    expect(mocks.readStudioMediaUploadCandidate).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.verifyStudioMediaImage).not.toHaveBeenCalled();
    expect(mocks.uploadPreview).not.toHaveBeenCalled();
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
    expect(mocks.signGalleryPreviews).toHaveBeenCalledWith(galleryRecord);
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
    expect(mocks.rejectStudioMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaId,
        rejectionCode: "validation_failed",
        userId: studioTestIds.userId,
      }),
    );
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
    expect(mocks.rejectStudioMediaUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaId,
        rejectionCode: "object_missing",
        userId: studioTestIds.userId,
      }),
    );
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
  });

  it("terminalizes a prepared upload before exposing a concurrent revision conflict", async () => {
    const conflict = {
      code: "40001",
      message: "studio_revision_conflict",
    };
    mocks.readStudioMediaUploadCandidate.mockRejectedValueOnce(conflict);
    const command = {
      action: "studio.media.upload.finalize",
      expectedScope: studioTestIds.userId,
      idempotencyKey: studioTestIds.idempotencyKey,
      payload: { ...boundary, mediaId },
    } as const;

    await expect(executeStudioMediaCommand(command, context)).rejects.toBe(conflict);
    expect(mocks.rejectStudioMediaUpload).toHaveBeenCalledWith({
      ...command.payload,
      idempotencyKey: studioTestIds.idempotencyKey,
      rejectionCode: "superseded",
      requestId: studioTestIds.requestId,
      userId: studioTestIds.userId,
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.finalizeStudioMediaUpload).not.toHaveBeenCalled();
    expect(mocks.handleStudioDatabaseError).toHaveBeenCalledWith(conflict);
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
