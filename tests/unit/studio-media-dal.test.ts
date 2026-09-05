import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../../src/lib/server/dal-pool", () => ({
  commandDalPool: () => ({ connect: mocks.connect, query: mocks.query }),
}));

import {
  confirmStudioMediaFinalizeResult,
  confirmStudioMediaUploadToken,
  deleteStudioMedia,
  finalizeStudioMediaUpload,
  prepareStudioMediaUpload,
  readOwnerStudioMediaRecord,
  rejectUnsignedStudioMediaUpload,
  rejectStudioMediaUpload,
  renewStudioMediaFinalizeClaim,
  reorderStudioMedia,
  setStudioMediaCover,
  StudioMediaFinalizeClaimBusyError,
  withStudioMediaFinalizeClaim,
} from "../../src/domains/studios/server/studio-media-dal";
import { studioTestIds } from "./studio-test-fixture";

const mediaId = "88000000-0000-4000-8000-000000000001";
const claimToken = "88000000-0000-4000-8000-000000000002";
const leaseExpiresAt = "2026-08-31T12:00:30.000Z";
const path = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.png`;
const previewPath = `owners/${studioTestIds.userId}/studios/${studioTestIds.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.preview.webp`;
const expiresAt = "2026-08-31T12:00:00.000Z";
const issuedAt = "2026-08-31T10:00:01.000Z";
const rejectedAt = "2026-08-31T10:00:02.000Z";
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
const candidate = {
  ...preparation,
  declaredByteSize: 68,
  declaredChecksumSha256: null,
  declaredMimeType: "image/png" as const,
  previewPath,
};
const gallery = {
  canEdit: true,
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
  revisionStatus: "draft" as const,
  revisionVersion: 4,
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
};
const prepareResult = {
  action: "studio.media.upload.prepare",
  idempotencyKey: studioTestIds.idempotencyKey,
  result: preparation,
} as const;
const finalizeResult = {
  action: "studio.media.upload.finalize",
  idempotencyKey: studioTestIds.idempotencyKey,
  result: gallery,
} as const;

describe("studio media DAL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockReset().mockResolvedValue({ rows: [{ result: gallery }] });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    mocks.query.mockResolvedValueOnce({ rows: [{ result: prepareResult }] });

    await expect(
      prepareStudioMediaUpload({
        ...command,
        ...revision,
        declaredByteSize: 68,
        declaredChecksumSha256: null,
        declaredMimeType: "image/png",
      }),
    ).resolves.toEqual(prepareResult);

    expect(mocks.query.mock.calls[0]?.[0]).toContain(
      "private.bind_studio_command_result($1::uuid, $5::uuid, private.prepare_studio_media_upload",
    );

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

  it("settles upload-token delivery only through the narrow app_dal routines", async () => {
    const issued = {
      issuedAt,
      mediaId,
      revisionId: studioTestIds.revisionId,
      revisionVersion: 3,
      scope: studioTestIds.userId,
      state: "issued" as const,
      studioId: studioTestIds.studioId,
    };
    const rejected = {
      mediaId,
      rejectedAt,
      revisionId: studioTestIds.revisionId,
      revisionVersion: 3,
      scope: studioTestIds.userId,
      state: "rejected" as const,
      studioId: studioTestIds.studioId,
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ result: issued }] })
      .mockResolvedValueOnce({ rows: [{ result: rejected }] });

    await expect(
      confirmStudioMediaUploadToken({
        ...revision,
        mediaId,
        userId: studioTestIds.userId,
      }),
    ).resolves.toEqual(issued);
    await expect(
      rejectUnsignedStudioMediaUpload({
        ...revision,
        mediaId,
        requestId: studioTestIds.requestId,
        userId: studioTestIds.userId,
      }),
    ).resolves.toEqual(rejected);

    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("private.confirm_studio_media_upload_token"),
      [studioTestIds.userId, studioTestIds.studioId, studioTestIds.revisionId, 3, mediaId],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("private.reject_unsigned_studio_media_upload"),
      [
        studioTestIds.userId,
        studioTestIds.studioId,
        studioTestIds.revisionId,
        3,
        mediaId,
        studioTestIds.requestId,
      ],
    );
  });

  it("projects only the claim token into lease checks and fenced terminal writes", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ result: { leaseExpiresAt } }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ result: gallery }] });

    await expect(renewStudioMediaFinalizeClaim({ claimToken })).resolves.toEqual({
      leaseExpiresAt,
    });
    await expect(
      rejectStudioMediaUpload({
        claimToken,
        requestId: studioTestIds.requestId,
        rejectionCode: "superseded",
      }),
    ).resolves.toBeUndefined();
    await expect(
      finalizeStudioMediaUpload({
        claimToken,
        requestId: studioTestIds.requestId,
        verification: {
          byteSize: 68,
          checksumSha256: "a".repeat(64),
          height: 1,
          mimeType: "image/png",
          width: 1,
        },
      }),
    ).resolves.toEqual(gallery);

    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("private.renew_studio_media_finalize_claim");
    expect(mocks.query.mock.calls[1]?.[0]).toContain("private.reject_studio_media_upload_claimed");
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      claimToken,
      studioTestIds.requestId,
      "superseded",
    ]);
    expect(mocks.query.mock.calls[2]?.[0]).toContain(
      "private.finalize_studio_media_upload_claimed",
    );
    expect(mocks.query.mock.calls[2]?.[1]).toEqual([
      claimToken,
      studioTestIds.requestId,
      "image/png",
      68,
      1,
      1,
      "a".repeat(64),
    ]);
  });

  it("projects strict identities for every gallery mutation", async () => {
    const reorderResult = { ...finalizeResult, action: "studio.media.reorder" };
    const coverResult = { ...finalizeResult, action: "studio.media.cover.set" };
    const deleteResult = { ...finalizeResult, action: "studio.media.delete" };
    mocks.query
      .mockResolvedValueOnce({ rows: [{ result: reorderResult }] })
      .mockResolvedValueOnce({ rows: [{ result: coverResult }] })
      .mockResolvedValueOnce({ rows: [{ result: deleteResult }] });
    await expect(
      reorderStudioMedia({ ...command, ...revision, orderedMediaIds: [mediaId] }),
    ).resolves.toEqual(reorderResult);
    await expect(setStudioMediaCover({ ...command, ...revision, mediaId })).resolves.toEqual(
      coverResult,
    );
    await expect(deleteStudioMedia({ ...command, ...revision, mediaId })).resolves.toEqual(
      deleteResult,
    );

    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("private.reorder_studio_media"),
      expect.stringContaining("private.set_studio_media_cover"),
      expect.stringContaining("private.delete_studio_media"),
    ]);
    for (const [sql, values] of mocks.query.mock.calls) {
      expect(sql).toContain("private.bind_studio_command_result($1::uuid, $5::uuid,");
      expect(values.slice(0, 6)).toEqual([
        studioTestIds.userId,
        studioTestIds.studioId,
        studioTestIds.revisionId,
        3,
        studioTestIds.idempotencyKey,
        studioTestIds.requestId,
      ]);
    }
  });

  it("confirms the finalized gallery against the attempt ledger without echoing its identity", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ result: finalizeResult }] });
    await expect(
      confirmStudioMediaFinalizeResult(
        {
          userId: studioTestIds.userId,
          idempotencyKey: studioTestIds.idempotencyKey,
        },
        gallery,
      ),
    ).resolves.toEqual(finalizeResult);
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(
      "select private.bind_studio_command_result($1::uuid, $2::uuid, $3::jsonb) as result",
      [studioTestIds.userId, studioTestIds.idempotencyKey, expect.any(String)],
    );
    expect(JSON.parse(mocks.query.mock.calls[0]?.[1]?.[2])).toEqual(gallery);
  });

  describe.each([
    {
      name: "prepare",
      attempt: prepareResult,
      execute: () =>
        prepareStudioMediaUpload({
          ...command,
          ...revision,
          declaredByteSize: 68,
          declaredChecksumSha256: null,
          declaredMimeType: "image/png",
        }),
    },
    {
      name: "reorder",
      attempt: { ...finalizeResult, action: "studio.media.reorder" },
      execute: () => reorderStudioMedia({ ...command, ...revision, orderedMediaIds: [mediaId] }),
    },
    {
      name: "cover",
      attempt: { ...finalizeResult, action: "studio.media.cover.set" },
      execute: () => setStudioMediaCover({ ...command, ...revision, mediaId }),
    },
    {
      name: "delete",
      attempt: { ...finalizeResult, action: "studio.media.delete" },
      execute: () => deleteStudioMedia({ ...command, ...revision, mediaId }),
    },
    {
      name: "finalize confirmation",
      attempt: finalizeResult,
      execute: () =>
        confirmStudioMediaFinalizeResult(
          { userId: studioTestIds.userId, idempotencyKey: studioTestIds.idempotencyKey },
          gallery,
        ),
    },
  ])("$name attempt binding", ({ attempt, execute }) => {
    it.each([
      { name: "missing identity", response: attempt.result, failure: { name: "ZodError" } },
      {
        name: "same-owner same-target sibling key",
        response: { ...attempt, idempotencyKey: "33333333-3333-4333-8333-333333333334" },
        failure: { code: "SERVICE_UNAVAILABLE", status: 503 },
      },
      {
        name: "wrong action",
        response: { ...attempt, action: "studio.revision.updateCore" },
        failure: { code: "SERVICE_UNAVAILABLE", status: 503 },
      },
    ])("rejects $name even when the terminal DTO is valid", async ({ response, failure }) => {
      mocks.query.mockResolvedValueOnce({ rows: [{ result: response }] });
      await expect(execute()).rejects.toMatchObject(failure);
      expect(mocks.query).toHaveBeenCalledOnce();
    });
  });

  it("keeps external work outside a checked-out pool session and releases its lease", async () => {
    let finishWork: ((value: typeof gallery) => void) | undefined;
    const pendingWork = new Promise<typeof gallery>((resolve) => {
      finishWork = resolve;
    });
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ result: { candidate, claimToken, leaseExpiresAt, state: "acquired" } }],
      })
      .mockResolvedValueOnce({ rows: [{ result: "unrelated-command" }] })
      .mockResolvedValueOnce({ rows: [{ result: true }] });
    const work = vi.fn(async () => pendingWork);
    const operation = withStudioMediaFinalizeClaim({ ...command, ...revision, mediaId }, work);

    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    await expect(mocks.query("select unrelated_command() as result")).resolves.toEqual({
      rows: [{ result: "unrelated-command" }],
    });
    finishWork?.(gallery);
    await expect(operation).resolves.toEqual(gallery);

    expect(mocks.connect).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledWith({
      candidate,
      claimToken,
      leaseExpiresAt,
      state: "acquired",
    });
    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("private.begin_studio_media_finalize_claim"),
      [
        studioTestIds.userId,
        studioTestIds.studioId,
        studioTestIds.revisionId,
        3,
        studioTestIds.idempotencyKey,
        studioTestIds.requestId,
        mediaId,
      ],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("private.release_studio_media_finalize_claim"),
      [claimToken],
    );
  });

  it("returns a terminal replay without creating or releasing a lease", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { result: gallery, state: "replay" } }],
    });
    type FinalizeClaim = Parameters<Parameters<typeof withStudioMediaFinalizeClaim>[1]>[0];
    const work = vi.fn(async (claim: FinalizeClaim) =>
      claim.state === "replay" ? claim.result : null,
    );

    await expect(
      withStudioMediaFinalizeClaim({ ...command, ...revision, mediaId }, work),
    ).resolves.toEqual(gallery);

    expect(work).toHaveBeenCalledWith({ result: gallery, state: "replay" });
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("returns a terminal rejection without reopening or releasing a lease", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { rejectionCode: "validation_failed", state: "rejected" } }],
    });
    type FinalizeClaim = Parameters<Parameters<typeof withStudioMediaFinalizeClaim>[1]>[0];
    const work = vi.fn(async (claim: FinalizeClaim) => claim);

    await expect(
      withStudioMediaFinalizeClaim({ ...command, ...revision, mediaId }, work),
    ).resolves.toEqual({ rejectionCode: "validation_failed", state: "rejected" });

    expect(work).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("waits using the database hint and then acquires a fresh fenced lease", async () => {
    vi.useFakeTimers();
    mocks.query
      .mockResolvedValueOnce({ rows: [{ result: { retryAfterMs: 50, state: "waiting" } }] })
      .mockResolvedValueOnce({
        rows: [{ result: { candidate, claimToken, leaseExpiresAt, state: "acquired" } }],
      })
      .mockResolvedValueOnce({ rows: [{ result: true }] });
    const work = vi.fn(async () => gallery);
    const operation = withStudioMediaFinalizeClaim({ ...command, ...revision, mediaId }, work);

    await vi.advanceTimersByTimeAsync(50);
    await expect(operation).resolves.toEqual(gallery);

    expect(work).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("fails closed after the bounded wait without releasing another worker's lease", async () => {
    vi.useFakeTimers();
    mocks.query.mockResolvedValue({
      rows: [{ result: { retryAfterMs: 250, state: "waiting" } }],
    });
    const work = vi.fn(async () => gallery);
    const operation = withStudioMediaFinalizeClaim({ ...command, ...revision, mediaId }, work);
    const rejection = expect(operation).rejects.toBeInstanceOf(StudioMediaFinalizeClaimBusyError);

    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;

    expect(work).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes("private.release_studio_media_finalize_claim"),
      ),
    ).toBe(false);
  });

  it("fails closed when a successful callback can no longer prove lease release", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ result: { candidate, claimToken, leaseExpiresAt, state: "acquired" } }],
      })
      .mockResolvedValueOnce({ rows: [{ result: false }] });

    await expect(
      withStudioMediaFinalizeClaim({ ...command, ...revision, mediaId }, async () => gallery),
    ).rejects.toBeInstanceOf(StudioMediaFinalizeClaimBusyError);
  });

  it("preserves the canonical callback failure when lease cleanup is temporarily unavailable", async () => {
    const workError = new Error("storage unavailable");
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ result: { candidate, claimToken, leaseExpiresAt, state: "acquired" } }],
      })
      .mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      withStudioMediaFinalizeClaim({ ...command, ...revision, mediaId }, async () => {
        throw workError;
      }),
    ).rejects.toBe(workError);
  });

  it("rejects a malformed claim response without running external work", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { unexpected: true, state: "acquired" } }],
    });
    const work = vi.fn(async () => gallery);

    await expect(
      withStudioMediaFinalizeClaim({ ...command, ...revision, mediaId }, work),
    ).rejects.toThrow();

    expect(work).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledOnce();
  });
});
