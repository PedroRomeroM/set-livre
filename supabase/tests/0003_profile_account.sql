-- FEAT-003: perfil, PII mascarada, preferências, ACL/RLS e concorrência.

-- Fixtures concorrentes precisam estar committed para sessões dblink.
delete from auth.users
where id in (
  '39000000-0000-4000-8000-000000000001',
  '39000000-0000-4000-8000-000000000002'
);

delete from private.signup_legal_intents
where request_id in (
  '39100000-0000-4000-8000-000000000001',
  '39100000-0000-4000-8000-000000000002'
);

do $block$
declare
  same_intent uuid;
  divergent_intent uuid;
begin
  same_intent := private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '39100000-0000-4000-8000-000000000001',
    '{}'::jsonb
  );
  divergent_intent := private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '39100000-0000-4000-8000-000000000002',
    '{}'::jsonb
  );

  insert into auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  )
  values
    (
      '39000000-0000-4000-8000-000000000001',
      'authenticated',
      'authenticated',
      'qa-feat003-concurrent-same@setlivre.local',
      '',
      pg_catalog.now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      pg_catalog.jsonb_build_object('sl_legal_intent', same_intent::text),
      pg_catalog.now(),
      pg_catalog.now()
    ),
    (
      '39000000-0000-4000-8000-000000000002',
      'authenticated',
      'authenticated',
      'qa-feat003-concurrent-divergent@setlivre.local',
      '',
      pg_catalog.now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      pg_catalog.jsonb_build_object('sl_legal_intent', divergent_intent::text),
      pg_catalog.now(),
      pg_catalog.now()
    );
end;
$block$;

begin;

create function private.feat003_capture_error(command text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
begin
  execute command;
  return 'NO_ERROR';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$function$;

create function private.feat003_create_user(
  user_id uuid,
  email_address text,
  initial_person_type text,
  request_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  legal_intent uuid;
begin
  legal_intent := private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    initial_person_type,
    request_id,
    '{}'::jsonb
  );

  insert into auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  )
  values (
    user_id,
    'authenticated',
    'authenticated',
    email_address,
    '',
    pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    pg_catalog.jsonb_build_object('sl_legal_intent', legal_intent::text),
    pg_catalog.now(),
    pg_catalog.now()
  );
end;
$function$;

revoke all on function private.feat003_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat003_create_user(uuid, text, text, uuid)
  from public, anon, authenticated, service_role, app_dal;

create temporary table feat003_results (
  label text primary key,
  user_id uuid not null,
  person_type text not null,
  status text not null,
  name text,
  phone_e164 text,
  tax_id_masked text,
  additional_document_masked text,
  profile_completed boolean not null,
  profile_version bigint not null,
  color_scheme text not null,
  preferences_version bigint not null
) on commit drop;

create temporary table feat003_concurrency_results (
  label text primary key,
  profile_version bigint,
  error_message text
) on commit drop;

select plan(57);

select ok(
  pg_catalog.to_regclass('public.user_preferences') is not null,
  'tabela canônica de preferências existe'
);

select ok(
  (
    select pg_catalog.count(*) = 7
      and pg_catalog.bool_and(
        case attribute.attname
          when 'tax_id_masked' then attribute.attgenerated = 's'
          when 'additional_document_masked' then attribute.attgenerated = 's'
          else attribute.attgenerated = ''
        end
      )
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.profiles'::pg_catalog.regclass
      and attribute.attname in (
        'name', 'phone_e164', 'tax_id', 'additional_document',
        'tax_id_masked', 'additional_document_masked', 'profile_version'
      )
      and attribute.attnum > 0
      and not attribute.attisdropped
  ),
  'profiles possui sete campos FEAT-003 e somente máscaras generated'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_index as index_definition
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = index_definition.indrelid
      and attribute.attnum = any(index_definition.indkey)
    where index_definition.indrelid = 'public.profiles'::pg_catalog.regclass
      and index_definition.indisunique
      and attribute.attname = 'tax_id'
  ),
  'CPF/CNPJ não cria unicidade nem oráculo estrutural'
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(relation.relrowsecurity)
    from pg_catalog.pg_class as relation
    where relation.oid in (
      'public.profiles'::pg_catalog.regclass,
      'public.user_preferences'::pg_catalog.regclass
    )
  ),
  'profiles e user_preferences mantêm RLS habilitada'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_policy as policy
    where policy.polrelid = 'public.user_preferences'::pg_catalog.regclass
      and policy.polname = 'user_preferences_select_own'
      and policy.polcmd = 'r'
  ),
  'preferências possuem policy de leitura própria'
);

select ok(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'public.user_preferences',
    'SELECT'
  )
    and not exists (
      select 1
      from (
        values
          ('public.profiles'::regclass, 'id'::name),
          ('public.profiles'::regclass, 'person_type'::name),
          ('public.profiles'::regclass, 'status'::name),
          ('public.profiles'::regclass, 'name'::name),
          ('public.profiles'::regclass, 'phone_e164'::name),
          ('public.profiles'::regclass, 'tax_id_masked'::name),
          ('public.profiles'::regclass, 'additional_document_masked'::name),
          ('public.profiles'::regclass, 'completed_at'::name),
          ('public.profiles'::regclass, 'profile_version'::name),
          ('public.user_preferences'::regclass, 'user_id'::name),
          ('public.user_preferences'::regclass, 'color_scheme'::name),
          ('public.user_preferences'::regclass, 'preferences_version'::name)
      ) as required(relation_oid, column_name)
      where not pg_catalog.has_column_privilege(
        'authenticated',
        required.relation_oid,
        required.column_name,
        'SELECT'
      )
    ),
  'authenticated recebe somente colunas necessárias ao read model invoker'
);

select ok(
  not pg_catalog.has_column_privilege(
      'authenticated', 'public.profiles', 'tax_id', 'SELECT'
    )
    and not pg_catalog.has_column_privilege(
      'authenticated', 'public.profiles', 'additional_document', 'SELECT'
    )
    and not pg_catalog.has_column_privilege(
      'authenticated', 'public.profiles', 'created_at', 'SELECT'
    )
    and not pg_catalog.has_column_privilege(
      'authenticated', 'public.profiles', 'updated_at', 'SELECT'
    )
    and not pg_catalog.has_column_privilege(
      'authenticated', 'public.user_preferences', 'created_at', 'SELECT'
    )
    and not pg_catalog.has_column_privilege(
      'authenticated', 'public.user_preferences', 'updated_at', 'SELECT'
    )
    and not exists (
    select 1
    from (
      values ('anon'::name), ('service_role'::name), ('app_dal'::name)
    ) as monitored(role_name)
    cross join (
      values
        ('public.profiles'::regclass, 'name'::name),
        ('public.profiles'::regclass, 'phone_e164'::name),
        ('public.profiles'::regclass, 'tax_id_masked'::name),
        ('public.profiles'::regclass, 'additional_document_masked'::name),
        ('public.profiles'::regclass, 'profile_version'::name),
        ('public.user_preferences'::regclass, 'user_id'::name),
        ('public.user_preferences'::regclass, 'color_scheme'::name),
        ('public.user_preferences'::regclass, 'preferences_version'::name)
    ) as protected(relation_oid, column_name)
    where pg_catalog.has_column_privilege(
      monitored.role_name,
      protected.relation_oid,
      protected.column_name,
      'SELECT'
    )
  ),
  'PII crua e colunas excedentes seguem inacessíveis e outras roles não leem a projeção'
);

select ok(
  not exists (
    select 1
    from (
      values ('anon'::name), ('authenticated'::name),
        ('service_role'::name), ('app_dal'::name)
    ) as monitored(role_name)
    cross join (
      values ('public.profiles'::regclass), ('public.user_preferences'::regclass)
    ) as protected(relation_oid)
    where pg_catalog.has_table_privilege(
      monitored.role_name,
      protected.relation_oid,
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
  ),
  'roles runtime não escrevem diretamente perfil ou aparência'
);

select ok(
  (
    select not routine.prosecdef
      and routine.provolatile = 's'
      and routine.pronargs = 0
      and 'search_path=""' = any(routine.proconfig)
    from pg_catalog.pg_proc as routine
    where routine.oid = 'public.get_my_profile()'::pg_catalog.regprocedure
  )
    and pg_catalog.has_function_privilege(
      'authenticated', 'public.get_my_profile()', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'public', 'public.get_my_profile()', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'anon', 'public.get_my_profile()', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'service_role', 'public.get_my_profile()', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal', 'public.get_my_profile()', 'EXECUTE'
    ),
  'read model público é invoker sem argumentos e executa somente por authenticated'
);

select ok(
  (
    select pg_catalog.count(*) = 3
      and pg_catalog.bool_and(routine.prosecdef)
      and pg_catalog.bool_and('search_path=""' = any(routine.proconfig))
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = routine.pronamespace
    where namespace.nspname = 'private'
      and routine.proname in (
        'complete_profile',
        'update_profile_identity',
        'update_profile_appearance'
      )
  )
    and not exists (
    select 1
    from (
      values
        ('private.complete_profile(uuid,bigint,text,text,text,text,text)'::text),
        ('private.update_profile_identity(uuid,bigint,text,text,boolean,text,boolean,text)'::text),
        ('private.update_profile_appearance(uuid,bigint,text)'::text)
    ) as entrypoint(signature)
    where not pg_catalog.has_function_privilege(
        'app_dal', entrypoint.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'public', entrypoint.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'anon', entrypoint.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'authenticated', entrypoint.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'service_role', entrypoint.signature, 'EXECUTE'
      )
  ),
  'três comandos privados são definer e executam somente por app_dal'
);

select ok(
  (
    select routine.prosecdef
      and 'search_path=""' = any(routine.proconfig)
    from pg_catalog.pg_proc as routine
    where routine.oid =
      'private.profile_command_result(uuid)'::pg_catalog.regprocedure
  )
    and not exists (
      select 1
      from (
        values ('public'::name), ('anon'::name), ('authenticated'::name),
          ('service_role'::name), ('app_dal'::name)
      ) as monitored(role_name)
      where pg_catalog.has_function_privilege(
        monitored.role_name,
        'private.profile_command_result(uuid)',
        'EXECUTE'
      )
    )
    and not pg_catalog.has_function_privilege(
      'app_dal', 'private.is_valid_cpf(text)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal', 'private.is_valid_cnpj(text)', 'EXECUTE'
    ),
  'helper de projeção e validadores internos não ampliam superfície app_dal'
);

select ok(
  private.is_valid_cpf('28001238938')
    and private.is_valid_cpf('52998224725'),
  'CPF aceita fixtures canônicas válidas'
);

select ok(
  not private.is_valid_cpf('28001238939')
    and not private.is_valid_cpf('11111111111')
    and not private.is_valid_cpf('280.012.389-38'),
  'CPF rejeita DV, repetição e apresentação não canônica'
);

select ok(
  private.is_valid_cnpj('11222333000181')
    and private.is_valid_cnpj('12ABC34501DE35'),
  'CNPJ aceita legado numérico e fixture alfanumérica oficial'
);

select ok(
  not private.is_valid_cnpj('11222333000182')
    and not private.is_valid_cnpj('12abc34501de35')
    and not private.is_valid_cnpj('12.ABC.345/01DE-35')
    and not private.is_valid_cnpj('00000000000000'),
  'CNPJ rejeita DV, lowercase, pontuação e repetição'
);

select private.feat003_create_user(
  '30000000-0000-4000-8000-000000000001',
  'qa-feat003-a@setlivre.local',
  'individual',
  '31000000-0000-4000-8000-000000000001'
);
select private.feat003_create_user(
  '30000000-0000-4000-8000-000000000002',
  'qa-feat003-b@setlivre.local',
  'individual',
  '31000000-0000-4000-8000-000000000002'
);
select private.feat003_create_user(
  '30000000-0000-4000-8000-000000000003',
  'qa-feat003-suspended@setlivre.local',
  'individual',
  '31000000-0000-4000-8000-000000000003'
);
select private.feat003_create_user(
  '30000000-0000-4000-8000-000000000004',
  'qa-feat003-missing-legal@setlivre.local',
  'individual',
  '31000000-0000-4000-8000-000000000004'
);
select private.feat003_create_user(
  '30000000-0000-4000-8000-000000000005',
  'qa-feat003-cascade@setlivre.local',
  'individual',
  '31000000-0000-4000-8000-000000000005'
);
select private.feat003_create_user(
  '30000000-0000-4000-8000-000000000006',
  'qa-feat003-owner@setlivre.local',
  'individual',
  '31000000-0000-4000-8000-000000000006'
);
select private.feat003_create_user(
  '30000000-0000-4000-8000-000000000007',
  'qa-feat003-application-admin@setlivre.local',
  'individual',
  '31000000-0000-4000-8000-000000000007'
);

-- FEAT-004 e FEAT-031 ainda são donas, respectivamente, de owner_profiles e
-- platform_roles. Estes marcadores existem somente na fixture Auth para provar
-- que metadata com aparência de privilégio de negócio nunca amplia ACL/RLS.
update auth.users
set raw_app_meta_data = raw_app_meta_data ||
  '{"set_livre_test_persona":"owner"}'::jsonb
where id = '30000000-0000-4000-8000-000000000006';

update auth.users
set raw_app_meta_data = raw_app_meta_data ||
  '{"set_livre_test_persona":"application_admin"}'::jsonb
where id = '30000000-0000-4000-8000-000000000007';

select is(
  (
    select pg_catalog.jsonb_object_agg(
      auth_user.id::text,
      auth_user.raw_app_meta_data->>'set_livre_test_persona'
      order by auth_user.id
    )
    from auth.users as auth_user
    where auth_user.id in (
      '30000000-0000-4000-8000-000000000006',
      '30000000-0000-4000-8000-000000000007'
    )
  ),
  '{
    "30000000-0000-4000-8000-000000000006": "owner",
    "30000000-0000-4000-8000-000000000007": "application_admin"
  }'::jsonb,
  'fixtures Auth reais distinguem owner e admin sem criar papel canônico antecipado'
);

select ok(
  not exists (
    select 1
    from public.profiles as profile
    left join public.user_preferences as preference
      on preference.user_id = profile.id
    where preference.user_id is null
  ),
  'backfill e trigger mantêm uma preferência por perfil'
);

select ok(
  (
    select preference.color_scheme = 'system'
      and preference.preferences_version = 0
    from public.user_preferences as preference
    where preference.user_id = '30000000-0000-4000-8000-000000000001'
  ),
  'preferência nova nasce system e versão zero'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.preference_scope_a',
  (
    select pg_catalog.jsonb_build_object(
      'count', pg_catalog.count(*),
      'ownsAll',
      pg_catalog.bool_and(
        preference.user_id = '30000000-0000-4000-8000-000000000001'
      )
    )::text
    from public.user_preferences as preference
  ),
  true
);
reset role;

select is(
  pg_catalog.current_setting('set_livre.test.preference_scope_a')::jsonb,
  '{"count":1,"ownsAll":true}'::jsonb,
  'RLS deixa usuário A ver somente a própria preferência'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.preference_scope_b',
  (
    select pg_catalog.jsonb_build_object(
      'count', pg_catalog.count(*),
      'ownsAll',
      pg_catalog.bool_and(
        profile.user_id = '30000000-0000-4000-8000-000000000002'
      )
    )::text
    from public.get_my_profile() as profile
  ),
  true
);
reset role;

select is(
  pg_catalog.current_setting('set_livre.test.preference_scope_b')::jsonb,
  '{"count":1,"ownsAll":true}'::jsonb,
  'RPC invoker e RLS deixam usuário B ver somente o próprio perfil'
);

-- O postgres local conserva ADMIN sem SET no manifesto. O teste habilita SET
-- apenas nesta transação, exerce a role efetiva da DAL e restaura a membership
-- exata antes de consultar readiness.
grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.owner_complete_version',
  (
    select profile.profile_version::text
    from private.complete_profile(
      '30000000-0000-4000-8000-000000000006',
      0,
      'individual',
      'Pessoa Dona de Estúdio',
      '+5541991112233',
      '28001238938',
      null
    ) as profile
  ),
  true
);

select pg_catalog.set_config(
  'set_livre.test.owner_dal_result',
  (
    select pg_catalog.jsonb_build_object(
      'userId', profile.user_id,
      'name', profile.name,
      'profileVersion', profile.profile_version,
      'preferencesVersion', profile.preferences_version
    )::text
    from private.update_profile_identity(
      '30000000-0000-4000-8000-000000000006',
      1,
      'Pessoa Dona Atualizada',
      '+5541991112233',
      false,
      null,
      false,
      null
    ) as profile
  ),
  true
);

select pg_catalog.set_config(
  'set_livre.test.admin_complete_version',
  (
    select profile.profile_version::text
    from private.complete_profile(
      '30000000-0000-4000-8000-000000000007',
      0,
      'individual',
      'Pessoa Administradora',
      '+5541992223344',
      '52998224725',
      null
    ) as profile
  ),
  true
);

select pg_catalog.set_config(
  'set_livre.test.admin_dal_result',
  (
    select pg_catalog.jsonb_build_object(
      'userId', profile.user_id,
      'colorScheme', profile.color_scheme,
      'profileVersion', profile.profile_version,
      'preferencesVersion', profile.preferences_version
    )::text
    from private.update_profile_appearance(
      '30000000-0000-4000-8000-000000000007',
      0,
      'dark'
    ) as profile
  ),
  true
);

reset role;
grant app_dal to postgres with inherit false, set false;

-- authenticated não possui USAGE em private, portanto o nome qualificado não
-- pode ser resolvido sob essa role. Os OIDs são congelados antes da troca para
-- provar o EXECUTE efetivo sem transformar a própria introspecção em acesso.
select pg_catalog.set_config(
  'set_livre.test.complete_profile_oid',
  pg_catalog.to_regprocedure(
    'private.complete_profile(uuid,bigint,text,text,text,text,text)'
  )::pg_catalog.oid::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.update_profile_identity_oid',
  pg_catalog.to_regprocedure(
    'private.update_profile_identity(uuid,bigint,text,text,boolean,text,boolean,text)'
  )::pg_catalog.oid::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.update_profile_appearance_oid',
  pg_catalog.to_regprocedure(
    'private.update_profile_appearance(uuid,bigint,text)'
  )::pg_catalog.oid::text,
  true
);

select is(
  pg_catalog.current_setting('set_livre.test.owner_complete_version'),
  '1',
  'app_dal conclui perfil da persona owner pelo boundary autorizado'
);

select is(
  pg_catalog.current_setting('set_livre.test.owner_dal_result')::jsonb,
  '{
    "userId": "30000000-0000-4000-8000-000000000006",
    "name": "Pessoa Dona Atualizada",
    "profileVersion": 2,
    "preferencesVersion": 0
  }'::jsonb,
  'app_dal atualiza identidade owner sem ampliar a versão de aparência'
);

select is(
  pg_catalog.current_setting('set_livre.test.admin_complete_version'),
  '1',
  'app_dal conclui perfil da persona admin pelo boundary autorizado'
);

select is(
  pg_catalog.current_setting('set_livre.test.admin_dal_result')::jsonb,
  '{
    "userId": "30000000-0000-4000-8000-000000000007",
    "colorScheme": "dark",
    "profileVersion": 1,
    "preferencesVersion": 1
  }'::jsonb,
  'app_dal atualiza aparência admin sem ampliar a versão de identidade'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000006',
  true
);
select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', '30000000-0000-4000-8000-000000000006',
    'role', 'authenticated',
    'app_metadata', (
      select auth_user.raw_app_meta_data
      from auth.users as auth_user
      where auth_user.id = '30000000-0000-4000-8000-000000000006'
    )
  )::text,
  true
);

set local role authenticated;

select pg_catalog.set_config(
  'set_livre.test.owner_rls',
  pg_catalog.jsonb_build_object(
    'persona',
      pg_catalog.current_setting('request.jwt.claims')::jsonb
        #>> '{app_metadata,set_livre_test_persona}',
    'authUid', auth.uid(),
    'profiles', (
      select pg_catalog.jsonb_build_object(
        'count', pg_catalog.count(profile.id),
        'ownsAll', coalesce(
          pg_catalog.bool_and(
            profile.id = '30000000-0000-4000-8000-000000000006'
          ),
          false
        )
      )
      from public.profiles as profile
    ),
    'preferences', (
      select pg_catalog.jsonb_build_object(
        'count', pg_catalog.count(preference.user_id),
        'ownsAll', coalesce(
          pg_catalog.bool_and(
            preference.user_id = '30000000-0000-4000-8000-000000000006'
          ),
          false
        )
      )
      from public.user_preferences as preference
    ),
    'readModel', (
      select pg_catalog.jsonb_build_object(
        'count', pg_catalog.count(profile.user_id),
        'ownsAll', coalesce(
          pg_catalog.bool_and(
            profile.user_id = '30000000-0000-4000-8000-000000000006'
          ),
          false
        )
      )
      from public.get_my_profile() as profile
    )
  )::text,
  true
);

select pg_catalog.set_config(
  'set_livre.test.owner_command_boundary',
  pg_catalog.jsonb_build_object(
    'privateSchemaUsage', pg_catalog.has_schema_privilege(
      current_user,
      'private',
      'USAGE'
    ),
    'completeExecute', pg_catalog.has_function_privilege(
      current_user,
      pg_catalog.current_setting(
        'set_livre.test.complete_profile_oid'
      )::pg_catalog.oid,
      'EXECUTE'
    ),
    'identityExecute', pg_catalog.has_function_privilege(
      current_user,
      pg_catalog.current_setting(
        'set_livre.test.update_profile_identity_oid'
      )::pg_catalog.oid,
      'EXECUTE'
    ),
    'appearanceExecute', pg_catalog.has_function_privilege(
      current_user,
      pg_catalog.current_setting(
        'set_livre.test.update_profile_appearance_oid'
      )::pg_catalog.oid,
      'EXECUTE'
    ),
    'profileWrite', pg_catalog.has_table_privilege(
      current_user,
      'public.profiles',
      'INSERT,UPDATE,DELETE'
    ),
    'preferenceWrite', pg_catalog.has_table_privilege(
      current_user,
      'public.user_preferences',
      'INSERT,UPDATE,DELETE'
    )
  )::text,
  true
);

reset role;

select is(
  pg_catalog.current_setting('set_livre.test.owner_rls')::jsonb,
  '{
    "persona": "owner",
    "authUid": "30000000-0000-4000-8000-000000000006",
    "profiles": {"count": 1, "ownsAll": true},
    "preferences": {"count": 1, "ownsAll": true},
    "readModel": {"count": 1, "ownsAll": true}
  }'::jsonb,
  'owner lê perfil, preferência e read model próprios sem atravessar ownership'
);

select is(
  pg_catalog.current_setting(
    'set_livre.test.owner_command_boundary'
  )::jsonb,
  '{
    "privateSchemaUsage": false,
    "completeExecute": false,
    "identityExecute": false,
    "appearanceExecute": false,
    "profileWrite": false,
    "preferenceWrite": false
  }'::jsonb,
  'owner autenticado não contorna tabela nem comandos privados pela persona'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000007',
  true
);
select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', '30000000-0000-4000-8000-000000000007',
    'role', 'authenticated',
    'app_metadata', (
      select auth_user.raw_app_meta_data
      from auth.users as auth_user
      where auth_user.id = '30000000-0000-4000-8000-000000000007'
    )
  )::text,
  true
);

set local role authenticated;

select pg_catalog.set_config(
  'set_livre.test.admin_rls',
  pg_catalog.jsonb_build_object(
    'persona',
      pg_catalog.current_setting('request.jwt.claims')::jsonb
        #>> '{app_metadata,set_livre_test_persona}',
    'authUid', auth.uid(),
    'profiles', (
      select pg_catalog.jsonb_build_object(
        'count', pg_catalog.count(profile.id),
        'ownsAll', coalesce(
          pg_catalog.bool_and(
            profile.id = '30000000-0000-4000-8000-000000000007'
          ),
          false
        )
      )
      from public.profiles as profile
    ),
    'preferences', (
      select pg_catalog.jsonb_build_object(
        'count', pg_catalog.count(preference.user_id),
        'ownsAll', coalesce(
          pg_catalog.bool_and(
            preference.user_id = '30000000-0000-4000-8000-000000000007'
          ),
          false
        )
      )
      from public.user_preferences as preference
    ),
    'readModel', (
      select pg_catalog.jsonb_build_object(
        'count', pg_catalog.count(profile.user_id),
        'ownsAll', coalesce(
          pg_catalog.bool_and(
            profile.user_id = '30000000-0000-4000-8000-000000000007'
          ),
          false
        )
      )
      from public.get_my_profile() as profile
    )
  )::text,
  true
);

select pg_catalog.set_config(
  'set_livre.test.admin_command_boundary',
  pg_catalog.jsonb_build_object(
    'privateSchemaUsage', pg_catalog.has_schema_privilege(
      current_user,
      'private',
      'USAGE'
    ),
    'completeExecute', pg_catalog.has_function_privilege(
      current_user,
      pg_catalog.current_setting(
        'set_livre.test.complete_profile_oid'
      )::pg_catalog.oid,
      'EXECUTE'
    ),
    'identityExecute', pg_catalog.has_function_privilege(
      current_user,
      pg_catalog.current_setting(
        'set_livre.test.update_profile_identity_oid'
      )::pg_catalog.oid,
      'EXECUTE'
    ),
    'appearanceExecute', pg_catalog.has_function_privilege(
      current_user,
      pg_catalog.current_setting(
        'set_livre.test.update_profile_appearance_oid'
      )::pg_catalog.oid,
      'EXECUTE'
    ),
    'profileWrite', pg_catalog.has_table_privilege(
      current_user,
      'public.profiles',
      'INSERT,UPDATE,DELETE'
    ),
    'preferenceWrite', pg_catalog.has_table_privilege(
      current_user,
      'public.user_preferences',
      'INSERT,UPDATE,DELETE'
    )
  )::text,
  true
);

reset role;

select is(
  pg_catalog.current_setting('set_livre.test.admin_rls')::jsonb,
  '{
    "persona": "application_admin",
    "authUid": "30000000-0000-4000-8000-000000000007",
    "profiles": {"count": 1, "ownsAll": true},
    "preferences": {"count": 1, "ownsAll": true},
    "readModel": {"count": 1, "ownsAll": true}
  }'::jsonb,
  'admin de aplicação lê somente a própria conta na superfície FEAT-003'
);

select is(
  pg_catalog.current_setting(
    'set_livre.test.admin_command_boundary'
  )::jsonb,
  '{
    "privateSchemaUsage": false,
    "completeExecute": false,
    "identityExecute": false,
    "appearanceExecute": false,
    "profileWrite": false,
    "preferenceWrite": false
  }'::jsonb,
  'admin de aplicação não herda bypass RLS, escrita direta ou execute DAL'
);

select pg_catalog.set_config('request.jwt.claims', '', true);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000001',
  true
);

insert into feat003_results
select 'before-complete', profile.*
from public.get_my_profile() as profile;

select ok(
  (
    select not result.profile_completed
      and result.name is null
      and result.tax_id_masked is null
      and result.profile_version = 0
      and result.preferences_version = 0
    from feat003_results as result
    where result.label = 'before-complete'
  ),
  'read model representa perfil incompleto sem documento'
);

select matches(
  private.feat003_capture_error(
    $command$
      update public.profiles
      set name = 'Estado Parcial'
      where id = '30000000-0000-4000-8000-000000000001'
    $command$
  ),
  '23514:.*profiles_completion_data_check.*',
  'constraint impede persistência parcial antes da conclusão'
);

select is(
  private.feat003_capture_error(
    $command$
      update public.profiles
      set person_type = 'company'
      where id = '30000000-0000-4000-8000-000000000001'
    $command$
  ),
  'P0001:profile_person_type_change_requires_completion',
  'PF/PJ não muda isoladamente antes da conclusão'
);

insert into feat003_results
select 'complete-a', profile.*
from private.complete_profile(
  '30000000-0000-4000-8000-000000000001',
  0,
  'individual',
  'Pessoa de Teste',
  '+5541991234567',
  '28001238938',
  'RG-123456'
) as profile;

select ok(
  (
    select result.profile_completed
      and result.person_type = 'individual'
      and result.tax_id_masked = '***.***.***-38'
      and pg_catalog.right(result.additional_document_masked, 2) = '56'
      and result.additional_document_masked !~ 'RG|1234'
      and result.profile_version = 1
      and result.preferences_version = 0
    from feat003_results as result
    where result.label = 'complete-a'
  ),
  'conclusão PF retorna máscaras e incrementa só profile_version'
);

insert into feat003_results
select 'complete-a-retry', profile.*
from private.complete_profile(
  '30000000-0000-4000-8000-000000000001',
  0,
  'individual',
  'Pessoa de Teste',
  '+5541991234567',
  '28001238938',
  'RG-123456'
) as profile;

select is(
  (
    select result.profile_version
    from feat003_results as result
    where result.label = 'complete-a-retry'
  ),
  1::bigint,
  'retry idêntico de complete é idempotente'
);

select is(
  private.feat003_capture_error(
    $command$
      select *
      from private.complete_profile(
        '30000000-0000-4000-8000-000000000001',
        0,
        'individual',
        'Payload Divergente',
        '+5541991234567',
        '28001238938',
        'RG-123456'
      )
    $command$
  ),
  '40001:profile_already_completed',
  'retry divergente de complete retorna conflito serializável'
);

insert into feat003_results
select 'update-a', profile.*
from private.update_profile_identity(
  '30000000-0000-4000-8000-000000000001',
  1,
  'Pessoa Atualizada',
  '+5541987654321',
  false,
  null,
  false,
  null
) as profile;

select ok(
  (
    select result.profile_version = 2
      and result.preferences_version = 0
      and result.tax_id_masked = '***.***.***-38'
      and pg_catalog.right(result.additional_document_masked, 2) = '56'
    from feat003_results as result
    where result.label = 'update-a'
  ),
  'edição preserva PII não reenviada e não toca aparência'
);

insert into feat003_results
select 'update-a-retry', profile.*
from private.update_profile_identity(
  '30000000-0000-4000-8000-000000000001',
  1,
  'Pessoa Atualizada',
  '+5541987654321',
  false,
  null,
  false,
  null
) as profile;

select is(
  (
    select result.profile_version
    from feat003_results as result
    where result.label = 'update-a-retry'
  ),
  2::bigint,
  'retry idêntico de identity update não incrementa'
);

select is(
  private.feat003_capture_error(
    $command$
      select *
      from private.update_profile_identity(
        '30000000-0000-4000-8000-000000000001',
        1,
        'Outra Pessoa',
        '+5541987654321',
        false,
        null,
        false,
        null
      )
    $command$
  ),
  '40001:profile_version_conflict',
  'versão antiga com alvo divergente retorna conflito'
);

insert into feat003_results
select 'replace-documents-a', profile.*
from private.update_profile_identity(
  '30000000-0000-4000-8000-000000000001',
  2,
  'Pessoa Atualizada',
  '+5541987654321',
  true,
  '52998224725',
  true,
  null
) as profile;

select ok(
  (
    select result.profile_version = 3
      and result.tax_id_masked = '***.***.***-25'
      and result.additional_document_masked is null
    from feat003_results as result
    where result.label = 'replace-documents-a'
  ),
  'substituição explícita troca CPF e limpa documento adicional'
);

select is(
  private.feat003_capture_error(
    $command$
      update public.profiles
      set person_type = 'company', tax_id = '12ABC34501DE35'
      where id = '30000000-0000-4000-8000-000000000001'
    $command$
  ),
  'P0001:profile_person_type_change_requires_completion',
  'PF/PJ fica imutável depois da conclusão'
);

insert into feat003_results
select 'appearance-a', profile.*
from private.update_profile_appearance(
  '30000000-0000-4000-8000-000000000001',
  0,
  'dark'
) as profile;

select ok(
  (
    select result.color_scheme = 'dark'
      and result.preferences_version = 1
      and result.profile_version = 3
    from feat003_results as result
    where result.label = 'appearance-a'
  ),
  'aparência incrementa preferences_version sem tocar identidade'
);

insert into feat003_results
select 'appearance-a-retry', profile.*
from private.update_profile_appearance(
  '30000000-0000-4000-8000-000000000001',
  0,
  'dark'
) as profile;

select is(
  (
    select result.preferences_version
    from feat003_results as result
    where result.label = 'appearance-a-retry'
  ),
  1::bigint,
  'retry idêntico de aparência não incrementa'
);

select is(
  private.feat003_capture_error(
    $command$
      select *
      from private.update_profile_appearance(
        '30000000-0000-4000-8000-000000000001',
        0,
        'light'
      )
    $command$
  ),
  '40001:preferences_version_conflict',
  'aparência divergente com versão antiga retorna conflito'
);

select is(
  private.feat003_capture_error(
    $command$
      select *
      from private.complete_profile(
        '30000000-0000-4000-8000-000000000002',
        0,
        'company',
        'Empresa de Teste',
        '+554132345678',
        '28001238938',
        null
      )
    $command$
  ),
  '22023:invalid_profile_input',
  'tipo PJ rejeita CPF antes de mutação'
);

insert into feat003_results
select 'complete-b-company', profile.*
from private.complete_profile(
  '30000000-0000-4000-8000-000000000002',
  0,
  'company',
  'Empresa de Teste',
  '+554132345678',
  '12ABC34501DE35',
  'REG-AB/123'
) as profile;

select ok(
  (
    select result.person_type = 'company'
      and result.tax_id_masked = '**.***.***/****-35'
      and result.profile_version = 1
      and result.profile_completed
    from feat003_results as result
    where result.label = 'complete-b-company'
  ),
  'complete corrige PF para PJ e mascara CNPJ alfanumérico'
);

update public.profiles
set status = 'suspended'
where id = '30000000-0000-4000-8000-000000000003';

select is(
  private.feat003_capture_error(
    $command$
      select *
      from private.complete_profile(
        '30000000-0000-4000-8000-000000000003',
        1,
        'individual',
        'Pessoa Suspensa',
        '+5541991234567',
        '28001238938',
        null
      )
    $command$
  ),
  '42501:profile_inactive',
  'perfil suspenso não conclui dados pessoais'
);

alter table public.terms_acceptances
  disable trigger terms_acceptances_protect_immutability;
delete from public.terms_acceptances
where user_id = '30000000-0000-4000-8000-000000000004';
alter table public.terms_acceptances
  enable trigger terms_acceptances_protect_immutability;

select is(
  private.feat003_capture_error(
    $command$
      select *
      from private.complete_profile(
        '30000000-0000-4000-8000-000000000004',
        0,
        'individual',
        'Sem Aceite',
        '+5541991234567',
        '28001238938',
        null
      )
    $command$
  ),
  'P0001:profile_legal_acceptances_missing',
  'complete falha fechado sem os dois aceites preexistentes'
);

delete from auth.users
where id = '30000000-0000-4000-8000-000000000005';

select ok(
  not exists (
    select 1 from public.profiles
    where id = '30000000-0000-4000-8000-000000000005'
  )
    and not exists (
      select 1 from public.user_preferences
      where user_id = '30000000-0000-4000-8000-000000000005'
    )
    and not exists (
      select 1 from public.terms_acceptances
      where user_id = '30000000-0000-4000-8000-000000000005'
    ),
  'exclusão Auth cascateia perfil, preferência e aceites'
);

select is(
  private.feat003_capture_error(
    $command$
      select *
      from private.complete_profile(
        '30000000-0000-4000-8000-000000000004',
        0,
        'individual',
        'Telefone Inválido',
        '+5500123',
        '28001238938',
        null
      )
    $command$
  ),
  '22023:invalid_profile_input',
  'telefone fora da estrutura E.164 brasileira é rejeitado'
);

select is(
  private.feat003_capture_error(
    $command$
      select *
      from private.complete_profile(
        '30000000-0000-4000-8000-000000000004',
        0,
        'individual',
        'Documento Inválido',
        '+5541991234567',
        '28001238938',
        'rg--1'
      )
    $command$
  ),
  '22023:invalid_profile_input',
  'documento adicional rejeita lowercase e separadores consecutivos'
);

select ok(
  (
    select pg_catalog.array_agg(argument.argument_name order by argument.ordinality)
      = array[
        'user_id', 'person_type', 'status', 'name', 'phone_e164',
        'tax_id_masked', 'additional_document_masked', 'profile_completed',
        'profile_version', 'color_scheme', 'preferences_version'
      ]::text[]
    from pg_catalog.pg_proc as routine
    cross join lateral pg_catalog.unnest(
      routine.proargnames
    ) with ordinality as argument(argument_name, ordinality)
    where routine.oid = 'public.get_my_profile()'::pg_catalog.regprocedure
      and routine.proargmodes[argument.ordinality::integer] = 't'
  ),
  'RPC público expõe somente o shape seguro e mascarado congelado'
);

create extension if not exists dblink with schema extensions;

do $block$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat003_same_a',
    'feat003_same_b',
    'feat003_divergent_a',
    'feat003_divergent_b'
  ]
  loop
    perform extensions.dblink_connect(
      connection_name,
      pg_catalog.format(
        'host=%s port=%s dbname=%I user=%I password=%s',
        pg_catalog.inet_server_addr(),
        pg_catalog.inet_server_port(),
        pg_catalog.current_database(),
        'supabase_admin',
        'postgres'
      )
    );
  end loop;

  perform extensions.dblink_send_query(
    'feat003_same_a',
    $remote$
      select profile_version
      from private.complete_profile(
        '39000000-0000-4000-8000-000000000001',
        0,
        'individual',
        'Concorrência Igual',
        '+5541991234567',
        '28001238938',
        null
      )
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat003_same_b',
    $remote$
      select profile_version
      from private.complete_profile(
        '39000000-0000-4000-8000-000000000001',
        0,
        'individual',
        'Concorrência Igual',
        '+5541991234567',
        '28001238938',
        null
      )
    $remote$
  );
end;
$block$;

do $block$
begin
  begin
    insert into feat003_concurrency_results (label, profile_version)
    select 'same-a', result.profile_version
    from extensions.dblink_get_result(
      'feat003_same_a'
    ) as result(profile_version bigint);
  exception when others then
    insert into feat003_concurrency_results (label, error_message)
    values ('same-a', sqlstate || ':' || sqlerrm);
  end;

  begin
    insert into feat003_concurrency_results (label, profile_version)
    select 'same-b', result.profile_version
    from extensions.dblink_get_result(
      'feat003_same_b'
    ) as result(profile_version bigint);
  exception when others then
    insert into feat003_concurrency_results (label, error_message)
    values ('same-b', sqlstate || ':' || sqlerrm);
  end;
end;
$block$;

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(result.profile_version = 1)
      and pg_catalog.bool_and(result.error_message is null)
    from feat003_concurrency_results as result
    where result.label in ('same-a', 'same-b')
  )
    and (
      select profile.profile_version = 1
      from public.profiles as profile
      where profile.id = '39000000-0000-4000-8000-000000000001'
    ),
  'conclusões concorrentes idênticas convergem em um incremento'
);

do $block$
begin
  perform extensions.dblink_send_query(
    'feat003_divergent_a',
    $remote$
      select profile_version
      from private.complete_profile(
        '39000000-0000-4000-8000-000000000002',
        0,
        'individual',
        'Concorrência A',
        '+5541991234567',
        '28001238938',
        null
      )
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat003_divergent_b',
    $remote$
      select profile_version
      from private.complete_profile(
        '39000000-0000-4000-8000-000000000002',
        0,
        'individual',
        'Concorrência B',
        '+5541991234567',
        '28001238938',
        null
      )
    $remote$
  );
end;
$block$;

do $block$
begin
  begin
    insert into feat003_concurrency_results (label, profile_version)
    select 'divergent-a', result.profile_version
    from extensions.dblink_get_result(
      'feat003_divergent_a'
    ) as result(profile_version bigint);
  exception when others then
    insert into feat003_concurrency_results (label, error_message)
    values ('divergent-a', sqlstate || ':' || sqlerrm);
  end;

  begin
    insert into feat003_concurrency_results (label, profile_version)
    select 'divergent-b', result.profile_version
    from extensions.dblink_get_result(
      'feat003_divergent_b'
    ) as result(profile_version bigint);
  exception when others then
    insert into feat003_concurrency_results (label, error_message)
    values ('divergent-b', sqlstate || ':' || sqlerrm);
  end;
end;
$block$;

select ok(
  (
    select pg_catalog.count(*) filter (
        where result.profile_version = 1 and result.error_message is null
      ) = 1
      and pg_catalog.count(*) filter (
        where result.profile_version is null
          and result.error_message = '40001:profile_already_completed'
      ) = 1
    from feat003_concurrency_results as result
    where result.label in ('divergent-a', 'divergent-b')
  )
    and (
      select profile.profile_version = 1
      from public.profiles as profile
      where profile.id = '39000000-0000-4000-8000-000000000002'
    ),
  'conclusões concorrentes divergentes dão um vencedor e um conflito'
);

do $block$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat003_same_a',
    'feat003_same_b',
    'feat003_divergent_a',
    'feat003_divergent_b'
  ]
  loop
    perform extensions.dblink_disconnect(connection_name);
  end loop;
end;
$block$;

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_proc as routine
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    join pg_catalog.pg_roles as role on role.oid = privilege.grantee
    where role.rolname = 'app_dal'
      and privilege.privilege_type = 'EXECUTE'
      and not privilege.is_grantable
  ),
  16,
  'manifesto app_dal possui dezesseis grants de rotina'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_shdepend as dependency
    join pg_catalog.pg_roles as role on role.oid = dependency.refobjid
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.deptype = 'a'
      and role.rolname = 'app_dal'
  ),
  17,
  'manifesto app_dal possui dezessete dependências ACL'
);

select ok(
  private.check_readiness('20260812000100'),
  'readiness permanece verde na head FEAT-003'
);

create function private.feat003_readiness_probe()
returns boolean
language sql
stable
set search_path = ''
as $function$
  select true;
$function$;
revoke all on function private.feat003_readiness_probe()
  from public, anon, authenticated, service_role, app_dal;
grant execute on function private.feat003_readiness_probe()
  to app_dal;

select ok(
  not private.check_readiness('20260812000100'),
  'readiness falha fechado com rotina DAL fora da allowlist'
);

revoke all on function private.feat003_readiness_probe()
  from app_dal;

select ok(
  private.check_readiness('20260812000100'),
  'readiness recupera ao remover grant DAL indevido'
);

select * from finish();

rollback;

delete from auth.users
where id in (
  '39000000-0000-4000-8000-000000000001',
  '39000000-0000-4000-8000-000000000002'
);
