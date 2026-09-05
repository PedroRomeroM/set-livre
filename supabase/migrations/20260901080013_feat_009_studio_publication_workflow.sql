alter table public.studios
  add column publication_version bigint not null default 1,
  add constraint studios_publication_version_check check (publication_version >= 1),
  add constraint studios_publication_pointer_state_check check (
    (
      status = any (array['draft'::text, 'pending_review'::text, 'rejected'::text])
      and published_revision_id is null
      and draft_revision_id is not null
    )
    or (
      status = any (array['published'::text, 'changes_pending'::text, 'paused'::text])
      and published_revision_id is not null
      and (status <> 'changes_pending' or draft_revision_id is not null)
    )
    or status = 'disabled'
  );

create table public.studio_review_events (
  id uuid primary key default extensions.gen_random_uuid(),
  event_sequence bigint generated always as identity,
  studio_id uuid not null,
  revision_id uuid not null,
  actor_user_id uuid,
  event_type text not null,
  rejection_reason text,
  occurred_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint studio_review_events_studio_id_fkey foreign key (studio_id)
    references public.studios (id) on delete restrict,
  constraint studio_review_events_revision_id_fkey foreign key (revision_id)
    references public.studio_revisions (id) on delete restrict,
  constraint studio_review_events_actor_user_id_fkey foreign key (actor_user_id)
    references public.profiles (id) on delete set null,
  constraint studio_review_events_type_check check (
    event_type = any (array['submitted'::text, 'approved'::text, 'rejected'::text])
  ),
  constraint studio_review_events_reason_check check (
    (
      event_type = 'rejected'
      and rejection_reason is not null
      and rejection_reason = pg_catalog.btrim(rejection_reason)
      and pg_catalog.char_length(rejection_reason) between 1 and 2000
    )
    or (event_type <> 'rejected' and rejection_reason is null)
  ),
  unique (event_sequence),
  unique (revision_id, event_type)
);

alter table public.studio_review_events owner to postgres;

create index studio_review_events_studio_latest_idx
  on public.studio_review_events (studio_id, event_sequence desc);
create index studio_review_events_actor_user_id_idx
  on public.studio_review_events (actor_user_id)
  where actor_user_id is not null;
create unique index studio_review_events_one_decision_idx
  on public.studio_review_events (revision_id)
  where event_type in ('approved', 'rejected');

create table public.email_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  template_key text not null,
  audience_key text not null,
  studio_id uuid not null,
  revision_id uuid not null,
  deduplication_key text not null unique,
  status text not null default 'pending',
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint email_outbox_template_key_check check (
    template_key = 'studio.review.submitted'
  ),
  constraint email_outbox_audience_key_check check (
    audience_key = 'studio_reviewers'
  ),
  constraint email_outbox_studio_id_fkey foreign key (studio_id)
    references public.studios (id) on delete restrict,
  constraint email_outbox_revision_id_fkey foreign key (revision_id)
    references public.studio_revisions (id) on delete restrict,
  constraint email_outbox_deduplication_key_check check (
    deduplication_key = pg_catalog.btrim(deduplication_key)
    and pg_catalog.char_length(deduplication_key) between 20 and 160
  ),
  constraint email_outbox_status_check check (status = 'pending'),
  unique (revision_id, template_key)
);

alter table public.email_outbox owner to postgres;

create index email_outbox_studio_created_idx
  on public.email_outbox (studio_id, created_at, id);

create table private.studio_deletion_fences (
  studio_id uuid primary key,
  transaction_id xid8 not null,
  backend_pid integer not null,
  constraint studio_deletion_fences_studio_id_fkey foreign key (studio_id)
    references public.studios (id) on delete cascade,
  constraint studio_deletion_fences_backend_pid_check check (backend_pid > 0)
);

alter table private.studio_deletion_fences owner to postgres;
alter table private.studio_deletion_fences enable row level security;
revoke all on table private.studio_deletion_fences
  from public, anon, authenticated, service_role, app_dal;

alter table private.studio_command_requests
  drop constraint studio_command_requests_action_check,
  add constraint studio_command_requests_action_check check (
    action = any (array[
      'studio.create'::text,
      'studio.revision.updateCore'::text,
      'studio.revision.updateTaxonomy'::text,
      'studio.revision.updateContent'::text,
      'studio.draft.discard'::text,
      'studio.media.prepare'::text,
      'studio.media.finalize'::text,
      'studio.media.reorder'::text,
      'studio.media.cover.set'::text,
      'studio.media.delete'::text,
      'studio.revision.submit'::text,
      'studio.pause'::text,
      'studio.resume'::text
    ])
  );

create or replace function private.enforce_studio_publication_boundary() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  boundary_changed boolean;
begin
  boundary_changed := new.status is distinct from old.status
    or new.published_revision_id is distinct from old.published_revision_id
    or new.draft_revision_id is distinct from old.draft_revision_id;

  if old.status = 'published'
    and new.status = 'published'
    and old.draft_revision_id is null
    and new.draft_revision_id is not null
  then
    new.status := 'changes_pending';
    boundary_changed := true;
  elsif old.status = 'changes_pending'
    and new.status = 'changes_pending'
    and old.draft_revision_id is not null
    and new.draft_revision_id is null
    and new.published_revision_id is not null
  then
    new.status := 'published';
    boundary_changed := true;
  end if;

  if old.status is distinct from new.status
    and not (
      (old.status = 'draft' and new.status = 'pending_review')
      or (old.status = 'pending_review' and new.status in ('published', 'rejected'))
      or (old.status = 'published' and new.status in ('changes_pending', 'paused'))
      or (old.status = 'changes_pending' and new.status in ('published', 'paused'))
      or (old.status = 'paused' and new.status in ('published', 'changes_pending'))
      or (old.status = 'rejected' and new.status = 'pending_review')
    )
  then
    raise exception using errcode = '23514', message = 'studio_status_transition_invalid';
  end if;

  if boundary_changed then
    if new.publication_version is distinct from old.publication_version then
      raise exception using errcode = '23514', message = 'studio_publication_version_invalid';
    end if;

    new.publication_version := old.publication_version + 1;
  elsif new.publication_version is distinct from old.publication_version then
    raise exception using errcode = '23514', message = 'studio_publication_version_invalid';
  end if;

  return new;
end;
$function$;

alter function private.enforce_studio_publication_boundary() owner to postgres;

create trigger studios_enforce_publication_boundary
  before update of status, published_revision_id, draft_revision_id, publication_version
  on public.studios
  for each row execute function private.enforce_studio_publication_boundary();

create or replace function private.enforce_studio_revision_immutability() returns trigger
  language plpgsql
  set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' and not exists (
    select 1
    from public.studios as studio
    where studio.id = old.studio_id
  ) then
    return old;
  end if;

  if old.status <> 'draft' then
    raise exception using errcode = '23514', message = 'studio_revision_immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.id is distinct from old.id
    or new.studio_id is distinct from old.studio_id
    or new.revision_number is distinct from old.revision_number
    or new.created_at is distinct from old.created_at
    or new.revision_version <> old.revision_version + 1
  then
    raise exception using errcode = '23514', message = 'studio_revision_identity_invalid';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

alter function private.enforce_studio_revision_immutability() owner to postgres;

create or replace function private.assert_editable_studio_media_relation() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  locked_revision record;
  old_revision_exists boolean := false;
  old_revision_status text;
  new_revision_exists boolean := false;
  new_revision_status text;
  new_revision_studio_id uuid;
  target_media_status text;
  target_media_studio_id uuid;
begin
  if tg_op = 'DELETE' then
    select revision.status
    into old_revision_status
    from public.studio_revisions as revision
    where revision.id = old.revision_id
    for share;

    old_revision_exists := found;
    if not old_revision_exists or old_revision_status = 'draft' then
      return old;
    end if;

    raise exception using errcode = '23514', message = 'studio_media_revision_immutable';
  end if;

  for locked_revision in
    select revision.id, revision.status, revision.studio_id
    from public.studio_revisions as revision
    where revision.id = new.revision_id
      or (tg_op = 'UPDATE' and revision.id = old.revision_id)
    order by revision.id
    for share
  loop
    if tg_op = 'UPDATE' and locked_revision.id = old.revision_id then
      old_revision_exists := true;
      old_revision_status := locked_revision.status;
    end if;
    if locked_revision.id = new.revision_id then
      new_revision_exists := true;
      new_revision_status := locked_revision.status;
      new_revision_studio_id := locked_revision.studio_id;
    end if;
  end loop;

  if tg_op = 'UPDATE'
    and (not old_revision_exists or old_revision_status is distinct from 'draft')
  then
    raise exception using errcode = '23514', message = 'studio_media_revision_immutable';
  end if;

  if not new_revision_exists or new_revision_status is distinct from 'draft' then
    raise exception using errcode = '23514', message = 'studio_media_revision_immutable';
  end if;

  select media.status, media.studio_id
  into target_media_status, target_media_studio_id
  from public.studio_media as media
  where media.id = new.media_id
  for share;

  if not found
    or target_media_status <> 'ready'
    or target_media_studio_id is distinct from new_revision_studio_id
  then
    raise exception using errcode = '23514', message = 'studio_media_relation_invalid';
  end if;

  return new;
end;
$function$;

alter function private.assert_editable_studio_media_relation() owner to postgres;

create or replace function private.protect_immutable_studio_media_lifecycle() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  aggregate_deletion_fenced boolean;
  immutable_reference_exists boolean;
begin
  if old.status = 'ready' and new.status = 'delete_pending' then
    perform revision.id
    from public.studio_revision_media as relation
    join public.studio_revisions as revision on revision.id = relation.revision_id
    where relation.media_id = old.id
    order by revision.id
    for share of revision;

    select exists (
      select 1
      from public.studio_revision_media as relation
      join public.studio_revisions as revision on revision.id = relation.revision_id
      where relation.media_id = old.id
        and revision.status <> 'draft'
    )
    into immutable_reference_exists;

    select exists (
      select 1
      from private.studio_deletion_fences as fence
      where fence.studio_id = old.studio_id
        and fence.transaction_id = pg_catalog.pg_current_xact_id()
        and fence.backend_pid = pg_catalog.pg_backend_pid()
    )
    into aggregate_deletion_fenced;

    if immutable_reference_exists and not aggregate_deletion_fenced then
      raise exception using errcode = '23514', message = 'studio_media_revision_immutable';
    end if;
  end if;

  return new;
end;
$function$;

alter function private.protect_immutable_studio_media_lifecycle() owner to postgres;

create trigger studio_media_protect_immutable_revision
  before update on public.studio_media
  for each row execute function private.protect_immutable_studio_media_lifecycle();

create or replace function private.queue_studio_media_before_studio_delete() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  requested_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into private.studio_deletion_fences (studio_id, transaction_id, backend_pid)
  values (old.id, pg_catalog.pg_current_xact_id(), pg_catalog.pg_backend_pid());

  update public.studio_media as media
  set
    status = 'delete_pending',
    delete_requested_at = coalesce(media.delete_requested_at, requested_at),
    cleanup_after = greatest(
      coalesce(media.cleanup_after, requested_at),
      media.upload_expires_at
    ),
    cleanup_next_attempt_at = case
      when media.status = 'delete_pending' then media.cleanup_next_attempt_at
      else null
    end
  where media.studio_id = old.id
    and media.status <> 'deleted';

  return old;
end;
$function$;

alter function private.queue_studio_media_before_studio_delete() owner to postgres;

create or replace function private.get_owner_studio_media(
  p_user_id uuid,
  p_studio_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  select pg_catalog.jsonb_build_object(
    'scope', studio.owner_user_id,
    'studioId', studio.id,
    'revisionId', revision.id,
    'revisionNumber', revision.revision_number,
    'revisionVersion', revision.revision_version,
    'revisionStatus', revision.status,
    'canEdit', revision.status in ('draft', 'approved'),
    'items', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', media.id,
          'previewStoragePath', media.preview_storage_path,
          'mimeType', media.actual_mime_type,
          'byteSize', media.actual_size_bytes,
          'checksumSha256', media.checksum_sha256,
          'width', media.width,
          'height', media.height,
          'position', relation.position,
          'isCover', relation.is_cover
        ) order by relation.position
      )
      from public.studio_revision_media as relation
      join public.studio_media as media on media.id = relation.media_id
      where relation.revision_id = revision.id
        and media.status = 'ready'
    ), '[]'::jsonb)
  )
  from public.studios as studio
  join public.profiles as profile on profile.id = studio.owner_user_id
  join public.owner_profiles as owner on owner.user_id = profile.id
  join public.terms_versions as legal_version
    on legal_version.id = owner.accepted_owner_contract_version_id
  join public.terms_acceptances as acceptance
    on acceptance.user_id = owner.user_id
    and acceptance.terms_version_id = legal_version.id
    and acceptance.accepted_content_hash = legal_version.content_hash
  join public.studio_revisions as revision
    on revision.id = coalesce(studio.draft_revision_id, studio.published_revision_id)
    and revision.studio_id = studio.id
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
    and studio.status <> 'disabled'
    and profile.status = 'active'
    and profile.completed_at is not null
    and owner.status = 'active'
    and revision.revision_number >= 1
    and legal_version.kind = 'owner_contract'
    and legal_version.effective_at <= pg_catalog.now()
    and (legal_version.retired_at is null or pg_catalog.now() < legal_version.retired_at)
    and (
      (
        studio.draft_revision_id is not null
        and revision.id = studio.draft_revision_id
        and revision.status in ('draft', 'pending')
      )
      or (
        studio.draft_revision_id is null
        and studio.published_revision_id is not null
        and revision.id = studio.published_revision_id
        and revision.status = 'approved'
      )
    );
$function$;

alter function private.get_owner_studio_media(uuid, uuid) owner to postgres;

create or replace function private.protect_studio_review_event() returns trigger
  language plpgsql
  set search_path to ''
as $function$
begin
  if tg_op = 'UPDATE'
    and old.actor_user_id is not null
    and new.actor_user_id is null
    and new.id is not distinct from old.id
    and new.event_sequence is not distinct from old.event_sequence
    and new.studio_id is not distinct from old.studio_id
    and new.revision_id is not distinct from old.revision_id
    and new.event_type is not distinct from old.event_type
    and new.rejection_reason is not distinct from old.rejection_reason
    and new.occurred_at is not distinct from old.occurred_at
  then
    return new;
  end if;

  if tg_op = 'DELETE' and current_user = 'postgres' then
    return old;
  end if;

  raise exception using errcode = '42501', message = 'studio_review_event_is_append_only';
end;
$function$;

alter function private.protect_studio_review_event() owner to postgres;

create or replace function private.enforce_studio_review_event_identity() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  current_revision_status text;
  current_studio_draft_revision_id uuid;
  current_studio_owner_user_id uuid;
  current_studio_status text;
begin
  select
    revision.status,
    studio.draft_revision_id,
    studio.owner_user_id,
    studio.status
  into
    current_revision_status,
    current_studio_draft_revision_id,
    current_studio_owner_user_id,
    current_studio_status
  from public.studio_revisions as revision
  join public.studios as studio on studio.id = revision.studio_id
  where revision.id = new.revision_id
    and revision.studio_id = new.studio_id
  for key share of revision, studio;

  if not found then
    raise exception using errcode = '23514', message = 'studio_review_revision_mismatch';
  end if;

  if new.event_type = 'submitted' then
    if new.actor_user_id is null
      or current_studio_owner_user_id is distinct from new.actor_user_id
    then
      raise exception using errcode = '23514', message = 'studio_review_submitter_invalid';
    end if;

    if current_revision_status <> 'pending'
      or current_studio_draft_revision_id is distinct from new.revision_id
      or current_studio_status not in ('pending_review', 'changes_pending', 'paused')
    then
      raise exception using errcode = '23514', message = 'studio_review_submission_state_invalid';
    end if;
  elsif new.event_type in ('approved', 'rejected') then
    if new.actor_user_id is null then
      raise exception using errcode = '23514', message = 'studio_review_decision_actor_invalid';
    end if;

    if not exists (
      select 1
      from public.studio_review_events as submitted_event
      where submitted_event.studio_id = new.studio_id
        and submitted_event.revision_id = new.revision_id
        and submitted_event.event_type = 'submitted'
    ) then
      raise exception using errcode = '23514', message = 'studio_review_decision_submission_missing';
    end if;

    if current_revision_status <> new.event_type then
      raise exception using errcode = '23514', message = 'studio_review_decision_state_invalid';
    end if;
  end if;

  return new;
end;
$function$;

alter function private.enforce_studio_review_event_identity() owner to postgres;

create or replace function private.enforce_studio_outbox_identity() returns trigger
  language plpgsql
  set search_path to ''
as $function$
begin
  if not exists (
    select 1
    from public.studio_review_events as review
    where review.studio_id = new.studio_id
      and review.revision_id = new.revision_id
      and review.event_type = 'submitted'
  ) then
    raise exception using errcode = '23514', message = 'studio_outbox_event_missing';
  end if;
  return new;
end;
$function$;

alter function private.enforce_studio_outbox_identity() owner to postgres;

create trigger studio_review_events_enforce_identity
  before insert on public.studio_review_events
  for each row execute function private.enforce_studio_review_event_identity();

create trigger studio_review_events_protect_append_only
  before update or delete on public.studio_review_events
  for each row execute function private.protect_studio_review_event();

create trigger email_outbox_enforce_identity
  before insert on public.email_outbox
  for each row execute function private.enforce_studio_outbox_identity();

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
    'studio.draft_discarded'::text,
    'studio.media_upload_prepared'::text,
    'studio.media_upload_rejected'::text,
    'studio.media_upload_finalized'::text,
    'studio.media_reordered'::text,
    'studio.media_cover_set'::text,
    'studio.media_deleted'::text,
    'studio.revision_submitted'::text,
    'studio.paused'::text,
    'studio.resumed'::text,
    'backoffice.admin_bootstrapped'::text,
    'backoffice.user_suspended'::text,
    'backoffice.user_restored'::text,
    'backoffice.user_pii_revealed'::text,
    'backoffice.role_granted'::text,
    'backoffice.role_revoked'::text,
    'backoffice.taxonomy_created'::text,
    'backoffice.taxonomy_updated'::text,
    'backoffice.taxonomy_archived'::text,
    'backoffice.taxonomy_reactivated'::text
  ])
);

create or replace function private.studio_revision_taxonomy_fence(
  p_revision_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  select pg_catalog.jsonb_build_object(
    'studioTypeId', revision.studio_type_id,
    'tagIds', coalesce((
      select pg_catalog.jsonb_agg(relation.tag_id order by relation.tag_id)
      from public.studio_revision_tags as relation
      where relation.revision_id = revision.id
    ), '[]'::jsonb),
    'amenityIds', coalesce((
      select pg_catalog.jsonb_agg(relation.amenity_id order by relation.amenity_id)
      from public.studio_revision_amenities as relation
      where relation.revision_id = revision.id
    ), '[]'::jsonb)
  )
  from public.studio_revisions as revision
  where revision.id = p_revision_id;
$function$;

alter function private.studio_revision_taxonomy_fence(uuid) owner to postgres;

create or replace function private.lock_active_studio_revision_taxonomy(
  p_user_id uuid,
  p_studio_id uuid,
  p_revision_id uuid,
  p_revision_version bigint
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  active_amenity_ids uuid[];
  active_tag_ids uuid[];
  current_studio_type_id uuid;
begin
  if not exists (
    select 1
    from public.studios as studio
    where studio.id = p_studio_id
      and studio.owner_user_id = p_user_id
  ) then
    raise exception using errcode = 'P0002', message = 'studio_not_found';
  end if;

  if not exists (
    select 1
    from public.studios as studio
    join public.studio_revisions as revision
      on revision.id = studio.draft_revision_id
      and revision.studio_id = studio.id
    where studio.id = p_studio_id
      and studio.owner_user_id = p_user_id
      and revision.id = p_revision_id
      and revision.revision_version = p_revision_version
  ) then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  select studio_type.id
  into current_studio_type_id
  from public.studio_revisions as revision
  join public.studio_types as studio_type on studio_type.id = revision.studio_type_id
  where revision.id = p_revision_id
    and revision.studio_id = p_studio_id
    and studio_type.active
  order by studio_type.id
  for share of studio_type;

  if not found then
    raise exception using errcode = '23514', message = 'studio_submission_incomplete';
  end if;

  select coalesce(pg_catalog.array_agg(locked_tag.id order by locked_tag.id), array[]::uuid[])
  into active_tag_ids
  from (
    select tag.id
    from public.studio_revision_tags as relation
    join public.tags as tag on tag.id = relation.tag_id
    where relation.revision_id = p_revision_id
      and tag.active
    order by tag.id
    for share of tag
  ) as locked_tag;

  if pg_catalog.cardinality(active_tag_ids) <> (
    select pg_catalog.count(*)
    from public.studio_revision_tags as relation
    where relation.revision_id = p_revision_id
  ) then
    raise exception using errcode = '23514', message = 'studio_submission_incomplete';
  end if;

  select coalesce(
    pg_catalog.array_agg(locked_amenity.id order by locked_amenity.id),
    array[]::uuid[]
  )
  into active_amenity_ids
  from (
    select amenity.id
    from public.studio_revision_amenities as relation
    join public.amenities as amenity on amenity.id = relation.amenity_id
    where relation.revision_id = p_revision_id
      and amenity.active
    order by amenity.id
    for share of amenity
  ) as locked_amenity;

  if pg_catalog.cardinality(active_amenity_ids) <> (
    select pg_catalog.count(*)
    from public.studio_revision_amenities as relation
    where relation.revision_id = p_revision_id
  ) then
    raise exception using errcode = '23514', message = 'studio_submission_incomplete';
  end if;

  return pg_catalog.jsonb_build_object(
    'studioTypeId', current_studio_type_id,
    'tagIds', pg_catalog.to_jsonb(active_tag_ids),
    'amenityIds', pg_catalog.to_jsonb(active_amenity_ids)
  );
end;
$function$;

alter function private.lock_active_studio_revision_taxonomy(
  uuid, uuid, uuid, bigint
) owner to postgres;

create or replace function private.studio_publication_checklist(
  p_revision_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  with taxonomy_state as (
    select
      exists (
        select 1
        from public.studio_revisions as revision
        join public.studio_types as studio_type on studio_type.id = revision.studio_type_id
        where revision.id = p_revision_id
          and studio_type.active
      ) as studio_type_active,
      not exists (
        select 1
        from public.studio_revision_tags as relation
        join public.tags as tag on tag.id = relation.tag_id
        where relation.revision_id = p_revision_id
          and not tag.active
      ) as tags_active,
      not exists (
        select 1
        from public.studio_revision_amenities as relation
        join public.amenities as amenity on amenity.id = relation.amenity_id
        where relation.revision_id = p_revision_id
          and not amenity.active
      ) as amenities_active
  ),
  media_state as (
    select
      (
        select pg_catalog.count(*)
        from public.studio_revision_media as relation
        join public.studio_media as media on media.id = relation.media_id
        where relation.revision_id = p_revision_id
          and media.status = 'ready'
      ) as ready_count,
      (
        select pg_catalog.count(*)
        from public.studio_revision_media as relation
        join public.studio_media as media on media.id = relation.media_id
        where relation.revision_id = p_revision_id
          and relation.is_cover
          and media.status = 'ready'
      ) as cover_count,
      (
        select pg_catalog.count(*)
        from public.studio_media as media
        where media.prepared_revision_id = p_revision_id
          and media.status = 'pending_upload'
          and pg_catalog.now() < media.upload_expires_at
      ) as pending_count
  ),
  taxonomy_messages as (
    select
      coalesce(
        pg_catalog.jsonb_agg(message.message order by message.position)
          filter (where message.section = 'details'),
        '[]'::jsonb
      ) as details_messages,
      coalesce(
        pg_catalog.jsonb_agg(message.message order by message.position)
          filter (where message.section = 'content'),
        '[]'::jsonb
      ) as content_messages
    from taxonomy_state as state
    cross join lateral (
      values
        (
          1,
          'details'::text,
          'Escolha um tipo de estúdio ativo.'::text,
          not state.studio_type_active
        ),
        (
          2,
          'content'::text,
          'Revise as tags arquivadas antes de enviar.'::text,
          not state.tags_active
        ),
        (
          3,
          'content'::text,
          'Revise as comodidades arquivadas antes de enviar.'::text,
          not state.amenities_active
        )
    ) as message(position, section, message, missing)
    where message.missing
  ),
  media_messages as (
    select coalesce(
      pg_catalog.jsonb_agg(message.message order by message.position),
      '[]'::jsonb
    ) as messages
    from media_state as state
    cross join lateral (
      values
        (1, 'Adicione ao menos uma foto.'::text, state.ready_count < 1),
        (2, 'Escolha uma foto de capa.'::text, state.cover_count <> 1),
        (
          3,
          'Conclua ou descarte os envios de mídia pendentes.'::text,
          state.pending_count > 0
        )
    ) as message(position, message, missing)
    where message.missing
  )
  select pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'key', 'details',
      'complete', taxonomy.studio_type_active,
      'messages', taxonomy_messages.details_messages
    ),
    pg_catalog.jsonb_build_object(
      'key', 'content',
      'complete', taxonomy.tags_active and taxonomy.amenities_active,
      'messages', taxonomy_messages.content_messages
    ),
    pg_catalog.jsonb_build_object(
      'key', 'media',
      'complete', state.ready_count >= 1
        and state.cover_count = 1
        and state.pending_count = 0,
      'messages', messages.messages
    )
  )
  from taxonomy_state as taxonomy
  cross join taxonomy_messages
  cross join media_state as state
  cross join media_messages as messages;
$function$;

alter function private.studio_publication_checklist(uuid) owner to postgres;

create or replace function private.studio_publication_revision_json(
  p_revision_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  select pg_catalog.jsonb_build_object(
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
    'studioType', pg_catalog.jsonb_build_object(
      'id', studio_type.id,
      'name', studio_type.name
    ),
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
    ), '[]'::jsonb),
    'mediaCount', (
      select pg_catalog.count(*)
      from public.studio_revision_media as relation
      join public.studio_media as media on media.id = relation.media_id
      where relation.revision_id = revision.id
        and media.status = 'ready'
    ),
    'cover', (
      select pg_catalog.jsonb_build_object(
        'id', media.id,
        'previewStoragePath', media.preview_storage_path,
        'mimeType', media.actual_mime_type,
        'byteSize', media.actual_size_bytes,
        'checksumSha256', media.checksum_sha256,
        'width', media.width,
        'height', media.height,
        'position', relation.position,
        'isCover', relation.is_cover
      )
      from public.studio_revision_media as relation
      join public.studio_media as media on media.id = relation.media_id
      where relation.revision_id = revision.id
        and relation.is_cover
        and media.status = 'ready'
    )
  )
  from public.studio_revisions as revision
  join public.studio_types as studio_type on studio_type.id = revision.studio_type_id
  where revision.id = p_revision_id;
$function$;

alter function private.studio_publication_revision_json(uuid) owner to postgres;

create or replace function private.studio_publication_json(
  p_user_id uuid,
  p_studio_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  with eligible as (
    select
      studio.id,
      studio.owner_user_id,
      studio.status,
      studio.published_revision_id,
      studio.publication_version,
      current_revision.id as current_revision_id,
      current_revision.status as current_revision_status,
      published_revision.status as published_revision_status,
      private.studio_publication_checklist(current_revision.id) as checklist
    from public.studios as studio
    join public.profiles as profile on profile.id = studio.owner_user_id
    join public.owner_profiles as owner on owner.user_id = profile.id
    join public.terms_versions as legal_version
      on legal_version.id = owner.accepted_owner_contract_version_id
    join public.terms_acceptances as acceptance
      on acceptance.user_id = owner.user_id
      and acceptance.terms_version_id = legal_version.id
      and acceptance.accepted_content_hash = legal_version.content_hash
    join public.studio_revisions as current_revision
      on current_revision.id = coalesce(studio.draft_revision_id, studio.published_revision_id)
      and current_revision.studio_id = studio.id
    left join public.studio_revisions as published_revision
      on published_revision.id = studio.published_revision_id
      and published_revision.studio_id = studio.id
    where studio.id = p_studio_id
      and studio.owner_user_id = p_user_id
      and profile.status = 'active'
      and profile.completed_at is not null
      and owner.status = 'active'
      and legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.now()
      and (legal_version.retired_at is null or pg_catalog.now() < legal_version.retired_at)
      and (
        (
          studio.draft_revision_id is not null
          and current_revision.id = studio.draft_revision_id
          and current_revision.status in ('draft', 'pending', 'rejected')
        )
        or (
          studio.draft_revision_id is null
          and studio.published_revision_id is not null
          and current_revision.id = studio.published_revision_id
          and current_revision.status = 'approved'
        )
      )
      and (
        studio.published_revision_id is null
        or published_revision.status = 'approved'
      )
  )
  select pg_catalog.jsonb_build_object(
    'scope', studio.owner_user_id,
    'studioId', studio.id,
    'studioStatus', studio.status,
    'publicationVersion', studio.publication_version,
    'checklist', studio.checklist,
    'canSubmit', studio.status in ('draft', 'rejected', 'published', 'changes_pending', 'paused')
      and studio.current_revision_status = 'draft'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(studio.checklist) as item(value)
        where not (item.value ->> 'complete')::boolean
      ),
    'canPause', studio.status in ('published', 'changes_pending')
      and studio.published_revision_id is not null
      and studio.published_revision_status = 'approved',
    'canResume', studio.status = 'paused'
      and studio.published_revision_id is not null
      and studio.published_revision_status = 'approved',
    'currentRevision', private.studio_publication_revision_json(studio.current_revision_id),
    'publishedRevision', case
      when studio.published_revision_id is null then null
      else private.studio_publication_revision_json(studio.published_revision_id)
    end,
    'latestReview', (
      select pg_catalog.jsonb_build_object(
        'revisionId', review.revision_id,
        'eventType', review.event_type,
        'rejectionReason', review.rejection_reason,
        'occurredAt', review.occurred_at
      )
      from public.studio_review_events as review
      where review.studio_id = studio.id
      order by review.event_sequence desc
      limit 1
    )
  )
  from eligible as studio;
$function$;

alter function private.studio_publication_json(uuid, uuid) owner to postgres;

create or replace function private.studio_publication_payload_hash(
  p_action text,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_expected_publication_version bigint
) returns text
  language sql immutable
  set search_path to ''
as $function$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'action', p_action,
          'studioId', p_studio_id,
          'expectedRevisionId', p_expected_revision_id,
          'expectedRevisionVersion', p_expected_revision_version,
          'expectedPublicationVersion', p_expected_publication_version
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$function$;

alter function private.studio_publication_payload_hash(
  text, uuid, uuid, bigint, bigint
) owner to postgres;

create or replace function private.replay_studio_publication_command(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_payload_hash text,
  p_studio_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  existing_request private.studio_command_requests%rowtype;
  result jsonb;
begin
  select request.*
  into existing_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key;

  if not found then
    return null;
  end if;

  if existing_request.action <> p_action
    or existing_request.payload_hash <> p_payload_hash
    or existing_request.studio_id <> p_studio_id
  then
    raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
  end if;

  result := private.studio_publication_json(p_user_id, p_studio_id);
  if result is null
    or private.studio_result_hash(result) <> existing_request.result_hash
  then
    raise exception using errcode = '40001', message = 'studio_publication_result_stale';
  end if;

  return result;
end;
$function$;

alter function private.replay_studio_publication_command(
  uuid, uuid, text, text, uuid
) owner to postgres;

create or replace function private.record_studio_publication_command(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_payload_hash text,
  p_studio_id uuid,
  p_revision_id uuid,
  p_revision_version bigint,
  p_result jsonb
) returns void
  language plpgsql security definer
  set search_path to ''
as $function$
begin
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
    p_action,
    p_payload_hash,
    private.studio_result_hash(p_result),
    p_studio_id,
    p_revision_id,
    p_revision_version
  );
end;
$function$;

alter function private.record_studio_publication_command(
  uuid, uuid, text, text, uuid, uuid, bigint, jsonb
) owner to postgres;

create or replace function private.audit_studio_publication_command(
  p_user_id uuid,
  p_request_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_studio_id uuid,
  p_revision_id uuid,
  p_publication_version bigint
) returns void
  language plpgsql security definer
  set search_path to ''
as $function$
begin
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
    p_action,
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'revisionId', p_revision_id,
      'publicationVersion', p_publication_version
    )
  );
end;
$function$;

alter function private.audit_studio_publication_command(
  uuid, uuid, uuid, text, uuid, uuid, bigint
) owner to postgres;

create or replace function private.get_owner_studio_publication(
  p_user_id uuid,
  p_studio_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  select private.studio_publication_json(p_user_id, p_studio_id);
$function$;

alter function private.get_owner_studio_publication(uuid, uuid) owner to postgres;

create or replace function private.submit_studio_revision(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  checklist jsonb;
  current_revision public.studio_revisions%rowtype;
  current_studio public.studios%rowtype;
  payload_hash text;
  replayed jsonb;
  result jsonb;
  taxonomy_fence jsonb;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_submission';
  end if;

  payload_hash := private.studio_publication_payload_hash(
    'studio.revision.submit',
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version,
    null
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replayed := private.replay_studio_publication_command(
    p_user_id,
    p_idempotency_key,
    'studio.revision.submit',
    payload_hash,
    p_studio_id
  );
  if replayed is not null then
    return replayed;
  end if;

  taxonomy_fence := private.lock_active_studio_revision_taxonomy(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  );

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
  if current_studio.draft_revision_id is null
    or (
      current_studio.published_revision_id is null
      and current_studio.status not in ('draft', 'rejected')
    )
    or (
      current_studio.published_revision_id is not null
      and current_studio.status not in ('published', 'changes_pending', 'paused')
    )
  then
    raise exception using errcode = '23514', message = 'studio_submission_state_invalid';
  end if;

  if current_studio.published_revision_id is not null
    and not exists (
      select 1
      from public.studio_revisions as published_revision
      where published_revision.id = current_studio.published_revision_id
        and published_revision.studio_id = current_studio.id
        and published_revision.status = 'approved'
    )
  then
    raise exception using errcode = '23514', message = 'studio_published_state_invalid';
  end if;

  select revision.*
  into current_revision
  from public.studio_revisions as revision
  where revision.id = current_studio.draft_revision_id
    and revision.studio_id = current_studio.id
  for update;

  if not found
    or current_revision.id <> p_expected_revision_id
    or current_revision.revision_version <> p_expected_revision_version
  then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;
  if current_revision.status <> 'draft' then
    raise exception using errcode = '23514', message = 'studio_submission_state_invalid';
  end if;
  if private.studio_revision_taxonomy_fence(current_revision.id) is distinct from taxonomy_fence then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  checklist := private.studio_publication_checklist(current_revision.id);
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(checklist) as item(value)
    where not (item.value ->> 'complete')::boolean
  ) then
    raise exception using errcode = '23514', message = 'studio_submission_incomplete';
  end if;

  update public.studio_revisions as revision
  set
    status = 'pending',
    revision_version = revision.revision_version + 1
  where revision.id = current_revision.id
    and revision.status = 'draft'
    and revision.revision_version = p_expected_revision_version
  returning revision.* into current_revision;

  if not found then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  update public.studios as studio
  set status = case
    when studio.published_revision_id is null then 'pending_review'
    when studio.status = 'paused' then 'paused'
    else 'changes_pending'
  end
  where studio.id = current_studio.id;

  insert into public.studio_review_events (
    studio_id,
    revision_id,
    actor_user_id,
    event_type,
    rejection_reason
  )
  values (
    current_studio.id,
    current_revision.id,
    p_user_id,
    'submitted',
    null
  );

  insert into public.email_outbox (
    template_key,
    audience_key,
    studio_id,
    revision_id,
    deduplication_key,
    status
  )
  values (
    'studio.review.submitted',
    'studio_reviewers',
    current_studio.id,
    current_revision.id,
    'studio.review.submitted:' || current_revision.id::text,
    'pending'
  );

  result := private.studio_publication_json(p_user_id, p_studio_id);
  if result is null then
    raise exception using errcode = 'P0002', message = 'studio_submission_result_missing';
  end if;

  perform private.record_studio_publication_command(
    p_user_id,
    p_idempotency_key,
    'studio.revision.submit',
    payload_hash,
    p_studio_id,
    current_revision.id,
    current_revision.revision_version,
    result
  );
  perform private.audit_studio_publication_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.revision_submitted',
    p_studio_id,
    current_revision.id,
    (result ->> 'publicationVersion')::bigint
  );

  return result;
end;
$function$;

alter function private.submit_studio_revision(
  uuid, uuid, uuid, bigint, uuid, uuid
) owner to postgres;

create or replace function private.pause_studio(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_publication_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  current_studio public.studios%rowtype;
  payload_hash text;
  published_revision public.studio_revisions%rowtype;
  replayed jsonb;
  result jsonb;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_publication_version is null
    or p_expected_publication_version < 1
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_pause';
  end if;

  payload_hash := private.studio_publication_payload_hash(
    'studio.pause', p_studio_id, null, null, p_expected_publication_version
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replayed := private.replay_studio_publication_command(
    p_user_id,
    p_idempotency_key,
    'studio.pause',
    payload_hash,
    p_studio_id
  );
  if replayed is not null then
    return replayed;
  end if;

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
  if current_studio.publication_version <> p_expected_publication_version then
    raise exception using errcode = '40001', message = 'studio_publication_conflict';
  end if;
  if current_studio.status not in ('published', 'changes_pending')
    or current_studio.published_revision_id is null
  then
    raise exception using errcode = '23514', message = 'studio_pause_state_invalid';
  end if;

  select revision.*
  into published_revision
  from public.studio_revisions as revision
  where revision.id = current_studio.published_revision_id
    and revision.studio_id = current_studio.id;

  if not found or published_revision.status <> 'approved' then
    raise exception using errcode = '23514', message = 'studio_pause_state_invalid';
  end if;

  update public.studios as studio
  set status = 'paused'
  where studio.id = current_studio.id
    and studio.publication_version = p_expected_publication_version;

  if not found then
    raise exception using errcode = '40001', message = 'studio_publication_conflict';
  end if;

  result := private.studio_publication_json(p_user_id, p_studio_id);
  if result is null then
    raise exception using errcode = 'P0002', message = 'studio_pause_result_missing';
  end if;

  perform private.record_studio_publication_command(
    p_user_id,
    p_idempotency_key,
    'studio.pause',
    payload_hash,
    p_studio_id,
    published_revision.id,
    published_revision.revision_version,
    result
  );
  perform private.audit_studio_publication_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.paused',
    p_studio_id,
    published_revision.id,
    (result ->> 'publicationVersion')::bigint
  );

  return result;
end;
$function$;

alter function private.pause_studio(
  uuid, uuid, bigint, uuid, uuid
) owner to postgres;

create or replace function private.resume_studio(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_publication_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  current_studio public.studios%rowtype;
  payload_hash text;
  published_revision public.studio_revisions%rowtype;
  replayed jsonb;
  result jsonb;
  target_status text;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_publication_version is null
    or p_expected_publication_version < 1
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_resume';
  end if;

  payload_hash := private.studio_publication_payload_hash(
    'studio.resume', p_studio_id, null, null, p_expected_publication_version
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replayed := private.replay_studio_publication_command(
    p_user_id,
    p_idempotency_key,
    'studio.resume',
    payload_hash,
    p_studio_id
  );
  if replayed is not null then
    return replayed;
  end if;

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
  if current_studio.publication_version <> p_expected_publication_version then
    raise exception using errcode = '40001', message = 'studio_publication_conflict';
  end if;
  if current_studio.status <> 'paused'
    or current_studio.published_revision_id is null
  then
    raise exception using errcode = '23514', message = 'studio_resume_state_invalid';
  end if;

  select revision.*
  into published_revision
  from public.studio_revisions as revision
  where revision.id = current_studio.published_revision_id
    and revision.studio_id = current_studio.id;

  if not found or published_revision.status <> 'approved' then
    raise exception using errcode = '23514', message = 'studio_resume_state_invalid';
  end if;

  target_status := case
    when current_studio.draft_revision_id is not null
      and exists (
        select 1
        from public.studio_revisions as revision
        where revision.id = current_studio.draft_revision_id
          and revision.studio_id = current_studio.id
          and revision.status = 'pending'
      )
    then 'changes_pending'
    else 'published'
  end;

  update public.studios as studio
  set status = target_status
  where studio.id = current_studio.id
    and studio.publication_version = p_expected_publication_version;

  if not found then
    raise exception using errcode = '40001', message = 'studio_publication_conflict';
  end if;

  result := private.studio_publication_json(p_user_id, p_studio_id);
  if result is null then
    raise exception using errcode = 'P0002', message = 'studio_resume_result_missing';
  end if;

  perform private.record_studio_publication_command(
    p_user_id,
    p_idempotency_key,
    'studio.resume',
    payload_hash,
    p_studio_id,
    published_revision.id,
    published_revision.revision_version,
    result
  );
  perform private.audit_studio_publication_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.resumed',
    p_studio_id,
    published_revision.id,
    (result ->> 'publicationVersion')::bigint
  );

  return result;
end;
$function$;

alter function private.resume_studio(
  uuid, uuid, bigint, uuid, uuid
) owner to postgres;

insert into private.dal_routine_allowlist (signature)
values
  ('private.get_owner_studio_publication(uuid,uuid)'),
  ('private.submit_studio_revision(uuid,uuid,uuid,bigint,uuid,uuid)'),
  ('private.pause_studio(uuid,uuid,bigint,uuid,uuid)'),
  ('private.resume_studio(uuid,uuid,bigint,uuid,uuid)');

alter table public.studio_review_events enable row level security;
alter table public.email_outbox enable row level security;

revoke all on table public.studio_review_events
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.email_outbox
  from public, anon, authenticated, service_role, app_dal;
revoke all on sequence public.studio_review_events_event_sequence_seq
  from public, anon, authenticated, service_role, app_dal;

revoke all on function private.enforce_studio_publication_boundary()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.protect_immutable_studio_media_lifecycle()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.protect_studio_review_event()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.enforce_studio_review_event_identity()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.enforce_studio_outbox_identity()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_revision_taxonomy_fence(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.lock_active_studio_revision_taxonomy(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_publication_checklist(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_publication_revision_json(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_publication_json(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_publication_payload_hash(
  text, uuid, uuid, bigint, bigint
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.replay_studio_publication_command(
  uuid, uuid, text, text, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.record_studio_publication_command(
  uuid, uuid, text, text, uuid, uuid, bigint, jsonb
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.audit_studio_publication_command(
  uuid, uuid, uuid, text, uuid, uuid, bigint
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.get_owner_studio_publication(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.submit_studio_revision(
  uuid, uuid, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.pause_studio(uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.resume_studio(uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;

grant execute on function private.get_owner_studio_publication(uuid, uuid)
  to app_dal;
grant execute on function private.submit_studio_revision(
  uuid, uuid, uuid, bigint, uuid, uuid
) to app_dal;
grant execute on function private.pause_studio(uuid, uuid, bigint, uuid, uuid)
  to app_dal;
grant execute on function private.resume_studio(uuid, uuid, bigint, uuid, uuid)
  to app_dal;

comment on column public.studios.publication_version is
  'Fence monotônica de toda mudança de status ou ponteiro editorial do estúdio.';
comment on table public.studio_review_events is
  'Histórico editorial append-only; motivo de rejeição é dado de produto e não metadata de audit.';
comment on column public.studio_review_events.event_sequence is
  'Fence causal global e monotônica; define a ordem editorial sem depender do relógio ou de UUID.';
comment on table public.email_outbox is
  'Intenções transacionais deduplicadas; FEAT-029 acrescenta worker, tentativas e entrega real.';
comment on function private.studio_publication_checklist(uuid) is
  'Deriva completude somente de dados canônicos; catálogo arquivado ou mídia pendente impedem submissão.';
comment on function private.protect_immutable_studio_media_lifecycle() is
  'Impede que o ciclo físico da mídia altere o conteúdo de uma revisão editorial não draft.';
comment on function private.studio_publication_revision_json(uuid) is
  'Projeta uma revisão e sua capa privada para o DAL server-only assinar fora do banco.';
comment on function private.get_owner_studio_publication(uuid, uuid) is
  'Read model privado nullable do fluxo editorial, cercado por ownership e elegibilidade vigentes.';
comment on function private.submit_studio_revision(uuid, uuid, uuid, bigint, uuid, uuid) is
  'Submete uma candidata completa atomicamente com evento editorial, outbox, ledger e audit.';
comment on function private.pause_studio(uuid, uuid, bigint, uuid, uuid) is
  'Pausa uma publicação aprovada com fence monotônica e preserva ambos os ponteiros.';
comment on function private.resume_studio(uuid, uuid, bigint, uuid, uuid) is
  'Retoma publicação aprovada e deriva published ou changes_pending da candidata apontada.';
