import "server-only";

export { isDatabaseReadinessSatisfied } from "../database-readiness-contract";

export const databaseReadinessQuery = `select
  private.check_readiness($1::text) as ready,
  private.check_runtime_readiness($2::text) as "runtimeReady",
  current_user::text as "currentRole",
  session_user::text as "sessionRole"`;
