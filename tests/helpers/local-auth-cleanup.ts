import { Pool } from "pg";
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

export type LocalAuthCleanupPool = {
  end: () => Promise<void>;
  query: (text: string, values: readonly [string, string]) => Promise<CleanupResult>;
};

export type LocalAuthCleanupDependencies = {
  adminDatabaseUrl: string;
  createPool: (databaseUrl: string) => LocalAuthCleanupPool;
  preflight: () => Promise<void>;
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

  let pool: LocalAuthCleanupPool;
  try {
    pool = dependencies.createPool(dependencies.adminDatabaseUrl);
  } catch {
    throw cleanupError();
  }

  let result: CleanupResult | undefined;
  let failure: Error | undefined;
  try {
    result = await pool.query(
      `delete from auth.users
       where id = $1::uuid
         and email = $2
       returning id`,
      [parsed.data.userId, email],
    );
  } catch {
    failure = cleanupError();
  }

  try {
    await pool.end();
  } catch {
    failure ??= cleanupError();
  }

  if (failure !== undefined) {
    throw failure;
  }
  if (result === undefined || (result.rowCount !== 0 && result.rowCount !== 1)) {
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
  const [{ default: e2eDatabasePreflight }, { safeE2EEnvironment }] = await Promise.all([
    import("./e2e-database-preflight"),
    import("./e2e-environment"),
  ]);

  return cleanupLocalAuthUserWithDependencies(input, {
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
          const result = await pool.query<{ id: string }>(text, [...values]);
          return { rowCount: result.rowCount, rows: result.rows };
        },
      };
    },
    preflight: e2eDatabasePreflight,
  });
}
