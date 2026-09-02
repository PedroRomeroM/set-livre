import "server-only";

import { databaseCommandPoolTimeouts, parseDalDatabaseUrl } from "@set-livre/contracts";
import { Pool } from "pg";
import { z } from "zod";

const environmentSchema = z.object({ DATABASE_URL_APP_DAL: z.string() });

const poolRegistry = globalThis as typeof globalThis & {
  setLivreWebCommandDalPool?: Pool;
};

export function commandDalPool() {
  if (poolRegistry.setLivreWebCommandDalPool !== undefined) {
    return poolRegistry.setLivreWebCommandDalPool;
  }

  const environment = environmentSchema.parse(process.env);
  const database = parseDalDatabaseUrl(environment.DATABASE_URL_APP_DAL);
  const commandPool = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-web-command-dal",
    connectionString: database.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 2,
    query_timeout: databaseCommandPoolTimeouts.queryTimeoutMs,
    statement_timeout: databaseCommandPoolTimeouts.statementTimeoutMs,
  });
  commandPool.on("error", () => undefined);
  poolRegistry.setLivreWebCommandDalPool = commandPool;
  return commandPool;
}
