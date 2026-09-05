import "server-only";

import { studioPublicationRecordSchema, type StudioPublicationRecord } from "@set-livre/contracts";
import { z } from "zod";

import { commandDalPool } from "@/lib/server/dal-pool";

const commandIdentitySchema = z.strictObject({
  idempotencyKey: z.uuid(),
  requestId: z.uuid(),
  userId: z.uuid(),
});

const studioIdentitySchema = z.strictObject({
  studioId: z.uuid(),
  userId: z.uuid(),
});

const revisionBoundarySchema = z.strictObject({
  expectedRevisionId: z.uuid(),
  expectedRevisionVersion: z.number().int().positive(),
  studioId: z.uuid(),
});

const publicationBoundarySchema = z.strictObject({
  expectedPublicationVersion: z.number().int().positive(),
  studioId: z.uuid(),
});

const publicationMutationStatement = {
  pause_studio: `select private.pause_studio(
    $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid
  ) as result`,
  resume_studio: `select private.resume_studio(
    $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::uuid
  ) as result`,
} as const;

function exactlyOneResult<T>(rows: readonly unknown[], schema: z.ZodType<T>): T {
  if (rows.length !== 1) {
    throw new Error("O DAL de publicação recebeu uma cardinalidade inesperada.");
  }
  return z.strictObject({ result: schema }).parse(rows[0]).result;
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

export async function readOwnerStudioPublicationRecord(input: {
  studioId: string;
  userId: string;
}): Promise<StudioPublicationRecord | null> {
  const identity = studioIdentitySchema.parse(input);
  const result = await commandDalPool().query(
    `select private.get_owner_studio_publication($1::uuid, $2::uuid) as result`,
    [identity.userId, identity.studioId],
  );
  return exactlyOneResult(result.rows, studioPublicationRecordSchema.nullable());
}

export async function submitStudioRevision(input: {
  expectedRevisionId: string;
  expectedRevisionVersion: number;
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}): Promise<StudioPublicationRecord> {
  const command = parseCommandIdentity(input);
  const revision = revisionBoundarySchema.parse({
    expectedRevisionId: input.expectedRevisionId,
    expectedRevisionVersion: input.expectedRevisionVersion,
    studioId: input.studioId,
  });
  const result = await commandDalPool().query(
    `select private.submit_studio_revision(
       $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::uuid
     ) as result`,
    [
      command.userId,
      revision.studioId,
      revision.expectedRevisionId,
      revision.expectedRevisionVersion,
      command.idempotencyKey,
      command.requestId,
    ],
  );
  return exactlyOneResult(result.rows, studioPublicationRecordSchema);
}

async function mutateStudioPublication(input: {
  expectedPublicationVersion: number;
  functionName: "pause_studio" | "resume_studio";
  idempotencyKey: string;
  requestId: string;
  studioId: string;
  userId: string;
}): Promise<StudioPublicationRecord> {
  const command = parseCommandIdentity(input);
  const publication = publicationBoundarySchema.parse({
    expectedPublicationVersion: input.expectedPublicationVersion,
    studioId: input.studioId,
  });
  const result = await commandDalPool().query(publicationMutationStatement[input.functionName], [
    command.userId,
    publication.studioId,
    publication.expectedPublicationVersion,
    command.idempotencyKey,
    command.requestId,
  ]);
  return exactlyOneResult(result.rows, studioPublicationRecordSchema);
}

export function pauseStudio(
  input: Omit<Parameters<typeof mutateStudioPublication>[0], "functionName">,
) {
  return mutateStudioPublication({ ...input, functionName: "pause_studio" });
}

export function resumeStudio(
  input: Omit<Parameters<typeof mutateStudioPublication>[0], "functionName">,
) {
  return mutateStudioPublication({ ...input, functionName: "resume_studio" });
}
