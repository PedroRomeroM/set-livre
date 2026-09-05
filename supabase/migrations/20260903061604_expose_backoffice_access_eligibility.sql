-- The access detail must derive grant actions from the same profile eligibility
-- enforced by private.set_backoffice_user_role. Keep the field server-only.

revoke all on function private.get_backoffice_user_access(uuid, uuid, timestamptz, uuid)
  from public, anon, authenticated, service_role, app_dal;

drop function private.get_backoffice_user_access(uuid, uuid, timestamptz, uuid);

create function private.get_backoffice_user_access(
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
  profile_completed boolean,
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
    profile.completed_at is not null,
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

revoke all on function private.get_backoffice_user_access(uuid, uuid, timestamptz, uuid)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function private.get_backoffice_user_access(uuid, uuid, timestamptz, uuid)
  to app_dal;

comment on function private.get_backoffice_user_access(uuid, uuid, timestamptz, uuid) is
  'Compõe no servidor papéis, status e elegibilidade de perfil de uma conta para um admin revalidado.';
