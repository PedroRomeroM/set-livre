import {
  studioCommandActionSchema,
  studioCommandResultSchema,
  studioDraftDiscardResultSchema,
  studioEditorSchema,
  studioMediaGallerySchema,
  studioMediaUploadPreparationSchema,
  type StudioCommandAction,
} from "@set-livre/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  changeStudioPublication,
  createStudio,
  deleteStudioMedia,
  discardStudioDraft,
  finalizeStudioMediaUpload,
  isAmbiguousStudioError,
  prepareStudioMediaUpload,
  reorderStudioMedia,
  setStudioMediaCover,
  StudioApiError,
  updateStudioContent,
  updateStudioCore,
  updateStudioTaxonomy,
} from "../../src/domains/studios/components/studio-api";
import { createStudioPublicationFixture } from "./studio-publication-test-fixture";
import { studioCoreFixture, studioEditorFixture, studioTestIds } from "./studio-test-fixture";

type ResponseBoundary = Readonly<{ scope: string; studioId: string }>;
const boundary: ResponseBoundary = {
  scope: studioTestIds.userId,
  studioId: studioTestIds.studioId,
};
const envelope = {
  expectedScope: studioTestIds.userId,
  idempotencyKey: studioTestIds.idempotencyKey,
};
const revision = {
  expectedRevisionId: studioTestIds.revisionId,
  expectedRevisionVersion: 1,
  studioId: studioTestIds.studioId,
};
const mediaId = "88888888-8888-4888-8888-888888888888";
const discardCommand = {
  ...envelope,
  action: "studio.draft.discard",
  payload: revision,
} satisfies Parameters<typeof discardStudioDraft>[0];
const createCommand = {
  ...envelope,
  action: "studio.create",
  payload: studioCoreFixture,
} satisfies Parameters<typeof createStudio>[0];

function editorFor(expected: ResponseBoundary) {
  return studioEditorSchema.parse({ ...studioEditorFixture, ...expected });
}

function galleryFor(expected: ResponseBoundary) {
  return studioMediaGallerySchema.parse({
    ...expected,
    canEdit: true,
    items: [],
    previewExpiresAt: "2026-09-05T20:05:00.000Z",
    revisionId: studioTestIds.revisionId,
    revisionNumber: 1,
    revisionStatus: "draft",
    revisionVersion: 1,
  });
}

type CommandResponseCase = Readonly<{
  action: StudioCommandAction;
  name: string;
  request: () => Promise<unknown>;
  resultFor: (expected: ResponseBoundary) => ResponseBoundary;
}>;

const existingStudioCases: readonly CommandResponseCase[] = [
  {
    action: "studio.revision.updateCore",
    name: "updateCore",
    request: () =>
      updateStudioCore({
        ...envelope,
        action: "studio.revision.updateCore",
        payload: { ...studioCoreFixture, ...revision },
      }),
    resultFor: editorFor,
  },
  {
    action: "studio.revision.updateTaxonomy",
    name: "updateTaxonomy",
    request: () =>
      updateStudioTaxonomy({
        ...envelope,
        action: "studio.revision.updateTaxonomy",
        payload: { ...revision, amenityIds: [], tagIds: [] },
      }),
    resultFor: editorFor,
  },
  {
    action: "studio.revision.updateContent",
    name: "updateContent",
    request: () =>
      updateStudioContent({
        ...envelope,
        action: "studio.revision.updateContent",
        payload: {
          ...revision,
          faqs: [],
          usageRules: "Regras de uso preservadas.",
          youtubeVideoId: null,
        },
      }),
    resultFor: editorFor,
  },
  ...([true, false] as const).map((studioDeleted) => ({
    action: "studio.draft.discard" as const,
    name: `discard studioDeleted=${studioDeleted}`,
    request: () => discardStudioDraft(discardCommand),
    resultFor: (expected: ResponseBoundary) =>
      studioDraftDiscardResultSchema.parse({
        ...expected,
        studioDeleted,
        ...(studioDeleted ? {} : { editor: editorFor(expected) }),
      }),
  })),
  ...(["studio.pause", "studio.resume", "studio.revision.submit"] as const).map((action) => ({
    action,
    name: action,
    request: () =>
      changeStudioPublication(
        action === "studio.revision.submit"
          ? { ...envelope, action, payload: revision }
          : {
              ...envelope,
              action,
              payload: { expectedPublicationVersion: 1, studioId: studioTestIds.studioId },
            },
      ),
    resultFor: (expected: ResponseBoundary) => createStudioPublicationFixture(expected),
  })),
  {
    action: "studio.media.upload.prepare",
    name: "media upload prepare",
    request: () =>
      prepareStudioMediaUpload({
        ...envelope,
        action: "studio.media.upload.prepare",
        payload: {
          ...revision,
          declaredByteSize: 120_000,
          declaredChecksumSha256: null,
          declaredMimeType: "image/jpeg",
        },
      }),
    resultFor: (expected: ResponseBoundary) =>
      studioMediaUploadPreparationSchema.parse({
        ...expected,
        bucket: "studio-media",
        expiresAt: "2026-09-05T20:05:00.000Z",
        mediaId,
        path: `owners/${expected.scope}/studios/${expected.studioId}/revisions/${studioTestIds.revisionId}/${mediaId}.jpg`,
        revisionId: studioTestIds.revisionId,
        revisionVersion: 1,
        signedToken: "qa-unit-signed-token",
      }),
  },
  {
    action: "studio.media.upload.finalize",
    name: "media upload finalize",
    request: () =>
      finalizeStudioMediaUpload({
        ...envelope,
        action: "studio.media.upload.finalize",
        payload: { ...revision, mediaId },
      }),
    resultFor: galleryFor,
  },
  {
    action: "studio.media.reorder",
    name: "media reorder",
    request: () =>
      reorderStudioMedia({
        ...envelope,
        action: "studio.media.reorder",
        payload: { ...revision, orderedMediaIds: [mediaId] },
      }),
    resultFor: galleryFor,
  },
  {
    action: "studio.media.cover.set",
    name: "media cover set",
    request: () =>
      setStudioMediaCover({
        ...envelope,
        action: "studio.media.cover.set",
        payload: { ...revision, mediaId },
      }),
    resultFor: galleryFor,
  },
  {
    action: "studio.media.delete",
    name: "media delete",
    request: () =>
      deleteStudioMedia({
        ...envelope,
        action: "studio.media.delete",
        payload: { ...revision, mediaId },
      }),
    resultFor: galleryFor,
  },
];
const allCases: readonly CommandResponseCase[] = [
  {
    action: "studio.create",
    name: "create",
    request: () => createStudio(createCommand),
    resultFor: editorFor,
  },
  ...existingStudioCases,
];

function respondWith(data: unknown) {
  vi.stubGlobal("window", { clearTimeout, setTimeout });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data, requestId: studioTestIds.requestId })),
  );
}

describe("studio command response boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("covers every registered studio command action", () => {
    expect(new Set(allCases.map(({ action }) => action))).toEqual(
      new Set(studioCommandActionSchema.options),
    );
  });

  it.each(allCases)(
    "unwraps only the DTO with matching action, key, scope and studio for $name",
    async ({ action, request, resultFor }) => {
      const result = resultFor(boundary);
      respondWith({ action, idempotencyKey: envelope.idempotencyKey, result });
      await expect(request()).resolves.toEqual(result);
    },
  );

  it.each(allCases)(
    "rejects another owner's structurally valid result before success for $name",
    async ({ action, request, resultFor }) => {
      respondWith({
        action,
        idempotencyKey: envelope.idempotencyKey,
        result: resultFor({ ...boundary, scope: studioTestIds.otherUserId }),
      });
      const onSuccess = vi.fn();
      const error = await request()
        .then(onSuccess)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(StudioApiError);
      expect(error).toMatchObject({ code: "RESPONSE_INVALID" });
      expect(isAmbiguousStudioError(error)).toBe(true);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(JSON.stringify(error)).not.toContain(studioTestIds.otherUserId);
    },
  );

  it.each(existingStudioCases)(
    "rejects another studio's structurally valid result for $name",
    async ({ action, request, resultFor }) => {
      respondWith({
        action,
        idempotencyKey: envelope.idempotencyKey,
        result: resultFor({ ...boundary, studioId: studioTestIds.otherStudioId }),
      });
      await expect(request()).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    },
  );

  it.each([
    { ...boundary, scope: studioTestIds.otherUserId },
    { ...boundary, studioId: studioTestIds.otherStudioId },
  ])("rejects discard's nested editor when only the envelope matches: %j", async (mismatched) => {
    respondWith({
      action: discardCommand.action,
      idempotencyKey: discardCommand.idempotencyKey,
      result: studioDraftDiscardResultSchema.parse({
        ...boundary,
        editor: editorFor(mismatched),
        studioDeleted: false,
      }),
    });
    await expect(discardStudioDraft(discardCommand)).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
    });
  });

  it.each([studioTestIds.studioId, studioTestIds.otherStudioId])(
    "rejects another creation attempt's valid key for the same owner's studio %s before success",
    async (studioId) => {
      const otherIdempotencyKey = "33333333-3333-4333-8333-333333333334";
      const result = studioCommandResultSchema(studioEditorSchema).parse({
        action: createCommand.action,
        idempotencyKey: otherIdempotencyKey,
        result: editorFor({ ...boundary, studioId }),
      });
      expect(result.result.scope).toBe(createCommand.expectedScope);
      expect(result.idempotencyKey).not.toBe(createCommand.idempotencyKey);
      respondWith(result);
      const onSuccess = vi.fn();

      const error = await createStudio(createCommand)
        .then(onSuccess)
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(StudioApiError);
      expect(error).toMatchObject({ code: "RESPONSE_INVALID" });
      expect(isAmbiguousStudioError(error)).toBe(true);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(JSON.stringify(error)).not.toContain(otherIdempotencyKey);
      expect(JSON.stringify(error)).not.toContain(studioId);
    },
  );

  describe.each(allCases)("$name response identity", ({ action, request, resultFor }) => {
    const result = resultFor(boundary);
    const matching = { action, idempotencyKey: envelope.idempotencyKey, result };
    const otherIdempotencyKey = "33333333-3333-4333-8333-333333333334";

    it.each([
      { name: "missing key", data: { action, result } },
      { name: "different valid key", data: { ...matching, idempotencyKey: otherIdempotencyKey } },
      {
        name: "different valid action",
        data: {
          ...matching,
          action: action === "studio.create" ? "studio.revision.updateCore" : "studio.create",
        },
      },
      ...(action === "studio.media.upload.prepare"
        ? [
            {
              name: "invalid UUID key",
              data: { ...matching, idempotencyKey: "qa-invalid-idempotency-key" },
            },
            { name: "null key", data: { ...matching, idempotencyKey: null } },
            { name: "missing action", data: { idempotencyKey: envelope.idempotencyKey, result } },
            { name: "non-studio action", data: { ...matching, action: "owner.activate" } },
            { name: "legacy bare DTO", data: result },
            { name: "unexpected envelope PII", data: { ...matching, ownerTaxId: "52998224725" } },
            {
              name: "unexpected DTO PII",
              data: { ...matching, result: { ...result, ownerTaxId: "52998224725" } },
            },
            {
              name: "unexpected envelope token",
              data: { ...matching, signedToken: "qa-unexpected-signed-token" },
            },
          ]
        : []),
    ])("rejects $name as ambiguous before onSuccess without leaking payload", async ({ data }) => {
      respondWith(data);
      const onSuccess = vi.fn();

      const error = await request()
        .then(onSuccess)
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(StudioApiError);
      expect(error).toMatchObject({ code: "RESPONSE_INVALID" });
      expect(isAmbiguousStudioError(error)).toBe(true);
      expect(onSuccess).not.toHaveBeenCalled();
      const serialized = [
        String(error),
        JSON.stringify(error),
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      ].join("\n");
      for (const privateValue of [
        otherIdempotencyKey,
        studioTestIds.idempotencyKey,
        studioTestIds.userId,
        studioTestIds.studioId,
        studioCoreFixture.street,
        "qa-invalid-idempotency-key",
        "52998224725",
        "qa-unit-signed-token",
        "qa-unexpected-signed-token",
        "token=test",
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
    });
  });

  it("rejects the superseded create-specific envelope", async () => {
    respondWith({ editor: studioEditorFixture, idempotencyKey: createCommand.idempotencyKey });
    await expect(createStudio(createCommand)).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });

  it.each([studioTestIds.studioId, studioTestIds.otherStudioId])(
    "returns only the editor for server-generated studio ID %s with the matching creation key and scope",
    async (studioId) => {
      const result = editorFor({ ...boundary, studioId });
      respondWith({
        action: createCommand.action,
        idempotencyKey: createCommand.idempotencyKey,
        result,
      });

      expect(createCommand.payload).not.toHaveProperty("studioId");
      await expect(createStudio(createCommand)).resolves.toEqual(result);
    },
  );
});
