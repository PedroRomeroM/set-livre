begin;

select plan(38);

select ok(pg_catalog.to_regnamespace('audit') is not null, 'schema audit existe');
select ok(pg_catalog.to_regnamespace('private') is not null, 'schema private existe');

select ok(
  exists (
    select 1
    from pg_catalog.pg_roles as role
    where role.rolname = 'app_dal'
      and not role.rolcanlogin
      and not role.rolinherit
      and not role.rolsuper
      and not role.rolcreatedb
      and not role.rolcreaterole
      and not role.rolreplication
      and not role.rolbypassrls
  ),
  'app_dal não autentica nem possui atributos elevados'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where member.rolname = 'app_dal'
  ),
  'app_dal não herda outra role'
);

select ok(
  not pg_catalog.has_schema_privilege('public', 'public', 'CREATE'),
  'PUBLIC não cria objetos no schema public'
);
select ok(
  not pg_catalog.has_schema_privilege('anon', 'public', 'CREATE'),
  'anon não cria objetos no schema public'
);
select ok(
  not pg_catalog.has_schema_privilege('authenticated', 'public', 'CREATE'),
  'authenticated não cria objetos no schema public'
);
select ok(
  not pg_catalog.has_schema_privilege('service_role', 'public', 'CREATE'),
  'service_role não cria objetos no schema public'
);
select ok(
  not pg_catalog.has_schema_privilege('app_dal', 'public', 'CREATE'),
  'app_dal não cria objetos no schema public'
);

select ok(
  pg_catalog.has_schema_privilege('app_dal', 'private', 'USAGE'),
  'app_dal acessa somente a fronteira de comandos private'
);

select ok(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        namespace.nspname = 'private'
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable
      )
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
    join pg_catalog.pg_roles as role on role.oid = privilege.grantee
    where role.rolname = 'app_dal'
  ),
  'grant direto de schema da DAL é somente USAGE em private'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    join pg_catalog.pg_roles as role on role.oid = privilege.grantee
    where role.rolname = 'app_dal'
      and (
        namespace.nspname <> 'private'
        or privilege.privilege_type <> 'EXECUTE'
        or privilege.is_grantable
      )
  ),
  'grants diretos de rotina da DAL são EXECUTE sem grant option em private'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
    join pg_catalog.pg_roles as role on role.oid = privilege.grantee
    where role.rolname = 'app_dal'

    union all

    select 1
    from pg_catalog.pg_attribute as attribute
    cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
    join pg_catalog.pg_roles as role on role.oid = privilege.grantee
    where role.rolname = 'app_dal'

    union all

    select 1
    from pg_catalog.pg_default_acl as defaults
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
    join pg_catalog.pg_roles as role on role.oid = privilege.grantee
    where role.rolname = 'app_dal'
  ),
  'app_dal não recebe acesso direto a dados ou default privileges'
);

select ok(
  (
    select coalesce(pg_catalog.bool_and(relation.relrowsecurity), true)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('p', 'r')
  ),
  'todas as tabelas públicas usam RLS'
);

select ok(
  not pg_catalog.has_database_privilege(
    'app_dal',
    pg_catalog.current_database(),
    'TEMPORARY'
  ),
  'app_dal não cria tabelas temporárias'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_roles as role
    where role.rolname = 'app_runtime_production'
      and not role.rolcanlogin
      and not role.rolinherit
      and not role.rolsuper
      and not role.rolcreatedb
      and not role.rolcreaterole
      and not role.rolreplication
      and not role.rolbypassrls
      and role.rolconnlimit = 10
  ),
  'runtime de produção nasce sem login e sem atributos elevados'
);

select ok(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        granted.rolname = 'app_dal'
        and not membership.admin_option
        and not membership.inherit_option
        and membership.set_option
      )
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where member.rolname = 'app_runtime_production'
  ),
  'runtime de produção pode somente assumir app_dal'
);

create role runtime_membership_intruder nologin noinherit;
grant app_runtime_production to runtime_membership_intruder
  with admin false, inherit false, set true;
select ok(
  not private.managed_runtime_boundaries_are_ready()
    and not private.check_readiness('20260824000100'),
  'runtime de produção não pode ser concedido a outra identidade'
);
revoke app_runtime_production from runtime_membership_intruder;
drop role runtime_membership_intruder;

select ok(
  not exists (
    select 1
    from pg_catalog.pg_db_role_setting as setting
    join pg_catalog.pg_roles as role on role.oid = setting.setrole
    where role.rolname = 'app_runtime_production'
  ),
  'runtime de produção não armazena segredo ou configuração em GUC'
);

select ok(
  private.managed_runtime_boundaries_are_ready(),
  'fronteiras gerenciadas de catálogo, HTTP e database estão seguras'
);

grant create on database postgres to app_runtime_production;
select ok(
  not private.managed_runtime_boundaries_are_ready(),
  'fronteira gerenciada rejeita CREATE direto no login de produção'
);
revoke create on database postgres from app_runtime_production;

select ok(
  pg_catalog.has_table_privilege(
    'supabase_storage_admin',
    'pg_catalog.pg_roles',
    'SELECT'
  )
    and not pg_catalog.has_table_privilege('app_dal', 'pg_catalog.pg_db_role_setting', 'SELECT')
    and not pg_catalog.has_any_column_privilege(
      'app_dal',
      'pg_catalog.pg_db_role_setting',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege('app_dal', 'pg_catalog.pg_roles', 'SELECT')
    and not pg_catalog.has_any_column_privilege(
      'app_dal',
      'pg_catalog.pg_roles',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege('app_dal', 'pg_catalog.pg_user', 'SELECT')
    and not pg_catalog.has_any_column_privilege(
      'app_dal',
      'pg_catalog.pg_user',
      'SELECT'
    ),
  'stack local preserva o Storage e nega à DAL leitura efetiva dos catálogos sensíveis'
);

select ok(
  private.check_readiness('20260824000100'),
  'readiness aceita a migration head atual'
);

savepoint private_schema_owner_drift;
create role readiness_owner_intruder nologin noinherit;
grant readiness_owner_intruder to postgres with admin false, inherit false, set true;
do $$
begin
  execute pg_catalog.format(
    'grant create on database %I to readiness_owner_intruder',
    pg_catalog.current_database()
  );
end;
$$;
alter schema private owner to readiness_owner_intruder;
do $$
begin
  execute pg_catalog.format(
    'revoke create on database %I from readiness_owner_intruder',
    pg_catalog.current_database()
  );
end;
$$;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita owner não canônico no schema private'
);
rollback to savepoint private_schema_owner_drift;

savepoint private_routine_owner_drift;
create role readiness_owner_intruder nologin noinherit;
grant readiness_owner_intruder to postgres with admin false, inherit false, set true;
grant create on schema private to readiness_owner_intruder;
alter function private.complete_profile(uuid, bigint, text, text, text, text, text)
  owner to readiness_owner_intruder;
revoke create on schema private from readiness_owner_intruder;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita owner não canônico em comando private'
);
rollback to savepoint private_routine_owner_drift;

insert into supabase_migrations.schema_migrations(version, statements, name)
values ('20260815000100', array[]::text[], 'rollback-readiness-probe');
select ok(
  private.check_readiness('20260815000100'),
  'readiness mantém uma migration aplicada apta ao rollback expand/contract'
);
delete from supabase_migrations.schema_migrations where version = '20260815000100';

select ok(
  not private.check_readiness('20260815000100'),
  'readiness rejeita uma migration que não foi aplicada'
);

grant execute on function private.profile_command_result(uuid) to app_dal;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita rotina privada fora da allowlist DAL'
);
revoke execute on function private.profile_command_result(uuid) from app_dal;

grant usage on schema private to public;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita acesso ao schema privado herdado por PUBLIC'
);
revoke usage on schema private from public;

grant execute on function private.complete_profile(uuid, bigint, text, text, text, text, text)
  to public;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita comando privado herdado por PUBLIC'
);
revoke execute on function private.complete_profile(uuid, bigint, text, text, text, text, text)
  from public;

grant select on table private.identity_recovery_grants to public;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita acesso a dados herdado por PUBLIC'
);
revoke select on table private.identity_recovery_grants from public;

savepoint managed_schema_drift;
create schema readiness_external;
create table readiness_external.public_probe (id bigint primary key);
grant usage on schema readiness_external to public;
grant select on table readiness_external.public_probe to public;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita acesso efetivo da DAL a schema externo herdado por PUBLIC'
);
rollback to savepoint managed_schema_drift;

create role readiness_intruder nologin noinherit;
grant app_dal to readiness_intruder with admin false, inherit false, set true;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita membro inesperado de app_dal'
);
revoke app_dal from readiness_intruder;
drop role readiness_intruder;

create extension if not exists dblink with schema extensions;

select extensions.dblink_connect(
  'readiness_owner_probe',
  pg_catalog.format(
    'host=%s port=%s dbname=%I user=%I password=%s',
    pg_catalog.inet_server_addr(),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    'supabase_admin',
    'postgres'
  )
);
select extensions.dblink_exec(
  'readiness_owner_probe',
  'drop table if exists private.readiness_owner_probe; '
    || 'create table private.readiness_owner_probe(id integer primary key); '
    || 'alter table private.readiness_owner_probe owner to app_dal'
);
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita qualquer objeto pertencente a app_dal'
);
select extensions.dblink_exec(
  'readiness_owner_probe',
  'drop table private.readiness_owner_probe'
);
select extensions.dblink_disconnect('readiness_owner_probe');

select ok(
  (
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
      )
    from pg_catalog.pg_shdepend as dependency
    join pg_catalog.pg_roles as role on role.oid = dependency.refobjid
    where role.rolname = 'app_runtime_local'
      and dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.deptype = 'a'
  ),
  'manifesto de ACL do runtime contém somente o CONNECT direto esperado'
);

grant usage on schema audit to app_runtime_local;
select ok(
  not (
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
      )
    from pg_catalog.pg_shdepend as dependency
    join pg_catalog.pg_roles as role on role.oid = dependency.refobjid
    where role.rolname = 'app_runtime_local'
      and dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.deptype = 'a'
  ),
  'manifesto de ACL rejeita grant direto adicional no login'
);
revoke usage on schema audit from app_runtime_local;

alter role app_dal login;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita elevação da role DAL'
);
alter role app_dal nologin;

grant create on schema public to public;
select ok(
  not private.check_readiness('20260824000100'),
  'readiness rejeita CREATE público'
);
revoke create on schema public from public;

select * from finish();

rollback;
