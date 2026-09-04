alter table public.profiles
  add column account_version bigint not null default 0,
  add constraint profiles_account_version_check check (account_version >= 0);

comment on column public.profiles.account_version is
  'Versão otimista do estado operacional da conta: status e autorizações; não altera a versão da identidade nem a sincronização do recebedor.';

create or replace function private.set_profile_updated_at() returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.profile_version := old.profile_version + case
    when (
      new.person_type,
      new.completed_at,
      new.name,
      new.phone_e164,
      new.tax_id,
      new.additional_document
    ) is distinct from (
      old.person_type,
      old.completed_at,
      old.name,
      old.phone_e164,
      old.tax_id,
      old.additional_document
    ) then 1
    else 0
  end;
  new.account_version := old.account_version + case
    when new.status is distinct from old.status
      or new.account_version is distinct from old.account_version
    then 1
    else 0
  end;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

alter function private.set_profile_updated_at() owner to postgres;

comment on function private.set_profile_updated_at() is
  'Atualiza timestamp e mantém versões independentes para identidade e estado operacional da conta.';

create index profiles_backoffice_created_at_id_idx
  on public.profiles (created_at desc, id desc);

alter table public.studio_types
  add column taxonomy_version bigint not null default 0,
  add constraint studio_types_taxonomy_version_check check (taxonomy_version >= 0);

alter table public.tags
  add column taxonomy_version bigint not null default 0,
  add constraint tags_taxonomy_version_check check (taxonomy_version >= 0);

alter table public.amenities
  add column taxonomy_version bigint not null default 0,
  add constraint amenities_taxonomy_version_check check (taxonomy_version >= 0);

create trigger studio_types_set_updated_at
  before update on public.studio_types
  for each row execute function private.set_studio_updated_at();

create table public.platform_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (user_id, role),
  constraint platform_roles_role_check check (
    role = any (array['support'::text, 'admin'::text])
  )
);

comment on table public.platform_roles is
  'Papéis cumulativos entregues pela FEAT-031; não antecipa reviewer ou finance e não possui acesso direto de runtime.';

create index platform_roles_role_user_id_idx
  on public.platform_roles (role, user_id);
create index platform_roles_granted_by_idx
  on public.platform_roles (granted_by)
  where granted_by is not null;

create or replace function private.touch_platform_role_account_version() returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  update public.profiles as profile
  set account_version = profile.account_version + 1
  where profile.id = case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

alter function private.touch_platform_role_account_version() owner to postgres;

create trigger platform_roles_touch_account_version
  after insert or delete on public.platform_roles
  for each row execute function private.touch_platform_role_account_version();

comment on function private.touch_platform_role_account_version() is
  'Avança a versão opaca de autorização em toda concessão ou revogação de papel.';

create table private.backoffice_sessions (
  auth_session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  opened_at timestamptz not null,
  last_seen_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  closed_at timestamptz,
  constraint backoffice_sessions_window_check check (
    last_seen_at >= opened_at
    and absolute_expires_at > opened_at
    and (closed_at is null or closed_at >= opened_at)
  )
);

comment on table private.backoffice_sessions is
  'Binding curta do backoffice para uma sessão Auth canônica; expira por 30 minutos de inatividade ou oito horas absolutas.';

create index backoffice_sessions_user_id_idx
  on private.backoffice_sessions (user_id);

create table private.backoffice_command_requests (
  actor_user_id uuid not null references public.profiles(id) on delete cascade,
  idempotency_key uuid not null,
  action text not null,
  payload_hash text not null,
  result_hash text,
  target_type text not null,
  target_id uuid not null,
  result_profile_version bigint,
  result_auth_updated_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (actor_user_id, idempotency_key),
  constraint backoffice_command_requests_action_check check (
    action = any (array[
      'backoffice.user.restore'::text,
      'backoffice.user.suspend'::text,
      'backoffice.user.revealPii'::text,
      'backoffice.access.grantAdmin'::text,
      'backoffice.access.grantSupport'::text,
      'backoffice.access.revokeAdmin'::text,
      'backoffice.access.revokeSupport'::text,
      'backoffice.taxonomy.upsert'::text,
      'backoffice.taxonomy.setActive'::text
    ])
  ),
  constraint backoffice_command_requests_payload_hash_check check (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint backoffice_command_requests_result_hash_check check (
    result_hash is null or result_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint backoffice_command_requests_target_type_check check (
    target_type = any (array[
      'profile'::text,
      'platform_role'::text,
      'studio_type'::text,
      'tag'::text,
      'amenity'::text
    ])
  ),
  constraint backoffice_command_requests_result_shape_check check (
    (
      action = 'backoffice.user.revealPii'
      and result_hash is null
      and result_profile_version is not null
      and result_auth_updated_at is not null
    )
    or (
      action <> 'backoffice.user.revealPii'
      and result_hash is not null
      and result_profile_version is null
      and result_auth_updated_at is null
    )
  )
);

alter table public.platform_roles owner to postgres;
alter table private.backoffice_sessions owner to postgres;
alter table private.backoffice_command_requests owner to postgres;

comment on table private.backoffice_command_requests is
  'Ledger mínimo dos comandos administrativos; PII nunca é persistida nem recebe hash reutilizável.';

alter table public.platform_roles enable row level security;
alter table private.backoffice_sessions enable row level security;
alter table private.backoffice_command_requests enable row level security;

create or replace function private.backoffice_payload_hash(payload jsonb)
returns text
language sql
immutable
security definer
set search_path = ''
as $function$
  select pg_catalog.encode(extensions.digest(payload::text, 'sha256'), 'hex');
$function$;

alter function private.backoffice_payload_hash(jsonb) owner to postgres;

create or replace function private.backoffice_result_hash(result jsonb)
returns text
language sql
immutable
security definer
set search_path = ''
as $function$
  select pg_catalog.encode(extensions.digest(result::text, 'sha256'), 'hex');
$function$;

alter function private.backoffice_result_hash(jsonb) owner to postgres;

create or replace function private.platform_roles_for_user(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.array_agg(
      platform_role.role
      order by case platform_role.role when 'support' then 1 else 2 end
    ),
    '{}'::text[]
  )
  from public.platform_roles as platform_role
  where platform_role.user_id = p_user_id;
$function$;

alter function private.platform_roles_for_user(uuid) owner to postgres;

create or replace function private.mask_backoffice_email(p_email text)
returns text
language sql
immutable
security definer
set search_path = ''
as $function$
  select case
    when p_email is null or pg_catalog.strpos(p_email, '@') <= 1 then null
    else
      pg_catalog.left(pg_catalog.split_part(p_email, '@', 1), 1)
      || '***@'
      || pg_catalog.split_part(p_email, '@', 2)
  end;
$function$;

alter function private.mask_backoffice_email(text) owner to postgres;

create or replace function private.backoffice_user_summary_json(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'accountVersion', profile.account_version,
    'createdAt', profile.created_at,
    'emailMasked', private.mask_backoffice_email(auth_user.email),
    'id', profile.id,
    'status', profile.status
  )
  into result
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where profile.id = p_user_id
    and auth_user.email is not null;

  if result is null then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
  return result;
end;
$function$;

alter function private.backoffice_user_summary_json(uuid) owner to postgres;

create or replace function private.backoffice_user_pii_json(
  p_actor_user_id uuid,
  p_target_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'additionalDocument', profile.additional_document,
    'email', auth_user.email,
    'name', profile.name,
    'phoneE164', profile.phone_e164,
    'scope', p_actor_user_id,
    'taxId', profile.tax_id,
    'userId', profile.id
  )
  into result
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
    and auth_user.email is not null;

  if result is null then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
  return result;
end;
$function$;

alter function private.backoffice_user_pii_json(uuid, uuid) owner to postgres;

create or replace function private.backoffice_taxonomy_item_json(
  p_kind text,
  p_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
begin
  if p_kind = 'studioType' then
    select pg_catalog.jsonb_build_object(
      'active', item.active,
      'id', item.id,
      'kind', p_kind,
      'name', item.name,
      'slug', item.slug,
      'sortOrder', item.sort_order,
      'updatedAt', item.updated_at,
      'usageCount', (
        select pg_catalog.count(*)
        from public.studio_revisions as revision
        where revision.studio_type_id = item.id
      ),
      'version', item.taxonomy_version
    )
    into result
    from public.studio_types as item
    where item.id = p_id;
  elsif p_kind = 'tag' then
    select pg_catalog.jsonb_build_object(
      'active', item.active,
      'id', item.id,
      'kind', p_kind,
      'name', item.name,
      'slug', item.slug,
      'sortOrder', item.sort_order,
      'updatedAt', item.updated_at,
      'usageCount', (
        select pg_catalog.count(*)
        from public.studio_revision_tags as relation
        where relation.tag_id = item.id
      ),
      'version', item.taxonomy_version
    )
    into result
    from public.tags as item
    where item.id = p_id;
  elsif p_kind = 'amenity' then
    select pg_catalog.jsonb_build_object(
      'active', item.active,
      'id', item.id,
      'kind', p_kind,
      'name', item.name,
      'slug', item.slug,
      'sortOrder', item.sort_order,
      'updatedAt', item.updated_at,
      'usageCount', (
        select pg_catalog.count(*)
        from public.studio_revision_amenities as relation
        where relation.amenity_id = item.id
      ),
      'version', item.taxonomy_version
    )
    into result
    from public.amenities as item
    where item.id = p_id;
  else
    raise exception using errcode = '22023', message = 'invalid_backoffice_taxonomy_kind';
  end if;

  if result is null then
    raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
  end if;
  return result;
end;
$function$;

alter function private.backoffice_taxonomy_item_json(text, uuid) owner to postgres;

create or replace function private.open_backoffice_session(
  p_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz
)
returns table (
  scope uuid,
  authorization_version bigint,
  roles text[],
  expires_at timestamptz,
  strong_authentication_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  opened_at timestamptz := pg_catalog.clock_timestamp();
  current_authorization_version bigint;
  canonical_not_after timestamptz;
  current_roles text[];
begin
  if pg_catalog.current_setting('app.settings.jwt_exp', true) is distinct from '3600' then
    raise exception using errcode = '55000', message = 'backoffice_jwt_expiry_not_pinned';
  end if;
  if p_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_auth_expires_at <= opened_at
    or p_auth_expires_at > opened_at + interval '65 minutes'
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_session';
  end if;

  select auth_session.not_after
  into canonical_not_after
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
    and (auth_session.not_after is null or auth_session.not_after > opened_at)
  for key share;

  if not found then
    raise exception using errcode = '42501', message = 'backoffice_auth_session_invalid';
  end if;
  select profile.account_version
  into current_authorization_version
  from public.profiles as profile
  where profile.id = p_user_id
    and profile.status = 'active'
    and profile.completed_at is not null
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'backoffice_profile_ineligible';
  end if;

  current_roles := private.platform_roles_for_user(p_user_id);
  if pg_catalog.cardinality(current_roles) = 0 then
    raise exception using errcode = '42501', message = 'backoffice_role_required';
  end if;

  insert into private.backoffice_sessions (
    auth_session_id,
    user_id,
    opened_at,
    last_seen_at,
    absolute_expires_at,
    closed_at
  )
  values (
    p_auth_session_id,
    p_user_id,
    opened_at,
    opened_at,
    least(
      opened_at + interval '8 hours',
      coalesce(canonical_not_after, opened_at + interval '8 hours')
    ),
    null
  )
  on conflict (auth_session_id) do update
  set
    user_id = excluded.user_id,
    opened_at = excluded.opened_at,
    last_seen_at = excluded.last_seen_at,
    absolute_expires_at = excluded.absolute_expires_at,
    closed_at = null;

  return query
  select
    p_user_id,
    current_authorization_version,
    current_roles,
    least(
      opened_at + interval '8 hours',
      coalesce(canonical_not_after, opened_at + interval '8 hours'),
      p_auth_expires_at,
      opened_at + interval '30 minutes'
    ),
    opened_at + interval '5 minutes';
end;
$function$;

alter function private.open_backoffice_session(uuid, uuid, timestamptz) owner to postgres;

create or replace function private.backoffice_session_context(
  p_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_required_role text,
  p_require_strong_authentication boolean,
  p_touch_activity boolean
)
returns table (
  actor_role text,
  authorization_version bigint,
  roles text[],
  expires_at timestamptz,
  strong_authentication_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  checked_at timestamptz := pg_catalog.clock_timestamp();
  current_authorization_version bigint;
  binding private.backoffice_sessions%rowtype;
  canonical_not_after timestamptz;
  current_roles text[];
begin
  if pg_catalog.current_setting('app.settings.jwt_exp', true) is distinct from '3600' then
    raise exception using errcode = '55000', message = 'backoffice_jwt_expiry_not_pinned';
  end if;
  if p_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_auth_expires_at <= checked_at
    or p_auth_expires_at > checked_at + interval '65 minutes'
    or (p_required_role is not null and p_required_role <> 'admin')
    or p_touch_activity is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_session';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0)
  );

  select session_binding.*
  into binding
  from private.backoffice_sessions as session_binding
  where session_binding.auth_session_id = p_auth_session_id
    and session_binding.user_id = p_user_id
  for update;

  if not found
    or binding.closed_at is not null
    or binding.last_seen_at + interval '30 minutes' <= checked_at
    or binding.absolute_expires_at <= checked_at
  then
    raise exception using errcode = '42501', message = 'backoffice_session_expired';
  end if;

  select auth_session.not_after
  into canonical_not_after
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
    and (auth_session.not_after is null or auth_session.not_after > checked_at)
  for key share;

  if not found then
    raise exception using errcode = '42501', message = 'backoffice_auth_session_invalid';
  end if;
  select profile.account_version
  into current_authorization_version
  from public.profiles as profile
  where profile.id = p_user_id
    and profile.status = 'active'
    and profile.completed_at is not null
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'backoffice_profile_ineligible';
  end if;

  current_roles := private.platform_roles_for_user(p_user_id);
  if pg_catalog.cardinality(current_roles) = 0
    or (p_required_role is not null and not p_required_role = any(current_roles))
  then
    raise exception using errcode = '42501', message = 'backoffice_role_required';
  end if;
  if p_require_strong_authentication
    and binding.opened_at + interval '5 minutes' <= checked_at
  then
    raise exception using errcode = '42501', message = 'backoffice_reauthentication_required';
  end if;

  if p_touch_activity then
    update private.backoffice_sessions as session_binding
    set last_seen_at = checked_at
    where session_binding.auth_session_id = p_auth_session_id;
  end if;

  return query
  select
    case when 'admin' = any(current_roles) then 'admin'::text else 'support'::text end,
    current_authorization_version,
    current_roles,
    least(
      binding.absolute_expires_at,
      coalesce(canonical_not_after, binding.absolute_expires_at),
      p_auth_expires_at,
      (
        case
          when p_touch_activity then checked_at
          else binding.last_seen_at
        end
      ) + interval '30 minutes'
    ),
    binding.opened_at + interval '5 minutes';
end;
$function$;

alter function private.backoffice_session_context(uuid, uuid, timestamptz, text, boolean, boolean)
  owner to postgres;

create or replace function private.get_backoffice_session(
  p_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz
)
returns table (
  scope uuid,
  authorization_version bigint,
  roles text[],
  expires_at timestamptz,
  strong_authentication_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  context record;
begin
  select *
  into strict context
  from private.backoffice_session_context(
    p_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    null,
    false,
    false
  );
  return query
  select
    p_user_id,
    context.authorization_version,
    context.roles,
    context.expires_at,
    context.strong_authentication_expires_at;
end;
$function$;

alter function private.get_backoffice_session(uuid, uuid, timestamptz) owner to postgres;

create or replace function private.close_backoffice_session(
  p_user_id uuid,
  p_auth_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null or p_auth_session_id is null then
    raise exception using errcode = '22023', message = 'invalid_backoffice_session';
  end if;
  update private.backoffice_sessions as session_binding
  set closed_at = coalesce(session_binding.closed_at, pg_catalog.clock_timestamp())
  where session_binding.auth_session_id = p_auth_session_id
    and session_binding.user_id = p_user_id;
  return found;
end;
$function$;

alter function private.close_backoffice_session(uuid, uuid) owner to postgres;

create or replace function private.list_backoffice_users(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_query text,
  p_cursor_created_at timestamptz,
  p_cursor_id uuid,
  p_limit integer
)
returns table (
  account_version bigint,
  created_at timestamptz,
  email_masked text,
  id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_query text := nullif(pg_catalog.btrim(p_query), '');
begin
  perform private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    null,
    false,
    true
  );
  if (p_cursor_created_at is null) <> (p_cursor_id is null)
    or p_limit is null
    or p_limit < 1
    or p_limit > 51
    or (normalized_query is not null and pg_catalog.char_length(normalized_query) > 160)
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_user_query';
  end if;

  return query
  select
    profile.account_version,
    profile.created_at,
    private.mask_backoffice_email(auth_user.email),
    profile.id,
    profile.status
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where auth_user.email is not null
    and (
      normalized_query is null
      or pg_catalog.starts_with(
        pg_catalog.lower(auth_user.email),
        pg_catalog.lower(normalized_query)
      )
      or pg_catalog.starts_with(
        pg_catalog.lower(coalesce(profile.name, '')),
        pg_catalog.lower(normalized_query)
      )
      or profile.id::text = pg_catalog.lower(normalized_query)
    )
    and (
      p_cursor_created_at is null
      or (profile.created_at, profile.id) < (p_cursor_created_at, p_cursor_id)
    )
  order by profile.created_at desc, profile.id desc
  limit p_limit;
end;
$function$;

alter function private.list_backoffice_users(
  uuid, uuid, timestamptz, text, timestamptz, uuid, integer
) owner to postgres;

create or replace function private.get_backoffice_user_access(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_target_user_id uuid
)
returns table (
  account_version bigint,
  created_at timestamptz,
  email_masked text,
  id uuid,
  roles text[],
  status text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_target_user_id is null then
    raise exception using errcode = '22023', message = 'invalid_backoffice_access_target';
  end if;
  perform private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
    false,
    true
  );
  return query
  select
    profile.account_version,
    profile.created_at,
    private.mask_backoffice_email(auth_user.email),
    profile.id,
    private.platform_roles_for_user(profile.id),
    profile.status
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
    and auth_user.email is not null;
  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
end;
$function$;

alter function private.get_backoffice_user_access(uuid, uuid, timestamptz, uuid)
  owner to postgres;

create or replace function private.list_backoffice_taxonomies(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz
)
returns table (
  active boolean,
  id uuid,
  kind text,
  name text,
  slug text,
  sort_order smallint,
  updated_at timestamptz,
  usage_count bigint,
  taxonomy_version bigint
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
    false,
    true
  );
  return query
  select *
  from (
    select
      item.active,
      item.id,
      'studioType'::text as kind,
      item.name,
      item.slug,
      item.sort_order,
      item.updated_at,
      (
        select pg_catalog.count(*)
        from public.studio_revisions as revision
        where revision.studio_type_id = item.id
      ) as usage_count,
      item.taxonomy_version
    from public.studio_types as item
    union all
    select
      item.active,
      item.id,
      'tag'::text,
      item.name,
      item.slug,
      item.sort_order,
      item.updated_at,
      (
        select pg_catalog.count(*)
        from public.studio_revision_tags as relation
        where relation.tag_id = item.id
      ),
      item.taxonomy_version
    from public.tags as item
    union all
    select
      item.active,
      item.id,
      'amenity'::text,
      item.name,
      item.slug,
      item.sort_order,
      item.updated_at,
      (
        select pg_catalog.count(*)
        from public.studio_revision_amenities as relation
        where relation.amenity_id = item.id
      ),
      item.taxonomy_version
    from public.amenities as item
  ) as taxonomy
  order by
    case taxonomy.kind when 'studioType' then 1 when 'tag' then 2 else 3 end,
    taxonomy.sort_order,
    taxonomy.name,
    taxonomy.id
  limit 501;
end;
$function$;

alter function private.list_backoffice_taxonomies(uuid, uuid, timestamptz) owner to postgres;

create or replace function private.canonical_platform_roles(p_roles text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
declare
  canonical_roles text[];
begin
  if p_roles is null
    or pg_catalog.cardinality(p_roles) > 2
    or exists (
      select 1
      from pg_catalog.unnest(p_roles) as candidate(role)
      where candidate.role is null
        or candidate.role <> all (array['support'::text, 'admin'::text])
    )
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_roles';
  end if;

  select coalesce(
    pg_catalog.array_agg(
      candidate.role
      order by case candidate.role when 'support' then 1 else 2 end
    ),
    '{}'::text[]
  )
  into canonical_roles
  from (
    select distinct expanded.role
    from pg_catalog.unnest(p_roles) as expanded(role)
  ) as candidate;

  if pg_catalog.cardinality(canonical_roles) <> pg_catalog.cardinality(p_roles) then
    raise exception using errcode = '22023', message = 'invalid_backoffice_roles';
  end if;

  return canonical_roles;
end;
$function$;

alter function private.canonical_platform_roles(text[]) owner to postgres;

alter table audit.events drop constraint events_actor_role_check;
alter table audit.events add constraint events_actor_role_check check (
  actor_role = any (array[
    'authenticated'::text,
    'support'::text,
    'admin'::text,
    'system'::text
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

alter table audit.events drop constraint events_target_type_check;
alter table audit.events add constraint events_target_type_check check (
  target_type = any (array[
    'owner_profile'::text,
    'owner_payment_recipient'::text,
    'studio'::text,
    'profile'::text,
    'platform_role'::text,
    'studio_type'::text,
    'tag'::text,
    'amenity'::text
  ])
);

create or replace function private.bootstrap_first_platform_admin(
  p_user_id uuid,
  p_request_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result jsonb;
begin
  if p_user_id is null or p_request_id is null or p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'invalid_backoffice_admin_bootstrap';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0)
  );

  if exists (
    select 1
    from audit.events as event
    where event.action = 'backoffice.admin_bootstrapped'
      and event.target_type = 'platform_role'
      and event.target_id = p_user_id
      and event.idempotency_key = p_idempotency_key
  ) then
    if not exists (
      select 1
      from public.platform_roles as platform_role
      where platform_role.user_id = p_user_id
        and platform_role.role = 'admin'
    ) then
      raise exception using errcode = '40001', message = 'backoffice_admin_bootstrap_result_stale';
    end if;
    return private.backoffice_user_summary_json(p_user_id);
  end if;

  if exists (select 1 from public.platform_roles) then
    raise exception using errcode = '42501', message = 'backoffice_admin_bootstrap_unavailable';
  end if;

  perform 1
  from public.profiles as profile
  where profile.id = p_user_id
    and profile.status = 'active'
    and profile.completed_at is not null
  for share;

  if not found then
    raise exception using errcode = '42501', message = 'backoffice_admin_bootstrap_profile_ineligible';
  end if;

  perform 1
  from auth.users as auth_user
  where auth_user.id = p_user_id
    and auth_user.email is not null
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;

  insert into public.platform_roles (user_id, role, granted_by)
  values (p_user_id, 'admin', null);

  result := private.backoffice_user_summary_json(p_user_id);

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
    null,
    'system',
    'backoffice.admin_bootstrapped',
    'platform_role',
    p_user_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object('role', 'admin')
  );

  return result;
end;
$function$;

alter function private.bootstrap_first_platform_admin(uuid, uuid, uuid) owner to postgres;

create or replace function private.set_backoffice_user_status(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_target_user_id uuid,
  p_expected_account_version bigint,
  p_action text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_context record;
  current_profile public.profiles%rowtype;
  existing_request private.backoffice_command_requests%rowtype;
  payload_hash text;
  result jsonb;
  target_status text;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_target_user_id is null
    or p_expected_account_version is null
    or p_expected_account_version < 0
    or p_action is null
    or p_action <> all (
      array['backoffice.user.restore'::text, 'backoffice.user.suspend'::text]
    )
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_user_status';
  end if;

  target_status := case p_action
    when 'backoffice.user.suspend' then 'suspended'
    else 'active'
  end;

  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'expectedAccountVersion', p_expected_account_version,
      'userId', p_target_user_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0)
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    null,
    false,
    true
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_actor_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select request.*
  into existing_request
  from private.backoffice_command_requests as request
  where request.actor_user_id = p_actor_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> p_action
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> 'profile'
      or existing_request.target_id <> p_target_user_id
    then
      raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
    end if;

    perform 1
    from public.profiles as profile
    where profile.id = p_target_user_id
    for share;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_user_status_result_missing';
    end if;
    perform 1
    from auth.users as auth_user
    where auth_user.id = p_target_user_id
      and auth_user.email is not null
    for share;
    result := private.backoffice_user_summary_json(p_target_user_id);
    if private.backoffice_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'backoffice_user_status_result_stale';
    end if;
    return result;
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_target_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
  if current_profile.account_version <> p_expected_account_version then
    raise exception using errcode = '40001', message = 'backoffice_account_version_conflict';
  end if;
  if current_profile.status = target_status then
    raise exception using errcode = '23514', message = 'backoffice_user_status_unchanged';
  end if;

  if target_status = 'suspended'
    and exists (
      select 1
      from public.platform_roles as platform_role
      where platform_role.user_id = p_target_user_id
        and platform_role.role = 'admin'
    )
    and not exists (
      select 1
      from public.platform_roles as platform_role
      join public.profiles as profile on profile.id = platform_role.user_id
      where platform_role.role = 'admin'
        and platform_role.user_id <> p_target_user_id
        and profile.status = 'active'
        and profile.completed_at is not null
    )
  then
    raise exception using errcode = '23514', message = 'backoffice_last_active_admin_required';
  end if;

  update public.profiles as profile
  set status = target_status
  where profile.id = p_target_user_id
    and profile.account_version = p_expected_account_version
  returning profile.* into current_profile;

  if not found then
    raise exception using errcode = '40001', message = 'backoffice_account_version_conflict';
  end if;

  if target_status = 'suspended' then
    update private.backoffice_sessions as session_binding
    set closed_at = coalesce(session_binding.closed_at, pg_catalog.clock_timestamp())
    where session_binding.user_id = p_target_user_id;
  end if;

  perform 1
  from auth.users as auth_user
  where auth_user.id = p_target_user_id
    and auth_user.email is not null
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;

  result := private.backoffice_user_summary_json(p_target_user_id);

  insert into private.backoffice_command_requests (
    actor_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    target_type,
    target_id
  )
  values (
    p_actor_user_id,
    p_idempotency_key,
    p_action,
    payload_hash,
    private.backoffice_result_hash(result),
    'profile',
    p_target_user_id
  );

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
    p_actor_user_id,
    actor_context.actor_role,
    case
      when target_status = 'suspended' then 'backoffice.user_suspended'
      else 'backoffice.user_restored'
    end,
    'profile',
    p_target_user_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'accountVersion', current_profile.account_version,
      'previousStatus', case when target_status = 'suspended' then 'active' else 'suspended' end,
      'status', target_status
    )
  );

  return result;
end;
$function$;

alter function private.set_backoffice_user_status(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) owner to postgres;

create or replace function private.reveal_backoffice_user_pii(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_target_user_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_context record;
  auth_updated_at timestamptz;
  existing_request private.backoffice_command_requests%rowtype;
  payload_hash text;
  profile_version bigint;
  result jsonb;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_target_user_id is null
    or p_reason is null
    or p_reason <> all (array[
      'identity_verification'::text,
      'legal_request'::text,
      'security_investigation'::text,
      'support_case'::text
    ])
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_pii_reveal';
  end if;

  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'reason', p_reason,
      'userId', p_target_user_id
    )
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    null,
    false,
    true
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_actor_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select request.*
  into existing_request
  from private.backoffice_command_requests as request
  where request.actor_user_id = p_actor_user_id
    and request.idempotency_key = p_idempotency_key;

  if found
    and (
      existing_request.action <> 'backoffice.user.revealPii'
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> 'profile'
      or existing_request.target_id <> p_target_user_id
    )
  then
    raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
  end if;

  select
    profile.profile_version,
    coalesce(auth_user.updated_at, auth_user.created_at)
  into profile_version, auth_updated_at
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where profile.id = p_target_user_id
    and auth_user.email is not null
  for share of profile, auth_user;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;

  result := private.backoffice_user_pii_json(p_actor_user_id, p_target_user_id);

  if existing_request.actor_user_id is not null then
    if existing_request.result_profile_version <> profile_version
      or existing_request.result_auth_updated_at <> auth_updated_at
    then
      raise exception using errcode = '40001', message = 'backoffice_pii_result_stale';
    end if;
    return result;
  end if;

  insert into private.backoffice_command_requests (
    actor_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    target_type,
    target_id,
    result_profile_version,
    result_auth_updated_at
  )
  values (
    p_actor_user_id,
    p_idempotency_key,
    'backoffice.user.revealPii',
    payload_hash,
    null,
    'profile',
    p_target_user_id,
    profile_version,
    auth_updated_at
  );

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
    p_actor_user_id,
    actor_context.actor_role,
    'backoffice.user_pii_revealed',
    'profile',
    p_target_user_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object('reason', p_reason)
  );

  return result;
end;
$function$;

alter function private.reveal_backoffice_user_pii(
  uuid, uuid, timestamptz, uuid, text, uuid, uuid
) owner to postgres;

create or replace function private.set_backoffice_user_role(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_target_user_id uuid,
  p_expected_account_version bigint,
  p_action text,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_context record;
  current_profile public.profiles%rowtype;
  current_roles text[];
  enabled boolean;
  existing_request private.backoffice_command_requests%rowtype;
  payload_hash text;
  result jsonb;
  role_to_change text;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_target_user_id is null
    or p_expected_account_version is null
    or p_expected_account_version < 0
    or p_action is null
    or p_action <> all (array[
      'backoffice.access.grantAdmin'::text,
      'backoffice.access.grantSupport'::text,
      'backoffice.access.revokeAdmin'::text,
      'backoffice.access.revokeSupport'::text
    ])
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_role_change';
  end if;

  role_to_change := case
    when p_action in ('backoffice.access.grantAdmin', 'backoffice.access.revokeAdmin')
      then 'admin'
    else 'support'
  end;
  enabled := p_action in ('backoffice.access.grantAdmin', 'backoffice.access.grantSupport');
  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'expectedAccountVersion', p_expected_account_version,
      'userId', p_target_user_id
    )
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('set-livre:backoffice-authorization', 0)
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
    true,
    true
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_actor_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select request.*
  into existing_request
  from private.backoffice_command_requests as request
  where request.actor_user_id = p_actor_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> p_action
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> 'platform_role'
      or existing_request.target_id <> p_target_user_id
    then
      raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
    end if;

    perform 1
    from public.profiles as profile
    where profile.id = p_target_user_id
    for share;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_role_result_missing';
    end if;
    perform 1
    from auth.users as auth_user
    where auth_user.id = p_target_user_id
      and auth_user.email is not null
    for share;
    result := private.backoffice_user_summary_json(p_target_user_id);
    if private.backoffice_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'backoffice_role_result_stale';
    end if;
    return result;
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_target_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;
  if current_profile.account_version <> p_expected_account_version then
    raise exception using errcode = '40001', message = 'backoffice_roles_conflict';
  end if;
  if enabled
    and (current_profile.status <> 'active' or current_profile.completed_at is null)
  then
    raise exception using errcode = '42501', message = 'backoffice_role_target_ineligible';
  end if;

  current_roles := private.platform_roles_for_user(p_target_user_id);
  if enabled = (role_to_change = any(current_roles)) then
    raise exception using errcode = '23514', message = 'backoffice_role_unchanged';
  end if;

  if not enabled
    and role_to_change = 'admin'
    and current_profile.status = 'active'
    and current_profile.completed_at is not null
    and not exists (
      select 1
      from public.platform_roles as platform_role
      join public.profiles as profile on profile.id = platform_role.user_id
      where platform_role.role = 'admin'
        and platform_role.user_id <> p_target_user_id
        and profile.status = 'active'
        and profile.completed_at is not null
    )
  then
    raise exception using errcode = '23514', message = 'backoffice_last_active_admin_required';
  end if;

  if enabled then
    insert into public.platform_roles (user_id, role, granted_by)
    values (p_target_user_id, role_to_change, p_actor_user_id);
  else
    delete from public.platform_roles as platform_role
    where platform_role.user_id = p_target_user_id
      and platform_role.role = role_to_change;
    if not found then
      raise exception using errcode = '40001', message = 'backoffice_roles_conflict';
    end if;
  end if;

  current_roles := private.platform_roles_for_user(p_target_user_id);
  if pg_catalog.cardinality(current_roles) = 0 then
    update private.backoffice_sessions as session_binding
    set closed_at = coalesce(session_binding.closed_at, pg_catalog.clock_timestamp())
    where session_binding.user_id = p_target_user_id;
  end if;

  perform 1
  from auth.users as auth_user
  where auth_user.id = p_target_user_id
    and auth_user.email is not null
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_user_missing';
  end if;

  result := private.backoffice_user_summary_json(p_target_user_id);

  insert into private.backoffice_command_requests (
    actor_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    target_type,
    target_id
  )
  values (
    p_actor_user_id,
    p_idempotency_key,
    p_action,
    payload_hash,
    private.backoffice_result_hash(result),
    'platform_role',
    p_target_user_id
  );

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
    p_actor_user_id,
    actor_context.actor_role,
    case
      when enabled then 'backoffice.role_granted'
      else 'backoffice.role_revoked'
    end,
    'platform_role',
    p_target_user_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'role', role_to_change,
      'roles', pg_catalog.to_jsonb(current_roles)
    )
  );

  return result;
end;
$function$;

alter function private.set_backoffice_user_role(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) owner to postgres;

create or replace function private.upsert_backoffice_taxonomy(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_kind text,
  p_id uuid,
  p_expected_version bigint,
  p_slug text,
  p_name text,
  p_sort_order integer,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_context record;
  current_version bigint;
  existing_request private.backoffice_command_requests%rowtype;
  is_create boolean;
  payload_hash text;
  result jsonb;
  target_id uuid;
  target_type text;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_kind is null
    or p_kind <> all (array['studioType'::text, 'tag'::text, 'amenity'::text])
    or (p_id is null) <> (p_expected_version is null)
    or (p_expected_version is not null and p_expected_version < 0)
    or p_slug is null
    or p_slug <> pg_catalog.btrim(p_slug)
    or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or pg_catalog.char_length(p_slug) not between 2 and 80
    or p_name is null
    or p_name <> pg_catalog.btrim(p_name)
    or pg_catalog.char_length(p_name) not between 2 and 80
    or p_sort_order is null
    or p_sort_order not between 0 and 32767
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_taxonomy_upsert';
  end if;

  is_create := p_id is null;
  target_type := case p_kind
    when 'studioType' then 'studio_type'
    when 'tag' then 'tag'
    else 'amenity'
  end;
  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'expectedVersion', p_expected_version,
      'id', p_id,
      'kind', p_kind,
      'name', p_name,
      'slug', p_slug,
      'sortOrder', p_sort_order
    )
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
    false,
    true
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_actor_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select request.*
  into existing_request
  from private.backoffice_command_requests as request
  where request.actor_user_id = p_actor_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> 'backoffice.taxonomy.upsert'
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> target_type
      or (not is_create and existing_request.target_id <> p_id)
    then
      raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
    end if;

    result := private.backoffice_taxonomy_item_json(p_kind, existing_request.target_id);
    if private.backoffice_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'backoffice_taxonomy_result_stale';
    end if;
    return result;
  end if;

  if is_create then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('set-livre:backoffice-taxonomy-capacity', 0)
    );
    if (
      select pg_catalog.count(*) >= 500
      from (
        select studio_type.id from public.studio_types as studio_type
        union all
        select tag.id from public.tags as tag
        union all
        select amenity.id from public.amenities as amenity
      ) as taxonomy_item
    ) then
      raise exception using errcode = '23514', message = 'backoffice_taxonomy_capacity_reached';
    end if;

    target_id := extensions.gen_random_uuid();
    if p_kind = 'studioType' then
      insert into public.studio_types (id, slug, name, sort_order)
      values (target_id, p_slug, p_name, p_sort_order);
    elsif p_kind = 'tag' then
      insert into public.tags (id, slug, name, sort_order)
      values (target_id, p_slug, p_name, p_sort_order);
    else
      insert into public.amenities (id, slug, name, sort_order)
      values (target_id, p_slug, p_name, p_sort_order);
    end if;
  else
    target_id := p_id;
    if p_kind = 'studioType' then
      select item.taxonomy_version
      into current_version
      from public.studio_types as item
      where item.id = target_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
      end if;
      if current_version <> p_expected_version then
        raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
      end if;
      update public.studio_types as item
      set
        slug = p_slug,
        name = p_name,
        sort_order = p_sort_order,
        taxonomy_version = item.taxonomy_version + 1
      where item.id = target_id
        and item.taxonomy_version = p_expected_version;
    elsif p_kind = 'tag' then
      select item.taxonomy_version
      into current_version
      from public.tags as item
      where item.id = target_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
      end if;
      if current_version <> p_expected_version then
        raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
      end if;
      update public.tags as item
      set
        slug = p_slug,
        name = p_name,
        sort_order = p_sort_order,
        taxonomy_version = item.taxonomy_version + 1
      where item.id = target_id
        and item.taxonomy_version = p_expected_version;
    else
      select item.taxonomy_version
      into current_version
      from public.amenities as item
      where item.id = target_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
      end if;
      if current_version <> p_expected_version then
        raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
      end if;
      update public.amenities as item
      set
        slug = p_slug,
        name = p_name,
        sort_order = p_sort_order,
        taxonomy_version = item.taxonomy_version + 1
      where item.id = target_id
        and item.taxonomy_version = p_expected_version;
    end if;

    if not found then
      raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
    end if;
  end if;

  result := private.backoffice_taxonomy_item_json(p_kind, target_id);

  insert into private.backoffice_command_requests (
    actor_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    target_type,
    target_id
  )
  values (
    p_actor_user_id,
    p_idempotency_key,
    'backoffice.taxonomy.upsert',
    payload_hash,
    private.backoffice_result_hash(result),
    target_type,
    target_id
  );

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
    p_actor_user_id,
    actor_context.actor_role,
    case
      when is_create then 'backoffice.taxonomy_created'
      else 'backoffice.taxonomy_updated'
    end,
    target_type,
    target_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'kind', p_kind,
      'version', result -> 'version'
    )
  );

  return result;
end;
$function$;

alter function private.upsert_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, text, integer, uuid, uuid
) owner to postgres;

create or replace function private.set_backoffice_taxonomy_active(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_kind text,
  p_id uuid,
  p_expected_version bigint,
  p_active boolean,
  p_idempotency_key uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_context record;
  current_active boolean;
  current_version bigint;
  existing_request private.backoffice_command_requests%rowtype;
  payload_hash text;
  result jsonb;
  target_type text;
begin
  if p_actor_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_kind is null
    or p_kind <> all (array['studioType'::text, 'tag'::text, 'amenity'::text])
    or p_id is null
    or p_expected_version is null
    or p_expected_version < 0
    or p_active is null
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_taxonomy_status';
  end if;

  target_type := case p_kind
    when 'studioType' then 'studio_type'
    when 'tag' then 'tag'
    else 'amenity'
  end;
  payload_hash := private.backoffice_payload_hash(
    pg_catalog.jsonb_build_object(
      'active', p_active,
      'expectedVersion', p_expected_version,
      'id', p_id,
      'kind', p_kind
    )
  );

  select *
  into strict actor_context
  from private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    'admin',
    false,
    true
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_actor_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select request.*
  into existing_request
  from private.backoffice_command_requests as request
  where request.actor_user_id = p_actor_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> 'backoffice.taxonomy.setActive'
      or existing_request.payload_hash <> payload_hash
      or existing_request.target_type <> target_type
      or existing_request.target_id <> p_id
    then
      raise exception using errcode = '40001', message = 'backoffice_idempotency_conflict';
    end if;

    result := private.backoffice_taxonomy_item_json(p_kind, p_id);
    if private.backoffice_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'backoffice_taxonomy_result_stale';
    end if;
    return result;
  end if;

  if p_kind = 'studioType' then
    select item.active, item.taxonomy_version
    into current_active, current_version
    from public.studio_types as item
    where item.id = p_id
    for update;
  elsif p_kind = 'tag' then
    select item.active, item.taxonomy_version
    into current_active, current_version
    from public.tags as item
    where item.id = p_id
    for update;
  else
    select item.active, item.taxonomy_version
    into current_active, current_version
    from public.amenities as item
    where item.id = p_id
    for update;
  end if;

  if not found then
    raise exception using errcode = 'P0002', message = 'backoffice_taxonomy_missing';
  end if;
  if current_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
  end if;
  if current_active = p_active then
    raise exception using errcode = '23514', message = 'backoffice_taxonomy_status_unchanged';
  end if;

  if p_kind = 'studioType' then
    update public.studio_types as item
    set
      active = p_active,
      taxonomy_version = item.taxonomy_version + 1
    where item.id = p_id
      and item.taxonomy_version = p_expected_version;
  elsif p_kind = 'tag' then
    update public.tags as item
    set
      active = p_active,
      taxonomy_version = item.taxonomy_version + 1
    where item.id = p_id
      and item.taxonomy_version = p_expected_version;
  else
    update public.amenities as item
    set
      active = p_active,
      taxonomy_version = item.taxonomy_version + 1
    where item.id = p_id
      and item.taxonomy_version = p_expected_version;
  end if;

  if not found then
    raise exception using errcode = '40001', message = 'backoffice_taxonomy_version_conflict';
  end if;

  result := private.backoffice_taxonomy_item_json(p_kind, p_id);

  insert into private.backoffice_command_requests (
    actor_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    target_type,
    target_id
  )
  values (
    p_actor_user_id,
    p_idempotency_key,
    'backoffice.taxonomy.setActive',
    payload_hash,
    private.backoffice_result_hash(result),
    target_type,
    p_id
  );

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
    p_actor_user_id,
    actor_context.actor_role,
    case
      when p_active then 'backoffice.taxonomy_reactivated'
      else 'backoffice.taxonomy_archived'
    end,
    target_type,
    p_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'active', p_active,
      'kind', p_kind,
      'usageCount', result -> 'usageCount',
      'version', result -> 'version'
    )
  );

  return result;
end;
$function$;

alter function private.set_backoffice_taxonomy_active(
  uuid, uuid, timestamptz, text, uuid, bigint, boolean, uuid, uuid
) owner to postgres;

insert into private.dal_routine_allowlist (signature)
values
  ('private.close_backoffice_session(uuid,uuid)'),
  ('private.get_backoffice_user_access(uuid,uuid,timestamptz,uuid)'),
  ('private.get_backoffice_session(uuid,uuid,timestamptz)'),
  ('private.list_backoffice_taxonomies(uuid,uuid,timestamptz)'),
  ('private.list_backoffice_users(uuid,uuid,timestamptz,text,timestamptz,uuid,integer)'),
  ('private.open_backoffice_session(uuid,uuid,timestamptz)'),
  ('private.reveal_backoffice_user_pii(uuid,uuid,timestamptz,uuid,text,uuid,uuid)'),
  ('private.set_backoffice_taxonomy_active(uuid,uuid,timestamptz,text,uuid,bigint,boolean,uuid,uuid)'),
  ('private.set_backoffice_user_role(uuid,uuid,timestamptz,uuid,bigint,text,uuid,uuid)'),
  ('private.set_backoffice_user_status(uuid,uuid,timestamptz,uuid,bigint,text,uuid,uuid)'),
  ('private.upsert_backoffice_taxonomy(uuid,uuid,timestamptz,text,uuid,bigint,text,text,integer,uuid,uuid)');

revoke all on table public.platform_roles
  from public, anon, authenticated, service_role, app_dal;
revoke all on table private.backoffice_sessions
  from public, anon, authenticated, service_role, app_dal;
revoke all on table private.backoffice_command_requests
  from public, anon, authenticated, service_role, app_dal;

revoke all on function private.set_profile_updated_at()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.backoffice_payload_hash(jsonb)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.backoffice_result_hash(jsonb)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.platform_roles_for_user(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.mask_backoffice_email(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.backoffice_user_summary_json(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.backoffice_user_pii_json(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.backoffice_taxonomy_item_json(text, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.backoffice_session_context(
  uuid, uuid, timestamptz, text, boolean, boolean
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.canonical_platform_roles(text[])
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.touch_platform_role_account_version()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.bootstrap_first_platform_admin(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;

revoke all on function private.open_backoffice_session(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.get_backoffice_session(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.close_backoffice_session(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.list_backoffice_users(
  uuid, uuid, timestamptz, text, timestamptz, uuid, integer
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.get_backoffice_user_access(uuid, uuid, timestamptz, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.list_backoffice_taxonomies(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.set_backoffice_user_status(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.reveal_backoffice_user_pii(
  uuid, uuid, timestamptz, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.set_backoffice_user_role(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.upsert_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, text, integer, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.set_backoffice_taxonomy_active(
  uuid, uuid, timestamptz, text, uuid, bigint, boolean, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;

grant execute on function private.open_backoffice_session(uuid, uuid, timestamptz)
  to app_dal;
grant execute on function private.get_backoffice_session(uuid, uuid, timestamptz)
  to app_dal;
grant execute on function private.close_backoffice_session(uuid, uuid)
  to app_dal;
grant execute on function private.list_backoffice_users(
  uuid, uuid, timestamptz, text, timestamptz, uuid, integer
) to app_dal;
grant execute on function private.get_backoffice_user_access(uuid, uuid, timestamptz, uuid)
  to app_dal;
grant execute on function private.list_backoffice_taxonomies(uuid, uuid, timestamptz)
  to app_dal;
grant execute on function private.set_backoffice_user_status(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) to app_dal;
grant execute on function private.reveal_backoffice_user_pii(
  uuid, uuid, timestamptz, uuid, text, uuid, uuid
) to app_dal;
grant execute on function private.set_backoffice_user_role(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) to app_dal;
grant execute on function private.upsert_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, text, integer, uuid, uuid
) to app_dal;
grant execute on function private.set_backoffice_taxonomy_active(
  uuid, uuid, timestamptz, text, uuid, bigint, boolean, uuid, uuid
) to app_dal;

comment on column public.studio_types.taxonomy_version is
  'Versão otimista das alterações administrativas da taxonomia.';
comment on column public.tags.taxonomy_version is
  'Versão otimista das alterações administrativas da taxonomia.';
comment on column public.amenities.taxonomy_version is
  'Versão otimista das alterações administrativas da taxonomia.';

comment on function private.bootstrap_first_platform_admin(uuid, uuid, uuid) is
  'Bootstrap único e auditado do primeiro admin; executável somente pelo operador PostgreSQL.';
comment on function private.open_backoffice_session(uuid, uuid, timestamptz) is
  'Abre binding curto depois de login Auth válido, perfil elegível e papel administrativo vivo.';
comment on function private.get_backoffice_session(uuid, uuid, timestamptz) is
  'Revalida Auth, perfil, papel, inatividade e expiração absoluta da sessão do backoffice.';
comment on function private.close_backoffice_session(uuid, uuid) is
  'Fecha de forma idempotente a sessão curta correspondente ao usuário e session_id Auth.';
comment on function private.list_backoffice_users(
  uuid, uuid, timestamptz, text, timestamptz, uuid, integer
) is 'Busca privada prefixada e paginada por cursor; retorna somente email mascarado.';
comment on function private.get_backoffice_user_access(uuid, uuid, timestamptz, uuid) is
  'Compõe no servidor o estado de acesso de uma conta para um admin revalidado.';
comment on function private.list_backoffice_taxonomies(uuid, uuid, timestamptz) is
  'Lista privada e limitada das taxonomias com versão e impacto de uso.';
comment on function private.set_backoffice_user_status(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) is 'Suspende ou restaura conta com versão otimista, auditoria e proteção do último admin.';
comment on function private.reveal_backoffice_user_pii(
  uuid, uuid, timestamptz, uuid, text, uuid, uuid
) is 'Revela PII somente em resposta efêmera e auditada; o ledger persiste apenas versões.';
comment on function private.set_backoffice_user_role(
  uuid, uuid, timestamptz, uuid, bigint, text, uuid, uuid
) is 'Deriva concessão ou revogação support/admin da ação explícita, com reautenticação, versão opaca e proteção do último admin.';
comment on function private.upsert_backoffice_taxonomy(
  uuid, uuid, timestamptz, text, uuid, bigint, text, text, integer, uuid, uuid
) is 'Cria ou edita taxonomia com versão otimista, idempotência e auditoria.';
comment on function private.set_backoffice_taxonomy_active(
  uuid, uuid, timestamptz, text, uuid, bigint, boolean, uuid, uuid
) is 'Arquiva ou reativa taxonomia sem apagar referências históricas.';
