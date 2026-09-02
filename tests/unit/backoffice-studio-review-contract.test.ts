import {
  backofficeCommandSchema,
  backofficeStudioCommandResultSchema,
  backofficeStudioReviewDetailRecordSchema,
  backofficeStudioReviewDetailSchema,
  backofficeStudioReviewQueueSchema,
  studioPublicationChecklistSchema,
} from "@set-livre/contracts";
import { describe, expect, it } from "vitest";

import {
  backofficeLandingPath,
  canManageBackofficeUsers,
  canReviewBackofficeStudios,
} from "../../apps/backoffice/src/domains/backoffice/backoffice-authorization";
import {
  backofficeStudioReviewDetailRecordFixture,
  backofficeStudioReviewDetailFixture,
  backofficeStudioReviewPreviewPath,
  backofficeStudioReviewSubmittedAt,
  backofficeStudioReviewTestIds,
  studioReviewRevisionRecordFixture,
  studioTestIds,
} from "./studio-test-fixture";

const reviewerId = backofficeStudioReviewTestIds.reviewerId;
const idempotencyKey = "a1000000-0000-4000-8000-000000000002";
const submittedAt = backofficeStudioReviewSubmittedAt;
const revision = studioReviewRevisionRecordFixture();
const pendingDetail = backofficeStudioReviewDetailRecordFixture();
const otherMediaId = "a1000000-0000-4000-8000-000000000005";

describe("FEAT-030 backoffice studio review contracts", () => {
  it("keeps reviewer, support and admin capabilities disjoint with deliberate admin substitution", () => {
    expect(canReviewBackofficeStudios(["reviewer"])).toBe(true);
    expect(canManageBackofficeUsers(["reviewer"])).toBe(false);
    expect(canReviewBackofficeStudios(["support"])).toBe(false);
    expect(canManageBackofficeUsers(["support"])).toBe(true);
    expect(canReviewBackofficeStudios(["admin"])).toBe(true);
    expect(canManageBackofficeUsers(["admin"])).toBe(true);
    expect(backofficeLandingPath(["reviewer"])).toBe("/estudios");
    expect(backofficeLandingPath(["support"])).toBe("/usuarios");
  });

  it("derives approval from the checklist and rejects contradictory capabilities", () => {
    expect(backofficeStudioReviewDetailRecordSchema.parse(pendingDetail)).toMatchObject({
      canApprove: true,
      reviewState: "reviewPending",
      submittedAt,
    });
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...pendingDetail,
        canApprove: false,
      }).success,
    ).toBe(false);
    const incompleteChecklist = pendingDetail.checklist.map((item, index) =>
      index === 0 ? { ...item, complete: false, messages: ["Complete os detalhes."] } : item,
    );
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...pendingDetail,
        canApprove: false,
        checklist: incompleteChecklist,
      }).success,
    ).toBe(true);
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...pendingDetail,
        checklist: incompleteChecklist,
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...pendingDetail,
        canApprove: false,
        canDisable: true,
        canReject: false,
        reviewState: "moderation",
        studioStatus: "published",
        submittedAt: null,
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...pendingDetail,
        canRestore: true,
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...pendingDetail,
        candidateRevision: { ...pendingDetail.candidateRevision, status: "approved" },
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...pendingDetail,
        studioStatus: "changes_pending",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed media collections in record and signed revisions", () => {
    const signedDetail = backofficeStudioReviewDetailFixture();
    const recordItem = pendingDetail.candidateRevision.media[0];
    const signedItem = signedDetail.candidateRevision.media[0];
    if (recordItem === undefined || signedItem === undefined) {
      throw new Error("A fixture canônica precisa possuir mídia.");
    }
    const recordSecondItem = {
      ...recordItem,
      id: otherMediaId,
      isCover: false,
      position: 2,
      previewStoragePath: recordItem.previewStoragePath.replace(recordItem.id, otherMediaId),
    };
    const signedSecondItem = {
      ...signedItem,
      id: otherMediaId,
      isCover: false,
      position: 2,
      previewUrl: "https://project.supabase.co/storage/v1/object/sign/preview-b",
    };
    const invalidCollections = [
      {
        record: [recordItem, { ...recordSecondItem, id: recordItem.id }],
        signed: [signedItem, { ...signedSecondItem, id: signedItem.id }],
      },
      {
        record: [recordItem, { ...recordSecondItem, position: 3 }],
        signed: [signedItem, { ...signedSecondItem, position: 3 }],
      },
      {
        record: [{ ...recordItem, isCover: false }],
        signed: [{ ...signedItem, isCover: false }],
      },
      {
        record: [recordItem, { ...recordSecondItem, isCover: true }],
        signed: [signedItem, { ...signedSecondItem, isCover: true }],
      },
    ];

    for (const collection of invalidCollections) {
      expect(
        backofficeStudioReviewDetailRecordSchema.safeParse({
          ...pendingDetail,
          candidateRevision: {
            ...pendingDetail.candidateRevision,
            media: collection.record,
          },
        }).success,
      ).toBe(false);
      expect(
        backofficeStudioReviewDetailSchema.safeParse({
          ...signedDetail,
          candidateRevision: {
            ...signedDetail.candidateRevision,
            media: collection.signed,
          },
        }).success,
      ).toBe(false);
    }
  });

  it("validates backoffice preview paths without confusing reviewer and owner scopes", () => {
    const recordItem = pendingDetail.candidateRevision.media[0];
    if (recordItem === undefined) throw new Error("A fixture canônica precisa possuir mídia.");
    const sourceRevisionId = "a1000000-0000-4000-8000-000000000006";
    const validAlternativePaths = [
      backofficeStudioReviewPreviewPath.replace(studioTestIds.revisionId, sourceRevisionId),
      backofficeStudioReviewPreviewPath.replace(studioTestIds.userId, studioTestIds.otherUserId),
    ];
    for (const previewStoragePath of validAlternativePaths) {
      expect(
        backofficeStudioReviewDetailRecordSchema.safeParse({
          ...pendingDetail,
          candidateRevision: {
            ...pendingDetail.candidateRevision,
            media: [{ ...recordItem, previewStoragePath }],
          },
        }).success,
      ).toBe(true);
    }

    const invalidPaths = [
      "preview-invalida.webp",
      backofficeStudioReviewPreviewPath.replace(
        studioTestIds.studioId,
        studioTestIds.otherStudioId,
      ),
      backofficeStudioReviewPreviewPath.replace(
        `/${recordItem.id}.preview.webp`,
        `/${otherMediaId}.preview.webp`,
      ),
    ];
    for (const previewStoragePath of invalidPaths) {
      expect(
        backofficeStudioReviewDetailRecordSchema.safeParse({
          ...pendingDetail,
          candidateRevision: {
            ...pendingDetail.candidateRevision,
            media: [{ ...recordItem, previewStoragePath }],
          },
        }).success,
      ).toBe(false);
    }
  });

  it("requires each publication checklist section exactly once", () => {
    const completeChecklist = pendingDetail.checklist;
    const invalidChecklists = [
      completeChecklist.slice(0, 2),
      [completeChecklist[0], completeChecklist[1], completeChecklist[0]],
    ];
    for (const checklist of invalidChecklists) {
      expect(studioPublicationChecklistSchema.safeParse(checklist).success).toBe(false);
      expect(
        backofficeStudioReviewDetailRecordSchema.safeParse({
          ...pendingDetail,
          checklist,
        }).success,
      ).toBe(false);
    }
  });

  it("requires an explicit preserved status for restoration", () => {
    const publication = studioReviewRevisionRecordFixture({ status: "approved" });
    const disabled = backofficeStudioReviewDetailRecordFixture({
      canApprove: false,
      canDisable: false,
      canReject: false,
      canRestore: true,
      candidateRevision: publication,
      disabledFromStatus: "paused",
      publishedRevision: publication,
      reviewState: "disabled",
      studioStatus: "disabled",
    });
    expect(backofficeStudioReviewDetailRecordSchema.parse(disabled)).toMatchObject({
      canRestore: true,
      disabledFromStatus: "paused",
    });
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...disabled,
        disabledFromStatus: null,
      }).success,
    ).toBe(false);

    const disabledWithDisable = backofficeStudioReviewDetailRecordSchema.safeParse({
      ...disabled,
      canDisable: true,
    });
    expect(disabledWithDisable.success).toBe(false);
    if (!disabledWithDisable.success) {
      expect(disabledWithDisable.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["canDisable"] })]),
      );
    }
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...disabled,
        studioStatus: "published",
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...disabled,
        candidateRevision: { ...publication, id: studioTestIds.otherStudioId },
      }).success,
    ).toBe(false);
  });

  it("keeps disable valid for moderation but mutually exclusive with restore", () => {
    const publication = studioReviewRevisionRecordFixture({ status: "approved" });
    const moderation = backofficeStudioReviewDetailRecordFixture({
      canApprove: false,
      canDisable: true,
      canReject: false,
      candidateRevision: publication,
      publishedRevision: publication,
      reviewState: "moderation",
      studioStatus: "published",
    });
    expect(backofficeStudioReviewDetailRecordSchema.parse(moderation)).toMatchObject({
      canDisable: true,
      canRestore: false,
      reviewState: "moderation",
    });

    const contradictory = backofficeStudioReviewDetailRecordSchema.safeParse({
      ...moderation,
      canRestore: true,
      disabledFromStatus: "published",
    });
    expect(contradictory.success).toBe(false);
    if (!contradictory.success) {
      expect(contradictory.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["canDisable"] })]),
      );
    }
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...moderation,
        publishedRevision: { ...publication, status: "superseded" },
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...moderation,
        submittedAt: null,
      }).success,
    ).toBe(false);
  });

  it("preserves an approved publication beside a pending change without exposing another graph", () => {
    const publication = studioReviewRevisionRecordFixture({
      id: studioTestIds.publishedRevisionId,
      status: "approved",
    });
    const changesPending = backofficeStudioReviewDetailRecordFixture({
      canDisable: true,
      publishedRevision: publication,
      studioStatus: "changes_pending",
    });

    expect(backofficeStudioReviewDetailRecordSchema.parse(changesPending)).toMatchObject({
      canApprove: true,
      canDisable: true,
      candidateRevision: { status: "pending" },
      publishedRevision: { id: studioTestIds.publishedRevisionId, status: "approved" },
    });
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...changesPending,
        publishedRevision: { ...publication, id: changesPending.candidateRevision.id },
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...changesPending,
        disabledFromStatus: "published",
      }).success,
    ).toBe(false);
  });

  it("keeps queue pages strict, scoped and capped", () => {
    const item = {
      disabledFromStatus: null,
      hasPublished: false,
      name: revision.name,
      publicationVersion: 2,
      reviewState: "reviewPending",
      revisionId: revision.id,
      studioId: studioTestIds.studioId,
      studioStatus: "pending_review",
      submittedAt,
    } as const;
    expect(
      backofficeStudioReviewQueueSchema.parse({
        items: [item],
        nextCursor: null,
        scope: reviewerId,
      }),
    ).toMatchObject({ scope: reviewerId });
    expect(
      backofficeStudioReviewQueueSchema.safeParse({
        items: Array.from({ length: 51 }, () => item),
        nextCursor: null,
        scope: reviewerId,
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewQueueSchema.safeParse({
        items: [{ ...item, submittedAt: null }],
        nextCursor: null,
        scope: reviewerId,
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewQueueSchema.safeParse({
        items: [{ ...item, hasPublished: true }],
        nextCursor: null,
        scope: reviewerId,
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewQueueSchema.safeParse({
        items: [{ ...item, hasPublished: false, studioStatus: "changes_pending" }],
        nextCursor: null,
        scope: reviewerId,
      }).success,
    ).toBe(false);
    expect(
      backofficeStudioReviewQueueSchema.safeParse({
        items: [
          {
            ...item,
            hasPublished: false,
            reviewState: "moderation",
            studioStatus: "published",
            submittedAt: null,
          },
        ],
        nextCursor: null,
        scope: reviewerId,
      }).success,
    ).toBe(false);
  });

  it("keeps unsigned database records free of invented preview expiry", () => {
    expect(
      backofficeStudioReviewDetailRecordSchema.safeParse({
        ...pendingDetail,
        previewExpiresAt: "2026-09-01T20:05:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("normalizes a rejection reason and rejects client-selected status or empty evidence", () => {
    const command = {
      action: "backoffice.studio.reject",
      expectedScope: reviewerId,
      idempotencyKey,
      payload: {
        expectedPublicationVersion: 2,
        expectedRevisionId: revision.id,
        reason: "  Endereço não confere.  ",
        studioId: studioTestIds.studioId,
      },
    } as const;
    expect(backofficeCommandSchema.parse(command)).toMatchObject({
      payload: { reason: "Endereço não confere." },
    });
    expect(
      backofficeCommandSchema.safeParse({
        ...command,
        payload: { ...command.payload, reason: "   " },
      }).success,
    ).toBe(false);
    expect(
      backofficeCommandSchema.safeParse({
        ...command,
        payload: { ...command.payload, status: "rejected" },
      }).success,
    ).toBe(false);
  });

  it("accepts only the optimistic boundary required by administrative moderation", () => {
    expect(
      backofficeCommandSchema.parse({
        action: "backoffice.studio.disable",
        expectedScope: reviewerId,
        idempotencyKey,
        payload: { expectedPublicationVersion: 3, studioId: studioTestIds.studioId },
      }),
    ).toMatchObject({ action: "backoffice.studio.disable" });
    expect(
      backofficeCommandSchema.safeParse({
        action: "backoffice.studio.restore",
        expectedScope: reviewerId,
        idempotencyKey,
        payload: {
          expectedPublicationVersion: 3,
          restoreToStatus: "published",
          studioId: studioTestIds.studioId,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts only action-specific command result states", () => {
    const common = {
      publicationVersion: 3,
      scope: reviewerId,
      studioId: studioTestIds.studioId,
    } as const;
    const approve = {
      ...common,
      action: "backoffice.studio.approve",
      disabledFromStatus: null,
      draftRevisionId: null,
      publishedRevisionId: studioTestIds.revisionId,
      revisionId: studioTestIds.revisionId,
      studioStatus: "published",
    } as const;
    const reject = {
      ...common,
      action: "backoffice.studio.reject",
      disabledFromStatus: null,
      draftRevisionId: studioTestIds.otherStudioId,
      publishedRevisionId: null,
      revisionId: studioTestIds.revisionId,
      studioStatus: "rejected",
    } as const;
    const disable = {
      ...common,
      action: "backoffice.studio.disable",
      disabledFromStatus: "changes_pending",
      draftRevisionId: studioTestIds.revisionId,
      publishedRevisionId: studioTestIds.publishedRevisionId,
      revisionId: studioTestIds.publishedRevisionId,
      studioStatus: "disabled",
    } as const;
    const restore = {
      ...common,
      action: "backoffice.studio.restore",
      disabledFromStatus: null,
      draftRevisionId: studioTestIds.revisionId,
      publishedRevisionId: studioTestIds.publishedRevisionId,
      revisionId: studioTestIds.publishedRevisionId,
      studioStatus: "changes_pending",
    } as const;

    for (const result of [approve, reject, disable, restore]) {
      expect(backofficeStudioCommandResultSchema.safeParse(result).success).toBe(true);
    }

    const impossibleResults = [
      { ...approve, publishedRevisionId: studioTestIds.publishedRevisionId },
      { ...reject, draftRevisionId: reject.revisionId },
      { ...reject, publishedRevisionId: studioTestIds.publishedRevisionId },
      { ...disable, draftRevisionId: null },
      { ...disable, revisionId: studioTestIds.revisionId },
      { ...restore, draftRevisionId: null },
      { ...restore, studioStatus: "disabled" },
    ];
    for (const result of impossibleResults) {
      expect(backofficeStudioCommandResultSchema.safeParse(result).success).toBe(false);
    }
  });
});
