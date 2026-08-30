create or replace function private.normalize_backoffice_session_window()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.last_seen_at < new.opened_at then
    new.last_seen_at := new.opened_at;
  end if;
  if new.closed_at is not null and new.closed_at < new.last_seen_at then
    new.closed_at := new.last_seen_at;
  end if;
  return new;
end;
$function$;

alter function private.normalize_backoffice_session_window() owner to postgres;

comment on function private.normalize_backoffice_session_window() is
  'Preserva a ordem temporal da sessão quando o relógio de parede do host recua.';

revoke all on function private.normalize_backoffice_session_window()
  from public, anon, authenticated, service_role, app_dal;

create trigger backoffice_sessions_normalize_window
  before insert or update on private.backoffice_sessions
  for each row execute function private.normalize_backoffice_session_window();

update private.backoffice_sessions as session_binding
set closed_at = session_binding.last_seen_at
where session_binding.closed_at is not null
  and session_binding.closed_at < session_binding.last_seen_at;

alter table private.backoffice_sessions
  drop constraint backoffice_sessions_window_check,
  add constraint backoffice_sessions_window_check check (
    last_seen_at >= opened_at
    and absolute_expires_at > opened_at
    and (closed_at is null or closed_at >= last_seen_at)
  );

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

  if not found then
    raise exception using errcode = '42501', message = 'backoffice_session_expired';
  end if;

  checked_at := greatest(checked_at, binding.last_seen_at);
  if binding.closed_at is not null
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
      p_auth_expires_at
    ),
    binding.opened_at + interval '5 minutes';
end;
$function$;

alter function private.backoffice_session_context(uuid, uuid, timestamptz, text, boolean, boolean)
  owner to postgres;

comment on function private.backoffice_session_context(uuid, uuid, timestamptz, text, boolean, boolean)
  is 'Valida a sessão administrativa com atividade monotônica mesmo sob correção regressiva do relógio do host.';

revoke all on function private.backoffice_session_context(
  uuid, uuid, timestamptz, text, boolean, boolean
) from public, anon, authenticated, service_role, app_dal;
