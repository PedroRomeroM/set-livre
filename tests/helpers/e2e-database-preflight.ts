import { Pool } from "pg";
import { z } from "zod";

import { safeE2EEnvironment } from "./e2e-environment";

const identitySchema = z
  .array(
    z.strictObject({
      database: z.literal("postgres"),
      marker: z.string(),
      role: z.literal("postgres"),
    }),
  )
  .length(1);

export default async function e2eDatabasePreflight() {
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
        pg_catalog.shobj_description(database.oid, 'pg_database') as marker
      from pg_catalog.pg_database as database
      where database.datname = current_database()`,
    );
    const identity = identitySchema.parse(result.rows).at(0);
    if (identity?.marker !== `set-livre-e2e:${safeE2EEnvironment.databaseMarker}`) {
      throw new Error("O banco E2E não possui o marcador efêmero da instância local atual.");
    }
  } finally {
    await pool.end();
  }
}
