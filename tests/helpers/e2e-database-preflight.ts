import { Pool, type PoolClient } from "pg";
import { z } from "zod";

import { readSafeE2EEnvironment } from "./e2e-environment";

const identitySchema = z
  .array(
    z.strictObject({
      database: z.literal("postgres"),
      marker: z.string(),
      role: z.literal("postgres"),
      stale_qa_identities: z.coerce.number().int().nonnegative(),
    }),
  )
  .length(1);

export type E2EDatabaseClient = Pick<PoolClient, "query">;

type DatabaseScope = "admin" | "dal";

const pools: Partial<Record<DatabaseScope, Pool>> = {};
let safetyPreflight: Promise<z.infer<typeof identitySchema>[number] | undefined> | undefined;

function databasePool(scope: DatabaseScope) {
  const existing = pools[scope];
  if (existing !== undefined) return existing;

  const safeE2EEnvironment = readSafeE2EEnvironment();
  const pool = new Pool({
    allowExitOnIdle: true,
    application_name: `set-livre-e2e-${scope}`,
    connectionString:
      scope === "admin" ? safeE2EEnvironment.adminDatabaseUrl : safeE2EEnvironment.dalDatabaseUrl,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 0,
    max: 1,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  pool.on("error", () => {
    if (pools[scope] === pool) delete pools[scope];
    if (scope === "admin") safetyPreflight = undefined;
    void pool.end().catch(() => undefined);
  });
  pools[scope] = pool;
  return pool;
}

async function withDatabaseClient<T>(
  scope: DatabaseScope,
  operation: (client: E2EDatabaseClient) => Promise<T>,
) {
  const client = await databasePool(scope).connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

async function inspectE2EDatabase() {
  return withDatabaseClient("admin", async (client) => {
    const result = await client.query(
      `select
        current_database() as database,
        current_user as role,
        pg_catalog.shobj_description(database.oid, 'pg_database') as marker,
        (
          select pg_catalog.count(*)
          from auth.users as auth_user
          where auth_user.email like 'qa\\_%@example.test' escape '\\'
        ) as stale_qa_identities
      from pg_catalog.pg_database as database
      where database.datname = current_database()`,
    );
    return identitySchema.parse(result.rows).at(0);
  });
}

async function assertE2EDatabaseSafety() {
  const identity = await inspectE2EDatabase();
  const safeE2EEnvironment = readSafeE2EEnvironment();
  if (identity?.marker !== `set-livre-e2e:${safeE2EEnvironment.databaseMarker}`) {
    throw new Error("O banco E2E não possui o marcador efêmero da instância local atual.");
  }
  return identity;
}

export async function e2eDatabaseSafetyPreflight() {
  safetyPreflight ??= assertE2EDatabaseSafety();
  try {
    await safetyPreflight;
  } catch (error) {
    safetyPreflight = undefined;
    throw error;
  }
}

export async function withE2EAdminClient<T>(operation: (client: E2EDatabaseClient) => Promise<T>) {
  await e2eDatabaseSafetyPreflight();
  return withDatabaseClient("admin", operation);
}

export async function withE2EDalClient<T>(operation: (client: E2EDatabaseClient) => Promise<T>) {
  await e2eDatabaseSafetyPreflight();
  return withDatabaseClient("dal", operation);
}

export default async function e2eDatabasePreflight() {
  const identity = await assertE2EDatabaseSafety();
  if (identity.stale_qa_identities !== 0) {
    throw new Error(
      `O banco E2E contém ${identity.stale_qa_identities} identidades QA residuais. Execute npm run supabase:reset antes de repetir a suíte.`,
    );
  }
}
