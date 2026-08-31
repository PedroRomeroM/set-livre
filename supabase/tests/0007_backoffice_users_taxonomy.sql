-- FEAT-031: usuários, papéis, sessões curtas e taxonomias do backoffice.

begin;

create function private.feat031_capture_error(command text)
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

create function private.feat031_create_user(
  user_id uuid,
  email_address text,
  display_name text,
  phone_number text,
  tax_id text,
  request_suffix integer,
  activate_as_owner boolean default false
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
    'individual',
    (
      '83000000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
    '{}'::jsonb
  );

  insert into auth.users (
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
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

  perform private.complete_profile(
    user_id,
    0,
    'individual',
    display_name,
    phone_number,
    tax_id,
    null
  );

  if activate_as_owner then
    perform private.activate_owner(
      user_id,
      '00000000-0000-4000-8000-000000000204',
      (
        '84000000-0000-4000-8000-'
        || pg_catalog.lpad(request_suffix::text, 12, '0')
      )::uuid,
      (
        '85000000-0000-4000-8000-'
        || pg_catalog.lpad(request_suffix::text, 12, '0')
      )::uuid,
      null
    );
  end if;
end;
$function$;

revoke all on function private.feat031_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat031_create_user(
  uuid, text, text, text, text, integer, boolean
) from public, anon, authenticated, service_role, app_dal;

select plan(57);

select has_table('public', 'platform_roles', 'papéis da plataforma existem');
select has_table('private', 'backoffice_sessions', 'bindings curtas do backoffice existem');
select has_table(
  'private',
  'backoffice_command_requests',
  'ledger administrativo existe'
);
select has_column('public', 'profiles', 'account_version', 'status da conta possui versão própria');
select ok(
  pg_catalog.to_regprocedure(
    'private.set_backoffice_taxonomy_active(uuid,uuid,timestamptz,text,uuid,bigint,boolean,uuid,uuid)'
  ) is null,
  'função legada de status escolhido pelo cliente foi removida'
);
select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'studio_types'
      and column_name = 'taxonomy_version'
  )
  and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tags'
      and column_name = 'taxonomy_version'
  )
  and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'amenities'
      and column_name = 'taxonomy_version'
  ),
  'as três taxonomias possuem versão otimista'
);
select ok(
  not exists (
    select 1
    from (
      values
        ('public'::text, 'platform_roles'::text),
        ('private'::text, 'backoffice_sessions'::text),
        ('private'::text, 'backoffice_command_requests'::text)
    ) as expected(schema_name, table_name)
    join pg_catalog.pg_namespace as namespace on namespace.nspname = expected.schema_name
    join pg_catalog.pg_class as relation
      on relation.relnamespace = namespace.oid
      and relation.relname = expected.table_name
    where not relation.relrowsecurity
      or exists (
        select 1
        from pg_catalog.pg_policy as policy
        where policy.polrelid = relation.oid
      )
  ),
  'tabelas administrativas usam RLS fechado sem policies públicas'
);
select ok(
  not exists (
    select 1
    from (
      values
        ('public.platform_roles'::text),
        ('private.backoffice_sessions'::text),
        ('private.backoffice_command_requests'::text)
    ) as protected_table(signature)
    cross join (
      values
        ('anon'::name),
        ('authenticated'::name),
        ('service_role'::name),
        ('app_dal'::name)
    ) as runtime_role(role_name)
    where pg_catalog.has_table_privilege(
      runtime_role.role_name,
      protected_table.signature,
      'SELECT,INSERT,UPDATE,DELETE'
    )
  )
  and not pg_catalog.has_function_privilege(
    'app_dal',
    'private.bootstrap_first_platform_admin(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'app_dal',
    'private.backoffice_session_context(uuid,uuid,timestamptz,text,boolean,boolean)',
    'EXECUTE'
  )
  and not exists (
    select 1
    from (
      values
        ('anon'::name),
        ('authenticated'::name),
        ('service_role'::name)
    ) as forbidden_role(role_name)
    cross join (
      values
        ('private.open_backoffice_session(uuid,uuid,timestamptz)'),
        ('private.get_backoffice_session(uuid,uuid,timestamptz)'),
        ('private.close_backoffice_session(uuid,uuid)'),
        ('private.list_backoffice_users(uuid,uuid,timestamptz,text,timestamptz,uuid,integer)'),
        ('private.get_backoffice_user_access(uuid,uuid,timestamptz,uuid)'),
        ('private.list_backoffice_taxonomies(uuid,uuid,timestamptz)'),
        ('private.set_backoffice_user_status(uuid,uuid,timestamptz,uuid,bigint,text,uuid,uuid)'),
        ('private.reveal_backoffice_user_pii(uuid,uuid,timestamptz,uuid,text,uuid,uuid)'),
        ('private.set_backoffice_user_role(uuid,uuid,timestamptz,uuid,bigint,text,uuid,uuid)'),
        ('private.upsert_backoffice_taxonomy(uuid,uuid,timestamptz,text,uuid,bigint,text,text,integer,uuid,uuid)'),
        ('private.transition_backoffice_taxonomy(uuid,uuid,timestamptz,text,uuid,bigint,text,uuid,uuid)')
    ) as entrypoint(signature)
    where pg_catalog.has_function_privilege(
      forbidden_role.role_name,
      entrypoint.signature,
      'EXECUTE'
    )
  )
  and not exists (
    select 1
    from (
      values
        ('private.open_backoffice_session(uuid,uuid,timestamptz)'),
        ('private.get_backoffice_session(uuid,uuid,timestamptz)'),
        ('private.close_backoffice_session(uuid,uuid)'),
        ('private.list_backoffice_users(uuid,uuid,timestamptz,text,timestamptz,uuid,integer)'),
        ('private.get_backoffice_user_access(uuid,uuid,timestamptz,uuid)'),
        ('private.list_backoffice_taxonomies(uuid,uuid,timestamptz)'),
        ('private.set_backoffice_user_status(uuid,uuid,timestamptz,uuid,bigint,text,uuid,uuid)'),
        ('private.reveal_backoffice_user_pii(uuid,uuid,timestamptz,uuid,text,uuid,uuid)'),
        ('private.set_backoffice_user_role(uuid,uuid,timestamptz,uuid,bigint,text,uuid,uuid)'),
        ('private.upsert_backoffice_taxonomy(uuid,uuid,timestamptz,text,uuid,bigint,text,text,integer,uuid,uuid)'),
        ('private.transition_backoffice_taxonomy(uuid,uuid,timestamptz,text,uuid,bigint,text,uuid,uuid)')
    ) as entrypoint(signature)
    where not pg_catalog.has_function_privilege('app_dal', entrypoint.signature, 'EXECUTE')
  ),
  'app_dal executa somente as onze fachadas administrativas e nunca lê tabelas diretamente'
);

select private.feat031_create_user(
  '81000000-0000-4000-8000-000000000001',
  'qa-feat031-admin-a@setlivre.local',
  'Admin A FEAT 031',
  '+5541999993101',
  '52998224725',
  1
);
select private.feat031_create_user(
  '81000000-0000-4000-8000-000000000002',
  'qa-feat031-support@setlivre.local',
  'Support FEAT 031',
  '+5541999993102',
  '11144477735',
  2
);
select private.feat031_create_user(
  '81000000-0000-4000-8000-000000000003',
  'qa-feat031-owner@setlivre.local',
  'Owner FEAT 031',
  '+5541999993103',
  '28001238938',
  3,
  true
);
select private.feat031_create_user(
  '81000000-0000-4000-8000-000000000004',
  'qa-feat031-regular@setlivre.local',
  'Regular FEAT 031',
  '+5541999993104',
  '16899535009',
  4
);
select private.feat031_create_user(
  '81000000-0000-4000-8000-000000000005',
  'qa-feat031-admin-b@setlivre.local',
  'Admin B FEAT 031',
  '+5541999993105',
  '39053344705',
  5
);

insert into auth.sessions (id, user_id, created_at, updated_at, aal)
values
  (
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '82000000-0000-4000-8000-000000000002',
    '81000000-0000-4000-8000-000000000002',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '82000000-0000-4000-8000-000000000003',
    '81000000-0000-4000-8000-000000000003',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '82000000-0000-4000-8000-000000000004',
    '81000000-0000-4000-8000-000000000004',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '82000000-0000-4000-8000-000000000005',
    '81000000-0000-4000-8000-000000000005',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  );

select pg_catalog.set_config(
  'set_livre.test.f031_bootstrap',
  private.bootstrap_first_platform_admin(
    '81000000-0000-4000-8000-000000000001',
    '86000000-0000-4000-8000-000000000001',
    '87000000-0000-4000-8000-000000000001'
  )::text,
  true
);
select ok(
  pg_catalog.current_setting('set_livre.test.f031_bootstrap')::jsonb
    @> '{"accountVersion":1}'::jsonb
    and not (
      pg_catalog.current_setting('set_livre.test.f031_bootstrap')::jsonb ? 'name'
    )
    and not (
      pg_catalog.current_setting('set_livre.test.f031_bootstrap')::jsonb ? 'roles'
    ),
  'bootstrap cria o primeiro admin e devolve resumo sem nome ou papel'
);
select private.bootstrap_first_platform_admin(
  '81000000-0000-4000-8000-000000000001',
  '86000000-0000-4000-8000-000000000099',
  '87000000-0000-4000-8000-000000000001'
);
select ok(
  (select pg_catalog.count(*) = 1 from public.platform_roles)
    and (
      select pg_catalog.count(*) = 1
      from audit.events
      where action = 'backoffice.admin_bootstrapped'
    ),
  'replay do bootstrap não duplica papel nem auditoria'
);
select matches(
  private.feat031_capture_error(
    $command$
      select private.bootstrap_first_platform_admin(
        '81000000-0000-4000-8000-000000000005',
        '86000000-0000-4000-8000-000000000002',
        '87000000-0000-4000-8000-000000000002'
      )
    $command$
  ),
  '^42501:backoffice_admin_bootstrap_unavailable$',
  'bootstrap fecha permanentemente depois do primeiro papel'
);
select matches(
  private.feat031_capture_error(
    $command$
      select * from private.open_backoffice_session(
        '81000000-0000-4000-8000-000000000004',
        '82000000-0000-4000-8000-000000000004',
        pg_catalog.clock_timestamp() + interval '30 minutes'
      )
    $command$
  ),
  '^42501:backoffice_role_required$',
  'usuário comum não abre sessão de backoffice'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f031_admin_session',
  (
    select pg_catalog.to_jsonb(session_result)::text
    from private.open_backoffice_session(
      '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      pg_catalog.clock_timestamp() + interval '30 minutes'
    ) as session_result
  ),
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_admin_session')::jsonb
    @> '{"scope":"81000000-0000-4000-8000-000000000001","roles":["admin"]}'::jsonb,
  'admin abre binding curto vinculado ao session_id Auth'
);

update private.backoffice_sessions as session_binding
set
  opened_at = shifted.observed_at,
  last_seen_at = shifted.observed_at,
  absolute_expires_at = shifted.observed_at + interval '1 hour'
from (
  select pg_catalog.clock_timestamp() + interval '1 second' as observed_at
) as shifted
where session_binding.auth_session_id = '82000000-0000-4000-8000-000000000001';
set local role app_dal;
select * from private.list_backoffice_users(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() + interval '30 minutes',
  null,
  null,
  null,
  1
);
reset role;
select ok(
  (
    select session_binding.last_seen_at >= session_binding.opened_at
    from private.backoffice_sessions as session_binding
    where session_binding.auth_session_id = '82000000-0000-4000-8000-000000000001'
  ),
  'atividade preserva o relógio lógico monotônico da sessão'
);
set local role app_dal;
select private.close_backoffice_session(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001'
);
reset role;
select ok(
  (
    select session_binding.closed_at >= session_binding.last_seen_at
    from private.backoffice_sessions as session_binding
    where session_binding.auth_session_id = '82000000-0000-4000-8000-000000000001'
  ),
  'encerramento preserva a ordem temporal da sessão'
);
set local role app_dal;
select * from private.open_backoffice_session(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
reset role;

update private.backoffice_sessions
set
  opened_at = pg_catalog.clock_timestamp() - interval '32 minutes',
  last_seen_at = pg_catalog.clock_timestamp() - interval '31 minutes'
where auth_session_id = '82000000-0000-4000-8000-000000000001';
select matches(
  private.feat031_capture_error(
    $command$
      select * from private.get_backoffice_session(
        '81000000-0000-4000-8000-000000000001',
        '82000000-0000-4000-8000-000000000001',
        pg_catalog.clock_timestamp() + interval '30 minutes'
      )
    $command$
  ),
  '^42501:backoffice_session_expired$',
  'trinta minutos de inatividade expiram a binding'
);

set local role app_dal;
select * from private.open_backoffice_session(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
reset role;
update private.backoffice_sessions
set
  opened_at = pg_catalog.clock_timestamp() - interval '6 minutes',
  last_seen_at = pg_catalog.clock_timestamp(),
  absolute_expires_at = pg_catalog.clock_timestamp() + interval '1 hour'
where auth_session_id = '82000000-0000-4000-8000-000000000001';
select matches(
  private.feat031_capture_error(
    $command$
      select private.set_backoffice_user_role(
        '81000000-0000-4000-8000-000000000001',
        '82000000-0000-4000-8000-000000000001',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        '81000000-0000-4000-8000-000000000002',
        0,
        'backoffice.access.grantSupport',
        '87000000-0000-4000-8000-000000000003',
        '86000000-0000-4000-8000-000000000003'
      )
    $command$
  ),
  '^42501:backoffice_reauthentication_required$',
  'mudança de papel exige login recente no backoffice'
);

set local role app_dal;
select * from private.open_backoffice_session(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
select pg_catalog.set_config(
  'set_livre.test.f031_support_role',
  private.set_backoffice_user_role(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    '81000000-0000-4000-8000-000000000002',
    0,
    'backoffice.access.grantSupport',
    '87000000-0000-4000-8000-000000000004',
    '86000000-0000-4000-8000-000000000004'
  )::text,
  true
);
select * from private.open_backoffice_session(
  '81000000-0000-4000-8000-000000000002',
  '82000000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_support_role')::jsonb
    @> '{"accountVersion":1}'::jsonb
    and not (pg_catalog.current_setting('set_livre.test.f031_support_role')::jsonb ? 'roles')
    and exists (
      select 1 from public.platform_roles
      where user_id = '81000000-0000-4000-8000-000000000002'
        and role = 'support'
    ),
  'admin recente concede support sem devolver papel no resultado do browser'
);
select ok(
  exists (
    select 1
    from private.backoffice_sessions
    where auth_session_id = '82000000-0000-4000-8000-000000000002'
      and closed_at is null
  ),
  'support abre a própria sessão depois da concessão'
);
select matches(
  private.feat031_capture_error(
    $command$
      select private.set_backoffice_user_role(
        '81000000-0000-4000-8000-000000000002',
        '82000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        '81000000-0000-4000-8000-000000000004',
        0,
        'backoffice.access.grantSupport',
        '87000000-0000-4000-8000-000000000005',
        '86000000-0000-4000-8000-000000000005'
      )
    $command$
  ),
  '^42501:backoffice_role_required$',
  'support nunca concede papéis'
);
select matches(
  private.feat031_capture_error(
    $command$
      select private.set_backoffice_user_status(
        '81000000-0000-4000-8000-000000000001',
        '82000000-0000-4000-8000-000000000001',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        '81000000-0000-4000-8000-000000000001',
        1,
        'backoffice.user.suspend',
        '87000000-0000-4000-8000-000000000006',
        '86000000-0000-4000-8000-000000000006'
      )
    $command$
  ),
  '^23514:backoffice_last_active_admin_required$',
  'último admin ativo não pode suspender a si mesmo'
);
select matches(
  private.feat031_capture_error(
    $command$
      select private.set_backoffice_user_role(
        '81000000-0000-4000-8000-000000000001',
        '82000000-0000-4000-8000-000000000001',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        '81000000-0000-4000-8000-000000000001',
        1,
        'backoffice.access.revokeAdmin',
        '87000000-0000-4000-8000-000000000007',
        '86000000-0000-4000-8000-000000000007'
      )
    $command$
  ),
  '^23514:backoffice_last_active_admin_required$',
  'último admin ativo não pode revogar o próprio papel'
);

set local role app_dal;
select private.set_backoffice_user_role(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() + interval '30 minutes',
  '81000000-0000-4000-8000-000000000005',
  0,
  'backoffice.access.grantAdmin',
  '87000000-0000-4000-8000-000000000008',
  '86000000-0000-4000-8000-000000000008'
);
select pg_catalog.set_config(
  'set_livre.test.f031_admin_b_session',
  (
    select pg_catalog.to_jsonb(session_result)::text
    from private.open_backoffice_session(
      '81000000-0000-4000-8000-000000000005',
      '82000000-0000-4000-8000-000000000005',
      pg_catalog.clock_timestamp() + interval '30 minutes'
    ) as session_result
  ),
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_admin_b_session')::jsonb
    @> '{"authorization_version":1,"roles":["admin"]}'::jsonb,
  'segundo admin recebe papel e abre sessão independente'
);

update private.backoffice_sessions
set last_seen_at = opened_at
where auth_session_id = '82000000-0000-4000-8000-000000000001';
select pg_catalog.set_config(
  'set_livre.test.f031_passive_last_seen',
  (
    select last_seen_at::text
    from private.backoffice_sessions
    where auth_session_id = '82000000-0000-4000-8000-000000000001'
  ),
  true
);
set local role app_dal;
select * from private.get_backoffice_session(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
reset role;
select is(
  (
    select last_seen_at::text
    from private.backoffice_sessions
    where auth_session_id = '82000000-0000-4000-8000-000000000001'
  ),
  pg_catalog.current_setting('set_livre.test.f031_passive_last_seen'),
  'revalidação passiva da sessão não renova o limite de inatividade'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f031_admin_b_access',
  (
    select pg_catalog.to_jsonb(access_result)::text
    from private.get_backoffice_user_access(
      '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      '81000000-0000-4000-8000-000000000005'
    ) as access_result
  ),
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_admin_b_access')::jsonb
    @> '{"account_version":1,"roles":["admin"]}'::jsonb,
  'somente a leitura server-side de acesso expõe papéis ao admin'
);
select matches(
  private.feat031_capture_error(
    $command$
      select * from private.get_backoffice_user_access(
        '81000000-0000-4000-8000-000000000002',
        '82000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        '81000000-0000-4000-8000-000000000005'
      )
    $command$
  ),
  '^42501:backoffice_role_required$',
  'support não lê a composição de papéis de outra conta'
);

select ok(
  (
    select pg_catalog.count(*) = 5
      and pg_catalog.bool_and(email_masked like '%***@%')
      and pg_catalog.bool_and(email_masked not like 'qa-feat031-%')
      and pg_catalog.bool_and(not (pg_catalog.to_jsonb(listed_user) ? 'roles'))
    from private.list_backoffice_users(
      '81000000-0000-4000-8000-000000000002',
      '82000000-0000-4000-8000-000000000002',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      'qa-feat031-',
      null,
      null,
      51
    ) as listed_user
  ),
  'busca server-side retorna as cinco personas mascaradas sem papéis no contrato do browser'
);
select ok(
  (
    with first_page as materialized (
      select *
      from private.list_backoffice_users(
        '81000000-0000-4000-8000-000000000002',
        '82000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        null,
        null,
        null,
        2
      )
    ),
    cursor_row as (
      select created_at, id
      from first_page
      order by created_at asc, id asc
      limit 1
    ),
    second_page as materialized (
      select *
      from private.list_backoffice_users(
        '81000000-0000-4000-8000-000000000002',
        '82000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        null,
        (select created_at from cursor_row),
        (select id from cursor_row),
        2
      )
    )
    select pg_catalog.count(*) = 2
      and not exists (
        select 1
        from first_page
        join second_page using (id)
      )
    from second_page
  ),
  'paginação keyset avança sem repetir usuários'
);
select matches(
  private.feat031_capture_error(
    $command$
      select private.reveal_backoffice_user_pii(
        '81000000-0000-4000-8000-000000000002',
        '82000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        '81000000-0000-4000-8000-000000000003',
        'curiosity',
        '87000000-0000-4000-8000-000000000009',
        '86000000-0000-4000-8000-000000000009'
      )
    $command$
  ),
  '^22023:invalid_backoffice_pii_reveal$',
  'PII exige motivo controlado'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f031_pii',
  private.reveal_backoffice_user_pii(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    '81000000-0000-4000-8000-000000000003',
    'support_case',
    '87000000-0000-4000-8000-000000000010',
    '86000000-0000-4000-8000-000000000010'
  )::text,
  true
);
select private.reveal_backoffice_user_pii(
  '81000000-0000-4000-8000-000000000002',
  '82000000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp() + interval '30 minutes',
  '81000000-0000-4000-8000-000000000003',
  'support_case',
  '87000000-0000-4000-8000-000000000010',
  '86000000-0000-4000-8000-000000000099'
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_pii')::jsonb
    @> '{"email":"qa-feat031-owner@setlivre.local","taxId":"28001238938","scope":"81000000-0000-4000-8000-000000000002"}'::jsonb,
  'support recebe PII efêmera vinculada ao próprio escopo'
);
select ok(
  (
    select result_hash is null
      and result_profile_version = 1
      and result_auth_updated_at is not null
      and payload_hash !~ '28001238938|qa-feat031-owner'
    from private.backoffice_command_requests
    where actor_user_id = '81000000-0000-4000-8000-000000000002'
      and idempotency_key = '87000000-0000-4000-8000-000000000010'
  )
  and (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(metadata = '{"reason":"support_case"}'::jsonb)
    from audit.events
    where action = 'backoffice.user_pii_revealed'
      and target_id = '81000000-0000-4000-8000-000000000003'
  ),
  'ledger e auditoria guardam versões e motivo, nunca PII ou hash reutilizável'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from audit.events
    where action = 'backoffice.user_pii_revealed'
      and idempotency_key = '87000000-0000-4000-8000-000000000010'
  ),
  1,
  'replay de PII não duplica auditoria'
);

set local role app_dal;
select * from private.update_profile_identity(
  '81000000-0000-4000-8000-000000000003',
  1,
  'Owner Atualizado FEAT 031',
  '+5541999993103',
  false,
  null,
  false,
  null
);
reset role;
select matches(
  private.feat031_capture_error(
    $command$
      select private.reveal_backoffice_user_pii(
        '81000000-0000-4000-8000-000000000002',
        '82000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        '81000000-0000-4000-8000-000000000003',
        'support_case',
        '87000000-0000-4000-8000-000000000010',
        '86000000-0000-4000-8000-000000000098'
      )
    $command$
  ),
  '^40001:backoffice_pii_result_stale$',
  'replay de PII falha fechado depois de mudança na identidade'
);

select matches(
  private.feat031_capture_error(
    $command$
      select *
      from private.list_backoffice_taxonomies(
        '81000000-0000-4000-8000-000000000002',
        '82000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes'
      )
    $command$
  ),
  '^42501:backoffice_role_required$',
  'support não lê o catálogo administrativo de taxonomias'
);
select matches(
  private.feat031_capture_error(
    $command$
      select private.upsert_backoffice_taxonomy(
        '81000000-0000-4000-8000-000000000002',
        '82000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        'tag', null, null, 'negada-feat031', 'Negada FEAT 031', 90,
        '87000000-0000-4000-8000-000000000091',
        '86000000-0000-4000-8000-000000000091'
      )
    $command$
  ),
  '^42501:backoffice_role_required$',
  'support não cria nem altera taxonomias'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f031_tag',
  private.upsert_backoffice_taxonomy(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    'tag',
    null,
    null,
    'ensaio-feat031',
    'Ensaio FEAT 031',
    91,
    '87000000-0000-4000-8000-000000000011',
    '86000000-0000-4000-8000-000000000011'
  )::text,
  true
);
select private.upsert_backoffice_taxonomy(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() + interval '30 minutes',
  'tag',
  null,
  null,
  'ensaio-feat031',
  'Ensaio FEAT 031',
  91,
  '87000000-0000-4000-8000-000000000011',
  '86000000-0000-4000-8000-000000000097'
);
reset role;
select ok(
  (pg_catalog.current_setting('set_livre.test.f031_tag')::jsonb ->> 'version')::bigint = 0
    and (
      select pg_catalog.count(*) = 1
      from audit.events
      where action = 'backoffice.taxonomy_created'
        and idempotency_key = '87000000-0000-4000-8000-000000000011'
    ),
  'criação de taxonomia é versionada e idempotente'
);
select pg_catalog.set_config(
  'set_livre.test.f031_tag_id',
  pg_catalog.current_setting('set_livre.test.f031_tag')::jsonb ->> 'id',
  true
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f031_tag_edited',
  private.upsert_backoffice_taxonomy(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    'tag',
    pg_catalog.current_setting('set_livre.test.f031_tag_id')::uuid,
    0,
    'ensaio-fotografico-feat031',
    'Ensaio fotográfico FEAT 031',
    92,
    '87000000-0000-4000-8000-000000000012',
    '86000000-0000-4000-8000-000000000012'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_tag_edited')::jsonb
    @> '{"slug":"ensaio-fotografico-feat031","version":1}'::jsonb,
  'edição incrementa a versão da taxonomia uma vez'
);
select matches(
  private.feat031_capture_error(pg_catalog.format(
    $command$
      select private.upsert_backoffice_taxonomy(
        '81000000-0000-4000-8000-000000000001',
        '82000000-0000-4000-8000-000000000001',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        'tag', %L, 0, 'stale-feat031', 'Stale FEAT 031', 93,
        '87000000-0000-4000-8000-000000000013',
        '86000000-0000-4000-8000-000000000013'
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f031_tag_id')
  )),
  '^40001:backoffice_taxonomy_version_conflict$',
  'edição stale é rejeitada por versão otimista'
);
select matches(
  private.feat031_capture_error(
    $command$
      select private.upsert_backoffice_taxonomy(
        '81000000-0000-4000-8000-000000000001',
        '82000000-0000-4000-8000-000000000001',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        'tag', null, null,
        'ensaio-fotografico-feat031', 'Slug duplicado FEAT 031', 94,
        '87000000-0000-4000-8000-000000000014',
        '86000000-0000-4000-8000-000000000014'
      )
    $command$
  ),
  '^23505:',
  'slug permanece único dentro da taxonomia'
);

set local role app_dal;
with editor as (
  select private.create_studio(
    '81000000-0000-4000-8000-000000000003',
    '87000000-0000-4000-8000-000000000015',
    '86000000-0000-4000-8000-000000000015',
    'Estúdio histórico FEAT 031',
    'Estúdio criado para comprovar arquivamento sem apagar o histórico.',
    'Rua da História',
    '31',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    8,
    '60000000-0000-4000-8000-000000000001'
  ) as value
)
select
  pg_catalog.set_config('set_livre.test.f031_studio', value ->> 'studioId', true),
  pg_catalog.set_config('set_livre.test.f031_revision', value #>> '{revision,id}', true)
from editor;
select private.update_studio_revision_taxonomy(
  '81000000-0000-4000-8000-000000000003',
  pg_catalog.current_setting('set_livre.test.f031_studio')::uuid,
  pg_catalog.current_setting('set_livre.test.f031_revision')::uuid,
  1,
  '87000000-0000-4000-8000-000000000016',
  '86000000-0000-4000-8000-000000000016',
  array[pg_catalog.current_setting('set_livre.test.f031_tag_id')::uuid],
  array['63000000-0000-4000-8000-000000000001']::uuid[]
);
reset role;
select matches(
  private.feat031_capture_error(
    pg_catalog.format(
      $command$
        select private.transition_backoffice_taxonomy(
          '81000000-0000-4000-8000-000000000001',
          '82000000-0000-4000-8000-000000000001',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          'tag', %L, 1, 'backoffice.taxonomy.setActive',
          '87000000-0000-4000-8000-000000000019',
          '86000000-0000-4000-8000-000000000019'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f031_tag_id')
    )
  ),
  '^22023:invalid_backoffice_taxonomy_transition$',
  'função privada rejeita o comando legado em vez de aceitar estado escolhido pelo cliente'
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f031_tag_archived',
  private.transition_backoffice_taxonomy(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    'tag',
    pg_catalog.current_setting('set_livre.test.f031_tag_id')::uuid,
    1,
    'backoffice.taxonomy.archive',
    '87000000-0000-4000-8000-000000000017',
    '86000000-0000-4000-8000-000000000017'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f031_tag_archived_replay',
  private.transition_backoffice_taxonomy(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    'tag',
    pg_catalog.current_setting('set_livre.test.f031_tag_id')::uuid,
    1,
    'backoffice.taxonomy.archive',
    '87000000-0000-4000-8000-000000000017',
    '86000000-0000-4000-8000-000000000097'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_tag_archived_replay')::jsonb
    = pg_catalog.current_setting('set_livre.test.f031_tag_archived')::jsonb
  and (
    select pg_catalog.count(*) = 1
    from audit.events
    where action = 'backoffice.taxonomy_archived'
      and idempotency_key = '87000000-0000-4000-8000-000000000017'
  ),
  'replay de arquivamento devolve o mesmo resultado sem repetir versão ou auditoria'
);
select matches(
  private.feat031_capture_error(
    pg_catalog.format(
      $command$
        select private.transition_backoffice_taxonomy(
          '81000000-0000-4000-8000-000000000001',
          '82000000-0000-4000-8000-000000000001',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          'tag', %L, 1, 'backoffice.taxonomy.reactivate',
          '87000000-0000-4000-8000-000000000017',
          '86000000-0000-4000-8000-000000000098'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f031_tag_id')
    )
  ),
  '^40001:backoffice_idempotency_conflict$',
  'a mesma chave não pode trocar arquivamento por reativação'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f031_tag_archived')::jsonb
    @> '{"active":false,"usageCount":1,"version":2}'::jsonb
    and exists (
      select 1
      from public.studio_revision_tags
      where revision_id = pg_catalog.current_setting('set_livre.test.f031_revision')::uuid
        and tag_id = pg_catalog.current_setting('set_livre.test.f031_tag_id')::uuid
    ),
  'arquivamento mostra impacto e preserva a referência histórica'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '81000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;
select ok(
  exists (
    select 1
    from public.tags
    where id = pg_catalog.current_setting('set_livre.test.f031_tag_id')::uuid
      and not active
  )
  and not (
    public.list_active_studio_taxonomies() -> 'tags'
      @> pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'id',
          pg_catalog.current_setting('set_livre.test.f031_tag_id')
        )
      )
  ),
  'dono lê a referência arquivada, mas novas seleções não a recebem'
);
reset role;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f031_tag_reactivated',
  private.transition_backoffice_taxonomy(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    'tag',
    pg_catalog.current_setting('set_livre.test.f031_tag_id')::uuid,
    2,
    'backoffice.taxonomy.reactivate',
    '87000000-0000-4000-8000-000000000018',
    '86000000-0000-4000-8000-000000000018'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_tag_reactivated')::jsonb
    @> '{"active":true,"usageCount":1,"version":3}'::jsonb,
  'reativação mantém o impacto e incrementa a versão'
);
select ok(
  exists (
    select 1
    from private.list_backoffice_taxonomies(
      '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      pg_catalog.clock_timestamp() + interval '30 minutes'
    )
    where id = pg_catalog.current_setting('set_livre.test.f031_tag_id')::uuid
      and usage_count = 1
      and taxonomy_version = 3
  ),
  'read model privado entrega versão e impacto autoritativos'
);

with taxonomy_total as (
  select pg_catalog.count(*)::integer as value
  from (
    select studio_type.id from public.studio_types as studio_type
    union all
    select tag.id from public.tags as tag
    union all
    select amenity.id from public.amenities as amenity
  ) as taxonomy_item
)
insert into public.tags (id, slug, name, sort_order)
select
  extensions.gen_random_uuid(),
  'qa-capacidade-' || generated.index::text,
  'Capacidade QA ' || generated.index::text,
  (1000 + generated.index)::smallint
from taxonomy_total
cross join lateral pg_catalog.generate_series(1, 500 - taxonomy_total.value) as generated(index);

select matches(
  private.feat031_capture_error(
    $command$
      select private.upsert_backoffice_taxonomy(
        '81000000-0000-4000-8000-000000000001',
        '82000000-0000-4000-8000-000000000001',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        'tag', null, null, 'limite-feat031', 'Limite FEAT 031', 1501,
        '87000000-0000-4000-8000-000000000024',
        '86000000-0000-4000-8000-000000000024'
      )
    $command$
  ),
  '^23514:backoffice_taxonomy_capacity_reached$',
  'catálogo cheio rejeita nova taxonomia antes de ultrapassar 500 itens'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f031_tag_at_capacity',
  private.upsert_backoffice_taxonomy(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    'tag',
    pg_catalog.current_setting('set_livre.test.f031_tag_id')::uuid,
    3,
    'ensaio-atualizado-feat031',
    'Ensaio atualizado FEAT 031',
    93,
    '87000000-0000-4000-8000-000000000025',
    '86000000-0000-4000-8000-000000000025'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_tag_at_capacity')::jsonb
    @> '{"slug":"ensaio-atualizado-feat031","version":4}'::jsonb,
  'catálogo cheio continua permitindo atualizar um item existente'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f031_owner_suspended',
  private.set_backoffice_user_status(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    '81000000-0000-4000-8000-000000000003',
    0,
    'backoffice.user.suspend',
    '87000000-0000-4000-8000-000000000019',
    '86000000-0000-4000-8000-000000000019'
  )::text,
  true
);
select private.set_backoffice_user_status(
  '81000000-0000-4000-8000-000000000002',
  '82000000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp() + interval '30 minutes',
  '81000000-0000-4000-8000-000000000003',
  0,
  'backoffice.user.suspend',
  '87000000-0000-4000-8000-000000000019',
  '86000000-0000-4000-8000-000000000096'
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f031_owner_suspended')::jsonb
    @> '{"accountVersion":1,"status":"suspended"}'::jsonb
    and (
      select profile_version = 2 and account_version = 1
      from public.profiles
      where id = '81000000-0000-4000-8000-000000000003'
    ),
  'suspensão incrementa só accountVersion e preserva a versão da identidade'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from audit.events
    where action = 'backoffice.user_suspended'
      and idempotency_key = '87000000-0000-4000-8000-000000000019'
  ),
  1,
  'replay de suspensão não duplica efeito nem auditoria'
);
select matches(
  private.feat031_capture_error(
    $command$
      select private.create_studio(
        '81000000-0000-4000-8000-000000000003',
        '87000000-0000-4000-8000-000000000020',
        '86000000-0000-4000-8000-000000000020',
        'Bloqueado FEAT 031', 'Não deve persistir', 'Rua Bloqueada', '1', null,
        'Centro', 'Curitiba', 'PR', '80010000', 1,
        '60000000-0000-4000-8000-000000000001'
      )
    $command$
  ),
  '^42501:studio_owner_inactive$',
  'conta suspensa não executa comandos do produto'
);

set local role app_dal;
select private.set_backoffice_user_status(
  '81000000-0000-4000-8000-000000000002',
  '82000000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp() + interval '30 minutes',
  '81000000-0000-4000-8000-000000000003',
  1,
  'backoffice.user.restore',
  '87000000-0000-4000-8000-000000000021',
  '86000000-0000-4000-8000-000000000021'
);
reset role;
select ok(
  (
    select status = 'active' and account_version = 2 and profile_version = 2
    from public.profiles
    where id = '81000000-0000-4000-8000-000000000003'
  ),
  'restore preserva identidade e avança apenas a versão da conta'
);

set local role app_dal;
select private.set_backoffice_user_status(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() + interval '30 minutes',
  '81000000-0000-4000-8000-000000000002',
  1,
  'backoffice.user.suspend',
  '87000000-0000-4000-8000-000000000022',
  '86000000-0000-4000-8000-000000000022'
);
reset role;
select ok(
  (
    select account_version = 2 and profile_version = 1
    from public.profiles
    where id = '81000000-0000-4000-8000-000000000002'
  )
  and (
    select closed_at is not null
    from private.backoffice_sessions
    where auth_session_id = '82000000-0000-4000-8000-000000000002'
  ),
  'suspender operador fecha imediatamente sua binding sem alterar identidade'
);
select matches(
  private.feat031_capture_error(
    $command$
      select * from private.get_backoffice_session(
        '81000000-0000-4000-8000-000000000002',
        '82000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes'
      )
    $command$
  ),
  '^42501:backoffice_session_expired$',
  'binding encerrada não pode ser reutilizada'
);

set local role app_dal;
select private.set_backoffice_user_status(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() + interval '30 minutes',
  '81000000-0000-4000-8000-000000000002',
  2,
  'backoffice.user.restore',
  '87000000-0000-4000-8000-000000000023',
  '86000000-0000-4000-8000-000000000023'
);
reset role;
select ok(
  (
    select status = 'active' and account_version = 3 and profile_version = 1
    from public.profiles
    where id = '81000000-0000-4000-8000-000000000002'
  ),
  'admin restaura o operador sem reabrir silenciosamente a sessão'
);

select ok(
  not exists (
    select 1
    from audit.events as event
    where event.action like 'backoffice.%'
      and (
        event.metadata::text like '%qa-feat031-%@setlivre.local%'
        or event.metadata::text like '%28001238938%'
        or event.metadata::text like '%+5541999993103%'
      )
  ),
  'nenhum evento administrativo persiste PII em metadata'
);

reset role;
revoke app_dal from postgres granted by current_user;

select ok(
  private.check_readiness('20260830204500'),
  'readiness inclui a migration FEAT-031 e a allowlist DAL exata'
);

select * from finish();
rollback;
