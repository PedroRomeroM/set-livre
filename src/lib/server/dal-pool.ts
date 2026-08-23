import "server-only";

import { loadDalPostgresConnectionConfig } from "@set-livre/contracts/server/postgres-connection-config";
import { Pool } from "pg";

let commandPool: Pool | undefined;

export function commandDalPool() {
  if (commandPool !== undefined) {
    return commandPool;
  }

  const database = loadDalPostgresConnectionConfig(process.env);
  commandPool = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-web-command-dal",
    connectionString: database.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 6,
    query_timeout: 2_000,
    ssl: database.ssl,
    statement_timeout: 2_000,
  });
  commandPool.on("error", () => undefined);
  return commandPool;
}
