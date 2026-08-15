-- FEAT-004 review hardening: correlate canonical audit facts with the API/log
-- request ID while preserving the existing command idempotency keys.

alter table audit.events
  add column idempotency_key uuid;

-- The predecessor wrote the idempotency key into request_id. Preserve that
-- truthful legacy value as the new deduplication key; the unavailable historic
-- API request ID is deliberately not fabricated.
alter table audit.events
  disable trigger audit_events_protect_append_only;

update audit.events as event
set idempotency_key = event.request_id;

alter table audit.events
  alter column idempotency_key set not null,
  drop constraint events_action_target_id_request_id_key,
  add constraint events_action_target_id_idempotency_key_key
    unique (action, target_id, idempotency_key);

create or replace function private.protect_audit_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
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
$function$;

revoke all on function private.protect_audit_event()
  from public, anon, authenticated, service_role, app_dal;

alter table audit.events
  enable trigger audit_events_protect_append_only;

do $owner_activation$
declare
  source_body text;
  transformed_body text;
begin
  select routine.prosrc
  into source_body
  from pg_catalog.pg_proc as routine
  where routine.oid = pg_catalog.to_regprocedure(
    'private.activate_owner(uuid,uuid,uuid,text)'
  );

  if source_body is null
    or pg_catalog.strpos(source_body, 'p_request_id') <> 0
    or pg_catalog.strpos(
      source_body,
      $validation$    or p_idempotency_key is null
    or ($validation$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $audit$      request_id,
      ip_hash,$audit$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $audit$      'succeeded',
      p_idempotency_key,
      null,$audit$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_activate_owner_predecessor';
  end if;

  transformed_body := pg_catalog.replace(
    source_body,
    $validation$    or p_idempotency_key is null
    or ($validation$,
    $validation$    or p_idempotency_key is null
    or p_request_id is null
    or ($validation$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $audit$      request_id,
      ip_hash,$audit$,
    $audit$      request_id,
      idempotency_key,
      ip_hash,$audit$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $audit$      'succeeded',
      p_idempotency_key,
      null,$audit$,
    $audit$      'succeeded',
      p_request_id,
      p_idempotency_key,
      null,$audit$
  );

  if transformed_body = source_body
    or pg_catalog.strpos(transformed_body, 'p_request_id is null') = 0
    or pg_catalog.strpos(
      transformed_body,
      $audit$      'succeeded',
      p_request_id,
      p_idempotency_key,
      null,$audit$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'activate_owner_request_id_transform_failed';
  end if;

  execute pg_catalog.format(
    $definition$
      create function private.activate_owner(
        p_user_id uuid,
        p_owner_contract_version_id uuid,
        p_idempotency_key uuid,
        p_request_id uuid,
        p_user_agent_hash text
      )
      returns table (
        scope uuid,
        owner_status text,
        owner_version bigint,
        accepted_owner_contract_version_id uuid,
        owner_contract_accepted boolean,
        owner_contract_id uuid,
        owner_contract_kind text,
        owner_contract_version text,
        owner_contract_title text,
        owner_contract_body_markdown text,
        owner_contract_content_hash text,
        owner_contract_source text,
        owner_contract_effective_at timestamptz,
        recipient_status text,
        requirements text[],
        next_action text,
        profile_version bigint,
        profile_version_synced bigint,
        recipient_version bigint,
        reservations_eligible boolean,
        provider_mode text
      )
      language plpgsql
      volatile
      security definer
      set search_path = ''
      as %L
    $definition$,
    transformed_body
  );
end;
$owner_activation$;

do $recipient_apply$
declare
  source_body text;
  transformed_body text;
begin
  select routine.prosrc
  into source_body
  from pg_catalog.pg_proc as routine
  where routine.oid = pg_catalog.to_regprocedure(
    'private.apply_owner_recipient_operation(uuid,uuid,text,text,text,text[])'
  );

  if source_body is null
    or pg_catalog.strpos(source_body, 'p_request_id') <> 0
    or pg_catalog.strpos(
      source_body,
      $validation$    or p_operation_id is null
    or p_provider is distinct from 'local'$validation$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $audit$    request_id,
    ip_hash,$audit$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $audit$    'succeeded',
    current_operation.idempotency_key,
    null,$audit$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_apply_owner_recipient_predecessor';
  end if;

  transformed_body := pg_catalog.replace(
    source_body,
    $validation$    or p_operation_id is null
    or p_provider is distinct from 'local'$validation$,
    $validation$    or p_operation_id is null
    or p_request_id is null
    or p_provider is distinct from 'local'$validation$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $audit$    request_id,
    ip_hash,$audit$,
    $audit$    request_id,
    idempotency_key,
    ip_hash,$audit$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $audit$    'succeeded',
    current_operation.idempotency_key,
    null,$audit$,
    $audit$    'succeeded',
    p_request_id,
    current_operation.idempotency_key,
    null,$audit$
  );

  if transformed_body = source_body
    or pg_catalog.strpos(transformed_body, 'p_request_id is null') = 0
    or pg_catalog.strpos(
      transformed_body,
      $audit$    'succeeded',
    p_request_id,
    current_operation.idempotency_key,
    null,$audit$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'apply_owner_recipient_request_id_transform_failed';
  end if;

  execute pg_catalog.format(
    $definition$
      create function private.apply_owner_recipient_operation(
        p_user_id uuid,
        p_operation_id uuid,
        p_request_id uuid,
        p_provider text,
        p_provider_reference text,
        p_status text,
        p_requirements text[]
      )
      returns table (
        scope uuid,
        owner_status text,
        owner_version bigint,
        accepted_owner_contract_version_id uuid,
        owner_contract_accepted boolean,
        owner_contract_id uuid,
        owner_contract_kind text,
        owner_contract_version text,
        owner_contract_title text,
        owner_contract_body_markdown text,
        owner_contract_content_hash text,
        owner_contract_source text,
        owner_contract_effective_at timestamptz,
        recipient_status text,
        requirements text[],
        next_action text,
        profile_version bigint,
        profile_version_synced bigint,
        recipient_version bigint,
        reservations_eligible boolean,
        provider_mode text
      )
      language plpgsql
      volatile
      security definer
      set search_path = ''
      as %L
    $definition$,
    transformed_body
  );
end;
$recipient_apply$;

revoke all on function private.activate_owner(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.apply_owner_recipient_operation(uuid, uuid, text, text, text, text[])
  from public, anon, authenticated, service_role, app_dal;

drop function private.activate_owner(uuid, uuid, uuid, text);
drop function private.apply_owner_recipient_operation(uuid, uuid, text, text, text, text[]);

revoke all on function private.activate_owner(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.apply_owner_recipient_operation(
  uuid, uuid, uuid, text, text, text, text[]
)
  from public, anon, authenticated, service_role, app_dal;

grant execute on function private.activate_owner(uuid, uuid, uuid, uuid, text)
  to app_dal;
grant execute on function private.apply_owner_recipient_operation(
  uuid, uuid, uuid, text, text, text, text[]
)
  to app_dal;

comment on function private.activate_owner(uuid, uuid, uuid, uuid, text)
  is 'Ativa ou renova dono com idempotência própria e request ID da fachada para auditoria.';
comment on function private.apply_owner_recipient_operation(
  uuid, uuid, uuid, text, text, text, text[]
)
  is 'Aplica transição autoritativa do recebedor e correlaciona auditoria ao request ID da fachada.';

comment on column audit.events.request_id
  is 'Correlação com o requestId seguro da API e dos logs; linhas anteriores a 20260815000100 conservam o valor legado sem inventar correlação.';
comment on column audit.events.idempotency_key
  is 'Chave de deduplicação do comando, separada da correlação request_id.';

do $readiness$
declare
  definition text;
  previous_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('private.check_readiness(text)')
  )
  into definition;

  if definition is null
    or pg_catalog.strpos(
      definition,
      'private.activate_owner(uuid,uuid,uuid,text)'
    ) = 0
    or pg_catalog.strpos(
      definition,
      'private.apply_owner_recipient_operation(uuid,uuid,text,text,text,text[])'
    ) = 0
    or pg_catalog.strpos(
      definition,
      'private.activate_owner(uuid,uuid,uuid,uuid,text)'
    ) <> 0
    or pg_catalog.strpos(
      definition,
      'private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'
    ) <> 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_request_correlation_readiness_predecessor';
  end if;

  previous_definition := definition;
  definition := pg_catalog.replace(
    definition,
    'private.activate_owner(uuid,uuid,uuid,text)',
    'private.activate_owner(uuid,uuid,uuid,uuid,text)'
  );
  definition := pg_catalog.replace(
    definition,
    'private.apply_owner_recipient_operation(uuid,uuid,text,text,text,text[])',
    'private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'
  );

  if definition = previous_definition
    or pg_catalog.strpos(
      definition,
      'private.activate_owner(uuid,uuid,uuid,text)'
    ) <> 0
    or pg_catalog.strpos(
      definition,
      'private.apply_owner_recipient_operation(uuid,uuid,text,text,text,text[])'
    ) <> 0
    or pg_catalog.strpos(
      definition,
      'private.activate_owner(uuid,uuid,uuid,uuid,text)'
    ) = 0
    or pg_catalog.strpos(
      definition,
      'private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'request_correlation_readiness_update_failed';
  end if;

  execute definition;
end;
$readiness$;

revoke all on function private.check_readiness(text)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function private.check_readiness(text)
  to app_dal;
