-- FEAT-030: fila editorial privada, decisões atômicas e moderação administrativa.
-- A fixture concorrente precisa estar committed para ser visível às duas sessões dblink.

create or replace function private.feat030_capture_error(command text)
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

create or replace function private.feat030_create_user(
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
      'a3100000-0000-4000-8000-'
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
        'a3200000-0000-4000-8000-'
        || pg_catalog.lpad(request_suffix::text, 12, '0')
      )::uuid,
      (
        'a3300000-0000-4000-8000-'
        || pg_catalog.lpad(request_suffix::text, 12, '0')
      )::uuid,
      null
    );
  end if;
end;
$function$;

create or replace function private.feat030_create_pending_studio(
  owner_user_id uuid,
  fixture_suffix integer,
  studio_name text
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
  revision_version bigint;
  studio_id uuid;
begin
  editor := private.create_studio(
    owner_user_id,
    (
      'b0100000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    (
      'b0200000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    studio_name,
    'Estúdio completo para validar a revisão editorial privada da FEAT 030.',
    'Rua da Curadoria',
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
  revision_version := (editor -> 'revision' ->> 'version')::bigint;

  editor := private.update_studio_revision_taxonomy(
    owner_user_id,
    studio_id,
    revision_id,
    revision_version,
    (
      'b0300000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    (
      'b0400000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    array['62000000-0000-4000-8000-000000000001'::uuid],
    array['63000000-0000-4000-8000-000000000001'::uuid]
  );
  revision_id := (editor -> 'revision' ->> 'id')::uuid;
  revision_version := (editor -> 'revision' ->> 'version')::bigint;

  editor := private.update_studio_revision_content(
    owner_user_id,
    studio_id,
    revision_id,
    revision_version,
    (
      'b0500000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    (
      'b0600000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    'Uso mediante reserva confirmada e respeito integral ao horário contratado.',
    'dQw4w9WgXcQ',
    '[{"question":"Há Wi-Fi?","answer":"Sim, a rede está incluída."}]'::jsonb
  );
  revision_id := (editor -> 'revision' ->> 'id')::uuid;
  revision_version := (editor -> 'revision' ->> 'version')::bigint;

  prepared := private.prepare_studio_media_upload(
    owner_user_id,
    studio_id,
    revision_id,
    revision_version,
    (
      'b0700000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    (
      'b0800000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    'image/jpeg',
    100,
    pg_catalog.repeat('a', 64)
  );
  media_id := (prepared ->> 'mediaId')::uuid;

  perform private.finalize_studio_media_upload(
    owner_user_id,
    studio_id,
    revision_id,
    revision_version,
    (
      'b0900000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    (
      'b0a00000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    media_id,
    'image/jpeg',
    100,
    1200,
    800,
    pg_catalog.repeat('a', 64)
  );

  editor := private.studio_editor_json(owner_user_id, studio_id);
  revision_id := (editor -> 'revision' ->> 'id')::uuid;
  revision_version := (editor -> 'revision' ->> 'version')::bigint;

  perform private.submit_studio_revision(
    owner_user_id,
    studio_id,
    revision_id,
    revision_version,
    (
      'b0b00000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid,
    (
      'b0c00000-0000-4000-8000-'
      || pg_catalog.lpad(fixture_suffix::text, 12, '0')
    )::uuid
  );

  return pg_catalog.jsonb_build_object(
    'mediaId', media_id,
    'revisionId', revision_id,
    'studioId', studio_id,
    'publicationVersion', (
      select studio.publication_version
      from public.studios as studio
      where studio.id = studio_id
    ),
    'previewStoragePath', (
      select media.preview_storage_path
      from public.studio_media as media
      where media.id = media_id
    )
  );
end;
$function$;

create or replace function private.feat030_revisions_are_exact_clones(
  source_revision_id uuid,
  cloned_revision_id uuid
) returns boolean
  language sql stable security definer
  set search_path = ''
as $function$
  select coalesce((
    select clone.revision_number = source.revision_number + 1
      and clone.revision_version = 1
      and clone.status = 'draft'
      and (
        pg_catalog.to_jsonb(source)
          - array['id', 'revision_number', 'revision_version', 'status', 'created_at', 'updated_at']
      ) = (
        pg_catalog.to_jsonb(clone)
          - array['id', 'revision_number', 'revision_version', 'status', 'created_at', 'updated_at']
      )
      and (
        select coalesce(
          pg_catalog.jsonb_agg(relation.tag_id order by relation.tag_id),
          '[]'::jsonb
        )
        from public.studio_revision_tags as relation
        where relation.revision_id = source.id
      ) = (
        select coalesce(
          pg_catalog.jsonb_agg(relation.tag_id order by relation.tag_id),
          '[]'::jsonb
        )
        from public.studio_revision_tags as relation
        where relation.revision_id = clone.id
      )
      and (
        select coalesce(
          pg_catalog.jsonb_agg(relation.amenity_id order by relation.amenity_id),
          '[]'::jsonb
        )
        from public.studio_revision_amenities as relation
        where relation.revision_id = source.id
      ) = (
        select coalesce(
          pg_catalog.jsonb_agg(relation.amenity_id order by relation.amenity_id),
          '[]'::jsonb
        )
        from public.studio_revision_amenities as relation
        where relation.revision_id = clone.id
      )
      and (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'answer', faq.answer,
              'position', faq.position,
              'question', faq.question
            ) order by faq.position
          ),
          '[]'::jsonb
        )
        from public.studio_faqs as faq
        where faq.revision_id = source.id
      ) = (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'answer', faq.answer,
              'position', faq.position,
              'question', faq.question
            ) order by faq.position
          ),
          '[]'::jsonb
        )
        from public.studio_faqs as faq
        where faq.revision_id = clone.id
      )
      and (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'isCover', relation.is_cover,
              'mediaId', relation.media_id,
              'position', relation.position
            ) order by relation.position
          ),
          '[]'::jsonb
        )
        from public.studio_revision_media as relation
        where relation.revision_id = source.id
      ) = (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'isCover', relation.is_cover,
              'mediaId', relation.media_id,
              'position', relation.position
            ) order by relation.position
          ),
          '[]'::jsonb
        )
        from public.studio_revision_media as relation
        where relation.revision_id = clone.id
      )
    from public.studio_revisions as source
    join public.studio_revisions as clone on clone.id = cloned_revision_id
    where source.id = source_revision_id
  ), false);
$function$;

alter function private.feat030_capture_error(text) owner to postgres;
alter function private.feat030_create_user(
  uuid, text, text, text, text, integer, boolean
) owner to postgres;
alter function private.feat030_create_pending_studio(uuid, integer, text) owner to postgres;
alter function private.feat030_revisions_are_exact_clones(uuid, uuid) owner to postgres;

revoke all on function private.feat030_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat030_create_user(uuid, text, text, text, text, integer, boolean)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat030_create_pending_studio(uuid, integer, text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat030_revisions_are_exact_clones(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;

create table if not exists private.feat030_concurrency_fixtures (
  label text primary key,
  reviewer_user_id uuid not null,
  auth_session_id uuid not null,
  studio_id uuid not null,
  revision_id uuid not null,
  publication_version bigint not null
);
alter table private.feat030_concurrency_fixtures owner to postgres;
revoke all on table private.feat030_concurrency_fixtures
  from public, anon, authenticated, service_role, app_dal;

delete from audit.events
where actor_user_id in (
    'a3f00000-0000-4000-8000-000000000001',
    'a3f00000-0000-4000-8000-000000000002',
    'a3f00000-0000-4000-8000-000000000003'
  )
  or target_id in (
    'a3f00000-0000-4000-8000-000000000001',
    'a3f00000-0000-4000-8000-000000000002',
    'a3f00000-0000-4000-8000-000000000003'
  )
  or target_id in (
    select fixture.studio_id
    from private.feat030_concurrency_fixtures as fixture
  );
delete from private.studio_command_requests
where owner_user_id = 'a3f00000-0000-4000-8000-000000000001';
delete from public.studios
where owner_user_id = 'a3f00000-0000-4000-8000-000000000001';
update public.studio_media
set
  status = 'delete_pending',
  delete_requested_at = coalesce(delete_requested_at, pg_catalog.clock_timestamp()),
  cleanup_after = pg_catalog.clock_timestamp()
where uploaded_by = 'a3f00000-0000-4000-8000-000000000001'
  and status in ('pending_upload', 'ready', 'rejected', 'delete_pending');
delete from public.studio_media
where uploaded_by = 'a3f00000-0000-4000-8000-000000000001';
delete from auth.users
where id in (
  'a3f00000-0000-4000-8000-000000000001',
  'a3f00000-0000-4000-8000-000000000002',
  'a3f00000-0000-4000-8000-000000000003'
);
truncate table private.feat030_concurrency_fixtures;

select private.feat030_create_user(
  'a3f00000-0000-4000-8000-000000000001',
  'qa-feat030-concurrency-owner@setlivre.local',
  'Dono concorrência FEAT 030',
  '+5541999993090',
  '73194268031',
  90,
  true
);
select private.feat030_create_user(
  'a3f00000-0000-4000-8000-000000000002',
  'qa-feat030-concurrency-reviewer@setlivre.local',
  'Reviewer concorrência FEAT 030',
  '+5541999993091',
  '84620531707',
  91
);
select private.feat030_create_user(
  'a3f00000-0000-4000-8000-000000000003',
  'qa-feat030-concurrency-reviewer-b@setlivre.local',
  'Reviewer B concorrência FEAT 030',
  '+5541999993092',
  '84620531880',
  92
);
insert into public.platform_roles (user_id, role, granted_by)
values
  ('a3f00000-0000-4000-8000-000000000002', 'reviewer', null),
  ('a3f00000-0000-4000-8000-000000000003', 'reviewer', null);
insert into auth.sessions (id, user_id, created_at, updated_at, aal)
values
  (
    'a4f00000-0000-4000-8000-000000000002',
    'a3f00000-0000-4000-8000-000000000002',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  ),
  (
    'a4f00000-0000-4000-8000-000000000003',
    'a3f00000-0000-4000-8000-000000000003',
    pg_catalog.now(),
    pg_catalog.now(),
    'aal1'
  );
select * from private.open_backoffice_session(
  'a3f00000-0000-4000-8000-000000000002',
  'a4f00000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
select * from private.open_backoffice_session(
  'a3f00000-0000-4000-8000-000000000003',
  'a4f00000-0000-4000-8000-000000000003',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
insert into private.feat030_concurrency_fixtures (
  label,
  reviewer_user_id,
  auth_session_id,
  studio_id,
  revision_id,
  publication_version
)
select
  'approval',
  'a3f00000-0000-4000-8000-000000000002'::uuid,
  'a4f00000-0000-4000-8000-000000000002'::uuid,
  (fixture.payload ->> 'studioId')::uuid,
  (fixture.payload ->> 'revisionId')::uuid,
  (fixture.payload ->> 'publicationVersion')::bigint
from (
  select private.feat030_create_pending_studio(
    'a3f00000-0000-4000-8000-000000000001',
    90,
    'Estúdio concorrência real FEAT 030'
  ) as payload
) as fixture;

insert into private.feat030_concurrency_fixtures (
  label,
  reviewer_user_id,
  auth_session_id,
  studio_id,
  revision_id,
  publication_version
)
select
  'snapshot',
  'a3f00000-0000-4000-8000-000000000002'::uuid,
  'a4f00000-0000-4000-8000-000000000002'::uuid,
  (fixture.payload ->> 'studioId')::uuid,
  (fixture.payload ->> 'revisionId')::uuid,
  (fixture.payload ->> 'publicationVersion')::bigint
from (
  select private.feat030_create_pending_studio(
    'a3f00000-0000-4000-8000-000000000001',
    92,
    'Estúdio snapshot concorrente FEAT 030'
  ) as payload
) as fixture;

begin;

select plan(63);

select has_column(
  'public',
  'studios',
  'disabled_from_status',
  'estado anterior da desativação é persistido explicitamente'
);
select has_table(
  'private',
  'studio_review_transition_fences',
  'transições editoriais possuem fence transacional privada'
);
select is(
  pg_catalog.pg_get_function_result(
    'private.list_backoffice_studio_reviews(uuid,uuid,timestamptz,bigint,uuid,integer)'
      ::pg_catalog.regprocedure
  ),
  'TABLE(disabled_from_status text, has_published boolean, name text, publication_version bigint, review_state text, revision_id uuid, sort_sequence bigint, studio_id uuid, studio_status text, submitted_at timestamp with time zone)',
  'fila expõe as dez colunas nominais na ordem exata do contrato'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as constraint_record
    where constraint_record.conname = 'platform_roles_role_check'
      and pg_catalog.pg_get_constraintdef(constraint_record.oid) like '%reviewer%'
  ),
  'reviewer integra a allowlist canônica de papéis'
);
select is(
  pg_catalog.obj_description(
    'private.platform_roles_for_user(uuid)'::pg_catalog.regprocedure,
    'pg_proc'
  ),
  'Retorna os papéis cumulativos support, reviewer e admin vigentes para um usuário do backoffice.',
  'comentário permanente da função enumera support, reviewer e admin'
);
select ok(
  pg_catalog.has_function_privilege(
    'app_dal',
    'private.list_backoffice_studio_reviews(uuid,uuid,timestamptz,bigint,uuid,integer)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'app_dal',
    'private.get_backoffice_studio_review(uuid,uuid,timestamptz,uuid,boolean)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'app_dal',
    'private.execute_backoffice_studio_command(uuid,uuid,timestamptz,uuid,uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'private.can_sign_backoffice_studio_media(text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'private.can_sign_backoffice_studio_media(text)',
    'EXECUTE'
  ),
  'DAL e policy recebem somente as execuções privadas necessárias'
);
select ok(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        policy.policyname = 'studio_media_select_backoffice_review'
        and policy.permissive = 'PERMISSIVE'
        and policy.roles = array['authenticated'::name]
        and policy.cmd = 'SELECT'
        and pg_catalog.regexp_replace(policy.qual, '[[:space:]]', '', 'g')
          = pg_catalog.regexp_replace(
              '((bucket_id = ''studio-media''::text) AND storage.allow_only_operation(''storage.object.sign_many''::text) AND private.can_sign_backoffice_studio_media(name))',
              '[[:space:]]',
              '',
              'g'
            )
        and policy.with_check is null
      )
    from pg_catalog.pg_policies as policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
  )
    and (
      select routine.prosecdef
        and routine.provolatile = 's'
        and routine.proconfig is not distinct from array['search_path=""']::text[]
        and owner.rolname = 'postgres'
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_roles as owner on owner.oid = routine.proowner
      where routine.oid = 'private.can_sign_backoffice_studio_media(text)'::pg_catalog.regprocedure
    )
    and pg_catalog.to_regprocedure(
      'private.can_read_backoffice_studio_media(uuid,uuid,text)'
    ) is null,
  'manifesto do Storage fixa policy, role, comando, operação e helper security-definer'
);
select ok(
  private.check_readiness('20260903061604'),
  'readiness reconhece a migration e preserva os grants exatos'
);

savepoint storage_policy_widening;
create policy feat030_unexpected_storage_download
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'studio-media');
select ok(
  not private.check_readiness('20260903061604'),
  'readiness falha fechado quando uma policy extra amplia operações do Storage'
);
rollback to savepoint storage_policy_widening;
release savepoint storage_policy_widening;

savepoint storage_helper_grant_widening;
grant execute on function private.can_sign_backoffice_studio_media(text) to anon;
select ok(
  not private.check_readiness('20260903061604'),
  'readiness falha fechado quando o helper autenticado ganha grant adicional'
);
rollback to savepoint storage_helper_grant_widening;
release savepoint storage_helper_grant_widening;

savepoint editorial_table_grant_widening;
grant select on table public.studio_review_events to authenticated;
select ok(
  not private.check_readiness('20260903061604'),
  'readiness falha fechado com grant web de tabela editorial sem acesso direto'
);
rollback to savepoint editorial_table_grant_widening;
release savepoint editorial_table_grant_widening;
select ok(
  private.check_readiness('20260903061604'),
  'readiness volta a verde após rollback do grant editorial de tabela'
);

savepoint editorial_column_grant_widening;
grant select (preview_storage_path) on table public.studio_media to authenticated;
select ok(
  not private.check_readiness('20260903061604'),
  'readiness falha fechado com grant web de coluna privada de mídia'
);
rollback to savepoint editorial_column_grant_widening;
release savepoint editorial_column_grant_widening;
select ok(
  private.check_readiness('20260903061604'),
  'readiness volta a verde após rollback do grant editorial de coluna'
);

savepoint editorial_policy_widening;
create policy feat030_unexpected_studio_review_event_select
  on public.studio_review_events
  for select
  to authenticated
  using (true);
select ok(
  not private.check_readiness('20260903061604'),
  'readiness falha fechado com policy web editorial adicional'
);
rollback to savepoint editorial_policy_widening;
release savepoint editorial_policy_widening;
select ok(
  private.check_readiness('20260903061604'),
  'readiness volta a verde após rollback da policy editorial adicional'
);

select private.feat030_create_user(
  'a3000000-0000-4000-8000-000000000001',
  'qa-feat030-owner@setlivre.local',
  'Dono FEAT 030',
  '+5541999993001',
  '52998224725',
  1,
  true
);
select private.feat030_create_user(
  'a3000000-0000-4000-8000-000000000002',
  'qa-feat030-reviewer@setlivre.local',
  'Reviewer FEAT 030',
  '+5541999993002',
  '11144477735',
  2
);
select private.feat030_create_user(
  'a3000000-0000-4000-8000-000000000003',
  'qa-feat030-support@setlivre.local',
  'Support FEAT 030',
  '+5541999993003',
  '28001238938',
  3
);
select private.feat030_create_user(
  'a3000000-0000-4000-8000-000000000004',
  'qa-feat030-admin@setlivre.local',
  'Admin FEAT 030',
  '+5541999993004',
  '16899535009',
  4
);

insert into public.platform_roles (user_id, role, granted_by)
values
  ('a3000000-0000-4000-8000-000000000002', 'reviewer', null),
  ('a3000000-0000-4000-8000-000000000003', 'support', null),
  ('a3000000-0000-4000-8000-000000000004', 'admin', null);

insert into auth.sessions (id, user_id, created_at, updated_at, aal)
values
  (
    'a4000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000002',
    pg_catalog.now(), pg_catalog.now(), 'aal1'
  ),
  (
    'a4000000-0000-4000-8000-000000000003',
    'a3000000-0000-4000-8000-000000000003',
    pg_catalog.now(), pg_catalog.now(), 'aal1'
  ),
  (
    'a4000000-0000-4000-8000-000000000004',
    'a3000000-0000-4000-8000-000000000004',
    pg_catalog.now(), pg_catalog.now(), 'aal1'
  );

grant app_dal to postgres with inherit false, set true;
set local role app_dal;
select * from private.open_backoffice_session(
  'a3000000-0000-4000-8000-000000000002',
  'a4000000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
select * from private.open_backoffice_session(
  'a3000000-0000-4000-8000-000000000003',
  'a4000000-0000-4000-8000-000000000003',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
select * from private.open_backoffice_session(
  'a3000000-0000-4000-8000-000000000004',
  'a4000000-0000-4000-8000-000000000004',
  pg_catalog.clock_timestamp() + interval '30 minutes'
);
reset role;

select is(
  private.platform_roles_for_user('a3000000-0000-4000-8000-000000000002'),
  array['reviewer']::text[],
  'reviewer abre sessão sem herdar support ou admin'
);
select is(
  private.platform_roles_for_user('a3000000-0000-4000-8000-000000000003'),
  array['support']::text[],
  'support abre sessão sem herdar reviewer'
);
select is(
  private.platform_roles_for_user('a3000000-0000-4000-8000-000000000004'),
  array['admin']::text[],
  'admin permanece um papel explícito e não uma expansão persistida'
);

select pg_catalog.set_config(
  'set_livre.test.f030_approve',
  private.feat030_create_pending_studio(
    'a3000000-0000-4000-8000-000000000001',
    1,
    'Estúdio aprovação FEAT 030'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_keyset_oldest',
  private.feat030_create_pending_studio(
    'a3000000-0000-4000-8000-000000000001',
    10,
    'Estúdio paginação antiga FEAT 030'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_keyset_middle',
  private.feat030_create_pending_studio(
    'a3000000-0000-4000-8000-000000000001',
    11,
    'Estúdio paginação intermediária FEAT 030'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_keyset_newest',
  private.feat030_create_pending_studio(
    'a3000000-0000-4000-8000-000000000001',
    12,
    'Estúdio paginação recente FEAT 030'
  )::text,
  true
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_reviewer_queue',
  (
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(listed))::text
    from private.list_backoffice_studio_reviews(
      'a3000000-0000-4000-8000-000000000002',
      'a4000000-0000-4000-8000-000000000002',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      null, null, 51
    ) as listed
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_keyset_page_one',
  coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(listed)
      order by listed.sort_sequence desc, listed.studio_id desc
    )
    from private.list_backoffice_studio_reviews(
      'a3000000-0000-4000-8000-000000000002',
      'a4000000-0000-4000-8000-000000000002',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      null,
      null,
      2
    ) as listed
  ), '[]'::jsonb)::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_keyset_page_two',
  coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(listed)
      order by listed.sort_sequence desc, listed.studio_id desc
    )
    from private.list_backoffice_studio_reviews(
      'a3000000-0000-4000-8000-000000000002',
      'a4000000-0000-4000-8000-000000000002',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      (
        pg_catalog.current_setting('set_livre.test.f030_keyset_page_one')::jsonb
          -> 1 ->> 'sort_sequence'
      )::bigint,
      (
        pg_catalog.current_setting('set_livre.test.f030_keyset_page_one')::jsonb
          -> 1 ->> 'studio_id'
      )::uuid,
      2
    ) as listed
  ), '[]'::jsonb)::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_keyset_tie_sequence',
  (
    select listed.sort_sequence::text
    from private.list_backoffice_studio_reviews(
      'a3000000-0000-4000-8000-000000000002',
      'a4000000-0000-4000-8000-000000000002',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      null,
      null,
      51
    ) as listed
    where listed.studio_id = (
      pg_catalog.current_setting('set_livre.test.f030_keyset_newest')::jsonb
        ->> 'studioId'
    )::uuid
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_keyset_tie_break',
  pg_catalog.jsonb_build_object(
    'withMaximumBoundary', (
      select pg_catalog.count(*)
      from private.list_backoffice_studio_reviews(
        'a3000000-0000-4000-8000-000000000002',
        'a4000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        pg_catalog.current_setting('set_livre.test.f030_keyset_tie_sequence')::bigint,
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
        51
      ) as listed
      where listed.studio_id = (
        pg_catalog.current_setting('set_livre.test.f030_keyset_newest')::jsonb
          ->> 'studioId'
      )::uuid
    ),
    'withMinimumBoundary', (
      select pg_catalog.count(*)
      from private.list_backoffice_studio_reviews(
        'a3000000-0000-4000-8000-000000000002',
        'a4000000-0000-4000-8000-000000000002',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        pg_catalog.current_setting('set_livre.test.f030_keyset_tie_sequence')::bigint,
        '00000000-0000-0000-0000-000000000000',
        51
      ) as listed
      where listed.studio_id = (
        pg_catalog.current_setting('set_livre.test.f030_keyset_newest')::jsonb
          ->> 'studioId'
      )::uuid
    )
  )::text,
  true
);
reset role;
update private.backoffice_sessions as session_binding
set last_seen_at = session_binding.opened_at
where session_binding.auth_session_id = 'a4000000-0000-4000-8000-000000000002';
select pg_catalog.set_config(
  'set_livre.test.f030_passive_last_seen',
  (
    select session_binding.last_seen_at::text
    from private.backoffice_sessions as session_binding
    where session_binding.auth_session_id = 'a4000000-0000-4000-8000-000000000002'
  ),
  true
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_reviewer_detail',
  private.get_backoffice_studio_review(
    'a3000000-0000-4000-8000-000000000002',
    'a4000000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb
        ->> 'studioId'
    )::uuid,
    false
  )::text,
  true
);
reset role;
select is(
  (
    select session_binding.last_seen_at
    from private.backoffice_sessions as session_binding
    where session_binding.auth_session_id = 'a4000000-0000-4000-8000-000000000002'
  ),
  pg_catalog.current_setting('set_livre.test.f030_passive_last_seen')::timestamptz,
  'polling passivo do detalhe revalida a sessão sem renovar a inatividade'
);

create temporary table feat030_keyset_pages (
  page_number integer not null,
  page_position bigint not null,
  sort_sequence bigint not null,
  studio_id uuid not null,
  primary key (page_number, page_position)
) on commit drop;

insert into feat030_keyset_pages (page_number, page_position, sort_sequence, studio_id)
select
  page.page_number,
  item.position,
  (item.value ->> 'sort_sequence')::bigint,
  (item.value ->> 'studio_id')::uuid
from (
  values
    (1, pg_catalog.current_setting('set_livre.test.f030_keyset_page_one')::jsonb),
    (2, pg_catalog.current_setting('set_livre.test.f030_keyset_page_two')::jsonb)
) as page(page_number, payload)
cross join lateral pg_catalog.jsonb_array_elements(page.payload)
  with ordinality as item(value, position);

select is(
  array[
    (select pg_catalog.count(*) from feat030_keyset_pages where page_number = 1),
    (select pg_catalog.count(*) from feat030_keyset_pages where page_number = 2)
  ],
  array[2::bigint, 2::bigint],
  'fila keyset entrega páginas pequenas usando cursor sequence e studio_id não nulos'
);

with ordered as (
  select
    page.sort_sequence,
    page.studio_id,
    pg_catalog.lag(page.sort_sequence) over (
      order by page.page_number, page.page_position
    ) as previous_sequence,
    pg_catalog.lag(page.studio_id) over (
      order by page.page_number, page.page_position
    ) as previous_studio_id
  from feat030_keyset_pages as page
)
select ok(
  not exists (
    select 1
    from ordered
    where ordered.previous_sequence is not null
      and (ordered.previous_sequence, ordered.previous_studio_id)
        <= (ordered.sort_sequence, ordered.studio_id)
  ),
  'ordem keyset permanece estritamente decrescente entre as páginas'
);

select ok(
  (
    select pg_catalog.count(*) = pg_catalog.count(distinct page.studio_id)
    from feat030_keyset_pages as page
  )
  and (
    select pg_catalog.count(*) = 3
    from feat030_keyset_pages as page
    where page.studio_id in (
      (
        pg_catalog.current_setting('set_livre.test.f030_keyset_oldest')::jsonb
          ->> 'studioId'
      )::uuid,
      (
        pg_catalog.current_setting('set_livre.test.f030_keyset_middle')::jsonb
          ->> 'studioId'
      )::uuid,
      (
        pg_catalog.current_setting('set_livre.test.f030_keyset_newest')::jsonb
          ->> 'studioId'
      )::uuid
    )
  ),
  'round-trip do cursor não repete itens e alcança os três fixtures consecutivos'
);

select is(
  pg_catalog.current_setting('set_livre.test.f030_keyset_tie_break')::jsonb,
  '{"withMaximumBoundary":1,"withMinimumBoundary":0}'::jsonb,
  'studio_id decide o desempate quando a sequência do cursor é igual à do item'
);

select ok(
  pg_catalog.current_setting('set_livre.test.f030_reviewer_queue')::jsonb
    @> pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'studio_id',
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId',
        'revision_id',
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId',
        'review_state',
        'reviewPending'
      )
    ),
  'reviewer recebe a candidata pendente pela fila keyset privada'
);
select ok(
  pg_catalog.current_setting('set_livre.test.f030_reviewer_detail')::jsonb
    @> '{"reviewState":"reviewPending","canApprove":true,"canReject":true,"canDisable":false,"canRestore":false}'::jsonb
  and pg_catalog.current_setting('set_livre.test.f030_reviewer_detail')::jsonb
    #>> '{candidateRevision,id}'
      = pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId'
  and not (
    pg_catalog.current_setting('set_livre.test.f030_reviewer_detail')::jsonb ? 'pricing'
  ),
  'detalhe deriva ações editoriais e não antecipa preços da FEAT-016'
);
select is(
  array[
    private.feat030_capture_error(
      $command$
        select * from private.list_backoffice_studio_reviews(
          'a3000000-0000-4000-8000-000000000003',
          'a4000000-0000-4000-8000-000000000003',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          null, null, 51
        )
      $command$
    ),
    private.feat030_capture_error(
      pg_catalog.format(
        $command$
          select private.get_backoffice_studio_review(
            'a3000000-0000-4000-8000-000000000003',
            'a4000000-0000-4000-8000-000000000003',
            pg_catalog.clock_timestamp() + interval '30 minutes',
            %L::uuid
          )
        $command$,
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
      )
    )
  ],
  array['42501:backoffice_role_required', '42501:backoffice_role_required'],
  'support não ganha fila nem detalhe editorial'
);
select is(
  array[
    private.feat030_capture_error(
      $command$
        select * from private.list_backoffice_users(
          'a3000000-0000-4000-8000-000000000002',
          'a4000000-0000-4000-8000-000000000002',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          null, null, null, 1
        )
      $command$
    ),
    private.feat030_capture_error(
      $command$
        select private.reveal_backoffice_user_pii(
          'a3000000-0000-4000-8000-000000000002',
          'a4000000-0000-4000-8000-000000000002',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          'a3000000-0000-4000-8000-000000000004',
          'support_case',
          'a5000000-0000-4000-8000-000000000090',
          'a6000000-0000-4000-8000-000000000090'
        )
      $command$
    ),
    private.feat030_capture_error(
      $command$
        select private.set_backoffice_user_status(
          'a3000000-0000-4000-8000-000000000002',
          'a4000000-0000-4000-8000-000000000002',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          'a3000000-0000-4000-8000-000000000004',
          1,
          'backoffice.user.suspend',
          'a5000000-0000-4000-8000-000000000091',
          'a6000000-0000-4000-8000-000000000091'
        )
      $command$
    ),
    private.feat030_capture_error(
      $command$
        select * from private.list_backoffice_taxonomies(
          'a3000000-0000-4000-8000-000000000002',
          'a4000000-0000-4000-8000-000000000002',
          pg_catalog.clock_timestamp() + interval '30 minutes'
        )
      $command$
    )
  ],
  array[
    '42501:backoffice_role_required',
    '42501:backoffice_role_required',
    '42501:backoffice_role_required',
    '42501:backoffice_role_required'
  ],
  'reviewer não ganha diretório, PII, status de usuários ou administração'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_admin_detail',
  private.get_backoffice_studio_review(
    'a3000000-0000-4000-8000-000000000004',
    'a4000000-0000-4000-8000-000000000004',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb
        ->> 'studioId'
    )::uuid
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_admin_detail')::jsonb
    @> '{"reviewState":"reviewPending","canApprove":true,"canReject":true}'::jsonb,
  'admin substitui reviewer deliberadamente no servidor'
);

insert into storage.objects (bucket_id, name, owner)
values (
  'studio-media',
  pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'previewStoragePath',
  'a3000000-0000-4000-8000-000000000001'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'a3000000-0000-4000-8000-000000000002',
  true
);
select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', 'a3000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'session_id', 'a4000000-0000-4000-8000-000000000002'
  )::text,
  true
);
set local role authenticated;
select pg_catalog.set_config('storage.operation', '', true);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_direct',
  (select pg_catalog.count(*)::text from storage.objects where bucket_id = 'studio-media'),
  true
);
select pg_catalog.set_config('storage.operation', 'storage.object.list', true);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_list',
  (select pg_catalog.count(*)::text from storage.objects where bucket_id = 'studio-media'),
  true
);
select pg_catalog.set_config('storage.operation', 'storage.object.get_authenticated', true);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_download',
  (select pg_catalog.count(*)::text from storage.objects where bucket_id = 'studio-media'),
  true
);
select pg_catalog.set_config('storage.operation', 'storage.object.sign', true);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_sign_one',
  (select pg_catalog.count(*)::text from storage.objects where bucket_id = 'studio-media'),
  true
);
select pg_catalog.set_config('storage.operation', 'storage.object.sign_many', true);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_sign_many',
  (select pg_catalog.count(*)::text from storage.objects where bucket_id = 'studio-media'),
  true
);
select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', 'a3000000-0000-4000-8000-000000000002',
    'role', 'authenticated',
    'session_id', 'sessão-inválida'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_invalid_session',
  (select pg_catalog.count(*)::text from storage.objects where bucket_id = 'studio-media'),
  true
);
select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', 'a3000000-0000-4000-8000-000000000001',
    'role', 'authenticated',
    'session_id', 'a4000000-0000-4000-8000-000000000002'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_spoofed_identity',
  (select pg_catalog.count(*)::text from storage.objects where bucket_id = 'studio-media'),
  true
);
reset role;
select is(
  array[
    pg_catalog.current_setting('set_livre.test.f030_storage_direct')::integer,
    pg_catalog.current_setting('set_livre.test.f030_storage_list')::integer,
    pg_catalog.current_setting('set_livre.test.f030_storage_download')::integer,
    pg_catalog.current_setting('set_livre.test.f030_storage_sign_one')::integer,
    pg_catalog.current_setting('set_livre.test.f030_storage_sign_many')::integer,
    pg_catalog.current_setting('set_livre.test.f030_storage_invalid_session')::integer,
    pg_catalog.current_setting('set_livre.test.f030_storage_spoofed_identity')::integer
  ],
  array[0, 0, 0, 0, 1, 0, 0],
  'somente sign_many com uid e session_id autênticos vê a prévia; demais operações veem zero'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'a3000000-0000-4000-8000-000000000003',
  true
);
select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', 'a3000000-0000-4000-8000-000000000003',
    'role', 'authenticated',
    'session_id', 'a4000000-0000-4000-8000-000000000003'
  )::text,
  true
);
set local role authenticated;
select pg_catalog.set_config('storage.operation', 'storage.object.sign_many', true);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_support',
  (select pg_catalog.count(*)::text from storage.objects where bucket_id = 'studio-media'),
  true
);
reset role;
set local role anon;
select pg_catalog.set_config(
  'set_livre.test.f030_storage_anon',
  (select pg_catalog.count(*)::text from storage.objects where bucket_id = 'studio-media'),
  true
);
reset role;
select is(
  array[
    pg_catalog.current_setting('set_livre.test.f030_storage_support')::integer,
    pg_catalog.current_setting('set_livre.test.f030_storage_anon')::integer
  ],
  array[0, 0],
  'mesmo sign_many permanece fechado para suporte e anon'
);
select pg_catalog.set_config('storage.operation', '', true);

select pg_catalog.set_config(
  'set_livre.test.f030_first_reject_fixture',
  private.feat030_create_pending_studio(
    'a3000000-0000-4000-8000-000000000001',
    3,
    'Estúdio primeira rejeição FEAT 030'
  )::text,
  true
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_first_rejected',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000002',
    'a4000000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (
      pg_catalog.current_setting('set_livre.test.f030_first_reject_fixture')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_first_reject_fixture')::jsonb
        ->> 'revisionId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_first_reject_fixture')::jsonb
        ->> 'publicationVersion'
    )::bigint,
    'backoffice.studio.reject',
    'A documentação inicial precisa ser corrigida.',
    'a5000000-0000-4000-8000-000000000020',
    'a6000000-0000-4000-8000-000000000020'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_first_rejected')::jsonb
    @> '{"action":"backoffice.studio.reject","studioStatus":"rejected"}'::jsonb
  and (
    select studio.status = 'rejected'
      and studio.published_revision_id is null
      and studio.draft_revision_id = replacement.id
      and rejected.status = 'rejected'
      and replacement.status = 'draft'
      and private.feat030_revisions_are_exact_clones(rejected.id, replacement.id)
    from public.studios as studio
    join public.studio_revisions as rejected on rejected.id = (
      pg_catalog.current_setting('set_livre.test.f030_first_reject_fixture')::jsonb
        ->> 'revisionId'
    )::uuid
    join public.studio_revisions as replacement on replacement.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f030_first_reject_fixture')::jsonb
        ->> 'studioId'
    )::uuid
  )
    and (
      select pg_catalog.count(*) = 1
      from public.studio_review_events
      where revision_id = (
        pg_catalog.current_setting('set_livre.test.f030_first_reject_fixture')::jsonb
          ->> 'revisionId'
      )::uuid
        and event_type = 'rejected'
    )
    and (
      select pg_catalog.count(*) = 1
      from public.email_outbox
      where revision_id = (
        pg_catalog.current_setting('set_livre.test.f030_first_reject_fixture')::jsonb
          ->> 'revisionId'
      )::uuid
        and template_key = 'studio.review.rejected'
    )
    and (
      select pg_catalog.count(*) = 1
      from audit.events
      where target_id = (
        pg_catalog.current_setting('set_livre.test.f030_first_reject_fixture')::jsonb
          ->> 'studioId'
      )::uuid
        and action = 'backoffice.studio_rejected'
    ),
  'primeira rejeição preserva ausência de publicação e clona integralmente a candidata uma vez'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_approved',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000002',
    'a4000000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId')::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'publicationVersion')::bigint,
    'backoffice.studio.approve',
    null,
    'a5000000-0000-4000-8000-000000000001',
    'a6000000-0000-4000-8000-000000000001'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_approved')::jsonb
    @> '{"action":"backoffice.studio.approve","studioStatus":"published"}'::jsonb
  and (
    select studio.status = 'published'
      and studio.draft_revision_id is null
      and studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId'
      )::uuid
      and revision.status = 'approved'
    from public.studios as studio
    join public.studio_revisions as revision on revision.id = studio.published_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
  ),
  'aprovação troca pointers e status atomicamente'
);
select ok(
  (
    select pg_catalog.count(*) = 1
    from public.studio_review_events
    where studio_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
      and event_type = 'approved'
  )
  and (
    select pg_catalog.count(*) = 1
    from public.email_outbox
    where studio_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
      and template_key = 'studio.review.approved'
  )
  and (
    select pg_catalog.count(*) = 1
    from audit.events
    where target_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
      and action = 'backoffice.studio_approved'
  ),
  'aprovação registra evento, outbox e auditoria uma vez'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_approved_replay',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000002',
    'a4000000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId')::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'publicationVersion')::bigint,
    'backoffice.studio.approve',
    null,
    'a5000000-0000-4000-8000-000000000001',
    'a6000000-0000-4000-8000-000000000099'
  )::text,
  true
);
reset role;
select is(
  pg_catalog.current_setting('set_livre.test.f030_approved_replay')::jsonb,
  pg_catalog.current_setting('set_livre.test.f030_approved')::jsonb,
  'replay da aprovação retorna o resultado autoritativo original'
);
select is(
  private.feat030_capture_error(
    pg_catalog.format(
      $command$
        select private.execute_backoffice_studio_command(
          'a3000000-0000-4000-8000-000000000002',
          'a4000000-0000-4000-8000-000000000002',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          %L::uuid, null, %L::bigint,
          'backoffice.studio.disable', null,
          'a5000000-0000-4000-8000-000000000002',
          'a6000000-0000-4000-8000-000000000002'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f030_approved')::jsonb ->> 'publicationVersion'
    )
  ),
  '42501:backoffice_role_required',
  'reviewer não pode desativar publicação'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_paused',
  private.pause_studio(
    'a3000000-0000-4000-8000-000000000001',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_approved')::jsonb ->> 'publicationVersion')::bigint,
    'a5000000-0000-4000-8000-000000000003',
    'a6000000-0000-4000-8000-000000000003'
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_disabled',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000004',
    'a4000000-0000-4000-8000-000000000004',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    null,
    (pg_catalog.current_setting('set_livre.test.f030_paused')::jsonb ->> 'publicationVersion')::bigint,
    'backoffice.studio.disable',
    null,
    'a5000000-0000-4000-8000-000000000004',
    'a6000000-0000-4000-8000-000000000004'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_disabled')::jsonb
    @> '{"studioStatus":"disabled","disabledFromStatus":"paused"}'::jsonb
  and (
    select status = 'disabled' and disabled_from_status = 'paused'
    from public.studios
    where id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
  ),
  'admin desativa preservando o estado pausado explicitamente'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_admin_queue_disabled',
  (
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(listed))::text
    from private.list_backoffice_studio_reviews(
      'a3000000-0000-4000-8000-000000000004',
      'a4000000-0000-4000-8000-000000000004',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      null, null, 51
    ) as listed
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_reviewer_queue_disabled',
  coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(listed))::text
    from private.list_backoffice_studio_reviews(
      'a3000000-0000-4000-8000-000000000002',
      'a4000000-0000-4000-8000-000000000002',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      null, null, 51
    ) as listed
  ), '[]'),
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_admin_queue_disabled')::jsonb
    @> '[{"review_state":"disabled","disabled_from_status":"paused"}]'::jsonb
  and not (
    pg_catalog.current_setting('set_livre.test.f030_reviewer_queue_disabled')::jsonb
      @> '[{"review_state":"disabled"}]'::jsonb
  ),
  'somente admin encontra a moderação desativada na fila'
);
select is(
  array[
    private.feat030_capture_error(
      pg_catalog.format(
        $command$
          select private.get_backoffice_studio_review(
            'a3000000-0000-4000-8000-000000000002',
            'a4000000-0000-4000-8000-000000000002',
            pg_catalog.clock_timestamp() + interval '30 minutes',
            %L::uuid
          )
        $command$,
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
      )
    ),
    private.feat030_capture_error(
      $command$
        select private.get_backoffice_studio_review(
          'a3000000-0000-4000-8000-000000000002',
          'a4000000-0000-4000-8000-000000000002',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          'aff00000-0000-4000-8000-000000000001'
        )
      $command$
    )
  ],
  array[
    'P0002:backoffice_studio_review_missing',
    'P0002:backoffice_studio_review_missing'
  ],
  'reviewer recebe o mesmo not found para estúdio desativado e inexistente'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_restored',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000004',
    'a4000000-0000-4000-8000-000000000004',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    null,
    (pg_catalog.current_setting('set_livre.test.f030_disabled')::jsonb ->> 'publicationVersion')::bigint,
    'backoffice.studio.restore',
    null,
    'a5000000-0000-4000-8000-000000000005',
    'a6000000-0000-4000-8000-000000000005'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_restored')::jsonb
    @> '{"studioStatus":"paused","disabledFromStatus":null}'::jsonb
  and (
    select status = 'paused' and disabled_from_status is null
    from public.studios
    where id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
  ),
  'restauração recupera exatamente paused sem inferência'
);
select ok(
  (
    select pg_catalog.count(*) = 1
    from audit.events
    where target_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
      and action = 'backoffice.studio_disabled'
  )
  and (
    select pg_catalog.count(*) = 1
    from audit.events
    where target_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
      and action = 'backoffice.studio_restored'
  ),
  'desativação e restauração são auditadas sem duplicidade'
);

select pg_catalog.set_config(
  'set_livre.test.f030_approved_revision_version',
  (
    select revision_version::text
    from public.studio_revisions
    where id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId'
    )::uuid
  ),
  true
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_changes_draft',
  private.update_studio_revision_content(
    'a3000000-0000-4000-8000-000000000001',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId')::uuid,
    pg_catalog.current_setting('set_livre.test.f030_approved_revision_version')::bigint,
    'a5000000-0000-4000-8000-000000000006',
    'a6000000-0000-4000-8000-000000000006',
    'Conteúdo alterado para comprovar a rejeição sem substituir a publicação.',
    'dQw4w9WgXcQ',
    '[{"question":"A publicação antiga permanece?","answer":"Sim."}]'::jsonb
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_private_media_prepare',
  private.prepare_studio_media_upload(
    'a3000000-0000-4000-8000-000000000001',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_changes_draft')::jsonb
        #>> '{revision,id}'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_changes_draft')::jsonb
        #>> '{revision,version}'
    )::bigint,
    'aa500000-0000-4000-8000-000000000006',
    'aa600000-0000-4000-8000-000000000006',
    'image/jpeg',
    101,
    pg_catalog.repeat('b', 64)
  )::text,
  true
);
reset role;
select pg_catalog.set_config(
  'set_livre.test.f030_private_media_finalize',
  private.finalize_studio_media_upload(
    'a3000000-0000-4000-8000-000000000001',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_private_media_prepare')::jsonb
        ->> 'revisionId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_private_media_prepare')::jsonb
        ->> 'revisionVersion'
    )::bigint,
    'ab500000-0000-4000-8000-000000000006',
    'ab600000-0000-4000-8000-000000000006',
    (
      pg_catalog.current_setting('set_livre.test.f030_private_media_prepare')::jsonb
        ->> 'mediaId'
    )::uuid,
    'image/jpeg',
    101,
    1200,
    800,
    pg_catalog.repeat('b', 64)
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_private_media_path',
  (
    select media.preview_storage_path
    from public.studio_media as media
    where media.id = (
      pg_catalog.current_setting('set_livre.test.f030_private_media_prepare')::jsonb
        ->> 'mediaId'
    )::uuid
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_private_draft_revision_version',
  (
    select revision.revision_version::text
    from public.studio_revisions as revision
    where revision.id = (
      pg_catalog.current_setting('set_livre.test.f030_changes_draft')::jsonb
        #>> '{revision,id}'
    )::uuid
  ),
  true
);
insert into storage.objects (bucket_id, name, owner)
values (
  'studio-media',
  pg_catalog.current_setting('set_livre.test.f030_private_media_path'),
  'a3000000-0000-4000-8000-000000000001'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_admin_private_draft_queue',
  coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(listed))::text
    from private.list_backoffice_studio_reviews(
      'a3000000-0000-4000-8000-000000000004',
      'a4000000-0000-4000-8000-000000000004',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      null, null, 51
    ) as listed
    where listed.studio_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
  ), '[]'),
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_reviewer_private_draft_queue',
  coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(listed))::text
    from private.list_backoffice_studio_reviews(
      'a3000000-0000-4000-8000-000000000002',
      'a4000000-0000-4000-8000-000000000002',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      null, null, 51
    ) as listed
    where listed.studio_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
  ), '[]'),
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_admin_private_draft_detail',
  private.get_backoffice_studio_review(
    'a3000000-0000-4000-8000-000000000004',
    'a4000000-0000-4000-8000-000000000004',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_admin_private_draft_queue')::jsonb
    @> pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'revision_id',
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId',
        'review_state',
        'moderation'
      )
    )
  and pg_catalog.current_setting('set_livre.test.f030_admin_private_draft_detail')::jsonb
    #>> '{candidateRevision,id}'
      = pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId'
  and pg_catalog.current_setting('set_livre.test.f030_admin_private_draft_detail')::jsonb
    #>> '{publishedRevision,id}'
      = pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId'
  and pg_catalog.current_setting('set_livre.test.f030_reviewer_private_draft_queue')::jsonb
    = '[]'::jsonb,
  'moderação de estúdio pausado usa somente a publicação e oculta o draft privado'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'a3000000-0000-4000-8000-000000000004',
  true
);
select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.jsonb_build_object(
    'sub', 'a3000000-0000-4000-8000-000000000004',
    'role', 'authenticated',
    'session_id', 'a4000000-0000-4000-8000-000000000004'
  )::text,
  true
);
set local role authenticated;
select pg_catalog.set_config('storage.operation', 'storage.object.sign_many', true);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_published_moderation',
  (
    select pg_catalog.count(*)::text
    from storage.objects
    where bucket_id = 'studio-media'
      and name = (
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb
          ->> 'previewStoragePath'
      )
  ),
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_storage_private_draft',
  (
    select pg_catalog.count(*)::text
    from storage.objects
    where bucket_id = 'studio-media'
      and name = pg_catalog.current_setting('set_livre.test.f030_private_media_path')
  ),
  true
);
reset role;
select is(
  array[
    pg_catalog.current_setting('set_livre.test.f030_storage_published_moderation')::integer,
    pg_catalog.current_setting('set_livre.test.f030_storage_private_draft')::integer
  ],
  array[1, 0],
  'sign_many de moderação autoriza a publicação e nega mídia exclusiva do draft privado'
);
select pg_catalog.set_config('storage.operation', '', true);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_changes_submit',
  private.submit_studio_revision(
    'a3000000-0000-4000-8000-000000000001',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_changes_draft')::jsonb
        -> 'revision' ->> 'id'
    )::uuid,
    pg_catalog.current_setting(
      'set_livre.test.f030_private_draft_revision_version'
    )::bigint,
    'a5000000-0000-4000-8000-000000000007',
    'a6000000-0000-4000-8000-000000000007'
  )::text,
  true
);
reset role;
select ok(
  (
    select studio.status = 'paused'
      and candidate.status = 'pending'
      and studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId'
      )::uuid
    from public.studios as studio
    join public.studio_revisions as candidate on candidate.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
  ),
  'estúdio pausado mantém a publicação ao submeter uma nova candidata'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_rejected',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000002',
    'a4000000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_changes_draft')::jsonb
        -> 'revision' ->> 'id'
    )::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_changes_submit')::jsonb ->> 'publicationVersion')::bigint,
    'backoffice.studio.reject',
    'O endereço precisa ser confirmado.',
    'a5000000-0000-4000-8000-000000000008',
    'a6000000-0000-4000-8000-000000000008'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_rejected')::jsonb
    @> '{"action":"backoffice.studio.reject","studioStatus":"paused"}'::jsonb
  and (
    select studio.published_revision_id = (
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'revisionId'
      )::uuid
      and studio.draft_revision_id is distinct from rejected.id
      and rejected.status = 'rejected'
      and replacement.status = 'draft'
    from public.studios as studio
    join public.studio_revisions as rejected on rejected.id = (
      pg_catalog.current_setting('set_livre.test.f030_changes_draft')::jsonb
        -> 'revision' ->> 'id'
    )::uuid
    join public.studio_revisions as replacement on replacement.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
  ),
  'rejeição preserva published e cria nova draft sem reabrir a candidata imutável'
);
select ok(
  (
    select private.feat030_revisions_are_exact_clones(rejected.id, replacement.id)
    from public.studios as studio
    join public.studio_revisions as rejected on rejected.id = (
      pg_catalog.current_setting('set_livre.test.f030_changes_draft')::jsonb
        -> 'revision' ->> 'id'
    )::uuid
    join public.studio_revisions as replacement on replacement.id = studio.draft_revision_id
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
  ),
  'nova draft clona exatamente todos os campos, taxonomias, FAQ, mídia, posição e capa'
);
select ok(
  (
    select pg_catalog.count(*) = 1
    from public.studio_review_events
    where studio_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
      and event_type = 'rejected'
      and rejection_reason = 'O endereço precisa ser confirmado.'
  )
  and (
    select pg_catalog.count(*) = 1
    from public.email_outbox
    where studio_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
      and template_key = 'studio.review.rejected'
  )
  and (
    select pg_catalog.count(*) = 1
    from audit.events
    where target_id = (
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
    )::uuid
      and action = 'backoffice.studio_rejected'
  ),
  'rejeição registra motivo, outbox e auditoria uma vez'
);

set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_rejected_replay',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000002',
    'a4000000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId')::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_changes_draft')::jsonb
        -> 'revision' ->> 'id'
    )::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_changes_submit')::jsonb ->> 'publicationVersion')::bigint,
    'backoffice.studio.reject',
    'O endereço precisa ser confirmado.',
    'a5000000-0000-4000-8000-000000000008',
    'a6000000-0000-4000-8000-000000000098'
  )::text,
  true
);
reset role;
select is(
  pg_catalog.current_setting('set_livre.test.f030_rejected_replay')::jsonb,
  pg_catalog.current_setting('set_livre.test.f030_rejected')::jsonb,
  'replay da rejeição não duplica a draft nem efeitos laterais'
);
select is(
  array[
    private.feat030_capture_error(
      pg_catalog.format(
        $command$
          select private.execute_backoffice_studio_command(
            'a3000000-0000-4000-8000-000000000002',
            'a4000000-0000-4000-8000-000000000002',
            pg_catalog.clock_timestamp() + interval '30 minutes',
            %L::uuid, %L::uuid, 999999,
            'backoffice.studio.approve', null,
            'a5000000-0000-4000-8000-000000000040',
            'a6000000-0000-4000-8000-000000000040'
          )
        $command$,
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId',
        pg_catalog.current_setting('set_livre.test.f030_rejected')::jsonb ->> 'draftRevisionId'
      )
    ),
    private.feat030_capture_error(
      $command$
        select private.execute_backoffice_studio_command(
          'a3000000-0000-4000-8000-000000000002',
          'a4000000-0000-4000-8000-000000000002',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          'aff00000-0000-4000-8000-000000000040',
          'afe00000-0000-4000-8000-000000000040',
          999999,
          'backoffice.studio.approve', null,
          'a5000000-0000-4000-8000-000000000041',
          'a6000000-0000-4000-8000-000000000041'
        )
      $command$
    )
  ],
  array[
    'P0002:backoffice_studio_review_missing',
    'P0002:backoffice_studio_review_missing'
  ],
  'decisão não distingue draft nunca submetido de estúdio inexistente'
);
select matches(
  private.feat030_capture_error(
    pg_catalog.format(
      $command$
        select private.execute_backoffice_studio_command(
          'a3000000-0000-4000-8000-000000000002',
          'a4000000-0000-4000-8000-000000000002',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          %L::uuid, %L::uuid, 999999,
          'backoffice.studio.approve', null,
          'a5000000-0000-4000-8000-000000000009',
          'a6000000-0000-4000-8000-000000000009'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f030_rejected')::jsonb ->> 'revisionId'
    )
  ),
  '^40001:backoffice_studio_conflict$',
  'fence stale de revisão anteriormente submetida preserva conflito sem mutação parcial'
);
select is(
  array[
    private.feat030_capture_error(
      pg_catalog.format(
        $command$
          select private.execute_backoffice_studio_command(
            'a3000000-0000-4000-8000-000000000004',
            'a4000000-0000-4000-8000-000000000004',
            pg_catalog.clock_timestamp() + interval '30 minutes',
            %L::uuid, null, 999999,
            'backoffice.studio.disable', null,
            'a5000000-0000-4000-8000-000000000042',
            'a6000000-0000-4000-8000-000000000042'
          )
        $command$,
        pg_catalog.current_setting('set_livre.test.f030_first_rejected')::jsonb ->> 'studioId'
      )
    ),
    private.feat030_capture_error(
      $command$
        select private.execute_backoffice_studio_command(
          'a3000000-0000-4000-8000-000000000004',
          'a4000000-0000-4000-8000-000000000004',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          'aff00000-0000-4000-8000-000000000042',
          null,
          999999,
          'backoffice.studio.disable', null,
          'a5000000-0000-4000-8000-000000000043',
          'a6000000-0000-4000-8000-000000000043'
        )
      $command$
    ),
    private.feat030_capture_error(
      pg_catalog.format(
        $command$
          select private.execute_backoffice_studio_command(
            'a3000000-0000-4000-8000-000000000004',
            'a4000000-0000-4000-8000-000000000004',
            pg_catalog.clock_timestamp() + interval '30 minutes',
            %L::uuid, null, 999999,
            'backoffice.studio.disable', null,
            'a5000000-0000-4000-8000-000000000044',
            'a6000000-0000-4000-8000-000000000044'
          )
        $command$,
        pg_catalog.current_setting('set_livre.test.f030_approve')::jsonb ->> 'studioId'
      )
    )
  ],
  array[
    'P0002:backoffice_studio_review_missing',
    'P0002:backoffice_studio_review_missing',
    '40001:backoffice_studio_conflict'
  ],
  'moderação não distingue estúdio nunca publicado e preserva conflito para publicação stale'
);

create extension if not exists dblink with schema extensions;
create temporary table feat030_concurrency_results (
  connection_name text primary key,
  result jsonb,
  error_message text
);
create temporary table feat030_snapshot_concurrency_result (
  read_result jsonb not null,
  decision_result jsonb,
  decision_error text,
  decision_was_blocked boolean not null
);
create temporary table feat030_session_read_concurrency_result (
  first_scope uuid,
  second_scope uuid,
  second_read_completed_while_first_open boolean not null,
  second_read_error text
);

do $block$
declare
  barrier_key bigint := pg_catalog.hashtextextended('feat030:approval:barrier', 0);
  connection_name text;
  connection_string text := pg_catalog.format(
    'host=%s port=%s dbname=%I user=%I password=%s',
    pg_catalog.inet_server_addr(),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    'supabase_admin',
    'postgres'
  );
  query_a text;
  query_b text;
begin
  perform extensions.dblink_connect('feat030_approve_a', connection_string);
  perform extensions.dblink_connect('feat030_approve_b', connection_string);
  perform pg_catalog.pg_advisory_lock(barrier_key);

  query_a := pg_catalog.format(
    $remote$
      with barrier as materialized (
        select pg_catalog.pg_advisory_xact_lock(%s)
      )
      select private.execute_backoffice_studio_command(
        fixture.reviewer_user_id,
        fixture.auth_session_id,
        pg_catalog.clock_timestamp() + interval '30 minutes',
        fixture.studio_id,
        fixture.revision_id,
        fixture.publication_version,
        'backoffice.studio.approve',
        null,
        'a5f00000-0000-4000-8000-000000000001',
        'a6f00000-0000-4000-8000-000000000001'
      )
      from private.feat030_concurrency_fixtures as fixture
      cross join barrier
      where fixture.label = 'approval'
    $remote$,
    barrier_key
  );
  query_b := pg_catalog.format(
    $remote$
      with barrier as materialized (
        select pg_catalog.pg_advisory_xact_lock(%s)
      )
      select private.execute_backoffice_studio_command(
        'a3f00000-0000-4000-8000-000000000003',
        'a4f00000-0000-4000-8000-000000000003',
        pg_catalog.clock_timestamp() + interval '30 minutes',
        fixture.studio_id,
        fixture.revision_id,
        fixture.publication_version,
        'backoffice.studio.approve',
        null,
        'a5f00000-0000-4000-8000-000000000002',
        'a6f00000-0000-4000-8000-000000000002'
      )
      from private.feat030_concurrency_fixtures as fixture
      cross join barrier
      where fixture.label = 'approval'
    $remote$,
    barrier_key
  );

  perform extensions.dblink_send_query('feat030_approve_a', query_a);
  perform extensions.dblink_send_query('feat030_approve_b', query_b);
  if extensions.dblink_is_busy('feat030_approve_a') <> 1
    or extensions.dblink_is_busy('feat030_approve_b') <> 1
  then
    raise exception using errcode = '23514', message = 'feat030_concurrency_not_dispatched';
  end if;
  perform pg_catalog.pg_advisory_unlock(barrier_key);

  foreach connection_name in array array['feat030_approve_a', 'feat030_approve_b']
  loop
    begin
      insert into feat030_concurrency_results (connection_name, result)
      select connection_name, remote_result.result
      from extensions.dblink_get_result(connection_name) as remote_result(result jsonb);
      perform remote_result.result
      from extensions.dblink_get_result(connection_name) as remote_result(result jsonb);
    exception
      when others then
        insert into feat030_concurrency_results (connection_name, error_message)
        values (connection_name, sqlstate || ':' || sqlerrm);
    end;
    perform extensions.dblink_disconnect(connection_name);
  end loop;
end;
$block$;

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.count(*) filter (
        where result is not null and error_message is null
      ) = 1
      and pg_catalog.count(*) filter (
        where result is null
          and error_message = '40001:backoffice_studio_conflict'
      ) = 1
    from feat030_concurrency_results
  )
    and (
      select studio.status = 'published'
        and studio.published_revision_id = fixture.revision_id
        and studio.draft_revision_id is null
      from private.feat030_concurrency_fixtures as fixture
      join public.studios as studio on studio.id = fixture.studio_id
      where fixture.label = 'approval'
    )
    and (
      select pg_catalog.count(*) = 1
      from private.feat030_concurrency_fixtures as fixture
      join public.studio_review_events as event
        on event.studio_id = fixture.studio_id
        and event.revision_id = fixture.revision_id
      where fixture.label = 'approval'
        and event.event_type = 'approved'
    )
    and (
      select pg_catalog.count(*) = 1
      from private.feat030_concurrency_fixtures as fixture
      join public.email_outbox as message
        on message.studio_id = fixture.studio_id
        and message.revision_id = fixture.revision_id
      where fixture.label = 'approval'
        and message.template_key = 'studio.review.approved'
    )
    and (
      select pg_catalog.count(*) = 1
      from private.feat030_concurrency_fixtures as fixture
      join audit.events as event on event.target_id = fixture.studio_id
      where fixture.label = 'approval'
        and event.action = 'backoffice.studio_approved'
    )
    and (
      select pg_catalog.count(*) = 1
      from private.feat030_concurrency_fixtures as fixture
      join private.backoffice_command_requests as request
        on request.target_id = fixture.studio_id
      where fixture.label = 'approval'
        and request.action = 'backoffice.studio.approve'
        and request.actor_user_id in (
          'a3f00000-0000-4000-8000-000000000002',
          'a3f00000-0000-4000-8000-000000000003'
        )
        and request.result_hash is not null
    )
    and not exists (
      select 1
      from private.studio_review_transition_fences as fence
      join private.feat030_concurrency_fixtures as fixture
        on fixture.studio_id = fence.studio_id
      where fixture.label = 'approval'
    ),
  'duas decisões realmente despachadas produzem um sucesso, um conflito e um único efeito terminal'
);

do $block$
declare
  attempt integer;
  connection_string text := pg_catalog.format(
    'host=%s port=%s dbname=%I user=%I password=%s',
    pg_catalog.inet_server_addr(),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    'supabase_admin',
    'postgres'
  );
  decision_backend_pid integer;
  decision_error text;
  decision_query text;
  decision_result jsonb;
  decision_was_blocked boolean := false;
  read_result jsonb;
begin
  perform extensions.dblink_connect('feat030_snapshot_read', connection_string);
  perform extensions.dblink_connect('feat030_snapshot_decide', connection_string);

  select remote_backend.pid
  into strict decision_backend_pid
  from extensions.dblink(
    'feat030_snapshot_decide',
    'select pg_catalog.pg_backend_pid()'
  ) as remote_backend(pid integer);

  perform extensions.dblink_exec('feat030_snapshot_read', 'begin');
  select remote_read.result
  into strict read_result
  from extensions.dblink(
    'feat030_snapshot_read',
    $remote$
      select private.get_backoffice_studio_review(
        fixture.reviewer_user_id,
        fixture.auth_session_id,
        pg_catalog.clock_timestamp() + interval '30 minutes',
        fixture.studio_id
      )
      from private.feat030_concurrency_fixtures as fixture
      where fixture.label = 'snapshot'
    $remote$
  ) as remote_read(result jsonb);

  decision_query := $remote$
    select private.execute_backoffice_studio_command(
      'a3f00000-0000-4000-8000-000000000003',
      'a4f00000-0000-4000-8000-000000000003',
      pg_catalog.clock_timestamp() + interval '30 minutes',
      fixture.studio_id,
      fixture.revision_id,
      fixture.publication_version,
      'backoffice.studio.approve',
      null,
      'a5f00000-0000-4000-8000-000000000003',
      'a6f00000-0000-4000-8000-000000000003'
    )
    from private.feat030_concurrency_fixtures as fixture
    where fixture.label = 'snapshot'
  $remote$;
  perform extensions.dblink_send_query('feat030_snapshot_decide', decision_query);
  if extensions.dblink_is_busy('feat030_snapshot_decide') <> 1 then
    raise exception using errcode = '23514', message = 'feat030_snapshot_decision_not_dispatched';
  end if;

  for attempt in 1..100 loop
    select coalesce(
      (
        select activity.wait_event_type = 'Lock'
        from pg_catalog.pg_stat_activity as activity
        where activity.pid = decision_backend_pid
      ),
      false
    )
    into decision_was_blocked;
    exit when decision_was_blocked;
    perform pg_catalog.pg_sleep(0.01);
  end loop;

  perform extensions.dblink_exec('feat030_snapshot_read', 'commit');
  begin
    select remote_decision.result
    into decision_result
    from extensions.dblink_get_result(
      'feat030_snapshot_decide'
    ) as remote_decision(result jsonb);
    perform remote_decision.result
    from extensions.dblink_get_result(
      'feat030_snapshot_decide'
    ) as remote_decision(result jsonb);
  exception
    when others then
      decision_error := sqlstate || ':' || sqlerrm;
  end;

  insert into feat030_snapshot_concurrency_result (
    read_result,
    decision_result,
    decision_error,
    decision_was_blocked
  )
  values (
    read_result,
    decision_result,
    decision_error,
    decision_was_blocked
  );

  perform extensions.dblink_disconnect('feat030_snapshot_read');
  perform extensions.dblink_disconnect('feat030_snapshot_decide');
end;
$block$;

select ok(
  snapshot.decision_was_blocked
    and snapshot.decision_error is null
    and snapshot.read_result @> '{"reviewState":"reviewPending","studioStatus":"pending_review"}'::jsonb
    and snapshot.read_result #>> '{candidateRevision,id}' = fixture.revision_id::text
    and snapshot.decision_result @> '{"action":"backoffice.studio.approve","studioStatus":"published"}'::jsonb
    and studio.status = 'published'
    and studio.published_revision_id = fixture.revision_id
    and studio.draft_revision_id is null,
  'GET mantém snapshot anterior consistente e decisão concorrente espera o lock studio -> revisions'
)
from feat030_snapshot_concurrency_result as snapshot
cross join private.feat030_concurrency_fixtures as fixture
join public.studios as studio on studio.id = fixture.studio_id
where fixture.label = 'snapshot';

do $block$
declare
  attempt integer;
  connection_string text := pg_catalog.format(
    'host=%s port=%s dbname=%I user=%I password=%s',
    pg_catalog.inet_server_addr(),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    'supabase_admin',
    'postgres'
  );
  first_scope uuid;
  second_read_completed_while_first_open boolean := false;
  second_read_error text;
  second_scope uuid;
begin
  perform extensions.dblink_connect('feat030_session_read_a', connection_string);
  perform extensions.dblink_connect('feat030_session_read_b', connection_string);
  perform extensions.dblink_exec('feat030_session_read_a', 'begin');

  select remote_read.scope
  into strict first_scope
  from extensions.dblink(
    'feat030_session_read_a',
    $remote$
      select session.scope
      from private.feat030_concurrency_fixtures as fixture
      cross join lateral private.get_backoffice_session(
        fixture.reviewer_user_id,
        fixture.auth_session_id,
        pg_catalog.clock_timestamp() + interval '30 minutes'
      ) as session
      where fixture.label = 'snapshot'
    $remote$
  ) as remote_read(scope uuid);

  perform extensions.dblink_send_query(
    'feat030_session_read_b',
    $remote$
      select session.scope
      from private.feat030_concurrency_fixtures as fixture
      cross join lateral private.get_backoffice_session(
        fixture.reviewer_user_id,
        fixture.auth_session_id,
        pg_catalog.clock_timestamp() + interval '30 minutes'
      ) as session
      where fixture.label = 'snapshot'
    $remote$
  );

  for attempt in 1..100 loop
    second_read_completed_while_first_open :=
      extensions.dblink_is_busy('feat030_session_read_b') = 0;
    exit when second_read_completed_while_first_open;
    perform pg_catalog.pg_sleep(0.01);
  end loop;

  perform extensions.dblink_exec('feat030_session_read_a', 'commit');
  begin
    select remote_read.scope
    into strict second_scope
    from extensions.dblink_get_result(
      'feat030_session_read_b'
    ) as remote_read(scope uuid);
    perform remote_read.scope
    from extensions.dblink_get_result(
      'feat030_session_read_b'
    ) as remote_read(scope uuid);
  exception
    when others then
      second_read_error := sqlstate || ':' || sqlerrm;
  end;

  insert into feat030_session_read_concurrency_result (
    first_scope,
    second_scope,
    second_read_completed_while_first_open,
    second_read_error
  )
  values (
    first_scope,
    second_scope,
    second_read_completed_while_first_open,
    second_read_error
  );

  perform extensions.dblink_disconnect('feat030_session_read_a');
  perform extensions.dblink_disconnect('feat030_session_read_b');
end;
$block$;

select ok(
  result.second_read_completed_while_first_open
    and result.second_read_error is null
    and result.first_scope = result.second_scope
    and result.first_scope = fixture.reviewer_user_id,
  'duas leituras de sessão do mesmo operador não se serializam em lock exclusivo'
)
from feat030_session_read_concurrency_result as result
cross join private.feat030_concurrency_fixtures as fixture
where fixture.label = 'snapshot';

select pg_catalog.set_config(
  'set_livre.test.f030_admin_fixture',
  private.feat030_create_pending_studio(
    'a3000000-0000-4000-8000-000000000001',
    2,
    'Estúdio aprovação administrativa FEAT 030'
  )::text,
  true
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_admin_approved',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000004',
    'a4000000-0000-4000-8000-000000000004',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb ->> 'studioId')::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb ->> 'revisionId')::uuid,
    (pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb ->> 'publicationVersion')::bigint,
    'backoffice.studio.approve',
    null,
    'a5000000-0000-4000-8000-000000000010',
    'a6000000-0000-4000-8000-000000000010'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_admin_approved')::jsonb
    @> '{"studioStatus":"published","action":"backoffice.studio.approve"}'::jsonb,
  'admin também pode decidir uma candidata como substituto deliberado'
);

select pg_catalog.set_config(
  'set_livre.test.f030_admin_approved_revision_version',
  (
    select revision.revision_version::text
    from public.studio_revisions as revision
    where revision.id = (
      pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb
        ->> 'revisionId'
    )::uuid
  ),
  true
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_admin_changes_draft',
  private.update_studio_revision_content(
    'a3000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb
        ->> 'revisionId'
    )::uuid,
    pg_catalog.current_setting('set_livre.test.f030_admin_approved_revision_version')::bigint,
    'a5000000-0000-4000-8000-000000000030',
    'a6000000-0000-4000-8000-000000000030',
    'Alteração submetida para provar restauração integral de changes_pending.',
    'dQw4w9WgXcQ',
    '[{"question":"Os dois ponteiros permanecem?","answer":"Sim."}]'::jsonb
  )::text,
  true
);
select pg_catalog.set_config(
  'set_livre.test.f030_admin_changes_submit',
  private.submit_studio_revision(
    'a3000000-0000-4000-8000-000000000001',
    (
      pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb
        ->> 'studioId'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_admin_changes_draft')::jsonb
        #>> '{revision,id}'
    )::uuid,
    (
      pg_catalog.current_setting('set_livre.test.f030_admin_changes_draft')::jsonb
        #>> '{revision,version}'
    )::bigint,
    'a5000000-0000-4000-8000-000000000031',
    'a6000000-0000-4000-8000-000000000031'
  )::text,
  true
);
reset role;
select pg_catalog.set_config(
  'set_livre.test.f030_changes_pending_pointers',
  (
    select pg_catalog.jsonb_build_object(
      'draftRevisionId', studio.draft_revision_id,
      'publishedRevisionId', studio.published_revision_id
    )::text
    from public.studios as studio
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb
        ->> 'studioId'
    )::uuid
      and studio.status = 'changes_pending'
  ),
  true
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_changes_pending_disabled',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000004',
    'a4000000-0000-4000-8000-000000000004',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (
      pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb
        ->> 'studioId'
    )::uuid,
    null,
    (
      pg_catalog.current_setting('set_livre.test.f030_admin_changes_submit')::jsonb
        ->> 'publicationVersion'
    )::bigint,
    'backoffice.studio.disable',
    null,
    'a5000000-0000-4000-8000-000000000032',
    'a6000000-0000-4000-8000-000000000032'
  )::text,
  true
);
reset role;
select pg_catalog.set_config(
  'set_livre.test.f030_changes_pending_disabled_pointers',
  (
    select pg_catalog.jsonb_build_object(
      'draftRevisionId', studio.draft_revision_id,
      'publishedRevisionId', studio.published_revision_id
    )::text
    from public.studios as studio
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb
        ->> 'studioId'
    )::uuid
      and studio.status = 'disabled'
      and studio.disabled_from_status = 'changes_pending'
  ),
  true
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_changes_pending_restored',
  private.execute_backoffice_studio_command(
    'a3000000-0000-4000-8000-000000000004',
    'a4000000-0000-4000-8000-000000000004',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    (
      pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb
        ->> 'studioId'
    )::uuid,
    null,
    (
      pg_catalog.current_setting('set_livre.test.f030_changes_pending_disabled')::jsonb
        ->> 'publicationVersion'
    )::bigint,
    'backoffice.studio.restore',
    null,
    'a5000000-0000-4000-8000-000000000033',
    'a6000000-0000-4000-8000-000000000033'
  )::text,
  true
);
reset role;
select ok(
  pg_catalog.current_setting('set_livre.test.f030_changes_pending_disabled')::jsonb
    @> '{"studioStatus":"disabled","disabledFromStatus":"changes_pending"}'::jsonb
  and pg_catalog.current_setting('set_livre.test.f030_changes_pending_restored')::jsonb
    @> '{"studioStatus":"changes_pending","disabledFromStatus":null}'::jsonb
  and pg_catalog.current_setting('set_livre.test.f030_changes_pending_disabled_pointers')::jsonb
    = pg_catalog.current_setting('set_livre.test.f030_changes_pending_pointers')::jsonb
  and (
    select studio.status = 'changes_pending'
      and studio.disabled_from_status is null
      and pg_catalog.jsonb_build_object(
        'draftRevisionId', studio.draft_revision_id,
        'publishedRevisionId', studio.published_revision_id
      ) = pg_catalog.current_setting(
        'set_livre.test.f030_changes_pending_pointers'
      )::jsonb
    from public.studios as studio
    where studio.id = (
      pg_catalog.current_setting('set_livre.test.f030_admin_fixture')::jsonb
        ->> 'studioId'
    )::uuid
  ),
  'disable e restore de changes_pending preservam exatamente draft e publicação'
);

select pg_catalog.set_config(
  'set_livre.test.f030_support_account_version',
  (
    select account_version::text
    from public.profiles
    where id = 'a3000000-0000-4000-8000-000000000003'
  ),
  true
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_role_granted',
  private.set_backoffice_user_role(
    'a3000000-0000-4000-8000-000000000004',
    'a4000000-0000-4000-8000-000000000004',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    'a3000000-0000-4000-8000-000000000003',
    pg_catalog.current_setting('set_livre.test.f030_support_account_version')::bigint,
    'backoffice.access.grantReviewer',
    'a5000000-0000-4000-8000-000000000011',
    'a6000000-0000-4000-8000-000000000011'
  )::text,
  true
);
reset role;
select pg_catalog.set_config(
  'set_livre.test.f030_support_account_version_after_grant',
  (
    select account_version::text
    from public.profiles
    where id = 'a3000000-0000-4000-8000-000000000003'
  ),
  true
);
select ok(
  exists (
    select 1
    from public.platform_roles
    where user_id = 'a3000000-0000-4000-8000-000000000003'
      and role = 'reviewer'
  ),
  'admin concede reviewer pela fachada atômica canônica'
);
set local role app_dal;
select pg_catalog.set_config(
  'set_livre.test.f030_role_revoked',
  private.set_backoffice_user_role(
    'a3000000-0000-4000-8000-000000000004',
    'a4000000-0000-4000-8000-000000000004',
    pg_catalog.clock_timestamp() + interval '30 minutes',
    'a3000000-0000-4000-8000-000000000003',
    pg_catalog.current_setting(
      'set_livre.test.f030_support_account_version_after_grant'
    )::bigint,
    'backoffice.access.revokeReviewer',
    'a5000000-0000-4000-8000-000000000012',
    'a6000000-0000-4000-8000-000000000012'
  )::text,
  true
);
reset role;
select ok(
  not exists (
    select 1
    from public.platform_roles
    where user_id = 'a3000000-0000-4000-8000-000000000003'
      and role = 'reviewer'
  )
  and exists (
    select 1
    from public.platform_roles
    where user_id = 'a3000000-0000-4000-8000-000000000003'
      and role = 'support'
  ),
  'revogar reviewer preserva o papel support independente'
);

select pg_catalog.set_config(
  'set_livre.test.f030_archived_taxonomy',
  private.feat030_create_pending_studio(
    'a3f00000-0000-4000-8000-000000000001',
    93,
    'Estúdio taxonomia arquivada FEAT 030'
  )::text,
  false
);
update public.tags
set active = false
where id = '62000000-0000-4000-8000-000000000001';
select pg_catalog.set_config(
  'set_livre.test.f030_archived_taxonomy_error',
  private.feat030_capture_error(
    pg_catalog.format(
      $command$
        select private.execute_backoffice_studio_command(
          'a3000000-0000-4000-8000-000000000004',
          'a4000000-0000-4000-8000-000000000004',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          %L::uuid,
          %L::uuid,
          %s,
          'backoffice.studio.approve',
          null,
          'a5000000-0000-4000-8000-000000000045',
          'a6000000-0000-4000-8000-000000000045'
        )
      $command$,
      pg_catalog.current_setting('set_livre.test.f030_archived_taxonomy')::jsonb ->> 'studioId',
      pg_catalog.current_setting('set_livre.test.f030_archived_taxonomy')::jsonb ->> 'revisionId',
      pg_catalog.current_setting('set_livre.test.f030_archived_taxonomy')::jsonb
        ->> 'publicationVersion'
    )
  ),
  false
);
select ok(
  pg_catalog.current_setting('set_livre.test.f030_archived_taxonomy_error')
    = '23514:studio_submission_incomplete'
    and exists (
      select 1
      from public.studios as studio
      where studio.id = (
          pg_catalog.current_setting('set_livre.test.f030_archived_taxonomy')::jsonb
            ->> 'studioId'
        )::uuid
        and studio.status = 'pending_review'
        and studio.draft_revision_id = (
          pg_catalog.current_setting('set_livre.test.f030_archived_taxonomy')::jsonb
            ->> 'revisionId'
        )::uuid
        and studio.published_revision_id is null
    )
    and (
      select not (detail.payload ->> 'canApprove')::boolean
        and (detail.payload ->> 'canReject')::boolean
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(detail.payload -> 'checklist') as item(value)
          where item.value ->> 'key' = 'content'
            and not (item.value ->> 'complete')::boolean
        )
      from (
        select private.get_backoffice_studio_review(
          'a3000000-0000-4000-8000-000000000004',
          'a4000000-0000-4000-8000-000000000004',
          pg_catalog.clock_timestamp() + interval '30 minutes',
          (
            pg_catalog.current_setting('set_livre.test.f030_archived_taxonomy')::jsonb
              ->> 'studioId'
          )::uuid
        ) as payload
      ) as detail
    )
    and not exists (
      select 1
      from private.backoffice_command_requests as request
      where request.actor_user_id = 'a3000000-0000-4000-8000-000000000004'
        and request.idempotency_key = 'a5000000-0000-4000-8000-000000000045'
    )
    and not exists (
      select 1
      from private.studio_review_transition_fences as fence
      where fence.studio_id = (
        pg_catalog.current_setting('set_livre.test.f030_archived_taxonomy')::jsonb
          ->> 'studioId'
      )::uuid
    ),
  'aprovação relê o checklist sob locks e falha sem efeito quando taxonomia arquiva após submissão'
);
update public.tags
set active = true
where id = '62000000-0000-4000-8000-000000000001';

select ok(
  not exists (select 1 from private.studio_review_transition_fences),
  'nenhuma fence transacional permanece após os comandos'
);
select ok(
  not exists (
    select 1
    from audit.events
    where action like 'backoffice.studio_%'
      and metadata::text like '%@setlivre.local%'
  ),
  'auditoria editorial não persiste PII'
);
select ok(
  not pg_catalog.has_table_privilege(
    'app_dal',
    'private.studio_review_transition_fences',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'private.studio_review_transition_fences',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'fences continuam inacessíveis às roles de runtime'
);

reset role;
revoke app_dal from postgres granted by current_user;

select ok(
  private.check_readiness('20260903061604'),
  'readiness final permanece verde após os cenários completos'
);

select * from finish();
rollback;

delete from audit.events
where actor_user_id in (
    'a3f00000-0000-4000-8000-000000000001',
    'a3f00000-0000-4000-8000-000000000002',
    'a3f00000-0000-4000-8000-000000000003'
  )
  or target_id in (
    'a3f00000-0000-4000-8000-000000000001',
    'a3f00000-0000-4000-8000-000000000002',
    'a3f00000-0000-4000-8000-000000000003'
  )
  or target_id in (
    select fixture.studio_id
    from private.feat030_concurrency_fixtures as fixture
  );
delete from private.studio_command_requests
where owner_user_id = 'a3f00000-0000-4000-8000-000000000001';
delete from public.studios
where owner_user_id = 'a3f00000-0000-4000-8000-000000000001';
update public.studio_media
set
  status = 'delete_pending',
  delete_requested_at = coalesce(delete_requested_at, pg_catalog.clock_timestamp()),
  cleanup_after = pg_catalog.clock_timestamp()
where uploaded_by = 'a3f00000-0000-4000-8000-000000000001'
  and status in ('pending_upload', 'ready', 'rejected', 'delete_pending');
delete from public.studio_media
where uploaded_by = 'a3f00000-0000-4000-8000-000000000001';
delete from auth.users
where id in (
  'a3f00000-0000-4000-8000-000000000001',
  'a3f00000-0000-4000-8000-000000000002',
  'a3f00000-0000-4000-8000-000000000003'
);
drop table if exists private.feat030_concurrency_fixtures;
drop function if exists private.feat030_revisions_are_exact_clones(uuid, uuid);
drop function if exists private.feat030_create_pending_studio(uuid, integer, text);
drop function if exists private.feat030_create_user(
  uuid, text, text, text, text, integer, boolean
);
drop function if exists private.feat030_capture_error(text);
