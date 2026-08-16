-- FEAT-006 hardening append-only: lineariza a seleção de tipo com o futuro
-- arquivamento administrativo e garante que editar um publicado sempre crie
-- um draft, mesmo quando o payload é byte a byte idêntico ao aprovado.

alter table audit.events
  drop constraint events_action_check,
  add constraint events_action_check check (action in (
    'owner.activated',
    'owner.contract_renewed',
    'recipient.status_transitioned',
    'studio.created',
    'studio.revision.updated',
    'studio.draft.discarded',
    'studio.deleted'
  )),
  drop constraint events_target_type_check,
  add constraint events_target_type_check check (target_type in (
    'owner_profile',
    'owner_payment_recipient',
    'studio'
  ));

do $studio_command_concurrency_hardening$
declare
  active_snapshot text := $active_snapshot$  if not exists (
    select 1
    from public.studio_types as studio_type
    where studio_type.id = p_studio_type_id
      and studio_type.active
  ) then
    raise exception using
      errcode = '23514',
      message = 'studio_type_unavailable';
  end if;$active_snapshot$;
  active_lock text := $active_lock$  perform 1
  from public.studio_types as studio_type
  where studio_type.id = p_studio_type_id
    and studio_type.active
  for share of studio_type;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'studio_type_unavailable';
  end if;$active_lock$;
  published_noop text := $published_noop$  if current_revision.name = p_name$published_noop$;
  draft_noop text := $draft_noop$  if current_studio.draft_revision_id is not null
    and current_revision.name = p_name$draft_noop$;
  definition text;
  previous_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    )
  )
  into definition;

  if definition is null
    or pg_catalog.strpos(definition, active_snapshot) = 0
    or pg_catalog.strpos(definition, active_lock) <> 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_create_studio_predecessor';
  end if;

  previous_definition := definition;
  definition := pg_catalog.replace(definition, active_snapshot, active_lock);

  if definition = previous_definition
    or pg_catalog.strpos(definition, active_snapshot) <> 0
    or pg_catalog.strpos(definition, active_lock) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'create_studio_type_lock_update_failed';
  end if;

  execute definition;

  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'private.update_studio_revision_core(uuid,uuid,bigint,uuid,text,text,text,text,text,text,text,integer,uuid)'
    )
  )
  into definition;

  if definition is null
    or pg_catalog.strpos(definition, active_snapshot) = 0
    or pg_catalog.strpos(definition, active_lock) <> 0
    or pg_catalog.strpos(definition, published_noop) = 0
    or pg_catalog.strpos(definition, draft_noop) <> 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_update_studio_core_predecessor';
  end if;

  previous_definition := definition;
  definition := pg_catalog.replace(definition, published_noop, draft_noop);
  definition := pg_catalog.replace(definition, active_snapshot, active_lock);

  if definition = previous_definition
    or pg_catalog.strpos(definition, active_snapshot) <> 0
    or pg_catalog.strpos(definition, active_lock) = 0
    or pg_catalog.strpos(definition, published_noop) <> 0
    or pg_catalog.strpos(definition, draft_noop) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'update_studio_core_hardening_failed';
  end if;

  execute definition;
end;
$studio_command_concurrency_hardening$;

do $create_studio_request_correlation$
declare
  source_body text;
  transformed_body text;
begin
  if pg_catalog.to_regprocedure(
    'private.create_studio(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
  ) is not null then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_correlated_create_studio_predecessor';
  end if;

  select routine.prosrc
  into source_body
  from pg_catalog.pg_proc as routine
  where routine.oid = pg_catalog.to_regprocedure(
    'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
  );

  if source_body is null
    or pg_catalog.strpos(source_body, 'p_request_id') <> 0
    or pg_catalog.strpos(
      source_body,
      $validation$    or p_idempotency_key is null
    or p_studio_type_id is null$validation$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $return$  return query
  select *
  from private.owner_studio_editor_row(p_user_id, p_studio_id);
end;$return$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_create_studio_audit_predecessor';
  end if;

  transformed_body := pg_catalog.replace(
    source_body,
    $validation$    or p_idempotency_key is null
    or p_studio_type_id is null$validation$,
    $validation$    or p_idempotency_key is null
    or p_request_id is null
    or p_studio_type_id is null$validation$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $return$  return query
  select *
  from private.owner_studio_editor_row(p_user_id, p_studio_id);
end;$return$,
    $return$  insert into audit.events (
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
  ) values (
    p_user_id,
    'authenticated',
    'studio.created',
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'editVersion', 1,
      'revisionNumber', 1
    )
  );

  return query
  select *
  from private.owner_studio_editor_row(p_user_id, p_studio_id);
end;$return$
  );

  if transformed_body = source_body
    or pg_catalog.strpos(transformed_body, 'p_request_id is null') = 0
    or pg_catalog.strpos(
      transformed_body,
      $needle$'studio.created'$needle$
    ) = 0
    or pg_catalog.strpos(
      transformed_body,
      $metadata$pg_catalog.jsonb_build_object(
      'editVersion', 1,
      'revisionNumber', 1
    )$metadata$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'create_studio_audit_transform_failed';
  end if;

  execute pg_catalog.format(
    $definition$
      create function private.create_studio(
        p_user_id uuid,
        p_studio_id uuid,
        p_idempotency_key uuid,
        p_request_id uuid,
        p_name text,
        p_description text,
        p_street text,
        p_street_number text,
        p_address_complement text,
        p_neighborhood text,
        p_postal_code text,
        p_capacity integer,
        p_studio_type_id uuid
      )
      returns table (
        scope uuid,
        studio_id uuid,
        studio_status text,
        edit_version bigint,
        draft_revision_id uuid,
        draft_revision_number bigint,
        draft_name text,
        draft_description text,
        draft_street text,
        draft_street_number text,
        draft_address_complement text,
        draft_neighborhood text,
        draft_city text,
        draft_state text,
        draft_postal_code text,
        draft_capacity integer,
        draft_studio_type_id uuid,
        draft_studio_type_name text,
        published_revision_id uuid,
        published_revision_number bigint,
        published_name text,
        published_description text,
        published_street text,
        published_street_number text,
        published_address_complement text,
        published_neighborhood text,
        published_city text,
        published_state text,
        published_postal_code text,
        published_capacity integer,
        published_studio_type_id uuid,
        published_studio_type_name text
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
$create_studio_request_correlation$;

do $update_studio_request_correlation$
declare
  source_body text;
  transformed_body text;
begin
  if pg_catalog.to_regprocedure(
    'private.update_studio_revision_core(uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
  ) is not null then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_correlated_update_studio_predecessor';
  end if;

  select routine.prosrc
  into source_body
  from pg_catalog.pg_proc as routine
  where routine.oid = pg_catalog.to_regprocedure(
    'private.update_studio_revision_core(uuid,uuid,bigint,uuid,text,text,text,text,text,text,text,integer,uuid)'
  );

  if source_body is null
    or pg_catalog.strpos(source_body, 'p_request_id') <> 0
    or pg_catalog.strpos(
      source_body,
      $validation$    or p_idempotency_key is null
    or p_expected_edit_version is null$validation$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $declaration$  new_revision_number bigint;
begin$declaration$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $new_draft$  if current_studio.draft_revision_id is null then
    new_revision_id := extensions.gen_random_uuid();
    new_revision_number := current_studio.last_revision_number + 1;$new_draft$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $existing_draft$  else
    update public.studio_revisions as revision$existing_draft$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $return$  return query
  select *
  from private.owner_studio_editor_row(p_user_id, p_studio_id);
end;$return$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_update_studio_audit_predecessor';
  end if;

  transformed_body := pg_catalog.replace(
    source_body,
    $validation$    or p_idempotency_key is null
    or p_expected_edit_version is null$validation$,
    $validation$    or p_idempotency_key is null
    or p_request_id is null
    or p_expected_edit_version is null$validation$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $declaration$  new_revision_number bigint;
begin$declaration$,
    $declaration$  new_revision_number bigint;
  draft_created boolean;
  resulting_revision_number bigint;
begin$declaration$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $new_draft$  if current_studio.draft_revision_id is null then
    new_revision_id := extensions.gen_random_uuid();
    new_revision_number := current_studio.last_revision_number + 1;$new_draft$,
    $new_draft$  if current_studio.draft_revision_id is null then
    draft_created := true;
    new_revision_id := extensions.gen_random_uuid();
    new_revision_number := current_studio.last_revision_number + 1;
    resulting_revision_number := new_revision_number;$new_draft$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $existing_draft$  else
    update public.studio_revisions as revision$existing_draft$,
    $existing_draft$  else
    draft_created := false;
    resulting_revision_number := current_revision.revision_number;

    update public.studio_revisions as revision$existing_draft$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $return$  return query
  select *
  from private.owner_studio_editor_row(p_user_id, p_studio_id);
end;$return$,
    $return$  insert into audit.events (
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
  ) values (
    p_user_id,
    'authenticated',
    'studio.revision.updated',
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'draftCreated', draft_created,
      'editVersion', current_studio.edit_version + 1,
      'revisionNumber', resulting_revision_number
    )
  );

  return query
  select *
  from private.owner_studio_editor_row(p_user_id, p_studio_id);
end;$return$
  );

  if transformed_body = source_body
    or pg_catalog.strpos(transformed_body, 'p_request_id is null') = 0
    or pg_catalog.strpos(transformed_body, 'draft_created := true') = 0
    or pg_catalog.strpos(transformed_body, 'draft_created := false') = 0
    or pg_catalog.strpos(
      transformed_body,
      $needle$'studio.revision.updated'$needle$
    ) = 0
    or pg_catalog.strpos(
      transformed_body,
      $needle$'revisionNumber', resulting_revision_number$needle$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'update_studio_audit_transform_failed';
  end if;

  execute pg_catalog.format(
    $definition$
      create function private.update_studio_revision_core(
        p_user_id uuid,
        p_studio_id uuid,
        p_expected_edit_version bigint,
        p_idempotency_key uuid,
        p_request_id uuid,
        p_name text,
        p_description text,
        p_street text,
        p_street_number text,
        p_address_complement text,
        p_neighborhood text,
        p_postal_code text,
        p_capacity integer,
        p_studio_type_id uuid
      )
      returns table (
        scope uuid,
        studio_id uuid,
        studio_status text,
        edit_version bigint,
        draft_revision_id uuid,
        draft_revision_number bigint,
        draft_name text,
        draft_description text,
        draft_street text,
        draft_street_number text,
        draft_address_complement text,
        draft_neighborhood text,
        draft_city text,
        draft_state text,
        draft_postal_code text,
        draft_capacity integer,
        draft_studio_type_id uuid,
        draft_studio_type_name text,
        published_revision_id uuid,
        published_revision_number bigint,
        published_name text,
        published_description text,
        published_street text,
        published_street_number text,
        published_address_complement text,
        published_neighborhood text,
        published_city text,
        published_state text,
        published_postal_code text,
        published_capacity integer,
        published_studio_type_id uuid,
        published_studio_type_name text
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
$update_studio_request_correlation$;

do $discard_studio_request_correlation$
declare
  source_body text;
  transformed_body text;
begin
  if pg_catalog.to_regprocedure(
    'private.discard_studio_draft(uuid,uuid,bigint,uuid,uuid)'
  ) is not null then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_correlated_discard_studio_predecessor';
  end if;

  select routine.prosrc
  into source_body
  from pg_catalog.pg_proc as routine
  where routine.oid = pg_catalog.to_regprocedure(
    'private.discard_studio_draft(uuid,uuid,bigint,uuid)'
  );

  if source_body is null
    or pg_catalog.strpos(source_body, 'p_request_id') <> 0
    or pg_catalog.strpos(
      source_body,
      $validation$    or p_idempotency_key is null
    or p_expected_edit_version is null$validation$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $declaration$  removed_revision_id uuid;
  resulting_version bigint;$declaration$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $removed$  removed_revision_id := current_studio.draft_revision_id;$removed$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $deleted$    delete from public.studios as studio
    where studio.id = current_studio.id;

    return query$deleted$
    ) = 0
    or pg_catalog.strpos(
      source_body,
      $discarded$  return query
  select p_user_id, p_studio_id, false, true, resulting_version;
end;$discarded$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_discard_studio_audit_predecessor';
  end if;

  transformed_body := pg_catalog.replace(
    source_body,
    $validation$    or p_idempotency_key is null
    or p_expected_edit_version is null$validation$,
    $validation$    or p_idempotency_key is null
    or p_request_id is null
    or p_expected_edit_version is null$validation$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $declaration$  removed_revision_id uuid;
  resulting_version bigint;$declaration$,
    $declaration$  removed_revision_id uuid;
  removed_revision_number bigint;
  resulting_version bigint;$declaration$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $removed$  removed_revision_id := current_studio.draft_revision_id;$removed$,
    $removed$  removed_revision_id := current_studio.draft_revision_id;

  select revision.revision_number
  into removed_revision_number
  from public.studio_revisions as revision
  where revision.id = removed_revision_id
    and revision.studio_id = current_studio.id;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'studio_revision_pointer_invalid';
  end if;$removed$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $deleted$    delete from public.studios as studio
    where studio.id = current_studio.id;

    return query$deleted$,
    $deleted$    delete from public.studios as studio
    where studio.id = current_studio.id;

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
    ) values (
      p_user_id,
      'authenticated',
      'studio.deleted',
      'studio',
      p_studio_id,
      'succeeded',
      p_request_id,
      p_idempotency_key,
      null,
      pg_catalog.jsonb_build_object(
        'lastRevisionNumber', current_studio.last_revision_number
      )
    );

    return query$deleted$
  );
  transformed_body := pg_catalog.replace(
    transformed_body,
    $discarded$  return query
  select p_user_id, p_studio_id, false, true, resulting_version;
end;$discarded$,
    $discarded$  insert into audit.events (
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
  ) values (
    p_user_id,
    'authenticated',
    'studio.draft.discarded',
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'editVersion', resulting_version,
      'revisionNumber', removed_revision_number
    )
  );

  return query
  select p_user_id, p_studio_id, false, true, resulting_version;
end;$discarded$
  );

  if transformed_body = source_body
    or pg_catalog.strpos(transformed_body, 'p_request_id is null') = 0
    or pg_catalog.strpos(
      transformed_body,
      $needle$'studio.deleted'$needle$
    ) = 0
    or pg_catalog.strpos(
      transformed_body,
      $needle$'studio.draft.discarded'$needle$
    ) = 0
    or pg_catalog.strpos(
      transformed_body,
      $needle$'revisionNumber', removed_revision_number$needle$
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'discard_studio_audit_transform_failed';
  end if;

  execute pg_catalog.format(
    $definition$
      create function private.discard_studio_draft(
        p_user_id uuid,
        p_studio_id uuid,
        p_expected_edit_version bigint,
        p_idempotency_key uuid,
        p_request_id uuid
      )
      returns table (
        scope uuid,
        studio_id uuid,
        studio_deleted boolean,
        draft_discarded boolean,
        edit_version bigint
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
$discard_studio_request_correlation$;

revoke all on function private.create_studio(
  uuid, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.update_studio_revision_core(
  uuid, uuid, bigint, uuid, text, text, text, text, text, text, text, integer, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.discard_studio_draft(uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, app_dal;

drop function private.create_studio(
  uuid, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
);
drop function private.update_studio_revision_core(
  uuid, uuid, bigint, uuid, text, text, text, text, text, text, text, integer, uuid
);
drop function private.discard_studio_draft(uuid, uuid, bigint, uuid);

revoke all on function private.create_studio(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.update_studio_revision_core(
  uuid, uuid, bigint, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.discard_studio_draft(uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;

grant execute on function private.create_studio(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) to app_dal;
grant execute on function private.update_studio_revision_core(
  uuid, uuid, bigint, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) to app_dal;
grant execute on function private.discard_studio_draft(uuid, uuid, bigint, uuid, uuid)
  to app_dal;

comment on function private.create_studio(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) is 'Cria agregado e primeira revisão sob lock do tipo ativo e audita o efeito com request e idempotência separados.';
comment on function private.update_studio_revision_core(
  uuid, uuid, bigint, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) is 'Atualiza draft ou clona publicado, ainda que idêntico, e audita somente o efeito real sob edit_version.';
comment on function private.discard_studio_draft(uuid, uuid, bigint, uuid, uuid)
  is 'Descarta draft ou shell seguro e audita somente o efeito real, preservando replay e tombstone.';

do $studio_readiness_signatures$
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
      'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) = 0
    or pg_catalog.strpos(
      definition,
      'private.update_studio_revision_core(uuid,uuid,bigint,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) = 0
    or pg_catalog.strpos(
      definition,
      'private.discard_studio_draft(uuid,uuid,bigint,uuid)'
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_studio_request_readiness_predecessor';
  end if;

  previous_definition := definition;
  definition := pg_catalog.replace(
    definition,
    'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)',
    'private.create_studio(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
  );
  definition := pg_catalog.replace(
    definition,
    'private.update_studio_revision_core(uuid,uuid,bigint,uuid,text,text,text,text,text,text,text,integer,uuid)',
    'private.update_studio_revision_core(uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
  );
  definition := pg_catalog.replace(
    definition,
    'private.discard_studio_draft(uuid,uuid,bigint,uuid)',
    'private.discard_studio_draft(uuid,uuid,bigint,uuid,uuid)'
  );

  if definition = previous_definition
    or pg_catalog.strpos(
      definition,
      'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) <> 0
    or pg_catalog.strpos(
      definition,
      'private.update_studio_revision_core(uuid,uuid,bigint,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) <> 0
    or pg_catalog.strpos(
      definition,
      'private.discard_studio_draft(uuid,uuid,bigint,uuid)'
    ) <> 0
    or pg_catalog.strpos(
      definition,
      'private.create_studio(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) = 0
    or pg_catalog.strpos(
      definition,
      'private.update_studio_revision_core(uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) = 0
    or pg_catalog.strpos(
      definition,
      'private.discard_studio_draft(uuid,uuid,bigint,uuid,uuid)'
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'studio_request_readiness_update_failed';
  end if;

  execute definition;
end;
$studio_readiness_signatures$;

revoke all on function private.check_readiness(text)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function private.check_readiness(text)
  to app_dal;
