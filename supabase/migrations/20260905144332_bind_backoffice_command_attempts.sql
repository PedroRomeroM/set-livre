-- Vincula confirmações à tentativa persistida, sem alterar os hashes históricos do resultado.
-- O ledger já vincula ator/chave/action ao hash do payload completo; nenhum eco vem da UI.

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
    return result || pg_catalog.jsonb_build_object(
      'action', existing_request.action,
      'idempotencyKey', existing_request.idempotency_key,
      'scope', existing_request.actor_user_id
    );
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
  )
  returning * into existing_request;

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

  return result || pg_catalog.jsonb_build_object(
    'action', existing_request.action,
    'idempotencyKey', existing_request.idempotency_key,
    'scope', existing_request.actor_user_id
  );
end;
$function$;

alter function private.set_backoffice_user_status(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) owner to postgres;

revoke all on function private.set_backoffice_user_status(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
)
from public, anon, authenticated, service_role;
grant execute on function private.set_backoffice_user_status(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
)
to app_dal;

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
    return result || pg_catalog.jsonb_build_object(
      'action', existing_request.action,
      'idempotencyKey', existing_request.idempotency_key,
      'scope', existing_request.actor_user_id
    );
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
  )
  returning * into existing_request;

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

  return result || pg_catalog.jsonb_build_object(
    'action', existing_request.action,
    'idempotencyKey', existing_request.idempotency_key,
    'scope', existing_request.actor_user_id
  );
end;
$function$;

alter function private.set_backoffice_user_role(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) owner to postgres;

revoke all on function private.set_backoffice_user_role(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
)
from public, anon, authenticated, service_role;
grant execute on function private.set_backoffice_user_role(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
)
to app_dal;

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
    return result || pg_catalog.jsonb_build_object(
      'action', existing_request.action,
      'idempotencyKey', existing_request.idempotency_key,
      'scope', existing_request.actor_user_id
    );
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
  )
  returning * into existing_request;

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

  return result || pg_catalog.jsonb_build_object(
    'action', existing_request.action,
    'idempotencyKey', existing_request.idempotency_key,
    'scope', existing_request.actor_user_id
  );
end;
$function$;

alter function private.execute_backoffice_studio_command(
  uuid, uuid, timestamptz, uuid, uuid, bigint, text, text, uuid, uuid
) owner to postgres;

revoke all on function private.execute_backoffice_studio_command(
  uuid, uuid, timestamptz, uuid, uuid, bigint, text, text, uuid, uuid
)
from public, anon, authenticated, service_role;
grant execute on function private.execute_backoffice_studio_command(
  uuid, uuid, timestamptz, uuid, uuid, bigint, text, text, uuid, uuid
)
to app_dal;

create or replace function private.upsert_backoffice_taxonomy(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_kind text,
  p_id uuid,
  p_expected_version bigint,
  p_slug text,
  p_name text,
  p_sort_order integer,
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
  current_version bigint;
  existing_request private.backoffice_command_requests%rowtype;
  is_create boolean;
  payload_hash text;
  result jsonb;
  target_id uuid;
  target_type text;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_kind is null
    or p_kind <> all (array['studioType'::text, 'tag'::text, 'amenity'::text])
    or (p_id is null) <> (p_expected_version is null)
    or (p_expected_version is not null and p_expected_version < 0)
    or p_slug is null
    or p_slug <> pg_catalog.btrim(p_slug)
    or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or pg_catalog.char_length(p_slug) not between 2 and 80
    or p_name is null
    or p_name <> pg_catalog.btrim(p_name)
    or pg_catalog.char_length(p_name) not between 2 and 80
    or p_sort_order is null
    or p_sort_order not between 0 and 32767
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_taxonomy_upsert';
  end if;

  is_create := p_id is null;
  target_type := case p_kind
    when 'studioType' then 'studio_type'
    when 'tag' then 'tag'
    else 'amenity'
  end;
  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'expectedVersion', p_expected_version,
      'id', p_id,
      'kind', p_kind,
      'name', p_name,
      'slug', p_slug,
      'sortOrder', p_sort_order
    )
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
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
    if existing_request.action <> 'backoffice.taxonomy.upsert'
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> target_type
      or (not is_create and existing_request.target_id <> p_id)
    then
      raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
    end if;

    result := private.backoffice_taxonomy_item_json(p_kind, existing_request.target_id);
    if private.backoffice_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'backoffice_taxonomy_result_stale';
    end if;
    return result || pg_catalog.jsonb_build_object(
      'action', existing_request.action,
      'idempotencyKey', existing_request.idempotency_key,
      'scope', existing_request.actor_user_id
    );
  end if;

  if is_create then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('set-livre:backoffice-taxonomy-capacity', 0)
    );
    if (
      select pg_catalog.count(*) >= 500
      from (
        select studio_type.id from public.studio_types as studio_type
        union all
        select tag.id from public.tags as tag
        union all
        select amenity.id from public.amenities as amenity
      ) as taxonomy_item
    ) then
      raise exception using errcode = '23514', message = 'backoffice_taxonomy_capacity_reached';
    end if;

    target_id := extensions.gen_random_uuid();
    if p_kind = 'studioType' then
      insert into public.studio_types (id, slug, name, sort_order)
      values (target_id, p_slug, p_name, p_sort_order);
    elsif p_kind = 'tag' then
      insert into public.tags (id, slug, name, sort_order)
      values (target_id, p_slug, p_name, p_sort_order);
    else
      insert into public.amenities (id, slug, name, sort_order)
      values (target_id, p_slug, p_name, p_sort_order);
    end if;
  else
    target_id := p_id;
    if p_kind = 'studioType' then
      select item.taxonomy_version
      into current_version
      from public.studio_types as item
      where item.id = target_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
      end if;
      if current_version <> p_expected_version then
        raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
      end if;
      update public.studio_types as item
      set
        slug = p_slug,
        name = p_name,
        sort_order = p_sort_order,
        taxonomy_version = item.taxonomy_version + 1
      where item.id = target_id
        and item.taxonomy_version = p_expected_version;
    elsif p_kind = 'tag' then
      select item.taxonomy_version
      into current_version
      from public.tags as item
      where item.id = target_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
      end if;
      if current_version <> p_expected_version then
        raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
      end if;
      update public.tags as item
      set
        slug = p_slug,
        name = p_name,
        sort_order = p_sort_order,
        taxonomy_version = item.taxonomy_version + 1
      where item.id = target_id
        and item.taxonomy_version = p_expected_version;
    else
      select item.taxonomy_version
      into current_version
      from public.amenities as item
      where item.id = target_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
      end if;
      if current_version <> p_expected_version then
        raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
      end if;
      update public.amenities as item
      set
        slug = p_slug,
        name = p_name,
        sort_order = p_sort_order,
        taxonomy_version = item.taxonomy_version + 1
      where item.id = target_id
        and item.taxonomy_version = p_expected_version;
    end if;

    if not found then
      raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
    end if;
  end if;

  result := private.backoffice_taxonomy_item_json(p_kind, target_id);

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
    'backoffice.taxonomy.upsert',
    payload_hash,
    private.backoffice_result_hash(result),
    target_type,
    target_id
  )
  returning * into existing_request;

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
      when is_create then 'backoffice.taxonomy_created'
      else 'backoffice.taxonomy_updated'
    end,
    target_type,
    target_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'kind', p_kind,
      'version', result -> 'version'
    )
  );

  return result || pg_catalog.jsonb_build_object(
    'action', existing_request.action,
    'idempotencyKey', existing_request.idempotency_key,
    'scope', existing_request.actor_user_id
  );
end;
$function$;

alter function private.upsert_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, text, integer, uuid, uuid
) owner to postgres;

revoke all on function private.upsert_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, text, integer, uuid, uuid
)
from public, anon, authenticated, service_role;
grant execute on function private.upsert_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, text, integer, uuid, uuid
)
to app_dal;

create or replace function private.transition_backoffice_taxonomy(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_kind text,
  p_id uuid,
  p_expected_version bigint,
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
  current_active boolean;
  current_version bigint;
  existing_request private.backoffice_command_requests%rowtype;
  payload_hash text;
  result jsonb;
  target_active boolean;
  target_type text;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_kind is null
    or p_kind <> all (array['studioType'::text, 'tag'::text, 'amenity'::text])
    or p_id is null
    or p_expected_version is null
    or p_expected_version < 0
    or p_action is null
    or p_action <> all (array[
      'backoffice.taxonomy.archive'::text,
      'backoffice.taxonomy.reactivate'::text
    ])
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_taxonomy_transition';
  end if;

  target_active := p_action = 'backoffice.taxonomy.reactivate';
  target_type := case p_kind
    when 'studioType' then 'studio_type'
    when 'tag' then 'tag'
    else 'amenity'
  end;
  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'expectedVersion', p_expected_version,
      'id', p_id,
      'kind', p_kind
    )
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
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
      or existing_request.target_type <> target_type
      or existing_request.target_id <> p_id
    then
      raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
    end if;

    result := private.backoffice_taxonomy_item_json(p_kind, p_id);
    if private.backoffice_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'backoffice_taxonomy_result_stale';
    end if;
    return result || pg_catalog.jsonb_build_object(
      'action', existing_request.action,
      'idempotencyKey', existing_request.idempotency_key,
      'scope', existing_request.actor_user_id
    );
  end if;

  if p_kind = 'studioType' then
    select item.active, item.taxonomy_version
    into current_active, current_version
    from public.studio_types as item
    where item.id = p_id
    for update;
  elsif p_kind = 'tag' then
    select item.active, item.taxonomy_version
    into current_active, current_version
    from public.tags as item
    where item.id = p_id
    for update;
  else
    select item.active, item.taxonomy_version
    into current_active, current_version
    from public.amenities as item
    where item.id = p_id
    for update;
  end if;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
  end if;
  if current_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
  end if;
  if current_active = target_active then
    raise exception using errcode = '23514', message = 'backoffice_taxonomy_status_unchanged';
  end if;

  if p_kind = 'studioType' then
    update public.studio_types as item
    set
      active = target_active,
      taxonomy_version = item.taxonomy_version + 1
    where item.id = p_id
      and item.taxonomy_version = p_expected_version;
  elsif p_kind = 'tag' then
    update public.tags as item
    set
      active = target_active,
      taxonomy_version = item.taxonomy_version + 1
    where item.id = p_id
      and item.taxonomy_version = p_expected_version;
  else
    update public.amenities as item
    set
      active = target_active,
      taxonomy_version = item.taxonomy_version + 1
    where item.id = p_id
      and item.taxonomy_version = p_expected_version;
  end if;

  if not found then
    raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
  end if;

  result := private.backoffice_taxonomy_item_json(p_kind, p_id);

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
    target_type,
    p_id
  )
  returning * into existing_request;

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
      when target_active then 'backoffice.taxonomy_reactivated'
      else 'backoffice.taxonomy_archived'
    end,
    target_type,
    p_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'active', target_active,
      'kind', p_kind,
      'usageCount', result -> 'usageCount',
      'version', result -> 'version'
    )
  );

  return result || pg_catalog.jsonb_build_object(
    'action', existing_request.action,
    'idempotencyKey', existing_request.idempotency_key,
    'scope', existing_request.actor_user_id
  );
end;
$function$;

alter function private.transition_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, uuid, uuid
) owner to postgres;

revoke all on function private.transition_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, uuid, uuid
)
from public, anon, authenticated, service_role;
grant execute on function private.transition_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, uuid, uuid
)
to app_dal;
