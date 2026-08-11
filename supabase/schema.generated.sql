


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "audit";


ALTER SCHEMA "audit" OWNER TO "postgres";


COMMENT ON SCHEMA "audit" IS 'Eventos sensíveis append-only não expostos pela Data API.';



CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


COMMENT ON SCHEMA "private" IS 'Objetos internos e comandos não expostos pela Data API.';



CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "private"."bootstrap_signup_identity"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  accepted_at timestamptz := pg_catalog.clock_timestamp();
  intent private.signup_legal_intents%rowtype;
  intent_token_text text;
begin
  intent_token_text := new.raw_user_meta_data ->> 'sl_legal_intent';

  if intent_token_text is null
    or intent_token_text !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_intent_required';
  end if;

  select pending_intent.*
  into intent
  from private.signup_legal_intents as pending_intent
  where pending_intent.id = intent_token_text::uuid
  for update;

  if not found or intent.expires_at <= accepted_at then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_intent_invalid';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = intent.terms_version_id
    and legal_version.kind = 'terms'
    and legal_version.effective_at <= accepted_at
    and (
      legal_version.retired_at is null
      or accepted_at < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = intent.privacy_version_id
    and legal_version.kind = 'privacy'
    and legal_version.effective_at <= accepted_at
    and (
      legal_version.retired_at is null
      or accepted_at < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  insert into public.profiles (
    id,
    person_type,
    status,
    completed_at
  )
  values (
    new.id,
    intent.person_type,
    'active',
    null
  );

  insert into public.terms_acceptances (
    user_id,
    terms_version_id,
    accepted_content_hash,
    accepted_at,
    request_id,
    ip_hash,
    user_agent_hash
  )
  select
    new.id,
    legal_version.id,
    legal_version.content_hash,
    accepted_at,
    intent.request_id,
    intent.ip_hash,
    intent.user_agent_hash
  from public.terms_versions as legal_version
  where legal_version.id in (
    intent.terms_version_id,
    intent.privacy_version_id
  );

  delete from private.signup_legal_intents as pending_intent
  where pending_intent.id = intent.id;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_intent_invalid';
  end if;

  update auth.users as auth_user
  set raw_user_meta_data =
    coalesce(auth_user.raw_user_meta_data, '{}'::jsonb)
      - 'sl_legal_intent'
  where auth_user.id = new.id;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_metadata_scrub_failed';
  end if;

  return new;
end;
$_$;


ALTER FUNCTION "private"."bootstrap_signup_identity"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."bootstrap_signup_identity"() IS 'Apaga a intenção válida no INSERT de auth.users e cria perfil, aceites e scrub de metadata atomicamente.';



CREATE OR REPLACE FUNCTION "private"."check_readiness"("expected_version" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
      pg_catalog.count(*) = 9
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
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)'
          )
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
            'private.issue_identity_recovery_grant(uuid)'
          )
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
            'private.has_identity_recovery_grant(uuid,uuid)'
          )
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
            'private.claim_identity_recovery_grant(uuid,uuid,uuid)'
          )
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
            'private.release_identity_recovery_grant(uuid,uuid,uuid)'
          )
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
            'private.consume_identity_recovery_grant(uuid,uuid,uuid)'
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
      pg_catalog.count(*) = 8
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
        pg_catalog.to_regprocedure('private.check_runtime_readiness(text)'),
        pg_catalog.to_regprocedure(
          'private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)'
        ),
        pg_catalog.to_regprocedure(
          'private.issue_identity_recovery_grant(uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.has_identity_recovery_grant(uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.claim_identity_recovery_grant(uuid,uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.release_identity_recovery_grant(uuid,uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.consume_identity_recovery_grant(uuid,uuid,uuid)'
        )
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
      pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        privilege.grantor = database.datdba
        and privilege.privilege_type = 'CONNECT'
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_database as database
    cross join lateral pg_catalog.aclexplode(
      coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
    ) as privilege
    where database.datname = pg_catalog.current_database()
      and privilege.grantee = 0
  ),
  runtime_role_temporary_privilege_restricted as (
    select not pg_catalog.has_database_privilege(
      runtime_role.oid,
      pg_catalog.current_database(),
      'TEMPORARY'
    ) as restricted
    from runtime_role
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
    and (select restricted from runtime_role_temporary_privilege_restricted)
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
$$;


ALTER FUNCTION "private"."check_readiness"("expected_version" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."check_readiness"("expected_version" "text") IS 'Valida migration head, superfície pública e manifesto exato da role DAL, incluindo cadastro e recovery.';



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
        select
          pg_catalog.count(*) = 1
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
  ),
  effective_role as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = 'app_dal'
  ),
  session_acl_dependencies as (
    select
      pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        dependency.dbid = 0
        and dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
        and dependency.objid = (
          select database.oid
          from pg_catalog.pg_database as database
          where database.datname = pg_catalog.current_database()
        )
        and dependency.objsubid = 0
      ) as restricted
    from pg_catalog.pg_shdepend as dependency
    cross join session_role
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.refobjid = session_role.oid
      and dependency.deptype = 'a'
  ),
  session_database_privilege as (
    select
      pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        privilege.grantee = session_role.oid
        and privilege.grantor <> session_role.oid
        and privilege.privilege_type = 'CONNECT'
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_database as database
    cross join session_role
    cross join lateral pg_catalog.aclexplode(database.datacl) as privilege
    where database.datname = pg_catalog.current_database()
      and (
        privilege.grantee = session_role.oid
        or privilege.grantor = session_role.oid
      )
  ),
  temporary_privileges_restricted as (
    select
      not pg_catalog.has_database_privilege(
        session_role.oid,
        pg_catalog.current_database(),
        'TEMPORARY'
      )
      and not pg_catalog.has_database_privilege(
        effective_role.oid,
        pg_catalog.current_database(),
        'TEMPORARY'
      ) as restricted
    from session_role
    cross join effective_role
  ),
  session_memberships as (
    select
      pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        granted.oid = effective_role.oid
        and not membership.admin_option
        and not membership.inherit_option
        and membership.set_option
      ) as restricted
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    cross join session_role
    cross join effective_role
    where membership.member = session_role.oid
  ),
  session_assumption as (
    select
      pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        member.rolname = 'postgres'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      ) as restricted
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    cross join session_role
    where membership.roleid = session_role.oid
  ),
  effective_assumption as (
    select
      pg_catalog.count(*) = 2
      and pg_catalog.bool_and(
        (
          member.oid = session_role.oid
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
      ) as restricted
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    cross join session_role
    cross join effective_role
    where membership.roleid = effective_role.oid
  )
  select coalesce(
    pg_catalog.current_setting('role', true) = 'app_dal'
    and (select restricted from session_acl_dependencies)
    and (select restricted from session_database_privilege)
    and (select restricted from temporary_privileges_restricted)
    and (select restricted from session_memberships)
    and (select restricted from session_assumption)
    and (select restricted from effective_assumption)
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


COMMENT ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") IS 'Comprova identidade, manifesto mínimo do login DAL e ausência efetiva de TEMPORARY.';



CREATE OR REPLACE FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  claim_time timestamptz;
  grant_claimed boolean;
begin
  if p_token is null or p_user_id is null or p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  claim_time := pg_catalog.clock_timestamp();

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = p_attempt_id,
    claimed_at = coalesce(recovery_grant.claimed_at, claim_time)
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.expires_at > claim_time
    and (
      recovery_grant.claim_attempt_id is null
      or recovery_grant.claim_attempt_id = p_attempt_id
    )
  returning true into grant_claimed;

  return coalesce(grant_claimed, false);
end;
$$;


ALTER FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") IS 'Reserva exclusivamente um grant vigente; retry da mesma tentativa é idempotente.';



CREATE OR REPLACE FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  grant_consumed boolean;
begin
  if p_token is null or p_user_id is null or p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  delete from private.identity_recovery_grants as recovery_grant
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.claim_attempt_id = p_attempt_id
  returning true into grant_consumed;

  return coalesce(grant_consumed, false);
end;
$$;


ALTER FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") IS 'Remove somente o grant reservado pela tentativa após sucesso do provedor.';



CREATE OR REPLACE FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  existing_intent private.signup_legal_intents%rowtype;
  intent_created_at timestamptz;
  intent_id uuid;
  normalized_ip_hash text;
  normalized_user_agent_hash text;
begin
  if expected_terms_version_id is null
    or expected_privacy_version_id is null
    or person_type is null
    or request_id is null
    or evidence is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_signup_legal_intent';
  end if;

  if person_type not in ('individual', 'company')
    or pg_catalog.jsonb_typeof(evidence) <> 'object'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(evidence) as evidence_key(key)
      where evidence_key.key not in ('ipHash', 'userAgentHash')
    )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_signup_legal_intent';
  end if;

  normalized_ip_hash := evidence ->> 'ipHash';
  normalized_user_agent_hash := evidence ->> 'userAgentHash';

  if (
      normalized_ip_hash is not null
      and normalized_ip_hash !~ '^[0-9a-f]{64}$'
    )
    or (
      normalized_user_agent_hash is not null
      and normalized_user_agent_hash !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_signup_legal_evidence';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = expected_terms_version_id
    and legal_version.kind = 'terms'
    and legal_version.effective_at <= pg_catalog.clock_timestamp()
    and (
      legal_version.retired_at is null
      or pg_catalog.clock_timestamp() < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = expected_privacy_version_id
    and legal_version.kind = 'privacy'
    and legal_version.effective_at <= pg_catalog.clock_timestamp()
    and (
      legal_version.retired_at is null
      or pg_catalog.clock_timestamp() < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  delete from private.signup_legal_intents as expired_intent
  where expired_intent.expires_at <= pg_catalog.clock_timestamp();

  intent_created_at := pg_catalog.clock_timestamp();

  insert into private.signup_legal_intents (
    terms_version_id,
    privacy_version_id,
    person_type,
    request_id,
    ip_hash,
    user_agent_hash,
    created_at,
    expires_at
  )
  values (
    expected_terms_version_id,
    expected_privacy_version_id,
    create_signup_legal_intent.person_type,
    create_signup_legal_intent.request_id,
    normalized_ip_hash,
    normalized_user_agent_hash,
    intent_created_at,
    intent_created_at + interval '10 minutes'
  )
  on conflict on constraint signup_legal_intents_request_id_key do nothing
  returning id into intent_id;

  if found then
    return intent_id;
  end if;

  select intent.*
  into existing_intent
  from private.signup_legal_intents as intent
  where intent.request_id = create_signup_legal_intent.request_id
  for update;

  if found
    and existing_intent.expires_at > pg_catalog.clock_timestamp()
    and existing_intent.terms_version_id = expected_terms_version_id
    and existing_intent.privacy_version_id = expected_privacy_version_id
    and existing_intent.person_type = create_signup_legal_intent.person_type
    and existing_intent.ip_hash is not distinct from normalized_ip_hash
    and existing_intent.user_agent_hash
      is not distinct from normalized_user_agent_hash
  then
    return existing_intent.id;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'signup_legal_request_conflict';
end;
$_$;


ALTER FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") IS 'Purga tokens expirados e cria token opaco idempotente enquanto o request_id permanece pendente.';



CREATE OR REPLACE FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if p_token is null or p_user_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  return exists (
    select 1
    from private.identity_recovery_grants as recovery_grant
    where recovery_grant.token = p_token
      and recovery_grant.user_id = p_user_id
      and recovery_grant.expires_at > pg_catalog.statement_timestamp()
      and recovery_grant.claim_attempt_id is null
  );
end;
$$;


ALTER FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") IS 'Confirma somente grant vigente, vinculado ao usuário e ainda não reservado.';



CREATE OR REPLACE FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  grant_issued_at timestamptz;
  grant_token uuid;
begin
  if p_user_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  grant_issued_at := pg_catalog.clock_timestamp();

  delete from private.identity_recovery_grants as expired_grant
  where expired_grant.expires_at <= grant_issued_at;

  insert into private.identity_recovery_grants (
    user_id,
    issued_at,
    expires_at
  )
  values (
    p_user_id,
    grant_issued_at,
    grant_issued_at + interval '15 minutes'
  )
  returning token into grant_token;

  return grant_token;
end;
$$;


ALTER FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") IS 'Purga grants expirados e emite token opaco vinculado ao usuário por 15 minutos.';



CREATE OR REPLACE FUNCTION "private"."protect_profile_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = old.id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'profile_delete_requires_auth_cascade';
  end if;

  return old;
end;
$$;


ALTER FUNCTION "private"."protect_profile_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."protect_terms_acceptance"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception using
      errcode = 'P0001',
      message = 'terms_acceptance_is_immutable';
  end if;

  if exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = old.user_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'terms_acceptance_delete_requires_auth_cascade';
  end if;

  return old;
end;
$$;


ALTER FUNCTION "private"."protect_terms_acceptance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."protect_terms_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'terms_version_is_immutable';
  end if;

  if old.id is not distinct from new.id
    and old.kind is not distinct from new.kind
    and old.version is not distinct from new.version
    and old.title is not distinct from new.title
    and old.body_markdown is not distinct from new.body_markdown
    and old.source is not distinct from new.source
    and old.effective_at is not distinct from new.effective_at
    and old.created_at is not distinct from new.created_at
    and old.retired_at is null
    and new.retired_at is not null
    and new.retired_at >= pg_catalog.statement_timestamp()
  then
    return new;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'terms_version_is_immutable';
end;
$$;


ALTER FUNCTION "private"."protect_terms_version"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  grant_released boolean;
begin
  if p_token is null or p_user_id is null or p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = null,
    claimed_at = null
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.claim_attempt_id = p_attempt_id
  returning true into grant_released;

  return coalesce(grant_released, false);
end;
$$;


ALTER FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") IS 'Libera somente a reserva da tentativa informada para retry após falha do provedor.';



CREATE OR REPLACE FUNCTION "private"."set_profile_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;


ALTER FUNCTION "private"."set_profile_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."validate_terms_acceptance_snapshot"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  expected_hash text;
  version_effective_at timestamptz;
  version_retired_at timestamptz;
begin
  select
    legal_version.content_hash,
    legal_version.effective_at,
    legal_version.retired_at
  into
    expected_hash,
    version_effective_at,
    version_retired_at
  from public.terms_versions as legal_version
  where legal_version.id = new.terms_version_id;

  if expected_hash is null
    or expected_hash <> new.accepted_content_hash
    or new.accepted_at < version_effective_at
    or (
      version_retired_at is not null
      and new.accepted_at >= version_retired_at
    )
    or new.accepted_at > pg_catalog.clock_timestamp()
  then
    raise exception using
      errcode = 'P0001',
      message = 'terms_acceptance_snapshot_mismatch';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "private"."validate_terms_acceptance_snapshot"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_current_legal_terms"() RETURNS TABLE("id" "uuid", "kind" "text", "version" "text", "title" "text", "body_markdown" "text", "content_hash" "text", "source" "text", "effective_at" timestamp with time zone)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select
    legal_version.id,
    legal_version.kind,
    legal_version.version,
    legal_version.title,
    legal_version.body_markdown,
    legal_version.content_hash,
    legal_version.source,
    legal_version.effective_at
  from public.terms_versions as legal_version
  where legal_version.effective_at <= pg_catalog.now()
    and (
      legal_version.retired_at is null
      or pg_catalog.now() < legal_version.retired_at
    )
  order by legal_version.kind;
$$;


ALTER FUNCTION "public"."get_current_legal_terms"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_own_identity_context"() RETURNS TABLE("user_id" "uuid", "person_type" "text", "status" "text", "is_complete" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select
    profile.id,
    profile.person_type,
    profile.status,
    profile.completed_at is not null
  from public.profiles as profile
  where profile.id = (select auth.uid());
$$;


ALTER FUNCTION "public"."get_own_identity_context"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "private"."identity_recovery_grants" (
    "token" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "issued_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "claim_attempt_id" "uuid",
    "claimed_at" timestamp with time zone,
    CONSTRAINT "identity_recovery_grants_claim_pair_check" CHECK (((("claim_attempt_id" IS NULL) AND ("claimed_at" IS NULL)) OR (("claim_attempt_id" IS NOT NULL) AND ("claimed_at" IS NOT NULL) AND ("claimed_at" >= "issued_at") AND ("claimed_at" < "expires_at")))),
    CONSTRAINT "identity_recovery_grants_expiry_check" CHECK ((("expires_at" > "issued_at") AND ("expires_at" <= ("issued_at" + '00:15:00'::interval))))
);


ALTER TABLE "private"."identity_recovery_grants" OWNER TO "postgres";


COMMENT ON TABLE "private"."identity_recovery_grants" IS 'Grant opaco de recuperação, válido por até 15 minutos e removido após consumo.';



COMMENT ON COLUMN "private"."identity_recovery_grants"."claim_attempt_id" IS 'Reserva exclusiva e idempotente da tentativa que pode chamar o provedor Auth.';



CREATE TABLE IF NOT EXISTS "private"."signup_legal_intents" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "terms_version_id" "uuid" NOT NULL,
    "privacy_version_id" "uuid" NOT NULL,
    "person_type" "text" NOT NULL,
    "request_id" "uuid" NOT NULL,
    "ip_hash" "text",
    "user_agent_hash" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "signup_legal_intents_check" CHECK (("terms_version_id" <> "privacy_version_id")),
    CONSTRAINT "signup_legal_intents_check1" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "signup_legal_intents_check2" CHECK (("expires_at" <= ("created_at" + '00:15:00'::interval))),
    CONSTRAINT "signup_legal_intents_ip_hash_check" CHECK ((("ip_hash" IS NULL) OR ("ip_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "signup_legal_intents_person_type_check" CHECK (("person_type" = ANY (ARRAY['individual'::"text", 'company'::"text"]))),
    CONSTRAINT "signup_legal_intents_user_agent_hash_check" CHECK ((("user_agent_hash" IS NULL) OR ("user_agent_hash" ~ '^[0-9a-f]{64}$'::"text")))
);


ALTER TABLE "private"."signup_legal_intents" OWNER TO "postgres";


COMMENT ON TABLE "private"."signup_legal_intents" IS 'Token aleatório e temporário removido atomicamente ao ser consumido ou após expirar.';



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "person_type" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_check" CHECK ((("completed_at" IS NULL) OR ("completed_at" >= "created_at"))),
    CONSTRAINT "profiles_check1" CHECK (("updated_at" >= "created_at")),
    CONSTRAINT "profiles_person_type_check" CHECK (("person_type" = ANY (ARRAY['individual'::"text", 'company'::"text"]))),
    CONSTRAINT "profiles_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'suspended'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."profiles" IS 'Identidade mínima criada atomicamente com auth.users; FEAT-003 completa os dados pessoais.';



COMMENT ON COLUMN "public"."profiles"."completed_at" IS 'Permanece nulo até o comando de conclusão pertencente à FEAT-003.';



CREATE TABLE IF NOT EXISTS "public"."terms_acceptances" (
    "user_id" "uuid" NOT NULL,
    "terms_version_id" "uuid" NOT NULL,
    "accepted_content_hash" "text" NOT NULL,
    "accepted_at" timestamp with time zone NOT NULL,
    "request_id" "uuid" NOT NULL,
    "ip_hash" "text",
    "user_agent_hash" "text",
    CONSTRAINT "terms_acceptances_accepted_content_hash_check" CHECK (("accepted_content_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "terms_acceptances_ip_hash_check" CHECK ((("ip_hash" IS NULL) OR ("ip_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "terms_acceptances_user_agent_hash_check" CHECK ((("user_agent_hash" IS NULL) OR ("user_agent_hash" ~ '^[0-9a-f]{64}$'::"text")))
);


ALTER TABLE "public"."terms_acceptances" OWNER TO "postgres";


COMMENT ON TABLE "public"."terms_acceptances" IS 'Fato jurídico imutável com snapshot do hash aceito e evidência minimizada.';



COMMENT ON COLUMN "public"."terms_acceptances"."ip_hash" IS 'Nulo quando a origem não fornece endereço confiável; nunca recebe IP encaminhado sem confiança.';



CREATE TABLE IF NOT EXISTS "public"."terms_versions" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "kind" "text" NOT NULL,
    "version" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body_markdown" "text" NOT NULL,
    "source" "text" NOT NULL,
    "effective_at" timestamp with time zone NOT NULL,
    "retired_at" timestamp with time zone,
    "content_hash" "text" GENERATED ALWAYS AS ("encode"("extensions"."digest"("body_markdown", 'sha256'::"text"), 'hex'::"text")) STORED,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "terms_versions_body_markdown_check" CHECK (((("char_length"("btrim"("body_markdown")) >= 1) AND ("char_length"("btrim"("body_markdown")) <= 200000)) AND ("body_markdown" = "btrim"("body_markdown")))),
    CONSTRAINT "terms_versions_content_hash_check" CHECK (("content_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "terms_versions_kind_check" CHECK (("kind" = ANY (ARRAY['terms'::"text", 'privacy'::"text"]))),
    CONSTRAINT "terms_versions_retirement_after_effective_check" CHECK ((("retired_at" IS NULL) OR ("retired_at" > "effective_at"))),
    CONSTRAINT "terms_versions_source_check" CHECK (("source" = ANY (ARRAY['local_fixture'::"text", 'approved'::"text"]))),
    CONSTRAINT "terms_versions_title_check" CHECK (((("char_length"("btrim"("title")) >= 3) AND ("char_length"("btrim"("title")) <= 160)) AND ("title" = "btrim"("title")))),
    CONSTRAINT "terms_versions_version_check" CHECK ((("char_length"("version") >= 1) AND ("char_length"("version") <= 40)))
);


ALTER TABLE "public"."terms_versions" OWNER TO "postgres";


COMMENT ON TABLE "public"."terms_versions" IS 'Versões jurídicas append-only; somente aposentadoria nula para definida é permitida.';



COMMENT ON COLUMN "public"."terms_versions"."source" IS 'local_fixture identifica conteúdo exclusivo do ambiente local; approved exige aprovação humana externa.';



ALTER TABLE ONLY "private"."identity_recovery_grants"
    ADD CONSTRAINT "identity_recovery_grants_pkey" PRIMARY KEY ("token");



ALTER TABLE ONLY "private"."signup_legal_intents"
    ADD CONSTRAINT "signup_legal_intents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "private"."signup_legal_intents"
    ADD CONSTRAINT "signup_legal_intents_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("user_id", "terms_version_id");



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_request_id_terms_version_id_key" UNIQUE ("request_id", "terms_version_id");



ALTER TABLE ONLY "public"."terms_versions"
    ADD CONSTRAINT "terms_versions_effective_period_exclusion" EXCLUDE USING "gist" ("kind" WITH =, "tstzrange"("effective_at", "retired_at", '[)'::"text") WITH &&);



ALTER TABLE ONLY "public"."terms_versions"
    ADD CONSTRAINT "terms_versions_kind_version_key" UNIQUE ("kind", "version");



ALTER TABLE ONLY "public"."terms_versions"
    ADD CONSTRAINT "terms_versions_pkey" PRIMARY KEY ("id");



CREATE INDEX "identity_recovery_grants_expires_at_idx" ON "private"."identity_recovery_grants" USING "btree" ("expires_at");



CREATE INDEX "signup_legal_intents_expires_at_idx" ON "private"."signup_legal_intents" USING "btree" ("expires_at");



CREATE OR REPLACE TRIGGER "profiles_protect_delete" BEFORE DELETE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."protect_profile_delete"();



CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."set_profile_updated_at"();



CREATE OR REPLACE TRIGGER "terms_acceptances_protect_immutability" BEFORE DELETE OR UPDATE ON "public"."terms_acceptances" FOR EACH ROW EXECUTE FUNCTION "private"."protect_terms_acceptance"();



CREATE OR REPLACE TRIGGER "terms_acceptances_validate_snapshot" BEFORE INSERT ON "public"."terms_acceptances" FOR EACH ROW EXECUTE FUNCTION "private"."validate_terms_acceptance_snapshot"();



CREATE OR REPLACE TRIGGER "terms_versions_protect_immutability" BEFORE DELETE OR UPDATE ON "public"."terms_versions" FOR EACH ROW EXECUTE FUNCTION "private"."protect_terms_version"();



ALTER TABLE ONLY "private"."identity_recovery_grants"
    ADD CONSTRAINT "identity_recovery_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."signup_legal_intents"
    ADD CONSTRAINT "signup_legal_intents_privacy_version_id_fkey" FOREIGN KEY ("privacy_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "private"."signup_legal_intents"
    ADD CONSTRAINT "signup_legal_intents_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE "private"."identity_recovery_grants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_select_own" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



ALTER TABLE "public"."terms_acceptances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "terms_acceptances_select_own" ON "public"."terms_acceptances" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."terms_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "terms_versions_select_current" ON "public"."terms_versions" FOR SELECT TO "authenticated", "anon" USING ((("effective_at" <= "now"()) AND (("retired_at" IS NULL) OR ("now"() < "retired_at"))));



GRANT USAGE ON SCHEMA "private" TO "app_dal";



REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "private"."bootstrap_signup_identity"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."check_readiness"("expected_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."check_readiness"("expected_version" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."protect_profile_delete"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_terms_acceptance"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_terms_version"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."set_profile_updated_at"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."validate_terms_acceptance_snapshot"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."get_current_legal_terms"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_current_legal_terms"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_legal_terms"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_own_identity_context"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_own_identity_context"() TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("person_type") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("completed_at") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("user_id") ON TABLE "public"."terms_acceptances" TO "authenticated";



GRANT SELECT("terms_version_id") ON TABLE "public"."terms_acceptances" TO "authenticated";



GRANT SELECT("accepted_content_hash") ON TABLE "public"."terms_acceptances" TO "authenticated";



GRANT SELECT("accepted_at") ON TABLE "public"."terms_acceptances" TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("id") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("kind") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("kind") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("version") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("version") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("title") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("title") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("body_markdown") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("body_markdown") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("source") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("source") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("effective_at") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("effective_at") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("retired_at") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("retired_at") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("content_hash") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("content_hash") ON TABLE "public"."terms_versions" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
