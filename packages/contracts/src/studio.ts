import { z } from "zod";

import {
  studioContentPayloadSchema,
  studioFaqSchema,
  studioTaxonomyPayloadSchema,
  studioTaxonomyReferenceSchema,
  studioYoutubeVideoIdSchema,
} from "./studio-taxonomy-content";
import {
  studioMediaCommandActionSchema,
  studioMediaCommandSchema,
  studioMediaItemSchema,
  studioMediaRecordSchema,
} from "./studio-media";

export const studioStatusSchema = z.enum([
  "draft",
  "pending_review",
  "published",
  "changes_pending",
  "paused",
  "rejected",
  "disabled",
]);

export const studioRevisionStatusSchema = z.enum([
  "draft",
  "pending",
  "approved",
  "rejected",
  "superseded",
]);

export const studioNameSchema = z
  .string()
  .trim()
  .min(2, "Informe um nome com pelo menos 2 caracteres.")
  .max(120, "Use no máximo 120 caracteres no nome.");

export const studioDescriptionSchema = z
  .string()
  .trim()
  .min(20, "Descreva o estúdio com pelo menos 20 caracteres.")
  .max(5000, "Use no máximo 5.000 caracteres na descrição.");

const studioStreetSchema = z
  .string()
  .trim()
  .min(2, "Informe a rua ou avenida.")
  .max(160, "Use no máximo 160 caracteres na rua.");

const studioStreetNumberSchema = z
  .string()
  .trim()
  .min(1, "Informe o número ou use s/n.")
  .max(20, "Use no máximo 20 caracteres no número.");

const studioAddressComplementSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string()
    .trim()
    .min(1, "Revise o complemento informado.")
    .max(120, "Use no máximo 120 caracteres no complemento.")
    .nullable(),
);

const studioNeighborhoodSchema = z
  .string()
  .trim()
  .min(2, "Informe o bairro.")
  .max(120, "Use no máximo 120 caracteres no bairro.");

export const studioPostalCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{5}-?[0-9]{3}$/u, "Informe um CEP válido com 8 dígitos.")
  .transform((value) => value.replace("-", ""));

export const studioCapacitySchema = z
  .number()
  .int("A capacidade precisa ser um número inteiro.")
  .min(1, "A capacidade mínima é 1 pessoa.")
  .max(500, "A capacidade máxima é 500 pessoas.");

export const studioCorePayloadSchema = z.strictObject({
  addressComplement: studioAddressComplementSchema,
  capacity: studioCapacitySchema,
  city: z.literal("Curitiba", "A baseline aceita somente estúdios em Curitiba."),
  description: studioDescriptionSchema,
  name: studioNameSchema,
  neighborhood: studioNeighborhoodSchema,
  postalCode: studioPostalCodeSchema,
  state: z.literal("PR", "A baseline aceita somente estúdios no Paraná."),
  street: studioStreetSchema,
  streetNumber: studioStreetNumberSchema,
  studioTypeId: z.uuid("Selecione um tipo de estúdio válido."),
});

export const studioTypeSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(2).max(80),
});

export const studioTypeOptionSchema = studioTypeSchema.extend({
  sortOrder: z.number().int().nonnegative(),
});

export const studioTypeOptionsSchema = z.array(studioTypeOptionSchema);

const studioTaxonomyReferencesSchema = z
  .array(studioTaxonomyReferenceSchema)
  .max(20)
  .refine(
    (references) => new Set(references.map((reference) => reference.id)).size === references.length,
    {
      message: "A revisão não pode repetir a mesma taxonomia.",
    },
  );

export const studioRevisionSchema = z
  .strictObject({
    ...studioCorePayloadSchema.shape,
    amenities: studioTaxonomyReferencesSchema,
    faqs: z.array(studioFaqSchema).max(20),
    id: z.uuid(),
    number: z.number().int().positive(),
    status: studioRevisionStatusSchema,
    tags: studioTaxonomyReferencesSchema,
    usageRules: z.string().max(5000),
    version: z.number().int().positive(),
    youtubeVideoId: studioYoutubeVideoIdSchema.nullable(),
  })
  .superRefine((value, context) => {
    value.faqs.forEach((faq, index) => {
      if (faq.position !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "A ordem da FAQ não é contínua.",
          path: ["faqs", index, "position"],
        });
      }
    });
  });

export const studioEditorSchema = z
  .strictObject({
    draftRevisionId: z.uuid().nullable(),
    hasDraft: z.boolean(),
    publishedRevisionId: z.uuid().nullable(),
    revision: studioRevisionSchema,
    scope: z.uuid(),
    studioId: z.uuid(),
    studioStatus: studioStatusSchema,
    studioType: studioTypeSchema,
  })
  .superRefine((value, context) => {
    if (value.hasDraft !== (value.draftRevisionId !== null)) {
      context.addIssue({
        code: "custom",
        message: "O indicador de rascunho não corresponde ao ponteiro canônico.",
        path: ["hasDraft"],
      });
    }
    const currentRevisionId = value.draftRevisionId ?? value.publishedRevisionId;
    if (currentRevisionId !== value.revision.id) {
      context.addIssue({
        code: "custom",
        message: "A revisão retornada não corresponde ao ponteiro canônico do estúdio.",
        path: ["revision", "id"],
      });
    }
    if (value.studioType.id !== value.revision.studioTypeId) {
      context.addIssue({
        code: "custom",
        message: "O tipo exibido não corresponde à revisão retornada.",
        path: ["studioType", "id"],
      });
    }
  });

export const studioPublicationChecklistKeySchema = z.enum(["details", "content", "media"]);

export const studioPublicationChecklistItemSchema = z
  .strictObject({
    complete: z.boolean(),
    key: studioPublicationChecklistKeySchema,
    messages: z.array(z.string().trim().min(1).max(240)).max(8),
  })
  .superRefine((value, context) => {
    if (value.complete !== (value.messages.length === 0)) {
      context.addIssue({
        code: "custom",
        message:
          "Uma seção completa não pode publicar pendências, e uma incompleta precisa explicá-las.",
        path: ["messages"],
      });
    }
  });

export const studioPublicationChecklistSchema = z
  .array(studioPublicationChecklistItemSchema)
  .length(3)
  .refine(
    (items) =>
      new Set(items.map((item) => item.key)).size === 3 &&
      ["details", "content", "media"].every((key) => items.some((item) => item.key === key)),
    { message: "O checklist de publicação precisa conter cada seção exatamente uma vez." },
  );

const studioPublicationRevisionPreviewBase = {
  addressComplement: studioAddressComplementSchema,
  amenities: studioTaxonomyReferencesSchema,
  capacity: z.number().int().min(1).max(500),
  city: z.literal("Curitiba"),
  description: studioDescriptionSchema,
  faqs: z.array(studioFaqSchema).max(20),
  id: z.uuid(),
  mediaCount: z.number().int().min(0).max(20),
  name: studioNameSchema,
  neighborhood: z.string().trim().min(2).max(120),
  number: z.number().int().positive(),
  postalCode: studioPostalCodeSchema,
  state: z.literal("PR"),
  status: studioRevisionStatusSchema,
  street: studioStreetSchema,
  streetNumber: studioStreetNumberSchema,
  studioType: studioTypeSchema,
  tags: studioTaxonomyReferencesSchema,
  usageRules: z.string().max(5000),
  version: z.number().int().positive(),
  youtubeVideoId: studioYoutubeVideoIdSchema.nullable(),
} as const;

export const studioPublicationRevisionRecordSchema = z.strictObject({
  ...studioPublicationRevisionPreviewBase,
  cover: studioMediaRecordSchema.nullable(),
});

export const studioPublicationRevisionPreviewSchema = z.strictObject({
  ...studioPublicationRevisionPreviewBase,
  cover: studioMediaItemSchema.nullable(),
});

export const studioPublicationReviewEventTypeSchema = z.enum(["submitted", "approved", "rejected"]);

export const studioPublicationLatestReviewSchema = z
  .strictObject({
    eventType: studioPublicationReviewEventTypeSchema,
    occurredAt: z.iso.datetime({ offset: true }),
    rejectionReason: z.string().trim().min(1).max(2000).nullable(),
    revisionId: z.uuid(),
  })
  .superRefine((value, context) => {
    if ((value.eventType === "rejected") !== (value.rejectionReason !== null)) {
      context.addIssue({
        code: "custom",
        message: "Somente uma rejeição pode carregar motivo.",
        path: ["rejectionReason"],
      });
    }
  });

const studioPublicationStateBase = {
  canPause: z.boolean(),
  canResume: z.boolean(),
  canSubmit: z.boolean(),
  checklist: studioPublicationChecklistSchema,
  latestReview: studioPublicationLatestReviewSchema.nullable(),
  publicationVersion: z.number().int().positive(),
  scope: z.uuid(),
  studioId: z.uuid(),
  studioStatus: studioStatusSchema,
} as const;

function validateStudioPublicationState(
  value: Readonly<{
    canPause: boolean;
    canResume: boolean;
    canSubmit: boolean;
    checklist: ReadonlyArray<{ complete: boolean }>;
    currentRevision: { id: string; status: z.infer<typeof studioRevisionStatusSchema> };
    publishedRevision: {
      id: string;
      status: z.infer<typeof studioRevisionStatusSchema>;
    } | null;
    studioStatus: z.infer<typeof studioStatusSchema>;
  }>,
  context: z.RefinementCtx,
) {
  const publishedRevisionIsApproved = value.publishedRevision?.status === "approved";
  const currentRevisionMatchesPublished =
    value.publishedRevision !== null && value.publishedRevision.id === value.currentRevision.id;
  const currentRevisionIsPrivate =
    value.currentRevision.status === "draft" ||
    value.currentRevision.status === "pending" ||
    value.currentRevision.status === "rejected";
  const currentRevisionIsUnsubmittedPrivate =
    value.currentRevision.status === "draft" || value.currentRevision.status === "rejected";
  let stateMatchesRevisionGraph = false;

  switch (value.studioStatus) {
    case "draft":
      stateMatchesRevisionGraph =
        value.publishedRevision === null && value.currentRevision.status === "draft";
      break;
    case "pending_review":
      stateMatchesRevisionGraph =
        value.publishedRevision === null && value.currentRevision.status === "pending";
      break;
    case "rejected":
      stateMatchesRevisionGraph =
        value.publishedRevision === null &&
        (value.currentRevision.status === "rejected" || value.currentRevision.status === "draft");
      break;
    case "published":
      stateMatchesRevisionGraph =
        publishedRevisionIsApproved &&
        ((currentRevisionMatchesPublished && value.currentRevision.status === "approved") ||
          (!currentRevisionMatchesPublished && currentRevisionIsUnsubmittedPrivate));
      break;
    case "changes_pending":
      stateMatchesRevisionGraph =
        publishedRevisionIsApproved && !currentRevisionMatchesPublished && currentRevisionIsPrivate;
      break;
    case "paused":
      stateMatchesRevisionGraph =
        publishedRevisionIsApproved &&
        ((currentRevisionMatchesPublished && value.currentRevision.status === "approved") ||
          (!currentRevisionMatchesPublished && currentRevisionIsPrivate));
      break;
    case "disabled":
      stateMatchesRevisionGraph =
        value.publishedRevision === null
          ? currentRevisionIsPrivate
          : publishedRevisionIsApproved &&
            ((currentRevisionMatchesPublished && value.currentRevision.status === "approved") ||
              (!currentRevisionMatchesPublished && currentRevisionIsPrivate));
      break;
  }

  const expectedCanSubmit =
    (value.studioStatus === "draft" ||
      value.studioStatus === "rejected" ||
      value.studioStatus === "published" ||
      value.studioStatus === "changes_pending" ||
      value.studioStatus === "paused") &&
    value.currentRevision.status === "draft" &&
    value.checklist.every((item) => item.complete);
  const expectedCanPause =
    (value.studioStatus === "published" || value.studioStatus === "changes_pending") &&
    publishedRevisionIsApproved;
  const expectedCanResume = value.studioStatus === "paused" && publishedRevisionIsApproved;

  if (!stateMatchesRevisionGraph) {
    context.addIssue({
      code: "custom",
      message: "O estado editorial não corresponde aos ponteiros e estados das revisões.",
      path: ["studioStatus"],
    });
  }
  if (value.canSubmit !== expectedCanSubmit) {
    context.addIssue({
      code: "custom",
      message: "A disponibilidade de envio não corresponde ao checklist e à revisão atual.",
      path: ["canSubmit"],
    });
  }
  if (value.canPause !== expectedCanPause) {
    context.addIssue({
      code: "custom",
      message: "A disponibilidade de pausa não corresponde ao estado editorial.",
      path: ["canPause"],
    });
  }
  if (value.canResume !== expectedCanResume) {
    context.addIssue({
      code: "custom",
      message: "A disponibilidade de retomada não corresponde ao estado editorial.",
      path: ["canResume"],
    });
  }
  if (value.publishedRevision !== null && !publishedRevisionIsApproved) {
    context.addIssue({
      code: "custom",
      message: "A versão publicada precisa permanecer aprovada.",
      path: ["publishedRevision", "status"],
    });
  }
  if (
    (value.studioStatus === "published" ||
      value.studioStatus === "changes_pending" ||
      value.studioStatus === "paused") &&
    value.publishedRevision === null
  ) {
    context.addIssue({
      code: "custom",
      message: "Este estado editorial exige uma revisão publicada aprovada.",
      path: ["publishedRevision"],
    });
  }
  if (
    value.studioStatus === "changes_pending" &&
    value.publishedRevision?.id === value.currentRevision.id
  ) {
    context.addIssue({
      code: "custom",
      message: "Alterações pendentes precisam apontar para uma candidata privada distinta.",
      path: ["currentRevision", "id"],
    });
  }
}

export const studioPublicationRecordSchema = z
  .strictObject({
    ...studioPublicationStateBase,
    currentRevision: studioPublicationRevisionRecordSchema,
    publishedRevision: studioPublicationRevisionRecordSchema.nullable(),
  })
  .superRefine(validateStudioPublicationState);

export const studioPublicationSchema = z
  .strictObject({
    ...studioPublicationStateBase,
    currentRevision: studioPublicationRevisionPreviewSchema,
    previewExpiresAt: z.iso.datetime({ offset: true }).nullable(),
    publishedRevision: studioPublicationRevisionPreviewSchema.nullable(),
  })
  .superRefine((value, context) => {
    validateStudioPublicationState(value, context);
    const hasCover =
      value.currentRevision.cover !== null ||
      (value.publishedRevision !== null && value.publishedRevision.cover !== null);
    if (hasCover !== (value.previewExpiresAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "A expiração das prévias precisa corresponder às capas assinadas.",
        path: ["previewExpiresAt"],
      });
    }
  });

const privateStudioCommandEnvelope = {
  expectedScope: z.uuid(),
  idempotencyKey: z.uuid(),
} as const;

export const studioCreateCommandSchema = z.strictObject({
  action: z.literal("studio.create"),
  ...privateStudioCommandEnvelope,
  payload: studioCorePayloadSchema,
});

export const studioRevisionUpdateCoreCommandSchema = z.strictObject({
  action: z.literal("studio.revision.updateCore"),
  ...privateStudioCommandEnvelope,
  payload: studioCorePayloadSchema.extend({
    expectedRevisionId: z.uuid(),
    expectedRevisionVersion: z.number().int().positive(),
    studioId: z.uuid(),
  }),
});

export const studioDraftDiscardCommandSchema = z.strictObject({
  action: z.literal("studio.draft.discard"),
  ...privateStudioCommandEnvelope,
  payload: z.strictObject({
    expectedRevisionId: z.uuid(),
    expectedRevisionVersion: z.number().int().positive(),
    studioId: z.uuid(),
  }),
});

const studioPublicationTransitionBoundarySchema = z.strictObject({
  expectedPublicationVersion: z.number().int().positive(),
  studioId: z.uuid(),
});

export const studioRevisionSubmitCommandSchema = z.strictObject({
  action: z.literal("studio.revision.submit"),
  ...privateStudioCommandEnvelope,
  payload: z.strictObject({
    expectedRevisionId: z.uuid(),
    expectedRevisionVersion: z.number().int().positive(),
    studioId: z.uuid(),
  }),
});

export const studioPauseCommandSchema = z.strictObject({
  action: z.literal("studio.pause"),
  ...privateStudioCommandEnvelope,
  payload: studioPublicationTransitionBoundarySchema,
});

export const studioResumeCommandSchema = z.strictObject({
  action: z.literal("studio.resume"),
  ...privateStudioCommandEnvelope,
  payload: studioPublicationTransitionBoundarySchema,
});

const studioRevisionMutationBoundarySchema = z.strictObject({
  expectedRevisionId: z.uuid(),
  expectedRevisionVersion: z.number().int().positive(),
  studioId: z.uuid(),
});

export const studioRevisionUpdateTaxonomyCommandSchema = z.strictObject({
  action: z.literal("studio.revision.updateTaxonomy"),
  ...privateStudioCommandEnvelope,
  payload: studioRevisionMutationBoundarySchema.extend(studioTaxonomyPayloadSchema.shape),
});

export const studioRevisionUpdateContentCommandSchema = z.strictObject({
  action: z.literal("studio.revision.updateContent"),
  ...privateStudioCommandEnvelope,
  payload: studioRevisionMutationBoundarySchema.extend(studioContentPayloadSchema.shape),
});

export const studioCommandActionSchema = z.enum([
  "studio.create",
  "studio.revision.updateCore",
  "studio.revision.updateTaxonomy",
  "studio.revision.updateContent",
  "studio.draft.discard",
  "studio.revision.submit",
  "studio.pause",
  "studio.resume",
  ...studioMediaCommandActionSchema.options,
]);

export function studioCommandResultSchema<TData extends z.ZodType>(result: TData) {
  return z.strictObject({
    action: studioCommandActionSchema,
    idempotencyKey: z.uuid(),
    result,
  });
}

export const studioCommandSchema = z.discriminatedUnion("action", [
  studioCreateCommandSchema,
  studioRevisionUpdateCoreCommandSchema,
  studioRevisionUpdateTaxonomyCommandSchema,
  studioRevisionUpdateContentCommandSchema,
  studioDraftDiscardCommandSchema,
  studioRevisionSubmitCommandSchema,
  studioPauseCommandSchema,
  studioResumeCommandSchema,
  ...studioMediaCommandSchema.options,
]);

export const studioDraftDiscardResultSchema = z.discriminatedUnion("studioDeleted", [
  z.strictObject({
    scope: z.uuid(),
    studioDeleted: z.literal(true),
    studioId: z.uuid(),
  }),
  z.strictObject({
    editor: studioEditorSchema,
    scope: z.uuid(),
    studioDeleted: z.literal(false),
    studioId: z.uuid(),
  }),
]);

export function formatStudioPostalCode(postalCode: string) {
  if (!/^[0-9-]*$/u.test(postalCode)) return postalCode;
  const normalized = postalCode.replaceAll("-", "");
  if (normalized.length > 8) return postalCode;
  return normalized.length <= 5 ? normalized : `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}

export type StudioCommand = z.infer<typeof studioCommandSchema>;
export type StudioCommandAction = z.infer<typeof studioCommandActionSchema>;
export type StudioCorePayload = z.infer<typeof studioCorePayloadSchema>;
export type StudioDraftDiscardResult = z.infer<typeof studioDraftDiscardResultSchema>;
export type StudioEditor = z.infer<typeof studioEditorSchema>;
export type StudioPublication = z.infer<typeof studioPublicationSchema>;
export type StudioPublicationChecklistItem = z.infer<typeof studioPublicationChecklistItemSchema>;
export type StudioPublicationRecord = z.infer<typeof studioPublicationRecordSchema>;
export type StudioPublicationRevisionPreview = z.infer<
  typeof studioPublicationRevisionPreviewSchema
>;
export type StudioPublicationRevisionRecord = z.infer<typeof studioPublicationRevisionRecordSchema>;
export type StudioRevision = z.infer<typeof studioRevisionSchema>;
export type StudioRevisionStatus = z.infer<typeof studioRevisionStatusSchema>;
export type StudioStatus = z.infer<typeof studioStatusSchema>;
export type StudioTypeOption = z.infer<typeof studioTypeOptionSchema>;
