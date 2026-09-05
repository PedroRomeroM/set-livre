-- FEAT-006: núcleo versionado do estúdio, ownership, RLS, idempotência e concorrência.

begin;

create function private.feat006_capture_error(command text)
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

create function private.feat006_create_owner(
  user_id uuid,
  email_address text,
  tax_id text,
  request_suffix integer
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
      '62000000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
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

  perform private.complete_profile(
    user_id,
    0,
    'individual',
    'Dono QA FEAT 006',
    '+5541999999900',
    tax_id,
    null
  );

  perform private.activate_owner(
    user_id,
    '00000000-0000-4000-8000-000000000204',
    (
      '63000000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
    (
      '64000000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
    null
  );
end;
$function$;

revoke all on function private.feat006_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat006_create_owner(uuid, text, text, integer)
  from public, anon, authenticated, service_role, app_dal;

select plan(57);

select private.feat006_create_owner(
  '61000000-0000-4000-8000-000000000001',
  'qa-feat006-owner-a@setlivre.local',
  '52998224725',
  1
);
select private.feat006_create_owner(
  '61000000-0000-4000-8000-000000000002',
  'qa-feat006-owner-b@setlivre.local',
  '11144477735',
  2
);

do $retire_owner_contract$
begin
  alter table public.terms_versions
    disable trigger terms_versions_protect_immutability;
  update public.terms_versions
  set retired_at = pg_catalog.transaction_timestamp() - interval '1 microsecond'
  where id = '00000000-0000-4000-8000-000000000204';
  alter table public.terms_versions
    enable trigger terms_versions_protect_immutability;
end;
$retire_owner_contract$;

select matches(
  private.feat006_capture_error(
    $command$
      select private.create_studio(
        '61000000-0000-4000-8000-000000000001',
        '65000000-0000-4000-8000-000000000099',
        '66000000-0000-4000-8000-000000000099',
        'Estúdio bloqueado',
        'Este comando comprova que contrato vencido bloqueia até replay idempotente.',
        'Rua A', '1', null, 'Centro', 'Curitiba', 'PR', '80010000', 2,
        '60000000-0000-4000-8000-000000000001'
      )
    $command$
  ),
  '^42501:owner_contract_not_current$',
  'autoridade canônica bloqueia mutação quando o contrato do dono não está vigente'
);

do $restore_owner_contract$
begin
  alter table public.terms_versions
    disable trigger terms_versions_protect_immutability;
  update public.terms_versions
  set retired_at = null
  where id = '00000000-0000-4000-8000-000000000204';
  alter table public.terms_versions
    enable trigger terms_versions_protect_immutability;
end;
$restore_owner_contract$;

select has_table('public', 'studios', 'studios existe');
select has_table('public', 'studio_revisions', 'studio_revisions existe');
select has_table('public', 'studio_types', 'studio_types existe');
select has_table('private', 'studio_command_requests', 'ledger privado existe');

select policies_are(
  'public',
  'studios',
  array['studios_select_own'],
  'studios possui somente a policy de leitura do dono'
);

select is(
  (
    select routine.prosecdef
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'private'
      and routine.proname = 'enforce_studio_revision_pointers'
      and routine.pronargs = 0
  ),
  true,
  'o gatilho de ponteiros mantém autoridade interna ao fim da instrução atômica'
);
select policies_are(
  'public',
  'studio_revisions',
  array['studio_revisions_select_own'],
  'revisões possuem somente a policy de leitura por ownership'
);

select is(
  (select pg_catalog.count(*)::integer from public.studio_types where active),
  4,
  'taxonomia mínima ativa é seedada de forma determinística'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.create_binding',
  private.bind_studio_command_result(
    '61000000-0000-4000-8000-000000000001',
    '65000000-0000-4000-8000-000000000001',
    private.create_studio(
      '61000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001',
      '66000000-0000-4000-8000-000000000001',
      'Estúdio Aurora',
      'Estúdio completo para ensaios fotográficos e gravações audiovisuais.',
      'Rua das Flores',
      '100',
      'Sala 2',
      'Centro',
      'Curitiba',
      'PR',
      '80010000',
      12,
      '60000000-0000-4000-8000-000000000001'
    )
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.create_response',
  (pg_catalog.current_setting('set_livre.test.create_binding')::jsonb -> 'result')::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.studio_a',
  (
    pg_catalog.current_setting('set_livre.test.create_response')::jsonb
      ->> 'studioId'
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.revision_a',
  (
    pg_catalog.current_setting('set_livre.test.create_response')::jsonb
      #>> '{revision,id}'
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.create_replay_equal',
  (
    private.bind_studio_command_result(
      '61000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001',
      private.create_studio(
        '61000000-0000-4000-8000-000000000001',
        '65000000-0000-4000-8000-000000000001',
        '66000000-0000-4000-8000-000000000002',
        'Estúdio Aurora',
        'Estúdio completo para ensaios fotográficos e gravações audiovisuais.',
        'Rua das Flores',
        '100',
        'Sala 2',
        'Centro',
        'Curitiba',
        'PR',
        '80010000',
        12,
        '60000000-0000-4000-8000-000000000001'
      )
    )::text = pg_catalog.current_setting('set_livre.test.create_binding')
  )::text,
  true
);
reset role;
revoke app_dal from postgres granted by current_user;

select ok(
  pg_catalog.current_setting('set_livre.test.create_replay_equal')::boolean,
  'replay de criação retorna exatamente o resultado originalmente registrado'
);

select is(
  pg_catalog.current_setting('set_livre.test.create_binding')::jsonb,
  pg_catalog.jsonb_build_object(
    'action', 'studio.create',
    'idempotencyKey', '65000000-0000-4000-8000-000000000001',
    'result', pg_catalog.current_setting('set_livre.test.create_response')::jsonb
  ),
  'binder VOLATILE vê o ledger criado no mesmo SELECT e preserva o resultado bruto no replay'
);

select ok(
  (
    select routine.prosecdef and routine.provolatile = 'v'
      and routine.proconfig = array['search_path=""']::text[]
      and pg_catalog.pg_get_userbyid(routine.proowner) = 'postgres'
      and pg_catalog.has_function_privilege('app_dal', routine.oid, 'EXECUTE')
      and not exists (
        select 1
        from pg_catalog.aclexplode(routine.proacl) as privilege
        where privilege.privilege_type <> 'EXECUTE'
          or privilege.is_grantable
          or privilege.grantee not in (
            routine.proowner,
            (select oid from pg_catalog.pg_roles where rolname = 'app_dal')
          )
      )
      and not exists (
        select 1
        from (values ('anon'), ('authenticated'), ('service_role')) as role(name)
        where pg_catalog.has_function_privilege(role.name, routine.oid, 'EXECUTE')
      )
    from pg_catalog.pg_proc as routine
    where routine.oid = 'private.bind_studio_command_result(uuid,uuid,jsonb)'::regprocedure
  ),
  'binder é privado, definer postgres, VOLATILE e só concede EXECUTE sem grant option a app_dal'
);

select ok(
  not exists (
    select 1
    from (values
      (null::uuid, '65000000-0000-4000-8000-000000000001'::uuid, '{}'::jsonb),
      ('61000000-0000-4000-8000-000000000001', null, '{}'::jsonb),
      ('61000000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000001', null),
      ('61000000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000001', 'null'::jsonb),
      ('61000000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000001', '[]'::jsonb)
    ) as invalid(owner_id, key, result)
    where private.feat006_capture_error(pg_catalog.format(
      'select private.bind_studio_command_result(%L::uuid, %L::uuid, %L::jsonb)',
      invalid.owner_id, invalid.key, invalid.result
    )) <> 'XX000:studio_command_result_mismatch'
  ),
  'nulos SQL/JSON e resultado não objeto falham como incerteza interna, não conflito definitivo'
);

select ok(
  not exists (
    select 1
    from (values
      ('61000000-0000-4000-8000-000000000002'::uuid, '65000000-0000-4000-8000-000000000001'::uuid),
      ('61000000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000098')
    ) as other(owner_id, key)
    where private.feat006_capture_error(pg_catalog.format(
      'select private.bind_studio_command_result(%L::uuid, %L::uuid, %L::jsonb)',
      other.owner_id, other.key, pg_catalog.current_setting('set_livre.test.create_response')
    )) <> 'XX000:studio_command_result_mismatch'
  ),
  'resultado real não pode ser vinculado a outro dono nem a chave ausente'
);

select matches(
  private.feat006_capture_error($command$
    select private.bind_studio_command_result(
      '61000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.create_response')::jsonb
        || '{"action":"studio.pause","idempotencyKey":"65000000-0000-4000-8000-000000000098"}'::jsonb
    )
  $command$),
  '^XX000:studio_command_result_mismatch$',
  'action/chave injetadas no JSON não reetiquetam o resultado cujo hash é persistido'
);

select matches(
  private.feat006_capture_error($command$
    select private.bind_studio_command_result(
      '61000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000098',
      private.create_studio(
        '61000000-0000-4000-8000-000000000001',
        '65000000-0000-4000-8000-000000000097',
        '66000000-0000-4000-8000-000000000097',
        'Estúdio QA rollback do binding',
        'Criação que deve ser revertida integralmente quando seu binding diverge.',
        'Rua QA', '1', null, 'Centro', 'Curitiba', 'PR', '80010000', 2,
        '60000000-0000-4000-8000-000000000001'
      )
    )
  $command$),
  '^XX000:studio_command_result_mismatch$',
  'binder rejeita uma chave diferente da mutação aninhada na mesma instrução'
);
select ok(
  not exists (
    select 1 from private.studio_command_requests
    where owner_user_id = '61000000-0000-4000-8000-000000000001'
      and idempotency_key = '65000000-0000-4000-8000-000000000097'
  ) and not exists (
    select 1 from audit.events
    where actor_user_id = '61000000-0000-4000-8000-000000000001'
      and idempotency_key = '65000000-0000-4000-8000-000000000097'
  ) and (select pg_catalog.count(*) = 1 from public.studios
    where owner_user_id = '61000000-0000-4000-8000-000000000001'),
  'falha do binding reverte estúdio, ledger e auditoria, sem mutação parcial'
);

savepoint corrupt_bound_result_hash;
update private.studio_command_requests
set result_hash = pg_catalog.repeat('f', 64)
where owner_user_id = '61000000-0000-4000-8000-000000000001'
  and idempotency_key = '65000000-0000-4000-8000-000000000001';
select matches(
  private.feat006_capture_error($command$
    select private.bind_studio_command_result(
      '61000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.create_response')::jsonb
    )
  $command$),
  '^XX000:studio_command_result_mismatch$',
  'hash persistido divergente bloqueia a resposta bruta mesmo sem result_payload'
);
rollback to savepoint corrupt_bound_result_hash;
release savepoint corrupt_bound_result_hash;

savepoint unknown_bound_action;
alter table private.studio_command_requests drop constraint studio_command_requests_action_check;
update private.studio_command_requests
set action = 'studio.unknown'
where owner_user_id = '61000000-0000-4000-8000-000000000001'
  and idempotency_key = '65000000-0000-4000-8000-000000000001';
select matches(
  private.feat006_capture_error($command$
    select private.bind_studio_command_result(
      '61000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.create_response')::jsonb
    )
  $command$),
  '^XX000:studio_command_result_mismatch$',
  'action fora do mapa explícito falha mesmo com resultado e hash íntegros'
);
rollback to savepoint unknown_bound_action;
release savepoint unknown_bound_action;

select ok(
  exists (
    select 1
    from public.studios as studio
    join public.studio_revisions as revision on revision.id = studio.draft_revision_id
    where studio.id = pg_catalog.current_setting('set_livre.test.studio_a')::uuid
      and studio.owner_user_id = '61000000-0000-4000-8000-000000000001'
      and studio.status = 'draft'
      and revision.revision_number = 1
      and revision.revision_version = 1
      and revision.status = 'draft'
  ),
  'create é atômico e aponta para a primeira revisão draft'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from private.studio_command_requests as request
    where request.owner_user_id = '61000000-0000-4000-8000-000000000001'
      and request.idempotency_key = '65000000-0000-4000-8000-000000000001'
  ),
  1,
  'replay idempotente converge sem criar outro estúdio'
);

select ok(
  exists (
    select 1
    from private.studio_command_requests as request
    where request.owner_user_id = '61000000-0000-4000-8000-000000000001'
      and request.idempotency_key = '65000000-0000-4000-8000-000000000001'
      and request.result_hash ~ '^[0-9a-f]{64}$'
  ),
  'ledger preserva somente o hash verificável do resultado idempotente'
);

savepoint future_revision_timestamp;

alter table public.studio_revisions disable trigger user;
select pg_catalog.set_config(
  'set_livre.test.future_revision_timestamp',
  (pg_catalog.clock_timestamp() + interval '2 seconds')::text,
  true
);
update public.studio_revisions as revision
set
  created_at = pg_catalog.current_setting('set_livre.test.future_revision_timestamp')::timestamptz,
  updated_at = pg_catalog.current_setting('set_livre.test.future_revision_timestamp')::timestamptz
where revision.id = pg_catalog.current_setting('set_livre.test.revision_a')::uuid;
alter table public.studio_revisions enable trigger user;

update public.studio_revisions as revision
set revision_version = revision.revision_version + 1
where revision.id = pg_catalog.current_setting('set_livre.test.revision_a')::uuid;

select ok(
  (
    select revision.revision_version = 2
      and revision.updated_at >= revision.created_at
      and revision.updated_at >=
        pg_catalog.current_setting('set_livre.test.future_revision_timestamp')::timestamptz
    from public.studio_revisions as revision
    where revision.id = pg_catalog.current_setting('set_livre.test.revision_a')::uuid
  ),
  'revisão permanece atualizável quando o relógio observado recua após sua criação'
);

rollback to savepoint future_revision_timestamp;

select matches(
  private.feat006_capture_error(
    $command$
      select private.create_studio(
        '61000000-0000-4000-8000-000000000001',
        '65000000-0000-4000-8000-000000000001',
        '66000000-0000-4000-8000-000000000003',
        'Payload divergente',
        'Este conteúdo deliberadamente diverge do primeiro comando idempotente.',
        'Rua das Flores', '100', null, 'Centro', 'Curitiba', 'PR', '80010000', 12,
        '60000000-0000-4000-8000-000000000001'
      )
    $command$
  ),
  '^40001:studio_idempotency_conflict$',
  'a mesma chave com payload divergente falha fechado'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.update_response',
  private.update_studio_revision_core(
    '61000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.studio_a')::uuid,
    pg_catalog.current_setting('set_livre.test.revision_a')::uuid,
    1,
    '65000000-0000-4000-8000-000000000002',
    '66000000-0000-4000-8000-000000000004',
    'Estúdio Aurora Atualizado',
    'Descrição atualizada sem perder a versão canônica nem o endereço estruturado.',
    'Rua das Flores',
    '101',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    16,
    '60000000-0000-4000-8000-000000000002'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.update_replay_equal',
  (
    private.update_studio_revision_core(
    '61000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.studio_a')::uuid,
    pg_catalog.current_setting('set_livre.test.revision_a')::uuid,
    1,
    '65000000-0000-4000-8000-000000000002',
    '66000000-0000-4000-8000-000000000004',
    'Estúdio Aurora Atualizado',
    'Descrição atualizada sem perder a versão canônica nem o endereço estruturado.',
    'Rua das Flores', '101', null, 'Centro', 'Curitiba', 'PR', '80010000', 16,
    '60000000-0000-4000-8000-000000000002'
    )::text = pg_catalog.current_setting('set_livre.test.update_response')
  )::text,
  true
);
reset role;
revoke app_dal from postgres granted by current_user;

select ok(
  pg_catalog.current_setting('set_livre.test.update_replay_equal')::boolean,
  'replay de atualização retorna exatamente o resultado originalmente registrado'
);

select ok(
  exists (
    select 1
    from public.studio_revisions as revision
    where revision.id = pg_catalog.current_setting('set_livre.test.revision_a')::uuid
      and revision.name = 'Estúdio Aurora Atualizado'
      and revision.revision_version = 2
      and revision.capacity = 16
  ),
  'update altera somente draft e incrementa o token otimista'
);

select matches(
  private.feat006_capture_error(
    $command$
      select private.create_studio(
        '61000000-0000-4000-8000-000000000001',
        '65000000-0000-4000-8000-000000000001',
        '66000000-0000-4000-8000-000000000011',
        'Estúdio Aurora',
        'Estúdio completo para ensaios fotográficos e gravações audiovisuais.',
        'Rua das Flores', '100', 'Sala 2', 'Centro', 'Curitiba', 'PR', '80010000', 12,
        '60000000-0000-4000-8000-000000000001'
      )
    $command$
  ),
  '^40001:studio_create_result_stale$',
  'replay antigo falha fechado quando o resultado exato da criação não é mais reconstruível'
);

select matches(
  private.feat006_capture_error(
    pg_catalog.format(
      $command$
        select private.update_studio_revision_core(
          '61000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 1,
          '65000000-0000-4000-8000-000000000003',
          '66000000-0000-4000-8000-000000000005',
          'Versão velha',
          'Tentativa concorrente usando deliberadamente um token de versão já vencido.',
          'Rua das Flores', '101', null, 'Centro', 'Curitiba', 'PR', '80010000', 16,
          '60000000-0000-4000-8000-000000000002'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.studio_a'),
      pg_catalog.current_setting('set_livre.test.revision_a')
    )
  ),
  '^40001:studio_revision_conflict$',
  'token otimista vencido não sobrescreve a revisão'
);

select matches(
  private.feat006_capture_error(
    pg_catalog.format(
      $command$
        select private.update_studio_revision_core(
          '61000000-0000-4000-8000-000000000002', %L::uuid, %L::uuid, 2,
          '65000000-0000-4000-8000-000000000004',
          '66000000-0000-4000-8000-000000000006',
          'Tentativa externa',
          'Outro dono tenta alterar um estúdio que não pertence à sua própria conta.',
          'Rua das Flores', '101', null, 'Centro', 'Curitiba', 'PR', '80010000', 16,
          '60000000-0000-4000-8000-000000000002'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.studio_a'),
      pg_catalog.current_setting('set_livre.test.revision_a')
    )
  ),
  '^P0002:studio_not_found$',
  'ownership impede que o dono B altere o estúdio A'
);

update public.studio_revisions as revision
set status = 'approved', revision_version = revision_version + 1
where revision.id = pg_catalog.current_setting('set_livre.test.revision_a')::uuid;

update public.studios as studio
set status = 'pending_review'
where studio.id = pg_catalog.current_setting('set_livre.test.studio_a')::uuid;

update public.studios as studio
set
  status = 'published',
  published_revision_id = pg_catalog.current_setting('set_livre.test.revision_a')::uuid,
  draft_revision_id = null
where studio.id = pg_catalog.current_setting('set_livre.test.studio_a')::uuid;

select matches(
  private.feat006_capture_error(
    pg_catalog.format(
      $command$
        select private.update_studio_revision_core(
          '61000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 1,
          '65000000-0000-4000-8000-000000000002',
          '66000000-0000-4000-8000-000000000012',
          'Estúdio Aurora Atualizado',
          'Descrição atualizada sem perder a versão canônica nem o endereço estruturado.',
          'Rua das Flores', '101', null, 'Centro', 'Curitiba', 'PR', '80010000', 16,
          '60000000-0000-4000-8000-000000000002'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.studio_a'),
      pg_catalog.current_setting('set_livre.test.revision_a')
    )
  ),
  '^40001:studio_update_result_stale$',
  'replay antigo falha fechado quando o resultado exato da atualização não é mais reconstruível'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.cloned_revision',
  (
    private.update_studio_revision_core(
      '61000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.studio_a')::uuid,
      pg_catalog.current_setting('set_livre.test.revision_a')::uuid,
      3,
      '65000000-0000-4000-8000-000000000005',
      '66000000-0000-4000-8000-000000000007',
      'Novo rascunho privado',
      'A edição de um publicado cria nova revisão sem alterar o conteúdo aprovado anterior.',
      'Rua das Flores',
      '202',
      null,
      'Centro',
      'Curitiba',
      'PR',
      '80010000',
      20,
      '60000000-0000-4000-8000-000000000003'
    ) #>> '{revision,id}'
  ),
  true
);
reset role;
revoke app_dal from postgres granted by current_user;

select ok(
  exists (
    select 1
    from public.studios as studio
    join public.studio_revisions as published on published.id = studio.published_revision_id
    join public.studio_revisions as draft on draft.id = studio.draft_revision_id
    where studio.id = pg_catalog.current_setting('set_livre.test.studio_a')::uuid
      and published.id = pg_catalog.current_setting('set_livre.test.revision_a')::uuid
      and published.name = 'Estúdio Aurora Atualizado'
      and published.status = 'approved'
      and draft.id = pg_catalog.current_setting('set_livre.test.cloned_revision')::uuid
      and draft.name = 'Novo rascunho privado'
      and draft.status = 'draft'
      and draft.revision_number = 2
      and draft.revision_version = 1
  ),
  'editar publicado clona revision number monotônico e preserva a versão aprovada'
);

select matches(
  private.feat006_capture_error(
    pg_catalog.format(
      $command$
        insert into public.studio_revisions (
          studio_id, revision_number, revision_version, status, name, description,
          street, street_number, neighborhood, city, state, postal_code, capacity, studio_type_id
        ) values (
          %L::uuid, 3, 1, 'draft', 'Segundo draft',
          'Segundo rascunho simultâneo que deve ser rejeitado pelo índice parcial.',
          'Rua B', '1', 'Centro', 'Curitiba', 'PR', '80010000', 2,
          '60000000-0000-4000-8000-000000000001'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.studio_a')
    )
  ),
  '^23505:',
  'índice parcial garante no máximo um draft por estúdio'
);

select matches(
  private.feat006_capture_error(
    pg_catalog.format(
      'update public.studio_revisions set name = %L where id = %L::uuid',
      'Mutação proibida',
      pg_catalog.current_setting('set_livre.test.revision_a')
    )
  ),
  '^23514:studio_revision_immutable$',
  'revisão aprovada é imutável por trigger'
);

select matches(
  private.feat006_capture_error(
    pg_catalog.format(
      'delete from public.studio_revisions where id = %L::uuid',
      pg_catalog.current_setting('set_livre.test.revision_a')
    )
  ),
  '^23514:studio_revision_immutable$',
  'revisão aprovada não pode ser removida'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.discard_published_response',
  (
    private.discard_studio_draft(
      '61000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.studio_a')::uuid,
      pg_catalog.current_setting('set_livre.test.cloned_revision')::uuid,
      1,
      '65000000-0000-4000-8000-000000000006',
      '66000000-0000-4000-8000-000000000008'
    )::text
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.discard_published',
  pg_catalog.current_setting('set_livre.test.discard_published_response')::jsonb
    ->> 'studioDeleted',
  true
);
select pg_catalog.set_config(
  'set_livre.test.discard_published_replay_equal',
  (
    private.discard_studio_draft(
    '61000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.studio_a')::uuid,
    pg_catalog.current_setting('set_livre.test.cloned_revision')::uuid,
    1,
    '65000000-0000-4000-8000-000000000006',
    '66000000-0000-4000-8000-000000000013'
    )::text = pg_catalog.current_setting('set_livre.test.discard_published_response')
  )::text,
  true
);
reset role;
revoke app_dal from postgres granted by current_user;

select ok(
  pg_catalog.current_setting('set_livre.test.discard_published_replay_equal')::boolean,
  'replay de descarte retorna exatamente o resultado originalmente registrado'
);

select ok(
  not pg_catalog.current_setting('set_livre.test.discard_published')::boolean
    and exists (
      select 1 from public.studios as studio
      where studio.id = pg_catalog.current_setting('set_livre.test.studio_a')::uuid
        and studio.draft_revision_id is null
        and studio.published_revision_id =
          pg_catalog.current_setting('set_livre.test.revision_a')::uuid
    )
    and not exists (
      select 1 from public.studio_revisions as revision
      where revision.id = pg_catalog.current_setting('set_livre.test.cloned_revision')::uuid
    ),
  'descarte remove somente o draft quando há publicação'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.unpublished_response',
  (
    private.create_studio(
      '61000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000007',
      '66000000-0000-4000-8000-000000000009',
      'Estúdio Temporário',
      'Este estúdio ainda inédito será descartado integralmente pelo dono.',
      'Rua C', '3', null, 'Centro', 'Curitiba', 'PR', '80010000', 4,
      '60000000-0000-4000-8000-000000000004'
    )::text
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.unpublished_studio',
  (
    pg_catalog.current_setting('set_livre.test.unpublished_response')::jsonb
      ->> 'studioId'
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.unpublished_revision',
  (
    pg_catalog.current_setting('set_livre.test.unpublished_response')::jsonb
      #>> '{revision,id}'
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.discard_unpublished_response',
  (
    private.discard_studio_draft(
      '61000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.unpublished_studio')::uuid,
      pg_catalog.current_setting('set_livre.test.unpublished_revision')::uuid,
      1,
      '65000000-0000-4000-8000-000000000008',
      '66000000-0000-4000-8000-000000000010'
    )::text
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.discard_unpublished',
  pg_catalog.current_setting('set_livre.test.discard_unpublished_response')::jsonb
    ->> 'studioDeleted',
  true
);
select pg_catalog.set_config(
  'set_livre.test.discard_unpublished_replay_equal',
  (
    private.discard_studio_draft(
    '61000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.unpublished_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.unpublished_revision')::uuid,
    1,
    '65000000-0000-4000-8000-000000000008',
    '66000000-0000-4000-8000-000000000014'
    )::text = pg_catalog.current_setting('set_livre.test.discard_unpublished_response')
  )::text,
  true
);
reset role;
revoke app_dal from postgres granted by current_user;

select ok(
  pg_catalog.current_setting('set_livre.test.discard_unpublished_replay_equal')::boolean,
  'replay de descarte integral reconstrói exatamente o resultado terminal registrado'
);

select ok(
  pg_catalog.current_setting('set_livre.test.discard_unpublished')::boolean
    and not exists (
      select 1 from public.studios as studio
      where studio.id = pg_catalog.current_setting('set_livre.test.unpublished_studio')::uuid
    ),
  'descartar o único draft remove o estúdio ainda inédito'
);

update public.studio_types as studio_type
set active = false
where studio_type.id = '60000000-0000-4000-8000-000000000002';

select matches(
  private.feat006_capture_error(
    pg_catalog.format(
      $command$
        select private.update_studio_revision_core(
          '61000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 3,
          '65000000-0000-4000-8000-000000000009',
          '66000000-0000-4000-8000-000000000015',
          'Tipo arquivado',
          'Uma nova alteração nunca pode conservar uma opção retirada da seleção ativa.',
          'Rua das Flores', '101', null, 'Centro', 'Curitiba', 'PR', '80010000', 16,
          '60000000-0000-4000-8000-000000000002'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.studio_a'),
      pg_catalog.current_setting('set_livre.test.revision_a')
    )
  ),
  '^23514:studio_type_inactive$',
  'comando rejeita tipo arquivado mesmo quando ele pertence à revisão histórica atual'
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  true
);

select is(
  (select pg_catalog.count(*)::integer from public.studios),
  1,
  'RLS mostra ao dono A somente seus estúdios'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from public.studio_types as studio_type
    where studio_type.id = '60000000-0000-4000-8000-000000000002'
  ),
  1,
  'RLS mantém o tipo arquivado legível para o dono da revisão histórica'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from public.list_active_studio_types() as studio_type
    where studio_type.id = '60000000-0000-4000-8000-000000000002'
  ),
  0,
  'read model de seleção exclui o tipo arquivado de novas alterações'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from public.get_owner_studio_editor(
      pg_catalog.current_setting('set_livre.test.studio_a')::uuid
    )
  ),
  1,
  'read model autenticado retorna o editor do próprio dono'
);

reset role;
update public.profiles as profile
set status = 'suspended'
where profile.id = '61000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  true
);
select ok(
  (select pg_catalog.count(*) = 0 from public.studios)
    and (select pg_catalog.count(*) = 0 from public.studio_revisions)
    and (
      select pg_catalog.count(*) = 0
      from public.get_owner_studio_editor(
        pg_catalog.current_setting('set_livre.test.studio_a')::uuid
      )
    ),
  'conta suspensa perde a leitura direta e o editor no limite do banco'
);

reset role;
update public.profiles as profile
set status = 'active'
where profile.id = '61000000-0000-4000-8000-000000000001';
alter table public.profiles disable trigger profiles_enforce_lifecycle;
update public.profiles as profile
set
  name = null,
  phone_e164 = null,
  tax_id = null,
  additional_document = null,
  completed_at = null
where profile.id = '61000000-0000-4000-8000-000000000001';
alter table public.profiles enable trigger profiles_enforce_lifecycle;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  true
);
select ok(
  (select pg_catalog.count(*) = 0 from public.studios)
    and (select pg_catalog.count(*) = 0 from public.studio_revisions)
    and (
      select pg_catalog.count(*) = 0
      from public.get_owner_studio_editor(
        pg_catalog.current_setting('set_livre.test.studio_a')::uuid
      )
    ),
  'perfil incompleto perde a leitura direta e o editor no limite do banco'
);

reset role;
alter table public.profiles disable trigger profiles_enforce_lifecycle;
update public.profiles as profile
set
  name = 'Dono QA FEAT 006',
  phone_e164 = '+5541999999900',
  tax_id = '52998224725',
  completed_at = pg_catalog.clock_timestamp()
where profile.id = '61000000-0000-4000-8000-000000000001';
alter table public.profiles enable trigger profiles_enforce_lifecycle;
savepoint owner_blocked_read_gate;
update public.owner_profiles as owner
set
  status = 'blocked',
  owner_version = owner.owner_version + 1
where owner.user_id = '61000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  true
);
select ok(
  (select pg_catalog.count(*) = 0 from public.studios)
    and (select pg_catalog.count(*) = 0 from public.studio_revisions)
    and (
      select pg_catalog.count(*) = 0
      from public.get_owner_studio_editor(
        pg_catalog.current_setting('set_livre.test.studio_a')::uuid
      )
    ),
  'dono bloqueado perde a leitura direta e o editor no limite do banco'
);

reset role;
rollback to savepoint owner_blocked_read_gate;
release savepoint owner_blocked_read_gate;
savepoint expired_owner_contract_read_gate;
alter table public.terms_versions disable trigger terms_versions_protect_immutability;
update public.terms_versions as legal_version
set retired_at = pg_catalog.transaction_timestamp() - interval '1 microsecond'
where legal_version.id = '00000000-0000-4000-8000-000000000204';
alter table public.terms_versions enable trigger terms_versions_protect_immutability;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  true
);
select ok(
  (select pg_catalog.count(*) = 0 from public.studios)
    and (select pg_catalog.count(*) = 0 from public.studio_revisions)
    and (
      select pg_catalog.count(*) = 0
      from public.get_owner_studio_editor(
        pg_catalog.current_setting('set_livre.test.studio_a')::uuid
      )
    ),
  'contrato vencido perde a leitura direta e o editor no limite do banco'
);

reset role;
rollback to savepoint expired_owner_contract_read_gate;
release savepoint expired_owner_contract_read_gate;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000001',
  true
);
select ok(
  (select pg_catalog.count(*) = 1 from public.studios)
    and (select pg_catalog.count(*) = 1 from public.studio_revisions)
    and (
      select pg_catalog.count(*) = 1
      from public.get_owner_studio_editor(
        pg_catalog.current_setting('set_livre.test.studio_a')::uuid
      )
    ),
  'restaurar todos os fatos canônicos devolve a leitura elegível do dono'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '61000000-0000-4000-8000-000000000002',
  true
);
select is(
  (
    select pg_catalog.count(*)::integer
    from public.studio_types as studio_type
    where studio_type.id = '60000000-0000-4000-8000-000000000002'
  ),
  0,
  'RLS não revela o tipo arquivado a outro dono sem revisão correspondente'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from public.get_owner_studio_editor(
      pg_catalog.current_setting('set_livre.test.studio_a')::uuid
    )
  ),
  0,
  'read model não revela a existência do estúdio de outro dono'
);
reset role;

create function private.feat006_attempt_studio_read()
returns text
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform 1 from public.studios limit 1;
  return 'NO_ERROR';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$function$;

revoke all on function private.feat006_attempt_studio_read()
  from public, anon, authenticated, service_role;
grant execute on function private.feat006_attempt_studio_read()
  to app_dal;

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.app_dal_studio_read_result',
  private.feat006_attempt_studio_read(),
  true
);
reset role;
revoke app_dal from postgres granted by current_user;

select matches(
  pg_catalog.current_setting('set_livre.test.app_dal_studio_read_result'),
  '^42501:',
  'app_dal não recebe leitura direta de tabelas públicas'
);

drop function private.feat006_attempt_studio_read();

select ok(
  pg_catalog.has_function_privilege(
    'app_dal',
    'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,integer,uuid)',
    'EXECUTE'
  )
    and pg_catalog.has_function_privilege(
      'app_dal',
      'private.update_studio_revision_core(uuid,uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,text,text,integer,uuid)',
      'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'app_dal',
      'private.discard_studio_draft(uuid,uuid,uuid,bigint,uuid,uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal',
      'private.studio_editor_json(uuid,uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal',
      'private.studio_result_hash(jsonb)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal',
      'private.assert_studio_owner_mutable(uuid)',
      'EXECUTE'
    ),
  'app_dal recebe somente as três fachadas novas, não os helpers'
);

select ok(
  private.check_readiness('20260905190840'),
  'readiness aceita a migration e a allowlist canônica atualizadas'
);

savepoint missing_binder_grant;
revoke execute on function private.bind_studio_command_result(uuid, uuid, jsonb) from app_dal;
select ok(
  not private.check_readiness('20260905190840'),
  'readiness detecta ausência do EXECUTE do binder na allowlist canônica'
);
rollback to savepoint missing_binder_grant;
release savepoint missing_binder_grant;

select is(
  (
    select pg_catalog.count(*)::integer
    from audit.events as event
    where event.actor_user_id = '61000000-0000-4000-8000-000000000001'
      and event.action in (
        'studio.created',
        'studio.revision_updated',
        'studio.draft_discarded'
      )
  ),
  6,
  'criação, atualização e descartes geram auditoria sem conteúdo do endereço'
);

select ok(
  not exists (
    select 1
    from audit.events as event
    where event.actor_user_id = '61000000-0000-4000-8000-000000000001'
      and event.metadata::text ~ '(Rua|Centro|80010000)'
  ),
  'metadata de auditoria não replica endereço ou conteúdo'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from private.dal_routine_allowlist as entry
    where pg_catalog.to_regprocedure(entry.signature) is null
  ),
  0,
  'toda assinatura da allowlist resolve para uma rotina real'
);

select * from finish();
rollback;
