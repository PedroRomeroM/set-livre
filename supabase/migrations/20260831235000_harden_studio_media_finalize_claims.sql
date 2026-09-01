create table private.studio_media_finalize_claims (
  owner_user_id uuid not null,
  idempotency_key uuid not null,
  payload_hash text not null,
  studio_id uuid not null,
  expected_revision_id uuid not null,
  expected_revision_version bigint not null,
  media_id uuid not null,
  latest_request_id uuid not null,
  lease_token uuid,
  lease_claimed_at timestamptz,
  lease_expires_at timestamptz,
  terminal_state text,
  terminal_rejection_code text,
  terminal_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (owner_user_id, idempotency_key),
  constraint studio_media_finalize_claims_owner_fkey foreign key (owner_user_id)
    references public.profiles (id) on delete cascade,
  constraint studio_media_finalize_claims_media_key unique (media_id),
  constraint studio_media_finalize_claims_lease_token_key unique (lease_token),
  constraint studio_media_finalize_claims_payload_hash_check check (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint studio_media_finalize_claims_revision_version_check check (
    expected_revision_version >= 1
  ),
  constraint studio_media_finalize_claims_lease_check check (
    (
      lease_token is null
      and lease_claimed_at is null
      and lease_expires_at is null
    )
    or (
      lease_token is not null
      and lease_claimed_at is not null
      and lease_expires_at is not null
      and lease_expires_at > lease_claimed_at
    )
  ),
  constraint studio_media_finalize_claims_terminal_check check (
    (
      terminal_state is null
      and terminal_rejection_code is null
      and terminal_at is null
    )
    or (
      terminal_state = 'finalized'
      and terminal_rejection_code is null
      and terminal_at is not null
    )
    or (
      terminal_state = 'rejected'
      and terminal_rejection_code = any (array[
        'object_missing'::text,
        'superseded'::text,
        'validation_failed'::text
      ])
      and terminal_at is not null
    )
  )
);

create index studio_media_finalize_claims_studio_idx
  on private.studio_media_finalize_claims (studio_id);

alter table private.studio_media_finalize_claims owner to postgres;
alter table private.studio_media_finalize_claims enable row level security;

comment on table private.studio_media_finalize_claims is
  'Identidade e tombstone persistentes da finalização de mídia, com lease curta embutida e cercada por token; não referencia studio/media mutáveis para sobreviver ao cleanup.';

create or replace function private.begin_studio_media_finalize_claim(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_media_id uuid
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
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
$function$;

alter function private.begin_studio_media_finalize_claim(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid
) owner to postgres;

create or replace function private.renew_studio_media_finalize_claim(
  p_claim_token uuid
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
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
$function$;

alter function private.renew_studio_media_finalize_claim(uuid) owner to postgres;

create or replace function private.release_studio_media_finalize_claim(
  p_claim_token uuid
) returns boolean
  language plpgsql volatile security definer
  set search_path to ''
as $function$
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
$function$;

alter function private.release_studio_media_finalize_claim(uuid) owner to postgres;

create or replace function private.reject_studio_media_upload_claimed(
  p_claim_token uuid,
  p_request_id uuid,
  p_rejection_code text
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
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
$function$;

alter function private.reject_studio_media_upload_claimed(uuid, uuid, text) owner to postgres;

create or replace function private.finalize_studio_media_upload_claimed(
  p_claim_token uuid,
  p_request_id uuid,
  p_actual_mime_type text,
  p_actual_size_bytes bigint,
  p_width integer,
  p_height integer,
  p_checksum_sha256 text
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
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
$function$;

alter function private.finalize_studio_media_upload_claimed(
  uuid, uuid, text, bigint, integer, integer, text
) owner to postgres;

delete from private.dal_routine_allowlist
where signature in (
  'private.replay_studio_media_finalize(uuid,uuid,uuid,bigint,uuid,uuid)',
  'private.get_studio_media_upload_candidate(uuid,uuid,uuid,bigint,uuid)',
  'private.reject_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid,text)',
  'private.finalize_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid,uuid,text,bigint,integer,integer,text)'
);

insert into private.dal_routine_allowlist (signature)
values
  ('private.begin_studio_media_finalize_claim(uuid,uuid,uuid,bigint,uuid,uuid,uuid)'),
  ('private.renew_studio_media_finalize_claim(uuid)'),
  ('private.release_studio_media_finalize_claim(uuid)'),
  ('private.reject_studio_media_upload_claimed(uuid,uuid,text)'),
  ('private.finalize_studio_media_upload_claimed(uuid,uuid,text,bigint,integer,integer,text)');

revoke all on table private.studio_media_finalize_claims
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.begin_studio_media_finalize_claim(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.renew_studio_media_finalize_claim(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.release_studio_media_finalize_claim(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.reject_studio_media_upload_claimed(uuid, uuid, text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.finalize_studio_media_upload_claimed(
  uuid, uuid, text, bigint, integer, integer, text
) from public, anon, authenticated, service_role, app_dal;
revoke execute on function private.replay_studio_media_finalize(
  uuid, uuid, uuid, bigint, uuid, uuid
) from app_dal;
revoke execute on function private.get_studio_media_upload_candidate(
  uuid, uuid, uuid, bigint, uuid
) from app_dal;
revoke execute on function private.reject_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text
) from app_dal;
revoke execute on function private.finalize_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid, text, bigint, integer, integer, text
) from app_dal;

grant execute on function private.begin_studio_media_finalize_claim(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid
) to app_dal;
grant execute on function private.renew_studio_media_finalize_claim(uuid) to app_dal;
grant execute on function private.release_studio_media_finalize_claim(uuid) to app_dal;
grant execute on function private.reject_studio_media_upload_claimed(uuid, uuid, text)
  to app_dal;
grant execute on function private.finalize_studio_media_upload_claimed(
  uuid, uuid, text, bigint, integer, integer, text
) to app_dal;

comment on function private.begin_studio_media_finalize_claim(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid
) is
  'Persiste a identidade antes de trabalho externo, serializa uma chave por mídia, adquire lease de 30 s e devolve o candidato somente junto do token cercado.';
comment on function private.renew_studio_media_finalize_claim(uuid) is
  'Renova atomicamente por 30 s a lease ainda vigente antes do upload terminal; token expirado ou substituído não pode ressuscitar.';
comment on function private.release_studio_media_finalize_claim(uuid) is
  'Limpa somente a lease do token atual; tokens antigos não conseguem liberar uma tomada posterior.';
comment on function private.reject_studio_media_upload_claimed(uuid, uuid, text) is
  'Deriva toda identidade mutável do claim cercado e terminaliza a reserva e o tombstone na mesma transação.';
comment on function private.finalize_studio_media_upload_claimed(
  uuid, uuid, text, bigint, integer, integer, text
) is
  'Deriva toda identidade mutável do claim cercado e grava galeria, ledger e tombstone terminal na mesma transação.';
