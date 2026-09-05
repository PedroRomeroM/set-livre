-- FEAT-008 review hardening: a token that was never delivered cannot retain media quota.

alter table public.studio_media
  add column upload_token_issued_at timestamptz;

comment on column public.studio_media.upload_token_issued_at is
  'Primeira autorização de upload confirmada pelo servidor; permanece nula quando nenhum token foi entregue.';

-- Existing rows may represent an upload authorization already delivered by the previous release. Preserve
-- them conservatively so the migration never cancels an in-flight upload.
update public.studio_media as media
set upload_token_issued_at = media.prepared_at
where media.status in ('pending_upload', 'ready', 'rejected');

alter table public.studio_media
  add constraint studio_media_upload_token_issued_at_check check (
    upload_token_issued_at is null
    or upload_token_issued_at between prepared_at and upload_expires_at
  ) not valid;

alter table public.studio_media
  validate constraint studio_media_upload_token_issued_at_check;

alter table public.studio_media
  add constraint studio_media_upload_token_rejection_coherence_check check (
    rejection_code is distinct from 'upload_token_signing_failed'
    or upload_token_issued_at is null
  ) not valid;

alter table public.studio_media
  validate constraint studio_media_upload_token_rejection_coherence_check;

alter table public.studio_media
  drop constraint studio_media_rejection_code_check;

alter table public.studio_media
  add constraint studio_media_rejection_code_check check (
    rejection_code is null
    or rejection_code = any (array[
      'validation_failed'::text,
      'object_missing'::text,
      'superseded'::text,
      'upload_token_signing_failed'::text,
      'mime_mismatch'::text,
      'size_mismatch'::text,
      'checksum_mismatch'::text,
      'decode_failed'::text,
      'dimension_invalid'::text
    ])
  );

create or replace function private.enforce_studio_media_lifecycle() returns trigger
  language plpgsql
  set search_path to ''
as $function$
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
$function$;

alter function private.enforce_studio_media_lifecycle() owner to postgres;

create or replace function private.reject_studio_media_upload(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_media_id uuid,
  p_request_id uuid,
  p_rejection_code text default 'validation_failed'
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
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
$function$;

alter function private.reject_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text
) owner to postgres;

comment on function private.reject_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text
) is
  'Terminaliza a reserva pela identidade persistida; falha de assinatura só vence quando nenhuma autorização foi confirmada.';

create or replace function private.confirm_studio_media_upload_token(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_media_id uuid
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
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
$function$;

alter function private.confirm_studio_media_upload_token(
  uuid, uuid, uuid, bigint, uuid
) owner to postgres;

comment on function private.confirm_studio_media_upload_token(
  uuid, uuid, uuid, bigint, uuid
) is
  'Confirma atomicamente a primeira autorização assinada antes que o token alcance o navegador.';

create or replace function private.reject_unsigned_studio_media_upload(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_media_id uuid,
  p_request_id uuid
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
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
$function$;

alter function private.reject_unsigned_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid
) owner to postgres;

comment on function private.reject_unsigned_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid
) is
  'Compensa uma assinatura não entregue sem cancelar uma autorização confirmada por tentativa concorrente.';

insert into private.dal_routine_allowlist (signature)
values
  ('private.confirm_studio_media_upload_token(uuid,uuid,uuid,bigint,uuid)'),
  ('private.reject_unsigned_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid)');

revoke all on function private.confirm_studio_media_upload_token(
  uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.reject_unsigned_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.reject_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text
) from public, anon, authenticated, service_role, app_dal;

grant execute on function private.confirm_studio_media_upload_token(
  uuid, uuid, uuid, bigint, uuid
) to app_dal;
grant execute on function private.reject_unsigned_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid
) to app_dal;
