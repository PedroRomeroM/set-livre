-- A resposta efêmera identifica a tentativa persistida, inclusive no replay.
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
  audited_attempt jsonb;
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
  else
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
      'backoffice.user_pii_revealed',
      'profile',
      p_target_user_id,
      'succeeded',
      p_request_id,
      p_idempotency_key,
      null,
      pg_catalog.jsonb_build_object('reason', p_reason)
    );
  end if;

  -- A unicidade existente (action, target_id, idempotency_key) limita a leitura.
  -- O request_id HTTP pode mudar no replay; a identidade auditada não muda.
  select pg_catalog.jsonb_build_object(
    'action', existing_request.action,
    'idempotencyKey', event.idempotency_key,
    'reason', event.metadata ->> 'reason'
  )
  into audited_attempt
  from audit.events as event
  where event.action = 'backoffice.user_pii_revealed'
    and event.target_id = existing_request.target_id
    and event.idempotency_key = existing_request.idempotency_key
    and event.actor_user_id = existing_request.actor_user_id
    and event.target_type = existing_request.target_type
    and event.result = 'succeeded';

  if not found or audited_attempt ->> 'reason' is distinct from p_reason then
    raise exception using errcode = '40001', message = 'backoffice_pii_audit_mismatch';
  end if;

  return result || audited_attempt;
end;
$function$;

alter function private.reveal_backoffice_user_pii(
  uuid, uuid, timestamptz, uuid, text, uuid, uuid
) owner to postgres;

revoke all on function private.reveal_backoffice_user_pii(
  uuid, uuid, timestamptz, uuid, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function private.reveal_backoffice_user_pii(
  uuid, uuid, timestamptz, uuid, text, uuid, uuid
) to app_dal;
