-- FEAT-009: submissao editorial, isolamento, idempotencia, pausa e retomada.
--
-- Dependencias deliberadas desta suite (criadas pela migration proprietaria da FEAT-009):
--   public.studios.publication_version bigint;
--   public.studio_review_events;
--   public.email_outbox;
--   private.studio_command_requests;
--   private.studio_deletion_fences;
--   private.get_owner_studio_publication(uuid, uuid);
--   private.submit_studio_revision(uuid, uuid, uuid, bigint, uuid, uuid);
--   private.pause_studio(uuid, uuid, bigint, uuid, uuid);
--   private.resume_studio(uuid, uuid, bigint, uuid, uuid).

-- A fixture concorrente precisa estar committed para as duas sessoes dblink. O bloco de
-- limpeza torna a suite segura para rerun mesmo se uma execucao anterior for interrompida.
drop table if exists private.feat009_concurrency_fixtures;
drop trigger if exists feat009_taxonomy_submit_barrier on public.studio_revisions;
drop function if exists private.feat009_taxonomy_submit_barrier();
drop function if exists private.feat009_capture_error(text);
drop function if exists private.feat009_create_owner(uuid, text, text, integer);
drop function if exists private.feat009_create_studio_fixture(
  uuid, integer, text, boolean, boolean
);

delete from public.email_outbox as outbox
using public.studios as studio
where outbox.studio_id = studio.id
  and studio.owner_user_id = '91000000-0000-4000-8000-000000000009';
delete from public.studio_review_events as review
using public.studios as studio
where review.studio_id = studio.id
  and studio.owner_user_id = '91000000-0000-4000-8000-000000000009';
delete from audit.events
where actor_user_id = '91000000-0000-4000-8000-000000000009'
  or target_id in (
    select studio.id
    from public.studios as studio
    where studio.owner_user_id = '91000000-0000-4000-8000-000000000009'
  );
delete from private.studio_command_requests
where owner_user_id = '91000000-0000-4000-8000-000000000009';
delete from public.studios
where owner_user_id = '91000000-0000-4000-8000-000000000009';
update public.studio_media
set
  status = 'delete_pending',
  delete_requested_at = coalesce(delete_requested_at, pg_catalog.clock_timestamp()),
  cleanup_after = pg_catalog.clock_timestamp()
where uploaded_by = '91000000-0000-4000-8000-000000000009'
  and status in ('pending_upload', 'ready', 'rejected', 'delete_pending');
delete from public.studio_media
where uploaded_by = '91000000-0000-4000-8000-000000000009';
delete from auth.users
where id = '91000000-0000-4000-8000-000000000009';
delete from public.tags
where id = '62f00000-0000-4000-8000-000000000009';

create function private.feat009_capture_error(command text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
begin
  execute command;
  raise exception using errcode = 'P0099', message = 'feat009_forbidden_command_succeeded';
exception
  when sqlstate 'P0099' then
    return 'NO_ERROR';
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$function$;

create function private.feat009_create_owner(
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
      '90100000-0000-4000-8000-'
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
    'Dono QA FEAT 009',
    '+5541999999909',
    tax_id,
    null
  );

  perform private.activate_owner(
    user_id,
    '00000000-0000-4000-8000-000000000204',
    (
      '90200000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
    (
      '90300000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
    null
  );
end;
$function$;

create function private.feat009_create_studio_fixture(
  user_id uuid,
  fixture_suffix integer,
  studio_name text,
  make_complete boolean,
  make_published boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  editor jsonb;
  media_id uuid;
  prepared jsonb;
  revision_id uuid;
  fixture_revision_version bigint;
  studio_id uuid;
begin
  if make_published and not make_complete then
    raise exception using errcode = '22023', message = 'invalid_feat009_fixture';
  end if;

  editor := private.create_studio(
    user_id,
    (
      '92000000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    (
      '92100000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    studio_name,
    'Estudio de teste completo para comprovar o workflow editorial da FEAT 009.',
    'Rua da Publicacao',
    fixture_suffix::text,
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    12,
    '60000000-0000-4000-8000-000000000001'
  );

  studio_id := (editor ->> 'studioId')::uuid;
  revision_id := (editor -> 'revision' ->> 'id')::uuid;
  fixture_revision_version := (editor -> 'revision' ->> 'version')::bigint;

  if make_complete then
    editor := private.update_studio_revision_taxonomy(
      user_id,
      studio_id,
      revision_id,
      fixture_revision_version,
      (
        '92200000-0000-4000-8000-'
        || pg_catalog.lpad(fixture_suffix::text, 12, '0')
      )::uuid,
      (
        '92300000-0000-4000-8000-'
        || pg_catalog.lpad(fixture_suffix::text, 12, '0')
      )::uuid,
      array['62000000-0000-4000-8000-000000000001'::uuid],
      array['63000000-0000-4000-8000-000000000001'::uuid]
    );
    revision_id := (editor -> 'revision' ->> 'id')::uuid;
    fixture_revision_version := (editor -> 'revision' ->> 'version')::bigint;

    editor := private.update_studio_revision_content(
      user_id,
      studio_id,
      revision_id,
      fixture_revision_version,
      (
        '92400000-0000-4000-8000-'
        || pg_catalog.lpad(fixture_suffix::text, 12, '0')
      )::uuid,
      (
        '92500000-0000-4000-8000-'
        || pg_catalog.lpad(fixture_suffix::text, 12, '0')
      )::uuid,
      'Uso mediante reserva confirmada e respeito integral ao horario contratado.',
      'dQw4w9WgXcQ',
      '[{"question":"O estudio possui Wi-Fi?","answer":"Sim, a rede esta inclusa."}]'::jsonb
    );
    revision_id := (editor -> 'revision' ->> 'id')::uuid;
    fixture_revision_version := (editor -> 'revision' ->> 'version')::bigint;

    prepared := private.prepare_studio_media_upload(
      user_id,
      studio_id,
      revision_id,
      fixture_revision_version,
      (
        '92600000-0000-4000-8000-'
        || pg_catalog.lpad(fixture_suffix::text, 12, '0')
      )::uuid,
      (
        '92700000-0000-4000-8000-'
        || pg_catalog.lpad(fixture_suffix::text, 12, '0')
      )::uuid,
      'image/jpeg',
      100,
      pg_catalog.repeat('a', 64)
    );
    media_id := (prepared ->> 'mediaId')::uuid;

    perform private.finalize_studio_media_upload(
      user_id,
      studio_id,
      revision_id,
      fixture_revision_version,
      (
        '92800000-0000-4000-8000-'
        || pg_catalog.lpad(fixture_suffix::text, 12, '0')
      )::uuid,
      (
        '92900000-0000-4000-8000-'
        || pg_catalog.lpad(fixture_suffix::text, 12, '0')
      )::uuid,
      media_id,
      'image/jpeg',
      100,
      1200,
      800,
      pg_catalog.repeat('a', 64)
    );

    editor := private.studio_editor_json(user_id, studio_id);
    revision_id := (editor -> 'revision' ->> 'id')::uuid;
    fixture_revision_version := (editor -> 'revision' ->> 'version')::bigint;
  end if;

  if make_published then
    update public.studios as studio
    set status = 'pending_review'
    where studio.id = studio_id
      and studio.status = 'draft';

    if not found then
      raise exception using errcode = '23514', message = 'feat009_prepare_publish_fixture_failed';
    end if;

    with approved_revision as (
      update public.studio_revisions as revision
      set
        status = 'approved',
        revision_version = revision.revision_version + 1
      where revision.id = revision_id
        and revision.status = 'draft'
        and revision.revision_version = fixture_revision_version
      returning revision.id, revision.revision_version
    )
    update public.studios as studio
    set
      status = 'published',
      published_revision_id = approved_revision.id,
      draft_revision_id = null
    from approved_revision
    where studio.id = studio_id
      and studio.draft_revision_id = approved_revision.id
    returning approved_revision.revision_version into fixture_revision_version;

    if not found then
      raise exception using errcode = '23514', message = 'feat009_publish_fixture_failed';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'studioId', studio_id,
    'revisionId', revision_id,
    'revisionVersion', fixture_revision_version,
    'mediaId', media_id,
    'publicationVersion', (
      select studio.publication_version
      from public.studios as studio
      where studio.id = studio_id
    )
  );
end;
$function$;

revoke all on function private.feat009_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat009_create_owner(uuid, text, text, integer)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat009_create_studio_fixture(uuid, integer, text, boolean, boolean)
  from public, anon, authenticated, service_role, app_dal;

create table private.feat009_concurrency_fixtures (
  label text primary key,
  studio_id uuid not null,
  revision_id uuid not null,
  revision_version bigint not null,
  publication_version bigint not null
);
revoke all on table private.feat009_concurrency_fixtures
  from public, anon, authenticated, service_role, app_dal;

select private.feat009_create_owner(
  '91000000-0000-4000-8000-000000000009',
  'qa-feat009-concurrency@setlivre.local',
  '86421975364',
  9
);
insert into public.tags (id, slug, name, sort_order)
values (
  '62f00000-0000-4000-8000-000000000009',
  'qa-feat009-taxonomy-lock',
  'QA FEAT 009 taxonomy lock',
  900
);
with fixture as (
  select private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000009',
    9,
    'Estudio QA FEAT 009 concorrencia real',
    true,
    true
  ) as value
)
insert into private.feat009_concurrency_fixtures (
  label,
  studio_id,
  revision_id,
  revision_version,
  publication_version
)
select
  'pause',
  (fixture.value ->> 'studioId')::uuid,
  (fixture.value ->> 'revisionId')::uuid,
  (fixture.value ->> 'revisionVersion')::bigint,
  (fixture.value ->> 'publicationVersion')::bigint
from fixture;

with fixture as (
  select private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000009',
    11,
    'Estudio QA FEAT 009 trava de taxonomia',
    true,
    false
  ) as value
)
insert into private.feat009_concurrency_fixtures (
  label,
  studio_id,
  revision_id,
  revision_version,
  publication_version
)
select
  'taxonomy_submit',
  (fixture.value ->> 'studioId')::uuid,
  (fixture.value ->> 'revisionId')::uuid,
  (fixture.value ->> 'revisionVersion')::bigint,
  (fixture.value ->> 'publicationVersion')::bigint
from fixture;

with fixture as (
  select fixture.*
  from private.feat009_concurrency_fixtures as fixture
  where fixture.label = 'taxonomy_submit'
), updated as (
  select private.update_studio_revision_taxonomy(
    '91000000-0000-4000-8000-000000000009',
    fixture.studio_id,
    fixture.revision_id,
    fixture.revision_version,
    '92a00000-0000-4000-8000-000000000011',
    '92b00000-0000-4000-8000-000000000011',
    array['62f00000-0000-4000-8000-000000000009'::uuid],
    array['63000000-0000-4000-8000-000000000001'::uuid]
  ) as value
  from fixture
)
update private.feat009_concurrency_fixtures as fixture
set
  revision_id = (updated.value -> 'revision' ->> 'id')::uuid,
  revision_version = (updated.value -> 'revision' ->> 'version')::bigint
from updated
where fixture.label = 'taxonomy_submit';

create function private.feat009_taxonomy_submit_barrier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.status = 'draft'
    and new.status = 'pending'
    and old.id = (
      select fixture.revision_id
      from private.feat009_concurrency_fixtures as fixture
      where fixture.label = 'taxonomy_submit'
    )
  then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('feat009-taxonomy-submit-barrier', 0)
    );
  end if;
  return new;
end;
$function$;

revoke all on function private.feat009_taxonomy_submit_barrier()
  from public, anon, authenticated, service_role, app_dal;

create trigger feat009_taxonomy_submit_barrier
  before update on public.studio_revisions
  for each row execute function private.feat009_taxonomy_submit_barrier();

begin;

select plan(80);

select has_column(
  'public',
  'studios',
  'publication_version',
  'studios possui o token otimista independente de publicacao'
);

select ok(
  (
    select attribute.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
      and attribute.attnotnull
      and pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
        in ('1', '1::bigint')
    from pg_catalog.pg_attribute as attribute
    join pg_catalog.pg_attrdef as default_value
      on default_value.adrelid = attribute.attrelid
      and default_value.adnum = attribute.attnum
    where attribute.attrelid = 'public.studios'::pg_catalog.regclass
      and attribute.attname = 'publication_version'
      and not attribute.attisdropped
  ),
  'publication_version e bigint not null e inicia em um'
);

select has_table(
  'public',
  'studio_review_events',
  'eventos editoriais append-only existem'
);
select has_column(
  'public',
  'studio_review_events',
  'event_sequence',
  'eventos editoriais possuem fence causal monotônica'
);
select has_table(
  'public',
  'email_outbox',
  'outbox minima de notificacao existe'
);
select ok(
  (
    select pg_catalog.count(*) = 4
      and pg_catalog.bool_and(constraint_object.confdeltype = 'c')
    from (
      values
        (
          'public.studio_review_events'::pg_catalog.regclass,
          'studio_review_events_studio_id_fkey'::name
        ),
        (
          'public.studio_review_events'::pg_catalog.regclass,
          'studio_review_events_revision_id_fkey'::name
        ),
        (
          'public.email_outbox'::pg_catalog.regclass,
          'email_outbox_studio_id_fkey'::name
        ),
        (
          'public.email_outbox'::pg_catalog.regclass,
          'email_outbox_revision_id_fkey'::name
        )
    ) as expected(relation_oid, constraint_name)
    join pg_catalog.pg_constraint as constraint_object
      on constraint_object.conrelid = expected.relation_oid
      and constraint_object.conname = expected.constraint_name
      and constraint_object.contype = 'f'
  ),
  'eventos e outbox acompanham a exclusao canonica do agregado nunca publicado'
);
select ok(
  (
    select pg_catalog.upper(pg_catalog.pg_get_constraintdef(constraint_object.oid))
      like '%REJECTION_REASON IS NOT NULL%'
    from pg_catalog.pg_constraint as constraint_object
    where constraint_object.conrelid = 'public.studio_review_events'::pg_catalog.regclass
      and constraint_object.conname = 'studio_review_events_reason_check'
  ),
  'rejeicao exige motivo nao nulo alem de trim e limite de tamanho'
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
    where index_definition.indexrelid =
      'public.studio_review_events_actor_user_id_idx'::pg_catalog.regclass
  )
    and (
      select index_definition.indisunique
        and index_definition.indisvalid
        and index_definition.indisready
        and pg_catalog.pg_get_expr(
          index_definition.indpred,
          index_definition.indrelid
        ) like '%approved%rejected%'
      from pg_catalog.pg_index as index_definition
      where index_definition.indexrelid =
        'public.studio_review_events_one_decision_idx'::pg_catalog.regclass
    )
    and (
      select index_definition.indisvalid and index_definition.indisready
      from pg_catalog.pg_index as index_definition
      where index_definition.indexrelid =
        'public.studio_review_events_studio_latest_idx'::pg_catalog.regclass
    )
    and (
      select index_definition.indisvalid and index_definition.indisready
      from pg_catalog.pg_index as index_definition
      where index_definition.indexrelid =
        'public.email_outbox_studio_created_idx'::pg_catalog.regclass
    ),
  'indices editoriais estruturais estao prontos e preservam os predicados de dominio'
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
    ) as runtime(role_name)
    cross join (
      values
        ('public.studios'::pg_catalog.regclass, 'publication_version'::name)
    ) as protected(relation_oid, column_name)
    where pg_catalog.has_column_privilege(
        runtime.role_name,
        protected.relation_oid,
        protected.column_name,
        'SELECT'
      )
      or pg_catalog.has_column_privilege(
        runtime.role_name,
        protected.relation_oid,
        protected.column_name,
        'INSERT'
      )
      or pg_catalog.has_column_privilege(
        runtime.role_name,
        protected.relation_oid,
        protected.column_name,
        'UPDATE'
      )
  )
    and not exists (
      select 1
      from pg_catalog.pg_attribute as attribute
      where attribute.attrelid = 'private.studio_command_requests'::pg_catalog.regclass
        and attribute.attname = 'resulting_publication_version'
        and attribute.attnum > 0
        and not attribute.attisdropped
    ),
  'token canonico nao recebe privilegio runtime nem e duplicado no ledger por hash'
);
select ok(
  pg_catalog.to_regclass('private.studio_publication_requests') is null
    and pg_catalog.to_regclass('private.studio_command_requests') is not null
    and (
      select pg_catalog.pg_get_constraintdef(constraint_object.oid)
        like all (array[
          '%studio.revision.submit%',
          '%studio.pause%',
          '%studio.resume%'
        ])
      from pg_catalog.pg_constraint as constraint_object
      where constraint_object.conrelid = 'private.studio_command_requests'::pg_catalog.regclass
        and constraint_object.conname = 'studio_command_requests_action_check'
    ),
  'ledger canonico aceita as actions sem criar ledger paralelo'
);

select policies_are(
  'public',
  'studio_review_events',
  array[]::text[],
  'eventos editoriais nao possuem policy de acesso runtime'
);
select policies_are(
  'public',
  'email_outbox',
  array[]::text[],
  'outbox nao possui policy de acesso runtime'
);
select policies_are(
  'private',
  'studio_command_requests',
  array[]::text[],
  'ledger canonico nao possui policy de acesso runtime'
);
select policies_are(
  'private',
  'studio_deletion_fences',
  array[]::text[],
  'fence interno de exclusao nao possui policy de acesso runtime'
);

select ok(
  (
    select pg_catalog.bool_and(relation.relrowsecurity)
    from (
      values
        ('public.studio_review_events'::pg_catalog.regclass),
        ('public.email_outbox'::pg_catalog.regclass),
        ('private.studio_command_requests'::pg_catalog.regclass),
        ('private.studio_deletion_fences'::pg_catalog.regclass)
    ) as expected(relation_oid)
    join pg_catalog.pg_class as relation on relation.oid = expected.relation_oid
  ),
  'eventos, outbox, ledger e fence permanecem fail-closed sob RLS'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('public.studio_review_events'::pg_catalog.regclass),
        ('public.email_outbox'::pg_catalog.regclass),
        ('private.studio_command_requests'::pg_catalog.regclass),
        ('private.studio_deletion_fences'::pg_catalog.regclass)
    ) as expected(relation_oid)
    join pg_catalog.pg_class as relation on relation.oid = expected.relation_oid
    join pg_catalog.pg_roles as owner_role on owner_role.oid = relation.relowner
    where owner_role.rolname <> 'postgres'
  ),
  'estado editorial e fences internos sao owned por postgres'
);

select has_function(
  'private',
  'get_owner_studio_publication',
  array['uuid', 'uuid'],
  'read model privado do dono existe'
);
select has_function(
  'private',
  'submit_studio_revision',
  array['uuid', 'uuid', 'uuid', 'bigint', 'uuid', 'uuid'],
  'comando privado de submissao existe'
);
select has_function(
  'private',
  'pause_studio',
  array['uuid', 'uuid', 'bigint', 'uuid', 'uuid'],
  'comando privado de pausa existe'
);
select has_function(
  'private',
  'resume_studio',
  array['uuid', 'uuid', 'bigint', 'uuid', 'uuid'],
  'comando privado de retomada existe'
);

with expected(signature) as (
  values
    ('private.get_owner_studio_publication(uuid,uuid)'),
    ('private.submit_studio_revision(uuid,uuid,uuid,bigint,uuid,uuid)'),
    ('private.pause_studio(uuid,uuid,bigint,uuid,uuid)'),
    ('private.resume_studio(uuid,uuid,bigint,uuid,uuid)')
), routines as (
  select routine.*
  from expected
  join pg_catalog.pg_proc as routine
    on routine.oid = pg_catalog.to_regprocedure(expected.signature)
)
select ok(
  pg_catalog.count(*) = 4
    and pg_catalog.bool_and(routines.prosecdef)
    and pg_catalog.bool_and(routines.proconfig = array['search_path=""'])
    and pg_catalog.bool_and(routines.proowner = 'postgres'::pg_catalog.regrole),
  'as quatro fronteiras sao postgres security-definer com search_path vazio'
)
from routines;

select ok(
  (
    select routine.provolatile = 's'
      and pg_catalog.pg_get_function_result(routine.oid) = 'jsonb'
    from pg_catalog.pg_proc as routine
    where routine.oid = pg_catalog.to_regprocedure(
      'private.get_owner_studio_publication(uuid,uuid)'
    )
  )
    and (
      select pg_catalog.bool_and(routine.provolatile = 'v')
        and pg_catalog.bool_and(pg_catalog.pg_get_function_result(routine.oid) = 'jsonb')
      from (
        values
          ('private.submit_studio_revision(uuid,uuid,uuid,bigint,uuid,uuid)'),
          ('private.pause_studio(uuid,uuid,bigint,uuid,uuid)'),
          ('private.resume_studio(uuid,uuid,bigint,uuid,uuid)')
      ) as expected(signature)
      join pg_catalog.pg_proc as routine
        on routine.oid = pg_catalog.to_regprocedure(expected.signature)
    ),
  'read model e stable; comandos sao volatile e todos retornam jsonb autoritativo'
);

select ok(
  (
    select pg_catalog.count(*) = 4
      and pg_catalog.bool_and(
        exists (
          select 1
          from private.dal_routine_allowlist as allowlisted
          where allowlisted.signature = expected.signature
        )
      )
    from (
      values
        ('private.get_owner_studio_publication(uuid,uuid)'),
        ('private.submit_studio_revision(uuid,uuid,uuid,bigint,uuid,uuid)'),
        ('private.pause_studio(uuid,uuid,bigint,uuid,uuid)'),
        ('private.resume_studio(uuid,uuid,bigint,uuid,uuid)')
    ) as expected(signature)
  ),
  'as quatro assinaturas FEAT-009 estao na allowlist canonica'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('private.get_owner_studio_publication(uuid,uuid)'),
        ('private.submit_studio_revision(uuid,uuid,uuid,bigint,uuid,uuid)'),
        ('private.pause_studio(uuid,uuid,bigint,uuid,uuid)'),
        ('private.resume_studio(uuid,uuid,bigint,uuid,uuid)')
    ) as expected(signature)
    cross join (
      values
        ('public'::name),
        ('anon'::name),
        ('authenticated'::name),
        ('service_role'::name)
    ) as forbidden(role_name)
    where not pg_catalog.has_function_privilege(
        'app_dal',
        expected.signature,
        'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        forbidden.role_name,
        expected.signature,
        'EXECUTE'
      )
  )
    and not exists (
      select 1
      from (
        values
          ('private.studio_revision_taxonomy_fence(uuid)'),
          ('private.lock_active_studio_revision_taxonomy(uuid,uuid,uuid,bigint)'),
          ('private.protect_immutable_studio_media_lifecycle()')
      ) as internal(signature)
      cross join (
        values
          ('public'::name),
          ('anon'::name),
          ('authenticated'::name),
          ('service_role'::name),
          ('app_dal'::name)
      ) as runtime(role_name)
      where pg_catalog.has_function_privilege(
        runtime.role_name,
        internal.signature,
        'EXECUTE'
      )
    )
    and not exists (
      select 1
      from (
        values
          ('anon'::name),
          ('authenticated'::name),
          ('service_role'::name),
          ('app_dal'::name)
      ) as runtime(role_name)
      where pg_catalog.has_sequence_privilege(
          runtime.role_name,
          'public.studio_review_events_event_sequence_seq'::pg_catalog.regclass,
          'SELECT'
        )
        or pg_catalog.has_sequence_privilege(
          runtime.role_name,
          'public.studio_review_events_event_sequence_seq'::pg_catalog.regclass,
          'USAGE'
        )
        or pg_catalog.has_sequence_privilege(
          runtime.role_name,
          'public.studio_review_events_event_sequence_seq'::pg_catalog.regclass,
          'UPDATE'
        )
  ),
  'app_dal executa apenas as quatro fronteiras e nenhum runtime acessa helpers ou sequencia'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('public.studio_review_events'::pg_catalog.regclass),
        ('public.email_outbox'::pg_catalog.regclass),
        ('private.studio_command_requests'::pg_catalog.regclass),
        ('private.studio_deletion_fences'::pg_catalog.regclass)
    ) as expected(relation_oid)
    cross join (
      values
        ('public'::name),
        ('anon'::name),
        ('authenticated'::name),
        ('service_role'::name),
        ('app_dal'::name)
    ) as runtime(role_name)
    where pg_catalog.has_table_privilege(runtime.role_name, expected.relation_oid, 'SELECT')
      or pg_catalog.has_table_privilege(runtime.role_name, expected.relation_oid, 'INSERT')
      or pg_catalog.has_table_privilege(runtime.role_name, expected.relation_oid, 'UPDATE')
      or pg_catalog.has_table_privilege(runtime.role_name, expected.relation_oid, 'DELETE')
  ),
  'nenhum runtime recebe acesso direto a eventos, outbox, ledger ou fence'
);

select ok(
  (
    select pg_catalog.pg_get_constraintdef(constraint_object.oid) like '%studio.revision_submitted%'
      and pg_catalog.pg_get_constraintdef(constraint_object.oid) like '%studio.paused%'
      and pg_catalog.pg_get_constraintdef(constraint_object.oid) like '%studio.resumed%'
    from pg_catalog.pg_constraint as constraint_object
    where constraint_object.conrelid = 'audit.events'::pg_catalog.regclass
      and constraint_object.conname = 'events_action_check'
  ),
  'allowlist de auditoria inclui submissao, pausa e retomada'
);

select ok(
  pg_catalog.to_regprocedure('public.get_owner_studio_publication(uuid)') is null
    and pg_catalog.to_regprocedure(
      'public.submit_studio_revision(uuid,uuid,uuid,bigint,uuid,uuid)'
    ) is null
    and pg_catalog.to_regprocedure(
      'public.pause_studio(uuid,uuid,bigint,uuid,uuid)'
    ) is null
    and pg_catalog.to_regprocedure(
      'public.resume_studio(uuid,uuid,bigint,uuid,uuid)'
    ) is null,
  'workflow editorial nao cria RPC publica paralela'
);

select private.feat009_create_owner(
  '91000000-0000-4000-8000-000000000001',
  'qa-feat009-owner-a@setlivre.local',
  '52998224725',
  1
);
select private.feat009_create_owner(
  '91000000-0000-4000-8000-000000000002',
  'qa-feat009-owner-b@setlivre.local',
  '11144477735',
  2
);

select pg_catalog.set_config(
  'set_livre.test.f009_incomplete',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    1,
    'Estudio QA FEAT 009 incompleto',
    false,
    false
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_complete',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    2,
    'Estudio QA FEAT 009 completo',
    true,
    false
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_stale',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    3,
    'Estudio QA FEAT 009 concorrencia',
    true,
    false
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_pending_candidate',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    4,
    'Estudio QA FEAT 009 candidato pendente',
    true,
    true
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_draft_candidate',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    5,
    'Estudio QA FEAT 009 candidato draft',
    true,
    true
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_no_candidate',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    6,
    'Estudio QA FEAT 009 sem candidato',
    true,
    true
  )::text,
  true
);
with inserted_studio as (
  insert into public.studios (
    id,
    owner_user_id,
    status,
    draft_revision_id,
    publication_version
  )
  values (
    '94000000-0000-4000-8000-000000000007',
    '91000000-0000-4000-8000-000000000001',
    'disabled',
    '94100000-0000-4000-8000-000000000007',
    2
  )
  returning id
)
insert into public.studio_revisions (
  id,
  studio_id,
  revision_number,
  revision_version,
  status,
  name,
  description,
  street,
  street_number,
  address_complement,
  neighborhood,
  city,
  state,
  postal_code,
  capacity,
  studio_type_id
)
select
  '94100000-0000-4000-8000-000000000007',
  inserted_studio.id,
  1,
  1,
  'draft',
  'Estudio QA FEAT 009 desabilitado',
  'Estudio factual desabilitado para comprovar leitura segura sem antecipar comando administrativo.',
  'Rua da Publicacao',
  '7',
  null,
  'Centro',
  'Curitiba',
  'PR',
  '80010000',
  12,
  '60000000-0000-4000-8000-000000000001'
from inserted_studio;
select pg_catalog.set_config(
  'set_livre.test.f009_disabled',
  pg_catalog.jsonb_build_object(
    'studioId', '94000000-0000-4000-8000-000000000007'::uuid,
    'revisionId', '94100000-0000-4000-8000-000000000007'::uuid,
    'revisionVersion', 1,
    'publicationVersion', 2
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_paused_submission',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    8,
    'Estudio QA FEAT 009 submissao pausada',
    true,
    true
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_upload_expiry',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    10,
    'Estudio QA FEAT 009 expiracao de upload',
    true,
    false
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_archived_taxonomy',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    12,
    'Estudio QA FEAT 009 taxonomia arquivada',
    true,
    false
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_review_order',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    13,
    'Estudio QA FEAT 009 ordem editorial',
    true,
    true
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_reviewed_unpublished',
  private.feat009_create_studio_fixture(
    '91000000-0000-4000-8000-000000000001',
    14,
    'Estudio QA FEAT 009 rejeitado antes da primeira publicacao',
    true,
    false
  )::text,
  true
);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_owner_read',
  private.get_owner_studio_publication(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'studioId'
    )::uuid
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_foreign_read',
  coalesce(
    private.get_owner_studio_publication(
      '91000000-0000-4000-8000-000000000002',
      (
        pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
          ->> 'studioId'
      )::uuid
    )::text,
    'null'
  ),
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f009_owner_read')::jsonb ?& array[
    'scope',
    'studioId',
    'studioStatus',
    'publicationVersion',
    'currentRevision',
    'publishedRevision',
    'latestReview'
  ]
    and pg_catalog.current_setting('set_livre.test.f009_owner_read')::jsonb
      @> pg_catalog.jsonb_build_object(
        'scope', '91000000-0000-4000-8000-000000000001'::uuid,
        'studioStatus', 'draft',
        'publicationVersion', 1
      )
    and pg_catalog.current_setting('set_livre.test.f009_owner_read')::jsonb
      -> 'currentRevision' ->> 'id' = (
        pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
          ->> 'revisionId'
      )
    and pg_catalog.current_setting('set_livre.test.f009_owner_read')::jsonb
      -> 'publishedRevision' = 'null'::jsonb
    and pg_catalog.current_setting('set_livre.test.f009_owner_read')::jsonb
      -> 'latestReview' = 'null'::jsonb,
  'read model retorna shape owner-scoped e motivo de rejeicao nulo quando inexistente'
);
select is(
  pg_catalog.current_setting('set_livre.test.f009_foreign_read')::jsonb,
  'null'::jsonb,
  'read model privado nao revela estudio de outro dono'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_pending_upload',
  private.prepare_studio_media_upload(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_upload_expiry')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_upload_expiry')::jsonb
        ->> 'revisionId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_upload_expiry')::jsonb
        ->> 'revisionVersion'
    )::bigint,
    '93600000-0000-4000-8000-000000000010',
    '93700000-0000-4000-8000-000000000010',
    'image/jpeg',
    100,
    pg_catalog.repeat('b', 64)
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_active_upload_read',
  private.get_owner_studio_publication(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_upload_expiry')::jsonb
        ->> 'studioId'
    )::uuid
  )::text,
  true
);
reset role;

select ok(
  (
    select checklist_item.value ->> 'complete' = 'false'
      and checklist_item.value -> 'messages'
        ? 'Conclua ou descarte os envios de mídia pendentes.'
    from pg_catalog.jsonb_array_elements(
      pg_catalog.current_setting('set_livre.test.f009_active_upload_read')::jsonb
        -> 'checklist'
    ) as checklist_item(value)
    where checklist_item.value ->> 'key' = 'media'
  ),
  'upload pendente ainda valido bloqueia submissao e orienta a conclusao'
);

set local session_replication_role = replica;
update public.studio_media as media
set
  prepared_at = pg_catalog.statement_timestamp() - interval '3 hours',
  upload_expires_at = pg_catalog.statement_timestamp() - interval '1 hour'
where media.id = (
  pg_catalog.current_setting('set_livre.test.f009_pending_upload')::jsonb
    ->> 'mediaId'
)::uuid;
set local session_replication_role = origin;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_expired_upload_read',
  private.get_owner_studio_publication(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_upload_expiry')::jsonb
        ->> 'studioId'
    )::uuid
  )::text,
  true
);
reset role;

select ok(
  (
    select checklist_item.value ->> 'complete' = 'true'
      and not (
        checklist_item.value -> 'messages'
          ? 'Conclua ou descarte os envios de mídia pendentes.'
      )
    from pg_catalog.jsonb_array_elements(
      pg_catalog.current_setting('set_livre.test.f009_expired_upload_read')::jsonb
        -> 'checklist'
    ) as checklist_item(value)
    where checklist_item.value ->> 'key' = 'media'
  ),
  'upload expirado deixa de bloquear sem fingir que foi finalizado'
);

select matches(
  private.feat009_capture_error(
    pg_catalog.format(
      'update public.studios set publication_version = publication_version + 1 where id = %L::uuid',
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'studioId'
    )
  ),
  '^23514:studio_publication_version_invalid$',
  'publication_version nao avanca sem mudanca real de status ou ponteiro'
);

select ok(
  private.feat009_capture_error(
    pg_catalog.format(
      'update public.studios set status = ''disabled'' where id = %L::uuid',
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'studioId'
    )
  ) = '23514:studio_status_transition_invalid'
    and (
      select studio.status = 'draft' and studio.publication_version = 1
      from public.studios as studio
      where studio.id = (
        pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
          ->> 'studioId'
      )::uuid
    ),
  'FEAT 009 nao antecipa transicao administrativa para disabled e preserva o estado'
);

select is(
  array[
    private.feat009_capture_error(
      pg_catalog.format(
        'insert into public.studio_review_events (studio_id, revision_id, actor_user_id, event_type) values (%L::uuid, %L::uuid, %L::uuid, ''submitted'')',
        pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
          ->> 'studioId',
        pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
          ->> 'revisionId',
        '91000000-0000-4000-8000-000000000001'
      )
    ),
    private.feat009_capture_error(
      pg_catalog.format(
        'insert into public.studio_review_events (studio_id, revision_id, actor_user_id, event_type) values (%L::uuid, %L::uuid, %L::uuid, ''approved'')',
        pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
          ->> 'studioId',
        pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
          ->> 'revisionId',
        '91000000-0000-4000-8000-000000000002'
      )
    )
  ],
  array[
    '23514:studio_review_submission_state_invalid',
    '23514:studio_review_decision_submission_missing'
  ],
  'eventos editoriais rejeitam submissao em draft e decisao sem fato submetido anterior'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_disabled_read',
  private.get_owner_studio_publication(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_disabled')::jsonb
        ->> 'studioId'
    )::uuid
  )::text,
  true
);
reset role;

select ok(
  (
    select studio.status = 'disabled'
      and studio.publication_version = 2
    from public.studios as studio
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_disabled')::jsonb
        ->> 'studioId'
    )::uuid
  )
    and pg_catalog.current_setting('set_livre.test.f009_disabled_read')::jsonb
      @> pg_catalog.jsonb_build_object(
        'studioStatus', 'disabled',
        'publicationVersion', 2,
        'canSubmit', false,
        'canPause', false,
        'canResume', false
      )
    and pg_catalog.current_setting('set_livre.test.f009_disabled_read')::jsonb
      -> 'currentRevision' ->> 'id' = (
        pg_catalog.current_setting('set_livre.test.f009_disabled')::jsonb
          ->> 'revisionId'
      ),
  'estado disabled preexistente permanece factual e estritamente somente leitura'
);

select matches(
  private.feat009_capture_error(
    pg_catalog.format(
      $command$
        select private.submit_studio_revision(
          '91000000-0000-4000-8000-000000000002',
          %L::uuid,
          %L::uuid,
          %L::bigint,
          '9a000000-0000-4000-8000-000000000099',
          '9b000000-0000-4000-8000-000000000099'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'revisionId',
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'revisionVersion'
    )
  ),
  '^P0002:studio_not_found$',
  'comando nao revela nem altera estudio de outro dono'
);

select matches(
  private.feat009_capture_error(
    pg_catalog.format(
      $command$
        select private.submit_studio_revision(
          '91000000-0000-4000-8000-000000000001',
          %L::uuid,
          %L::uuid,
          %L::bigint,
          '9a000000-0000-4000-8000-000000000001',
          '9b000000-0000-4000-8000-000000000001'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'revisionId',
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'revisionVersion'
    )
  ),
  '^23514:studio_submission_incomplete$',
  'submissao incompleta falha com erro de dominio estavel'
);
select ok(
  (
    select studio.status = 'draft'
      and studio.publication_version = 1
      and revision.status = 'draft'
    from public.studios as studio
    join public.studio_revisions as revision on revision.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_incomplete')::jsonb
        ->> 'studioId'
    )::uuid
  )
    and (select pg_catalog.count(*) = 0 from public.studio_review_events)
    and (select pg_catalog.count(*) = 0 from public.email_outbox)
    and (
      select pg_catalog.count(*) = 0
      from private.studio_command_requests as request
      where request.owner_user_id = '91000000-0000-4000-8000-000000000001'
        and request.idempotency_key = '9a000000-0000-4000-8000-000000000001'
    )
    and (
      select pg_catalog.count(*) = 0
      from audit.events as event
      where event.action = 'studio.revision_submitted'
    ),
  'falha de completude nao muda estado nem cria evento, outbox, ledger ou audit'
);

update public.tags as tag
set
  active = false,
  taxonomy_version = tag.taxonomy_version + 1
where tag.id = '62000000-0000-4000-8000-000000000001'
  and tag.active;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_archived_taxonomy_read',
  private.get_owner_studio_publication(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy')::jsonb
        ->> 'studioId'
    )::uuid
  )::text,
  true
);
reset role;

select ok(
  not (
    pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy_read')::jsonb
      ->> 'canSubmit'
  )::boolean
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy_read')::jsonb
          -> 'checklist'
      ) as item(value)
      where item.value ->> 'key' = 'content'
        and not (item.value ->> 'complete')::boolean
        and item.value -> 'messages'
          @> '["Revise as tags arquivadas antes de enviar."]'::jsonb
    ),
  'read model bloqueia submissao quando uma taxonomia referenciada foi arquivada'
);

select matches(
  private.feat009_capture_error(
    pg_catalog.format(
      $command$
        select private.submit_studio_revision(
          '91000000-0000-4000-8000-000000000001',
          %L::uuid,
          %L::uuid,
          %L::bigint,
          '9a000000-0000-4000-8000-000000000012',
          '9b000000-0000-4000-8000-000000000012'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy')::jsonb
        ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy')::jsonb
        ->> 'revisionId',
      pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy')::jsonb
        ->> 'revisionVersion'
    )
  ),
  '^23514:studio_submission_incomplete$',
  'submit revalida a taxonomia no banco e rejeita referencia arquivada'
);

select ok(
  (
    select studio.status = 'draft'
      and studio.publication_version = 1
      and revision.status = 'draft'
    from public.studios as studio
    join public.studio_revisions as revision on revision.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy')::jsonb
        ->> 'studioId'
    )::uuid
  )
    and not exists (
      select 1
      from public.studio_review_events as review
      where review.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and not exists (
      select 1
      from public.email_outbox as outbox
      where outbox.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and not exists (
      select 1
      from private.studio_command_requests as request
      where request.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy')::jsonb
          ->> 'studioId'
      )::uuid
        and request.action = 'studio.revision.submit'
    )
    and not exists (
      select 1
      from audit.events as event
      where event.target_id = (
        pg_catalog.current_setting('set_livre.test.f009_archived_taxonomy')::jsonb
          ->> 'studioId'
      )::uuid
        and event.action = 'studio.revision_submitted'
    ),
  'taxonomia arquivada nao produz transicao, evento, outbox, ledger ou audit parcial'
);

update public.tags as tag
set
  active = true,
  taxonomy_version = tag.taxonomy_version + 1
where tag.id = '62000000-0000-4000-8000-000000000001'
  and not tag.active;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_submit_result',
  private.submit_studio_revision(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'revisionId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'revisionVersion'
    )::bigint,
    '9a000000-0000-4000-8000-000000000002',
    '9b000000-0000-4000-8000-000000000002'
  )::text,
  true
);
reset role;

select ok(
  (
    select studio.status = 'pending_review'
      and studio.publication_version = 2
      and studio.published_revision_id is null
      and studio.draft_revision_id = revision.id
      and revision.status = 'pending'
    from public.studios as studio
    join public.studio_revisions as revision on revision.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'studioId'
    )::uuid
  ),
  'submissao completa transiciona draft para pending_review exatamente uma vez'
);
select ok(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(pg_catalog.to_jsonb(event)::text like '%submitted%')
    from public.studio_review_events as event
    where event.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId'
      )::uuid
      and event.revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'revisionId'
      )::uuid
  )
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(outbox.template_key = 'studio.review.submitted')
        and pg_catalog.count(distinct outbox.deduplication_key) = 1
      from public.email_outbox as outbox
      where pg_catalog.to_jsonb(outbox)::text like pg_catalog.format(
        '%%%s%%',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId'
      )
    )
    and (
      select pg_catalog.count(*) = 1
      from private.studio_command_requests as request
      where request.owner_user_id = '91000000-0000-4000-8000-000000000001'
        and request.idempotency_key = '9a000000-0000-4000-8000-000000000002'
        and request.action = 'studio.revision.submit'
        and request.studio_id = (
          pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
            ->> 'studioId'
        )::uuid
        and request.resulting_revision_id = (
          pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
            ->> 'revisionId'
        )::uuid
        and request.resulting_revision_version = (
          pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
            ->> 'revisionVersion'
        )::bigint + 1
        and request.result_payload is null
        and request.result_hash = private.studio_result_hash(
          pg_catalog.current_setting('set_livre.test.f009_submit_result')::jsonb
        )
        and pg_catalog.to_jsonb(request)::text
          !~ '(Rua da Publicacao|Estudio QA|Wi-Fi)'
    ),
  'transacao cria evento/outbox e ancora hashes e referencias minimas no ledger canonico'
);
select is(
  pg_catalog.current_setting('set_livre.test.f009_submit_result')::jsonb,
  private.get_owner_studio_publication(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'studioId'
    )::uuid
  ),
  'submit retorna o read model autoritativo persistido'
);
select is(
  (
    select pg_catalog.jsonb_build_object(
      'revisionId', gallery.value ->> 'revisionId',
      'revisionStatus', gallery.value ->> 'revisionStatus',
      'canEdit', (gallery.value ->> 'canEdit')::boolean,
      'itemCount', pg_catalog.jsonb_array_length(gallery.value -> 'items')
    )
    from (
      select private.get_owner_studio_media(
        '91000000-0000-4000-8000-000000000001',
        (
          pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
            ->> 'studioId'
        )::uuid
      ) as value
    ) as gallery
  ),
  pg_catalog.jsonb_build_object(
    'revisionId', pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
      ->> 'revisionId',
    'revisionStatus', 'pending',
    'canEdit', false,
    'itemCount', 1
  ),
  'galeria pending permanece legivel, factual e sem autorizacao de edicao'
);
select ok(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        event.target_type = 'studio'
        and event.target_id = (
          pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
            ->> 'studioId'
        )::uuid
        and event.request_id = '9b000000-0000-4000-8000-000000000002'
        and event.idempotency_key = '9a000000-0000-4000-8000-000000000002'
      )
    from audit.events as event
    where event.actor_user_id = '91000000-0000-4000-8000-000000000001'
      and event.action = 'studio.revision_submitted'
  ),
  'submissao registra audit correlacionado e separado da chave idempotente'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_submit_replay',
  private.submit_studio_revision(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'revisionId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'revisionVersion'
    )::bigint,
    '9a000000-0000-4000-8000-000000000002',
    '9b000000-0000-4000-8000-000000000002'
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f009_submit_replay')::jsonb
      = pg_catalog.current_setting('set_livre.test.f009_submit_result')::jsonb
    and (
      select studio.publication_version = 2
      from public.studios as studio
      where studio.id = (
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and (
      select pg_catalog.count(*) = 1
      from public.studio_review_events as event
      where event.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and (
      select pg_catalog.count(*) = 1
      from audit.events as event
      where event.action = 'studio.revision_submitted'
        and event.target_id = (
          pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
            ->> 'studioId'
        )::uuid
    ),
  'replay identico retorna o mesmo JSON sem incrementar versao ou duplicar efeitos'
);

select is(
  array[
    private.feat009_capture_error(
      pg_catalog.format(
        'insert into public.studio_review_events (studio_id, revision_id, actor_user_id, event_type) values (%L::uuid, %L::uuid, null, ''approved'')',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'revisionId'
      )
    ),
    private.feat009_capture_error(
      pg_catalog.format(
        'insert into public.studio_review_events (studio_id, revision_id, actor_user_id, event_type) values (%L::uuid, %L::uuid, %L::uuid, ''approved'')',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'revisionId',
        '91000000-0000-4000-8000-000000000002'
      )
    )
  ],
  array[
    '23514:studio_review_decision_actor_invalid',
    '23514:studio_review_decision_state_invalid'
  ],
  'decisao exige ator identificado e estado terminal correspondente depois da submissao'
);

select matches(
  private.feat009_capture_error(
    pg_catalog.format(
      $command$
        select private.submit_studio_revision(
          '91000000-0000-4000-8000-000000000001',
          %L::uuid,
          %L::uuid,
          %L::bigint,
          '9a000000-0000-4000-8000-000000000002',
          '9b000000-0000-4000-8000-000000000098'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
        ->> 'revisionId',
      (
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'revisionVersion'
      )::bigint + 1
    )
  ),
  '^40001:studio_(publication_)?idempotency_conflict$',
  'mesma chave com payload divergente conflita antes de qualquer novo efeito'
);
select ok(
  (
    select pg_catalog.count(*) = 1
    from private.studio_command_requests as request
    where request.owner_user_id = '91000000-0000-4000-8000-000000000001'
      and request.idempotency_key = '9a000000-0000-4000-8000-000000000002'
  )
    and (
      select pg_catalog.count(*) = 1
      from public.email_outbox as outbox
      where pg_catalog.to_jsonb(outbox)::text like pg_catalog.format(
        '%%%s%%',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId'
      )
    ),
  'conflito idempotente preserva exatamente o ledger e a outbox originais'
);

select is(
  array[
    private.feat009_capture_error(
      pg_catalog.format(
        'update public.studio_revisions set name = name, revision_version = revision_version + 1 where id = %L::uuid',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'revisionId'
      )
    ),
    private.feat009_capture_error(
      pg_catalog.format(
        'delete from public.studio_revision_tags where revision_id = %L::uuid',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'revisionId'
      )
    ),
    private.feat009_capture_error(
      pg_catalog.format(
        'update public.studio_faqs set answer = answer where revision_id = %L::uuid',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'revisionId'
      )
    ),
    private.feat009_capture_error(
      pg_catalog.format(
        'update public.studio_revision_media set position = position where revision_id = %L::uuid',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'revisionId'
      )
    ),
    private.feat009_capture_error(
      pg_catalog.format(
        'update public.studio_media set status = ''delete_pending'', delete_requested_at = pg_catalog.clock_timestamp(), cleanup_after = pg_catalog.clock_timestamp() where id = %L::uuid',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'mediaId'
      )
    ),
    private.feat009_capture_error(
      pg_catalog.format(
        'delete from public.studio_revision_media where revision_id = %L::uuid and media_id = %L::uuid',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'revisionId',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'mediaId'
      )
    )
  ],
  array[
    '23514:studio_revision_immutable',
    '23514:studio_revision_relation_immutable',
    '23514:studio_revision_relation_immutable',
    '23514:studio_media_revision_immutable',
    '23514:studio_media_revision_immutable',
    '23514:studio_media_revision_immutable'
  ],
  'revisao pending, suas relacoes e o ciclo fisico da midia sao imutaveis'
);

select is(
  array[
    private.feat009_capture_error(
      pg_catalog.format(
        'update public.studio_review_events set id = id where studio_id = %L::uuid',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId'
      )
    ),
    private.feat009_capture_error(
      pg_catalog.format(
        'update public.studio_review_events set event_type = event_type where studio_id = %L::uuid',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId'
      )
    ),
    private.feat009_capture_error(
      pg_catalog.format(
        'update public.studio_review_events set event_sequence = event_sequence + 100 where studio_id = %L::uuid',
        pg_catalog.current_setting('set_livre.test.f009_complete')::jsonb
          ->> 'studioId'
      )
    )
  ],
  array[
    '42501:studio_review_event_is_append_only',
    '42501:studio_review_event_is_append_only',
    '428C9:column "event_sequence" can only be updated to DEFAULT'
  ],
  'trigger append-only e identity rejeitam alteracoes de identidade, conteudo e sequencia'
);

select matches(
  private.feat009_capture_error(
    pg_catalog.format(
      $command$
        select private.submit_studio_revision(
          '91000000-0000-4000-8000-000000000001',
          %L::uuid,
          %L::uuid,
          %L::bigint,
          '9a000000-0000-4000-8000-000000000003',
          '9b000000-0000-4000-8000-000000000003'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f009_stale')::jsonb
        ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f009_stale')::jsonb
        ->> 'revisionId',
      (
        pg_catalog.current_setting('set_livre.test.f009_stale')::jsonb
          ->> 'revisionVersion'
      )::bigint + 1
    )
  ),
  '^40001:studio_revision_conflict$',
  'revision_version stale falha por optimistic concurrency'
);
select ok(
  (
    select studio.status = 'draft'
      and studio.publication_version = 1
      and revision.status = 'draft'
    from public.studios as studio
    join public.studio_revisions as revision on revision.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_stale')::jsonb
        ->> 'studioId'
    )::uuid
  )
    and not exists (
      select 1
      from public.studio_review_events as event
      where event.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_stale')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and not exists (
      select 1
      from public.email_outbox as outbox
      where pg_catalog.to_jsonb(outbox)::text like pg_catalog.format(
        '%%%s%%',
        pg_catalog.current_setting('set_livre.test.f009_stale')::jsonb
          ->> 'studioId'
      )
    ),
  'conflito otimista nao deixa transicao, evento ou intencao parcial'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_pending_draft',
  private.update_studio_revision_content(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'revisionId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'revisionVersion'
    )::bigint,
    '97200000-0000-4000-8000-000000000004',
    '97300000-0000-4000-8000-000000000004',
    'Uso mediante reserva confirmada; esta e a revisao candidata completa.',
    'dQw4w9WgXcQ',
    '[{"question":"A revisao esta completa?","answer":"Sim, incluindo capa e taxonomias."}]'::jsonb
  )::text,
  true
);
reset role;

select ok(
  (
    select studio.status = 'changes_pending'
      and studio.publication_version = 4
      and studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
          ->> 'revisionId'
      )::uuid
      and studio.draft_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_draft')::jsonb
          -> 'revision' ->> 'id'
      )::uuid
      and published.status = 'approved'
      and candidate.status = 'draft'
    from public.studios as studio
    join public.studio_revisions as published on published.id = studio.published_revision_id
    join public.studio_revisions as candidate on candidate.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid
  ),
  'editar publicado cria nova draft completa sem trocar a revisao publica'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_changes_submit',
  private.submit_studio_revision(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_draft')::jsonb
        -> 'revision' ->> 'id'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_draft')::jsonb
        -> 'revision' ->> 'version'
    )::bigint,
    '9a000000-0000-4000-8000-000000000004',
    '9b000000-0000-4000-8000-000000000004'
  )::text,
  true
);
reset role;

select ok(
  (
    select studio.status = 'changes_pending'
      and studio.publication_version = 4
      and studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
          ->> 'revisionId'
      )::uuid
      and studio.draft_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_draft')::jsonb
          -> 'revision' ->> 'id'
      )::uuid
      and published.status = 'approved'
      and candidate.status = 'pending'
    from public.studios as studio
    join public.studio_revisions as published on published.id = studio.published_revision_id
    join public.studio_revisions as candidate on candidate.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid
  ),
  'submit em changes_pending nao inventa fronteira nem troca published_revision_id'
);
select ok(
  (
    select pg_catalog.count(*) = 1
    from public.studio_review_events as event
    where event.studio_id = (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid
  )
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(outbox.template_key = 'studio.review.submitted')
      from public.email_outbox as outbox
      where pg_catalog.to_jsonb(outbox)::text like pg_catalog.format(
        '%%%s%%',
        pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
          ->> 'studioId'
      )
    ),
  'reaprovacao tambem cria um unico evento e uma unica intencao de review'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_paused_submission_draft',
  private.update_studio_revision_content(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_paused_submission')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_paused_submission')::jsonb
        ->> 'revisionId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_paused_submission')::jsonb
        ->> 'revisionVersion'
    )::bigint,
    '97200000-0000-4000-8000-000000000008',
    '97300000-0000-4000-8000-000000000008',
    'Uso mediante reserva confirmada; candidata enviada enquanto a publicacao esta pausada.',
    'dQw4w9WgXcQ',
    '[{"question":"Pode ser revisada pausada?","answer":"Sim, sem nova fronteira publica."}]'::jsonb
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_paused_submission_pause',
  private.pause_studio(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_paused_submission')::jsonb
        ->> 'studioId'
    )::uuid,
    4,
    '9c000000-0000-4000-8000-000000000008',
    '9e000000-0000-4000-8000-000000000008'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_paused_submission_result',
  private.submit_studio_revision(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_paused_submission')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_paused_submission_draft')::jsonb
        -> 'revision' ->> 'id'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_paused_submission_draft')::jsonb
        -> 'revision' ->> 'version'
    )::bigint,
    '9a000000-0000-4000-8000-000000000008',
    '9b000000-0000-4000-8000-000000000008'
  )::text,
  true
);
reset role;

select ok(
  (
    select studio.status = 'paused'
      and studio.publication_version = 5
      and candidate.status = 'pending'
      and studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_paused_submission')::jsonb
          ->> 'revisionId'
      )::uuid
      and studio.draft_revision_id = candidate.id
    from public.studios as studio
    join public.studio_revisions as candidate on candidate.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_paused_submission')::jsonb
        ->> 'studioId'
    )::uuid
  )
    and pg_catalog.current_setting('set_livre.test.f009_paused_submission_result')::jsonb
      @> pg_catalog.jsonb_build_object(
        'studioStatus', 'paused',
        'publicationVersion', 5
      )
    and (
      select pg_catalog.count(*) = 1
      from public.studio_review_events as review
      where review.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_paused_submission')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and (
      select pg_catalog.count(*) = 1
      from public.email_outbox as outbox
      where outbox.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_paused_submission')::jsonb
          ->> 'studioId'
      )::uuid
    ),
  'submit em paused torna a candidata pending sem incremento ficticio da publicacao'
);

select ok(
  private.feat009_capture_error(
    pg_catalog.format(
      $command$
        select private.pause_studio(
          '91000000-0000-4000-8000-000000000002',
          %L::uuid,
          4,
          '9c000000-0000-4000-8000-000000000024',
          '9e000000-0000-4000-8000-000000000024'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )
  ) = 'P0002:studio_not_found'
    and private.feat009_capture_error(
      pg_catalog.format(
        $command$
          select private.resume_studio(
            '91000000-0000-4000-8000-000000000002',
            %L::uuid,
            4,
            '9d000000-0000-4000-8000-000000000024',
            '9f000000-0000-4000-8000-000000000024'
          )
        $command$,
        pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
          ->> 'studioId'
      )
    ) = 'P0002:studio_not_found',
  'pause e resume nao revelam nem alteram estudio de outro dono'
);

update public.profiles as profile
set status = 'suspended'
where profile.id = '91000000-0000-4000-8000-000000000001';
select is(
  private.feat009_capture_error(
    pg_catalog.format(
      $command$
        select private.pause_studio(
          '91000000-0000-4000-8000-000000000001',
          %L::uuid,
          4,
          '9c000000-0000-4000-8000-000000000034',
          '9e000000-0000-4000-8000-000000000034'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )
  ),
  '42501:studio_owner_inactive',
  'conta suspensa nao pausa publicacao'
);
update public.profiles as profile
set status = 'active'
where profile.id = '91000000-0000-4000-8000-000000000001';

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_pause_result',
  private.pause_studio(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    4,
    '9c000000-0000-4000-8000-000000000004',
    '9e000000-0000-4000-8000-000000000004'
  )::text,
  true
);
reset role;

select ok(
  (
    select studio.status = 'paused'
      and studio.publication_version = 5
      and studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
          ->> 'revisionId'
      )::uuid
      and studio.draft_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_draft')::jsonb
          -> 'revision' ->> 'id'
      )::uuid
    from public.studios as studio
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid
  )
    and (
      select pg_catalog.count(*) = 1
      from public.studio_review_events as event
      where event.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
          ->> 'studioId'
      )::uuid
    ),
  'pause incrementa a versao e preserva ambos os ponteiros sem novo review'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_pause_replay',
  private.pause_studio(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    4,
    '9c000000-0000-4000-8000-000000000004',
    '9e000000-0000-4000-8000-000000000004'
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f009_pause_replay')::jsonb
      = pg_catalog.current_setting('set_livre.test.f009_pause_result')::jsonb
    and (
      select studio.publication_version = 5
      from public.studios as studio
      where studio.id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and (
      select pg_catalog.count(*) = 1
      from audit.events as event
      where event.action = 'studio.paused'
        and event.target_id = (
          pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
            ->> 'studioId'
        )::uuid
    ),
  'replay de pause converge sem nova versao ou audit duplicado'
);

update public.profiles as profile
set status = 'suspended'
where profile.id = '91000000-0000-4000-8000-000000000001';
select is(
  private.feat009_capture_error(
    pg_catalog.format(
      $command$
        select private.resume_studio(
          '91000000-0000-4000-8000-000000000001',
          %L::uuid,
          5,
          '9d000000-0000-4000-8000-000000000035',
          '9f000000-0000-4000-8000-000000000035'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )
  ),
  '42501:studio_owner_inactive',
  'conta suspensa nao retoma publicacao'
);
update public.profiles as profile
set status = 'active'
where profile.id = '91000000-0000-4000-8000-000000000001';

select matches(
  private.feat009_capture_error(
    pg_catalog.format(
      $command$
        select private.resume_studio(
          '91000000-0000-4000-8000-000000000001',
          %L::uuid,
          4,
          '9d000000-0000-4000-8000-000000000094',
          '9f000000-0000-4000-8000-000000000094'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )
  ),
  '^40001:studio_publication_conflict$',
  'resume com token anterior ao pause falha por optimistic concurrency'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_resume_result',
  private.resume_studio(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    5,
    '9d000000-0000-4000-8000-000000000004',
    '9f000000-0000-4000-8000-000000000004'
  )::text,
  true
);
reset role;

select ok(
  (
    select studio.status = 'changes_pending'
      and studio.publication_version = 6
      and studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
          ->> 'revisionId'
      )::uuid
      and studio.draft_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_pending_draft')::jsonb
          -> 'revision' ->> 'id'
      )::uuid
    from public.studios as studio
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid
  ),
  'resume deriva changes_pending quando o candidato preservado esta pending'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_draft_clone',
  private.update_studio_revision_content(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'revisionId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'revisionVersion'
    )::bigint,
    '97200000-0000-4000-8000-000000000005',
    '97300000-0000-4000-8000-000000000005',
    'Uso mediante reserva confirmada; esta draft ainda nao foi enviada.',
    'dQw4w9WgXcQ',
    '[{"question":"Ja foi enviada?","answer":"Ainda nao."}]'::jsonb
  )::text,
  true
);
reset role;

do $block$
begin
  delete from public.studio_revision_media as relation
  where relation.revision_id = (
      pg_catalog.current_setting('set_livre.test.f009_draft_clone')::jsonb
        -> 'revision' ->> 'id'
    )::uuid
    and relation.media_id = (
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'mediaId'
    )::uuid;

  if not found then
    raise exception using errcode = 'P0002', message = 'feat009_media_escape_fixture_missing';
  end if;
end;
$block$;

select is(
  private.feat009_capture_error(
    pg_catalog.format(
      'update public.studio_revision_media set revision_id = %L::uuid where revision_id = %L::uuid and media_id = %L::uuid',
      pg_catalog.current_setting('set_livre.test.f009_draft_clone')::jsonb
        -> 'revision' ->> 'id',
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'revisionId',
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'mediaId'
    )
  ),
  '23514:studio_media_revision_immutable',
  'midia aprovada nao pode escapar para uma draft compativel por troca de revision_id'
);

insert into public.studio_revision_media (revision_id, media_id, position, is_cover)
select
  (
    pg_catalog.current_setting('set_livre.test.f009_draft_clone')::jsonb
      -> 'revision' ->> 'id'
  )::uuid,
  relation.media_id,
  relation.position,
  relation.is_cover
from public.studio_revision_media as relation
where relation.revision_id = (
    pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
      ->> 'revisionId'
  )::uuid
  and relation.media_id = (
    pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
      ->> 'mediaId'
  )::uuid;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_draft_pause',
  private.pause_studio(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    4,
    '9c000000-0000-4000-8000-000000000005',
    '9e000000-0000-4000-8000-000000000005'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_draft_resume',
  private.resume_studio(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    5,
    '9d000000-0000-4000-8000-000000000005',
    '9f000000-0000-4000-8000-000000000005'
  )::text,
  true
);
reset role;

select ok(
  (
    select studio.status = 'published'
      and studio.publication_version = 6
      and studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
          ->> 'revisionId'
      )::uuid
      and studio.draft_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_draft_clone')::jsonb
          -> 'revision' ->> 'id'
      )::uuid
      and candidate.status = 'draft'
    from public.studios as studio
    join public.studio_revisions as candidate on candidate.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'studioId'
    )::uuid
  )
    and pg_catalog.current_setting('set_livre.test.f009_draft_resume')::jsonb
      ->> 'studioStatus' = 'published'
    and (
      pg_catalog.current_setting('set_livre.test.f009_draft_resume')::jsonb
        ->> 'canSubmit'
    )::boolean
    and pg_catalog.current_setting('set_livre.test.f009_draft_resume')::jsonb
      -> 'currentRevision' ->> 'status' = 'draft',
  'resume deriva published, preserva a draft e devolve submissao disponivel'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_draft_discard',
  private.discard_studio_draft(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_clone')::jsonb
        -> 'revision' ->> 'id'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_clone')::jsonb
        -> 'revision' ->> 'version'
    )::bigint,
    '97400000-0000-4000-8000-000000000005',
    '97500000-0000-4000-8000-000000000005'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_draft_discard_replay',
  private.discard_studio_draft(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_clone')::jsonb
        -> 'revision' ->> 'id'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_draft_clone')::jsonb
        -> 'revision' ->> 'version'
    )::bigint,
    '97400000-0000-4000-8000-000000000005',
    '97500000-0000-4000-8000-000000000005'
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f009_draft_discard')::jsonb
      = pg_catalog.current_setting('set_livre.test.f009_draft_discard_replay')::jsonb
    and (
      select studio.status = 'published'
        and studio.publication_version = 7
        and studio.published_revision_id = (
          pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
            ->> 'revisionId'
        )::uuid
        and studio.draft_revision_id is null
      from public.studios as studio
      where studio.id = (
        pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and not exists (
      select 1
      from public.studio_revisions as revision
      where revision.id = (
        pg_catalog.current_setting('set_livre.test.f009_draft_clone')::jsonb
          -> 'revision' ->> 'id'
      )::uuid
    )
    and (
      select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(
          request.resulting_revision_id = (
            pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
              ->> 'revisionId'
          )::uuid
          and request.result_payload is null
        )
      from private.studio_command_requests as request
      where request.owner_user_id = '91000000-0000-4000-8000-000000000001'
        and request.idempotency_key in (
          '9c000000-0000-4000-8000-000000000005',
          '9d000000-0000-4000-8000-000000000005'
        )
    )
    and (
      select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(
          event.metadata ->> 'revisionId' = (
            pg_catalog.current_setting('set_livre.test.f009_draft_candidate')::jsonb
              ->> 'revisionId'
          )
        )
      from audit.events as event
      where event.actor_user_id = '91000000-0000-4000-8000-000000000001'
        and event.idempotency_key in (
          '9c000000-0000-4000-8000-000000000005',
          '9d000000-0000-4000-8000-000000000005'
        )
    ),
  'pause/resume ancoram a revisao publicada e nao impedem descarte idempotente da draft'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_none_pause',
  private.pause_studio(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_no_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    3,
    '9c000000-0000-4000-8000-000000000006',
    '9e000000-0000-4000-8000-000000000006'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_none_resume',
  private.resume_studio(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_no_candidate')::jsonb
        ->> 'studioId'
    )::uuid,
    4,
    '9d000000-0000-4000-8000-000000000006',
    '9f000000-0000-4000-8000-000000000006'
  )::text,
  true
);
reset role;

select ok(
  (
    select studio.status = 'published'
      and studio.publication_version = 5
      and studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f009_no_candidate')::jsonb
          ->> 'revisionId'
      )::uuid
      and studio.draft_revision_id is null
    from public.studios as studio
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f009_no_candidate')::jsonb
        ->> 'studioId'
    )::uuid
  ),
  'resume deriva published quando nao existe candidato e preserva o ponteiro publico'
);

select ok(
  (
    select pg_catalog.count(*) = 10
      and pg_catalog.count(*) filter (
        where event.action = 'studio.revision_submitted'
      ) = 3
      and pg_catalog.count(*) filter (where event.action = 'studio.paused') = 4
      and pg_catalog.count(*) filter (where event.action = 'studio.resumed') = 3
      and pg_catalog.bool_and(event.request_id <> event.idempotency_key)
    from audit.events as event
    where event.actor_user_id = '91000000-0000-4000-8000-000000000001'
      and event.action in (
        'studio.revision_submitted',
        'studio.paused',
        'studio.resumed'
      )
  ),
  'cada transicao efetiva gera um audit e replays nao duplicam fatos'
);
select ok(
  not exists (
    select 1
    from audit.events as event
    where event.actor_user_id = '91000000-0000-4000-8000-000000000001'
      and event.action in (
        'studio.revision_submitted',
        'studio.paused',
        'studio.resumed'
      )
      and event.metadata::text ~ '(Rua da Publicacao|Estudio QA|Wi-Fi)'
  ),
  'audit editorial nao replica endereco, nome ou conteudo da revisao'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_final_read',
  private.get_owner_studio_publication(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
        ->> 'studioId'
    )::uuid
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f009_final_read')::jsonb
      = pg_catalog.current_setting('set_livre.test.f009_resume_result')::jsonb
    and pg_catalog.current_setting('set_livre.test.f009_final_read')::jsonb
      @> pg_catalog.jsonb_build_object(
        'scope', '91000000-0000-4000-8000-000000000001'::uuid,
        'studioStatus', 'changes_pending',
        'publicationVersion', 6
      )
    and pg_catalog.current_setting('set_livre.test.f009_final_read')::jsonb
      -> 'publishedRevision' ->> 'id' = (
        pg_catalog.current_setting('set_livre.test.f009_pending_candidate')::jsonb
          ->> 'revisionId'
      )
    and pg_catalog.current_setting('set_livre.test.f009_final_read')::jsonb
      -> 'currentRevision' ->> 'id' = (
        pg_catalog.current_setting('set_livre.test.f009_pending_draft')::jsonb
          -> 'revision' ->> 'id'
      )
    and pg_catalog.current_setting('set_livre.test.f009_final_read')::jsonb
      -> 'latestReview' -> 'rejectionReason' = 'null'::jsonb,
  'read model final preserva shape, ponteiros, versao e ultimo motivo factual'
);

select pg_catalog.set_config(
  'set_livre.test.f009_review_order_approved_candidate',
  pg_catalog.jsonb_build_object(
    'revisionId', prepared.revision_id,
    'revisionVersion', prepared.revision_version
  )::text,
  true
)
from private.prepare_studio_revision_draft(
  '91000000-0000-4000-8000-000000000001',
  (
    pg_catalog.current_setting('set_livre.test.f009_review_order')::jsonb
      ->> 'studioId'
  )::uuid,
  (
    pg_catalog.current_setting('set_livre.test.f009_review_order')::jsonb
      ->> 'revisionId'
  )::uuid,
  (
    pg_catalog.current_setting('set_livre.test.f009_review_order')::jsonb
      ->> 'revisionVersion'
  )::bigint
) as prepared;

update public.studio_revisions as revision
set
  status = 'pending',
  revision_version = revision.revision_version + 1
where revision.id = (
  pg_catalog.current_setting('set_livre.test.f009_review_order_approved_candidate')::jsonb
    ->> 'revisionId'
)::uuid
  and revision.status = 'draft';

insert into public.studio_review_events (
  id,
  studio_id,
  revision_id,
  actor_user_id,
  event_type,
  occurred_at
)
select
  'ffffffff-ffff-4fff-8fff-ffffffff9001',
  (fixture.value ->> 'studioId')::uuid,
  (
    pg_catalog.current_setting('set_livre.test.f009_review_order_approved_candidate')::jsonb
      ->> 'revisionId'
  )::uuid,
  '91000000-0000-4000-8000-000000000001',
  'submitted',
  '2040-01-01 12:00:00+00'::timestamptz
from (
  select pg_catalog.current_setting('set_livre.test.f009_review_order')::jsonb as value
) as fixture;

-- A decisao editorial pertence ao backoffice futuro. O fixture pgTAP fabrica somente esse fato
-- fora do caminho de producao, sem DDL que retenha lock de relacao durante os testes dblink.
set local session_replication_role = replica;
update public.studio_revisions as revision
set
  status = 'approved',
  revision_version = revision.revision_version + 1,
  updated_at = pg_catalog.clock_timestamp()
where revision.id = (
  pg_catalog.current_setting('set_livre.test.f009_review_order_approved_candidate')::jsonb
    ->> 'revisionId'
)::uuid
  and revision.status = 'pending';
set local session_replication_role = origin;

update public.studios as studio
set
  status = 'published',
  published_revision_id = (
    pg_catalog.current_setting('set_livre.test.f009_review_order_approved_candidate')::jsonb
      ->> 'revisionId'
  )::uuid,
  draft_revision_id = null
where studio.id = (
  pg_catalog.current_setting('set_livre.test.f009_review_order')::jsonb
    ->> 'studioId'
)::uuid
  and studio.status = 'changes_pending';

insert into public.studio_review_events (
  id,
  studio_id,
  revision_id,
  actor_user_id,
  event_type,
  occurred_at
)
select
  '00000000-0000-4000-8000-000000009002',
  (fixture.value ->> 'studioId')::uuid,
  (
    pg_catalog.current_setting('set_livre.test.f009_review_order_approved_candidate')::jsonb
      ->> 'revisionId'
  )::uuid,
  '91000000-0000-4000-8000-000000000002',
  'approved',
  '2039-01-01 12:00:00+00'::timestamptz
from (
  select pg_catalog.current_setting('set_livre.test.f009_review_order')::jsonb as value
) as fixture;

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_regressive_timestamp_read',
  private.get_owner_studio_publication(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_review_order')::jsonb
        ->> 'studioId'
    )::uuid
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f009_regressive_timestamp_read')::jsonb
      -> 'latestReview' ->> 'eventType' = 'approved'
    and (
      pg_catalog.current_setting('set_livre.test.f009_regressive_timestamp_read')::jsonb
        -> 'latestReview' ->> 'occurredAt'
    )::timestamptz = '2039-01-01 12:00:00+00'::timestamptz,
  'ultimo review segue a sequencia causal mesmo quando o relogio retrocede'
);

create extension if not exists dblink with schema extensions;
create temporary table feat009_concurrency_results (
  label text primary key,
  result jsonb,
  error_message text
);

select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('feat009-pause-barrier', 0)
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
    'feat009_pause_a',
    'feat009_pause_b'
  ]
  loop
    perform extensions.dblink_connect(connection_name, connection_string);
  end loop;

  perform extensions.dblink_send_query(
    'feat009_pause_a',
    $remote$
      with barrier as materialized (
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('feat009-pause-barrier', 0)
        ) as acquired
      )
      select private.pause_studio(
        '91000000-0000-4000-8000-000000000009',
        fixture.studio_id,
        fixture.publication_version,
        '9c000000-0000-4000-8000-000000000009',
        '9e000000-0000-4000-8000-000000000009'
      )
      from barrier
      cross join private.feat009_concurrency_fixtures as fixture
      where fixture.label = 'pause'
    $remote$
  );
  perform extensions.dblink_send_query(
    'feat009_pause_b',
    $remote$
      with barrier as materialized (
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('feat009-pause-barrier', 0)
        ) as acquired
      )
      select private.pause_studio(
        '91000000-0000-4000-8000-000000000009',
        fixture.studio_id,
        fixture.publication_version,
        '9c000000-0000-4000-8000-000000000019',
        '9e000000-0000-4000-8000-000000000019'
      )
      from barrier
      cross join private.feat009_concurrency_fixtures as fixture
      where fixture.label = 'pause'
    $remote$
  );
end;
$block$;

select ok(
  extensions.dblink_is_busy('feat009_pause_a') = 1
    and extensions.dblink_is_busy('feat009_pause_b') = 1,
  'barreira comprova que as duas pausas chegaram antes da primeira transicao'
);

select pg_catalog.pg_advisory_unlock(
  pg_catalog.hashtextextended('feat009-pause-barrier', 0)
);

do $block$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat009_pause_a',
    'feat009_pause_b'
  ]
  loop
    begin
      insert into feat009_concurrency_results (label, result)
      select connection_name, remote_result.result
      from extensions.dblink_get_result(connection_name) as remote_result(result jsonb);
    exception when others then
      insert into feat009_concurrency_results (label, error_message)
      values (connection_name, sqlstate || ':' || sqlerrm);
    end;
  end loop;
end;
$block$;

select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('feat009-taxonomy-submit-barrier', 0)
);

do $block$
declare
  connection_string text := pg_catalog.format(
    'host=%s port=%s dbname=%I user=%I password=%s application_name=%s',
    pg_catalog.inet_server_addr(),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    'supabase_admin',
    'postgres',
    'feat009_taxonomy_submit'
  );
begin
  perform extensions.dblink_connect('feat009_taxonomy_submit', connection_string);
  perform extensions.dblink_send_query(
    'feat009_taxonomy_submit',
    $remote$
      select private.submit_studio_revision(
        '91000000-0000-4000-8000-000000000009',
        fixture.studio_id,
        fixture.revision_id,
        fixture.revision_version,
        '9a000000-0000-4000-8000-000000000011',
        '9b000000-0000-4000-8000-000000000011'
      )
      from private.feat009_concurrency_fixtures as fixture
      where fixture.label = 'taxonomy_submit'
    $remote$
  );
end;
$block$;

select pg_catalog.set_config(
  'set_livre.test.f009_taxonomy_barrier_reached',
  'false',
  true
);
do $block$
declare
  attempt integer := 0;
  reached boolean := false;
begin
  while attempt < 200 and not reached loop
    select exists (
      select 1
      from pg_catalog.pg_stat_activity as activity
      where activity.application_name = 'feat009_taxonomy_submit'
        and activity.wait_event_type = 'Lock'
        and activity.wait_event = 'advisory'
    ) into reached;

    if not reached then
      perform pg_catalog.pg_sleep(0.01);
    end if;
    attempt := attempt + 1;
  end loop;

  perform pg_catalog.set_config(
    'set_livre.test.f009_taxonomy_barrier_reached',
    reached::text,
    true
  );
end;
$block$;

select ok(
  pg_catalog.current_setting('set_livre.test.f009_taxonomy_barrier_reached')::boolean
    and extensions.dblink_is_busy('feat009_taxonomy_submit') = 1,
  'submit concorrente alcanca a barreira ja mantendo a taxonomia ativa travada'
);

set local lock_timeout = '250ms';
select matches(
  private.feat009_capture_error(
    $command$
      update public.tags as tag
      set
        active = false,
        taxonomy_version = tag.taxonomy_version + 1
      where tag.id = '62f00000-0000-4000-8000-000000000009'
        and tag.active
    $command$
  ),
  '^55P03:.*lock timeout$',
  'arquivamento concorrente nao atravessa o fence de taxonomia da submissao'
);
set local lock_timeout = '0';

select pg_catalog.pg_advisory_unlock(
  pg_catalog.hashtextextended('feat009-taxonomy-submit-barrier', 0)
);

do $block$
begin
  begin
    insert into feat009_concurrency_results (label, result)
    select 'feat009_taxonomy_submit', remote_result.result
    from extensions.dblink_get_result('feat009_taxonomy_submit')
      as remote_result(result jsonb);
  exception when others then
    insert into feat009_concurrency_results (label, error_message)
    values ('feat009_taxonomy_submit', sqlstate || ':' || sqlerrm);
  end;
end;
$block$;

select ok(
  (
    select concurrency.result is not null and concurrency.error_message is null
    from feat009_concurrency_results as concurrency
    where concurrency.label = 'feat009_taxonomy_submit'
  )
    and (
      select studio.status = 'pending_review'
        and studio.publication_version = fixture.publication_version + 1
        and revision.status = 'pending'
        and revision.revision_version = fixture.revision_version + 1
      from private.feat009_concurrency_fixtures as fixture
      join public.studios as studio on studio.id = fixture.studio_id
      join public.studio_revisions as revision on revision.id = fixture.revision_id
      where fixture.label = 'taxonomy_submit'
    )
    and (
      select tag.active
      from public.tags as tag
      where tag.id = '62f00000-0000-4000-8000-000000000009'
    )
    and (
      select pg_catalog.count(*) = 1
      from public.studio_review_events as review
      join private.feat009_concurrency_fixtures as fixture
        on fixture.studio_id = review.studio_id
        and fixture.revision_id = review.revision_id
      where fixture.label = 'taxonomy_submit'
        and review.event_type = 'submitted'
    )
    and (
      select pg_catalog.count(*) = 1
      from public.email_outbox as outbox
      join private.feat009_concurrency_fixtures as fixture
        on fixture.studio_id = outbox.studio_id
        and fixture.revision_id = outbox.revision_id
      where fixture.label = 'taxonomy_submit'
    )
    and (
      select pg_catalog.count(*) = 1
      from private.studio_command_requests as request
      join private.feat009_concurrency_fixtures as fixture
        on fixture.studio_id = request.studio_id
      where fixture.label = 'taxonomy_submit'
        and request.action = 'studio.revision.submit'
        and request.idempotency_key = '9a000000-0000-4000-8000-000000000011'
    )
    and (
      select pg_catalog.count(*) = 1
      from audit.events as event
      join private.feat009_concurrency_fixtures as fixture
        on fixture.studio_id = event.target_id
      where fixture.label = 'taxonomy_submit'
        and event.action = 'studio.revision_submitted'
        and event.idempotency_key = '9a000000-0000-4000-8000-000000000011'
    ),
  'submit protegido conclui uma unica transicao atomica sem arquivar a taxonomia'
);

select extensions.dblink_disconnect('feat009_taxonomy_submit');

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.count(*) filter (
        where result is not null and error_message is null
      ) = 1
      and pg_catalog.count(*) filter (
        where result is null
          and error_message = '40001:studio_publication_conflict'
      ) = 1
    from feat009_concurrency_results
    where label in ('feat009_pause_a', 'feat009_pause_b')
  )
    and (
      select studio.status = 'paused'
        and studio.publication_version = fixture.publication_version + 1
        and studio.published_revision_id = fixture.revision_id
        and studio.draft_revision_id is null
      from private.feat009_concurrency_fixtures as fixture
      join public.studios as studio on studio.id = fixture.studio_id
      where fixture.label = 'pause'
    )
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          request.action = 'studio.pause'
          and request.resulting_revision_id = fixture.revision_id
          and request.resulting_revision_version = fixture.revision_version
          and request.result_payload is null
          and request.result_hash = private.studio_result_hash(result_row.result)
        )
      from private.studio_command_requests as request
      join private.feat009_concurrency_fixtures as fixture
        on fixture.studio_id = request.studio_id
        and fixture.label = 'pause'
      cross join lateral (
        select concurrency.result
        from feat009_concurrency_results as concurrency
        where concurrency.result is not null
        order by concurrency.label
        limit 1
      ) as result_row
      where request.owner_user_id = '91000000-0000-4000-8000-000000000009'
        and request.idempotency_key in (
          '9c000000-0000-4000-8000-000000000009',
          '9c000000-0000-4000-8000-000000000019'
        )
    )
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          event.metadata ->> 'revisionId' = fixture.revision_id::text
          and (event.metadata ->> 'publicationVersion')::bigint
            = fixture.publication_version + 1
        )
      from audit.events as event
      join private.feat009_concurrency_fixtures as fixture
        on fixture.studio_id = event.target_id
        and fixture.label = 'pause'
      where event.actor_user_id = '91000000-0000-4000-8000-000000000009'
        and event.action = 'studio.paused'
        and event.idempotency_key in (
          '9c000000-0000-4000-8000-000000000009',
          '9c000000-0000-4000-8000-000000000019'
        )
    ),
  'duas pausas simultaneas com chaves distintas geram um sucesso, um conflito e um unico fato'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_reviewed_unpublished_submit',
  private.submit_studio_revision(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
        ->> 'revisionId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
        ->> 'revisionVersion'
    )::bigint,
    '9a000000-0000-4000-8000-000000000014',
    '9b000000-0000-4000-8000-000000000014'
  )::text,
  true
);
reset role;

with correction as (
  insert into public.studio_revisions (
    studio_id,
    revision_number,
    revision_version,
    status,
    name,
    description,
    street,
    street_number,
    address_complement,
    neighborhood,
    city,
    state,
    postal_code,
    capacity,
    studio_type_id,
    usage_rules,
    youtube_video_id
  )
  select
    rejected.studio_id,
    rejected.revision_number + 1,
    1,
    'draft',
    rejected.name,
    rejected.description,
    rejected.street,
    rejected.street_number,
    rejected.address_complement,
    rejected.neighborhood,
    rejected.city,
    rejected.state,
    rejected.postal_code,
    rejected.capacity,
    rejected.studio_type_id,
    rejected.usage_rules,
    rejected.youtube_video_id
  from public.studio_revisions as rejected
  where rejected.id = (
      pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
        ->> 'revisionId'
    )::uuid
    and rejected.studio_id = (
      pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
        ->> 'studioId'
    )::uuid
    and rejected.status = 'pending'
  returning id
)
select pg_catalog.set_config(
    'set_livre.test.f009_reviewed_unpublished_correction',
    correction.id::text,
    true
  )
from correction;

set local session_replication_role = replica;
update public.studio_revisions as rejected
set
  status = 'rejected',
  revision_version = rejected.revision_version + 1,
  updated_at = pg_catalog.clock_timestamp()
where rejected.id = (
    pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
      ->> 'revisionId'
  )::uuid
  and rejected.studio_id = (
    pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
      ->> 'studioId'
  )::uuid
  and rejected.status = 'pending';
set local session_replication_role = origin;

insert into public.studio_review_events (
  studio_id,
  revision_id,
  actor_user_id,
  event_type,
  rejection_reason
)
values (
  (
    pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
      ->> 'studioId'
  )::uuid,
  (
    pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
      ->> 'revisionId'
  )::uuid,
  '91000000-0000-4000-8000-000000000002',
  'rejected',
  'A primeira submissao precisa de correcao antes de qualquer publicacao.'
);

update public.studios as studio
set
  status = 'rejected',
  draft_revision_id = pg_catalog.current_setting(
    'set_livre.test.f009_reviewed_unpublished_correction'
  )::uuid
where studio.id = (
    pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
      ->> 'studioId'
  )::uuid
  and studio.owner_user_id = '91000000-0000-4000-8000-000000000001'
  and studio.status = 'pending_review'
  and studio.published_revision_id is null
  and studio.draft_revision_id = (
    pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
      ->> 'revisionId'
  )::uuid;

select pg_catalog.set_config(
  'set_livre.test.f009_reviewed_unpublished_dependencies',
  pg_catalog.jsonb_build_object(
    'events', (
      select pg_catalog.count(*)
      from public.studio_review_events as review
      where review.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
          ->> 'studioId'
      )::uuid
    ),
    'outbox', (
      select pg_catalog.count(*)
      from public.email_outbox as outbox
      where outbox.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
          ->> 'studioId'
      )::uuid
    ),
    'revisions', (
      select pg_catalog.count(*)
      from public.studio_revisions as revision
      where revision.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
          ->> 'studioId'
      )::uuid
    )
  )::text,
  true
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f009_reviewed_unpublished_discard',
  private.discard_studio_draft(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
        ->> 'studioId'
    )::uuid,
    pg_catalog.current_setting(
      'set_livre.test.f009_reviewed_unpublished_correction'
    )::uuid,
    1,
    '9c000000-0000-4000-8000-000000000014',
    '9d000000-0000-4000-8000-000000000014'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f009_reviewed_unpublished_discard_replay',
  private.discard_studio_draft(
    '91000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
        ->> 'studioId'
    )::uuid,
    pg_catalog.current_setting(
      'set_livre.test.f009_reviewed_unpublished_correction'
    )::uuid,
    1,
    '9c000000-0000-4000-8000-000000000014',
    '9e000000-0000-4000-8000-000000000014'
  )::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished_dependencies')::jsonb
      = '{"events": 2, "outbox": 1, "revisions": 2}'::jsonb
    and (
      pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished_discard')::jsonb
        ->> 'studioDeleted'
    )::boolean
    and pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished_discard')
      = pg_catalog.current_setting(
        'set_livre.test.f009_reviewed_unpublished_discard_replay'
      )
    and not exists (
      select 1
      from public.studios as studio
      where studio.id = (
        pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and not exists (
      select 1
      from public.studio_revisions as revision
      where revision.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and not exists (
      select 1
      from public.studio_review_events as review
      where review.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
          ->> 'studioId'
      )::uuid
    )
    and not exists (
      select 1
      from public.email_outbox as outbox
      where outbox.studio_id = (
        pg_catalog.current_setting('set_livre.test.f009_reviewed_unpublished')::jsonb
          ->> 'studioId'
      )::uuid
    ),
  'descartar correcao da primeira rejeicao remove agregado e dependencias sem quebrar replay'
);

do $block$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat009_pause_a',
    'feat009_pause_b'
  ]
  loop
    perform extensions.dblink_disconnect(connection_name);
  end loop;
end;
$block$;

select ok(
  (
    select pg_catalog.count(*) = 0
    from private.dal_routine_allowlist as entry
    where pg_catalog.to_regprocedure(entry.signature) is null
  ),
  'toda assinatura da allowlist canonica resolve para uma rotina real'
);

revoke app_dal from postgres granted by current_user;

select * from finish();

rollback;

drop trigger if exists feat009_taxonomy_submit_barrier on public.studio_revisions;
drop function if exists private.feat009_taxonomy_submit_barrier();
drop table if exists private.feat009_concurrency_fixtures;
delete from public.email_outbox as outbox
using public.studios as studio
where outbox.studio_id = studio.id
  and studio.owner_user_id = '91000000-0000-4000-8000-000000000009';
delete from public.studio_review_events as review
using public.studios as studio
where review.studio_id = studio.id
  and studio.owner_user_id = '91000000-0000-4000-8000-000000000009';
delete from audit.events
where actor_user_id = '91000000-0000-4000-8000-000000000009'
  or target_id in (
    select studio.id
    from public.studios as studio
    where studio.owner_user_id = '91000000-0000-4000-8000-000000000009'
  );
delete from private.studio_command_requests
where owner_user_id = '91000000-0000-4000-8000-000000000009';
delete from public.studios
where owner_user_id = '91000000-0000-4000-8000-000000000009';
update public.studio_media
set
  status = 'delete_pending',
  delete_requested_at = coalesce(delete_requested_at, pg_catalog.clock_timestamp()),
  cleanup_after = pg_catalog.clock_timestamp()
where uploaded_by = '91000000-0000-4000-8000-000000000009'
  and status in ('pending_upload', 'ready', 'rejected', 'delete_pending');
delete from public.studio_media
where uploaded_by = '91000000-0000-4000-8000-000000000009';
delete from auth.users
where id = '91000000-0000-4000-8000-000000000009';
delete from public.tags
where id = '62f00000-0000-4000-8000-000000000009';

drop function if exists private.feat009_capture_error(text);
drop function if exists private.feat009_create_owner(uuid, text, text, integer);
drop function if exists private.feat009_create_studio_fixture(
  uuid, integer, text, boolean, boolean
);
