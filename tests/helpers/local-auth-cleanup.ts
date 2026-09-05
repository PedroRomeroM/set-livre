import { z } from "zod";

import { assertQaAuthEmail } from "./local-auth-mailpit";

const cleanupInputSchema = z.strictObject({
  email: z.string(),
  userId: z.uuid(),
});
const cleanupRowsSchema = z.array(z.strictObject({ id: z.uuid() })).max(1);

type CleanupResult = {
  rowCount: number | null;
  rows: unknown[];
};

export type LocalAuthCleanupClient = {
  query: (text: string, values: readonly [string, string]) => Promise<CleanupResult>;
};

export type LocalAuthCleanupDependencies = {
  preflight: () => Promise<void>;
  withClient: <T>(operation: (client: LocalAuthCleanupClient) => Promise<T>) => Promise<T>;
};

type LocalAuthCleanupInput = z.infer<typeof cleanupInputSchema>;

function cleanupError() {
  return new Error("Não foi possível limpar o usuário Auth local exato com segurança.");
}

export async function cleanupLocalAuthUserWithDependencies(
  input: LocalAuthCleanupInput,
  dependencies: LocalAuthCleanupDependencies,
) {
  const parsed = cleanupInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("A limpeza do usuário Auth local exige e-mail e UUID exatos.");
  }
  const email = assertQaAuthEmail(parsed.data.email);

  try {
    await dependencies.preflight();
  } catch {
    throw new Error("O preflight do banco E2E local não foi validado para a limpeza Auth.");
  }

  let result: CleanupResult;
  try {
    result = await dependencies.withClient((client) =>
      client.query(
        `with authorization_fence as materialized (
           select pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0)
           )
         )
         delete from auth.users using authorization_fence
         where id = $1::uuid
           and email = $2
         returning id`,
        [parsed.data.userId, email],
      ),
    );
  } catch {
    throw cleanupError();
  }
  if (result.rowCount !== 0 && result.rowCount !== 1) {
    throw cleanupError();
  }

  const rows = cleanupRowsSchema.safeParse(result.rows);
  if (!rows.success || rows.data.length !== result.rowCount) {
    throw cleanupError();
  }
  if (rows.data.length === 1 && rows.data[0]?.id !== parsed.data.userId) {
    throw cleanupError();
  }
  return result.rowCount === 1;
}

export async function cleanupLocalAuthUser(input: LocalAuthCleanupInput) {
  const { e2eDatabaseSafetyPreflight, withE2EAdminClient } =
    await import("./e2e-database-preflight");

  return cleanupLocalAuthUserWithDependencies(input, {
    preflight: e2eDatabaseSafetyPreflight,
    withClient(operation) {
      return withE2EAdminClient((client) =>
        operation({
          async query(text, values) {
            const result = await client.query<{ id: string }>(text, [...values]);
            return { rowCount: result.rowCount, rows: result.rows };
          },
        }),
      );
    },
  });
}
