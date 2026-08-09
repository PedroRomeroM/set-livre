do $block$
begin
  if exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'app_dal' and (rolsuper or rolreplication or rolbypassrls)
  ) then
    raise exception 'app_dal possui atributo que somente um superuser pode remover.';
  end if;
end
$block$;

alter role app_dal nologin noinherit nocreatedb nocreaterole;
alter role app_dal reset all;

do $block$
declare
  granted_role text;
begin
  for granted_role in
    select granted.rolname
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    where member.rolname = 'app_dal'
  loop
    execute pg_catalog.format('revoke %I from %I', granted_role, 'app_dal');
  end loop;
end
$block$;

-- O default EXECUTE de funções é global no PostgreSQL. Um REVOKE limitado por
-- schema não remove o privilégio herdado de PUBLIC, portanto a negação precisa
-- existir no default global da role que aplica as migrations.
alter default privileges for role postgres
  revoke execute on functions from public;

revoke all on all functions in schema private
  from public, anon, authenticated, service_role, app_dal;
revoke all on all functions in schema audit
  from public, anon, authenticated, service_role, app_dal;

grant execute on function private.check_readiness(text) to app_dal;
