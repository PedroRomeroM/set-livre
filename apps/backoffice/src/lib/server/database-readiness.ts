import "server-only";

import { databaseMigrationHead } from "@set-livre/contracts";
import { Pool } from "pg";

import {
  databaseReadinessQuery,
  isDatabaseReadinessSatisfied,
} from "@set-livre/contracts/server/database-readiness";
import { loadDalPostgresConnectionConfig } from "@set-livre/contracts/server/postgres-connection-config";

let databaseConnection: { pool: Pool; sessionRole: string } | undefined;

function getDatabaseConnection() {
  if (databaseConnection !== undefined) {
    return databaseConnection;
  }

  const configuration = loadDalPostgresConnectionConfig(process.env);
  const pool = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-backoffice-readiness",
    connectionString: configuration.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 2,
    query_timeout: 1_000,
    ssl: configuration.ssl,
    statement_timeout: 1_000,
  });
  pool.on("error", () => undefined);
  databaseConnection = { pool, sessionRole: configuration.sessionRole };

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
