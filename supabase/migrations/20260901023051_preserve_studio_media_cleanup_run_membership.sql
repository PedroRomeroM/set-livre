-- Preserve immutable run membership before a cleanup lease can be reused.
-- Mutable claim/last-completion tokens remain the current item state, while this
-- ledger is the historical source used to terminalize interrupted executions.

create table maintenance.studio_media_cleanup_run_items (
  run_id uuid not null
    references maintenance.studio_media_cleanup_runs (run_id) on delete cascade,
  item_kind text not null,
  media_id uuid not null,
  outcome text,
  claimed_at timestamptz not null,
  completed_at timestamptz,
  constraint studio_media_cleanup_run_items_pkey
    primary key (run_id, item_kind, media_id),
  constraint studio_media_cleanup_run_items_kind_check check (
    item_kind in ('media', 'probe')
  ),
  constraint studio_media_cleanup_run_items_outcome_check check (
    outcome is null or outcome in ('deleted', 'failed')
  ),
  constraint studio_media_cleanup_run_items_state_check check (
    (outcome is null and completed_at is null)
    or (outcome is not null and completed_at is not null)
  ),
  constraint studio_media_cleanup_run_items_timestamps_check check (
    completed_at is null or completed_at >= claimed_at
  )
);

alter table maintenance.studio_media_cleanup_run_items owner to postgres;
alter table maintenance.studio_media_cleanup_run_items enable row level security;
revoke all on table maintenance.studio_media_cleanup_run_items
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;

comment on table maintenance.studio_media_cleanup_run_items is
  'Pertencimento histórico imutável por execução; preserva contagens mesmo depois de outro run reutilizar o lease do item.';
comment on column maintenance.studio_media_cleanup_run_items.item_kind is
  'Discrimina mídia de produto e probe operacional sem criar FK polimórfica.';
comment on column maintenance.studio_media_cleanup_run_items.outcome is
  'Resultado observado pelo run original; null é convertido em failed quando o run termina ou é abandonado.';

create or replace function maintenance.enforce_studio_media_cleanup_run_item_lifecycle()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if old.run_id is distinct from new.run_id
    or old.item_kind is distinct from new.item_kind
    or old.media_id is distinct from new.media_id
    or old.claimed_at is distinct from new.claimed_at
    or old.outcome is not null
    or (
      new.outcome is null
      or new.completed_at is null
    )
  then
    raise exception using
      errcode = '23514',
      message = 'studio_media_cleanup_run_item_immutable';
  end if;

  return new;
end;
$function$;

alter function maintenance.enforce_studio_media_cleanup_run_item_lifecycle()
  owner to postgres;
revoke all on function maintenance.enforce_studio_media_cleanup_run_item_lifecycle()
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;

create trigger studio_media_cleanup_run_items_enforce_lifecycle
  before update on maintenance.studio_media_cleanup_run_items
  for each row execute function maintenance.enforce_studio_media_cleanup_run_item_lifecycle();

create or replace function maintenance.persist_studio_media_cleanup_run_items(
  p_run_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path to ''
as $function$
begin
  if p_run_id is null or not exists (
    select 1
    from maintenance.studio_media_cleanup_runs as run
    where run.run_id = p_run_id
      and run.status = 'running'
  ) then
    raise exception using
      errcode = '40001',
      message = 'studio_media_cleanup_run_not_running';
  end if;

  insert into maintenance.studio_media_cleanup_run_items (
    run_id,
    item_kind,
    media_id,
    claimed_at
  )
  select
    p_run_id,
    'media',
    media.id,
    media.cleanup_claimed_at
  from public.studio_media as media
  where media.cleanup_claim_token = p_run_id
    and media.cleanup_claimed_at is not null
  on conflict (run_id, item_kind, media_id) do nothing;

  insert into maintenance.studio_media_cleanup_run_items (
    run_id,
    item_kind,
    media_id,
    claimed_at
  )
  select
    p_run_id,
    'probe',
    probe.media_id,
    probe.cleanup_claimed_at
  from maintenance.studio_media_cleanup_probes as probe
  where probe.cleanup_claim_token = p_run_id
    and probe.cleanup_claimed_at is not null
  on conflict (run_id, item_kind, media_id) do nothing;

  insert into maintenance.studio_media_cleanup_run_items (
    run_id,
    item_kind,
    media_id,
    outcome,
    claimed_at,
    completed_at
  )
  select
    p_run_id,
    'media',
    media.id,
    case when media.cleanup_last_succeeded then 'deleted' else 'failed' end,
    run.started_at,
    greatest(media.updated_at, run.started_at)
  from public.studio_media as media
  join maintenance.studio_media_cleanup_runs as run on run.run_id = p_run_id
  where media.cleanup_last_completed_token = p_run_id
    and media.cleanup_last_succeeded is not null
  on conflict (run_id, item_kind, media_id) do update
  set
    outcome = excluded.outcome,
    completed_at = excluded.completed_at
  where maintenance.studio_media_cleanup_run_items.outcome is null;

  insert into maintenance.studio_media_cleanup_run_items (
    run_id,
    item_kind,
    media_id,
    outcome,
    claimed_at,
    completed_at
  )
  select
    p_run_id,
    'probe',
    probe.media_id,
    case when probe.cleanup_last_succeeded then 'deleted' else 'failed' end,
    run.started_at,
    greatest(probe.updated_at, run.started_at)
  from maintenance.studio_media_cleanup_probes as probe
  join maintenance.studio_media_cleanup_runs as run on run.run_id = p_run_id
  where probe.cleanup_last_completed_token = p_run_id
    and probe.cleanup_last_succeeded is not null
  on conflict (run_id, item_kind, media_id) do update
  set
    outcome = excluded.outcome,
    completed_at = excluded.completed_at
  where maintenance.studio_media_cleanup_run_items.outcome is null;
end;
$function$;

alter function maintenance.persist_studio_media_cleanup_run_items(uuid) owner to postgres;
revoke all on function maintenance.persist_studio_media_cleanup_run_items(uuid)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;

create or replace function maintenance.track_studio_media_cleanup_membership()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  completed_outcome text;
begin
  if new.cleanup_claim_token is not null
    and new.cleanup_claimed_at is not null
    and (
      tg_op = 'INSERT'
      or new.cleanup_claim_token is distinct from old.cleanup_claim_token
      or new.cleanup_claimed_at is distinct from old.cleanup_claimed_at
    )
  then
    insert into maintenance.studio_media_cleanup_run_items (
      run_id,
      item_kind,
      media_id,
      claimed_at
    )
    select
      new.cleanup_claim_token,
      'media',
      new.id,
      new.cleanup_claimed_at
    from maintenance.studio_media_cleanup_runs as run
    where run.run_id = new.cleanup_claim_token
      and run.status = 'running'
    on conflict (run_id, item_kind, media_id) do nothing;
  end if;

  if new.cleanup_last_completed_token is not null
    and new.cleanup_last_succeeded is not null
    and (
      tg_op = 'INSERT'
      or new.cleanup_last_completed_token is distinct from old.cleanup_last_completed_token
      or new.cleanup_last_succeeded is distinct from old.cleanup_last_succeeded
    )
  then
    completed_outcome := case
      when new.cleanup_last_succeeded then 'deleted'
      else 'failed'
    end;

    if tg_op = 'INSERT' then
      insert into maintenance.studio_media_cleanup_run_items (
        run_id,
        item_kind,
        media_id,
        outcome,
        claimed_at,
        completed_at
      )
      select
        new.cleanup_last_completed_token,
        'media',
        new.id,
        completed_outcome,
        run.started_at,
        greatest(new.updated_at, run.started_at)
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id = new.cleanup_last_completed_token
        and run.status = 'running'
      on conflict (run_id, item_kind, media_id) do update
      set
        outcome = excluded.outcome,
        completed_at = excluded.completed_at
      where maintenance.studio_media_cleanup_run_items.outcome is null;
    end if;

    update maintenance.studio_media_cleanup_run_items as item
    set
      outcome = completed_outcome,
      completed_at = greatest(
        pg_catalog.clock_timestamp(),
        item.claimed_at
      )
    where item.run_id = new.cleanup_last_completed_token
      and item.item_kind = 'media'
      and item.media_id = new.id
      and item.outcome is null;

    if not found and exists (
      select 1
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id = new.cleanup_last_completed_token
        and run.status = 'running'
    ) and not exists (
      select 1
      from maintenance.studio_media_cleanup_run_items as item
      where item.run_id = new.cleanup_last_completed_token
        and item.item_kind = 'media'
        and item.media_id = new.id
        and item.outcome = completed_outcome
    ) then
      raise exception using
        errcode = '40001',
        message = 'studio_media_cleanup_run_item_history_missing';
    end if;
  end if;

  return new;
end;
$function$;

alter function maintenance.track_studio_media_cleanup_membership() owner to postgres;
revoke all on function maintenance.track_studio_media_cleanup_membership()
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;

create trigger studio_media_track_cleanup_membership
  after insert or update on public.studio_media
  for each row execute function maintenance.track_studio_media_cleanup_membership();

create or replace function maintenance.track_studio_media_cleanup_probe_membership()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  completed_outcome text;
begin
  if new.cleanup_claim_token is not null
    and new.cleanup_claimed_at is not null
    and (
      tg_op = 'INSERT'
      or new.cleanup_claim_token is distinct from old.cleanup_claim_token
      or new.cleanup_claimed_at is distinct from old.cleanup_claimed_at
    )
  then
    insert into maintenance.studio_media_cleanup_run_items (
      run_id,
      item_kind,
      media_id,
      claimed_at
    )
    select
      new.cleanup_claim_token,
      'probe',
      new.media_id,
      new.cleanup_claimed_at
    from maintenance.studio_media_cleanup_runs as run
    where run.run_id = new.cleanup_claim_token
      and run.status = 'running'
    on conflict (run_id, item_kind, media_id) do nothing;
  end if;

  if new.cleanup_last_completed_token is not null
    and new.cleanup_last_succeeded is not null
    and (
      tg_op = 'INSERT'
      or new.cleanup_last_completed_token is distinct from old.cleanup_last_completed_token
      or new.cleanup_last_succeeded is distinct from old.cleanup_last_succeeded
    )
  then
    completed_outcome := case
      when new.cleanup_last_succeeded then 'deleted'
      else 'failed'
    end;

    if tg_op = 'INSERT' then
      insert into maintenance.studio_media_cleanup_run_items (
        run_id,
        item_kind,
        media_id,
        outcome,
        claimed_at,
        completed_at
      )
      select
        new.cleanup_last_completed_token,
        'probe',
        new.media_id,
        completed_outcome,
        run.started_at,
        greatest(new.updated_at, run.started_at)
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id = new.cleanup_last_completed_token
        and run.status = 'running'
      on conflict (run_id, item_kind, media_id) do update
      set
        outcome = excluded.outcome,
        completed_at = excluded.completed_at
      where maintenance.studio_media_cleanup_run_items.outcome is null;
    end if;

    update maintenance.studio_media_cleanup_run_items as item
    set
      outcome = completed_outcome,
      completed_at = greatest(
        pg_catalog.clock_timestamp(),
        item.claimed_at
      )
    where item.run_id = new.cleanup_last_completed_token
      and item.item_kind = 'probe'
      and item.media_id = new.media_id
      and item.outcome is null;

    if not found and exists (
      select 1
      from maintenance.studio_media_cleanup_runs as run
      where run.run_id = new.cleanup_last_completed_token
        and run.status = 'running'
    ) and not exists (
      select 1
      from maintenance.studio_media_cleanup_run_items as item
      where item.run_id = new.cleanup_last_completed_token
        and item.item_kind = 'probe'
        and item.media_id = new.media_id
        and item.outcome = completed_outcome
    ) then
      raise exception using
        errcode = '40001',
        message = 'studio_media_cleanup_run_item_history_missing';
    end if;
  end if;

  return new;
end;
$function$;

alter function maintenance.track_studio_media_cleanup_probe_membership() owner to postgres;
revoke all on function maintenance.track_studio_media_cleanup_probe_membership()
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;

create trigger studio_media_cleanup_probes_track_membership
  after insert or update on maintenance.studio_media_cleanup_probes
  for each row execute function maintenance.track_studio_media_cleanup_probe_membership();

-- Backfill any execution that was already running while this migration was applied.
select maintenance.persist_studio_media_cleanup_run_items(run.run_id)
from maintenance.studio_media_cleanup_runs as run
where run.status = 'running';

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
    for update
  )
  update maintenance.studio_media_cleanup_run_items as item
  set
    outcome = 'failed',
    completed_at = run_started_at
  from abandoned_runs as abandoned
  where item.run_id = abandoned.run_id
    and item.outcome is null;

  with abandoned_runs as materialized (
    select abandoned.run_id
    from maintenance.studio_media_cleanup_runs as abandoned
    where abandoned.run_id <> p_run_id
      and abandoned.status = 'running'
      and abandoned.started_at <= abandoned_cutoff
  ), abandoned_counts as (
    select
      abandoned.run_id,
      pg_catalog.count(item.media_id)::integer as claimed_count,
      (
        pg_catalog.count(item.media_id)
          filter (where item.outcome = 'deleted')
      )::integer as deleted_count,
      (
        pg_catalog.count(item.media_id)
          filter (where item.outcome = 'failed')
      )::integer as failed_count
    from abandoned_runs as abandoned
    left join maintenance.studio_media_cleanup_run_items as item
      on item.run_id = abandoned.run_id
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

  if run.status = 'running' then
    perform maintenance.persist_studio_media_cleanup_run_items(run.run_id);
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
  'Cria ou relê um run, persiste seu conjunto de itens e abandona runs envelhecidos a partir do histórico imutável antes de purgar terminais antigos.';

create or replace function maintenance.complete_studio_media_cleanup_run(
  p_run_id uuid,
  p_status text,
  p_claimed integer,
  p_deleted integer,
  p_failed integer,
  p_error_code text
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
declare
  run maintenance.studio_media_cleanup_runs%rowtype;
  completion_time timestamptz := pg_catalog.clock_timestamp();
  historical_claimed integer;
  historical_deleted integer;
  historical_failed integer;
begin
  if p_run_id is null
    or p_status is null
    or p_status not in ('succeeded', 'failed')
    or p_claimed is null
    or p_claimed < 0
    or p_deleted is null
    or p_deleted < 0
    or p_failed is null
    or p_failed < 0
    or p_claimed <> p_deleted + p_failed
    or (
      p_status = 'succeeded'
      and (p_failed <> 0 or p_error_code is not null)
    )
    or (
      p_status = 'failed'
      and (p_error_code is null or p_error_code !~ '^[a-z0-9_]{2,80}$')
    )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_studio_media_cleanup_run_completion';
  end if;

  select candidate.*
  into run
  from maintenance.studio_media_cleanup_runs as candidate
  where candidate.run_id = p_run_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_cleanup_run_not_found';
  end if;

  if run.status in ('succeeded', 'failed') then
    if run.status <> p_status
      or run.claimed_count <> p_claimed
      or run.deleted_count <> p_deleted
      or run.failed_count <> p_failed
      or run.error_code is distinct from p_error_code
    then
      raise exception using
        errcode = '40001',
        message = 'studio_media_cleanup_run_completion_conflict';
    end if;
  elsif run.status = 'running' then
    update maintenance.studio_media_cleanup_run_items as item
    set
      outcome = 'failed',
      completed_at = completion_time
    where item.run_id = run.run_id
      and item.outcome is null;

    select
      pg_catalog.count(*)::integer,
      (pg_catalog.count(*) filter (where item.outcome = 'deleted'))::integer,
      (pg_catalog.count(*) filter (where item.outcome = 'failed'))::integer
    into historical_claimed, historical_deleted, historical_failed
    from maintenance.studio_media_cleanup_run_items as item
    where item.run_id = run.run_id;

    if historical_claimed <> p_claimed
      or historical_deleted <> p_deleted
      or historical_failed <> p_failed
    then
      raise exception using
        errcode = '40001',
        message = 'studio_media_cleanup_run_membership_conflict';
    end if;

    update maintenance.studio_media_cleanup_runs as candidate
    set
      status = p_status,
      claimed_count = historical_claimed,
      deleted_count = historical_deleted,
      failed_count = historical_failed,
      error_code = p_error_code,
      completed_at = completion_time
    where candidate.run_id = run.run_id
    returning candidate.* into run;
  else
    raise exception using
      errcode = '40001',
      message = 'studio_media_cleanup_run_not_started';
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

alter function maintenance.complete_studio_media_cleanup_run(
  uuid, text, integer, integer, integer, text
) owner to postgres;
revoke all on function maintenance.complete_studio_media_cleanup_run(
  uuid, text, integer, integer, integer, text
) from public, anon, authenticated, service_role, app_dal, app_runtime_production;

comment on function maintenance.complete_studio_media_cleanup_run(
  uuid, text, integer, integer, integer, text
) is 'Conclui o ledger somente quando as contagens do worker coincidem com o pertencimento histórico persistido.';
