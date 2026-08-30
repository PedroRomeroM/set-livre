import "server-only";

import { parseDalDatabaseUrl } from "@set-livre/contracts";
import { Pool } from "pg";
import { z } from "zod";

const environmentSchema = z.object({ DATABASE_URL_APP_DAL: z.string() });

let backofficePool: Pool | undefined;

export function backofficeDalPool() {
  if (backofficePool !== undefined) return backofficePool;

  const environment = environmentSchema.parse(process.env);
  const database = parseDalDatabaseUrl(environment.DATABASE_URL_APP_DAL);
  backofficePool = new Pool({
    allowExitOnIdle: true,
    application_name: "set-livre-backoffice-dal",
    connectionString: database.connectionString,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 10_000,
    max: 2,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  backofficePool.on("error", () => undefined);
  return backofficePool;
}
