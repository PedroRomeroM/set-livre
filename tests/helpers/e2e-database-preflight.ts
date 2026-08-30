import { Pool } from "pg";
import { z } from "zod";

import { safeE2EEnvironment } from "./e2e-environment";

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

async function inspectE2EDatabase() {
  const pool = new Pool({
    allowExitOnIdle: true,
    connectionString: safeE2EEnvironment.adminDatabaseUrl,
    connectionTimeoutMillis: 1_000,
    max: 1,
    query_timeout: 1_000,
    statement_timeout: 1_000,
  });

  try {
    const result = await pool.query(
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
  } finally {
    await pool.end();
  }
}

async function assertE2EDatabaseSafety() {
  const identity = await inspectE2EDatabase();
  if (identity?.marker !== `set-livre-e2e:${safeE2EEnvironment.databaseMarker}`) {
    throw new Error("O banco E2E não possui o marcador efêmero da instância local atual.");
  }
  return identity;
}

export async function e2eDatabaseSafetyPreflight() {
  await assertE2EDatabaseSafety();
}

export default async function e2eDatabasePreflight() {
  const identity = await assertE2EDatabaseSafety();
  if (identity.stale_qa_identities !== 0) {
    throw new Error(
      `O banco E2E contém ${identity.stale_qa_identities} identidades QA residuais. Execute npm run supabase:reset antes de repetir a suíte.`,
    );
  }
}
