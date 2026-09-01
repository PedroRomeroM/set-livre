-- FEAT-008: objeto imutável, associação versionada, RLS, idempotência e cleanup.

-- Fixtures concorrentes precisam estar committed para sessões dblink.
delete from audit.events
where actor_user_id = '8f000000-0000-4000-8000-000000000008'
  or target_id = '8f000000-0000-4000-8000-000000000008';
delete from private.studio_command_requests
where owner_user_id = '8f000000-0000-4000-8000-000000000008';
delete from public.studio_revision_media as relation
using public.studio_media as media
where relation.media_id = media.id
  and media.uploaded_by = '8f000000-0000-4000-8000-000000000008';
delete from public.studio_media
where uploaded_by = '8f000000-0000-4000-8000-000000000008';
delete from auth.users
where id = '8f000000-0000-4000-8000-000000000008';

drop table if exists private.feat008_concurrency_fixtures;
create table private.feat008_concurrency_fixtures (
  label text primary key,
  studio_id uuid not null,
  revision_id uuid not null,
  media_id uuid
);
revoke all on table private.feat008_concurrency_fixtures
  from public, anon, authenticated, service_role, app_dal;

do $block$
declare
  legal_intent uuid;
begin
  legal_intent := private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '82300000-0000-4000-8000-000000000003',
    '{}'::jsonb
  );
  insert into auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '8f000000-0000-4000-8000-000000000008',
    'authenticated',
    'authenticated',
    'qa-feat008-concurrency@setlivre.local',
    '',
    pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    pg_catalog.jsonb_build_object('sl_legal_intent', legal_intent::text),
    pg_catalog.now(),
    pg_catalog.now()
  );
  perform private.complete_profile(
    '8f000000-0000-4000-8000-000000000008',
    0,
    'individual',
    'Dono QA Concorrência FEAT 008',
    '+5541999999803',
    '93541134780',
    null
  );
  perform private.activate_owner(
    '8f000000-0000-4000-8000-000000000008',
    '00000000-0000-4000-8000-000000000204',
    '82300000-0000-4000-8000-000000000013',
    '82300000-0000-4000-8000-000000000023',
    null
  );
end;
$block$;

do $block$
declare
  claimed_finalize_studio jsonb;
  claimed_reject_studio jsonb;
  finalize_studio jsonb;
  limit_studio jsonb;
  prepared jsonb;
begin
  limit_studio := private.create_studio(
    '8f000000-0000-4000-8000-000000000008',
    '82300000-0000-4000-8000-000000000101',
    '82300000-0000-4000-8000-000000000111',
    'Estúdio corrida de limite',
    'Fixture committed para disputar de forma real a vigésima vaga de mídia.',
    'Rua da Concorrência',
    '20',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    4,
    '60000000-0000-4000-8000-000000000001'
  );
  finalize_studio := private.create_studio(
    '8f000000-0000-4000-8000-000000000008',
    '82300000-0000-4000-8000-000000000102',
    '82300000-0000-4000-8000-000000000112',
    'Estúdio corrida de finalize',
    'Fixture committed para provar duas finalizações idênticas simultâneas.',
    'Rua da Concorrência',
    '21',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    4,
    '60000000-0000-4000-8000-000000000001'
  );
  claimed_finalize_studio := private.create_studio(
    '8f000000-0000-4000-8000-000000000008',
    '82300000-0000-4000-8000-000000000103',
    '82300000-0000-4000-8000-000000000113',
    'Estúdio ordem de locks finalize',
    'Fixture committed para sobrepor begin e a fachada claimed de finalização.',
    'Rua da Concorrência',
    '22',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    4,
    '60000000-0000-4000-8000-000000000001'
  );
  claimed_reject_studio := private.create_studio(
    '8f000000-0000-4000-8000-000000000008',
    '82300000-0000-4000-8000-000000000104',
    '82300000-0000-4000-8000-000000000114',
    'Estúdio ordem de locks reject',
    'Fixture committed para sobrepor begin e a fachada claimed de rejeição.',
    'Rua da Concorrência',
    '23',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    4,
    '60000000-0000-4000-8000-000000000001'
  );
  insert into private.feat008_concurrency_fixtures (label, studio_id, revision_id)
  values
    (
      'limit',
      (limit_studio ->> 'studioId')::uuid,
      (limit_studio #>> '{revision,id}')::uuid
    ),
    (
      'finalize',
      (finalize_studio ->> 'studioId')::uuid,
      (finalize_studio #>> '{revision,id}')::uuid
    ),
    (
      'claimed_finalize',
      (claimed_finalize_studio ->> 'studioId')::uuid,
      (claimed_finalize_studio #>> '{revision,id}')::uuid
    ),
    (
      'claimed_reject',
      (claimed_reject_studio ->> 'studioId')::uuid,
      (claimed_reject_studio #>> '{revision,id}')::uuid
    );
  prepared := private.prepare_studio_media_upload(
    '8f000000-0000-4000-8000-000000000008',
    (finalize_studio ->> 'studioId')::uuid,
    (finalize_studio #>> '{revision,id}')::uuid,
    1,
    '82300000-0000-4000-8000-000000000121',
    '82300000-0000-4000-8000-000000000131',
    'image/png',
    100,
    null
  );
  update private.feat008_concurrency_fixtures
  set media_id = (prepared ->> 'mediaId')::uuid
  where label = 'finalize';
  prepared := private.prepare_studio_media_upload(
    '8f000000-0000-4000-8000-000000000008',
    (claimed_finalize_studio ->> 'studioId')::uuid,
    (claimed_finalize_studio #>> '{revision,id}')::uuid,
    1,
    '82300000-0000-4000-8000-000000000122',
    '82300000-0000-4000-8000-000000000132',
    'image/png',
    100,
    null
  );
  update private.feat008_concurrency_fixtures
  set media_id = (prepared ->> 'mediaId')::uuid
  where label = 'claimed_finalize';
  prepared := private.prepare_studio_media_upload(
    '8f000000-0000-4000-8000-000000000008',
    (claimed_reject_studio ->> 'studioId')::uuid,
    (claimed_reject_studio #>> '{revision,id}')::uuid,
    1,
    '82300000-0000-4000-8000-000000000123',
    '82300000-0000-4000-8000-000000000133',
    'image/png',
    100,
    null
  );
  update private.feat008_concurrency_fixtures
  set media_id = (prepared ->> 'mediaId')::uuid
  where label = 'claimed_reject';
end;
$block$;

with facts as (
  select fixture.studio_id, fixture.revision_id, pg_catalog.clock_timestamp() as prepared_at
  from private.feat008_concurrency_fixtures as fixture
  where fixture.label = 'limit'
), media_ids as (
  select
    sequence,
    ('89000000-0000-4000-8000-' || pg_catalog.lpad(sequence::text, 12, '0'))::uuid
      as media_id
  from pg_catalog.generate_series(1, 19) as generated(sequence)
)
insert into public.studio_media (
  id, studio_id, prepared_revision_id, uploaded_by, storage_bucket, storage_path,
  preview_storage_path, declared_mime_type, declared_size_bytes, status, prepared_at,
  upload_expires_at, cleanup_after, updated_at
)
select
  media_ids.media_id,
  facts.studio_id,
  facts.revision_id,
  '8f000000-0000-4000-8000-000000000008',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.png',
    '8f000000-0000-4000-8000-000000000008',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '8f000000-0000-4000-8000-000000000008',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  'image/png',
  100,
  'pending_upload',
  facts.prepared_at,
  facts.prepared_at + interval '2 hours',
  facts.prepared_at + interval '24 hours',
  facts.prepared_at
from facts
cross join media_ids;

with facts as (
  select
    fixture.studio_id,
    fixture.revision_id,
    pg_catalog.clock_timestamp() - interval '4 hours' as prepared_at
  from private.feat008_concurrency_fixtures as fixture
  where fixture.label = 'limit'
), media_ids as (
  select
    sequence,
    ('89000000-0000-4000-8000-' || pg_catalog.lpad((100 + sequence)::text, 12, '0'))::uuid
      as media_id
  from pg_catalog.generate_series(1, 2) as generated(sequence)
)
insert into public.studio_media (
  id, studio_id, prepared_revision_id, uploaded_by, storage_bucket, storage_path,
  preview_storage_path, declared_mime_type, declared_size_bytes, status, rejection_code,
  prepared_at, upload_expires_at, rejected_at, cleanup_after, updated_at
)
select
  media_ids.media_id,
  facts.studio_id,
  facts.revision_id,
  '8f000000-0000-4000-8000-000000000008',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.png',
    '8f000000-0000-4000-8000-000000000008',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '8f000000-0000-4000-8000-000000000008',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  'image/png',
  100,
  'rejected',
  'validation_failed',
  facts.prepared_at,
  facts.prepared_at + interval '2 hours',
  facts.prepared_at,
  facts.prepared_at + interval '24 hours',
  facts.prepared_at
from facts
cross join media_ids;

begin;

create function private.feat008_capture_error(command text)
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

create function private.feat008_create_owner(
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
      '82000000-0000-4000-8000-'
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
    'Dono QA FEAT 008',
    '+5541999999800',
    tax_id,
    null
  );

  perform private.activate_owner(
    user_id,
    '00000000-0000-4000-8000-000000000204',
    (
      '82100000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
    (
      '82200000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
    null
  );
end;
$function$;

create function private.feat008_explain_json(command text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  plan jsonb;
begin
  execute 'explain (analyze, buffers, format json) ' || command into plan;
  return plan;
end;
$function$;

revoke all on function private.feat008_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat008_create_owner(uuid, text, text, integer)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat008_explain_json(text)
  from public, anon, authenticated, service_role, app_dal;

select plan(103);

insert into maintenance.studio_media_cleanup_runs (
  run_id,
  function_slug,
  status,
  claimed_count,
  deleted_count,
  failed_count,
  error_code,
  started_at,
  completed_at,
  updated_at
)
values (
  '8c000000-0000-4000-8000-000000000000',
  'media-cleanup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'succeeded',
  0,
  0,
  0,
  null,
  pg_catalog.clock_timestamp() - interval '1 second',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);

select has_table('public', 'studio_media', 'objetos de mídia existem');
select has_table('public', 'studio_revision_media', 'associações versionadas existem');
select has_table(
  'maintenance',
  'studio_media_cleanup_runs',
  'ledger operacional durável de cleanup existe fora da Data API'
);
select has_table(
  'maintenance',
  'studio_media_cleanup_run_items',
  'pertencimento histórico por run existe fora da Data API'
);
select has_table(
  'maintenance',
  'studio_media_cleanup_probes',
  'fila operacional privada do canário real existe fora da Data API'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as constraint_object
    where constraint_object.conrelid = 'public.studio_revision_media'::pg_catalog.regclass
      and constraint_object.conname = 'studio_revision_media_position_key'
      and constraint_object.condeferrable
  )
    and exists (
      select 1
      from pg_catalog.pg_indexes as index_object
      where index_object.schemaname = 'public'
        and index_object.indexname = 'studio_revision_media_one_cover_idx'
    )
    and exists (
      select 1
      from pg_catalog.pg_indexes as index_object
      where index_object.schemaname = 'public'
        and index_object.indexname = 'studio_media_uploaded_by_idx'
    )
    and exists (
      select 1
      from pg_catalog.pg_indexes as index_object
      where index_object.schemaname = 'private'
        and index_object.indexname = 'studio_command_requests_resulting_media_id_idx'
        and index_object.indexdef like '%WHERE (resulting_media_id IS NOT NULL)%'
    )
    and exists (
      select 1
      from pg_catalog.pg_indexes as index_object
      where index_object.schemaname = 'private'
        and index_object.indexname = 'studio_media_finalize_claims_studio_idx'
    )
    and exists (
      select 1
      from pg_catalog.pg_indexes as index_object
      where index_object.schemaname = 'private'
        and index_object.indexname = 'studio_media_finalize_claims_media_key'
    ),
  'posição, capa, ownership e FKs reversas possuem índices estruturais exatos'
);
select policies_are(
  'public',
  'studio_media',
  array[]::text[],
  'objetos não possuem policy browser; leitura ocorre somente no DAL'
);
select policies_are(
  'public',
  'studio_revision_media',
  array[]::text[],
  'associações não possuem policy browser; leitura ocorre somente no DAL'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_policies as policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
      and policy.policyname like 'studio_media_objects_%'
  ),
  0,
  'browser não recebe policy de upload, listagem, assinatura ou download no Storage'
);
select ok(
  (
    select pg_catalog.count(*) = 12
    from (
      values
        ('private.get_owner_studio_media(uuid,uuid)'),
        ('private.prepare_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid,text,bigint,text)'),
        ('private.confirm_studio_media_upload_token(uuid,uuid,uuid,bigint,uuid)'),
        ('private.reject_unsigned_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid)'),
        ('private.begin_studio_media_finalize_claim(uuid,uuid,uuid,bigint,uuid,uuid,uuid)'),
        ('private.renew_studio_media_finalize_claim(uuid)'),
        ('private.release_studio_media_finalize_claim(uuid)'),
        ('private.reject_studio_media_upload_claimed(uuid,uuid,text)'),
        ('private.finalize_studio_media_upload_claimed(uuid,uuid,text,bigint,integer,integer,text)'),
        ('private.reorder_studio_media(uuid,uuid,uuid,bigint,uuid,uuid,uuid[])'),
        ('private.set_studio_media_cover(uuid,uuid,uuid,bigint,uuid,uuid,uuid)'),
        ('private.delete_studio_media(uuid,uuid,uuid,bigint,uuid,uuid,uuid)')
    ) as expected(signature)
    where pg_catalog.has_function_privilege('app_dal', expected.signature, 'EXECUTE')
  )
    and not pg_catalog.has_function_privilege(
      'app_dal',
      'private.replay_studio_media_finalize(uuid,uuid,uuid,bigint,uuid,uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal',
      'private.get_studio_media_upload_candidate(uuid,uuid,uuid,bigint,uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal',
      'private.reject_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid,text)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal',
      'private.finalize_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid,uuid,text,bigint,integer,integer,text)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'anon',
      'private.confirm_studio_media_upload_token(uuid,uuid,uuid,bigint,uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated',
      'private.reject_unsigned_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'service_role',
      'private.reject_unsigned_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_table_privilege('app_dal', 'public.studio_media', 'SELECT')
    and not pg_catalog.has_table_privilege(
      'app_dal',
      'private.studio_media_finalize_claims',
      'SELECT'
    ),
  'app_dal executa apenas o read model e as fachadas cercadas sem leitura direta das tabelas'
);
select ok(
  pg_catalog.to_regclass('private.studio_media_finalize_claims') is not null
    and (
      select class.relrowsecurity
      from pg_catalog.pg_class as class
      where class.oid = 'private.studio_media_finalize_claims'::pg_catalog.regclass
    )
    and not pg_catalog.has_table_privilege(
      'anon',
      'private.studio_media_finalize_claims',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'authenticated',
      'private.studio_media_finalize_claims',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'private.studio_media_finalize_claims',
      'SELECT'
    )
    and not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_object
      where constraint_object.conrelid =
          'private.studio_media_finalize_claims'::pg_catalog.regclass
        and constraint_object.contype = 'f'
        and constraint_object.confrelid in (
          'public.studios'::pg_catalog.regclass,
          'public.studio_media'::pg_catalog.regclass
        )
    ),
  'claim privado mantém RLS e tombstone sem FK para studio ou mídia mutáveis'
);
select ok(
  pg_catalog.has_function_privilege(
      'service_role',
      'public.claim_studio_media_cleanup(uuid,integer)',
      'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'service_role',
      'public.complete_studio_media_cleanup(uuid,uuid,boolean,text)',
      'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'service_role',
      'public.begin_studio_media_cleanup_run(uuid,text)',
      'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'service_role',
      'public.complete_studio_media_cleanup_run(uuid,text,integer,integer,integer,text)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated',
      'public.claim_studio_media_cleanup(uuid,integer)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal',
      'public.complete_studio_media_cleanup(uuid,uuid,boolean,text)',
      'EXECUTE'
    )
    and not pg_catalog.has_schema_privilege('service_role', 'maintenance', 'USAGE')
    and not pg_catalog.has_function_privilege(
      'service_role',
      'maintenance.claim_studio_media_cleanup(uuid,integer)',
      'EXECUTE'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'maintenance.studio_media_cleanup_probes',
      'SELECT'
    )
    and not pg_catalog.has_function_privilege(
      'service_role',
      'maintenance.prepare_studio_media_cleanup_probe(uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated',
      'maintenance.get_studio_media_cleanup_probe(uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_schema_privilege('service_role', 'maintenance', 'USAGE')
    and pg_catalog.to_regprocedure('maintenance.invoke_studio_media_cleanup()') is null
    and pg_catalog.to_regprocedure(
      'maintenance.invoke_studio_media_cleanup(uuid,text)'
    ) is null
    and not exists (
      select 1
      from pg_catalog.pg_namespace as namespace
      where namespace.nspname = 'net'
        and (
          pg_catalog.has_schema_privilege('app_dal', namespace.oid, 'USAGE')
          or pg_catalog.has_schema_privilege(
            'app_runtime_production',
            namespace.oid,
            'USAGE'
          )
        )
    ),
  'service_role usa somente quatro RPCs; invoke não existe e runtimes não alcançam net/maintenance'
);
select ok(
  not pg_catalog.has_table_privilege('anon', 'public.studio_media', 'SELECT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_media', 'SELECT')
    and not pg_catalog.has_table_privilege('service_role', 'public.studio_media', 'SELECT')
    and not pg_catalog.has_table_privilege('app_dal', 'public.studio_media', 'SELECT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_media', 'INSERT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_media', 'UPDATE')
    and not pg_catalog.has_table_privilege('authenticated', 'public.studio_media', 'DELETE'),
  'tabelas não concedem leitura ou escrita direta ao browser nem aos runtimes'
);
select ok(
  pg_catalog.to_regprocedure('public.get_owner_studio_media(uuid)') is null
    and pg_catalog.has_function_privilege(
      'app_dal',
      'private.get_owner_studio_media(uuid,uuid)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated',
      'private.get_owner_studio_media(uuid,uuid)',
      'EXECUTE'
    ),
  'não existe RPC pública e o único read model de mídia executa somente no app_dal'
);

select ok(
  private.managed_runtime_boundaries_are_ready()
    and not exists (
      select 1
      from pg_catalog.pg_namespace as namespace
      where namespace.nspname = 'net'
        and (
          pg_catalog.has_schema_privilege('app_dal', namespace.oid, 'USAGE')
          or pg_catalog.has_schema_privilege(
            'app_runtime_production',
            namespace.oid,
            'USAGE'
          )
        )
    ),
  'readiness restaura a fronteira anterior: DAL e runtime LOGIN não alcançam net'
);

savepoint runtime_net_drift;
create schema if not exists net;
grant usage on schema net to app_runtime_production;
select ok(
  not private.managed_runtime_boundaries_are_ready(),
  'readiness falha fechado se o runtime de produção alcançar net'
);
rollback to savepoint runtime_net_drift;
release savepoint runtime_net_drift;

select private.feat008_create_owner(
  '81000000-0000-4000-8000-000000000001',
  'qa-feat008-owner-a@setlivre.local',
  '52998224725',
  1
);
select private.feat008_create_owner(
  '81000000-0000-4000-8000-000000000002',
  'qa-feat008-owner-b@setlivre.local',
  '11144477735',
  2
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.f008_create',
  private.create_studio(
    '81000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000001',
    'Estúdio Mídia',
    'Estúdio criado para provar o ciclo completo e privado de mídia versionada.',
    'Rua das Imagens',
    '8',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    10,
    '60000000-0000-4000-8000-000000000001'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_studio',
  pg_catalog.current_setting('set_livre.test.f008_create')::jsonb ->> 'studioId',
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_revision',
  pg_catalog.current_setting('set_livre.test.f008_create')::jsonb #>> '{revision,id}',
  true
);

select pg_catalog.set_config(
  'set_livre.test.f008_prepare_1',
  private.prepare_studio_media_upload(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    1,
    '85000000-0000-4000-8000-000000000001',
    '86000000-0000-4000-8000-000000000001',
    'image/jpeg',
    100,
    pg_catalog.repeat('a', 64)
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_media_1',
  pg_catalog.current_setting('set_livre.test.f008_prepare_1')::jsonb ->> 'mediaId',
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_prepare_replay_equal',
  (
    private.prepare_studio_media_upload(
      '81000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
      pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
      1,
      '85000000-0000-4000-8000-000000000001',
      '86000000-0000-4000-8000-000000000002',
      'image/jpeg',
      100,
      pg_catalog.repeat('a', 64)
    )::text = pg_catalog.current_setting('set_livre.test.f008_prepare_1')
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_claim_1',
  private.begin_studio_media_finalize_claim(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    1,
    '85000000-0000-4000-8000-000000000002',
    '86000000-0000-4000-8000-000000000003',
    pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_candidate_1',
  (
    pg_catalog.current_setting('set_livre.test.f008_claim_1')::jsonb -> 'candidate'
  )::text,
  true
);
select private.release_studio_media_finalize_claim(
  (
    pg_catalog.current_setting('set_livre.test.f008_claim_1')::jsonb ->> 'claimToken'
  )::uuid
);

reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_prepare_1')::jsonb ->> 'bucket'
      = 'studio-media'
    and (
      pg_catalog.current_setting('set_livre.test.f008_prepare_1')::jsonb ->> 'path'
    ) ~ '^owners/[0-9a-f-]{36}/studios/[0-9a-f-]{36}/revisions/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
    and exists (
      select 1
      from public.studio_media as media
      where media.id = pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
        and media.upload_expires_at = media.prepared_at + interval '2 hours'
        and media.cleanup_after = media.prepared_at + interval '24 hours'
    )
    and (
      select pg_catalog.count(*) = 8
      from pg_catalog.jsonb_object_keys(
        pg_catalog.current_setting('set_livre.test.f008_prepare_1')::jsonb
      ) as key_name
    )
    and pg_catalog.current_setting('set_livre.test.f008_prepare_1')::jsonb ?& array[
      'scope',
      'studioId',
      'revisionId',
      'revisionVersion',
      'mediaId',
      'bucket',
      'path',
      'expiresAt'
    ],
  'prepare retorna o objeto strict de oito chaves e deriva janelas sem path do cliente'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f008_prepare_replay_equal')::boolean,
  'replay de prepare retorna exatamente o JSON originalmente persistido'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f008_candidate_1')::jsonb ->> 'mediaId'
      = pg_catalog.current_setting('set_livre.test.f008_media_1')
    and pg_catalog.current_setting('set_livre.test.f008_candidate_1')::jsonb ->> 'path'
      = pg_catalog.current_setting('set_livre.test.f008_prepare_1')::jsonb ->> 'path'
    and pg_catalog.current_setting('set_livre.test.f008_candidate_1')::jsonb ->> 'declaredByteSize'
      = '100'
    and pg_catalog.current_setting('set_livre.test.f008_candidate_1')::jsonb ->> 'previewPath'
      = pg_catalog.regexp_replace(
          pg_catalog.current_setting('set_livre.test.f008_prepare_1')::jsonb ->> 'path',
          '\.[a-z]+$',
          '.preview.webp'
        )
    and (
      select pg_catalog.count(*) = 12
      from pg_catalog.jsonb_object_keys(
        pg_catalog.current_setting('set_livre.test.f008_candidate_1')::jsonb
      ) as key_name
    ),
  'candidate devolve exatamente os doze fatos canônicos aceitos pelo Zod strict'
);

with timing as (
  select pg_catalog.clock_timestamp() as prepared_at
)
insert into public.studio_media (
  id,
  studio_id,
  prepared_revision_id,
  uploaded_by,
  storage_bucket,
  storage_path,
  preview_storage_path,
  declared_mime_type,
  declared_size_bytes,
  status,
  prepared_at,
  upload_expires_at,
  cleanup_after,
  updated_at
)
select
  '87000000-0000-4000-8000-000000007010',
  pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
  pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
  '81000000-0000-4000-8000-000000000001',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.jpg',
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio'),
    pg_catalog.current_setting('set_livre.test.f008_revision'),
    '87000000-0000-4000-8000-000000007010'
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio'),
    pg_catalog.current_setting('set_livre.test.f008_revision'),
    '87000000-0000-4000-8000-000000007010'
  ),
  'image/jpeg',
  100,
  'pending_upload',
  timing.prepared_at,
  timing.prepared_at + interval '2 hours',
  timing.prepared_at + interval '24 hours',
  timing.prepared_at
from timing;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_expiring_claim',
  private.begin_studio_media_finalize_claim(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    1,
    '85000000-0000-4000-8000-000000000096',
    '86000000-0000-4000-8000-000000000096',
    '87000000-0000-4000-8000-000000007010'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_expiring_candidate',
  (
    pg_catalog.current_setting('set_livre.test.f008_expiring_claim')::jsonb -> 'candidate'
  )::text,
  true
);
select private.release_studio_media_finalize_claim(
  (
    pg_catalog.current_setting('set_livre.test.f008_expiring_claim')::jsonb ->> 'claimToken'
  )::uuid
);
reset role;

set local session_replication_role = replica;
with timing as (
  select pg_catalog.clock_timestamp() - interval '3 hours' as prepared_at
)
update public.studio_media as media
set
  prepared_at = timing.prepared_at,
  upload_expires_at = timing.prepared_at + interval '2 hours',
  cleanup_after = timing.prepared_at + interval '24 hours',
  updated_at = pg_catalog.clock_timestamp()
from timing
where media.id = '87000000-0000-4000-8000-000000007010';
set local session_replication_role = origin;

select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select private.finalize_studio_media_upload(
          '81000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 1,
          '85000000-0000-4000-8000-000000000096',
          '86000000-0000-4000-8000-000000000096',
          '87000000-0000-4000-8000-000000007010',
          'image/jpeg', 100, 1200, 800, %L
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.repeat('d', 64)
    )
  ),
  '^40001:studio_media_upload_expired$',
  'finalize distingue a expiração ocorrida depois de get_candidate para permitir renovação'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        with facts as (
          select pg_catalog.clock_timestamp() as prepared_at
        )
        insert into public.studio_media (
          id, studio_id, prepared_revision_id, uploaded_by, storage_bucket, storage_path,
          preview_storage_path, declared_mime_type, declared_size_bytes, status, prepared_at,
          upload_expires_at, cleanup_after, updated_at
        )
        select
          '87000000-0000-4000-8000-000000007001', %L::uuid, %L::uuid,
          '81000000-0000-4000-8000-000000000001', 'studio-media',
          pg_catalog.format(
            'owners/%%s/studios/%%s/revisions/%%s/%%s.jpg',
            '81000000-0000-4000-8000-000000000002',
            %L::uuid,
            %L::uuid,
            '87000000-0000-4000-8000-000000007001'
          ),
          pg_catalog.format(
            'owners/%%s/studios/%%s/revisions/%%s/%%s.preview.webp',
            '81000000-0000-4000-8000-000000000002',
            %L::uuid,
            %L::uuid,
            '87000000-0000-4000-8000-000000007001'
          ),
          'image/jpeg', 10, 'pending_upload', facts.prepared_at,
          facts.prepared_at + interval '2 hours',
          facts.prepared_at + interval '24 hours',
          facts.prepared_at
        from facts
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision')
    )
  ),
  '^23514:',
  'constraint rejeita owner UUID válido trocado dentro do storage_path'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        with facts as (
          select pg_catalog.clock_timestamp() as prepared_at
        )
        insert into public.studio_media (
          id, studio_id, prepared_revision_id, uploaded_by, storage_bucket, storage_path,
          preview_storage_path, declared_mime_type, declared_size_bytes, status, prepared_at,
          upload_expires_at, cleanup_after, updated_at
        )
        select
          '87000000-0000-4000-8000-000000007002', %L::uuid, %L::uuid,
          '81000000-0000-4000-8000-000000000001', 'studio-media',
          pg_catalog.format(
            'owners/%%s/studios/%%s/revisions/%%s/%%s.png',
            '81000000-0000-4000-8000-000000000001',
            %L::uuid,
            %L::uuid,
            '87000000-0000-4000-8000-000000007002'
          ),
          pg_catalog.format(
            'owners/%%s/studios/%%s/revisions/%%s/%%s.preview.webp',
            '81000000-0000-4000-8000-000000000001',
            %L::uuid,
            %L::uuid,
            '87000000-0000-4000-8000-000000007003'
          ),
          'image/png', 10, 'pending_upload', facts.prepared_at,
          facts.prepared_at + interval '2 hours',
          facts.prepared_at + interval '24 hours',
          facts.prepared_at
        from facts
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision')
    )
  ),
  '^23514:',
  'constraint rejeita media UUID válido trocado no preview <mediaId>.preview.webp'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select private.get_studio_media_upload_candidate(
          '81000000-0000-4000-8000-000000000002', %L::uuid, %L::uuid, 1, %L::uuid
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_media_1')
    )
  ),
  '^P0002:studio_not_found$',
  'dono B não obtém bucket, path nem token canônico do dono A'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select private.finalize_studio_media_upload(
          '81000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 1,
          '85000000-0000-4000-8000-000000000099',
          '86000000-0000-4000-8000-000000000099', %L::uuid,
          'image/png', 100, 1200, 800, %L
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_media_1'),
      pg_catalog.repeat('a', 64)
    )
  ),
  '^23514:studio_media_metadata_mismatch$',
  'finalize rejeita MIME real divergente sem confiar na declaração'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select private.finalize_studio_media_upload(
          '81000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 1,
          '85000000-0000-4000-8000-000000000097',
          '86000000-0000-4000-8000-000000000097', %L::uuid,
          'image/jpeg', 100, 8193, 1, %L
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_media_1'),
      pg_catalog.repeat('a', 64)
    )
  ),
  '^22023:invalid_studio_media_finalize$',
  'finalize rejeita qualquer aresta acima de 8192 pixels'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select private.finalize_studio_media_upload(
          '81000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 1,
          '85000000-0000-4000-8000-000000000098',
          '86000000-0000-4000-8000-000000000098', %L::uuid,
          'image/jpeg', 100, 6001, 6000, %L
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_media_1'),
      pg_catalog.repeat('a', 64)
    )
  ),
  '^22023:invalid_studio_media_finalize$',
  'finalize rejeita imagens acima do orçamento total de 36 milhões de pixels'
);
select is(
  (
    select media.status
    from public.studio_media as media
    where media.id = pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
  ),
  'pending_upload',
  'falha de finalize não fabrica ready nem perde o candidato rejeitável'
);

set local role app_dal;
with claim as (
  select private.begin_studio_media_finalize_claim(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    1,
    '85000000-0000-4000-8000-000000000002',
    '86000000-0000-4000-8000-000000000003',
    pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
  ) as result
)
select pg_catalog.set_config(
  'set_livre.test.f008_finalize_1',
  private.finalize_studio_media_upload_claimed(
    (claim.result ->> 'claimToken')::uuid,
    '86000000-0000-4000-8000-000000000003',
    'image/jpeg',
    100,
    1200,
    800,
    pg_catalog.repeat('a', 64)
  )::text,
  true
)
from claim;
select pg_catalog.set_config(
  'set_livre.test.f008_finalize_replay_equal',
  (
    (
      private.begin_studio_media_finalize_claim(
        '81000000-0000-4000-8000-000000000001',
        pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
        pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
        1,
        '85000000-0000-4000-8000-000000000002',
        '86000000-0000-4000-8000-000000000004',
        pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
      ) -> 'result'
    )::text = pg_catalog.current_setting('set_livre.test.f008_finalize_1')
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_prepare_2',
  private.prepare_studio_media_upload(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    2,
    '85000000-0000-4000-8000-000000000003',
    '86000000-0000-4000-8000-000000000005',
    'image/png',
    200,
    pg_catalog.repeat('b', 64)
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_media_2',
  pg_catalog.current_setting('set_livre.test.f008_prepare_2')::jsonb ->> 'mediaId',
  true
);
with claim as (
  select private.begin_studio_media_finalize_claim(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    2,
    '85000000-0000-4000-8000-000000000004',
    '86000000-0000-4000-8000-000000000006',
    pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
  ) as result
)
select pg_catalog.set_config(
  'set_livre.test.f008_finalize_2',
  private.finalize_studio_media_upload_claimed(
    (claim.result ->> 'claimToken')::uuid,
    '86000000-0000-4000-8000-000000000006',
    'image/png',
    200,
    900,
    900,
    pg_catalog.repeat('b', 64)
  )::text,
  true
)
from claim;
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_finalize_1')::jsonb ->> 'revisionVersion'
      = '2'
    and pg_catalog.current_setting('set_livre.test.f008_finalize_1')::jsonb ->> 'revisionNumber'
      = (
        select revision.revision_number::text
        from public.studio_revisions as revision
        where revision.id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
      )
    and exists (
      select 1
      from public.studio_revision_media as relation
      where relation.revision_id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
        and relation.media_id = pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
        and relation.position = 1
        and relation.is_cover
    )
    and exists (
      select 1
      from private.studio_media_finalize_claims as claim
      where claim.owner_user_id = '81000000-0000-4000-8000-000000000001'
        and claim.idempotency_key = '85000000-0000-4000-8000-000000000002'
        and claim.media_id = pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
        and claim.terminal_state = 'finalized'
        and claim.terminal_rejection_code is null
        and claim.terminal_at is not null
    ),
  'primeiro finalize cria associação, versão 2, capa e tombstone terminal atômicos'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f008_finalize_replay_equal')::boolean,
  'replay de finalize devolve a fotografia exata do resultado confirmado'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f008_finalize_2')::jsonb ->> 'revisionVersion'
      = '3'
    and pg_catalog.current_setting('set_livre.test.f008_finalize_2')::jsonb ->> 'revisionNumber'
      = (
        select revision.revision_number::text
        from public.studio_revisions as revision
        where revision.id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
      )
    and (
      select pg_catalog.count(*) = 2
        and pg_catalog.count(*) filter (where relation.is_cover) = 1
        and pg_catalog.max(relation.position) = 2
      from public.studio_revision_media as relation
      where relation.revision_id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
    ),
  'segundo finalize mantém posições contínuas e exatamente uma capa'
);

savepoint duplicate_cover;
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      'update public.studio_revision_media set is_cover = true where revision_id = %L::uuid and media_id = %L::uuid',
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_media_2')
    )
  ),
  '^23505:',
  'índice parcial impede duas capas mesmo fora da fachada DAL'
);
rollback to savepoint duplicate_cover;
release savepoint duplicate_cover;

savepoint duplicate_position;
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      'update public.studio_revision_media set position = 1 where revision_id = %L::uuid and media_id = %L::uuid',
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_media_2')
    )
  ),
  '^23505:',
  'constraint impede posição duplicada fora de uma reordenação transacional'
);
rollback to savepoint duplicate_position;
release savepoint duplicate_position;

select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      'update public.studio_media set storage_path = %L where id = %L::uuid',
      'studios/00000000-0000-4000-8000-000000000000/media/00000000-0000-4000-8000-000000000000.jpg',
      pg_catalog.current_setting('set_livre.test.f008_media_1')
    )
  ),
  '^23514:studio_media_object_immutable$',
  'objeto pronto não permite trocar path nem identidade física'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_owner_read',
  coalesce(
    private.get_owner_studio_media(
      '81000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.f008_studio')::uuid
    )::text,
    'null'
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_other_owner_read',
  coalesce(
    private.get_owner_studio_media(
      '81000000-0000-4000-8000-000000000002',
      pg_catalog.current_setting('set_livre.test.f008_studio')::uuid
    )::text,
    'null'
  ),
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb ->> 'scope'
      = '81000000-0000-4000-8000-000000000001'
    and pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb ->> 'studioId'
      = pg_catalog.current_setting('set_livre.test.f008_studio')
    and pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb ->> 'revisionId'
      = pg_catalog.current_setting('set_livre.test.f008_revision')
    and (
      pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb
        ->> 'revisionNumber'
    )::bigint = (
      select revision.revision_number
      from public.studio_revisions as revision
      where revision.id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
        and revision.revision_number >= 1
    )
    and pg_catalog.jsonb_typeof(
      pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb
        -> 'revisionNumber'
    ) = 'number'
    and (
      select pg_catalog.count(*) = 6
      from pg_catalog.jsonb_object_keys(
        pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb
      ) as key_name
    )
    and pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb ?& array[
      'scope',
      'studioId',
      'revisionId',
      'revisionNumber',
      'revisionVersion',
      'items'
    ]
    and pg_catalog.jsonb_array_length(
      pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb -> 'items'
    ) = 2,
  'DAL lê o objeto camelCase exato com revisionNumber autoritativo e positivo'
);
select ok(
  (
    pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb #> '{items,0}'
  ) ?& array[
    'id',
    'previewStoragePath',
    'mimeType',
    'byteSize',
    'checksumSha256',
    'width',
    'height',
    'position',
    'isCover'
  ]
    and (
      select pg_catalog.count(*) = 9
      from pg_catalog.jsonb_object_keys(
        pg_catalog.current_setting('set_livre.test.f008_owner_read')::jsonb
          #> '{items,0}'
      ) as key_name
    ),
  'read model privado entrega exatamente os fatos camelCase validados pela aplicação'
);
select is(
  pg_catalog.current_setting('set_livre.test.f008_other_owner_read')::jsonb,
  'null'::jsonb,
  'dono B recebe null e não descobre mídia, associação ou path de A'
);

update public.profiles as profile
set status = 'suspended'
where profile.id = '81000000-0000-4000-8000-000000000001';
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_suspended_read',
  coalesce(
    private.get_owner_studio_media(
      '81000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.f008_studio')::uuid
    )::text,
    'null'
  ),
  true
);
reset role;
select is(
  pg_catalog.current_setting('set_livre.test.f008_suspended_read')::jsonb,
  'null'::jsonb,
  'conta suspensa perde o read model no limite privado do banco'
);
update public.profiles as profile
set status = 'active'
where profile.id = '81000000-0000-4000-8000-000000000001';

savepoint expired_contract;
alter table public.terms_versions disable trigger terms_versions_protect_immutability;
update public.terms_versions as legal_version
set retired_at = pg_catalog.transaction_timestamp() - interval '1 microsecond'
where legal_version.id = '00000000-0000-4000-8000-000000000204';
alter table public.terms_versions enable trigger terms_versions_protect_immutability;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_expired_contract_read',
  coalesce(
    private.get_owner_studio_media(
      '81000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.f008_studio')::uuid
    )::text,
    'null'
  ),
  true
);
reset role;
select is(
  pg_catalog.current_setting('set_livre.test.f008_expired_contract_read')::jsonb,
  'null'::jsonb,
  'contrato vencido remove acesso ao read model privado'
);
rollback to savepoint expired_contract;
release savepoint expired_contract;

select ok(
  not pg_catalog.has_column_privilege('anon', 'public.studio_media', 'storage_path', 'SELECT')
    and not pg_catalog.has_table_privilege('anon', 'public.studio_revision_media', 'SELECT'),
  'anon não recebe nem metadado privado nem associação de draft'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_reorder',
  private.reorder_studio_media(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    3,
    '85000000-0000-4000-8000-000000000005',
    '86000000-0000-4000-8000-000000000007',
    array[
      pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid,
      pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
    ]
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cover',
  private.set_studio_media_cover(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    4,
    '85000000-0000-4000-8000-000000000006',
    '86000000-0000-4000-8000-000000000008',
    pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_reorder')::jsonb ->> 'revisionVersion'
      = '4'
    and pg_catalog.current_setting('set_livre.test.f008_reorder')::jsonb ->> 'revisionNumber'
      = (
        select revision.revision_number::text
        from public.studio_revisions as revision
        where revision.id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
      )
    and exists (
      select 1
      from public.studio_revision_media as relation
      where relation.revision_id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
        and relation.media_id = pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
        and relation.position = 1
    ),
  'reorder substitui o conjunto completo e incrementa a versão uma vez'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f008_cover')::jsonb ->> 'revisionVersion'
      = '5'
    and pg_catalog.current_setting('set_livre.test.f008_cover')::jsonb ->> 'revisionNumber'
      = (
        select revision.revision_number::text
        from public.studio_revisions as revision
        where revision.id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
      )
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(relation.media_id = pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid)
      from public.studio_revision_media as relation
      where relation.revision_id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
        and relation.is_cover
    ),
  'set cover troca a capa atomicamente e mantém unicidade'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select private.delete_studio_media(
          '81000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 5,
          '85000000-0000-4000-8000-000000000007',
          '86000000-0000-4000-8000-000000000009', %L::uuid
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_studio'),
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_media_2')
    )
  ),
  '^23514:studio_media_cover_replacement_required$',
  'excluir capa com outras fotos exige escolha explícita anterior'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_delete_1',
  private.delete_studio_media(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    5,
    '85000000-0000-4000-8000-000000000008',
    '86000000-0000-4000-8000-000000000010',
    pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_delete_1')::jsonb ->> 'revisionVersion'
      = '6'
    and pg_catalog.current_setting('set_livre.test.f008_delete_1')::jsonb ->> 'revisionNumber'
      = (
        select revision.revision_number::text
        from public.studio_revisions as revision
        where revision.id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
      )
    and (
      select media.status = 'delete_pending'
      from public.studio_media as media
      where media.id = pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
    )
    and exists (
      select 1
      from public.studio_revision_media as relation
      where relation.revision_id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
        and relation.media_id = pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
        and relation.position = 1
        and relation.is_cover
    ),
  'delete compacta posição e enfileira objeto que ficou sem referência'
);

update public.studio_revisions as revision
set
  status = 'approved',
  revision_version = revision.revision_version + 1
where revision.id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid;
update public.studios as studio
set
  status = 'published',
  published_revision_id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
  draft_revision_id = null
where studio.id = pg_catalog.current_setting('set_livre.test.f008_studio')::uuid;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_prepare_3',
  private.prepare_studio_media_upload(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    7,
    '85000000-0000-4000-8000-000000000009',
    '86000000-0000-4000-8000-000000000011',
    'image/webp',
    300,
    pg_catalog.repeat('c', 64)
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_draft_revision',
  pg_catalog.current_setting('set_livre.test.f008_prepare_3')::jsonb ->> 'revisionId',
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_media_3',
  pg_catalog.current_setting('set_livre.test.f008_prepare_3')::jsonb ->> 'mediaId',
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_draft_revision')
      <> pg_catalog.current_setting('set_livre.test.f008_revision')
    and exists (
      select 1
      from public.studio_revision_media as published_relation
      join public.studio_revision_media as draft_relation
        on draft_relation.media_id = published_relation.media_id
      where published_relation.revision_id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
        and draft_relation.revision_id = pg_catalog.current_setting('set_livre.test.f008_draft_revision')::uuid
        and published_relation.media_id = pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
        and published_relation.position = draft_relation.position
        and published_relation.is_cover = draft_relation.is_cover
    ),
  'criar nova draft clona associações sem duplicar o objeto publicado'
);

set local role app_dal;
with claim as (
  select private.begin_studio_media_finalize_claim(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_draft_revision')::uuid,
    1,
    '85000000-0000-4000-8000-000000000010',
    '86000000-0000-4000-8000-000000000012',
    pg_catalog.current_setting('set_livre.test.f008_media_3')::uuid
  ) as result
)
select pg_catalog.set_config(
  'set_livre.test.f008_reject_1',
  private.reject_studio_media_upload_claimed(
    (claim.result ->> 'claimToken')::uuid,
    '86000000-0000-4000-8000-000000000012',
    'validation_failed'
  )::text,
  true
)
from claim;
select pg_catalog.set_config(
  'set_livre.test.f008_reject_claim_terminal',
  private.begin_studio_media_finalize_claim(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_draft_revision')::uuid,
    1,
    '85000000-0000-4000-8000-000000000010',
    '86000000-0000-4000-8000-000000000014',
    pg_catalog.current_setting('set_livre.test.f008_media_3')::uuid
  )::text,
  true
);
reset role;
select pg_catalog.set_config(
  'set_livre.test.f008_reject_replay_equal',
  (
    private.reject_studio_media_upload(
      '81000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
      pg_catalog.current_setting('set_livre.test.f008_draft_revision')::uuid,
      1,
      pg_catalog.current_setting('set_livre.test.f008_media_3')::uuid,
      '86000000-0000-4000-8000-000000000013'
    )::text = pg_catalog.current_setting('set_livre.test.f008_reject_1')
  )::text,
  true
);

select ok(
  pg_catalog.current_setting('set_livre.test.f008_reject_replay_equal')::boolean
    and pg_catalog.current_setting('set_livre.test.f008_reject_claim_terminal')::jsonb
      @> '{"state":"rejected","rejectionCode":"validation_failed"}'::jsonb
    and (
      select pg_catalog.count(*) = 1
      from audit.events as event
      where event.action = 'studio.media_upload_rejected'
        and event.target_id = pg_catalog.current_setting('set_livre.test.f008_studio')::uuid
        and event.idempotency_key = pg_catalog.current_setting('set_livre.test.f008_media_3')::uuid
    ),
  'reject persiste terminal replayável, é idempotente pelo media_id e audita somente a transição'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_delete_shared',
  private.delete_studio_media(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_draft_revision')::uuid,
    1,
    '85000000-0000-4000-8000-000000000010',
    '86000000-0000-4000-8000-000000000014',
    pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
  )::text,
  true
);
reset role;

select ok(
  (
    select media.status = 'ready'
    from public.studio_media as media
    where media.id = pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
  )
    and exists (
      select 1
      from public.studio_revision_media as relation
      where relation.revision_id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
        and relation.media_id = pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
    )
    and not exists (
      select 1
      from public.studio_revision_media as relation
      where relation.revision_id = pg_catalog.current_setting('set_livre.test.f008_draft_revision')::uuid
        and relation.media_id = pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
    ),
  'delete da draft preserva objeto e associação da revisão publicada'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      'delete from public.studio_revision_media where revision_id = %L::uuid and media_id = %L::uuid',
      pg_catalog.current_setting('set_livre.test.f008_revision'),
      pg_catalog.current_setting('set_livre.test.f008_media_2')
    )
  ),
  '^23514:studio_media_revision_immutable$',
  'associação publicada não pode ser removida diretamente'
);

update public.studios as studio
set draft_revision_id = null
where studio.id = pg_catalog.current_setting('set_livre.test.f008_studio')::uuid;
delete from public.studio_revisions as revision
where revision.id = pg_catalog.current_setting('set_livre.test.f008_draft_revision')::uuid
  and revision.status = 'draft';

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_media_first_delete',
  private.delete_studio_media(
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
    7,
    '85000000-0000-4000-8000-000000000013',
    '86000000-0000-4000-8000-000000000017',
    pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_media_first_delete')::jsonb
      ->> 'revisionId'
      <> pg_catalog.current_setting('set_livre.test.f008_revision')
    and pg_catalog.current_setting('set_livre.test.f008_media_first_delete')::jsonb
      ->> 'revisionVersion' = '2'
    and (
      pg_catalog.current_setting('set_livre.test.f008_media_first_delete')::jsonb
        ->> 'revisionNumber'
    )::bigint > (
      select revision.revision_number
      from public.studio_revisions as revision
      where revision.id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
    )
    and pg_catalog.current_setting('set_livre.test.f008_media_first_delete')::jsonb
      -> 'items' = '[]'::jsonb
    and exists (
      select 1
      from public.studios as studio
      join public.studio_revisions as draft
        on draft.id = studio.draft_revision_id
      where studio.id = pg_catalog.current_setting('set_livre.test.f008_studio')::uuid
        and studio.published_revision_id
          = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
        and draft.id = (
          pg_catalog.current_setting('set_livre.test.f008_media_first_delete')::jsonb
            ->> 'revisionId'
        )::uuid
        and draft.status = 'draft'
        and draft.revision_version = 2
    )
    and exists (
      select 1
      from public.studio_revisions as published
      join public.studio_revision_media as published_relation
        on published_relation.revision_id = published.id
      where published.id = pg_catalog.current_setting('set_livre.test.f008_revision')::uuid
        and published.status = 'approved'
        and published.revision_version = 7
        and published_relation.media_id
          = pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
        and published_relation.position = 1
        and published_relation.is_cover
    )
    and not exists (
      select 1
      from public.studio_revision_media as draft_relation
      where draft_relation.revision_id = (
          pg_catalog.current_setting('set_livre.test.f008_media_first_delete')::jsonb
            ->> 'revisionId'
        )::uuid
        and draft_relation.media_id
          = pg_catalog.current_setting('set_livre.test.f008_media_2')::uuid
    ),
  'primeira edição por mídia clona a galeria publicada e muta somente a nova draft'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_discard_create',
  private.create_studio(
    '81000000-0000-4000-8000-000000000002',
    '83000000-0000-4000-8000-000000000003',
    '84000000-0000-4000-8000-000000000003',
    'Estúdio descarte com mídia',
    'Primeiro rascunho com mídia pronta, pendente e rejeitada.',
    'Rua do Descarte',
    '30',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    4,
    '60000000-0000-4000-8000-000000000001'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_discard_studio',
  pg_catalog.current_setting('set_livre.test.f008_discard_create')::jsonb ->> 'studioId',
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_discard_revision',
  pg_catalog.current_setting('set_livre.test.f008_discard_create')::jsonb #>> '{revision,id}',
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_discard_ready_prepare',
  private.prepare_studio_media_upload(
    '81000000-0000-4000-8000-000000000002',
    pg_catalog.current_setting('set_livre.test.f008_discard_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_discard_revision')::uuid,
    1,
    '85000000-0000-4000-8000-000000000020',
    '86000000-0000-4000-8000-000000000020',
    'image/webp',
    46,
    pg_catalog.repeat('e', 64)
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_discard_ready_media',
  pg_catalog.current_setting('set_livre.test.f008_discard_ready_prepare')::jsonb
    ->> 'mediaId',
  true
);
with claim as (
  select private.begin_studio_media_finalize_claim(
    '81000000-0000-4000-8000-000000000002',
    pg_catalog.current_setting('set_livre.test.f008_discard_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_discard_revision')::uuid,
    1,
    '85000000-0000-4000-8000-000000000021',
    '86000000-0000-4000-8000-000000000021',
    pg_catalog.current_setting('set_livre.test.f008_discard_ready_media')::uuid
  ) as result
)
select private.finalize_studio_media_upload_claimed(
  (claim.result ->> 'claimToken')::uuid,
  '86000000-0000-4000-8000-000000000021',
  'image/webp',
  46,
  1,
  1,
  pg_catalog.repeat('e', 64)
)
from claim;
select pg_catalog.set_config(
  'set_livre.test.f008_discard_pending_prepare',
  private.prepare_studio_media_upload(
    '81000000-0000-4000-8000-000000000002',
    pg_catalog.current_setting('set_livre.test.f008_discard_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_discard_revision')::uuid,
    2,
    '85000000-0000-4000-8000-000000000022',
    '86000000-0000-4000-8000-000000000022',
    'image/png',
    100,
    null
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_discard_pending_media',
  pg_catalog.current_setting('set_livre.test.f008_discard_pending_prepare')::jsonb
    ->> 'mediaId',
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_discard_rejected_prepare',
  private.prepare_studio_media_upload(
    '81000000-0000-4000-8000-000000000002',
    pg_catalog.current_setting('set_livre.test.f008_discard_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_discard_revision')::uuid,
    2,
    '85000000-0000-4000-8000-000000000023',
    '86000000-0000-4000-8000-000000000023',
    'image/avif',
    100,
    null
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_discard_rejected_media',
  pg_catalog.current_setting('set_livre.test.f008_discard_rejected_prepare')::jsonb
    ->> 'mediaId',
  true
);
with claim as (
  select private.begin_studio_media_finalize_claim(
    '81000000-0000-4000-8000-000000000002',
    pg_catalog.current_setting('set_livre.test.f008_discard_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_discard_revision')::uuid,
    2,
    '85000000-0000-4000-8000-000000000026',
    '86000000-0000-4000-8000-000000000024',
    pg_catalog.current_setting('set_livre.test.f008_discard_rejected_media')::uuid
  ) as result
)
select private.reject_studio_media_upload_claimed(
  (claim.result ->> 'claimToken')::uuid,
  '86000000-0000-4000-8000-000000000024',
  'validation_failed'
)
from claim;
select pg_catalog.set_config(
  'set_livre.test.f008_discard_result',
  private.discard_studio_draft(
    '81000000-0000-4000-8000-000000000002',
    pg_catalog.current_setting('set_livre.test.f008_discard_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f008_discard_revision')::uuid,
    2,
    '85000000-0000-4000-8000-000000000024',
    '86000000-0000-4000-8000-000000000025'
  )::text,
  true
);
reset role;

select ok(
  (
    pg_catalog.current_setting('set_livre.test.f008_discard_result')::jsonb
      ->> 'studioDeleted'
  )::boolean
    and not exists (
      select 1
      from public.studios as studio
      where studio.id = pg_catalog.current_setting(
        'set_livre.test.f008_discard_studio'
      )::uuid
    )
    and (
      select pg_catalog.count(*) = 3
        and pg_catalog.bool_and(
          media.status = 'delete_pending'
          and media.studio_id is null
          and media.prepared_revision_id is null
          and media.delete_requested_at is not null
          and media.cleanup_after >= media.upload_expires_at
        )
      from public.studio_media as media
      where media.id in (
        pg_catalog.current_setting('set_livre.test.f008_discard_ready_media')::uuid,
        pg_catalog.current_setting('set_livre.test.f008_discard_pending_media')::uuid,
        pg_catalog.current_setting('set_livre.test.f008_discard_rejected_media')::uuid
      )
    ),
  'descarte do primeiro draft enfileira ready/pending/rejected antes das FKs e respeita a janela assinada'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_limit_create',
  private.create_studio(
    '81000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000002',
    '84000000-0000-4000-8000-000000000002',
    'Estúdio Limite',
    'Estúdio isolado para provar vinte reservas concorrentes de mídia pendente.',
    'Rua do Limite',
    '20',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    4,
    '60000000-0000-4000-8000-000000000001'
  )::text,
  true
);
reset role;

with facts as (
  select
    pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb ->> 'studioId' as studio_id,
    pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb #>> '{revision,id}' as revision_id,
    pg_catalog.clock_timestamp() as prepared_at
), media_ids as (
  select
    sequence,
    (
      '88000000-0000-4000-8000-'
      || pg_catalog.lpad(sequence::text, 12, '0')
    )::uuid as media_id
  from pg_catalog.generate_series(1, 20) as generated(sequence)
)
insert into public.studio_media (
  id,
  studio_id,
  prepared_revision_id,
  uploaded_by,
  storage_bucket,
  storage_path,
  preview_storage_path,
  declared_mime_type,
  declared_size_bytes,
  status,
  prepared_at,
  upload_expires_at,
  cleanup_after,
  updated_at
)
select
  media_ids.media_id,
  facts.studio_id::uuid,
  facts.revision_id::uuid,
  '81000000-0000-4000-8000-000000000001',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.jpg',
    '81000000-0000-4000-8000-000000000001',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '81000000-0000-4000-8000-000000000001',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  'image/jpeg',
  10,
  'pending_upload',
  facts.prepared_at,
  facts.prepared_at + interval '2 hours',
  facts.prepared_at + interval '24 hours',
  facts.prepared_at
from facts
cross join media_ids;

select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select private.prepare_studio_media_upload(
          '81000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 1,
          '85000000-0000-4000-8000-000000000011',
          '86000000-0000-4000-8000-000000000015',
          'image/jpeg', 10, null
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb #>> '{revision,id}'
    )
  ),
  '^23514:studio_media_limit_reached$',
  'lock da revisão contabiliza pendentes e impede a vigésima primeira mídia'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_limit_token_issued',
  private.confirm_studio_media_upload_token(
    '81000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        #>> '{revision,id}'
    )::uuid,
    1,
    '88000000-0000-4000-8000-000000000001'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_limit_token_preserved',
  private.reject_unsigned_studio_media_upload(
    '81000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        #>> '{revision,id}'
    )::uuid,
    1,
    '88000000-0000-4000-8000-000000000001',
    '8a000000-0000-4000-8000-000000000010'
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_limit_token_issued')::jsonb
      ->> 'state' = 'issued'
    and pg_catalog.current_setting('set_livre.test.f008_limit_token_preserved')::jsonb
      ->> 'state' = 'issued'
    and exists (
      select 1
      from public.studio_media as media
      where media.id = '88000000-0000-4000-8000-000000000001'
        and media.status = 'pending_upload'
        and media.upload_token_issued_at is not null
    )
    and not exists (
      select 1
      from audit.events as event
      where event.action = 'studio.media_upload_rejected'
        and event.idempotency_key = '88000000-0000-4000-8000-000000000001'
    ),
  'confirmação vencedora impede que uma compensação concorrente rejeite o token emitido'
);

update public.studio_revisions as revision
set revision_version = revision.revision_version + 1
where revision.id = (
    pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
      #>> '{revision,id}'
  )::uuid
  and revision.revision_version = 1;

set local role app_dal;
with claim as (
  select private.begin_studio_media_finalize_claim(
    '81000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        #>> '{revision,id}'
    )::uuid,
    1,
    '8a000000-0000-4000-8000-000000000004',
    '8a000000-0000-4000-8000-000000000001',
    '88000000-0000-4000-8000-000000000001'
  ) as result
)
select pg_catalog.set_config(
  'set_livre.test.f008_limit_reject',
  private.reject_studio_media_upload_claimed(
    (claim.result ->> 'claimToken')::uuid,
    '8a000000-0000-4000-8000-000000000001',
    'superseded'
  )::text,
  true
)
from claim;
select pg_catalog.set_config(
  'set_livre.test.f008_limit_replacement',
  private.prepare_studio_media_upload(
    '81000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        #>> '{revision,id}'
    )::uuid,
    2,
    '8a000000-0000-4000-8000-000000000002',
    '8a000000-0000-4000-8000-000000000003',
    'image/jpeg',
    10,
    null
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_limit_reject')::jsonb
      ->> 'rejectionCode' = 'superseded'
    and pg_catalog.current_setting('set_livre.test.f008_limit_reject')::jsonb
      ->> 'revisionVersion' = '1'
    and pg_catalog.current_setting('set_livre.test.f008_limit_replacement')::jsonb
      ->> 'mediaId' is not null
    and pg_catalog.current_setting('set_livre.test.f008_limit_replacement')::jsonb
      ->> 'revisionVersion' = '2'
    and (
      select pg_catalog.count(*) filter (where media.status = 'pending_upload') = 20
        and pg_catalog.count(*) filter (
          where media.status = 'rejected'
            and media.rejection_code = 'superseded'
        ) = 1
      from public.studio_media as media
      where media.prepared_revision_id = (
        pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
          #>> '{revision,id}'
      )::uuid
    ),
  'supersessão por identidade libera a quota mesmo após a versão da galeria avançar'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_expired_limit_create',
  private.create_studio(
    '81000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000003',
    '84000000-0000-4000-8000-000000000003',
    'Estúdio Limite Expirado',
    'Estúdio isolado para provar que retenção não ocupa a quota de upload.',
    'Rua da Expiração',
    '21',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    4,
    '60000000-0000-4000-8000-000000000001'
  )::text,
  true
);
reset role;

with facts as (
  select
    pg_catalog.current_setting('set_livre.test.f008_expired_limit_create')::jsonb
      ->> 'studioId' as studio_id,
    pg_catalog.current_setting('set_livre.test.f008_expired_limit_create')::jsonb
      #>> '{revision,id}' as revision_id,
    pg_catalog.clock_timestamp() - interval '3 hours' as prepared_at
), media_ids as (
  select
    sequence,
    (
      '88000000-0000-4000-8001-'
      || pg_catalog.lpad(sequence::text, 12, '0')
    )::uuid as media_id
  from pg_catalog.generate_series(1, 20) as generated(sequence)
)
insert into public.studio_media (
  id,
  studio_id,
  prepared_revision_id,
  uploaded_by,
  storage_bucket,
  storage_path,
  preview_storage_path,
  declared_mime_type,
  declared_size_bytes,
  status,
  prepared_at,
  upload_expires_at,
  cleanup_after,
  updated_at
)
select
  media_ids.media_id,
  facts.studio_id::uuid,
  facts.revision_id::uuid,
  '81000000-0000-4000-8000-000000000001',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.jpg',
    '81000000-0000-4000-8000-000000000001',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '81000000-0000-4000-8000-000000000001',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  'image/jpeg',
  10,
  'pending_upload',
  facts.prepared_at,
  facts.prepared_at + interval '2 hours',
  facts.prepared_at + interval '24 hours',
  pg_catalog.clock_timestamp()
from facts
cross join media_ids;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_prepare_after_expiry',
  private.prepare_studio_media_upload(
    '81000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f008_expired_limit_create')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f008_expired_limit_create')::jsonb
        #>> '{revision,id}'
    )::uuid,
    1,
    '85000000-0000-4000-8000-000000000012',
    '86000000-0000-4000-8000-000000000016',
    'image/jpeg',
    10,
    null
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_prepare_after_expiry')::jsonb
      ->> 'mediaId' is not null
    and (
      select pg_catalog.count(*) filter (
          where media.status = 'pending_upload'
            and media.upload_expires_at <= pg_catalog.clock_timestamp()
        ) = 20
        and pg_catalog.count(*) filter (
          where media.status = 'pending_upload'
            and media.upload_expires_at > pg_catalog.clock_timestamp()
        ) = 1
      from public.studio_media as media
      where media.prepared_revision_id = (
        pg_catalog.current_setting('set_livre.test.f008_expired_limit_create')::jsonb
          #>> '{revision,id}'
      )::uuid
    ),
  'vinte reservas expiradas permanecem retidas sem bloquear uma nova preparação'
);

savepoint cleanup_index_plans;
with facts as (
  select
    pg_catalog.current_setting('set_livre.test.f008_expired_limit_create')::jsonb
      ->> 'studioId' as studio_id,
    pg_catalog.current_setting('set_livre.test.f008_expired_limit_create')::jsonb
      #>> '{revision,id}' as revision_id,
    pg_catalog.clock_timestamp() - interval '4 hours' as prepared_at
), media_ids as (
  select
    sequence,
    (
      '8e000000-0000-4000-8000-'
      || pg_catalog.lpad(sequence::text, 12, '0')
    )::uuid as media_id
  from pg_catalog.generate_series(1, 512) as generated(sequence)
)
insert into public.studio_media (
  id,
  studio_id,
  prepared_revision_id,
  uploaded_by,
  storage_bucket,
  storage_path,
  preview_storage_path,
  declared_mime_type,
  declared_size_bytes,
  status,
  rejection_code,
  prepared_at,
  upload_expires_at,
  rejected_at,
  cleanup_after,
  updated_at
)
select
  media_ids.media_id,
  facts.studio_id::uuid,
  facts.revision_id::uuid,
  '81000000-0000-4000-8000-000000000001',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.png',
    '81000000-0000-4000-8000-000000000001',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '81000000-0000-4000-8000-000000000001',
    facts.studio_id,
    facts.revision_id,
    media_ids.media_id
  ),
  'image/png',
  10,
  'rejected',
  'validation_failed',
  facts.prepared_at,
  facts.prepared_at + interval '2 hours',
  facts.prepared_at + interval '2 hours',
  facts.prepared_at + interval '2 hours',
  pg_catalog.clock_timestamp()
from facts
cross join media_ids;

with facts as (
  select
    pg_catalog.current_setting('set_livre.test.f008_expired_limit_create')::jsonb
      ->> 'studioId' as studio_id,
    pg_catalog.current_setting('set_livre.test.f008_expired_limit_create')::jsonb
      #>> '{revision,id}' as revision_id,
    pg_catalog.clock_timestamp() - interval '4 hours' as prepared_at
)
insert into public.studio_media (
  id,
  studio_id,
  prepared_revision_id,
  uploaded_by,
  storage_bucket,
  storage_path,
  preview_storage_path,
  declared_mime_type,
  declared_size_bytes,
  status,
  prepared_at,
  upload_expires_at,
  cleanup_after,
  delete_requested_at,
  cleanup_claim_token,
  cleanup_claimed_at,
  cleanup_attempts,
  updated_at
)
select
  '8e000000-0000-4000-8001-000000000001',
  facts.studio_id::uuid,
  facts.revision_id::uuid,
  '81000000-0000-4000-8000-000000000001',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.png',
    '81000000-0000-4000-8000-000000000001',
    facts.studio_id,
    facts.revision_id,
    '8e000000-0000-4000-8001-000000000001'
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '81000000-0000-4000-8000-000000000001',
    facts.studio_id,
    facts.revision_id,
    '8e000000-0000-4000-8001-000000000001'
  ),
  'image/png',
  10,
  'delete_pending',
  facts.prepared_at,
  facts.prepared_at + interval '2 hours',
  facts.prepared_at + interval '2 hours',
  facts.prepared_at + interval '2 hours',
  '8e000000-0000-4000-8002-000000000001',
  pg_catalog.clock_timestamp(),
  1,
  pg_catalog.clock_timestamp()
from facts;

set local enable_seqscan = off;
select ok(
  private.feat008_explain_json(
    $query$
      select media.id
      from public.studio_media as media
      where media.status in ('pending_upload', 'rejected', 'delete_pending')
        and coalesce(media.cleanup_next_attempt_at, media.cleanup_after)
          <= pg_catalog.clock_timestamp()
        and (
          media.cleanup_claimed_at is null
          or media.cleanup_claimed_at
            <= pg_catalog.clock_timestamp() - interval '15 minutes'
        )
      order by coalesce(media.cleanup_next_attempt_at, media.cleanup_after), media.id
      for update skip locked
      limit 100
    $query$
  )::text like '%studio_media_cleanup_dequeue_idx%',
  'EXPLAIN com 512 itens usa o índice de expressão alinhado ao dequeue'
);
select ok(
  private.feat008_explain_json(
    $query$
      select media.id
      from public.studio_media as media
      where media.status = 'delete_pending'
        and media.cleanup_claim_token = '8e000000-0000-4000-8002-000000000001'
        and media.cleanup_claimed_at
          > pg_catalog.clock_timestamp() - interval '15 minutes'
    $query$
  )::text like '%studio_media_cleanup_claim_token_idx%',
  'EXPLAIN usa o índice parcial do replay por claim token ativo'
);
rollback to savepoint cleanup_index_plans;
release savepoint cleanup_index_plans;

set local session_replication_role = replica;
with timing as (
  select pg_catalog.clock_timestamp() as claim_ready_at
)
update public.studio_media as media
set
  prepared_at = timing.claim_ready_at - interval '2 hours 1 second',
  upload_expires_at = timing.claim_ready_at - interval '1 second',
  cleanup_after = timing.claim_ready_at - interval '1 microsecond',
  updated_at = timing.claim_ready_at
from timing
where media.id in (
  pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid,
  pg_catalog.current_setting('set_livre.test.f008_media_3')::uuid
);
set local session_replication_role = origin;

set local role service_role;
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_claim_1',
  public.claim_studio_media_cleanup(
    '87000000-0000-4000-8000-000000000001',
    10
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_claim_replay_equal',
  (
    public.claim_studio_media_cleanup(
      '87000000-0000-4000-8000-000000000001',
      10
    )::text = pg_catalog.current_setting('set_livre.test.f008_cleanup_claim_1')
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.jsonb_array_length(
    pg_catalog.current_setting('set_livre.test.f008_cleanup_claim_1')::jsonb -> 'items'
  ) = 2
    and not exists (
      select 1
      from public.studio_media as media
      where media.id in (
          pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid,
          pg_catalog.current_setting('set_livre.test.f008_media_3')::uuid
        )
        and media.upload_expires_at >= media.cleanup_claimed_at
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        pg_catalog.current_setting('set_livre.test.f008_cleanup_claim_1')::jsonb -> 'items'
      ) as item(value)
      where pg_catalog.jsonb_array_length(item.value -> 'paths') <> 2
        or item.value #>> '{paths,1}' <> pg_catalog.regexp_replace(
          item.value #>> '{paths,0}',
          '\.[a-z]+$',
          '.preview.webp'
        )
    ),
  'claim ocorre após expirar upload e cerca original e prévia no mesmo item'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_claim_replay_equal')::boolean,
  'replay do mesmo claim token não captura lote adicional'
);

set local role service_role;
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_failure_1',
  public.complete_studio_media_cleanup(
    '87000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid,
    false,
    'storage_timeout'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_failure_replay_equal',
  (
    public.complete_studio_media_cleanup(
      '87000000-0000-4000-8000-000000000001',
      pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid,
      false,
      'storage_timeout'
    )::text = pg_catalog.current_setting('set_livre.test.f008_cleanup_failure_1')
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_success_3',
  public.complete_studio_media_cleanup(
    '87000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_media_3')::uuid,
    true,
    null
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_failure_1')::jsonb ->> 'status'
      = 'delete_pending'
    and (
      select media.cleanup_next_attempt_at > pg_catalog.clock_timestamp()
        and media.cleanup_last_error_code = 'storage_timeout'
      from public.studio_media as media
      where media.id = pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid
    ),
  'falha limpa o claim e agenda backoff sem declarar exclusão'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_failure_replay_equal')::boolean,
  'complete de falha é idempotente pelo claim token'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_success_3')::jsonb ->> 'status'
      = 'deleted'
    and (
      select media.deleted_at is not null
        and media.cleanup_claim_token is null
      from public.studio_media as media
      where media.id = pg_catalog.current_setting('set_livre.test.f008_media_3')::uuid
    ),
  'sucesso somente confirma deleted depois do worker remover pela API'
);

update public.studio_media as media
set cleanup_next_attempt_at = pg_catalog.clock_timestamp() - interval '1 microsecond'
where media.id = pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid;

set local role service_role;
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_claim_2',
  public.claim_studio_media_cleanup(
    '87000000-0000-4000-8000-000000000002',
    10
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_success_1',
  public.complete_studio_media_cleanup(
    '87000000-0000-4000-8000-000000000002',
    pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid,
    true,
    null
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.jsonb_array_length(
    pg_catalog.current_setting('set_livre.test.f008_cleanup_claim_2')::jsonb -> 'items'
  ) = 1
    and pg_catalog.current_setting('set_livre.test.f008_cleanup_success_1')::jsonb ->> 'status'
      = 'deleted',
  'novo token reclama somente retry vencido e pode concluí-lo'
);
select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.min(media.cleanup_attempts) >= 1
      and pg_catalog.max(media.cleanup_attempts) = 2
    from public.studio_media as media
    where media.id in (
      pg_catalog.current_setting('set_livre.test.f008_media_1')::uuid,
      pg_catalog.current_setting('set_livre.test.f008_media_3')::uuid
    )
      and media.status = 'deleted'
  ),
  'cleanup preserva ledger relacional e termina ambos os objetos em deleted'
);

select ok(
  private.feat008_capture_error(
    $command$
      select maintenance.prepare_studio_media_cleanup_probe(null)
    $command$
  ) like '22023:invalid_studio_media_cleanup_probe%'
    and private.feat008_capture_error(
      $command$
        select maintenance.abort_studio_media_cleanup_probe(
          '8e000000-0000-4000-8000-000000000001',
          'Unsafe Error'
        )
      $command$
    ) like '22023:invalid_studio_media_cleanup_probe_abort%',
  'fronteira administrativa do probe rejeita run nulo e error_code inseguro'
);

select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_probe_run',
  '8e000000-0000-4000-8000-000000000001',
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_probe_prepared',
  maintenance.prepare_studio_media_cleanup_probe(
    pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run')::uuid
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_probe_prepare_replay_equal',
  (
    maintenance.prepare_studio_media_cleanup_probe(
      pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run')::uuid
    )::text = pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')
  )::text,
  true
);

select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb
      = pg_catalog.jsonb_build_object(
        'runId', pg_catalog.current_setting(
          'set_livre.test.f008_cleanup_probe_run'
        )::uuid,
        'status', 'prepared',
        'bucket', 'studio-media',
        'mediaId', (
          pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb
            ->> 'mediaId'
        )::uuid,
        'paths', pg_catalog.jsonb_build_array(
          pg_catalog.format(
            'owners/%s/studios/%s/revisions/%s/%s.webp',
            pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run'),
            pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run'),
            pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run'),
            pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb
              ->> 'mediaId'
          ),
          pg_catalog.format(
            'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
            pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run'),
            pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run'),
            pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run'),
            pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb
              ->> 'mediaId'
          )
        )
      )
    and pg_catalog.current_setting(
      'set_livre.test.f008_cleanup_probe_prepare_replay_equal'
    )::boolean
    and exists (
      select 1
      from maintenance.studio_media_cleanup_probes as probe
      where probe.run_id = pg_catalog.current_setting(
          'set_livre.test.f008_cleanup_probe_run'
        )::uuid
        and probe.status = 'prepared'
        and probe.cleanup_claim_token is null
    ),
  'prepare retorna cinco campos exatos, paths relacionais e replay com identidade estável'
);

select matches(
  private.feat008_capture_error(
    $command$
      select maintenance.get_studio_media_cleanup_probe(
        '8e000000-0000-4000-8000-000000000001'
      )
    $command$
  ),
  '^P0002:studio_media_cleanup_probe_not_terminal$',
  'get não confunde prepared com prova terminal de remoção'
);

select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_probe_armed',
  maintenance.arm_studio_media_cleanup_probe(
    pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run')::uuid
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_probe_arm_replay_equal',
  (
    maintenance.arm_studio_media_cleanup_probe(
      pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run')::uuid
    )::text = pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_armed')
  )::text,
  true
);

select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_armed')::jsonb
      = pg_catalog.jsonb_set(
        pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb,
        '{status}',
        '"queued"'::jsonb
      )
    and pg_catalog.current_setting(
      'set_livre.test.f008_cleanup_probe_arm_replay_equal'
    )::boolean
    and exists (
      select 1
      from maintenance.studio_media_cleanup_probes as probe
      where probe.run_id = pg_catalog.current_setting(
          'set_livre.test.f008_cleanup_probe_run'
        )::uuid
        and probe.status = 'queued'
        and probe.cleanup_claim_token = probe.run_id
        and probe.cleanup_claimed_at is not null
    ),
  'arm preserva identidade e reserva o item com cleanup_claim_token igual ao runId'
);

set local role service_role;
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_probe_claim',
  public.claim_studio_media_cleanup(
    pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run')::uuid,
    10
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_claim')::jsonb
      = pg_catalog.jsonb_build_object(
        'claimToken', pg_catalog.current_setting(
          'set_livre.test.f008_cleanup_probe_run'
        )::uuid,
        'items', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'mediaId', (
              pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb
                ->> 'mediaId'
            )::uuid,
            'bucket', 'studio-media',
            'paths', pg_catalog.current_setting(
              'set_livre.test.f008_cleanup_probe_prepared'
            )::jsonb -> 'paths',
            'attempt', 1
          )
        )
      ),
  'worker service_role recebe o probe reservado pelo mesmo claim real e com ambos os paths'
);

set local role service_role;
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_probe_complete',
  public.complete_studio_media_cleanup(
    pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run')::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb
        ->> 'mediaId'
    )::uuid,
    true,
    null
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_probe_complete_replay_equal',
  (
    public.complete_studio_media_cleanup(
      pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run')::uuid,
      (
        pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb
          ->> 'mediaId'
      )::uuid,
      true,
      null
    )::text = pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_complete')
  )::text,
  true
);
reset role;
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_probe_terminal',
  maintenance.get_studio_media_cleanup_probe(
    pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_run')::uuid
  )::text,
  true
);

select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_complete')::jsonb
      = pg_catalog.jsonb_build_object(
        'mediaId', (
          pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb
            ->> 'mediaId'
        )::uuid,
        'status', 'deleted',
        'succeeded', true,
        'nextAttemptAt', null::timestamptz
      )
    and pg_catalog.current_setting(
      'set_livre.test.f008_cleanup_probe_complete_replay_equal'
    )::boolean
    and pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_terminal')::jsonb
      = pg_catalog.jsonb_set(
        pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb,
        '{status}',
        '"deleted"'::jsonb
      )
    and exists (
      select 1
      from maintenance.studio_media_cleanup_probes as probe
      where probe.run_id = pg_catalog.current_setting(
          'set_livre.test.f008_cleanup_probe_run'
        )::uuid
        and probe.status = 'deleted'
        and probe.cleanup_last_completed_token = probe.run_id
        and probe.cleanup_last_succeeded
    ),
  'complete terminal é idempotente e get comprova deleted sem mudar mediaId nem paths'
);

select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select public.complete_studio_media_cleanup(
          '8e000000-0000-4000-8000-000000000001', %L::uuid, false, 'storage_timeout'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_cleanup_probe_prepared')::jsonb
        ->> 'mediaId'
    )
  ),
  '^40001:studio_media_cleanup_completion_conflict$',
  'replay terminal conflitante do probe falha fechado'
);

select maintenance.prepare_studio_media_cleanup_probe(
  '8e000000-0000-4000-8000-000000000002'
);
select maintenance.abort_studio_media_cleanup_probe(
  '8e000000-0000-4000-8000-000000000002',
  'probe_preparation_failed'
);
select maintenance.prepare_studio_media_cleanup_probe(
  '8e000000-0000-4000-8000-000000000003'
);
select maintenance.arm_studio_media_cleanup_probe(
  '8e000000-0000-4000-8000-000000000003'
);
select maintenance.abort_studio_media_cleanup_probe(
  '8e000000-0000-4000-8000-000000000003',
  'probe_failed'
);
select maintenance.abort_studio_media_cleanup_probe(
  '8e000000-0000-4000-8000-000000000003',
  'recovery_retry'
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(
        probe.status = 'aborted'
        and probe.cleanup_claim_token is null
        and probe.cleanup_last_completed_token = probe.run_id
        and probe.cleanup_last_succeeded is false
      )
    from maintenance.studio_media_cleanup_probes as probe
    where probe.run_id in (
      '8e000000-0000-4000-8000-000000000002',
      '8e000000-0000-4000-8000-000000000003'
    )
  )
    and private.feat008_capture_error(
      $command$
        select maintenance.get_studio_media_cleanup_probe(
          '8e000000-0000-4000-8000-000000000003'
        )
      $command$
    ) like 'P0002:studio_media_cleanup_probe_not_terminal%',
  'abort é idempotente antes/depois do arm e nunca transforma recuperação em deleted'
);

select policies_are(
  'maintenance',
  'studio_media_cleanup_runs',
  array[]::text[],
  'ledger operacional mantém RLS sem policy permissiva'
);
select policies_are(
  'maintenance',
  'studio_media_cleanup_run_items',
  array[]::text[],
  'histórico de pertencimento mantém RLS sem policy permissiva'
);
select policies_are(
  'maintenance',
  'studio_media_cleanup_probes',
  array[]::text[],
  'probes com paths permanecem privados e sem policy permissiva'
);
select ok(
  not pg_catalog.has_table_privilege(
      'anon',
      'maintenance.studio_media_cleanup_runs',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'authenticated',
      'maintenance.studio_media_cleanup_runs',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'maintenance.studio_media_cleanup_runs',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'anon',
      'maintenance.studio_media_cleanup_run_items',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'authenticated',
      'maintenance.studio_media_cleanup_run_items',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'maintenance.studio_media_cleanup_run_items',
      'SELECT'
    )
    and not exists (
      select 1
      from information_schema.columns as column_definition
      where column_definition.table_schema = 'maintenance'
        and column_definition.table_name = 'studio_media_cleanup_runs'
        and (
          column_definition.column_name ~ '(path|secret|url|payload)'
          or column_definition.column_name in ('pg_net_request_id', 'queued_at')
        )
    )
    and private.feat008_capture_error(
      $command$
        insert into maintenance.studio_media_cleanup_runs (
          run_id,
          function_slug,
          status,
          started_at
        ) values (
          '8d000000-0000-4000-8000-000000000000',
          'media-cleanup-dddddddddddddddddddddddddddddddddddddddd',
          'queued',
          pg_catalog.clock_timestamp()
        )
      $command$
    ) like '23514:%',
  'ledger não expõe dados operacionais sensíveis nem aceita pg_net_request_id/queued'
);

savepoint cleanup_run_health_explain;
insert into maintenance.studio_media_cleanup_runs (
  run_id,
  function_slug,
  status,
  started_at,
  updated_at
)
select
  extensions.gen_random_uuid(),
  'media-cleanup-dddddddddddddddddddddddddddddddddddddddd',
  'running',
  sample.started_at,
  sample.started_at
from (
  select
    generated.sequence,
    pg_catalog.clock_timestamp() - generated.sequence * interval '1 minute' as started_at
  from pg_catalog.generate_series(1, 512) as generated(sequence)
) as sample;
insert into maintenance.studio_media_cleanup_runs (
  run_id,
  function_slug,
  status,
  claimed_count,
  deleted_count,
  failed_count,
  error_code,
  started_at,
  completed_at,
  updated_at
)
select
  extensions.gen_random_uuid(),
  'media-cleanup-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  sample.status,
  0,
  0,
  0,
  case when sample.status = 'failed' then 'fixture_failure' else null end,
  sample.started_at,
  sample.started_at + interval '1 second',
  sample.started_at + interval '1 second'
from (
  select
    generated.sequence,
    case when generated.sequence % 5 = 0 then 'failed' else 'succeeded' end as status,
    pg_catalog.clock_timestamp() - generated.sequence * interval '1 minute' as started_at
  from pg_catalog.generate_series(1, 1536) as generated(sequence)
) as sample;

with sample as (
  select
    generated.sequence,
    extensions.gen_random_uuid() as run_id,
    extensions.gen_random_uuid() as media_id,
    case when generated.sequence % 3 = 0 then 'aborted' else 'deleted' end as status,
    pg_catalog.clock_timestamp() - generated.sequence * interval '1 day' as prepared_at
  from pg_catalog.generate_series(1, 512) as generated(sequence)
)
insert into maintenance.studio_media_cleanup_probes (
  run_id,
  media_id,
  storage_bucket,
  storage_path,
  preview_storage_path,
  status,
  cleanup_claim_token,
  cleanup_claimed_at,
  cleanup_last_completed_token,
  cleanup_last_succeeded,
  error_code,
  prepared_at,
  completed_at,
  updated_at
)
select
  sample.run_id,
  sample.media_id,
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.webp',
    sample.run_id,
    sample.run_id,
    sample.run_id,
    sample.media_id
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    sample.run_id,
    sample.run_id,
    sample.run_id,
    sample.media_id
  ),
  sample.status,
  null,
  null,
  sample.run_id,
  sample.status = 'deleted',
  case when sample.status = 'aborted' then 'fixture_abort' else null end,
  sample.prepared_at,
  sample.prepared_at + interval '1 second',
  sample.prepared_at + interval '1 second'
from sample;

analyze maintenance.studio_media_cleanup_runs;
analyze maintenance.studio_media_cleanup_probes;
set local enable_seqscan = off;
select ok(
  private.feat008_explain_json(
    $plan$
      select 1
      from maintenance.studio_media_cleanup_runs as run
      where run.status = 'running'
        and run.started_at <= pg_catalog.now() - interval '30 minutes'
      limit 1
    $plan$
  )::text like '%studio_media_cleanup_runs_active_age_idx%'
    and private.feat008_explain_json(
      $plan$
        select 1
        from maintenance.studio_media_cleanup_runs as failed_run
        where failed_run.status = 'failed'
          and failed_run.completed_at > coalesce(
            (
              select pg_catalog.max(succeeded_run.completed_at)
              from maintenance.studio_media_cleanup_runs as succeeded_run
              where succeeded_run.status = 'succeeded'
            ),
            '-infinity'::timestamptz
          )
        limit 1
      $plan$
    )::text like '%studio_media_cleanup_runs_terminal_completed_idx%'
    and private.feat008_explain_json(
      $plan$
        select run.run_id
        from maintenance.studio_media_cleanup_runs as run
        where run.status in ('succeeded', 'failed')
          and run.completed_at < pg_catalog.now() - interval '30 days'
        limit 1
      $plan$
    )::text like '%studio_media_cleanup_runs_terminal_completed_idx%'
    and private.feat008_explain_json(
      $plan$
        select probe.run_id
        from maintenance.studio_media_cleanup_probes as probe
        where probe.status in ('deleted', 'aborted')
          and probe.completed_at < pg_catalog.now() - interval '30 days'
        limit 1
      $plan$
    )::text like '%studio_media_cleanup_probes_terminal_completed_idx%',
  'EXPLAIN ANALYZE prova os índices mínimos de health e retenção para runs/probes volumosos'
);
rollback to savepoint cleanup_run_health_explain;
release savepoint cleanup_run_health_explain;

select ok(
  private.feat008_capture_error(
    $command$
      select public.begin_studio_media_cleanup_run(
        null,
        'media-cleanup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    $command$
  ) like '22023:invalid_studio_media_cleanup_run_begin%'
    and private.feat008_capture_error(
      $command$
        select public.begin_studio_media_cleanup_run(
          '8c000000-0000-4000-8000-000000000001',
          'media-cleanup-not-a-sha'
        )
      $command$
    ) like '22023:invalid_studio_media_cleanup_run_begin%',
  'begin rejeita run_id nulo e slug fora de media-cleanup-<40hex>'
);

set local role service_role;
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_run_begin',
  public.begin_studio_media_cleanup_run(
    '8c000000-0000-4000-8000-000000000001',
    'media-cleanup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_run_begin_replay_equal',
  (
    public.begin_studio_media_cleanup_run(
      '8c000000-0000-4000-8000-000000000001',
      'media-cleanup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )::text = pg_catalog.current_setting('set_livre.test.f008_cleanup_run_begin')
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_run_begin')::jsonb
      ->> 'status' = 'running'
    and pg_catalog.current_setting('set_livre.test.f008_cleanup_run_begin')::jsonb
      ->> 'functionSlug' = 'media-cleanup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    and pg_catalog.current_setting(
      'set_livre.test.f008_cleanup_run_begin_replay_equal'
    )::boolean
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(run.status = 'running')
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id = '8c000000-0000-4000-8000-000000000001'
    ),
  'begin cria running atomicamente e replay do mesmo run_id/slug converge'
);
select matches(
  private.feat008_capture_error(
    $command$
      select public.begin_studio_media_cleanup_run(
        '8c000000-0000-4000-8000-000000000001',
        'media-cleanup-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      )
    $command$
  ),
  '^40001:studio_media_cleanup_run_begin_conflict$',
  'replay do mesmo run_id com slug divergente falha fechado'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select public.complete_studio_media_cleanup_run(
          '8c000000-0000-4000-8000-000000000001',
          'succeeded',
          2,
          1,
          0,
          null
        )
      $command$
    )
  ),
  '^22023:invalid_studio_media_cleanup_run_completion$',
  'complete rejeita claimed diferente de deleted mais failed'
);

insert into maintenance.studio_media_cleanup_run_items (
  run_id,
  item_kind,
  media_id,
  outcome,
  claimed_at,
  completed_at
)
values
  (
    '8c000000-0000-4000-8000-000000000001',
    'media',
    '8c000000-0000-4000-8000-000000000101',
    'deleted',
    pg_catalog.clock_timestamp() - interval '2 seconds',
    pg_catalog.clock_timestamp() - interval '1 second'
  ),
  (
    '8c000000-0000-4000-8000-000000000001',
    'media',
    '8c000000-0000-4000-8000-000000000102',
    'deleted',
    pg_catalog.clock_timestamp() - interval '2 seconds',
    pg_catalog.clock_timestamp() - interval '1 second'
  );

set local role service_role;
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_run_complete',
  public.complete_studio_media_cleanup_run(
    '8c000000-0000-4000-8000-000000000001',
    'succeeded',
    2,
    2,
    0,
    null
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_run_complete_replay_equal',
  (
    public.complete_studio_media_cleanup_run(
      '8c000000-0000-4000-8000-000000000001',
      'succeeded',
      2,
      2,
      0,
      null
    )::text = pg_catalog.current_setting('set_livre.test.f008_cleanup_run_complete')
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_cleanup_run_terminal_replay_equal',
  (
    public.begin_studio_media_cleanup_run(
      '8c000000-0000-4000-8000-000000000001',
      'media-cleanup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )::text = pg_catalog.current_setting('set_livre.test.f008_cleanup_run_complete')
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_cleanup_run_complete')::jsonb
      ->> 'status' = 'succeeded'
    and pg_catalog.current_setting('set_livre.test.f008_cleanup_run_complete')::jsonb
      ->> 'functionSlug' = 'media-cleanup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    and pg_catalog.current_setting(
      'set_livre.test.f008_cleanup_run_complete_replay_equal'
    )::boolean
    and pg_catalog.current_setting(
      'set_livre.test.f008_cleanup_run_terminal_replay_equal'
    )::boolean
    and private.studio_media_cleanup_runs_are_healthy(),
  'complete e replay terminal convergem; o último sucesso mantém health verde'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select public.complete_studio_media_cleanup_run(
          '8c000000-0000-4000-8000-000000000001',
          'failed',
          2,
          1,
          1,
          'storage_timeout'
        )
      $command$
    )
  ),
  '^40001:studio_media_cleanup_run_completion_conflict$',
  'retry terminal divergente falha fechado'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      'update maintenance.studio_media_cleanup_runs set function_slug = %L where run_id = %L',
      'media-cleanup-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '8c000000-0000-4000-8000-000000000001'
    )
  ),
  '^23514:studio_media_cleanup_run_immutable$',
  'slug por SHA não pode mudar depois do begin'
);

savepoint cleanup_retention;
with fixture (
  run_id,
  function_slug,
  status,
  started_at,
  completed_at,
  error_code
) as (
  values
    (
      '8d000000-0000-4000-8000-000000000101'::uuid,
      'media-cleanup-dddddddddddddddddddddddddddddddddddddddd',
      'succeeded'::text,
      pg_catalog.clock_timestamp() - interval '31 days 1 second',
      pg_catalog.clock_timestamp() - interval '31 days',
      null::text
    ),
    (
      '8d000000-0000-4000-8000-000000000102'::uuid,
      'media-cleanup-dddddddddddddddddddddddddddddddddddddddd',
      'failed'::text,
      pg_catalog.clock_timestamp() - interval '31 days 1 second',
      pg_catalog.clock_timestamp() - interval '31 days',
      'fixture_failure'::text
    ),
    (
      '8d000000-0000-4000-8000-000000000103'::uuid,
      'media-cleanup-dddddddddddddddddddddddddddddddddddddddd',
      'succeeded'::text,
      pg_catalog.clock_timestamp() - interval '29 days 1 second',
      pg_catalog.clock_timestamp() - interval '29 days',
      null::text
    ),
    (
      '8d000000-0000-4000-8000-000000000104'::uuid,
      'media-cleanup-dddddddddddddddddddddddddddddddddddddddd',
      'running'::text,
      pg_catalog.clock_timestamp() - interval '31 days',
      null::timestamptz,
      null::text
    )
)
insert into maintenance.studio_media_cleanup_runs (
  run_id,
  function_slug,
  status,
  claimed_count,
  deleted_count,
  failed_count,
  error_code,
  started_at,
  completed_at,
  updated_at
)
select
  fixture.run_id,
  fixture.function_slug,
  fixture.status,
  case when fixture.status in ('succeeded', 'failed') then 0 end,
  case when fixture.status in ('succeeded', 'failed') then 0 end,
  case when fixture.status in ('succeeded', 'failed') then 0 end,
  fixture.error_code,
  fixture.started_at,
  fixture.completed_at,
  coalesce(fixture.completed_at, fixture.started_at)
from fixture;

with fixture (run_id, media_id, status, prepared_at, completed_at) as (
  values
    (
      '8d000000-0000-4000-8000-000000000201'::uuid,
      '8d000000-0000-4000-8000-000000000301'::uuid,
      'deleted'::text,
      pg_catalog.clock_timestamp() - interval '31 days 1 second',
      pg_catalog.clock_timestamp() - interval '31 days'
    ),
    (
      '8d000000-0000-4000-8000-000000000202'::uuid,
      '8d000000-0000-4000-8000-000000000302'::uuid,
      'aborted'::text,
      pg_catalog.clock_timestamp() - interval '31 days 1 second',
      pg_catalog.clock_timestamp() - interval '31 days'
    ),
    (
      '8d000000-0000-4000-8000-000000000203'::uuid,
      '8d000000-0000-4000-8000-000000000303'::uuid,
      'prepared'::text,
      pg_catalog.clock_timestamp() - interval '31 days',
      null::timestamptz
    ),
    (
      '8d000000-0000-4000-8000-000000000204'::uuid,
      '8d000000-0000-4000-8000-000000000304'::uuid,
      'queued'::text,
      pg_catalog.clock_timestamp() - interval '31 days',
      null::timestamptz
    ),
    (
      '8d000000-0000-4000-8000-000000000205'::uuid,
      '8d000000-0000-4000-8000-000000000305'::uuid,
      'deleted'::text,
      pg_catalog.clock_timestamp() - interval '29 days 1 second',
      pg_catalog.clock_timestamp() - interval '29 days'
    )
)
insert into maintenance.studio_media_cleanup_probes (
  run_id,
  media_id,
  storage_bucket,
  storage_path,
  preview_storage_path,
  status,
  cleanup_claim_token,
  cleanup_claimed_at,
  cleanup_last_completed_token,
  cleanup_last_succeeded,
  error_code,
  prepared_at,
  completed_at,
  updated_at
)
select
  fixture.run_id,
  fixture.media_id,
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.webp',
    fixture.run_id,
    fixture.run_id,
    fixture.run_id,
    fixture.media_id
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    fixture.run_id,
    fixture.run_id,
    fixture.run_id,
    fixture.media_id
  ),
  fixture.status,
  case when fixture.status = 'queued' then fixture.run_id end,
  case when fixture.status = 'queued' then fixture.prepared_at + interval '1 second' end,
  case when fixture.status in ('deleted', 'aborted') then fixture.run_id end,
  case
    when fixture.status = 'deleted' then true
    when fixture.status = 'aborted' then false
  end,
  case when fixture.status = 'aborted' then 'fixture_abort' end,
  fixture.prepared_at,
  fixture.completed_at,
  coalesce(fixture.completed_at, fixture.prepared_at + interval '1 second')
from fixture;

with timing as (
  select pg_catalog.clock_timestamp() - interval '4 hours' as prepared_at
), fixture (media_id, status, cleanup_succeeded, cleanup_error_code) as (
  values
    (
      '8d000000-0000-4000-8000-000000000401'::uuid,
      'deleted'::text,
      true,
      null::text
    ),
    (
      '8d000000-0000-4000-8000-000000000402'::uuid,
      'delete_pending'::text,
      false,
      'storage_timeout'::text
    )
)
insert into public.studio_media (
  id,
  studio_id,
  prepared_revision_id,
  uploaded_by,
  storage_bucket,
  storage_path,
  preview_storage_path,
  declared_mime_type,
  declared_size_bytes,
  status,
  prepared_at,
  upload_expires_at,
  cleanup_after,
  delete_requested_at,
  deleted_at,
  cleanup_attempts,
  cleanup_last_completed_token,
  cleanup_last_succeeded,
  cleanup_last_error_code,
  updated_at
)
select
  fixture.media_id,
  pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
  pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
  '81000000-0000-4000-8000-000000000001',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.png',
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio'),
    pg_catalog.current_setting('set_livre.test.f008_revision'),
    fixture.media_id
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio'),
    pg_catalog.current_setting('set_livre.test.f008_revision'),
    fixture.media_id
  ),
  'image/png',
  10,
  fixture.status,
  timing.prepared_at,
  timing.prepared_at + interval '2 hours',
  case
    when fixture.status = 'delete_pending' then timing.prepared_at + interval '2 hours'
  end,
  timing.prepared_at + interval '2 hours',
  case when fixture.status = 'deleted' then timing.prepared_at + interval '2 hours 1 second' end,
  1,
  '8d000000-0000-4000-8000-000000000104',
  fixture.cleanup_succeeded,
  fixture.cleanup_error_code,
  timing.prepared_at + interval '2 hours 1 second'
from timing
cross join fixture;

with timing as (
  select pg_catalog.clock_timestamp() - interval '31 minutes' as prepared_at
)
insert into maintenance.studio_media_cleanup_probes (
  run_id,
  media_id,
  storage_bucket,
  storage_path,
  preview_storage_path,
  status,
  cleanup_claim_token,
  cleanup_claimed_at,
  prepared_at,
  updated_at
)
select
  '8d000000-0000-4000-8000-000000000104',
  '8d000000-0000-4000-8000-000000000403',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.webp',
    '8d000000-0000-4000-8000-000000000104',
    '8d000000-0000-4000-8000-000000000104',
    '8d000000-0000-4000-8000-000000000104',
    '8d000000-0000-4000-8000-000000000403'
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '8d000000-0000-4000-8000-000000000104',
    '8d000000-0000-4000-8000-000000000104',
    '8d000000-0000-4000-8000-000000000104',
    '8d000000-0000-4000-8000-000000000403'
  ),
  'queued',
  '8d000000-0000-4000-8000-000000000104',
  timing.prepared_at + interval '1 second',
  timing.prepared_at,
  timing.prepared_at + interval '1 second'
from timing;

select maintenance.persist_studio_media_cleanup_run_items(
  '8d000000-0000-4000-8000-000000000104'
);

set local role service_role;
select public.begin_studio_media_cleanup_run(
  '8d000000-0000-4000-8000-000000000999',
  'media-cleanup-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
);
reset role;
select ok(
  not exists (
      select 1
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id in (
        '8d000000-0000-4000-8000-000000000101',
        '8d000000-0000-4000-8000-000000000102'
      )
    )
    and (
      select pg_catalog.count(*) = 3
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id in (
        '8d000000-0000-4000-8000-000000000103',
        '8d000000-0000-4000-8000-000000000104',
        '8d000000-0000-4000-8000-000000000999'
      )
    )
    and exists (
      select 1
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id = '8d000000-0000-4000-8000-000000000104'
        and run.status = 'failed'
        and run.claimed_count = 3
        and run.deleted_count = 1
        and run.failed_count = 2
        and run.error_code = 'cleanup_run_abandoned'
        and run.completed_at is not null
    )
    and not exists (
      select 1
      from maintenance.studio_media_cleanup_probes as probe
      where probe.run_id in (
        '8d000000-0000-4000-8000-000000000201',
        '8d000000-0000-4000-8000-000000000202'
      )
    )
    and (
      select pg_catalog.count(*) = 3
      from maintenance.studio_media_cleanup_probes as probe
      where probe.run_id in (
        '8d000000-0000-4000-8000-000000000203',
        '8d000000-0000-4000-8000-000000000204',
        '8d000000-0000-4000-8000-000000000205'
      )
    ),
  'begin retém 30 dias, terminaliza run abandonado e não purga probe não terminal'
);
select ok(
  exists (
      select 1
      from public.studio_media as media
      where media.id = '8d000000-0000-4000-8000-000000000401'
        and media.cleanup_last_completed_token
          = '8d000000-0000-4000-8000-000000000104'
        and media.cleanup_last_succeeded is true
    )
    and exists (
      select 1
      from public.studio_media as media
      where media.id = '8d000000-0000-4000-8000-000000000402'
        and media.cleanup_last_completed_token
          = '8d000000-0000-4000-8000-000000000104'
        and media.cleanup_last_succeeded is false
    )
    and exists (
      select 1
      from maintenance.studio_media_cleanup_probes as probe
      where probe.run_id = '8d000000-0000-4000-8000-000000000104'
        and probe.status = 'queued'
        and probe.cleanup_claim_token = probe.run_id
        and probe.cleanup_last_completed_token is null
    )
    and exists (
      select 1
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id = '8d000000-0000-4000-8000-000000000104'
        and run.status = 'failed'
        and run.claimed_count = 3
        and run.deleted_count = 1
        and run.failed_count = 2
        and run.claimed_count = run.deleted_count + run.failed_count
    ),
  'abandono deriva uma exclusão, uma falha e um claim ainda em voo dos tokens persistidos'
);

set local role service_role;
select public.complete_studio_media_cleanup_run(
  '8d000000-0000-4000-8000-000000000999',
  'succeeded',
  0,
  0,
  0,
  null
);
reset role;
select ok(
  private.studio_media_cleanup_runs_are_healthy()
    and private.managed_runtime_boundaries_are_ready(),
  'sucesso posterior ao abandono restaura health/readiness sem intervenção manual'
);
rollback to savepoint cleanup_retention;
release savepoint cleanup_retention;

savepoint cleanup_run_membership_reuse;
with timing as (
  select pg_catalog.clock_timestamp() - interval '10 days' as prepared_at
)
insert into public.studio_media (
  id,
  studio_id,
  prepared_revision_id,
  uploaded_by,
  storage_bucket,
  storage_path,
  preview_storage_path,
  declared_mime_type,
  declared_size_bytes,
  status,
  prepared_at,
  upload_expires_at,
  cleanup_after,
  delete_requested_at,
  cleanup_attempts,
  updated_at
)
select
  '8d000000-0000-4000-8000-000000000450',
  pg_catalog.current_setting('set_livre.test.f008_studio')::uuid,
  pg_catalog.current_setting('set_livre.test.f008_revision')::uuid,
  '81000000-0000-4000-8000-000000000001',
  'studio-media',
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.png',
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio'),
    pg_catalog.current_setting('set_livre.test.f008_revision'),
    '8d000000-0000-4000-8000-000000000450'
  ),
  pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    '81000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f008_studio'),
    pg_catalog.current_setting('set_livre.test.f008_revision'),
    '8d000000-0000-4000-8000-000000000450'
  ),
  'image/png',
  10,
  'delete_pending',
  timing.prepared_at,
  timing.prepared_at + interval '2 hours',
  timing.prepared_at + interval '2 hours',
  timing.prepared_at + interval '2 hours',
  0,
  timing.prepared_at + interval '2 hours'
from timing;

insert into maintenance.studio_media_cleanup_runs (
  run_id,
  function_slug,
  status,
  started_at,
  updated_at
)
values (
  '8d000000-0000-4000-8000-000000000451',
  'media-cleanup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'running',
  pg_catalog.clock_timestamp() - interval '31 minutes',
  pg_catalog.clock_timestamp() - interval '31 minutes'
);

set local role service_role;
select public.claim_studio_media_cleanup(
  '8d000000-0000-4000-8000-000000000451',
  1
);
reset role;

update public.studio_media as media
set cleanup_claimed_at = pg_catalog.clock_timestamp() - interval '16 minutes'
where media.id = '8d000000-0000-4000-8000-000000000450';

insert into maintenance.studio_media_cleanup_runs (
  run_id,
  function_slug,
  status,
  started_at,
  updated_at
)
values (
  '8d000000-0000-4000-8000-000000000452',
  'media-cleanup-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'running',
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp()
);

set local role service_role;
select public.claim_studio_media_cleanup(
  '8d000000-0000-4000-8000-000000000452',
  1
);
select public.complete_studio_media_cleanup(
  '8d000000-0000-4000-8000-000000000452',
  '8d000000-0000-4000-8000-000000000450',
  true,
  null
);
select public.complete_studio_media_cleanup_run(
  '8d000000-0000-4000-8000-000000000452',
  'succeeded',
  1,
  1,
  0,
  null
);
select public.begin_studio_media_cleanup_run(
  '8d000000-0000-4000-8000-000000000453',
  'media-cleanup-cccccccccccccccccccccccccccccccccccccccc'
);
reset role;

select ok(
  exists (
      select 1
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id = '8d000000-0000-4000-8000-000000000451'
        and run.status = 'failed'
        and run.claimed_count = 1
        and run.deleted_count = 0
        and run.failed_count = 1
        and run.error_code = 'cleanup_run_abandoned'
    )
    and exists (
      select 1
      from maintenance.studio_media_cleanup_run_items as item
      where item.run_id = '8d000000-0000-4000-8000-000000000451'
        and item.item_kind = 'media'
        and item.media_id = '8d000000-0000-4000-8000-000000000450'
        and item.outcome = 'failed'
        and item.completed_at is not null
    )
    and exists (
      select 1
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id = '8d000000-0000-4000-8000-000000000452'
        and run.status = 'succeeded'
        and run.claimed_count = 1
        and run.deleted_count = 1
        and run.failed_count = 0
    )
    and exists (
      select 1
      from maintenance.studio_media_cleanup_run_items as item
      where item.run_id = '8d000000-0000-4000-8000-000000000452'
        and item.item_kind = 'media'
        and item.media_id = '8d000000-0000-4000-8000-000000000450'
        and item.outcome = 'deleted'
    )
    and exists (
      select 1
      from public.studio_media as media
      where media.id = '8d000000-0000-4000-8000-000000000450'
        and media.status = 'deleted'
        and media.cleanup_last_completed_token
          = '8d000000-0000-4000-8000-000000000452'
        and media.cleanup_last_succeeded is true
    )
    and private.feat008_capture_error(
      $command$
        update maintenance.studio_media_cleanup_run_items
        set outcome = 'deleted'
        where run_id = '8d000000-0000-4000-8000-000000000451'
          and item_kind = 'media'
          and media_id = '8d000000-0000-4000-8000-000000000450'
      $command$
    ) = '23514:studio_media_cleanup_run_item_immutable',
  'reclaim e conclusão por run B não apagam o claim histórico usado para abandonar run A'
);
rollback to savepoint cleanup_run_membership_reuse;
release savepoint cleanup_run_membership_reuse;

savepoint cleanup_failed_health;
set local role service_role;
select public.begin_studio_media_cleanup_run(
  '8c000000-0000-4000-8000-000000000002',
  'media-cleanup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);
select public.complete_studio_media_cleanup_run(
  '8c000000-0000-4000-8000-000000000002',
  'failed',
  0,
  0,
  0,
  'storage_timeout'
);
reset role;
select ok(
  not private.studio_media_cleanup_runs_are_healthy()
    and not private.managed_runtime_boundaries_are_ready(),
  'health detecta falha terminal posterior ao último sucesso'
);
rollback to savepoint cleanup_failed_health;
release savepoint cleanup_failed_health;

savepoint cleanup_stale_health;
insert into maintenance.studio_media_cleanup_runs (
  run_id,
  function_slug,
  status,
  started_at,
  updated_at
)
values (
  '8d000000-0000-4000-8000-000000000001',
  'media-cleanup-cccccccccccccccccccccccccccccccccccccccc',
  'running',
  pg_catalog.clock_timestamp() - interval '31 minutes',
  pg_catalog.clock_timestamp() - interval '31 minutes'
);
select ok(
  not private.studio_media_cleanup_runs_are_healthy()
    and not private.managed_runtime_boundaries_are_ready(),
  'health/readiness detectam execução running envelhecida'
);
rollback to savepoint cleanup_stale_health;
release savepoint cleanup_stale_health;

savepoint cleanup_stale_success_health;
delete from maintenance.studio_media_cleanup_probes;
delete from maintenance.studio_media_cleanup_runs;
insert into maintenance.studio_media_cleanup_runs (
  run_id,
  function_slug,
  status,
  claimed_count,
  deleted_count,
  failed_count,
  error_code,
  started_at,
  completed_at,
  updated_at
)
values (
  '8d000000-0000-4000-8000-000000000002',
  'media-cleanup-cccccccccccccccccccccccccccccccccccccccc',
  'succeeded',
  0,
  0,
  0,
  null,
  pg_catalog.clock_timestamp() - interval '31 minutes 1 second',
  pg_catalog.clock_timestamp() - interval '31 minutes',
  pg_catalog.clock_timestamp() - interval '31 minutes'
);
select ok(
  not private.studio_media_cleanup_runs_are_healthy()
    and not private.managed_runtime_boundaries_are_ready(),
  'health/readiness degradam quando o worker deixa de publicar sucesso por trinta minutos'
);
rollback to savepoint cleanup_stale_success_health;
release savepoint cleanup_stale_success_health;

create extension if not exists dblink with schema extensions;
create temporary table feat008_concurrency_results (
  label text primary key,
  result jsonb,
  error_message text
);

do $block$
declare
  connection_name text;
  connection_string text := pg_catalog.format(
    'host=%s port=%s dbname=%I user=%I password=%s',
    pg_catalog.inet_server_addr(),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    'supabase_admin',
    'postgres'
  );
begin
  foreach connection_name in array array[
    'feat008_limit_a',
    'feat008_limit_b',
    'feat008_finalize_a',
    'feat008_finalize_b',
    'feat008_claim_a',
    'feat008_claim_b',
    'feat008_claim_c',
    'feat008_claim_finalize_owner',
    'feat008_claim_finalize_terminal',
    'feat008_claim_reject_owner',
    'feat008_claim_reject_terminal',
    'feat008_cleanup_a',
    'feat008_cleanup_b'
  ]
  loop
    perform extensions.dblink_connect(connection_name, connection_string);
  end loop;

  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_finalize_acquired', remote_result.result
  from extensions.dblink(
    'feat008_claim_finalize_terminal',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000223',
        '82300000-0000-4000-8000-000000000236',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'claimed_finalize'
    $remote$
  ) as remote_result(result jsonb);
  perform extensions.dblink_exec('feat008_claim_finalize_owner', 'begin');
  perform extensions.dblink_exec(
    'feat008_claim_finalize_owner',
    $remote$
      do $owner_lock$
      begin
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            '8f000000-0000-4000-8000-000000000008:82300000-0000-4000-8000-000000000223',
            0
          )
        );
        perform private.assert_studio_owner_mutable(
          '8f000000-0000-4000-8000-000000000008'
        );
      end;
      $owner_lock$;
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat008_claim_finalize_terminal',
    $remote$
      select private.finalize_studio_media_upload_claimed(
        claim.lease_token,
        '82300000-0000-4000-8000-000000000237',
        'image/png',
        100,
        1,
        1,
        pg_catalog.repeat('d', 64)
      )
      from private.feat008_concurrency_fixtures as fixture
      join private.studio_media_finalize_claims as claim on claim.media_id = fixture.media_id
      where fixture.label = 'claimed_finalize'
        and claim.idempotency_key = '82300000-0000-4000-8000-000000000223'
    $remote$
  );
  perform pg_catalog.pg_sleep(0.2);
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_finalize_waiting', remote_result.result
  from extensions.dblink(
    'feat008_claim_finalize_owner',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000223',
        '82300000-0000-4000-8000-000000000238',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'claimed_finalize'
    $remote$
  ) as remote_result(result jsonb);
  perform extensions.dblink_exec('feat008_claim_finalize_owner', 'commit');
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_finalize_terminal', remote_result.result
  from extensions.dblink_get_result(
    'feat008_claim_finalize_terminal'
  ) as remote_result(result jsonb);
  perform remote_result.result
  from extensions.dblink_get_result(
    'feat008_claim_finalize_terminal'
  ) as remote_result(result jsonb);
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_finalize_replay', remote_result.result
  from extensions.dblink(
    'feat008_claim_finalize_owner',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000223',
        '82300000-0000-4000-8000-000000000239',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'claimed_finalize'
    $remote$
  ) as remote_result(result jsonb);
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_finalize_released', pg_catalog.to_jsonb(remote_result.result)
  from extensions.dblink(
    'feat008_claim_finalize_terminal',
    $remote$
      select private.release_studio_media_finalize_claim(claim.lease_token)
      from private.feat008_concurrency_fixtures as fixture
      join private.studio_media_finalize_claims as claim on claim.media_id = fixture.media_id
      where fixture.label = 'claimed_finalize'
        and claim.idempotency_key = '82300000-0000-4000-8000-000000000223'
    $remote$
  ) as remote_result(result boolean);

  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_reject_acquired', remote_result.result
  from extensions.dblink(
    'feat008_claim_reject_terminal',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000224',
        '82300000-0000-4000-8000-000000000240',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'claimed_reject'
    $remote$
  ) as remote_result(result jsonb);
  perform extensions.dblink_exec('feat008_claim_reject_owner', 'begin');
  perform extensions.dblink_exec(
    'feat008_claim_reject_owner',
    $remote$
      do $owner_lock$
      begin
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            '8f000000-0000-4000-8000-000000000008:82300000-0000-4000-8000-000000000224',
            0
          )
        );
        perform private.assert_studio_owner_mutable(
          '8f000000-0000-4000-8000-000000000008'
        );
      end;
      $owner_lock$;
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat008_claim_reject_terminal',
    $remote$
      select private.reject_studio_media_upload_claimed(
        claim.lease_token,
        '82300000-0000-4000-8000-000000000241',
        'validation_failed'
      )
      from private.feat008_concurrency_fixtures as fixture
      join private.studio_media_finalize_claims as claim on claim.media_id = fixture.media_id
      where fixture.label = 'claimed_reject'
        and claim.idempotency_key = '82300000-0000-4000-8000-000000000224'
    $remote$
  );
  perform pg_catalog.pg_sleep(0.2);
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_reject_waiting', remote_result.result
  from extensions.dblink(
    'feat008_claim_reject_owner',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000224',
        '82300000-0000-4000-8000-000000000242',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'claimed_reject'
    $remote$
  ) as remote_result(result jsonb);
  perform extensions.dblink_exec('feat008_claim_reject_owner', 'commit');
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_reject_terminal', remote_result.result
  from extensions.dblink_get_result(
    'feat008_claim_reject_terminal'
  ) as remote_result(result jsonb);
  perform remote_result.result
  from extensions.dblink_get_result(
    'feat008_claim_reject_terminal'
  ) as remote_result(result jsonb);
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_reject_replay', remote_result.result
  from extensions.dblink(
    'feat008_claim_reject_owner',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000224',
        '82300000-0000-4000-8000-000000000243',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'claimed_reject'
    $remote$
  ) as remote_result(result jsonb);
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claimed_reject_released', pg_catalog.to_jsonb(remote_result.result)
  from extensions.dblink(
    'feat008_claim_reject_terminal',
    $remote$
      select private.release_studio_media_finalize_claim(claim.lease_token)
      from private.feat008_concurrency_fixtures as fixture
      join private.studio_media_finalize_claims as claim on claim.media_id = fixture.media_id
      where fixture.label = 'claimed_reject'
        and claim.idempotency_key = '82300000-0000-4000-8000-000000000224'
    $remote$
  ) as remote_result(result boolean);

  insert into feat008_concurrency_results (label, result)
  select 'feat008_claim_acquired_a', remote_result.result
  from extensions.dblink(
    'feat008_claim_a',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000221',
        '82300000-0000-4000-8000-000000000231',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'finalize'
    $remote$
  ) as remote_result(result jsonb);
  perform extensions.dblink_disconnect('feat008_claim_a');
  perform extensions.dblink_exec(
    'feat008_claim_b',
    $remote$
      update private.studio_media_finalize_claims as claim
      set
        lease_claimed_at = pg_catalog.clock_timestamp(),
        lease_expires_at = pg_catalog.clock_timestamp() + interval '1 second'
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'finalize'
        and claim.media_id = fixture.media_id
    $remote$
  );
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claim_renewed_a', remote_result.result
  from extensions.dblink(
    'feat008_claim_b',
    $remote$
      select private.renew_studio_media_finalize_claim(claim.lease_token)
      from private.feat008_concurrency_fixtures as fixture
      join private.studio_media_finalize_claims as claim on claim.media_id = fixture.media_id
      where fixture.label = 'finalize'
        and claim.idempotency_key = '82300000-0000-4000-8000-000000000221'
    $remote$
  ) as remote_result(result jsonb);
  perform pg_catalog.pg_sleep(1.1);
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claim_waiting_b', remote_result.result
  from extensions.dblink(
    'feat008_claim_b',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000221',
        '82300000-0000-4000-8000-000000000232',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'finalize'
    $remote$
  ) as remote_result(result jsonb);
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claim_waiting_c', remote_result.result
  from extensions.dblink(
    'feat008_claim_c',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000222',
        '82300000-0000-4000-8000-000000000234',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'finalize'
    $remote$
  ) as remote_result(result jsonb);
  perform extensions.dblink_exec(
    'feat008_claim_b',
    $remote$
      update private.studio_media_finalize_claims as claim
      set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 microsecond'
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'finalize'
        and claim.media_id = fixture.media_id
    $remote$
  );
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claim_acquired_b', remote_result.result
  from extensions.dblink(
    'feat008_claim_b',
    $remote$
      select private.begin_studio_media_finalize_claim(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000221',
        '82300000-0000-4000-8000-000000000232',
        fixture.media_id
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'finalize'
    $remote$
  ) as remote_result(result jsonb);
  insert into feat008_concurrency_results (label, result)
  select
    'feat008_claim_stale_release_a',
    pg_catalog.to_jsonb(
      private.release_studio_media_finalize_claim(
        (acquired.result ->> 'claimToken')::uuid
      )
    )
  from feat008_concurrency_results as acquired
  where acquired.label = 'feat008_claim_acquired_a';
  insert into feat008_concurrency_results (label, result)
  select 'feat008_claim_released_b', pg_catalog.to_jsonb(remote_result.result)
  from extensions.dblink(
    'feat008_claim_b',
    $remote$
      select private.release_studio_media_finalize_claim(claim.lease_token)
      from private.feat008_concurrency_fixtures as fixture
      join private.studio_media_finalize_claims as claim on claim.media_id = fixture.media_id
      where fixture.label = 'finalize'
        and claim.idempotency_key = '82300000-0000-4000-8000-000000000221'
    $remote$
  ) as remote_result(result boolean);
  perform extensions.dblink_exec(
    'feat008_cleanup_a',
    $remote$
      update public.studio_media
      set cleanup_after = pg_catalog.clock_timestamp() - interval '1 second'
      where id in (
        '89000000-0000-4000-8000-000000000101',
        '89000000-0000-4000-8000-000000000102'
      )
    $remote$
  );

  perform extensions.dblink_send_query(
    'feat008_limit_a',
    $remote$
      select private.prepare_studio_media_upload(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000201',
        '82300000-0000-4000-8000-000000000211',
        'image/png',
        100,
        null
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'limit'
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat008_limit_b',
    $remote$
      select private.prepare_studio_media_upload(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000202',
        '82300000-0000-4000-8000-000000000212',
        'image/png',
        100,
        null
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'limit'
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat008_finalize_a',
    $remote$
      select private.finalize_studio_media_upload(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000221',
        '82300000-0000-4000-8000-000000000231',
        fixture.media_id,
        'image/png',
        100,
        1,
        1,
        pg_catalog.repeat('c', 64)
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'finalize'
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat008_finalize_b',
    $remote$
      select private.finalize_studio_media_upload(
        '8f000000-0000-4000-8000-000000000008',
        fixture.studio_id,
        fixture.revision_id,
        1,
        '82300000-0000-4000-8000-000000000221',
        '82300000-0000-4000-8000-000000000232',
        fixture.media_id,
        'image/png',
        100,
        1,
        1,
        pg_catalog.repeat('c', 64)
      )
      from private.feat008_concurrency_fixtures as fixture
      where fixture.label = 'finalize'
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat008_cleanup_a',
    $remote$
      select public.claim_studio_media_cleanup(
        '82300000-0000-4000-8000-000000000241',
        1
      )
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat008_cleanup_b',
    $remote$
      select public.claim_studio_media_cleanup(
        '82300000-0000-4000-8000-000000000242',
        1
      )
    $remote$
  );
end;
$block$;

select ok(
  (select result ->> 'state' from feat008_concurrency_results
    where label = 'feat008_claimed_finalize_acquired') = 'acquired'
    and (select result ->> 'state' from feat008_concurrency_results
      where label = 'feat008_claimed_finalize_waiting') = 'waiting'
    and (select result ->> 'state' from feat008_concurrency_results
      where label = 'feat008_claimed_finalize_replay') = 'replay'
    and (select result -> 'result' from feat008_concurrency_results
      where label = 'feat008_claimed_finalize_replay') = (
        select result
        from feat008_concurrency_results
        where label = 'feat008_claimed_finalize_terminal'
      )
    and (select result from feat008_concurrency_results
      where label = 'feat008_claimed_finalize_released') = 'true'::jsonb
    and exists (
      select 1
      from private.feat008_concurrency_fixtures as fixture
      join private.studio_media_finalize_claims as claim on claim.media_id = fixture.media_id
      join public.studio_media as media on media.id = fixture.media_id
      where fixture.label = 'claimed_finalize'
        and claim.terminal_state = 'finalized'
        and claim.lease_token is null
        and media.status = 'ready'
    ),
  'begin sobreposto à fachada claimed de finalize respeita advisory-owner-claim sem deadlock e relê o terminal'
);
select ok(
  (select result ->> 'state' from feat008_concurrency_results
    where label = 'feat008_claimed_reject_acquired') = 'acquired'
    and (select result ->> 'state' from feat008_concurrency_results
      where label = 'feat008_claimed_reject_waiting') = 'waiting'
    and (select result ->> 'status' from feat008_concurrency_results
      where label = 'feat008_claimed_reject_terminal') = 'rejected'
    and (select result ->> 'state' from feat008_concurrency_results
      where label = 'feat008_claimed_reject_replay') = 'rejected'
    and (select result ->> 'rejectionCode' from feat008_concurrency_results
      where label = 'feat008_claimed_reject_replay') = 'validation_failed'
    and (select result from feat008_concurrency_results
      where label = 'feat008_claimed_reject_released') = 'true'::jsonb
    and exists (
      select 1
      from private.feat008_concurrency_fixtures as fixture
      join private.studio_media_finalize_claims as claim on claim.media_id = fixture.media_id
      join public.studio_media as media on media.id = fixture.media_id
      where fixture.label = 'claimed_reject'
        and claim.terminal_state = 'rejected'
        and claim.terminal_rejection_code = 'validation_failed'
        and claim.lease_token is null
        and media.status = 'rejected'
    ),
  'begin sobreposto à fachada claimed de reject respeita advisory-owner-claim sem deadlock e relê a rejeição'
);

insert into feat008_concurrency_results (label, error_message)
select
  'feat008_claim_conflict_c',
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select private.begin_studio_media_finalize_claim(
          '8f000000-0000-4000-8000-000000000008',
          %L::uuid,
          %L::uuid,
          1,
          '82300000-0000-4000-8000-000000000222',
          '82300000-0000-4000-8000-000000000235',
          %L::uuid
        )
      $command$,
      fixture.studio_id,
      fixture.revision_id,
      fixture.media_id
    )
  )
from private.feat008_concurrency_fixtures as fixture
where fixture.label = 'finalize';

select ok(
  (select result ->> 'state' from feat008_concurrency_results
    where label = 'feat008_claim_acquired_a') = 'acquired'
    and (select result ? 'leaseExpiresAt' from feat008_concurrency_results
      where label = 'feat008_claim_renewed_a')
    and (select result ->> 'state' from feat008_concurrency_results
      where label = 'feat008_claim_waiting_b') = 'waiting'
    and (select result ->> 'state' from feat008_concurrency_results
      where label = 'feat008_claim_waiting_c') = 'waiting'
    and (select result ->> 'state' from feat008_concurrency_results
      where label = 'feat008_claim_acquired_b') = 'acquired'
    and (select result from feat008_concurrency_results
      where label = 'feat008_claim_released_b') = 'true'::jsonb
    and (select result from feat008_concurrency_results
      where label = 'feat008_claim_stale_release_a') = 'false'::jsonb
    and (select error_message from feat008_concurrency_results
      where label = 'feat008_claim_conflict_c')
        = '40001:studio_media_finalize_key_conflict'
    and (select result ->> 'claimToken' from feat008_concurrency_results
      where label = 'feat008_claim_acquired_a') <> (
        select result ->> 'claimToken'
        from feat008_concurrency_results
        where label = 'feat008_claim_acquired_b'
      )
    and (
      select pg_catalog.count(*) = 1
      from private.studio_media_finalize_claims as claim
      where claim.owner_user_id = '8f000000-0000-4000-8000-000000000008'
        and claim.idempotency_key = '82300000-0000-4000-8000-000000000221'
        and claim.latest_request_id = '82300000-0000-4000-8000-000000000232'
        and claim.lease_token is null
        and claim.terminal_state is null
    ),
  'claim único renova a janela terminal, impede takeover após a expiração anterior, troca token expirado e cerca o token antigo'
);
select matches(
  (
    select private.feat008_capture_error(
      pg_catalog.format(
        $command$
          select private.renew_studio_media_finalize_claim(%L::uuid)
        $command$,
        acquired.result ->> 'claimToken'
      )
    )
    from feat008_concurrency_results as acquired
    where acquired.label = 'feat008_claim_acquired_a'
  ),
  '^40001:studio_media_finalize_claim_lost$',
  'token anterior permanece cercado depois de expiração, troca de dono e liberação da lease'
);
select matches(
  (
    select private.feat008_capture_error(
      pg_catalog.format(
        $command$
          select private.begin_studio_media_finalize_claim(
            '8f000000-0000-4000-8000-000000000008',
            %L::uuid,
            %L::uuid,
            1,
            '82300000-0000-4000-8000-000000000221',
            '82300000-0000-4000-8000-000000000239',
            '89000000-0000-4000-8000-000000000001'
          )
        $command$,
        fixture.studio_id,
        fixture.revision_id
      )
    )
    from private.feat008_concurrency_fixtures as fixture
    where fixture.label = 'limit'
  ),
  '^40001:studio_idempotency_conflict$',
  'claim persistido recusa reutilização da chave com outro payload antes do processamento'
);

do $block$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat008_limit_a',
    'feat008_limit_b',
    'feat008_finalize_a',
    'feat008_finalize_b',
    'feat008_claim_finalize_owner',
    'feat008_claim_finalize_terminal',
    'feat008_claim_reject_owner',
    'feat008_claim_reject_terminal',
    'feat008_cleanup_a',
    'feat008_cleanup_b'
  ]
  loop
    begin
      insert into feat008_concurrency_results (label, result)
      select connection_name, remote_result.result
      from extensions.dblink_get_result(connection_name) as remote_result(result jsonb);
    exception when others then
      insert into feat008_concurrency_results (label, error_message)
      values (connection_name, sqlstate || ':' || sqlerrm);
    end;
  end loop;
end;
$block$;

select ok(
  (
    select pg_catalog.count(*) filter (where result is not null and error_message is null) = 1
      and pg_catalog.count(*) filter (
        where result is null and error_message = '23514:studio_media_limit_reached'
      ) = 1
    from feat008_concurrency_results
    where label in ('feat008_limit_a', 'feat008_limit_b')
  )
    and (
      select pg_catalog.count(*) = 20
      from public.studio_media as media
      join private.feat008_concurrency_fixtures as fixture
        on fixture.revision_id = media.prepared_revision_id
      where fixture.label = 'limit'
        and media.status = 'pending_upload'
        and media.cleanup_after > pg_catalog.clock_timestamp()
    ),
  'duas sessões disputam a vigésima vaga e apenas uma preparação vence'
);
select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.count(*) filter (where error_message is null and result is not null) = 2
      and pg_catalog.count(distinct result) = 1
    from feat008_concurrency_results
    where label in ('feat008_finalize_a', 'feat008_finalize_b')
  )
    and (
      select revision.revision_version = 2
        and (
          select pg_catalog.count(*) = 1
          from public.studio_revision_media as relation
          where relation.revision_id = fixture.revision_id
            and relation.media_id = fixture.media_id
        )
      from private.feat008_concurrency_fixtures as fixture
      join public.studio_revisions as revision on revision.id = fixture.revision_id
      where fixture.label = 'finalize'
    ),
  'finalizações idênticas simultâneas convergem no mesmo retorno e um incremento'
);
insert into feat008_concurrency_results (label, result)
select 'feat008_claim_replay_a', remote_result.result
from extensions.dblink(
  'feat008_claim_b',
  $remote$
    select private.begin_studio_media_finalize_claim(
      '8f000000-0000-4000-8000-000000000008',
      fixture.studio_id,
      fixture.revision_id,
      1,
      '82300000-0000-4000-8000-000000000221',
      '82300000-0000-4000-8000-000000000233',
      fixture.media_id
    )
    from private.feat008_concurrency_fixtures as fixture
    where fixture.label = 'finalize'
  $remote$
) as remote_result(result jsonb);
select ok(
  (select result ->> 'state' from feat008_concurrency_results
    where label = 'feat008_claim_replay_a') = 'replay'
    and (select result -> 'result' from feat008_concurrency_results
      where label = 'feat008_claim_replay_a') = (
        select result
        from feat008_concurrency_results
        where label = 'feat008_finalize_a'
      )
    and exists (
      select 1
      from private.studio_media_finalize_claims as claim
      join private.feat008_concurrency_fixtures as fixture on fixture.media_id = claim.media_id
      where fixture.label = 'finalize'
        and claim.lease_token is null
    ),
  'retry sobreposto relê o resultado terminal no claim sem reabrir processamento externo'
);
select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(error_message is null)
      and pg_catalog.bool_and(pg_catalog.jsonb_array_length(result -> 'items') = 1)
      and pg_catalog.count(distinct result #>> '{items,0,mediaId}') = 2
    from feat008_concurrency_results
    where label in ('feat008_cleanup_a', 'feat008_cleanup_b')
  )
    and (
      select pg_catalog.count(*) = 2
        and pg_catalog.count(distinct media.cleanup_claim_token) = 2
      from public.studio_media as media
      where media.id in (
        '89000000-0000-4000-8000-000000000101',
        '89000000-0000-4000-8000-000000000102'
      )
        and media.status = 'delete_pending'
    ),
  'claims concorrentes usam skip locked e capturam objetos disjuntos'
);
select pg_catalog.set_config(
  'set_livre.test.f008_concurrent_cleanup_media',
  (
    select result #>> '{items,0,mediaId}'
    from feat008_concurrency_results
    where label = 'feat008_cleanup_a'
  ),
  true
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select public.complete_studio_media_cleanup(
          '82300000-0000-4000-8000-000000000299',
          %L::uuid,
          true,
          null
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_concurrent_cleanup_media')
    )
  ),
  '^40001:studio_media_cleanup_claim_conflict$',
  'token alheio não atravessa o fencing de conclusão do cleanup'
);

do $block$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat008_limit_a',
    'feat008_limit_b',
    'feat008_finalize_a',
    'feat008_finalize_b',
    'feat008_claim_b',
    'feat008_claim_c',
    'feat008_cleanup_a',
    'feat008_cleanup_b'
  ]
  loop
    perform extensions.dblink_disconnect(connection_name);
  end loop;
end;
$block$;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f008_unsigned_reject',
  private.reject_unsigned_studio_media_upload(
    '81000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        #>> '{revision,id}'
    )::uuid,
    2,
    '88000000-0000-4000-8000-000000000002',
    '8a000000-0000-4000-8000-000000000020'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_unsigned_replay',
  private.reject_unsigned_studio_media_upload(
    '81000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        #>> '{revision,id}'
    )::uuid,
    2,
    '88000000-0000-4000-8000-000000000002',
    '8a000000-0000-4000-8000-000000000021'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f008_unsigned_replacement',
  private.prepare_studio_media_upload(
    '81000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
        #>> '{revision,id}'
    )::uuid,
    2,
    '8a000000-0000-4000-8000-000000000022',
    '8a000000-0000-4000-8000-000000000023',
    'image/jpeg',
    10,
    null
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f008_unsigned_reject')::jsonb
      ->> 'state' = 'rejected'
    and pg_catalog.current_setting('set_livre.test.f008_unsigned_reject')
      = pg_catalog.current_setting('set_livre.test.f008_unsigned_replay')
    and pg_catalog.current_setting('set_livre.test.f008_unsigned_replacement')::jsonb
      ->> 'mediaId' is not null
    and (
      select media.status = 'rejected'
        and media.rejection_code = 'upload_token_signing_failed'
        and media.upload_token_issued_at is null
        and media.cleanup_after = media.rejected_at
      from public.studio_media as media
      where media.id = '88000000-0000-4000-8000-000000000002'
    )
    and (
      select pg_catalog.count(*) filter (where media.status = 'pending_upload') = 20
      from public.studio_media as media
      where media.prepared_revision_id = (
        pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb
          #>> '{revision,id}'
      )::uuid
    )
    and (
      select pg_catalog.count(*) = 1
      from audit.events as event
      where event.action = 'studio.media_upload_rejected'
        and event.idempotency_key = '88000000-0000-4000-8000-000000000002'
    ),
  'falha de assinatura rejeita uma única vez, libera quota imediatamente e permite nova reserva'
);
select matches(
  private.feat008_capture_error(
    pg_catalog.format(
      $command$
        select private.confirm_studio_media_upload_token(
          '81000000-0000-4000-8000-000000000001', %L::uuid, %L::uuid, 2,
          '88000000-0000-4000-8000-000000000002'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f008_limit_create')::jsonb #>> '{revision,id}'
    )
  ),
  '^40001:studio_media_upload_token_rejected$',
  'compensação vencedora cerca confirmação tardia e nenhum token rejeitado retorna ao navegador'
);

select ok(
  (
    select pg_catalog.count(*) = 13
    from private.studio_command_requests as request
    where request.owner_user_id = '81000000-0000-4000-8000-000000000001'
      and request.action like 'studio.media.%'
      and request.result_payload is not null
      and request.result_hash = private.studio_result_hash(request.result_payload)
  ),
  'ledger existente ancora todos os comandos idempotentes de mídia executados'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.lower(
      pg_catalog.pg_get_functiondef(
        'maintenance.claim_studio_media_cleanup(uuid,integer)'::pg_catalog.regprocedure
      )
      || pg_catalog.pg_get_functiondef(
        'maintenance.complete_studio_media_cleanup(uuid,uuid,boolean,text)'::pg_catalog.regprocedure
      )
    ),
    'delete from storage.objects'
  ) = 0,
  'cleanup nunca apaga storage.objects por SQL'
);

revoke app_dal from postgres granted by current_user;

select * from finish();
rollback;

drop table if exists private.feat008_concurrency_fixtures;
delete from audit.events
where actor_user_id = '8f000000-0000-4000-8000-000000000008'
  or target_id = '8f000000-0000-4000-8000-000000000008';
delete from private.studio_command_requests
where owner_user_id = '8f000000-0000-4000-8000-000000000008';
delete from public.studio_revision_media as relation
using public.studio_media as media
where relation.media_id = media.id
  and media.uploaded_by = '8f000000-0000-4000-8000-000000000008';
delete from public.studio_media
where uploaded_by = '8f000000-0000-4000-8000-000000000008';
delete from auth.users
where id = '8f000000-0000-4000-8000-000000000008';
