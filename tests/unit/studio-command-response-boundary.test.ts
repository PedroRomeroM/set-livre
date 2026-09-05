import {
  studioDraftDiscardResultSchema,
  studioEditorSchema,
  studioMediaGallerySchema,
  studioMediaUploadPreparationSchema,
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

const existingStudioCases = [
  {
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
const allCases = [
  { name: "create", request: () => createStudio(createCommand), resultFor: editorFor },
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

  it.each(allCases)(
    "accepts the requested scope and studio for $name",
    async ({ request, resultFor }) => {
      const result = resultFor(boundary);
      respondWith(result);
      await expect(request()).resolves.toEqual(result);
    },
  );

  it.each(allCases)(
    "rejects another owner's structurally valid result before success for $name",
    async ({ request, resultFor }) => {
      respondWith(resultFor({ ...boundary, scope: studioTestIds.otherUserId }));
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
    async ({ request, resultFor }) => {
      respondWith(resultFor({ ...boundary, studioId: studioTestIds.otherStudioId }));
      await expect(request()).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    },
  );

  it.each([
    { ...boundary, scope: studioTestIds.otherUserId },
    { ...boundary, studioId: studioTestIds.otherStudioId },
  ])("rejects discard's nested editor when only the envelope matches: %j", async (mismatched) => {
    respondWith(
      studioDraftDiscardResultSchema.parse({
        ...boundary,
        editor: editorFor(mismatched),
        studioDeleted: false,
      }),
    );
    await expect(discardStudioDraft(discardCommand)).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
    });
  });

  it("accepts a server-generated studio ID for creation in the requested scope", async () => {
    const editor = editorFor({ ...boundary, studioId: studioTestIds.otherStudioId });
    respondWith(editor);
    await expect(createStudio(createCommand)).resolves.toEqual(editor);
  });
});
