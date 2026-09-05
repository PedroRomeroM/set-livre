-- FEAT-008 review hardening: authoritative rejection reasons and cleanup heartbeat.

drop function private.reject_studio_media_upload(uuid, uuid, uuid, bigint, uuid, uuid);

create function private.reject_studio_media_upload(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_media_id uuid,
  p_request_id uuid,
  p_rejection_code text default 'validation_failed'
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
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
    or p_rejection_code <> all (array['validation_failed'::text, 'object_missing'::text])
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_reject';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('studio-media-reject:' || p_media_id::text, 0)
  );
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
  if media.status not in ('pending_upload', 'rejected') then
    raise exception using errcode = '40001', message = 'studio_media_reject_conflict';
  end if;

  if media.status = 'pending_upload' then
    update public.studio_media as candidate
    set
      status = 'rejected',
      rejection_code = p_rejection_code,
      rejected_at = rejected_time,
      cleanup_after = greatest(rejected_time, media.upload_expires_at),
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
        'revisionId', draft_revision_id,
        'revisionVersion', draft_revision_version,
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
    'revisionId', draft_revision_id,
    'revisionVersion', draft_revision_version,
    'mediaId', p_media_id,
    'status', 'rejected',
    'rejectionCode', p_rejection_code,
    'rejectedAt', rejected_time
  );
  return result;
end;
$function$;

alter function private.reject_studio_media_upload(uuid, uuid, uuid, bigint, uuid, uuid, text)
  owner to postgres;

delete from private.dal_routine_allowlist
where signature = 'private.reject_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid)';
insert into private.dal_routine_allowlist (signature)
values ('private.reject_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid,text)');

revoke all on function private.reject_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function private.reject_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text
) to app_dal;

comment on function private.reject_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text
) is
  'Terminaliza uma reserva pendente com motivo server-side permitido; replay preserva o primeiro fato e libera a quota imediatamente.';

create or replace function private.studio_media_cleanup_runs_are_healthy()
returns boolean
  language sql stable security definer
  set search_path to ''
as $function$
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
$function$;

alter function private.studio_media_cleanup_runs_are_healthy() owner to postgres;
revoke all on function private.studio_media_cleanup_runs_are_healthy()
  from public, anon, authenticated, service_role, app_dal;

comment on function private.studio_media_cleanup_runs_are_healthy() is
  'Fail-closed quando falta sucesso terminal recente, existe execução envelhecida ou uma falha posterior ao último sucesso.';
