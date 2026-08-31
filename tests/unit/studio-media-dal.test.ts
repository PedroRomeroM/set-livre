import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../src/lib/server/dal-pool", () => ({
  commandDalPool: () => ({ query: mocks.query }),
}));

import {
  deleteStudioMedia,
  finalizeStudioMediaUpload,
  prepareStudioMediaUpload,
  readOwnerStudioMediaRecord,
  readStudioMediaUploadCandidate,
  rejectStudioMediaUpload,
  reorderStudioMedia,
  replayStudioMediaFinalize,
  setStudioMediaCover,
} from "../../src/domains/studios/server/studio-media-dal";
import { studioTestIds } from "./studio-test-fixture";

const mediaId = "88000000-0000-4000-8000-000000000001";
const path = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.png`;
const previewPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.preview.webp`;
const expiresAt = "2026-08-31T12:00:00.000Z";
const revision = {
  expectedRevisionId: studioTestIds.revisionId,
  expectedRevisionVersion: 3,
  studioId: studioTestIds.studioId,
};
const command = {
  idempotencyKey: studioTestIds.idempotencyKey,
  requestId: studioTestIds.requestId,
  userId: studioTestIds.userId,
};
const preparation = {
  bucket: "studio-media" as const,
  expiresAt,
  mediaId,
  path,
  revisionId: studioTestIds.revisionId,
  revisionVersion: 3,
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
};
const gallery = {
  items: [
    {
      byteSize: 68,
      checksumSha256: "a".repeat(64),
      height: 1,
      id: mediaId,
      isCover: true,
      mimeType: "image/png" as const,
      position: 1,
      previewStoragePath: previewPath,
      width: 1,
    },
  ],
  revisionId: studioTestIds.revisionId,
  revisionNumber: 1,
  revisionVersion: 4,
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
};

describe("studio media DAL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [{ result: gallery }] });
  });

  it("reads private paths only through the scoped app_dal routine", async () => {
    await expect(
      readOwnerStudioMediaRecord({
        studioId: studioTestIds.studioId,
        userId: studioTestIds.userId,
      }),
    ).resolves.toEqual(gallery);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("private.get_owner_studio_media"),
      [studioTestIds.userId, studioTestIds.studioId],
    );
  });

  it("projects strict identities from the complete prepare envelope", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ result: preparation }] });

    await expect(
      prepareStudioMediaUpload({
        ...command,
        ...revision,
        declaredByteSize: 68,
        declaredChecksumSha256: null,
        declaredMimeType: "image/png",
      }),
    ).resolves.toEqual(preparation);

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("private.prepare_studio_media_upload"),
      [
        studioTestIds.userId,
        studioTestIds.studioId,
        studioTestIds.revisionId,
        3,
        studioTestIds.idempotencyKey,
        studioTestIds.requestId,
        "image/png",
        68,
        null,
      ],
    );
  });

  it("projects strict identities for upload verification and replay", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            result: {
              ...preparation,
              declaredByteSize: 68,
              declaredChecksumSha256: null,
              declaredMimeType: "image/png",
              previewPath,
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ result: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ result: gallery }] });

    await expect(
      readStudioMediaUploadCandidate({ ...revision, mediaId, userId: studioTestIds.userId }),
    ).resolves.toMatchObject({ mediaId, previewPath });
    await expect(
      replayStudioMediaFinalize({ ...command, ...revision, mediaId }),
    ).resolves.toBeNull();
    await expect(
      rejectStudioMediaUpload({
        ...revision,
        mediaId,
        rejectionCode: "object_missing",
        requestId: studioTestIds.requestId,
        userId: studioTestIds.userId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      finalizeStudioMediaUpload({
        ...command,
        ...revision,
        mediaId,
        verification: {
          byteSize: 68,
          checksumSha256: "a".repeat(64),
          height: 1,
          mimeType: "image/png",
          width: 1,
        },
      }),
    ).resolves.toEqual(gallery);

    expect(mocks.query).toHaveBeenCalledTimes(4);
    expect(mocks.query.mock.calls[2]?.[1]).toEqual([
      studioTestIds.userId,
      studioTestIds.studioId,
      studioTestIds.revisionId,
      3,
      mediaId,
      studioTestIds.requestId,
      "object_missing",
    ]);
  });

  it("projects strict identities for every gallery mutation", async () => {
    await expect(
      reorderStudioMedia({ ...command, ...revision, orderedMediaIds: [mediaId] }),
    ).resolves.toEqual(gallery);
    await expect(setStudioMediaCover({ ...command, ...revision, mediaId })).resolves.toEqual(
      gallery,
    );
    await expect(deleteStudioMedia({ ...command, ...revision, mediaId })).resolves.toEqual(gallery);

    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("private.reorder_studio_media"),
      expect.stringContaining("private.set_studio_media_cover"),
      expect.stringContaining("private.delete_studio_media"),
    ]);
  });
});
