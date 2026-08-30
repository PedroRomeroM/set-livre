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

export type LocalRecoveryGrantClient = {
  query: (text: string, values: readonly [string, string]) => Promise<ExpirationResult>;
};

export type LocalRecoveryGrantDependencies = {
  preflight: () => Promise<void>;
  withClient: <T>(operation: (client: LocalRecoveryGrantClient) => Promise<T>) => Promise<T>;
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

  let result: ExpirationResult;
  try {
    result = await dependencies.withClient((client) =>
      client.query(
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
      ),
    );
  } catch {
    throw expirationError();
  }
  if (result.rowCount !== 1) {
    throw expirationError();
  }
  const rows = expirationRowsSchema.safeParse(result.rows);
  if (!rows.success || rows.data.length !== result.rowCount) {
    throw expirationError();
  }
}

export async function expireExactLocalRecoveryGrant(input: ExpirationInput) {
  return expireExactLocalRecoveryGrantWithDependencies(input, await localRecoveryDependencies());
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

  let result: ExpirationResult;
  try {
    result = await dependencies.withClient((client) =>
      client.query(
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
      ),
    );
  } catch {
    throw closedSessionError();
  }
  if (result.rowCount !== 1) {
    throw closedSessionError();
  }
  const rows = closedSessionRowsSchema.safeParse(result.rows);
  if (!rows.success || rows.data.length !== result.rowCount) {
    throw closedSessionError();
  }
}

export async function assertExactLocalRecoverySessionClosed(input: ExpirationInput) {
  return assertExactLocalRecoverySessionClosedWithDependencies(
    input,
    await localRecoveryDependencies(),
  );
}

async function localRecoveryDependencies(): Promise<LocalRecoveryGrantDependencies> {
  const { e2eDatabaseSafetyPreflight, withE2EAdminClient } =
    await import("./e2e-database-preflight");
  return {
    preflight: e2eDatabaseSafetyPreflight,
    withClient(operation) {
      return withE2EAdminClient((client) =>
        operation({
          async query(text, values) {
            const result = await client.query(text, [...values]);
            return { rowCount: result.rowCount, rows: result.rows };
          },
        }),
      );
    },
  };
}
