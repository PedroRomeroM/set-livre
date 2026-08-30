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
type DatabaseConnection = { pool: Pool; sessionRole: string };
const connectionRegistry = globalThis as typeof globalThis & {
  setLivreWebReadinessConnection?: DatabaseConnection;
};

function getDatabaseConnection() {
  if (connectionRegistry.setLivreWebReadinessConnection !== undefined) {
    return connectionRegistry.setLivreWebReadinessConnection;
  }

  const environment = environmentSchema.parse(process.env);
  const configuration = parseDalDatabaseUrl(environment.DATABASE_URL_APP_DAL);
  const pool = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-web-readiness",
    connectionString: configuration.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 1,
    query_timeout: 1_000,
    statement_timeout: 1_000,
  });
  pool.on("error", () => undefined);
  const databaseConnection = { pool, sessionRole: configuration.sessionRole };
  connectionRegistry.setLivreWebReadinessConnection = databaseConnection;

  return databaseConnection;
}

export async function isDatabaseReady() {
  try {
    const connection = getDatabaseConnection();
    const result = await connection.pool.query(databaseReadinessQuery, [
      databaseMigrationHead,
      connection.sessionRole,
    ]);
    return isDatabaseReadinessSatisfied(result.rows, connection.sessionRole);
  } catch {
    return false;
  }
}
