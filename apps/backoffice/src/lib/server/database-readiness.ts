import "server-only";

import { databaseMigrationHead, parseDalDatabaseUrl } from "@set-livre/contracts";
import { Pool } from "pg";
import { z } from "zod";

import {
  databaseReadinessQuery,
  isDatabaseReadinessSatisfied,
} from "@set-livre/contracts/server/database-readiness";

const environmentSchema = z.object({
  DATABASE_URL_APP_DAL: z.string(),
});
let databaseConnection: { pool: Pool; sessionRole: string } | undefined;

function getDatabaseConnection() {
  if (databaseConnection !== undefined) {
    return databaseConnection;
  }

  const environment = environmentSchema.parse(process.env);
  const configuration = parseDalDatabaseUrl(environment.DATABASE_URL_APP_DAL);
  const pool = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-backoffice-readiness",
    connectionString: configuration.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 2,
    query_timeout: 1_000,
    statement_timeout: 1_000,
  });
  pool.on("error", () => undefined);
  databaseConnection = { pool, sessionRole: configuration.sessionRole };

  return databaseConnection;
}

export async function isDatabaseReady() {
  try {
    const connection = getDatabaseConnection();
    const result = await connection.pool.query(databaseReadinessQuery, [databaseMigrationHead]);
    return isDatabaseReadinessSatisfied(result.rows, connection.sessionRole);
  } catch {
    return false;
  }
}
