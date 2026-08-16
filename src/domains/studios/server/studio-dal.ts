import "server-only";

import {
  ownerStudioEditorEditResultSchema,
  studioCoreInputSchema,
  studioEditVersionSchema,
  studioStatusSchema,
  studioTypeOptionSchema,
  type OwnerStudioEditorEditResult,
  type StudioCoreInput,
  type StudioTypeOption,
} from "@set-livre/contracts";
import { z } from "zod";

import { commandDalPool } from "@/lib/server/dal-pool";

const databasePositiveIntegerSchema = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .transform(Number)
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
]);

const nullableRevisionFields = {
  address_complement: z.string().nullable(),
  capacity: z.number().int().min(1).max(500).nullable(),
  city: z.literal("Curitiba").nullable(),
  description: z.string().nullable(),
  id: z.uuid().nullable(),
  name: z.string().nullable(),
  neighborhood: z.string().nullable(),
  number: databasePositiveIntegerSchema.nullable(),
  postal_code: z.string().nullable(),
  state: z.literal("PR").nullable(),
  street: z.string().nullable(),
  street_number: z.string().nullable(),
  studio_type_id: z.uuid().nullable(),
  studio_type_name: z.string().nullable(),
} as const;

function addRevisionGroupIssues(
  context: z.RefinementCtx,
  prefix: "draft" | "published",
  values: Readonly<{
    addressComplement: string | null;
    capacity: number | null;
    city: string | null;
    description: string | null;
    id: string | null;
    name: string | null;
    neighborhood: string | null;
    number: number | null;
    postalCode: string | null;
    state: string | null;
    street: string | null;
    streetNumber: string | null;
    studioTypeId: string | null;
    studioTypeName: string | null;
  }>,
) {
  const required = [
    values.capacity,
    values.city,
    values.description,
    values.name,
    values.neighborhood,
    values.number,
    values.postalCode,
    values.state,
    values.street,
    values.streetNumber,
    values.studioTypeId,
    values.studioTypeName,
  ];
  if (
    values.id === null &&
    [...required, values.addressComplement].some((value) => value !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: `A projeção ${prefix} ausente contém dados residuais.`,
      path: [`${prefix}_revision_id`],
    });
  }
  if (values.id !== null && required.some((value) => value === null)) {
    context.addIssue({
      code: "custom",
      message: `A projeção ${prefix} está incompleta.`,
      path: [`${prefix}_revision_id`],
    });
  }
}

const ownerStudioEditorDalRowSchema = z
  .strictObject({
    draft_address_complement: nullableRevisionFields.address_complement,
    draft_capacity: nullableRevisionFields.capacity,
    draft_city: nullableRevisionFields.city,
    draft_description: nullableRevisionFields.description,
    draft_name: nullableRevisionFields.name,
    draft_neighborhood: nullableRevisionFields.neighborhood,
    draft_postal_code: nullableRevisionFields.postal_code,
    draft_revision_id: nullableRevisionFields.id,
    draft_revision_number: nullableRevisionFields.number,
    draft_state: nullableRevisionFields.state,
    draft_street: nullableRevisionFields.street,
    draft_street_number: nullableRevisionFields.street_number,
    draft_studio_type_id: nullableRevisionFields.studio_type_id,
    draft_studio_type_name: nullableRevisionFields.studio_type_name,
    edit_version: databasePositiveIntegerSchema,
    published_address_complement: nullableRevisionFields.address_complement,
    published_capacity: nullableRevisionFields.capacity,
    published_city: nullableRevisionFields.city,
    published_description: nullableRevisionFields.description,
    published_name: nullableRevisionFields.name,
    published_neighborhood: nullableRevisionFields.neighborhood,
    published_postal_code: nullableRevisionFields.postal_code,
    published_revision_id: nullableRevisionFields.id,
    published_revision_number: nullableRevisionFields.number,
    published_state: nullableRevisionFields.state,
    published_street: nullableRevisionFields.street,
    published_street_number: nullableRevisionFields.street_number,
    published_studio_type_id: nullableRevisionFields.studio_type_id,
    published_studio_type_name: nullableRevisionFields.studio_type_name,
    scope: z.uuid(),
    studio_id: z.uuid(),
    studio_status: studioStatusSchema,
  })
  .superRefine((row, context) => {
    addRevisionGroupIssues(context, "draft", {
      addressComplement: row.draft_address_complement,
      capacity: row.draft_capacity,
      city: row.draft_city,
      description: row.draft_description,
      id: row.draft_revision_id,
      name: row.draft_name,
      neighborhood: row.draft_neighborhood,
      number: row.draft_revision_number,
      postalCode: row.draft_postal_code,
      state: row.draft_state,
      street: row.draft_street,
      streetNumber: row.draft_street_number,
      studioTypeId: row.draft_studio_type_id,
      studioTypeName: row.draft_studio_type_name,
    });
    addRevisionGroupIssues(context, "published", {
      addressComplement: row.published_address_complement,
      capacity: row.published_capacity,
      city: row.published_city,
      description: row.published_description,
      id: row.published_revision_id,
      name: row.published_name,
      neighborhood: row.published_neighborhood,
      number: row.published_revision_number,
      postalCode: row.published_postal_code,
      state: row.published_state,
      street: row.published_street,
      streetNumber: row.published_street_number,
      studioTypeId: row.published_studio_type_id,
      studioTypeName: row.published_studio_type_name,
    });
    if (row.draft_revision_id === null && row.published_revision_id === null) {
      context.addIssue({
        code: "custom",
        message: "O editor não possui revisão de rascunho nem publicada.",
        path: ["draft_revision_id"],
      });
    }
    if (
      row.studio_status === "draft" &&
      (row.draft_revision_id === null || row.published_revision_id !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "O estúdio draft possui ponteiros incoerentes.",
        path: ["studio_status"],
      });
    }
    if (row.studio_status === "published" && row.published_revision_id === null) {
      context.addIssue({
        code: "custom",
        message: "O estúdio published não possui revisão publicada.",
        path: ["studio_status"],
      });
    }
  });

const discardStudioDraftDalRowSchema = z
  .strictObject({
    draft_discarded: z.boolean(),
    edit_version: databasePositiveIntegerSchema.nullable(),
    scope: z.uuid(),
    studio_deleted: z.boolean(),
    studio_id: z.uuid(),
  })
  .superRefine((row, context) => {
    if (row.draft_discarded === row.studio_deleted) {
      context.addIssue({
        code: "custom",
        message: "O descarte precisa produzir exatamente um resultado.",
      });
    }
    if (row.draft_discarded && row.edit_version === null) {
      context.addIssue({
        code: "custom",
        message: "O descarte de rascunho precisa retornar a nova versão de edição.",
        path: ["edit_version"],
      });
    }
    if (row.studio_deleted && row.edit_version !== null) {
      context.addIssue({
        code: "custom",
        message: "A remoção do estúdio não pode retornar uma versão de edição.",
        path: ["edit_version"],
      });
    }
  });

const studioEditorProjection = `scope,
       studio_id,
       studio_status,
       edit_version,
       draft_revision_id,
       draft_revision_number,
       draft_name,
       draft_description,
       draft_street,
       draft_street_number,
       draft_address_complement,
       draft_neighborhood,
       draft_city,
       draft_state,
       draft_postal_code,
       draft_capacity,
       draft_studio_type_id,
       draft_studio_type_name,
       published_revision_id,
       published_revision_number,
       published_name,
       published_description,
       published_street,
       published_street_number,
       published_address_complement,
       published_neighborhood,
       published_city,
       published_state,
       published_postal_code,
       published_capacity,
       published_studio_type_id,
       published_studio_type_name`;

export type OwnerStudioEditorDalRow = z.infer<typeof ownerStudioEditorDalRowSchema>;

function parseExactlyOneRow<T>(rows: readonly unknown[], schema: z.ZodType<T>) {
  if (rows.length !== 1) {
    throw new Error("O DAL de estúdio recebeu uma cardinalidade inesperada.");
  }
  return schema.parse(rows[0]);
}

export function parseOwnerStudioEditorDalRow(row: unknown) {
  return ownerStudioEditorDalRowSchema.parse(row);
}

export function parseDiscardStudioDraftDalRow(row: unknown) {
  return discardStudioDraftDalRowSchema.parse(row);
}

function parseStudioWriteInput(input: {
  core: StudioCoreInput;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}) {
  return z
    .strictObject({
      core: studioCoreInputSchema,
      idempotencyKey: z.uuid(),
      requestId: z.uuid(),
      studioId: z.uuid(),
      userId: z.uuid(),
    })
    .parse(input);
}

function coreParameters(core: StudioCoreInput) {
  return [
    core.name,
    core.description,
    core.address.street,
    core.address.streetNumber,
    core.address.complement,
    core.address.neighborhood,
    core.address.postalCode,
    core.capacity,
    core.studioTypeId,
  ] as const;
}

export async function createStudioDraft(input: {
  core: StudioCoreInput;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}) {
  const parsed = parseStudioWriteInput(input);
  const result = await commandDalPool().query(
    `select ${studioEditorProjection}
       from private.create_studio(
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4::uuid,
         $5::text,
         $6::text,
         $7::text,
         $8::text,
         $9::text,
         $10::text,
         $11::text,
         $12::integer,
         $13::uuid
       )`,
    [
      parsed.userId,
      parsed.studioId,
      parsed.idempotencyKey,
      parsed.requestId,
      ...coreParameters(parsed.core),
    ],
  );
  return parseExactlyOneRow(result.rows, ownerStudioEditorDalRowSchema);
}

export async function updateStudioDraftCore(input: {
  core: StudioCoreInput;
  expectedEditVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}) {
  const parsed = z
    .strictObject({
      ...z.strictObject({
        core: studioCoreInputSchema,
        idempotencyKey: z.uuid(),
        requestId: z.uuid(),
        studioId: z.uuid(),
        userId: z.uuid(),
      }).shape,
      expectedEditVersion: studioEditVersionSchema,
    })
    .parse(input);
  const result = await commandDalPool().query(
    `select ${studioEditorProjection}
       from private.update_studio_revision_core(
         $1::uuid,
         $2::uuid,
         $3::bigint,
         $4::uuid,
         $5::uuid,
         $6::text,
         $7::text,
         $8::text,
         $9::text,
         $10::text,
         $11::text,
         $12::text,
         $13::integer,
         $14::uuid
       )`,
    [
      parsed.userId,
      parsed.studioId,
      parsed.expectedEditVersion,
      parsed.idempotencyKey,
      parsed.requestId,
      ...coreParameters(parsed.core),
    ],
  );
  return parseExactlyOneRow(result.rows, ownerStudioEditorDalRowSchema);
}

export async function discardStudioDraft(input: {
  expectedEditVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}) {
  const parsed = z
    .strictObject({
      expectedEditVersion: studioEditVersionSchema,
      idempotencyKey: z.uuid(),
      requestId: z.uuid(),
      studioId: z.uuid(),
      userId: z.uuid(),
    })
    .parse(input);
  const result = await commandDalPool().query(
    `select scope,
            studio_id,
            studio_deleted,
            draft_discarded,
            edit_version
       from private.discard_studio_draft(
         $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid
       )`,
    [
      parsed.userId,
      parsed.studioId,
      parsed.expectedEditVersion,
      parsed.idempotencyKey,
      parsed.requestId,
    ],
  );
  return parseExactlyOneRow(result.rows, discardStudioDraftDalRowSchema);
}

function mapDraftRevision(row: OwnerStudioEditorDalRow) {
  if (row.draft_revision_id === null) return null;
  return {
    core: {
      address: {
        complement: row.draft_address_complement,
        neighborhood: row.draft_neighborhood,
        postalCode: row.draft_postal_code,
        street: row.draft_street,
        streetNumber: row.draft_street_number,
      },
      capacity: row.draft_capacity,
      city: row.draft_city,
      description: row.draft_description,
      name: row.draft_name,
      state: row.draft_state,
      studioTypeId: row.draft_studio_type_id,
      studioTypeName: row.draft_studio_type_name,
    },
    revisionNumber: row.draft_revision_number,
  };
}

function mapPublishedRevision(row: OwnerStudioEditorDalRow) {
  if (row.published_revision_id === null) return null;
  return {
    core: {
      address: {
        complement: row.published_address_complement,
        neighborhood: row.published_neighborhood,
        postalCode: row.published_postal_code,
        street: row.published_street,
        streetNumber: row.published_street_number,
      },
      capacity: row.published_capacity,
      city: row.published_city,
      description: row.published_description,
      name: row.published_name,
      state: row.published_state,
      studioTypeId: row.published_studio_type_id,
      studioTypeName: row.published_studio_type_name,
    },
    revisionNumber: row.published_revision_number,
  };
}

export function mapOwnerStudioEditorDalRow(
  row: OwnerStudioEditorDalRow,
  expectedUserId: string,
  studioTypes: readonly StudioTypeOption[],
): OwnerStudioEditorEditResult {
  if (row.scope !== expectedUserId) {
    throw new Error("O editor de estúdio retornado não corresponde à sessão autenticada.");
  }
  return ownerStudioEditorEditResultSchema.parse({
    mode: "edit",
    projection: "studio_editor",
    scope: row.scope,
    studio: {
      draft: mapDraftRevision(row),
      editVersion: row.edit_version,
      id: row.studio_id,
      published: mapPublishedRevision(row),
      status: row.studio_status,
    },
    studioTypes: studioTypes.map((option) => studioTypeOptionSchema.parse(option)),
  });
}
