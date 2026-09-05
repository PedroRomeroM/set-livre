-- Renew replay reservations under row locks before exposing deletion paths.
create or replace function maintenance.enforce_studio_media_cleanup_probe_lifecycle()
returns trigger
  language plpgsql
  set search_path to ''
as $function$
begin
  if old.run_id is distinct from new.run_id
    or old.media_id is distinct from new.media_id
    or old.storage_bucket is distinct from new.storage_bucket
    or old.storage_path is distinct from new.storage_path
    or old.preview_storage_path is distinct from new.preview_storage_path
    or old.prepared_at is distinct from new.prepared_at
  then
    raise exception using
      errcode = '23514',
      message = 'studio_media_cleanup_probe_immutable';
  end if;

  if not (
    (old.status = 'prepared' and new.status in ('queued', 'aborted'))
    or (old.status = 'queued' and new.status in ('deleted', 'aborted'))
    or (
      old.status = 'queued' and new.status = 'queued'
      and old.cleanup_claim_token is not null
      and new.cleanup_claimed_at > old.cleanup_claimed_at
      and (pg_catalog.to_jsonb(new) - array['cleanup_claimed_at', 'updated_at'])
        = (pg_catalog.to_jsonb(old) - array['cleanup_claimed_at', 'updated_at'])
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'studio_media_cleanup_probe_transition_invalid';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

alter function maintenance.enforce_studio_media_cleanup_probe_lifecycle() owner to postgres;

create or replace function maintenance.claim_studio_media_cleanup(
  p_claim_token uuid,
  p_limit integer
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  claimed_at timestamptz;
  items jsonb;
  has_membership boolean;
begin
  if p_claim_token is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_studio_media_cleanup_claim';
  end if;

  -- A replay can overlap the transaction whose HTTP response was lost.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('studio-media-cleanup-claim:' || p_claim_token::text, 0)
  );
  select exists (
    select 1 from maintenance.studio_media_cleanup_run_items as item
    where item.run_id = p_claim_token
  ) into has_membership;

  -- Lock current ownership, then refresh the full lease. Different-token claims
  -- SKIP LOCKED until commit and see the renewed timestamp afterwards. Never
  -- resurrect a transferred token or renew a historical terminal member.
  -- Keep media -> membership lock order used by the completion triggers.
  with reserved as (
    select media.id
    from public.studio_media as media
    where media.status = 'delete_pending'
      and media.cleanup_claim_token = p_claim_token
      and (not has_membership or exists (
        select 1 from maintenance.studio_media_cleanup_run_items as item
        where item.run_id = p_claim_token and item.item_kind = 'media'
          and item.media_id = media.id and item.outcome is null
      ))
    order by media.id
    for update of media
  )
  update public.studio_media as media
  set cleanup_claimed_at = pg_catalog.clock_timestamp()
  from reserved
  where media.id = reserved.id
    and media.status = 'delete_pending'
    and media.cleanup_claim_token = p_claim_token;

  with reserved as (
    select probe.media_id
    from maintenance.studio_media_cleanup_probes as probe
    where probe.status = 'queued'
      and probe.cleanup_claim_token = p_claim_token
      and (not has_membership or exists (
        select 1 from maintenance.studio_media_cleanup_run_items as item
        where item.run_id = p_claim_token and item.item_kind = 'probe'
          and item.media_id = probe.media_id and item.outcome is null
      ))
    order by probe.media_id
    for update of probe
  )
  update maintenance.studio_media_cleanup_probes as probe
  set cleanup_claimed_at = pg_catalog.clock_timestamp()
  from reserved
  where probe.media_id = reserved.media_id
    and probe.status = 'queued'
    and probe.cleanup_claim_token = p_claim_token;

  claimed_at := pg_catalog.clock_timestamp();

  -- The immutable run membership survives clearing mutable completion tokens.
  -- Never append another batch when a replay already has persisted members.
  if has_membership then
    select pg_catalog.jsonb_agg(
      case
        when item.outcome is not null then pg_catalog.jsonb_build_object(
          'mediaId', item.media_id, 'outcome', item.outcome
        )
        when media.id is not null then pg_catalog.jsonb_build_object(
          'mediaId', media.id, 'bucket', media.storage_bucket,
          'paths', pg_catalog.jsonb_build_array(media.storage_path, media.preview_storage_path),
          'attempt', media.cleanup_attempts
        )
        when probe.media_id is not null then pg_catalog.jsonb_build_object(
          'mediaId', probe.media_id, 'bucket', probe.storage_bucket,
          'paths', pg_catalog.jsonb_build_array(probe.storage_path, probe.preview_storage_path),
          'attempt', 1
        )
        else null
      end order by item.media_id
    )
    into items
    from maintenance.studio_media_cleanup_run_items as item
    left join public.studio_media as media
      on item.item_kind = 'media' and item.outcome is null
      and media.id = item.media_id and media.status = 'delete_pending'
      and media.cleanup_claim_token = p_claim_token
    left join maintenance.studio_media_cleanup_probes as probe
      on item.item_kind = 'probe' and item.outcome is null
      and probe.media_id = item.media_id and probe.status = 'queued'
      and probe.cleanup_claim_token = p_claim_token
    where item.run_id = p_claim_token;

    if items @> '[null]'::jsonb then
      -- Another run owns an expired lease: do not touch its objects or invent totals.
      raise exception using errcode = '40001', message = 'studio_media_cleanup_replay_lease_lost';
    end if;
    return pg_catalog.jsonb_build_object('claimToken', p_claim_token, 'items', items);
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'mediaId', reserved.media_id,
      'bucket', reserved.storage_bucket,
      'paths', pg_catalog.jsonb_build_array(
        reserved.storage_path,
        reserved.preview_storage_path
      ),
      'attempt', reserved.cleanup_attempts
    ) order by reserved.media_id
  )
  into items
  from (
    select
      media.id as media_id,
      media.storage_bucket,
      media.storage_path,
      media.preview_storage_path,
      media.cleanup_attempts
    from public.studio_media as media
    where media.status = 'delete_pending'
      and media.cleanup_claim_token = p_claim_token
      and media.cleanup_claimed_at > claimed_at - interval '15 minutes'
    union all
    select
      probe.media_id,
      probe.storage_bucket,
      probe.storage_path,
      probe.preview_storage_path,
      1 as cleanup_attempts
    from maintenance.studio_media_cleanup_probes as probe
    where probe.status = 'queued'
      and probe.cleanup_claim_token = p_claim_token
  ) as reserved;

  if items is not null then
    return pg_catalog.jsonb_build_object('claimToken', p_claim_token, 'items', items);
  end if;

  with candidates as (
    select media.id
    from public.studio_media as media
    where media.status in ('pending_upload', 'rejected', 'delete_pending')
      and coalesce(media.cleanup_next_attempt_at, media.cleanup_after) <= claimed_at
      and (
        media.cleanup_claimed_at is null
        or media.cleanup_claimed_at <= claimed_at - interval '15 minutes'
      )
    order by coalesce(media.cleanup_next_attempt_at, media.cleanup_after), media.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.studio_media as media
    set
      status = 'delete_pending',
      delete_requested_at = coalesce(media.delete_requested_at, claimed_at),
      cleanup_after = coalesce(media.cleanup_after, claimed_at),
      cleanup_claim_token = p_claim_token,
      cleanup_claimed_at = claimed_at,
      cleanup_next_attempt_at = null,
      cleanup_attempts = media.cleanup_attempts + 1
    from candidates
    where media.id = candidates.id
    returning
      media.id,
      media.storage_bucket,
      media.storage_path,
      media.preview_storage_path,
      media.cleanup_attempts
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'mediaId', claimed.id,
        'bucket', claimed.storage_bucket,
        'paths', pg_catalog.jsonb_build_array(
          claimed.storage_path,
          claimed.preview_storage_path
        ),
        'attempt', claimed.cleanup_attempts
      ) order by claimed.id
    ),
    '[]'::jsonb
  )
  into items
  from claimed;

  return pg_catalog.jsonb_build_object('claimToken', p_claim_token, 'items', items);
end;
$function$;

alter function maintenance.claim_studio_media_cleanup(uuid, integer) owner to postgres;
