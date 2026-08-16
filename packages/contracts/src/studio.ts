import { z } from "zod";

const forbiddenInlineCharacters = /[\p{Cc}\p{Cf}]/u;
const forbiddenMultilineCharacters = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\p{Cf}]/u;

function normalizeInlineText(value: string) {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function normalizeMultilineText(value: string) {
  return value
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/[\t ]+/gu, " "))
    .join("\n")
    .trim();
}

function inlineTextSchema(minimum: number, maximum: number, label: string) {
  return z
    .string()
    .transform(normalizeInlineText)
    .pipe(
      z
        .string()
        .min(minimum, `${label} precisa ter pelo menos ${minimum} caracteres.`)
        .max(maximum, `${label} deve ter no máximo ${maximum} caracteres.`)
        .refine(
          (value) => !forbiddenInlineCharacters.test(value),
          `${label} contém caracteres inválidos.`,
        ),
    );
}

export const studioNameSchema = inlineTextSchema(2, 120, "O nome");
export const studioDescriptionSchema = z
  .string()
  .transform(normalizeMultilineText)
  .pipe(
    z
      .string()
      .min(20, "A descrição precisa ter pelo menos 20 caracteres.")
      .max(5_000, "A descrição deve ter no máximo 5000 caracteres.")
      .refine(
        (value) => !forbiddenMultilineCharacters.test(value),
        "A descrição contém caracteres inválidos.",
      ),
  );
export const studioStreetSchema = inlineTextSchema(2, 160, "O logradouro");
export const studioStreetNumberSchema = inlineTextSchema(1, 20, "O número");
export const studioAddressComplementSchema = inlineTextSchema(1, 120, "O complemento").nullable();
export const studioNeighborhoodSchema = inlineTextSchema(2, 120, "O bairro");
export const studioPostalCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{8}$/u, "Informe um CEP com 8 dígitos.");
export const studioCapacitySchema = z
  .number()
  .int("Informe a capacidade em pessoas inteiras.")
  .min(1, "A capacidade mínima é 1 pessoa.")
  .max(500, "A capacidade máxima é 500 pessoas.");
export const studioEditVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const studioRevisionNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const studioAddressInputSchema = z.strictObject({
  complement: studioAddressComplementSchema,
  neighborhood: studioNeighborhoodSchema,
  postalCode: studioPostalCodeSchema,
  street: studioStreetSchema,
  streetNumber: studioStreetNumberSchema,
});

export const studioCoreInputSchema = z.strictObject({
  address: studioAddressInputSchema,
  capacity: studioCapacitySchema,
  description: studioDescriptionSchema,
  name: studioNameSchema,
  studioTypeId: z.uuid(),
});

const studioTypeNameSchema = inlineTextSchema(2, 80, "O nome do tipo");

export const studioTypeOptionSchema = z.strictObject({
  id: z.uuid(),
  name: studioTypeNameSchema,
});

const studioTypeOptionsSchema = z
  .array(studioTypeOptionSchema)
  .max(100)
  .refine((options) => new Set(options.map(({ id }) => id)).size === options.length, {
    message: "A lista de tipos de estúdio contém identificadores repetidos.",
  });

export const studioStatusSchema = z.enum(["draft", "published"]);

export const studioCoreResultSchema = studioCoreInputSchema.extend({
  city: z.literal("Curitiba"),
  state: z.literal("PR"),
  studioTypeName: studioTypeNameSchema,
});

export const studioRevisionEditorSchema = z.strictObject({
  core: studioCoreResultSchema,
  revisionNumber: studioRevisionNumberSchema,
});

export const ownerStudioEditorStudioSchema = z.strictObject({
  draft: studioRevisionEditorSchema.nullable(),
  editVersion: studioEditVersionSchema,
  id: z.uuid(),
  published: studioRevisionEditorSchema.nullable(),
  status: studioStatusSchema,
});

const ownerStudioEditorCommon = {
  projection: z.literal("studio_editor"),
  scope: z.uuid(),
  studioTypes: studioTypeOptionsSchema,
} as const;

export const ownerStudioEditorCreateResultSchema = z.strictObject({
  ...ownerStudioEditorCommon,
  mode: z.literal("create"),
  studio: z.null(),
});

export const ownerStudioEditorEditResultSchema = z.strictObject({
  ...ownerStudioEditorCommon,
  mode: z.literal("edit"),
  studio: ownerStudioEditorStudioSchema,
});

export const ownerStudioEditorResultSchema = z.discriminatedUnion("mode", [
  ownerStudioEditorCreateResultSchema,
  ownerStudioEditorEditResultSchema,
]);

const privateStudioCommandEnvelope = {
  expectedScope: z.uuid(),
  idempotencyKey: z.uuid(),
} as const;

export const studioCreatePayloadSchema = z.strictObject({
  core: studioCoreInputSchema,
  studioId: z.uuid(),
});

export const studioCreateCommandSchema = z.strictObject({
  action: z.literal("studio.create"),
  ...privateStudioCommandEnvelope,
  payload: studioCreatePayloadSchema,
});

export const studioRevisionUpdateCorePayloadSchema = z.strictObject({
  core: studioCoreInputSchema,
  expectedEditVersion: studioEditVersionSchema,
  studioId: z.uuid(),
});

export const studioRevisionUpdateCoreCommandSchema = z.strictObject({
  action: z.literal("studio.revision.updateCore"),
  ...privateStudioCommandEnvelope,
  payload: studioRevisionUpdateCorePayloadSchema,
});

export const studioDraftDiscardPayloadSchema = z.strictObject({
  expectedEditVersion: studioEditVersionSchema,
  studioId: z.uuid(),
});

export const studioDraftDiscardCommandSchema = z.strictObject({
  action: z.literal("studio.draft.discard"),
  ...privateStudioCommandEnvelope,
  payload: studioDraftDiscardPayloadSchema,
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

export const studioDraftDiscardResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("studio_removed"),
    projection: z.literal("studio_draft_discard"),
    scope: z.uuid(),
    studioId: z.uuid(),
  }),
  z.strictObject({
    editor: ownerStudioEditorEditResultSchema,
    outcome: z.literal("draft_removed"),
    projection: z.literal("studio_draft_discard"),
    scope: z.uuid(),
    studioId: z.uuid(),
  }),
]);

export const ownerStudioEditorQuerySchema = z.strictObject({
  studioId: z.uuid().optional(),
});

export const ownerStudioEditorExpectedScopeHeader = "x-set-livre-expected-scope";
export const ownerStudioEditorExpectedScopeSchema = z.uuid();

export type OwnerStudioEditorCreateResult = z.infer<typeof ownerStudioEditorCreateResultSchema>;
export type OwnerStudioEditorEditResult = z.infer<typeof ownerStudioEditorEditResultSchema>;
export type OwnerStudioEditorResult = z.infer<typeof ownerStudioEditorResultSchema>;
export type StudioCommand = z.infer<typeof studioCommandSchema>;
export type StudioCommandAction = z.infer<typeof studioCommandActionSchema>;
export type StudioCoreInput = z.infer<typeof studioCoreInputSchema>;
export type StudioCoreResult = z.infer<typeof studioCoreResultSchema>;
export type StudioCreatePayload = z.infer<typeof studioCreatePayloadSchema>;
export type StudioDraftDiscardPayload = z.infer<typeof studioDraftDiscardPayloadSchema>;
export type StudioDraftDiscardResult = z.infer<typeof studioDraftDiscardResultSchema>;
export type StudioRevisionUpdateCorePayload = z.infer<typeof studioRevisionUpdateCorePayloadSchema>;
export type StudioStatus = z.infer<typeof studioStatusSchema>;
export type StudioTypeOption = z.infer<typeof studioTypeOptionSchema>;
