import "server-only";

import {
  studioMediaGalleryRecordSchema,
  studioMediaMimeTypeSchema,
  studioMediaUploadCandidateSchema,
  studioMediaUploadPreparationRecordSchema,
  studioMediaVerificationSchema,
  type StudioMediaGalleryRecord,
  type StudioMediaMimeType,
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

const studioMediaFinalizeClaimWaitMs = 8_000;
const studioMediaFinalizeClaimSchema = z.discriminatedUnion("state", [
  z.strictObject({
    candidate: studioMediaUploadCandidateSchema,
    claimToken: z.uuid(),
    leaseExpiresAt: z.iso.datetime({ offset: true }),
    state: z.literal("acquired"),
  }),
  z.strictObject({
    claimToken: z.uuid(),
    leaseExpiresAt: z.iso.datetime({ offset: true }),
    state: z.literal("superseded"),
  }),
  z.strictObject({ result: studioMediaGalleryRecordSchema, state: z.literal("replay") }),
  z.strictObject({
    rejectionCode: z.enum(["object_missing", "superseded", "validation_failed"]),
    state: z.literal("rejected"),
  }),
  z.strictObject({
    retryAfterMs: z.number().int().min(1).max(250),
    state: z.literal("waiting"),
  }),
]);
const studioMediaFinalizeLeaseSchema = z.strictObject({
  leaseExpiresAt: z.iso.datetime({ offset: true }),
});
type StudioMediaFinalizeWorkClaim = Exclude<
  z.infer<typeof studioMediaFinalizeClaimSchema>,
  { state: "waiting" }
>;

export class StudioMediaFinalizeClaimBusyError extends Error {
  constructor() {
    super("Outra solicitação idêntica ainda está finalizando esta foto.");
    this.name = "StudioMediaFinalizeClaimBusyError";
  }
}

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

export async function withStudioMediaFinalizeClaim<T>(
  input: {
    expectedRevisionId: string;
    expectedRevisionVersion: number;
    idempotencyKey: string;
    mediaId: string;
    requestId: string;
    studioId: string;
    userId: string;
  },
  work: (claim: StudioMediaFinalizeWorkClaim) => Promise<T>,
): Promise<T> {
  const command = parseCommandIdentity(input);
  const revision = parseRevisionIdentity(input);
  const mediaId = z.uuid().parse(input.mediaId);
  const pool = commandDalPool();
  const deadlineAt = Date.now() + studioMediaFinalizeClaimWaitMs;

  while (true) {
    const result = await pool.query(
      `select private.begin_studio_media_finalize_claim(
         $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid, $7::uuid
       ) as result`,
      [
        command.userId,
        revision.studioId,
        revision.expectedRevisionId,
        revision.expectedRevisionVersion,
        command.idempotencyKey,
        command.requestId,
        mediaId,
      ],
    );
    const claim = exactlyOneResult(result.rows, studioMediaFinalizeClaimSchema);
    if (claim.state === "waiting") {
      if (Date.now() >= deadlineAt) throw new StudioMediaFinalizeClaimBusyError();
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(claim.retryAfterMs, Math.max(1, deadlineAt - Date.now()))),
      );
      continue;
    }
    if (claim.state === "replay" || claim.state === "rejected") return work(claim);

    let workFailed = false;
    try {
      return await work(claim);
    } catch (error) {
      workFailed = true;
      throw error;
    } finally {
      try {
        const released = await pool.query(
          `select private.release_studio_media_finalize_claim($1::uuid) as result`,
          [claim.claimToken],
        );
        if (!exactlyOneResult(released.rows, z.boolean()) && !workFailed) {
          throw new StudioMediaFinalizeClaimBusyError();
        }
      } catch (error) {
        if (!workFailed) throw error;
      }
    }
  }
}

export async function renewStudioMediaFinalizeClaim(input: { claimToken: string }) {
  const parsed = z.strictObject({ claimToken: z.uuid() }).parse(input);
  const result = await commandDalPool().query(
    `select private.renew_studio_media_finalize_claim($1::uuid) as result`,
    [parsed.claimToken],
  );
  return exactlyOneResult(result.rows, studioMediaFinalizeLeaseSchema);
}

export async function rejectStudioMediaUpload(input: {
  claimToken: string;
  requestId: string;
  rejectionCode: "object_missing" | "superseded" | "validation_failed";
}) {
  const parsed = z
    .strictObject({
      claimToken: z.uuid(),
      rejectionCode: z.enum(["object_missing", "superseded", "validation_failed"]),
      requestId: z.uuid(),
    })
    .parse(input);
  await commandDalPool().query(
    `select private.reject_studio_media_upload_claimed(
       $1::uuid, $2::uuid, $3::text
     )`,
    [parsed.claimToken, parsed.requestId, parsed.rejectionCode],
  );
}

export async function finalizeStudioMediaUpload(input: {
  claimToken: string;
  requestId: string;
  verification: StudioMediaVerification;
}): Promise<StudioMediaGalleryRecord> {
  const claimToken = z.uuid().parse(input.claimToken);
  const requestId = z.uuid().parse(input.requestId);
  const verification = studioMediaVerificationSchema.parse(input.verification);
  const result = await commandDalPool().query(
    `select private.finalize_studio_media_upload_claimed(
       $1::uuid, $2::uuid, $3::text, $4::bigint, $5::integer, $6::integer,
       $7::text
     ) as result`,
    [
      claimToken,
      requestId,
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
