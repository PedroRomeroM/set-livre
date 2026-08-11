import "server-only";

import { parseDalDatabaseUrl } from "@set-livre/contracts";
import { Pool } from "pg";
import { z } from "zod";

const environmentSchema = z.object({ DATABASE_URL_APP_DAL: z.string() });
const intentResultSchema = z.object({ intent_id: z.uuid() });
const recoveryContextResultSchema = z.strictObject({
  grant_token: z.uuid(),
  session_scope: z.uuid(),
});
const recoveryGrantBooleanResultSchema = z.object({ result: z.boolean() });
const recoverySessionIdentitySchema = z.strictObject({
  authSessionId: z.uuid(),
  sessionScope: z.uuid(),
  token: z.uuid(),
  userId: z.uuid(),
});
const recoveryGrantAttemptSchema = recoverySessionIdentitySchema.extend({ attemptId: z.uuid() });
const recoverySessionIssueSchema = z.strictObject({
  authExpiresAt: z.iso.datetime({ offset: true }),
  authSessionId: z.uuid(),
  userId: z.uuid(),
});
const recoverySessionInspectionInputSchema = recoverySessionIssueSchema.extend({
  sessionScope: z.uuid().nullable(),
  token: z.uuid().nullable(),
});
const recoverySessionInspectionResultSchema = z.strictObject({
  active: z.boolean(),
  grant_allowed: z.boolean(),
  session_scope: z.uuid(),
});
const recoverySessionCloseSchema = z.strictObject({
  authSessionId: z.uuid(),
  userId: z.uuid(),
});
const evidenceHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();
let connection: { pool: Pool; sessionRole: string } | undefined;

function parseExactlyOneRow<T>(rows: readonly unknown[], schema: z.ZodType<T>) {
  if (rows.length !== 1) {
    throw new Error("O DAL de identidade recebeu uma cardinalidade inesperada.");
  }
  return schema.parse(rows[0]);
}

function parseOptionalRow<T>(rows: readonly unknown[], schema: z.ZodType<T>) {
  if (rows.length === 0) {
    return undefined;
  }
  return parseExactlyOneRow(rows, schema);
}

function identityDatabaseConnection() {
  if (connection !== undefined) {
    return connection;
  }

  const environment = environmentSchema.parse(process.env);
  const parsed = parseDalDatabaseUrl(environment.DATABASE_URL_APP_DAL);
  const pool = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-web-identity",
    connectionString: parsed.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 4,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  pool.on("error", () => undefined);
  connection = { pool, sessionRole: parsed.sessionRole };
  return connection;
}

export async function createSignupLegalIntent(input: {
  evidence: Readonly<{ ipHash: string | null; userAgentHash: string | null }>;
  personType: "company" | "individual";
  privacyVersionId: string;
  requestId: string;
  termsVersionId: string;
}) {
  const evidence = z
    .strictObject({ ipHash: evidenceHashSchema, userAgentHash: evidenceHashSchema })
    .parse(input.evidence);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.create_signup_legal_intent($1::uuid, $2::uuid, $3::text, $4::uuid, $5::jsonb) as intent_id`,
    [
      input.termsVersionId,
      input.privacyVersionId,
      input.personType,
      input.requestId,
      JSON.stringify(evidence),
    ],
  );
  return parseExactlyOneRow(result.rows, intentResultSchema).intent_id;
}

export async function issueIdentityRecoveryContext(input: {
  authExpiresAt: string;
  authSessionId: string;
  userId: string;
}) {
  const parsed = recoverySessionIssueSchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select grant_token, session_scope
       from private.issue_identity_recovery_context($1::uuid, $2::uuid, $3::timestamptz)`,
    [parsed.userId, parsed.authSessionId, parsed.authExpiresAt],
  );
  const context = parseExactlyOneRow(result.rows, recoveryContextResultSchema);
  return { sessionScope: context.session_scope, token: context.grant_token };
}

export async function inspectIdentityRecoverySession(input: {
  authExpiresAt: string;
  authSessionId: string;
  sessionScope: string | null;
  token: string | null;
  userId: string;
}) {
  const parsed = recoverySessionInspectionInputSchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select session_scope, active, grant_allowed
       from private.inspect_identity_recovery_session(
         $1::uuid,
         $2::uuid,
         $3::timestamptz,
         $4::uuid,
         $5::uuid
       )`,
    [parsed.userId, parsed.authSessionId, parsed.authExpiresAt, parsed.token, parsed.sessionScope],
  );
  const inspection = parseOptionalRow(result.rows, recoverySessionInspectionResultSchema);
  return inspection === undefined
    ? undefined
    : {
        active: inspection.active,
        grantAllowed: inspection.grant_allowed,
        sessionScope: inspection.session_scope,
      };
}

export async function claimIdentityRecoveryContext(input: {
  attemptId: string;
  authSessionId: string;
  sessionScope: string;
  token: string;
  userId: string;
}) {
  const parsed = recoveryGrantAttemptSchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.claim_identity_recovery_context(
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::uuid,
       $5::uuid
     ) as result`,
    [parsed.token, parsed.userId, parsed.authSessionId, parsed.sessionScope, parsed.attemptId],
  );
  return parseExactlyOneRow(result.rows, recoveryGrantBooleanResultSchema).result;
}

export async function releaseIdentityRecoveryContext(input: {
  attemptId: string;
  authSessionId: string;
  sessionScope: string;
  token: string;
  userId: string;
}) {
  const parsed = recoveryGrantAttemptSchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.release_identity_recovery_context(
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::uuid,
       $5::uuid
     ) as result`,
    [parsed.token, parsed.userId, parsed.authSessionId, parsed.sessionScope, parsed.attemptId],
  );
  return parseExactlyOneRow(result.rows, recoveryGrantBooleanResultSchema).result;
}

export async function consumeIdentityRecoveryContext(input: {
  attemptId: string;
  authSessionId: string;
  sessionScope: string;
  token: string;
  userId: string;
}) {
  const parsed = recoveryGrantAttemptSchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.consume_identity_recovery_context(
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::uuid,
       $5::uuid
     ) as result`,
    [parsed.token, parsed.userId, parsed.authSessionId, parsed.sessionScope, parsed.attemptId],
  );
  return parseExactlyOneRow(result.rows, recoveryGrantBooleanResultSchema).result;
}

export async function closeIdentityRecoverySession(input: {
  authSessionId: string;
  userId: string;
}) {
  const parsed = recoverySessionCloseSchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.close_identity_recovery_session($1::uuid, $2::uuid) as result`,
    [parsed.userId, parsed.authSessionId],
  );
  return parseExactlyOneRow(result.rows, recoveryGrantBooleanResultSchema).result;
}
