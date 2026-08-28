ALTER ROLE "app_runtime_production" IN DATABASE "postgres" SET "role" TO 'app_dal';


CREATE OR REPLACE FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with session_role as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = session_user
      and role.rolname = expected_session_role
      and role.rolcanlogin
      and not role.rolinherit
      and not role.rolsuper
      and not role.rolcreatedb
      and not role.rolcreaterole
      and not role.rolreplication
      and not role.rolbypassrls
      and role.rolconnlimit = 10
      and role.rolvaliduntil = 'infinity'::timestamptz
      and role.rolconfig is null
      and (
        (
          role.rolname = 'app_runtime_production'
          and (
            select pg_catalog.count(*) = 1
              and pg_catalog.bool_and(
                setting.setdatabase = (
                  select database.oid
                  from pg_catalog.pg_database as database
                  where database.datname = pg_catalog.current_database()
                )
                and setting.setconfig = array['role=app_dal']::text[]
              )
            from pg_catalog.pg_db_role_setting as setting
            where setting.setrole = role.oid
          )
        )
        or (
          role.rolname = 'app_runtime_local'
          and (
            select pg_catalog.count(*) = 1
              and pg_catalog.bool_and(
                setting.setdatabase = (
                  select database.oid
                  from pg_catalog.pg_database as database
                  where database.datname = pg_catalog.current_database()
                )
                and setting.setconfig = array['app.settings.jwt_secret=']::text[]
              )
            from pg_catalog.pg_db_role_setting as setting
            where setting.setrole = role.oid
          )
        )
      )
  ),
  memberships_are_restricted as (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        granted.rolname = 'app_dal'
        and not membership.admin_option
        and not membership.inherit_option
        and membership.set_option
      ) as ready
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    cross join session_role
    where membership.member = session_role.oid
  ),
  direct_database_privilege_is_restricted as (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        privilege.grantee = session_role.oid
        and privilege.privilege_type = 'CONNECT'
        and not privilege.is_grantable
      ) as ready
    from pg_catalog.pg_database as database
    cross join lateral pg_catalog.aclexplode(database.datacl) as privilege
    cross join session_role
    where database.datname = pg_catalog.current_database()
      and privilege.grantee = session_role.oid
  ),
  direct_acl_dependencies_are_restricted as (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        dependency.dbid = 0
        and dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
        and dependency.objid = (
          select database.oid
          from pg_catalog.pg_database as database
          where database.datname = pg_catalog.current_database()
        )
        and dependency.objsubid = 0
      ) as ready
    from pg_catalog.pg_shdepend as dependency
    cross join session_role
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.refobjid = session_role.oid
      and dependency.deptype = 'a'
  )
  select coalesce(
    pg_catalog.current_setting('role', true) = 'app_dal'
    and pg_catalog.pg_has_role(session_user, 'app_dal', 'MEMBER')
    and (select ready from memberships_are_restricted)
    and (select ready from direct_database_privilege_is_restricted)
    and (select ready from direct_acl_dependencies_are_restricted)
    and private.managed_runtime_boundaries_are_ready()
    and not pg_catalog.has_database_privilege(
      session_user,
      pg_catalog.current_database(),
      'TEMPORARY'
    )
    and not pg_catalog.has_database_privilege(
      'app_dal',
      pg_catalog.current_database(),
      'TEMPORARY'
    )
    and not exists (
      select 1
      from pg_catalog.pg_shdepend as dependency
      cross join session_role
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = session_role.oid
        and dependency.deptype = 'o'
    ),
    false
  );
$$;


ALTER FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") IS 'Health do login restrito: assume app_dal por configuração canônica do database e possui somente CONNECT direto, sem ownership ou ACL adicional.';


REVOKE ALL ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") TO "app_dal";
