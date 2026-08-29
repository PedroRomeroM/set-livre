import "server-only";

import {
  studioCorePayloadSchema,
  studioDraftDiscardResultSchema,
  studioEditorSchema,
  type StudioCorePayload,
  type StudioDraftDiscardResult,
  type StudioEditor,
} from "@set-livre/contracts";
import { z } from "zod";

import { commandDalPool } from "@/lib/server/dal-pool";

const commandIdentitySchema = z.strictObject({
  idempotencyKey: z.uuid(),
  requestId: z.uuid(),
  userId: z.uuid(),
});

const revisionIdentitySchema = z.strictObject({
  expectedRevisionId: z.uuid(),
  expectedRevisionVersion: z.number().int().positive(),
  studioId: z.uuid(),
});

function exactlyOneResult<T>(rows: readonly unknown[], schema: z.ZodType<T>): T {
  if (rows.length !== 1) {
    throw new Error("O DAL de estúdio recebeu uma cardinalidade inesperada.");
  }
  return z.strictObject({ result: schema }).parse(rows[0]).result;
}

export async function createStudioDraft(input: {
  core: StudioCorePayload;
  idempotencyKey: string;
  requestId: string;
  userId: string;
}): Promise<StudioEditor> {
  const identity = commandIdentitySchema.parse({
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    userId: input.userId,
  });
  const core = studioCorePayloadSchema.parse(input.core);
  const result = await commandDalPool().query(
    `select private.create_studio(
       $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
       $7::text, $8::text, $9::text, $10::text, $11::text, $12::text,
       $13::integer, $14::uuid
     ) as result`,
    [
      identity.userId,
      identity.idempotencyKey,
      identity.requestId,
      core.name,
      core.description,
      core.street,
      core.streetNumber,
      core.addressComplement,
      core.neighborhood,
      core.city,
      core.state,
      core.postalCode,
      core.capacity,
      core.studioTypeId,
    ],
  );
  return exactlyOneResult(result.rows, studioEditorSchema);
}

export async function updateStudioRevisionCore(input: {
  core: StudioCorePayload;
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}): Promise<StudioEditor> {
  const identity = commandIdentitySchema.parse({
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    userId: input.userId,
  });
  const revision = revisionIdentitySchema.parse({
    expectedRevisionId: input.expectedRevisionId,
    expectedRevisionVersion: input.expectedRevisionVersion,
    studioId: input.studioId,
  });
  const core = studioCorePayloadSchema.parse(input.core);
  const result = await commandDalPool().query(
    `select private.update_studio_revision_core(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid,
       $7::text, $8::text, $9::text, $10::text, $11::text, $12::text,
       $13::text, $14::text, $15::text, $16::integer, $17::uuid
     ) as result`,
    [
      identity.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      identity.idempotencyKey,
      identity.requestId,
      core.name,
      core.description,
      core.street,
      core.streetNumber,
      core.addressComplement,
      core.neighborhood,
      core.city,
      core.state,
      core.postalCode,
      core.capacity,
      core.studioTypeId,
    ],
  );
  return exactlyOneResult(result.rows, studioEditorSchema);
}

export async function discardStudioDraft(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}): Promise<StudioDraftDiscardResult> {
  const identity = commandIdentitySchema.parse({
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    userId: input.userId,
  });
  const revision = revisionIdentitySchema.parse({
    expectedRevisionId: input.expectedRevisionId,
    expectedRevisionVersion: input.expectedRevisionVersion,
    studioId: input.studioId,
  });
  const result = await commandDalPool().query(
    `select private.discard_studio_draft(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid
     ) as result`,
    [
      identity.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      identity.idempotencyKey,
      identity.requestId,
    ],
  );
  return exactlyOneResult(result.rows, studioDraftDiscardResultSchema);
}
