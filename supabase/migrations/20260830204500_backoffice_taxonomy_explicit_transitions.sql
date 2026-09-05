alter table private.backoffice_command_requests
  drop constraint backoffice_command_requests_action_check;

alter table private.backoffice_command_requests
  add constraint backoffice_command_requests_action_check check (
    action = any (array[
      'backoffice.user.restore'::text,
      'backoffice.user.suspend'::text,
      'backoffice.user.revealPii'::text,
      'backoffice.access.grantAdmin'::text,
      'backoffice.access.grantSupport'::text,
      'backoffice.access.revokeAdmin'::text,
      'backoffice.access.revokeSupport'::text,
      'backoffice.taxonomy.upsert'::text,
      'backoffice.taxonomy.setActive'::text,
      'backoffice.taxonomy.archive'::text,
      'backoffice.taxonomy.reactivate'::text
    ])
  );

delete from private.dal_routine_allowlist
where signature =
  'private.set_backoffice_taxonomy_active(uuid,uuid,timestamptz,text,uuid,bigint,boolean,uuid,uuid)';

revoke all on function private.set_backoffice_taxonomy_active(
  uuid, uuid, timestamptz, text, uuid, bigint, boolean, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;

drop function private.set_backoffice_taxonomy_active(
  uuid, uuid, timestamptz, text, uuid, bigint, boolean, uuid, uuid
);

create function private.transition_backoffice_taxonomy(
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
    return result;
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

  return result;
end;
$function$;

alter function private.transition_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, uuid, uuid
) owner to postgres;

insert into private.dal_routine_allowlist (signature)
values (
  'private.transition_backoffice_taxonomy(uuid,uuid,timestamptz,text,uuid,bigint,text,uuid,uuid)'
);

revoke all on function private.transition_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;

grant execute on function private.transition_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, uuid, uuid
) to app_dal;

comment on function private.transition_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, uuid, uuid
) is 'Deriva arquivamento ou reativação da ação explícita e preserva referências históricas.';
