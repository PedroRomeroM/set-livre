import "server-only";

import {
  studioCorePayloadSchema,
  studioContentPayloadSchema,
  studioDraftDiscardResultSchema,
  studioEditorSchema,
  studioTaxonomyPayloadSchema,
  type StudioContentPayload,
  type StudioCorePayload,
  type StudioDraftDiscardResult,
  type StudioEditor,
  type StudioTaxonomyPayload,
} from "@set-livre/contracts";
import { z } from "zod";

import { commandDalPool } from "@/lib/server/dal-pool";

import { parseStudioCommandResult, type StudioCommandResult } from "./studio-command-result";

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

export async function createStudioDraft(input: {
  core: StudioCorePayload;
  idempotencyKey: string;
  requestId: string;
  userId: string;
}): Promise<StudioCommandResult<StudioEditor>> {
  const identity = commandIdentitySchema.parse({
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    userId: input.userId,
  });
  const core = studioCorePayloadSchema.parse(input.core);
  const result = await commandDalPool().query(
    `select private.bind_studio_command_result($1::uuid, $2::uuid, private.create_studio(
       $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
       $7::text, $8::text, $9::text, $10::text, $11::text, $12::text,
       $13::integer, $14::uuid
     )) as result`,
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
  return parseStudioCommandResult(result.rows, studioEditorSchema, {
    ...identity,
    action: "studio.create",
  });
}

export async function updateStudioRevisionCore(input: {
  core: StudioCorePayload;
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}): Promise<StudioCommandResult<StudioEditor>> {
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
    `select private.bind_studio_command_result($1::uuid, $5::uuid, private.update_studio_revision_core(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid,
       $7::text, $8::text, $9::text, $10::text, $11::text, $12::text,
       $13::text, $14::text, $15::text, $16::integer, $17::uuid
     )) as result`,
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
  return parseStudioCommandResult(result.rows, studioEditorSchema, {
    ...identity,
    action: "studio.revision.updateCore",
  });
}

export async function discardStudioDraft(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}): Promise<StudioCommandResult<StudioDraftDiscardResult>> {
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
    `select private.bind_studio_command_result($1::uuid, $5::uuid, private.discard_studio_draft(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid
     )) as result`,
    [
      identity.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      identity.idempotencyKey,
      identity.requestId,
    ],
  );
  return parseStudioCommandResult(result.rows, studioDraftDiscardResultSchema, {
    ...identity,
    action: "studio.draft.discard",
  });
}

export async function updateStudioRevisionTaxonomy(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  taxonomy: StudioTaxonomyPayload;
  userId: string;
}): Promise<StudioCommandResult<StudioEditor>> {
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
  const taxonomy = studioTaxonomyPayloadSchema.parse(input.taxonomy);
  const result = await commandDalPool().query(
    `select private.bind_studio_command_result($1::uuid, $5::uuid, private.update_studio_revision_taxonomy(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid,
       $7::uuid[], $8::uuid[]
     )) as result`,
    [
      identity.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      identity.idempotencyKey,
      identity.requestId,
      taxonomy.tagIds,
      taxonomy.amenityIds,
    ],
  );
  return parseStudioCommandResult(result.rows, studioEditorSchema, {
    ...identity,
    action: "studio.revision.updateTaxonomy",
  });
}

export async function updateStudioRevisionContent(input: {
  content: StudioContentPayload;
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}): Promise<StudioCommandResult<StudioEditor>> {
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
  const content = studioContentPayloadSchema.parse(input.content);
  const result = await commandDalPool().query(
    `select private.bind_studio_command_result($1::uuid, $5::uuid, private.update_studio_revision_content(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid,
       $7::text, $8::text, $9::jsonb
     )) as result`,
    [
      identity.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      identity.idempotencyKey,
      identity.requestId,
      content.usageRules,
      content.youtubeVideoId,
      JSON.stringify(content.faqs),
    ],
  );
  return parseStudioCommandResult(result.rows, studioEditorSchema, {
    ...identity,
    action: "studio.revision.updateContent",
  });
}
