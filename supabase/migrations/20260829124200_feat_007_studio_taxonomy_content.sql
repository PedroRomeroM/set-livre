alter table private.studio_command_requests
  drop constraint studio_command_requests_action_check,
  add constraint studio_command_requests_action_check check (
    action = any (array[
      'studio.create'::text,
      'studio.revision.updateCore'::text,
      'studio.revision.updateTaxonomy'::text,
      'studio.revision.updateContent'::text,
      'studio.draft.discard'::text
    ])
  );

alter table audit.events drop constraint events_action_check;
alter table audit.events add constraint events_action_check check (
  action = any (array[
    'owner.activated'::text,
    'owner.contract_renewed'::text,
    'recipient.status_transitioned'::text,
    'studio.created'::text,
    'studio.revision_updated'::text,
    'studio.revision_taxonomy_updated'::text,
    'studio.revision_content_updated'::text,
    'studio.draft_discarded'::text
  ])
);

alter table public.studio_revisions
  add column usage_rules text not null default '',
  add column youtube_video_id text,
  add constraint studio_revisions_usage_rules_check check (
    usage_rules = pg_catalog.btrim(usage_rules)
    and pg_catalog.char_length(usage_rules) <= 5000
  ),
  add constraint studio_revisions_youtube_video_id_check check (
    youtube_video_id is null or youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
  );

create table public.tags (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique,
  name text not null,
  active boolean not null default true,
  sort_order smallint not null default 0,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint tags_slug_check check (
    slug = pg_catalog.btrim(slug)
    and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    and pg_catalog.char_length(slug) between 2 and 80
  ),
  constraint tags_name_check check (
    name = pg_catalog.btrim(name)
    and pg_catalog.char_length(name) between 2 and 80
  ),
  constraint tags_sort_order_check check (sort_order >= 0),
  constraint tags_timestamps_check check (updated_at >= created_at)
);

create table public.amenities (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique,
  name text not null,
  active boolean not null default true,
  sort_order smallint not null default 0,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint amenities_slug_check check (
    slug = pg_catalog.btrim(slug)
    and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    and pg_catalog.char_length(slug) between 2 and 80
  ),
  constraint amenities_name_check check (
    name = pg_catalog.btrim(name)
    and pg_catalog.char_length(name) between 2 and 80
  ),
  constraint amenities_sort_order_check check (sort_order >= 0),
  constraint amenities_timestamps_check check (updated_at >= created_at)
);

insert into public.tags (id, slug, name, sort_order)
values
  ('62000000-0000-4000-8000-000000000001', 'podcast', 'Podcast', 10),
  ('62000000-0000-4000-8000-000000000002', 'fotografia', 'Fotografia', 20),
  ('62000000-0000-4000-8000-000000000003', 'video', 'Vídeo', 30),
  ('62000000-0000-4000-8000-000000000004', 'live-streaming', 'Live streaming', 40),
  ('62000000-0000-4000-8000-000000000005', 'entrevista', 'Entrevista', 50),
  ('62000000-0000-4000-8000-000000000006', 'ensaio', 'Ensaio', 60),
  ('62000000-0000-4000-8000-000000000007', 'produto', 'Produto', 70),
  ('62000000-0000-4000-8000-000000000008', 'musica', 'Música', 80);

insert into public.amenities (id, slug, name, sort_order)
values
  ('63000000-0000-4000-8000-000000000001', 'wi-fi', 'Wi-Fi', 10),
  ('63000000-0000-4000-8000-000000000002', 'ar-condicionado', 'Ar-condicionado', 20),
  ('63000000-0000-4000-8000-000000000003', 'estacionamento', 'Estacionamento', 30),
  ('63000000-0000-4000-8000-000000000004', 'camarim', 'Camarim', 40),
  ('63000000-0000-4000-8000-000000000005', 'banheiro-privativo', 'Banheiro privativo', 50),
  ('63000000-0000-4000-8000-000000000006', 'acessibilidade', 'Acessibilidade', 60),
  ('63000000-0000-4000-8000-000000000007', 'copa', 'Copa', 70),
  ('63000000-0000-4000-8000-000000000008', 'isolamento-acustico', 'Isolamento acústico', 80);

create table public.studio_revision_tags (
  revision_id uuid not null references public.studio_revisions (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete restrict,
  primary key (revision_id, tag_id)
);

create table public.studio_revision_amenities (
  revision_id uuid not null references public.studio_revisions (id) on delete cascade,
  amenity_id uuid not null references public.amenities (id) on delete restrict,
  primary key (revision_id, amenity_id)
);

create table public.studio_faqs (
  id uuid primary key default extensions.gen_random_uuid(),
  revision_id uuid not null references public.studio_revisions (id) on delete cascade,
  question text not null,
  answer text not null,
  position smallint not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint studio_faqs_question_check check (
    question = pg_catalog.btrim(question)
    and pg_catalog.char_length(question) between 1 and 160
  ),
  constraint studio_faqs_answer_check check (
    answer = pg_catalog.btrim(answer)
    and pg_catalog.char_length(answer) between 1 and 2000
  ),
  constraint studio_faqs_position_check check (position between 1 and 20),
  constraint studio_faqs_timestamps_check check (updated_at >= created_at),
  unique (revision_id, position)
);

alter table public.tags owner to postgres;
alter table public.amenities owner to postgres;
alter table public.studio_revision_tags owner to postgres;
alter table public.studio_revision_amenities owner to postgres;
alter table public.studio_faqs owner to postgres;

create index studio_revision_tags_tag_id_idx on public.studio_revision_tags (tag_id);
create index studio_revision_amenities_amenity_id_idx
  on public.studio_revision_amenities (amenity_id);

create trigger tags_set_updated_at
  before update on public.tags
  for each row execute function private.set_studio_updated_at();

create trigger amenities_set_updated_at
  before update on public.amenities
  for each row execute function private.set_studio_updated_at();

create trigger studio_faqs_set_updated_at
  before update on public.studio_faqs
  for each row execute function private.set_studio_updated_at();

create or replace function private.assert_editable_studio_revision_relation() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  new_revision_status text;
  old_revision_status text;
begin
  perform revision.id
  from public.studio_revisions as revision
  where revision.id in (
    case when tg_op in ('UPDATE', 'DELETE') then old.revision_id else null end,
    case when tg_op in ('INSERT', 'UPDATE') then new.revision_id else null end
  )
  order by revision.id
  for share;

  if tg_op in ('UPDATE', 'DELETE') then
    select revision.status
    into old_revision_status
    from public.studio_revisions as revision
    where revision.id = old.revision_id;

    if found and old_revision_status <> 'draft' then
      raise exception using errcode = '23514', message = 'studio_revision_relation_immutable';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select revision.status
    into new_revision_status
    from public.studio_revisions as revision
    where revision.id = new.revision_id;

    if not found or new_revision_status <> 'draft' then
      raise exception using errcode = '23514', message = 'studio_revision_relation_immutable';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

alter function private.assert_editable_studio_revision_relation() owner to postgres;

create trigger studio_revision_tags_require_draft
  before insert or update or delete on public.studio_revision_tags
  for each row execute function private.assert_editable_studio_revision_relation();

create trigger studio_revision_amenities_require_draft
  before insert or update or delete on public.studio_revision_amenities
  for each row execute function private.assert_editable_studio_revision_relation();

create trigger studio_faqs_require_draft
  before insert or update or delete on public.studio_faqs
  for each row execute function private.assert_editable_studio_revision_relation();

create or replace function private.clone_studio_revision_content_before_insert() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  source_revision public.studio_revisions%rowtype;
begin
  if new.status <> 'draft' then
    return new;
  end if;

  select revision.*
  into source_revision
  from public.studios as studio
  join public.studio_revisions as revision on revision.id = studio.published_revision_id
  where studio.id = new.studio_id
    and studio.draft_revision_id is null
    and revision.status = 'approved';

  if found then
    new.usage_rules := source_revision.usage_rules;
    new.youtube_video_id := source_revision.youtube_video_id;
  end if;
  return new;
end;
$function$;

alter function private.clone_studio_revision_content_before_insert() owner to postgres;

create trigger studio_revisions_clone_content
  before insert on public.studio_revisions
  for each row execute function private.clone_studio_revision_content_before_insert();

create or replace function private.clone_studio_revision_relations_after_insert() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  source_revision_id uuid;
begin
  if new.status <> 'draft' then
    return new;
  end if;

  select studio.published_revision_id
  into source_revision_id
  from public.studios as studio
  join public.studio_revisions as revision on revision.id = studio.published_revision_id
  where studio.id = new.studio_id
    and studio.draft_revision_id is null
    and revision.status = 'approved';

  if source_revision_id is null then
    return new;
  end if;

  insert into public.studio_revision_tags (revision_id, tag_id)
  select new.id, relation.tag_id
  from public.studio_revision_tags as relation
  where relation.revision_id = source_revision_id;

  insert into public.studio_revision_amenities (revision_id, amenity_id)
  select new.id, relation.amenity_id
  from public.studio_revision_amenities as relation
  where relation.revision_id = source_revision_id;

  insert into public.studio_faqs (revision_id, question, answer, position)
  select new.id, faq.question, faq.answer, faq.position
  from public.studio_faqs as faq
  where faq.revision_id = source_revision_id
  order by faq.position;

  return new;
end;
$function$;

alter function private.clone_studio_revision_relations_after_insert() owner to postgres;

create trigger studio_revisions_clone_relations
  after insert on public.studio_revisions
  for each row execute function private.clone_studio_revision_relations_after_insert();

create or replace function private.studio_editor_json(
  p_user_id uuid,
  p_studio_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  select pg_catalog.jsonb_build_object(
    'scope', studio.owner_user_id,
    'studioId', studio.id,
    'studioStatus', studio.status,
    'publishedRevisionId', studio.published_revision_id,
    'draftRevisionId', studio.draft_revision_id,
    'hasDraft', studio.draft_revision_id is not null,
    'revision', pg_catalog.jsonb_build_object(
      'id', revision.id,
      'number', revision.revision_number,
      'version', revision.revision_version,
      'status', revision.status,
      'name', revision.name,
      'description', revision.description,
      'street', revision.street,
      'streetNumber', revision.street_number,
      'addressComplement', revision.address_complement,
      'neighborhood', revision.neighborhood,
      'city', revision.city,
      'state', revision.state,
      'postalCode', revision.postal_code,
      'capacity', revision.capacity,
      'studioTypeId', revision.studio_type_id,
      'usageRules', revision.usage_rules,
      'youtubeVideoId', revision.youtube_video_id,
      'tags', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', tag.id,
            'name', tag.name,
            'active', tag.active,
            'sortOrder', tag.sort_order
          ) order by tag.sort_order, tag.name, tag.id
        )
        from public.studio_revision_tags as relation
        join public.tags as tag on tag.id = relation.tag_id
        where relation.revision_id = revision.id
      ), '[]'::jsonb),
      'amenities', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', amenity.id,
            'name', amenity.name,
            'active', amenity.active,
            'sortOrder', amenity.sort_order
          ) order by amenity.sort_order, amenity.name, amenity.id
        )
        from public.studio_revision_amenities as relation
        join public.amenities as amenity on amenity.id = relation.amenity_id
        where relation.revision_id = revision.id
      ), '[]'::jsonb),
      'faqs', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', faq.id,
            'question', faq.question,
            'answer', faq.answer,
            'position', faq.position
          ) order by faq.position
        )
        from public.studio_faqs as faq
        where faq.revision_id = revision.id
      ), '[]'::jsonb)
    ),
    'studioType', pg_catalog.jsonb_build_object(
      'id', studio_type.id,
      'name', studio_type.name
    )
  )
  from public.studios as studio
  join public.studio_revisions as revision
    on revision.id = coalesce(studio.draft_revision_id, studio.published_revision_id)
  join public.studio_types as studio_type on studio_type.id = revision.studio_type_id
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id;
$function$;

alter function private.studio_editor_json(uuid, uuid) owner to postgres;

drop function public.get_owner_studio_editor(uuid);

create function public.get_owner_studio_editor(p_studio_id uuid)
returns table (
  scope uuid,
  studio_id uuid,
  studio_status text,
  published_revision_id uuid,
  draft_revision_id uuid,
  has_draft boolean,
  revision_id uuid,
  revision_status text,
  revision_number bigint,
  revision_version bigint,
  name text,
  description text,
  street text,
  street_number text,
  address_complement text,
  neighborhood text,
  city text,
  state text,
  postal_code text,
  capacity integer,
  studio_type_id uuid,
  studio_type_name text,
  usage_rules text,
  youtube_video_id text,
  tags jsonb,
  amenities jsonb,
  faqs jsonb
)
  language sql stable security invoker
  set search_path to ''
as $function$
  select
    studio.owner_user_id,
    studio.id,
    studio.status,
    studio.published_revision_id,
    studio.draft_revision_id,
    studio.draft_revision_id is not null,
    revision.id,
    revision.status,
    revision.revision_number,
    revision.revision_version,
    revision.name,
    revision.description,
    revision.street,
    revision.street_number,
    revision.address_complement,
    revision.neighborhood,
    revision.city,
    revision.state,
    revision.postal_code,
    revision.capacity,
    revision.studio_type_id,
    studio_type.name,
    revision.usage_rules,
    revision.youtube_video_id,
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', tag.id,
          'name', tag.name,
          'active', tag.active,
          'sortOrder', tag.sort_order
        ) order by tag.sort_order, tag.name, tag.id
      )
      from public.studio_revision_tags as relation
      join public.tags as tag on tag.id = relation.tag_id
      where relation.revision_id = revision.id
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', amenity.id,
          'name', amenity.name,
          'active', amenity.active,
          'sortOrder', amenity.sort_order
        ) order by amenity.sort_order, amenity.name, amenity.id
      )
      from public.studio_revision_amenities as relation
      join public.amenities as amenity on amenity.id = relation.amenity_id
      where relation.revision_id = revision.id
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', faq.id,
          'question', faq.question,
          'answer', faq.answer,
          'position', faq.position
        ) order by faq.position
      )
      from public.studio_faqs as faq
      where faq.revision_id = revision.id
    ), '[]'::jsonb)
  from public.studios as studio
  join public.studio_revisions as revision
    on revision.id = coalesce(studio.draft_revision_id, studio.published_revision_id)
  join public.studio_types as studio_type on studio_type.id = revision.studio_type_id
  where studio.id = p_studio_id
    and studio.owner_user_id = (select auth.uid());
$function$;

alter function public.get_owner_studio_editor(uuid) owner to postgres;

create or replace function public.list_active_studio_taxonomies() returns jsonb
  language sql stable security invoker
  set search_path to ''
as $function$
  select pg_catalog.jsonb_build_object(
    'tags', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', tag.id,
          'name', tag.name,
          'sortOrder', tag.sort_order
        ) order by tag.sort_order, tag.name, tag.id
      )
      from public.tags as tag
      where tag.active
    ), '[]'::jsonb),
    'amenities', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', amenity.id,
          'name', amenity.name,
          'sortOrder', amenity.sort_order
        ) order by amenity.sort_order, amenity.name, amenity.id
      )
      from public.amenities as amenity
      where amenity.active
    ), '[]'::jsonb)
  );
$function$;

alter function public.list_active_studio_taxonomies() owner to postgres;

create or replace function private.prepare_studio_revision_draft(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint
) returns table (revision_id uuid, revision_version bigint, cloned boolean)
  language plpgsql security invoker
  set search_path to ''
as $function$
declare
  current_revision public.studio_revisions%rowtype;
  current_studio public.studios%rowtype;
  next_revision_number bigint;
  new_revision_id uuid;
begin
  select studio.*
  into current_studio
  from public.studios as studio
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_not_found';
  end if;
  if current_studio.status = 'disabled' then
    raise exception using errcode = '42501', message = 'studio_disabled';
  end if;

  select revision.*
  into current_revision
  from public.studio_revisions as revision
  where revision.id = coalesce(
      current_studio.draft_revision_id,
      current_studio.published_revision_id
    )
    and revision.studio_id = current_studio.id
  for update;

  if not found
    or current_revision.id <> p_expected_revision_id
    or current_revision.revision_version <> p_expected_revision_version
  then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  if current_studio.draft_revision_id is not null then
    if current_revision.status <> 'draft' then
      raise exception using errcode = '23514', message = 'studio_draft_state_invalid';
    end if;
    return query select current_revision.id, current_revision.revision_version, false;
    return;
  end if;

  if current_revision.status <> 'approved'
    or current_studio.published_revision_id <> current_revision.id
  then
    raise exception using errcode = '23514', message = 'studio_published_state_invalid';
  end if;

  select pg_catalog.max(revision.revision_number) + 1
  into next_revision_number
  from public.studio_revisions as revision
  where revision.studio_id = current_studio.id;

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
  values (
    current_studio.id,
    next_revision_number,
    1,
    'draft',
    current_revision.name,
    current_revision.description,
    current_revision.street,
    current_revision.street_number,
    current_revision.address_complement,
    current_revision.neighborhood,
    current_revision.city,
    current_revision.state,
    current_revision.postal_code,
    current_revision.capacity,
    current_revision.studio_type_id,
    current_revision.usage_rules,
    current_revision.youtube_video_id
  )
  returning id into new_revision_id;

  update public.studios as studio
  set draft_revision_id = new_revision_id
  where studio.id = current_studio.id;

  return query select new_revision_id, 1::bigint, true;
end;
$function$;

alter function private.prepare_studio_revision_draft(uuid, uuid, uuid, bigint) owner to postgres;

create or replace function private.update_studio_revision_taxonomy(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_tag_ids uuid[],
  p_amenity_ids uuid[]
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  editor jsonb;
  existing_request private.studio_command_requests%rowtype;
  payload_hash text;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_tag_ids is null
    or p_amenity_ids is null
    or pg_catalog.cardinality(p_tag_ids) > 20
    or pg_catalog.cardinality(p_amenity_ids) > 20
  then
    raise exception using errcode = '22023', message = 'invalid_studio_taxonomy';
  end if;

  if pg_catalog.cardinality(p_tag_ids) <> (
      select pg_catalog.count(distinct selected.id)
      from pg_catalog.unnest(p_tag_ids) as selected(id)
    )
    or pg_catalog.cardinality(p_amenity_ids) <> (
      select pg_catalog.count(distinct selected.id)
      from pg_catalog.unnest(p_amenity_ids) as selected(id)
    )
  then
    raise exception using errcode = '22023', message = 'duplicate_studio_taxonomy';
  end if;

  payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'studioId', p_studio_id,
          'expectedRevisionId', p_expected_revision_id,
          'expectedRevisionVersion', p_expected_revision_version,
          'tagIds', coalesce((
            select pg_catalog.jsonb_agg(selected.id order by selected.id::text)
            from pg_catalog.unnest(p_tag_ids) as selected(id)
          ), '[]'::jsonb),
          'amenityIds', coalesce((
            select pg_catalog.jsonb_agg(selected.id order by selected.id::text)
            from pg_catalog.unnest(p_amenity_ids) as selected(id)
          ), '[]'::jsonb)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  select request.*
  into existing_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> 'studio.revision.updateTaxonomy'
      or existing_request.payload_hash <> payload_hash
      or existing_request.studio_id <> p_studio_id
    then
      raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
    end if;

    editor := private.studio_editor_json(p_user_id, p_studio_id);
    if editor is null then
      raise exception using errcode = '40001', message = 'studio_taxonomy_result_missing';
    end if;
    if private.studio_result_hash(editor) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'studio_taxonomy_result_stale';
    end if;
    return editor;
  end if;

  perform tag.id
  from public.tags as tag
  where tag.id = any (p_tag_ids)
    and tag.active
  order by tag.id
  for share;

  perform amenity.id
  from public.amenities as amenity
  where amenity.id = any (p_amenity_ids)
    and amenity.active
  order by amenity.id
  for share;

  if pg_catalog.cardinality(p_tag_ids) <> (
      select pg_catalog.count(*)
      from public.tags as tag
      where tag.id = any (p_tag_ids)
        and tag.active
    )
    or pg_catalog.cardinality(p_amenity_ids) <> (
      select pg_catalog.count(*)
      from public.amenities as amenity
      where amenity.id = any (p_amenity_ids)
        and amenity.active
    )
  then
    raise exception using errcode = '23514', message = 'studio_taxonomy_inactive';
  end if;

  select prepared.revision_id, prepared.revision_version
  into draft_revision_id, draft_revision_version
  from private.prepare_studio_revision_draft(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as prepared;

  delete from public.studio_revision_tags as relation
  where relation.revision_id = draft_revision_id;

  insert into public.studio_revision_tags (revision_id, tag_id)
  select draft_revision_id, selected.id
  from pg_catalog.unnest(p_tag_ids) as selected(id);

  delete from public.studio_revision_amenities as relation
  where relation.revision_id = draft_revision_id;

  insert into public.studio_revision_amenities (revision_id, amenity_id)
  select draft_revision_id, selected.id
  from pg_catalog.unnest(p_amenity_ids) as selected(id);

  update public.studio_revisions as revision
  set revision_version = revision.revision_version + 1
  where revision.id = draft_revision_id
    and revision.status = 'draft'
    and revision.revision_version = draft_revision_version
  returning revision.revision_version into resulting_revision_version;

  if not found then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  editor := private.studio_editor_json(p_user_id, p_studio_id);
  if editor is null then
    raise exception using errcode = 'P0002', message = 'studio_taxonomy_result_missing';
  end if;

  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    studio_id,
    resulting_revision_id,
    resulting_revision_version
  )
  values (
    p_user_id,
    p_idempotency_key,
    'studio.revision.updateTaxonomy',
    payload_hash,
    private.studio_result_hash(editor),
    p_studio_id,
    draft_revision_id,
    resulting_revision_version
  );

  insert into audit.events (
    actor_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    request_id,
    idempotency_key,
    ip_hash,
    metadata
  )
  values (
    p_user_id,
    'authenticated',
    'studio.revision_taxonomy_updated',
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'tagCount', pg_catalog.cardinality(p_tag_ids),
      'amenityCount', pg_catalog.cardinality(p_amenity_ids)
    )
  );

  return editor;
end;
$function$;

alter function private.update_studio_revision_taxonomy(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid[], uuid[]
) owner to postgres;

create or replace function private.update_studio_revision_content(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_usage_rules text,
  p_youtube_video_id text,
  p_faqs jsonb
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  editor jsonb;
  existing_request private.studio_command_requests%rowtype;
  payload_hash text;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_usage_rules is null
    or p_usage_rules <> pg_catalog.btrim(p_usage_rules)
    or pg_catalog.char_length(p_usage_rules) > 5000
    or (p_youtube_video_id is not null and p_youtube_video_id !~ '^[A-Za-z0-9_-]{11}$')
    or p_faqs is null
    or pg_catalog.jsonb_typeof(p_faqs) <> 'array'
    or pg_catalog.jsonb_array_length(p_faqs) > 20
  then
    raise exception using errcode = '22023', message = 'invalid_studio_content';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_faqs) as faq(value)
    where case
      when pg_catalog.jsonb_typeof(faq.value) <> 'object' then true
      else
        (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(faq.value)) <> 2
        or not (faq.value ? 'question' and faq.value ? 'answer')
        or pg_catalog.jsonb_typeof(faq.value -> 'question') <> 'string'
        or pg_catalog.jsonb_typeof(faq.value -> 'answer') <> 'string'
        or faq.value ->> 'question' <> pg_catalog.btrim(faq.value ->> 'question')
        or faq.value ->> 'answer' <> pg_catalog.btrim(faq.value ->> 'answer')
        or pg_catalog.char_length(faq.value ->> 'question') not between 1 and 160
        or pg_catalog.char_length(faq.value ->> 'answer') not between 1 and 2000
      end
  ) then
    raise exception using errcode = '22023', message = 'invalid_studio_faq';
  end if;

  payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'studioId', p_studio_id,
          'expectedRevisionId', p_expected_revision_id,
          'expectedRevisionVersion', p_expected_revision_version,
          'usageRules', p_usage_rules,
          'youtubeVideoId', p_youtube_video_id,
          'faqs', p_faqs
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  select request.*
  into existing_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> 'studio.revision.updateContent'
      or existing_request.payload_hash <> payload_hash
      or existing_request.studio_id <> p_studio_id
    then
      raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
    end if;

    editor := private.studio_editor_json(p_user_id, p_studio_id);
    if editor is null then
      raise exception using errcode = '40001', message = 'studio_content_result_missing';
    end if;
    if private.studio_result_hash(editor) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'studio_content_result_stale';
    end if;
    return editor;
  end if;

  select prepared.revision_id, prepared.revision_version
  into draft_revision_id, draft_revision_version
  from private.prepare_studio_revision_draft(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as prepared;

  update public.studio_revisions as revision
  set
    usage_rules = p_usage_rules,
    youtube_video_id = p_youtube_video_id,
    revision_version = revision.revision_version + 1
  where revision.id = draft_revision_id
    and revision.status = 'draft'
    and revision.revision_version = draft_revision_version
  returning revision.revision_version into resulting_revision_version;

  if not found then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  delete from public.studio_faqs as faq
  where faq.revision_id = draft_revision_id;

  insert into public.studio_faqs (revision_id, question, answer, position)
  select
    draft_revision_id,
    faq.value ->> 'question',
    faq.value ->> 'answer',
    faq.position::smallint
  from pg_catalog.jsonb_array_elements(p_faqs) with ordinality as faq(value, position);

  editor := private.studio_editor_json(p_user_id, p_studio_id);
  if editor is null then
    raise exception using errcode = 'P0002', message = 'studio_content_result_missing';
  end if;

  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    studio_id,
    resulting_revision_id,
    resulting_revision_version
  )
  values (
    p_user_id,
    p_idempotency_key,
    'studio.revision.updateContent',
    payload_hash,
    private.studio_result_hash(editor),
    p_studio_id,
    draft_revision_id,
    resulting_revision_version
  );

  insert into audit.events (
    actor_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    request_id,
    idempotency_key,
    ip_hash,
    metadata
  )
  values (
    p_user_id,
    'authenticated',
    'studio.revision_content_updated',
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'faqCount', pg_catalog.jsonb_array_length(p_faqs),
      'hasYoutubeVideo', p_youtube_video_id is not null
    )
  );

  return editor;
end;
$function$;

alter function private.update_studio_revision_content(
  uuid, uuid, uuid, bigint, uuid, uuid, text, text, jsonb
) owner to postgres;

insert into private.dal_routine_allowlist (signature)
values
  ('private.update_studio_revision_content(uuid,uuid,uuid,bigint,uuid,uuid,text,text,jsonb)'),
  ('private.update_studio_revision_taxonomy(uuid,uuid,uuid,bigint,uuid,uuid,uuid[],uuid[])');

alter table public.tags enable row level security;
alter table public.amenities enable row level security;
alter table public.studio_revision_tags enable row level security;
alter table public.studio_revision_amenities enable row level security;
alter table public.studio_faqs enable row level security;

create policy tags_select_active_or_referenced_own
  on public.tags
  for select
  to authenticated
  using (
    active
    or exists (
      select 1
      from public.studio_revision_tags as relation
      join public.studio_revisions as revision on revision.id = relation.revision_id
      join public.studios as studio on studio.id = revision.studio_id
      where relation.tag_id = tags.id
        and studio.owner_user_id = (select auth.uid())
    )
  );

create policy amenities_select_active_or_referenced_own
  on public.amenities
  for select
  to authenticated
  using (
    active
    or exists (
      select 1
      from public.studio_revision_amenities as relation
      join public.studio_revisions as revision on revision.id = relation.revision_id
      join public.studios as studio on studio.id = revision.studio_id
      where relation.amenity_id = amenities.id
        and studio.owner_user_id = (select auth.uid())
    )
  );

create policy studio_revision_tags_select_own
  on public.studio_revision_tags
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.studio_revisions as revision
      join public.studios as studio on studio.id = revision.studio_id
      where revision.id = studio_revision_tags.revision_id
        and studio.owner_user_id = (select auth.uid())
    )
  );

create policy studio_revision_amenities_select_own
  on public.studio_revision_amenities
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.studio_revisions as revision
      join public.studios as studio on studio.id = revision.studio_id
      where revision.id = studio_revision_amenities.revision_id
        and studio.owner_user_id = (select auth.uid())
    )
  );

create policy studio_faqs_select_own
  on public.studio_faqs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.studio_revisions as revision
      join public.studios as studio on studio.id = revision.studio_id
      where revision.id = studio_faqs.revision_id
        and studio.owner_user_id = (select auth.uid())
    )
  );

revoke all on table public.tags
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.amenities
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.studio_revision_tags
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.studio_revision_amenities
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.studio_faqs
  from public, anon, authenticated, service_role, app_dal;

grant select (id, name, active, sort_order) on table public.tags to authenticated;
grant select (id, name, active, sort_order) on table public.amenities to authenticated;
grant select (revision_id, tag_id) on table public.studio_revision_tags to authenticated;
grant select (revision_id, amenity_id) on table public.studio_revision_amenities to authenticated;
grant select (id, revision_id, question, answer, position)
  on table public.studio_faqs to authenticated;
grant select (usage_rules, youtube_video_id)
  on table public.studio_revisions to authenticated;

revoke all on function private.assert_editable_studio_revision_relation()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.clone_studio_revision_content_before_insert()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.clone_studio_revision_relations_after_insert()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_editor_json(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.prepare_studio_revision_draft(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.update_studio_revision_taxonomy(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid[], uuid[]
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.update_studio_revision_content(
  uuid, uuid, uuid, bigint, uuid, uuid, text, text, jsonb
) from public, anon, authenticated, service_role, app_dal;

grant execute on function private.update_studio_revision_taxonomy(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid[], uuid[]
) to app_dal;
grant execute on function private.update_studio_revision_content(
  uuid, uuid, uuid, bigint, uuid, uuid, text, text, jsonb
) to app_dal;

revoke all on function public.list_active_studio_taxonomies()
  from public, anon, authenticated, service_role, app_dal;
grant execute on function public.list_active_studio_taxonomies() to authenticated;
revoke all on function public.get_owner_studio_editor(uuid)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function public.get_owner_studio_editor(uuid) to authenticated;

comment on table public.tags is
  'Taxonomia administrada de usos e estilos do estúdio; somente itens ativos entram em novas drafts.';
comment on table public.amenities is
  'Taxonomia administrada de comodidades; somente itens ativos entram em novas drafts.';
comment on table public.studio_revision_tags is
  'Seleção versionada de tags da revisão; sem escrita direta de runtime.';
comment on table public.studio_revision_amenities is
  'Seleção versionada de comodidades da revisão; sem escrita direta de runtime.';
comment on table public.studio_faqs is
  'FAQ plain text, ordenada e pertencente integralmente a uma revisão de estúdio.';
comment on function private.prepare_studio_revision_draft(uuid, uuid, uuid, bigint) is
  'Trava e valida o token da revisão; retorna a draft existente ou clona a publicada sem mutá-la.';
comment on function private.update_studio_revision_taxonomy(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid[], uuid[]
) is 'Substitui tags e comodidades ativas da draft de forma atômica e idempotente.';
comment on function private.update_studio_revision_content(
  uuid, uuid, uuid, bigint, uuid, uuid, text, text, jsonb
) is 'Substitui regras, FAQ ordenada e ID de YouTube da draft de forma atômica e idempotente.';
comment on function public.list_active_studio_taxonomies() is
  'Read model autenticado e ordenado das tags e comodidades ativas.';
