-- FEAT-004: dono, contrato próprio, recebedor local, RLS, grants e comandos.

-- As duas sessões dblink precisam enxergar um perfil committed. A limpeza
-- exata ao fim mantém o teste repetível sem depender de reset intermediário.
delete from audit.events
where actor_user_id = '40000000-0000-4000-8000-000000000010'
  or target_id = '40000000-0000-4000-8000-000000000010';

delete from auth.users
where id = '40000000-0000-4000-8000-000000000010';

delete from private.signup_legal_intents
where request_id = '41000000-0000-4000-8000-000000000010';

do $concurrency_fixture$
declare
  legal_intent uuid;
begin
  legal_intent := private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '41000000-0000-4000-8000-000000000010',
    '{}'::jsonb
  );

  insert into auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  )
  values (
    '40000000-0000-4000-8000-000000000010',
    'authenticated',
    'authenticated',
    'qa-feat004-concurrent@setlivre.local',
    '',
    pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    pg_catalog.jsonb_build_object('sl_legal_intent', legal_intent::text),
    pg_catalog.now(),
    pg_catalog.now()
  );

  perform private.complete_profile(
    '40000000-0000-4000-8000-000000000010',
    0,
    'individual',
    'Dono Concorrente',
    '+5541996667788',
    '28001238938',
    null
  );
end;
$concurrency_fixture$;

begin;

create function private.feat004_capture_error(command text)
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

create function private.feat004_create_user(
  user_id uuid,
  email_address text,
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
    'individual',
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

create temporary table feat004_concurrency_results (
  label text primary key,
  owner_version bigint,
  operation_id uuid,
  operation_sequence bigint,
  error_message text
) on commit drop;

revoke all on function private.feat004_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat004_create_user(uuid, text, uuid)
  from public, anon, authenticated, service_role, app_dal;

select plan(65);

create extension if not exists dblink with schema extensions;

do $concurrent_activation$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat004_activate_a',
    'feat004_activate_b'
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

    perform extensions.dblink_send_query(
      connection_name,
      pg_catalog.format(
        $remote$
        select owner_version
        from private.activate_owner(
          '40000000-0000-4000-8000-000000000010',
          '00000000-0000-4000-8000-000000000204',
          '42000000-0000-4000-8000-000000000010',
          %L::uuid,
          null
        )
        $remote$,
        case connection_name
          when 'feat004_activate_a'
            then '45000000-0000-4000-8000-000000000010'
          else '45000000-0000-4000-8000-000000000011'
        end
      )
    );
  end loop;
end;
$concurrent_activation$;

do $collect_concurrent_activation$
begin
  begin
    insert into feat004_concurrency_results (label, owner_version)
    select 'activate-a', result.owner_version
    from extensions.dblink_get_result('feat004_activate_a')
      as result(owner_version bigint);
  exception when others then
    insert into feat004_concurrency_results (label, error_message)
    values ('activate-a', sqlstate || ':' || sqlerrm);
  end;

  begin
    insert into feat004_concurrency_results (label, owner_version)
    select 'activate-b', result.owner_version
    from extensions.dblink_get_result('feat004_activate_b')
      as result(owner_version bigint);
  exception when others then
    insert into feat004_concurrency_results (label, error_message)
    values ('activate-b', sqlstate || ':' || sqlerrm);
  end;
end;
$collect_concurrent_activation$;

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(result.owner_version = 1)
      and pg_catalog.bool_and(result.error_message is null)
    from feat004_concurrency_results as result
    where result.label in ('activate-a', 'activate-b')
  )
    and (
      select pg_catalog.count(*) = 1
      from private.owner_activation_requests as request
      where request.owner_user_id = '40000000-0000-4000-8000-000000000010'
        and request.idempotency_key = '42000000-0000-4000-8000-000000000010'
    )
    and (
      select pg_catalog.count(*) = 1
      from audit.events as event
      where event.actor_user_id = '40000000-0000-4000-8000-000000000010'
        and event.action = 'owner.activated'
        and event.request_id in (
          '45000000-0000-4000-8000-000000000010',
          '45000000-0000-4000-8000-000000000011'
        )
        and event.request_id <> '42000000-0000-4000-8000-000000000010'
    ),
  'activate concorrente mantém idempotência e audita o request vencedor separadamente'
);

do $concurrent_prepare$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat004_prepare_a',
    'feat004_prepare_b'
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

    perform extensions.dblink_send_query(
      connection_name,
      $remote$
        select operation_id, operation_sequence
        from private.prepare_owner_recipient_operation(
          '40000000-0000-4000-8000-000000000010',
          'start',
          '43000000-0000-4000-8000-000000000010'
        )
      $remote$
    );
  end loop;
end;
$concurrent_prepare$;

do $collect_concurrent_prepare$
begin
  begin
    insert into feat004_concurrency_results (
      label, operation_id, operation_sequence
    )
    select 'prepare-a', result.operation_id, result.operation_sequence
    from extensions.dblink_get_result('feat004_prepare_a')
      as result(operation_id uuid, operation_sequence bigint);
  exception when others then
    insert into feat004_concurrency_results (label, error_message)
    values ('prepare-a', sqlstate || ':' || sqlerrm);
  end;

  begin
    insert into feat004_concurrency_results (
      label, operation_id, operation_sequence
    )
    select 'prepare-b', result.operation_id, result.operation_sequence
    from extensions.dblink_get_result('feat004_prepare_b')
      as result(operation_id uuid, operation_sequence bigint);
  exception when others then
    insert into feat004_concurrency_results (label, error_message)
    values ('prepare-b', sqlstate || ':' || sqlerrm);
  end;
end;
$collect_concurrent_prepare$;

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.count(distinct result.operation_id) = 1
      and pg_catalog.bool_and(result.operation_sequence = 1)
      and pg_catalog.bool_and(result.error_message is null)
    from feat004_concurrency_results as result
    where result.label in ('prepare-a', 'prepare-b')
  )
    and (
      select pg_catalog.count(*) = 1
      from private.owner_recipient_operations as operation
      where operation.owner_user_id = '40000000-0000-4000-8000-000000000010'
        and operation.idempotency_key = '43000000-0000-4000-8000-000000000010'
    ),
  'prepare concorrente same-key converge sem 23505 em uma operação'
);

do $disconnect_concurrency$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat004_activate_a',
    'feat004_activate_b',
    'feat004_prepare_a',
    'feat004_prepare_b'
  ]
  loop
    perform extensions.dblink_disconnect(connection_name);
  end loop;
end;
$disconnect_concurrency$;

select ok(
  not exists (
    select 1
    from (
      values
        ('public.owner_profiles'::regclass),
        ('public.owner_payment_recipients'::regclass),
        ('private.owner_activation_requests'::regclass),
        ('private.owner_recipient_operations'::regclass),
        ('audit.events'::regclass)
    ) as expected(relation_oid)
    where expected.relation_oid is null
  ),
  'cinco relações FEAT-004 existem nos schemas deliberados'
);

select ok(
  (
    select pg_catalog.count(*) = 5
      and pg_catalog.bool_and(relation.relrowsecurity)
    from pg_catalog.pg_class as relation
    where relation.oid in (
      'public.owner_profiles'::regclass,
      'public.owner_payment_recipients'::regclass,
      'private.owner_activation_requests'::regclass,
      'private.owner_recipient_operations'::regclass,
      'audit.events'::regclass
    )
  ),
  'todas as relações FEAT-004 possuem RLS habilitada'
);

select ok(
  (
    select attribute.attnotnull
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'audit.events'::regclass
      and attribute.attname = 'idempotency_key'
      and attribute.attnum > 0
      and not attribute.attisdropped
  )
    and exists (
      select 1
      from pg_catalog.pg_constraint as constraint_record
      where constraint_record.conrelid = 'audit.events'::regclass
        and constraint_record.conname =
          'events_action_target_id_idempotency_key_key'
        and constraint_record.contype = 'u'
        and constraint_record.convalidated
        and pg_catalog.pg_get_constraintdef(constraint_record.oid) =
          'UNIQUE (action, target_id, idempotency_key)'
    )
    and not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_record
      where constraint_record.conrelid = 'audit.events'::regclass
        and constraint_record.conname =
          'events_action_target_id_request_id_key'
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_record
      where trigger_record.tgrelid = 'audit.events'::regclass
        and trigger_record.tgname = 'audit_events_protect_append_only'
        and not trigger_record.tgisinternal
        and trigger_record.tgenabled = 'O'
    )
    and pg_catalog.strpos(
      pg_catalog.pg_get_functiondef(
        'private.protect_audit_event()'::regprocedure
      ),
      'new.idempotency_key is not distinct from old.idempotency_key'
    ) > 0,
  'auditoria separa correlação/dedup e mantém proteção append-only habilitada'
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(policy.polcmd = 'r')
    from pg_catalog.pg_policy as policy
    where policy.polrelid in (
      'public.owner_profiles'::regclass,
      'public.owner_payment_recipients'::regclass
    )
  )
    and not exists (
      select 1
      from pg_catalog.pg_policy as policy
      where policy.polrelid in (
        'private.owner_activation_requests'::regclass,
        'private.owner_recipient_operations'::regclass,
        'audit.events'::regclass
      )
    ),
  'somente tabelas públicas seguras têm policy e ela é select-own'
);

select ok(
  not exists (
    select 1
    from (
      values ('public'::name), ('anon'::name), ('authenticated'::name),
        ('service_role'::name), ('app_dal'::name)
    ) as monitored(role_name)
    cross join (
      values
        ('private.owner_activation_requests'::regclass),
        ('private.owner_recipient_operations'::regclass),
        ('audit.events'::regclass)
    ) as protected(relation_oid)
    where pg_catalog.has_table_privilege(
      monitored.role_name,
      protected.relation_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
  ),
  'estado provider, idempotência e auditoria não possuem grants runtime'
);

select ok(
  not pg_catalog.has_table_privilege(
      'authenticated', 'public.owner_profiles', 'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'authenticated', 'public.owner_payment_recipients', 'SELECT'
    )
    and not exists (
      select 1
      from (
        values
          ('public.owner_profiles'::regclass, 'user_id'::name),
          ('public.owner_profiles'::regclass, 'status'::name),
          ('public.owner_profiles'::regclass, 'accepted_owner_contract_version_id'::name),
          ('public.owner_profiles'::regclass, 'owner_version'::name),
          ('public.owner_profiles'::regclass, 'activated_at'::name),
          ('public.owner_payment_recipients'::regclass, 'owner_user_id'::name),
          ('public.owner_payment_recipients'::regclass, 'status'::name),
          ('public.owner_payment_recipients'::regclass, 'requirements'::name),
          ('public.owner_payment_recipients'::regclass, 'profile_version_synced'::name),
          ('public.owner_payment_recipients'::regclass, 'recipient_version'::name)
      ) as required(relation_oid, column_name)
      where not pg_catalog.has_column_privilege(
        'authenticated', required.relation_oid, required.column_name, 'SELECT'
      )
    ),
  'authenticated recebe somente a projeção por coluna necessária ao invoker'
);

select ok(
  not pg_catalog.has_column_privilege(
      'authenticated', 'public.owner_profiles', 'created_at', 'SELECT'
    )
    and not pg_catalog.has_column_privilege(
      'authenticated', 'public.owner_profiles', 'updated_at', 'SELECT'
    )
    and not pg_catalog.has_column_privilege(
      'authenticated', 'public.owner_payment_recipients', 'created_at', 'SELECT'
    )
    and not pg_catalog.has_column_privilege(
      'authenticated', 'public.owner_payment_recipients', 'updated_at', 'SELECT'
    )
    and not exists (
      select 1
      from (
        values ('anon'::name), ('service_role'::name), ('app_dal'::name)
      ) as monitored(role_name)
      cross join (
        values
          ('public.owner_profiles'::regclass),
          ('public.owner_payment_recipients'::regclass)
      ) as protected(relation_oid)
      where pg_catalog.has_any_column_privilege(
        monitored.role_name, protected.relation_oid, 'SELECT'
      )
    ),
  'timestamps internos e projeções públicas não vazam para roles excedentes'
);

select ok(
  not exists (
    select 1
    from (
      values ('public'::name), ('anon'::name), ('authenticated'::name),
        ('service_role'::name), ('app_dal'::name)
    ) as monitored(role_name)
    cross join (
      values
        ('public.owner_profiles'::regclass),
        ('public.owner_payment_recipients'::regclass)
    ) as protected(relation_oid)
    where pg_catalog.has_table_privilege(
      monitored.role_name,
      protected.relation_oid,
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
  ),
  'nenhuma role runtime escreve diretamente estado de dono ou recebedor'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('public.get_owner_activation_status()'::text),
        ('public.get_owner_recipient_status()'::text)
    ) as projection(signature)
    join pg_catalog.pg_proc as routine
      on routine.oid = projection.signature::pg_catalog.regprocedure
    where routine.prosecdef
      or routine.provolatile <> 's'
      or routine.pronargs <> 0
      or not ('search_path=""' = any(routine.proconfig))
      or not pg_catalog.has_function_privilege(
        'authenticated', projection.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'public', projection.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'anon', projection.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'service_role', projection.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'app_dal', projection.signature, 'EXECUTE'
      )
  ),
  'projeções activation/recipient são invoker sem UUID e somente authenticated'
);

select ok(
  (
    select not routine.prosecdef
      and routine.provolatile = 's'
      and routine.pronargs = 0
      and 'search_path=""' = any(routine.proconfig)
    from pg_catalog.pg_proc as routine
    where routine.oid =
      'public.get_current_owner_contract()'::pg_catalog.regprocedure
  )
    and pg_catalog.has_function_privilege(
      'authenticated', 'public.get_current_owner_contract()', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'public', 'public.get_current_owner_contract()', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'anon', 'public.get_current_owner_contract()', 'EXECUTE'
    ),
  'contrato do dono tem RPC dedicado invoker e autenticado'
);

select is(
  (
    select pg_catalog.jsonb_agg(legal.kind order by legal.kind)
    from public.get_current_legal_terms() as legal
  ),
  '["privacy", "terms"]'::jsonb,
  'read model jurídico geral permanece exatamente terms e privacy'
);

select is(
  (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('kind', contract.kind, 'source', contract.source)
    )
    from public.get_current_owner_contract() as contract
  ),
  '[{"kind":"owner_contract","source":"local_fixture"}]'::jsonb,
  'RPC do dono retorna exatamente um owner_contract local vigente'
);

set local role anon;
select pg_catalog.set_config(
  'set_livre.test.anon_legal_visibility',
  (
    select pg_catalog.jsonb_build_object(
      'count', pg_catalog.count(*),
      'kinds', pg_catalog.jsonb_agg(legal_version.kind order by legal_version.kind),
      'ownerContracts', pg_catalog.count(*) filter (
        where legal_version.kind = 'owner_contract'
      )
    )::text
    from public.terms_versions as legal_version
  ),
  true
);
reset role;

select is(
  pg_catalog.current_setting('set_livre.test.anon_legal_visibility')::jsonb,
  '{"count":2,"kinds":["privacy","terms"],"ownerContracts":0}'::jsonb,
  'RLS anon vê exatamente terms/privacy e nenhum owner_contract'
);

set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.authenticated_legal_visibility',
  (
    select pg_catalog.jsonb_build_object(
      'count', pg_catalog.count(*),
      'kinds', pg_catalog.jsonb_agg(legal_version.kind order by legal_version.kind),
      'ownerContracts', pg_catalog.count(*) filter (
        where legal_version.kind = 'owner_contract'
      )
    )::text
    from public.terms_versions as legal_version
  ),
  true
);
reset role;

select is(
  pg_catalog.current_setting('set_livre.test.authenticated_legal_visibility')::jsonb,
  '{"count":3,"kinds":["owner_contract","privacy","terms"],"ownerContracts":1}'::jsonb,
  'RLS authenticated vê os três documentos vigentes e um owner_contract'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('private.get_owner_recipient_status_for_user(uuid)'::text),
        ('private.activate_owner(uuid,uuid,uuid,uuid,text)'::text),
        ('private.prepare_owner_recipient_operation(uuid,text,uuid)'::text),
        ('private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'::text)
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
  )
    and pg_catalog.to_regprocedure(
      'private.activate_owner(uuid,uuid,uuid,text)'
    ) is null
    and pg_catalog.to_regprocedure(
      'private.apply_owner_recipient_operation(uuid,uuid,text,text,text,text[])'
    ) is null,
  'quatro entrypoints privados executam somente por app_dal'
);

select ok(
  (
    select pg_catalog.count(*) = 4
      and pg_catalog.bool_and(routine.prosecdef)
      and pg_catalog.bool_and('search_path=""' = any(routine.proconfig))
    from pg_catalog.pg_proc as routine
    where routine.oid in (
      'private.get_owner_recipient_status_for_user(uuid)'::regprocedure,
      'private.activate_owner(uuid,uuid,uuid,uuid,text)'::regprocedure,
      'private.prepare_owner_recipient_operation(uuid,text,uuid)'::regprocedure,
      'private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'::regprocedure
    )
  ),
  'quatro entrypoints privados usam definer e search_path vazio'
);

select ok(
  (
    select pg_catalog.count(*) = 16
    from pg_catalog.pg_proc as routine
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    join pg_catalog.pg_roles as role on role.oid = privilege.grantee
    where role.rolname = 'app_dal'
      and privilege.privilege_type = 'EXECUTE'
      and not privilege.is_grantable
  ),
  'app_dal mantém allowlist exata de dezesseis rotinas'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid in (
      'public.owner_profiles'::regclass,
      'public.owner_payment_recipients'::regclass
    )
      and attribute.attname in (
        'name', 'phone', 'phone_e164', 'tax_id', 'additional_document',
        'provider', 'provider_reference', 'recipient_id'
      )
      and attribute.attnum > 0
      and not attribute.attisdropped
  ),
  'tabelas públicas owner não duplicam PII nem referência do provider'
);

select ok(
  (
    select index_definition.indisvalid
      and index_definition.indisready
      and pg_catalog.pg_get_expr(
        index_definition.indpred,
        index_definition.indrelid
      ) = '(actor_user_id IS NOT NULL)'
    from pg_catalog.pg_index as index_definition
    join pg_catalog.pg_class as index_relation
      on index_relation.oid = index_definition.indexrelid
    where index_relation.relname = 'audit_events_actor_user_id_idx'
      and index_definition.indrelid = 'audit.events'::regclass
  ),
  'FK SET NULL de audit usa índice estrutural parcial por actor_user_id'
);

select ok(
  (
    select pg_catalog.array_agg(attribute.attname order by attribute.attnum)
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid =
      'private.owner_recipient_operations'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
  ) @> array['owner_user_id', 'provider_reference']::name[],
  'referência provider existe exclusivamente na operação privada'
);

select private.feat004_create_user(
  '40000000-0000-4000-8000-000000000001',
  'qa-feat004-a@setlivre.local',
  '41000000-0000-4000-8000-000000000001'
);
select private.feat004_create_user(
  '40000000-0000-4000-8000-000000000002',
  'qa-feat004-b@setlivre.local',
  '41000000-0000-4000-8000-000000000002'
);
select private.feat004_create_user(
  '40000000-0000-4000-8000-000000000003',
  'qa-feat004-owner-persona@setlivre.local',
  '41000000-0000-4000-8000-000000000003'
);
select private.feat004_create_user(
  '40000000-0000-4000-8000-000000000004',
  'qa-feat004-admin-persona@setlivre.local',
  '41000000-0000-4000-8000-000000000004'
);

update auth.users
set raw_app_meta_data = raw_app_meta_data ||
  '{"set_livre_test_persona":"owner"}'::jsonb
where id = '40000000-0000-4000-8000-000000000003';

update auth.users
set raw_app_meta_data = raw_app_meta_data ||
  '{"set_livre_test_persona":"application_admin"}'::jsonb
where id = '40000000-0000-4000-8000-000000000004';

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select private.complete_profile(
  '40000000-0000-4000-8000-000000000001', 0, 'individual',
  'Pessoa Dona A', '+5541991112233', '28001238938', null
);
select private.complete_profile(
  '40000000-0000-4000-8000-000000000002', 0, 'individual',
  'Pessoa Dona B', '+5541992223344', '52998224725', null
);
select private.complete_profile(
  '40000000-0000-4000-8000-000000000003', 0, 'individual',
  'Persona Owner', '+5541993334455', '39053344705', null
);
select private.complete_profile(
  '40000000-0000-4000-8000-000000000004', 0, 'individual',
  'Persona Admin', '+5541994445566', '16899535009', null
);

reset role;
grant app_dal to postgres with inherit false, set false;

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '40000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.initial_read_model',
  coalesce((
    select pg_catalog.jsonb_build_object(
      'scope', status.scope,
      'ownerStatus', status.owner_status,
      'recipientStatus', status.recipient_status,
      'requirements', status.requirements,
      'nextAction', status.next_action,
      'ownerVersion', status.owner_version,
      'recipientVersion', status.recipient_version,
      'eligible', status.reservations_eligible,
      'providerMode', status.provider_mode
    )
    from public.get_owner_recipient_status() as status
  )::text, 'null'),
  true
);
reset role;

select is(
  pg_catalog.current_setting('set_livre.test.initial_read_model')::jsonb,
  '{
    "scope":"40000000-0000-4000-8000-000000000001",
    "ownerStatus":"inactive",
    "recipientStatus":"not_started",
    "requirements":[],
    "nextAction":"activate_owner",
    "ownerVersion":0,
    "recipientVersion":0,
    "eligible":false,
    "providerMode":"local"
  }'::jsonb,
  'read model inicial é seguro, factual e fechado para reserva'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '40000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.rls_b_owner_count',
  (select pg_catalog.count(*)::text from public.owner_profiles),
  true
);
reset role;

select is(
  pg_catalog.current_setting('set_livre.test.rls_b_owner_count')::bigint,
  0::bigint,
  'RLS B não lê autoridade owner inexistente ou alheia'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.activation_result_ok',
  coalesce((
    select result.owner_status = 'active'
      and result.owner_contract_accepted
      and result.owner_version = 1
      and result.recipient_status = 'not_started'
      and result.next_action = 'start_onboarding'
      and not result.reservations_eligible
    from private.activate_owner(
      '40000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000204',
      '42000000-0000-4000-8000-000000000001',
      '45000000-0000-4000-8000-000000000001',
      pg_catalog.repeat('a', 64)
    ) as result
  )::text, 'false'),
  true
);

select pg_catalog.set_config(
  'set_livre.test.activation_replay_result',
  coalesce((
    select pg_catalog.jsonb_build_object(
      'ownerVersion', result.owner_version,
      'recipientVersion', result.recipient_version,
      'accepted', result.owner_contract_accepted
    )
    from private.activate_owner(
      '40000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000204',
      '42000000-0000-4000-8000-000000000001',
      '45000000-0000-4000-8000-000000000101',
      pg_catalog.repeat('a', 64)
    ) as result
  )::text, 'null'),
  true
);

reset role;
grant app_dal to postgres with inherit false, set false;

select ok(
  pg_catalog.current_setting('set_livre.test.activation_result_ok')::boolean,
  'activate cria autoridade, aceite vigente e recipient not_started atomicamente'
);

select is(
  pg_catalog.current_setting('set_livre.test.activation_replay_result')::jsonb,
  '{"ownerVersion":1,"recipientVersion":0,"accepted":true}'::jsonb,
  'replay exato da ativação é idempotente'
);

select matches(
  private.feat004_capture_error(
    $command$
      select * from private.activate_owner(
        '40000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000204',
        '42000000-0000-4000-8000-000000000001',
        '45000000-0000-4000-8000-000000000102',
        repeat('b', 64)
      )
    $command$
  ),
  '^NO_ERROR$',
  'evidência não reescreve fato no replay já aplicado'
);

select is(
  private.feat004_capture_error(
    $command$
      select * from private.activate_owner(
        '40000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000201',
        '42000000-0000-4000-8000-000000000002',
        '45000000-0000-4000-8000-000000000103',
        null
      )
    $command$
  ),
  '23514:owner_contract_stale',
  'ativação recusa kind/version contratual incorreta'
);

select is(
  private.feat004_capture_error(
    $command$
      select * from private.activate_owner(
        '40000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000204',
        '42000000-0000-4000-8000-000000000104',
        null::uuid,
        null::text
      )
    $command$
  ),
  '22023:invalid_owner_activation',
  'ativação exige request ID autoritativo sem reaproveitar idempotência'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.start_operation_id',
  (
    select operation.operation_id::text
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'start',
      '43000000-0000-4000-8000-000000000001'
    ) as operation
  ),
  true
);

select pg_catalog.set_config(
  'set_livre.test.prepare_start_replay_ok',
  coalesce((
    select not operation.already_applied
      and operation.operation_sequence = 1
      and operation.operation_action = 'start'
      and operation.provider_reference is null
      and operation.profile_version = 1
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'start',
      '43000000-0000-4000-8000-000000000001'
    ) as operation
  )::text, 'false'),
  true
);

select pg_catalog.set_config(
  'set_livre.test.apply_start_ok',
  coalesce((
    select result.recipient_status = 'pending'
      and result.requirements = array['identity_review']::text[]
      and result.profile_version_synced = 1
      and result.recipient_version = 1
      and result.next_action = 'refresh_status'
      and not result.reservations_eligible
    from private.apply_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.start_operation_id')::uuid,
      '45100000-0000-4000-8000-000000000001',
      'local',
      'local-recipient:' || pg_catalog.current_setting('set_livre.test.start_operation_id'),
      'pending',
      array['identity_review']::text[]
    ) as result
  )::text, 'false'),
  true
);

select pg_catalog.set_config(
  'set_livre.test.prepare_start_applied_replay_ok',
  coalesce((
    select operation.already_applied
      and operation.operation_sequence = 1
      and operation.provider_reference =
        'local-recipient:' || operation.operation_id::text
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'start',
      '43000000-0000-4000-8000-000000000001'
    ) as operation
  )::text, 'false'),
  true
);

select pg_catalog.set_config(
  'set_livre.test.refresh_operation_id',
  (
    select operation.operation_id::text
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'refresh',
      '43000000-0000-4000-8000-000000000002'
    ) as operation
  ),
  true
);

select pg_catalog.set_config(
  'set_livre.test.prepare_refresh_ok',
  coalesce((
    select operation.operation_sequence = 2
      and operation.operation_action = 'refresh'
      and operation.provider_reference =
        'local-recipient:' || pg_catalog.current_setting('set_livre.test.start_operation_id')
      and not operation.already_applied
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'refresh',
      '43000000-0000-4000-8000-000000000002'
    ) as operation
  )::text, 'false'),
  true
);

select pg_catalog.set_config(
  'set_livre.test.apply_refresh_ok',
  coalesce((
    select result.recipient_status = 'active'
      and result.requirements = '{}'::text[]
      and result.profile_version_synced = result.profile_version
      and result.recipient_version = 2
      and result.next_action = 'none'
      and result.reservations_eligible
    from private.apply_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.refresh_operation_id')::uuid,
      '45100000-0000-4000-8000-000000000001',
      'local',
      'local-recipient:' || pg_catalog.current_setting('set_livre.test.start_operation_id'),
      'active',
      '{}'::text[]
    ) as result
  )::text, 'false'),
  true
);

reset role;
grant app_dal to postgres with inherit false, set false;

select ok(
  pg_catalog.current_setting('set_livre.test.prepare_start_replay_ok')::boolean,
  'prepare replay preserva a primeira operação pendente'
);

select ok(
  pg_catalog.current_setting('set_livre.test.apply_start_ok')::boolean,
  'apply start nominal materializa pending e requirement allowlisted'
);

select ok(
  pg_catalog.current_setting(
    'set_livre.test.prepare_start_applied_replay_ok'
  )::boolean,
  'prepare aplicado sinaliza replay sem nova chamada provider'
);

select ok(
  pg_catalog.current_setting('set_livre.test.prepare_refresh_ok')::boolean,
  'refresh herda somente a referência privada aplicada mais recente'
);

select ok(
  pg_catalog.current_setting('set_livre.test.apply_refresh_ok')::boolean,
  'refresh nominal ativa recebedor e deriva elegibilidade completa'
);

select is(
  private.feat004_capture_error(
    pg_catalog.format(
      $command$
        select * from private.apply_owner_recipient_operation(
          '40000000-0000-4000-8000-000000000001',
          %L::uuid,
          '45100000-0000-4000-8000-000000000102',
          'local',
          %L,
          'refused',
          array['additional_information']::text[]
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.refresh_operation_id'),
      'local-recipient:' || pg_catalog.current_setting('set_livre.test.start_operation_id')
    )
  ),
  '40001:recipient_apply_conflict',
  'apply replay divergente não reescreve resultado aplicado'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select private.update_profile_identity(
  '40000000-0000-4000-8000-000000000001',
  1,
  'Pessoa Dona A Corrigida',
  '+5541991112233',
  false,
  null,
  false,
  null
);
reset role;
grant app_dal to postgres with inherit false, set false;

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '40000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.profile_drift_read_ok',
  coalesce((
    select not result.reservations_eligible
      and result.profile_version = 2
      and result.profile_version_synced = 1
      and result.next_action = 'refresh_status'
    from public.get_owner_recipient_status() as result
  )::text, 'false'),
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.profile_drift_read_ok')::boolean,
  'mudança de perfil fecha elegibilidade sem persistir booleano stale'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.drift_operation_id',
  (
    select operation.operation_id::text
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'refresh',
      '43000000-0000-4000-8000-000000000003'
    ) as operation
  ),
  true
);

select private.update_profile_identity(
  '40000000-0000-4000-8000-000000000001',
  2,
  'Pessoa Dona A Nova Correção',
  '+5541991112233',
  false,
  null,
  false,
  null
);

reset role;
grant app_dal to postgres with inherit false, set false;

select is(
  private.feat004_capture_error(
    pg_catalog.format(
      $command$
        select * from private.apply_owner_recipient_operation(
          '40000000-0000-4000-8000-000000000001',
          %L::uuid,
          '45100000-0000-4000-8000-000000000103',
          'local',
          %L,
          'active',
          '{}'::text[]
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.drift_operation_id'),
      'local-recipient:' || pg_catalog.current_setting('set_livre.test.start_operation_id')
    )
  ),
  '40001:recipient_profile_version_changed',
  'apply falha fechado quando profile muda durante provider fora da transação'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.latest_operation_id',
  (
    select operation.operation_id::text
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'refresh',
      '43000000-0000-4000-8000-000000000004'
    ) as operation
  ),
  true
);

reset role;
grant app_dal to postgres with inherit false, set false;

select is(
  private.feat004_capture_error(
    pg_catalog.format(
      $command$
        select * from private.apply_owner_recipient_operation(
          '40000000-0000-4000-8000-000000000001',
          %L::uuid,
          '45100000-0000-4000-8000-000000000104',
          'local',
          %L,
          'active',
          '{}'::text[]
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.drift_operation_id'),
      'local-recipient:' || pg_catalog.current_setting('set_livre.test.start_operation_id')
    )
  ),
  '40001:recipient_operation_superseded',
  'resultado tardio de sequência anterior é recusado após novo prepare'
);

select is(
  private.feat004_capture_error(
    pg_catalog.format(
      $command$
        select * from private.apply_owner_recipient_operation(
          '40000000-0000-4000-8000-000000000001',
          %L::uuid,
          '45100000-0000-4000-8000-000000000105',
          'local',
          'local-test-fixture:refused',
          'active',
          '{}'::text[]
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.latest_operation_id')
    )
  ),
  '23514:recipient_provider_reference_changed',
  'refresh não aceita referência diferente da preparada pelo servidor'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.apply_refused_ok',
  coalesce((
    select result.recipient_status = 'refused'
      and result.requirements = array['additional_information']::text[]
      and result.next_action = 'start_onboarding'
    from private.apply_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.latest_operation_id')::uuid,
      '45100000-0000-4000-8000-000000000003',
      'local',
      'local-recipient:' || pg_catalog.current_setting('set_livre.test.start_operation_id'),
      'refused',
      array['additional_information']::text[]
    ) as result
  )::text, 'false'),
  true
);

select pg_catalog.set_config(
  'set_livre.test.retry_operation_id',
  (
    select operation.operation_id::text
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'start',
      '43000000-0000-4000-8000-000000000005'
    ) as operation
  ),
  true
);

select pg_catalog.set_config(
  'set_livre.test.restart_reference_ok',
  coalesce((
    select operation.provider_reference is null
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'start',
      '43000000-0000-4000-8000-000000000005'
    ) as operation
  )::text, 'false'),
  true
);

select pg_catalog.set_config(
  'set_livre.test.apply_restart_ok',
  coalesce((
    select result.recipient_status = 'pending'
      and result.next_action = 'refresh_status'
    from private.apply_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.retry_operation_id')::uuid,
      '45100000-0000-4000-8000-000000000004',
      'local',
      'local-recipient:' || pg_catalog.current_setting('set_livre.test.retry_operation_id'),
      'pending',
      array['identity_review']::text[]
    ) as result
  )::text, 'false'),
  true
);

reset role;
grant app_dal to postgres with inherit false, set false;

select pg_catalog.set_config(
  'set_livre.test.block_operation_id',
  (
    select operation.operation_id::text
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'refresh',
      '43000000-0000-4000-8000-000000000006'
    ) as operation
  ),
  true
);

-- A referência fixture é controlada por postgres/teste, nunca por app_dal/web.
update private.owner_recipient_operations as operation
set provider_reference = 'local-test-fixture:blocked'
where operation.id =
  pg_catalog.current_setting('set_livre.test.block_operation_id')::uuid;

select pg_catalog.set_config(
  'set_livre.test.apply_blocked_ok',
  coalesce((
    select result.recipient_status = 'blocked'
      and result.next_action = 'none'
      and not result.reservations_eligible
    from private.apply_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.block_operation_id')::uuid,
      '45100000-0000-4000-8000-000000000005',
      'local',
      'local-test-fixture:blocked',
      'blocked',
      array['provider_contact']::text[]
    ) as result
  )::text, 'false'),
  true
);

select ok(
  pg_catalog.current_setting('set_livre.test.apply_refused_ok')::boolean,
  'matriz aceita active para refused por resultado refresh allowlisted'
);

select ok(
  pg_catalog.current_setting('set_livre.test.restart_reference_ok')::boolean,
  'restart após refused não transporta referência provider anterior'
);

select ok(
  pg_catalog.current_setting('set_livre.test.apply_restart_ok')::boolean,
  'matriz aceita refused para pending em nova tentativa start'
);

select ok(
  pg_catalog.current_setting('set_livre.test.apply_blocked_ok')::boolean,
  'resultado fixture privado pode levar pending a blocked terminal'
);

select is(
  private.feat004_capture_error(
    $command$
      select * from private.prepare_owner_recipient_operation(
        '40000000-0000-4000-8000-000000000001',
        'refresh',
        '43000000-0000-4000-8000-000000000007'
      )
    $command$
  ),
  '42501:recipient_blocked',
  'blocked é terminal também no prepare'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.blocked_replay_ok',
  coalesce((
    select operation.already_applied
      and operation.operation_id =
        pg_catalog.current_setting('set_livre.test.block_operation_id')::uuid
      and operation.operation_action = 'refresh'
    from private.prepare_owner_recipient_operation(
      '40000000-0000-4000-8000-000000000001',
      'refresh',
      '43000000-0000-4000-8000-000000000006'
    ) as operation
  )::text, 'false'),
  true
);
reset role;
grant app_dal to postgres with inherit false, set false;

select ok(
  pg_catalog.current_setting('set_livre.test.blocked_replay_ok')::boolean,
  'retry aplicado converge mesmo após recipient avançar a blocked terminal'
);

select is(
  private.feat004_capture_error(
    $command$
      update public.owner_payment_recipients
      set status = 'active', requirements = '{}'::text[]
      where owner_user_id = '40000000-0000-4000-8000-000000000001'
    $command$
  ),
  '23514:recipient_transition_invalid',
  'trigger canônico impede saída direta de blocked'
);

select ok(
  (
    select pg_catalog.count(*) = 6
      and pg_catalog.bool_and(event.actor_user_id =
        '40000000-0000-4000-8000-000000000001')
      and pg_catalog.bool_and(event.ip_hash is null)
      and pg_catalog.bool_and(event.request_id <> event.idempotency_key)
      and pg_catalog.count(distinct event.request_id) = 5
      and pg_catalog.bool_and(
        event.metadata::text !~* 'provider|reference|email|phone|tax'
      )
      and pg_catalog.array_agg(event.request_id order by event.request_id) = array[
        '45000000-0000-4000-8000-000000000001',
        '45100000-0000-4000-8000-000000000001',
        '45100000-0000-4000-8000-000000000001',
        '45100000-0000-4000-8000-000000000003',
        '45100000-0000-4000-8000-000000000004',
        '45100000-0000-4000-8000-000000000005'
      ]::uuid[]
      and pg_catalog.array_agg(
        event.idempotency_key order by event.idempotency_key
      ) = array[
        '42000000-0000-4000-8000-000000000001',
        '43000000-0000-4000-8000-000000000001',
        '43000000-0000-4000-8000-000000000002',
        '43000000-0000-4000-8000-000000000004',
        '43000000-0000-4000-8000-000000000005',
        '43000000-0000-4000-8000-000000000006'
      ]::uuid[]
    from audit.events as event
    where event.actor_user_id = '40000000-0000-4000-8000-000000000001'
  ),
  'auditoria separa requests/idempotência, aceita request reutilizado e preserva replay'
);

create function private.feat004_attempt_audit_delete()
returns text
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  delete from audit.events
  where actor_user_id = '40000000-0000-4000-8000-000000000001';
  return 'NO_ERROR';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$function$;

revoke all on function private.feat004_attempt_audit_delete()
  from public, anon, authenticated, service_role;
grant execute on function private.feat004_attempt_audit_delete()
  to app_dal;

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.app_dal_audit_delete_result',
  private.feat004_attempt_audit_delete(),
  true
);
reset role;
grant app_dal to postgres with inherit false, set false;

select matches(
  pg_catalog.current_setting('set_livre.test.app_dal_audit_delete_result'),
  '^42501:',
  'app_dal não apaga auditoria mesmo quando invocada por sessão postgres'
);

drop function private.feat004_attempt_audit_delete();

select lives_ok(
  $command$
    delete from audit.events
    where actor_user_id = '40000000-0000-4000-8000-000000000001'
  $command$,
  'postgres administrativo exato pode limpar fixture QA'
);

select private.feat004_create_user(
  '40000000-0000-4000-8000-000000000005',
  'qa-feat004-audit-retention@setlivre.local',
  '41000000-0000-4000-8000-000000000005'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select private.complete_profile(
  '40000000-0000-4000-8000-000000000005', 0, 'individual',
  'Pessoa Retenção', '+5541995556677', '11144477735', null
);
select private.activate_owner(
  '40000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000204',
  '42000000-0000-4000-8000-000000000005',
  '45000000-0000-4000-8000-000000000005',
  null
);
reset role;
grant app_dal to postgres with inherit false, set false;

delete from auth.users
where id = '40000000-0000-4000-8000-000000000005';

select ok(
  exists (
    select 1
    from audit.events as event
    where event.request_id = '45000000-0000-4000-8000-000000000005'
      and event.request_id <> '42000000-0000-4000-8000-000000000005'
      and event.actor_user_id is null
      and event.target_id = '40000000-0000-4000-8000-000000000005'
  ),
  'cascade Auth preserva fato correlacionado ao request sem confundir idempotência'
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select private.activate_owner(
  '40000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000204',
  '42000000-0000-4000-8000-000000000020',
  '45000000-0000-4000-8000-000000000020',
  null
);
reset role;
grant app_dal to postgres with inherit false, set false;

do $contract_transition$
declare
  transition_at timestamptz :=
    pg_catalog.transaction_timestamp() - interval '1 microsecond';
begin
  alter table public.terms_versions
    disable trigger terms_versions_protect_immutability;

  update public.terms_versions
  set retired_at = transition_at
  where id = '00000000-0000-4000-8000-000000000204';

  insert into public.terms_versions (
    id, kind, version, title, body_markdown, source, effective_at
  )
  values (
    '00000000-0000-4000-8000-000000000205',
    'owner_contract',
    'local-2026-08-13',
    'Contrato do dono — renovação local',
    '# Contrato renovado somente para teste local.',
    'local_fixture',
    transition_at
  );

  alter table public.terms_versions
    enable trigger terms_versions_protect_immutability;
end;
$contract_transition$;

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.renewal_required_ok',
  coalesce((
    select result.owner_status = 'active'
      and not result.owner_contract_accepted
      and result.accepted_owner_contract_version_id =
        '00000000-0000-4000-8000-000000000204'
      and result.owner_contract_id =
        '00000000-0000-4000-8000-000000000205'
      and result.next_action = 'activate_owner'
      and not result.reservations_eligible
    from private.get_owner_recipient_status_for_user(
      '40000000-0000-4000-8000-000000000002'
    ) as result
  )::text, 'false'),
  true
);

select pg_catalog.set_config(
  'set_livre.test.retired_activation_replay_ok',
  coalesce((
    select result.owner_status = 'active'
      and not result.owner_contract_accepted
      and result.owner_contract_id =
        '00000000-0000-4000-8000-000000000205'
    from private.activate_owner(
      '40000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000204',
      '42000000-0000-4000-8000-000000000020',
      '45000000-0000-4000-8000-000000000120',
      null
    ) as result
  )::text, 'false'),
  true
);

select pg_catalog.set_config(
  'set_livre.test.renewal_activation_ok',
  coalesce((
    select result.owner_status = 'active'
      and result.owner_contract_accepted
      and result.accepted_owner_contract_version_id =
        '00000000-0000-4000-8000-000000000205'
      and result.owner_version = 2
    from private.activate_owner(
      '40000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000205',
      '42000000-0000-4000-8000-000000000006',
      '45000000-0000-4000-8000-000000000006',
      null
    ) as result
  )::text, 'false'),
  true
);

reset role;
grant app_dal to postgres with inherit false, set false;

select ok(
  pg_catalog.current_setting('set_livre.test.renewal_required_ok')::boolean,
  'nova versão vigente fecha elegibilidade e exige aceite sem apagar histórico'
);

select ok(
  pg_catalog.current_setting(
    'set_livre.test.retired_activation_replay_ok'
  )::boolean,
  'retry idêntico antigo converge ao fato atual mesmo após aposentadoria'
);

select ok(
  pg_catalog.current_setting('set_livre.test.renewal_activation_ok')::boolean
    and (
      select pg_catalog.count(*) = 1
      from audit.events as event
      where event.actor_user_id = '40000000-0000-4000-8000-000000000002'
        and event.action = 'owner.contract_renewed'
        and event.target_type = 'owner_profile'
        and event.target_id = '40000000-0000-4000-8000-000000000002'
        and event.request_id = '45000000-0000-4000-8000-000000000006'
        and event.idempotency_key = '42000000-0000-4000-8000-000000000006'
    ),
  'dono renova contrato monotonicamente com request e idempotência separados'
);

select is(
  private.feat004_capture_error(
    $command$
      select * from private.activate_owner(
        '40000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000205',
        '42000000-0000-4000-8000-000000000020',
        '45000000-0000-4000-8000-000000000121',
        null
      )
    $command$
  ),
  '40001:owner_idempotency_conflict',
  'key antiga com contrato diferente falha por conflito idempotente'
);

select ok(
  (
    select pg_catalog.count(*) = 2
    from public.terms_acceptances as acceptance
    where acceptance.user_id = '40000000-0000-4000-8000-000000000002'
      and acceptance.terms_version_id in (
        '00000000-0000-4000-8000-000000000204',
        '00000000-0000-4000-8000-000000000205'
      )
  ),
  'renovação preserva aceites owner_contract históricos'
);

select is(
  private.feat004_capture_error(
    $command$
      insert into public.owner_payment_recipients (
        owner_user_id, status, requirements, profile_version_synced,
        recipient_version
      ) values (
        '40000000-0000-4000-8000-000000000003',
        'pending', array['bank_password'], 1, 1
      )
    $command$
  ),
  '23514:recipient_initial_state_invalid',
  'estado inicial e requirement fora da allowlist falham fechados'
);

select is(
  private.feat004_capture_error(
    $command$
      select * from private.prepare_owner_recipient_operation(
        '40000000-0000-4000-8000-000000000002',
        'delete',
        '43000000-0000-4000-8000-000000000099'
      )
    $command$
  ),
  '22023:invalid_recipient_operation',
  'prepare aceita somente start ou refresh'
);

select is(
  private.feat004_capture_error(
    $command$
      select * from private.apply_owner_recipient_operation(
        '40000000-0000-4000-8000-000000000002',
        '44000000-0000-4000-8000-000000000099',
        '45100000-0000-4000-8000-000000000099',
        'pagarme', 'external-reference', 'active', '{}'::text[]
      )
    $command$
  ),
  '22023:invalid_recipient_result',
  'apply aceita somente provider local e referência local allowlisted'
);

select is(
  private.feat004_capture_error(
    $command$
      select * from private.apply_owner_recipient_operation(
        '40000000-0000-4000-8000-000000000002',
        '44000000-0000-4000-8000-000000000099',
        null::uuid,
        'local',
        'local-recipient:44000000-0000-4000-8000-000000000099',
        'active',
        '{}'::text[]
      )
    $command$
  ),
  '22023:invalid_recipient_result',
  'apply exige request ID da fachada antes de consultar a operação'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '40000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.owner_persona_isolated',
  ((select pg_catalog.count(*) = 0 from public.owner_profiles)
    and (select pg_catalog.count(*) = 0 from public.owner_payment_recipients)
    and not pg_catalog.has_schema_privilege(current_user, 'private', 'USAGE')
    and not pg_catalog.has_schema_privilege(current_user, 'audit', 'USAGE'))::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.owner_persona_isolated')::boolean,
  'persona owner adversarial não ganha autoridade, dados alheios ou schemas privados'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '40000000-0000-4000-8000-000000000004',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.admin_persona_isolated',
  ((select pg_catalog.count(*) = 0 from public.owner_profiles)
    and (select pg_catalog.count(*) = 0 from public.owner_payment_recipients)
    and not pg_catalog.has_schema_privilege(current_user, 'private', 'USAGE')
    and not pg_catalog.has_schema_privilege(current_user, 'audit', 'USAGE'))::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.admin_persona_isolated')::boolean,
  'persona admin adversarial não bypassa ownership ou superfície privada'
);

select is(
  (
    select pg_catalog.count(*)
    from public.get_current_legal_terms()
  ),
  2::bigint,
  'owner_contract nunca amplia o read model público geral além de dois docs'
);

select ok(
  private.check_readiness('20260815000100'),
  'readiness aceita head FEAT-004 e allowlist DAL ampliada exata'
);

select ok(
  not private.check_readiness('20260812000200'),
  'readiness rejeita predecessor sem correlação de auditoria'
);

select ok(
  (
    select
      routine.proargnames = array[
        'scope','owner_status','owner_version',
        'accepted_owner_contract_version_id','owner_contract_accepted',
        'owner_contract_id','owner_contract_source',
        'owner_contract_effective_at','recipient_status','requirements',
        'next_action','profile_version','profile_version_synced',
        'recipient_version','reservations_eligible','provider_mode'
      ]::text[]
      and (
        select pg_catalog.array_agg(type_oid::regtype::text order by position)
        from pg_catalog.unnest(routine.proallargtypes)
          with ordinality as argument(type_oid, position)
      ) = array[
        'uuid','text','bigint','uuid','boolean','uuid','text',
        'timestamp with time zone','text','text[]','text','bigint','bigint',
        'bigint','boolean','text'
      ]::text[]
      and routine.proargmodes = pg_catalog.array_fill(
        't'::"char", array[16]
      )
    from pg_catalog.pg_proc as routine
    where routine.oid =
      'public.get_owner_recipient_status()'::regprocedure
  )
    and (
      select
        routine.proargnames = array[
          'scope','owner_status','owner_version',
          'accepted_owner_contract_version_id','owner_contract_accepted',
          'owner_contract_id','owner_contract_kind','owner_contract_version',
          'owner_contract_title','owner_contract_body_markdown',
          'owner_contract_content_hash','owner_contract_source',
          'owner_contract_effective_at','recipient_status','requirements',
          'next_action','profile_version','profile_version_synced',
          'recipient_version','reservations_eligible','provider_mode'
        ]::text[]
        and (
          select pg_catalog.array_agg(type_oid::regtype::text order by position)
          from pg_catalog.unnest(routine.proallargtypes)
            with ordinality as argument(type_oid, position)
        ) = array[
          'uuid','text','bigint','uuid','boolean','uuid','text','text','text',
          'text','text','text','timestamp with time zone','text','text[]','text',
          'bigint','bigint','bigint','boolean','text'
        ]::text[]
        and routine.proargmodes = pg_catalog.array_fill(
          't'::"char", array[21]
        )
      from pg_catalog.pg_proc as routine
      where routine.oid =
        'public.get_owner_activation_status()'::regprocedure
    ),
  'recipient mantém 16 colunas sem documento e activation preserva 21 colunas completas'
);

select * from finish();
rollback;

delete from audit.events
where actor_user_id = '40000000-0000-4000-8000-000000000010'
  or target_id = '40000000-0000-4000-8000-000000000010';

delete from auth.users
where id = '40000000-0000-4000-8000-000000000010';

delete from private.signup_legal_intents
where request_id = '41000000-0000-4000-8000-000000000010';
