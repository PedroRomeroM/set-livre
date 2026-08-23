-- Roles de grupo necessárias antes da primeira migration remota.
-- Senhas e logins de runtime são configurados fora deste arquivo, por uma
-- transação administrativa que recebe o segredo somente por stdin.

do $block$
begin
  if not exists (
    select 1
    from pg_catalog.pg_roles as role
    where role.rolname = 'app_dal'
  ) then
    create role app_dal
      nologin
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      connection limit -1;
  end if;
end
$block$;

do $block$
begin
  if exists (
    select 1
    from pg_catalog.pg_roles as role
    where role.rolname = 'app_dal'
      and (role.rolsuper or role.rolreplication or role.rolbypassrls)
  ) then
    raise exception 'app_dal possui atributo que somente um superuser pode remover.';
  end if;
end
$block$;

-- A identidade postgres gerenciada pelo Supabase possui CREATEROLE, mas não
-- SUPERUSER. Os três atributos privilegiados foram verificados acima e não
-- podem aparecer como opções ALTER ROLE, mesmo em uma tentativa de no-op.
alter role app_dal
  nologin
  noinherit
  nocreatedb
  nocreaterole
  connection limit -1;

alter role app_dal reset all;
