-- Fecha o owner drift nas baselines públicas implícitas de rotinas pg_catalog.
-- ACL i/e de pg_init_privs continua autoritativa. Sem essa entrada, rotinas
-- initdb sem membership usam o bootstrap superuser OID imutável 10; membros
-- de extensão usam pg_extension.extowner. A baseline nunca deriva de proowner,
-- que é o próprio estado auditado, e rotinas normais posteriores seguem sem
-- exceção. O OID da rotina preserva a identidade exata de cada overload.

create or replace function private.check_readiness(expected_version text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with runtime_role as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = 'app_dal'
      and not role.rolcanlogin
      and not role.rolinherit
      and not role.rolsuper
      and not role.rolcreatedb
      and not role.rolcreaterole
      and not role.rolreplication
      and not role.rolbypassrls
      and role.rolconfig is null
      and not exists (
        select 1
        from pg_catalog.pg_db_role_setting as setting
        where setting.setrole = role.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_auth_members as membership
        where membership.member = role.oid
      )
  ),
  authorized_acl_dependencies as (
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
  authorized_schema_privilege as (
    select
      pg_catalog.count(*) = 1
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
  authorized_routine_privilege as (
    select
      pg_catalog.count(*) = 2
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
  ),
  public_schema_privileges_restricted as (
    select
      pg_catalog.count(*) = 2
      and pg_catalog.bool_and(
        namespace.nspname in ('information_schema', 'pg_catalog')
        and privilege.grantor = namespace.nspowner
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        namespace.nspacl,
        pg_catalog.acldefault('n', namespace.nspowner)
      )
    ) as privilege
    where privilege.grantee = 0
  ),
  public_database_privileges_restricted as (
    select
      pg_catalog.count(*) = 2
      and pg_catalog.bool_and(
        privilege.grantor = database.datdba
        and privilege.privilege_type in ('CONNECT', 'TEMPORARY')
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_database as database
    cross join lateral pg_catalog.aclexplode(
      coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
    ) as privilege
    where database.datname = pg_catalog.current_database()
      and privilege.grantee = 0
  ),
  public_default_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_default_acl as defaults
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
      where privilege.grantee = 0
    ) as restricted
  ),
  public_large_object_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_largeobject_metadata as large_object
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          large_object.lomacl,
          pg_catalog.acldefault('L', large_object.lomowner)
        )
      ) as privilege
      where privilege.grantee = 0
    ) as restricted
  ),
  public_parameter_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_parameter_acl as parameter
      cross join lateral pg_catalog.aclexplode(parameter.paracl) as privilege
      where privilege.grantee = 0
    ) as restricted
  ),
  public_foreign_data_privileges_restricted as (
    select not exists (
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
    ) as restricted
  ),
  public_tablespace_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_tablespace as tablespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          tablespace.spcacl,
          pg_catalog.acldefault('t', tablespace.spcowner)
        )
      ) as privilege
      where privilege.grantee = 0
    ) as restricted
  ),
  public_language_privileges_restricted as (
    select
      pg_catalog.count(*) = 4
      and pg_catalog.bool_and(
        language.lanname in ('c', 'internal', 'plpgsql', 'sql')
        and privilege.grantor = language.lanowner
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_language as language
    cross join lateral pg_catalog.aclexplode(
      coalesce(language.lanacl, pg_catalog.acldefault('l', language.lanowner))
    ) as privilege
    where privilege.grantee = 0
  ),
  sensitive_catalog_relations as (
    select relation.oid, relation.relowner
    from pg_catalog.pg_class as relation
    where relation.oid in (
      'pg_catalog.pg_db_role_setting'::pg_catalog.regclass,
      'pg_catalog.pg_roles'::pg_catalog.regclass,
      'pg_catalog.pg_user'::pg_catalog.regclass
    )
  ),
  sensitive_catalog_privileges_restricted as (
    select
      (
        select pg_catalog.count(*) = 3
          and pg_catalog.bool_and(
            relation.relowner = (
              select role.oid
              from pg_catalog.pg_roles as role
              where role.rolname = 'supabase_admin'
            )
          )
        from sensitive_catalog_relations as relation
      )
      and (
        select pg_catalog.count(*) = 3
          and pg_catalog.bool_and(
            privilege.grantor = relation.relowner
            and privilege.privilege_type = 'SELECT'
            and not privilege.is_grantable
          )
        from sensitive_catalog_relations as relation
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            (select catalog.relacl from pg_catalog.pg_class as catalog where catalog.oid = relation.oid),
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) as privilege
        where privilege.grantee = (
          select role.oid
          from pg_catalog.pg_roles as role
          where role.rolname = 'postgres'
        )
      )
      and not exists (
        select 1
        from sensitive_catalog_relations as relation
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            (select catalog.relacl from pg_catalog.pg_class as catalog where catalog.oid = relation.oid),
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) as privilege
        where not (
          (
            privilege.grantee = relation.relowner
            and privilege.grantor = relation.relowner
            and not privilege.is_grantable
          )
          or (
            privilege.grantee = (
              select role.oid
              from pg_catalog.pg_roles as role
              where role.rolname = 'postgres'
            )
            and privilege.grantor = relation.relowner
            and privilege.privilege_type = 'SELECT'
            and not privilege.is_grantable
          )
        )
      )
      and not exists (
        select 1
        from sensitive_catalog_relations as relation
        join pg_catalog.pg_attribute as attribute on attribute.attrelid = relation.oid
        cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
        where attribute.attnum > 0
          and not attribute.attisdropped
      )
      and not exists (
        select 1
        from sensitive_catalog_relations as relation
        cross join pg_catalog.pg_roles as role
        where (
            role.rolname in (
              'anon',
              'app_dal',
              'authenticated',
              'service_role'
            )
            or (
              role.rolname = session_user
              and role.rolname not in ('postgres', 'supabase_admin')
            )
          )
          and (
            pg_catalog.has_table_privilege(role.oid, relation.oid, 'SELECT')
            or pg_catalog.has_any_column_privilege(role.oid, relation.oid, 'SELECT')
          )
      ) as restricted
  ),
  public_catalog_relation_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          relation.relacl,
          pg_catalog.acldefault(
            case
              when relation.relkind = 'S'
                then 's'::pg_catalog."char"
              else 'r'::pg_catalog."char"
            end,
            relation.relowner
          )
        )
      ) as current_privilege
      where namespace.nspname = 'pg_catalog'
        and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
        and current_privilege.grantee = 0
        and not exists (
          select 1
          from pg_catalog.pg_init_privs as initial_acl
          cross join lateral pg_catalog.aclexplode(
            initial_acl.initprivs
          ) as initial_privilege
          where initial_acl.classoid =
              'pg_catalog.pg_class'::pg_catalog.regclass
            and initial_acl.objoid = relation.oid
            and initial_acl.objsubid = 0
            and initial_acl.privtype in ('i', 'e')
            and initial_privilege.grantee = 0
            and initial_privilege.privilege_type =
              current_privilege.privilege_type
            and (
              not current_privilege.is_grantable
              or initial_privilege.is_grantable
            )
        )

      union all

      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation.oid
      cross join lateral pg_catalog.aclexplode(
        attribute.attacl
      ) as current_privilege
      where namespace.nspname = 'pg_catalog'
        and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
        and attribute.attnum > 0
        and not attribute.attisdropped
        and current_privilege.grantee = 0
        and not exists (
          select 1
          from pg_catalog.pg_init_privs as initial_acl
          cross join lateral pg_catalog.aclexplode(
            initial_acl.initprivs
          ) as initial_privilege
          where initial_acl.classoid =
              'pg_catalog.pg_class'::pg_catalog.regclass
            and initial_acl.objoid = relation.oid
            and initial_acl.objsubid in (0, attribute.attnum)
            and initial_acl.privtype in ('i', 'e')
            and initial_privilege.grantee = 0
            and initial_privilege.privilege_type =
              current_privilege.privilege_type
            and (
              not current_privilege.is_grantable
              or initial_privilege.is_grantable
            )
        )
    ) as restricted
  ),
  implicit_catalog_routine_owners_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
      left join pg_catalog.pg_depend as dependency
        on dependency.classid =
            'pg_catalog.pg_proc'::pg_catalog.regclass
        and dependency.objid = routine.oid
        and dependency.objsubid = 0
        and dependency.refclassid =
            'pg_catalog.pg_extension'::pg_catalog.regclass
        and dependency.deptype = 'e'
      left join pg_catalog.pg_extension as extension
        on extension.oid = dependency.refobjid
      where namespace.nspname = 'pg_catalog'
        and not exists (
          select 1
          from pg_catalog.pg_init_privs as initial_acl
          where initial_acl.classoid =
              'pg_catalog.pg_proc'::pg_catalog.regclass
            and initial_acl.objoid = routine.oid
            and initial_acl.objsubid = 0
            and initial_acl.privtype in ('i', 'e')
        )
        and (
          (
            extension.oid is not null
            and routine.proowner <> extension.extowner
          )
          or (
            extension.oid is null
            and routine.oid < 16384
            and routine.proowner <> 10
          )
        )
    ) as restricted
  ),
  public_catalog_routine_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
      left join pg_catalog.pg_depend as dependency
        on dependency.classid =
            'pg_catalog.pg_proc'::pg_catalog.regclass
        and dependency.objid = routine.oid
        and dependency.objsubid = 0
        and dependency.refclassid =
            'pg_catalog.pg_extension'::pg_catalog.regclass
        and dependency.deptype = 'e'
      left join pg_catalog.pg_extension as extension
        on extension.oid = dependency.refobjid
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) as current_privilege
      where namespace.nspname = 'pg_catalog'
        and current_privilege.grantee = 0
        and not (
          exists (
            select 1
            from pg_catalog.pg_init_privs as initial_acl
            cross join lateral pg_catalog.aclexplode(
              initial_acl.initprivs
            ) as initial_privilege
            where initial_acl.classoid =
                'pg_catalog.pg_proc'::pg_catalog.regclass
              and initial_acl.objoid = routine.oid
              and initial_acl.objsubid = 0
              and initial_acl.privtype in ('i', 'e')
              and initial_privilege.grantee = current_privilege.grantee
              and initial_privilege.grantor = current_privilege.grantor
              and initial_privilege.privilege_type =
                current_privilege.privilege_type
              and (
                not current_privilege.is_grantable
                or initial_privilege.is_grantable
              )
          )
          or (
            not exists (
              select 1
              from pg_catalog.pg_init_privs as initial_acl
              where initial_acl.classoid =
                  'pg_catalog.pg_proc'::pg_catalog.regclass
                and initial_acl.objoid = routine.oid
                and initial_acl.objsubid = 0
                and initial_acl.privtype in ('i', 'e')
            )
            and (
              (
                extension.oid is not null
                and routine.proowner = extension.extowner
                and exists (
                  select 1
                  from pg_catalog.aclexplode(
                    pg_catalog.acldefault('f', extension.extowner)
                  ) as initial_privilege
                  where initial_privilege.grantee =
                      current_privilege.grantee
                    and initial_privilege.grantor =
                      current_privilege.grantor
                    and initial_privilege.privilege_type =
                      current_privilege.privilege_type
                    and (
                      not current_privilege.is_grantable
                      or initial_privilege.is_grantable
                    )
                )
              )
              or (
                extension.oid is null
                and routine.oid < 16384
                and routine.proowner = 10
                and exists (
                  select 1
                  from pg_catalog.aclexplode(
                    pg_catalog.acldefault('f', 10::pg_catalog.oid)
                  ) as initial_privilege
                  where initial_privilege.grantee =
                      current_privilege.grantee
                    and initial_privilege.grantor =
                      current_privilege.grantor
                    and initial_privilege.privilege_type =
                      current_privilege.privilege_type
                    and (
                      not current_privilege.is_grantable
                      or initial_privilege.is_grantable
                    )
                )
              )
            )
          )
        )
    ) as restricted
  ),
  database_global_settings_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_db_role_setting as setting
      cross join lateral pg_catalog.unnest(setting.setconfig) as configuration(value)
      where setting.setrole = 0
        and setting.setdatabase = (
          select database.oid
          from pg_catalog.pg_database as database
          where database.datname = pg_catalog.current_database()
        )
        and pg_catalog.split_part(configuration.value, '=', 1)
          not in ('app.settings.jwt_exp', 'app.settings.jwt_secret')
    ) as restricted
  ),
  public_private_object_privileges_restricted as (
    select not exists (
      select 1
      from (
        select privilege.grantee
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            relation.relacl,
            pg_catalog.acldefault(
              case
                when relation.relkind = 'S'
                  then 's'::pg_catalog."char"
                else 'r'::pg_catalog."char"
              end,
              relation.relowner
            )
          )
        ) as privilege
        where namespace.nspname = 'private'
          and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')

        union all

        select privilege.grantee
        from pg_catalog.pg_attribute as attribute
        join pg_catalog.pg_class as relation
          on relation.oid = attribute.attrelid
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            attribute.attacl,
            pg_catalog.acldefault('c', relation.relowner)
          )
        ) as privilege
        where namespace.nspname = 'private'
          and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
          and attribute.attnum > 0
          and not attribute.attisdropped

        union all

        select privilege.grantee
        from pg_catalog.pg_proc as routine
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = routine.pronamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )
        ) as privilege
        where namespace.nspname = 'private'

        union all

        select privilege.grantee
        from pg_catalog.pg_type as type_object
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = type_object.typnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            type_object.typacl,
            pg_catalog.acldefault('T', type_object.typowner)
          )
        ) as privilege
        where namespace.nspname = 'private'
          and not exists (
            select 1
            from pg_catalog.pg_type as element_type
            where element_type.typarray = type_object.oid
          )
          and not exists (
            select 1
            from pg_catalog.pg_range as range_type
            where range_type.rngmultitypid = type_object.oid
          )
          and (
            type_object.typrelid = 0
            or exists (
              select 1
              from pg_catalog.pg_class as composite_relation
              where composite_relation.oid = type_object.typrelid
                and composite_relation.relkind = 'c'
            )
          )
      ) as private_object_privilege
      where private_object_privilege.grantee = 0
    ) as restricted
  )
  select coalesce(
    (
      select pg_catalog.max(schema_migrations.version)::text = expected_version
      from supabase_migrations.schema_migrations
    )
    and (select restricted from authorized_acl_dependencies)
    and (select restricted from authorized_schema_privilege)
    and (select restricted from authorized_routine_privilege)
    and (select restricted from public_schema_privileges_restricted)
    and (select restricted from public_database_privileges_restricted)
    and (select restricted from public_default_privileges_restricted)
    and (select restricted from public_large_object_privileges_restricted)
    and (select restricted from public_parameter_privileges_restricted)
    and (select restricted from public_foreign_data_privileges_restricted)
    and (select restricted from public_tablespace_privileges_restricted)
    and (select restricted from public_language_privileges_restricted)
    and (select restricted from sensitive_catalog_privileges_restricted)
    and (select restricted from public_catalog_relation_privileges_restricted)
    and (select restricted from implicit_catalog_routine_owners_restricted)
    and (select restricted from public_catalog_routine_privileges_restricted)
    and (select restricted from database_global_settings_restricted)
    and (select restricted from public_private_object_privileges_restricted)
    and not exists (
      select 1
      from pg_catalog.pg_shdepend as dependency
      join runtime_role on runtime_role.oid = dependency.refobjid
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.deptype = 'o'
    ),
    false
  );
$function$;
