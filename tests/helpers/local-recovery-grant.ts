import { Pool } from "pg";
import { z } from "zod";

import { assertQaAuthEmail } from "./local-auth-mailpit";

const expirationInputSchema = z.strictObject({
  email: z.string(),
  userId: z.uuid(),
});
const expirationRowsSchema = z.array(z.strictObject({ expired: z.literal(true) })).length(1);
const closedSessionRowsSchema = z
  .array(
    z.strictObject({
      exact_user_count: z.literal(1),
      grant_count: z.literal(0),
      historical_binding_count: z.number().int().min(1),
      linked_auth_session_count: z.literal(0),
      open_binding_count: z.literal(0),
    }),
  )
  .length(1);

type ExpirationResult = {
  rowCount: number | null;
  rows: unknown[];
};

export type LocalRecoveryGrantPool = {
  end: () => Promise<void>;
  query: (text: string, values: readonly [string, string]) => Promise<ExpirationResult>;
};

export type LocalRecoveryGrantDependencies = {
  adminDatabaseUrl: string;
  createPool: (databaseUrl: string) => LocalRecoveryGrantPool;
  preflight: () => Promise<void>;
};

type ExpirationInput = z.infer<typeof expirationInputSchema>;

function expirationError() {
  return new Error("Não foi possível expirar o grant de recuperação local exato com segurança.");
}

function closedSessionError() {
  return new Error(
    "Não foi possível comprovar o encerramento da sessão de recuperação local exata.",
  );
}

export async function expireExactLocalRecoveryGrantWithDependencies(
  input: ExpirationInput,
  dependencies: LocalRecoveryGrantDependencies,
) {
  const parsed = expirationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("A expiração local exige e-mail QA e UUID exatos.");
  }
  const email = assertQaAuthEmail(parsed.data.email);

  try {
    await dependencies.preflight();
  } catch {
    throw new Error("O preflight do banco E2E local não foi validado para a expiração.");
  }

  let pool: LocalRecoveryGrantPool;
  try {
    pool = dependencies.createPool(dependencies.adminDatabaseUrl);
  } catch {
    throw expirationError();
  }

  let result: ExpirationResult | undefined;
  let failure: Error | undefined;
  try {
    result = await pool.query(
      `with candidate_count as (
         select pg_catalog.count(*) as exact_count
         from private.identity_recovery_grants as recovery_grant
         join private.identity_recovery_sessions as recovery_session
           on recovery_session.auth_session_id = recovery_grant.auth_session_id
          and recovery_session.user_id = recovery_grant.user_id
         join auth.sessions as auth_session
           on auth_session.id = recovery_grant.auth_session_id
          and auth_session.user_id = recovery_grant.user_id
         join auth.users as auth_user
           on auth_user.id = recovery_grant.user_id
         where recovery_grant.user_id = $1::uuid
           and auth_user.email = $2
           and recovery_session.closed_at is null
           and recovery_grant.claim_attempt_id is null
           and recovery_grant.claimed_at is null
           and recovery_grant.expires_at > pg_catalog.statement_timestamp()
       )
       update private.identity_recovery_grants as recovery_grant
       set expires_at = recovery_grant.issued_at + interval '1 microsecond'
       from private.identity_recovery_sessions as recovery_session,
            auth.sessions as auth_session,
            auth.users as auth_user,
            candidate_count
       where candidate_count.exact_count = 1
         and recovery_session.auth_session_id = recovery_grant.auth_session_id
         and recovery_session.user_id = recovery_grant.user_id
         and recovery_session.closed_at is null
         and auth_session.id = recovery_grant.auth_session_id
         and auth_session.user_id = recovery_grant.user_id
         and auth_user.id = recovery_grant.user_id
         and recovery_grant.user_id = $1::uuid
         and auth_user.email = $2
         and recovery_grant.claim_attempt_id is null
         and recovery_grant.claimed_at is null
         and recovery_grant.expires_at > pg_catalog.statement_timestamp()
       returning true as expired`,
      [parsed.data.userId, email],
    );
  } catch {
    failure = expirationError();
  }

  try {
    await pool.end();
  } catch {
    failure ??= expirationError();
  }

  if (failure !== undefined) {
    throw failure;
  }
  if (result === undefined || result.rowCount !== 1) {
    throw expirationError();
  }
  const rows = expirationRowsSchema.safeParse(result.rows);
  if (!rows.success || rows.data.length !== result.rowCount) {
    throw expirationError();
  }
}

export async function expireExactLocalRecoveryGrant(input: ExpirationInput) {
  const [{ default: e2eDatabasePreflight }, { safeE2EEnvironment }] = await Promise.all([
    import("./e2e-database-preflight"),
    import("./e2e-environment"),
  ]);

  return expireExactLocalRecoveryGrantWithDependencies(input, {
    adminDatabaseUrl: safeE2EEnvironment.adminDatabaseUrl,
    createPool(databaseUrl) {
      const pool = new Pool({
        allowExitOnIdle: true,
        connectionString: databaseUrl,
        connectionTimeoutMillis: 1_000,
        max: 1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      });
      return {
        end: () => pool.end(),
        async query(text, values) {
          const result = await pool.query<{ expired: boolean }>(text, [...values]);
          return { rowCount: result.rowCount, rows: result.rows };
        },
      };
    },
    preflight: e2eDatabasePreflight,
  });
}

export async function assertExactLocalRecoverySessionClosedWithDependencies(
  input: ExpirationInput,
  dependencies: LocalRecoveryGrantDependencies,
) {
  const parsed = expirationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("A prova local exige e-mail QA e UUID exatos.");
  }
  const email = assertQaAuthEmail(parsed.data.email);

  try {
    await dependencies.preflight();
  } catch {
    throw new Error("O preflight do banco E2E local não foi validado para a prova de sessão.");
  }

  let pool: LocalRecoveryGrantPool;
  try {
    pool = dependencies.createPool(dependencies.adminDatabaseUrl);
  } catch {
    throw closedSessionError();
  }

  let result: ExpirationResult | undefined;
  let failure: Error | undefined;
  try {
    result = await pool.query(
      `with target_user as (
         select auth_user.id
         from auth.users as auth_user
         where auth_user.id = $1::uuid
           and auth_user.email = $2
       ),
       target_bindings as (
         select recovery_session.auth_session_id, recovery_session.closed_at
         from private.identity_recovery_sessions as recovery_session
         join target_user on target_user.id = recovery_session.user_id
       )
       select
         (select pg_catalog.count(*)::integer from target_user) as exact_user_count,
         (select pg_catalog.count(*)::integer from target_bindings) as historical_binding_count,
         (
           select pg_catalog.count(*)::integer
           from target_bindings
           where target_bindings.closed_at is null
         ) as open_binding_count,
         (
           select pg_catalog.count(*)::integer
           from auth.sessions as auth_session
           join target_bindings
             on target_bindings.auth_session_id = auth_session.id
         ) as linked_auth_session_count,
         (
           select pg_catalog.count(*)::integer
           from private.identity_recovery_grants as recovery_grant
           join target_user on target_user.id = recovery_grant.user_id
         ) as grant_count`,
      [parsed.data.userId, email],
    );
  } catch {
    failure = closedSessionError();
  }

  try {
    await pool.end();
  } catch {
    failure ??= closedSessionError();
  }

  if (failure !== undefined) {
    throw failure;
  }
  if (result === undefined || result.rowCount !== 1) {
    throw closedSessionError();
  }
  const rows = closedSessionRowsSchema.safeParse(result.rows);
  if (!rows.success || rows.data.length !== result.rowCount) {
    throw closedSessionError();
  }
}

export async function assertExactLocalRecoverySessionClosed(input: ExpirationInput) {
  const [{ default: e2eDatabasePreflight }, { safeE2EEnvironment }] = await Promise.all([
    import("./e2e-database-preflight"),
    import("./e2e-environment"),
  ]);

  return assertExactLocalRecoverySessionClosedWithDependencies(input, {
    adminDatabaseUrl: safeE2EEnvironment.adminDatabaseUrl,
    createPool(databaseUrl) {
      const pool = new Pool({
        allowExitOnIdle: true,
        connectionString: databaseUrl,
        connectionTimeoutMillis: 1_000,
        max: 1,
        query_timeout: 1_000,
        statement_timeout: 1_000,
      });
      return {
        end: () => pool.end(),
        async query(text, values) {
          const result = await pool.query(text, [...values]);
          return { rowCount: result.rowCount, rows: result.rows };
        },
      };
    },
    preflight: e2eDatabasePreflight,
  });
}
