-- FEAT-008: objetos de mídia imutáveis, associações versionadas e cleanup via Storage API.
-- O bucket privado `studio-media` e o agendamento externo são provisionados por configuração/API.
-- A migration cria somente o contrato relacional e as fronteiras server-only; as roles da aplicação
-- não recebem paths, policies de Storage ou acesso aos schemas operacionais.

create schema if not exists maintenance authorization postgres;
alter schema maintenance owner to postgres;
revoke all on schema maintenance
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
create table maintenance.studio_media_cleanup_runs (
  run_id uuid primary key,
  function_slug text not null,
  status text not null,
  claimed_count integer,
  deleted_count integer,
  failed_count integer,
  error_code text,
  started_at timestamptz not null,
  completed_at timestamptz,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint studio_media_cleanup_runs_slug_check check (
    function_slug ~ '^media-cleanup-[0-9a-f]{40}$'
  ),
  constraint studio_media_cleanup_runs_status_check check (
    status in ('running', 'succeeded', 'failed')
  ),
  constraint studio_media_cleanup_runs_counts_check check (
    (claimed_count is null and deleted_count is null and failed_count is null)
    or (
      claimed_count >= 0
      and deleted_count >= 0
      and failed_count >= 0
      and claimed_count = deleted_count + failed_count
    )
  ),
  constraint studio_media_cleanup_runs_error_check check (
    error_code is null or error_code ~ '^[a-z0-9_]{2,80}$'
  ),
  constraint studio_media_cleanup_runs_state_check check (
    (
      status = 'running'
      and completed_at is null
      and claimed_count is null
      and deleted_count is null
      and failed_count is null
      and error_code is null
    )
    or (
      status = 'succeeded'
      and started_at is not null
      and completed_at is not null
      and claimed_count is not null
      and deleted_count is not null
      and failed_count = 0
      and claimed_count = deleted_count
      and error_code is null
    )
    or (
      status = 'failed'
      and started_at is not null
      and completed_at is not null
      and claimed_count is not null
      and deleted_count is not null
      and failed_count is not null
      and claimed_count = deleted_count + failed_count
      and error_code is not null
    )
  ),
  constraint studio_media_cleanup_runs_timestamps_check check (
    updated_at >= started_at
    and (completed_at is null or completed_at >= started_at)
  )
);

alter table maintenance.studio_media_cleanup_runs owner to postgres;
alter table maintenance.studio_media_cleanup_runs enable row level security;
create index studio_media_cleanup_runs_active_age_idx
  on maintenance.studio_media_cleanup_runs (started_at)
  where status = 'running';
create index studio_media_cleanup_runs_terminal_completed_idx
  on maintenance.studio_media_cleanup_runs (status, completed_at desc)
  where status in ('succeeded', 'failed');

create table maintenance.studio_media_cleanup_probes (
  run_id uuid primary key,
  media_id uuid not null unique,
  storage_bucket text not null default 'studio-media',
  storage_path text not null unique,
  preview_storage_path text not null unique,
  status text not null default 'prepared',
  cleanup_claim_token uuid,
  cleanup_claimed_at timestamptz,
  cleanup_last_completed_token uuid,
  cleanup_last_succeeded boolean,
  error_code text,
  prepared_at timestamptz not null default pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint studio_media_cleanup_probes_bucket_check check (
    storage_bucket = 'studio-media'
  ),
  constraint studio_media_cleanup_probes_path_check check (
    storage_path = pg_catalog.format(
      'owners/%s/studios/%s/revisions/%s/%s.webp',
      run_id,
      run_id,
      run_id,
      media_id
    )
    and preview_storage_path = pg_catalog.format(
      'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
      run_id,
      run_id,
      run_id,
      media_id
    )
  ),
  constraint studio_media_cleanup_probes_status_check check (
    status in ('prepared', 'queued', 'deleted', 'aborted')
  ),
  constraint studio_media_cleanup_probes_error_check check (
    error_code is null or error_code ~ '^[a-z0-9_]{2,80}$'
  ),
  constraint studio_media_cleanup_probes_state_check check (
    (
      status = 'prepared'
      and cleanup_claim_token is null
      and cleanup_claimed_at is null
      and cleanup_last_completed_token is null
      and cleanup_last_succeeded is null
      and error_code is null
      and completed_at is null
    )
    or (
      status = 'queued'
      and cleanup_claim_token = run_id
      and cleanup_claimed_at is not null
      and cleanup_last_completed_token is null
      and cleanup_last_succeeded is null
      and error_code is null
      and completed_at is null
    )
    or (
      status = 'deleted'
      and cleanup_claim_token is null
      and cleanup_claimed_at is null
      and cleanup_last_completed_token = run_id
      and cleanup_last_succeeded is true
      and error_code is null
      and completed_at is not null
    )
    or (
      status = 'aborted'
      and cleanup_claim_token is null
      and cleanup_claimed_at is null
      and cleanup_last_completed_token = run_id
      and cleanup_last_succeeded is false
      and error_code is not null
      and completed_at is not null
    )
  ),
  constraint studio_media_cleanup_probes_timestamps_check check (
    updated_at >= prepared_at
    and (cleanup_claimed_at is null or cleanup_claimed_at >= prepared_at)
    and (completed_at is null or completed_at >= prepared_at)
  )
);

alter table maintenance.studio_media_cleanup_probes owner to postgres;
alter table maintenance.studio_media_cleanup_probes enable row level security;
create index studio_media_cleanup_probes_terminal_completed_idx
  on maintenance.studio_media_cleanup_probes (completed_at)
  where status in ('deleted', 'aborted');

create table public.studio_media (
  id uuid primary key default extensions.gen_random_uuid(),
  studio_id uuid,
  prepared_revision_id uuid,
  uploaded_by uuid not null,
  storage_bucket text not null default 'studio-media',
  storage_path text not null unique,
  preview_storage_path text not null unique,
  declared_mime_type text not null,
  declared_size_bytes bigint not null,
  declared_checksum_sha256 text,
  actual_mime_type text,
  actual_size_bytes bigint,
  width integer,
  height integer,
  checksum_sha256 text,
  status text not null default 'pending_upload',
  rejection_code text,
  prepared_at timestamptz not null default pg_catalog.clock_timestamp(),
  upload_expires_at timestamptz not null,
  cleanup_after timestamptz,
  finalized_at timestamptz,
  rejected_at timestamptz,
  delete_requested_at timestamptz,
  deleted_at timestamptz,
  cleanup_attempts integer not null default 0,
  cleanup_claim_token uuid,
  cleanup_claimed_at timestamptz,
  cleanup_next_attempt_at timestamptz,
  cleanup_last_completed_token uuid,
  cleanup_last_succeeded boolean,
  cleanup_last_error_code text,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint studio_media_studio_id_fkey foreign key (studio_id)
    references public.studios (id) on delete set null,
  constraint studio_media_prepared_revision_id_fkey foreign key (prepared_revision_id)
    references public.studio_revisions (id) on delete set null,
  constraint studio_media_uploaded_by_fkey foreign key (uploaded_by)
    references public.profiles (id) on delete restrict,
  constraint studio_media_bucket_check check (storage_bucket = 'studio-media'),
  constraint studio_media_path_identity_check check (
    storage_path = pg_catalog.btrim(storage_path)
    and pg_catalog.split_part(storage_path, '/', 1) = 'owners'
    and pg_catalog.split_part(storage_path, '/', 2) = uploaded_by::text
    and pg_catalog.split_part(storage_path, '/', 3) = 'studios'
    and (
      pg_catalog.split_part(storage_path, '/', 4) = studio_id::text
      or (
        studio_id is null
        and status in ('delete_pending', 'deleted')
        and pg_catalog.split_part(storage_path, '/', 4)
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    )
    and pg_catalog.split_part(storage_path, '/', 5) = 'revisions'
    and (
      pg_catalog.split_part(storage_path, '/', 6) = prepared_revision_id::text
      or (
        prepared_revision_id is null
        and status in ('delete_pending', 'deleted')
        and pg_catalog.split_part(storage_path, '/', 6)
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    )
    and pg_catalog.split_part(storage_path, '/', 7) = pg_catalog.format(
      '%s.%s',
      id,
      case declared_mime_type
        when 'image/jpeg' then 'jpg'
        when 'image/png' then 'png'
        when 'image/webp' then 'webp'
        when 'image/avif' then 'avif'
      end
    )
    and pg_catalog.split_part(storage_path, '/', 8) = ''
  ),
  constraint studio_media_preview_path_identity_check check (
    preview_storage_path = pg_catalog.regexp_replace(
      storage_path,
      '\.(avif|jpg|png|webp)$',
      '.preview.webp'
    )
    and pg_catalog.split_part(preview_storage_path, '/', 7)
      = pg_catalog.format('%s.preview.webp', id)
  ),
  constraint studio_media_declared_mime_check check (
    declared_mime_type = any (array[
      'image/jpeg'::text,
      'image/png'::text,
      'image/webp'::text,
      'image/avif'::text
    ])
  ),
  constraint studio_media_declared_size_check check (
    declared_size_bytes between 1 and 15728640
  ),
  constraint studio_media_declared_checksum_check check (
    declared_checksum_sha256 is null
    or declared_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint studio_media_actual_mime_check check (
    actual_mime_type is null
    or actual_mime_type = any (array[
      'image/jpeg'::text,
      'image/png'::text,
      'image/webp'::text,
      'image/avif'::text
    ])
  ),
  constraint studio_media_actual_size_check check (
    actual_size_bytes is null or actual_size_bytes between 1 and 15728640
  ),
  constraint studio_media_dimensions_check check (
    (width is null and height is null)
    or (
      width between 1 and 8192
      and height between 1 and 8192
      and width::bigint * height::bigint <= 36000000
    )
  ),
  constraint studio_media_checksum_check check (
    checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint studio_media_status_check check (
    status = any (array[
      'pending_upload'::text,
      'ready'::text,
      'rejected'::text,
      'delete_pending'::text,
      'deleted'::text
    ])
  ),
  constraint studio_media_rejection_code_check check (
    rejection_code is null
    or rejection_code = any (array[
      'validation_failed'::text,
      'object_missing'::text,
      'mime_mismatch'::text,
      'size_mismatch'::text,
      'checksum_mismatch'::text,
      'decode_failed'::text,
      'dimension_invalid'::text
    ])
  ),
  constraint studio_media_upload_window_check check (
    upload_expires_at = prepared_at + interval '2 hours'
  ),
  constraint studio_media_state_coherence_check check (
    (
      status = 'pending_upload'
      and studio_id is not null
      and prepared_revision_id is not null
      and actual_mime_type is null
      and actual_size_bytes is null
      and width is null
      and height is null
      and checksum_sha256 is null
      and rejection_code is null
      and finalized_at is null
      and rejected_at is null
      and delete_requested_at is null
      and deleted_at is null
      and cleanup_after >= prepared_at + interval '24 hours'
    )
    or (
      status = 'ready'
      and studio_id is not null
      and prepared_revision_id is not null
      and actual_mime_type is not null
      and actual_size_bytes is not null
      and width is not null
      and height is not null
      and checksum_sha256 is not null
      and rejection_code is null
      and finalized_at is not null
      and rejected_at is null
      and delete_requested_at is null
      and deleted_at is null
      and cleanup_after is null
    )
    or (
      status = 'rejected'
      and studio_id is not null
      and prepared_revision_id is not null
      and actual_mime_type is null
      and actual_size_bytes is null
      and width is null
      and height is null
      and checksum_sha256 is null
      and rejection_code is not null
      and finalized_at is null
      and rejected_at is not null
      and delete_requested_at is null
      and deleted_at is null
      and cleanup_after is not null
    )
    or (
      status = 'delete_pending'
      and delete_requested_at is not null
      and deleted_at is null
      and cleanup_after is not null
    )
    or (
      status = 'deleted'
      and delete_requested_at is not null
      and deleted_at is not null
      and cleanup_after is null
    )
  ),
  constraint studio_media_cleanup_claim_check check (
    (cleanup_claim_token is null and cleanup_claimed_at is null)
    or (
      status = 'delete_pending'
      and cleanup_claim_token is not null
      and cleanup_claimed_at is not null
    )
  ),
  constraint studio_media_cleanup_result_check check (
    (
      cleanup_last_completed_token is null
      and cleanup_last_succeeded is null
      and cleanup_last_error_code is null
    )
    or (
      cleanup_last_completed_token is not null
      and cleanup_last_succeeded is true
      and cleanup_last_error_code is null
      and status = 'deleted'
    )
    or (
      cleanup_last_completed_token is not null
      and cleanup_last_succeeded is false
      and cleanup_last_error_code ~ '^[a-z0-9_]{2,80}$'
      and status = 'delete_pending'
    )
  ),
  constraint studio_media_cleanup_attempts_check check (cleanup_attempts >= 0),
  constraint studio_media_cleanup_next_attempt_check check (
    cleanup_next_attempt_at is null or status = 'delete_pending'
  ),
  constraint studio_media_timestamps_check check (
    updated_at >= prepared_at
    and (finalized_at is null or finalized_at >= prepared_at)
    and (rejected_at is null or rejected_at >= prepared_at)
    and (delete_requested_at is null or delete_requested_at >= prepared_at)
    and (deleted_at is null or deleted_at >= delete_requested_at)
  )
);

create table public.studio_revision_media (
  revision_id uuid not null,
  media_id uuid not null,
  position smallint not null,
  is_cover boolean not null default false,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (revision_id, media_id),
  constraint studio_revision_media_revision_id_fkey foreign key (revision_id)
    references public.studio_revisions (id) on delete cascade,
  constraint studio_revision_media_media_id_fkey foreign key (media_id)
    references public.studio_media (id) on delete restrict,
  constraint studio_revision_media_position_check check (position between 1 and 20),
  constraint studio_revision_media_position_key unique (revision_id, position)
    deferrable initially immediate
);

alter table public.studio_media owner to postgres;
alter table public.studio_revision_media owner to postgres;

create index studio_media_studio_id_idx on public.studio_media (studio_id)
  where studio_id is not null;
create index studio_media_prepared_revision_id_idx on public.studio_media (prepared_revision_id)
  where prepared_revision_id is not null;
create index studio_media_uploaded_by_idx on public.studio_media (uploaded_by);
create index studio_media_cleanup_claim_token_idx
  on public.studio_media (cleanup_claim_token, cleanup_claimed_at)
  where status = 'delete_pending' and cleanup_claim_token is not null;
create index studio_media_cleanup_dequeue_idx
  on public.studio_media (
    (coalesce(cleanup_next_attempt_at, cleanup_after)),
    id
  )
  where status in ('pending_upload', 'rejected', 'delete_pending');
create index studio_revision_media_media_id_idx
  on public.studio_revision_media (media_id);
create unique index studio_revision_media_one_cover_idx
  on public.studio_revision_media (revision_id)
  where is_cover;

create or replace function maintenance.enforce_studio_media_cleanup_run_lifecycle()
returns trigger
  language plpgsql
  set search_path to ''
as $function$
begin
  if old.run_id is distinct from new.run_id
    or old.function_slug is distinct from new.function_slug
    or old.started_at is distinct from new.started_at
    or (old.completed_at is not null and old.completed_at is distinct from new.completed_at)
    or (old.claimed_count is not null and old.claimed_count is distinct from new.claimed_count)
    or (old.deleted_count is not null and old.deleted_count is distinct from new.deleted_count)
    or (old.failed_count is not null and old.failed_count is distinct from new.failed_count)
    or (old.error_code is not null and old.error_code is distinct from new.error_code)
  then
    raise exception using
      errcode = '23514',
      message = 'studio_media_cleanup_run_immutable';
  end if;

  if old.status <> new.status and not (
    old.status = 'running' and new.status in ('succeeded', 'failed')
  ) then
    raise exception using
      errcode = '23514',
      message = 'studio_media_cleanup_run_transition_invalid';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

alter function maintenance.enforce_studio_media_cleanup_run_lifecycle() owner to postgres;

create trigger studio_media_cleanup_runs_enforce_lifecycle
  before update on maintenance.studio_media_cleanup_runs
  for each row execute function maintenance.enforce_studio_media_cleanup_run_lifecycle();

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
  ) then
    raise exception using
      errcode = '23514',
      message = 'studio_media_cleanup_probe_transition_invalid';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

alter function maintenance.enforce_studio_media_cleanup_probe_lifecycle()
  owner to postgres;

create trigger studio_media_cleanup_probes_enforce_lifecycle
  before update on maintenance.studio_media_cleanup_probes
  for each row execute function maintenance.enforce_studio_media_cleanup_probe_lifecycle();

create or replace function private.studio_media_cleanup_runs_are_healthy()
returns boolean
  language sql stable security definer
  set search_path to ''
as $function$
  select
    not exists (
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

create or replace function private.managed_runtime_boundaries_are_ready()
returns boolean
  language sql stable security definer
  set search_path to ''
as $function$
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
  ),
  production_runtime_members_are_restricted as (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        member.rolname = 'postgres'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      ) as ready
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where granted.rolname = 'app_runtime_production'
  )
  select coalesce(
    (
      (select ready from sensitive_catalog_access_is_restricted)
      or (select ready from sensitive_settings_are_absent)
    )
    and (select ready from managed_http_access_is_restricted)
    and (select ready from application_database_access_is_restricted)
    and (select ready from production_runtime_members_are_restricted)
    and private.studio_media_cleanup_runs_are_healthy(),
    false
  );
$function$;

alter function private.managed_runtime_boundaries_are_ready() owner to postgres;

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

create trigger studio_media_enforce_lifecycle
  before update on public.studio_media
  for each row execute function private.enforce_studio_media_lifecycle();

create or replace function private.assert_editable_studio_media_relation() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  target_revision_id uuid;
  target_revision_status text;
  target_revision_studio_id uuid;
  target_media_status text;
  target_media_studio_id uuid;
begin
  target_revision_id := case when tg_op = 'DELETE' then old.revision_id else new.revision_id end;

  select revision.status, revision.studio_id
  into target_revision_status, target_revision_studio_id
  from public.studio_revisions as revision
  where revision.id = target_revision_id
  for share;

  if tg_op = 'DELETE' then
    select media.status, media.studio_id
    into target_media_status, target_media_studio_id
    from public.studio_media as media
    where media.id = old.media_id
    for share;

    if target_revision_status = 'draft'
      or (found and target_media_status = 'delete_pending')
    then
      return old;
    end if;

    raise exception using errcode = '23514', message = 'studio_media_revision_immutable';
  end if;

  if target_revision_status is distinct from 'draft' then
    raise exception using errcode = '23514', message = 'studio_media_revision_immutable';
  end if;

  if tg_op <> 'DELETE' then
    select media.status, media.studio_id
    into target_media_status, target_media_studio_id
    from public.studio_media as media
    where media.id = new.media_id
    for share;

    if not found
      or target_media_status <> 'ready'
      or target_media_studio_id is distinct from target_revision_studio_id
    then
      raise exception using errcode = '23514', message = 'studio_media_relation_invalid';
    end if;
  end if;

  return new;
end;
$function$;

alter function private.assert_editable_studio_media_relation() owner to postgres;

create trigger studio_revision_media_require_draft
  before insert or update or delete on public.studio_revision_media
  for each row execute function private.assert_editable_studio_media_relation();

create or replace function private.clone_studio_revision_media_after_insert() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  source_revision_id uuid;
begin
  if new.status <> 'draft' then
    return new;
  end if;

  select studio.published_revision_id
  into source_revision_id
  from public.studios as studio
  join public.studio_revisions as revision on revision.id = studio.published_revision_id
  where studio.id = new.studio_id
    and studio.draft_revision_id is null
    and revision.status = 'approved';

  if source_revision_id is null then
    return new;
  end if;

  insert into public.studio_revision_media (revision_id, media_id, position, is_cover)
  select new.id, relation.media_id, relation.position, relation.is_cover
  from public.studio_revision_media as relation
  where relation.revision_id = source_revision_id
  order by relation.position;

  return new;
end;
$function$;

alter function private.clone_studio_revision_media_after_insert() owner to postgres;

create trigger studio_revisions_clone_media
  after insert on public.studio_revisions
  for each row execute function private.clone_studio_revision_media_after_insert();

create or replace function private.queue_unreferenced_studio_media_after_delete() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  requested_at timestamptz := pg_catalog.clock_timestamp();
begin
  update public.studio_media as media
  set
    status = 'delete_pending',
    delete_requested_at = coalesce(media.delete_requested_at, requested_at),
    cleanup_after = greatest(
      coalesce(media.cleanup_after, requested_at),
      media.upload_expires_at
    ),
    cleanup_next_attempt_at = null
  where media.id = old.media_id
    and media.status = 'ready'
    and not exists (
      select 1
      from public.studio_revision_media as remaining
      where remaining.media_id = media.id
    );

  return old;
end;
$function$;

alter function private.queue_unreferenced_studio_media_after_delete() owner to postgres;

create trigger studio_revision_media_queue_unreferenced
  after delete on public.studio_revision_media
  for each row execute function private.queue_unreferenced_studio_media_after_delete();

create or replace function private.queue_unattached_studio_media_before_revision_delete() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  requested_at timestamptz := pg_catalog.clock_timestamp();
begin
  update public.studio_media as media
  set
    status = 'delete_pending',
    delete_requested_at = coalesce(media.delete_requested_at, requested_at),
    cleanup_after = greatest(
      coalesce(media.cleanup_after, requested_at),
      media.upload_expires_at
    ),
    cleanup_next_attempt_at = null
  where media.prepared_revision_id = old.id
    and media.status in ('pending_upload', 'rejected')
    and not exists (
      select 1
      from public.studio_revision_media as relation
      where relation.media_id = media.id
        and relation.revision_id <> old.id
    );

  return old;
end;
$function$;

alter function private.queue_unattached_studio_media_before_revision_delete() owner to postgres;

create trigger studio_revisions_queue_unattached_media
  before delete on public.studio_revisions
  for each row execute function private.queue_unattached_studio_media_before_revision_delete();

create or replace function private.queue_studio_media_before_studio_delete() returns trigger
  language plpgsql
  set search_path to ''
as $function$
declare
  requested_at timestamptz := pg_catalog.clock_timestamp();
begin
  update public.studio_media as media
  set
    status = 'delete_pending',
    delete_requested_at = coalesce(media.delete_requested_at, requested_at),
    cleanup_after = greatest(
      coalesce(media.cleanup_after, requested_at),
      media.upload_expires_at
    ),
    cleanup_next_attempt_at = case
      when media.status = 'delete_pending' then media.cleanup_next_attempt_at
      else null
    end
  where media.studio_id = old.id
    and media.status <> 'deleted';

  return old;
end;
$function$;

alter function private.queue_studio_media_before_studio_delete() owner to postgres;

create trigger studios_queue_media_before_delete
  before delete on public.studios
  for each row execute function private.queue_studio_media_before_studio_delete();

alter table private.studio_command_requests
  add column resulting_media_id uuid,
  add column result_payload jsonb,
  add constraint studio_command_requests_resulting_media_id_fkey foreign key (resulting_media_id)
    references public.studio_media (id) on delete restrict,
  add constraint studio_command_requests_media_result_check check (
    (
      action like 'studio.media.%'
      and pg_catalog.jsonb_typeof(result_payload) = 'object'
      and result_hash = private.studio_result_hash(result_payload)
    )
    or (action not like 'studio.media.%' and result_payload is null)
  ),
  add constraint studio_command_requests_media_target_check check (
    (
      action = any (array[
        'studio.media.prepare'::text,
        'studio.media.finalize'::text,
        'studio.media.cover.set'::text,
        'studio.media.delete'::text
      ])
      and resulting_media_id is not null
    )
    or (
      action <> all (array[
        'studio.media.prepare'::text,
        'studio.media.finalize'::text,
        'studio.media.cover.set'::text,
        'studio.media.delete'::text
      ])
      and resulting_media_id is null
    )
  );

create index studio_command_requests_resulting_media_id_idx
  on private.studio_command_requests (resulting_media_id)
  where resulting_media_id is not null;

alter table private.studio_command_requests
  drop constraint studio_command_requests_action_check,
  add constraint studio_command_requests_action_check check (
    action = any (array[
      'studio.create'::text,
      'studio.revision.updateCore'::text,
      'studio.revision.updateTaxonomy'::text,
      'studio.revision.updateContent'::text,
      'studio.draft.discard'::text,
      'studio.media.prepare'::text,
      'studio.media.finalize'::text,
      'studio.media.reorder'::text,
      'studio.media.cover.set'::text,
      'studio.media.delete'::text
    ])
  );

alter table audit.events drop constraint events_action_check;
alter table audit.events add constraint events_action_check check (
  action = any (array[
    'owner.activated'::text,
    'owner.contract_renewed'::text,
    'recipient.status_transitioned'::text,
    'studio.created'::text,
    'studio.revision_updated'::text,
    'studio.revision_taxonomy_updated'::text,
    'studio.revision_content_updated'::text,
    'studio.draft_discarded'::text,
    'studio.media_upload_prepared'::text,
    'studio.media_upload_rejected'::text,
    'studio.media_upload_finalized'::text,
    'studio.media_reordered'::text,
    'studio.media_cover_set'::text,
    'studio.media_deleted'::text,
    'backoffice.admin_bootstrapped'::text,
    'backoffice.user_suspended'::text,
    'backoffice.user_restored'::text,
    'backoffice.user_pii_revealed'::text,
    'backoffice.role_granted'::text,
    'backoffice.role_revoked'::text,
    'backoffice.taxonomy_created'::text,
    'backoffice.taxonomy_updated'::text,
    'backoffice.taxonomy_archived'::text,
    'backoffice.taxonomy_reactivated'::text
  ])
);

create or replace function private.studio_media_payload_hash(
  p_action text,
  p_payload jsonb
) returns text
  language sql immutable
  set search_path to ''
as $function$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object('action', p_action, 'payload', p_payload)::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$function$;

alter function private.studio_media_payload_hash(text, jsonb) owner to postgres;

create or replace function private.get_owner_studio_media(
  p_user_id uuid,
  p_studio_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  select pg_catalog.jsonb_build_object(
    'scope', studio.owner_user_id,
    'studioId', studio.id,
    'revisionId', revision.id,
    'revisionNumber', revision.revision_number,
    'revisionVersion', revision.revision_version,
    'items', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', media.id,
          'previewStoragePath', media.preview_storage_path,
          'mimeType', media.actual_mime_type,
          'byteSize', media.actual_size_bytes,
          'checksumSha256', media.checksum_sha256,
          'width', media.width,
          'height', media.height,
          'position', relation.position,
          'isCover', relation.is_cover
        ) order by relation.position
      )
      from public.studio_revision_media as relation
      join public.studio_media as media on media.id = relation.media_id
      where relation.revision_id = revision.id
        and media.status = 'ready'
    ), '[]'::jsonb)
  )
  from public.studios as studio
  join public.profiles as profile on profile.id = studio.owner_user_id
  join public.owner_profiles as owner on owner.user_id = profile.id
  join public.terms_versions as legal_version
    on legal_version.id = owner.accepted_owner_contract_version_id
  join public.terms_acceptances as acceptance
    on acceptance.user_id = owner.user_id
    and acceptance.terms_version_id = legal_version.id
    and acceptance.accepted_content_hash = legal_version.content_hash
  join public.studio_revisions as revision
    on revision.id = coalesce(studio.draft_revision_id, studio.published_revision_id)
    and revision.studio_id = studio.id
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
    and studio.status <> 'disabled'
    and profile.status = 'active'
    and profile.completed_at is not null
    and owner.status = 'active'
    and revision.revision_number >= 1
    and legal_version.kind = 'owner_contract'
    and legal_version.effective_at <= pg_catalog.now()
    and (legal_version.retired_at is null or pg_catalog.now() < legal_version.retired_at)
    and (
      (
        studio.draft_revision_id is not null
        and revision.id = studio.draft_revision_id
        and revision.status = 'draft'
      )
      or (
        studio.draft_revision_id is null
        and studio.published_revision_id is not null
        and revision.id = studio.published_revision_id
        and revision.status = 'approved'
      )
    );
$function$;

alter function private.get_owner_studio_media(uuid, uuid) owner to postgres;

create or replace function private.replay_studio_media_command(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_payload_hash text,
  p_studio_id uuid,
  p_media_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  existing_request private.studio_command_requests%rowtype;
begin
  select request.*
  into existing_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key;

  if not found then
    return null;
  end if;

  if existing_request.action <> p_action
    or existing_request.payload_hash <> p_payload_hash
    or existing_request.studio_id <> p_studio_id
    or (
      p_action = 'studio.media.prepare'
      and existing_request.resulting_media_id is null
    )
    or (
      p_action <> 'studio.media.prepare'
      and existing_request.resulting_media_id is distinct from p_media_id
    )
    or existing_request.result_payload is null
    or existing_request.result_hash <> private.studio_result_hash(existing_request.result_payload)
  then
    raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
  end if;

  return existing_request.result_payload;
end;
$function$;

alter function private.replay_studio_media_command(uuid, uuid, text, text, uuid, uuid)
  owner to postgres;

create or replace function private.replay_studio_media_finalize(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_media_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  payload_hash text;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_media_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_finalize';
  end if;

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
  return private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.finalize',
    payload_hash,
    p_studio_id,
    p_media_id
  );
end;
$function$;

alter function private.replay_studio_media_finalize(uuid, uuid, uuid, bigint, uuid, uuid)
  owner to postgres;

create or replace function private.record_studio_media_command(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_payload_hash text,
  p_studio_id uuid,
  p_revision_id uuid,
  p_revision_version bigint,
  p_media_id uuid,
  p_result jsonb
) returns void
  language sql security definer
  set search_path to ''
as $function$
  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    studio_id,
    resulting_revision_id,
    resulting_revision_version,
    resulting_media_id,
    result_payload
  )
  values (
    p_user_id,
    p_idempotency_key,
    p_action,
    p_payload_hash,
    private.studio_result_hash(p_result),
    p_studio_id,
    p_revision_id,
    p_revision_version,
    p_media_id,
    p_result
  );
$function$;

alter function private.record_studio_media_command(
  uuid, uuid, text, text, uuid, uuid, bigint, uuid, jsonb
) owner to postgres;

create or replace function private.audit_studio_media_command(
  p_user_id uuid,
  p_request_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_studio_id uuid,
  p_metadata jsonb
) returns void
  language sql security definer
  set search_path to ''
as $function$
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
    p_action,
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    p_metadata
  );
$function$;

alter function private.audit_studio_media_command(uuid, uuid, uuid, text, uuid, jsonb)
  owner to postgres;

create or replace function private.lock_studio_media_revision(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint
) returns table (locked_revision_id uuid, locked_revision_version bigint)
  language plpgsql security definer
  set search_path to ''
as $function$
begin
  return query
  select prepared.revision_id, prepared.revision_version
  from private.prepare_studio_revision_draft(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as prepared;
end;
$function$;

alter function private.lock_studio_media_revision(uuid, uuid, uuid, bigint) owner to postgres;

create or replace function private.prepare_studio_media_upload(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_declared_mime_type text,
  p_declared_size_bytes bigint,
  p_declared_checksum_sha256 text
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  extension text;
  media_id uuid := extensions.gen_random_uuid();
  payload_hash text;
  prepared_time timestamptz := pg_catalog.clock_timestamp();
  replay jsonb;
  result jsonb;
  preview_storage_path text;
  storage_path text;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_declared_mime_type is null
    or p_declared_mime_type <> all (array[
      'image/jpeg'::text,
      'image/png'::text,
      'image/webp'::text,
      'image/avif'::text
    ])
    or p_declared_size_bytes is null
    or p_declared_size_bytes not between 1 and 15728640
    or (
      p_declared_checksum_sha256 is not null
      and p_declared_checksum_sha256 !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_prepare';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.prepare',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'declaredMimeType', p_declared_mime_type,
      'declaredSizeBytes', p_declared_size_bytes,
      'declaredChecksumSha256', p_declared_checksum_sha256
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.prepare',
    payload_hash,
    p_studio_id,
    null
  );
  if replay is not null then
    return replay;
  end if;

  select prepared.revision_id, prepared.revision_version
  into draft_revision_id, draft_revision_version
  from private.prepare_studio_revision_draft(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as prepared;

  if (
    select pg_catalog.count(*)
    from public.studio_revision_media as relation
    where relation.revision_id = draft_revision_id
  ) + (
    select pg_catalog.count(*)
    from public.studio_media as pending
    where pending.prepared_revision_id = draft_revision_id
      and pending.status = 'pending_upload'
      and pending.upload_expires_at > prepared_time
  ) >= 20 then
    raise exception using errcode = '23514', message = 'studio_media_limit_reached';
  end if;

  extension := case p_declared_mime_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/avif' then 'avif'
  end;
  storage_path := pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.%s',
    p_user_id,
    p_studio_id,
    draft_revision_id,
    media_id,
    extension
  );
  preview_storage_path := pg_catalog.format(
    'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
    p_user_id,
    p_studio_id,
    draft_revision_id,
    media_id
  );

  insert into public.studio_media (
    id,
    studio_id,
    prepared_revision_id,
    uploaded_by,
    storage_bucket,
    storage_path,
    preview_storage_path,
    declared_mime_type,
    declared_size_bytes,
    declared_checksum_sha256,
    status,
    prepared_at,
    upload_expires_at,
    cleanup_after,
    updated_at
  )
  values (
    media_id,
    p_studio_id,
    draft_revision_id,
    p_user_id,
    'studio-media',
    storage_path,
    preview_storage_path,
    p_declared_mime_type,
    p_declared_size_bytes,
    p_declared_checksum_sha256,
    'pending_upload',
    prepared_time,
    prepared_time + interval '2 hours',
    prepared_time + interval '24 hours',
    prepared_time
  );

  result := pg_catalog.jsonb_build_object(
    'scope', p_user_id,
    'studioId', p_studio_id,
    'revisionId', draft_revision_id,
    'revisionVersion', draft_revision_version,
    'mediaId', media_id,
    'bucket', 'studio-media',
    'path', storage_path,
    'expiresAt', prepared_time + interval '2 hours'
  );

  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.prepare',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    draft_revision_version,
    media_id,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_upload_prepared',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'mediaId', media_id,
      'revisionId', draft_revision_id,
      'revisionVersion', draft_revision_version,
      'declaredMimeType', p_declared_mime_type,
      'declaredSizeBytes', p_declared_size_bytes
    )
  );

  return result;
end;
$function$;

alter function private.prepare_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text, bigint, text
) owner to postgres;

create or replace function private.get_studio_media_upload_candidate(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_media_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  media public.studio_media%rowtype;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_media_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_candidate';
  end if;

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
  if media.status <> 'pending_upload' then
    raise exception using errcode = '40001', message = 'studio_media_candidate_not_pending';
  end if;
  if pg_catalog.clock_timestamp() >= media.upload_expires_at then
    raise exception using errcode = '40001', message = 'studio_media_upload_expired';
  end if;

  return pg_catalog.jsonb_build_object(
    'scope', p_user_id,
    'studioId', p_studio_id,
    'revisionId', draft_revision_id,
    'revisionVersion', draft_revision_version,
    'mediaId', media.id,
    'bucket', media.storage_bucket,
    'path', media.storage_path,
    'previewPath', media.preview_storage_path,
    'expiresAt', media.upload_expires_at,
    'declaredMimeType', media.declared_mime_type,
    'declaredByteSize', media.declared_size_bytes,
    'declaredChecksumSha256', media.declared_checksum_sha256
  );
end;
$function$;

alter function private.get_studio_media_upload_candidate(uuid, uuid, uuid, bigint, uuid)
  owner to postgres;

create or replace function private.reject_studio_media_upload(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_media_id uuid,
  p_request_id uuid
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
      rejection_code = 'validation_failed',
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
        'rejectionCode', 'validation_failed'
      )
    );
  else
    rejected_time := media.rejected_at;
  end if;

  result := pg_catalog.jsonb_build_object(
    'scope', p_user_id,
    'studioId', p_studio_id,
    'revisionId', draft_revision_id,
    'revisionVersion', draft_revision_version,
    'mediaId', p_media_id,
    'status', 'rejected',
    'rejectionCode', 'validation_failed',
    'rejectedAt', rejected_time
  );
  return result;
end;
$function$;

alter function private.reject_studio_media_upload(uuid, uuid, uuid, bigint, uuid, uuid)
  owner to postgres;

create or replace function private.finalize_studio_media_upload(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_media_id uuid,
  p_actual_mime_type text,
  p_actual_size_bytes bigint,
  p_width integer,
  p_height integer,
  p_checksum_sha256 text
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  is_first boolean;
  media public.studio_media%rowtype;
  next_position smallint;
  payload_hash text;
  replay jsonb;
  result jsonb;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_media_id is null
    or p_actual_mime_type is null
    or p_actual_mime_type <> all (array[
      'image/jpeg'::text,
      'image/png'::text,
      'image/webp'::text,
      'image/avif'::text
    ])
    or p_actual_size_bytes is null
    or p_actual_size_bytes not between 1 and 15728640
    or p_width is null
    or p_width not between 1 and 8192
    or p_height is null
    or p_height not between 1 and 8192
    or p_width::bigint * p_height::bigint > 36000000
    or p_checksum_sha256 is null
    or p_checksum_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_finalize';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.finalize',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'mediaId', p_media_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.finalize',
    payload_hash,
    p_studio_id,
    p_media_id
  );
  if replay is not null then
    return replay;
  end if;

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
  if media.status <> 'pending_upload' then
    raise exception using errcode = '40001', message = 'studio_media_finalize_conflict';
  end if;
  if media.upload_expires_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '40001', message = 'studio_media_upload_expired';
  end if;
  if media.declared_mime_type <> p_actual_mime_type
    or media.declared_size_bytes <> p_actual_size_bytes
    or (
      media.declared_checksum_sha256 is not null
      and media.declared_checksum_sha256 <> p_checksum_sha256
    )
  then
    raise exception using errcode = '23514', message = 'studio_media_metadata_mismatch';
  end if;

  select coalesce(pg_catalog.max(relation.position), 0) + 1,
    pg_catalog.count(*) = 0
  into next_position, is_first
  from public.studio_revision_media as relation
  where relation.revision_id = draft_revision_id;

  if next_position > 20 then
    raise exception using errcode = '23514', message = 'studio_media_limit_reached';
  end if;

  update public.studio_media as candidate
  set
    actual_mime_type = p_actual_mime_type,
    actual_size_bytes = p_actual_size_bytes,
    width = p_width,
    height = p_height,
    checksum_sha256 = p_checksum_sha256,
    status = 'ready',
    finalized_at = pg_catalog.clock_timestamp(),
    cleanup_after = null
  where candidate.id = media.id;

  insert into public.studio_revision_media (revision_id, media_id, position, is_cover)
  values (draft_revision_id, p_media_id, next_position, is_first);

  update public.studio_revisions as revision
  set revision_version = revision.revision_version + 1
  where revision.id = draft_revision_id
    and revision.status = 'draft'
    and revision.revision_version = draft_revision_version
  returning revision.revision_version into resulting_revision_version;

  if not found then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  result := private.get_owner_studio_media(p_user_id, p_studio_id);
  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.finalize',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    resulting_revision_version,
    p_media_id,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_upload_finalized',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'mediaId', p_media_id,
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'mimeType', p_actual_mime_type,
      'sizeBytes', p_actual_size_bytes,
      'width', p_width,
      'height', p_height
    )
  );

  return result;
end;
$function$;

alter function private.finalize_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid, text, bigint, integer, integer, text
) owner to postgres;

create or replace function private.reorder_studio_media(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_ordered_media_ids uuid[]
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  changed boolean;
  draft_revision_id uuid;
  draft_revision_version bigint;
  payload_hash text;
  replay jsonb;
  result jsonb;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_ordered_media_ids is null
    or pg_catalog.cardinality(p_ordered_media_ids) > 20
    or pg_catalog.array_position(p_ordered_media_ids, null) is not null
    or pg_catalog.cardinality(p_ordered_media_ids) <> (
      select pg_catalog.count(distinct selected.media_id)
      from pg_catalog.unnest(p_ordered_media_ids) as selected(media_id)
    )
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_order';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.reorder',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'orderedMediaIds', pg_catalog.to_jsonb(p_ordered_media_ids)
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.reorder',
    payload_hash,
    p_studio_id,
    null
  );
  if replay is not null then
    return replay;
  end if;

  select locked.locked_revision_id, locked.locked_revision_version
  into draft_revision_id, draft_revision_version
  from private.lock_studio_media_revision(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as locked;
  resulting_revision_version := draft_revision_version;

  perform relation.media_id
  from public.studio_revision_media as relation
  where relation.revision_id = draft_revision_id
  order by relation.media_id
  for update;

  if pg_catalog.cardinality(p_ordered_media_ids) <> (
      select pg_catalog.count(*)
      from public.studio_revision_media as relation
      where relation.revision_id = draft_revision_id
    )
    or exists (
      select 1
      from public.studio_revision_media as relation
      where relation.revision_id = draft_revision_id
        and relation.media_id <> all (p_ordered_media_ids)
    )
  then
    raise exception using errcode = '23514', message = 'studio_media_order_set_mismatch';
  end if;

  select exists (
    select 1
    from pg_catalog.unnest(p_ordered_media_ids) with ordinality as selected(media_id, position)
    join public.studio_revision_media as relation
      on relation.revision_id = draft_revision_id
      and relation.media_id = selected.media_id
    where relation.position <> selected.position
  ) into changed;

  if changed then
    set constraints public.studio_revision_media_position_key deferred;

    update public.studio_revision_media as relation
    set position = selected.position::smallint
    from pg_catalog.unnest(p_ordered_media_ids) with ordinality as selected(media_id, position)
    where relation.revision_id = draft_revision_id
      and relation.media_id = selected.media_id;

    update public.studio_revisions as revision
    set revision_version = revision.revision_version + 1
    where revision.id = draft_revision_id
      and revision.status = 'draft'
      and revision.revision_version = draft_revision_version
    returning revision.revision_version into resulting_revision_version;

    if not found then
      raise exception using errcode = '40001', message = 'studio_revision_conflict';
    end if;
  end if;

  result := private.get_owner_studio_media(p_user_id, p_studio_id);
  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.reorder',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    resulting_revision_version,
    null,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_reordered',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'mediaCount', pg_catalog.cardinality(p_ordered_media_ids),
      'changed', changed
    )
  );

  return result;
end;
$function$;

alter function private.reorder_studio_media(uuid, uuid, uuid, bigint, uuid, uuid, uuid[])
  owner to postgres;

create or replace function private.set_studio_media_cover(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_media_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  already_cover boolean;
  draft_revision_id uuid;
  draft_revision_version bigint;
  payload_hash text;
  replay jsonb;
  result jsonb;
  resulting_revision_version bigint;
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
    raise exception using errcode = '22023', message = 'invalid_studio_media_cover';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.cover.set',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'mediaId', p_media_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.cover.set',
    payload_hash,
    p_studio_id,
    p_media_id
  );
  if replay is not null then
    return replay;
  end if;

  select locked.locked_revision_id, locked.locked_revision_version
  into draft_revision_id, draft_revision_version
  from private.lock_studio_media_revision(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as locked;
  resulting_revision_version := draft_revision_version;

  select relation.is_cover
  into already_cover
  from public.studio_revision_media as relation
  join public.studio_media as media on media.id = relation.media_id
  where relation.revision_id = draft_revision_id
    and relation.media_id = p_media_id
    and media.status = 'ready'
  for update of relation;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;

  if not already_cover then
    update public.studio_revision_media as relation
    set is_cover = false
    where relation.revision_id = draft_revision_id
      and relation.is_cover;

    update public.studio_revision_media as relation
    set is_cover = true
    where relation.revision_id = draft_revision_id
      and relation.media_id = p_media_id;

    update public.studio_revisions as revision
    set revision_version = revision.revision_version + 1
    where revision.id = draft_revision_id
      and revision.status = 'draft'
      and revision.revision_version = draft_revision_version
    returning revision.revision_version into resulting_revision_version;

    if not found then
      raise exception using errcode = '40001', message = 'studio_revision_conflict';
    end if;
  end if;

  result := private.get_owner_studio_media(p_user_id, p_studio_id);
  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.cover.set',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    resulting_revision_version,
    p_media_id,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_cover_set',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'mediaId', p_media_id,
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'changed', not already_cover
    )
  );

  return result;
end;
$function$;

alter function private.set_studio_media_cover(uuid, uuid, uuid, bigint, uuid, uuid, uuid)
  owner to postgres;

create or replace function private.delete_studio_media(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_media_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  draft_revision_id uuid;
  draft_revision_version bigint;
  media_count integer;
  media_is_cover boolean;
  media_status text;
  payload_hash text;
  replay jsonb;
  result jsonb;
  resulting_revision_version bigint;
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
    raise exception using errcode = '22023', message = 'invalid_studio_media_delete';
  end if;

  payload_hash := private.studio_media_payload_hash(
    'studio.media.delete',
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedRevisionId', p_expected_revision_id,
      'expectedRevisionVersion', p_expected_revision_version,
      'mediaId', p_media_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );
  perform private.assert_studio_owner_mutable(p_user_id);

  replay := private.replay_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.delete',
    payload_hash,
    p_studio_id,
    p_media_id
  );
  if replay is not null then
    return replay;
  end if;

  select locked.locked_revision_id, locked.locked_revision_version
  into draft_revision_id, draft_revision_version
  from private.lock_studio_media_revision(
    p_user_id,
    p_studio_id,
    p_expected_revision_id,
    p_expected_revision_version
  ) as locked;

  select relation.is_cover,
    (
      select pg_catalog.count(*)::integer
      from public.studio_revision_media as counted
      where counted.revision_id = draft_revision_id
    )
  into media_is_cover, media_count
  from public.studio_revision_media as relation
  where relation.revision_id = draft_revision_id
    and relation.media_id = p_media_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;
  if media_is_cover and media_count > 1 then
    raise exception using errcode = '23514', message = 'studio_media_cover_replacement_required';
  end if;

  set constraints public.studio_revision_media_position_key deferred;

  delete from public.studio_revision_media as relation
  where relation.revision_id = draft_revision_id
    and relation.media_id = p_media_id;

  with ordered as (
    select relation.media_id,
      pg_catalog.row_number() over (order by relation.position)::smallint as position
    from public.studio_revision_media as relation
    where relation.revision_id = draft_revision_id
  )
  update public.studio_revision_media as relation
  set position = ordered.position
  from ordered
  where relation.revision_id = draft_revision_id
    and relation.media_id = ordered.media_id
    and relation.position <> ordered.position;

  update public.studio_revisions as revision
  set revision_version = revision.revision_version + 1
  where revision.id = draft_revision_id
    and revision.status = 'draft'
    and revision.revision_version = draft_revision_version
  returning revision.revision_version into resulting_revision_version;

  if not found then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  select media.status
  into media_status
  from public.studio_media as media
  where media.id = p_media_id;

  result := private.get_owner_studio_media(p_user_id, p_studio_id);
  perform private.record_studio_media_command(
    p_user_id,
    p_idempotency_key,
    'studio.media.delete',
    payload_hash,
    p_studio_id,
    draft_revision_id,
    resulting_revision_version,
    p_media_id,
    result
  );
  perform private.audit_studio_media_command(
    p_user_id,
    p_request_id,
    p_idempotency_key,
    'studio.media_deleted',
    p_studio_id,
    pg_catalog.jsonb_build_object(
      'mediaId', p_media_id,
      'revisionId', draft_revision_id,
      'revisionVersion', resulting_revision_version,
      'objectStatus', media_status
    )
  );

  return result;
end;
$function$;

alter function private.delete_studio_media(uuid, uuid, uuid, bigint, uuid, uuid, uuid)
  owner to postgres;

create or replace function maintenance.prepare_studio_media_cleanup_probe(
  p_run_id uuid
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
declare
  probe maintenance.studio_media_cleanup_probes%rowtype;
  generated_media_id uuid;
begin
  if p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_studio_media_cleanup_probe';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('studio-media-cleanup-probe:' || p_run_id::text, 0)
  );
  select candidate.*
  into probe
  from maintenance.studio_media_cleanup_probes as candidate
  where candidate.run_id = p_run_id
  for update;

  if found then
    if probe.status <> 'prepared' then
      raise exception using
        errcode = '40001',
        message = 'studio_media_cleanup_probe_conflict';
    end if;
  else
    generated_media_id := extensions.gen_random_uuid();
    insert into maintenance.studio_media_cleanup_probes (
      run_id,
      media_id,
      storage_path,
      preview_storage_path
    )
    values (
      p_run_id,
      generated_media_id,
      pg_catalog.format(
        'owners/%s/studios/%s/revisions/%s/%s.webp',
        p_run_id,
        p_run_id,
        p_run_id,
        generated_media_id
      ),
      pg_catalog.format(
        'owners/%s/studios/%s/revisions/%s/%s.preview.webp',
        p_run_id,
        p_run_id,
        p_run_id,
        generated_media_id
      )
    )
    returning * into probe;
  end if;

  return pg_catalog.jsonb_build_object(
    'runId', probe.run_id,
    'status', probe.status,
    'bucket', probe.storage_bucket,
    'mediaId', probe.media_id,
    'paths', pg_catalog.jsonb_build_array(
      probe.storage_path,
      probe.preview_storage_path
    )
  );
end;
$function$;

alter function maintenance.prepare_studio_media_cleanup_probe(uuid) owner to postgres;

create or replace function maintenance.arm_studio_media_cleanup_probe(
  p_run_id uuid
) returns jsonb
  language plpgsql volatile security definer
  set search_path to ''
as $function$
declare
  probe maintenance.studio_media_cleanup_probes%rowtype;
begin
  if p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_studio_media_cleanup_probe';
  end if;

  select candidate.*
  into probe
  from maintenance.studio_media_cleanup_probes as candidate
  where candidate.run_id = p_run_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'studio_media_cleanup_probe_not_found';
  end if;

  if probe.status = 'prepared' then
    update maintenance.studio_media_cleanup_probes as candidate
    set
      status = 'queued',
      cleanup_claim_token = probe.run_id,
      cleanup_claimed_at = pg_catalog.clock_timestamp()
    where candidate.run_id = probe.run_id
    returning candidate.* into probe;
  elsif probe.status <> 'queued' then
    raise exception using
      errcode = '40001',
      message = 'studio_media_cleanup_probe_conflict';
  end if;

  return pg_catalog.jsonb_build_object(
    'runId', probe.run_id,
    'status', probe.status,
    'bucket', probe.storage_bucket,
    'mediaId', probe.media_id,
    'paths', pg_catalog.jsonb_build_array(
      probe.storage_path,
      probe.preview_storage_path
    )
  );
end;
$function$;

alter function maintenance.arm_studio_media_cleanup_probe(uuid) owner to postgres;

create or replace function maintenance.get_studio_media_cleanup_probe(
  p_run_id uuid
) returns jsonb
  language plpgsql stable security definer
  set search_path to ''
as $function$
declare
  probe maintenance.studio_media_cleanup_probes%rowtype;
begin
  if p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_studio_media_cleanup_probe';
  end if;

  select candidate.*
  into probe
  from maintenance.studio_media_cleanup_probes as candidate
  where candidate.run_id = p_run_id
    and candidate.status = 'deleted'
    and candidate.cleanup_last_completed_token = p_run_id
    and candidate.cleanup_last_succeeded is true
    and candidate.completed_at is not null;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'studio_media_cleanup_probe_not_terminal';
  end if;

  return pg_catalog.jsonb_build_object(
    'runId', probe.run_id,
    'status', probe.status,
    'bucket', probe.storage_bucket,
    'mediaId', probe.media_id,
    'paths', pg_catalog.jsonb_build_array(
      probe.storage_path,
      probe.preview_storage_path
    )
  );
end;
$function$;

alter function maintenance.get_studio_media_cleanup_probe(uuid) owner to postgres;

create or replace function maintenance.abort_studio_media_cleanup_probe(
  p_run_id uuid,
  p_error_code text
) returns void
  language plpgsql volatile security definer
  set search_path to ''
as $function$
declare
  probe maintenance.studio_media_cleanup_probes%rowtype;
begin
  if p_run_id is null
    or p_error_code is null
    or p_error_code !~ '^[a-z0-9_]{2,80}$'
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_studio_media_cleanup_probe_abort';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('studio-media-cleanup-probe:' || p_run_id::text, 0)
  );
  select candidate.*
  into probe
  from maintenance.studio_media_cleanup_probes as candidate
  where candidate.run_id = p_run_id
  for update;

  if not found or probe.status in ('deleted', 'aborted') then
    return;
  end if;

  update maintenance.studio_media_cleanup_probes as candidate
  set
    status = 'aborted',
    cleanup_claim_token = null,
    cleanup_claimed_at = null,
    cleanup_last_completed_token = probe.run_id,
    cleanup_last_succeeded = false,
    error_code = p_error_code,
    completed_at = pg_catalog.clock_timestamp()
  where candidate.run_id = probe.run_id;
end;
$function$;

alter function maintenance.abort_studio_media_cleanup_probe(uuid, text) owner to postgres;

create or replace function maintenance.claim_studio_media_cleanup(
  p_claim_token uuid,
  p_limit integer
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  claimed_at timestamptz := pg_catalog.clock_timestamp();
  items jsonb;
begin
  if p_claim_token is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_studio_media_cleanup_claim';
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

create or replace function maintenance.complete_studio_media_cleanup(
  p_claim_token uuid,
  p_media_id uuid,
  p_succeeded boolean,
  p_error_code text
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  media public.studio_media%rowtype;
  probe maintenance.studio_media_cleanup_probes%rowtype;
  completion_time timestamptz := pg_catalog.clock_timestamp();
  retry_minutes integer;
begin
  if p_claim_token is null
    or p_media_id is null
    or p_succeeded is null
    or (p_succeeded and p_error_code is not null)
    or (
      not p_succeeded
      and (p_error_code is null or p_error_code !~ '^[a-z0-9_]{2,80}$')
    )
  then
    raise exception using errcode = '22023', message = 'invalid_studio_media_cleanup_completion';
  end if;

  select candidate.*
  into probe
  from maintenance.studio_media_cleanup_probes as candidate
  where candidate.media_id = p_media_id
  for update;

  if found then
    if probe.cleanup_last_completed_token = p_claim_token then
      if probe.cleanup_last_succeeded <> p_succeeded
        or (
          not p_succeeded
          and probe.error_code is distinct from p_error_code
        )
      then
        raise exception using
          errcode = '40001',
          message = 'studio_media_cleanup_completion_conflict';
      end if;

      return pg_catalog.jsonb_build_object(
        'mediaId', probe.media_id,
        'status', probe.status,
        'succeeded', probe.cleanup_last_succeeded,
        'nextAttemptAt', null::timestamptz
      );
    end if;

    if probe.status <> 'queued'
      or probe.cleanup_claim_token <> p_claim_token
      or probe.cleanup_claimed_at is null
    then
      raise exception using
        errcode = '40001',
        message = 'studio_media_cleanup_claim_conflict';
    end if;

    update maintenance.studio_media_cleanup_probes as candidate
    set
      status = case when p_succeeded then 'deleted' else 'aborted' end,
      cleanup_claim_token = null,
      cleanup_claimed_at = null,
      cleanup_last_completed_token = p_claim_token,
      cleanup_last_succeeded = p_succeeded,
      error_code = p_error_code,
      completed_at = completion_time
    where candidate.run_id = probe.run_id
    returning candidate.* into probe;

    return pg_catalog.jsonb_build_object(
      'mediaId', probe.media_id,
      'status', probe.status,
      'succeeded', probe.cleanup_last_succeeded,
      'nextAttemptAt', null::timestamptz
    );
  end if;

  select candidate.*
  into media
  from public.studio_media as candidate
  where candidate.id = p_media_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_media_not_found';
  end if;

  if media.cleanup_last_completed_token = p_claim_token then
    if media.cleanup_last_succeeded <> p_succeeded then
      raise exception using errcode = '40001', message = 'studio_media_cleanup_completion_conflict';
    end if;
    return pg_catalog.jsonb_build_object(
      'mediaId', media.id,
      'status', media.status,
      'succeeded', media.cleanup_last_succeeded,
      'nextAttemptAt', media.cleanup_next_attempt_at
    );
  end if;

  if media.status <> 'delete_pending'
    or media.cleanup_claim_token <> p_claim_token
    or media.cleanup_claimed_at is null
  then
    raise exception using errcode = '40001', message = 'studio_media_cleanup_claim_conflict';
  end if;

  if p_succeeded then
    update public.studio_media as candidate
    set
      status = 'deleted',
      deleted_at = completion_time,
      cleanup_after = null,
      cleanup_claim_token = null,
      cleanup_claimed_at = null,
      cleanup_next_attempt_at = null,
      cleanup_last_completed_token = p_claim_token,
      cleanup_last_succeeded = true,
      cleanup_last_error_code = null
    where candidate.id = media.id
    returning candidate.* into media;
  else
    retry_minutes := least(
      360,
      pg_catalog.power(2::numeric, least(media.cleanup_attempts, 8))::integer
    );

    update public.studio_media as candidate
    set
      cleanup_claim_token = null,
      cleanup_claimed_at = null,
      cleanup_next_attempt_at = completion_time
        + pg_catalog.make_interval(mins => retry_minutes),
      cleanup_last_completed_token = p_claim_token,
      cleanup_last_succeeded = false,
      cleanup_last_error_code = p_error_code
    where candidate.id = media.id
    returning candidate.* into media;
  end if;

  return pg_catalog.jsonb_build_object(
    'mediaId', media.id,
    'status', media.status,
    'succeeded', p_succeeded,
    'nextAttemptAt', media.cleanup_next_attempt_at
  );
end;
$function$;

alter function maintenance.complete_studio_media_cleanup(uuid, uuid, boolean, text)
  owner to postgres;

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

  -- Uma execução interrompida pode não voltar com o mesmo UUID. A primeira
  -- execução posterior fecha o ledger envelhecido antes de abrir o novo run;
  -- o próximo claim reaproveita normalmente qualquer lease vencido.
  update maintenance.studio_media_cleanup_runs as abandoned
  set
    status = 'failed',
    claimed_count = 0,
    deleted_count = 0,
    failed_count = 0,
    error_code = 'cleanup_run_abandoned',
    completed_at = run_started_at
  where abandoned.run_id <> p_run_id
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
    update maintenance.studio_media_cleanup_runs as candidate
    set
      status = p_status,
      claimed_count = p_claimed,
      deleted_count = p_deleted,
      failed_count = p_failed,
      error_code = p_error_code,
      completed_at = pg_catalog.clock_timestamp()
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

create or replace function public.claim_studio_media_cleanup(
  p_claim_token uuid,
  p_limit integer
) returns jsonb
  language sql volatile security definer
  set search_path to ''
as $function$
  select maintenance.claim_studio_media_cleanup(p_claim_token, p_limit);
$function$;

alter function public.claim_studio_media_cleanup(uuid, integer) owner to postgres;

create or replace function public.complete_studio_media_cleanup(
  p_claim_token uuid,
  p_media_id uuid,
  p_succeeded boolean,
  p_error_code text
) returns jsonb
  language sql volatile security definer
  set search_path to ''
as $function$
  select maintenance.complete_studio_media_cleanup(
    p_claim_token,
    p_media_id,
    p_succeeded,
    p_error_code
  );
$function$;

alter function public.complete_studio_media_cleanup(uuid, uuid, boolean, text)
  owner to postgres;

create or replace function public.begin_studio_media_cleanup_run(
  p_run_id uuid,
  p_function_slug text
) returns jsonb
  language sql volatile security definer
  set search_path to ''
as $function$
  select maintenance.begin_studio_media_cleanup_run(p_run_id, p_function_slug);
$function$;

alter function public.begin_studio_media_cleanup_run(uuid, text) owner to postgres;

create or replace function public.complete_studio_media_cleanup_run(
  p_run_id uuid,
  p_status text,
  p_claimed integer,
  p_deleted integer,
  p_failed integer,
  p_error_code text
) returns jsonb
  language sql volatile security definer
  set search_path to ''
as $function$
  select maintenance.complete_studio_media_cleanup_run(
    p_run_id,
    p_status,
    p_claimed,
    p_deleted,
    p_failed,
    p_error_code
  );
$function$;

alter function public.complete_studio_media_cleanup_run(
  uuid, text, integer, integer, integer, text
) owner to postgres;

insert into private.dal_routine_allowlist (signature)
values
  ('private.get_owner_studio_media(uuid,uuid)'),
  ('private.prepare_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid,text,bigint,text)'),
  ('private.replay_studio_media_finalize(uuid,uuid,uuid,bigint,uuid,uuid)'),
  ('private.get_studio_media_upload_candidate(uuid,uuid,uuid,bigint,uuid)'),
  ('private.reject_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid)'),
  ('private.finalize_studio_media_upload(uuid,uuid,uuid,bigint,uuid,uuid,uuid,text,bigint,integer,integer,text)'),
  ('private.reorder_studio_media(uuid,uuid,uuid,bigint,uuid,uuid,uuid[])'),
  ('private.set_studio_media_cover(uuid,uuid,uuid,bigint,uuid,uuid,uuid)'),
  ('private.delete_studio_media(uuid,uuid,uuid,bigint,uuid,uuid,uuid)');

alter table public.studio_media enable row level security;
alter table public.studio_revision_media enable row level security;

revoke all on table public.studio_media
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.studio_revision_media
  from public, anon, authenticated, service_role, app_dal;

revoke all on function private.enforce_studio_media_lifecycle()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.assert_editable_studio_media_relation()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.clone_studio_revision_media_after_insert()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.queue_unreferenced_studio_media_after_delete()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.queue_unattached_studio_media_before_revision_delete()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.queue_studio_media_before_studio_delete()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_media_payload_hash(text, jsonb)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.get_owner_studio_media(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_media_cleanup_runs_are_healthy()
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function private.managed_runtime_boundaries_are_ready()
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function private.replay_studio_media_command(uuid, uuid, text, text, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.replay_studio_media_finalize(uuid, uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.record_studio_media_command(
  uuid, uuid, text, text, uuid, uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.audit_studio_media_command(uuid, uuid, uuid, text, uuid, jsonb)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.lock_studio_media_revision(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.prepare_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text, bigint, text
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.get_studio_media_upload_candidate(uuid, uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.reject_studio_media_upload(uuid, uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.finalize_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid, text, bigint, integer, integer, text
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.reorder_studio_media(uuid, uuid, uuid, bigint, uuid, uuid, uuid[])
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.set_studio_media_cover(uuid, uuid, uuid, bigint, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.delete_studio_media(uuid, uuid, uuid, bigint, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;

grant execute on function private.get_owner_studio_media(uuid, uuid) to app_dal;
grant execute on function private.prepare_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text, bigint, text
) to app_dal;
grant execute on function private.replay_studio_media_finalize(
  uuid, uuid, uuid, bigint, uuid, uuid
) to app_dal;
grant execute on function private.get_studio_media_upload_candidate(uuid, uuid, uuid, bigint, uuid)
  to app_dal;
grant execute on function private.reject_studio_media_upload(uuid, uuid, uuid, bigint, uuid, uuid)
  to app_dal;
grant execute on function private.finalize_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid, text, bigint, integer, integer, text
) to app_dal;
grant execute on function private.reorder_studio_media(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid[]
) to app_dal;
grant execute on function private.set_studio_media_cover(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid
) to app_dal;
grant execute on function private.delete_studio_media(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid
) to app_dal;

revoke all on table maintenance.studio_media_cleanup_runs
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on table maintenance.studio_media_cleanup_probes
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.enforce_studio_media_cleanup_run_lifecycle()
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.enforce_studio_media_cleanup_probe_lifecycle()
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.prepare_studio_media_cleanup_probe(uuid)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.arm_studio_media_cleanup_probe(uuid)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.get_studio_media_cleanup_probe(uuid)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.abort_studio_media_cleanup_probe(uuid, text)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.claim_studio_media_cleanup(uuid, integer)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.complete_studio_media_cleanup(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.begin_studio_media_cleanup_run(uuid, text)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function maintenance.complete_studio_media_cleanup_run(
  uuid, text, integer, integer, integer, text
) from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function public.claim_studio_media_cleanup(uuid, integer)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function public.complete_studio_media_cleanup(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function public.begin_studio_media_cleanup_run(uuid, text)
  from public, anon, authenticated, service_role, app_dal, app_runtime_production;
revoke all on function public.complete_studio_media_cleanup_run(
  uuid, text, integer, integer, integer, text
) from public, anon, authenticated, service_role, app_dal, app_runtime_production;
grant execute on function public.claim_studio_media_cleanup(uuid, integer)
  to service_role;
grant execute on function public.complete_studio_media_cleanup(uuid, uuid, boolean, text)
  to service_role;
grant execute on function public.begin_studio_media_cleanup_run(uuid, text)
  to service_role;
grant execute on function public.complete_studio_media_cleanup_run(
  uuid, text, integer, integer, integer, text
) to service_role;

comment on schema maintenance is
  'Fronteira administrativa não exposta; service_role alcança somente as fachadas públicas estreitas do cleanup.';
comment on table maintenance.studio_media_cleanup_runs is
  'Ledger operacional durável sem paths ou secrets; cerca run_id por slug imutável e preserva o resultado terminal por 30 dias.';
comment on table maintenance.studio_media_cleanup_probes is
  'Objetos descartáveis e privados do canário real; atravessam o mesmo claim, Storage remove e complete do worker.';
comment on table public.studio_media is
  'Objeto original e prévia WebP imutáveis no bucket privado; estado físico é independente das associações versionadas.';
comment on table public.studio_revision_media is
  'Associação ordenada e versionada entre uma revisão e objetos prontos; publicada nunca é mutada.';
comment on function private.get_owner_studio_media(uuid, uuid)
  is 'Read model privado nullable do dono elegível; paths de prévia chegam somente ao DAL server-only.';
comment on function private.prepare_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, text, bigint, text
) is 'Reserva path canônico por duas horas e mantém o candidato pendente por 24 horas, sem enviar binário pela aplicação.';
comment on function private.replay_studio_media_finalize(uuid, uuid, uuid, bigint, uuid, uuid)
  is 'Relê um finalize já confirmado pelo envelope original antes de repetir download ou escrita física.';
comment on function private.get_studio_media_upload_candidate(uuid, uuid, uuid, bigint, uuid)
  is 'Retorna ao DAL o bucket/path canônicos ainda válidos para emitir o token de upload.';
comment on function private.reject_studio_media_upload(uuid, uuid, uuid, bigint, uuid, uuid)
  is 'Rejeita de forma naturalmente idempotente um candidato cuja verificação de bytes falhou.';
comment on function private.finalize_studio_media_upload(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid, text, bigint, integer, integer, text
) is 'Persiste fatos verificados, associa a mídia pronta e incrementa a versão da draft uma vez.';
comment on function private.reorder_studio_media(uuid, uuid, uuid, bigint, uuid, uuid, uuid[])
  is 'Substitui a ordem completa da galeria sob lock e constraint diferível.';
comment on function private.set_studio_media_cover(uuid, uuid, uuid, bigint, uuid, uuid, uuid)
  is 'Define no máximo uma capa da draft de forma atômica; replay e no-op preservam a versão.';
comment on function private.delete_studio_media(uuid, uuid, uuid, bigint, uuid, uuid, uuid)
  is 'Remove somente a associação da draft; objeto compartilhado permanece e órfão entra em delete_pending.';
comment on function private.queue_studio_media_before_studio_delete()
  is 'Enfileira toda mídia não terminal antes das ações FK e nunca antecipa cleanup ao vencimento do upload assinado.';
comment on function maintenance.prepare_studio_media_cleanup_probe(uuid)
  is 'Reserva identidade e paths relacionais descartáveis sem depender de usuário ou mídia de produto.';
comment on function maintenance.arm_studio_media_cleanup_probe(uuid)
  is 'Cerca o probe preparado com cleanup_claim_token igual ao run_id antes da invocação candidata.';
comment on function maintenance.get_studio_media_cleanup_probe(uuid)
  is 'Retorna o contrato exato somente após o mesmo worker confirmar terminal deleted.';
comment on function maintenance.abort_studio_media_cleanup_probe(uuid, text)
  is 'Aborta de forma idempotente um probe parcial usando somente código de erro seguro.';
comment on function maintenance.claim_studio_media_cleanup(uuid, integer)
  is 'Claim idempotente e cercado por token para mídia real ou probe privado ser removido pela Storage API.';
comment on function maintenance.complete_studio_media_cleanup(uuid, uuid, boolean, text)
  is 'Confirma ausência física de mídia/probe ou agenda retry de produto; nunca remove storage.objects por SQL.';
comment on function maintenance.begin_studio_media_cleanup_run(uuid, text)
  is 'Cria a execução diretamente em running, cerca replay por run_id e slug e purga somente terminais com mais de 30 dias.';
comment on function maintenance.complete_studio_media_cleanup_run(
  uuid, text, integer, integer, integer, text
) is 'Fecha uma execução com contagens balanceadas; replay idêntico converge e divergência falha fechada.';
comment on function public.claim_studio_media_cleanup(uuid, integer)
  is 'Fachada RPC sem lógica própria, executável somente por service_role, para o claim em maintenance.';
comment on function public.complete_studio_media_cleanup(uuid, uuid, boolean, text)
  is 'Fachada RPC sem lógica própria, executável somente por service_role, para o complete em maintenance.';
comment on function public.begin_studio_media_cleanup_run(uuid, text)
  is 'Fachada service_role-only para criar ou reler atomicamente uma execução cercada pelo slug da Edge Function.';
comment on function public.complete_studio_media_cleanup_run(
  uuid, text, integer, integer, integer, text
) is 'Fachada service_role-only para concluir o ledger com contagens e código seguro.';
