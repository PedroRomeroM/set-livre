


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "audit";


ALTER SCHEMA "audit" OWNER TO "postgres";


COMMENT ON SCHEMA "audit" IS 'Eventos sensíveis append-only não expostos pela Data API.';



CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


COMMENT ON SCHEMA "private" IS 'Objetos internos e comandos não expostos pela Data API.';



CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "private"."activate_owner"("p_user_id" "uuid", "p_owner_contract_version_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_user_agent_hash" "text") RETURNS TABLE("scope" "uuid", "owner_status" "text", "owner_version" bigint, "accepted_owner_contract_version_id" "uuid", "owner_contract_accepted" boolean, "owner_contract_id" "uuid", "owner_contract_kind" "text", "owner_contract_version" "text", "owner_contract_title" "text", "owner_contract_body_markdown" "text", "owner_contract_content_hash" "text", "owner_contract_source" "text", "owner_contract_effective_at" timestamp with time zone, "recipient_status" "text", "requirements" "text"[], "next_action" "text", "profile_version" bigint, "profile_version_synced" bigint, "recipient_version" bigint, "reservations_eligible" boolean, "provider_mode" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  accepted_at timestamptz := pg_catalog.clock_timestamp();
  contract public.terms_versions%rowtype;
  existing_request private.owner_activation_requests%rowtype;
  owner public.owner_profiles%rowtype;
  profile public.profiles%rowtype;
  transition_action text;
begin
  if p_user_id is null
    or p_owner_contract_version_id is null
    or p_idempotency_key is null
    or p_request_id is null
    or (
      p_user_agent_hash is not null
      and p_user_agent_hash !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_owner_activation';
  end if;

  select candidate.*
  into profile
  from public.profiles as candidate
  where candidate.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_profile_missing';
  end if;

  select request.*
  into existing_request
  from private.owner_activation_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key
  for update;

  if found then
    if existing_request.owner_contract_version_id
      is distinct from p_owner_contract_version_id
    then
      raise exception using errcode = '40001', message = 'owner_idempotency_conflict';
    end if;

    return query
    select * from private.owner_recipient_status_row(p_user_id);
    return;
  end if;

  if profile.status <> 'active' or profile.completed_at is null then
    raise exception using errcode = '42501', message = 'owner_profile_inactive';
  end if;

  select legal_version.*
  into contract
  from public.terms_versions as legal_version
  where legal_version.id = p_owner_contract_version_id
    and legal_version.kind = 'owner_contract'
    and legal_version.effective_at <= accepted_at
    and (
      legal_version.retired_at is null
      or accepted_at < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using errcode = '23514', message = 'owner_contract_stale';
  end if;

  if exists (
    select 1
    from public.terms_acceptances as acceptance
    where acceptance.request_id = p_idempotency_key
      and (
        acceptance.user_id <> p_user_id
        or acceptance.terms_version_id <> p_owner_contract_version_id
      )
  ) then
    raise exception using errcode = '40001', message = 'owner_idempotency_conflict';
  end if;

  select current_owner.*
  into owner
  from public.owner_profiles as current_owner
  where current_owner.user_id = p_user_id
  for update;

  if not found then
    insert into public.owner_profiles (
      user_id,
      status,
      accepted_owner_contract_version_id,
      owner_version
    )
    values (
      p_user_id,
      'active',
      p_owner_contract_version_id,
      1
    )
    returning * into owner;
    transition_action := 'owner.activated';
  elsif owner.status = 'blocked' then
    raise exception using errcode = '42501', message = 'owner_blocked';
  elsif owner.accepted_owner_contract_version_id
    is distinct from p_owner_contract_version_id
  then
    update public.owner_profiles as current_owner
    set accepted_owner_contract_version_id = p_owner_contract_version_id
    where current_owner.user_id = p_user_id
    returning * into owner;
    transition_action := 'owner.contract_renewed';
  end if;

  insert into public.terms_acceptances (
    user_id,
    terms_version_id,
    accepted_content_hash,
    accepted_at,
    request_id,
    ip_hash,
    user_agent_hash
  )
  values (
    p_user_id,
    contract.id,
    contract.content_hash,
    accepted_at,
    p_idempotency_key,
    null,
    p_user_agent_hash
  )
  on conflict (user_id, terms_version_id) do nothing;

  if not exists (
    select 1
    from public.terms_acceptances as acceptance
    where acceptance.user_id = p_user_id
      and acceptance.terms_version_id = contract.id
      and acceptance.accepted_content_hash = contract.content_hash
  ) then
    raise exception using errcode = '23514', message = 'owner_acceptance_invalid';
  end if;

  insert into public.owner_payment_recipients (owner_user_id)
  values (p_user_id)
  on conflict (owner_user_id) do nothing;

  insert into private.owner_activation_requests (
    owner_user_id,
    idempotency_key,
    owner_contract_version_id,
    resulting_owner_version
  )
  values (
    p_user_id,
    p_idempotency_key,
    p_owner_contract_version_id,
    owner.owner_version
  );

  if transition_action is not null then
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
      transition_action,
      'owner_profile',
      p_user_id,
      'succeeded',
      p_request_id,
      p_idempotency_key,
      null,
      pg_catalog.jsonb_build_object(
        'ownerVersion', owner.owner_version,
        'contractVersionId', contract.id
      )
    );
  end if;

  return query
  select * from private.owner_recipient_status_row(p_user_id);
end;
$_$;


ALTER FUNCTION "private"."activate_owner"("p_user_id" "uuid", "p_owner_contract_version_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_user_agent_hash" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."activate_owner"("p_user_id" "uuid", "p_owner_contract_version_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_user_agent_hash" "text") IS 'Ativa ou renova dono com idempotência própria e request ID da fachada para auditoria.';



CREATE OR REPLACE FUNCTION "private"."apply_owner_recipient_operation"("p_user_id" "uuid", "p_operation_id" "uuid", "p_request_id" "uuid", "p_provider" "text", "p_provider_reference" "text", "p_status" "text", "p_requirements" "text"[]) RETURNS TABLE("scope" "uuid", "owner_status" "text", "owner_version" bigint, "accepted_owner_contract_version_id" "uuid", "owner_contract_accepted" boolean, "owner_contract_id" "uuid", "owner_contract_kind" "text", "owner_contract_version" "text", "owner_contract_title" "text", "owner_contract_body_markdown" "text", "owner_contract_content_hash" "text", "owner_contract_source" "text", "owner_contract_effective_at" timestamp with time zone, "recipient_status" "text", "requirements" "text"[], "next_action" "text", "profile_version" bigint, "profile_version_synced" bigint, "recipient_version" bigint, "reservations_eligible" boolean, "provider_mode" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_applied_at timestamptz := pg_catalog.clock_timestamp();
  current_operation private.owner_recipient_operations%rowtype;
  current_profile public.profiles%rowtype;
  current_owner public.owner_profiles%rowtype;
  current_recipient public.owner_payment_recipients%rowtype;
  previous_status text;
  latest_sequence bigint;
begin
  if p_user_id is null
    or p_operation_id is null
    or p_request_id is null
    or p_provider is distinct from 'local'
    or p_provider_reference is null
    or pg_catalog.char_length(p_provider_reference) not between 1 and 200
    or p_provider_reference ~ '[[:cntrl:]]'
    or not (
      p_provider_reference ~ '^local-recipient:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or p_provider_reference in (
        'local-test-fixture:refused',
        'local-test-fixture:suspended',
        'local-test-fixture:blocked',
        'local-test-fixture:unavailable',
        'local-test-fixture:timeout'
      )
    )
    or p_status is null
    or p_status not in ('pending', 'active', 'refused', 'suspended', 'blocked')
    or p_requirements is null
    or pg_catalog.cardinality(p_requirements) > 3
    or pg_catalog.array_position(p_requirements, null) is not null
    or not (
      p_requirements <@ array[
        'identity_review', 'additional_information', 'provider_contact'
      ]::text[]
    )
    or (
      pg_catalog.cardinality(p_requirements) >= 2
      and p_requirements[1] = p_requirements[2]
    )
    or (
      pg_catalog.cardinality(p_requirements) >= 3
      and (
        p_requirements[1] = p_requirements[3]
        or p_requirements[2] = p_requirements[3]
      )
    )
    or (p_status = 'active' and p_requirements <> '{}'::text[])
  then
    raise exception using errcode = '22023', message = 'invalid_recipient_result';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_profile_missing';
  end if;

  select owner.*
  into current_owner
  from public.owner_profiles as owner
  where owner.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_authority_missing';
  end if;

  select recipient.*
  into current_recipient
  from public.owner_payment_recipients as recipient
  where recipient.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'recipient_state_missing';
  end if;

  select operation.*
  into current_operation
  from private.owner_recipient_operations as operation
  where operation.id = p_operation_id
    and operation.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'recipient_operation_missing';
  end if;

  if current_operation.applied_at is not null then
    if current_operation.provider is distinct from p_provider
      or current_operation.provider_reference is distinct from p_provider_reference
      or current_operation.result_status is distinct from p_status
      or current_operation.result_requirements is distinct from p_requirements
    then
      raise exception using errcode = '40001', message = 'recipient_apply_conflict';
    end if;

    return query
    select * from private.owner_recipient_status_row(p_user_id);
    return;
  end if;

  if current_profile.status <> 'active' or current_profile.completed_at is null then
    raise exception using errcode = '42501', message = 'owner_profile_inactive';
  end if;

  if current_owner.status <> 'active' then
    raise exception using errcode = '42501', message = 'owner_blocked';
  end if;

  select pg_catalog.max(operation.operation_sequence)
  into latest_sequence
  from private.owner_recipient_operations as operation
  where operation.owner_user_id = p_user_id;

  if current_operation.operation_sequence <> latest_sequence then
    raise exception using errcode = '40001', message = 'recipient_operation_superseded';
  end if;

  if current_operation.profile_version <> current_profile.profile_version then
    raise exception using errcode = '40001', message = 'recipient_profile_version_changed';
  end if;

  if (
      current_operation.action = 'start'
      and p_provider_reference <> ('local-recipient:' || current_operation.id::text)
    )
    or (
      current_operation.action = 'refresh'
      and p_provider_reference is distinct from current_operation.provider_reference
    )
  then
    raise exception using errcode = '23514', message = 'recipient_provider_reference_changed';
  end if;

  if current_operation.action = 'start'
    and p_status <> 'pending'
  then
    raise exception using errcode = '23514', message = 'recipient_start_result_invalid';
  end if;

  previous_status := current_recipient.status;

  update public.owner_payment_recipients as recipient
  set
    status = p_status,
    requirements = p_requirements,
    profile_version_synced = current_operation.profile_version
  where recipient.owner_user_id = p_user_id
  returning * into current_recipient;

  update private.owner_recipient_operations as operation
  set
    provider = p_provider,
    provider_reference = p_provider_reference,
    result_status = p_status,
    result_requirements = p_requirements,
    applied_at = v_applied_at
  where operation.id = p_operation_id
    and operation.owner_user_id = p_user_id
    and operation.applied_at is null;

  if not found then
    raise exception using errcode = '40001', message = 'recipient_apply_conflict';
  end if;

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
    'recipient.status_transitioned',
    'owner_payment_recipient',
    p_user_id,
    'succeeded',
    p_request_id,
    current_operation.idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'fromStatus', previous_status,
      'toStatus', p_status,
      'recipientVersion', current_recipient.recipient_version,
      'operationSequence', current_operation.operation_sequence
    )
  );

  return query
  select * from private.owner_recipient_status_row(p_user_id);
end;
$_$;


ALTER FUNCTION "private"."apply_owner_recipient_operation"("p_user_id" "uuid", "p_operation_id" "uuid", "p_request_id" "uuid", "p_provider" "text", "p_provider_reference" "text", "p_status" "text", "p_requirements" "text"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."apply_owner_recipient_operation"("p_user_id" "uuid", "p_operation_id" "uuid", "p_request_id" "uuid", "p_provider" "text", "p_provider_reference" "text", "p_status" "text", "p_requirements" "text"[]) IS 'Aplica transição autoritativa do recebedor e correlaciona auditoria ao request ID da fachada.';



CREATE OR REPLACE FUNCTION "private"."assert_editable_studio_media_relation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."assert_editable_studio_media_relation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."assert_editable_studio_revision_relation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."assert_editable_studio_revision_relation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."assert_studio_owner_mutable"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'invalid_studio_owner';
  end if;

  perform profile.id
  from public.profiles as profile
  join public.owner_profiles as owner on owner.user_id = profile.id
  where profile.id = p_user_id
    and profile.status = 'active'
    and profile.completed_at is not null
    and owner.status = 'active'
  for update of profile, owner;

  if not found then
    raise exception using errcode = '42501', message = 'studio_owner_inactive';
  end if;

  if not exists (
    select 1
    from public.owner_profiles as owner
    join public.terms_versions as legal_version
      on legal_version.id = owner.accepted_owner_contract_version_id
    join public.terms_acceptances as acceptance
      on acceptance.user_id = owner.user_id
      and acceptance.terms_version_id = legal_version.id
      and acceptance.accepted_content_hash = legal_version.content_hash
    where owner.user_id = p_user_id
      and legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.clock_timestamp()
      and (
        legal_version.retired_at is null
        or pg_catalog.clock_timestamp() < legal_version.retired_at
      )
  ) then
    raise exception using errcode = '42501', message = 'owner_contract_not_current';
  end if;
end;
$$;


ALTER FUNCTION "private"."assert_studio_owner_mutable"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."audit_studio_media_command"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_studio_id" "uuid", "p_metadata" "jsonb") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
    p_metadata
  );
$$;


ALTER FUNCTION "private"."audit_studio_media_command"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_studio_id" "uuid", "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."audit_studio_publication_command"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_publication_version" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."audit_studio_publication_command"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_publication_version" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."backoffice_payload_hash"("payload" "jsonb") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select pg_catalog.encode(extensions.digest(payload::text, 'sha256'), 'hex');
$$;


ALTER FUNCTION "private"."backoffice_payload_hash"("payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."backoffice_result_hash"("result" "jsonb") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select pg_catalog.encode(extensions.digest(result::text, 'sha256'), 'hex');
$$;


ALTER FUNCTION "private"."backoffice_result_hash"("result" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."backoffice_session_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_required_role" "text", "p_require_strong_authentication" boolean, "p_touch_activity" boolean) RETURNS TABLE("actor_role" "text", "authorization_version" bigint, "roles" "text"[], "expires_at" timestamp with time zone, "strong_authentication_expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."backoffice_session_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_required_role" "text", "p_require_strong_authentication" boolean, "p_touch_activity" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."backoffice_session_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_required_role" "text", "p_require_strong_authentication" boolean, "p_touch_activity" boolean) IS 'Valida binding, perfil e papel explícito; admin substitui deliberadamente support/reviewer.';



CREATE OR REPLACE FUNCTION "private"."backoffice_studio_command_result_json"("p_actor_user_id" "uuid", "p_action" "text", "p_studio_id" "uuid", "p_revision_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."backoffice_studio_command_result_json"("p_actor_user_id" "uuid", "p_action" "text", "p_studio_id" "uuid", "p_revision_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."backoffice_studio_revision_json"("p_revision_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."backoffice_studio_revision_json"("p_revision_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."backoffice_taxonomy_item_json"("p_kind" "text", "p_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  result jsonb;
begin
  if p_kind = 'studioType' then
    select pg_catalog.jsonb_build_object(
      'active', item.active,
      'id', item.id,
      'kind', p_kind,
      'name', item.name,
      'slug', item.slug,
      'sortOrder', item.sort_order,
      'updatedAt', item.updated_at,
      'usageCount', (
        select pg_catalog.count(*)
        from public.studio_revisions as revision
        where revision.studio_type_id = item.id
      ),
      'version', item.taxonomy_version
    )
    into result
    from public.studio_types as item
    where item.id = p_id;
  elsif p_kind = 'tag' then
    select pg_catalog.jsonb_build_object(
      'active', item.active,
      'id', item.id,
      'kind', p_kind,
      'name', item.name,
      'slug', item.slug,
      'sortOrder', item.sort_order,
      'updatedAt', item.updated_at,
      'usageCount', (
        select pg_catalog.count(*)
        from public.studio_revision_tags as relation
        where relation.tag_id = item.id
      ),
      'version', item.taxonomy_version
    )
    into result
    from public.tags as item
    where item.id = p_id;
  elsif p_kind = 'amenity' then
    select pg_catalog.jsonb_build_object(
      'active', item.active,
      'id', item.id,
      'kind', p_kind,
      'name', item.name,
      'slug', item.slug,
      'sortOrder', item.sort_order,
      'updatedAt', item.updated_at,
      'usageCount', (
        select pg_catalog.count(*)
        from public.studio_revision_amenities as relation
        where relation.amenity_id = item.id
      ),
      'version', item.taxonomy_version
    )
    into result
    from public.amenities as item
    where item.id = p_id;
  else
    raise exception using errcode = '22023', message = 'invalid_backoffice_taxonomy_kind';
  end if;

  if result is null then
    raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
  end if;
  return result;
end;
$$;


ALTER FUNCTION "private"."backoffice_taxonomy_item_json"("p_kind" "text", "p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."backoffice_user_pii_json"("p_actor_user_id" "uuid", "p_target_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'additionalDocument', profile.additional_document,
    'email', auth_user.email,
    'name', profile.name,
    'phoneE164', profile.phone_e164,
    'scope', p_actor_user_id,
    'taxId', profile.tax_id,
    'userId', profile.id
  )
  into result
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
    and auth_user.email is not null;

  if result is null then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
  return result;
end;
$$;


ALTER FUNCTION "private"."backoffice_user_pii_json"("p_actor_user_id" "uuid", "p_target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."backoffice_user_summary_json"("p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'accountVersion', profile.account_version,
    'createdAt', profile.created_at,
    'emailMasked', private.mask_backoffice_email(auth_user.email),
    'id', profile.id,
    'status', profile.status
  )
  into result
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where profile.id = p_user_id
    and auth_user.email is not null;

  if result is null then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
  return result;
end;
$$;


ALTER FUNCTION "private"."backoffice_user_summary_json"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."begin_studio_media_finalize_claim"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  candidate jsonb;
  candidate_error text;
  claim private.studio_media_finalize_claims%rowtype;
  claim_time timestamptz;
  conflicting_claim private.studio_media_finalize_claims%rowtype;
  new_lease_token uuid;
  payload_hash text;
  replay jsonb;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_media_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_finalize_claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);
  payload_hash := private.studio_media_payload_hash(
    'studio.media.finalize',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'mediaId', p_media_id
    )
  );
  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.finalize',
    payload_hash,
    p_studio_id,
    p_media_id
  );
  if replay is not null then
    return pg_catalog.jsonb_build_object('state', 'replay', 'result', replay);
  end if;

  loop
    select existing.*
    into claim
    from private.studio_media_finalize_claims as existing
    where existing.owner_user_id = p_user_id
      and existing.idempotency_key = p_idempotency_key
    for update;

    if found then
      if claim.payload_hash <> payload_hash
        or claim.studio_id <> p_studio_id
        or claim.expected_revision_id <> p_expected_revision_id
        or claim.expected_revision_version <> p_expected_revision_version
        or claim.media_id <> p_media_id
      then
        raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
      end if;

      update private.studio_media_finalize_claims as existing
      set latest_request_id = p_request_id
      where existing.owner_user_id = p_user_id
        and existing.idempotency_key = p_idempotency_key
      returning existing.* into claim;

      if claim.terminal_state = 'finalized' then
        replay := private.replay_studio_media_command(
          p_user_id,
          p_idempotency_key,
          'studio.media.finalize',
          payload_hash,
          p_studio_id,
          p_media_id
        );
        if replay is null then
          raise exception using
            errcode = '40001',
            message = 'studio_media_finalize_claim_inconsistent';
        end if;
        return pg_catalog.jsonb_build_object('state', 'replay', 'result', replay);
      end if;
      if claim.terminal_state = 'rejected' then
        return pg_catalog.jsonb_build_object(
          'state', 'rejected',
          'rejectionCode', claim.terminal_rejection_code
        );
      end if;
      exit;
    end if;

    select existing.*
    into conflicting_claim
    from private.studio_media_finalize_claims as existing
    where existing.media_id = p_media_id
    for update;

    if found then
      claim_time := pg_catalog.clock_timestamp();
      if conflicting_claim.terminal_state is null
        and conflicting_claim.lease_token is not null
        and conflicting_claim.lease_expires_at > claim_time
      then
        return pg_catalog.jsonb_build_object(
          'state', 'waiting',
          'retryAfterMs', least(
            250,
            greatest(
              1,
              pg_catalog.ceil(
                extract(epoch from (conflicting_claim.lease_expires_at - claim_time)) * 1000
              )::integer
            )
          )
        );
      end if;
      raise exception using
        errcode = '40001',
        message = 'studio_media_finalize_key_conflict';
    end if;

    begin
      insert into private.studio_media_finalize_claims (
        owner_user_id,
        idempotency_key,
        payload_hash,
        studio_id,
        expected_revision_id,
        expected_revision_version,
        media_id,
        latest_request_id
      ) values (
        p_user_id,
        p_idempotency_key,
        payload_hash,
        p_studio_id,
        p_expected_revision_id,
        p_expected_revision_version,
        p_media_id,
        p_request_id
      )
      returning * into claim;
      exit;
    exception
      when unique_violation then
        null;
    end;
  end loop;

  claim_time := pg_catalog.clock_timestamp();
  if claim.lease_token is not null and claim.lease_expires_at > claim_time then
    return pg_catalog.jsonb_build_object(
      'state', 'waiting',
      'retryAfterMs', least(
        250,
        greatest(
          1,
          pg_catalog.ceil(extract(epoch from (claim.lease_expires_at - claim_time)) * 1000)::integer
        )
      )
    );
  end if;

  perform 1
  from public.studios as studio
  join public.studio_media as media on media.studio_id = studio.id
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
    and media.id = p_media_id
    and media.prepared_revision_id = p_expected_revision_id
    and media.uploaded_by = p_user_id
    and media.status = 'pending_upload';
  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;

  new_lease_token := extensions.gen_random_uuid();
  update private.studio_media_finalize_claims as existing
  set
    lease_token = new_lease_token,
    lease_claimed_at = claim_time,
    lease_expires_at = claim_time + interval '30 seconds'
  where existing.owner_user_id = p_user_id
    and existing.idempotency_key = p_idempotency_key
    and existing.terminal_state is null
    and (
      existing.lease_token is null
      or existing.lease_expires_at <= claim_time
    )
  returning existing.* into claim;

  if not found then
    raise exception using errcode = '40001', message = 'studio_media_finalize_claim_lost';
  end if;

  begin
    candidate := private.get_studio_media_upload_candidate(
      claim.owner_user_id,
      claim.studio_id,
      claim.expected_revision_id,
      claim.expected_revision_version,
      claim.media_id
    );
  exception
    when sqlstate '40001' then
      get stacked diagnostics candidate_error = message_text;
      if candidate_error = 'studio_revision_conflict' then
        return pg_catalog.jsonb_build_object(
          'state', 'superseded',
          'claimToken', claim.lease_token,
          'leaseExpiresAt', claim.lease_expires_at
        );
      end if;
      raise;
  end;

  return pg_catalog.jsonb_build_object(
    'state', 'acquired',
    'claimToken', claim.lease_token,
    'leaseExpiresAt', claim.lease_expires_at,
    'candidate', candidate
  );
end;
$$;


ALTER FUNCTION "private"."begin_studio_media_finalize_claim"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."begin_studio_media_finalize_claim"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") IS 'Persiste a identidade antes de trabalho externo, serializa uma chave por mídia, adquire lease de 30 s e devolve o candidato somente junto do token cercado.';



CREATE OR REPLACE FUNCTION "private"."bootstrap_first_platform_admin"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  result jsonb;
begin
  if p_user_id is null or p_request_id is null or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'invalid_backoffice_admin_bootstrap';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0)
  );

  if exists (
    select 1
    from audit.events as event
    where event.action = 'backoffice.admin_bootstrapped'
      and event.target_type = 'platform_role'
      and event.target_id = p_user_id
      and event.idempotency_key = p_idempotency_key
  ) then
    if not exists (
      select 1
      from public.platform_roles as platform_role
      where platform_role.user_id = p_user_id
        and platform_role.role = 'admin'
    ) then
      raise exception using errcode = '40001', message = 'backoffice_admin_bootstrap_result_stale';
    end if;
    return private.backoffice_user_summary_json(p_user_id);
  end if;

  if exists (select 1 from public.platform_roles) then
    raise exception using errcode = '42501', message = 'backoffice_admin_bootstrap_unavailable';
  end if;

  perform 1
  from public.profiles as profile
  where profile.id = p_user_id
    and profile.status = 'active'
    and profile.completed_at is not null
  for share;

  if not found then
    raise exception using errcode = '42501', message = 'backoffice_admin_bootstrap_profile_ineligible';
  end if;

  perform 1
  from auth.users as auth_user
  where auth_user.id = p_user_id
    and auth_user.email is not null
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;

  insert into public.platform_roles (user_id, role, granted_by)
  values (p_user_id, 'admin', null);

  result := private.backoffice_user_summary_json(p_user_id);

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
    null,
    'system',
    'backoffice.admin_bootstrapped',
    'platform_role',
    p_user_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object('role', 'admin')
  );

  return result;
end;
$$;


ALTER FUNCTION "private"."bootstrap_first_platform_admin"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."bootstrap_first_platform_admin"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid") IS 'Bootstrap único e auditado do primeiro admin; executável somente pelo operador PostgreSQL.';



CREATE OR REPLACE FUNCTION "private"."bootstrap_signup_identity"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  accepted_at timestamptz := pg_catalog.clock_timestamp();
  intent private.signup_legal_intents%rowtype;
  intent_token_text text;
begin
  intent_token_text := new.raw_user_meta_data ->> 'sl_legal_intent';

  if intent_token_text is null
    or intent_token_text !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_intent_required';
  end if;

  select pending_intent.*
  into intent
  from private.signup_legal_intents as pending_intent
  where pending_intent.id = intent_token_text::uuid
  for update;

  if not found or intent.expires_at <= accepted_at then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_intent_invalid';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = intent.terms_version_id
    and legal_version.kind = 'terms'
    and legal_version.effective_at <= accepted_at
    and (
      legal_version.retired_at is null
      or accepted_at < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = intent.privacy_version_id
    and legal_version.kind = 'privacy'
    and legal_version.effective_at <= accepted_at
    and (
      legal_version.retired_at is null
      or accepted_at < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  insert into public.profiles (
    id,
    person_type,
    status,
    completed_at
  )
  values (
    new.id,
    intent.person_type,
    'active',
    null
  );

  insert into public.terms_acceptances (
    user_id,
    terms_version_id,
    accepted_content_hash,
    accepted_at,
    request_id,
    ip_hash,
    user_agent_hash
  )
  select
    new.id,
    legal_version.id,
    legal_version.content_hash,
    accepted_at,
    intent.request_id,
    intent.ip_hash,
    intent.user_agent_hash
  from public.terms_versions as legal_version
  where legal_version.id in (
    intent.terms_version_id,
    intent.privacy_version_id
  );

  delete from private.signup_legal_intents as pending_intent
  where pending_intent.id = intent.id;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_intent_invalid';
  end if;

  update auth.users as auth_user
  set raw_user_meta_data =
    coalesce(auth_user.raw_user_meta_data, '{}'::jsonb)
      - 'sl_legal_intent'
  where auth_user.id = new.id;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_metadata_scrub_failed';
  end if;

  return new;
end;
$_$;


ALTER FUNCTION "private"."bootstrap_signup_identity"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."bootstrap_signup_identity"() IS 'Apaga a intenção válida no INSERT de auth.users e cria perfil, aceites e scrub de metadata atomicamente.';



CREATE OR REPLACE FUNCTION "private"."bootstrap_user_preferences"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.user_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;


ALTER FUNCTION "private"."bootstrap_user_preferences"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."can_sign_backoffice_studio_media"("p_object_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."can_sign_backoffice_studio_media"("p_object_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."canonical_platform_roles"("p_roles" "text"[]) RETURNS "text"[]
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."canonical_platform_roles"("p_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."check_readiness"("expected_version" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
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
$_$;


ALTER FUNCTION "private"."check_readiness"("expected_version" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."check_readiness"("expected_version" "text") IS 'Health fail-closed: DAL, grants/policies editoriais exatos e única policy sign_many para preview.';



CREATE OR REPLACE FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with session_role as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = session_user
      and role.rolname = expected_session_role
      and role.rolcanlogin
      and not role.rolinherit
      and not role.rolsuper
      and not role.rolcreatedb
      and not role.rolcreaterole
      and not role.rolreplication
      and not role.rolbypassrls
      and role.rolconnlimit = 10
      and role.rolvaliduntil = 'infinity'::timestamptz
      and role.rolconfig is null
      and (
        (
          role.rolname = 'app_runtime_production'
          and (
            select pg_catalog.count(*) = 1
              and pg_catalog.bool_and(
                setting.setdatabase = (
                  select database.oid
                  from pg_catalog.pg_database as database
                  where database.datname = pg_catalog.current_database()
                )
                and setting.setconfig = array['role=app_dal']::text[]
              )
            from pg_catalog.pg_db_role_setting as setting
            where setting.setrole = role.oid
          )
        )
        or (
          role.rolname = 'app_runtime_local'
          and (
            select pg_catalog.count(*) = 1
              and pg_catalog.bool_and(
                setting.setdatabase = (
                  select database.oid
                  from pg_catalog.pg_database as database
                  where database.datname = pg_catalog.current_database()
                )
                and setting.setconfig = array['app.settings.jwt_secret=']::text[]
              )
            from pg_catalog.pg_db_role_setting as setting
            where setting.setrole = role.oid
          )
        )
      )
  ),
  memberships_are_restricted as (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        granted.rolname = 'app_dal'
        and not membership.admin_option
        and not membership.inherit_option
        and membership.set_option
      ) as ready
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    cross join session_role
    where membership.member = session_role.oid
  ),
  direct_database_privilege_is_restricted as (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        privilege.grantee = session_role.oid
        and privilege.privilege_type = 'CONNECT'
        and not privilege.is_grantable
      ) as ready
    from pg_catalog.pg_database as database
    cross join lateral pg_catalog.aclexplode(database.datacl) as privilege
    cross join session_role
    where database.datname = pg_catalog.current_database()
      and privilege.grantee = session_role.oid
  ),
  direct_acl_dependencies_are_restricted as (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        dependency.dbid = 0
        and dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
        and dependency.objid = (
          select database.oid
          from pg_catalog.pg_database as database
          where database.datname = pg_catalog.current_database()
        )
        and dependency.objsubid = 0
      ) as ready
    from pg_catalog.pg_shdepend as dependency
    cross join session_role
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.refobjid = session_role.oid
      and dependency.deptype = 'a'
  )
  select coalesce(
    pg_catalog.current_setting('role', true) = 'app_dal'
    and pg_catalog.pg_has_role(session_user, 'app_dal', 'MEMBER')
    and (select ready from memberships_are_restricted)
    and (select ready from direct_database_privilege_is_restricted)
    and (select ready from direct_acl_dependencies_are_restricted)
    and private.managed_runtime_boundaries_are_ready()
    and not pg_catalog.has_database_privilege(
      session_user,
      pg_catalog.current_database(),
      'TEMPORARY'
    )
    and not pg_catalog.has_database_privilege(
      'app_dal',
      pg_catalog.current_database(),
      'TEMPORARY'
    )
    and not exists (
      select 1
      from pg_catalog.pg_shdepend as dependency
      cross join session_role
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.refobjid = session_role.oid
        and dependency.deptype = 'o'
    ),
    false
  );
$$;


ALTER FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") IS 'Health do login restrito: assume app_dal por configuração canônica do database e possui somente CONNECT direto, sem ownership ou ACL adicional.';



CREATE OR REPLACE FUNCTION "private"."claim_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  claim_time timestamptz := pg_catalog.clock_timestamp();
  grant_claimed boolean;
begin
  if p_token is null
    or p_user_id is null
    or p_auth_session_id is null
    or p_session_scope is null
    or p_attempt_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    return false;
  end if;

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = p_attempt_id,
    claimed_at = coalesce(recovery_grant.claimed_at, claim_time)
  from private.identity_recovery_sessions as recovery_session
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.auth_session_id = p_auth_session_id
    and recovery_grant.expires_at > claim_time
    and recovery_session.auth_session_id = recovery_grant.auth_session_id
    and recovery_session.user_id = recovery_grant.user_id
    and recovery_session.session_scope = p_session_scope
    and recovery_session.closed_at is null
    and (
      recovery_grant.claim_attempt_id is null
      or recovery_grant.claim_attempt_id = p_attempt_id
    )
  returning true into grant_claimed;

  return coalesce(grant_claimed, false);
end;
$$;


ALTER FUNCTION "private"."claim_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."claim_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") IS 'Reserva exclusivamente grant vigente que corresponde a user, session_id e scope da binding ativa.';



CREATE OR REPLACE FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  claim_time timestamptz;
  grant_claimed boolean;
begin
  if p_token is null or p_user_id is null or p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  claim_time := pg_catalog.clock_timestamp();

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = p_attempt_id,
    claimed_at = coalesce(recovery_grant.claimed_at, claim_time)
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.expires_at > claim_time
    and (
      recovery_grant.claim_attempt_id is null
      or recovery_grant.claim_attempt_id = p_attempt_id
    )
  returning true into grant_claimed;

  return coalesce(grant_claimed, false);
end;
$$;


ALTER FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") IS 'Reserva exclusivamente um grant vigente; retry da mesma tentativa é idempotente.';



CREATE OR REPLACE FUNCTION "private"."clone_studio_revision_content_before_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."clone_studio_revision_content_before_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."clone_studio_revision_media_after_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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

  insert into public.studio_revision_media (revision_id, media_id, position, is_cover)
  select new.id, relation.media_id, relation.position, relation.is_cover
  from public.studio_revision_media as relation
  where relation.revision_id = source_revision_id
  order by relation.position;

  return new;
end;
$$;


ALTER FUNCTION "private"."clone_studio_revision_media_after_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."clone_studio_revision_relations_after_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."clone_studio_revision_relations_after_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."close_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if p_user_id is null or p_auth_session_id is null then
    raise exception using errcode = '22023', message = 'invalid_backoffice_session';
  end if;
  update private.backoffice_sessions as session_binding
  set closed_at = coalesce(session_binding.closed_at, pg_catalog.clock_timestamp())
  where session_binding.auth_session_id = p_auth_session_id
    and session_binding.user_id = p_user_id;
  return found;
end;
$$;


ALTER FUNCTION "private"."close_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."close_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") IS 'Fecha de forma idempotente a sessão curta correspondente ao usuário e session_id Auth.';



CREATE OR REPLACE FUNCTION "private"."close_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  binding_closed boolean;
begin
  if p_user_id is null or p_auth_session_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_session';
  end if;

  update private.identity_recovery_sessions as recovery_session
  set closed_at = coalesce(
    recovery_session.closed_at,
    pg_catalog.clock_timestamp()
  )
  where recovery_session.auth_session_id = p_auth_session_id
    and recovery_session.user_id = p_user_id
  returning true into binding_closed;

  if coalesce(binding_closed, false) then
    delete from private.identity_recovery_grants as recovery_grant
    where recovery_grant.auth_session_id = p_auth_session_id
      and recovery_grant.user_id = p_user_id;
  end if;

  return coalesce(binding_closed, false);
end;
$$;


ALTER FUNCTION "private"."close_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."close_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") IS 'Fecha a binding e remove seu grant; o tombstone persiste para bloquear replay da sessão Auth.';



CREATE OR REPLACE FUNCTION "private"."complete_profile"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_person_type" "text", "p_name" "text", "p_phone_e164" "text", "p_tax_id" "text", "p_additional_document" "text") RETURNS TABLE("user_id" "uuid", "person_type" "text", "status" "text", "name" "text", "phone_e164" "text", "tax_id_masked" "text", "additional_document_masked" "text", "profile_completed" boolean, "profile_version" bigint, "color_scheme" "text", "preferences_version" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  current_profile public.profiles%rowtype;
begin
  if p_user_id is null
    or p_expected_profile_version is null
    or p_expected_profile_version < 0
    or p_person_type is null
    or p_person_type not in ('individual', 'company')
    or p_name is null
    or pg_catalog.char_length(p_name) not between 2 and 160
    or p_name <> pg_catalog.btrim(p_name)
    or p_name ~ '[[:cntrl:]]'
    or p_phone_e164 is null
    or p_phone_e164 !~ '^\+55[1-9][0-9]([2-5][0-9]{7}|9[0-9]{8})$'
    or p_tax_id is null
    or (
      p_person_type = 'individual'
      and not private.is_valid_cpf(p_tax_id)
    )
    or (
      p_person_type = 'company'
      and not private.is_valid_cnpj(p_tax_id)
    )
    or (
      p_additional_document is not null
      and (
        pg_catalog.char_length(p_additional_document) not between 3 and 40
        or p_additional_document !~ '^[A-Z0-9]+([./ -][A-Z0-9]+)*$'
      )
    )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_profile_input';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'profile_not_found';
  end if;

  if current_profile.status <> 'active' then
    raise exception using errcode = '42501', message = 'profile_inactive';
  end if;

  if current_profile.completed_at is not null then
    if current_profile.person_type = p_person_type
      and current_profile.name = p_name
      and current_profile.phone_e164 = p_phone_e164
      and current_profile.tax_id = p_tax_id
      and current_profile.additional_document is not distinct from p_additional_document
    then
      return query select * from private.profile_command_result(p_user_id);
      return;
    end if;

    raise exception using errcode = '40001', message = 'profile_already_completed';
  end if;

  if current_profile.profile_version <> p_expected_profile_version then
    raise exception using errcode = '40001', message = 'profile_version_conflict';
  end if;

  if (
    select pg_catalog.count(distinct legal_version.kind)
    from public.terms_acceptances as acceptance
    join public.terms_versions as legal_version
      on legal_version.id = acceptance.terms_version_id
    where acceptance.user_id = p_user_id
      and legal_version.kind in ('terms', 'privacy')
  ) <> 2 then
    raise exception using
      errcode = 'P0001',
      message = 'profile_legal_acceptances_missing';
  end if;

  update public.profiles as profile
  set
    person_type = p_person_type,
    name = p_name,
    phone_e164 = p_phone_e164,
    tax_id = p_tax_id,
    additional_document = p_additional_document,
    completed_at = pg_catalog.clock_timestamp()
  where profile.id = p_user_id;

  return query select * from private.profile_command_result(p_user_id);
end;
$_$;


ALTER FUNCTION "private"."complete_profile"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_person_type" "text", "p_name" "text", "p_phone_e164" "text", "p_tax_id" "text", "p_additional_document" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."complete_profile"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_person_type" "text", "p_name" "text", "p_phone_e164" "text", "p_tax_id" "text", "p_additional_document" "text") IS 'Completa uma única vez o perfil ativo, valida aceites preexistentes e permite a correção final de PF/PJ.';



CREATE OR REPLACE FUNCTION "private"."confirm_studio_media_upload_token"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  issued_time timestamptz := pg_catalog.clock_timestamp();
  media public.studio_media%rowtype;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_media_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_upload_token_confirmation';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('studio-media-reject:' || p_media_id::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  perform studio.id
  from public.studios as studio
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;

  perform revision.id
  from public.studio_revisions as revision
  where revision.id = p_expected_revision_id
    and revision.studio_id = p_studio_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;

  select candidate.*
  into media
  from public.studio_media as candidate
  where candidate.id = p_media_id
    and candidate.studio_id = p_studio_id
    and candidate.prepared_revision_id = p_expected_revision_id
    and candidate.uploaded_by = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;
  if media.status = 'rejected'
    and media.rejection_code = 'upload_token_signing_failed'
  then
    raise exception using errcode = '40001', message = 'studio_media_upload_token_rejected';
  end if;
  if media.status <> 'pending_upload' then
    raise exception using errcode = '40001', message = 'studio_media_upload_token_conflict';
  end if;
  if media.upload_token_issued_at is null and media.upload_expires_at <= issued_time then
    raise exception using errcode = '40001', message = 'studio_media_upload_expired';
  end if;

  update public.studio_media as candidate
  set upload_token_issued_at = coalesce(candidate.upload_token_issued_at, issued_time)
  where candidate.id = media.id
  returning candidate.* into media;

  return pg_catalog.jsonb_build_object(
    'scope', p_user_id,
    'studioId', p_studio_id,
    'revisionId', p_expected_revision_id,
    'revisionVersion', p_expected_revision_version,
    'mediaId', p_media_id,
    'state', 'issued',
    'issuedAt', media.upload_token_issued_at
  );
end;
$$;


ALTER FUNCTION "private"."confirm_studio_media_upload_token"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."confirm_studio_media_upload_token"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid") IS 'Confirma atomicamente a primeira autorização assinada antes que o token alcance o navegador.';



CREATE OR REPLACE FUNCTION "private"."consume_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  grant_consumed boolean;
begin
  if p_token is null
    or p_user_id is null
    or p_auth_session_id is null
    or p_session_scope is null
    or p_attempt_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    return false;
  end if;

  delete from private.identity_recovery_grants as recovery_grant
  using private.identity_recovery_sessions as recovery_session
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.auth_session_id = p_auth_session_id
    and recovery_grant.claim_attempt_id = p_attempt_id
    and recovery_session.auth_session_id = recovery_grant.auth_session_id
    and recovery_session.user_id = recovery_grant.user_id
    and recovery_session.session_scope = p_session_scope
    and recovery_session.closed_at is null
  returning true into grant_consumed;

  return coalesce(grant_consumed, false);
end;
$$;


ALTER FUNCTION "private"."consume_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."consume_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") IS 'Consome o grant da tentativa sem remover o tombstone da sessão recovery.';



CREATE OR REPLACE FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  grant_consumed boolean;
begin
  if p_token is null or p_user_id is null or p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  delete from private.identity_recovery_grants as recovery_grant
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.claim_attempt_id = p_attempt_id
  returning true into grant_consumed;

  return coalesce(grant_consumed, false);
end;
$$;


ALTER FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") IS 'Remove somente o grant reservado pela tentativa após sucesso do provedor.';



CREATE OR REPLACE FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  existing_intent private.signup_legal_intents%rowtype;
  intent_created_at timestamptz;
  intent_id uuid;
  normalized_ip_hash text;
  normalized_user_agent_hash text;
begin
  if expected_terms_version_id is null
    or expected_privacy_version_id is null
    or person_type is null
    or request_id is null
    or evidence is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_signup_legal_intent';
  end if;

  if person_type not in ('individual', 'company')
    or pg_catalog.jsonb_typeof(evidence) <> 'object'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(evidence) as evidence_key(key)
      where evidence_key.key not in ('ipHash', 'userAgentHash')
    )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_signup_legal_intent';
  end if;

  normalized_ip_hash := evidence ->> 'ipHash';
  normalized_user_agent_hash := evidence ->> 'userAgentHash';

  if (
      normalized_ip_hash is not null
      and normalized_ip_hash !~ '^[0-9a-f]{64}$'
    )
    or (
      normalized_user_agent_hash is not null
      and normalized_user_agent_hash !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_signup_legal_evidence';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = expected_terms_version_id
    and legal_version.kind = 'terms'
    and legal_version.effective_at <= pg_catalog.clock_timestamp()
    and (
      legal_version.retired_at is null
      or pg_catalog.clock_timestamp() < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = expected_privacy_version_id
    and legal_version.kind = 'privacy'
    and legal_version.effective_at <= pg_catalog.clock_timestamp()
    and (
      legal_version.retired_at is null
      or pg_catalog.clock_timestamp() < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  delete from private.signup_legal_intents as expired_intent
  where expired_intent.expires_at <= pg_catalog.clock_timestamp();

  intent_created_at := pg_catalog.clock_timestamp();

  insert into private.signup_legal_intents (
    terms_version_id,
    privacy_version_id,
    person_type,
    request_id,
    ip_hash,
    user_agent_hash,
    created_at,
    expires_at
  )
  values (
    expected_terms_version_id,
    expected_privacy_version_id,
    create_signup_legal_intent.person_type,
    create_signup_legal_intent.request_id,
    normalized_ip_hash,
    normalized_user_agent_hash,
    intent_created_at,
    intent_created_at + interval '10 minutes'
  )
  on conflict on constraint signup_legal_intents_request_id_key do nothing
  returning id into intent_id;

  if found then
    return intent_id;
  end if;

  select intent.*
  into existing_intent
  from private.signup_legal_intents as intent
  where intent.request_id = create_signup_legal_intent.request_id
  for update;

  if found
    and existing_intent.expires_at > pg_catalog.clock_timestamp()
    and existing_intent.terms_version_id = expected_terms_version_id
    and existing_intent.privacy_version_id = expected_privacy_version_id
    and existing_intent.person_type = create_signup_legal_intent.person_type
    and existing_intent.ip_hash is not distinct from normalized_ip_hash
    and existing_intent.user_agent_hash
      is not distinct from normalized_user_agent_hash
  then
    return existing_intent.id;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'signup_legal_request_conflict';
end;
$_$;


ALTER FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") IS 'Purga tokens expirados e cria token opaco idempotente enquanto o request_id permanece pendente.';



CREATE OR REPLACE FUNCTION "private"."create_studio"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  editor jsonb;
  existing_request private.studio_command_requests%rowtype;
  payload_hash text;
  revision_id uuid := extensions.gen_random_uuid();
  studio_id uuid := extensions.gen_random_uuid();
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_request_id is null
    or p_studio_type_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_create';
  end if;

  payload_hash := private.studio_core_payload_hash(
    p_name,
    p_description,
    p_street,
    p_street_number,
    p_address_complement,
    p_neighborhood,
    p_city,
    p_state,
    p_postal_code,
    p_capacity,
    p_studio_type_id
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
    if existing_request.action <> 'studio.create'
      or existing_request.payload_hash <> payload_hash
    then
      raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
    end if;

    editor := private.studio_editor_json(p_user_id, existing_request.studio_id);
    if editor is null then
      raise exception using errcode = '40001', message = 'studio_create_result_missing';
    end if;
    if private.studio_result_hash(editor) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'studio_create_result_stale';
    end if;
    return editor;
  end if;

  if not exists (
    select 1
    from public.studio_types as studio_type
    where studio_type.id = p_studio_type_id
      and studio_type.active
    for share
  ) then
    raise exception using errcode = '23514', message = 'studio_type_inactive';
  end if;

  with inserted_studio as (
    insert into public.studios (id, owner_user_id, status, draft_revision_id)
    values (studio_id, p_user_id, 'draft', revision_id)
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
    revision_id,
    inserted_studio.id,
    1,
    1,
    'draft',
    p_name,
    p_description,
    p_street,
    p_street_number,
    p_address_complement,
    p_neighborhood,
    p_city,
    p_state,
    p_postal_code,
    p_capacity,
    p_studio_type_id
  from inserted_studio;

  editor := private.studio_editor_json(p_user_id, studio_id);
  if editor is null then
    raise exception using errcode = 'P0002', message = 'studio_create_result_missing';
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
    'studio.create',
    payload_hash,
    private.studio_result_hash(editor),
    studio_id,
    revision_id,
    1
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
    'studio.created',
    'studio',
    studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'revisionId', revision_id,
      'revisionNumber', 1,
      'revisionVersion', 1
    )
  );

  return editor;
end;
$$;


ALTER FUNCTION "private"."create_studio"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."create_studio"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") IS 'Cria estúdio e primeira revisão draft de forma atômica e idempotente.';



CREATE OR REPLACE FUNCTION "private"."delete_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  media_count integer;
  media_is_cover boolean;
  media_status text;
  payload_hash text;
  replay jsonb;
  result jsonb;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_media_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_delete';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.delete',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'mediaId', p_media_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.delete',
    payload_hash,
    p_studio_id,
    p_media_id
  );
  if replay is not null then
    return replay;
  end if;

  select locked.locked_revision_id, locked.locked_revision_version
  into draft_revision_id, draft_revision_version
  from private.lock_studio_media_revision(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as locked;

  select relation.is_cover,
    (
      select pg_catalog.count(*)::integer
      from public.studio_revision_media as counted
      where counted.revision_id = draft_revision_id
    )
  into media_is_cover, media_count
  from public.studio_revision_media as relation
  where relation.revision_id = draft_revision_id
    and relation.media_id = p_media_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;
  if media_is_cover and media_count > 1 then
    raise exception using errcode = '23514', message = 'studio_media_cover_replacement_required';
  end if;

  set constraints public.studio_revision_media_position_key deferred;

  delete from public.studio_revision_media as relation
  where relation.revision_id = draft_revision_id
    and relation.media_id = p_media_id;

  with ordered as (
    select relation.media_id,
      pg_catalog.row_number() over (order by relation.position)::smallint as position
    from public.studio_revision_media as relation
    where relation.revision_id = draft_revision_id
  )
  update public.studio_revision_media as relation
  set position = ordered.position
  from ordered
  where relation.revision_id = draft_revision_id
    and relation.media_id = ordered.media_id
    and relation.position <> ordered.position;

  update public.studio_revisions as revision
  set revision_version = revision.revision_version + 1
  where revision.id = draft_revision_id
    and revision.status = 'draft'
    and revision.revision_version = draft_revision_version
  returning revision.revision_version into resulting_revision_version;

  if not found then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  select media.status
  into media_status
  from public.studio_media as media
  where media.id = p_media_id;

  result := private.get_owner_studio_media(p_user_id, p_studio_id);
  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.delete',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    resulting_revision_version,
    p_media_id,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_deleted',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'mediaId', p_media_id,
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'objectStatus', media_status
    )
  );

  return result;
end;
$$;


ALTER FUNCTION "private"."delete_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."delete_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") IS 'Remove somente a associação da draft; objeto compartilhado permanece e órfão entra em delete_pending.';



CREATE OR REPLACE FUNCTION "private"."discard_studio_draft"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  current_revision public.studio_revisions%rowtype;
  current_studio public.studios%rowtype;
  editor jsonb;
  existing_request private.studio_command_requests%rowtype;
  payload_hash text;
  published_revision public.studio_revisions%rowtype;
  result jsonb;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_discard';
  end if;

  payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'studioId', p_studio_id,
          'expectedRevisionId', p_expected_revision_id,
          'expectedRevisionVersion', p_expected_revision_version
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
    if existing_request.action <> 'studio.draft.discard'
      or existing_request.payload_hash <> payload_hash
      or existing_request.studio_id <> p_studio_id
    then
      raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
    end if;

    if existing_request.studio_deleted then
      result := pg_catalog.jsonb_build_object(
        'scope', p_user_id,
        'studioId', p_studio_id,
        'studioDeleted', true
      );
    else
      editor := private.studio_editor_json(p_user_id, p_studio_id);
      if editor is null then
        raise exception using errcode = '40001', message = 'studio_discard_result_missing';
      end if;
      result := pg_catalog.jsonb_build_object(
        'scope', p_user_id,
        'studioId', p_studio_id,
        'studioDeleted', false,
        'editor', editor
      );
    end if;
    if private.studio_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'studio_discard_result_stale';
    end if;
    return result;
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
  if current_studio.draft_revision_id is null then
    raise exception using errcode = '40001', message = 'studio_draft_missing';
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
    or current_revision.status <> 'draft'
  then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  if current_studio.published_revision_id is null then
    result := pg_catalog.jsonb_build_object(
      'scope', p_user_id,
      'studioId', p_studio_id,
      'studioDeleted', true
    );

    insert into private.studio_command_requests (
      owner_user_id,
      idempotency_key,
      action,
      payload_hash,
      result_hash,
      studio_id,
      resulting_revision_id,
      resulting_revision_version,
      studio_deleted
    )
    values (
      p_user_id,
      p_idempotency_key,
      'studio.draft.discard',
      payload_hash,
      private.studio_result_hash(result),
      p_studio_id,
      null,
      null,
      true
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
      'studio.draft_discarded',
      'studio',
      p_studio_id,
      'succeeded',
      p_request_id,
      p_idempotency_key,
      null,
      pg_catalog.jsonb_build_object(
        'revisionId', current_revision.id,
        'studioDeleted', true
      )
    );

    delete from public.studios as studio where studio.id = p_studio_id;

    return result;
  end if;

  select revision.*
  into published_revision
  from public.studio_revisions as revision
  where revision.id = current_studio.published_revision_id
    and revision.studio_id = current_studio.id;

  if not found or published_revision.status <> 'approved' then
    raise exception using errcode = '23514', message = 'studio_published_state_invalid';
  end if;

  update public.studios as studio
  set draft_revision_id = null
  where studio.id = p_studio_id;

  delete from public.studio_revisions as revision
  where revision.id = current_revision.id;

  editor := private.studio_editor_json(p_user_id, p_studio_id);
  if editor is null then
    raise exception using errcode = 'P0002', message = 'studio_discard_result_missing';
  end if;
  result := pg_catalog.jsonb_build_object(
    'scope', p_user_id,
    'studioId', p_studio_id,
    'studioDeleted', false,
    'editor', editor
  );

  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    studio_id,
    resulting_revision_id,
    resulting_revision_version,
    studio_deleted
  )
  values (
    p_user_id,
    p_idempotency_key,
    'studio.draft.discard',
    payload_hash,
    private.studio_result_hash(result),
    p_studio_id,
    published_revision.id,
    published_revision.revision_version,
    false
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
    'studio.draft_discarded',
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'revisionId', current_revision.id,
      'studioDeleted', false
    )
  );

  return result;
end;
$$;


ALTER FUNCTION "private"."discard_studio_draft"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."discard_studio_draft"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Descarta somente draft esperado; remove o estúdio ainda inédito ou preserva a revisão publicada.';



CREATE OR REPLACE FUNCTION "private"."enforce_owner_profile_state"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  contract_kind text;
begin
  select legal_version.kind
  into contract_kind
  from public.terms_versions as legal_version
  where legal_version.id = new.accepted_owner_contract_version_id;

  if contract_kind is distinct from 'owner_contract' then
    raise exception using
      errcode = '23514',
      message = 'owner_contract_kind_invalid';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'active' or new.owner_version <> 1 then
      raise exception using
        errcode = '23514',
        message = 'owner_initial_state_invalid';
    end if;
    return new;
  end if;

  if old.status = 'blocked'
    and (
      new.status is distinct from old.status
      or new.accepted_owner_contract_version_id
        is distinct from old.accepted_owner_contract_version_id
    )
  then
    raise exception using
      errcode = '23514',
      message = 'owner_blocked_is_terminal';
  end if;

  new.owner_version := old.owner_version + 1;
  new.activated_at := old.activated_at;
  new.created_at := old.created_at;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


ALTER FUNCTION "private"."enforce_owner_profile_state"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."enforce_owner_recipient_state"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'not_started'
      or new.recipient_version <> 0
      or new.profile_version_synced is not null
      or new.requirements <> '{}'::text[]
    then
      raise exception using
        errcode = '23514',
        message = 'recipient_initial_state_invalid';
    end if;
    return new;
  end if;

  if not (
    (old.status = 'not_started' and new.status = 'pending')
    or (
      old.status = 'pending'
      and new.status in ('pending', 'active', 'refused', 'suspended', 'blocked')
    )
    or (
      old.status = 'active'
      and new.status in ('active', 'refused', 'suspended', 'blocked')
    )
    or (
      old.status = 'refused'
      and new.status in ('pending', 'refused', 'blocked')
    )
    or (
      old.status = 'suspended'
      and new.status in ('pending', 'active', 'suspended', 'blocked')
    )
    or (old.status = 'blocked' and new.status = 'blocked')
  ) then
    raise exception using
      errcode = '23514',
      message = 'recipient_transition_invalid';
  end if;

  new.recipient_version := old.recipient_version + 1;
  new.created_at := old.created_at;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


ALTER FUNCTION "private"."enforce_owner_recipient_state"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."enforce_profile_lifecycle"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if old.completed_at is not null
    and new.completed_at is distinct from old.completed_at
  then
    raise exception using
      errcode = 'P0001',
      message = 'profile_completion_is_immutable';
  end if;

  if new.person_type is distinct from old.person_type
    and not (old.completed_at is null and new.completed_at is not null)
  then
    raise exception using
      errcode = 'P0001',
      message = 'profile_person_type_change_requires_completion';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "private"."enforce_profile_lifecycle"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."enforce_studio_media_lifecycle"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if old.id is distinct from new.id
    or old.uploaded_by is distinct from new.uploaded_by
    or old.storage_bucket is distinct from new.storage_bucket
    or old.storage_path is distinct from new.storage_path
    or old.preview_storage_path is distinct from new.preview_storage_path
    or old.declared_mime_type is distinct from new.declared_mime_type
    or old.declared_size_bytes is distinct from new.declared_size_bytes
    or old.declared_checksum_sha256 is distinct from new.declared_checksum_sha256
    or old.prepared_at is distinct from new.prepared_at
    or old.upload_expires_at is distinct from new.upload_expires_at
    or (
      old.upload_token_issued_at is not null
      and old.upload_token_issued_at is distinct from new.upload_token_issued_at
    )
    or (
      old.studio_id is distinct from new.studio_id
      and not (
        old.studio_id is not null
        and new.studio_id is null
        and old.status in ('delete_pending', 'deleted')
        and new.status in ('delete_pending', 'deleted')
      )
    )
    or (
      old.prepared_revision_id is distinct from new.prepared_revision_id
      and not (
        old.prepared_revision_id is not null
        and new.prepared_revision_id is null
        and old.status in ('delete_pending', 'deleted')
        and new.status in ('delete_pending', 'deleted')
      )
    )
    or (old.actual_mime_type is not null and old.actual_mime_type is distinct from new.actual_mime_type)
    or (old.actual_size_bytes is not null and old.actual_size_bytes is distinct from new.actual_size_bytes)
    or (old.width is not null and old.width is distinct from new.width)
    or (old.height is not null and old.height is distinct from new.height)
    or (old.checksum_sha256 is not null and old.checksum_sha256 is distinct from new.checksum_sha256)
    or (old.rejection_code is not null and old.rejection_code is distinct from new.rejection_code)
    or (old.finalized_at is not null and old.finalized_at is distinct from new.finalized_at)
    or (old.rejected_at is not null and old.rejected_at is distinct from new.rejected_at)
    or (old.delete_requested_at is not null and old.delete_requested_at is distinct from new.delete_requested_at)
    or (old.deleted_at is not null and old.deleted_at is distinct from new.deleted_at)
  then
    raise exception using errcode = '23514', message = 'studio_media_object_immutable';
  end if;

  if old.status <> new.status and not (
    (old.status = 'pending_upload' and new.status in ('ready', 'rejected', 'delete_pending'))
    or (old.status = 'ready' and new.status = 'delete_pending')
    or (old.status = 'rejected' and new.status = 'delete_pending')
    or (old.status = 'delete_pending' and new.status = 'deleted')
  ) then
    raise exception using errcode = '23514', message = 'studio_media_state_transition_invalid';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


ALTER FUNCTION "private"."enforce_studio_media_lifecycle"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."enforce_studio_outbox_identity"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."enforce_studio_outbox_identity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."enforce_studio_publication_boundary"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."enforce_studio_publication_boundary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."enforce_studio_review_event_identity"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."enforce_studio_review_event_identity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."enforce_studio_revision_immutability"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."enforce_studio_revision_immutability"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."enforce_studio_revision_pointers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  current_studio public.studios%rowtype;
begin
  select studio.*
  into current_studio
  from public.studios as studio
  where studio.id = new.id;

  if not found then
    return null;
  end if;

  if current_studio.draft_revision_id is null
    and current_studio.published_revision_id is null
  then
    raise exception using errcode = '23514', message = 'studio_revision_pointer_missing';
  end if;

  if current_studio.draft_revision_id is not null
    and not exists (
      select 1
      from public.studio_revisions as revision
      where revision.id = current_studio.draft_revision_id
        and revision.studio_id = current_studio.id
    )
  then
    raise exception using errcode = '23514', message = 'studio_draft_pointer_invalid';
  end if;

  if current_studio.published_revision_id is not null
    and not exists (
      select 1
      from public.studio_revisions as revision
      where revision.id = current_studio.published_revision_id
        and revision.studio_id = current_studio.id
    )
  then
    raise exception using errcode = '23514', message = 'studio_published_pointer_invalid';
  end if;

  return null;
end;
$$;


ALTER FUNCTION "private"."enforce_studio_revision_pointers"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."enforce_studio_revision_pointers"() IS 'Valida ponteiros ao fim da instrução atômica com autoridade interna mínima.';



CREATE OR REPLACE FUNCTION "private"."execute_backoffice_studio_command"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_publication_version" bigint, "p_action" "text", "p_rejection_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."execute_backoffice_studio_command"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_publication_version" bigint, "p_action" "text", "p_rejection_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."execute_backoffice_studio_command"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_publication_version" bigint, "p_action" "text", "p_rejection_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Decide ou modera estúdio atomicamente com fence, ledger, evento, outbox e audit.';



CREATE OR REPLACE FUNCTION "private"."finalize_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid", "p_actual_mime_type" "text", "p_actual_size_bytes" bigint, "p_width" integer, "p_height" integer, "p_checksum_sha256" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  is_first boolean;
  media public.studio_media%rowtype;
  next_position smallint;
  payload_hash text;
  replay jsonb;
  result jsonb;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_media_id is null
    or p_actual_mime_type is null
    or p_actual_mime_type <> all (array[
      'image/jpeg'::text,
      'image/png'::text,
      'image/webp'::text,
      'image/avif'::text
    ])
    or p_actual_size_bytes is null
    or p_actual_size_bytes not between 1 and 15728640
    or p_width is null
    or p_width not between 1 and 8192
    or p_height is null
    or p_height not between 1 and 8192
    or p_width::bigint * p_height::bigint > 36000000
    or p_checksum_sha256 is null
    or p_checksum_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_finalize';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.finalize',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'mediaId', p_media_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.finalize',
    payload_hash,
    p_studio_id,
    p_media_id
  );
  if replay is not null then
    return replay;
  end if;

  select locked.locked_revision_id, locked.locked_revision_version
  into draft_revision_id, draft_revision_version
  from private.lock_studio_media_revision(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as locked;

  select candidate.*
  into media
  from public.studio_media as candidate
  where candidate.id = p_media_id
    and candidate.studio_id = p_studio_id
    and candidate.prepared_revision_id = draft_revision_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;
  if media.status <> 'pending_upload' then
    raise exception using errcode = '40001', message = 'studio_media_finalize_conflict';
  end if;
  if media.upload_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '40001', message = 'studio_media_upload_expired';
  end if;
  if media.declared_mime_type <> p_actual_mime_type
    or media.declared_size_bytes <> p_actual_size_bytes
    or (
      media.declared_checksum_sha256 is not null
      and media.declared_checksum_sha256 <> p_checksum_sha256
    )
  then
    raise exception using errcode = '23514', message = 'studio_media_metadata_mismatch';
  end if;

  select coalesce(pg_catalog.max(relation.position), 0) + 1,
    pg_catalog.count(*) = 0
  into next_position, is_first
  from public.studio_revision_media as relation
  where relation.revision_id = draft_revision_id;

  if next_position > 20 then
    raise exception using errcode = '23514', message = 'studio_media_limit_reached';
  end if;

  update public.studio_media as candidate
  set
    actual_mime_type = p_actual_mime_type,
    actual_size_bytes = p_actual_size_bytes,
    width = p_width,
    height = p_height,
    checksum_sha256 = p_checksum_sha256,
    status = 'ready',
    finalized_at = pg_catalog.clock_timestamp(),
    cleanup_after = null
  where candidate.id = media.id;

  insert into public.studio_revision_media (revision_id, media_id, position, is_cover)
  values (draft_revision_id, p_media_id, next_position, is_first);

  update public.studio_revisions as revision
  set revision_version = revision.revision_version + 1
  where revision.id = draft_revision_id
    and revision.status = 'draft'
    and revision.revision_version = draft_revision_version
  returning revision.revision_version into resulting_revision_version;

  if not found then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  result := private.get_owner_studio_media(p_user_id, p_studio_id);
  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.finalize',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    resulting_revision_version,
    p_media_id,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_upload_finalized',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'mediaId', p_media_id,
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'mimeType', p_actual_mime_type,
      'sizeBytes', p_actual_size_bytes,
      'width', p_width,
      'height', p_height
    )
  );

  return result;
end;
$_$;


ALTER FUNCTION "private"."finalize_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid", "p_actual_mime_type" "text", "p_actual_size_bytes" bigint, "p_width" integer, "p_height" integer, "p_checksum_sha256" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."finalize_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid", "p_actual_mime_type" "text", "p_actual_size_bytes" bigint, "p_width" integer, "p_height" integer, "p_checksum_sha256" "text") IS 'Persiste fatos verificados, associa a mídia pronta e incrementa a versão da draft uma vez.';



CREATE OR REPLACE FUNCTION "private"."finalize_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_actual_mime_type" "text", "p_actual_size_bytes" bigint, "p_width" integer, "p_height" integer, "p_checksum_sha256" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  claim private.studio_media_finalize_claims%rowtype;
  claim_idempotency_key uuid;
  claim_owner_user_id uuid;
  result jsonb;
begin
  if p_claim_token is null or p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_studio_media_finalize_claim';
  end if;

  select existing.owner_user_id, existing.idempotency_key
  into claim_owner_user_id, claim_idempotency_key
  from private.studio_media_finalize_claims as existing
  where existing.lease_token = p_claim_token
    and existing.terminal_state is null;

  if not found then
    raise exception using errcode = '40001', message = 'studio_media_finalize_claim_lost';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      claim_owner_user_id::text || ':' || claim_idempotency_key::text,
      0
    )
  );
  perform private.assert_studio_owner_mutable(claim_owner_user_id);

  select existing.*
  into claim
  from private.studio_media_finalize_claims as existing
  where existing.lease_token = p_claim_token
  for update;

  if not found
    or claim.terminal_state is not null
    or claim.lease_expires_at <= pg_catalog.clock_timestamp()
  then
    raise exception using errcode = '40001', message = 'studio_media_finalize_claim_lost';
  end if;

  result := private.finalize_studio_media_upload(
    claim.owner_user_id,
    claim.studio_id,
    claim.expected_revision_id,
    claim.expected_revision_version,
    claim.idempotency_key,
    p_request_id,
    claim.media_id,
    p_actual_mime_type,
    p_actual_size_bytes,
    p_width,
    p_height,
    p_checksum_sha256
  );

  update private.studio_media_finalize_claims as existing
  set
    terminal_state = 'finalized',
    terminal_at = pg_catalog.clock_timestamp()
  where existing.owner_user_id = claim.owner_user_id
    and existing.idempotency_key = claim.idempotency_key
    and existing.lease_token = p_claim_token
    and existing.terminal_state is null;
  if not found then
    raise exception using errcode = '40001', message = 'studio_media_finalize_claim_lost';
  end if;

  return result;
end;
$$;


ALTER FUNCTION "private"."finalize_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_actual_mime_type" "text", "p_actual_size_bytes" bigint, "p_width" integer, "p_height" integer, "p_checksum_sha256" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."finalize_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_actual_mime_type" "text", "p_actual_size_bytes" bigint, "p_width" integer, "p_height" integer, "p_checksum_sha256" "text") IS 'Deriva toda identidade mutável do claim cercado e grava galeria, ledger e tombstone terminal na mesma transação.';



CREATE OR REPLACE FUNCTION "private"."get_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) RETURNS TABLE("scope" "uuid", "authorization_version" bigint, "roles" "text"[], "expires_at" timestamp with time zone, "strong_authentication_expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."get_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."get_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) IS 'Revalida Auth, perfil, papel, inatividade e expiração absoluta da sessão do backoffice.';



CREATE OR REPLACE FUNCTION "private"."get_backoffice_studio_review"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_touch_activity" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  actor_context record;
  candidate_is_pending boolean;
  current_studio public.studios%rowtype;
  review_checklist jsonb;
  selected_revision_id uuid;
  submitted_event public.studio_review_events%rowtype;
begin
  if p_studio_id is null or p_touch_activity is null then
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
    p_touch_activity
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
$$;


ALTER FUNCTION "private"."get_backoffice_studio_review"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_touch_activity" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."get_backoffice_studio_review"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_touch_activity" boolean) IS 'Detalhe privado estrito; polling passivo revalida sem renovar a inatividade da sessão.';



CREATE OR REPLACE FUNCTION "private"."get_backoffice_user_access"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid") RETURNS TABLE("account_version" bigint, "created_at" timestamp with time zone, "email_masked" "text", "id" "uuid", "profile_completed" boolean, "roles" "text"[], "status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if p_target_user_id is null then
    raise exception using errcode = '22023', message = 'invalid_backoffice_access_target';
  end if;
  perform private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
    false,
    true
  );
  return query
  select
    profile.account_version,
    profile.created_at,
    private.mask_backoffice_email(auth_user.email),
    profile.id,
    profile.completed_at is not null,
    private.platform_roles_for_user(profile.id),
    profile.status
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
    and auth_user.email is not null;
  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
end;
$$;


ALTER FUNCTION "private"."get_backoffice_user_access"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."get_backoffice_user_access"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid") IS 'Compõe no servidor papéis, status e elegibilidade de perfil de uma conta para um admin revalidado.';



CREATE OR REPLACE FUNCTION "private"."get_owner_recipient_status_for_user"("p_user_id" "uuid") RETURNS TABLE("scope" "uuid", "owner_status" "text", "owner_version" bigint, "accepted_owner_contract_version_id" "uuid", "owner_contract_accepted" boolean, "owner_contract_id" "uuid", "owner_contract_kind" "text", "owner_contract_version" "text", "owner_contract_title" "text", "owner_contract_body_markdown" "text", "owner_contract_content_hash" "text", "owner_contract_source" "text", "owner_contract_effective_at" timestamp with time zone, "recipient_status" "text", "requirements" "text"[], "next_action" "text", "profile_version" bigint, "profile_version_synced" bigint, "recipient_version" bigint, "reservations_eligible" boolean, "provider_mode" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'invalid_owner_user';
  end if;

  if not exists (
    select 1 from public.profiles as profile where profile.id = p_user_id
  ) then
    raise exception using errcode = 'P0002', message = 'owner_profile_missing';
  end if;

  return query
  select * from private.owner_recipient_status_row(p_user_id);

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_contract_missing';
  end if;
end;
$$;


ALTER FUNCTION "private"."get_owner_recipient_status_for_user"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."get_owner_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."get_owner_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."get_owner_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid") IS 'Read model privado nullable do dono elegível; paths de prévia chegam somente ao DAL server-only.';



CREATE OR REPLACE FUNCTION "private"."get_owner_studio_publication"("p_user_id" "uuid", "p_studio_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select private.studio_publication_json(p_user_id, p_studio_id);
$$;


ALTER FUNCTION "private"."get_owner_studio_publication"("p_user_id" "uuid", "p_studio_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."get_owner_studio_publication"("p_user_id" "uuid", "p_studio_id" "uuid") IS 'Read model privado nullable do fluxo editorial, cercado por ownership e elegibilidade vigentes.';



CREATE OR REPLACE FUNCTION "private"."get_studio_media_upload_candidate"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  media public.studio_media%rowtype;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_media_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_candidate';
  end if;

  perform private.assert_studio_owner_mutable(p_user_id);
  select locked.locked_revision_id, locked.locked_revision_version
  into draft_revision_id, draft_revision_version
  from private.lock_studio_media_revision(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as locked;

  select candidate.*
  into media
  from public.studio_media as candidate
  where candidate.id = p_media_id
    and candidate.studio_id = p_studio_id
    and candidate.prepared_revision_id = draft_revision_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;
  if media.status <> 'pending_upload' then
    raise exception using errcode = '40001', message = 'studio_media_candidate_not_pending';
  end if;
  if pg_catalog.clock_timestamp() >= media.upload_expires_at then
    raise exception using errcode = '40001', message = 'studio_media_upload_expired';
  end if;

  return pg_catalog.jsonb_build_object(
    'scope', p_user_id,
    'studioId', p_studio_id,
    'revisionId', draft_revision_id,
    'revisionVersion', draft_revision_version,
    'mediaId', media.id,
    'bucket', media.storage_bucket,
    'path', media.storage_path,
    'previewPath', media.preview_storage_path,
    'expiresAt', media.upload_expires_at,
    'declaredMimeType', media.declared_mime_type,
    'declaredByteSize', media.declared_size_bytes,
    'declaredChecksumSha256', media.declared_checksum_sha256
  );
end;
$$;


ALTER FUNCTION "private"."get_studio_media_upload_candidate"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."get_studio_media_upload_candidate"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid") IS 'Retorna ao DAL o bucket/path canônicos ainda válidos para emitir o token de upload.';



CREATE OR REPLACE FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if p_token is null or p_user_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  return exists (
    select 1
    from private.identity_recovery_grants as recovery_grant
    where recovery_grant.token = p_token
      and recovery_grant.user_id = p_user_id
      and recovery_grant.expires_at > pg_catalog.statement_timestamp()
      and recovery_grant.claim_attempt_id is null
  );
end;
$$;


ALTER FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") IS 'Confirma somente grant vigente, vinculado ao usuário e ainda não reservado.';



CREATE OR REPLACE FUNCTION "private"."inspect_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_grant_token" "uuid", "p_session_scope" "uuid") RETURNS TABLE("session_scope" "uuid", "active" boolean, "grant_allowed" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  binding_active boolean;
  binding_scope uuid;
  inspection_time timestamptz := pg_catalog.clock_timestamp();
begin
  if pg_catalog.current_setting('app.settings.jwt_exp', true) is distinct from '3600' then
    raise exception using
      errcode = '55000',
      message = 'identity_recovery_jwt_expiry_not_pinned';
  end if;

  if p_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_auth_expires_at <= inspection_time
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_session';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    update private.identity_recovery_sessions as absent_binding
    set
      auth_expires_at = greatest(
        absent_binding.auth_expires_at,
        inspection_time + interval '1 hour'
      ),
      retain_until = greatest(
        absent_binding.retain_until,
        inspection_time + interval '65 minutes'
      ),
      canonical_absence_observed_at = coalesce(
        absent_binding.canonical_absence_observed_at,
        inspection_time
      ),
      closed_at = coalesce(absent_binding.closed_at, inspection_time)
    where absent_binding.auth_session_id = p_auth_session_id
      and absent_binding.user_id = p_user_id
    returning absent_binding.session_scope into binding_scope;

    if not found then
      return;
    end if;

    delete from private.identity_recovery_grants as recovery_grant
    where recovery_grant.auth_session_id = p_auth_session_id
      and recovery_grant.user_id = p_user_id;

    session_scope := binding_scope;
    active := false;
    grant_allowed := false;
    return next;
    return;
  end if;

  update private.identity_recovery_sessions as recovery_session
  set
    auth_expires_at = greatest(
      recovery_session.auth_expires_at,
      p_auth_expires_at
    ),
    retain_until = greatest(
      recovery_session.retain_until,
      p_auth_expires_at + interval '5 minutes'
    )
  where recovery_session.auth_session_id = p_auth_session_id
    and recovery_session.user_id = p_user_id
  returning
    recovery_session.session_scope,
    recovery_session.closed_at is null
  into binding_scope, binding_active;

  if not found then
    return;
  end if;

  session_scope := binding_scope;
  active := binding_active;
  grant_allowed := binding_active
    and p_grant_token is not null
    and p_session_scope = binding_scope
    and exists (
      select 1
      from private.identity_recovery_grants as recovery_grant
      where recovery_grant.token = p_grant_token
        and recovery_grant.user_id = p_user_id
        and recovery_grant.auth_session_id = p_auth_session_id
        and recovery_grant.expires_at > inspection_time
        and recovery_grant.claim_attempt_id is null
    );
  return next;
end;
$$;


ALTER FUNCTION "private"."inspect_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_grant_token" "uuid", "p_session_scope" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."inspect_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_grant_token" "uuid", "p_session_scope" "uuid") IS 'Classifica binding/tombstone pelo session_id assinado, estende retenção ao JWT observado e só autoriza grant/escopo ativos correspondentes.';



CREATE OR REPLACE FUNCTION "private"."is_valid_cnpj"("candidate" "text") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE STRICT
    SET "search_path" TO ''
    AS $_$
declare
  first_weights constant integer[] := array[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  second_weights constant integer[] := array[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  character_value integer;
  digit_sum integer := 0;
  remainder integer;
  first_check_digit integer;
  second_check_digit integer;
begin
  if candidate !~ '^[0-9A-Z]{12}[0-9]{2}$'
    or candidate ~ '^([0-9A-Z])\1{11}'
  then
    return false;
  end if;

  for position_index in 1..12 loop
    character_value :=
      pg_catalog.ascii(pg_catalog.substr(candidate, position_index, 1)) - 48;
    digit_sum := digit_sum + character_value * first_weights[position_index];
  end loop;

  remainder := digit_sum % 11;
  first_check_digit := case when remainder < 2 then 0 else 11 - remainder end;

  if first_check_digit <>
    pg_catalog.ascii(pg_catalog.substr(candidate, 13, 1)) - 48
  then
    return false;
  end if;

  digit_sum := 0;
  for position_index in 1..13 loop
    character_value :=
      pg_catalog.ascii(pg_catalog.substr(candidate, position_index, 1)) - 48;
    digit_sum := digit_sum + character_value * second_weights[position_index];
  end loop;

  remainder := digit_sum % 11;
  second_check_digit := case when remainder < 2 then 0 else 11 - remainder end;

  return second_check_digit =
    pg_catalog.ascii(pg_catalog.substr(candidate, 14, 1)) - 48;
end;
$_$;


ALTER FUNCTION "private"."is_valid_cnpj"("candidate" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."is_valid_cnpj"("candidate" "text") IS 'Valida CNPJ canônico numérico ou alfanumérico uppercase pelo valor ASCII menos 48 e DVs módulo 11; não comprova existência ou titularidade.';



CREATE OR REPLACE FUNCTION "private"."is_valid_cpf"("candidate" "text") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE STRICT
    SET "search_path" TO ''
    AS $_$
declare
  digit integer;
  digit_sum integer := 0;
  first_check_digit integer;
  second_check_digit integer;
begin
  if candidate !~ '^[0-9]{11}$'
    or candidate ~ '^([0-9])\1{10}$'
  then
    return false;
  end if;

  for position_index in 1..9 loop
    digit := pg_catalog.ascii(pg_catalog.substr(candidate, position_index, 1)) - 48;
    digit_sum := digit_sum + digit * (11 - position_index);
  end loop;

  first_check_digit := digit_sum % 11;
  first_check_digit := case
    when first_check_digit < 2 then 0
    else 11 - first_check_digit
  end;

  if first_check_digit <>
    pg_catalog.ascii(pg_catalog.substr(candidate, 10, 1)) - 48
  then
    return false;
  end if;

  digit_sum := 0;
  for position_index in 1..10 loop
    digit := pg_catalog.ascii(pg_catalog.substr(candidate, position_index, 1)) - 48;
    digit_sum := digit_sum + digit * (12 - position_index);
  end loop;

  second_check_digit := digit_sum % 11;
  second_check_digit := case
    when second_check_digit < 2 then 0
    else 11 - second_check_digit
  end;

  return second_check_digit =
    pg_catalog.ascii(pg_catalog.substr(candidate, 11, 1)) - 48;
end;
$_$;


ALTER FUNCTION "private"."is_valid_cpf"("candidate" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."is_valid_cpf"("candidate" "text") IS 'Valida o formato canônico de onze dígitos e os dois DVs módulo 11 do CPF; não comprova existência ou titularidade.';



CREATE OR REPLACE FUNCTION "private"."issue_identity_recovery_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) RETURNS TABLE("grant_token" "uuid", "session_scope" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  binding_time timestamptz := pg_catalog.clock_timestamp();
  issued_scope uuid;
  issued_token uuid;
begin
  if pg_catalog.current_setting('app.settings.jwt_exp', true) is distinct from '3600' then
    raise exception using
      errcode = '55000',
      message = 'identity_recovery_jwt_expiry_not_pinned';
  end if;

  if p_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_auth_expires_at <= binding_time
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_session';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_session';
  end if;

  update private.identity_recovery_sessions as absent_binding
  set
    auth_expires_at = greatest(
      absent_binding.auth_expires_at,
      binding_time + interval '1 hour'
    ),
    retain_until = greatest(
      absent_binding.retain_until,
      binding_time + interval '65 minutes'
    ),
    canonical_absence_observed_at = binding_time,
    closed_at = coalesce(absent_binding.closed_at, binding_time)
  where absent_binding.canonical_absence_observed_at is null
    and not exists (
      select 1
      from auth.sessions as canonical_session
      where canonical_session.id = absent_binding.auth_session_id
        and canonical_session.user_id = absent_binding.user_id
    );

  delete from private.identity_recovery_sessions as expired_binding
  where expired_binding.canonical_absence_observed_at is not null
    and expired_binding.retain_until <= binding_time
    and not exists (
      select 1
      from auth.sessions as canonical_session
      where canonical_session.id = expired_binding.auth_session_id
        and canonical_session.user_id = expired_binding.user_id
    );

  delete from private.identity_recovery_grants as expired_grant
  where expired_grant.expires_at <= binding_time;

  insert into private.identity_recovery_sessions (
    auth_session_id,
    user_id,
    bound_at,
    auth_expires_at,
    retain_until
  )
  values (
    p_auth_session_id,
    p_user_id,
    binding_time,
    p_auth_expires_at,
    p_auth_expires_at + interval '5 minutes'
  )
  returning identity_recovery_sessions.session_scope into issued_scope;

  insert into private.identity_recovery_grants (
    user_id,
    auth_session_id,
    issued_at,
    expires_at
  )
  values (
    p_user_id,
    p_auth_session_id,
    binding_time,
    binding_time + interval '15 minutes'
  )
  returning identity_recovery_grants.token into issued_token;

  grant_token := issued_token;
  session_scope := issued_scope;
  return next;
end;
$$;


ALTER FUNCTION "private"."issue_identity_recovery_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."issue_identity_recovery_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) IS 'Emite atomicamente binding por session_id Auth, scope opaco e grant de 15 minutos após validar auth.sessions.';



CREATE OR REPLACE FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  grant_issued_at timestamptz;
  grant_token uuid;
begin
  if p_user_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  grant_issued_at := pg_catalog.clock_timestamp();

  delete from private.identity_recovery_grants as expired_grant
  where expired_grant.expires_at <= grant_issued_at;

  insert into private.identity_recovery_grants (
    user_id,
    issued_at,
    expires_at
  )
  values (
    p_user_id,
    grant_issued_at,
    grant_issued_at + interval '15 minutes'
  )
  returning token into grant_token;

  return grant_token;
end;
$$;


ALTER FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") IS 'Purga grants expirados e emite token opaco vinculado ao usuário por 15 minutos.';



CREATE OR REPLACE FUNCTION "private"."list_backoffice_studio_reviews"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_cursor_sequence" bigint, "p_cursor_studio_id" "uuid", "p_limit" integer) RETURNS TABLE("disabled_from_status" "text", "has_published" boolean, "name" "text", "publication_version" bigint, "review_state" "text", "revision_id" "uuid", "sort_sequence" bigint, "studio_id" "uuid", "studio_status" "text", "submitted_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."list_backoffice_studio_reviews"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_cursor_sequence" bigint, "p_cursor_studio_id" "uuid", "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."list_backoffice_studio_reviews"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_cursor_sequence" bigint, "p_cursor_studio_id" "uuid", "p_limit" integer) IS 'Fila privada keyset; reviewer vê candidatas pendentes e somente admin vê desativações.';



CREATE OR REPLACE FUNCTION "private"."list_backoffice_taxonomies"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) RETURNS TABLE("active" boolean, "id" "uuid", "kind" "text", "name" "text", "slug" "text", "sort_order" smallint, "updated_at" timestamp with time zone, "usage_count" bigint, "taxonomy_version" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
    false,
    true
  );
  return query
  select *
  from (
    select
      item.active,
      item.id,
      'studioType'::text as kind,
      item.name,
      item.slug,
      item.sort_order,
      item.updated_at,
      (
        select pg_catalog.count(*)
        from public.studio_revisions as revision
        where revision.studio_type_id = item.id
      ) as usage_count,
      item.taxonomy_version
    from public.studio_types as item
    union all
    select
      item.active,
      item.id,
      'tag'::text,
      item.name,
      item.slug,
      item.sort_order,
      item.updated_at,
      (
        select pg_catalog.count(*)
        from public.studio_revision_tags as relation
        where relation.tag_id = item.id
      ),
      item.taxonomy_version
    from public.tags as item
    union all
    select
      item.active,
      item.id,
      'amenity'::text,
      item.name,
      item.slug,
      item.sort_order,
      item.updated_at,
      (
        select pg_catalog.count(*)
        from public.studio_revision_amenities as relation
        where relation.amenity_id = item.id
      ),
      item.taxonomy_version
    from public.amenities as item
  ) as taxonomy
  order by
    case taxonomy.kind when 'studioType' then 1 when 'tag' then 2 else 3 end,
    taxonomy.sort_order,
    taxonomy.name,
    taxonomy.id
  limit 501;
end;
$$;


ALTER FUNCTION "private"."list_backoffice_taxonomies"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."list_backoffice_taxonomies"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) IS 'Lista privada e limitada das taxonomias com versão e impacto de uso.';



CREATE OR REPLACE FUNCTION "private"."list_backoffice_users"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_query" "text", "p_cursor_created_at" timestamp with time zone, "p_cursor_id" "uuid", "p_limit" integer) RETURNS TABLE("account_version" bigint, "created_at" timestamp with time zone, "email_masked" "text", "id" "uuid", "status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."list_backoffice_users"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_query" "text", "p_cursor_created_at" timestamp with time zone, "p_cursor_id" "uuid", "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."list_backoffice_users"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_query" "text", "p_cursor_created_at" timestamp with time zone, "p_cursor_id" "uuid", "p_limit" integer) IS 'Diretório privado paginado: busca somente por prefixo de e-mail ou UUID exato e nunca avalia nome bruto.';



CREATE OR REPLACE FUNCTION "private"."lock_active_studio_revision_taxonomy"("p_user_id" "uuid", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_revision_version" bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."lock_active_studio_revision_taxonomy"("p_user_id" "uuid", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_revision_version" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."lock_studio_media_revision"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint) RETURNS TABLE("locked_revision_id" "uuid", "locked_revision_version" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  return query
  select prepared.revision_id, prepared.revision_version
  from private.prepare_studio_revision_draft(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as prepared;
end;
$$;


ALTER FUNCTION "private"."lock_studio_media_revision"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."managed_runtime_boundaries_are_ready"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
  with managed_roles(role_name) as (
    values
      ('anon'::text),
      ('authenticated'::text),
      ('service_role'::text),
      ('app_dal'::text),
      ('app_runtime_production'::text)
  ),
  sensitive_catalog_access_is_restricted as (
    select not exists (
      select 1
      from (
        values
          ('pg_catalog.pg_db_role_setting'::pg_catalog.regclass),
          ('pg_catalog.pg_roles'::pg_catalog.regclass),
          ('pg_catalog.pg_user'::pg_catalog.regclass)
      ) as catalog(relation_oid)
      cross join managed_roles
      where pg_catalog.has_table_privilege(
          managed_roles.role_name,
          catalog.relation_oid,
          'SELECT'
        )
        or pg_catalog.has_any_column_privilege(
          managed_roles.role_name,
          catalog.relation_oid,
          'SELECT'
        )
    ) as ready
  ),
  sensitive_settings_are_absent as (
    select not exists (
      select 1
      from pg_catalog.pg_db_role_setting as setting
      cross join lateral pg_catalog.unnest(setting.setconfig) as configuration(value)
      where pg_catalog.split_part(configuration.value, '=', 1)
        ~* '(^|[._-])(secret|password|token|credential|key)([._-]|$)'
    ) as ready
  ),
  managed_http_access_is_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_namespace as namespace
      cross join managed_roles
      where namespace.nspname = 'net'
        and (
          pg_catalog.has_schema_privilege(
            managed_roles.role_name,
            namespace.oid,
            'USAGE'
          )
          or pg_catalog.has_schema_privilege(
            managed_roles.role_name,
            namespace.oid,
            'CREATE'
          )
        )
    ) as ready
  ),
  application_database_access_is_restricted as (
    select not exists (
      select 1
      from (
        values
          ('app_dal'::text),
          ('app_runtime_production'::text)
      ) as application_role(role_name)
      where pg_catalog.has_database_privilege(
          application_role.role_name,
          pg_catalog.current_database(),
          'CREATE'
        )
        or pg_catalog.has_database_privilege(
          application_role.role_name,
          pg_catalog.current_database(),
          'TEMPORARY'
        )
    ) as ready
  ),
  production_runtime_members_are_restricted as (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        member.rolname = 'postgres'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      ) as ready
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where granted.rolname = 'app_runtime_production'
  )
  select coalesce(
    (
      (select ready from sensitive_catalog_access_is_restricted)
      or (select ready from sensitive_settings_are_absent)
    )
    and (select ready from managed_http_access_is_restricted)
    and (select ready from application_database_access_is_restricted)
    and (select ready from production_runtime_members_are_restricted)
    and private.studio_media_cleanup_runs_are_healthy(),
    false
  );
$_$;


ALTER FUNCTION "private"."managed_runtime_boundaries_are_ready"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."managed_runtime_boundaries_are_ready"() IS 'Falha fechado se catálogos legíveis contêm setting sensível, roles runtime alcançam pg_net, recebem CREATE/TEMP ou possuem membro assumível.';



CREATE OR REPLACE FUNCTION "private"."mask_backoffice_email"("p_email" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select case
    when p_email is null or pg_catalog.strpos(p_email, '@') <= 1 then null
    else
      pg_catalog.left(pg_catalog.split_part(p_email, '@', 1), 1)
      || '***@'
      || pg_catalog.split_part(p_email, '@', 2)
  end;
$$;


ALTER FUNCTION "private"."mask_backoffice_email"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."normalize_backoffice_session_window"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.last_seen_at < new.opened_at then
    new.last_seen_at := new.opened_at;
  end if;
  if new.closed_at is not null and new.closed_at < new.last_seen_at then
    new.closed_at := new.last_seen_at;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "private"."normalize_backoffice_session_window"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."normalize_backoffice_session_window"() IS 'Preserva a ordem temporal da sessão quando o relógio de parede do host recua.';



CREATE OR REPLACE FUNCTION "private"."normalize_updated_at_monotonic"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.updated_at := greatest(
    old.updated_at,
    new.created_at,
    pg_catalog.clock_timestamp()
  );
  return new;
end;
$$;


ALTER FUNCTION "private"."normalize_updated_at_monotonic"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."normalize_updated_at_monotonic"() IS 'Mantém updated_at monotônico quando o relógio de parede do host recua.';



CREATE OR REPLACE FUNCTION "private"."open_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) RETURNS TABLE("scope" "uuid", "authorization_version" bigint, "roles" "text"[], "expires_at" timestamp with time zone, "strong_authentication_expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  opened_at timestamptz := pg_catalog.clock_timestamp();
  current_authorization_version bigint;
  canonical_not_after timestamptz;
  current_roles text[];
begin
  if pg_catalog.current_setting('app.settings.jwt_exp', true) is distinct from '3600' then
    raise exception using errcode = '55000', message = 'backoffice_jwt_expiry_not_pinned';
  end if;
  if p_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_auth_expires_at <= opened_at
    or p_auth_expires_at > opened_at + interval '65 minutes'
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_session';
  end if;

  select auth_session.not_after
  into canonical_not_after
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
    and (auth_session.not_after is null or auth_session.not_after > opened_at)
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
  if pg_catalog.cardinality(current_roles) = 0 then
    raise exception using errcode = '42501', message = 'backoffice_role_required';
  end if;

  insert into private.backoffice_sessions (
    auth_session_id,
    user_id,
    opened_at,
    last_seen_at,
    absolute_expires_at,
    closed_at
  )
  values (
    p_auth_session_id,
    p_user_id,
    opened_at,
    opened_at,
    least(
      opened_at + interval '8 hours',
      coalesce(canonical_not_after, opened_at + interval '8 hours')
    ),
    null
  )
  on conflict (auth_session_id) do update
  set
    user_id = excluded.user_id,
    opened_at = excluded.opened_at,
    last_seen_at = excluded.last_seen_at,
    absolute_expires_at = excluded.absolute_expires_at,
    closed_at = null;

  return query
  select
    p_user_id,
    current_authorization_version,
    current_roles,
    least(
      opened_at + interval '8 hours',
      coalesce(canonical_not_after, opened_at + interval '8 hours'),
      p_auth_expires_at
    ),
    opened_at + interval '5 minutes';
end;
$$;


ALTER FUNCTION "private"."open_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."open_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) IS 'Abre binding curto depois de login Auth válido, perfil elegível e papel administrativo vivo.';



CREATE OR REPLACE FUNCTION "private"."owner_recipient_status_row"("p_user_id" "uuid") RETURNS TABLE("scope" "uuid", "owner_status" "text", "owner_version" bigint, "accepted_owner_contract_version_id" "uuid", "owner_contract_accepted" boolean, "owner_contract_id" "uuid", "owner_contract_kind" "text", "owner_contract_version" "text", "owner_contract_title" "text", "owner_contract_body_markdown" "text", "owner_contract_content_hash" "text", "owner_contract_source" "text", "owner_contract_effective_at" timestamp with time zone, "recipient_status" "text", "requirements" "text"[], "next_action" "text", "profile_version" bigint, "profile_version_synced" bigint, "recipient_version" bigint, "reservations_eligible" boolean, "provider_mode" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with current_contract as (
    select
      legal_version.id,
      legal_version.kind,
      legal_version.version,
      legal_version.title,
      legal_version.body_markdown,
      legal_version.content_hash,
      legal_version.source,
      legal_version.effective_at
    from public.terms_versions as legal_version
    where legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.now()
      and (
        legal_version.retired_at is null
        or pg_catalog.now() < legal_version.retired_at
      )
  ),
  source_state as (
    select
      profile.id as user_id,
      profile.profile_version,
      profile.status as profile_status,
      profile.completed_at,
      owner.status as canonical_owner_status,
      owner.owner_version,
      owner.accepted_owner_contract_version_id,
      contract.id as contract_id,
      contract.kind as contract_kind,
      contract.version as contract_version,
      contract.title as contract_title,
      contract.body_markdown as contract_body_markdown,
      contract.content_hash as contract_content_hash,
      contract.source as contract_source,
      contract.effective_at as contract_effective_at,
      recipient.status as canonical_recipient_status,
      recipient.requirements as recipient_requirements,
      recipient.profile_version_synced,
      recipient.recipient_version,
      exists (
        select 1
        from public.terms_acceptances as acceptance
        where acceptance.user_id = profile.id
          and acceptance.terms_version_id = contract.id
          and acceptance.accepted_content_hash = contract.content_hash
      ) as current_contract_acceptance_exists
    from public.profiles as profile
    cross join current_contract as contract
    left join public.owner_profiles as owner
      on owner.user_id = profile.id
    left join public.owner_payment_recipients as recipient
      on recipient.owner_user_id = owner.user_id
    where profile.id = p_user_id
  ),
  projected as (
    select
      source_state.*,
      case
        when source_state.profile_status <> 'active'
          or source_state.canonical_owner_status = 'blocked'
          then 'blocked'
        when source_state.canonical_owner_status is null
          then 'inactive'
        else 'active'
      end as projected_owner_status,
      coalesce(source_state.canonical_recipient_status, 'not_started')
        as projected_recipient_status,
      (
        source_state.accepted_owner_contract_version_id = source_state.contract_id
        and source_state.current_contract_acceptance_exists
      ) as projected_contract_accepted
    from source_state
  )
  select
    projected.user_id,
    projected.projected_owner_status,
    coalesce(projected.owner_version, 0::bigint),
    projected.accepted_owner_contract_version_id,
    projected.projected_contract_accepted,
    projected.contract_id,
    projected.contract_kind,
    projected.contract_version,
    projected.contract_title,
    projected.contract_body_markdown,
    projected.contract_content_hash,
    projected.contract_source,
    projected.contract_effective_at,
    projected.projected_recipient_status,
    coalesce(projected.recipient_requirements, '{}'::text[]),
    case
      when projected.projected_owner_status = 'blocked'
        or projected.projected_recipient_status = 'blocked'
        then 'none'
      when projected.projected_owner_status = 'inactive'
        or not projected.projected_contract_accepted
        then 'activate_owner'
      when projected.projected_recipient_status in ('not_started', 'refused')
        then 'start_onboarding'
      when projected.projected_recipient_status in ('pending', 'suspended')
        or (
          projected.projected_recipient_status = 'active'
          and projected.profile_version_synced is distinct from projected.profile_version
        )
        then 'refresh_status'
      else 'none'
    end,
    projected.profile_version,
    projected.profile_version_synced,
    coalesce(projected.recipient_version, 0::bigint),
    (
      projected.projected_owner_status = 'active'
      and projected.projected_contract_accepted
      and projected.projected_recipient_status = 'active'
      and projected.profile_version_synced = projected.profile_version
    ),
    'local'::text
  from projected;
$$;


ALTER FUNCTION "private"."owner_recipient_status_row"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."pause_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."pause_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."pause_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Pausa uma publicação aprovada com fence monotônica e preserva ambos os ponteiros.';



CREATE OR REPLACE FUNCTION "private"."platform_roles_for_user"("p_user_id" "uuid") RETURNS "text"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."platform_roles_for_user"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."platform_roles_for_user"("p_user_id" "uuid") IS 'Retorna os papéis cumulativos support, reviewer e admin vigentes para um usuário do backoffice.';



CREATE OR REPLACE FUNCTION "private"."prepare_owner_recipient_operation"("p_user_id" "uuid", "p_action" "text", "p_idempotency_key" "uuid") RETURNS TABLE("operation_id" "uuid", "operation_sequence" bigint, "operation_action" "text", "provider_reference" "text", "profile_version" bigint, "already_applied" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  current_operation private.owner_recipient_operations%rowtype;
  current_owner public.owner_profiles%rowtype;
  current_profile public.profiles%rowtype;
  current_recipient public.owner_payment_recipients%rowtype;
  next_sequence bigint;
  prepared_reference text;
  operation_was_found boolean := false;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_action is null
    or p_action not in ('start', 'refresh')
  then
    raise exception using errcode = '22023', message = 'invalid_recipient_operation';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_profile_missing';
  end if;

  select owner.*
  into current_owner
  from public.owner_profiles as owner
  where owner.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_authority_missing';
  end if;

  select recipient.*
  into current_recipient
  from public.owner_payment_recipients as recipient
  where recipient.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'recipient_state_missing';
  end if;

  select operation.*
  into current_operation
  from private.owner_recipient_operations as operation
  where operation.owner_user_id = p_user_id
    and operation.idempotency_key = p_idempotency_key
  for update;

  operation_was_found := found;

  if operation_was_found then
    if current_operation.action <> p_action then
      raise exception using errcode = '40001', message = 'recipient_idempotency_conflict';
    end if;

    if current_operation.applied_at is not null then
      return query
      select
        current_operation.id,
        current_operation.operation_sequence,
        current_operation.action,
        current_operation.provider_reference,
        current_operation.profile_version,
        true;
      return;
    end if;
  end if;

  if current_profile.status <> 'active' or current_profile.completed_at is null then
    raise exception using errcode = '42501', message = 'owner_profile_inactive';
  end if;

  if current_owner.status <> 'active' then
    raise exception using errcode = '42501', message = 'owner_blocked';
  end if;

  if not exists (
    select 1
    from public.terms_versions as legal_version
    join public.terms_acceptances as acceptance
      on acceptance.user_id = p_user_id
      and acceptance.terms_version_id = legal_version.id
      and acceptance.accepted_content_hash = legal_version.content_hash
    where legal_version.id = current_owner.accepted_owner_contract_version_id
      and legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.clock_timestamp()
      and (
        legal_version.retired_at is null
        or pg_catalog.clock_timestamp() < legal_version.retired_at
      )
  ) then
    raise exception using errcode = '42501', message = 'owner_contract_not_current';
  end if;

  if current_recipient.status = 'blocked' then
    raise exception using errcode = '42501', message = 'recipient_blocked';
  end if;

  if operation_was_found then
    if current_operation.profile_version <> current_profile.profile_version then
      raise exception using errcode = '40001', message = 'recipient_idempotency_conflict';
    end if;

    return query
    select
      current_operation.id,
      current_operation.operation_sequence,
      current_operation.action,
      current_operation.provider_reference,
      current_operation.profile_version,
      false;
    return;
  end if;

  if p_action = 'start'
    and current_recipient.status not in ('not_started', 'refused')
  then
    raise exception using errcode = '23514', message = 'recipient_start_transition_invalid';
  end if;

  if p_action = 'refresh'
    and current_recipient.status not in ('pending', 'active', 'suspended')
  then
    raise exception using errcode = '23514', message = 'recipient_refresh_transition_invalid';
  end if;

  if p_action = 'refresh' then
    select operation.provider_reference
    into prepared_reference
    from private.owner_recipient_operations as operation
    where operation.owner_user_id = p_user_id
      and operation.applied_at is not null
    order by operation.operation_sequence desc
    limit 1;

    if prepared_reference is null then
      raise exception using errcode = '23514', message = 'recipient_provider_reference_missing';
    end if;
  else
    prepared_reference := null;
  end if;

  select coalesce(pg_catalog.max(operation.operation_sequence), 0::bigint) + 1
  into next_sequence
  from private.owner_recipient_operations as operation
  where operation.owner_user_id = p_user_id;

  insert into private.owner_recipient_operations (
    owner_user_id,
    action,
    idempotency_key,
    operation_sequence,
    profile_version,
    provider_reference
  )
  values (
    p_user_id,
    p_action,
    p_idempotency_key,
    next_sequence,
    current_profile.profile_version,
    prepared_reference
  )
  returning * into current_operation;

  return query
  select
    current_operation.id,
    current_operation.operation_sequence,
    current_operation.action,
    current_operation.provider_reference,
    current_operation.profile_version,
    false;
end;
$$;


ALTER FUNCTION "private"."prepare_owner_recipient_operation"("p_user_id" "uuid", "p_action" "text", "p_idempotency_key" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."prepare_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_declared_mime_type" "text", "p_declared_size_bytes" bigint, "p_declared_checksum_sha256" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  extension text;
  media_id uuid := extensions.gen_random_uuid();
  payload_hash text;
  prepared_time timestamptz := pg_catalog.clock_timestamp();
  replay jsonb;
  result jsonb;
  preview_storage_path text;
  storage_path text;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_declared_mime_type is null
    or p_declared_mime_type <> all (array[
      'image/jpeg'::text,
      'image/png'::text,
      'image/webp'::text,
      'image/avif'::text
    ])
    or p_declared_size_bytes is null
    or p_declared_size_bytes not between 1 and 15728640
    or (
      p_declared_checksum_sha256 is not null
      and p_declared_checksum_sha256 !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_prepare';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.prepare',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'declaredMimeType', p_declared_mime_type,
      'declaredSizeBytes', p_declared_size_bytes,
      'declaredChecksumSha256', p_declared_checksum_sha256
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.prepare',
    payload_hash,
    p_studio_id,
    null
  );
  if replay is not null then
    return replay;
  end if;

  select prepared.revision_id, prepared.revision_version
  into draft_revision_id, draft_revision_version
  from private.prepare_studio_revision_draft(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as prepared;

  if (
    select pg_catalog.count(*)
    from public.studio_revision_media as relation
    where relation.revision_id = draft_revision_id
  ) + (
    select pg_catalog.count(*)
    from public.studio_media as pending
    where pending.prepared_revision_id = draft_revision_id
      and pending.status = 'pending_upload'
      and pending.upload_expires_at > prepared_time
  ) >= 20 then
    raise exception using errcode = '23514', message = 'studio_media_limit_reached';
  end if;

  extension := case p_declared_mime_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/avif' then 'avif'
  end;
  storage_path := pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.%s',
    p_user_id,
    p_studio_id,
    draft_revision_id,
    media_id,
    extension
  );
  preview_storage_path := pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    p_user_id,
    p_studio_id,
    draft_revision_id,
    media_id
  );

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
    declared_checksum_sha256,
    status,
    prepared_at,
    upload_expires_at,
    cleanup_after,
    updated_at
  )
  values (
    media_id,
    p_studio_id,
    draft_revision_id,
    p_user_id,
    'studio-media',
    storage_path,
    preview_storage_path,
    p_declared_mime_type,
    p_declared_size_bytes,
    p_declared_checksum_sha256,
    'pending_upload',
    prepared_time,
    prepared_time + interval '2 hours',
    prepared_time + interval '24 hours',
    prepared_time
  );

  result := pg_catalog.jsonb_build_object(
    'scope', p_user_id,
    'studioId', p_studio_id,
    'revisionId', draft_revision_id,
    'revisionVersion', draft_revision_version,
    'mediaId', media_id,
    'bucket', 'studio-media',
    'path', storage_path,
    'expiresAt', prepared_time + interval '2 hours'
  );

  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.prepare',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    draft_revision_version,
    media_id,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_upload_prepared',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'mediaId', media_id,
      'revisionId', draft_revision_id,
      'revisionVersion', draft_revision_version,
      'declaredMimeType', p_declared_mime_type,
      'declaredSizeBytes', p_declared_size_bytes
    )
  );

  return result;
end;
$_$;


ALTER FUNCTION "private"."prepare_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_declared_mime_type" "text", "p_declared_size_bytes" bigint, "p_declared_checksum_sha256" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."prepare_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_declared_mime_type" "text", "p_declared_size_bytes" bigint, "p_declared_checksum_sha256" "text") IS 'Reserva path canônico por duas horas e mantém o candidato pendente por 24 horas, sem enviar binário pela aplicação.';



CREATE OR REPLACE FUNCTION "private"."prepare_studio_revision_draft"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint) RETURNS TABLE("revision_id" "uuid", "revision_version" bigint, "cloned" boolean)
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."prepare_studio_revision_draft"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."prepare_studio_revision_draft"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint) IS 'Trava e valida o token da revisão; retorna a draft existente ou clona a publicada sem mutá-la.';



CREATE OR REPLACE FUNCTION "private"."profile_command_result"("p_user_id" "uuid") RETURNS TABLE("user_id" "uuid", "person_type" "text", "status" "text", "name" "text", "phone_e164" "text", "tax_id_masked" "text", "additional_document_masked" "text", "profile_completed" boolean, "profile_version" bigint, "color_scheme" "text", "preferences_version" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select
    profile.id,
    profile.person_type,
    profile.status,
    profile.name,
    profile.phone_e164,
    profile.tax_id_masked,
    profile.additional_document_masked,
    profile.completed_at is not null,
    profile.profile_version,
    preference.color_scheme,
    preference.preferences_version
  from public.profiles as profile
  join public.user_preferences as preference
    on preference.user_id = profile.id
  where profile.id = p_user_id
    and p_user_id is not null;
$$;


ALTER FUNCTION "private"."profile_command_result"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."profile_command_result"("p_user_id" "uuid") IS 'Helper interno sem grant runtime que projeta o retorno autoritativo dos comandos de perfil.';



CREATE OR REPLACE FUNCTION "private"."protect_audit_event"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'UPDATE'
    and old.actor_user_id is not null
    and new.actor_user_id is null
    and new.id is not distinct from old.id
    and new.occurred_at is not distinct from old.occurred_at
    and new.actor_role is not distinct from old.actor_role
    and new.action is not distinct from old.action
    and new.target_type is not distinct from old.target_type
    and new.target_id is not distinct from old.target_id
    and new.result is not distinct from old.result
    and new.request_id is not distinct from old.request_id
    and new.idempotency_key is not distinct from old.idempotency_key
    and new.ip_hash is not distinct from old.ip_hash
    and new.metadata is not distinct from old.metadata
  then
    return new;
  end if;

  if tg_op = 'DELETE' and current_user = 'postgres' then
    return old;
  end if;

  raise exception using
    errcode = '42501',
    message = 'audit_event_is_append_only';
end;
$$;


ALTER FUNCTION "private"."protect_audit_event"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."protect_immutable_studio_media_lifecycle"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."protect_immutable_studio_media_lifecycle"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."protect_immutable_studio_media_lifecycle"() IS 'Impede que o ciclo físico da mídia altere o conteúdo de uma revisão editorial não draft.';



CREATE OR REPLACE FUNCTION "private"."protect_profile_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = old.id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'profile_delete_requires_auth_cascade';
  end if;

  return old;
end;
$$;


ALTER FUNCTION "private"."protect_profile_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."protect_studio_review_event"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."protect_studio_review_event"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."protect_terms_acceptance"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception using
      errcode = 'P0001',
      message = 'terms_acceptance_is_immutable';
  end if;

  if exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = old.user_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'terms_acceptance_delete_requires_auth_cascade';
  end if;

  return old;
end;
$$;


ALTER FUNCTION "private"."protect_terms_acceptance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."protect_terms_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'terms_version_is_immutable';
  end if;

  if old.id is not distinct from new.id
    and old.kind is not distinct from new.kind
    and old.version is not distinct from new.version
    and old.title is not distinct from new.title
    and old.body_markdown is not distinct from new.body_markdown
    and old.source is not distinct from new.source
    and old.effective_at is not distinct from new.effective_at
    and old.created_at is not distinct from new.created_at
    and old.retired_at is null
    and new.retired_at is not null
    and new.retired_at >= pg_catalog.statement_timestamp()
  then
    return new;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'terms_version_is_immutable';
end;
$$;


ALTER FUNCTION "private"."protect_terms_version"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."queue_studio_media_before_studio_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."queue_studio_media_before_studio_delete"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."queue_studio_media_before_studio_delete"() IS 'Enfileira toda mídia não terminal antes das ações FK e nunca antecipa cleanup ao vencimento do upload assinado.';



CREATE OR REPLACE FUNCTION "private"."queue_unattached_studio_media_before_revision_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  requested_at timestamptz := pg_catalog.clock_timestamp();
begin
  update public.studio_media as media
  set
    status = 'delete_pending',
    delete_requested_at = coalesce(media.delete_requested_at, requested_at),
    cleanup_after = greatest(
      coalesce(media.cleanup_after, requested_at),
      media.upload_expires_at
    ),
    cleanup_next_attempt_at = null
  where media.prepared_revision_id = old.id
    and media.status in ('pending_upload', 'rejected')
    and not exists (
      select 1
      from public.studio_revision_media as relation
      where relation.media_id = media.id
        and relation.revision_id <> old.id
    );

  return old;
end;
$$;


ALTER FUNCTION "private"."queue_unattached_studio_media_before_revision_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."queue_unreferenced_studio_media_after_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  requested_at timestamptz := pg_catalog.clock_timestamp();
begin
  update public.studio_media as media
  set
    status = 'delete_pending',
    delete_requested_at = coalesce(media.delete_requested_at, requested_at),
    cleanup_after = greatest(
      coalesce(media.cleanup_after, requested_at),
      media.upload_expires_at
    ),
    cleanup_next_attempt_at = null
  where media.id = old.media_id
    and media.status = 'ready'
    and not exists (
      select 1
      from public.studio_revision_media as remaining
      where remaining.media_id = media.id
    );

  return old;
end;
$$;


ALTER FUNCTION "private"."queue_unreferenced_studio_media_after_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."record_studio_media_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_revision_version" bigint, "p_media_id" "uuid", "p_result" "jsonb") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    studio_id,
    resulting_revision_id,
    resulting_revision_version,
    resulting_media_id,
    result_payload
  )
  values (
    p_user_id,
    p_idempotency_key,
    p_action,
    p_payload_hash,
    private.studio_result_hash(p_result),
    p_studio_id,
    p_revision_id,
    p_revision_version,
    p_media_id,
    p_result
  );
$$;


ALTER FUNCTION "private"."record_studio_media_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_revision_version" bigint, "p_media_id" "uuid", "p_result" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."record_studio_publication_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_revision_version" bigint, "p_result" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."record_studio_publication_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_revision_version" bigint, "p_result" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."reject_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid", "p_request_id" "uuid", "p_rejection_code" "text" DEFAULT 'validation_failed'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  media public.studio_media%rowtype;
  rejected_time timestamptz := pg_catalog.clock_timestamp();
  result jsonb;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_media_id is null
    or p_request_id is null
    or p_rejection_code is null
    or p_rejection_code <> all (array[
      'validation_failed'::text,
      'object_missing'::text,
      'superseded'::text,
      'upload_token_signing_failed'::text
    ])
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_reject';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('studio-media-reject:' || p_media_id::text, 0)
  );
  if p_rejection_code = 'upload_token_signing_failed' then
    perform profile.id
    from public.profiles as profile
    join public.owner_profiles as owner on owner.user_id = profile.id
    where profile.id = p_user_id
    for update of profile, owner;

    if not found then
      raise exception using errcode = 'P0002', message = 'studio_media_not_found';
    end if;
  else
    perform private.assert_studio_owner_mutable(p_user_id);
  end if;

  perform studio.id
  from public.studios as studio
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;

  perform revision.id
  from public.studio_revisions as revision
  where revision.id = p_expected_revision_id
    and revision.studio_id = p_studio_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;

  select candidate.*
  into media
  from public.studio_media as candidate
  where candidate.id = p_media_id
    and candidate.studio_id = p_studio_id
    and candidate.prepared_revision_id = p_expected_revision_id
    and candidate.uploaded_by = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;

  if p_rejection_code = 'upload_token_signing_failed'
    and media.upload_token_issued_at is not null
  then
    return pg_catalog.jsonb_build_object(
      'scope', p_user_id,
      'studioId', p_studio_id,
      'revisionId', p_expected_revision_id,
      'revisionVersion', p_expected_revision_version,
      'mediaId', p_media_id,
      'status', media.status,
      'tokenWasIssued', true,
      'issuedAt', media.upload_token_issued_at
    );
  end if;

  if media.status not in ('pending_upload', 'rejected') then
    raise exception using errcode = '40001', message = 'studio_media_reject_conflict';
  end if;

  if media.status = 'pending_upload' then
    update public.studio_media as candidate
    set
      status = 'rejected',
      rejection_code = p_rejection_code,
      rejected_at = rejected_time,
      cleanup_after = case
        when p_rejection_code = 'upload_token_signing_failed' then rejected_time
        else greatest(rejected_time, media.upload_expires_at)
      end,
      cleanup_next_attempt_at = null
    where candidate.id = media.id;

    perform private.audit_studio_media_command(
      p_user_id,
      p_request_id,
      p_media_id,
      'studio.media_upload_rejected',
      p_studio_id,
      pg_catalog.jsonb_build_object(
        'mediaId', p_media_id,
        'revisionId', p_expected_revision_id,
        'revisionVersion', p_expected_revision_version,
        'rejectionCode', p_rejection_code
      )
    );
  else
    rejected_time := media.rejected_at;
    p_rejection_code := media.rejection_code;
  end if;

  result := pg_catalog.jsonb_build_object(
    'scope', p_user_id,
    'studioId', p_studio_id,
    'revisionId', p_expected_revision_id,
    'revisionVersion', p_expected_revision_version,
    'mediaId', p_media_id,
    'status', 'rejected',
    'rejectionCode', p_rejection_code,
    'rejectedAt', rejected_time
  );
  return result;
end;
$$;


ALTER FUNCTION "private"."reject_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid", "p_request_id" "uuid", "p_rejection_code" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."reject_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid", "p_request_id" "uuid", "p_rejection_code" "text") IS 'Terminaliza a reserva pela identidade persistida; falha de assinatura só vence quando nenhuma autorização foi confirmada.';



CREATE OR REPLACE FUNCTION "private"."reject_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_rejection_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  claim private.studio_media_finalize_claims%rowtype;
  claim_idempotency_key uuid;
  claim_owner_user_id uuid;
  result jsonb;
begin
  if p_claim_token is null
    or p_request_id is null
    or p_rejection_code is null
    or p_rejection_code <> all (
      array['object_missing'::text, 'superseded'::text, 'validation_failed'::text]
    )
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_finalize_rejection';
  end if;

  select existing.owner_user_id, existing.idempotency_key
  into claim_owner_user_id, claim_idempotency_key
  from private.studio_media_finalize_claims as existing
  where existing.lease_token = p_claim_token
    and existing.terminal_state is null;

  if not found then
    raise exception using errcode = '40001', message = 'studio_media_finalize_claim_lost';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      claim_owner_user_id::text || ':' || claim_idempotency_key::text,
      0
    )
  );
  perform private.assert_studio_owner_mutable(claim_owner_user_id);

  select existing.*
  into claim
  from private.studio_media_finalize_claims as existing
  where existing.lease_token = p_claim_token
  for update;

  if not found
    or claim.terminal_state is not null
    or claim.lease_expires_at <= pg_catalog.clock_timestamp()
  then
    raise exception using errcode = '40001', message = 'studio_media_finalize_claim_lost';
  end if;

  result := private.reject_studio_media_upload(
    claim.owner_user_id,
    claim.studio_id,
    claim.expected_revision_id,
    claim.expected_revision_version,
    claim.media_id,
    p_request_id,
    p_rejection_code
  );

  update private.studio_media_finalize_claims as existing
  set
    terminal_state = 'rejected',
    terminal_rejection_code = p_rejection_code,
    terminal_at = pg_catalog.clock_timestamp()
  where existing.owner_user_id = claim.owner_user_id
    and existing.idempotency_key = claim.idempotency_key
    and existing.lease_token = p_claim_token
    and existing.terminal_state is null;
  if not found then
    raise exception using errcode = '40001', message = 'studio_media_finalize_claim_lost';
  end if;

  return result;
end;
$$;


ALTER FUNCTION "private"."reject_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_rejection_code" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."reject_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_rejection_code" "text") IS 'Deriva toda identidade mutável do claim cercado e terminaliza a reserva e o tombstone na mesma transação.';



CREATE OR REPLACE FUNCTION "private"."reject_unsigned_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  settlement jsonb;
begin
  settlement := private.reject_studio_media_upload(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version,
    p_media_id,
    p_request_id,
    'upload_token_signing_failed'
  );

  if coalesce((settlement ->> 'tokenWasIssued')::boolean, false) then
    return pg_catalog.jsonb_build_object(
      'scope', settlement ->> 'scope',
      'studioId', settlement ->> 'studioId',
      'revisionId', settlement ->> 'revisionId',
      'revisionVersion', (settlement ->> 'revisionVersion')::bigint,
      'mediaId', settlement ->> 'mediaId',
      'state', 'issued',
      'issuedAt', settlement ->> 'issuedAt'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'scope', settlement ->> 'scope',
    'studioId', settlement ->> 'studioId',
    'revisionId', settlement ->> 'revisionId',
    'revisionVersion', (settlement ->> 'revisionVersion')::bigint,
    'mediaId', settlement ->> 'mediaId',
    'state', 'rejected',
    'rejectedAt', settlement ->> 'rejectedAt'
  );
end;
$$;


ALTER FUNCTION "private"."reject_unsigned_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."reject_unsigned_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid", "p_request_id" "uuid") IS 'Compensa uma assinatura não entregue sem cancelar uma autorização confirmada por tentativa concorrente.';



CREATE OR REPLACE FUNCTION "private"."release_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  grant_released boolean;
begin
  if p_token is null
    or p_user_id is null
    or p_auth_session_id is null
    or p_session_scope is null
    or p_attempt_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    return false;
  end if;

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = null,
    claimed_at = null
  from private.identity_recovery_sessions as recovery_session
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.auth_session_id = p_auth_session_id
    and recovery_grant.claim_attempt_id = p_attempt_id
    and recovery_grant.expires_at > pg_catalog.statement_timestamp()
    and recovery_session.auth_session_id = recovery_grant.auth_session_id
    and recovery_session.user_id = recovery_grant.user_id
    and recovery_session.session_scope = p_session_scope
    and recovery_session.closed_at is null
  returning true into grant_released;

  return coalesce(grant_released, false);
end;
$$;


ALTER FUNCTION "private"."release_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."release_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") IS 'Libera somente a reserva vigente da mesma tentativa e binding ativa após rejeição segura.';



CREATE OR REPLACE FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  grant_released boolean;
begin
  if p_token is null or p_user_id is null or p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = null,
    claimed_at = null
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.claim_attempt_id = p_attempt_id
    and recovery_grant.expires_at > pg_catalog.statement_timestamp()
  returning true into grant_released;

  return coalesce(grant_released, false);
end;
$$;


ALTER FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") IS 'Libera somente grant vigente reservado pela tentativa informada após rejeição segura do provedor.';



CREATE OR REPLACE FUNCTION "private"."release_studio_media_finalize_claim"("p_claim_token" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if p_claim_token is null then
    raise exception using errcode = '22023', message = 'invalid_studio_media_finalize_claim_release';
  end if;

  update private.studio_media_finalize_claims as existing
  set
    lease_token = null,
    lease_claimed_at = null,
    lease_expires_at = null
  where existing.lease_token = p_claim_token;

  return found;
end;
$$;


ALTER FUNCTION "private"."release_studio_media_finalize_claim"("p_claim_token" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."release_studio_media_finalize_claim"("p_claim_token" "uuid") IS 'Limpa somente a lease do token atual; tokens antigos não conseguem liberar uma tomada posterior.';



CREATE OR REPLACE FUNCTION "private"."renew_studio_media_finalize_claim"("p_claim_token" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  claim_time timestamptz;
  renewed_lease_expires_at timestamptz;
begin
  if p_claim_token is null then
    raise exception using errcode = '22023', message = 'invalid_studio_media_finalize_claim';
  end if;

  claim_time := pg_catalog.clock_timestamp();
  update private.studio_media_finalize_claims as existing
  set
    lease_claimed_at = claim_time,
    lease_expires_at = claim_time + interval '30 seconds'
  where existing.lease_token = p_claim_token
    and existing.terminal_state is null
    and existing.lease_expires_at > claim_time
  returning existing.lease_expires_at into renewed_lease_expires_at;

  if not found then
    raise exception using errcode = '40001', message = 'studio_media_finalize_claim_lost';
  end if;

  return pg_catalog.jsonb_build_object('leaseExpiresAt', renewed_lease_expires_at);
end;
$$;


ALTER FUNCTION "private"."renew_studio_media_finalize_claim"("p_claim_token" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."renew_studio_media_finalize_claim"("p_claim_token" "uuid") IS 'Renova atomicamente por 30 s a lease ainda vigente antes do upload terminal; token expirado ou substituído não pode ressuscitar.';



CREATE OR REPLACE FUNCTION "private"."reorder_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_ordered_media_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  changed boolean;
  draft_revision_id uuid;
  draft_revision_version bigint;
  payload_hash text;
  replay jsonb;
  result jsonb;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_ordered_media_ids is null
    or pg_catalog.cardinality(p_ordered_media_ids) > 20
    or pg_catalog.array_position(p_ordered_media_ids, null) is not null
    or pg_catalog.cardinality(p_ordered_media_ids) <> (
      select pg_catalog.count(distinct selected.media_id)
      from pg_catalog.unnest(p_ordered_media_ids) as selected(media_id)
    )
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_order';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.reorder',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'orderedMediaIds', pg_catalog.to_jsonb(p_ordered_media_ids)
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.reorder',
    payload_hash,
    p_studio_id,
    null
  );
  if replay is not null then
    return replay;
  end if;

  select locked.locked_revision_id, locked.locked_revision_version
  into draft_revision_id, draft_revision_version
  from private.lock_studio_media_revision(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as locked;
  resulting_revision_version := draft_revision_version;

  perform relation.media_id
  from public.studio_revision_media as relation
  where relation.revision_id = draft_revision_id
  order by relation.media_id
  for update;

  if pg_catalog.cardinality(p_ordered_media_ids) <> (
      select pg_catalog.count(*)
      from public.studio_revision_media as relation
      where relation.revision_id = draft_revision_id
    )
    or exists (
      select 1
      from public.studio_revision_media as relation
      where relation.revision_id = draft_revision_id
        and relation.media_id <> all (p_ordered_media_ids)
    )
  then
    raise exception using errcode = '23514', message = 'studio_media_order_set_mismatch';
  end if;

  select exists (
    select 1
    from pg_catalog.unnest(p_ordered_media_ids) with ordinality as selected(media_id, position)
    join public.studio_revision_media as relation
      on relation.revision_id = draft_revision_id
      and relation.media_id = selected.media_id
    where relation.position <> selected.position
  ) into changed;

  if changed then
    set constraints public.studio_revision_media_position_key deferred;

    update public.studio_revision_media as relation
    set position = selected.position::smallint
    from pg_catalog.unnest(p_ordered_media_ids) with ordinality as selected(media_id, position)
    where relation.revision_id = draft_revision_id
      and relation.media_id = selected.media_id;

    update public.studio_revisions as revision
    set revision_version = revision.revision_version + 1
    where revision.id = draft_revision_id
      and revision.status = 'draft'
      and revision.revision_version = draft_revision_version
    returning revision.revision_version into resulting_revision_version;

    if not found then
      raise exception using errcode = '40001', message = 'studio_revision_conflict';
    end if;
  end if;

  result := private.get_owner_studio_media(p_user_id, p_studio_id);
  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.reorder',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    resulting_revision_version,
    null,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_reordered',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'mediaCount', pg_catalog.cardinality(p_ordered_media_ids),
      'changed', changed
    )
  );

  return result;
end;
$$;


ALTER FUNCTION "private"."reorder_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_ordered_media_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."reorder_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_ordered_media_ids" "uuid"[]) IS 'Substitui a ordem completa da galeria sob lock e constraint diferível.';



CREATE OR REPLACE FUNCTION "private"."replay_studio_media_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid", "p_media_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  existing_request private.studio_command_requests%rowtype;
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
    or (
      p_action = 'studio.media.prepare'
      and existing_request.resulting_media_id is null
    )
    or (
      p_action <> 'studio.media.prepare'
      and existing_request.resulting_media_id is distinct from p_media_id
    )
    or existing_request.result_payload is null
    or existing_request.result_hash <> private.studio_result_hash(existing_request.result_payload)
  then
    raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
  end if;

  return existing_request.result_payload;
end;
$$;


ALTER FUNCTION "private"."replay_studio_media_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid", "p_media_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."replay_studio_media_finalize"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_media_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  payload_hash text;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_media_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_finalize';
  end if;

  perform private.assert_studio_owner_mutable(p_user_id);
  payload_hash := private.studio_media_payload_hash(
    'studio.media.finalize',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'mediaId', p_media_id
    )
  );
  return private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.finalize',
    payload_hash,
    p_studio_id,
    p_media_id
  );
end;
$$;


ALTER FUNCTION "private"."replay_studio_media_finalize"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_media_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."replay_studio_media_finalize"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_media_id" "uuid") IS 'Relê um finalize já confirmado pelo envelope original antes de repetir download ou escrita física.';



CREATE OR REPLACE FUNCTION "private"."replay_studio_publication_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."replay_studio_publication_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."resume_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."resume_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."resume_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Retoma publicação aprovada e deriva published ou changes_pending da candidata apontada.';



CREATE OR REPLACE FUNCTION "private"."reveal_backoffice_user_pii"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."reveal_backoffice_user_pii"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."reveal_backoffice_user_pii"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Revela PII somente em resposta efêmera e auditada; o ledger persiste apenas versões.';



CREATE OR REPLACE FUNCTION "private"."set_backoffice_user_role"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."set_backoffice_user_role"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."set_backoffice_user_role"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Deriva concessão ou revogação support/admin da ação explícita, com reautenticação, versão opaca e proteção do último admin.';



CREATE OR REPLACE FUNCTION "private"."set_backoffice_user_status"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."set_backoffice_user_status"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."set_backoffice_user_status"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Suspende ou restaura conta com versão otimista, auditoria e proteção do último admin.';



CREATE OR REPLACE FUNCTION "private"."set_profile_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.profile_version := old.profile_version + case
    when (
      new.person_type,
      new.completed_at,
      new.name,
      new.phone_e164,
      new.tax_id,
      new.additional_document
    ) is distinct from (
      old.person_type,
      old.completed_at,
      old.name,
      old.phone_e164,
      old.tax_id,
      old.additional_document
    ) then 1
    else 0
  end;
  new.account_version := old.account_version + case
    when new.status is distinct from old.status
      or new.account_version is distinct from old.account_version
    then 1
    else 0
  end;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


ALTER FUNCTION "private"."set_profile_updated_at"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."set_profile_updated_at"() IS 'Atualiza timestamp e mantém versões independentes para identidade e estado operacional da conta.';



CREATE OR REPLACE FUNCTION "private"."set_studio_media_cover"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  already_cover boolean;
  draft_revision_id uuid;
  draft_revision_version bigint;
  payload_hash text;
  replay jsonb;
  result jsonb;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_media_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_cover';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.cover.set',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'mediaId', p_media_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.cover.set',
    payload_hash,
    p_studio_id,
    p_media_id
  );
  if replay is not null then
    return replay;
  end if;

  select locked.locked_revision_id, locked.locked_revision_version
  into draft_revision_id, draft_revision_version
  from private.lock_studio_media_revision(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as locked;
  resulting_revision_version := draft_revision_version;

  select relation.is_cover
  into already_cover
  from public.studio_revision_media as relation
  join public.studio_media as media on media.id = relation.media_id
  where relation.revision_id = draft_revision_id
    and relation.media_id = p_media_id
    and media.status = 'ready'
  for update of relation;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;

  if not already_cover then
    update public.studio_revision_media as relation
    set is_cover = false
    where relation.revision_id = draft_revision_id
      and relation.is_cover;

    update public.studio_revision_media as relation
    set is_cover = true
    where relation.revision_id = draft_revision_id
      and relation.media_id = p_media_id;

    update public.studio_revisions as revision
    set revision_version = revision.revision_version + 1
    where revision.id = draft_revision_id
      and revision.status = 'draft'
      and revision.revision_version = draft_revision_version
    returning revision.revision_version into resulting_revision_version;

    if not found then
      raise exception using errcode = '40001', message = 'studio_revision_conflict';
    end if;
  end if;

  result := private.get_owner_studio_media(p_user_id, p_studio_id);
  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.cover.set',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    resulting_revision_version,
    p_media_id,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_cover_set',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'mediaId', p_media_id,
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'changed', not already_cover
    )
  );

  return result;
end;
$$;


ALTER FUNCTION "private"."set_studio_media_cover"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."set_studio_media_cover"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") IS 'Define no máximo uma capa da draft de forma atômica; replay e no-op preservam a versão.';



CREATE OR REPLACE FUNCTION "private"."set_studio_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


ALTER FUNCTION "private"."set_studio_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."set_user_preferences_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception using
      errcode = 'P0001',
      message = 'user_preferences_owner_is_immutable';
  end if;

  new.preferences_version := old.preferences_version + 1;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


ALTER FUNCTION "private"."set_user_preferences_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."studio_core_payload_hash"("p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'name', p_name,
          'description', p_description,
          'street', p_street,
          'streetNumber', p_street_number,
          'addressComplement', p_address_complement,
          'neighborhood', p_neighborhood,
          'city', p_city,
          'state', p_state,
          'postalCode', p_postal_code,
          'capacity', p_capacity,
          'studioTypeId', p_studio_type_id
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;


ALTER FUNCTION "private"."studio_core_payload_hash"("p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."studio_editor_json"("p_user_id" "uuid", "p_studio_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."studio_editor_json"("p_user_id" "uuid", "p_studio_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."studio_media_cleanup_runs_are_healthy"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select
    coalesce(
      (
        select pg_catalog.max(succeeded_run.completed_at)
        from maintenance.studio_media_cleanup_runs as succeeded_run
        where succeeded_run.status = 'succeeded'
      ) >= pg_catalog.now() - interval '30 minutes',
      false
    )
    and not exists (
      select 1
      from maintenance.studio_media_cleanup_runs as run
      where run.status = 'running'
        and run.started_at <= pg_catalog.now() - interval '30 minutes'
    )
    and not exists (
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
    );
$$;


ALTER FUNCTION "private"."studio_media_cleanup_runs_are_healthy"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."studio_media_cleanup_runs_are_healthy"() IS 'Fail-closed quando falta sucesso terminal recente, existe execução envelhecida ou uma falha posterior ao último sucesso.';



CREATE OR REPLACE FUNCTION "private"."studio_media_payload_hash"("p_action" "text", "p_payload" "jsonb") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object('action', p_action, 'payload', p_payload)::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;


ALTER FUNCTION "private"."studio_media_payload_hash"("p_action" "text", "p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."studio_publication_checklist"("p_revision_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."studio_publication_checklist"("p_revision_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."studio_publication_checklist"("p_revision_id" "uuid") IS 'Deriva completude somente de dados canônicos; catálogo arquivado ou mídia pendente impedem submissão.';



CREATE OR REPLACE FUNCTION "private"."studio_publication_json"("p_user_id" "uuid", "p_studio_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."studio_publication_json"("p_user_id" "uuid", "p_studio_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."studio_publication_payload_hash"("p_action" "text", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_expected_publication_version" bigint) RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."studio_publication_payload_hash"("p_action" "text", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_expected_publication_version" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."studio_publication_revision_json"("p_revision_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."studio_publication_revision_json"("p_revision_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."studio_publication_revision_json"("p_revision_id" "uuid") IS 'Projeta uma revisão e sua capa privada para o DAL server-only assinar fora do banco.';



CREATE OR REPLACE FUNCTION "private"."studio_result_hash"("p_result" "jsonb") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_result::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;


ALTER FUNCTION "private"."studio_result_hash"("p_result" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."studio_revision_taxonomy_fence"("p_revision_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."studio_revision_taxonomy_fence"("p_revision_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."submit_studio_revision"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."submit_studio_revision"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."submit_studio_revision"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Submete uma candidata completa atomicamente com evento editorial, outbox, ledger e audit.';



CREATE OR REPLACE FUNCTION "private"."touch_platform_role_account_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  update public.profiles as profile
  set account_version = profile.account_version + 1
  where profile.id = case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;


ALTER FUNCTION "private"."touch_platform_role_account_version"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."touch_platform_role_account_version"() IS 'Avança a versão opaca de autorização em toda concessão ou revogação de papel.';



CREATE OR REPLACE FUNCTION "private"."transition_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."transition_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."transition_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Deriva arquivamento ou reativação da ação explícita e preserva referências históricas.';



CREATE OR REPLACE FUNCTION "private"."update_profile_appearance"("p_user_id" "uuid", "p_expected_preferences_version" bigint, "p_color_scheme" "text") RETURNS TABLE("user_id" "uuid", "person_type" "text", "status" "text", "name" "text", "phone_e164" "text", "tax_id_masked" "text", "additional_document_masked" "text", "profile_completed" boolean, "profile_version" bigint, "color_scheme" "text", "preferences_version" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  current_profile public.profiles%rowtype;
  current_preference public.user_preferences%rowtype;
begin
  if p_user_id is null
    or p_expected_preferences_version is null
    or p_expected_preferences_version < 0
    or p_color_scheme is null
    or p_color_scheme not in ('system', 'light', 'dark')
  then
    raise exception using errcode = '22023', message = 'invalid_profile_input';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'profile_not_found';
  end if;

  if current_profile.status <> 'active' then
    raise exception using errcode = '42501', message = 'profile_inactive';
  end if;

  select preference.*
  into current_preference
  from public.user_preferences as preference
  where preference.user_id = p_user_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'profile_preferences_missing';
  end if;

  if current_preference.color_scheme = p_color_scheme then
    return query select * from private.profile_command_result(p_user_id);
    return;
  end if;

  if current_preference.preferences_version <>
    p_expected_preferences_version
  then
    raise exception using
      errcode = '40001',
      message = 'preferences_version_conflict';
  end if;

  update public.user_preferences as preference
  set color_scheme = p_color_scheme
  where preference.user_id = p_user_id;

  return query select * from private.profile_command_result(p_user_id);
end;
$$;


ALTER FUNCTION "private"."update_profile_appearance"("p_user_id" "uuid", "p_expected_preferences_version" bigint, "p_color_scheme" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."update_profile_appearance"("p_user_id" "uuid", "p_expected_preferences_version" bigint, "p_color_scheme" "text") IS 'Atualiza a allowlist visual com versão independente da identidade.';



CREATE OR REPLACE FUNCTION "private"."update_profile_identity"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_name" "text", "p_phone_e164" "text", "p_replace_tax_id" boolean, "p_tax_id" "text", "p_replace_additional_document" boolean, "p_additional_document" "text") RETURNS TABLE("user_id" "uuid", "person_type" "text", "status" "text", "name" "text", "phone_e164" "text", "tax_id_masked" "text", "additional_document_masked" "text", "profile_completed" boolean, "profile_version" bigint, "color_scheme" "text", "preferences_version" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  current_profile public.profiles%rowtype;
  target_tax_id text;
  target_additional_document text;
begin
  if p_user_id is null
    or p_expected_profile_version is null
    or p_expected_profile_version < 0
    or p_name is null
    or pg_catalog.char_length(p_name) not between 2 and 160
    or p_name <> pg_catalog.btrim(p_name)
    or p_name ~ '[[:cntrl:]]'
    or p_phone_e164 is null
    or p_phone_e164 !~ '^\+55[1-9][0-9]([2-5][0-9]{7}|9[0-9]{8})$'
    or p_replace_tax_id is null
    or p_replace_additional_document is null
    or (not p_replace_tax_id and p_tax_id is not null)
    or (p_replace_tax_id and p_tax_id is null)
    or (not p_replace_additional_document and p_additional_document is not null)
    or (
      p_replace_additional_document
      and p_additional_document is not null
      and (
        pg_catalog.char_length(p_additional_document) not between 3 and 40
        or p_additional_document !~ '^[A-Z0-9]+([./ -][A-Z0-9]+)*$'
      )
    )
  then
    raise exception using errcode = '22023', message = 'invalid_profile_input';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'profile_not_found';
  end if;

  if current_profile.status <> 'active' then
    raise exception using errcode = '42501', message = 'profile_inactive';
  end if;

  if current_profile.completed_at is null then
    raise exception using errcode = 'P0001', message = 'profile_incomplete';
  end if;

  target_tax_id := case
    when p_replace_tax_id then p_tax_id
    else current_profile.tax_id
  end;
  target_additional_document := case
    when p_replace_additional_document then p_additional_document
    else current_profile.additional_document
  end;

  if (
    current_profile.person_type = 'individual'
    and not private.is_valid_cpf(target_tax_id)
  ) or (
    current_profile.person_type = 'company'
    and not private.is_valid_cnpj(target_tax_id)
  ) then
    raise exception using errcode = '22023', message = 'invalid_profile_input';
  end if;

  if current_profile.name = p_name
    and current_profile.phone_e164 = p_phone_e164
    and current_profile.tax_id = target_tax_id
    and current_profile.additional_document is not distinct from target_additional_document
  then
    return query select * from private.profile_command_result(p_user_id);
    return;
  end if;

  if current_profile.profile_version <> p_expected_profile_version then
    raise exception using errcode = '40001', message = 'profile_version_conflict';
  end if;

  update public.profiles as profile
  set
    name = p_name,
    phone_e164 = p_phone_e164,
    tax_id = target_tax_id,
    additional_document = target_additional_document
  where profile.id = p_user_id;

  return query select * from private.profile_command_result(p_user_id);
end;
$_$;


ALTER FUNCTION "private"."update_profile_identity"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_name" "text", "p_phone_e164" "text", "p_replace_tax_id" boolean, "p_tax_id" "text", "p_replace_additional_document" boolean, "p_additional_document" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."update_profile_identity"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_name" "text", "p_phone_e164" "text", "p_replace_tax_id" boolean, "p_tax_id" "text", "p_replace_additional_document" boolean, "p_additional_document" "text") IS 'Atualiza identidade concluída com versão otimista e substituição documental explícita sem reexpor PII.';



CREATE OR REPLACE FUNCTION "private"."update_studio_revision_content"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_usage_rules" "text", "p_youtube_video_id" "text", "p_faqs" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
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
$_$;


ALTER FUNCTION "private"."update_studio_revision_content"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_usage_rules" "text", "p_youtube_video_id" "text", "p_faqs" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."update_studio_revision_content"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_usage_rules" "text", "p_youtube_video_id" "text", "p_faqs" "jsonb") IS 'Substitui regras, FAQ ordenada e ID de YouTube da draft de forma atômica e idempotente.';



CREATE OR REPLACE FUNCTION "private"."update_studio_revision_core"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  core_hash text;
  current_revision public.studio_revisions%rowtype;
  current_studio public.studios%rowtype;
  editor jsonb;
  existing_request private.studio_command_requests%rowtype;
  next_revision_number bigint;
  payload_hash text;
  resulting_revision_id uuid;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_studio_type_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_update';
  end if;

  core_hash := private.studio_core_payload_hash(
    p_name,
    p_description,
    p_street,
    p_street_number,
    p_address_complement,
    p_neighborhood,
    p_city,
    p_state,
    p_postal_code,
    p_capacity,
    p_studio_type_id
  );
  payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'studioId', p_studio_id,
          'expectedRevisionId', p_expected_revision_id,
          'expectedRevisionVersion', p_expected_revision_version,
          'coreHash', core_hash
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
    if existing_request.action <> 'studio.revision.updateCore'
      or existing_request.payload_hash <> payload_hash
      or existing_request.studio_id <> p_studio_id
    then
      raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
    end if;

    editor := private.studio_editor_json(p_user_id, p_studio_id);
    if editor is null then
      raise exception using errcode = '40001', message = 'studio_update_result_missing';
    end if;
    if private.studio_result_hash(editor) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'studio_update_result_stale';
    end if;
    return editor;
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

  if not exists (
    select 1
    from public.studio_types as studio_type
    where studio_type.id = p_studio_type_id
      and studio_type.active
    for share
  ) then
    raise exception using errcode = '23514', message = 'studio_type_inactive';
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

    update public.studio_revisions as revision
    set
      revision_version = revision.revision_version + 1,
      name = p_name,
      description = p_description,
      street = p_street,
      street_number = p_street_number,
      address_complement = p_address_complement,
      neighborhood = p_neighborhood,
      city = p_city,
      state = p_state,
      postal_code = p_postal_code,
      capacity = p_capacity,
      studio_type_id = p_studio_type_id
    where revision.id = current_revision.id
      and revision.status = 'draft'
      and revision.revision_version = p_expected_revision_version
    returning revision.id, revision.revision_version
      into resulting_revision_id, resulting_revision_version;

    if not found then
      raise exception using errcode = '40001', message = 'studio_revision_conflict';
    end if;
  else
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
      studio_type_id
    )
    values (
      current_studio.id,
      next_revision_number,
      1,
      'draft',
      p_name,
      p_description,
      p_street,
      p_street_number,
      p_address_complement,
      p_neighborhood,
      p_city,
      p_state,
      p_postal_code,
      p_capacity,
      p_studio_type_id
    )
    returning id, revision_version
      into resulting_revision_id, resulting_revision_version;

    update public.studios as studio
    set draft_revision_id = resulting_revision_id
    where studio.id = current_studio.id;
  end if;

  editor := private.studio_editor_json(p_user_id, p_studio_id);
  if editor is null then
    raise exception using errcode = 'P0002', message = 'studio_update_result_missing';
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
    'studio.revision.updateCore',
    payload_hash,
    private.studio_result_hash(editor),
    p_studio_id,
    resulting_revision_id,
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
    'studio.revision_updated',
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'revisionId', resulting_revision_id,
      'revisionVersion', resulting_revision_version
    )
  );

  return editor;
end;
$$;


ALTER FUNCTION "private"."update_studio_revision_core"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."update_studio_revision_core"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") IS 'Atualiza draft com concorrência otimista ou clona a revisão publicada sem mutá-la.';



CREATE OR REPLACE FUNCTION "private"."update_studio_revision_taxonomy"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_tag_ids" "uuid"[], "p_amenity_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "private"."update_studio_revision_taxonomy"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_tag_ids" "uuid"[], "p_amenity_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "private"."update_studio_revision_taxonomy"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_tag_ids" "uuid"[], "p_amenity_ids" "uuid"[]) IS 'Substitui tags e comodidades ativas da draft de forma atômica e idempotente.';



CREATE OR REPLACE FUNCTION "private"."upsert_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_idempotency_key" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
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
    return result;
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

  return result;
end;
$_$;


ALTER FUNCTION "private"."upsert_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_idempotency_key" "uuid", "p_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "private"."upsert_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_idempotency_key" "uuid", "p_request_id" "uuid") IS 'Cria ou edita taxonomia com versão otimista, idempotência e auditoria.';



CREATE OR REPLACE FUNCTION "private"."validate_terms_acceptance_snapshot"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  expected_hash text;
  version_effective_at timestamptz;
  version_retired_at timestamptz;
begin
  select
    legal_version.content_hash,
    legal_version.effective_at,
    legal_version.retired_at
  into
    expected_hash,
    version_effective_at,
    version_retired_at
  from public.terms_versions as legal_version
  where legal_version.id = new.terms_version_id;

  if expected_hash is null
    or expected_hash <> new.accepted_content_hash
    or new.accepted_at < version_effective_at
    or (
      version_retired_at is not null
      and new.accepted_at >= version_retired_at
    )
    or new.accepted_at > pg_catalog.clock_timestamp()
  then
    raise exception using
      errcode = 'P0001',
      message = 'terms_acceptance_snapshot_mismatch';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "private"."validate_terms_acceptance_snapshot"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."begin_studio_media_cleanup_run"("p_run_id" "uuid", "p_function_slug" "text") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select maintenance.begin_studio_media_cleanup_run(p_run_id, p_function_slug);
$$;


ALTER FUNCTION "public"."begin_studio_media_cleanup_run"("p_run_id" "uuid", "p_function_slug" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."begin_studio_media_cleanup_run"("p_run_id" "uuid", "p_function_slug" "text") IS 'Fachada service_role-only para criar ou reler atomicamente uma execução cercada pelo slug da Edge Function.';



CREATE OR REPLACE FUNCTION "public"."claim_studio_media_cleanup"("p_claim_token" "uuid", "p_limit" integer) RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select maintenance.claim_studio_media_cleanup(p_claim_token, p_limit);
$$;


ALTER FUNCTION "public"."claim_studio_media_cleanup"("p_claim_token" "uuid", "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."claim_studio_media_cleanup"("p_claim_token" "uuid", "p_limit" integer) IS 'Fachada RPC sem lógica própria, executável somente por service_role, para o claim em maintenance.';



CREATE OR REPLACE FUNCTION "public"."complete_studio_media_cleanup"("p_claim_token" "uuid", "p_media_id" "uuid", "p_succeeded" boolean, "p_error_code" "text") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select maintenance.complete_studio_media_cleanup(
    p_claim_token,
    p_media_id,
    p_succeeded,
    p_error_code
  );
$$;


ALTER FUNCTION "public"."complete_studio_media_cleanup"("p_claim_token" "uuid", "p_media_id" "uuid", "p_succeeded" boolean, "p_error_code" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."complete_studio_media_cleanup"("p_claim_token" "uuid", "p_media_id" "uuid", "p_succeeded" boolean, "p_error_code" "text") IS 'Fachada RPC sem lógica própria, executável somente por service_role, para o complete em maintenance.';



CREATE OR REPLACE FUNCTION "public"."complete_studio_media_cleanup_run"("p_run_id" "uuid", "p_status" "text", "p_claimed" integer, "p_deleted" integer, "p_failed" integer, "p_error_code" "text") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select maintenance.complete_studio_media_cleanup_run(
    p_run_id,
    p_status,
    p_claimed,
    p_deleted,
    p_failed,
    p_error_code
  );
$$;


ALTER FUNCTION "public"."complete_studio_media_cleanup_run"("p_run_id" "uuid", "p_status" "text", "p_claimed" integer, "p_deleted" integer, "p_failed" integer, "p_error_code" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."complete_studio_media_cleanup_run"("p_run_id" "uuid", "p_status" "text", "p_claimed" integer, "p_deleted" integer, "p_failed" integer, "p_error_code" "text") IS 'Fachada service_role-only para concluir o ledger com contagens e código seguro.';



CREATE OR REPLACE FUNCTION "public"."get_current_legal_terms"() RETURNS TABLE("id" "uuid", "kind" "text", "version" "text", "title" "text", "body_markdown" "text", "content_hash" "text", "source" "text", "effective_at" timestamp with time zone)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select
    legal_version.id,
    legal_version.kind,
    legal_version.version,
    legal_version.title,
    legal_version.body_markdown,
    legal_version.content_hash,
    legal_version.source,
    legal_version.effective_at
  from public.terms_versions as legal_version
  where legal_version.kind in ('terms', 'privacy')
    and legal_version.effective_at <= pg_catalog.now()
    and (
      legal_version.retired_at is null
      or pg_catalog.now() < legal_version.retired_at
    )
  order by legal_version.kind;
$$;


ALTER FUNCTION "public"."get_current_legal_terms"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_current_owner_contract"() RETURNS TABLE("id" "uuid", "kind" "text", "version" "text", "title" "text", "body_markdown" "text", "content_hash" "text", "source" "text", "effective_at" timestamp with time zone)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select
    legal_version.id,
    legal_version.kind,
    legal_version.version,
    legal_version.title,
    legal_version.body_markdown,
    legal_version.content_hash,
    legal_version.source,
    legal_version.effective_at
  from public.terms_versions as legal_version
  where legal_version.kind = 'owner_contract'
    and legal_version.effective_at <= pg_catalog.now()
    and (
      legal_version.retired_at is null
      or pg_catalog.now() < legal_version.retired_at
    );
$$;


ALTER FUNCTION "public"."get_current_owner_contract"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_profile"() RETURNS TABLE("user_id" "uuid", "person_type" "text", "status" "text", "name" "text", "phone_e164" "text", "tax_id_masked" "text", "additional_document_masked" "text", "profile_completed" boolean, "profile_version" bigint, "color_scheme" "text", "preferences_version" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select
    profile.id,
    profile.person_type,
    profile.status,
    profile.name,
    profile.phone_e164,
    profile.tax_id_masked,
    profile.additional_document_masked,
    profile.completed_at is not null,
    profile.profile_version,
    preference.color_scheme,
    preference.preferences_version
  from public.profiles as profile
  join public.user_preferences as preference
    on preference.user_id = profile.id
  where profile.id = (select auth.uid());
$$;


ALTER FUNCTION "public"."get_my_profile"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_my_profile"() IS 'Read model próprio security invoker filtrado por auth.uid(), com projeção segura e mascarada.';



CREATE OR REPLACE FUNCTION "public"."get_own_identity_context"() RETURNS TABLE("user_id" "uuid", "person_type" "text", "status" "text", "is_complete" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select
    profile.id,
    profile.person_type,
    profile.status,
    profile.completed_at is not null
  from public.profiles as profile
  where profile.id = (select auth.uid());
$$;


ALTER FUNCTION "public"."get_own_identity_context"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_owner_activation_status"() RETURNS TABLE("scope" "uuid", "owner_status" "text", "owner_version" bigint, "accepted_owner_contract_version_id" "uuid", "owner_contract_accepted" boolean, "owner_contract_id" "uuid", "owner_contract_kind" "text", "owner_contract_version" "text", "owner_contract_title" "text", "owner_contract_body_markdown" "text", "owner_contract_content_hash" "text", "owner_contract_source" "text", "owner_contract_effective_at" timestamp with time zone, "recipient_status" "text", "requirements" "text"[], "next_action" "text", "profile_version" bigint, "profile_version_synced" bigint, "recipient_version" bigint, "reservations_eligible" boolean, "provider_mode" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  with current_contract as (
    select
      legal_version.id,
      legal_version.kind,
      legal_version.version,
      legal_version.title,
      legal_version.body_markdown,
      legal_version.content_hash,
      legal_version.source,
      legal_version.effective_at
    from public.terms_versions as legal_version
    where legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.now()
      and (
        legal_version.retired_at is null
        or pg_catalog.now() < legal_version.retired_at
      )
  ),
  source_state as (
    select
      profile.id as user_id,
      profile.profile_version,
      profile.status as profile_status,
      owner.status as canonical_owner_status,
      owner.owner_version,
      owner.accepted_owner_contract_version_id,
      contract.id as contract_id,
      contract.kind as contract_kind,
      contract.version as contract_version,
      contract.title as contract_title,
      contract.body_markdown as contract_body_markdown,
      contract.content_hash as contract_content_hash,
      contract.source as contract_source,
      contract.effective_at as contract_effective_at,
      recipient.status as canonical_recipient_status,
      recipient.requirements as recipient_requirements,
      recipient.profile_version_synced,
      recipient.recipient_version,
      exists (
        select 1
        from public.terms_acceptances as acceptance
        where acceptance.user_id = profile.id
          and acceptance.terms_version_id = contract.id
          and acceptance.accepted_content_hash = contract.content_hash
      ) as current_contract_acceptance_exists
    from public.profiles as profile
    cross join current_contract as contract
    left join public.owner_profiles as owner
      on owner.user_id = profile.id
    left join public.owner_payment_recipients as recipient
      on recipient.owner_user_id = owner.user_id
    where profile.id = (select auth.uid())
  ),
  projected as (
    select
      source_state.*,
      case
        when source_state.profile_status <> 'active'
          or source_state.canonical_owner_status = 'blocked'
          then 'blocked'
        when source_state.canonical_owner_status is null
          then 'inactive'
        else 'active'
      end as projected_owner_status,
      coalesce(source_state.canonical_recipient_status, 'not_started')
        as projected_recipient_status,
      (
        source_state.accepted_owner_contract_version_id = source_state.contract_id
        and source_state.current_contract_acceptance_exists
      ) as projected_contract_accepted
    from source_state
  )
  select
    projected.user_id,
    projected.projected_owner_status,
    coalesce(projected.owner_version, 0::bigint),
    projected.accepted_owner_contract_version_id,
    projected.projected_contract_accepted,
    projected.contract_id,
    projected.contract_kind,
    projected.contract_version,
    projected.contract_title,
    projected.contract_body_markdown,
    projected.contract_content_hash,
    projected.contract_source,
    projected.contract_effective_at,
    projected.projected_recipient_status,
    coalesce(projected.recipient_requirements, '{}'::text[]),
    case
      when projected.projected_owner_status = 'blocked'
        or projected.projected_recipient_status = 'blocked'
        then 'none'
      when projected.projected_owner_status = 'inactive'
        or not projected.projected_contract_accepted
        then 'activate_owner'
      when projected.projected_recipient_status in ('not_started', 'refused')
        then 'start_onboarding'
      when projected.projected_recipient_status in ('pending', 'suspended')
        or (
          projected.projected_recipient_status = 'active'
          and projected.profile_version_synced is distinct from projected.profile_version
        )
        then 'refresh_status'
      else 'none'
    end,
    projected.profile_version,
    projected.profile_version_synced,
    coalesce(projected.recipient_version, 0::bigint),
    (
      projected.projected_owner_status = 'active'
      and projected.projected_contract_accepted
      and projected.projected_recipient_status = 'active'
      and projected.profile_version_synced = projected.profile_version
    ),
    'local'::text
  from projected;
$$;


ALTER FUNCTION "public"."get_owner_activation_status"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_owner_activation_status"() IS 'Activation-only authenticated projection with the complete current owner contract.';



CREATE OR REPLACE FUNCTION "public"."get_owner_recipient_status"() RETURNS TABLE("scope" "uuid", "owner_status" "text", "owner_version" bigint, "accepted_owner_contract_version_id" "uuid", "owner_contract_accepted" boolean, "owner_contract_id" "uuid", "owner_contract_source" "text", "owner_contract_effective_at" timestamp with time zone, "recipient_status" "text", "requirements" "text"[], "next_action" "text", "profile_version" bigint, "profile_version_synced" bigint, "recipient_version" bigint, "reservations_eligible" boolean, "provider_mode" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  with current_contract as (
    select
      legal_version.id,
      legal_version.content_hash,
      legal_version.source,
      legal_version.effective_at
    from public.terms_versions as legal_version
    where legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.now()
      and (
        legal_version.retired_at is null
        or pg_catalog.now() < legal_version.retired_at
      )
  ),
  source_state as (
    select
      profile.id as user_id,
      profile.profile_version,
      profile.status as profile_status,
      owner.status as canonical_owner_status,
      owner.owner_version,
      owner.accepted_owner_contract_version_id,
      contract.id as contract_id,
      contract.source as contract_source,
      contract.effective_at as contract_effective_at,
      recipient.status as canonical_recipient_status,
      recipient.requirements as recipient_requirements,
      recipient.profile_version_synced,
      recipient.recipient_version,
      exists (
        select 1
        from public.terms_acceptances as acceptance
        where acceptance.user_id = profile.id
          and acceptance.terms_version_id = contract.id
          and acceptance.accepted_content_hash = contract.content_hash
      ) as current_contract_acceptance_exists
    from public.profiles as profile
    cross join current_contract as contract
    left join public.owner_profiles as owner
      on owner.user_id = profile.id
    left join public.owner_payment_recipients as recipient
      on recipient.owner_user_id = owner.user_id
    where profile.id = (select auth.uid())
  ),
  projected as (
    select
      source_state.*,
      case
        when source_state.profile_status <> 'active'
          or source_state.canonical_owner_status = 'blocked'
          then 'blocked'
        when source_state.canonical_owner_status is null
          then 'inactive'
        else 'active'
      end as projected_owner_status,
      coalesce(source_state.canonical_recipient_status, 'not_started')
        as projected_recipient_status,
      (
        source_state.accepted_owner_contract_version_id = source_state.contract_id
        and source_state.current_contract_acceptance_exists
      ) as projected_contract_accepted
    from source_state
  )
  select
    projected.user_id,
    projected.projected_owner_status,
    coalesce(projected.owner_version, 0::bigint),
    projected.accepted_owner_contract_version_id,
    projected.projected_contract_accepted,
    projected.contract_id,
    projected.contract_source,
    projected.contract_effective_at,
    projected.projected_recipient_status,
    coalesce(projected.recipient_requirements, '{}'::text[]),
    case
      when projected.projected_owner_status = 'blocked'
        or projected.projected_recipient_status = 'blocked'
        then 'none'
      when projected.projected_owner_status = 'inactive'
        or not projected.projected_contract_accepted
        then 'activate_owner'
      when projected.projected_recipient_status in ('not_started', 'refused')
        then 'start_onboarding'
      when projected.projected_recipient_status in ('pending', 'suspended')
        or (
          projected.projected_recipient_status = 'active'
          and projected.profile_version_synced is distinct from projected.profile_version
        )
        then 'refresh_status'
      else 'none'
    end,
    projected.profile_version,
    projected.profile_version_synced,
    coalesce(projected.recipient_version, 0::bigint),
    (
      projected.projected_owner_status = 'active'
      and projected.projected_contract_accepted
      and projected.projected_recipient_status = 'active'
      and projected.profile_version_synced = projected.profile_version
    ),
    'local'::text
  from projected;
$$;


ALTER FUNCTION "public"."get_owner_recipient_status"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_owner_recipient_status"() IS 'Compact authenticated recipient projection; never returns owner contract title, version, hash or Markdown body.';



CREATE OR REPLACE FUNCTION "public"."get_owner_studio_editor"("p_studio_id" "uuid") RETURNS TABLE("scope" "uuid", "studio_id" "uuid", "studio_status" "text", "published_revision_id" "uuid", "draft_revision_id" "uuid", "has_draft" boolean, "revision_id" "uuid", "revision_status" "text", "revision_number" bigint, "revision_version" bigint, "name" "text", "description" "text", "street" "text", "street_number" "text", "address_complement" "text", "neighborhood" "text", "city" "text", "state" "text", "postal_code" "text", "capacity" integer, "studio_type_id" "uuid", "studio_type_name" "text", "usage_rules" "text", "youtube_video_id" "text", "tags" "jsonb", "amenities" "jsonb", "faqs" "jsonb")
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
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
    and studio.owner_user_id = (select auth.uid())
    and exists (
      select 1
      from public.profiles as profile
      join public.owner_profiles as owner on owner.user_id = profile.id
      join public.terms_versions as legal_version
        on legal_version.id = owner.accepted_owner_contract_version_id
      join public.terms_acceptances as acceptance
        on acceptance.user_id = owner.user_id
        and acceptance.terms_version_id = legal_version.id
        and acceptance.accepted_content_hash = legal_version.content_hash
      where profile.id = studio.owner_user_id
        and profile.status = 'active'
        and profile.completed_at is not null
        and owner.status = 'active'
        and legal_version.kind = 'owner_contract'
        and legal_version.effective_at <= pg_catalog.now()
        and (
          legal_version.retired_at is null
          or pg_catalog.now() < legal_version.retired_at
        )
    );
$$;


ALTER FUNCTION "public"."get_owner_studio_editor"("p_studio_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_owner_studio_editor"("p_studio_id" "uuid") IS 'Editor privado limitado ao auth.uid elegível, com perfil completo, dono ativo e contrato vigente aceito.';



CREATE OR REPLACE FUNCTION "public"."list_active_studio_taxonomies"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "public"."list_active_studio_taxonomies"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."list_active_studio_taxonomies"() IS 'Read model autenticado e ordenado das tags e comodidades ativas.';



CREATE OR REPLACE FUNCTION "public"."list_active_studio_types"() RETURNS TABLE("id" "uuid", "name" "text", "sort_order" smallint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select studio_type.id, studio_type.name, studio_type.sort_order
  from public.studio_types as studio_type
  where studio_type.active
  order by studio_type.sort_order, studio_type.name, studio_type.id;
$$;


ALTER FUNCTION "public"."list_active_studio_types"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."list_active_studio_types"() IS 'Read model autenticado e ordenado da taxonomia ativa exigida pelo editor.';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "audit"."events" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor_user_id" "uuid",
    "actor_role" "text" NOT NULL,
    "action" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "result" "text" NOT NULL,
    "request_id" "uuid" NOT NULL,
    "ip_hash" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "idempotency_key" "uuid" NOT NULL,
    CONSTRAINT "events_action_check" CHECK (("action" = ANY (ARRAY['owner.activated'::"text", 'owner.contract_renewed'::"text", 'recipient.status_transitioned'::"text", 'studio.created'::"text", 'studio.revision_updated'::"text", 'studio.revision_taxonomy_updated'::"text", 'studio.revision_content_updated'::"text", 'studio.draft_discarded'::"text", 'studio.media_upload_prepared'::"text", 'studio.media_upload_rejected'::"text", 'studio.media_upload_finalized'::"text", 'studio.media_reordered'::"text", 'studio.media_cover_set'::"text", 'studio.media_deleted'::"text", 'studio.revision_submitted'::"text", 'studio.paused'::"text", 'studio.resumed'::"text", 'backoffice.admin_bootstrapped'::"text", 'backoffice.user_suspended'::"text", 'backoffice.user_restored'::"text", 'backoffice.user_pii_revealed'::"text", 'backoffice.role_granted'::"text", 'backoffice.role_revoked'::"text", 'backoffice.taxonomy_created'::"text", 'backoffice.taxonomy_updated'::"text", 'backoffice.taxonomy_archived'::"text", 'backoffice.taxonomy_reactivated'::"text", 'backoffice.studio_approved'::"text", 'backoffice.studio_rejected'::"text", 'backoffice.studio_disabled'::"text", 'backoffice.studio_restored'::"text"]))),
    CONSTRAINT "events_actor_role_check" CHECK (("actor_role" = ANY (ARRAY['authenticated'::"text", 'support'::"text", 'reviewer'::"text", 'admin'::"text", 'system'::"text"]))),
    CONSTRAINT "events_ip_hash_check" CHECK ((("ip_hash" IS NULL) OR ("ip_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "events_metadata_check" CHECK (("jsonb_typeof"("metadata") = 'object'::"text")),
    CONSTRAINT "events_result_check" CHECK (("result" = 'succeeded'::"text")),
    CONSTRAINT "events_target_type_check" CHECK (("target_type" = ANY (ARRAY['owner_profile'::"text", 'owner_payment_recipient'::"text", 'studio'::"text", 'profile'::"text", 'platform_role'::"text", 'studio_type'::"text", 'tag'::"text", 'amenity'::"text"])))
);


ALTER TABLE "audit"."events" OWNER TO "postgres";


COMMENT ON TABLE "audit"."events" IS 'Eventos operacionais append-only; referências externas e PII são proibidas em metadata.';



COMMENT ON COLUMN "audit"."events"."request_id" IS 'Correlação com o requestId seguro da API e dos logs; não é chave de idempotência.';



COMMENT ON COLUMN "audit"."events"."idempotency_key" IS 'Chave de deduplicação do comando, separada da correlação request_id.';



CREATE TABLE IF NOT EXISTS "private"."backoffice_command_requests" (
    "actor_user_id" "uuid" NOT NULL,
    "idempotency_key" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "payload_hash" "text" NOT NULL,
    "result_hash" "text",
    "target_type" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "result_profile_version" bigint,
    "result_auth_updated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "backoffice_command_requests_action_check" CHECK (("action" = ANY (ARRAY['backoffice.user.restore'::"text", 'backoffice.user.suspend'::"text", 'backoffice.user.revealPii'::"text", 'backoffice.access.grantAdmin'::"text", 'backoffice.access.grantReviewer'::"text", 'backoffice.access.grantSupport'::"text", 'backoffice.access.revokeAdmin'::"text", 'backoffice.access.revokeReviewer'::"text", 'backoffice.access.revokeSupport'::"text", 'backoffice.taxonomy.upsert'::"text", 'backoffice.taxonomy.setActive'::"text", 'backoffice.taxonomy.archive'::"text", 'backoffice.taxonomy.reactivate'::"text", 'backoffice.studio.approve'::"text", 'backoffice.studio.reject'::"text", 'backoffice.studio.disable'::"text", 'backoffice.studio.restore'::"text"]))),
    CONSTRAINT "backoffice_command_requests_payload_hash_check" CHECK (("payload_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "backoffice_command_requests_result_hash_check" CHECK ((("result_hash" IS NULL) OR ("result_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "backoffice_command_requests_result_shape_check" CHECK (((("action" = 'backoffice.user.revealPii'::"text") AND ("result_hash" IS NULL) AND ("result_profile_version" IS NOT NULL) AND ("result_auth_updated_at" IS NOT NULL)) OR (("action" <> 'backoffice.user.revealPii'::"text") AND ("result_hash" IS NOT NULL) AND ("result_profile_version" IS NULL) AND ("result_auth_updated_at" IS NULL)))),
    CONSTRAINT "backoffice_command_requests_target_type_check" CHECK (("target_type" = ANY (ARRAY['profile'::"text", 'platform_role'::"text", 'studio_type'::"text", 'tag'::"text", 'amenity'::"text", 'studio'::"text"])))
);


ALTER TABLE "private"."backoffice_command_requests" OWNER TO "postgres";


COMMENT ON TABLE "private"."backoffice_command_requests" IS 'Ledger mínimo dos comandos administrativos; PII nunca é persistida nem recebe hash reutilizável.';



CREATE TABLE IF NOT EXISTS "private"."backoffice_sessions" (
    "auth_session_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "opened_at" timestamp with time zone NOT NULL,
    "last_seen_at" timestamp with time zone NOT NULL,
    "absolute_expires_at" timestamp with time zone NOT NULL,
    "closed_at" timestamp with time zone,
    CONSTRAINT "backoffice_sessions_window_check" CHECK ((("last_seen_at" >= "opened_at") AND ("absolute_expires_at" > "opened_at") AND (("closed_at" IS NULL) OR ("closed_at" >= "last_seen_at"))))
);


ALTER TABLE "private"."backoffice_sessions" OWNER TO "postgres";


COMMENT ON TABLE "private"."backoffice_sessions" IS 'Binding curta do backoffice para uma sessão Auth canônica; expira por 30 minutos de inatividade ou oito horas absolutas.';



CREATE TABLE IF NOT EXISTS "private"."dal_routine_allowlist" (
    "signature" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dal_routine_allowlist_signature_check" CHECK ((("signature" = "btrim"("signature")) AND ("signature" ~ '^private\.[a-z0-9_]+\([^)]*\)$'::"text")))
);


ALTER TABLE "private"."dal_routine_allowlist" OWNER TO "postgres";


COMMENT ON TABLE "private"."dal_routine_allowlist" IS 'Allowlist canônica de rotinas privadas executáveis pelo app_dal; somente migrations podem alterá-la.';



CREATE TABLE IF NOT EXISTS "private"."identity_recovery_grants" (
    "token" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "issued_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "claim_attempt_id" "uuid",
    "claimed_at" timestamp with time zone,
    "auth_session_id" "uuid" NOT NULL,
    CONSTRAINT "identity_recovery_grants_claim_pair_check" CHECK (((("claim_attempt_id" IS NULL) AND ("claimed_at" IS NULL)) OR (("claim_attempt_id" IS NOT NULL) AND ("claimed_at" IS NOT NULL) AND ("claimed_at" >= "issued_at") AND ("claimed_at" < "expires_at")))),
    CONSTRAINT "identity_recovery_grants_expiry_check" CHECK ((("expires_at" > "issued_at") AND ("expires_at" <= ("issued_at" + '00:15:00'::interval))))
);


ALTER TABLE "private"."identity_recovery_grants" OWNER TO "postgres";


COMMENT ON TABLE "private"."identity_recovery_grants" IS 'Grant opaco de recuperação, válido por até 15 minutos e removido após consumo.';



COMMENT ON COLUMN "private"."identity_recovery_grants"."claim_attempt_id" IS 'Reserva exclusiva e idempotente da tentativa que pode chamar o provedor Auth.';



COMMENT ON COLUMN "private"."identity_recovery_grants"."auth_session_id" IS 'Sessão Auth assinada que originou o recovery; o grant nunca existe sem sua binding.';



CREATE TABLE IF NOT EXISTS "private"."identity_recovery_sessions" (
    "auth_session_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "session_scope" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "bound_at" timestamp with time zone NOT NULL,
    "auth_expires_at" timestamp with time zone NOT NULL,
    "retain_until" timestamp with time zone NOT NULL,
    "canonical_absence_observed_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    CONSTRAINT "identity_recovery_sessions_absence_check" CHECK ((("canonical_absence_observed_at" IS NULL) OR ("canonical_absence_observed_at" >= "bound_at"))),
    CONSTRAINT "identity_recovery_sessions_closed_check" CHECK ((("closed_at" IS NULL) OR ("closed_at" >= "bound_at"))),
    CONSTRAINT "identity_recovery_sessions_expiry_check" CHECK ((("auth_expires_at" > "bound_at") AND ("retain_until" = ("auth_expires_at" + '00:05:00'::interval))))
);


ALTER TABLE "private"."identity_recovery_sessions" OWNER TO "postgres";


COMMENT ON TABLE "private"."identity_recovery_sessions" IS 'Binding/tombstone de recovery por session_id Auth; sobrevive ao grant e só purga após ausência canônica e expiração do último JWT.';



COMMENT ON COLUMN "private"."identity_recovery_sessions"."session_scope" IS 'Escopo opaco não autoritativo usado apenas para isolar estado de interface.';



COMMENT ON COLUMN "private"."identity_recovery_sessions"."retain_until" IS 'Última expiração JWT observada acrescida de cinco minutos; nunca autoriza purge sem ausência em auth.sessions.';



COMMENT ON COLUMN "private"."identity_recovery_sessions"."canonical_absence_observed_at" IS 'Primeira ausência em auth.sessions; inicia nova retenção pelo JWT pinado de 3600 segundos mais cinco minutos antes de qualquer purge.';



CREATE TABLE IF NOT EXISTS "private"."owner_activation_requests" (
    "owner_user_id" "uuid" NOT NULL,
    "idempotency_key" "uuid" NOT NULL,
    "owner_contract_version_id" "uuid" NOT NULL,
    "resulting_owner_version" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "owner_activation_requests_resulting_owner_version_check" CHECK (("resulting_owner_version" >= 1))
);


ALTER TABLE "private"."owner_activation_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."owner_recipient_operations" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "idempotency_key" "uuid" NOT NULL,
    "operation_sequence" bigint NOT NULL,
    "profile_version" bigint NOT NULL,
    "provider" "text",
    "provider_reference" "text",
    "result_status" "text",
    "result_requirements" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "applied_at" timestamp with time zone,
    CONSTRAINT "owner_recipient_operations_action_check" CHECK (("action" = ANY (ARRAY['start'::"text", 'refresh'::"text"]))),
    CONSTRAINT "owner_recipient_operations_operation_sequence_check" CHECK (("operation_sequence" >= 1)),
    CONSTRAINT "owner_recipient_operations_profile_version_check" CHECK (("profile_version" >= 0)),
    CONSTRAINT "owner_recipient_operations_provider_check" CHECK ((("provider" IS NULL) OR ("provider" = 'local'::"text"))),
    CONSTRAINT "owner_recipient_operations_provider_reference_check" CHECK ((("provider_reference" IS NULL) OR (("char_length"("provider_reference") >= 1) AND ("char_length"("provider_reference") <= 200) AND ("provider_reference" !~ '[[:cntrl:]]'::"text") AND (("provider_reference" ~ '^local-recipient:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::"text") OR ("provider_reference" = ANY (ARRAY['local-test-fixture:refused'::"text", 'local-test-fixture:suspended'::"text", 'local-test-fixture:blocked'::"text", 'local-test-fixture:unavailable'::"text", 'local-test-fixture:timeout'::"text"])))))),
    CONSTRAINT "owner_recipient_operations_result_pair_check" CHECK (((("applied_at" IS NULL) AND ("provider" IS NULL) AND ("result_status" IS NULL) AND ("result_requirements" IS NULL)) OR (("applied_at" IS NOT NULL) AND ("applied_at" >= "created_at") AND ("provider" = 'local'::"text") AND ("provider_reference" IS NOT NULL) AND ("result_status" IS NOT NULL) AND ("result_requirements" IS NOT NULL)))),
    CONSTRAINT "owner_recipient_operations_result_requirements_check" CHECK ((("result_requirements" IS NULL) OR (("cardinality"("result_requirements") <= 3) AND ("array_position"("result_requirements", NULL::"text") IS NULL) AND ("result_requirements" <@ ARRAY['identity_review'::"text", 'additional_information'::"text", 'provider_contact'::"text"]) AND (("cardinality"("result_requirements") < 2) OR ("result_requirements"[1] <> "result_requirements"[2])) AND (("cardinality"("result_requirements") < 3) OR (("result_requirements"[1] <> "result_requirements"[3]) AND ("result_requirements"[2] <> "result_requirements"[3])))))),
    CONSTRAINT "owner_recipient_operations_result_status_check" CHECK ((("result_status" IS NULL) OR ("result_status" = ANY (ARRAY['pending'::"text", 'active'::"text", 'refused'::"text", 'suspended'::"text", 'blocked'::"text"]))))
);


ALTER TABLE "private"."owner_recipient_operations" OWNER TO "postgres";


COMMENT ON TABLE "private"."owner_recipient_operations" IS 'Prepare/apply idempotente e privado; contém a única referência local do provider nesta fatia.';



CREATE TABLE IF NOT EXISTS "private"."signup_legal_intents" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "terms_version_id" "uuid" NOT NULL,
    "privacy_version_id" "uuid" NOT NULL,
    "person_type" "text" NOT NULL,
    "request_id" "uuid" NOT NULL,
    "ip_hash" "text",
    "user_agent_hash" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "signup_legal_intents_check" CHECK (("terms_version_id" <> "privacy_version_id")),
    CONSTRAINT "signup_legal_intents_check1" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "signup_legal_intents_check2" CHECK (("expires_at" <= ("created_at" + '00:15:00'::interval))),
    CONSTRAINT "signup_legal_intents_ip_hash_check" CHECK ((("ip_hash" IS NULL) OR ("ip_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "signup_legal_intents_person_type_check" CHECK (("person_type" = ANY (ARRAY['individual'::"text", 'company'::"text"]))),
    CONSTRAINT "signup_legal_intents_user_agent_hash_check" CHECK ((("user_agent_hash" IS NULL) OR ("user_agent_hash" ~ '^[0-9a-f]{64}$'::"text")))
);


ALTER TABLE "private"."signup_legal_intents" OWNER TO "postgres";


COMMENT ON TABLE "private"."signup_legal_intents" IS 'Token aleatório e temporário removido atomicamente ao ser consumido ou após expirar.';



CREATE TABLE IF NOT EXISTS "private"."studio_command_requests" (
    "owner_user_id" "uuid" NOT NULL,
    "idempotency_key" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "payload_hash" "text" NOT NULL,
    "result_hash" "text" NOT NULL,
    "studio_id" "uuid" NOT NULL,
    "resulting_revision_id" "uuid",
    "resulting_revision_version" bigint,
    "studio_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resulting_media_id" "uuid",
    "result_payload" "jsonb",
    CONSTRAINT "studio_command_requests_action_check" CHECK (("action" = ANY (ARRAY['studio.create'::"text", 'studio.revision.updateCore'::"text", 'studio.revision.updateTaxonomy'::"text", 'studio.revision.updateContent'::"text", 'studio.draft.discard'::"text", 'studio.media.prepare'::"text", 'studio.media.finalize'::"text", 'studio.media.reorder'::"text", 'studio.media.cover.set'::"text", 'studio.media.delete'::"text", 'studio.revision.submit'::"text", 'studio.pause'::"text", 'studio.resume'::"text"]))),
    CONSTRAINT "studio_command_requests_media_result_check" CHECK (((("action" ~~ 'studio.media.%'::"text") AND ("jsonb_typeof"("result_payload") = 'object'::"text") AND ("result_hash" = "private"."studio_result_hash"("result_payload"))) OR (("action" !~~ 'studio.media.%'::"text") AND ("result_payload" IS NULL)))),
    CONSTRAINT "studio_command_requests_media_target_check" CHECK (((("action" = ANY (ARRAY['studio.media.prepare'::"text", 'studio.media.finalize'::"text", 'studio.media.cover.set'::"text", 'studio.media.delete'::"text"])) AND ("resulting_media_id" IS NOT NULL)) OR (("action" <> ALL (ARRAY['studio.media.prepare'::"text", 'studio.media.finalize'::"text", 'studio.media.cover.set'::"text", 'studio.media.delete'::"text"])) AND ("resulting_media_id" IS NULL)))),
    CONSTRAINT "studio_command_requests_payload_hash_check" CHECK (("payload_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "studio_command_requests_result_check" CHECK (((("action" = 'studio.draft.discard'::"text") AND (("studio_deleted" AND ("resulting_revision_id" IS NULL) AND ("resulting_revision_version" IS NULL)) OR ((NOT "studio_deleted") AND ("resulting_revision_id" IS NOT NULL) AND ("resulting_revision_version" IS NOT NULL)))) OR (("action" <> 'studio.draft.discard'::"text") AND (NOT "studio_deleted") AND ("resulting_revision_id" IS NOT NULL) AND ("resulting_revision_version" IS NOT NULL)))),
    CONSTRAINT "studio_command_requests_result_hash_check" CHECK (("result_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "studio_command_requests_revision_version_check" CHECK ((("resulting_revision_version" IS NULL) OR ("resulting_revision_version" >= 1)))
);


ALTER TABLE "private"."studio_command_requests" OWNER TO "postgres";


COMMENT ON TABLE "private"."studio_command_requests" IS 'Ledger mínimo de idempotência dos comandos de estúdio; hashes verificam payload e resultado sem replicar conteúdo nem endereço.';



CREATE TABLE IF NOT EXISTS "private"."studio_deletion_fences" (
    "studio_id" "uuid" NOT NULL,
    "transaction_id" "xid8" NOT NULL,
    "backend_pid" integer NOT NULL,
    CONSTRAINT "studio_deletion_fences_backend_pid_check" CHECK (("backend_pid" > 0))
);


ALTER TABLE "private"."studio_deletion_fences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."studio_media_finalize_claims" (
    "owner_user_id" "uuid" NOT NULL,
    "idempotency_key" "uuid" NOT NULL,
    "payload_hash" "text" NOT NULL,
    "studio_id" "uuid" NOT NULL,
    "expected_revision_id" "uuid" NOT NULL,
    "expected_revision_version" bigint NOT NULL,
    "media_id" "uuid" NOT NULL,
    "latest_request_id" "uuid" NOT NULL,
    "lease_token" "uuid",
    "lease_claimed_at" timestamp with time zone,
    "lease_expires_at" timestamp with time zone,
    "terminal_state" "text",
    "terminal_rejection_code" "text",
    "terminal_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "studio_media_finalize_claims_lease_check" CHECK (((("lease_token" IS NULL) AND ("lease_claimed_at" IS NULL) AND ("lease_expires_at" IS NULL)) OR (("lease_token" IS NOT NULL) AND ("lease_claimed_at" IS NOT NULL) AND ("lease_expires_at" IS NOT NULL) AND ("lease_expires_at" > "lease_claimed_at")))),
    CONSTRAINT "studio_media_finalize_claims_payload_hash_check" CHECK (("payload_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "studio_media_finalize_claims_revision_version_check" CHECK (("expected_revision_version" >= 1)),
    CONSTRAINT "studio_media_finalize_claims_terminal_check" CHECK (((("terminal_state" IS NULL) AND ("terminal_rejection_code" IS NULL) AND ("terminal_at" IS NULL)) OR (("terminal_state" = 'finalized'::"text") AND ("terminal_rejection_code" IS NULL) AND ("terminal_at" IS NOT NULL)) OR (("terminal_state" = 'rejected'::"text") AND ("terminal_rejection_code" = ANY (ARRAY['object_missing'::"text", 'superseded'::"text", 'validation_failed'::"text"])) AND ("terminal_at" IS NOT NULL))))
);


ALTER TABLE "private"."studio_media_finalize_claims" OWNER TO "postgres";


COMMENT ON TABLE "private"."studio_media_finalize_claims" IS 'Identidade e tombstone persistentes da finalização de mídia, com lease curta embutida e cercada por token; não referencia studio/media mutáveis para sobreviver ao cleanup.';



CREATE TABLE IF NOT EXISTS "private"."studio_review_transition_fences" (
    "revision_id" "uuid" NOT NULL,
    "studio_id" "uuid" NOT NULL,
    "target_status" "text" NOT NULL,
    "transaction_id" "xid8" NOT NULL,
    "backend_pid" integer NOT NULL,
    CONSTRAINT "studio_review_transition_fences_backend_pid_check" CHECK (("backend_pid" > 0)),
    CONSTRAINT "studio_review_transition_fences_target_status_check" CHECK (("target_status" = ANY (ARRAY['approved'::"text", 'rejected'::"text", 'superseded'::"text"])))
);


ALTER TABLE "private"."studio_review_transition_fences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."amenities" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "sort_order" smallint DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "taxonomy_version" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "amenities_name_check" CHECK ((("name" = "btrim"("name")) AND (("char_length"("name") >= 2) AND ("char_length"("name") <= 80)))),
    CONSTRAINT "amenities_slug_check" CHECK ((("slug" = "btrim"("slug")) AND ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::"text") AND (("char_length"("slug") >= 2) AND ("char_length"("slug") <= 80)))),
    CONSTRAINT "amenities_sort_order_check" CHECK (("sort_order" >= 0)),
    CONSTRAINT "amenities_taxonomy_version_check" CHECK (("taxonomy_version" >= 0)),
    CONSTRAINT "amenities_timestamps_check" CHECK (("updated_at" >= "created_at"))
);


ALTER TABLE "public"."amenities" OWNER TO "postgres";


COMMENT ON TABLE "public"."amenities" IS 'Taxonomia administrada de comodidades; somente itens ativos entram em novas drafts.';



COMMENT ON COLUMN "public"."amenities"."taxonomy_version" IS 'Versão otimista das alterações administrativas da taxonomia.';



CREATE TABLE IF NOT EXISTS "public"."email_outbox" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "template_key" "text" NOT NULL,
    "audience_key" "text" NOT NULL,
    "studio_id" "uuid" NOT NULL,
    "revision_id" "uuid" NOT NULL,
    "deduplication_key" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "email_outbox_audience_key_check" CHECK (("audience_key" = ANY (ARRAY['studio_reviewers'::"text", 'studio_owner'::"text"]))),
    CONSTRAINT "email_outbox_deduplication_key_check" CHECK ((("deduplication_key" = "btrim"("deduplication_key")) AND (("char_length"("deduplication_key") >= 20) AND ("char_length"("deduplication_key") <= 160)))),
    CONSTRAINT "email_outbox_status_check" CHECK (("status" = 'pending'::"text")),
    CONSTRAINT "email_outbox_template_key_check" CHECK (("template_key" = ANY (ARRAY['studio.review.submitted'::"text", 'studio.review.approved'::"text", 'studio.review.rejected'::"text"])))
);


ALTER TABLE "public"."email_outbox" OWNER TO "postgres";


COMMENT ON TABLE "public"."email_outbox" IS 'Intenções transacionais deduplicadas; FEAT-029 acrescenta worker, tentativas e entrega real.';



CREATE TABLE IF NOT EXISTS "public"."owner_payment_recipients" (
    "owner_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "requirements" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "profile_version_synced" bigint,
    "recipient_version" bigint DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "owner_payment_recipients_active_requirements_check" CHECK ((("status" <> 'active'::"text") OR ("requirements" = '{}'::"text"[]))),
    CONSTRAINT "owner_payment_recipients_check" CHECK (("updated_at" >= "created_at")),
    CONSTRAINT "owner_payment_recipients_profile_version_synced_check" CHECK ((("profile_version_synced" IS NULL) OR ("profile_version_synced" >= 0))),
    CONSTRAINT "owner_payment_recipients_recipient_version_check" CHECK (("recipient_version" >= 0)),
    CONSTRAINT "owner_payment_recipients_requirements_check" CHECK ((("cardinality"("requirements") <= 3) AND ("array_position"("requirements", NULL::"text") IS NULL) AND ("requirements" <@ ARRAY['identity_review'::"text", 'additional_information'::"text", 'provider_contact'::"text"]) AND (("cardinality"("requirements") < 2) OR ("requirements"[1] <> "requirements"[2])) AND (("cardinality"("requirements") < 3) OR (("requirements"[1] <> "requirements"[3]) AND ("requirements"[2] <> "requirements"[3]))))),
    CONSTRAINT "owner_payment_recipients_status_check" CHECK (("status" = ANY (ARRAY['not_started'::"text", 'pending'::"text", 'active'::"text", 'refused'::"text", 'suspended'::"text", 'blocked'::"text"])))
);


ALTER TABLE "public"."owner_payment_recipients" OWNER TO "postgres";


COMMENT ON TABLE "public"."owner_payment_recipients" IS 'Estado seguro e versionado do recebedor; nenhuma referência do provider existe nesta tabela.';



CREATE TABLE IF NOT EXISTS "public"."owner_profiles" (
    "user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "accepted_owner_contract_version_id" "uuid" NOT NULL,
    "owner_version" bigint DEFAULT 1 NOT NULL,
    "activated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "owner_profiles_check" CHECK (("activated_at" >= "created_at")),
    CONSTRAINT "owner_profiles_check1" CHECK (("updated_at" >= "created_at")),
    CONSTRAINT "owner_profiles_owner_version_check" CHECK (("owner_version" >= 1)),
    CONSTRAINT "owner_profiles_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'blocked'::"text"])))
);


ALTER TABLE "public"."owner_profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."owner_profiles" IS 'Autoridade mínima do dono; identidade e PII permanecem exclusivamente em profiles.';



COMMENT ON COLUMN "public"."owner_profiles"."accepted_owner_contract_version_id" IS 'Última versão de owner_contract aceita; o histórico imutável permanece em terms_acceptances.';



CREATE TABLE IF NOT EXISTS "public"."platform_roles" (
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "granted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "platform_roles_role_check" CHECK (("role" = ANY (ARRAY['support'::"text", 'reviewer'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."platform_roles" OWNER TO "postgres";


COMMENT ON TABLE "public"."platform_roles" IS 'Papéis cumulativos de backoffice: support, reviewer e admin; sem acesso direto de runtime.';



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "person_type" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "phone_e164" "text",
    "tax_id" "text",
    "additional_document" "text",
    "tax_id_masked" "text" GENERATED ALWAYS AS (
CASE
    WHEN ("tax_id" IS NULL) THEN NULL::"text"
    WHEN ("person_type" = 'individual'::"text") THEN ('***.***.***-'::"text" || "right"("tax_id", 2))
    ELSE ('**.***.***/****-'::"text" || "right"("tax_id", 2))
END) STORED,
    "additional_document_masked" "text" GENERATED ALWAYS AS (
CASE
    WHEN ("additional_document" IS NULL) THEN NULL::"text"
    ELSE ("repeat"('*'::"text", ("char_length"("additional_document") - 2)) || "right"("additional_document", 2))
END) STORED,
    "profile_version" bigint DEFAULT 0 NOT NULL,
    "account_version" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "profiles_account_version_check" CHECK (("account_version" >= 0)),
    CONSTRAINT "profiles_additional_document_shape_check" CHECK ((("additional_document" IS NULL) OR (("char_length"("additional_document") >= 3) AND ("char_length"("additional_document") <= 40) AND ("additional_document" ~ '^[A-Z0-9]+([./ -][A-Z0-9]+)*$'::"text")))),
    CONSTRAINT "profiles_check" CHECK ((("completed_at" IS NULL) OR ("completed_at" >= "created_at"))),
    CONSTRAINT "profiles_check1" CHECK (("updated_at" >= "created_at")),
    CONSTRAINT "profiles_completion_data_check" CHECK (((("completed_at" IS NULL) AND ("name" IS NULL) AND ("phone_e164" IS NULL) AND ("tax_id" IS NULL) AND ("additional_document" IS NULL)) OR (("completed_at" IS NOT NULL) AND ("name" IS NOT NULL) AND ("phone_e164" IS NOT NULL) AND ("tax_id" IS NOT NULL)))),
    CONSTRAINT "profiles_name_shape_check" CHECK ((("name" IS NULL) OR (("char_length"("name") >= 2) AND ("char_length"("name") <= 160) AND ("name" = "btrim"("name")) AND ("name" !~ '[[:cntrl:]]'::"text")))),
    CONSTRAINT "profiles_person_type_check" CHECK (("person_type" = ANY (ARRAY['individual'::"text", 'company'::"text"]))),
    CONSTRAINT "profiles_phone_e164_shape_check" CHECK ((("phone_e164" IS NULL) OR ("phone_e164" ~ '^\+55[1-9][0-9]([2-5][0-9]{7}|9[0-9]{8})$'::"text"))),
    CONSTRAINT "profiles_profile_version_check" CHECK (("profile_version" >= 0)),
    CONSTRAINT "profiles_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'suspended'::"text"]))),
    CONSTRAINT "profiles_tax_id_person_type_check" CHECK ((("tax_id" IS NULL) OR (("person_type" = 'individual'::"text") AND "private"."is_valid_cpf"("tax_id")) OR (("person_type" = 'company'::"text") AND "private"."is_valid_cnpj"("tax_id"))))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."profiles" IS 'Identidade mínima criada atomicamente com auth.users; FEAT-003 completa os dados pessoais.';



COMMENT ON COLUMN "public"."profiles"."completed_at" IS 'Permanece nulo até o comando de conclusão pertencente à FEAT-003.';



COMMENT ON COLUMN "public"."profiles"."name" IS 'Nome da pessoa ou razão social atual; obrigatório somente após a conclusão do perfil.';



COMMENT ON COLUMN "public"."profiles"."phone_e164" IS 'Telefone brasileiro canônico em E.164; validação estrutural não confirma titularidade.';



COMMENT ON COLUMN "public"."profiles"."tax_id" IS 'CPF ou CNPJ canônico atual; PII sem grant de leitura direta para roles runtime.';



COMMENT ON COLUMN "public"."profiles"."additional_document" IS 'Identificador textual opcional uppercase; tipo, emissor e titularidade não são inferidos.';



COMMENT ON COLUMN "public"."profiles"."tax_id_masked" IS 'Projeção derivada que revela somente os dois dígitos verificadores.';



COMMENT ON COLUMN "public"."profiles"."additional_document_masked" IS 'Projeção derivada que revela somente os dois últimos caracteres.';



COMMENT ON COLUMN "public"."profiles"."profile_version" IS 'Versão otimista monotônica da identidade, independente da aparência.';



COMMENT ON COLUMN "public"."profiles"."account_version" IS 'Versão otimista do estado operacional da conta: status e autorizações; não altera a versão da identidade nem a sincronização do recebedor.';



CREATE TABLE IF NOT EXISTS "public"."studio_faqs" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "revision_id" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "answer" "text" NOT NULL,
    "position" smallint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "studio_faqs_answer_check" CHECK ((("answer" = "btrim"("answer")) AND (("char_length"("answer") >= 1) AND ("char_length"("answer") <= 2000)))),
    CONSTRAINT "studio_faqs_position_check" CHECK ((("position" >= 1) AND ("position" <= 20))),
    CONSTRAINT "studio_faqs_question_check" CHECK ((("question" = "btrim"("question")) AND (("char_length"("question") >= 1) AND ("char_length"("question") <= 160)))),
    CONSTRAINT "studio_faqs_timestamps_check" CHECK (("updated_at" >= "created_at"))
);


ALTER TABLE "public"."studio_faqs" OWNER TO "postgres";


COMMENT ON TABLE "public"."studio_faqs" IS 'FAQ plain text, ordenada e pertencente integralmente a uma revisão de estúdio.';



CREATE TABLE IF NOT EXISTS "public"."studio_media" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "studio_id" "uuid",
    "prepared_revision_id" "uuid",
    "uploaded_by" "uuid" NOT NULL,
    "storage_bucket" "text" DEFAULT 'studio-media'::"text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "preview_storage_path" "text" NOT NULL,
    "declared_mime_type" "text" NOT NULL,
    "declared_size_bytes" bigint NOT NULL,
    "declared_checksum_sha256" "text",
    "actual_mime_type" "text",
    "actual_size_bytes" bigint,
    "width" integer,
    "height" integer,
    "checksum_sha256" "text",
    "status" "text" DEFAULT 'pending_upload'::"text" NOT NULL,
    "rejection_code" "text",
    "prepared_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "upload_expires_at" timestamp with time zone NOT NULL,
    "cleanup_after" timestamp with time zone,
    "finalized_at" timestamp with time zone,
    "rejected_at" timestamp with time zone,
    "delete_requested_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "cleanup_attempts" integer DEFAULT 0 NOT NULL,
    "cleanup_claim_token" "uuid",
    "cleanup_claimed_at" timestamp with time zone,
    "cleanup_next_attempt_at" timestamp with time zone,
    "cleanup_last_completed_token" "uuid",
    "cleanup_last_succeeded" boolean,
    "cleanup_last_error_code" "text",
    "updated_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "upload_token_issued_at" timestamp with time zone,
    CONSTRAINT "studio_media_actual_mime_check" CHECK ((("actual_mime_type" IS NULL) OR ("actual_mime_type" = ANY (ARRAY['image/jpeg'::"text", 'image/png'::"text", 'image/webp'::"text", 'image/avif'::"text"])))),
    CONSTRAINT "studio_media_actual_size_check" CHECK ((("actual_size_bytes" IS NULL) OR (("actual_size_bytes" >= 1) AND ("actual_size_bytes" <= 15728640)))),
    CONSTRAINT "studio_media_bucket_check" CHECK (("storage_bucket" = 'studio-media'::"text")),
    CONSTRAINT "studio_media_checksum_check" CHECK ((("checksum_sha256" IS NULL) OR ("checksum_sha256" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "studio_media_cleanup_attempts_check" CHECK (("cleanup_attempts" >= 0)),
    CONSTRAINT "studio_media_cleanup_claim_check" CHECK (((("cleanup_claim_token" IS NULL) AND ("cleanup_claimed_at" IS NULL)) OR (("status" = 'delete_pending'::"text") AND ("cleanup_claim_token" IS NOT NULL) AND ("cleanup_claimed_at" IS NOT NULL)))),
    CONSTRAINT "studio_media_cleanup_next_attempt_check" CHECK ((("cleanup_next_attempt_at" IS NULL) OR ("status" = 'delete_pending'::"text"))),
    CONSTRAINT "studio_media_cleanup_result_check" CHECK (((("cleanup_last_completed_token" IS NULL) AND ("cleanup_last_succeeded" IS NULL) AND ("cleanup_last_error_code" IS NULL)) OR (("cleanup_last_completed_token" IS NOT NULL) AND ("cleanup_last_succeeded" IS TRUE) AND ("cleanup_last_error_code" IS NULL) AND ("status" = 'deleted'::"text")) OR (("cleanup_last_completed_token" IS NOT NULL) AND ("cleanup_last_succeeded" IS FALSE) AND ("cleanup_last_error_code" ~ '^[a-z0-9_]{2,80}$'::"text") AND ("status" = 'delete_pending'::"text")))),
    CONSTRAINT "studio_media_declared_checksum_check" CHECK ((("declared_checksum_sha256" IS NULL) OR ("declared_checksum_sha256" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "studio_media_declared_mime_check" CHECK (("declared_mime_type" = ANY (ARRAY['image/jpeg'::"text", 'image/png'::"text", 'image/webp'::"text", 'image/avif'::"text"]))),
    CONSTRAINT "studio_media_declared_size_check" CHECK ((("declared_size_bytes" >= 1) AND ("declared_size_bytes" <= 15728640))),
    CONSTRAINT "studio_media_dimensions_check" CHECK (((("width" IS NULL) AND ("height" IS NULL)) OR ((("width" >= 1) AND ("width" <= 8192)) AND (("height" >= 1) AND ("height" <= 8192)) AND ((("width")::bigint * ("height")::bigint) <= 36000000)))),
    CONSTRAINT "studio_media_path_identity_check" CHECK ((("storage_path" = "btrim"("storage_path")) AND ("split_part"("storage_path", '/'::"text", 1) = 'owners'::"text") AND ("split_part"("storage_path", '/'::"text", 2) = ("uploaded_by")::"text") AND ("split_part"("storage_path", '/'::"text", 3) = 'studios'::"text") AND (("split_part"("storage_path", '/'::"text", 4) = ("studio_id")::"text") OR (("studio_id" IS NULL) AND ("status" = ANY (ARRAY['delete_pending'::"text", 'deleted'::"text"])) AND ("split_part"("storage_path", '/'::"text", 4) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::"text"))) AND ("split_part"("storage_path", '/'::"text", 5) = 'revisions'::"text") AND (("split_part"("storage_path", '/'::"text", 6) = ("prepared_revision_id")::"text") OR (("prepared_revision_id" IS NULL) AND ("status" = ANY (ARRAY['delete_pending'::"text", 'deleted'::"text"])) AND ("split_part"("storage_path", '/'::"text", 6) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::"text"))) AND ("split_part"("storage_path", '/'::"text", 7) = "format"('%s.%s'::"text", "id",
CASE "declared_mime_type"
    WHEN 'image/jpeg'::"text" THEN 'jpg'::"text"
    WHEN 'image/png'::"text" THEN 'png'::"text"
    WHEN 'image/webp'::"text" THEN 'webp'::"text"
    WHEN 'image/avif'::"text" THEN 'avif'::"text"
    ELSE NULL::"text"
END)) AND ("split_part"("storage_path", '/'::"text", 8) = ''::"text"))),
    CONSTRAINT "studio_media_preview_path_identity_check" CHECK ((("preview_storage_path" = "regexp_replace"("storage_path", '\.(avif|jpg|png|webp)$'::"text", '.preview.webp'::"text")) AND ("split_part"("preview_storage_path", '/'::"text", 7) = "format"('%s.preview.webp'::"text", "id")))),
    CONSTRAINT "studio_media_rejection_code_check" CHECK ((("rejection_code" IS NULL) OR ("rejection_code" = ANY (ARRAY['validation_failed'::"text", 'object_missing'::"text", 'superseded'::"text", 'upload_token_signing_failed'::"text", 'mime_mismatch'::"text", 'size_mismatch'::"text", 'checksum_mismatch'::"text", 'decode_failed'::"text", 'dimension_invalid'::"text"])))),
    CONSTRAINT "studio_media_state_coherence_check" CHECK (((("status" = 'pending_upload'::"text") AND ("studio_id" IS NOT NULL) AND ("prepared_revision_id" IS NOT NULL) AND ("actual_mime_type" IS NULL) AND ("actual_size_bytes" IS NULL) AND ("width" IS NULL) AND ("height" IS NULL) AND ("checksum_sha256" IS NULL) AND ("rejection_code" IS NULL) AND ("finalized_at" IS NULL) AND ("rejected_at" IS NULL) AND ("delete_requested_at" IS NULL) AND ("deleted_at" IS NULL) AND ("cleanup_after" >= ("prepared_at" + '24:00:00'::interval))) OR (("status" = 'ready'::"text") AND ("studio_id" IS NOT NULL) AND ("prepared_revision_id" IS NOT NULL) AND ("actual_mime_type" IS NOT NULL) AND ("actual_size_bytes" IS NOT NULL) AND ("width" IS NOT NULL) AND ("height" IS NOT NULL) AND ("checksum_sha256" IS NOT NULL) AND ("rejection_code" IS NULL) AND ("finalized_at" IS NOT NULL) AND ("rejected_at" IS NULL) AND ("delete_requested_at" IS NULL) AND ("deleted_at" IS NULL) AND ("cleanup_after" IS NULL)) OR (("status" = 'rejected'::"text") AND ("studio_id" IS NOT NULL) AND ("prepared_revision_id" IS NOT NULL) AND ("actual_mime_type" IS NULL) AND ("actual_size_bytes" IS NULL) AND ("width" IS NULL) AND ("height" IS NULL) AND ("checksum_sha256" IS NULL) AND ("rejection_code" IS NOT NULL) AND ("finalized_at" IS NULL) AND ("rejected_at" IS NOT NULL) AND ("delete_requested_at" IS NULL) AND ("deleted_at" IS NULL) AND ("cleanup_after" IS NOT NULL)) OR (("status" = 'delete_pending'::"text") AND ("delete_requested_at" IS NOT NULL) AND ("deleted_at" IS NULL) AND ("cleanup_after" IS NOT NULL)) OR (("status" = 'deleted'::"text") AND ("delete_requested_at" IS NOT NULL) AND ("deleted_at" IS NOT NULL) AND ("cleanup_after" IS NULL)))),
    CONSTRAINT "studio_media_status_check" CHECK (("status" = ANY (ARRAY['pending_upload'::"text", 'ready'::"text", 'rejected'::"text", 'delete_pending'::"text", 'deleted'::"text"]))),
    CONSTRAINT "studio_media_timestamps_check" CHECK ((("updated_at" >= "prepared_at") AND (("finalized_at" IS NULL) OR ("finalized_at" >= "prepared_at")) AND (("rejected_at" IS NULL) OR ("rejected_at" >= "prepared_at")) AND (("delete_requested_at" IS NULL) OR ("delete_requested_at" >= "prepared_at")) AND (("deleted_at" IS NULL) OR ("deleted_at" >= "delete_requested_at")))),
    CONSTRAINT "studio_media_upload_token_issued_at_check" CHECK ((("upload_token_issued_at" IS NULL) OR (("upload_token_issued_at" >= "prepared_at") AND ("upload_token_issued_at" <= "upload_expires_at")))),
    CONSTRAINT "studio_media_upload_token_rejection_coherence_check" CHECK ((("rejection_code" IS DISTINCT FROM 'upload_token_signing_failed'::"text") OR ("upload_token_issued_at" IS NULL))),
    CONSTRAINT "studio_media_upload_window_check" CHECK (("upload_expires_at" = ("prepared_at" + '02:00:00'::interval)))
);


ALTER TABLE "public"."studio_media" OWNER TO "postgres";


COMMENT ON TABLE "public"."studio_media" IS 'Objeto original e prévia WebP imutáveis no bucket privado; estado físico é independente das associações versionadas.';



COMMENT ON COLUMN "public"."studio_media"."upload_token_issued_at" IS 'Primeira autorização de upload confirmada pelo servidor; permanece nula quando nenhum token foi entregue.';



CREATE TABLE IF NOT EXISTS "public"."studio_review_events" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "event_sequence" bigint NOT NULL,
    "studio_id" "uuid" NOT NULL,
    "revision_id" "uuid" NOT NULL,
    "actor_user_id" "uuid",
    "event_type" "text" NOT NULL,
    "rejection_reason" "text",
    "occurred_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "studio_review_events_reason_check" CHECK (((("event_type" = 'rejected'::"text") AND ("rejection_reason" IS NOT NULL) AND ("rejection_reason" = "btrim"("rejection_reason")) AND (("char_length"("rejection_reason") >= 1) AND ("char_length"("rejection_reason") <= 2000))) OR (("event_type" <> 'rejected'::"text") AND ("rejection_reason" IS NULL)))),
    CONSTRAINT "studio_review_events_type_check" CHECK (("event_type" = ANY (ARRAY['submitted'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."studio_review_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."studio_review_events" IS 'Histórico editorial append-only; motivo de rejeição é dado de produto e não metadata de audit.';



COMMENT ON COLUMN "public"."studio_review_events"."event_sequence" IS 'Fence causal global e monotônica; define a ordem editorial sem depender do relógio ou de UUID.';



ALTER TABLE "public"."studio_review_events" ALTER COLUMN "event_sequence" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."studio_review_events_event_sequence_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."studio_revision_amenities" (
    "revision_id" "uuid" NOT NULL,
    "amenity_id" "uuid" NOT NULL
);


ALTER TABLE "public"."studio_revision_amenities" OWNER TO "postgres";


COMMENT ON TABLE "public"."studio_revision_amenities" IS 'Seleção versionada de comodidades da revisão; sem escrita direta de runtime.';



CREATE TABLE IF NOT EXISTS "public"."studio_revision_media" (
    "revision_id" "uuid" NOT NULL,
    "media_id" "uuid" NOT NULL,
    "position" smallint NOT NULL,
    "is_cover" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "studio_revision_media_position_check" CHECK ((("position" >= 1) AND ("position" <= 20)))
);


ALTER TABLE "public"."studio_revision_media" OWNER TO "postgres";


COMMENT ON TABLE "public"."studio_revision_media" IS 'Associação ordenada e versionada entre uma revisão e objetos prontos; publicada nunca é mutada.';



CREATE TABLE IF NOT EXISTS "public"."studio_revision_tags" (
    "revision_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL
);


ALTER TABLE "public"."studio_revision_tags" OWNER TO "postgres";


COMMENT ON TABLE "public"."studio_revision_tags" IS 'Seleção versionada de tags da revisão; sem escrita direta de runtime.';



CREATE TABLE IF NOT EXISTS "public"."studio_revisions" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "studio_id" "uuid" NOT NULL,
    "revision_number" bigint NOT NULL,
    "revision_version" bigint DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" NOT NULL,
    "street" "text" NOT NULL,
    "street_number" "text" NOT NULL,
    "address_complement" "text",
    "neighborhood" "text" NOT NULL,
    "city" "text" NOT NULL,
    "state" "text" NOT NULL,
    "postal_code" "text" NOT NULL,
    "capacity" integer NOT NULL,
    "studio_type_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "usage_rules" "text" DEFAULT ''::"text" NOT NULL,
    "youtube_video_id" "text",
    CONSTRAINT "studio_revisions_address_complement_check" CHECK ((("address_complement" IS NULL) OR (("address_complement" = "btrim"("address_complement")) AND (("char_length"("address_complement") >= 1) AND ("char_length"("address_complement") <= 120))))),
    CONSTRAINT "studio_revisions_capacity_check" CHECK ((("capacity" >= 1) AND ("capacity" <= 500))),
    CONSTRAINT "studio_revisions_city_check" CHECK (("city" = 'Curitiba'::"text")),
    CONSTRAINT "studio_revisions_description_check" CHECK ((("description" = "btrim"("description")) AND (("char_length"("description") >= 20) AND ("char_length"("description") <= 5000)))),
    CONSTRAINT "studio_revisions_name_check" CHECK ((("name" = "btrim"("name")) AND (("char_length"("name") >= 2) AND ("char_length"("name") <= 120)))),
    CONSTRAINT "studio_revisions_neighborhood_check" CHECK ((("neighborhood" = "btrim"("neighborhood")) AND (("char_length"("neighborhood") >= 2) AND ("char_length"("neighborhood") <= 120)))),
    CONSTRAINT "studio_revisions_number_check" CHECK (("revision_number" >= 1)),
    CONSTRAINT "studio_revisions_postal_code_check" CHECK (("postal_code" ~ '^[0-9]{8}$'::"text")),
    CONSTRAINT "studio_revisions_state_check" CHECK (("state" = 'PR'::"text")),
    CONSTRAINT "studio_revisions_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending'::"text", 'approved'::"text", 'rejected'::"text", 'superseded'::"text"]))),
    CONSTRAINT "studio_revisions_street_check" CHECK ((("street" = "btrim"("street")) AND (("char_length"("street") >= 2) AND ("char_length"("street") <= 160)))),
    CONSTRAINT "studio_revisions_street_number_check" CHECK ((("street_number" = "btrim"("street_number")) AND (("char_length"("street_number") >= 1) AND ("char_length"("street_number") <= 20)))),
    CONSTRAINT "studio_revisions_timestamps_check" CHECK (("updated_at" >= "created_at")),
    CONSTRAINT "studio_revisions_usage_rules_check" CHECK ((("usage_rules" = "btrim"("usage_rules")) AND ("char_length"("usage_rules") <= 5000))),
    CONSTRAINT "studio_revisions_version_check" CHECK (("revision_version" >= 1)),
    CONSTRAINT "studio_revisions_youtube_video_id_check" CHECK ((("youtube_video_id" IS NULL) OR ("youtube_video_id" ~ '^[A-Za-z0-9_-]{11}$'::"text")))
);


ALTER TABLE "public"."studio_revisions" OWNER TO "postgres";


COMMENT ON TABLE "public"."studio_revisions" IS 'Conteúdo central versionado do estúdio; somente a revisão draft pode ser alterada ou descartada.';



CREATE TABLE IF NOT EXISTS "public"."studio_types" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "sort_order" smallint DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "taxonomy_version" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "studio_types_name_check" CHECK ((("name" = "btrim"("name")) AND (("char_length"("name") >= 2) AND ("char_length"("name") <= 80)))),
    CONSTRAINT "studio_types_slug_check" CHECK ((("slug" = "btrim"("slug")) AND ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::"text") AND (("char_length"("slug") >= 2) AND ("char_length"("slug") <= 80)))),
    CONSTRAINT "studio_types_sort_order_check" CHECK (("sort_order" >= 0)),
    CONSTRAINT "studio_types_taxonomy_version_check" CHECK (("taxonomy_version" >= 0)),
    CONSTRAINT "studio_types_timestamps_check" CHECK (("updated_at" >= "created_at"))
);


ALTER TABLE "public"."studio_types" OWNER TO "postgres";


COMMENT ON TABLE "public"."studio_types" IS 'Taxonomia mínima e administrada de tipos de estúdio usada pelo conteúdo versionado.';



COMMENT ON COLUMN "public"."studio_types"."taxonomy_version" IS 'Versão otimista das alterações administrativas da taxonomia.';



CREATE TABLE IF NOT EXISTS "public"."studios" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "published_revision_id" "uuid",
    "draft_revision_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "publication_version" bigint DEFAULT 1 NOT NULL,
    "disabled_from_status" "text",
    CONSTRAINT "studios_disabled_from_status_check" CHECK (((("status" = 'disabled'::"text") AND ("disabled_from_status" = ANY (ARRAY['published'::"text", 'changes_pending'::"text", 'paused'::"text"]))) OR (("status" <> 'disabled'::"text") AND ("disabled_from_status" IS NULL)))),
    CONSTRAINT "studios_publication_pointer_state_check" CHECK (((("status" = ANY (ARRAY['draft'::"text", 'pending_review'::"text", 'rejected'::"text"])) AND ("published_revision_id" IS NULL) AND ("draft_revision_id" IS NOT NULL)) OR (("status" = ANY (ARRAY['published'::"text", 'changes_pending'::"text", 'paused'::"text"])) AND ("published_revision_id" IS NOT NULL) AND (("status" <> 'changes_pending'::"text") OR ("draft_revision_id" IS NOT NULL))) OR (("status" = 'disabled'::"text") AND ("published_revision_id" IS NOT NULL) AND (("disabled_from_status" <> 'changes_pending'::"text") OR ("draft_revision_id" IS NOT NULL))))),
    CONSTRAINT "studios_publication_version_check" CHECK (("publication_version" >= 1)),
    CONSTRAINT "studios_revision_pointer_check" CHECK ((("published_revision_id" IS NULL) OR ("draft_revision_id" IS NULL) OR ("published_revision_id" <> "draft_revision_id"))),
    CONSTRAINT "studios_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending_review'::"text", 'published'::"text", 'changes_pending'::"text", 'paused'::"text", 'rejected'::"text", 'disabled'::"text"]))),
    CONSTRAINT "studios_timestamps_check" CHECK (("updated_at" >= "created_at"))
);


ALTER TABLE "public"."studios" OWNER TO "postgres";


COMMENT ON TABLE "public"."studios" IS 'Entidade operacional do estúdio; conteúdo editável e público vive em revisões apontadas.';



COMMENT ON COLUMN "public"."studios"."publication_version" IS 'Fence monotônica de toda mudança de status ou ponteiro editorial do estúdio.';



COMMENT ON COLUMN "public"."studios"."disabled_from_status" IS 'Fonte explícita e única da restauração administrativa; nunca é inferida de ponteiros ou audit.';



CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "sort_order" smallint DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "taxonomy_version" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "tags_name_check" CHECK ((("name" = "btrim"("name")) AND (("char_length"("name") >= 2) AND ("char_length"("name") <= 80)))),
    CONSTRAINT "tags_slug_check" CHECK ((("slug" = "btrim"("slug")) AND ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::"text") AND (("char_length"("slug") >= 2) AND ("char_length"("slug") <= 80)))),
    CONSTRAINT "tags_sort_order_check" CHECK (("sort_order" >= 0)),
    CONSTRAINT "tags_taxonomy_version_check" CHECK (("taxonomy_version" >= 0)),
    CONSTRAINT "tags_timestamps_check" CHECK (("updated_at" >= "created_at"))
);


ALTER TABLE "public"."tags" OWNER TO "postgres";


COMMENT ON TABLE "public"."tags" IS 'Taxonomia administrada de usos e estilos do estúdio; somente itens ativos entram em novas drafts.';



COMMENT ON COLUMN "public"."tags"."taxonomy_version" IS 'Versão otimista das alterações administrativas da taxonomia.';



CREATE TABLE IF NOT EXISTS "public"."terms_acceptances" (
    "user_id" "uuid" NOT NULL,
    "terms_version_id" "uuid" NOT NULL,
    "accepted_content_hash" "text" NOT NULL,
    "accepted_at" timestamp with time zone NOT NULL,
    "request_id" "uuid" NOT NULL,
    "ip_hash" "text",
    "user_agent_hash" "text",
    CONSTRAINT "terms_acceptances_accepted_content_hash_check" CHECK (("accepted_content_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "terms_acceptances_ip_hash_check" CHECK ((("ip_hash" IS NULL) OR ("ip_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "terms_acceptances_user_agent_hash_check" CHECK ((("user_agent_hash" IS NULL) OR ("user_agent_hash" ~ '^[0-9a-f]{64}$'::"text")))
);


ALTER TABLE "public"."terms_acceptances" OWNER TO "postgres";


COMMENT ON TABLE "public"."terms_acceptances" IS 'Fato jurídico imutável com snapshot do hash aceito e evidência minimizada.';



COMMENT ON COLUMN "public"."terms_acceptances"."ip_hash" IS 'Nulo quando a origem não fornece endereço confiável; nunca recebe IP encaminhado sem confiança.';



CREATE TABLE IF NOT EXISTS "public"."terms_versions" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "kind" "text" NOT NULL,
    "version" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body_markdown" "text" NOT NULL,
    "source" "text" NOT NULL,
    "effective_at" timestamp with time zone NOT NULL,
    "retired_at" timestamp with time zone,
    "content_hash" "text" GENERATED ALWAYS AS ("encode"("extensions"."digest"("body_markdown", 'sha256'::"text"), 'hex'::"text")) STORED,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "terms_versions_body_markdown_check" CHECK ((("char_length"("btrim"("body_markdown")) >= 1) AND ("char_length"("btrim"("body_markdown")) <= 200000) AND ("body_markdown" = "btrim"("body_markdown")))),
    CONSTRAINT "terms_versions_content_hash_check" CHECK (("content_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "terms_versions_kind_check" CHECK (("kind" = ANY (ARRAY['terms'::"text", 'privacy'::"text", 'owner_contract'::"text"]))),
    CONSTRAINT "terms_versions_retirement_after_effective_check" CHECK ((("retired_at" IS NULL) OR ("retired_at" > "effective_at"))),
    CONSTRAINT "terms_versions_source_check" CHECK (("source" = ANY (ARRAY['local_fixture'::"text", 'approved'::"text"]))),
    CONSTRAINT "terms_versions_title_check" CHECK ((("char_length"("btrim"("title")) >= 3) AND ("char_length"("btrim"("title")) <= 160) AND ("title" = "btrim"("title")))),
    CONSTRAINT "terms_versions_version_check" CHECK ((("char_length"("version") >= 1) AND ("char_length"("version") <= 40)))
);


ALTER TABLE "public"."terms_versions" OWNER TO "postgres";


COMMENT ON TABLE "public"."terms_versions" IS 'Versões jurídicas append-only; somente aposentadoria nula para definida é permitida.';



COMMENT ON COLUMN "public"."terms_versions"."source" IS 'local_fixture identifica conteúdo exclusivo do ambiente local; approved exige aprovação humana externa.';



CREATE TABLE IF NOT EXISTS "public"."user_preferences" (
    "user_id" "uuid" NOT NULL,
    "color_scheme" "text" DEFAULT 'system'::"text" NOT NULL,
    "preferences_version" bigint DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_preferences_check" CHECK (("updated_at" >= "created_at")),
    CONSTRAINT "user_preferences_color_scheme_check" CHECK (("color_scheme" = ANY (ARRAY['system'::"text", 'light'::"text", 'dark'::"text"]))),
    CONSTRAINT "user_preferences_preferences_version_check" CHECK (("preferences_version" >= 0))
);


ALTER TABLE "public"."user_preferences" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_preferences" IS 'Preferência visual mínima 1:1 do perfil, versionada sem criar conflito com a identidade.';



COMMENT ON COLUMN "public"."user_preferences"."color_scheme" IS 'Allowlist de aparência: system, light ou dark.';



COMMENT ON COLUMN "public"."user_preferences"."preferences_version" IS 'Versão otimista monotônica da aparência, independente da identidade.';



ALTER TABLE ONLY "audit"."events"
    ADD CONSTRAINT "events_action_target_id_idempotency_key_key" UNIQUE ("action", "target_id", "idempotency_key");



ALTER TABLE ONLY "audit"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "private"."backoffice_command_requests"
    ADD CONSTRAINT "backoffice_command_requests_pkey" PRIMARY KEY ("actor_user_id", "idempotency_key");



ALTER TABLE ONLY "private"."backoffice_sessions"
    ADD CONSTRAINT "backoffice_sessions_pkey" PRIMARY KEY ("auth_session_id");



ALTER TABLE ONLY "private"."dal_routine_allowlist"
    ADD CONSTRAINT "dal_routine_allowlist_pkey" PRIMARY KEY ("signature");



ALTER TABLE ONLY "private"."identity_recovery_grants"
    ADD CONSTRAINT "identity_recovery_grants_pkey" PRIMARY KEY ("token");



ALTER TABLE ONLY "private"."identity_recovery_grants"
    ADD CONSTRAINT "identity_recovery_grants_session_key" UNIQUE ("auth_session_id");



ALTER TABLE ONLY "private"."identity_recovery_sessions"
    ADD CONSTRAINT "identity_recovery_sessions_pkey" PRIMARY KEY ("auth_session_id");



ALTER TABLE ONLY "private"."identity_recovery_sessions"
    ADD CONSTRAINT "identity_recovery_sessions_scope_key" UNIQUE ("session_scope");



ALTER TABLE ONLY "private"."identity_recovery_sessions"
    ADD CONSTRAINT "identity_recovery_sessions_user_session_key" UNIQUE ("auth_session_id", "user_id");



ALTER TABLE ONLY "private"."owner_activation_requests"
    ADD CONSTRAINT "owner_activation_requests_pkey" PRIMARY KEY ("owner_user_id", "idempotency_key");



ALTER TABLE ONLY "private"."owner_recipient_operations"
    ADD CONSTRAINT "owner_recipient_operations_owner_key_key" UNIQUE ("owner_user_id", "idempotency_key");



ALTER TABLE ONLY "private"."owner_recipient_operations"
    ADD CONSTRAINT "owner_recipient_operations_owner_sequence_key" UNIQUE ("owner_user_id", "operation_sequence");



ALTER TABLE ONLY "private"."owner_recipient_operations"
    ADD CONSTRAINT "owner_recipient_operations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "private"."signup_legal_intents"
    ADD CONSTRAINT "signup_legal_intents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "private"."signup_legal_intents"
    ADD CONSTRAINT "signup_legal_intents_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "private"."studio_command_requests"
    ADD CONSTRAINT "studio_command_requests_pkey" PRIMARY KEY ("owner_user_id", "idempotency_key");



ALTER TABLE ONLY "private"."studio_deletion_fences"
    ADD CONSTRAINT "studio_deletion_fences_pkey" PRIMARY KEY ("studio_id");



ALTER TABLE ONLY "private"."studio_media_finalize_claims"
    ADD CONSTRAINT "studio_media_finalize_claims_lease_token_key" UNIQUE ("lease_token");



ALTER TABLE ONLY "private"."studio_media_finalize_claims"
    ADD CONSTRAINT "studio_media_finalize_claims_media_key" UNIQUE ("media_id");



ALTER TABLE ONLY "private"."studio_media_finalize_claims"
    ADD CONSTRAINT "studio_media_finalize_claims_pkey" PRIMARY KEY ("owner_user_id", "idempotency_key");



ALTER TABLE ONLY "private"."studio_review_transition_fences"
    ADD CONSTRAINT "studio_review_transition_fences_pkey" PRIMARY KEY ("revision_id");



ALTER TABLE ONLY "public"."amenities"
    ADD CONSTRAINT "amenities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."amenities"
    ADD CONSTRAINT "amenities_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."email_outbox"
    ADD CONSTRAINT "email_outbox_deduplication_key_key" UNIQUE ("deduplication_key");



ALTER TABLE ONLY "public"."email_outbox"
    ADD CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_outbox"
    ADD CONSTRAINT "email_outbox_revision_id_template_key_key" UNIQUE ("revision_id", "template_key");



ALTER TABLE ONLY "public"."owner_payment_recipients"
    ADD CONSTRAINT "owner_payment_recipients_pkey" PRIMARY KEY ("owner_user_id");



ALTER TABLE ONLY "public"."owner_profiles"
    ADD CONSTRAINT "owner_profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."platform_roles"
    ADD CONSTRAINT "platform_roles_pkey" PRIMARY KEY ("user_id", "role");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."studio_faqs"
    ADD CONSTRAINT "studio_faqs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."studio_faqs"
    ADD CONSTRAINT "studio_faqs_revision_id_position_key" UNIQUE ("revision_id", "position");



ALTER TABLE ONLY "public"."studio_media"
    ADD CONSTRAINT "studio_media_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."studio_media"
    ADD CONSTRAINT "studio_media_preview_storage_path_key" UNIQUE ("preview_storage_path");



ALTER TABLE ONLY "public"."studio_media"
    ADD CONSTRAINT "studio_media_storage_path_key" UNIQUE ("storage_path");



ALTER TABLE ONLY "public"."studio_review_events"
    ADD CONSTRAINT "studio_review_events_event_sequence_key" UNIQUE ("event_sequence");



ALTER TABLE ONLY "public"."studio_review_events"
    ADD CONSTRAINT "studio_review_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."studio_review_events"
    ADD CONSTRAINT "studio_review_events_revision_id_event_type_key" UNIQUE ("revision_id", "event_type");



ALTER TABLE ONLY "public"."studio_revision_amenities"
    ADD CONSTRAINT "studio_revision_amenities_pkey" PRIMARY KEY ("revision_id", "amenity_id");



ALTER TABLE ONLY "public"."studio_revision_media"
    ADD CONSTRAINT "studio_revision_media_pkey" PRIMARY KEY ("revision_id", "media_id");



ALTER TABLE ONLY "public"."studio_revision_media"
    ADD CONSTRAINT "studio_revision_media_position_key" UNIQUE ("revision_id", "position") DEFERRABLE;



ALTER TABLE ONLY "public"."studio_revision_tags"
    ADD CONSTRAINT "studio_revision_tags_pkey" PRIMARY KEY ("revision_id", "tag_id");



ALTER TABLE ONLY "public"."studio_revisions"
    ADD CONSTRAINT "studio_revisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."studio_revisions"
    ADD CONSTRAINT "studio_revisions_studio_id_revision_number_key" UNIQUE ("studio_id", "revision_number");



ALTER TABLE ONLY "public"."studio_types"
    ADD CONSTRAINT "studio_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."studio_types"
    ADD CONSTRAINT "studio_types_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."studios"
    ADD CONSTRAINT "studios_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("user_id", "terms_version_id");



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_request_id_terms_version_id_key" UNIQUE ("request_id", "terms_version_id");



ALTER TABLE ONLY "public"."terms_versions"
    ADD CONSTRAINT "terms_versions_effective_period_exclusion" EXCLUDE USING "gist" ("kind" WITH =, "tstzrange"("effective_at", "retired_at", '[)'::"text") WITH &&);



ALTER TABLE ONLY "public"."terms_versions"
    ADD CONSTRAINT "terms_versions_kind_version_key" UNIQUE ("kind", "version");



ALTER TABLE ONLY "public"."terms_versions"
    ADD CONSTRAINT "terms_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id");



CREATE INDEX "audit_events_actor_user_id_idx" ON "audit"."events" USING "btree" ("actor_user_id") WHERE ("actor_user_id" IS NOT NULL);



CREATE INDEX "backoffice_sessions_user_id_idx" ON "private"."backoffice_sessions" USING "btree" ("user_id");



CREATE INDEX "identity_recovery_grants_expires_at_idx" ON "private"."identity_recovery_grants" USING "btree" ("expires_at");



CREATE INDEX "identity_recovery_sessions_retain_until_idx" ON "private"."identity_recovery_sessions" USING "btree" ("retain_until");



CREATE INDEX "signup_legal_intents_expires_at_idx" ON "private"."signup_legal_intents" USING "btree" ("expires_at");



CREATE INDEX "studio_command_requests_resulting_media_id_idx" ON "private"."studio_command_requests" USING "btree" ("resulting_media_id") WHERE ("resulting_media_id" IS NOT NULL);



CREATE INDEX "studio_media_finalize_claims_studio_idx" ON "private"."studio_media_finalize_claims" USING "btree" ("studio_id");



CREATE INDEX "email_outbox_studio_created_idx" ON "public"."email_outbox" USING "btree" ("studio_id", "created_at", "id");



CREATE INDEX "platform_roles_granted_by_idx" ON "public"."platform_roles" USING "btree" ("granted_by") WHERE ("granted_by" IS NOT NULL);



CREATE INDEX "platform_roles_role_user_id_idx" ON "public"."platform_roles" USING "btree" ("role", "user_id");



CREATE INDEX "profiles_backoffice_created_at_id_idx" ON "public"."profiles" USING "btree" ("created_at" DESC, "id" DESC);



CREATE INDEX "studio_media_cleanup_claim_token_idx" ON "public"."studio_media" USING "btree" ("cleanup_claim_token", "cleanup_claimed_at") WHERE (("status" = 'delete_pending'::"text") AND ("cleanup_claim_token" IS NOT NULL));



CREATE INDEX "studio_media_cleanup_dequeue_idx" ON "public"."studio_media" USING "btree" (COALESCE("cleanup_next_attempt_at", "cleanup_after"), "id") WHERE ("status" = ANY (ARRAY['pending_upload'::"text", 'rejected'::"text", 'delete_pending'::"text"]));



CREATE INDEX "studio_media_prepared_revision_id_idx" ON "public"."studio_media" USING "btree" ("prepared_revision_id") WHERE ("prepared_revision_id" IS NOT NULL);



CREATE INDEX "studio_media_studio_id_idx" ON "public"."studio_media" USING "btree" ("studio_id") WHERE ("studio_id" IS NOT NULL);



CREATE INDEX "studio_media_uploaded_by_idx" ON "public"."studio_media" USING "btree" ("uploaded_by");



CREATE INDEX "studio_review_events_actor_user_id_idx" ON "public"."studio_review_events" USING "btree" ("actor_user_id") WHERE ("actor_user_id" IS NOT NULL);



CREATE UNIQUE INDEX "studio_review_events_one_decision_idx" ON "public"."studio_review_events" USING "btree" ("revision_id") WHERE ("event_type" = ANY (ARRAY['approved'::"text", 'rejected'::"text"]));



CREATE INDEX "studio_review_events_studio_latest_idx" ON "public"."studio_review_events" USING "btree" ("studio_id", "event_sequence" DESC);



CREATE INDEX "studio_revision_amenities_amenity_id_idx" ON "public"."studio_revision_amenities" USING "btree" ("amenity_id");



CREATE INDEX "studio_revision_media_media_id_idx" ON "public"."studio_revision_media" USING "btree" ("media_id");



CREATE UNIQUE INDEX "studio_revision_media_one_cover_idx" ON "public"."studio_revision_media" USING "btree" ("revision_id") WHERE "is_cover";



CREATE INDEX "studio_revision_tags_tag_id_idx" ON "public"."studio_revision_tags" USING "btree" ("tag_id");



CREATE UNIQUE INDEX "studio_revisions_one_draft_per_studio_idx" ON "public"."studio_revisions" USING "btree" ("studio_id") WHERE ("status" = 'draft'::"text");



CREATE INDEX "studio_revisions_studio_type_id_idx" ON "public"."studio_revisions" USING "btree" ("studio_type_id");



CREATE INDEX "studios_draft_revision_id_idx" ON "public"."studios" USING "btree" ("draft_revision_id") WHERE ("draft_revision_id" IS NOT NULL);



CREATE INDEX "studios_owner_user_id_idx" ON "public"."studios" USING "btree" ("owner_user_id");



CREATE INDEX "studios_published_revision_id_idx" ON "public"."studios" USING "btree" ("published_revision_id") WHERE ("published_revision_id" IS NOT NULL);



CREATE OR REPLACE TRIGGER "audit_events_protect_append_only" BEFORE DELETE OR UPDATE ON "audit"."events" FOR EACH ROW EXECUTE FUNCTION "private"."protect_audit_event"();



CREATE OR REPLACE TRIGGER "backoffice_sessions_normalize_window" BEFORE INSERT OR UPDATE ON "private"."backoffice_sessions" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_backoffice_session_window"();



CREATE OR REPLACE TRIGGER "amenities_set_updated_at" BEFORE UPDATE ON "public"."amenities" FOR EACH ROW EXECUTE FUNCTION "private"."set_studio_updated_at"();



CREATE OR REPLACE TRIGGER "email_outbox_enforce_identity" BEFORE INSERT ON "public"."email_outbox" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_studio_outbox_identity"();



CREATE OR REPLACE TRIGGER "owner_payment_recipients_enforce_state" BEFORE INSERT OR UPDATE ON "public"."owner_payment_recipients" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_owner_recipient_state"();



CREATE OR REPLACE TRIGGER "owner_profiles_enforce_state" BEFORE INSERT OR UPDATE ON "public"."owner_profiles" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_owner_profile_state"();



CREATE OR REPLACE TRIGGER "platform_roles_touch_account_version" AFTER INSERT OR DELETE ON "public"."platform_roles" FOR EACH ROW EXECUTE FUNCTION "private"."touch_platform_role_account_version"();



CREATE OR REPLACE TRIGGER "profiles_bootstrap_user_preferences" AFTER INSERT ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."bootstrap_user_preferences"();



CREATE OR REPLACE TRIGGER "profiles_enforce_lifecycle" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_profile_lifecycle"();



CREATE OR REPLACE TRIGGER "profiles_protect_delete" BEFORE DELETE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."protect_profile_delete"();



CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."set_profile_updated_at"();



CREATE OR REPLACE TRIGGER "studio_faqs_require_draft" BEFORE INSERT OR DELETE OR UPDATE ON "public"."studio_faqs" FOR EACH ROW EXECUTE FUNCTION "private"."assert_editable_studio_revision_relation"();



CREATE OR REPLACE TRIGGER "studio_faqs_set_updated_at" BEFORE UPDATE ON "public"."studio_faqs" FOR EACH ROW EXECUTE FUNCTION "private"."set_studio_updated_at"();



CREATE OR REPLACE TRIGGER "studio_media_enforce_lifecycle" BEFORE UPDATE ON "public"."studio_media" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_studio_media_lifecycle"();



CREATE OR REPLACE TRIGGER "studio_media_protect_immutable_revision" BEFORE UPDATE ON "public"."studio_media" FOR EACH ROW EXECUTE FUNCTION "private"."protect_immutable_studio_media_lifecycle"();



CREATE OR REPLACE TRIGGER "studio_media_track_cleanup_membership" AFTER INSERT OR UPDATE ON "public"."studio_media" FOR EACH ROW EXECUTE FUNCTION "maintenance"."track_studio_media_cleanup_membership"();



CREATE OR REPLACE TRIGGER "studio_review_events_enforce_identity" BEFORE INSERT ON "public"."studio_review_events" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_studio_review_event_identity"();



CREATE OR REPLACE TRIGGER "studio_review_events_protect_append_only" BEFORE DELETE OR UPDATE ON "public"."studio_review_events" FOR EACH ROW EXECUTE FUNCTION "private"."protect_studio_review_event"();



CREATE OR REPLACE TRIGGER "studio_revision_amenities_require_draft" BEFORE INSERT OR DELETE OR UPDATE ON "public"."studio_revision_amenities" FOR EACH ROW EXECUTE FUNCTION "private"."assert_editable_studio_revision_relation"();



CREATE OR REPLACE TRIGGER "studio_revision_media_queue_unreferenced" AFTER DELETE ON "public"."studio_revision_media" FOR EACH ROW EXECUTE FUNCTION "private"."queue_unreferenced_studio_media_after_delete"();



CREATE OR REPLACE TRIGGER "studio_revision_media_require_draft" BEFORE INSERT OR DELETE OR UPDATE ON "public"."studio_revision_media" FOR EACH ROW EXECUTE FUNCTION "private"."assert_editable_studio_media_relation"();



CREATE OR REPLACE TRIGGER "studio_revision_tags_require_draft" BEFORE INSERT OR DELETE OR UPDATE ON "public"."studio_revision_tags" FOR EACH ROW EXECUTE FUNCTION "private"."assert_editable_studio_revision_relation"();



CREATE OR REPLACE TRIGGER "studio_revisions_clone_content" BEFORE INSERT ON "public"."studio_revisions" FOR EACH ROW EXECUTE FUNCTION "private"."clone_studio_revision_content_before_insert"();



CREATE OR REPLACE TRIGGER "studio_revisions_clone_media" AFTER INSERT ON "public"."studio_revisions" FOR EACH ROW EXECUTE FUNCTION "private"."clone_studio_revision_media_after_insert"();



CREATE OR REPLACE TRIGGER "studio_revisions_clone_relations" AFTER INSERT ON "public"."studio_revisions" FOR EACH ROW EXECUTE FUNCTION "private"."clone_studio_revision_relations_after_insert"();



CREATE OR REPLACE TRIGGER "studio_revisions_enforce_immutability" BEFORE DELETE OR UPDATE ON "public"."studio_revisions" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_studio_revision_immutability"();



CREATE OR REPLACE TRIGGER "studio_revisions_queue_unattached_media" BEFORE DELETE ON "public"."studio_revisions" FOR EACH ROW EXECUTE FUNCTION "private"."queue_unattached_studio_media_before_revision_delete"();



CREATE OR REPLACE TRIGGER "studio_types_set_updated_at" BEFORE UPDATE ON "public"."studio_types" FOR EACH ROW EXECUTE FUNCTION "private"."set_studio_updated_at"();



CREATE OR REPLACE TRIGGER "studios_enforce_publication_boundary" BEFORE UPDATE OF "status", "published_revision_id", "draft_revision_id", "disabled_from_status", "publication_version" ON "public"."studios" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_studio_publication_boundary"();



CREATE CONSTRAINT TRIGGER "studios_enforce_revision_pointers" AFTER INSERT OR UPDATE OF "draft_revision_id", "published_revision_id" ON "public"."studios" NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "private"."enforce_studio_revision_pointers"();



CREATE OR REPLACE TRIGGER "studios_queue_media_before_delete" BEFORE DELETE ON "public"."studios" FOR EACH ROW EXECUTE FUNCTION "private"."queue_studio_media_before_studio_delete"();



CREATE OR REPLACE TRIGGER "studios_set_updated_at" BEFORE UPDATE ON "public"."studios" FOR EACH ROW EXECUTE FUNCTION "private"."set_studio_updated_at"();



CREATE OR REPLACE TRIGGER "tags_set_updated_at" BEFORE UPDATE ON "public"."tags" FOR EACH ROW EXECUTE FUNCTION "private"."set_studio_updated_at"();



CREATE OR REPLACE TRIGGER "terms_acceptances_protect_immutability" BEFORE DELETE OR UPDATE ON "public"."terms_acceptances" FOR EACH ROW EXECUTE FUNCTION "private"."protect_terms_acceptance"();



CREATE OR REPLACE TRIGGER "terms_acceptances_validate_snapshot" BEFORE INSERT ON "public"."terms_acceptances" FOR EACH ROW EXECUTE FUNCTION "private"."validate_terms_acceptance_snapshot"();



CREATE OR REPLACE TRIGGER "terms_versions_protect_immutability" BEFORE DELETE OR UPDATE ON "public"."terms_versions" FOR EACH ROW EXECUTE FUNCTION "private"."protect_terms_version"();



CREATE OR REPLACE TRIGGER "user_preferences_set_updated_at" BEFORE UPDATE ON "public"."user_preferences" FOR EACH ROW EXECUTE FUNCTION "private"."set_user_preferences_updated_at"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."amenities" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."owner_payment_recipients" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."owner_profiles" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."studio_faqs" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."studio_revisions" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."studio_types" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."studios" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."tags" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



CREATE OR REPLACE TRIGGER "zzzz_normalize_updated_at" BEFORE UPDATE ON "public"."user_preferences" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_updated_at_monotonic"();



ALTER TABLE ONLY "audit"."events"
    ADD CONSTRAINT "events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "private"."backoffice_command_requests"
    ADD CONSTRAINT "backoffice_command_requests_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."backoffice_sessions"
    ADD CONSTRAINT "backoffice_sessions_auth_session_id_fkey" FOREIGN KEY ("auth_session_id") REFERENCES "auth"."sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."backoffice_sessions"
    ADD CONSTRAINT "backoffice_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."identity_recovery_grants"
    ADD CONSTRAINT "identity_recovery_grants_session_user_fkey" FOREIGN KEY ("auth_session_id", "user_id") REFERENCES "private"."identity_recovery_sessions"("auth_session_id", "user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."identity_recovery_grants"
    ADD CONSTRAINT "identity_recovery_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."identity_recovery_sessions"
    ADD CONSTRAINT "identity_recovery_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."owner_activation_requests"
    ADD CONSTRAINT "owner_activation_requests_owner_contract_version_id_fkey" FOREIGN KEY ("owner_contract_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "private"."owner_activation_requests"
    ADD CONSTRAINT "owner_activation_requests_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."owner_profiles"("user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."owner_recipient_operations"
    ADD CONSTRAINT "owner_recipient_operations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."owner_profiles"("user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."signup_legal_intents"
    ADD CONSTRAINT "signup_legal_intents_privacy_version_id_fkey" FOREIGN KEY ("privacy_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "private"."signup_legal_intents"
    ADD CONSTRAINT "signup_legal_intents_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "private"."studio_command_requests"
    ADD CONSTRAINT "studio_command_requests_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."owner_profiles"("user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."studio_command_requests"
    ADD CONSTRAINT "studio_command_requests_resulting_media_id_fkey" FOREIGN KEY ("resulting_media_id") REFERENCES "public"."studio_media"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "private"."studio_deletion_fences"
    ADD CONSTRAINT "studio_deletion_fences_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."studio_media_finalize_claims"
    ADD CONSTRAINT "studio_media_finalize_claims_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."studio_review_transition_fences"
    ADD CONSTRAINT "studio_review_transition_fences_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "private"."studio_review_transition_fences"
    ADD CONSTRAINT "studio_review_transition_fences_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_outbox"
    ADD CONSTRAINT "email_outbox_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE CASCADE;



COMMENT ON CONSTRAINT "email_outbox_revision_id_fkey" ON "public"."email_outbox" IS 'Intencao pendente nao sobrevive a exclusao canonica da revisao e de seu agregado.';



ALTER TABLE ONLY "public"."email_outbox"
    ADD CONSTRAINT "email_outbox_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE CASCADE;



COMMENT ON CONSTRAINT "email_outbox_studio_id_fkey" ON "public"."email_outbox" IS 'Intencao pendente nao sobrevive a exclusao canonica do estudio nunca publicado.';



ALTER TABLE ONLY "public"."owner_payment_recipients"
    ADD CONSTRAINT "owner_payment_recipients_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."owner_profiles"("user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."owner_profiles"
    ADD CONSTRAINT "owner_profiles_accepted_owner_contract_version_id_fkey" FOREIGN KEY ("accepted_owner_contract_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."owner_profiles"
    ADD CONSTRAINT "owner_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_roles"
    ADD CONSTRAINT "platform_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_roles"
    ADD CONSTRAINT "platform_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."studio_faqs"
    ADD CONSTRAINT "studio_faqs_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."studio_media"
    ADD CONSTRAINT "studio_media_prepared_revision_id_fkey" FOREIGN KEY ("prepared_revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."studio_media"
    ADD CONSTRAINT "studio_media_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."studio_media"
    ADD CONSTRAINT "studio_media_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."studio_review_events"
    ADD CONSTRAINT "studio_review_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."studio_review_events"
    ADD CONSTRAINT "studio_review_events_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE CASCADE;



COMMENT ON CONSTRAINT "studio_review_events_revision_id_fkey" ON "public"."studio_review_events" IS 'Evento acompanha a revisao quando o agregado nunca publicado e descartado integralmente.';



ALTER TABLE ONLY "public"."studio_review_events"
    ADD CONSTRAINT "studio_review_events_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE CASCADE;



COMMENT ON CONSTRAINT "studio_review_events_studio_id_fkey" ON "public"."studio_review_events" IS 'Evento pertence ao agregado; exclusao canonica de estudio nunca publicado remove seu historico editorial.';



ALTER TABLE ONLY "public"."studio_revision_amenities"
    ADD CONSTRAINT "studio_revision_amenities_amenity_id_fkey" FOREIGN KEY ("amenity_id") REFERENCES "public"."amenities"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."studio_revision_amenities"
    ADD CONSTRAINT "studio_revision_amenities_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."studio_revision_media"
    ADD CONSTRAINT "studio_revision_media_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."studio_media"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."studio_revision_media"
    ADD CONSTRAINT "studio_revision_media_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."studio_revision_tags"
    ADD CONSTRAINT "studio_revision_tags_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."studio_revision_tags"
    ADD CONSTRAINT "studio_revision_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."studio_revisions"
    ADD CONSTRAINT "studio_revisions_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."studio_revisions"
    ADD CONSTRAINT "studio_revisions_studio_type_id_fkey" FOREIGN KEY ("studio_type_id") REFERENCES "public"."studio_types"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."studios"
    ADD CONSTRAINT "studios_draft_revision_id_fkey" FOREIGN KEY ("draft_revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."studios"
    ADD CONSTRAINT "studios_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."owner_profiles"("user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."studios"
    ADD CONSTRAINT "studios_published_revision_id_fkey" FOREIGN KEY ("published_revision_id") REFERENCES "public"."studio_revisions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE "audit"."events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."backoffice_command_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."backoffice_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."dal_routine_allowlist" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."identity_recovery_grants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."identity_recovery_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."owner_activation_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."owner_recipient_operations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."signup_legal_intents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."studio_command_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."studio_deletion_fences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."studio_media_finalize_claims" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."studio_review_transition_fences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."amenities" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "amenities_select_active_or_referenced_own" ON "public"."amenities" FOR SELECT TO "authenticated" USING (("active" OR (EXISTS ( SELECT 1
   FROM (("public"."studio_revision_amenities" "relation"
     JOIN "public"."studio_revisions" "revision" ON (("revision"."id" = "relation"."revision_id")))
     JOIN "public"."studios" "studio" ON (("studio"."id" = "revision"."studio_id")))
  WHERE (("relation"."amenity_id" = "amenities"."id") AND ("studio"."owner_user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



ALTER TABLE "public"."email_outbox" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."owner_payment_recipients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owner_payment_recipients_select_own" ON "public"."owner_payment_recipients" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "owner_user_id"));



ALTER TABLE "public"."owner_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owner_profiles_select_own" ON "public"."owner_profiles" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."platform_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_select_own" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



ALTER TABLE "public"."studio_faqs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "studio_faqs_select_own" ON "public"."studio_faqs" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."studio_revisions" "revision"
     JOIN "public"."studios" "studio" ON (("studio"."id" = "revision"."studio_id")))
  WHERE (("revision"."id" = "studio_faqs"."revision_id") AND ("studio"."owner_user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."studio_media" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."studio_review_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."studio_revision_amenities" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "studio_revision_amenities_select_own" ON "public"."studio_revision_amenities" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."studio_revisions" "revision"
     JOIN "public"."studios" "studio" ON (("studio"."id" = "revision"."studio_id")))
  WHERE (("revision"."id" = "studio_revision_amenities"."revision_id") AND ("studio"."owner_user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."studio_revision_media" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."studio_revision_tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "studio_revision_tags_select_own" ON "public"."studio_revision_tags" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."studio_revisions" "revision"
     JOIN "public"."studios" "studio" ON (("studio"."id" = "revision"."studio_id")))
  WHERE (("revision"."id" = "studio_revision_tags"."revision_id") AND ("studio"."owner_user_id" = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."studio_revisions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "studio_revisions_select_own" ON "public"."studio_revisions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM (((("public"."studios" "studio"
     JOIN "public"."profiles" "profile" ON (("profile"."id" = "studio"."owner_user_id")))
     JOIN "public"."owner_profiles" "owner" ON (("owner"."user_id" = "profile"."id")))
     JOIN "public"."terms_versions" "legal_version" ON (("legal_version"."id" = "owner"."accepted_owner_contract_version_id")))
     JOIN "public"."terms_acceptances" "acceptance" ON ((("acceptance"."user_id" = "owner"."user_id") AND ("acceptance"."terms_version_id" = "legal_version"."id") AND ("acceptance"."accepted_content_hash" = "legal_version"."content_hash"))))
  WHERE (("studio"."id" = "studio_revisions"."studio_id") AND ("studio"."owner_user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("profile"."status" = 'active'::"text") AND ("profile"."completed_at" IS NOT NULL) AND ("owner"."status" = 'active'::"text") AND ("legal_version"."kind" = 'owner_contract'::"text") AND ("legal_version"."effective_at" <= "now"()) AND (("legal_version"."retired_at" IS NULL) OR ("now"() < "legal_version"."retired_at"))))));



COMMENT ON POLICY "studio_revisions_select_own" ON "public"."studio_revisions" IS 'Lê revisões somente sob ownership e elegibilidade canônica vigente do dono.';



ALTER TABLE "public"."studio_types" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "studio_types_select_active" ON "public"."studio_types" FOR SELECT TO "authenticated" USING (("active" OR (EXISTS ( SELECT 1
   FROM ("public"."studio_revisions" "revision"
     JOIN "public"."studios" "studio" ON (("studio"."id" = "revision"."studio_id")))
  WHERE (("revision"."studio_type_id" = "studio_types"."id") AND ("studio"."owner_user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



ALTER TABLE "public"."studios" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "studios_select_own" ON "public"."studios" FOR SELECT TO "authenticated" USING ((("owner_user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM ((("public"."profiles" "profile"
     JOIN "public"."owner_profiles" "owner" ON (("owner"."user_id" = "profile"."id")))
     JOIN "public"."terms_versions" "legal_version" ON (("legal_version"."id" = "owner"."accepted_owner_contract_version_id")))
     JOIN "public"."terms_acceptances" "acceptance" ON ((("acceptance"."user_id" = "owner"."user_id") AND ("acceptance"."terms_version_id" = "legal_version"."id") AND ("acceptance"."accepted_content_hash" = "legal_version"."content_hash"))))
  WHERE (("profile"."id" = "studios"."owner_user_id") AND ("profile"."status" = 'active'::"text") AND ("profile"."completed_at" IS NOT NULL) AND ("owner"."status" = 'active'::"text") AND ("legal_version"."kind" = 'owner_contract'::"text") AND ("legal_version"."effective_at" <= "now"()) AND (("legal_version"."retired_at" IS NULL) OR ("now"() < "legal_version"."retired_at")))))));



COMMENT ON POLICY "studios_select_own" ON "public"."studios" IS 'Lê somente estúdios do auth.uid elegível: conta ativa, perfil completo, dono ativo e contrato vigente aceito.';



ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tags_select_active_or_referenced_own" ON "public"."tags" FOR SELECT TO "authenticated" USING (("active" OR (EXISTS ( SELECT 1
   FROM (("public"."studio_revision_tags" "relation"
     JOIN "public"."studio_revisions" "revision" ON (("revision"."id" = "relation"."revision_id")))
     JOIN "public"."studios" "studio" ON (("studio"."id" = "revision"."studio_id")))
  WHERE (("relation"."tag_id" = "tags"."id") AND ("studio"."owner_user_id" = ( SELECT "auth"."uid"() AS "uid")))))));



ALTER TABLE "public"."terms_acceptances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "terms_acceptances_select_own" ON "public"."terms_acceptances" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."terms_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "terms_versions_select_current_authenticated" ON "public"."terms_versions" FOR SELECT TO "authenticated" USING ((("effective_at" <= "now"()) AND (("retired_at" IS NULL) OR ("now"() < "retired_at"))));



CREATE POLICY "terms_versions_select_current_public" ON "public"."terms_versions" FOR SELECT TO "anon" USING ((("kind" = ANY (ARRAY['terms'::"text", 'privacy'::"text"])) AND ("effective_at" <= "now"()) AND (("retired_at" IS NULL) OR ("now"() < "retired_at"))));



ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_preferences_select_own" ON "public"."user_preferences" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



GRANT USAGE ON SCHEMA "private" TO "app_dal";



REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "private"."activate_owner"("p_user_id" "uuid", "p_owner_contract_version_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_user_agent_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."activate_owner"("p_user_id" "uuid", "p_owner_contract_version_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_user_agent_hash" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."apply_owner_recipient_operation"("p_user_id" "uuid", "p_operation_id" "uuid", "p_request_id" "uuid", "p_provider" "text", "p_provider_reference" "text", "p_status" "text", "p_requirements" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."apply_owner_recipient_operation"("p_user_id" "uuid", "p_operation_id" "uuid", "p_request_id" "uuid", "p_provider" "text", "p_provider_reference" "text", "p_status" "text", "p_requirements" "text"[]) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."assert_editable_studio_media_relation"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."assert_editable_studio_revision_relation"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."assert_studio_owner_mutable"("p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."audit_studio_media_command"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_studio_id" "uuid", "p_metadata" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."audit_studio_publication_command"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_publication_version" bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."backoffice_payload_hash"("payload" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."backoffice_result_hash"("result" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."backoffice_session_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_required_role" "text", "p_require_strong_authentication" boolean, "p_touch_activity" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."backoffice_studio_command_result_json"("p_actor_user_id" "uuid", "p_action" "text", "p_studio_id" "uuid", "p_revision_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."backoffice_studio_revision_json"("p_revision_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."backoffice_taxonomy_item_json"("p_kind" "text", "p_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."backoffice_user_pii_json"("p_actor_user_id" "uuid", "p_target_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."backoffice_user_summary_json"("p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."begin_studio_media_finalize_claim"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."begin_studio_media_finalize_claim"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."bootstrap_first_platform_admin"("p_user_id" "uuid", "p_request_id" "uuid", "p_idempotency_key" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."bootstrap_signup_identity"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."bootstrap_user_preferences"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."can_sign_backoffice_studio_media"("p_object_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."can_sign_backoffice_studio_media"("p_object_name" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "private"."canonical_platform_roles"("p_roles" "text"[]) FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."check_readiness"("expected_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."check_readiness"("expected_version" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."claim_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."claim_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."clone_studio_revision_content_before_insert"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."clone_studio_revision_media_after_insert"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."clone_studio_revision_relations_after_insert"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."close_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."close_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."close_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."close_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."complete_profile"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_person_type" "text", "p_name" "text", "p_phone_e164" "text", "p_tax_id" "text", "p_additional_document" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."complete_profile"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_person_type" "text", "p_name" "text", "p_phone_e164" "text", "p_tax_id" "text", "p_additional_document" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."confirm_studio_media_upload_token"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."confirm_studio_media_upload_token"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."consume_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."consume_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."create_studio"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."create_studio"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."delete_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."delete_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."discard_studio_draft"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."discard_studio_draft"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."enforce_owner_profile_state"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_owner_recipient_state"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_profile_lifecycle"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_studio_media_lifecycle"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_studio_outbox_identity"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_studio_publication_boundary"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_studio_review_event_identity"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_studio_revision_immutability"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_studio_revision_pointers"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."execute_backoffice_studio_command"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_publication_version" bigint, "p_action" "text", "p_rejection_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."execute_backoffice_studio_command"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_publication_version" bigint, "p_action" "text", "p_rejection_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."finalize_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid", "p_actual_mime_type" "text", "p_actual_size_bytes" bigint, "p_width" integer, "p_height" integer, "p_checksum_sha256" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."finalize_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_actual_mime_type" "text", "p_actual_size_bytes" bigint, "p_width" integer, "p_height" integer, "p_checksum_sha256" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."finalize_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_actual_mime_type" "text", "p_actual_size_bytes" bigint, "p_width" integer, "p_height" integer, "p_checksum_sha256" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."get_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."get_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."get_backoffice_studio_review"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_touch_activity" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."get_backoffice_studio_review"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_studio_id" "uuid", "p_touch_activity" boolean) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."get_backoffice_user_access"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."get_backoffice_user_access"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."get_owner_recipient_status_for_user"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."get_owner_recipient_status_for_user"("p_user_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."get_owner_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."get_owner_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."get_owner_studio_publication"("p_user_id" "uuid", "p_studio_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."get_owner_studio_publication"("p_user_id" "uuid", "p_studio_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."get_studio_media_upload_candidate"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."inspect_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_grant_token" "uuid", "p_session_scope" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."inspect_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_grant_token" "uuid", "p_session_scope" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."is_valid_cnpj"("candidate" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."is_valid_cpf"("candidate" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."issue_identity_recovery_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."issue_identity_recovery_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."list_backoffice_studio_reviews"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_cursor_sequence" bigint, "p_cursor_studio_id" "uuid", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."list_backoffice_studio_reviews"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_cursor_sequence" bigint, "p_cursor_studio_id" "uuid", "p_limit" integer) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."list_backoffice_taxonomies"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."list_backoffice_taxonomies"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."list_backoffice_users"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_query" "text", "p_cursor_created_at" timestamp with time zone, "p_cursor_id" "uuid", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."list_backoffice_users"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_query" "text", "p_cursor_created_at" timestamp with time zone, "p_cursor_id" "uuid", "p_limit" integer) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."lock_active_studio_revision_taxonomy"("p_user_id" "uuid", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_revision_version" bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."lock_studio_media_revision"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."managed_runtime_boundaries_are_ready"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."mask_backoffice_email"("p_email" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."normalize_backoffice_session_window"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."normalize_updated_at_monotonic"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."open_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."open_backoffice_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."owner_recipient_status_row"("p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."pause_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."pause_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."platform_roles_for_user"("p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."prepare_owner_recipient_operation"("p_user_id" "uuid", "p_action" "text", "p_idempotency_key" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."prepare_owner_recipient_operation"("p_user_id" "uuid", "p_action" "text", "p_idempotency_key" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."prepare_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_declared_mime_type" "text", "p_declared_size_bytes" bigint, "p_declared_checksum_sha256" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."prepare_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_declared_mime_type" "text", "p_declared_size_bytes" bigint, "p_declared_checksum_sha256" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."prepare_studio_revision_draft"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."profile_command_result"("p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_audit_event"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_immutable_studio_media_lifecycle"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_profile_delete"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_studio_review_event"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_terms_acceptance"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_terms_version"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."queue_studio_media_before_studio_delete"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."queue_unattached_studio_media_before_revision_delete"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."queue_unreferenced_studio_media_after_delete"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."record_studio_media_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_revision_version" bigint, "p_media_id" "uuid", "p_result" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."record_studio_publication_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid", "p_revision_id" "uuid", "p_revision_version" bigint, "p_result" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."reject_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid", "p_request_id" "uuid", "p_rejection_code" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."reject_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_rejection_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."reject_studio_media_upload_claimed"("p_claim_token" "uuid", "p_request_id" "uuid", "p_rejection_code" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."reject_unsigned_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."reject_unsigned_studio_media_upload"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_media_id" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."release_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."release_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."release_studio_media_finalize_claim"("p_claim_token" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."release_studio_media_finalize_claim"("p_claim_token" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."renew_studio_media_finalize_claim"("p_claim_token" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."renew_studio_media_finalize_claim"("p_claim_token" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."reorder_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_ordered_media_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."reorder_studio_media"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_ordered_media_ids" "uuid"[]) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."replay_studio_media_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid", "p_media_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."replay_studio_media_finalize"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_media_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."replay_studio_publication_command"("p_user_id" "uuid", "p_idempotency_key" "uuid", "p_action" "text", "p_payload_hash" "text", "p_studio_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."resume_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."resume_studio"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_publication_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."reveal_backoffice_user_pii"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."reveal_backoffice_user_pii"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_reason" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."set_backoffice_user_role"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."set_backoffice_user_role"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."set_backoffice_user_status"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."set_backoffice_user_status"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_target_user_id" "uuid", "p_expected_account_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."set_profile_updated_at"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."set_studio_media_cover"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."set_studio_media_cover"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_media_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."set_studio_updated_at"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."set_user_preferences_updated_at"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_core_payload_hash"("p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_editor_json"("p_user_id" "uuid", "p_studio_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_media_cleanup_runs_are_healthy"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_media_payload_hash"("p_action" "text", "p_payload" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_publication_checklist"("p_revision_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_publication_json"("p_user_id" "uuid", "p_studio_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_publication_payload_hash"("p_action" "text", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_expected_publication_version" bigint) FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_publication_revision_json"("p_revision_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_result_hash"("p_result" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."studio_revision_taxonomy_fence"("p_revision_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."submit_studio_revision"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."submit_studio_revision"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."touch_platform_role_account_version"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."transition_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."transition_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_action" "text", "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."update_profile_appearance"("p_user_id" "uuid", "p_expected_preferences_version" bigint, "p_color_scheme" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."update_profile_appearance"("p_user_id" "uuid", "p_expected_preferences_version" bigint, "p_color_scheme" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."update_profile_identity"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_name" "text", "p_phone_e164" "text", "p_replace_tax_id" boolean, "p_tax_id" "text", "p_replace_additional_document" boolean, "p_additional_document" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."update_profile_identity"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_name" "text", "p_phone_e164" "text", "p_replace_tax_id" boolean, "p_tax_id" "text", "p_replace_additional_document" boolean, "p_additional_document" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."update_studio_revision_content"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_usage_rules" "text", "p_youtube_video_id" "text", "p_faqs" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."update_studio_revision_content"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_usage_rules" "text", "p_youtube_video_id" "text", "p_faqs" "jsonb") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."update_studio_revision_core"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."update_studio_revision_core"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_name" "text", "p_description" "text", "p_street" "text", "p_street_number" "text", "p_address_complement" "text", "p_neighborhood" "text", "p_city" "text", "p_state" "text", "p_postal_code" "text", "p_capacity" integer, "p_studio_type_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."update_studio_revision_taxonomy"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_tag_ids" "uuid"[], "p_amenity_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."update_studio_revision_taxonomy"("p_user_id" "uuid", "p_studio_id" "uuid", "p_expected_revision_id" "uuid", "p_expected_revision_version" bigint, "p_idempotency_key" "uuid", "p_request_id" "uuid", "p_tag_ids" "uuid"[], "p_amenity_ids" "uuid"[]) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."upsert_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_idempotency_key" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."upsert_backoffice_taxonomy"("p_actor_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_kind" "text", "p_id" "uuid", "p_expected_version" bigint, "p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_idempotency_key" "uuid", "p_request_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."validate_terms_acceptance_snapshot"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."begin_studio_media_cleanup_run"("p_run_id" "uuid", "p_function_slug" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."begin_studio_media_cleanup_run"("p_run_id" "uuid", "p_function_slug" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_studio_media_cleanup"("p_claim_token" "uuid", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_studio_media_cleanup"("p_claim_token" "uuid", "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_studio_media_cleanup"("p_claim_token" "uuid", "p_media_id" "uuid", "p_succeeded" boolean, "p_error_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_studio_media_cleanup"("p_claim_token" "uuid", "p_media_id" "uuid", "p_succeeded" boolean, "p_error_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_studio_media_cleanup_run"("p_run_id" "uuid", "p_status" "text", "p_claimed" integer, "p_deleted" integer, "p_failed" integer, "p_error_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_studio_media_cleanup_run"("p_run_id" "uuid", "p_status" "text", "p_claimed" integer, "p_deleted" integer, "p_failed" integer, "p_error_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_current_legal_terms"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_current_legal_terms"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_legal_terms"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_current_owner_contract"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_current_owner_contract"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_my_profile"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_my_profile"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_own_identity_context"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_own_identity_context"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_owner_activation_status"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_owner_activation_status"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_owner_recipient_status"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_owner_recipient_status"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_owner_studio_editor"("p_studio_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_owner_studio_editor"("p_studio_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."list_active_studio_taxonomies"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_active_studio_taxonomies"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."list_active_studio_types"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_active_studio_types"() TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."amenities" TO "authenticated";



GRANT SELECT("name") ON TABLE "public"."amenities" TO "authenticated";



GRANT SELECT("active") ON TABLE "public"."amenities" TO "authenticated";



GRANT SELECT("sort_order") ON TABLE "public"."amenities" TO "authenticated";



GRANT SELECT("owner_user_id") ON TABLE "public"."owner_payment_recipients" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."owner_payment_recipients" TO "authenticated";



GRANT SELECT("requirements") ON TABLE "public"."owner_payment_recipients" TO "authenticated";



GRANT SELECT("profile_version_synced") ON TABLE "public"."owner_payment_recipients" TO "authenticated";



GRANT SELECT("recipient_version") ON TABLE "public"."owner_payment_recipients" TO "authenticated";



GRANT SELECT("user_id") ON TABLE "public"."owner_profiles" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."owner_profiles" TO "authenticated";



GRANT SELECT("accepted_owner_contract_version_id") ON TABLE "public"."owner_profiles" TO "authenticated";



GRANT SELECT("owner_version") ON TABLE "public"."owner_profiles" TO "authenticated";



GRANT SELECT("activated_at") ON TABLE "public"."owner_profiles" TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("person_type") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("completed_at") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("name") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("phone_e164") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("tax_id_masked") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("additional_document_masked") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("profile_version") ON TABLE "public"."profiles" TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."studio_faqs" TO "authenticated";



GRANT SELECT("revision_id") ON TABLE "public"."studio_faqs" TO "authenticated";



GRANT SELECT("question") ON TABLE "public"."studio_faqs" TO "authenticated";



GRANT SELECT("answer") ON TABLE "public"."studio_faqs" TO "authenticated";



GRANT SELECT("position") ON TABLE "public"."studio_faqs" TO "authenticated";



GRANT SELECT("revision_id") ON TABLE "public"."studio_revision_amenities" TO "authenticated";



GRANT SELECT("amenity_id") ON TABLE "public"."studio_revision_amenities" TO "authenticated";



GRANT SELECT("revision_id") ON TABLE "public"."studio_revision_tags" TO "authenticated";



GRANT SELECT("tag_id") ON TABLE "public"."studio_revision_tags" TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("studio_id") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("revision_number") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("revision_version") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("name") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("description") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("street") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("street_number") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("address_complement") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("neighborhood") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("city") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("state") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("postal_code") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("capacity") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("studio_type_id") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("usage_rules") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("youtube_video_id") ON TABLE "public"."studio_revisions" TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."studio_types" TO "authenticated";



GRANT SELECT("name") ON TABLE "public"."studio_types" TO "authenticated";



GRANT SELECT("active") ON TABLE "public"."studio_types" TO "authenticated";



GRANT SELECT("sort_order") ON TABLE "public"."studio_types" TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."studios" TO "authenticated";



GRANT SELECT("owner_user_id") ON TABLE "public"."studios" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."studios" TO "authenticated";



GRANT SELECT("published_revision_id") ON TABLE "public"."studios" TO "authenticated";



GRANT SELECT("draft_revision_id") ON TABLE "public"."studios" TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."tags" TO "authenticated";



GRANT SELECT("name") ON TABLE "public"."tags" TO "authenticated";



GRANT SELECT("active") ON TABLE "public"."tags" TO "authenticated";



GRANT SELECT("sort_order") ON TABLE "public"."tags" TO "authenticated";



GRANT SELECT("user_id") ON TABLE "public"."terms_acceptances" TO "authenticated";



GRANT SELECT("terms_version_id") ON TABLE "public"."terms_acceptances" TO "authenticated";



GRANT SELECT("accepted_content_hash") ON TABLE "public"."terms_acceptances" TO "authenticated";



GRANT SELECT("accepted_at") ON TABLE "public"."terms_acceptances" TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("id") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("kind") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("kind") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("version") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("version") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("title") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("title") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("body_markdown") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("body_markdown") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("source") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("source") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("effective_at") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("effective_at") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("retired_at") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("retired_at") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("content_hash") ON TABLE "public"."terms_versions" TO "anon";
GRANT SELECT("content_hash") ON TABLE "public"."terms_versions" TO "authenticated";



GRANT SELECT("user_id") ON TABLE "public"."user_preferences" TO "authenticated";



GRANT SELECT("color_scheme") ON TABLE "public"."user_preferences" TO "authenticated";



GRANT SELECT("preferences_version") ON TABLE "public"."user_preferences" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
