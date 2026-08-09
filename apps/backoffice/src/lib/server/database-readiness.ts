import "server-only";

import { databaseMigrationHead, parseDalDatabaseUrl } from "@set-livre/contracts";
import { Pool } from "pg";
import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL_APP_DAL: z.string(),
});
const readinessRowsSchema = z
  .array(
    z.strictObject({
      currentRole: z.literal("app_dal"),
      ready: z.boolean(),
      sessionMembershipRestricted: z.boolean(),
      sessionRestricted: z.boolean(),
      sessionRole: z.string().min(1),
    }),
  )
  .length(1);

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
    const result = await connection.pool.query(
      `select
        private.check_readiness($1::text) as ready,
        current_user::text as "currentRole",
        session_user::text as "sessionRole",
        (
          session.rolcanlogin
          and not session.rolinherit
          and not session.rolsuper
          and not session.rolcreatedb
          and not session.rolcreaterole
          and not session.rolreplication
          and not session.rolbypassrls
        ) as "sessionRestricted",
        (
          select
            count(*) = 1
            and bool_and(
              granted.rolname = 'app_dal'
              and not membership.admin_option
              and not membership.inherit_option
              and membership.set_option
            )
          from pg_catalog.pg_auth_members as membership
          join pg_catalog.pg_roles as member on member.oid = membership.member
          join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
          where member.rolname = session_user
        ) as "sessionMembershipRestricted"
      from pg_catalog.pg_roles as session
      where session.rolname = session_user`,
      [databaseMigrationHead],
    );
    const row = readinessRowsSchema.parse(result.rows).at(0);
    return (
      row?.ready === true &&
      row.sessionMembershipRestricted &&
      row.sessionRestricted &&
      row.sessionRole === connection.sessionRole
    );
  } catch {
    return false;
  }
}
