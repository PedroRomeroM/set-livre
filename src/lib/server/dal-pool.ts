import "server-only";

import { parseDalDatabaseUrl } from "@set-livre/contracts";
import { Pool } from "pg";
import { z } from "zod";

const environmentSchema = z.object({ DATABASE_URL_APP_DAL: z.string() });

let commandPool: Pool | undefined;

export function commandDalPool() {
  if (commandPool !== undefined) {
    return commandPool;
  }

  const environment = environmentSchema.parse(process.env);
  const database = parseDalDatabaseUrl(environment.DATABASE_URL_APP_DAL);
  commandPool = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-web-command-dal",
    connectionString: database.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 4,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  commandPool.on("error", () => undefined);
  return commandPool;
}
