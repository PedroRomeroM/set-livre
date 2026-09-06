-- Reuse the complete deployed structural verifier without duplicating its grants/policies manifest.
-- The allowlist resolves check_readiness(text) by name, so only that facade retains DAL execution.
alter function private.check_readiness(text) rename to check_deployment_structure;

revoke all on function private.check_deployment_structure(text)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;

comment on function private.check_deployment_structure(text) is
  'Preflight administrativo: migration aplicada e fronteiras estruturais completas, sem depender da saúde operacional do cleanup; execução restrita a postgres.';

create function private.check_readiness(expected_version text) returns boolean
  language sql stable security definer
  set search_path to ''
as $function$
  select coalesce(
    private.check_deployment_structure(expected_version)
      and private.studio_media_cleanup_runs_are_healthy(),
    false
  );
$function$;

alter function private.check_readiness(text) owner to postgres;
revoke all on function private.check_readiness(text)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
grant execute on function private.check_readiness(text) to app_dal;

comment on function private.check_readiness(text) is
  'Health fail-closed da aplicação: estrutura, migration aplicada e sucesso terminal recente do cleanup; assinatura DAL preservada para ativação e rollback.';

-- Keep every managed security predicate; operational health belongs only to the facade above.
create or replace function private.managed_runtime_boundaries_are_ready()
returns boolean
  language sql stable security definer
  set search_path to ''
as $function$
  with managed_roles(role_name) as (
    values
      ('anon'::text),
      ('authenticated'::text),
      ('service_role'::text),
      ('app_dal'::text),
      ('app_runtime_production'::text)
  ),
  sensitive_catalog_access_is_restricted as (
    select not exists (
      select 1
      from (
        values
          ('pg_catalog.pg_db_role_setting'::pg_catalog.regclass),
          ('pg_catalog.pg_roles'::pg_catalog.regclass),
          ('pg_catalog.pg_user'::pg_catalog.regclass)
      ) as catalog(relation_oid)
      cross join managed_roles
      where pg_catalog.has_table_privilege(
          managed_roles.role_name,
          catalog.relation_oid,
          'SELECT'
        )
        or pg_catalog.has_any_column_privilege(
          managed_roles.role_name,
          catalog.relation_oid,
          'SELECT'
        )
    ) as ready
  ),
  sensitive_settings_are_absent as (
    select not exists (
      select 1
      from pg_catalog.pg_db_role_setting as setting
      cross join lateral pg_catalog.unnest(setting.setconfig) as configuration(value)
      where pg_catalog.split_part(configuration.value, '=', 1)
        ~* '(^|[._-])(secret|password|token|credential|key)([._-]|$)'
    ) as ready
  ),
  managed_http_access_is_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_namespace as namespace
      cross join managed_roles
      where namespace.nspname = 'net'
        and (
          pg_catalog.has_schema_privilege(
            managed_roles.role_name,
            namespace.oid,
            'USAGE'
          )
          or pg_catalog.has_schema_privilege(
            managed_roles.role_name,
            namespace.oid,
            'CREATE'
          )
        )
    ) as ready
  ),
  application_database_access_is_restricted as (
    select not exists (
      select 1
      from (
        values
          ('app_dal'::text),
          ('app_runtime_production'::text)
      ) as application_role(role_name)
      where pg_catalog.has_database_privilege(
          application_role.role_name,
          pg_catalog.current_database(),
          'CREATE'
        )
        or pg_catalog.has_database_privilege(
          application_role.role_name,
          pg_catalog.current_database(),
          'TEMPORARY'
        )
    ) as ready
  ),
  production_runtime_members_are_restricted as (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        member.rolname = 'postgres'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      ) as ready
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where granted.rolname = 'app_runtime_production'
  )
  select coalesce(
    (
      (select ready from sensitive_catalog_access_is_restricted)
      or (select ready from sensitive_settings_are_absent)
    )
    and (select ready from managed_http_access_is_restricted)
    and (select ready from application_database_access_is_restricted)
    and (select ready from production_runtime_members_are_restricted),
    false
  );
$function$;

comment on function private.managed_runtime_boundaries_are_ready() is
  'Fronteira estrutural gerenciada: catálogos/settings sensíveis, net, CREATE/TEMP e memberships; saúde do cleanup é exigida separadamente por check_readiness.';
