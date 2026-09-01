import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  assertStudioPublicationBoundary,
  invalidateStudioPublicationDependents,
  isStudioPublicationBoundaryChangedError,
  preserveNewestStudioPublication,
  publishStudioPublication,
  studioPublicationCanRender,
  StudioPublicationProjectionConflictError,
  StudioPublicationScopeChangedError,
  studioQueryKeys,
} from "../../src/domains/studios/components/studio-query-keys";
import { studioTestIds } from "./studio-test-fixture";
import { createStudioPublicationFixture } from "./studio-publication-test-fixture";

describe("studio publication private cache", () => {
  it("keeps the SSR snapshot hidden until an idle, successful, exact-scope read", () => {
    const publication = createStudioPublicationFixture();
    expect(
      studioPublicationCanRender(
        publication,
        studioTestIds.userId,
        studioTestIds.studioId,
        "fetching",
        false,
      ),
    ).toBe(false);
    expect(
      studioPublicationCanRender(
        publication,
        studioTestIds.userId,
        studioTestIds.studioId,
        "idle",
        true,
      ),
    ).toBe(false);
    expect(
      studioPublicationCanRender(
        publication,
        studioTestIds.otherUserId,
        studioTestIds.studioId,
        "idle",
        false,
      ),
    ).toBe(false);
    expect(
      studioPublicationCanRender(
        publication,
        studioTestIds.userId,
        studioTestIds.studioId,
        "idle",
        false,
      ),
    ).toBe(true);
  });

  it("rejects a publication from another session or studio", () => {
    const foreign = createStudioPublicationFixture({ scope: studioTestIds.otherUserId });
    expect(() =>
      assertStudioPublicationBoundary(foreign, studioTestIds.userId, studioTestIds.studioId),
    ).toThrow(StudioPublicationScopeChangedError);
  });

  it("never lets an older command response regress a newer publication", () => {
    const current = createStudioPublicationFixture({ publicationVersion: 3 });
    const stale = createStudioPublicationFixture({ publicationVersion: 2 });
    expect(
      preserveNewestStudioPublication(current, stale, studioTestIds.userId, studioTestIds.studioId),
    ).toEqual(current);

    const refreshedPreview = createStudioPublicationFixture({
      previewExpiresAt: "2026-08-31T20:10:00.000Z",
      publicationVersion: 3,
    });
    expect(
      preserveNewestStudioPublication(
        current,
        refreshedPreview,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toEqual(refreshedPreview);
  });

  it("orders equal publication fences by revision version before preview expiry", () => {
    const base = createStudioPublicationFixture();
    const newerContent = createStudioPublicationFixture({
      currentRevision: { ...base.currentRevision, name: "Conteúdo novo", version: 2 },
      previewExpiresAt: "2026-08-31T20:01:00.000Z",
    });
    const staleContentWithLongerPreview = createStudioPublicationFixture({
      currentRevision: { ...base.currentRevision, name: "Conteúdo antigo", version: 1 },
      previewExpiresAt: "2026-08-31T20:20:00.000Z",
    });

    expect(
      preserveNewestStudioPublication(
        newerContent,
        staleContentWithLongerPreview,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toEqual(newerContent);
    expect(
      preserveNewestStudioPublication(
        staleContentWithLongerPreview,
        newerContent,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toEqual(newerContent);
  });

  it("accepts a submitted candidate with a newer revision version on the same publication fence", () => {
    const base = createStudioPublicationFixture();
    const publishedRevision = {
      ...base.currentRevision,
      id: "83000000-0000-4000-8000-000000000001",
      number: 1,
      status: "approved" as const,
    };
    const beforeSubmission = createStudioPublicationFixture({
      canPause: true,
      canSubmit: true,
      currentRevision: {
        ...base.currentRevision,
        number: 2,
        status: "draft",
        version: 1,
      },
      latestReview: {
        eventType: "approved",
        occurredAt: "2026-08-31T19:00:00.000Z",
        rejectionReason: null,
        revisionId: publishedRevision.id,
      },
      publicationVersion: 5,
      publishedRevision,
      studioStatus: "changes_pending",
    });
    const afterSubmission = createStudioPublicationFixture({
      canPause: true,
      canSubmit: false,
      currentRevision: {
        ...beforeSubmission.currentRevision,
        status: "pending",
        version: 2,
      },
      latestReview: {
        eventType: "submitted",
        occurredAt: "2026-08-31T19:05:00.000Z",
        rejectionReason: null,
        revisionId: beforeSubmission.currentRevision.id,
      },
      publicationVersion: 5,
      publishedRevision,
      studioStatus: "changes_pending",
    });

    expect(
      preserveNewestStudioPublication(
        beforeSubmission,
        afterSubmission,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toEqual(afterSubmission);
    expect(
      preserveNewestStudioPublication(
        afterSubmission,
        beforeSubmission,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toEqual(afterSubmission);
  });

  it("fails closed when the same projection token carries divergent editorial content", () => {
    const current = createStudioPublicationFixture();
    const divergent = createStudioPublicationFixture({
      currentRevision: { ...current.currentRevision, name: "Conteúdo divergente" },
      previewExpiresAt: "2026-08-31T20:20:00.000Z",
    });

    expect(() =>
      preserveNewestStudioPublication(
        current,
        divergent,
        studioTestIds.userId,
        studioTestIds.studioId,
      ),
    ).toThrow(StudioPublicationProjectionConflictError);
  });

  it("classifies scope and same-fence projection drift as a full publication boundary change", () => {
    expect(isStudioPublicationBoundaryChangedError(new StudioPublicationScopeChangedError())).toBe(
      true,
    );
    expect(
      isStudioPublicationBoundaryChangedError(new StudioPublicationProjectionConflictError()),
    ).toBe(true);
    expect(isStudioPublicationBoundaryChangedError(new Error("transient failure"))).toBe(false);
  });

  it("publishes and invalidates only the exact user and studio dependents", async () => {
    const queryClient = new QueryClient();
    const publicationKey = studioQueryKeys.publication(
      studioTestIds.userId,
      studioTestIds.studioId,
    );
    const siblingPublicationKey = studioQueryKeys.publication(
      studioTestIds.userId,
      studioTestIds.otherStudioId,
    );
    const foreignPublicationKey = studioQueryKeys.publication(
      studioTestIds.otherUserId,
      studioTestIds.otherStudioId,
    );
    const editorKey = studioQueryKeys.editor(studioTestIds.userId, studioTestIds.studioId);
    const mediaKey = studioQueryKeys.media(studioTestIds.userId, studioTestIds.studioId);
    const siblingEditorKey = studioQueryKeys.editor(
      studioTestIds.userId,
      studioTestIds.otherStudioId,
    );
    const current = createStudioPublicationFixture();
    const updated = createStudioPublicationFixture({ publicationVersion: 2 });
    queryClient.setQueryData(publicationKey, current);
    queryClient.setQueryData(siblingPublicationKey, { sibling: true });
    queryClient.setQueryData(foreignPublicationKey, { foreign: true });
    queryClient.setQueryData(editorKey, { editor: true });
    queryClient.setQueryData(mediaKey, { media: true });
    queryClient.setQueryData(siblingEditorKey, { siblingEditor: true });

    expect(
      publishStudioPublication(queryClient, updated, studioTestIds.userId, studioTestIds.studioId),
    ).toEqual(updated);
    await invalidateStudioPublicationDependents(
      queryClient,
      studioTestIds.userId,
      studioTestIds.studioId,
    );

    expect(queryClient.getQueryData(publicationKey)).toEqual(updated);
    expect(queryClient.getQueryData(siblingPublicationKey)).toEqual({ sibling: true });
    expect(queryClient.getQueryData(foreignPublicationKey)).toBeUndefined();
    expect(queryClient.getQueryState(editorKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(mediaKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(siblingEditorKey)?.isInvalidated).toBe(false);
  });
});
