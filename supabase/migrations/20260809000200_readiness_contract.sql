create or replace function private.check_readiness(expected_version text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (
      select max(schema_migrations.version)::text = expected_version
      from supabase_migrations.schema_migrations
    ),
    false
  );
$function$;

comment on function private.check_readiness(text)
  is 'Comprova de forma mínima e não expositiva que o banco está acessível e na migration esperada.';

revoke all on function private.check_readiness(text) from public, anon, authenticated, service_role;
grant execute on function private.check_readiness(text) to app_dal;
