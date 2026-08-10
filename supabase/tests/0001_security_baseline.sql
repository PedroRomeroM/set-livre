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

create function private.app_dal_assumption_probe(expected_member text)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select coalesce(
    (
      select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(
          (
            member.rolname = expected_member
            and not membership.admin_option
            and not membership.inherit_option
            and membership.set_option
          )
          or (
            member.rolname = 'postgres'
            and membership.admin_option
            and not membership.inherit_option
            and not membership.set_option
          )
        )
      from pg_catalog.pg_auth_members as membership
      join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
      join pg_catalog.pg_roles as member on member.oid = membership.member
      where granted.rolname = 'app_dal'
    ),
    false
  );
$function$;

create function private.app_runtime_authorization_probe()
returns boolean
language sql
stable
set search_path = ''
as $function$
  with runtime_role as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = 'app_runtime_local'
      and role.rolconnlimit = 10
      and role.rolvaliduntil = 'infinity'::timestamptz
  )
  select coalesce(
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
      cross join runtime_role
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = runtime_role.oid
        and dependency.deptype = 'a'
    )
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          privilege.grantee = runtime_role.oid
          and privilege.grantor <> runtime_role.oid
          and privilege.privilege_type = 'CONNECT'
          and not privilege.is_grantable
        )
      from pg_catalog.pg_database as database
      cross join runtime_role
      cross join lateral pg_catalog.aclexplode(database.datacl) as privilege
      where database.datname = pg_catalog.current_database()
        and (
          privilege.grantee = runtime_role.oid
          or privilege.grantor = runtime_role.oid
        )
    )
    and not exists (
      select 1
      from pg_catalog.pg_shdepend as dependency
      cross join runtime_role
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = runtime_role.oid
        and dependency.deptype = 'o'
    ),
    false
  );
$function$;

select plan(129);

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
  not has_schema_privilege('public', 'public', 'usage')
    and not has_schema_privilege('app_dal', 'public', 'usage')
    and has_schema_privilege('anon', 'public', 'usage')
    and has_schema_privilege('authenticated', 'public', 'usage')
    and has_schema_privilege('service_role', 'public', 'usage'),
  'schema public exige grants explícitos e não é herdado por app_dal'
);

select ok(
  to_regnamespace('net') is not null
    and not has_schema_privilege('public', 'net', 'usage')
    and not has_schema_privilege('anon', 'net', 'usage')
    and not has_schema_privilege('authenticated', 'net', 'usage')
    and not has_schema_privilege('service_role', 'net', 'usage')
    and not has_schema_privilege('app_dal', 'net', 'usage'),
  'schema net fica indisponível às roles runtime durante a suspensão de APIs externas'
);

select ok(
  not exists (
    select 1
    from (
      values ('public'::name), ('anon'::name), ('authenticated'::name),
        ('service_role'::name), ('app_dal'::name)
    ) as monitored(role_name)
    cross join pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'net'
      and (
        (
          relation.relkind in ('r', 'p', 'v', 'm', 'f')
          and (
            has_table_privilege(monitored.role_name, relation.oid, 'SELECT')
            or has_table_privilege(monitored.role_name, relation.oid, 'INSERT')
            or has_table_privilege(monitored.role_name, relation.oid, 'UPDATE')
            or has_table_privilege(monitored.role_name, relation.oid, 'DELETE')
            or has_table_privilege(monitored.role_name, relation.oid, 'TRUNCATE')
            or has_table_privilege(monitored.role_name, relation.oid, 'REFERENCES')
            or has_table_privilege(monitored.role_name, relation.oid, 'TRIGGER')
          )
        )
        or (
          relation.relkind = 'S'
          and (
            has_sequence_privilege(monitored.role_name, relation.oid, 'USAGE')
            or has_sequence_privilege(monitored.role_name, relation.oid, 'SELECT')
            or has_sequence_privilege(monitored.role_name, relation.oid, 'UPDATE')
          )
        )
      )
  ),
  'tabelas e sequências net não concedem privilégio às roles runtime'
);

select ok(
  not exists (
    select 1
    from (
      values ('public'::name), ('anon'::name), ('authenticated'::name),
        ('service_role'::name), ('app_dal'::name)
    ) as monitored(role_name)
    cross join pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'net'
      and has_function_privilege(monitored.role_name, routine.oid, 'EXECUTE')
  ),
  'funções net não executam pelas roles runtime'
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
  to_regprocedure('private.check_readiness(text)') is not null
    and to_regprocedure('private.check_runtime_readiness(text)') is not null,
  'funções privadas de readiness existem'
);

select ok(
  (
    select pg_catalog.count(*) = 2 and pg_catalog.bool_and(procedure.prosecdef)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname in ('check_readiness', 'check_runtime_readiness')
  ),
  'readiness de banco e runtime usa security definer'
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and('search_path=""' = any(procedure.proconfig))
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname in ('check_readiness', 'check_runtime_readiness')
  ),
  'readiness de banco e runtime fixa search_path vazio'
);

select ok(
  has_function_privilege('app_dal', 'private.check_readiness(text)', 'execute')
    and has_function_privilege(
      'app_dal',
      'private.check_runtime_readiness(text)',
      'execute'
    ),
  'app_dal executa somente os contratos de readiness autorizados'
);

select ok(
  not has_function_privilege('public', 'private.check_readiness(text)', 'execute')
    and not has_function_privilege(
      'public',
      'private.check_runtime_readiness(text)',
      'execute'
    ),
  'PUBLIC não executa readiness privada'
);

select ok(
  not has_function_privilege('anon', 'private.check_readiness(text)', 'execute')
    and not has_function_privilege(
      'anon',
      'private.check_runtime_readiness(text)',
      'execute'
    ),
  'anon não executa readiness privada'
);

select ok(
  not has_function_privilege('authenticated', 'private.check_readiness(text)', 'execute')
    and not has_function_privilege(
      'authenticated',
      'private.check_runtime_readiness(text)',
      'execute'
    ),
  'authenticated não executa readiness privada'
);

select ok(
  not has_function_privilege('service_role', 'private.check_readiness(text)', 'execute')
    and not has_function_privilege(
      'service_role',
      'private.check_runtime_readiness(text)',
      'execute'
    ),
  'service_role não executa readiness privada por padrão'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('anon'::name),
        ('app_dal'::name),
        ('app_runtime_local'::name),
        ('authenticated'::name),
        ('service_role'::name)
    ) as monitored(role_name)
    cross join (
      values
        ('pg_catalog.pg_db_role_setting'::regclass),
        ('pg_catalog.pg_roles'::regclass),
        ('pg_catalog.pg_user'::regclass)
    ) as catalog(relation_oid)
    where has_table_privilege(monitored.role_name, catalog.relation_oid, 'SELECT')
      or has_any_column_privilege(monitored.role_name, catalog.relation_oid, 'SELECT')
  )
    and not exists (
      select 1
      from pg_catalog.pg_attribute as attribute
      cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
      where attribute.attrelid in (
          'pg_catalog.pg_db_role_setting'::regclass,
          'pg_catalog.pg_roles'::regclass,
          'pg_catalog.pg_user'::regclass
        )
        and attribute.attnum > 0
        and not attribute.attisdropped
    ),
  'roles DAL não leem catálogos que podem conter configurações sensíveis'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_parameter_acl as parameter
    cross join lateral pg_catalog.aclexplode(parameter.paracl) as privilege
    where privilege.grantee = 0
  ),
  'PUBLIC não recebe SET ou ALTER SYSTEM em parâmetros'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_foreign_data_wrapper as wrapper
    cross join lateral pg_catalog.aclexplode(
      coalesce(wrapper.fdwacl, pg_catalog.acldefault('F', wrapper.fdwowner))
    ) as privilege
    where privilege.grantee = 0

    union all

    select 1
    from pg_catalog.pg_foreign_server as server
    cross join lateral pg_catalog.aclexplode(
      coalesce(server.srvacl, pg_catalog.acldefault('S', server.srvowner))
    ) as privilege
    where privilege.grantee = 0

    union all

    select 1
    from pg_catalog.pg_tablespace as tablespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        tablespace.spcacl,
        pg_catalog.acldefault('t', tablespace.spcowner)
      )
    ) as privilege
    where privilege.grantee = 0
  ),
  'PUBLIC não recebe privilégios em wrappers, servidores ou tablespaces'
);

select ok(
  (
    select pg_catalog.count(*) = 4
      and pg_catalog.bool_and(
        language.lanname in ('c', 'internal', 'plpgsql', 'sql')
        and privilege.grantor = language.lanowner
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable
      )
    from pg_catalog.pg_language as language
    cross join lateral pg_catalog.aclexplode(
      coalesce(language.lanacl, pg_catalog.acldefault('l', language.lanowner))
    ) as privilege
    where privilege.grantee = 0
  ),
  'PUBLIC preserva somente USAGE nas quatro linguagens internas esperadas'
);

select ok(
  (
    with runtime_role as (
      select oid
      from pg_catalog.pg_roles
      where rolname = 'app_dal'
    ),
    acl_dependencies as (
      select
        pg_catalog.count(*) = 3
        and pg_catalog.bool_and(
          (
            dependency.dbid = (
              select database.oid
              from pg_catalog.pg_database as database
              where database.datname = pg_catalog.current_database()
            )
            and dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
            and dependency.objid = pg_catalog.to_regnamespace('private')
            and dependency.objsubid = 0
          )
          or (
            dependency.dbid = (
              select database.oid
              from pg_catalog.pg_database as database
              where database.datname = pg_catalog.current_database()
            )
            and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            and dependency.objid = pg_catalog.to_regprocedure('private.check_readiness(text)')
            and dependency.objsubid = 0
          )
          or (
            dependency.dbid = (
              select database.oid
              from pg_catalog.pg_database as database
              where database.datname = pg_catalog.current_database()
            )
            and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            and dependency.objid = pg_catalog.to_regprocedure(
              'private.check_runtime_readiness(text)'
            )
            and dependency.objsubid = 0
          )
        ) as restricted
      from pg_catalog.pg_shdepend as dependency
      join runtime_role on runtime_role.oid = dependency.refobjid
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.deptype = 'a'
    ),
    schema_privilege as (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          privilege.grantee = runtime_role.oid
          and privilege.grantor <> runtime_role.oid
          and privilege.privilege_type = 'USAGE'
          and not privilege.is_grantable
        ) as restricted
      from pg_catalog.pg_namespace as namespace
      cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
      cross join runtime_role
      where namespace.oid = pg_catalog.to_regnamespace('private')
        and (privilege.grantee = runtime_role.oid or privilege.grantor = runtime_role.oid)
    ),
    routine_privilege as (
      select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(
          privilege.grantee = runtime_role.oid
          and privilege.grantor <> runtime_role.oid
          and privilege.privilege_type = 'EXECUTE'
          and not privilege.is_grantable
        ) as restricted
      from pg_catalog.pg_proc as routine
      cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
      cross join runtime_role
      where routine.oid in (
          pg_catalog.to_regprocedure('private.check_readiness(text)'),
          pg_catalog.to_regprocedure('private.check_runtime_readiness(text)')
        )
        and (privilege.grantee = runtime_role.oid or privilege.grantor = runtime_role.oid)
    )
    select (select restricted from acl_dependencies)
      and (select restricted from schema_privilege)
      and (select restricted from routine_privilege)
  ),
  'app_dal preserva somente as três dependências ACL autorizadas, sem grant option'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_shdepend as dependency
    join pg_catalog.pg_roles as runtime_role on runtime_role.oid = dependency.refobjid
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.deptype = 'o'
      and runtime_role.rolname = 'app_dal'
  ),
  'app_dal não possui nenhum objeto registrado no catálogo de ownership'
);

select ok(
  private.check_readiness('20260810000100'),
  'readiness confirma a migration head atual'
);

select ok(
  not private.check_readiness('versao-inexistente'),
  'readiness rejeita migration head divergente'
);

grant usage on schema public to public;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta USAGE de PUBLIC recuperado em schema não sistêmico'
);

revoke usage on schema public from public;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após fechar novamente o schema public'
);

grant create on schema private to public;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta CREATE de PUBLIC em schema não sistêmico'
);

revoke create on schema private from public;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após remover CREATE público do schema'
);

grant create on database postgres to public;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta CREATE público no banco atual'
);

revoke create on database postgres from public;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após restaurar ACL pública exata do banco'
);

create function private.readiness_public_routine_probe()
returns boolean
language sql
stable
set search_path = ''
as $function$
  select true;
$function$;

grant execute on function private.readiness_public_routine_probe() to public;

select ok(
  has_function_privilege(
    'app_dal',
    'private.readiness_public_routine_probe()',
    'execute'
  ),
  'grant PUBLIC em função private alcança app_dal pelo USAGE autorizado do schema'
);

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta EXECUTE efetivo de PUBLIC em função private'
);

revoke execute on function private.readiness_public_routine_probe() from public;

select ok(
  not has_function_privilege(
    'app_dal',
    'private.readiness_public_routine_probe()',
    'execute'
  ),
  'revogação de PUBLIC remove o EXECUTE efetivo da role DAL'
);

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após fechar a função private'
);

drop function private.readiness_public_routine_probe();

create table private.readiness_relation_row_type_probe (id bigint);

select ok(
  private.check_readiness('20260810000100'),
  'row type implícito de tabela private não é tratado como tipo autônomo'
);

drop table private.readiness_relation_row_type_probe;

grant usage on schema private to app_dal with grant option;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta grant option sobre o USAGE mínimo de app_dal'
);

revoke grant option for usage on schema private from app_dal;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após remover o grant option'
);

do $block$
begin
  execute pg_catalog.format(
    'grant create on database %I to app_dal',
    current_database()
  );
end
$block$;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta grant direto no banco para app_dal'
);

do $block$
begin
  execute pg_catalog.format(
    'revoke create on database %I from app_dal',
    current_database()
  );
end
$block$;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após revogar o grant de banco'
);

grant create on schema public to app_dal;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta grant direto em schema fora do manifesto'
);

revoke create on schema public from app_dal;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após revogar o grant de schema'
);

create table private.readiness_relation_privilege_probe (id bigint);
grant select on table private.readiness_relation_privilege_probe to app_dal;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta grant direto em relação para app_dal'
);

revoke all on table private.readiness_relation_privilege_probe from app_dal;
drop table private.readiness_relation_privilege_probe;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após revogar o grant de relação'
);

create table private.readiness_column_privilege_probe (id bigint, private_value text);
grant select (private_value) on table private.readiness_column_privilege_probe to app_dal;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta grant direto por coluna invisível em relacl'
);

revoke select (private_value) on table private.readiness_column_privilege_probe from app_dal;
drop table private.readiness_column_privilege_probe;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após revogar o grant de coluna'
);

create sequence private.readiness_sequence_privilege_probe;
grant usage on sequence private.readiness_sequence_privilege_probe to app_dal;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta grant direto em sequência para app_dal'
);

revoke all on sequence private.readiness_sequence_privilege_probe from app_dal;
drop sequence private.readiness_sequence_privilege_probe;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após revogar o grant de sequência'
);

create function private.readiness_routine_privilege_probe()
returns boolean
language sql
stable
set search_path = ''
as $function$
  select true;
$function$;

grant execute on function private.readiness_routine_privilege_probe() to app_dal;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta grant direto em função fora do manifesto'
);

revoke all on function private.readiness_routine_privilege_probe() from app_dal;
drop function private.readiness_routine_privilege_probe();

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após revogar o grant de função'
);

create type private.readiness_type_privilege_probe as enum ('probe');
grant usage on type private.readiness_type_privilege_probe to app_dal;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta grant direto em tipo para app_dal'
);

revoke all on type private.readiness_type_privilege_probe from app_dal;
drop type private.readiness_type_privilege_probe;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após revogar o grant de tipo'
);

alter default privileges for role postgres in schema private
  grant select on tables to app_dal;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta default privilege concedido a app_dal'
);

alter default privileges for role postgres in schema private
  revoke select on tables from app_dal;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após revogar o default privilege'
);

savepoint readiness_large_object_drift;

do $block$
declare
  object_oid oid;
begin
  select pg_catalog.lo_create(0) into object_oid;
  execute pg_catalog.format(
    'grant select on large object %s to app_dal',
    object_oid
  );
end
$block$;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta ACL compartilhada em objeto grande'
);

rollback to savepoint readiness_large_object_drift;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após restaurar o objeto grande'
);

savepoint readiness_public_large_object_drift;

do $block$
declare
  object_oid oid;
begin
  select pg_catalog.lo_create(0) into object_oid;
  execute pg_catalog.format(
    'grant select on large object %s to public',
    object_oid
  );
end
$block$;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta ACL pública em objeto grande'
);

rollback to savepoint readiness_public_large_object_drift;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após restaurar objeto grande público'
);

alter default privileges for role postgres in schema private
  grant select on tables to public;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta default privilege público antes de materializar objeto'
);

alter default privileges for role postgres in schema private
  revoke select on tables from public;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após remover default privilege público'
);

savepoint readiness_ownership_drift;
grant app_dal to postgres with inherit false, set true;
create schema readiness_ownership_probe authorization app_dal;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta ownership indevido concedido a app_dal'
);

rollback to savepoint readiness_ownership_drift;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após restaurar o ownership'
);

-- A alteração é transacional e também é revertida explicitamente antes do
-- rollback final para não deixar a role adulterada mesmo quando o assert falha.
alter role app_dal bypassrls;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta app_dal adulterada com BYPASSRLS'
);

alter role app_dal nobypassrls;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após restaurar os atributos de app_dal'
);

alter role app_dal in database postgres set search_path = 'net, public';

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta parâmetro persistente por banco na role app_dal'
);

alter role app_dal in database postgres reset all;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após remover o parâmetro por banco'
);

-- A role efetiva NOINHERIT ainda pode usar SET ROLE quando recebe outra
-- membership. O grant também é revertido explicitamente antes do rollback.
grant pg_read_all_data to app_dal;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta membership adicional concedida a app_dal'
);

revoke pg_read_all_data from app_dal;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após revogar a membership indevida'
);

grant pg_read_all_data to anon;

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta acesso transitivo de role web a catálogo sensível'
);

revoke pg_read_all_data from anon;

select ok(
  private.check_readiness('20260810000100'),
  'readiness volta a ficar pronta após remover acesso transitivo ao catálogo'
);

select ok(
  private.app_dal_assumption_probe('app_runtime_local'),
  'somente runtime local e membership administrativa postgres referenciam app_dal'
);

create role readiness_rogue_membership nologin noinherit;
grant app_dal to readiness_rogue_membership
  with admin false, inherit false, set false;

select ok(
  not private.app_dal_assumption_probe('app_runtime_local'),
  'manifesto detecta terceiro membro mesmo sem admin, inherit ou set'
);

revoke app_dal from readiness_rogue_membership;
drop role readiness_rogue_membership;

select ok(
  private.app_dal_assumption_probe('app_runtime_local'),
  'manifesto de quem assume app_dal volta ao estado exato após restauração'
);

select ok(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        member.rolname = 'postgres'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      )
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where granted.rolname = 'app_runtime_local'
  ),
  'somente postgres administra o login local, sem SET ou INHERIT'
);

create role readiness_runtime_assumption_probe nologin noinherit;
grant app_runtime_local to readiness_runtime_assumption_probe
  with admin false, inherit false, set true;

select ok(
  not (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        member.rolname = 'postgres'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      )
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where granted.rolname = 'app_runtime_local'
  ),
  'manifesto detecta terceiro membro capaz de assumir o login local'
);

select ok(
  pg_catalog.pg_has_role('readiness_runtime_assumption_probe', 'app_dal', 'set'),
  'membership de entrada no login local abriria caminho transitivo até app_dal'
);

revoke app_runtime_local from readiness_runtime_assumption_probe;
drop role readiness_runtime_assumption_probe;

select ok(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        member.rolname = 'postgres'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      )
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where granted.rolname = 'app_runtime_local'
  ),
  'manifesto do login restrito volta ao administrador sem SET ou INHERIT'
);

select ok(
  (
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
    join pg_catalog.pg_roles as role on role.oid = setting.setrole
    where role.rolname = 'app_runtime_local'
  ),
  'login restrito local preserva somente a máscara vazia do segredo JWT'
);

alter role app_runtime_local in database postgres set search_path = 'net, public';

select ok(
  not (
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
    join pg_catalog.pg_roles as role on role.oid = setting.setrole
    where role.rolname = 'app_runtime_local'
  ),
  'drift de parâmetro por banco do login local fica visível no catálogo'
);

alter role app_runtime_local in database postgres reset all;

select ok(
  (
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
    join pg_catalog.pg_roles as role on role.oid = setting.setrole
    where role.rolname = 'app_runtime_local'
  ),
  'manifesto do login local volta somente à máscara vazia do segredo JWT'
);

alter database postgres set search_path = 'net, public';

select ok(
  not private.check_readiness('20260810000100'),
  'readiness detecta parâmetro global por banco fora da allowlist'
);

alter database postgres reset search_path;

select ok(
  private.check_readiness('20260810000100'),
  'readiness preserva somente parâmetros globais autorizados após restauração'
);

select ok(
  private.app_runtime_authorization_probe(),
  'login local possui somente CONNECT direto e nenhum ownership'
);

alter role app_runtime_local connection limit -1;

select ok(
  not private.app_runtime_authorization_probe(),
  'manifesto do login local detecta remoção do limite de conexões'
);

alter role app_runtime_local connection limit 10;

select ok(
  private.app_runtime_authorization_probe(),
  'manifesto do login local volta ao limite de dez conexões'
);

alter role app_runtime_local valid until '2026-08-11 00:00:00+00';

select ok(
  not private.app_runtime_authorization_probe(),
  'manifesto do login local detecta validade diferente de infinity'
);

alter role app_runtime_local valid until 'infinity';

select ok(
  private.app_runtime_authorization_probe(),
  'manifesto do login local volta à validade sem expiração'
);

savepoint readiness_runtime_acl_drift;

do $block$
declare
  object_oid oid;
begin
  select pg_catalog.lo_create(0) into object_oid;
  execute pg_catalog.format(
    'grant select on large object %s to app_runtime_local',
    object_oid
  );
end
$block$;

select ok(
  not private.app_runtime_authorization_probe(),
  'manifesto do login local detecta ACL compartilhada em objeto grande'
);

rollback to savepoint readiness_runtime_acl_drift;

select ok(
  private.app_runtime_authorization_probe(),
  'manifesto do login local volta ao CONNECT exato após restaurar a ACL'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_default_acl as defaults
    join pg_catalog.pg_roles as owner on owner.oid = defaults.defaclrole
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
    where owner.rolname = 'supabase_admin'
      and defaults.defaclnamespace = 0
      and defaults.defaclobjtype = 'f'
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'funções futuras de supabase_admin não recebem EXECUTE público por default'
);

select * from finish();

rollback;
