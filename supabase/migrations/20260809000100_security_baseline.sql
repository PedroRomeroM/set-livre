create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

create schema if not exists private;
create schema if not exists audit;

comment on schema private is 'Objetos internos e comandos não expostos pela Data API.';
comment on schema audit is 'Eventos sensíveis append-only não expostos pela Data API.';

revoke create on schema public from public;
revoke all on schema private from public, anon, authenticated, service_role;
revoke all on schema audit from public, anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'app_dal') then
    create role app_dal nologin noinherit;
  end if;
end
$block$;

alter role app_dal nologin noinherit;
grant usage on schema private to app_dal;

revoke all on all tables in schema public from anon, authenticated, service_role, app_dal;
revoke all on all sequences in schema public from anon, authenticated, service_role, app_dal;
revoke all on all functions in schema public from public, anon, authenticated, service_role, app_dal;
revoke all on all tables in schema private from public, anon, authenticated, service_role, app_dal;
revoke all on all sequences in schema private from public, anon, authenticated, service_role, app_dal;
revoke all on all functions in schema private from public, anon, authenticated, service_role, app_dal;
revoke all on all tables in schema audit from public, anon, authenticated, service_role, app_dal;
revoke all on all sequences in schema audit from public, anon, authenticated, service_role, app_dal;
revoke all on all functions in schema audit from public, anon, authenticated, service_role, app_dal;

alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated, service_role, app_dal;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated, service_role, app_dal;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role, app_dal;
alter default privileges for role postgres in schema private
  revoke all on tables from public, anon, authenticated, service_role, app_dal;
alter default privileges for role postgres in schema private
  revoke all on sequences from public, anon, authenticated, service_role, app_dal;
alter default privileges for role postgres in schema private
  revoke execute on functions from public, anon, authenticated, service_role, app_dal;
alter default privileges for role postgres in schema audit
  revoke all on tables from public, anon, authenticated, service_role, app_dal;
alter default privileges for role postgres in schema audit
  revoke all on sequences from public, anon, authenticated, service_role, app_dal;
alter default privileges for role postgres in schema audit
  revoke execute on functions from public, anon, authenticated, service_role, app_dal;
