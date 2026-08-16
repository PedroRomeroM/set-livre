import "server-only";

import {
  ownerActivationResultSchema,
  ownerCommandActionSchema,
  ownerRecipientStatusSchema,
  profileVersionSchema,
  recipientRequirementSchema,
  recipientStatusSchema,
  type OwnerActivationResult,
  type OwnerRecipientStatus,
  type RecipientOnboardingCapability,
  type RecipientRequirement,
  type RecipientStatus,
} from "@set-livre/contracts";
import { z } from "zod";

import { commandDalPool } from "@/lib/server/dal-pool";

import { assertOwnerContractRuntime } from "./owner-runtime";

const databaseVersionSchema = z.union([
  profileVersionSchema,
  z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/u)
    .transform(Number)
    .pipe(profileVersionSchema),
]);
const ownerRecipientStatusRowShape = {
  accepted_owner_contract_version_id: z.uuid().nullable(),
  next_action: z.enum(["activate_owner", "start_onboarding", "refresh_status", "none"]),
  owner_contract_accepted: z.boolean(),
  owner_contract_effective_at: z.union([z.date(), z.iso.datetime({ offset: true })]),
  owner_contract_id: z.uuid(),
  owner_contract_source: z.enum(["local_fixture", "approved"]),
  owner_status: z.enum(["inactive", "active", "blocked"]),
  owner_version: databaseVersionSchema,
  profile_version: databaseVersionSchema,
  profile_version_synced: databaseVersionSchema.nullable(),
  provider_mode: z.literal("local"),
  recipient_status: recipientStatusSchema,
  recipient_version: databaseVersionSchema,
  requirements: z.array(recipientRequirementSchema).max(3),
  reservations_eligible: z.boolean(),
  scope: z.uuid(),
} as const;
const ownerRecipientStatusRowSchema = z.strictObject(ownerRecipientStatusRowShape);
const ownerActivationRowSchema = z.strictObject({
  ...ownerRecipientStatusRowShape,
  owner_contract_body_markdown: z.string().min(1),
  owner_contract_content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  owner_contract_kind: z.literal("owner_contract"),
  owner_contract_title: z.string().min(1),
  owner_contract_version: z.string().min(1),
});
const preparedRecipientOperationRowSchema = z.strictObject({
  already_applied: z.boolean(),
  operation_action: z.enum(["start", "refresh"]),
  operation_id: z.uuid(),
  operation_sequence: databaseVersionSchema,
  profile_version: databaseVersionSchema,
  provider_reference: z.string().min(1).max(200).nullable(),
});
const evidenceHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .nullable();
const ownerRecipientStatusProjection = `scope,
       owner_status,
       owner_version,
       accepted_owner_contract_version_id,
       owner_contract_accepted,
       owner_contract_id,
       owner_contract_source,
       owner_contract_effective_at,
       recipient_status,
       requirements,
       next_action,
       profile_version,
       profile_version_synced,
       recipient_version,
       reservations_eligible,
       provider_mode`;
const ownerActivationProjection = `scope,
       owner_status,
       owner_version,
       accepted_owner_contract_version_id,
       owner_contract_accepted,
       owner_contract_id,
       owner_contract_kind,
       owner_contract_version,
       owner_contract_title,
       owner_contract_body_markdown,
       owner_contract_content_hash,
       owner_contract_source,
       owner_contract_effective_at,
       recipient_status,
       requirements,
       next_action,
       profile_version,
       profile_version_synced,
       recipient_version,
       reservations_eligible,
       provider_mode`;

export type OwnerActivationDalRow = z.infer<typeof ownerActivationRowSchema>;
export type OwnerRecipientStatusDalRow = z.infer<typeof ownerRecipientStatusRowSchema>;
export type PreparedRecipientOperation = Readonly<{
  alreadyApplied: boolean;
  operation: "refresh" | "start";
  operationId: string;
  operationSequence: number;
  profileVersion: number;
  providerReference: string | null;
}>;

function parseExactlyOneRow<T>(rows: readonly unknown[], schema: z.ZodType<T>) {
  if (rows.length !== 1) {
    throw new Error("O DAL de dono recebeu uma cardinalidade inesperada.");
  }
  return schema.parse(rows[0]);
}

export function parseOwnerActivationDalRow(row: unknown) {
  return ownerActivationRowSchema.parse(row);
}

export function parseOwnerRecipientStatusDalRow(row: unknown) {
  return ownerRecipientStatusRowSchema.parse(row);
}

export async function getOwnerRecipientStatusForUser(userId: string) {
  const parsedUserId = z.uuid().parse(userId);
  const result = await commandDalPool().query(
    `select ${ownerRecipientStatusProjection}
       from private.get_owner_recipient_status_for_user($1::uuid)`,
    [parsedUserId],
  );
  return parseExactlyOneRow(result.rows, ownerRecipientStatusRowSchema);
}

export async function activateOwnerProfile(input: {
  idempotencyKey: string;
  ownerContractVersionId: string;
  requestId: string;
  userAgentHash: string | null;
  userId: string;
}) {
  const parsed = z
    .strictObject({
      idempotencyKey: z.uuid(),
      ownerContractVersionId: z.uuid(),
      requestId: z.uuid(),
      userAgentHash: evidenceHashSchema,
      userId: z.uuid(),
    })
    .parse(input);
  const result = await commandDalPool().query(
    `select ${ownerActivationProjection}
       from private.activate_owner($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text)`,
    [
      parsed.userId,
      parsed.ownerContractVersionId,
      parsed.idempotencyKey,
      parsed.requestId,
      parsed.userAgentHash,
    ],
  );
  return parseExactlyOneRow(result.rows, ownerActivationRowSchema);
}

export async function prepareOwnerRecipientOperation(input: {
  action: "recipient.onboarding.refresh" | "recipient.onboarding.start";
  idempotencyKey: string;
  userId: string;
}): Promise<PreparedRecipientOperation> {
  const parsed = z
    .strictObject({
      action: ownerCommandActionSchema.extract([
        "recipient.onboarding.start",
        "recipient.onboarding.refresh",
      ]),
      idempotencyKey: z.uuid(),
      userId: z.uuid(),
    })
    .parse(input);
  const result = await commandDalPool().query(
    `select operation_id,
            operation_sequence,
            operation_action,
            provider_reference,
            profile_version,
            already_applied
       from private.prepare_owner_recipient_operation($1::uuid, $2::text, $3::uuid)`,
    [
      parsed.userId,
      parsed.action === "recipient.onboarding.start" ? "start" : "refresh",
      parsed.idempotencyKey,
    ],
  );
  const row = parseExactlyOneRow(result.rows, preparedRecipientOperationRowSchema);
  return {
    alreadyApplied: row.already_applied,
    operation: row.operation_action,
    operationId: row.operation_id,
    operationSequence: row.operation_sequence,
    profileVersion: row.profile_version,
    providerReference: row.provider_reference,
  };
}

export async function applyOwnerRecipientOperation(input: {
  operationId: string;
  provider: "local";
  providerReference: string;
  requestId: string;
  requirements: readonly RecipientRequirement[];
  status: RecipientStatus;
  userId: string;
}): Promise<OwnerRecipientStatusDalRow> {
  const parsed = z
    .strictObject({
      operationId: z.uuid(),
      provider: z.literal("local"),
      providerReference: z.string().min(1).max(200),
      requestId: z.uuid(),
      requirements: z.array(recipientRequirementSchema).max(3),
      status: recipientStatusSchema.exclude(["not_started"]),
      userId: z.uuid(),
    })
    .parse(input);
  const result = await commandDalPool().query(
    `select ${ownerRecipientStatusProjection}
       from private.apply_owner_recipient_operation(
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4::text,
         $5::text,
         $6::text,
         $7::text[]
       )`,
    [
      parsed.userId,
      parsed.operationId,
      parsed.requestId,
      parsed.provider,
      parsed.providerReference,
      parsed.status,
      parsed.requirements,
    ],
  );
  return parseExactlyOneRow(result.rows, ownerRecipientStatusRowSchema);
}

function assertOwnerRecipientScope(row: OwnerRecipientStatusDalRow, expectedUserId: string) {
  if (row.scope !== expectedUserId) {
    throw new Error("O cadastro de dono retornado não corresponde à sessão autenticada.");
  }
  assertOwnerContractRuntime(row.owner_contract_source);
}

function mapOwnerRecipientState(row: OwnerRecipientStatusDalRow) {
  return {
    acceptedOwnerContractVersionId: row.accepted_owner_contract_version_id,
    nextAction: row.next_action,
    ownerContractAccepted: row.owner_contract_accepted,
    ownerStatus: row.owner_status,
    ownerVersion: row.owner_version,
    profileVersion: row.profile_version,
    profileVersionSynced: row.profile_version_synced,
    providerMode: row.provider_mode,
    recipientStatus: row.recipient_status,
    recipientVersion: row.recipient_version,
    requirements: row.requirements,
    reservationsEligible: row.reservations_eligible,
    scope: row.scope,
  };
}

export function mapOwnerRecipientStatusDalRow(
  row: OwnerRecipientStatusDalRow,
  expectedUserId: string,
  recipientOnboardingCapability: RecipientOnboardingCapability,
): OwnerRecipientStatus {
  assertOwnerRecipientScope(row, expectedUserId);
  return ownerRecipientStatusSchema.parse({
    ...mapOwnerRecipientState(row),
    ownerContract: {
      effectiveAt: new Date(row.owner_contract_effective_at).toISOString(),
      id: row.owner_contract_id,
      source: row.owner_contract_source,
    },
    projection: "recipient",
    recipientOnboardingCapability,
  });
}

export function mapOwnerActivationDalRow(
  row: OwnerActivationDalRow,
  expectedUserId: string,
  recipientOnboardingCapability: RecipientOnboardingCapability,
): OwnerActivationResult {
  assertOwnerRecipientScope(row, expectedUserId);
  return ownerActivationResultSchema.parse({
    ...mapOwnerRecipientState(row),
    ownerContract: {
      bodyMarkdown: row.owner_contract_body_markdown,
      contentHash: row.owner_contract_content_hash,
      effectiveAt: new Date(row.owner_contract_effective_at).toISOString(),
      id: row.owner_contract_id,
      kind: row.owner_contract_kind,
      source: row.owner_contract_source,
      title: row.owner_contract_title,
      version: row.owner_contract_version,
    },
    projection: "activation",
    recipientOnboardingCapability,
  });
}
