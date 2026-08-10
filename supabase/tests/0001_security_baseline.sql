begin;

create function private.default_privilege_probe()
returns boolean
language sql
stable
set search_path = ''
as $function$
  select true;
$function$;

create function audit.default_privilege_probe()
returns boolean
language sql
stable
set search_path = ''
as $function$
  select true;
$function$;

create function public.default_privilege_probe()
returns boolean
language sql
stable
set search_path = ''
as $function$
  select true;
$function$;

select plan(56);

select ok(
  exists (select 1 from pg_catalog.pg_namespace where nspname = 'private'),
  'schema private existe'
);

select ok(
  exists (select 1 from pg_catalog.pg_namespace where nspname = 'audit'),
  'schema audit existe'
);

select ok(
  exists (select 1 from pg_catalog.pg_roles where rolname = 'app_dal'),
  'role app_dal existe'
);

select ok(
  not (select rolsuper from pg_catalog.pg_roles where rolname = 'app_dal'),
  'app_dal não é superuser'
);

select ok(
  not (select rolcanlogin from pg_catalog.pg_roles where rolname = 'app_dal'),
  'app_dal não recebe login por migration'
);

select ok(
  not (select rolinherit from pg_catalog.pg_roles where rolname = 'app_dal'),
  'app_dal não herda privilégios de outra role'
);

select ok(
  not (select rolcreatedb from pg_catalog.pg_roles where rolname = 'app_dal'),
  'app_dal não cria bancos'
);

select ok(
  not (select rolcreaterole from pg_catalog.pg_roles where rolname = 'app_dal'),
  'app_dal não cria roles'
);

select ok(
  not (select rolreplication from pg_catalog.pg_roles where rolname = 'app_dal'),
  'app_dal não replica'
);

select ok(
  not (select rolbypassrls from pg_catalog.pg_roles where rolname = 'app_dal'),
  'app_dal não ignora RLS'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where member.rolname = 'app_dal'
  ),
  'app_dal não pode assumir nenhuma role superior'
);

select ok(
  exists (select 1 from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'bootstrap local criou a role de login do runtime'
);

select ok(
  (select rolcanlogin from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime pode autenticar'
);

select ok(
  not (select rolinherit from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime não herda privilégios implicitamente'
);

select ok(
  not (select rolsuper from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime não é superuser'
);

select ok(
  not (select rolcreatedb from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime não cria bancos'
);

select ok(
  not (select rolcreaterole from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime não cria roles'
);

select ok(
  not (select rolbypassrls from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime não ignora RLS'
);

select ok(
  not (select rolreplication from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime não replica'
);

select ok(
  (select rolconnlimit = 10 from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime possui limite explícito de conexões'
);

select ok(
  (select rolvaliduntil = 'infinity'::timestamptz from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime não preserva validade adulterada'
);

select ok(
  (select rolconfig is null from pg_catalog.pg_roles where rolname = 'app_runtime_local'),
  'role local do runtime não preserva parâmetros de sessão'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_roles as runtime_role
    join pg_catalog.pg_database as database on database.datdba = runtime_role.oid
    where runtime_role.rolname = 'app_runtime_local'
    union all
    select 1
    from pg_catalog.pg_roles as runtime_role
    join pg_catalog.pg_namespace as namespace on namespace.nspowner = runtime_role.oid
    where runtime_role.rolname = 'app_runtime_local'
    union all
    select 1
    from pg_catalog.pg_roles as runtime_role
    join pg_catalog.pg_class as relation on relation.relowner = runtime_role.oid
    where runtime_role.rolname = 'app_runtime_local'
    union all
    select 1
    from pg_catalog.pg_roles as runtime_role
    join pg_catalog.pg_proc as routine on routine.proowner = runtime_role.oid
    where runtime_role.rolname = 'app_runtime_local'
    union all
    select 1
    from pg_catalog.pg_roles as runtime_role
    join pg_catalog.pg_type as type_object on type_object.typowner = runtime_role.oid
    where runtime_role.rolname = 'app_runtime_local'
  ),
  'role local do runtime não possui objetos'
);

select ok(
  (
    select pg_catalog.array_agg(privilege.privilege_type order by privilege.privilege_type)
      = array['CONNECT']::text[]
    from pg_catalog.pg_database as database
    join pg_catalog.pg_roles as runtime_role on runtime_role.rolname = 'app_runtime_local'
    cross join lateral pg_catalog.aclexplode(database.datacl) as privilege
    where database.datname = current_database() and privilege.grantee = runtime_role.oid
  ),
  'role local do runtime recebe diretamente apenas CONNECT no banco'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
    join pg_catalog.pg_roles as runtime_role on runtime_role.oid = privilege.grantee
    where runtime_role.rolname = 'app_runtime_local'
    union all
    select 1
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
    join pg_catalog.pg_roles as runtime_role on runtime_role.oid = privilege.grantee
    where runtime_role.rolname = 'app_runtime_local'
    union all
    select 1
    from pg_catalog.pg_proc as routine
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    join pg_catalog.pg_roles as runtime_role on runtime_role.oid = privilege.grantee
    where runtime_role.rolname = 'app_runtime_local'
    union all
    select 1
    from pg_catalog.pg_type as type_object
    cross join lateral pg_catalog.aclexplode(type_object.typacl) as privilege
    join pg_catalog.pg_roles as runtime_role on runtime_role.oid = privilege.grantee
    where runtime_role.rolname = 'app_runtime_local'
  ),
  'role local do runtime não preserva grants diretos em schemas ou objetos'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_default_acl as defaults
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
    join pg_catalog.pg_roles as runtime_role on runtime_role.oid = privilege.grantee
    where runtime_role.rolname = 'app_runtime_local'
  ),
  'role local do runtime não recebe default privileges residuais'
);

select ok(
  pg_has_role('app_runtime_local', 'app_dal', 'member'),
  'role local do runtime pode assumir app_dal explicitamente'
);

select ok(
  (
    select count(*) = 1
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where member.rolname = 'app_runtime_local'
  ),
  'role local do runtime possui somente a membership app_dal esperada'
);

select ok(
  not (
    select membership.admin_option
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    where member.rolname = 'app_runtime_local' and granted.rolname = 'app_dal'
  ),
  'membership local não concede admin option'
);

select ok(
  not (
    select membership.inherit_option
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    where member.rolname = 'app_runtime_local' and granted.rolname = 'app_dal'
  ),
  'membership local não herda app_dal implicitamente'
);

select ok(
  (
    select membership.set_option
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    where member.rolname = 'app_runtime_local' and granted.rolname = 'app_dal'
  ),
  'membership local permite assumir app_dal explicitamente'
);

select ok(
  not has_function_privilege('public', 'private.default_privilege_probe()', 'execute')
    and not has_function_privilege('app_dal', 'private.default_privilege_probe()', 'execute'),
  'nova função private nasce sem execute para PUBLIC ou app_dal'
);

select ok(
  not has_function_privilege('public', 'audit.default_privilege_probe()', 'execute')
    and not has_function_privilege('app_dal', 'audit.default_privilege_probe()', 'execute'),
  'nova função audit nasce sem execute para PUBLIC ou app_dal'
);

select ok(
  not has_function_privilege('public', 'public.default_privilege_probe()', 'execute')
    and not has_function_privilege('anon', 'public.default_privilege_probe()', 'execute')
    and not has_function_privilege('authenticated', 'public.default_privilege_probe()', 'execute')
    and not has_function_privilege('service_role', 'public.default_privilege_probe()', 'execute'),
  'nova função public nasce sem execute implícito para roles da Data API'
);

select ok(
  not has_schema_privilege('anon', 'private', 'usage'),
  'anon não usa schema private'
);

select ok(
  not has_schema_privilege('authenticated', 'private', 'usage'),
  'authenticated não usa schema private'
);

select ok(
  has_schema_privilege('app_dal', 'private', 'usage'),
  'app_dal pode resolver comandos autorizados no schema private'
);

select ok(
  not has_schema_privilege('anon', 'audit', 'usage'),
  'anon não usa schema audit'
);

select ok(
  not has_schema_privilege('authenticated', 'audit', 'usage'),
  'authenticated não usa schema audit'
);

select ok(
  not has_schema_privilege('service_role', 'audit', 'usage'),
  'service_role não recebe acesso genérico ao schema audit'
);

select ok(
  not has_schema_privilege('app_dal', 'audit', 'usage'),
  'app_dal não recebe acesso direto ao schema audit'
);

select ok(
  not has_schema_privilege('public', 'public', 'create'),
  'PUBLIC não cria objetos no schema public'
);

select ok(
  exists (select 1 from pg_catalog.pg_extension where extname = 'pgcrypto'),
  'extensão pgcrypto existe'
);

select ok(
  exists (select 1 from pg_catalog.pg_extension where extname = 'btree_gist'),
  'extensão btree_gist existe'
);

select ok(
  to_regprocedure('private.check_readiness(text)') is not null,
  'função privada de readiness existe'
);

select ok(
  (
    select procedure.prosecdef
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private' and procedure.proname = 'check_readiness'
  ),
  'readiness usa security definer'
);

select ok(
  (
    select 'search_path=""' = any(procedure.proconfig)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private' and procedure.proname = 'check_readiness'
  ),
  'readiness fixa search_path vazio'
);

select ok(
  has_function_privilege('app_dal', 'private.check_readiness(text)', 'execute'),
  'app_dal executa somente o contrato de readiness autorizado'
);

select ok(
  not has_function_privilege('public', 'private.check_readiness(text)', 'execute'),
  'PUBLIC não executa readiness privada'
);

select ok(
  not has_function_privilege('anon', 'private.check_readiness(text)', 'execute'),
  'anon não executa readiness privada'
);

select ok(
  not has_function_privilege('authenticated', 'private.check_readiness(text)', 'execute'),
  'authenticated não executa readiness privada'
);

select ok(
  not has_function_privilege('service_role', 'private.check_readiness(text)', 'execute'),
  'service_role não executa readiness privada por padrão'
);

select ok(
  private.check_readiness('20260809000300'),
  'readiness confirma a migration head atual'
);

select ok(
  not private.check_readiness('versao-inexistente'),
  'readiness rejeita migration head divergente'
);

-- A alteração é transacional e também é revertida explicitamente antes do
-- rollback final para não deixar a role adulterada mesmo quando o assert falha.
alter role app_dal bypassrls;

select ok(
  not (
    select
      not effective.rolcanlogin
      and not effective.rolinherit
      and not effective.rolsuper
      and not effective.rolcreatedb
      and not effective.rolcreaterole
      and not effective.rolreplication
      and not effective.rolbypassrls
    from pg_catalog.pg_roles as effective
    where effective.rolname = 'app_dal'
  ),
  'readiness detecta app_dal adulterada com BYPASSRLS'
);

alter role app_dal nobypassrls;

-- A role efetiva NOINHERIT ainda pode usar SET ROLE quando recebe outra
-- membership. O grant também é revertido explicitamente antes do rollback.
grant pg_read_all_data to app_dal;

select ok(
  not (
    select not exists (
      select 1
      from pg_catalog.pg_auth_members as membership
      where membership.member = effective.oid
    )
    from pg_catalog.pg_roles as effective
    where effective.rolname = 'app_dal'
  ),
  'readiness detecta membership adicional concedida a app_dal'
);

revoke pg_read_all_data from app_dal;

select * from finish();

rollback;
