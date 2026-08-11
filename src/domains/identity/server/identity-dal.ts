import "server-only";

import { parseDalDatabaseUrl } from "@set-livre/contracts";
import { Pool } from "pg";
import { z } from "zod";

const environmentSchema = z.object({ DATABASE_URL_APP_DAL: z.string() });
const intentResultSchema = z.object({ intent_id: z.uuid() });
const recoveryGrantTokenResultSchema = z.object({ grant_token: z.uuid() });
const recoveryGrantBooleanResultSchema = z.object({ result: z.boolean() });
const recoveryGrantIdentitySchema = z.strictObject({
  token: z.uuid(),
  userId: z.uuid(),
});
const recoveryGrantAttemptSchema = recoveryGrantIdentitySchema.extend({ attemptId: z.uuid() });
const evidenceHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();
let connection: { pool: Pool; sessionRole: string } | undefined;

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
  return intentResultSchema.parse(result.rows[0]).intent_id;
}

export async function issueIdentityRecoveryGrant(userId: string) {
  const parsedUserId = z.uuid().parse(userId);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.issue_identity_recovery_grant($1::uuid) as grant_token`,
    [parsedUserId],
  );
  return recoveryGrantTokenResultSchema.parse(result.rows[0]).grant_token;
}

export async function hasIdentityRecoveryGrant(input: { token: string; userId: string }) {
  const parsed = recoveryGrantIdentitySchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.has_identity_recovery_grant($1::uuid, $2::uuid) as result`,
    [parsed.token, parsed.userId],
  );
  return recoveryGrantBooleanResultSchema.parse(result.rows[0]).result;
}

export async function claimIdentityRecoveryGrant(input: {
  attemptId: string;
  token: string;
  userId: string;
}) {
  const parsed = recoveryGrantAttemptSchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.claim_identity_recovery_grant($1::uuid, $2::uuid, $3::uuid) as result`,
    [parsed.token, parsed.userId, parsed.attemptId],
  );
  return recoveryGrantBooleanResultSchema.parse(result.rows[0]).result;
}

export async function releaseIdentityRecoveryGrant(input: {
  attemptId: string;
  token: string;
  userId: string;
}) {
  const parsed = recoveryGrantAttemptSchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.release_identity_recovery_grant($1::uuid, $2::uuid, $3::uuid) as result`,
    [parsed.token, parsed.userId, parsed.attemptId],
  );
  return recoveryGrantBooleanResultSchema.parse(result.rows[0]).result;
}

export async function consumeIdentityRecoveryGrant(input: {
  attemptId: string;
  token: string;
  userId: string;
}) {
  const parsed = recoveryGrantAttemptSchema.parse(input);
  const database = identityDatabaseConnection();
  const result = await database.pool.query(
    `select private.consume_identity_recovery_grant($1::uuid, $2::uuid, $3::uuid) as result`,
    [parsed.token, parsed.userId, parsed.attemptId],
  );
  return recoveryGrantBooleanResultSchema.parse(result.rows[0]).result;
}
