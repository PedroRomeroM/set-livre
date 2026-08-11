-- A fixture de concorrência é criada em sessão dblink e, portanto, vive fora
-- da transação pgTAP. O preflight exato torna a suíte recuperável mesmo após
-- uma execução interrompida antes do cleanup final.
delete from auth.users
where id = '20000000-0000-4000-8000-000000000008';

begin;

create function private.feat002_capture_error(command text)
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

create function private.feat002_insert_auth_user(
  user_id uuid,
  email_address text,
  legal_intent text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
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
    pg_catalog.jsonb_build_object(
      'sl_legal_intent',
      legal_intent,
      'qaMarker',
      'preserved'
    ),
    pg_catalog.now(),
    pg_catalog.now()
  );
end;
$function$;

create function private.feat002_force_scrub_failure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.email = 'qa-feat002-rollback@setlivre.local' then
    raise exception using
      errcode = 'P0001',
      message = 'feat002_forced_scrub_failure';
  end if;

  return new;
end;
$function$;

revoke all on function private.feat002_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat002_insert_auth_user(uuid, text, text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat002_force_scrub_failure()
  from public, anon, authenticated, service_role, app_dal;

create temporary table feat002_test_state (
  label text primary key,
  token uuid not null,
  session_scope uuid,
  auth_session_id uuid,
  auth_expires_at timestamptz
) on commit drop;

create temporary table feat002_recovery_routines (
  signature text primary key
) on commit drop;

insert into feat002_recovery_routines (signature)
values
  ('private.issue_identity_recovery_context(uuid,uuid,timestamptz)'),
  ('private.inspect_identity_recovery_session(uuid,uuid,timestamptz,uuid,uuid)'),
  ('private.claim_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'),
  ('private.release_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'),
  ('private.consume_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'),
  ('private.close_identity_recovery_session(uuid,uuid)');

create temporary table feat002_recovery_outcomes (
  label text primary key,
  outcome boolean not null
) on commit drop;

select plan(78);

select ok(
  pg_catalog.to_regclass('public.profiles') is not null
    and pg_catalog.to_regclass('public.terms_versions') is not null
    and pg_catalog.to_regclass('public.terms_acceptances') is not null
    and pg_catalog.to_regclass('private.signup_legal_intents') is not null
    and pg_catalog.to_regclass('private.identity_recovery_grants') is not null
    and pg_catalog.to_regclass('private.identity_recovery_sessions') is not null,
  'as seis relações canônicas da identidade e legal-core existem'
);

select ok(
  (
    select pg_catalog.count(*) = 3
      and pg_catalog.bool_and(relation.relrowsecurity)
    from pg_catalog.pg_class as relation
    where relation.oid in (
      'public.profiles'::pg_catalog.regclass,
      'public.terms_versions'::pg_catalog.regclass,
      'public.terms_acceptances'::pg_catalog.regclass
    )
  ),
  'todas as tabelas public da feature possuem RLS habilitada'
);

select ok(
  (
    select pg_catalog.count(*) = 3
    from pg_catalog.pg_policies as policy
    where policy.schemaname = 'public'
      and policy.policyname in (
        'profiles_select_own',
        'terms_versions_select_current',
        'terms_acceptances_select_own'
      )
      and policy.cmd = 'SELECT'
  ),
  'a feature publica somente as três policies de leitura esperadas'
);

select ok(
  not pg_catalog.has_table_privilege('anon', 'public.profiles', 'SELECT')
    and pg_catalog.has_column_privilege(
      'authenticated',
      'public.profiles',
      'id',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'authenticated',
      'public.profiles',
      'INSERT, UPDATE, DELETE'
    ),
  'profiles expõe apenas colunas próprias de leitura ao usuário autenticado'
);

select ok(
  pg_catalog.has_column_privilege(
    'anon',
    'public.terms_versions',
    'body_markdown',
    'SELECT'
  )
    and pg_catalog.has_column_privilege(
      'anon',
      'public.terms_versions',
      'source',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'anon',
      'public.terms_versions',
      'INSERT, UPDATE, DELETE'
    ),
  'visitante lê o contrato jurídico vigente sem receber escrita'
);

select ok(
  pg_catalog.has_column_privilege(
    'authenticated',
    'public.terms_acceptances',
    'accepted_at',
    'SELECT'
  )
    and not pg_catalog.has_table_privilege(
      'authenticated',
      'public.terms_acceptances',
      'INSERT, UPDATE, DELETE'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'public.terms_acceptances',
      'SELECT, INSERT, UPDATE, DELETE'
    ),
  'aceites não recebem escrita do browser nem acesso implícito de service_role'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('public'::name),
        ('anon'::name),
        ('authenticated'::name),
        ('service_role'::name),
        ('app_dal'::name)
    ) as monitored(role_name)
    cross join (
      values
        ('private.signup_legal_intents'::pg_catalog.regclass),
        ('private.identity_recovery_grants'::pg_catalog.regclass),
        ('private.identity_recovery_sessions'::pg_catalog.regclass)
    ) as private_relation(relation_oid)
    where pg_catalog.has_table_privilege(
      monitored.role_name,
      private_relation.relation_oid,
      'SELECT, INSERT, UPDATE, DELETE'
    )
  )
    and (
      select pg_catalog.count(*) = 3
        and pg_catalog.bool_and(private_relation.relrowsecurity)
      from pg_catalog.pg_class as private_relation
      where private_relation.oid in (
        'private.signup_legal_intents'::pg_catalog.regclass,
        'private.identity_recovery_grants'::pg_catalog.regclass,
        'private.identity_recovery_sessions'::pg_catalog.regclass
      )
    )
    and not exists (
      select 1
      from pg_catalog.pg_policies as policy
      where policy.schemaname = 'private'
        and policy.tablename in (
          'signup_legal_intents',
          'identity_recovery_grants',
          'identity_recovery_sessions'
        )
    ),
  'estados privados permanecem sem grants runtime e fechados por RLS sem policies'
);

select ok(
  pg_catalog.to_regclass(
    'private.signup_legal_intents_expires_at_idx'
  ) is not null
    and pg_catalog.to_regclass(
      'private.identity_recovery_grants_expires_at_idx'
    ) is not null
    and pg_catalog.to_regclass(
      'private.identity_recovery_sessions_retain_until_idx'
    ) is not null,
  'purges de tokens expirados possuem índices dedicados'
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(not routine.prosecdef)
      and pg_catalog.bool_and('search_path=""' = any(routine.proconfig))
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and routine.proname in (
        'get_current_legal_terms',
        'get_own_identity_context'
      )
  ),
  'read models públicos são security invoker com search_path vazio'
);

select ok(
  pg_catalog.has_function_privilege(
    'anon',
    'public.get_current_legal_terms()',
    'EXECUTE'
  )
    and not pg_catalog.has_function_privilege(
      'anon',
      'public.get_own_identity_context()',
      'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'authenticated',
      'public.get_own_identity_context()',
      'EXECUTE'
    ),
  'execução dos read models segue o público de cada intenção'
);

select ok(
  (
    select pg_catalog.count(*) = 7
      and pg_catalog.bool_and(routine.prosecdef)
      and pg_catalog.bool_and('search_path=""' = any(routine.proconfig))
    from pg_catalog.pg_proc as routine
    where routine.oid = pg_catalog.to_regprocedure(
        'private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)'
      )
      or routine.oid in (
        select pg_catalog.to_regprocedure(recovery_routine.signature)
        from feat002_recovery_routines as recovery_routine
      )
  ),
  'comandos privados de cadastro e recovery são security definer com search_path vazio'
);

select ok(
  pg_catalog.has_function_privilege(
    'app_dal',
    'private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)',
    'EXECUTE'
  )
    and not exists (
      select 1
      from feat002_recovery_routines as recovery_routine
      cross join (
        values
          ('public'::name),
          ('anon'::name),
          ('authenticated'::name),
          ('service_role'::name)
      ) as forbidden(role_name)
      where not pg_catalog.has_function_privilege(
          'app_dal',
          recovery_routine.signature,
          'EXECUTE'
        )
        or pg_catalog.has_function_privilege(
          forbidden.role_name,
          recovery_routine.signature,
          'EXECUTE'
        )
    )
    and not pg_catalog.has_function_privilege(
      'anon',
      'private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated',
      'private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'service_role',
      'private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)',
      'EXECUTE'
    ),
  'somente app_dal executa os comandos privados de cadastro e recovery'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('private.issue_identity_recovery_grant(uuid)'),
        ('private.has_identity_recovery_grant(uuid,uuid)'),
        ('private.claim_identity_recovery_grant(uuid,uuid,uuid)'),
        ('private.release_identity_recovery_grant(uuid,uuid,uuid)'),
        ('private.consume_identity_recovery_grant(uuid,uuid,uuid)')
    ) as legacy_routine(signature)
    where pg_catalog.has_function_privilege(
      'app_dal',
      legacy_routine.signature,
      'EXECUTE'
    )
  ),
  'assinaturas legadas sem binding perderam EXECUTE da DAL'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid = 'auth.users'::pg_catalog.regclass
      and trigger.tgname = 'set_livre_bootstrap_signup_identity'
      and trigger.tgenabled = 'O'
      and not trigger.tgisinternal
  ),
  'auth.users possui trigger explícito para bootstrap atômico'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.terms_versions
    where source = 'local_fixture'
      and retired_at is null
  ),
  2,
  'seed local possui exatamente termos e privacidade vigentes'
);

select ok(
  (
    select pg_catalog.bool_and(
      title like '%fixture local%'
      and body_markdown like '%Não constitui%'
      and source = 'local_fixture'
    )
    from public.terms_versions
    where retired_at is null
  ),
  'fixtures declaram no dado que não são conteúdo jurídico de produção'
);

select ok(
  (
    select pg_catalog.bool_and(
      content_hash = pg_catalog.encode(
        extensions.digest(body_markdown, 'sha256'::text),
        'hex'::text
      )
    )
    from public.terms_versions
  ),
  'hash SHA-256 é derivado do conteúdo jurídico no banco'
);

insert into public.terms_versions (
  id,
  kind,
  version,
  title,
  body_markdown,
  source,
  effective_at,
  retired_at
)
values (
  '00000000-0000-4000-8000-000000000203',
  'terms',
  'historical-test-2025',
  'Termos históricos — fixture local',
  'Fixture histórica exclusiva do teste de vigência.',
  'local_fixture',
  '2025-01-01 00:00:00+00',
  '2025-02-01 00:00:00+00'
);

select is(
  private.feat002_capture_error(
    $command$
      select private.create_signup_legal_intent(
        '00000000-0000-4000-8000-000000000201',
        '00000000-0000-4000-8000-000000000202',
        'individual',
        '10000000-0000-4000-8000-000000000001',
        '{"unexpected":true}'::jsonb
      )
    $command$
  ),
  '22023:invalid_signup_legal_intent',
  'comando recusa chave de evidência não contratada'
);

select is(
  private.feat002_capture_error(
    $command$
      select private.create_signup_legal_intent(
        '00000000-0000-4000-8000-000000000201',
        '00000000-0000-4000-8000-000000000202',
        'individual',
        '10000000-0000-4000-8000-000000000002',
        '{"userAgentHash":"not-a-hash"}'::jsonb
      )
    $command$
  ),
  '22023:invalid_signup_legal_evidence',
  'comando recusa evidência que não é SHA-256 hexadecimal'
);

select is(
  private.feat002_capture_error(
    $command$
      select private.create_signup_legal_intent(
        '00000000-0000-4000-8000-000000000203',
        '00000000-0000-4000-8000-000000000202',
        'individual',
        '10000000-0000-4000-8000-000000000003',
        '{}'::jsonb
      )
    $command$
  ),
  '23514:signup_legal_terms_stale',
  'comando usa SQLSTATE estável para versão jurídica não vigente'
);

select pg_catalog.set_config(
  'set_livre.test.app_dal_token',
  private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'company',
    '10000000-0000-4000-8000-000000000004',
    '{"ipHash":null,"userAgentHash":null}'::jsonb
  )::text,
  true
);

select ok(
  pg_catalog.current_setting('set_livre.test.app_dal_token')
    ~ '^[0-9a-f-]{36}$',
  'comando autorizado cria token opaco sem serializar evidência no identificador'
);

insert into feat002_test_state (label, token)
select
  'retry',
  private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '10000000-0000-4000-8000-000000000005',
    '{"ipHash":null,"userAgentHash":null}'::jsonb
  );

select is(
  private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '10000000-0000-4000-8000-000000000005',
    '{"ipHash":null,"userAgentHash":null}'::jsonb
  ),
  (select token from feat002_test_state where label = 'retry'),
  'retry idêntico pelo mesmo request_id devolve o mesmo token'
);

create extension if not exists dblink with schema extensions;

do $block$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat002_intent_a',
    'feat002_intent_b'
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
    perform extensions.dblink_exec(connection_name, 'begin');
  end loop;
end;
$block$;

insert into feat002_test_state (label, token)
select 'concurrent-a', remote_result.token
from extensions.dblink(
  'feat002_intent_a',
  $remote$
    select private.create_signup_legal_intent(
      '00000000-0000-4000-8000-000000000201',
      '00000000-0000-4000-8000-000000000202',
      'individual',
      '10000000-0000-4000-8000-000000000012',
      '{}'::jsonb
    )
  $remote$
) as remote_result(token uuid);

do $block$
begin
  perform extensions.dblink_send_query(
    'feat002_intent_b',
    $remote$
      select private.create_signup_legal_intent(
        '00000000-0000-4000-8000-000000000201',
        '00000000-0000-4000-8000-000000000202',
        'individual',
        '10000000-0000-4000-8000-000000000012',
        '{}'::jsonb
      )
    $remote$
  );
  perform extensions.dblink_exec('feat002_intent_a', 'commit');
end;
$block$;

insert into feat002_test_state (label, token)
select 'concurrent-b', remote_result.token
from extensions.dblink_get_result(
  'feat002_intent_b'
) as remote_result(token uuid);

do $block$
begin
  perform 1
  from extensions.dblink_get_result(
    'feat002_intent_b'
  ) as drained_result(token uuid);
  perform extensions.dblink_exec('feat002_intent_b', 'commit');
  perform extensions.dblink_disconnect('feat002_intent_a');
  perform extensions.dblink_disconnect('feat002_intent_b');
end;
$block$;

select is(
  (select token from feat002_test_state where label = 'concurrent-b'),
  (select token from feat002_test_state where label = 'concurrent-a'),
  'duas transações concorrentes convergem ao mesmo token idempotente'
);

select is(
  private.feat002_capture_error(
    $command$
      select private.create_signup_legal_intent(
        '00000000-0000-4000-8000-000000000201',
        '00000000-0000-4000-8000-000000000202',
        'company',
        '10000000-0000-4000-8000-000000000005',
        '{}'::jsonb
      )
    $command$
  ),
  'P0001:signup_legal_request_conflict',
  'mesmo request_id não pode alterar pessoa ou evidência'
);

select is(
  private.feat002_capture_error(
    $command$
      select private.feat002_insert_auth_user(
        '20000000-0000-4000-8000-000000000001',
        'qa-feat002-without-intent@setlivre.local',
        null
      )
    $command$
  ),
  'P0001:signup_legal_intent_required',
  'INSERT direto de auth.users sem intenção é abortado'
);

insert into feat002_test_state (label, token)
select
  'user-a',
  private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '10000000-0000-4000-8000-000000000006',
    '{"ipHash":null,"userAgentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb
  );

select private.feat002_insert_auth_user(
  '20000000-0000-4000-8000-000000000002',
  'qa-feat002-a@setlivre.local',
  (select token::text from feat002_test_state where label = 'user-a')
);

insert into feat002_test_state (label, token)
select
  'user-b',
  private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'company',
    '10000000-0000-4000-8000-000000000007',
    '{"ipHash":null,"userAgentHash":null}'::jsonb
  );

select private.feat002_insert_auth_user(
  '20000000-0000-4000-8000-000000000003',
  'qa-feat002-b@setlivre.local',
  (select token::text from feat002_test_state where label = 'user-b')
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(status = 'active')
      and pg_catalog.bool_and(completed_at is null)
      and pg_catalog.bool_or(person_type = 'individual')
      and pg_catalog.bool_or(person_type = 'company')
    from public.profiles
    where id in (
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003'
    )
  ),
  'bootstrap cria perfis PF/PJ ativos e ainda incompletos'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.terms_acceptances
    where user_id in (
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003'
    )
  ),
  4,
  'cada cadastro cria exatamente dois aceites legais'
);

select ok(
  not exists (
    select 1
    from public.terms_acceptances as acceptance
    join public.terms_versions as legal_version
      on legal_version.id = acceptance.terms_version_id
    where acceptance.accepted_content_hash <> legal_version.content_hash
  ),
  'todo aceite preserva o hash exato da versão aceita'
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(ip_hash is null)
      and pg_catalog.bool_and(
        user_agent_hash =
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    from public.terms_acceptances
    where user_id = '20000000-0000-4000-8000-000000000002'
  ),
  'evidência confiável é copiada e IP ausente permanece nulo'
);

select ok(
  not exists (
    select 1
    from private.signup_legal_intents as intent
    where intent.id in (
      (select token from feat002_test_state where label = 'user-a'),
      (select token from feat002_test_state where label = 'user-b')
    )
  ),
  'cadastro concluído remove atomicamente a intenção e sua evidência transitória'
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(
        not (
          coalesce(raw_user_meta_data, '{}'::jsonb)
            ? 'sl_legal_intent'
        )
      )
      and pg_catalog.bool_and(raw_user_meta_data ->> 'qaMarker' = 'preserved')
    from auth.users
    where id in (
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003'
    )
  ),
  'trigger remove o token consumido de user_metadata e preserva o fato privado'
);

insert into auth.sessions (id, user_id, created_at, updated_at, aal)
values
  (
    '50000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '50000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000002',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '50000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000002',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '50000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000003',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '50000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000003',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '50000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000003',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    '50000000-0000-4000-8000-000000000008',
    '20000000-0000-4000-8000-000000000003',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  );

insert into feat002_test_state (
  label,
  token,
  session_scope,
  auth_session_id
)
select
  'recovery-expired',
  recovery_context.grant_token,
  recovery_context.session_scope,
  '50000000-0000-4000-8000-000000000001'
from private.issue_identity_recovery_context(
  '20000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() + interval '30 minutes'
) as recovery_context;

update feat002_test_state
set auth_expires_at = pg_catalog.statement_timestamp() + interval '1 hour'
where label = 'recovery-expired';

insert into feat002_recovery_outcomes (label, outcome)
select
  'refresh-inspection',
  inspection.active and inspection.grant_allowed
from private.inspect_identity_recovery_session(
  '20000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001',
  (
    select auth_expires_at
    from feat002_test_state
    where label = 'recovery-expired'
  ),
  (select token from feat002_test_state where label = 'recovery-expired'),
  (select session_scope from feat002_test_state where label = 'recovery-expired')
) as inspection;

select ok(
  (select outcome from feat002_recovery_outcomes where label = 'refresh-inspection')
    and exists (
      select 1
      from private.identity_recovery_sessions as recovery_session
      where recovery_session.auth_session_id =
          '50000000-0000-4000-8000-000000000001'
        and recovery_session.auth_expires_at = (
          select auth_expires_at
          from feat002_test_state
          where label = 'recovery-expired'
        )
        and recovery_session.retain_until = (
          select auth_expires_at + interval '5 minutes'
          from feat002_test_state
          where label = 'recovery-expired'
        )
        and recovery_session.canonical_absence_observed_at is null
        and recovery_session.closed_at is null
        and recovery_session.session_scope = (
          select session_scope
          from feat002_test_state
          where label = 'recovery-expired'
        )
    )
    and exists (
      select 1
      from private.identity_recovery_grants
      where token = (
        select token
        from feat002_test_state
        where label = 'recovery-expired'
      )
    ),
  'refresh observado estende exp e retenção sem trocar scope, grant ou estado ativo'
);

select ok(
  exists (
    select 1
    from private.inspect_identity_recovery_session(
      '20000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp() + interval '1 hour',
      (select token from feat002_test_state where label = 'recovery-expired'),
      (select session_scope from feat002_test_state where label = 'recovery-expired')
    ) as inspection
    where inspection.active
      and inspection.grant_allowed
  )
    and not exists (
      select 1
      from private.inspect_identity_recovery_session(
        '20000000-0000-4000-8000-000000000003',
        '50000000-0000-4000-8000-000000000001',
        pg_catalog.statement_timestamp() + interval '1 hour',
        (select token from feat002_test_state where label = 'recovery-expired'),
        (select session_scope from feat002_test_state where label = 'recovery-expired')
      )
    )
    and not private.claim_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-expired'),
      '20000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000001',
      (select session_scope from feat002_test_state where label = 'recovery-expired'),
      '40000000-0000-4000-8000-000000000001'
    )
    and (
      select expires_at - issued_at = interval '15 minutes'
        and auth_session_id = '50000000-0000-4000-8000-000000000001'
      from private.identity_recovery_grants
      where token = (
        select token
        from feat002_test_state
        where label = 'recovery-expired'
      )
    )
    and (
      select session_scope <> auth_session_id
        and session_scope <> (
          select token
          from feat002_test_state
          where label = 'recovery-expired'
        )
      from private.identity_recovery_sessions
      where auth_session_id = '50000000-0000-4000-8000-000000000001'
    ),
  'binding usa session_id assinado, isola dois usuários e mantém scope opaco separado do grant'
);

select pg_catalog.set_config('app.settings.jwt_exp', '7200', true);

select is(
  private.feat002_capture_error(
    $command$
      select *
      from private.issue_identity_recovery_context(
        '20000000-0000-4000-8000-000000000003',
        '50000000-0000-4000-8000-000000000008',
        pg_catalog.statement_timestamp() + interval '2 hours'
      )
    $command$
  ),
  '55000:identity_recovery_jwt_expiry_not_pinned',
  'emissão falha fechada quando jwt_exp diverge de 3600 segundos'
);

select pg_catalog.set_config('app.settings.jwt_exp', '3600', true);

select private.claim_identity_recovery_context(
  (select token from feat002_test_state where label = 'recovery-expired'),
  '20000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001',
  (select session_scope from feat002_test_state where label = 'recovery-expired'),
  '40000000-0000-4000-8000-000000000001'
);

update private.identity_recovery_grants
set
  issued_at = pg_catalog.statement_timestamp() - interval '15 minutes 1 second',
  expires_at = pg_catalog.statement_timestamp() - interval '1 second',
  claimed_at = pg_catalog.statement_timestamp() - interval '5 minutes'
where token = (
  select token
  from feat002_test_state
  where label = 'recovery-expired'
);

select ok(
  exists (
    select 1
    from private.inspect_identity_recovery_session(
      '20000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp() + interval '1 hour',
      (select token from feat002_test_state where label = 'recovery-expired'),
      (select session_scope from feat002_test_state where label = 'recovery-expired')
    ) as inspection
    where inspection.active
      and not inspection.grant_allowed
  )
    and not private.release_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-expired'),
      '20000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001',
      (select session_scope from feat002_test_state where label = 'recovery-expired'),
      '40000000-0000-4000-8000-000000000001'
    )
    and exists (
      select 1
      from private.identity_recovery_sessions
      where auth_session_id = '50000000-0000-4000-8000-000000000001'
    ),
  'grant expirado perde autorização sem remover nem reclassificar o tombstone recovery'
);

insert into feat002_recovery_outcomes (label, outcome)
select
  'close-expired',
  private.close_identity_recovery_session(
    '20000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001'
  );

select ok(
  (select outcome from feat002_recovery_outcomes where label = 'close-expired')
    and exists (
      select 1
      from private.identity_recovery_sessions
      where auth_session_id = '50000000-0000-4000-8000-000000000001'
        and closed_at is not null
    )
    and not exists (
      select 1
      from private.identity_recovery_grants
      where auth_session_id = '50000000-0000-4000-8000-000000000001'
    ),
  'close remove o grant mas preserva a binding enquanto auth.sessions existe'
);

insert into feat002_test_state (
  label,
  token,
  session_scope,
  auth_session_id
)
select
  'recovery-consume',
  recovery_context.grant_token,
  recovery_context.session_scope,
  '50000000-0000-4000-8000-000000000002'
from private.issue_identity_recovery_context(
  '20000000-0000-4000-8000-000000000003',
  '50000000-0000-4000-8000-000000000002',
  pg_catalog.statement_timestamp() + interval '1 hour'
) as recovery_context;

insert into feat002_recovery_outcomes (label, outcome)
values
  (
    'claim-consume-a',
    private.claim_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-consume'),
      '20000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000002',
      (select session_scope from feat002_test_state where label = 'recovery-consume'),
      '40000000-0000-4000-8000-000000000002'
    )
  ),
  (
    'claim-consume-a-retry',
    private.claim_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-consume'),
      '20000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000002',
      (select session_scope from feat002_test_state where label = 'recovery-consume'),
      '40000000-0000-4000-8000-000000000002'
    )
  ),
  (
    'release-consume-a',
    private.release_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-consume'),
      '20000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000002',
      (select session_scope from feat002_test_state where label = 'recovery-consume'),
      '40000000-0000-4000-8000-000000000002'
    )
  ),
  (
    'claim-consume-b',
    private.claim_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-consume'),
      '20000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000002',
      (select session_scope from feat002_test_state where label = 'recovery-consume'),
      '40000000-0000-4000-8000-000000000003'
    )
  );

select ok(
  (select outcome from feat002_recovery_outcomes where label = 'claim-consume-a')
    and (select outcome from feat002_recovery_outcomes where label = 'claim-consume-a-retry')
    and (select outcome from feat002_recovery_outcomes where label = 'release-consume-a')
    and (select outcome from feat002_recovery_outcomes where label = 'claim-consume-b'),
  'claim é idempotente por tentativa e release comprovado permite um novo claim'
);

select ok(
  not private.consume_identity_recovery_context(
    (select token from feat002_test_state where label = 'recovery-consume'),
    '20000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000002',
    (select session_scope from feat002_test_state where label = 'recovery-consume'),
    '40000000-0000-4000-8000-000000000002'
  )
    and exists (
      select 1
      from private.identity_recovery_grants
      where auth_session_id = '50000000-0000-4000-8000-000000000002'
    ),
  'tentativa diferente não consome a reserva corrente'
);

insert into feat002_recovery_outcomes (label, outcome)
values
  (
    'consume-b',
    private.consume_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-consume'),
      '20000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000002',
      (select session_scope from feat002_test_state where label = 'recovery-consume'),
      '40000000-0000-4000-8000-000000000003'
    )
  ),
  (
    'consume-b-replay',
    private.consume_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-consume'),
      '20000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000002',
      (select session_scope from feat002_test_state where label = 'recovery-consume'),
      '40000000-0000-4000-8000-000000000003'
    )
  );

select ok(
  (select outcome from feat002_recovery_outcomes where label = 'consume-b')
    and not (
      select outcome
      from feat002_recovery_outcomes
      where label = 'consume-b-replay'
    )
    and not exists (
      select 1
      from private.identity_recovery_grants
      where auth_session_id = '50000000-0000-4000-8000-000000000002'
    )
    and exists (
      select 1
      from private.identity_recovery_sessions
      where auth_session_id = '50000000-0000-4000-8000-000000000002'
        and closed_at is null
    ),
  'consume é one-shot e preserva a binding recovery aberta para fechamento terminal'
);

insert into feat002_recovery_outcomes (label, outcome)
select
  'close-consumed',
  private.close_identity_recovery_session(
    '20000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000002'
  );

select ok(
  (select outcome from feat002_recovery_outcomes where label = 'close-consumed')
    and exists (
      select 1
      from private.identity_recovery_sessions
      where auth_session_id = '50000000-0000-4000-8000-000000000002'
        and closed_at is not null
    ),
  'fechamento posterior ao consume preserva o tombstone da sessão Auth'
);

insert into feat002_test_state (
  label,
  token,
  session_scope,
  auth_session_id
)
select
  'recovery-canonical-absence',
  recovery_context.grant_token,
  recovery_context.session_scope,
  '50000000-0000-4000-8000-000000000003'
from private.issue_identity_recovery_context(
  '20000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000003',
  pg_catalog.statement_timestamp() + interval '1 hour'
) as recovery_context;

delete from auth.sessions
where id = '50000000-0000-4000-8000-000000000003';

insert into feat002_recovery_outcomes (label, outcome)
select
  'canonical-absence-inspection',
  not inspection.active and not inspection.grant_allowed
from private.inspect_identity_recovery_session(
  '20000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000003',
  pg_catalog.statement_timestamp() + interval '1 hour',
  (select token from feat002_test_state where label = 'recovery-canonical-absence'),
  (
    select session_scope
    from feat002_test_state
    where label = 'recovery-canonical-absence'
  )
) as inspection;

select ok(
  (
    select outcome
    from feat002_recovery_outcomes
    where label = 'canonical-absence-inspection'
  )
    and exists (
      select 1
      from private.identity_recovery_sessions
      where auth_session_id = '50000000-0000-4000-8000-000000000003'
        and canonical_absence_observed_at is not null
        and retain_until >= canonical_absence_observed_at + interval '65 minutes'
        and closed_at is not null
    )
    and not exists (
      select 1
      from private.identity_recovery_grants
      where auth_session_id = '50000000-0000-4000-8000-000000000003'
    ),
  'inspect detecta ausência canônica, fecha, remove grant e inicia retenção de 65 minutos'
);

insert into feat002_test_state (
  label,
  token,
  session_scope,
  auth_session_id
)
select
  'recovery-gc-target',
  recovery_context.grant_token,
  recovery_context.session_scope,
  '50000000-0000-4000-8000-000000000004'
from private.issue_identity_recovery_context(
  '20000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000004',
  pg_catalog.statement_timestamp() + interval '1 hour'
) as recovery_context;

update private.identity_recovery_sessions
set
  bound_at = pg_catalog.statement_timestamp() - interval '2 hours',
  auth_expires_at = pg_catalog.statement_timestamp() - interval '70 minutes',
  retain_until = pg_catalog.statement_timestamp() - interval '65 minutes'
where auth_session_id = '50000000-0000-4000-8000-000000000004';

delete from auth.sessions
where id = '50000000-0000-4000-8000-000000000004';

insert into feat002_test_state (
  label,
  token,
  session_scope,
  auth_session_id
)
select
  'recovery-gc-driver-one',
  recovery_context.grant_token,
  recovery_context.session_scope,
  '50000000-0000-4000-8000-000000000005'
from private.issue_identity_recovery_context(
  '20000000-0000-4000-8000-000000000003',
  '50000000-0000-4000-8000-000000000005',
  pg_catalog.statement_timestamp() + interval '1 hour'
) as recovery_context;

select ok(
  exists (
    select 1
    from private.identity_recovery_sessions
    where auth_session_id = '50000000-0000-4000-8000-000000000004'
      and canonical_absence_observed_at is not null
      and retain_until >= canonical_absence_observed_at + interval '65 minutes'
      and closed_at is not null
  ),
  'primeiro purge apenas observa ausência e abre nova janela; nunca apaga o tombstone'
);

update private.identity_recovery_sessions
set
  bound_at = pg_catalog.statement_timestamp() - interval '2 hours',
  auth_expires_at = pg_catalog.statement_timestamp() - interval '70 minutes',
  retain_until = pg_catalog.statement_timestamp() - interval '65 minutes'
where auth_session_id = '50000000-0000-4000-8000-000000000005';

insert into feat002_test_state (
  label,
  token,
  session_scope,
  auth_session_id
)
select
  'recovery-gc-driver-two',
  recovery_context.grant_token,
  recovery_context.session_scope,
  '50000000-0000-4000-8000-000000000006'
from private.issue_identity_recovery_context(
  '20000000-0000-4000-8000-000000000003',
  '50000000-0000-4000-8000-000000000006',
  pg_catalog.statement_timestamp() + interval '1 hour'
) as recovery_context;

select ok(
  exists (
    select 1
    from private.identity_recovery_sessions
    where auth_session_id = '50000000-0000-4000-8000-000000000004'
  )
    and exists (
      select 1
      from private.identity_recovery_sessions
      where auth_session_id = '50000000-0000-4000-8000-000000000005'
        and canonical_absence_observed_at is null
    ),
  'purge antes de 65 minutos preserva ausente observado e nunca apaga sessão canônica presente'
);

update private.identity_recovery_sessions
set
  bound_at = pg_catalog.statement_timestamp() - interval '2 hours',
  auth_expires_at = pg_catalog.statement_timestamp() - interval '10 minutes',
  retain_until = pg_catalog.statement_timestamp() - interval '5 minutes',
  canonical_absence_observed_at =
    pg_catalog.statement_timestamp() - interval '70 minutes',
  closed_at = pg_catalog.statement_timestamp() - interval '70 minutes'
where auth_session_id = '50000000-0000-4000-8000-000000000004';

insert into feat002_test_state (
  label,
  token,
  session_scope,
  auth_session_id
)
select
  'recovery-gc-driver-three',
  recovery_context.grant_token,
  recovery_context.session_scope,
  '50000000-0000-4000-8000-000000000007'
from private.issue_identity_recovery_context(
  '20000000-0000-4000-8000-000000000003',
  '50000000-0000-4000-8000-000000000007',
  pg_catalog.statement_timestamp() + interval '1 hour'
) as recovery_context;

select ok(
  not exists (
    select 1
    from private.identity_recovery_sessions
    where auth_session_id = '50000000-0000-4000-8000-000000000004'
  ),
  'purge posterior remove somente tombstone ainda ausente após a janela completa'
);

do $block$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat002_recovery_a',
    'feat002_recovery_b'
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

  perform extensions.dblink_exec(
    'feat002_recovery_a',
    $remote$
      delete from auth.users
      where id = '20000000-0000-4000-8000-000000000008'
    $remote$
  );

  perform extensions.dblink_exec(
    'feat002_recovery_a',
    $remote$
      with legal_intent as materialized (
        select private.create_signup_legal_intent(
          '00000000-0000-4000-8000-000000000201',
          '00000000-0000-4000-8000-000000000202',
          'individual',
          '10000000-0000-4000-8000-000000000015',
          '{}'::jsonb
        ) as token
      ),
      inserted_user as (
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
        select
          '20000000-0000-4000-8000-000000000008',
          'authenticated',
          'authenticated',
          'qa-feat002-recovery-concurrency@setlivre.local',
          '',
          pg_catalog.now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          pg_catalog.jsonb_build_object(
            'sl_legal_intent',
            legal_intent.token::text
          ),
          pg_catalog.now(),
          pg_catalog.now()
        from legal_intent
        returning id
      )
      insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      select
        '50000000-0000-4000-8000-000000000009',
        inserted_user.id,
        pg_catalog.now(),
        pg_catalog.now(),
        'aal1'
      from inserted_user
    $remote$
  );
end;
$block$;

insert into feat002_test_state (
  label,
  token,
  session_scope,
  auth_session_id
)
select
  'recovery-concurrent',
  remote_result.grant_token,
  remote_result.session_scope,
  '50000000-0000-4000-8000-000000000009'
from extensions.dblink(
  'feat002_recovery_a',
  $remote$
    select grant_token, session_scope
    from private.issue_identity_recovery_context(
      '20000000-0000-4000-8000-000000000008',
      '50000000-0000-4000-8000-000000000009',
      pg_catalog.statement_timestamp() + interval '1 hour'
    )
  $remote$
) as remote_result(grant_token uuid, session_scope uuid);

do $block$
begin
  perform extensions.dblink_exec('feat002_recovery_a', 'begin');
end;
$block$;

insert into feat002_recovery_outcomes (label, outcome)
select 'claim-a', remote_result.outcome
from extensions.dblink(
  'feat002_recovery_a',
  pg_catalog.format(
    $remote$
      select private.claim_identity_recovery_context(
        %L::uuid,
        '20000000-0000-4000-8000-000000000008',
        '50000000-0000-4000-8000-000000000009',
        %L::uuid,
        '40000000-0000-4000-8000-000000000004'
      )
    $remote$,
    (select token::text from feat002_test_state where label = 'recovery-concurrent'),
    (
      select session_scope::text
      from feat002_test_state
      where label = 'recovery-concurrent'
    )
  )
) as remote_result(outcome boolean);

do $block$
declare
  recovery_scope uuid;
  recovery_token uuid;
begin
  select token, session_scope
  into strict recovery_token, recovery_scope
  from feat002_test_state
  where label = 'recovery-concurrent';

  perform extensions.dblink_send_query(
    'feat002_recovery_b',
    pg_catalog.format(
      $remote$
        select private.claim_identity_recovery_context(
          %L::uuid,
          '20000000-0000-4000-8000-000000000008',
          '50000000-0000-4000-8000-000000000009',
          %L::uuid,
          '40000000-0000-4000-8000-000000000005'
        )
      $remote$,
      recovery_token::text,
      recovery_scope::text
    )
  );
  perform extensions.dblink_exec('feat002_recovery_a', 'commit');
end;
$block$;

insert into feat002_recovery_outcomes (label, outcome)
select 'claim-b-while-a', remote_result.outcome
from extensions.dblink_get_result(
  'feat002_recovery_b'
) as remote_result(outcome boolean);

do $block$
begin
  perform 1
  from extensions.dblink_get_result(
    'feat002_recovery_b'
  ) as drained_result(outcome boolean);
end;
$block$;

select ok(
  (select outcome from feat002_recovery_outcomes where label = 'claim-a')
    and not (
      select outcome
      from feat002_recovery_outcomes
      where label = 'claim-b-while-a'
    ),
  'claim concorrente A vence e B perde após o lock da mesma sessão e grant'
);

insert into feat002_recovery_outcomes (label, outcome)
select 'release-a', remote_result.outcome
from extensions.dblink(
  'feat002_recovery_a',
  pg_catalog.format(
    $remote$
      select private.release_identity_recovery_context(
        %L::uuid,
        '20000000-0000-4000-8000-000000000008',
        '50000000-0000-4000-8000-000000000009',
        %L::uuid,
        '40000000-0000-4000-8000-000000000004'
      )
    $remote$,
    (select token::text from feat002_test_state where label = 'recovery-concurrent'),
    (
      select session_scope::text
      from feat002_test_state
      where label = 'recovery-concurrent'
    )
  )
) as remote_result(outcome boolean);

insert into feat002_recovery_outcomes (label, outcome)
select 'claim-b-after-release', remote_result.outcome
from extensions.dblink(
  'feat002_recovery_b',
  pg_catalog.format(
    $remote$
      select private.claim_identity_recovery_context(
        %L::uuid,
        '20000000-0000-4000-8000-000000000008',
        '50000000-0000-4000-8000-000000000009',
        %L::uuid,
        '40000000-0000-4000-8000-000000000005'
      )
    $remote$,
    (select token::text from feat002_test_state where label = 'recovery-concurrent'),
    (
      select session_scope::text
      from feat002_test_state
      where label = 'recovery-concurrent'
    )
  )
) as remote_result(outcome boolean);

insert into feat002_recovery_outcomes (label, outcome)
select 'claim-b-retry', remote_result.outcome
from extensions.dblink(
  'feat002_recovery_b',
  pg_catalog.format(
    $remote$
      select private.claim_identity_recovery_context(
        %L::uuid,
        '20000000-0000-4000-8000-000000000008',
        '50000000-0000-4000-8000-000000000009',
        %L::uuid,
        '40000000-0000-4000-8000-000000000005'
      )
    $remote$,
    (select token::text from feat002_test_state where label = 'recovery-concurrent'),
    (
      select session_scope::text
      from feat002_test_state
      where label = 'recovery-concurrent'
    )
  )
) as remote_result(outcome boolean);

select ok(
  (select outcome from feat002_recovery_outcomes where label = 'release-a')
    and (select outcome from feat002_recovery_outcomes where label = 'claim-b-after-release')
    and (select outcome from feat002_recovery_outcomes where label = 'claim-b-retry'),
  'release permite retry concorrente e a mesma tentativa permanece idempotente'
);

select ok(
  not private.consume_identity_recovery_context(
    (select token from feat002_test_state where label = 'recovery-concurrent'),
    '20000000-0000-4000-8000-000000000008',
    '50000000-0000-4000-8000-000000000009',
    (
      select session_scope
      from feat002_test_state
      where label = 'recovery-concurrent'
    ),
    '40000000-0000-4000-8000-000000000004'
  ),
  'consume concorrente com attempt_id vencido falha fechado'
);

insert into feat002_recovery_outcomes (label, outcome)
values
  (
    'consume-concurrent-b',
    private.consume_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-concurrent'),
      '20000000-0000-4000-8000-000000000008',
      '50000000-0000-4000-8000-000000000009',
      (
        select session_scope
        from feat002_test_state
        where label = 'recovery-concurrent'
      ),
      '40000000-0000-4000-8000-000000000005'
    )
  ),
  (
    'consume-concurrent-b-replay',
    private.consume_identity_recovery_context(
      (select token from feat002_test_state where label = 'recovery-concurrent'),
      '20000000-0000-4000-8000-000000000008',
      '50000000-0000-4000-8000-000000000009',
      (
        select session_scope
        from feat002_test_state
        where label = 'recovery-concurrent'
      ),
      '40000000-0000-4000-8000-000000000005'
    )
  );

select ok(
  (select outcome from feat002_recovery_outcomes where label = 'consume-concurrent-b')
    and not (
      select outcome
      from feat002_recovery_outcomes
      where label = 'consume-concurrent-b-replay'
    )
    and exists (
      select 1
      from private.identity_recovery_sessions
      where auth_session_id = '50000000-0000-4000-8000-000000000009'
    ),
  'consume concorrente é one-shot e mantém o tombstone da sessão'
);

do $block$
begin
  perform extensions.dblink_exec(
    'feat002_recovery_a',
    $remote$
      insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      values (
        '50000000-0000-4000-8000-000000000010',
        '20000000-0000-4000-8000-000000000008',
        pg_catalog.now(),
        pg_catalog.now(),
        'aal1'
      )
    $remote$
  );
end;
$block$;

insert into feat002_test_state (
  label,
  token,
  session_scope,
  auth_session_id
)
select
  'recovery-cascade',
  remote_result.grant_token,
  remote_result.session_scope,
  '50000000-0000-4000-8000-000000000010'
from extensions.dblink(
  'feat002_recovery_a',
  $remote$
    select grant_token, session_scope
    from private.issue_identity_recovery_context(
      '20000000-0000-4000-8000-000000000008',
      '50000000-0000-4000-8000-000000000010',
      pg_catalog.statement_timestamp() + interval '1 hour'
    )
  $remote$
) as remote_result(grant_token uuid, session_scope uuid);

delete from auth.users
where id = '20000000-0000-4000-8000-000000000008';

select ok(
  not exists (
    select 1
    from private.identity_recovery_sessions
    where user_id = '20000000-0000-4000-8000-000000000008'
  )
    and not exists (
      select 1
      from private.identity_recovery_grants
      where user_id = '20000000-0000-4000-8000-000000000008'
    ),
  'exclusão canônica do usuário remove bindings e grants por cascata de privacidade'
);

do $block$
begin
  perform extensions.dblink_disconnect('feat002_recovery_a');
  perform extensions.dblink_disconnect('feat002_recovery_b');
end;
$block$;
create trigger feat002_force_scrub_failure
before update of raw_user_meta_data on auth.users
for each row execute function private.feat002_force_scrub_failure();

insert into feat002_test_state (label, token)
select
  'rollback-after-delete',
  private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '10000000-0000-4000-8000-000000000014',
    '{"userAgentHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb
  );

select is(
  private.feat002_capture_error(
    pg_catalog.format(
      $command$
        select private.feat002_insert_auth_user(
          '20000000-0000-4000-8000-000000000007',
          'qa-feat002-rollback@setlivre.local',
          %L
        )
      $command$,
      (
        select token::text
        from feat002_test_state
        where label = 'rollback-after-delete'
      )
    )
  ),
  'P0001:feat002_forced_scrub_failure',
  'falha posterior ao DELETE da intenção aborta o cadastro inteiro'
);

select ok(
  exists (
    select 1
    from private.signup_legal_intents
    where id = (
      select token
      from feat002_test_state
      where label = 'rollback-after-delete'
    )
  )
    and not exists (
      select 1
      from auth.users
      where id = '20000000-0000-4000-8000-000000000007'
    )
    and not exists (
      select 1
      from public.profiles
      where id = '20000000-0000-4000-8000-000000000007'
    )
    and not exists (
      select 1
      from public.terms_acceptances
      where user_id = '20000000-0000-4000-8000-000000000007'
    ),
  'rollback restaura a intenção pendente e não deixa identidade parcial'
);

select is(
  private.feat002_capture_error(
    pg_catalog.format(
      $command$
        select private.feat002_insert_auth_user(
          '20000000-0000-4000-8000-000000000004',
          'qa-feat002-replay@setlivre.local',
          %L
        )
      $command$,
      (select token::text from feat002_test_state where label = 'user-a')
    )
  ),
  'P0001:signup_legal_intent_invalid',
  'token consumido não cria uma segunda conta'
);

select ok(
  (
    select pg_catalog.count(*) = 1
    from public.profiles
    where id = '20000000-0000-4000-8000-000000000002'
  )
    and (
      select pg_catalog.count(*) = 2
      from public.terms_acceptances
      where user_id = '20000000-0000-4000-8000-000000000002'
    )
    and not exists (
      select 1
      from auth.users
      where id = '20000000-0000-4000-8000-000000000004'
    ),
  'replay mantém um perfil e dois aceites sem efeito público duplicado'
);

insert into private.signup_legal_intents (
  id,
  terms_version_id,
  privacy_version_id,
  person_type,
  request_id,
  created_at,
  expires_at
)
values (
  '30000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000202',
  'individual',
  '10000000-0000-4000-8000-000000000008',
  pg_catalog.now() - interval '20 minutes',
  pg_catalog.now() - interval '10 minutes'
);

select is(
  private.feat002_capture_error(
    $command$
      select private.feat002_insert_auth_user(
        '20000000-0000-4000-8000-000000000005',
        'qa-feat002-expired@setlivre.local',
        '30000000-0000-4000-8000-000000000001'
      )
    $command$
  ),
  'P0001:signup_legal_intent_invalid',
  'intenção expirada não cria identidade parcial'
);

insert into feat002_test_state (label, token)
select
  'post-expiry-purge',
  private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '10000000-0000-4000-8000-000000000013',
    '{}'::jsonb
  );

select ok(
  not exists (
    select 1
    from private.signup_legal_intents
    where id = '30000000-0000-4000-8000-000000000001'
  ),
  'próxima criação válida purga intenção abandonada já expirada'
);

select ok(
  not exists (
    select 1
    from auth.users
    where id in (
      '20000000-0000-4000-8000-000000000004',
      '20000000-0000-4000-8000-000000000005'
    )
  ),
  'falha do trigger reverte integralmente o INSERT de auth.users'
);

select is(
  pg_catalog.split_part(
    private.feat002_capture_error(
      $command$
        insert into public.terms_versions (
          id,
          kind,
          version,
          title,
          body_markdown,
          source,
          effective_at
        )
        values (
          '00000000-0000-4000-8000-000000000204',
          'terms',
          'overlap-test',
          'Sobreposição — fixture local',
          'Conteúdo exclusivo para testar a exclusão de vigência.',
          'local_fixture',
          '2026-08-02 00:00:00+00'
        )
      $command$
    ),
    ':',
    1
  ),
  '23P01',
  'constraint de exclusão recusa vigências sobrepostas por kind'
);

select is(
  private.feat002_capture_error(
    $command$
      update public.terms_versions
      set title = 'Título adulterado'
      where id = '00000000-0000-4000-8000-000000000201'
    $command$
  ),
  'P0001:terms_version_is_immutable',
  'conteúdo de versão jurídica não pode ser reescrito'
);

select is(
  private.feat002_capture_error(
    $command$
      delete from public.terms_versions
      where id = '00000000-0000-4000-8000-000000000203'
    $command$
  ),
  'P0001:terms_version_is_immutable',
  'versão jurídica não pode ser apagada mesmo sem aceite'
);

savepoint feat002_retirement_probe;

update public.terms_versions
set retired_at = '2027-01-01 00:00:00+00'
where id = '00000000-0000-4000-8000-000000000201';

select ok(
  (
    select retired_at = '2027-01-01 00:00:00+00'::timestamptz
    from public.terms_versions
    where id = '00000000-0000-4000-8000-000000000201'
  ),
  'aposentadoria é a única transição permitida numa versão jurídica'
);

select is(
  private.feat002_capture_error(
    $command$
      update public.terms_versions
      set retired_at = '2027-02-01 00:00:00+00'
      where id = '00000000-0000-4000-8000-000000000201'
    $command$
  ),
  'P0001:terms_version_is_immutable',
  'aposentadoria definida não pode ser reescrita'
);

rollback to savepoint feat002_retirement_probe;

select is(
  private.feat002_capture_error(
    $command$
      update public.terms_versions
      set retired_at = '2026-08-10 00:00:00+00'
      where id = '00000000-0000-4000-8000-000000000201'
    $command$
  ),
  'P0001:terms_version_is_immutable',
  'aposentadoria retroativa não invalida aceite já produzido'
);

select is(
  private.feat002_capture_error(
    $command$
      update public.terms_acceptances
      set accepted_at = pg_catalog.now()
      where user_id = '20000000-0000-4000-8000-000000000002'
    $command$
  ),
  'P0001:terms_acceptance_is_immutable',
  'aceite não pode ser atualizado'
);

select is(
  private.feat002_capture_error(
    $command$
      delete from public.terms_acceptances
      where user_id = '20000000-0000-4000-8000-000000000002'
    $command$
  ),
  'P0001:terms_acceptance_delete_requires_auth_cascade',
  'aceite não pode ser removido enquanto a conta canônica existe'
);

select is(
  private.feat002_capture_error(
    $command$
      delete from public.profiles
      where id = '20000000-0000-4000-8000-000000000002'
    $command$
  ),
  'P0001:profile_delete_requires_auth_cascade',
  'perfil não pode ser removido fora da cascata de Auth'
);

select is(
  private.feat002_capture_error(
    $command$
      insert into public.terms_acceptances (
        user_id,
        terms_version_id,
        accepted_content_hash,
        accepted_at,
        request_id
      )
      values (
        '20000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000203',
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        '2025-01-15 00:00:00+00',
        '10000000-0000-4000-8000-000000000009'
      )
    $command$
  ),
  'P0001:terms_acceptance_snapshot_mismatch',
  'trigger recusa snapshot de hash adulterado'
);

select is(
  private.feat002_capture_error(
    $command$
      insert into public.terms_acceptances (
        user_id,
        terms_version_id,
        accepted_content_hash,
        accepted_at,
        request_id
      )
      select
        '20000000-0000-4000-8000-000000000002',
        id,
        content_hash,
        pg_catalog.now(),
        '10000000-0000-4000-8000-000000000010'
      from public.terms_versions
      where id = '00000000-0000-4000-8000-000000000203'
    $command$
  ),
  'P0001:terms_acceptance_snapshot_mismatch',
  'trigger recusa aceite fora da vigência mesmo com hash correto'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '20000000-0000-4000-8000-000000000002',
  true
);

set local role authenticated;

select pg_catalog.set_config(
  'set_livre.test.user_a_profiles',
  (
    select pg_catalog.count(profile.id)::text
    from public.profiles as profile
  ),
  true
);

select pg_catalog.set_config(
  'set_livre.test.user_a_acceptances',
  (
    select pg_catalog.count(acceptance.user_id)::text
    from public.terms_acceptances as acceptance
  ),
  true
);

select pg_catalog.set_config(
  'set_livre.test.user_a_context',
  (
    select pg_catalog.jsonb_build_object(
      'userId',
      context.user_id,
      'personType',
      context.person_type,
      'status',
      context.status,
      'isComplete',
      context.is_complete
    )::text
    from public.get_own_identity_context() as context
  ),
  true
);

reset role;

select is(
  pg_catalog.current_setting('set_livre.test.user_a_profiles'),
  '1',
  'RLS de profiles isola usuário A do usuário B'
);

select is(
  pg_catalog.current_setting('set_livre.test.user_a_acceptances'),
  '2',
  'RLS de aceites entrega somente os dois fatos do usuário A'
);

select is(
  pg_catalog.current_setting('set_livre.test.user_a_context')::jsonb,
  pg_catalog.jsonb_build_object(
    'userId',
    '20000000-0000-4000-8000-000000000002'::uuid,
    'personType',
    'individual',
    'status',
    'active',
    'isComplete',
    false
  ),
  'read model próprio deriva perfil ainda incompleto'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '20000000-0000-4000-8000-000000000003',
  true
);

set local role authenticated;

select pg_catalog.set_config(
  'set_livre.test.user_b_context',
  (
    select pg_catalog.jsonb_build_object(
      'userId',
      context.user_id,
      'personType',
      context.person_type,
      'status',
      context.status
    )::text
    from public.get_own_identity_context() as context
  ),
  true
);

reset role;

select is(
  pg_catalog.current_setting('set_livre.test.user_b_context')::jsonb,
  pg_catalog.jsonb_build_object(
    'userId',
    '20000000-0000-4000-8000-000000000003'::uuid,
    'personType',
    'company',
    'status',
    'active'
  ),
  'usuário B recebe somente seu contexto PJ'
);

set local role anon;

select pg_catalog.set_config(
  'set_livre.test.current_legal',
  (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'kind',
        legal.kind,
        'source',
        legal.source
      )
      order by legal.kind
    )::text
    from public.get_current_legal_terms() as legal
  ),
  true
);

reset role;

select is(
  pg_catalog.current_setting('set_livre.test.current_legal')::jsonb,
  '[{"kind":"privacy","source":"local_fixture"},{"kind":"terms","source":"local_fixture"}]'::jsonb,
  'visitante lê somente as duas versões vigentes e sua origem explícita'
);

update public.profiles
set status = 'suspended'
where id = '20000000-0000-4000-8000-000000000002';

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '20000000-0000-4000-8000-000000000002',
  true
);

set local role authenticated;

select pg_catalog.set_config(
  'set_livre.test.suspended_status',
  (
    select context.status
    from public.get_own_identity_context() as context
  ),
  true
);

reset role;

select is(
  pg_catalog.current_setting('set_livre.test.suspended_status'),
  'suspended',
  'read model expõe suspensão para o gate server-side do produto'
);

update public.profiles
set status = 'active'
where id = '20000000-0000-4000-8000-000000000002';

insert into feat002_test_state (label, token)
select
  'user-c',
  private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '10000000-0000-4000-8000-000000000011',
    '{}'::jsonb
  );

select private.feat002_insert_auth_user(
  '20000000-0000-4000-8000-000000000006',
  'qa-feat002-cascade@setlivre.local',
  (select token::text from feat002_test_state where label = 'user-c')
);

delete from auth.users
where id = '20000000-0000-4000-8000-000000000006';

select ok(
  not exists (
    select 1
    from public.profiles
    where id = '20000000-0000-4000-8000-000000000006'
  )
    and not exists (
      select 1
      from public.terms_acceptances
      where user_id = '20000000-0000-4000-8000-000000000006'
    ),
  'exclusão canônica em Auth controla a cascata de perfil e aceites'
);

select ok(
  not exists (
    select 1
    from private.signup_legal_intents
    where id = (select token from feat002_test_state where label = 'user-c')
  ),
  'cascata posterior do Auth não recria a intenção já removida'
);

select ok(
  private.check_readiness('20260811000400'),
  'readiness permanece verde com dez dependências e nove rotinas DAL'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member_role
      on member_role.oid = membership.member
    where member_role.rolname = 'app_dal'
  ),
  0,
  'legal-core não amplia app_dal por membership'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_shdepend as dependency
    join pg_catalog.pg_roles as runtime_role
      on runtime_role.oid = dependency.refobjid
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.deptype = 'o'
      and runtime_role.rolname = 'app_dal'
  ),
  'legal-core não concede ownership à role DAL'
);

select * from finish();

rollback;

-- O DELETE exercitado dentro da transação é revertido junto dos demais dados
-- do teste. Esta limpeza exata remove de forma persistente a fixture dblink e
-- permite executar test:db novamente sem reset intermediário.
delete from auth.users
where id = '20000000-0000-4000-8000-000000000008';
