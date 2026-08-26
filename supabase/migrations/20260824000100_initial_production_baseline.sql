-- Initial Set Livre schema, consolidated before the first production deployment.
-- Every migration after this baseline is immutable and forward-only.

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

-- Roles and database-level privileges are global objects and are intentionally omitted by the
-- official schema-only squash. This preamble preserves the final least-privilege state before any
-- object grants in the generated baseline are applied.
DO $block$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_dal') THEN
    CREATE ROLE app_dal;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime_production'
  ) THEN
    CREATE ROLE app_runtime_production;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('app_dal', 'app_runtime_production')
      AND (rolsuper OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'role da aplicação possui atributo reservado a superuser';
  END IF;
END
$block$;

ALTER ROLE app_dal
  NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN CONNECTION LIMIT -1 VALID UNTIL 'infinity';
ALTER ROLE app_dal RESET ALL;
ALTER ROLE app_dal IN DATABASE postgres RESET ALL;

ALTER ROLE app_runtime_production
  NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN CONNECTION LIMIT 10 VALID UNTIL 'infinity';
ALTER ROLE app_runtime_production RESET ALL;
ALTER ROLE app_runtime_production IN DATABASE postgres RESET ALL;

DO $block$
BEGIN
  EXECUTE pg_catalog.format(
    'revoke temporary on database %I from public',
    pg_catalog.current_database()
  );
  EXECUTE pg_catalog.format(
    'revoke all privileges on database %I from app_dal, app_runtime_production',
    pg_catalog.current_database()
  );
  EXECUTE pg_catalog.format(
    'grant connect on database %I to app_runtime_production',
    pg_catalog.current_database()
  );
END
$block$;

GRANT app_dal TO app_runtime_production WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;


CREATE SCHEMA IF NOT EXISTS "audit";


ALTER SCHEMA "audit" OWNER TO "postgres";


COMMENT ON SCHEMA "audit" IS 'Eventos sensíveis append-only não expostos pela Data API.';



CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


COMMENT ON SCHEMA "private" IS 'Objetos internos e comandos não expostos pela Data API.';



COMMENT ON SCHEMA "public" IS 'standard public schema';

REVOKE CREATE ON SCHEMA public FROM public;
REVOKE ALL ON SCHEMA private FROM public, anon, authenticated, service_role;
REVOKE ALL ON SCHEMA audit FROM public, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO app_dal;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM public, anon, authenticated, service_role, app_dal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM public, anon, authenticated, service_role, app_dal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM public, anon, authenticated, service_role, app_dal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private
  REVOKE ALL ON TABLES FROM public, anon, authenticated, service_role, app_dal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private
  REVOKE ALL ON SEQUENCES FROM public, anon, authenticated, service_role, app_dal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private
  REVOKE EXECUTE ON FUNCTIONS FROM public, anon, authenticated, service_role, app_dal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA audit
  REVOKE ALL ON TABLES FROM public, anon, authenticated, service_role, app_dal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA audit
  REVOKE ALL ON SEQUENCES FROM public, anon, authenticated, service_role, app_dal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA audit
  REVOKE EXECUTE ON FUNCTIONS FROM public, anon, authenticated, service_role, app_dal;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM public;



CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






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


CREATE OR REPLACE FUNCTION "private"."managed_runtime_boundaries_are_ready"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
  )
  select coalesce(
    (
      (select ready from sensitive_catalog_access_is_restricted)
      or (select ready from sensitive_settings_are_absent)
    )
    and (select ready from managed_http_access_is_restricted)
    and (select ready from application_database_access_is_restricted),
    false
  );
$$;


ALTER FUNCTION "private"."managed_runtime_boundaries_are_ready"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."managed_runtime_boundaries_are_ready"() IS 'Falha fechado se catálogos expõem configuração sensível, roles runtime alcançam pg_net ou recebem CREATE/TEMP.';


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
  migration_is_applied as (
    select
      expected_version ~ '^[0-9]{14}$'
      and exists (
        select 1
        from supabase_migrations.schema_migrations as migration
        where migration.version = expected_version
      ) as ready
  ),
  authorized_dal_routines(oid) as (
    values
      (pg_catalog.to_regprocedure('private.activate_owner(uuid,uuid,uuid,uuid,text)')),
      (pg_catalog.to_regprocedure('private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])')),
      (pg_catalog.to_regprocedure('private.check_readiness(text)')),
      (pg_catalog.to_regprocedure('private.check_runtime_readiness(text)')),
      (pg_catalog.to_regprocedure('private.claim_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)')),
      (pg_catalog.to_regprocedure('private.close_identity_recovery_session(uuid,uuid)')),
      (pg_catalog.to_regprocedure('private.complete_profile(uuid,bigint,text,text,text,text,text)')),
      (pg_catalog.to_regprocedure('private.consume_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)')),
      (pg_catalog.to_regprocedure('private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)')),
      (pg_catalog.to_regprocedure('private.get_owner_recipient_status_for_user(uuid)')),
      (pg_catalog.to_regprocedure('private.inspect_identity_recovery_session(uuid,uuid,timestamptz,uuid,uuid)')),
      (pg_catalog.to_regprocedure('private.issue_identity_recovery_context(uuid,uuid,timestamptz)')),
      (pg_catalog.to_regprocedure('private.prepare_owner_recipient_operation(uuid,text,uuid)')),
      (pg_catalog.to_regprocedure('private.release_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)')),
      (pg_catalog.to_regprocedure('private.update_profile_appearance(uuid,bigint,text)')),
      (pg_catalog.to_regprocedure('private.update_profile_identity(uuid,bigint,text,text,boolean,text,boolean,text)'))
  ),
  direct_schema_grants_are_restricted as (
    select
      pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        namespace.nspname = 'private'
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable
      ) as ready
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
    cross join dal_role
    where privilege.grantee = dal_role.oid
  ),
  direct_routine_grants_are_restricted as (
    select
      pg_catalog.count(*) = (select pg_catalog.count(*) from authorized_dal_routines)
      and coalesce(
        pg_catalog.bool_and(
          namespace.nspname = 'private'
          and routine.oid in (select authorized.oid from authorized_dal_routines as authorized)
          and privilege.privilege_type = 'EXECUTE'
          and not privilege.is_grantable
        ),
        false
      )
      and not exists (
        select 1
        from authorized_dal_routines as authorized
        where authorized.oid is null
      ) as ready
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    cross join dal_role
    where privilege.grantee = dal_role.oid
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
    and (select ready from direct_schema_grants_are_restricted)
    and (select ready from direct_routine_grants_are_restricted)
    and (select ready from effective_private_routine_grants_are_restricted)
    and (select ready from direct_data_grants_are_absent)
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


COMMENT ON FUNCTION "private"."check_readiness"("expected_version" "text") IS 'Health do app: migration aplicada e compatível com rollback, role DAL mínima, RLS e allowlists exatas.';



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
            select pg_catalog.count(*) = 0
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


COMMENT ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") IS 'Health do login restrito: assume app_dal e possui somente CONNECT direto, sem ownership ou ACL adicional.';



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



CREATE OR REPLACE FUNCTION "private"."set_profile_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.profile_version := old.profile_version + 1;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;


ALTER FUNCTION "private"."set_profile_updated_at"() OWNER TO "postgres";


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
    CONSTRAINT "events_action_check" CHECK (("action" = ANY (ARRAY['owner.activated'::"text", 'owner.contract_renewed'::"text", 'recipient.status_transitioned'::"text"]))),
    CONSTRAINT "events_actor_role_check" CHECK (("actor_role" = 'authenticated'::"text")),
    CONSTRAINT "events_ip_hash_check" CHECK ((("ip_hash" IS NULL) OR ("ip_hash" ~ '^[0-9a-f]{64}$'::"text"))),
    CONSTRAINT "events_metadata_check" CHECK (("jsonb_typeof"("metadata") = 'object'::"text")),
    CONSTRAINT "events_result_check" CHECK (("result" = 'succeeded'::"text")),
    CONSTRAINT "events_target_type_check" CHECK (("target_type" = ANY (ARRAY['owner_profile'::"text", 'owner_payment_recipient'::"text"])))
);


ALTER TABLE "audit"."events" OWNER TO "postgres";


COMMENT ON TABLE "audit"."events" IS 'Eventos operacionais append-only; referências externas e PII são proibidas em metadata.';



COMMENT ON COLUMN "audit"."events"."request_id" IS 'Correlação com o requestId seguro da API e dos logs; não é chave de idempotência.';



COMMENT ON COLUMN "audit"."events"."idempotency_key" IS 'Chave de deduplicação do comando, separada da correlação request_id.';



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
    CONSTRAINT "owner_recipient_operations_provider_reference_check" CHECK ((("provider_reference" IS NULL) OR ((("char_length"("provider_reference") >= 1) AND ("char_length"("provider_reference") <= 200)) AND ("provider_reference" !~ '[[:cntrl:]]'::"text") AND (("provider_reference" ~ '^local-recipient:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::"text") OR ("provider_reference" = ANY (ARRAY['local-test-fixture:refused'::"text", 'local-test-fixture:suspended'::"text", 'local-test-fixture:blocked'::"text", 'local-test-fixture:unavailable'::"text", 'local-test-fixture:timeout'::"text"])))))),
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
    CONSTRAINT "profiles_additional_document_shape_check" CHECK ((("additional_document" IS NULL) OR ((("char_length"("additional_document") >= 3) AND ("char_length"("additional_document") <= 40)) AND ("additional_document" ~ '^[A-Z0-9]+([./ -][A-Z0-9]+)*$'::"text")))),
    CONSTRAINT "profiles_check" CHECK ((("completed_at" IS NULL) OR ("completed_at" >= "created_at"))),
    CONSTRAINT "profiles_check1" CHECK (("updated_at" >= "created_at")),
    CONSTRAINT "profiles_completion_data_check" CHECK (((("completed_at" IS NULL) AND ("name" IS NULL) AND ("phone_e164" IS NULL) AND ("tax_id" IS NULL) AND ("additional_document" IS NULL)) OR (("completed_at" IS NOT NULL) AND ("name" IS NOT NULL) AND ("phone_e164" IS NOT NULL) AND ("tax_id" IS NOT NULL)))),
    CONSTRAINT "profiles_name_shape_check" CHECK ((("name" IS NULL) OR ((("char_length"("name") >= 2) AND ("char_length"("name") <= 160)) AND ("name" = "btrim"("name")) AND ("name" !~ '[[:cntrl:]]'::"text")))),
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
    CONSTRAINT "terms_versions_body_markdown_check" CHECK (((("char_length"("btrim"("body_markdown")) >= 1) AND ("char_length"("btrim"("body_markdown")) <= 200000)) AND ("body_markdown" = "btrim"("body_markdown")))),
    CONSTRAINT "terms_versions_content_hash_check" CHECK (("content_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "terms_versions_kind_check" CHECK (("kind" = ANY (ARRAY['terms'::"text", 'privacy'::"text", 'owner_contract'::"text"]))),
    CONSTRAINT "terms_versions_retirement_after_effective_check" CHECK ((("retired_at" IS NULL) OR ("retired_at" > "effective_at"))),
    CONSTRAINT "terms_versions_source_check" CHECK (("source" = ANY (ARRAY['local_fixture'::"text", 'approved'::"text"]))),
    CONSTRAINT "terms_versions_title_check" CHECK (((("char_length"("btrim"("title")) >= 3) AND ("char_length"("btrim"("title")) <= 160)) AND ("title" = "btrim"("title")))),
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



ALTER TABLE ONLY "public"."owner_payment_recipients"
    ADD CONSTRAINT "owner_payment_recipients_pkey" PRIMARY KEY ("owner_user_id");



ALTER TABLE ONLY "public"."owner_profiles"
    ADD CONSTRAINT "owner_profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



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



CREATE INDEX "identity_recovery_grants_expires_at_idx" ON "private"."identity_recovery_grants" USING "btree" ("expires_at");



CREATE INDEX "identity_recovery_sessions_retain_until_idx" ON "private"."identity_recovery_sessions" USING "btree" ("retain_until");



CREATE INDEX "signup_legal_intents_expires_at_idx" ON "private"."signup_legal_intents" USING "btree" ("expires_at");



CREATE OR REPLACE TRIGGER "audit_events_protect_append_only" BEFORE DELETE OR UPDATE ON "audit"."events" FOR EACH ROW EXECUTE FUNCTION "private"."protect_audit_event"();



CREATE OR REPLACE TRIGGER "owner_payment_recipients_enforce_state" BEFORE INSERT OR UPDATE ON "public"."owner_payment_recipients" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_owner_recipient_state"();



CREATE OR REPLACE TRIGGER "owner_profiles_enforce_state" BEFORE INSERT OR UPDATE ON "public"."owner_profiles" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_owner_profile_state"();



CREATE OR REPLACE TRIGGER "profiles_bootstrap_user_preferences" AFTER INSERT ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."bootstrap_user_preferences"();



CREATE OR REPLACE TRIGGER "profiles_enforce_lifecycle" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."enforce_profile_lifecycle"();



CREATE OR REPLACE TRIGGER "profiles_protect_delete" BEFORE DELETE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."protect_profile_delete"();



CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "private"."set_profile_updated_at"();



CREATE OR REPLACE TRIGGER "terms_acceptances_protect_immutability" BEFORE DELETE OR UPDATE ON "public"."terms_acceptances" FOR EACH ROW EXECUTE FUNCTION "private"."protect_terms_acceptance"();



CREATE OR REPLACE TRIGGER "terms_acceptances_validate_snapshot" BEFORE INSERT ON "public"."terms_acceptances" FOR EACH ROW EXECUTE FUNCTION "private"."validate_terms_acceptance_snapshot"();



CREATE OR REPLACE TRIGGER "terms_versions_protect_immutability" BEFORE DELETE OR UPDATE ON "public"."terms_versions" FOR EACH ROW EXECUTE FUNCTION "private"."protect_terms_version"();



CREATE OR REPLACE TRIGGER "user_preferences_set_updated_at" BEFORE UPDATE ON "public"."user_preferences" FOR EACH ROW EXECUTE FUNCTION "private"."set_user_preferences_updated_at"();



ALTER TABLE ONLY "audit"."events"
    ADD CONSTRAINT "events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



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



ALTER TABLE ONLY "public"."owner_payment_recipients"
    ADD CONSTRAINT "owner_payment_recipients_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."owner_profiles"("user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."owner_profiles"
    ADD CONSTRAINT "owner_profiles_accepted_owner_contract_version_id_fkey" FOREIGN KEY ("accepted_owner_contract_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."owner_profiles"
    ADD CONSTRAINT "owner_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "public"."terms_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE "audit"."events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."identity_recovery_grants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."identity_recovery_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."owner_activation_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."owner_recipient_operations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "private"."signup_legal_intents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."owner_payment_recipients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owner_payment_recipients_select_own" ON "public"."owner_payment_recipients" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "owner_user_id"));



ALTER TABLE "public"."owner_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owner_profiles_select_own" ON "public"."owner_profiles" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_select_own" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



ALTER TABLE "public"."terms_acceptances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "terms_acceptances_select_own" ON "public"."terms_acceptances" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."terms_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "terms_versions_select_current_authenticated" ON "public"."terms_versions" FOR SELECT TO "authenticated" USING ((("effective_at" <= "now"()) AND (("retired_at" IS NULL) OR ("now"() < "retired_at"))));



CREATE POLICY "terms_versions_select_current_public" ON "public"."terms_versions" FOR SELECT TO "anon" USING ((("kind" = ANY (ARRAY['terms'::"text", 'privacy'::"text"])) AND ("effective_at" <= "now"()) AND (("retired_at" IS NULL) OR ("now"() < "retired_at"))));



ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_preferences_select_own" ON "public"."user_preferences" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


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



REVOKE ALL ON FUNCTION "private"."bootstrap_signup_identity"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."bootstrap_user_preferences"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."check_readiness"("expected_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."check_readiness"("expected_version" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."managed_runtime_boundaries_are_ready"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."check_runtime_readiness"("expected_session_role" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."claim_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."claim_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."claim_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."close_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."close_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."complete_profile"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_person_type" "text", "p_name" "text", "p_phone_e164" "text", "p_tax_id" "text", "p_additional_document" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."complete_profile"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_person_type" "text", "p_name" "text", "p_phone_e164" "text", "p_tax_id" "text", "p_additional_document" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."consume_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."consume_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."consume_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."create_signup_legal_intent"("expected_terms_version_id" "uuid", "expected_privacy_version_id" "uuid", "person_type" "text", "request_id" "uuid", "evidence" "jsonb") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."enforce_owner_profile_state"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_owner_recipient_state"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."enforce_profile_lifecycle"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."get_owner_recipient_status_for_user"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."get_owner_recipient_status_for_user"("p_user_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."has_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."inspect_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_grant_token" "uuid", "p_session_scope" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."inspect_identity_recovery_session"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone, "p_grant_token" "uuid", "p_session_scope" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."is_valid_cnpj"("candidate" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."is_valid_cpf"("candidate" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."issue_identity_recovery_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."issue_identity_recovery_context"("p_user_id" "uuid", "p_auth_session_id" "uuid", "p_auth_expires_at" timestamp with time zone) TO "app_dal";



REVOKE ALL ON FUNCTION "private"."issue_identity_recovery_grant"("p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."owner_recipient_status_row"("p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."prepare_owner_recipient_operation"("p_user_id" "uuid", "p_action" "text", "p_idempotency_key" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."prepare_owner_recipient_operation"("p_user_id" "uuid", "p_action" "text", "p_idempotency_key" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."profile_command_result"("p_user_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_audit_event"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_profile_delete"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_terms_acceptance"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."protect_terms_version"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."release_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."release_identity_recovery_context"("p_token" "uuid", "p_user_id" "uuid", "p_auth_session_id" "uuid", "p_session_scope" "uuid", "p_attempt_id" "uuid") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."release_identity_recovery_grant"("p_token" "uuid", "p_user_id" "uuid", "p_attempt_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."set_profile_updated_at"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."set_user_preferences_updated_at"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."update_profile_appearance"("p_user_id" "uuid", "p_expected_preferences_version" bigint, "p_color_scheme" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."update_profile_appearance"("p_user_id" "uuid", "p_expected_preferences_version" bigint, "p_color_scheme" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."update_profile_identity"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_name" "text", "p_phone_e164" "text", "p_replace_tax_id" boolean, "p_tax_id" "text", "p_replace_additional_document" boolean, "p_additional_document" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."update_profile_identity"("p_user_id" "uuid", "p_expected_profile_version" bigint, "p_name" "text", "p_phone_e164" "text", "p_replace_tax_id" boolean, "p_tax_id" "text", "p_replace_additional_document" boolean, "p_additional_document" "text") TO "app_dal";



REVOKE ALL ON FUNCTION "private"."validate_terms_acceptance_snapshot"() FROM PUBLIC;



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






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE ALL ON TYPES FROM PUBLIC;



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE ALL ON FUNCTIONS FROM PUBLIC;





























--
-- Dumped schema changes for auth and storage
--

CREATE OR REPLACE TRIGGER "set_livre_bootstrap_signup_identity" AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "private"."bootstrap_signup_identity"();
