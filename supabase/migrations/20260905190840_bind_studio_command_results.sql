create function private.bind_studio_command_result(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_result jsonb
) returns jsonb
  language plpgsql volatile
  security definer
  set search_path to ''
as $function$
declare
  persisted record;
  bound_action text;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or pg_catalog.jsonb_typeof(p_result) is distinct from 'object'
  then
    raise exception using errcode = 'XX000', message = 'studio_command_result_mismatch';
  end if;

  -- VOLATILE sees the ledger written by the nested command in this same SELECT.
  select request.action, request.idempotency_key, request.result_hash, request.result_payload
  into persisted
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key;

  if not found then
    raise exception using errcode = 'XX000', message = 'studio_command_result_mismatch';
  end if;

  bound_action := case
    when persisted.action = 'studio.media.prepare' then 'studio.media.upload.prepare'
    when persisted.action = 'studio.media.finalize' then 'studio.media.upload.finalize'
    when persisted.action = any (array[
      'studio.create',
      'studio.revision.updateCore',
      'studio.revision.updateTaxonomy',
      'studio.revision.updateContent',
      'studio.draft.discard',
      'studio.media.reorder',
      'studio.media.cover.set',
      'studio.media.delete',
      'studio.revision.submit',
      'studio.pause',
      'studio.resume'
    ]) then persisted.action
    else null
  end;

  if bound_action is null
    or private.studio_result_hash(p_result) is distinct from persisted.result_hash
    or (
      persisted.result_payload is not null
      and (
        persisted.result_payload is distinct from p_result
        or private.studio_result_hash(persisted.result_payload)
          is distinct from persisted.result_hash
      )
    )
  then
    raise exception using errcode = 'XX000', message = 'studio_command_result_mismatch';
  end if;

  return pg_catalog.jsonb_build_object(
    'action', bound_action,
    'idempotencyKey', persisted.idempotency_key,
    'result', p_result
  );
end;
$function$;

alter function private.bind_studio_command_result(uuid, uuid, jsonb) owner to postgres;
revoke all on function private.bind_studio_command_result(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.bind_studio_command_result(uuid, uuid, jsonb) to app_dal;

comment on function private.bind_studio_command_result(uuid, uuid, jsonb) is
  'Binds a raw command result to the persisted owner/key ledger before signing. Server-validated session only; not a read-model or command dispatcher.';

insert into private.dal_routine_allowlist (signature)
values ('private.bind_studio_command_result(uuid,uuid,jsonb)');
