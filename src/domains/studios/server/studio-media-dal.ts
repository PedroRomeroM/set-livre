import "server-only";

import {
  studioMediaGalleryRecordSchema,
  studioMediaMimeTypeSchema,
  studioMediaUploadCandidateSchema,
  studioMediaUploadPreparationRecordSchema,
  studioMediaVerificationSchema,
  type StudioMediaGalleryRecord,
  type StudioMediaMimeType,
  type StudioMediaUploadCandidate,
  type StudioMediaUploadPreparationRecord,
  type StudioMediaVerification,
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
    throw new Error("O DAL de mídia recebeu uma cardinalidade inesperada.");
  }
  return z.strictObject({ result: schema }).parse(rows[0]).result;
}

export async function readOwnerStudioMediaRecord(input: {
  studioId: string;
  userId: string;
}): Promise<StudioMediaGalleryRecord | null> {
  const parsed = z.strictObject({ studioId: z.uuid(), userId: z.uuid() }).parse(input);
  const result = await commandDalPool().query(
    `select private.get_owner_studio_media($1::uuid, $2::uuid) as result`,
    [parsed.userId, parsed.studioId],
  );
  return exactlyOneResult(result.rows, studioMediaGalleryRecordSchema.nullable());
}

function parseRevisionIdentity(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  studioId: string;
}) {
  return revisionIdentitySchema.parse({
    expectedRevisionId: input.expectedRevisionId,
    expectedRevisionVersion: input.expectedRevisionVersion,
    studioId: input.studioId,
  });
}

function parseCommandIdentity(input: {
  idempotencyKey: string;
  requestId: string;
  userId: string;
}) {
  return commandIdentitySchema.parse({
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    userId: input.userId,
  });
}

export async function prepareStudioMediaUpload(input: {
  declaredByteSize: number;
  declaredChecksumSha256: string | null;
  declaredMimeType: StudioMediaMimeType;
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}): Promise<StudioMediaUploadPreparationRecord> {
  const command = parseCommandIdentity(input);
  const revision = parseRevisionIdentity(input);
  const declaredMimeType = studioMediaMimeTypeSchema.parse(input.declaredMimeType);
  const result = await commandDalPool().query(
    `select private.prepare_studio_media_upload(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid,
       $7::text, $8::bigint, $9::text
     ) as result`,
    [
      command.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      command.idempotencyKey,
      command.requestId,
      declaredMimeType,
      input.declaredByteSize,
      input.declaredChecksumSha256,
    ],
  );
  return exactlyOneResult(result.rows, studioMediaUploadPreparationRecordSchema);
}

export async function readStudioMediaUploadCandidate(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  mediaId: string;
  studioId: string;
  userId: string;
}): Promise<StudioMediaUploadCandidate> {
  const revision = parseRevisionIdentity(input);
  const parsed = z.strictObject({ mediaId: z.uuid(), userId: z.uuid() }).parse({
    mediaId: input.mediaId,
    userId: input.userId,
  });
  const result = await commandDalPool().query(
    `select private.get_studio_media_upload_candidate(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid
     ) as result`,
    [
      parsed.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      parsed.mediaId,
    ],
  );
  return exactlyOneResult(result.rows, studioMediaUploadCandidateSchema);
}

export async function replayStudioMediaFinalize(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  mediaId: string;
  studioId: string;
  userId: string;
}): Promise<StudioMediaGalleryRecord | null> {
  const revision = parseRevisionIdentity(input);
  const parsed = z
    .strictObject({
      idempotencyKey: z.uuid(),
      mediaId: z.uuid(),
      userId: z.uuid(),
    })
    .parse({
      idempotencyKey: input.idempotencyKey,
      mediaId: input.mediaId,
      userId: input.userId,
    });
  const result = await commandDalPool().query(
    `select private.replay_studio_media_finalize(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid
     ) as result`,
    [
      parsed.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      parsed.idempotencyKey,
      parsed.mediaId,
    ],
  );
  return exactlyOneResult(result.rows, studioMediaGalleryRecordSchema.nullable());
}

export async function rejectStudioMediaUpload(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  mediaId: string;
  requestId: string;
  rejectionCode: "object_missing" | "superseded" | "validation_failed";
  studioId: string;
  userId: string;
}) {
  const revision = parseRevisionIdentity(input);
  const parsed = z
    .strictObject({
      mediaId: z.uuid(),
      rejectionCode: z.enum(["object_missing", "superseded", "validation_failed"]),
      requestId: z.uuid(),
      userId: z.uuid(),
    })
    .parse({
      mediaId: input.mediaId,
      rejectionCode: input.rejectionCode,
      requestId: input.requestId,
      userId: input.userId,
    });
  await commandDalPool().query(
    `select private.reject_studio_media_upload(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid, $7::text
     )`,
    [
      parsed.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      parsed.mediaId,
      parsed.requestId,
      parsed.rejectionCode,
    ],
  );
}

export async function finalizeStudioMediaUpload(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  mediaId: string;
  requestId: string;
  studioId: string;
  userId: string;
  verification: StudioMediaVerification;
}): Promise<StudioMediaGalleryRecord> {
  const command = parseCommandIdentity(input);
  const revision = parseRevisionIdentity(input);
  const parsedMediaId = z.uuid().parse(input.mediaId);
  const verification = studioMediaVerificationSchema.parse(input.verification);
  const result = await commandDalPool().query(
    `select private.finalize_studio_media_upload(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid,
       $7::uuid, $8::text, $9::bigint, $10::integer, $11::integer, $12::text
     ) as result`,
    [
      command.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      command.idempotencyKey,
      command.requestId,
      parsedMediaId,
      verification.mimeType,
      verification.byteSize,
      verification.width,
      verification.height,
      verification.checksumSha256,
    ],
  );
  return exactlyOneResult(result.rows, studioMediaGalleryRecordSchema);
}

async function mutateStudioMedia(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  functionName: "delete_studio_media" | "reorder_studio_media" | "set_studio_media_cover";
  idempotencyKey: string;
  mediaId?: string;
  orderedMediaIds?: readonly string[];
  requestId: string;
  studioId: string;
  userId: string;
}): Promise<StudioMediaGalleryRecord> {
  const command = parseCommandIdentity(input);
  const revision = parseRevisionIdentity(input);
  const values: readonly unknown[] = [
    command.userId,
    revision.studioId,
    revision.expectedRevisionId,
    revision.expectedRevisionVersion,
    command.idempotencyKey,
    command.requestId,
  ];
  const argument =
    input.functionName === "reorder_studio_media"
      ? z.array(z.uuid()).parse(input.orderedMediaIds)
      : z.uuid().parse(input.mediaId);
  const argumentType = input.functionName === "reorder_studio_media" ? "uuid[]" : "uuid";
  const result = await commandDalPool().query(
    `select private.${input.functionName}(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid, $7::${argumentType}
     ) as result`,
    [...values, argument],
  );
  return exactlyOneResult(result.rows, studioMediaGalleryRecordSchema);
}

export function reorderStudioMedia(
  input: Omit<Parameters<typeof mutateStudioMedia>[0], "functionName" | "mediaId"> & {
    orderedMediaIds: readonly string[];
  },
) {
  return mutateStudioMedia({ ...input, functionName: "reorder_studio_media" });
}

export function setStudioMediaCover(
  input: Omit<Parameters<typeof mutateStudioMedia>[0], "functionName" | "orderedMediaIds"> & {
    mediaId: string;
  },
) {
  return mutateStudioMedia({ ...input, functionName: "set_studio_media_cover" });
}

export function deleteStudioMedia(
  input: Omit<Parameters<typeof mutateStudioMedia>[0], "functionName" | "orderedMediaIds"> & {
    mediaId: string;
  },
) {
  return mutateStudioMedia({ ...input, functionName: "delete_studio_media" });
}
