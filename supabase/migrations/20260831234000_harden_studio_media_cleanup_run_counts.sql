-- Preserve the item-level evidence already committed when a cleanup run is abandoned.
-- A still-claimed item becomes a failed item in the terminal ledger so every abandoned
-- run continues to satisfy claimed = deleted + failed without inventing zero work.

create or replace function maintenance.begin_studio_media_cleanup_run(
  p_run_id uuid,
  p_function_slug text
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
declare
  run maintenance.studio_media_cleanup_runs%rowtype;
  run_started_at timestamptz := pg_catalog.clock_timestamp();
  retention_cutoff timestamptz := run_started_at - interval '30 days';
  abandoned_cutoff timestamptz := run_started_at - interval '30 minutes';
begin
  if p_run_id is null
    or p_function_slug is null
    or p_function_slug !~ '^media-cleanup-[0-9a-f]{40}$'
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_studio_media_cleanup_run_begin';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('studio-media-cleanup-run-ledger', 0)
  );

  with abandoned_runs as materialized (
    select abandoned.run_id
    from maintenance.studio_media_cleanup_runs as abandoned
    where abandoned.run_id <> p_run_id
      and abandoned.status = 'running'
      and abandoned.started_at <= abandoned_cutoff
  ), abandoned_item_outcomes as materialized (
    select
      abandoned.run_id,
      case
        when media.cleanup_last_completed_token = abandoned.run_id
          and media.cleanup_last_succeeded is true
        then 'deleted'::text
        else 'failed'::text
      end as outcome
    from abandoned_runs as abandoned
    join public.studio_media as media
      on media.cleanup_claim_token = abandoned.run_id
      or media.cleanup_last_completed_token = abandoned.run_id

    union all

    select
      abandoned.run_id,
      case
        when probe.cleanup_last_completed_token = abandoned.run_id
          and probe.cleanup_last_succeeded is true
        then 'deleted'::text
        else 'failed'::text
      end as outcome
    from abandoned_runs as abandoned
    join maintenance.studio_media_cleanup_probes as probe
      on probe.cleanup_claim_token = abandoned.run_id
      or probe.cleanup_last_completed_token = abandoned.run_id
  ), abandoned_counts as (
    select
      abandoned.run_id,
      pg_catalog.count(item.outcome)::integer as claimed_count,
      (
        pg_catalog.count(item.outcome)
          filter (where item.outcome = 'deleted')
      )::integer as deleted_count,
      (
        pg_catalog.count(item.outcome)
          filter (where item.outcome = 'failed')
      )::integer as failed_count
    from abandoned_runs as abandoned
    left join abandoned_item_outcomes as item on item.run_id = abandoned.run_id
    group by abandoned.run_id
  )
  update maintenance.studio_media_cleanup_runs as abandoned
  set
    status = 'failed',
    claimed_count = counts.claimed_count,
    deleted_count = counts.deleted_count,
    failed_count = counts.failed_count,
    error_code = 'cleanup_run_abandoned',
    completed_at = run_started_at
  from abandoned_counts as counts
  where abandoned.run_id = counts.run_id
    and abandoned.status = 'running'
    and abandoned.started_at <= abandoned_cutoff;

  delete from maintenance.studio_media_cleanup_runs as expired
  where expired.run_id <> p_run_id
    and expired.status in ('succeeded', 'failed')
    and expired.completed_at < retention_cutoff;

  delete from maintenance.studio_media_cleanup_probes as expired
  where expired.run_id <> p_run_id
    and expired.status in ('deleted', 'aborted')
    and expired.completed_at < retention_cutoff;

  select candidate.*
  into run
  from maintenance.studio_media_cleanup_runs as candidate
  where candidate.run_id = p_run_id
  for update;

  if found then
    if run.function_slug <> p_function_slug then
      raise exception using
        errcode = '40001',
        message = 'studio_media_cleanup_run_begin_conflict';
    end if;
  else
    insert into maintenance.studio_media_cleanup_runs (
      run_id,
      function_slug,
      status,
      started_at,
      updated_at
    )
    values (
      p_run_id,
      p_function_slug,
      'running',
      run_started_at,
      run_started_at
    )
    returning * into run;
  end if;

  return pg_catalog.jsonb_build_object(
    'runId', run.run_id,
    'functionSlug', run.function_slug,
    'status', run.status,
    'claimed', run.claimed_count,
    'deleted', run.deleted_count,
    'failed', run.failed_count,
    'errorCode', run.error_code
  );
end;
$function$;

alter function maintenance.begin_studio_media_cleanup_run(uuid, text) owner to postgres;
revoke all on function maintenance.begin_studio_media_cleanup_run(uuid, text)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;

comment on function maintenance.begin_studio_media_cleanup_run(uuid, text) is
  'Cria ou relê um run, abandona runs envelhecidos com contagens derivadas dos tokens persistidos e purga somente terminais com mais de 30 dias.';
