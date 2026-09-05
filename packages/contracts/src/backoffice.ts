import { z } from "zod";

import { identityEmailSchema, identityStatusSchema } from "./identity";
import { brazilianPhoneSchema, profileNameSchema } from "./profile";
import {
  studioMediaCollectionSchema,
  studioMediaRecordCollectionSchema,
  validateStudioMediaPreviewIdentity,
} from "./studio-media";
import {
  studioPublicationChecklistSchema,
  studioPublicationRevisionPreviewSchema,
  studioPublicationRevisionRecordSchema,
  studioStatusSchema,
} from "./studio";

export const backofficeLoginPayloadSchema = z.strictObject({
  email: identityEmailSchema,
  password: z.string().min(1).max(1_024),
});

export const backofficeLogoutPayloadSchema = z.strictObject({
  expectedScope: z.uuid(),
});

export const backofficeRuntimeUnlockPayloadSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "A chave local possui formato inválido."),
});

export const backofficeRuntimeUnlockResultSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
});

const idempotentBackofficeCommandSchema = z.strictObject({
  expectedScope: z.uuid(),
  idempotencyKey: z.uuid(),
});

export const platformRoleSchema = z.enum(["support", "reviewer", "admin"]);
export const platformRolesSchema = z
  .array(platformRoleSchema)
  .max(3)
  .refine((roles) => new Set(roles).size === roles.length, "Papéis duplicados não são permitidos.");

export const backofficeSessionSchema = z.discriminatedUnion("authenticated", [
  z.strictObject({ authenticated: z.literal(false) }),
  z.strictObject({
    authenticated: z.literal(true),
    authorizationVersion: z.number().int().nonnegative().safe(),
    email: identityEmailSchema,
    expiresAt: z.iso.datetime(),
    runtimeUnlockExpiresAt: z.iso.datetime().nullable(),
    scope: z.uuid(),
    strongAuthenticationExpiresAt: z.iso.datetime(),
  }),
]);

export const backofficeUserSummarySchema = z.strictObject({
  accountVersion: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  emailMasked: z.string().min(3).max(254),
  id: z.uuid(),
  status: identityStatusSchema,
});

export const backofficeUserCommandResultSchema = backofficeUserSummarySchema.extend({
  action: z.enum([
    "backoffice.user.suspend",
    "backoffice.user.restore",
    "backoffice.access.grantAdmin",
    "backoffice.access.grantReviewer",
    "backoffice.access.grantSupport",
    "backoffice.access.revokeAdmin",
    "backoffice.access.revokeReviewer",
    "backoffice.access.revokeSupport",
  ]),
  idempotencyKey: z.uuid(),
  scope: z.uuid(),
});

export const backofficeUserListSchema = z.strictObject({
  items: z.array(backofficeUserSummarySchema).max(50),
  nextCursor: z.string().min(1).max(512).nullable(),
  scope: z.uuid(),
});

export const backofficeUserQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(512).nullable().optional(),
  query: z.string().trim().max(160).optional(),
});

export const backofficePiiReasonSchema = z.enum([
  "identity_verification",
  "legal_request",
  "security_investigation",
  "support_case",
]);

export const backofficeUserPiiSchema = z.strictObject({
  action: z.literal("backoffice.user.revealPii"),
  additionalDocument: z.string().min(3).max(40).nullable(),
  email: identityEmailSchema,
  idempotencyKey: z.uuid(),
  name: profileNameSchema.nullable(),
  phoneE164: brazilianPhoneSchema.nullable(),
  reason: backofficePiiReasonSchema,
  scope: z.uuid(),
  taxId: z.string().min(11).max(14).nullable(),
  userId: z.uuid(),
});

export const backofficeTaxonomyKindSchema = z.enum(["studioType", "tag", "amenity"]);
export const backofficeTaxonomySlugSchema = z
  .string()
  .trim()
  .min(2, "Use pelo menos 2 caracteres.")
  .max(80, "Use no máximo 80 caracteres.")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Use letras minúsculas, números e hífens.");
export const backofficeTaxonomyNameSchema = z
  .string()
  .trim()
  .min(2, "Use pelo menos 2 caracteres.")
  .max(80, "Use no máximo 80 caracteres.");
export const backofficeTaxonomySortOrderSchema = z.number().int().min(0).max(32_767);

export const backofficeTaxonomyItemSchema = z.strictObject({
  active: z.boolean(),
  id: z.uuid(),
  kind: backofficeTaxonomyKindSchema,
  name: backofficeTaxonomyNameSchema,
  slug: backofficeTaxonomySlugSchema,
  sortOrder: backofficeTaxonomySortOrderSchema,
  updatedAt: z.iso.datetime(),
  usageCount: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
});

export const backofficeTaxonomyListSchema = z.strictObject({
  items: z.array(backofficeTaxonomyItemSchema).max(500),
  scope: z.uuid(),
});

export const backofficeTaxonomyCommandResultSchema = backofficeTaxonomyItemSchema.extend({
  action: z.enum([
    "backoffice.taxonomy.upsert",
    "backoffice.taxonomy.archive",
    "backoffice.taxonomy.reactivate",
  ]),
  idempotencyKey: z.uuid(),
  scope: z.uuid(),
});

export const backofficeTaxonomyImpactSchema = z.strictObject({
  active: z.boolean(),
  id: z.uuid(),
  kind: backofficeTaxonomyKindSchema,
  name: backofficeTaxonomyNameSchema,
  usageCount: z.number().int().nonnegative(),
});

const backofficeUserStatusPayloadSchema = z.strictObject({
  expectedAccountVersion: z.number().int().nonnegative(),
  userId: z.uuid(),
});

export const backofficeUserSuspendCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.user.suspend"),
  payload: backofficeUserStatusPayloadSchema,
});

export const backofficeUserRestoreCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.user.restore"),
  payload: backofficeUserStatusPayloadSchema,
});

export const backofficeUserRevealPiiCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.user.revealPii"),
  payload: z.strictObject({
    reason: backofficePiiReasonSchema,
    userId: z.uuid(),
  }),
});

export function matchesBackofficePiiAttempt(
  pii: BackofficeUserPii,
  command: BackofficeUserRevealPiiCommand,
) {
  return (
    pii.scope === command.expectedScope &&
    pii.userId === command.payload.userId &&
    pii.action === command.action &&
    pii.idempotencyKey === command.idempotencyKey &&
    pii.reason === command.payload.reason
  );
}

const backofficeAccessPayloadSchema = z.strictObject({
  expectedAccountVersion: z.number().int().nonnegative(),
  userId: z.uuid(),
});

export const backofficeAccessGrantSupportCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.access.grantSupport"),
  payload: backofficeAccessPayloadSchema,
});

export const backofficeAccessRevokeSupportCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.access.revokeSupport"),
  payload: backofficeAccessPayloadSchema,
});

export const backofficeAccessGrantReviewerCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.access.grantReviewer"),
  payload: backofficeAccessPayloadSchema,
});

export const backofficeAccessRevokeReviewerCommandSchema = idempotentBackofficeCommandSchema.extend(
  {
    action: z.literal("backoffice.access.revokeReviewer"),
    payload: backofficeAccessPayloadSchema,
  },
);

export const backofficeAccessGrantAdminCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.access.grantAdmin"),
  payload: backofficeAccessPayloadSchema,
});

export const backofficeAccessRevokeAdminCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.access.revokeAdmin"),
  payload: backofficeAccessPayloadSchema,
});

export const backofficeTaxonomyUpsertCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.taxonomy.upsert"),
  payload: z
    .strictObject({
      id: z.uuid().optional(),
      expectedVersion: z.number().int().nonnegative().optional(),
      kind: backofficeTaxonomyKindSchema,
      name: backofficeTaxonomyNameSchema,
      slug: backofficeTaxonomySlugSchema,
      sortOrder: backofficeTaxonomySortOrderSchema,
    })
    .refine((value) => (value.id === undefined) === (value.expectedVersion === undefined), {
      message: "Uma edição exige o item e a versão esperada.",
      path: ["expectedVersion"],
    }),
});

const backofficeTaxonomyStatusPayloadSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  id: z.uuid(),
  kind: backofficeTaxonomyKindSchema,
});

export const backofficeTaxonomyArchiveCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.taxonomy.archive"),
  payload: backofficeTaxonomyStatusPayloadSchema,
});

export const backofficeTaxonomyReactivateCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.taxonomy.reactivate"),
  payload: backofficeTaxonomyStatusPayloadSchema,
});

export const backofficeStudioReviewStateSchema = z.enum([
  "reviewPending",
  "moderation",
  "disabled",
]);
export const backofficeStudioReadActivityHeader = "x-set-livre-studio-read-activity";
export const backofficeStudioReadActivitySchema = z.enum(["interactive", "passive"]);

type BackofficeStudioReviewState = z.infer<typeof backofficeStudioReviewStateSchema>;
type StudioStatus = z.infer<typeof studioStatusSchema>;

function reviewStateMatchesStudioStatus(
  reviewState: BackofficeStudioReviewState,
  studioStatus: StudioStatus,
) {
  if (reviewState === "disabled") return studioStatus === "disabled";
  if (reviewState === "moderation") {
    return ["published", "changes_pending", "paused"].includes(studioStatus);
  }
  return ["pending_review", "changes_pending", "paused"].includes(studioStatus);
}

const backofficeStudioReviewRevisionRecordBaseSchema = studioPublicationRevisionRecordSchema.omit({
  cover: true,
});
const backofficeStudioReviewRevisionBaseSchema = studioPublicationRevisionPreviewSchema.omit({
  cover: true,
});

export const backofficeStudioReviewRevisionRecordSchema =
  backofficeStudioReviewRevisionRecordBaseSchema.extend({
    media: studioMediaRecordCollectionSchema,
  });

export const backofficeStudioReviewRevisionSchema = backofficeStudioReviewRevisionBaseSchema.extend(
  {
    media: studioMediaCollectionSchema,
  },
);

export const backofficeStudioReviewQueueItemSchema = z
  .strictObject({
    disabledFromStatus: z.enum(["published", "changes_pending", "paused"]).nullable(),
    hasPublished: z.boolean(),
    name: z.string().trim().min(2).max(120),
    publicationVersion: z.number().int().positive(),
    reviewState: backofficeStudioReviewStateSchema,
    revisionId: z.uuid(),
    studioId: z.uuid(),
    studioStatus: studioStatusSchema,
    submittedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .superRefine((item, context) => {
    if (!reviewStateMatchesStudioStatus(item.reviewState, item.studioStatus)) {
      context.addIssue({
        code: "custom",
        message: "O estado editorial não corresponde ao item de revisão.",
        path: ["studioStatus"],
      });
    }
    if (item.reviewState === "reviewPending" && item.submittedAt === null) {
      context.addIssue({
        code: "custom",
        message: "Uma candidata pendente precisa conservar sua submissão.",
        path: ["submittedAt"],
      });
    }
    if (
      item.reviewState === "reviewPending" &&
      item.hasPublished !== (item.studioStatus !== "pending_review")
    ) {
      context.addIssue({
        code: "custom",
        message: "A fila precisa refletir exatamente a existência de uma publicação vigente.",
        path: ["hasPublished"],
      });
    }
    if (item.reviewState === "disabled") {
      if (!item.hasPublished || item.disabledFromStatus === null) {
        context.addIssue({
          code: "custom",
          message: "Um item desativado exige publicação e estado de origem explícito.",
          path: ["disabledFromStatus"],
        });
      }
    } else if (item.disabledFromStatus !== null) {
      context.addIssue({
        code: "custom",
        message: "Somente um item desativado pode conservar estado de origem.",
        path: ["disabledFromStatus"],
      });
    }
    if (item.reviewState === "moderation" && !item.hasPublished) {
      context.addIssue({
        code: "custom",
        message: "Moderação exige uma revisão publicada.",
        path: ["hasPublished"],
      });
    }
  });

export const backofficeStudioReviewQueueSchema = z.strictObject({
  items: z.array(backofficeStudioReviewQueueItemSchema).max(50),
  nextCursor: z.string().min(1).max(512).nullable(),
  scope: z.uuid(),
});

export const backofficeStudioReviewQueueQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(512).nullable().optional(),
});

const backofficeStudioReviewDetailBase = {
  canApprove: z.boolean(),
  canDisable: z.boolean(),
  canReject: z.boolean(),
  canRestore: z.boolean(),
  checklist: studioPublicationChecklistSchema,
  disabledFromStatus: z.enum(["published", "changes_pending", "paused"]).nullable(),
  previewExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  publicationVersion: z.number().int().positive(),
  reviewState: backofficeStudioReviewStateSchema,
  scope: z.uuid(),
  studioId: z.uuid(),
  studioStatus: studioStatusSchema,
  submittedAt: z.iso.datetime({ offset: true }).nullable(),
} as const;

function validateBackofficeStudioReviewDetail(
  detail: Readonly<{
    canApprove: boolean;
    canDisable: boolean;
    canReject: boolean;
    canRestore: boolean;
    checklist: z.infer<typeof studioPublicationChecklistSchema>;
    candidateRevision: {
      id: string;
      status: "approved" | "draft" | "pending" | "rejected" | "superseded";
    };
    disabledFromStatus: "published" | "changes_pending" | "paused" | null;
    publishedRevision: {
      id: string;
      status: "approved" | "draft" | "pending" | "rejected" | "superseded";
    } | null;
    reviewState: "reviewPending" | "moderation" | "disabled";
    studioStatus: z.infer<typeof studioStatusSchema>;
    submittedAt: string | null;
  }>,
  context: z.RefinementCtx,
) {
  const candidateIsPending = detail.candidateRevision.status === "pending";
  const publishedIsApproved = detail.publishedRevision?.status === "approved";
  const candidateMatchesPublished =
    detail.publishedRevision !== null &&
    detail.candidateRevision.id === detail.publishedRevision.id;
  const checklistComplete = detail.checklist.every((item) => item.complete);

  if (detail.submittedAt === null) {
    context.addIssue({
      code: "custom",
      message: "Toda revisão visível no backoffice precisa conservar sua submissão original.",
      path: ["submittedAt"],
    });
  }
  if (!reviewStateMatchesStudioStatus(detail.reviewState, detail.studioStatus)) {
    context.addIssue({
      code: "custom",
      message: "O estado editorial não corresponde à superfície de revisão.",
      path: ["studioStatus"],
    });
  }

  if (detail.reviewState === "reviewPending") {
    if (!candidateIsPending) {
      context.addIssue({
        code: "custom",
        message: "Uma decisão editorial exige a candidata pendente exata.",
        path: ["candidateRevision", "status"],
      });
    }
    if (detail.canApprove !== checklistComplete || !detail.canReject || detail.canRestore) {
      context.addIssue({
        code: "custom",
        message:
          "A candidata pendente só pode ser aprovada com checklist completo e precisa conservar a rejeição disponível.",
        path: ["canApprove"],
      });
    }
    if (detail.disabledFromStatus !== null) {
      context.addIssue({
        code: "custom",
        message: "Uma decisão editorial não pode conservar estado de restauração.",
        path: ["disabledFromStatus"],
      });
    }
    if (detail.studioStatus === "pending_review") {
      if (detail.publishedRevision !== null || detail.canDisable) {
        context.addIssue({
          code: "custom",
          message: "A primeira publicação pendente não possui publicação moderável.",
          path: ["publishedRevision"],
        });
      }
    } else if (
      !publishedIsApproved ||
      detail.publishedRevision === null ||
      candidateMatchesPublished
    ) {
      context.addIssue({
        code: "custom",
        message: "Uma alteração pendente precisa preservar outra revisão publicada e aprovada.",
        path: ["publishedRevision"],
      });
    }
    return;
  }

  if (
    detail.canApprove ||
    detail.canReject ||
    !publishedIsApproved ||
    detail.candidateRevision.status !== "approved" ||
    !candidateMatchesPublished
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Moderação e restauração exigem a publicação aprovada exata e nenhuma decisão editorial.",
      path: ["candidateRevision"],
    });
  }

  if (detail.reviewState === "moderation") {
    if (!detail.canDisable || detail.canRestore || detail.disabledFromStatus !== null) {
      context.addIssue({
        code: "custom",
        message: "A moderação precisa expor somente a desativação administrativa.",
        path: ["canDisable"],
      });
    }
    return;
  }

  if (detail.canDisable) {
    context.addIssue({
      code: "custom",
      message: "Um estúdio desativado não pode expor uma nova desativação.",
      path: ["canDisable"],
    });
  }
  if (!detail.canRestore || detail.disabledFromStatus === null) {
    context.addIssue({
      code: "custom",
      message: "A restauração exige origem explícita e capacidades administrativas coerentes.",
      path: ["canRestore"],
    });
  }
}

function validateBackofficeStudioReviewRecordMediaIdentity(
  detail: Readonly<{
    candidateRevision: {
      media: ReadonlyArray<{ id: string; previewStoragePath: string }>;
    };
    publishedRevision: {
      media: ReadonlyArray<{ id: string; previewStoragePath: string }>;
    } | null;
    studioId: string;
  }>,
  context: z.RefinementCtx,
) {
  validateStudioMediaPreviewIdentity(
    { items: detail.candidateRevision.media, studioId: detail.studioId },
    context,
    ["candidateRevision", "media"],
  );
  if (detail.publishedRevision !== null) {
    validateStudioMediaPreviewIdentity(
      { items: detail.publishedRevision.media, studioId: detail.studioId },
      context,
      ["publishedRevision", "media"],
    );
  }
}

export const backofficeStudioReviewDetailRecordSchema = z
  .strictObject({
    ...backofficeStudioReviewDetailBase,
    candidateRevision: backofficeStudioReviewRevisionRecordSchema,
    previewExpiresAt: z.null(),
    publishedRevision: backofficeStudioReviewRevisionRecordSchema.nullable(),
  })
  .superRefine(validateBackofficeStudioReviewDetail)
  .superRefine(validateBackofficeStudioReviewRecordMediaIdentity);

export const backofficeStudioReviewDetailSchema = z
  .strictObject({
    ...backofficeStudioReviewDetailBase,
    candidateRevision: backofficeStudioReviewRevisionSchema,
    publishedRevision: backofficeStudioReviewRevisionSchema.nullable(),
  })
  .superRefine(validateBackofficeStudioReviewDetail)
  .superRefine((detail, context) => {
    const hasMedia =
      detail.candidateRevision.media.length > 0 ||
      (detail.publishedRevision?.media.length ?? 0) > 0;
    if (hasMedia !== (detail.previewExpiresAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "A expiração das prévias precisa corresponder à mídia assinada.",
        path: ["previewExpiresAt"],
      });
    }
  });

const backofficeStudioCommandBoundarySchema = z.strictObject({
  expectedPublicationVersion: z.number().int().positive(),
  studioId: z.uuid(),
});

export const backofficeStudioApproveCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.studio.approve"),
  payload: backofficeStudioCommandBoundarySchema.extend({ expectedRevisionId: z.uuid() }),
});

export const backofficeStudioRejectCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.studio.reject"),
  payload: backofficeStudioCommandBoundarySchema.extend({
    expectedRevisionId: z.uuid(),
    reason: z.string().trim().min(1).max(2_000),
  }),
});

export const backofficeStudioDisableCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.studio.disable"),
  payload: backofficeStudioCommandBoundarySchema,
});

export const backofficeStudioRestoreCommandSchema = idempotentBackofficeCommandSchema.extend({
  action: z.literal("backoffice.studio.restore"),
  payload: backofficeStudioCommandBoundarySchema,
});

const backofficeStudioCommandResultBase = {
  draftRevisionId: z.uuid().nullable(),
  idempotencyKey: z.uuid(),
  publicationVersion: z.number().int().positive(),
  revisionId: z.uuid(),
  scope: z.uuid(),
  studioId: z.uuid(),
} as const;

const backofficeStudioApproveResultSchema = z.strictObject({
  ...backofficeStudioCommandResultBase,
  action: z.literal("backoffice.studio.approve"),
  disabledFromStatus: z.null(),
  draftRevisionId: z.null(),
  publishedRevisionId: z.uuid(),
  studioStatus: z.enum(["published", "paused"]),
});

const backofficeStudioRejectResultSchema = z.strictObject({
  ...backofficeStudioCommandResultBase,
  action: z.literal("backoffice.studio.reject"),
  disabledFromStatus: z.null(),
  draftRevisionId: z.uuid(),
  publishedRevisionId: z.uuid().nullable(),
  studioStatus: z.enum(["rejected", "changes_pending", "paused"]),
});

const backofficeStudioDisableResultSchema = z.strictObject({
  ...backofficeStudioCommandResultBase,
  action: z.literal("backoffice.studio.disable"),
  disabledFromStatus: z.enum(["published", "changes_pending", "paused"]),
  publishedRevisionId: z.uuid(),
  studioStatus: z.literal("disabled"),
});

const backofficeStudioRestoreResultSchema = z.strictObject({
  ...backofficeStudioCommandResultBase,
  action: z.literal("backoffice.studio.restore"),
  disabledFromStatus: z.null(),
  publishedRevisionId: z.uuid(),
  studioStatus: z.enum(["published", "changes_pending", "paused"]),
});

export const backofficeStudioCommandResultSchema = z
  .discriminatedUnion("action", [
    backofficeStudioApproveResultSchema,
    backofficeStudioRejectResultSchema,
    backofficeStudioDisableResultSchema,
    backofficeStudioRestoreResultSchema,
  ])
  .superRefine((result, context) => {
    if (
      result.draftRevisionId !== null &&
      (result.draftRevisionId === result.revisionId ||
        result.draftRevisionId === result.publishedRevisionId)
    ) {
      context.addIssue({
        code: "custom",
        message: "O ponteiro de rascunho precisa identificar outra revisão.",
        path: ["draftRevisionId"],
      });
    }

    switch (result.action) {
      case "backoffice.studio.approve":
      case "backoffice.studio.disable":
      case "backoffice.studio.restore":
        if (result.publishedRevisionId !== result.revisionId) {
          context.addIssue({
            code: "custom",
            message: "A revisão afetada precisa ser a publicação resultante.",
            path: ["publishedRevisionId"],
          });
        }
        if (result.action === "backoffice.studio.restore") {
          if (result.studioStatus === "changes_pending" && result.draftRevisionId === null) {
            context.addIssue({
              code: "custom",
              message: "A restauração de alterações pendentes exige o rascunho preservado.",
              path: ["draftRevisionId"],
            });
          }
        } else if (
          result.action === "backoffice.studio.disable" &&
          result.disabledFromStatus === "changes_pending" &&
          result.draftRevisionId === null
        ) {
          context.addIssue({
            code: "custom",
            message: "A desativação de alterações pendentes exige o rascunho preservado.",
            path: ["draftRevisionId"],
          });
        }
        break;
      case "backoffice.studio.reject":
        if (
          result.revisionId === result.publishedRevisionId ||
          (result.studioStatus === "rejected" && result.publishedRevisionId !== null) ||
          (result.studioStatus !== "rejected" && result.publishedRevisionId === null)
        ) {
          context.addIssue({
            code: "custom",
            message: "A rejeição precisa preservar somente a publicação anterior aplicável.",
            path: ["publishedRevisionId"],
          });
        }
        break;
    }
  });

export function matchesBackofficeStudioAttempt(
  command: BackofficeStudioCommand,
  result: BackofficeStudioCommandResult,
) {
  return (
    result.scope === command.expectedScope &&
    result.action === command.action &&
    result.idempotencyKey === command.idempotencyKey &&
    result.studioId === command.payload.studioId &&
    result.publicationVersion === command.payload.expectedPublicationVersion + 1 &&
    ((command.action !== "backoffice.studio.approve" &&
      command.action !== "backoffice.studio.reject") ||
      result.revisionId === command.payload.expectedRevisionId)
  );
}

export const backofficeCommandSchema = z.discriminatedUnion("action", [
  backofficeUserSuspendCommandSchema,
  backofficeUserRestoreCommandSchema,
  backofficeUserRevealPiiCommandSchema,
  backofficeAccessGrantSupportCommandSchema,
  backofficeAccessRevokeSupportCommandSchema,
  backofficeAccessGrantReviewerCommandSchema,
  backofficeAccessRevokeReviewerCommandSchema,
  backofficeAccessGrantAdminCommandSchema,
  backofficeAccessRevokeAdminCommandSchema,
  backofficeTaxonomyUpsertCommandSchema,
  backofficeTaxonomyArchiveCommandSchema,
  backofficeTaxonomyReactivateCommandSchema,
  backofficeStudioApproveCommandSchema,
  backofficeStudioRejectCommandSchema,
  backofficeStudioDisableCommandSchema,
  backofficeStudioRestoreCommandSchema,
]);

export type BackofficeAccessCommand =
  | z.infer<typeof backofficeAccessGrantAdminCommandSchema>
  | z.infer<typeof backofficeAccessGrantReviewerCommandSchema>
  | z.infer<typeof backofficeAccessGrantSupportCommandSchema>
  | z.infer<typeof backofficeAccessRevokeAdminCommandSchema>
  | z.infer<typeof backofficeAccessRevokeReviewerCommandSchema>
  | z.infer<typeof backofficeAccessRevokeSupportCommandSchema>;
export type BackofficeCommand = z.infer<typeof backofficeCommandSchema>;
export type BackofficeLoginPayload = z.infer<typeof backofficeLoginPayloadSchema>;
export type BackofficeLogoutPayload = z.infer<typeof backofficeLogoutPayloadSchema>;
export type BackofficePiiReason = z.infer<typeof backofficePiiReasonSchema>;
export type BackofficeRuntimeUnlockPayload = z.infer<typeof backofficeRuntimeUnlockPayloadSchema>;
export type BackofficeRuntimeUnlockResult = z.infer<typeof backofficeRuntimeUnlockResultSchema>;
export type BackofficeSession = z.infer<typeof backofficeSessionSchema>;
export type BackofficeTaxonomyImpact = z.infer<typeof backofficeTaxonomyImpactSchema>;
export type BackofficeTaxonomyItem = z.infer<typeof backofficeTaxonomyItemSchema>;
export type BackofficeTaxonomyKind = z.infer<typeof backofficeTaxonomyKindSchema>;
export type BackofficeTaxonomyList = z.infer<typeof backofficeTaxonomyListSchema>;
export type BackofficeTaxonomyStatusCommand =
  | z.infer<typeof backofficeTaxonomyArchiveCommandSchema>
  | z.infer<typeof backofficeTaxonomyReactivateCommandSchema>;
export type BackofficeTaxonomyUpsertCommand = z.infer<typeof backofficeTaxonomyUpsertCommandSchema>;
export type BackofficeStudioCommand =
  | z.infer<typeof backofficeStudioApproveCommandSchema>
  | z.infer<typeof backofficeStudioRejectCommandSchema>
  | z.infer<typeof backofficeStudioDisableCommandSchema>
  | z.infer<typeof backofficeStudioRestoreCommandSchema>;
export type BackofficeStudioCommandResult = z.infer<typeof backofficeStudioCommandResultSchema>;
export type BackofficeStudioReviewDetail = z.infer<typeof backofficeStudioReviewDetailSchema>;
export type BackofficeStudioReviewDetailRecord = z.infer<
  typeof backofficeStudioReviewDetailRecordSchema
>;
export type BackofficeStudioReviewQueue = z.infer<typeof backofficeStudioReviewQueueSchema>;
export type BackofficeStudioReviewQueueItem = z.infer<typeof backofficeStudioReviewQueueItemSchema>;
export type BackofficeStudioReviewQueueQuery = z.infer<
  typeof backofficeStudioReviewQueueQuerySchema
>;
export type BackofficeStudioReadActivity = z.infer<typeof backofficeStudioReadActivitySchema>;
export type BackofficeUserList = z.infer<typeof backofficeUserListSchema>;
export type BackofficeUserPii = z.infer<typeof backofficeUserPiiSchema>;
export type BackofficeUserQuery = z.infer<typeof backofficeUserQuerySchema>;
export type BackofficeUserRevealPiiCommand = z.infer<typeof backofficeUserRevealPiiCommandSchema>;
export type BackofficeUserStatusCommand =
  | z.infer<typeof backofficeUserRestoreCommandSchema>
  | z.infer<typeof backofficeUserSuspendCommandSchema>;
export type BackofficeUserSummary = z.infer<typeof backofficeUserSummarySchema>;
export type PlatformRole = z.infer<typeof platformRoleSchema>;
