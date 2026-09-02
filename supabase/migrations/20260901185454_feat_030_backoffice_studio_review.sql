-- FEAT-030: revisão editorial privada no backoffice.
-- A migration mantém uma única fonte editorial: studios, studio_revisions e seus eventos.

alter table public.platform_roles
  drop constraint platform_roles_role_check,
  add constraint platform_roles_role_check check (
    role = any (array['support'::text, 'reviewer'::text, 'admin'::text])
  );

comment on table public.platform_roles is
  'Papéis cumulativos de backoffice: support, reviewer e admin; sem acesso direto de runtime.';

create or replace function private.platform_roles_for_user(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.array_agg(
      platform_role.role
      order by case platform_role.role
        when 'support' then 1
        when 'reviewer' then 2
        else 3
      end
    ),
    '{}'::text[]
  )
  from public.platform_roles as platform_role
  where platform_role.user_id = p_user_id;
$function$;

alter function private.platform_roles_for_user(uuid) owner to postgres;

comment on function private.platform_roles_for_user(uuid) is
  'Retorna os papéis cumulativos support, reviewer e admin vigentes para um usuário do backoffice.';

create or replace function private.canonical_platform_roles(p_roles text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
declare
  canonical_roles text[];
begin
  if p_roles is null
    or pg_catalog.cardinality(p_roles) > 3
    or exists (
      select 1
      from pg_catalog.unnest(p_roles) as candidate(role)
      where candidate.role is null
        or candidate.role <> all (
          array['support'::text, 'reviewer'::text, 'admin'::text]
        )
    )
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_roles';
  end if;

  select coalesce(
    pg_catalog.array_agg(
      candidate.role
      order by case candidate.role
        when 'support' then 1
        when 'reviewer' then 2
        else 3
      end
    ),
    '{}'::text[]
  )
  into canonical_roles
  from (
    select distinct expanded.role
    from pg_catalog.unnest(p_roles) as expanded(role)
  ) as candidate;

  if pg_catalog.cardinality(canonical_roles) <> pg_catalog.cardinality(p_roles) then
    raise exception using errcode = '22023', message = 'invalid_backoffice_roles';
  end if;

  return canonical_roles;
end;
$function$;

alter function private.canonical_platform_roles(text[]) owner to postgres;

create or replace function private.backoffice_session_context(
  p_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_required_role text,
  p_require_strong_authentication boolean,
  p_touch_activity boolean
)
returns table (
  actor_role text,
  authorization_version bigint,
  roles text[],
  expires_at timestamptz,
  strong_authentication_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  checked_at timestamptz := pg_catalog.clock_timestamp();
  current_authorization_version bigint;
  binding private.backoffice_sessions%rowtype;
  canonical_not_after timestamptz;
  current_roles text[];
begin
  if pg_catalog.current_setting('app.settings.jwt_exp', true) is distinct from '3600' then
    raise exception using errcode = '55000', message = 'backoffice_jwt_expiry_not_pinned';
  end if;
  if p_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_auth_expires_at <= checked_at
    or p_auth_expires_at > checked_at + interval '65 minutes'
    or p_required_role is null
    or p_required_role <> all (
      array['backoffice'::text, 'support'::text, 'reviewer'::text, 'admin'::text]
    )
    or p_require_strong_authentication is null
    or p_touch_activity is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_session';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0)
  );

  if p_touch_activity then
    select session_binding.*
    into binding
    from private.backoffice_sessions as session_binding
    where session_binding.auth_session_id = p_auth_session_id
      and session_binding.user_id = p_user_id
    for update;
  else
    select session_binding.*
    into binding
    from private.backoffice_sessions as session_binding
    where session_binding.auth_session_id = p_auth_session_id
      and session_binding.user_id = p_user_id
    for share;
  end if;

  if not found then
    raise exception using errcode = '42501', message = 'backoffice_session_expired';
  end if;

  checked_at := greatest(checked_at, binding.last_seen_at);
  if binding.closed_at is not null
    or binding.last_seen_at + interval '30 minutes' <= checked_at
    or binding.absolute_expires_at <= checked_at
  then
    raise exception using errcode = '42501', message = 'backoffice_session_expired';
  end if;

  select auth_session.not_after
  into canonical_not_after
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
    and (auth_session.not_after is null or auth_session.not_after > checked_at)
  for key share;

  if not found then
    raise exception using errcode = '42501', message = 'backoffice_auth_session_invalid';
  end if;

  select profile.account_version
  into current_authorization_version
  from public.profiles as profile
  where profile.id = p_user_id
    and profile.status = 'active'
    and profile.completed_at is not null
  for share;

  if not found then
    raise exception using errcode = '42501', message = 'backoffice_profile_ineligible';
  end if;

  current_roles := private.platform_roles_for_user(p_user_id);
  if pg_catalog.cardinality(current_roles) = 0
    or (
      p_required_role <> 'backoffice'
      and not p_required_role = any(current_roles)
      and not 'admin' = any(current_roles)
    )
  then
    raise exception using errcode = '42501', message = 'backoffice_role_required';
  end if;

  if p_require_strong_authentication
    and binding.opened_at + interval '5 minutes' <= checked_at
  then
    raise exception using errcode = '42501', message = 'backoffice_reauthentication_required';
  end if;

  if p_touch_activity then
    update private.backoffice_sessions as session_binding
    set last_seen_at = checked_at
    where session_binding.auth_session_id = p_auth_session_id;
  end if;

  return query
  select
    case
      when p_required_role = 'admin' then 'admin'::text
      when p_required_role in ('support', 'reviewer')
        and p_required_role = any(current_roles)
        then p_required_role
      when p_required_role in ('support', 'reviewer') then 'admin'::text
      when 'admin' = any(current_roles) then 'admin'::text
      when 'reviewer' = any(current_roles) then 'reviewer'::text
      else 'support'::text
    end,
    current_authorization_version,
    current_roles,
    least(
      binding.absolute_expires_at,
      coalesce(canonical_not_after, binding.absolute_expires_at),
      p_auth_expires_at
    ),
    binding.opened_at + interval '5 minutes';
end;
$function$;

alter function private.backoffice_session_context(
  uuid, uuid, timestamptz, text, boolean, boolean
) owner to postgres;

comment on function private.backoffice_session_context(
  uuid, uuid, timestamptz, text, boolean, boolean
) is
  'Valida binding, perfil e papel explícito; admin substitui deliberadamente support/reviewer.';

create or replace function private.get_backoffice_session(
  p_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz
)
returns table (
  scope uuid,
  authorization_version bigint,
  roles text[],
  expires_at timestamptz,
  strong_authentication_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  context record;
begin
  select *
  into strict context
  from private.backoffice_session_context(
    p_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'backoffice',
    false,
    false
  );
  return query
  select
    p_user_id,
    context.authorization_version,
    context.roles,
    context.expires_at,
    context.strong_authentication_expires_at;
end;
$function$;

alter function private.get_backoffice_session(uuid, uuid, timestamptz) owner to postgres;

create or replace function private.list_backoffice_users(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_query text,
  p_cursor_created_at timestamptz,
  p_cursor_id uuid,
  p_limit integer
)
returns table (
  account_version bigint,
  created_at timestamptz,
  email_masked text,
  id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_query text := nullif(pg_catalog.btrim(p_query), '');
begin
  perform private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'support',
    false,
    true
  );
  if (p_cursor_created_at is null) <> (p_cursor_id is null)
    or p_limit is null
    or p_limit < 1
    or p_limit > 51
    or (normalized_query is not null and pg_catalog.char_length(normalized_query) > 160)
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_user_query';
  end if;

  return query
  select
    profile.account_version,
    profile.created_at,
    private.mask_backoffice_email(auth_user.email),
    profile.id,
    profile.status
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where auth_user.email is not null
    and (
      normalized_query is null
      or pg_catalog.starts_with(
        pg_catalog.lower(auth_user.email),
        pg_catalog.lower(normalized_query)
      )
      or profile.id::text = normalized_query
    )
    and (
      p_cursor_created_at is null
      or (profile.created_at, profile.id) < (p_cursor_created_at, p_cursor_id)
    )
  order by profile.created_at desc, profile.id desc
  limit p_limit;
end;
$function$;

alter function private.list_backoffice_users(
  uuid, uuid, timestamptz, text, timestamptz, uuid, integer
) owner to postgres;

do $block$
begin
  if exists (select 1 from public.studios where status = 'disabled') then
    raise exception using
      errcode = '55000',
      message = 'legacy_disabled_studio_requires_explicit_restore_source';
  end if;
end;
$block$;

alter table public.studios
  add column disabled_from_status text,
  add constraint studios_disabled_from_status_check check (
    (
      status = 'disabled'
      and disabled_from_status = any (
        array['published'::text, 'changes_pending'::text, 'paused'::text]
      )
    )
    or (status <> 'disabled' and disabled_from_status is null)
  );

alter table public.studios
  drop constraint studios_publication_pointer_state_check,
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
    or (
      status = 'disabled'
      and published_revision_id is not null
      and (
        disabled_from_status <> 'changes_pending'
        or draft_revision_id is not null
      )
    )
  );

comment on column public.studios.disabled_from_status is
  'Fonte explícita e única da restauração administrativa; nunca é inferida de ponteiros ou audit.';

create table private.studio_review_transition_fences (
  revision_id uuid primary key,
  studio_id uuid not null,
  target_status text not null,
  transaction_id xid8 not null,
  backend_pid integer not null,
  constraint studio_review_transition_fences_revision_id_fkey foreign key (revision_id)
    references public.studio_revisions (id) on delete cascade,
  constraint studio_review_transition_fences_studio_id_fkey foreign key (studio_id)
    references public.studios (id) on delete cascade,
  constraint studio_review_transition_fences_target_status_check check (
    target_status = any (array['approved'::text, 'rejected'::text, 'superseded'::text])
  ),
  constraint studio_review_transition_fences_backend_pid_check check (backend_pid > 0)
);

alter table private.studio_review_transition_fences owner to postgres;
alter table private.studio_review_transition_fences enable row level security;
revoke all on table private.studio_review_transition_fences
  from public, anon, authenticated, service_role, app_dal;

create or replace function private.enforce_studio_publication_boundary() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  boundary_changed boolean;
begin
  boundary_changed := new.status is distinct from old.status
    or new.published_revision_id is distinct from old.published_revision_id
    or new.draft_revision_id is distinct from old.draft_revision_id
    or new.disabled_from_status is distinct from old.disabled_from_status;

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

  if old.status <> 'disabled' and new.status = 'disabled' then
    if old.status not in ('published', 'changes_pending', 'paused')
      or new.disabled_from_status is distinct from old.status
      or new.published_revision_id is distinct from old.published_revision_id
      or new.draft_revision_id is distinct from old.draft_revision_id
    then
      raise exception using errcode = '23514', message = 'studio_disable_transition_invalid';
    end if;
  elsif old.status = 'disabled' and new.status <> 'disabled' then
    if new.status is distinct from old.disabled_from_status
      or new.disabled_from_status is not null
      or new.published_revision_id is distinct from old.published_revision_id
      or new.draft_revision_id is distinct from old.draft_revision_id
    then
      raise exception using errcode = '23514', message = 'studio_restore_transition_invalid';
    end if;
  elsif old.status = 'disabled' and new.status = 'disabled' then
    if new.disabled_from_status is distinct from old.disabled_from_status
      or new.published_revision_id is distinct from old.published_revision_id
      or new.draft_revision_id is distinct from old.draft_revision_id
    then
      raise exception using errcode = '23514', message = 'studio_disabled_state_immutable';
    end if;
  elsif new.disabled_from_status is not null then
    raise exception using errcode = '23514', message = 'studio_disabled_source_invalid';
  elsif old.status is distinct from new.status
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

drop trigger studios_enforce_publication_boundary on public.studios;
create trigger studios_enforce_publication_boundary
  before update of status, published_revision_id, draft_revision_id,
    disabled_from_status, publication_version
  on public.studios
  for each row execute function private.enforce_studio_publication_boundary();

create or replace function private.enforce_studio_revision_immutability() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  transition_is_fenced boolean := false;
begin
  if tg_op = 'DELETE' and not exists (
    select 1
    from public.studios as studio
    where studio.id = old.studio_id
  ) then
    return old;
  end if;

  if tg_op = 'UPDATE' and (
    (old.status = 'pending' and new.status in ('approved', 'rejected'))
    or (old.status = 'approved' and new.status = 'superseded')
  ) then
    select exists (
      select 1
      from private.studio_review_transition_fences as fence
      where fence.revision_id = old.id
        and fence.studio_id = old.studio_id
        and fence.target_status = new.status
        and fence.transaction_id = pg_catalog.pg_current_xact_id()
        and fence.backend_pid = pg_catalog.pg_backend_pid()
    )
    into transition_is_fenced;

    if transition_is_fenced
      and new.id is not distinct from old.id
      and new.studio_id is not distinct from old.studio_id
      and new.revision_number is not distinct from old.revision_number
      and new.name is not distinct from old.name
      and new.description is not distinct from old.description
      and new.street is not distinct from old.street
      and new.street_number is not distinct from old.street_number
      and new.address_complement is not distinct from old.address_complement
      and new.neighborhood is not distinct from old.neighborhood
      and new.city is not distinct from old.city
      and new.state is not distinct from old.state
      and new.postal_code is not distinct from old.postal_code
      and new.capacity is not distinct from old.capacity
      and new.studio_type_id is not distinct from old.studio_type_id
      and new.usage_rules is not distinct from old.usage_rules
      and new.youtube_video_id is not distinct from old.youtube_video_id
      and new.created_at is not distinct from old.created_at
      and new.revision_version = old.revision_version + 1
    then
      new.updated_at := pg_catalog.clock_timestamp();
      return new;
    end if;
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

alter table private.backoffice_command_requests
  drop constraint backoffice_command_requests_action_check,
  add constraint backoffice_command_requests_action_check check (
    action = any (array[
      'backoffice.user.restore'::text,
      'backoffice.user.suspend'::text,
      'backoffice.user.revealPii'::text,
      'backoffice.access.grantAdmin'::text,
      'backoffice.access.grantReviewer'::text,
      'backoffice.access.grantSupport'::text,
      'backoffice.access.revokeAdmin'::text,
      'backoffice.access.revokeReviewer'::text,
      'backoffice.access.revokeSupport'::text,
      'backoffice.taxonomy.upsert'::text,
      'backoffice.taxonomy.setActive'::text,
      'backoffice.taxonomy.archive'::text,
      'backoffice.taxonomy.reactivate'::text,
      'backoffice.studio.approve'::text,
      'backoffice.studio.reject'::text,
      'backoffice.studio.disable'::text,
      'backoffice.studio.restore'::text
    ])
  ),
  drop constraint backoffice_command_requests_target_type_check,
  add constraint backoffice_command_requests_target_type_check check (
    target_type = any (array[
      'profile'::text,
      'platform_role'::text,
      'studio_type'::text,
      'tag'::text,
      'amenity'::text,
      'studio'::text
    ])
  );

alter table audit.events
  drop constraint events_actor_role_check,
  add constraint events_actor_role_check check (
    actor_role = any (array[
      'authenticated'::text,
      'support'::text,
      'reviewer'::text,
      'admin'::text,
      'system'::text
    ])
  ),
  drop constraint events_action_check,
  add constraint events_action_check check (
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
      'backoffice.taxonomy_reactivated'::text,
      'backoffice.studio_approved'::text,
      'backoffice.studio_rejected'::text,
      'backoffice.studio_disabled'::text,
      'backoffice.studio_restored'::text
    ])
  );

alter table public.email_outbox
  drop constraint email_outbox_template_key_check,
  add constraint email_outbox_template_key_check check (
    template_key = any (array[
      'studio.review.submitted'::text,
      'studio.review.approved'::text,
      'studio.review.rejected'::text
    ])
  ),
  drop constraint email_outbox_audience_key_check,
  add constraint email_outbox_audience_key_check check (
    audience_key = any (array['studio_reviewers'::text, 'studio_owner'::text])
  );

create or replace function private.enforce_studio_outbox_identity() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  expected_audience text;
  expected_event_type text;
begin
  expected_event_type := case new.template_key
    when 'studio.review.submitted' then 'submitted'
    when 'studio.review.approved' then 'approved'
    when 'studio.review.rejected' then 'rejected'
    else null
  end;
  expected_audience := case new.template_key
    when 'studio.review.submitted' then 'studio_reviewers'
    when 'studio.review.approved' then 'studio_owner'
    when 'studio.review.rejected' then 'studio_owner'
    else null
  end;

  if expected_event_type is null
    or new.audience_key is distinct from expected_audience
    or not exists (
      select 1
      from public.studio_review_events as review
      where review.studio_id = new.studio_id
        and review.revision_id = new.revision_id
        and review.event_type = expected_event_type
    )
  then
    raise exception using errcode = '23514', message = 'studio_outbox_event_missing';
  end if;
  return new;
end;
$function$;

alter function private.enforce_studio_outbox_identity() owner to postgres;

create or replace function private.backoffice_studio_revision_json(
  p_revision_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  select
    (private.studio_publication_revision_json(p_revision_id) - 'cover')
    || pg_catalog.jsonb_build_object(
      'media', coalesce((
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
        where relation.revision_id = p_revision_id
          and media.status = 'ready'
      ), '[]'::jsonb)
    );
$function$;

alter function private.backoffice_studio_revision_json(uuid) owner to postgres;

create or replace function private.list_backoffice_studio_reviews(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_cursor_sequence bigint,
  p_cursor_studio_id uuid,
  p_limit integer
)
returns table (
  disabled_from_status text,
  has_published boolean,
  name text,
  publication_version bigint,
  review_state text,
  revision_id uuid,
  sort_sequence bigint,
  studio_id uuid,
  studio_status text,
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_context record;
begin
  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'reviewer',
    false,
    true
  );

  if (p_cursor_sequence is null) <> (p_cursor_studio_id is null)
    or (p_cursor_sequence is not null and p_cursor_sequence < 0)
    or p_limit is null
    or p_limit < 1
    or p_limit > 51
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_studio_query';
  end if;

  return query
  select
    queue.disabled_from_status,
    queue.has_published,
    queue.name,
    queue.publication_version,
    queue.review_state,
    queue.revision_id,
    queue.sort_sequence,
    queue.studio_id,
    queue.studio_status,
    queue.submitted_at
  from (
    select
      null::text as disabled_from_status,
      studio.published_revision_id is not null as has_published,
      revision.name,
      studio.publication_version,
      'reviewPending'::text as review_state,
      revision.id as revision_id,
      submitted.event_sequence as sort_sequence,
      studio.id as studio_id,
      studio.status as studio_status,
      submitted.occurred_at as submitted_at
    from public.studios as studio
    join public.studio_revisions as revision
      on revision.id = studio.draft_revision_id
      and revision.studio_id = studio.id
      and revision.status = 'pending'
    join public.studio_review_events as submitted
      on submitted.studio_id = studio.id
      and submitted.revision_id = revision.id
      and submitted.event_type = 'submitted'
    where studio.status in ('pending_review', 'changes_pending', 'paused')

    union all

    select
      null::text,
      true,
      revision.name,
      studio.publication_version,
      'moderation'::text,
      revision.id,
      coalesce(latest.event_sequence, 0::bigint),
      studio.id,
      studio.status,
      submitted.occurred_at
    from public.studios as studio
    join public.studio_revisions as revision
      on revision.id = studio.published_revision_id
      and revision.studio_id = studio.id
    left join lateral (
      select review.event_sequence
      from public.studio_review_events as review
      where review.studio_id = studio.id
      order by review.event_sequence desc
      limit 1
    ) as latest on true
    left join public.studio_review_events as submitted
      on submitted.studio_id = studio.id
      and submitted.revision_id = revision.id
      and submitted.event_type = 'submitted'
    where studio.status in ('published', 'changes_pending', 'paused')
      and 'admin' = any(actor_context.roles)
      and not exists (
        select 1
        from public.studio_revisions as pending_revision
        where pending_revision.id = studio.draft_revision_id
          and pending_revision.studio_id = studio.id
          and pending_revision.status = 'pending'
      )

    union all

    select
      studio.disabled_from_status,
      true,
      revision.name,
      studio.publication_version,
      'disabled'::text,
      revision.id,
      coalesce(latest.event_sequence, 0::bigint),
      studio.id,
      studio.status,
      submitted.occurred_at
    from public.studios as studio
    join public.studio_revisions as revision
      on revision.id = studio.published_revision_id
      and revision.studio_id = studio.id
    left join lateral (
      select review.event_sequence
      from public.studio_review_events as review
      where review.studio_id = studio.id
      order by review.event_sequence desc
      limit 1
    ) as latest on true
    left join public.studio_review_events as submitted
      on submitted.studio_id = studio.id
      and submitted.revision_id = revision.id
      and submitted.event_type = 'submitted'
    where studio.status = 'disabled'
      and 'admin' = any(actor_context.roles)
  ) as queue
  where p_cursor_sequence is null
    or (queue.sort_sequence, queue.studio_id) < (p_cursor_sequence, p_cursor_studio_id)
  order by queue.sort_sequence desc, queue.studio_id desc
  limit p_limit;
end;
$function$;

alter function private.list_backoffice_studio_reviews(
  uuid, uuid, timestamptz, bigint, uuid, integer
) owner to postgres;

create or replace function private.get_backoffice_studio_review(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_studio_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  actor_context record;
  candidate_is_pending boolean;
  current_studio public.studios%rowtype;
  review_checklist jsonb;
  selected_revision_id uuid;
  submitted_event public.studio_review_events%rowtype;
begin
  if p_studio_id is null then
    raise exception using errcode = '22023', message = 'invalid_backoffice_studio_review';
  end if;

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'reviewer',
    false,
    true
  );

  select studio.*
  into current_studio
  from public.studios as studio
  where studio.id = p_studio_id
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_studio_review_missing';
  end if;

  if current_studio.status = 'disabled' then
    if not 'admin' = any(actor_context.roles) then
      raise exception using errcode = 'P0002', message = 'backoffice_studio_review_missing';
    end if;
    selected_revision_id := current_studio.published_revision_id;
  elsif current_studio.status in ('pending_review', 'changes_pending', 'paused')
    and exists (
      select 1
      from public.studio_revisions as revision
      where revision.id = current_studio.draft_revision_id
        and revision.studio_id = current_studio.id
        and revision.status = 'pending'
    )
  then
    selected_revision_id := current_studio.draft_revision_id;
  elsif current_studio.status in ('published', 'changes_pending', 'paused')
    and 'admin' = any(actor_context.roles)
  then
    selected_revision_id := current_studio.published_revision_id;
  else
    raise exception using errcode = 'P0002', message = 'backoffice_studio_review_missing';
  end if;

  perform revision.id
  from public.studio_revisions as revision
  where revision.id in (
    selected_revision_id,
    current_studio.published_revision_id,
    current_studio.draft_revision_id
  )
    and revision.studio_id = current_studio.id
  order by revision.id
  for share;

  select revision.status = 'pending'
  into candidate_is_pending
  from public.studio_revisions as revision
  where revision.id = selected_revision_id
    and revision.studio_id = current_studio.id;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_studio_review_missing';
  end if;

  select review.*
  into submitted_event
  from public.studio_review_events as review
  where review.studio_id = current_studio.id
    and review.revision_id = selected_revision_id
    and review.event_type = 'submitted';

  if candidate_is_pending and not found then
    raise exception using errcode = 'P0002', message = 'backoffice_studio_review_missing';
  end if;

  review_checklist := private.studio_publication_checklist(selected_revision_id);

  return pg_catalog.jsonb_build_object(
    'canApprove', candidate_is_pending
      and current_studio.status <> 'disabled'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(review_checklist) as item(value)
        where not (item.value ->> 'complete')::boolean
      ),
    'canDisable', 'admin' = any(actor_context.roles)
      and current_studio.status in ('published', 'changes_pending', 'paused'),
    'canReject', candidate_is_pending and current_studio.status <> 'disabled',
    'canRestore', 'admin' = any(actor_context.roles)
      and current_studio.status = 'disabled',
    'candidateRevision', private.backoffice_studio_revision_json(selected_revision_id),
    'checklist', review_checklist,
    'disabledFromStatus', current_studio.disabled_from_status,
    'previewExpiresAt', null,
    'publicationVersion', current_studio.publication_version,
    'publishedRevision', case
      when current_studio.published_revision_id is null then null
      else private.backoffice_studio_revision_json(current_studio.published_revision_id)
    end,
    'reviewState', case
      when current_studio.status = 'disabled' then 'disabled'
      when candidate_is_pending then 'reviewPending'
      else 'moderation'
    end,
    'scope', p_actor_user_id,
    'studioId', current_studio.id,
    'studioStatus', current_studio.status,
    'submittedAt', submitted_event.occurred_at
  );
end;
$function$;

alter function private.get_backoffice_studio_review(
  uuid, uuid, timestamptz, uuid
) owner to postgres;

create or replace function private.can_sign_backoffice_studio_media(
  p_object_name text
) returns boolean
  language plpgsql stable security definer
  set search_path to ''
as $function$
declare
  caller_claims jsonb := (select auth.jwt());
  caller_session_id uuid;
  caller_user_id uuid := (select auth.uid());
begin
  if p_object_name is null or p_object_name = '' then
    return false;
  end if;

  begin
    caller_session_id := nullif(caller_claims ->> 'session_id', '')::uuid;
  exception
    when invalid_text_representation then
      return false;
  end;

  if caller_user_id is null
    or caller_session_id is null
    or caller_claims ->> 'sub' is distinct from caller_user_id::text
    or caller_claims ->> 'role' is distinct from 'authenticated'
  then
    return false;
  end if;

  return exists (
    select 1
    from private.backoffice_sessions as session_binding
    join auth.sessions as auth_session
      on auth_session.id = session_binding.auth_session_id
      and auth_session.user_id = session_binding.user_id
    join public.profiles as profile on profile.id = session_binding.user_id
    join public.platform_roles as platform_role on platform_role.user_id = profile.id
    join public.studio_media as media on media.preview_storage_path = p_object_name
    join public.studio_revision_media as relation on relation.media_id = media.id
    join public.studios as studio on studio.id = media.studio_id
    where session_binding.user_id = caller_user_id
      and session_binding.auth_session_id = caller_session_id
      and session_binding.closed_at is null
      and session_binding.last_seen_at + interval '30 minutes' > pg_catalog.now()
      and session_binding.absolute_expires_at > pg_catalog.now()
      and (auth_session.not_after is null or auth_session.not_after > pg_catalog.now())
      and profile.status = 'active'
      and profile.completed_at is not null
      and platform_role.role in ('reviewer', 'admin')
      and media.status = 'ready'
      and (
        (
          studio.status in ('pending_review', 'changes_pending', 'paused')
          and exists (
            select 1
            from public.studio_revisions as candidate
            where candidate.id = studio.draft_revision_id
              and candidate.studio_id = studio.id
              and candidate.status = 'pending'
          )
          and relation.revision_id in (
            studio.draft_revision_id,
            studio.published_revision_id
          )
        )
        or (
          studio.status in ('published', 'changes_pending', 'paused')
          and platform_role.role = 'admin'
          and relation.revision_id = studio.published_revision_id
        )
        or (
          studio.status = 'disabled'
          and platform_role.role = 'admin'
          and relation.revision_id = studio.published_revision_id
        )
      )
  );
end;
$function$;

alter function private.can_sign_backoffice_studio_media(text) owner to postgres;

revoke all on function private.can_sign_backoffice_studio_media(text)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function private.can_sign_backoffice_studio_media(text)
  to authenticated;

grant select on table storage.objects to authenticated;

create policy studio_media_select_backoffice_review
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'studio-media'
    and storage.allow_only_operation('storage.object.sign_many')
    and private.can_sign_backoffice_studio_media(name)
  );

create or replace function private.set_backoffice_user_status(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_target_user_id uuid,
  p_expected_account_version bigint,
  p_action text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_context record;
  current_profile public.profiles%rowtype;
  existing_request private.backoffice_command_requests%rowtype;
  payload_hash text;
  result jsonb;
  target_status text;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_target_user_id is null
    or p_expected_account_version is null
    or p_expected_account_version < 0
    or p_action is null
    or p_action <> all (
      array['backoffice.user.restore'::text, 'backoffice.user.suspend'::text]
    )
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_user_status';
  end if;

  target_status := case p_action
    when 'backoffice.user.suspend' then 'suspended'
    else 'active'
  end;

  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'expectedAccountVersion', p_expected_account_version,
      'userId', p_target_user_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0)
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'support',
    false,
    true
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_actor_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select request.*
  into existing_request
  from private.backoffice_command_requests as request
  where request.actor_user_id = p_actor_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> p_action
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> 'profile'
      or existing_request.target_id <> p_target_user_id
    then
      raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
    end if;

    perform 1
    from public.profiles as profile
    where profile.id = p_target_user_id
    for share;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_user_status_result_missing';
    end if;
    perform 1
    from auth.users as auth_user
    where auth_user.id = p_target_user_id
      and auth_user.email is not null
    for share;
    result := private.backoffice_user_summary_json(p_target_user_id);
    if private.backoffice_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'backoffice_user_status_result_stale';
    end if;
    return result;
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_target_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
  if current_profile.account_version <> p_expected_account_version then
    raise exception using errcode = '40001', message = 'backoffice_account_version_conflict';
  end if;
  if current_profile.status = target_status then
    raise exception using errcode = '23514', message = 'backoffice_user_status_unchanged';
  end if;

  if target_status = 'suspended'
    and exists (
      select 1
      from public.platform_roles as platform_role
      where platform_role.user_id = p_target_user_id
        and platform_role.role = 'admin'
    )
    and not exists (
      select 1
      from public.platform_roles as platform_role
      join public.profiles as profile on profile.id = platform_role.user_id
      where platform_role.role = 'admin'
        and platform_role.user_id <> p_target_user_id
        and profile.status = 'active'
        and profile.completed_at is not null
    )
  then
    raise exception using errcode = '23514', message = 'backoffice_last_active_admin_required';
  end if;

  update public.profiles as profile
  set status = target_status
  where profile.id = p_target_user_id
    and profile.account_version = p_expected_account_version
  returning profile.* into current_profile;

  if not found then
    raise exception using errcode = '40001', message = 'backoffice_account_version_conflict';
  end if;

  if target_status = 'suspended' then
    update private.backoffice_sessions as session_binding
    set closed_at = coalesce(session_binding.closed_at, pg_catalog.clock_timestamp())
    where session_binding.user_id = p_target_user_id;
  end if;

  perform 1
  from auth.users as auth_user
  where auth_user.id = p_target_user_id
    and auth_user.email is not null
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;

  result := private.backoffice_user_summary_json(p_target_user_id);

  insert into private.backoffice_command_requests (
    actor_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    target_type,
    target_id
  )
  values (
    p_actor_user_id,
    p_idempotency_key,
    p_action,
    payload_hash,
    private.backoffice_result_hash(result),
    'profile',
    p_target_user_id
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
    p_actor_user_id,
    actor_context.actor_role,
    case
      when target_status = 'suspended' then 'backoffice.user_suspended'
      else 'backoffice.user_restored'
    end,
    'profile',
    p_target_user_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'accountVersion', current_profile.account_version,
      'previousStatus', case when target_status = 'suspended' then 'active' else 'suspended' end,
      'status', target_status
    )
  );

  return result;
end;
$function$;

alter function private.set_backoffice_user_status(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) owner to postgres;

create or replace function private.reveal_backoffice_user_pii(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_target_user_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_context record;
  auth_updated_at timestamptz;
  existing_request private.backoffice_command_requests%rowtype;
  payload_hash text;
  profile_version bigint;
  result jsonb;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_target_user_id is null
    or p_reason is null
    or p_reason <> all (array[
      'identity_verification'::text,
      'legal_request'::text,
      'security_investigation'::text,
      'support_case'::text
    ])
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_pii_reveal';
  end if;

  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'reason', p_reason,
      'userId', p_target_user_id
    )
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'support',
    false,
    true
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_actor_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select request.*
  into existing_request
  from private.backoffice_command_requests as request
  where request.actor_user_id = p_actor_user_id
    and request.idempotency_key = p_idempotency_key;

  if found
    and (
      existing_request.action <> 'backoffice.user.revealPii'
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> 'profile'
      or existing_request.target_id <> p_target_user_id
    )
  then
    raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
  end if;

  select
    profile.profile_version,
    coalesce(auth_user.updated_at, auth_user.created_at)
  into profile_version, auth_updated_at
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
    and auth_user.email is not null
  for share of profile, auth_user;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;

  result := private.backoffice_user_pii_json(p_actor_user_id, p_target_user_id);

  if existing_request.actor_user_id is not null then
    if existing_request.result_profile_version <> profile_version
      or existing_request.result_auth_updated_at <> auth_updated_at
    then
      raise exception using errcode = '40001', message = 'backoffice_pii_result_stale';
    end if;
    return result;
  end if;

  insert into private.backoffice_command_requests (
    actor_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    target_type,
    target_id,
    result_profile_version,
    result_auth_updated_at
  )
  values (
    p_actor_user_id,
    p_idempotency_key,
    'backoffice.user.revealPii',
    payload_hash,
    null,
    'profile',
    p_target_user_id,
    profile_version,
    auth_updated_at
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
    p_actor_user_id,
    actor_context.actor_role,
    'backoffice.user_pii_revealed',
    'profile',
    p_target_user_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object('reason', p_reason)
  );

  return result;
end;
$function$;

alter function private.reveal_backoffice_user_pii(
  uuid, uuid, timestamptz, uuid, text, uuid, uuid
) owner to postgres;

create or replace function private.set_backoffice_user_role(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_target_user_id uuid,
  p_expected_account_version bigint,
  p_action text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_context record;
  current_profile public.profiles%rowtype;
  current_roles text[];
  enabled boolean;
  existing_request private.backoffice_command_requests%rowtype;
  payload_hash text;
  result jsonb;
  role_to_change text;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_target_user_id is null
    or p_expected_account_version is null
    or p_expected_account_version < 0
    or p_action is null
    or p_action <> all (array[
      'backoffice.access.grantAdmin'::text,
      'backoffice.access.grantReviewer'::text,
      'backoffice.access.grantSupport'::text,
      'backoffice.access.revokeAdmin'::text,
      'backoffice.access.revokeReviewer'::text,
      'backoffice.access.revokeSupport'::text
    ])
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_role_change';
  end if;

  role_to_change := case
    when p_action in ('backoffice.access.grantAdmin', 'backoffice.access.revokeAdmin')
      then 'admin'
    when p_action in ('backoffice.access.grantReviewer', 'backoffice.access.revokeReviewer')
      then 'reviewer'
    else 'support'
  end;
  enabled := p_action in (
    'backoffice.access.grantAdmin',
    'backoffice.access.grantReviewer',
    'backoffice.access.grantSupport'
  );
  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'expectedAccountVersion', p_expected_account_version,
      'userId', p_target_user_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0)
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
    true,
    true
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_actor_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select request.*
  into existing_request
  from private.backoffice_command_requests as request
  where request.actor_user_id = p_actor_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> p_action
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> 'platform_role'
      or existing_request.target_id <> p_target_user_id
    then
      raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
    end if;

    perform 1
    from public.profiles as profile
    where profile.id = p_target_user_id
    for share;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_role_result_missing';
    end if;
    perform 1
    from auth.users as auth_user
    where auth_user.id = p_target_user_id
      and auth_user.email is not null
    for share;
    result := private.backoffice_user_summary_json(p_target_user_id);
    if private.backoffice_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'backoffice_role_result_stale';
    end if;
    return result;
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_target_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
  if current_profile.account_version <> p_expected_account_version then
    raise exception using errcode = '40001', message = 'backoffice_roles_conflict';
  end if;
  if enabled
    and (current_profile.status <> 'active' or current_profile.completed_at is null)
  then
    raise exception using errcode = '42501', message = 'backoffice_role_target_ineligible';
  end if;

  current_roles := private.platform_roles_for_user(p_target_user_id);
  if enabled = (role_to_change = any(current_roles)) then
    raise exception using errcode = '23514', message = 'backoffice_role_unchanged';
  end if;

  if not enabled
    and role_to_change = 'admin'
    and current_profile.status = 'active'
    and current_profile.completed_at is not null
    and not exists (
      select 1
      from public.platform_roles as platform_role
      join public.profiles as profile on profile.id = platform_role.user_id
      where platform_role.role = 'admin'
        and platform_role.user_id <> p_target_user_id
        and profile.status = 'active'
        and profile.completed_at is not null
    )
  then
    raise exception using errcode = '23514', message = 'backoffice_last_active_admin_required';
  end if;

  if enabled then
    insert into public.platform_roles (user_id, role, granted_by)
    values (p_target_user_id, role_to_change, p_actor_user_id);
  else
    delete from public.platform_roles as platform_role
    where platform_role.user_id = p_target_user_id
      and platform_role.role = role_to_change;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_roles_conflict';
    end if;
  end if;

  current_roles := private.platform_roles_for_user(p_target_user_id);
  if pg_catalog.cardinality(current_roles) = 0 then
    update private.backoffice_sessions as session_binding
    set closed_at = coalesce(session_binding.closed_at, pg_catalog.clock_timestamp())
    where session_binding.user_id = p_target_user_id;
  end if;

  perform 1
  from auth.users as auth_user
  where auth_user.id = p_target_user_id
    and auth_user.email is not null
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;

  result := private.backoffice_user_summary_json(p_target_user_id);

  insert into private.backoffice_command_requests (
    actor_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    target_type,
    target_id
  )
  values (
    p_actor_user_id,
    p_idempotency_key,
    p_action,
    payload_hash,
    private.backoffice_result_hash(result),
    'platform_role',
    p_target_user_id
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
    p_actor_user_id,
    actor_context.actor_role,
    case
      when enabled then 'backoffice.role_granted'
      else 'backoffice.role_revoked'
    end,
    'platform_role',
    p_target_user_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'role', role_to_change,
      'roles', pg_catalog.to_jsonb(current_roles)
    )
  );

  return result;
end;
$function$;

alter function private.set_backoffice_user_role(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) owner to postgres;

create or replace function private.backoffice_studio_command_result_json(
  p_actor_user_id uuid,
  p_action text,
  p_studio_id uuid,
  p_revision_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  select pg_catalog.jsonb_build_object(
    'action', p_action,
    'disabledFromStatus', studio.disabled_from_status,
    'draftRevisionId', studio.draft_revision_id,
    'publicationVersion', studio.publication_version,
    'publishedRevisionId', studio.published_revision_id,
    'revisionId', p_revision_id,
    'scope', p_actor_user_id,
    'studioId', studio.id,
    'studioStatus', studio.status
  )
  from public.studios as studio
  where studio.id = p_studio_id;
$function$;

alter function private.backoffice_studio_command_result_json(
  uuid, text, uuid, uuid
) owner to postgres;

create or replace function private.execute_backoffice_studio_command(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_publication_version bigint,
  p_action text,
  p_rejection_reason text,
  p_idempotency_key uuid,
  p_request_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  actor_context record;
  affected_revision_id uuid;
  candidate_revision public.studio_revisions%rowtype;
  checklist jsonb;
  current_studio public.studios%rowtype;
  existing_request private.backoffice_command_requests%rowtype;
  new_revision public.studio_revisions%rowtype;
  normalized_reason text := nullif(pg_catalog.btrim(p_rejection_reason), '');
  payload_hash text;
  required_role text;
  result jsonb;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_studio_id is null
    or p_expected_publication_version is null
    or p_expected_publication_version < 1
    or p_action is null
    or p_action <> all (array[
      'backoffice.studio.approve'::text,
      'backoffice.studio.reject'::text,
      'backoffice.studio.disable'::text,
      'backoffice.studio.restore'::text
    ])
    or p_idempotency_key is null
    or p_request_id is null
    or (
      p_action in ('backoffice.studio.approve', 'backoffice.studio.reject')
      and p_expected_revision_id is null
    )
    or (
      p_action in ('backoffice.studio.disable', 'backoffice.studio.restore')
      and p_expected_revision_id is not null
    )
    or (
      p_action = 'backoffice.studio.reject'
      and (
        normalized_reason is null
        or p_rejection_reason is distinct from normalized_reason
        or pg_catalog.char_length(normalized_reason) > 2000
      )
    )
    or (p_action <> 'backoffice.studio.reject' and p_rejection_reason is not null)
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_studio_command';
  end if;

  required_role := case
    when p_action in ('backoffice.studio.disable', 'backoffice.studio.restore') then 'admin'
    else 'reviewer'
  end;
  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'expectedPublicationVersion', p_expected_publication_version,
      'expectedRevisionId', p_expected_revision_id,
      'rejectionReason', normalized_reason,
      'studioId', p_studio_id
    )
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    required_role,
    false,
    true
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_actor_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select request.*
  into existing_request
  from private.backoffice_command_requests as request
  where request.actor_user_id = p_actor_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> p_action
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> 'studio'
      or existing_request.target_id <> p_studio_id
    then
      raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
    end if;

    affected_revision_id := coalesce(
      p_expected_revision_id,
      (
        select studio.published_revision_id
        from public.studios as studio
        where studio.id = p_studio_id
      )
    );
    result := private.backoffice_studio_command_result_json(
      p_actor_user_id,
      p_action,
      p_studio_id,
      affected_revision_id
    );
    if result is null
      or private.backoffice_result_hash(result) <> existing_request.result_hash
    then
      raise exception using errcode = '40001', message = 'backoffice_studio_result_stale';
    end if;
    return result;
  end if;

  select studio.*
  into current_studio
  from public.studios as studio
  where studio.id = p_studio_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_studio_review_missing';
  end if;

  perform revision.id
  from public.studio_revisions as revision
  where revision.id in (
    p_expected_revision_id,
    current_studio.published_revision_id,
    current_studio.draft_revision_id
  )
    and revision.studio_id = current_studio.id
  order by revision.id
  for update;

  if p_action in ('backoffice.studio.approve', 'backoffice.studio.reject') then
    select revision.*
    into candidate_revision
    from public.studio_revisions as revision
    where revision.id = p_expected_revision_id
      and revision.studio_id = current_studio.id;

    if not found
      or candidate_revision.status = 'draft'
      or not exists (
        select 1
        from public.studio_review_events as submitted
        where submitted.studio_id = current_studio.id
          and submitted.revision_id = candidate_revision.id
          and submitted.event_type = 'submitted'
      )
    then
      raise exception using errcode = 'P0002', message = 'backoffice_studio_review_missing';
    end if;
  elsif current_studio.status not in ('published', 'changes_pending', 'paused', 'disabled')
    or current_studio.published_revision_id is null
    or not exists (
      select 1
      from public.studio_revisions as published_revision
      where published_revision.id = current_studio.published_revision_id
        and published_revision.studio_id = current_studio.id
        and published_revision.status = 'approved'
    )
    or (
      current_studio.status = 'disabled'
      and (
        current_studio.disabled_from_status is null
        or current_studio.disabled_from_status not in ('published', 'changes_pending', 'paused')
      )
    )
    or (
      current_studio.status <> 'disabled'
      and current_studio.disabled_from_status is not null
    )
  then
    raise exception using errcode = 'P0002', message = 'backoffice_studio_review_missing';
  end if;

  if current_studio.publication_version <> p_expected_publication_version then
    raise exception using errcode = '40001', message = 'backoffice_studio_conflict';
  end if;

  if p_action in ('backoffice.studio.approve', 'backoffice.studio.reject') then
    if current_studio.status not in ('pending_review', 'changes_pending', 'paused')
      or current_studio.draft_revision_id is distinct from p_expected_revision_id
    then
      raise exception using errcode = '40001', message = 'backoffice_studio_conflict';
    end if;

    if candidate_revision.status <> 'pending' then
      raise exception using errcode = '40001', message = 'backoffice_studio_conflict';
    end if;
  end if;

  if p_action = 'backoffice.studio.approve' then
    perform private.lock_active_studio_revision_taxonomy(
      current_studio.owner_user_id,
      current_studio.id,
      candidate_revision.id,
      candidate_revision.revision_version
    );
    checklist := private.studio_publication_checklist(candidate_revision.id);
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(checklist) as item(value)
      where not (item.value ->> 'complete')::boolean
    ) then
      raise exception using errcode = '23514', message = 'studio_submission_incomplete';
    end if;

    insert into private.studio_review_transition_fences (
      revision_id,
      studio_id,
      target_status,
      transaction_id,
      backend_pid
    )
    values (
      candidate_revision.id,
      current_studio.id,
      'approved',
      pg_catalog.pg_current_xact_id(),
      pg_catalog.pg_backend_pid()
    );

    if current_studio.published_revision_id is not null
      and current_studio.published_revision_id <> candidate_revision.id
    then
      insert into private.studio_review_transition_fences (
        revision_id,
        studio_id,
        target_status,
        transaction_id,
        backend_pid
      )
      values (
        current_studio.published_revision_id,
        current_studio.id,
        'superseded',
        pg_catalog.pg_current_xact_id(),
        pg_catalog.pg_backend_pid()
      );
    end if;

    update public.studio_revisions as revision
    set
      status = 'approved',
      revision_version = revision.revision_version + 1
    where revision.id = candidate_revision.id
      and revision.status = 'pending';
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_studio_conflict';
    end if;

    if current_studio.published_revision_id is not null
      and current_studio.published_revision_id <> candidate_revision.id
    then
      update public.studio_revisions as revision
      set
        status = 'superseded',
        revision_version = revision.revision_version + 1
      where revision.id = current_studio.published_revision_id
        and revision.studio_id = current_studio.id
        and revision.status = 'approved';
      if not found then
        raise exception using errcode = '23514', message = 'studio_published_state_invalid';
      end if;
    end if;

    update public.studios as studio
    set
      draft_revision_id = null,
      published_revision_id = candidate_revision.id,
      status = case when studio.status = 'paused' then 'paused' else 'published' end
    where studio.id = current_studio.id
      and studio.publication_version = p_expected_publication_version;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_studio_conflict';
    end if;

    delete from private.studio_review_transition_fences as fence
    where fence.transaction_id = pg_catalog.pg_current_xact_id()
      and fence.backend_pid = pg_catalog.pg_backend_pid();

    insert into public.studio_review_events (
      studio_id,
      revision_id,
      actor_user_id,
      event_type,
      rejection_reason
    )
    values (
      current_studio.id,
      candidate_revision.id,
      p_actor_user_id,
      'approved',
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
      'studio.review.approved',
      'studio_owner',
      current_studio.id,
      candidate_revision.id,
      'studio.review.approved:' || candidate_revision.id::text,
      'pending'
    );

    affected_revision_id := candidate_revision.id;
  elsif p_action = 'backoffice.studio.reject' then
    insert into private.studio_review_transition_fences (
      revision_id,
      studio_id,
      target_status,
      transaction_id,
      backend_pid
    )
    values (
      candidate_revision.id,
      current_studio.id,
      'rejected',
      pg_catalog.pg_current_xact_id(),
      pg_catalog.pg_backend_pid()
    );

    update public.studio_revisions as revision
    set
      status = 'rejected',
      revision_version = revision.revision_version + 1
    where revision.id = candidate_revision.id
      and revision.status = 'pending';
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_studio_conflict';
    end if;

    delete from private.studio_review_transition_fences as fence
    where fence.transaction_id = pg_catalog.pg_current_xact_id()
      and fence.backend_pid = pg_catalog.pg_backend_pid();

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
      candidate_revision.studio_id,
      candidate_revision.revision_number + 1,
      1,
      'draft',
      candidate_revision.name,
      candidate_revision.description,
      candidate_revision.street,
      candidate_revision.street_number,
      candidate_revision.address_complement,
      candidate_revision.neighborhood,
      candidate_revision.city,
      candidate_revision.state,
      candidate_revision.postal_code,
      candidate_revision.capacity,
      candidate_revision.studio_type_id,
      candidate_revision.usage_rules,
      candidate_revision.youtube_video_id
    )
    returning * into new_revision;

    insert into public.studio_revision_tags (revision_id, tag_id)
    select new_revision.id, relation.tag_id
    from public.studio_revision_tags as relation
    where relation.revision_id = candidate_revision.id;

    insert into public.studio_revision_amenities (revision_id, amenity_id)
    select new_revision.id, relation.amenity_id
    from public.studio_revision_amenities as relation
    where relation.revision_id = candidate_revision.id;

    insert into public.studio_faqs (revision_id, question, answer, position)
    select new_revision.id, faq.question, faq.answer, faq.position
    from public.studio_faqs as faq
    where faq.revision_id = candidate_revision.id
    order by faq.position;

    insert into public.studio_revision_media (revision_id, media_id, position, is_cover)
    select new_revision.id, relation.media_id, relation.position, relation.is_cover
    from public.studio_revision_media as relation
    where relation.revision_id = candidate_revision.id
    order by relation.position;

    update public.studios as studio
    set
      draft_revision_id = new_revision.id,
      status = case
        when studio.status = 'pending_review' then 'rejected'
        else studio.status
      end
    where studio.id = current_studio.id
      and studio.publication_version = p_expected_publication_version;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_studio_conflict';
    end if;

    insert into public.studio_review_events (
      studio_id,
      revision_id,
      actor_user_id,
      event_type,
      rejection_reason
    )
    values (
      current_studio.id,
      candidate_revision.id,
      p_actor_user_id,
      'rejected',
      normalized_reason
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
      'studio.review.rejected',
      'studio_owner',
      current_studio.id,
      candidate_revision.id,
      'studio.review.rejected:' || candidate_revision.id::text,
      'pending'
    );

    affected_revision_id := candidate_revision.id;
  elsif p_action = 'backoffice.studio.disable' then
    if current_studio.status not in ('published', 'changes_pending', 'paused')
      or current_studio.published_revision_id is null
    then
      raise exception using errcode = '23514', message = 'backoffice_studio_disable_state_invalid';
    end if;

    update public.studios as studio
    set
      disabled_from_status = studio.status,
      status = 'disabled'
    where studio.id = current_studio.id
      and studio.publication_version = p_expected_publication_version;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_studio_conflict';
    end if;
    affected_revision_id := current_studio.published_revision_id;
  else
    if current_studio.status <> 'disabled'
      or current_studio.disabled_from_status is null
      or current_studio.published_revision_id is null
    then
      raise exception using errcode = '23514', message = 'backoffice_studio_restore_state_invalid';
    end if;

    update public.studios as studio
    set
      status = studio.disabled_from_status,
      disabled_from_status = null
    where studio.id = current_studio.id
      and studio.publication_version = p_expected_publication_version;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_studio_conflict';
    end if;
    affected_revision_id := current_studio.published_revision_id;
  end if;

  result := private.backoffice_studio_command_result_json(
    p_actor_user_id,
    p_action,
    p_studio_id,
    affected_revision_id
  );
  if result is null then
    raise exception using errcode = 'P0002', message = 'backoffice_studio_result_missing';
  end if;

  insert into private.backoffice_command_requests (
    actor_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    target_type,
    target_id
  )
  values (
    p_actor_user_id,
    p_idempotency_key,
    p_action,
    payload_hash,
    private.backoffice_result_hash(result),
    'studio',
    p_studio_id
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
    p_actor_user_id,
    actor_context.actor_role,
    case p_action
      when 'backoffice.studio.approve' then 'backoffice.studio_approved'
      when 'backoffice.studio.reject' then 'backoffice.studio_rejected'
      when 'backoffice.studio.disable' then 'backoffice.studio_disabled'
      else 'backoffice.studio_restored'
    end,
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'publicationVersion', result -> 'publicationVersion',
      'revisionId', affected_revision_id,
      'studioStatus', result -> 'studioStatus'
    )
  );

  return result;
end;
$function$;

alter function private.execute_backoffice_studio_command(
  uuid, uuid, timestamptz, uuid, uuid, bigint, text, text, uuid, uuid
) owner to postgres;

insert into private.dal_routine_allowlist (signature)
values
  ('private.list_backoffice_studio_reviews(uuid,uuid,timestamptz,bigint,uuid,integer)'),
  ('private.get_backoffice_studio_review(uuid,uuid,timestamptz,uuid)'),
  ('private.execute_backoffice_studio_command(uuid,uuid,timestamptz,uuid,uuid,bigint,text,text,uuid,uuid)');

revoke all on function private.backoffice_studio_revision_json(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.list_backoffice_studio_reviews(
  uuid, uuid, timestamptz, bigint, uuid, integer
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.get_backoffice_studio_review(
  uuid, uuid, timestamptz, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.backoffice_studio_command_result_json(
  uuid, text, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.execute_backoffice_studio_command(
  uuid, uuid, timestamptz, uuid, uuid, bigint, text, text, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;

grant execute on function private.list_backoffice_studio_reviews(
  uuid, uuid, timestamptz, bigint, uuid, integer
) to app_dal;
grant execute on function private.get_backoffice_studio_review(
  uuid, uuid, timestamptz, uuid
) to app_dal;
grant execute on function private.execute_backoffice_studio_command(
  uuid, uuid, timestamptz, uuid, uuid, bigint, text, text, uuid, uuid
) to app_dal;

comment on function private.list_backoffice_studio_reviews(
  uuid, uuid, timestamptz, bigint, uuid, integer
) is 'Fila privada keyset; reviewer vê candidatas pendentes e somente admin vê desativações.';
comment on function private.get_backoffice_studio_review(
  uuid, uuid, timestamptz, uuid
) is 'Detalhe privado estrito com candidata, versão vigente, mídia, conteúdo e checklist derivados.';
comment on function private.execute_backoffice_studio_command(
  uuid, uuid, timestamptz, uuid, uuid, bigint, text, text, uuid, uuid
) is 'Decide ou modera estúdio atomicamente com fence, ledger, evento, outbox e audit.';

-- O readiness anterior recusava corretamente qualquer EXECUTE privado fora da DAL. A revisão de
-- mídia exige uma única exceção autenticada para a função chamada pela policy de storage. A exceção
-- fica presa à assinatura, sem grant option; todas as demais fronteiras originais permanecem exatas.
create or replace function private.check_readiness(expected_version text) returns boolean
  language sql stable security definer
  set search_path to ''
as $function$
  with dal_role as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = 'app_dal'
      and not role.rolcanlogin
      and not role.rolinherit
      and not role.rolsuper
      and not role.rolcreatedb
      and not role.rolcreaterole
      and not role.rolreplication
      and not role.rolbypassrls
      and role.rolconfig is null
      and not exists (
        select 1
        from pg_catalog.pg_auth_members as membership
        where membership.member = role.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_shdepend as dependency
        where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          and dependency.refobjid = role.oid
          and dependency.deptype = 'o'
      )
  ),
  authenticated_role as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = 'authenticated'
  ),
  trusted_owner as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = 'postgres'
  ),
  migration_is_applied as (
    select
      expected_version ~ '^[0-9]{14}$'
      and exists (
        select 1
        from supabase_migrations.schema_migrations as migration
        where migration.version = expected_version
      ) as ready
  ),
  authorized_dal_routines as (
    select pg_catalog.to_regprocedure(entry.signature) as oid
    from private.dal_routine_allowlist as entry
  ),
  review_media_routine as (
    select pg_catalog.to_regprocedure(
      'private.can_sign_backoffice_studio_media(text)'
    ) as oid
  ),
  editorial_relations(schema_name, relation_name) as (
    values
      ('audit'::name, 'events'::name),
      ('private'::name, 'backoffice_command_requests'::name),
      ('private'::name, 'studio_review_transition_fences'::name),
      ('public'::name, 'email_outbox'::name),
      ('public'::name, 'platform_roles'::name),
      ('public'::name, 'studio_faqs'::name),
      ('public'::name, 'studio_media'::name),
      ('public'::name, 'studio_review_events'::name),
      ('public'::name, 'studio_revision_amenities'::name),
      ('public'::name, 'studio_revision_media'::name),
      ('public'::name, 'studio_revision_tags'::name),
      ('public'::name, 'studio_revisions'::name),
      ('public'::name, 'studios'::name)
  ),
  expected_editorial_web_grants(
    schema_name,
    relation_name,
    column_name,
    grantee_name,
    grantor_name,
    privilege_type,
    is_grantable
  ) as (
    values
      ('public'::name, 'studios'::name, 'id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studios'::name, 'owner_user_id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studios'::name, 'status'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studios'::name, 'published_revision_id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studios'::name, 'draft_revision_id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'studio_id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'revision_number'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'revision_version'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'status'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'name'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'description'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'street'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'street_number'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'address_complement'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'neighborhood'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'city'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'state'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'postal_code'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'capacity'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'studio_type_id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'usage_rules'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revisions'::name, 'youtube_video_id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_faqs'::name, 'id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_faqs'::name, 'revision_id'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_faqs'::name, 'question'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_faqs'::name, 'answer'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_faqs'::name, 'position'::name, 'authenticated'::name,
        'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revision_tags'::name, 'revision_id'::name,
        'authenticated'::name, 'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revision_tags'::name, 'tag_id'::name,
        'authenticated'::name, 'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revision_amenities'::name, 'revision_id'::name,
        'authenticated'::name, 'postgres'::name, 'SELECT'::text, false),
      ('public'::name, 'studio_revision_amenities'::name, 'amenity_id'::name,
        'authenticated'::name, 'postgres'::name, 'SELECT'::text, false)
  ),
  actual_editorial_web_grants as (
    select
      namespace.nspname::name as schema_name,
      relation.relname::name as relation_name,
      null::name as column_name,
      coalesce(grantee.rolname, 'PUBLIC'::name) as grantee_name,
      grantor.rolname::name as grantor_name,
      privilege.privilege_type,
      privilege.is_grantable
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    join editorial_relations as expected_relation
      on expected_relation.schema_name = namespace.nspname
      and expected_relation.relation_name = relation.relname
    cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
    left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
    join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
    where privilege.grantee = 0
      or grantee.rolname in ('anon', 'authenticated', 'service_role')

    union all

    select
      namespace.nspname::name,
      relation.relname::name,
      attribute.attname::name,
      coalesce(grantee.rolname, 'PUBLIC'::name),
      grantor.rolname::name,
      privilege.privilege_type,
      privilege.is_grantable
    from pg_catalog.pg_attribute as attribute
    join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    join editorial_relations as expected_relation
      on expected_relation.schema_name = namespace.nspname
      and expected_relation.relation_name = relation.relname
    cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
    left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
    join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
    where attribute.attnum > 0
      and not attribute.attisdropped
      and (
        privilege.grantee = 0
        or grantee.rolname in ('anon', 'authenticated', 'service_role')
      )
  ),
  editorial_web_grant_manifest_is_exact as (
    select not exists (
      (
        select expected.*
        from expected_editorial_web_grants as expected
        except
        select actual.*
        from actual_editorial_web_grants as actual
      )
      union all
      (
        select actual.*
        from actual_editorial_web_grants as actual
        except
        select expected.*
        from expected_editorial_web_grants as expected
      )
    ) as ready
  ),
  expected_editorial_web_policies(
    schema_name,
    relation_name,
    policy_name,
    permissive,
    roles,
    command,
    qualifier,
    with_check
  ) as (
    values
      (
        'public'::name,
        'studios'::name,
        'studios_select_own'::name,
        'PERMISSIVE'::text,
        array['authenticated'::name],
        'SELECT'::text,
        '((owner_user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
          FROM (((public.profiles profile
            JOIN public.owner_profiles owner ON ((owner.user_id = profile.id)))
            JOIN public.terms_versions legal_version ON ((legal_version.id = owner.accepted_owner_contract_version_id)))
            JOIN public.terms_acceptances acceptance ON (((acceptance.user_id = owner.user_id) AND (acceptance.terms_version_id = legal_version.id) AND (acceptance.accepted_content_hash = legal_version.content_hash))))
         WHERE ((profile.id = studios.owner_user_id) AND (profile.status = ''active''::text) AND (profile.completed_at IS NOT NULL) AND (owner.status = ''active''::text) AND (legal_version.kind = ''owner_contract''::text) AND (legal_version.effective_at <= now()) AND ((legal_version.retired_at IS NULL) OR (now() < legal_version.retired_at))))))'::text,
        null::text
      ),
      (
        'public'::name,
        'studio_revisions'::name,
        'studio_revisions_select_own'::name,
        'PERMISSIVE'::text,
        array['authenticated'::name],
        'SELECT'::text,
        '(EXISTS ( SELECT 1
          FROM ((((public.studios studio
            JOIN public.profiles profile ON ((profile.id = studio.owner_user_id)))
            JOIN public.owner_profiles owner ON ((owner.user_id = profile.id)))
            JOIN public.terms_versions legal_version ON ((legal_version.id = owner.accepted_owner_contract_version_id)))
            JOIN public.terms_acceptances acceptance ON (((acceptance.user_id = owner.user_id) AND (acceptance.terms_version_id = legal_version.id) AND (acceptance.accepted_content_hash = legal_version.content_hash))))
         WHERE ((studio.id = studio_revisions.studio_id) AND (studio.owner_user_id = ( SELECT auth.uid() AS uid)) AND (profile.status = ''active''::text) AND (profile.completed_at IS NOT NULL) AND (owner.status = ''active''::text) AND (legal_version.kind = ''owner_contract''::text) AND (legal_version.effective_at <= now()) AND ((legal_version.retired_at IS NULL) OR (now() < legal_version.retired_at)))))'::text,
        null::text
      ),
      (
        'public'::name,
        'studio_faqs'::name,
        'studio_faqs_select_own'::name,
        'PERMISSIVE'::text,
        array['authenticated'::name],
        'SELECT'::text,
        '(EXISTS ( SELECT 1 FROM (public.studio_revisions revision JOIN public.studios studio ON ((studio.id = revision.studio_id))) WHERE ((revision.id = studio_faqs.revision_id) AND (studio.owner_user_id = ( SELECT auth.uid() AS uid)))))'::text,
        null::text
      ),
      (
        'public'::name,
        'studio_revision_tags'::name,
        'studio_revision_tags_select_own'::name,
        'PERMISSIVE'::text,
        array['authenticated'::name],
        'SELECT'::text,
        '(EXISTS ( SELECT 1 FROM (public.studio_revisions revision JOIN public.studios studio ON ((studio.id = revision.studio_id))) WHERE ((revision.id = studio_revision_tags.revision_id) AND (studio.owner_user_id = ( SELECT auth.uid() AS uid)))))'::text,
        null::text
      ),
      (
        'public'::name,
        'studio_revision_amenities'::name,
        'studio_revision_amenities_select_own'::name,
        'PERMISSIVE'::text,
        array['authenticated'::name],
        'SELECT'::text,
        '(EXISTS ( SELECT 1 FROM (public.studio_revisions revision JOIN public.studios studio ON ((studio.id = revision.studio_id))) WHERE ((revision.id = studio_revision_amenities.revision_id) AND (studio.owner_user_id = ( SELECT auth.uid() AS uid)))))'::text,
        null::text
      )
  ),
  actual_editorial_web_policies as (
    select
      policy.schemaname::name as schema_name,
      policy.tablename::name as relation_name,
      policy.policyname::name as policy_name,
      policy.permissive,
      policy.roles,
      policy.cmd as command,
      policy.qual as qualifier,
      policy.with_check
    from pg_catalog.pg_policies as policy
    join editorial_relations as expected_relation
      on expected_relation.schema_name = policy.schemaname
      and expected_relation.relation_name = policy.tablename
  ),
  normalized_expected_editorial_web_policies as (
    select
      expected.schema_name,
      expected.relation_name,
      expected.policy_name,
      expected.permissive,
      expected.roles,
      expected.command,
      pg_catalog.regexp_replace(
        pg_catalog.replace(
          pg_catalog.replace(
            pg_catalog.replace(expected.qualifier, '"', ''),
            'public.',
            ''
          ),
          'pg_catalog.',
          ''
        ),
        '[[:space:]]',
        '',
        'g'
      ) as qualifier,
      expected.with_check
    from expected_editorial_web_policies as expected
  ),
  normalized_actual_editorial_web_policies as (
    select
      actual.schema_name,
      actual.relation_name,
      actual.policy_name,
      actual.permissive,
      actual.roles,
      actual.command,
      pg_catalog.regexp_replace(
        pg_catalog.replace(
          pg_catalog.replace(
            pg_catalog.replace(actual.qualifier, '"', ''),
            'public.',
            ''
          ),
          'pg_catalog.',
          ''
        ),
        '[[:space:]]',
        '',
        'g'
      ) as qualifier,
      actual.with_check
    from actual_editorial_web_policies as actual
  ),
  editorial_web_policy_manifest_is_exact as (
    select not exists (
      (
        select expected.*
        from normalized_expected_editorial_web_policies as expected
        except
        select actual.*
        from normalized_actual_editorial_web_policies as actual
      )
      union all
      (
        select actual.*
        from normalized_actual_editorial_web_policies as actual
        except
        select expected.*
        from normalized_expected_editorial_web_policies as expected
      )
    ) as ready
  ),
  storage_object_policy_manifest_is_exact as (
    select coalesce(
      pg_catalog.count(*) = 1
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
      ),
      false
    ) as ready
    from pg_catalog.pg_policies as policy
    where policy.schemaname = 'storage'
      and policy.tablename = 'objects'
  ),
  storage_object_grants_are_guarded as (
    select
      relation.relrowsecurity
      and pg_catalog.has_table_privilege(
        'authenticated',
        relation.oid,
        'SELECT'
      )
      and not pg_catalog.has_table_privilege(
        'authenticated',
        relation.oid,
        'SELECT WITH GRANT OPTION'
      )
      and not exists (
        select 1
        from lateral pg_catalog.aclexplode(relation.relacl) as privilege
        left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
        where (privilege.grantee = 0 or grantee.rolname in ('anon', 'authenticated'))
          and privilege.is_grantable
      )
      and not exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
        left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
        where attribute.attrelid = relation.oid
          and (privilege.grantee = 0 or grantee.rolname in ('anon', 'authenticated'))
      ) as ready
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'storage'
      and relation.relname = 'objects'
      and relation.relkind in ('p', 'r')
  ),
  dal_allowlist_is_trusted as (
    select exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join trusted_owner
      where namespace.nspname = 'private'
        and relation.relname = 'dal_routine_allowlist'
        and relation.relkind = 'r'
        and relation.relowner = trusted_owner.oid
        and relation.relrowsecurity
    ) as ready
  ),
  private_ownership_is_trusted as (
    select
      exists (
        select 1
        from pg_catalog.pg_namespace as namespace
        cross join trusted_owner
        where namespace.nspname = 'private'
          and namespace.nspowner = trusted_owner.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_proc as routine
        join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
        cross join trusted_owner
        where namespace.nspname = 'private'
          and routine.proowner <> trusted_owner.oid
      ) as ready
  ),
  authorized_routine_attributes_are_trusted as (
    select
      not exists (
        select 1
        from authorized_dal_routines as authorized
        left join pg_catalog.pg_proc as routine on routine.oid = authorized.oid
        where routine.oid is null
          or not routine.prosecdef
          or routine.proconfig is distinct from array['search_path=""']::text[]
      )
      and exists (
        select 1
        from review_media_routine as authorized
        join pg_catalog.pg_proc as routine on routine.oid = authorized.oid
        where routine.prosecdef
          and routine.proconfig is not distinct from array['search_path=""']::text[]
      ) as ready
  ),
  direct_schema_grants_are_restricted as (
    select
      pg_catalog.count(*) filter (where privilege.grantee = dal_role.oid) = 1
      and coalesce(
        pg_catalog.bool_and(
          privilege.grantee = trusted_owner.oid
          or (
            privilege.grantee = dal_role.oid
            and privilege.privilege_type = 'USAGE'
            and not privilege.is_grantable
          )
        ),
        false
      ) as ready
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
    cross join dal_role
    cross join trusted_owner
    where namespace.nspname = 'private'
  ),
  effective_external_schema_access_is_absent as (
    select not exists (
      select 1
      from pg_catalog.pg_namespace as namespace
      where namespace.nspname <> 'private'
        and namespace.nspname <> 'information_schema'
        and namespace.nspname !~ '^pg_'
        and (
          pg_catalog.has_schema_privilege('app_dal', namespace.oid, 'USAGE')
          or pg_catalog.has_schema_privilege('app_dal', namespace.oid, 'CREATE')
        )
    ) as ready
  ),
  direct_routine_grants_are_restricted as (
    select
      pg_catalog.count(*) filter (where privilege.grantee = dal_role.oid)
        = (select pg_catalog.count(*) from authorized_dal_routines)
      and pg_catalog.count(*) filter (where privilege.grantee = authenticated_role.oid) = 1
      and coalesce(
        pg_catalog.bool_and(
          privilege.grantee = trusted_owner.oid
          or (
            privilege.grantee = dal_role.oid
            and routine.oid in (select authorized.oid from authorized_dal_routines as authorized)
            and privilege.privilege_type = 'EXECUTE'
            and not privilege.is_grantable
          )
          or (
            privilege.grantee = authenticated_role.oid
            and routine.oid = (select authorized.oid from review_media_routine as authorized)
            and privilege.privilege_type = 'EXECUTE'
            and not privilege.is_grantable
          )
        ),
        false
      )
      and not exists (
        select 1
        from authorized_dal_routines as authorized
        where authorized.oid is null
      )
      and (select authorized.oid from review_media_routine as authorized) is not null as ready
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    cross join dal_role
    cross join authenticated_role
    cross join trusted_owner
    where namespace.nspname = 'private'
  ),
  effective_private_routine_grants_are_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'private'
        and (
          pg_catalog.has_function_privilege('app_dal', routine.oid, 'EXECUTE')
            <> (routine.oid in (select authorized.oid from authorized_dal_routines as authorized))
          or pg_catalog.has_function_privilege(
            'app_dal',
            routine.oid,
            'EXECUTE WITH GRANT OPTION'
          )
        )
    ) as ready
  ),
  direct_data_grants_are_absent as (
    select not exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
      cross join dal_role
      where namespace.nspname in ('audit', 'private', 'public')
        and privilege.grantee in (0, dal_role.oid)

      union all

      select 1
      from pg_catalog.pg_attribute as attribute
      join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
      cross join dal_role
      where namespace.nspname in ('audit', 'private', 'public')
        and privilege.grantee in (0, dal_role.oid)

      union all

      select 1
      from pg_catalog.pg_type as type_object
      join pg_catalog.pg_namespace as namespace on namespace.oid = type_object.typnamespace
      cross join lateral pg_catalog.aclexplode(type_object.typacl) as privilege
      cross join dal_role
      where namespace.nspname in ('audit', 'private', 'public')
        and privilege.grantee in (0, dal_role.oid)

      union all

      select 1
      from pg_catalog.pg_default_acl as defaults
      left join pg_catalog.pg_namespace as namespace on namespace.oid = defaults.defaclnamespace
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
      cross join dal_role
      where defaults.defaclrole = (
          select role.oid from pg_catalog.pg_roles as role where role.rolname = 'postgres'
        )
        and (defaults.defaclnamespace = 0 or namespace.nspname in ('audit', 'private', 'public'))
        and privilege.grantee in (0, dal_role.oid)
    ) as ready
  ),
  dal_memberships_are_restricted as (
    select
      exists (
        select 1
        from pg_catalog.pg_auth_members as membership
        join pg_catalog.pg_roles as member on member.oid = membership.member
        where membership.roleid = dal_role.oid
          and member.rolname = 'app_runtime_production'
          and not membership.admin_option
          and not membership.inherit_option
          and membership.set_option
      )
      and not exists (
        select 1
        from pg_catalog.pg_auth_members as membership
        join pg_catalog.pg_roles as member on member.oid = membership.member
        where membership.roleid = dal_role.oid
          and not (
            (
              member.rolname = 'app_runtime_production'
              and not membership.admin_option
              and not membership.inherit_option
              and membership.set_option
            )
            or (
              member.rolname = 'app_runtime_local'
              and not membership.admin_option
              and not membership.inherit_option
              and membership.set_option
              and exists (
                select 1
                from pg_catalog.pg_database as database
                where database.datname = pg_catalog.current_database()
                  and pg_catalog.shobj_description(database.oid, 'pg_database')
                    like 'set-livre-e2e:%'
              )
            )
            or (
              member.rolname = 'postgres'
              and membership.admin_option
              and not membership.inherit_option
              and not membership.set_option
            )
          )
      ) as ready
    from dal_role
  ),
  public_tables_use_rls as (
    select coalesce(pg_catalog.bool_and(relation.relrowsecurity), true) as ready
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('p', 'r')
  )
  select coalesce(
    (select ready from migration_is_applied)
    and pg_catalog.current_setting('app.settings.jwt_exp', true) = '3600'
    and (select ready from dal_allowlist_is_trusted)
    and (select ready from private_ownership_is_trusted)
    and (select ready from authorized_routine_attributes_are_trusted)
    and (select ready from direct_schema_grants_are_restricted)
    and (select ready from effective_external_schema_access_is_absent)
    and (select ready from direct_routine_grants_are_restricted)
    and (select ready from effective_private_routine_grants_are_restricted)
    and (select ready from direct_data_grants_are_absent)
    and (select ready from editorial_web_grant_manifest_is_exact)
    and (select ready from editorial_web_policy_manifest_is_exact)
    and (select ready from storage_object_policy_manifest_is_exact)
    and (select ready from storage_object_grants_are_guarded)
    and (select ready from dal_memberships_are_restricted)
    and (select ready from public_tables_use_rls)
    and private.managed_runtime_boundaries_are_ready()
    and not pg_catalog.has_schema_privilege('public', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('anon', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('authenticated', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('service_role', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('app_dal', 'public', 'CREATE')
    and not pg_catalog.has_database_privilege(
      'app_dal',
      pg_catalog.current_database(),
      'TEMPORARY'
    ),
    false
  );
$function$;

alter function private.check_readiness(text) owner to postgres;

comment on function private.check_readiness(text) is
  'Health fail-closed: DAL, grants/policies editoriais exatos e única policy sign_many para preview.';
