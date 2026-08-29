import { z } from "zod";

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

export const studioTypeOptionsSchema = z.array(studioTypeOptionSchema).max(100);

export const studioRevisionSchema = z.strictObject({
  ...studioCorePayloadSchema.shape,
  id: z.uuid(),
  number: z.number().int().positive(),
  status: studioRevisionStatusSchema,
  version: z.number().int().positive(),
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

export const studioCommandActionSchema = z.enum([
  "studio.create",
  "studio.revision.updateCore",
  "studio.draft.discard",
]);

export const studioCommandSchema = z.discriminatedUnion("action", [
  studioCreateCommandSchema,
  studioRevisionUpdateCoreCommandSchema,
  studioDraftDiscardCommandSchema,
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
export type StudioRevision = z.infer<typeof studioRevisionSchema>;
export type StudioRevisionStatus = z.infer<typeof studioRevisionStatusSchema>;
export type StudioStatus = z.infer<typeof studioStatusSchema>;
export type StudioTypeOption = z.infer<typeof studioTypeOptionSchema>;
