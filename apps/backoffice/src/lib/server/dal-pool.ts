import "server-only";

import { databaseCommandPoolTimeouts, parseDalDatabaseUrl } from "@set-livre/contracts";
import { Pool } from "pg";
import { z } from "zod";

const environmentSchema = z.object({ DATABASE_URL_APP_DAL: z.string() });

const poolRegistry = globalThis as typeof globalThis & {
  setLivreBackofficeDalPool?: Pool;
};

export function backofficeDalPool() {
  if (poolRegistry.setLivreBackofficeDalPool !== undefined) {
    return poolRegistry.setLivreBackofficeDalPool;
  }

  const environment = environmentSchema.parse(process.env);
  const database = parseDalDatabaseUrl(environment.DATABASE_URL_APP_DAL);
  const backofficePool = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-backoffice-dal",
    connectionString: database.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 2,
    query_timeout: databaseCommandPoolTimeouts.queryTimeoutMs,
    statement_timeout: databaseCommandPoolTimeouts.statementTimeoutMs,
  });
  backofficePool.on("error", () => undefined);
  poolRegistry.setLivreBackofficeDalPool = backofficePool;
  return backofficePool;
}
