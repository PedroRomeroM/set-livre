import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ poolOn: vi.fn(), query: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class Pool {
    on = mocks.poolOn;
    query = mocks.query;
  },
}));

import {
  createStudioDraft,
  discardStudioDraft,
  updateStudioRevisionContent,
  updateStudioRevisionCore,
  updateStudioRevisionTaxonomy,
} from "../../src/domains/studios/server/studio-dal";
import { studioCoreFixture, studioEditorFixture, studioTestIds } from "./studio-test-fixture";

describe("studio DAL", () => {
  beforeAll(() => {
    process.env.DATABASE_URL_APP_DAL =
      "postgresql://app_runtime:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [{ result: studioEditorFixture }] });
  });

  it("passes only normalized scalar values to the create facade", async () => {
    await expect(
      createStudioDraft({
        core: studioCoreFixture,
        idempotencyKey: studioTestIds.idempotencyKey,
        requestId: studioTestIds.requestId,
        userId: studioTestIds.userId,
      }),
    ).resolves.toEqual(studioEditorFixture);

    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("private.create_studio"), [
      studioTestIds.userId,
      studioTestIds.idempotencyKey,
      studioTestIds.requestId,
      studioCoreFixture.name,
      studioCoreFixture.description,
      studioCoreFixture.street,
      studioCoreFixture.streetNumber,
      null,
      studioCoreFixture.neighborhood,
      "Curitiba",
      "PR",
      studioCoreFixture.postalCode,
      studioCoreFixture.capacity,
      studioCoreFixture.studioTypeId,
    ]);
  });

  it("binds optimistic identity before core values on update and discard", async () => {
    await updateStudioRevisionCore({
      core: studioCoreFixture,
      expectedRevisionId: studioTestIds.revisionId,
      expectedRevisionVersion: 3,
      idempotencyKey: studioTestIds.idempotencyKey,
      requestId: studioTestIds.requestId,
      studioId: studioTestIds.studioId,
      userId: studioTestIds.userId,
    });
    expect(mocks.query.mock.calls[0]?.[1]?.slice(0, 6)).toEqual([
      studioTestIds.userId,
      studioTestIds.studioId,
      studioTestIds.revisionId,
      3,
      studioTestIds.idempotencyKey,
      studioTestIds.requestId,
    ]);

    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          result: {
            scope: studioTestIds.userId,
            studioDeleted: true,
            studioId: studioTestIds.studioId,
          },
        },
      ],
    });
    await discardStudioDraft({
      expectedRevisionId: studioTestIds.revisionId,
      expectedRevisionVersion: 3,
      idempotencyKey: studioTestIds.idempotencyKey,
      requestId: studioTestIds.requestId,
      studioId: studioTestIds.studioId,
      userId: studioTestIds.userId,
    });
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("private.discard_studio_draft"),
      [
        studioTestIds.userId,
        studioTestIds.studioId,
        studioTestIds.revisionId,
        3,
        studioTestIds.idempotencyKey,
        studioTestIds.requestId,
      ],
    );
  });

  it("fails closed on unexpected cardinality or DTO drift", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      createStudioDraft({
        core: studioCoreFixture,
        idempotencyKey: studioTestIds.idempotencyKey,
        requestId: studioTestIds.requestId,
        userId: studioTestIds.userId,
      }),
    ).rejects.toThrow("cardinalidade inesperada");

    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { ...studioEditorFixture, ownerTaxId: "52998224725" } }],
    });
    await expect(
      createStudioDraft({
        core: studioCoreFixture,
        idempotencyKey: studioTestIds.idempotencyKey,
        requestId: studioTestIds.requestId,
        userId: studioTestIds.userId,
      }),
    ).rejects.toThrow();
  });

  it("binds taxonomy sets and serializes ordered FAQ only at the JSONB boundary", async () => {
    await updateStudioRevisionTaxonomy({
      expectedRevisionId: studioTestIds.revisionId,
      expectedRevisionVersion: 3,
      idempotencyKey: studioTestIds.idempotencyKey,
      requestId: studioTestIds.requestId,
      studioId: studioTestIds.studioId,
      taxonomy: {
        amenityIds: [studioTestIds.amenityId],
        tagIds: [studioTestIds.tagId],
      },
      userId: studioTestIds.userId,
    });
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("private.update_studio_revision_taxonomy"),
      [
        studioTestIds.userId,
        studioTestIds.studioId,
        studioTestIds.revisionId,
        3,
        studioTestIds.idempotencyKey,
        studioTestIds.requestId,
        [studioTestIds.tagId],
        [studioTestIds.amenityId],
      ],
    );

    const faqs = [{ answer: "Resposta.", question: "Pergunta?" }];
    await updateStudioRevisionContent({
      content: { faqs, usageRules: "Regras seguras.", youtubeVideoId: "dQw4w9WgXcQ" },
      expectedRevisionId: studioTestIds.revisionId,
      expectedRevisionVersion: 4,
      idempotencyKey: studioTestIds.idempotencyKey,
      requestId: studioTestIds.requestId,
      studioId: studioTestIds.studioId,
      userId: studioTestIds.userId,
    });
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining("private.update_studio_revision_content"),
      [
        studioTestIds.userId,
        studioTestIds.studioId,
        studioTestIds.revisionId,
        4,
        studioTestIds.idempotencyKey,
        studioTestIds.requestId,
        "Regras seguras.",
        "dQw4w9WgXcQ",
        JSON.stringify(faqs),
      ],
    );
  });
});
