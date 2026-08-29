-- FEAT-007: taxonomias ativas, conteúdo plain text e clonagem integral da revisão.

begin;

create function private.feat007_capture_error(command text)
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

create function private.feat007_create_owner(
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
      '72000000-0000-4000-8000-'
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
    'Dono QA FEAT 007',
    '+5541999999700',
    tax_id,
    null
  );

  perform private.activate_owner(
    user_id,
    '00000000-0000-4000-8000-000000000204',
    (
      '73000000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
    (
      '74000000-0000-4000-8000-'
      || pg_catalog.lpad(request_suffix::text, 12, '0')
    )::uuid,
    null
  );
end;
$function$;

revoke all on function private.feat007_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat007_create_owner(uuid, text, text, integer)
  from public, anon, authenticated, service_role, app_dal;

select plan(42);

select has_table('public', 'tags', 'tags existe');
select has_table('public', 'amenities', 'amenities existe');
select has_table('public', 'studio_revision_tags', 'relação de tags existe');
select has_table('public', 'studio_revision_amenities', 'relação de comodidades existe');
select has_table('public', 'studio_faqs', 'FAQ versionada existe');

select is((select pg_catalog.count(*)::integer from public.tags where active), 8, 'oito tags ativas são seedadas');
select is((select pg_catalog.count(*)::integer from public.amenities where active), 8, 'oito comodidades ativas são seedadas');

select policies_are(
  'public',
  'tags',
  array['tags_select_active_or_referenced_own'],
  'tags expõe itens ativos e preserva referências históricas do próprio dono'
);
select policies_are(
  'public',
  'amenities',
  array['amenities_select_active_or_referenced_own'],
  'comodidades expõem itens ativos e preservam referências históricas do próprio dono'
);
select policies_are(
  'public',
  'studio_revision_tags',
  array['studio_revision_tags_select_own'],
  'tags da revisão usam ownership'
);
select policies_are(
  'public',
  'studio_revision_amenities',
  array['studio_revision_amenities_select_own'],
  'comodidades da revisão usam ownership'
);
select policies_are(
  'public',
  'studio_faqs',
  array['studio_faqs_select_own'],
  'FAQ usa ownership'
);

select ok(
  pg_catalog.has_function_privilege(
    'app_dal',
    'private.update_studio_revision_taxonomy(uuid,uuid,uuid,bigint,uuid,uuid,uuid[],uuid[])',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'app_dal',
    'private.update_studio_revision_content(uuid,uuid,uuid,bigint,uuid,uuid,text,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'private.studio_editor_json(uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'private.studio_editor_json(uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'app_dal',
    'private.studio_editor_json(uuid,uuid)',
    'EXECUTE'
  )
  and not exists (
    select 1
    from (
      values ('anon'::name), ('authenticated'::name), ('service_role'::name)
    ) as forbidden_role(role_name)
    cross join (
      values
        ('private.update_studio_revision_taxonomy(uuid,uuid,uuid,bigint,uuid,uuid,uuid[],uuid[])'),
        ('private.update_studio_revision_content(uuid,uuid,uuid,bigint,uuid,uuid,text,text,jsonb)'),
        ('private.studio_editor_json(uuid,uuid)')
    ) as private_routine(signature)
    where pg_catalog.has_function_privilege(
      forbidden_role.role_name,
      private_routine.signature,
      'EXECUTE'
    )
  ),
  'app_dal executa somente comandos autorizados e nenhum runtime invoca helpers privados'
);
select ok(
  not exists (
    select 1
    from (
      values ('anon'::name), ('service_role'::name), ('app_dal'::name)
    ) as forbidden_role(role_name)
    cross join (
      values
        ('public.tags'),
        ('public.amenities'),
        ('public.studio_revision_tags'),
        ('public.studio_revision_amenities'),
        ('public.studio_faqs')
    ) as private_table(table_name)
    where pg_catalog.has_table_privilege(
      forbidden_role.role_name,
      private_table.table_name,
      'SELECT'
    )
  ),
  'anon, service_role e app_dal continuam sem leitura direta das tabelas'
);

select private.feat007_create_owner(
  '71000000-0000-4000-8000-000000000001',
  'qa-feat007-owner-a@setlivre.local',
  '52998224725',
  1
);
select private.feat007_create_owner(
  '71000000-0000-4000-8000-000000000002',
  'qa-feat007-owner-b@setlivre.local',
  '11144477735',
  2
);

insert into public.tags (id, slug, name, active, sort_order)
values ('62000000-0000-4000-8000-000000000099', 'inativa-qa', 'Inativa QA', false, 999);
insert into public.amenities (id, slug, name, active, sort_order)
values ('63000000-0000-4000-8000-000000000099', 'inativa-qa', 'Inativa QA', false, 999);

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

with editor as (
  select private.create_studio(
    '71000000-0000-4000-8000-000000000001',
    '75000000-0000-4000-8000-000000000001',
    '76000000-0000-4000-8000-000000000001',
    'Estúdio Conteúdo Seguro',
    'Estúdio preparado para comprovar taxonomias e conteúdo versionado com segurança.',
    'Rua das Araucárias',
    '700',
    null,
    'Centro',
    'Curitiba',
    'PR',
    '80010000',
    15,
    '60000000-0000-4000-8000-000000000001'
  ) as value
)
select
  pg_catalog.set_config('set_livre.test.f007_studio', value ->> 'studioId', true),
  pg_catalog.set_config('set_livre.test.f007_revision', value #>> '{revision,id}', true)
from editor;

select private.update_studio_revision_taxonomy(
  '71000000-0000-4000-8000-000000000001',
  pg_catalog.current_setting('set_livre.test.f007_studio')::uuid,
  pg_catalog.current_setting('set_livre.test.f007_revision')::uuid,
  1,
  '75000000-0000-4000-8000-000000000002',
  '76000000-0000-4000-8000-000000000002',
  array[
    '62000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000002'
  ]::uuid[],
  array[
    '63000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000002'
  ]::uuid[]
);

reset role;
revoke app_dal from postgres granted by current_user;

create extension if not exists dblink with schema extensions;
select extensions.dblink_connect(
  'feat007_taxonomy_archive',
  pg_catalog.format(
    'host=%s port=%s dbname=%I user=%I password=%s',
    pg_catalog.inet_server_addr(),
    pg_catalog.inet_server_port(),
    pg_catalog.current_database(),
    'supabase_admin',
    'postgres'
  )
);
select extensions.dblink_exec(
  'feat007_taxonomy_archive',
  'set lock_timeout = ''250ms'''
);
select matches(
  private.feat007_capture_error(
    $command$
      select extensions.dblink_exec(
        'feat007_taxonomy_archive',
        'update public.tags set active = false where id = ''62000000-0000-4000-8000-000000000001'''
      )
    $command$
  ),
  '^55P03:canceling statement due to lock timeout$',
  'comando mantém lock compartilhado e impede arquivamento concorrente da tag selecionada'
);
select matches(
  private.feat007_capture_error(
    $command$
      select extensions.dblink_exec(
        'feat007_taxonomy_archive',
        'update public.amenities set active = false where id = ''63000000-0000-4000-8000-000000000001'''
      )
    $command$
  ),
  '^55P03:canceling statement due to lock timeout$',
  'comando mantém lock compartilhado e impede arquivamento concorrente da comodidade selecionada'
);
select extensions.dblink_disconnect('feat007_taxonomy_archive');

select ok(
  (select pg_catalog.count(*) from public.studio_revision_tags
    where revision_id = pg_catalog.current_setting('set_livre.test.f007_revision')::uuid) = 2
  and (select pg_catalog.count(*) from public.studio_revision_amenities
    where revision_id = pg_catalog.current_setting('set_livre.test.f007_revision')::uuid) = 2
  and (select revision_version from public.studio_revisions
    where id = pg_catalog.current_setting('set_livre.test.f007_revision')::uuid) = 2,
  'comando de taxonomia substitui conjuntos e incrementa o token uma vez'
);

update public.tags set active = false where id = '62000000-0000-4000-8000-000000000001';
update public.amenities set active = false where id = '63000000-0000-4000-8000-000000000001';

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '71000000-0000-4000-8000-000000000001',
  true
);
select ok(
  exists (
    select 1
    from public.tags as tag
    where tag.id = '62000000-0000-4000-8000-000000000001'
      and not tag.active
  )
  and exists (
    select 1
    from public.amenities as amenity
    where amenity.id = '63000000-0000-4000-8000-000000000001'
      and not amenity.active
  ),
  'dono preserva taxonomias arquivadas já referenciadas pela própria revisão'
);
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '71000000-0000-4000-8000-000000000002',
  true
);
select ok(
  not exists (
    select 1
    from public.tags as tag
    where tag.id = '62000000-0000-4000-8000-000000000001'
  )
  and not exists (
    select 1
    from public.amenities as amenity
    where amenity.id = '63000000-0000-4000-8000-000000000001'
  ),
  'outro dono não lê taxonomias arquivadas referenciadas por revisão alheia'
);
reset role;

select matches(
  private.feat007_capture_error(pg_catalog.format(
    $command$
      select private.update_studio_revision_taxonomy(
        '71000000-0000-4000-8000-000000000001', %L, %L, 1,
        '75000000-0000-4000-8000-000000000002',
        '76000000-0000-4000-8000-000000000098',
        array[
          '62000000-0000-4000-8000-000000000001',
          '62000000-0000-4000-8000-000000000002'
        ]::uuid[],
        array[
          '63000000-0000-4000-8000-000000000001',
          '63000000-0000-4000-8000-000000000002'
        ]::uuid[]
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f007_studio'),
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^40001:studio_taxonomy_result_stale$',
  'replay falha fechado se arquivamento posterior impede reconstruir o resultado exato'
);

update public.tags set active = true where id = '62000000-0000-4000-8000-000000000001';
update public.amenities set active = true where id = '63000000-0000-4000-8000-000000000001';

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select private.update_studio_revision_content(
  '71000000-0000-4000-8000-000000000001',
  pg_catalog.current_setting('set_livre.test.f007_studio')::uuid,
  pg_catalog.current_setting('set_livre.test.f007_revision')::uuid,
  2,
  '75000000-0000-4000-8000-000000000003',
  '76000000-0000-4000-8000-000000000003',
  'Não executar <script>window.__feat007 = true</script>; o conteúdo é plain text.',
  'dQw4w9WgXcQ',
  '[{"question":"Primeira pergunta?","answer":"Primeira resposta."},{"question":"Segunda pergunta?","answer":"Segunda resposta."}]'::jsonb
);

select private.update_studio_revision_content(
  '71000000-0000-4000-8000-000000000001',
  pg_catalog.current_setting('set_livre.test.f007_studio')::uuid,
  pg_catalog.current_setting('set_livre.test.f007_revision')::uuid,
  2,
  '75000000-0000-4000-8000-000000000003',
  '76000000-0000-4000-8000-000000000099',
  'Não executar <script>window.__feat007 = true</script>; o conteúdo é plain text.',
  'dQw4w9WgXcQ',
  '[{"question":"Primeira pergunta?","answer":"Primeira resposta."},{"question":"Segunda pergunta?","answer":"Segunda resposta."}]'::jsonb
);

reset role;
revoke app_dal from postgres granted by current_user;

select ok(
  (select revision_version = 3
      and youtube_video_id = 'dQw4w9WgXcQ'
      and usage_rules like '%<script>%'
    from public.studio_revisions
    where id = pg_catalog.current_setting('set_livre.test.f007_revision')::uuid),
  'conteúdo é persistido como texto e incrementa a revisão'
);
select results_eq(
  $query$
    select faq.question
    from public.studio_faqs as faq
    where faq.revision_id = pg_catalog.current_setting('set_livre.test.f007_revision')::uuid
    order by faq.position
  $query$,
  $values$ values ('Primeira pergunta?'::text), ('Segunda pergunta?'::text) $values$,
  'FAQ preserva a ordem autoritativa'
);
select ok(
  (select pg_catalog.count(*) from private.studio_command_requests
    where owner_user_id = '71000000-0000-4000-8000-000000000001'
      and idempotency_key = '75000000-0000-4000-8000-000000000003') = 1
  and (select pg_catalog.count(*) from audit.events
    where actor_user_id = '71000000-0000-4000-8000-000000000001'
      and idempotency_key = '75000000-0000-4000-8000-000000000003') = 1,
  'replay idempotente não duplica efeito nem auditoria'
);

select matches(
  private.feat007_capture_error(pg_catalog.format(
    $command$
      select private.update_studio_revision_taxonomy(
        '71000000-0000-4000-8000-000000000001', %L, %L, 1,
        '75000000-0000-4000-8000-000000000002',
        '76000000-0000-4000-8000-000000000097',
        array[
          '62000000-0000-4000-8000-000000000001',
          '62000000-0000-4000-8000-000000000002'
        ]::uuid[],
        array[
          '63000000-0000-4000-8000-000000000001',
          '63000000-0000-4000-8000-000000000002'
        ]::uuid[]
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f007_studio'),
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^40001:studio_taxonomy_result_stale$',
  'replay de taxonomia falha fechado se conteúdo posterior impede reconstruir o resultado exato'
);

select matches(
  private.feat007_capture_error(pg_catalog.format(
    $command$
      select private.update_studio_revision_taxonomy(
        '71000000-0000-4000-8000-000000000001', %L, %L, 3,
        '75000000-0000-4000-8000-000000000004',
        '76000000-0000-4000-8000-000000000004',
        array['62000000-0000-4000-8000-000000000099']::uuid[], array[]::uuid[]
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f007_studio'),
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^23514:studio_taxonomy_inactive$',
  'tag inativa é rejeitada pelo comando'
);
select matches(
  private.feat007_capture_error(pg_catalog.format(
    $command$
      select private.update_studio_revision_taxonomy(
        '71000000-0000-4000-8000-000000000001', %L, %L, 3,
        '75000000-0000-4000-8000-000000000005',
        '76000000-0000-4000-8000-000000000005',
        array[]::uuid[], array['63000000-0000-4000-8000-000000000098']::uuid[]
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f007_studio'),
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^23514:studio_taxonomy_inactive$',
  'comodidade externa é rejeitada pelo comando'
);
select matches(
  private.feat007_capture_error(pg_catalog.format(
    $command$
      select private.update_studio_revision_content(
        '71000000-0000-4000-8000-000000000001', %L, %L, 3,
        '75000000-0000-4000-8000-000000000006',
        '76000000-0000-4000-8000-000000000006', '', 'video-invalido', '[]'::jsonb
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f007_studio'),
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^22023:invalid_studio_content$',
  'ID de YouTube inválido falha fechado'
);
select matches(
  private.feat007_capture_error(pg_catalog.format(
    $command$
      select private.update_studio_revision_content(
        '71000000-0000-4000-8000-000000000001', %L, %L, 3,
        '75000000-0000-4000-8000-000000000007',
        '76000000-0000-4000-8000-000000000007', '', null,
        (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('question', 'Q' || n, 'answer', 'A'))
         from pg_catalog.generate_series(1, 21) as n)
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f007_studio'),
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^22023:invalid_studio_content$',
  'mais de vinte FAQs é rejeitado'
);
select matches(
  private.feat007_capture_error(pg_catalog.format(
    $command$
      select private.update_studio_revision_taxonomy(
        '71000000-0000-4000-8000-000000000001', %L, %L, 2,
        '75000000-0000-4000-8000-000000000008',
        '76000000-0000-4000-8000-000000000008', array[]::uuid[], array[]::uuid[]
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f007_studio'),
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^40001:studio_revision_conflict$',
  'token otimista vencido não sobrescreve conteúdo'
);
select matches(
  private.feat007_capture_error(pg_catalog.format(
    $command$
      select private.update_studio_revision_taxonomy(
        '71000000-0000-4000-8000-000000000002', %L, %L, 3,
        '75000000-0000-4000-8000-000000000009',
        '76000000-0000-4000-8000-000000000009', array[]::uuid[], array[]::uuid[]
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f007_studio'),
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^P0002:studio_not_found$',
  'outro dono não altera nem confirma a existência do estúdio'
);

update public.studio_revisions as revision
set
  status = 'approved',
  revision_version = revision.revision_version + 1
where revision.id = pg_catalog.current_setting('set_livre.test.f007_revision')::uuid;

update public.studios as studio
set
  status = 'published',
  published_revision_id = pg_catalog.current_setting('set_livre.test.f007_revision')::uuid,
  draft_revision_id = null
where studio.id = pg_catalog.current_setting('set_livre.test.f007_studio')::uuid;

grant app_dal to postgres with inherit false, set true;
set local role app_dal;

select pg_catalog.set_config(
  'set_livre.test.f007_clone',
  private.update_studio_revision_taxonomy(
    '71000000-0000-4000-8000-000000000001',
    pg_catalog.current_setting('set_livre.test.f007_studio')::uuid,
    pg_catalog.current_setting('set_livre.test.f007_revision')::uuid,
    4,
    '75000000-0000-4000-8000-000000000010',
    '76000000-0000-4000-8000-000000000010',
    array['62000000-0000-4000-8000-000000000003']::uuid[],
    array[
      '63000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000007'
    ]::uuid[]
  ) #>> '{revision,id}',
  true
);

reset role;
revoke app_dal from postgres granted by current_user;

select ok(
  pg_catalog.current_setting('set_livre.test.f007_clone')::uuid
    <> pg_catalog.current_setting('set_livre.test.f007_revision')::uuid
  and (select usage_rules like '%<script>%' and youtube_video_id = 'dQw4w9WgXcQ'
    from public.studio_revisions
    where id = pg_catalog.current_setting('set_livre.test.f007_clone')::uuid)
  and (select pg_catalog.count(*) = 2 from public.studio_faqs
    where revision_id = pg_catalog.current_setting('set_livre.test.f007_clone')::uuid),
  'editar publicação clona conteúdo e FAQ sem mutar a revisão aprovada'
);
select ok(
  (select pg_catalog.count(*) = 1 from public.studio_revision_tags
    where revision_id = pg_catalog.current_setting('set_livre.test.f007_clone')::uuid)
  and (select pg_catalog.count(*) = 2 from public.studio_revision_tags
    where revision_id = pg_catalog.current_setting('set_livre.test.f007_revision')::uuid),
  'a nova seleção fica na draft e a taxonomia publicada permanece intacta'
);
select matches(
  private.feat007_capture_error(pg_catalog.format(
    $command$
      select private.update_studio_revision_content(
        '71000000-0000-4000-8000-000000000001', %L, %L, 2,
        '75000000-0000-4000-8000-000000000003',
        '76000000-0000-4000-8000-000000000096',
        'Não executar <script>window.__feat007 = true</script>; o conteúdo é plain text.',
        'dQw4w9WgXcQ',
        '[{"question":"Primeira pergunta?","answer":"Primeira resposta."},{"question":"Segunda pergunta?","answer":"Segunda resposta."}]'::jsonb
      )
    $command$,
    pg_catalog.current_setting('set_livre.test.f007_studio'),
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^40001:studio_content_result_stale$',
  'replay de conteúdo falha fechado se draft posterior impede reconstruir o resultado exato'
);
select matches(
  private.feat007_capture_error(pg_catalog.format(
    'delete from public.studio_revision_tags where revision_id = %L',
    pg_catalog.current_setting('set_livre.test.f007_revision')
  )),
  '^23514:studio_revision_relation_immutable$',
  'relações de revisão aprovada são imutáveis'
);
select is(
  array[
    private.feat007_capture_error(pg_catalog.format(
      'insert into public.studio_revision_tags (revision_id, tag_id) values (%L, %L)',
      pg_catalog.current_setting('set_livre.test.f007_revision'),
      '62000000-0000-4000-8000-000000000003'
    )),
    private.feat007_capture_error(pg_catalog.format(
      'update public.studio_revision_tags set tag_id = %L where revision_id = %L and tag_id = %L',
      '62000000-0000-4000-8000-000000000003',
      pg_catalog.current_setting('set_livre.test.f007_revision'),
      '62000000-0000-4000-8000-000000000001'
    )),
    private.feat007_capture_error(pg_catalog.format(
      'delete from public.studio_revision_tags where revision_id = %L',
      pg_catalog.current_setting('set_livre.test.f007_revision')
    )),
    private.feat007_capture_error(pg_catalog.format(
      'insert into public.studio_revision_amenities (revision_id, amenity_id) values (%L, %L)',
      pg_catalog.current_setting('set_livre.test.f007_revision'),
      '63000000-0000-4000-8000-000000000003'
    )),
    private.feat007_capture_error(pg_catalog.format(
      'update public.studio_revision_amenities set amenity_id = %L where revision_id = %L and amenity_id = %L',
      '63000000-0000-4000-8000-000000000003',
      pg_catalog.current_setting('set_livre.test.f007_revision'),
      '63000000-0000-4000-8000-000000000001'
    )),
    private.feat007_capture_error(pg_catalog.format(
      'delete from public.studio_revision_amenities where revision_id = %L',
      pg_catalog.current_setting('set_livre.test.f007_revision')
    )),
    private.feat007_capture_error(pg_catalog.format(
      'insert into public.studio_faqs (revision_id, question, answer, position) values (%L, %L, %L, 3)',
      pg_catalog.current_setting('set_livre.test.f007_revision'),
      'Pergunta bloqueada?',
      'Resposta bloqueada.'
    )),
    private.feat007_capture_error(pg_catalog.format(
      'update public.studio_faqs set answer = %L where revision_id = %L and position = 1',
      'Resposta alterada.',
      pg_catalog.current_setting('set_livre.test.f007_revision')
    )),
    private.feat007_capture_error(pg_catalog.format(
      'delete from public.studio_faqs where revision_id = %L and position = 1',
      pg_catalog.current_setting('set_livre.test.f007_revision')
    ))
  ],
  pg_catalog.array_fill('23514:studio_revision_relation_immutable'::text, array[9]),
  'insert, update e delete falham fechado nas três relações de revisão aprovada'
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '71000000-0000-4000-8000-000000000001',
  true
);
select is(
  (select pg_catalog.count(*)::integer
    from public.get_owner_studio_editor(
      pg_catalog.current_setting('set_livre.test.f007_studio')::uuid
    )),
  1,
  'dono lê o próprio editor estendido'
);
select ok(
  (select pg_catalog.count(*) > 0 from public.studio_revision_tags)
    and (select pg_catalog.count(*) > 0 from public.studio_revision_amenities)
    and (select pg_catalog.count(*) > 0 from public.studio_faqs),
  'RLS permite ao dono consultar diretamente somente relações das próprias revisões'
);
select ok(
  not (public.list_active_studio_taxonomies() -> 'tags') @>
      '[{"id":"62000000-0000-4000-8000-000000000099"}]'::jsonb
    and not (public.list_active_studio_taxonomies() -> 'amenities') @>
      '[{"id":"63000000-0000-4000-8000-000000000099"}]'::jsonb,
  'read model não expõe taxonomias inativas'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '71000000-0000-4000-8000-000000000002',
  true
);
select is(
  (select pg_catalog.count(*)::integer
    from public.get_owner_studio_editor(
      pg_catalog.current_setting('set_livre.test.f007_studio')::uuid
    )),
  0,
  'outro dono não lê o editor estendido'
);
select ok(
  (select pg_catalog.count(*) = 0 from public.studio_revision_tags)
    and (select pg_catalog.count(*) = 0 from public.studio_revision_amenities)
    and (select pg_catalog.count(*) = 0 from public.studio_faqs),
  'RLS impede outro dono de consultar diretamente relações e FAQ alheias'
);
reset role;

select ok(
  not exists (
    select 1
    from audit.events as event
    where event.actor_user_id = '71000000-0000-4000-8000-000000000001'
      and event.action in (
        'studio.revision_taxonomy_updated',
        'studio.revision_content_updated'
      )
      and (
        event.metadata::text like '%Primeira pergunta%'
        or event.metadata::text like '%<script>%'
      )
  ),
  'auditoria registra contagens sem conteúdo privado'
);
select ok(private.check_readiness('20260829124200'), 'readiness inclui a migration e a allowlist atuais');

select * from finish();
rollback;
