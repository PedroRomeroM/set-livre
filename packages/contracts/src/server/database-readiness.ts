import "server-only";

export { isDatabaseReadinessSatisfied } from "../database-readiness-contract";

export const databaseReadinessQuery = `select
  private.check_readiness($1::text) as ready,
  current_user::text as "currentRole",
  session_user::text as "sessionRole",
  (
    not effective.rolcanlogin
    and not effective.rolinherit
    and not effective.rolsuper
    and not effective.rolcreatedb
    and not effective.rolcreaterole
    and not effective.rolreplication
    and not effective.rolbypassrls
  ) as "currentRoleRestricted",
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
join pg_catalog.pg_roles as effective on effective.rolname = current_user
where session.rolname = session_user`;
