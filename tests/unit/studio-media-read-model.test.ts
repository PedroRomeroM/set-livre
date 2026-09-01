import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createTrustedStudioMediaStorage: vi.fn(),
  readOwnerStudioMediaRecord: vi.fn(),
  signGalleryPreviews: vi.fn(),
}));

vi.mock("../../src/domains/studios/server/studio-media-dal", () => ({
  readOwnerStudioMediaRecord: mocks.readOwnerStudioMediaRecord,
}));

vi.mock("../../src/domains/studios/server/studio-media-storage", () => ({
  createTrustedStudioMediaStorage: mocks.createTrustedStudioMediaStorage,
  studioMediaPreviewSigningDeadlineMs: 2_000,
}));

import {
  readOwnerStudioMedia,
  StudioMediaNotFoundError,
} from "../../src/domains/studios/server/studio-media-read-model";
import { studioTestIds } from "./studio-test-fixture";

const mediaId = "88888888-8888-4888-8888-888888888888";
const previewStoragePath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.preview.webp`;
const galleryRecord = {
  canEdit: true,
  items: [
    {
      byteSize: 512,
      checksumSha256: "8".repeat(64),
      height: 720,
      id: mediaId,
      isCover: true,
      mimeType: "image/jpeg" as const,
      position: 1,
      previewStoragePath,
      width: 1280,
    },
  ],
  revisionId: studioTestIds.revisionId,
  revisionNumber: 1,
  revisionStatus: "draft" as const,
  revisionVersion: 3,
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

describe("studio media read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTrustedStudioMediaStorage.mockReturnValue({
      signGalleryPreviews: mocks.signGalleryPreviews,
    });
    mocks.readOwnerStudioMediaRecord.mockResolvedValue(galleryRecord);
    mocks.signGalleryPreviews.mockResolvedValue(gallery);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps the strict owner projection and signs only the resulting previews", async () => {
    await expect(
      readOwnerStudioMedia(studioTestIds.userId, studioTestIds.studioId),
    ).resolves.toEqual(gallery);
    expect(mocks.readOwnerStudioMediaRecord).toHaveBeenCalledWith({
      studioId: studioTestIds.studioId,
      userId: studioTestIds.userId,
    });
    expect(mocks.signGalleryPreviews).toHaveBeenCalledWith(galleryRecord, expect.any(AbortSignal));
  });

  it("returns safe not-found semantics and rejects projection boundary drift", async () => {
    mocks.readOwnerStudioMediaRecord.mockResolvedValueOnce(null);
    await expect(
      readOwnerStudioMedia(studioTestIds.userId, studioTestIds.studioId),
    ).rejects.toBeInstanceOf(StudioMediaNotFoundError);

    mocks.readOwnerStudioMediaRecord.mockResolvedValueOnce({
      ...galleryRecord,
      items: [],
      scope: studioTestIds.otherUserId,
    });
    await expect(
      readOwnerStudioMedia(studioTestIds.userId, studioTestIds.studioId),
    ).rejects.toThrow("fronteira diferente");

    mocks.readOwnerStudioMediaRecord.mockResolvedValueOnce({
      ...galleryRecord,
      privateOwnerEmail: "owner@example.test",
    });
    await expect(
      readOwnerStudioMedia(studioTestIds.userId, studioTestIds.studioId),
    ).rejects.toThrow();
    expect(mocks.signGalleryPreviews).not.toHaveBeenCalled();
  });

  it("mantém a assinatura em lote dentro do mesmo deadline da leitura", async () => {
    vi.useFakeTimers();
    let signingSignal: AbortSignal | undefined;
    mocks.signGalleryPreviews.mockImplementationOnce((_gallery: unknown, signal: AbortSignal) => {
      signingSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const result = readOwnerStudioMedia(studioTestIds.userId, studioTestIds.studioId);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(2_001);
    await rejection;
    expect(signingSignal?.aborted).toBe(true);
  });
});
