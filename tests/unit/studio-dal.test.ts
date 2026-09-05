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

const createResult = {
  action: "studio.create",
  idempotencyKey: studioTestIds.idempotencyKey,
  result: studioEditorFixture,
} as const;

describe("studio DAL", () => {
  beforeAll(() => {
    process.env.DATABASE_URL_APP_DAL =
      "postgresql://app_runtime_local:local-password@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal";
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockReset().mockResolvedValue({ rows: [{ result: createResult }] });
  });

  it("passes only normalized scalar values to the create facade", async () => {
    await expect(
      createStudioDraft({
        core: studioCoreFixture,
        idempotencyKey: studioTestIds.idempotencyKey,
        requestId: studioTestIds.requestId,
        userId: studioTestIds.userId,
      }),
    ).resolves.toEqual(createResult);

    expect(mocks.query.mock.calls[0]?.[0]).toContain(
      "private.bind_studio_command_result($1::uuid, $2::uuid, private.create_studio",
    );

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

  it("matches an uppercase submitted key to the lowercase ledger without rewriting SQL arguments", async () => {
    const persistedKey = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const input = {
      core: studioCoreFixture,
      idempotencyKey: persistedKey.toUpperCase(),
      requestId: studioTestIds.requestId,
      userId: studioTestIds.userId,
    };
    const confirmed = { ...createResult, idempotencyKey: persistedKey };
    mocks.query.mockResolvedValueOnce({ rows: [{ result: confirmed }] });
    await expect(createStudioDraft(input)).resolves.toEqual(confirmed);
    expect(mocks.query.mock.calls[0]?.[1]?.[1]).toBe(input.idempotencyKey);
    mocks.query.mockResolvedValueOnce({ rows: [{ result: createResult }] });
    await expect(createStudioDraft(input)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("binds optimistic identity before core values on update and discard", async () => {
    const updateResult = { ...createResult, action: "studio.revision.updateCore" };
    mocks.query.mockResolvedValueOnce({ rows: [{ result: updateResult }] });
    await expect(
      updateStudioRevisionCore({
        core: studioCoreFixture,
        expectedRevisionId: studioTestIds.revisionId,
        expectedRevisionVersion: 3,
        idempotencyKey: studioTestIds.idempotencyKey,
        requestId: studioTestIds.requestId,
        studioId: studioTestIds.studioId,
        userId: studioTestIds.userId,
      }),
    ).resolves.toEqual(updateResult);
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
            action: "studio.draft.discard",
            idempotencyKey: studioTestIds.idempotencyKey,
            result: {
              scope: studioTestIds.userId,
              studioDeleted: true,
              studioId: studioTestIds.studioId,
            },
          },
        },
      ],
    });
    await expect(
      discardStudioDraft({
        expectedRevisionId: studioTestIds.revisionId,
        expectedRevisionVersion: 3,
        idempotencyKey: studioTestIds.idempotencyKey,
        requestId: studioTestIds.requestId,
        studioId: studioTestIds.studioId,
        userId: studioTestIds.userId,
      }),
    ).resolves.toEqual({
      action: "studio.draft.discard",
      idempotencyKey: studioTestIds.idempotencyKey,
      result: {
        scope: studioTestIds.userId,
        studioDeleted: true,
        studioId: studioTestIds.studioId,
      },
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
      rows: [
        {
          result: {
            ...createResult,
            result: { ...studioEditorFixture, ownerTaxId: "52998224725" },
          },
        },
      ],
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
    const taxonomyResult = { ...createResult, action: "studio.revision.updateTaxonomy" };
    mocks.query.mockResolvedValueOnce({ rows: [{ result: taxonomyResult }] });
    await expect(
      updateStudioRevisionTaxonomy({
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
      }),
    ).resolves.toEqual(taxonomyResult);
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
    const contentResult = { ...createResult, action: "studio.revision.updateContent" };
    mocks.query.mockResolvedValueOnce({ rows: [{ result: contentResult }] });
    await expect(
      updateStudioRevisionContent({
        content: { faqs, usageRules: "Regras seguras.", youtubeVideoId: "dQw4w9WgXcQ" },
        expectedRevisionId: studioTestIds.revisionId,
        expectedRevisionVersion: 4,
        idempotencyKey: studioTestIds.idempotencyKey,
        requestId: studioTestIds.requestId,
        studioId: studioTestIds.studioId,
        userId: studioTestIds.userId,
      }),
    ).resolves.toEqual(contentResult);
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
  it.each([
    { name: "missing identity", result: studioEditorFixture, failure: { name: "ZodError" } },
    {
      name: "sibling attempt by the same owner",
      result: { ...createResult, idempotencyKey: "33333333-3333-4333-8333-333333333334" },
      failure: { code: "SERVICE_UNAVAILABLE", status: 503 },
    },
    {
      name: "different action",
      result: { ...createResult, action: "studio.revision.updateCore" },
      failure: { code: "SERVICE_UNAVAILABLE", status: 503 },
    },
    {
      name: "different owner",
      result: {
        ...createResult,
        result: { ...studioEditorFixture, scope: studioTestIds.otherUserId },
      },
      failure: { message: "A confirmação retornou outro escopo." },
    },
  ])(
    "rejects $name rather than rebinding a valid DTO to the request",
    async ({ result, failure }) => {
      mocks.query.mockResolvedValueOnce({ rows: [{ result }] });
      await expect(
        createStudioDraft({
          core: studioCoreFixture,
          idempotencyKey: studioTestIds.idempotencyKey,
          requestId: studioTestIds.requestId,
          userId: studioTestIds.userId,
        }),
      ).rejects.toMatchObject(failure);
      expect(mocks.query).toHaveBeenCalledOnce();
    },
  );
});
