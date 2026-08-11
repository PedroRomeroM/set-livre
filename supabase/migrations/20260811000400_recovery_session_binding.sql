-- FEAT-002 review hardening: vincula recovery à sessão Auth canônica e mantém
-- um tombstone que não desaparece com o grant ou com os cookies auxiliares.

create table private.identity_recovery_sessions (
  auth_session_id uuid primary key,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  session_scope uuid not null default extensions.gen_random_uuid(),
  bound_at timestamptz not null,
  auth_expires_at timestamptz not null,
  retain_until timestamptz not null,
  canonical_absence_observed_at timestamptz,
  closed_at timestamptz,
  constraint identity_recovery_sessions_user_session_key
    unique (auth_session_id, user_id),
  constraint identity_recovery_sessions_scope_key unique (session_scope),
  constraint identity_recovery_sessions_expiry_check
    check (
      auth_expires_at > bound_at
      and retain_until = auth_expires_at + interval '5 minutes'
    ),
  constraint identity_recovery_sessions_closed_check
    check (closed_at is null or closed_at >= bound_at),
  constraint identity_recovery_sessions_absence_check
    check (
      canonical_absence_observed_at is null
      or canonical_absence_observed_at >= bound_at
    )
);

comment on table private.identity_recovery_sessions
  is 'Binding/tombstone de recovery por session_id Auth; sobrevive ao grant e só purga após ausência canônica e expiração do último JWT.';
comment on column private.identity_recovery_sessions.session_scope
  is 'Escopo opaco não autoritativo usado apenas para isolar estado de interface.';
comment on column private.identity_recovery_sessions.retain_until
  is 'Última expiração JWT observada acrescida de cinco minutos; nunca autoriza purge sem ausência em auth.sessions.';
comment on column private.identity_recovery_sessions.canonical_absence_observed_at
  is 'Primeira ausência em auth.sessions; inicia nova retenção pelo JWT pinado de 3600 segundos mais cinco minutos antes de qualquer purge.';

create index identity_recovery_sessions_retain_until_idx
on private.identity_recovery_sessions (retain_until);

revoke all on table private.identity_recovery_sessions
  from public, anon, authenticated, service_role, app_dal;
alter table private.identity_recovery_sessions enable row level security;

-- Grants antigos não possuíam session_id. Invalidações de recovery são seguras:
-- o usuário precisa solicitar um novo link, sem preservar autorização ambígua.
delete from private.identity_recovery_grants;

alter table private.identity_recovery_grants
  add column auth_session_id uuid not null;
alter table private.identity_recovery_grants
  add constraint identity_recovery_grants_session_user_fkey
  foreign key (auth_session_id, user_id)
  references private.identity_recovery_sessions(auth_session_id, user_id)
  on delete cascade;
alter table private.identity_recovery_grants
  add constraint identity_recovery_grants_session_key unique (auth_session_id);

comment on column private.identity_recovery_grants.auth_session_id
  is 'Sessão Auth assinada que originou o recovery; o grant nunca existe sem sua binding.';

create function private.issue_identity_recovery_context(
  p_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz
)
returns table (grant_token uuid, session_scope uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  binding_time timestamptz := pg_catalog.clock_timestamp();
  issued_scope uuid;
  issued_token uuid;
begin
  if pg_catalog.current_setting('app.settings.jwt_exp', true) is distinct from '3600' then
    raise exception using
      errcode = '55000',
      message = 'identity_recovery_jwt_expiry_not_pinned';
  end if;

  if p_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_auth_expires_at <= binding_time
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_session';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_session';
  end if;

  update private.identity_recovery_sessions as absent_binding
  set
    auth_expires_at = greatest(
      absent_binding.auth_expires_at,
      binding_time + interval '1 hour'
    ),
    retain_until = greatest(
      absent_binding.retain_until,
      binding_time + interval '65 minutes'
    ),
    canonical_absence_observed_at = binding_time,
    closed_at = coalesce(absent_binding.closed_at, binding_time)
  where absent_binding.canonical_absence_observed_at is null
    and not exists (
      select 1
      from auth.sessions as canonical_session
      where canonical_session.id = absent_binding.auth_session_id
        and canonical_session.user_id = absent_binding.user_id
    );

  delete from private.identity_recovery_sessions as expired_binding
  where expired_binding.canonical_absence_observed_at is not null
    and expired_binding.retain_until <= binding_time
    and not exists (
      select 1
      from auth.sessions as canonical_session
      where canonical_session.id = expired_binding.auth_session_id
        and canonical_session.user_id = expired_binding.user_id
    );

  delete from private.identity_recovery_grants as expired_grant
  where expired_grant.expires_at <= binding_time;

  insert into private.identity_recovery_sessions (
    auth_session_id,
    user_id,
    bound_at,
    auth_expires_at,
    retain_until
  )
  values (
    p_auth_session_id,
    p_user_id,
    binding_time,
    p_auth_expires_at,
    p_auth_expires_at + interval '5 minutes'
  )
  returning identity_recovery_sessions.session_scope into issued_scope;

  insert into private.identity_recovery_grants (
    user_id,
    auth_session_id,
    issued_at,
    expires_at
  )
  values (
    p_user_id,
    p_auth_session_id,
    binding_time,
    binding_time + interval '15 minutes'
  )
  returning identity_recovery_grants.token into issued_token;

  grant_token := issued_token;
  session_scope := issued_scope;
  return next;
end;
$function$;

create function private.inspect_identity_recovery_session(
  p_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_grant_token uuid,
  p_session_scope uuid
)
returns table (session_scope uuid, active boolean, grant_allowed boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  binding_active boolean;
  binding_scope uuid;
  inspection_time timestamptz := pg_catalog.clock_timestamp();
begin
  if pg_catalog.current_setting('app.settings.jwt_exp', true) is distinct from '3600' then
    raise exception using
      errcode = '55000',
      message = 'identity_recovery_jwt_expiry_not_pinned';
  end if;

  if p_user_id is null
    or p_auth_session_id is null
    or p_auth_expires_at is null
    or p_auth_expires_at <= inspection_time
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_session';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    update private.identity_recovery_sessions as absent_binding
    set
      auth_expires_at = greatest(
        absent_binding.auth_expires_at,
        inspection_time + interval '1 hour'
      ),
      retain_until = greatest(
        absent_binding.retain_until,
        inspection_time + interval '65 minutes'
      ),
      canonical_absence_observed_at = coalesce(
        absent_binding.canonical_absence_observed_at,
        inspection_time
      ),
      closed_at = coalesce(absent_binding.closed_at, inspection_time)
    where absent_binding.auth_session_id = p_auth_session_id
      and absent_binding.user_id = p_user_id
    returning absent_binding.session_scope into binding_scope;

    if not found then
      return;
    end if;

    delete from private.identity_recovery_grants as recovery_grant
    where recovery_grant.auth_session_id = p_auth_session_id
      and recovery_grant.user_id = p_user_id;

    session_scope := binding_scope;
    active := false;
    grant_allowed := false;
    return next;
    return;
  end if;

  update private.identity_recovery_sessions as recovery_session
  set
    auth_expires_at = greatest(
      recovery_session.auth_expires_at,
      p_auth_expires_at
    ),
    retain_until = greatest(
      recovery_session.retain_until,
      p_auth_expires_at + interval '5 minutes'
    )
  where recovery_session.auth_session_id = p_auth_session_id
    and recovery_session.user_id = p_user_id
  returning
    recovery_session.session_scope,
    recovery_session.closed_at is null
  into binding_scope, binding_active;

  if not found then
    return;
  end if;

  session_scope := binding_scope;
  active := binding_active;
  grant_allowed := binding_active
    and p_grant_token is not null
    and p_session_scope = binding_scope
    and exists (
      select 1
      from private.identity_recovery_grants as recovery_grant
      where recovery_grant.token = p_grant_token
        and recovery_grant.user_id = p_user_id
        and recovery_grant.auth_session_id = p_auth_session_id
        and recovery_grant.expires_at > inspection_time
        and recovery_grant.claim_attempt_id is null
    );
  return next;
end;
$function$;

create function private.claim_identity_recovery_context(
  p_token uuid,
  p_user_id uuid,
  p_auth_session_id uuid,
  p_session_scope uuid,
  p_attempt_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claim_time timestamptz := pg_catalog.clock_timestamp();
  grant_claimed boolean;
begin
  if p_token is null
    or p_user_id is null
    or p_auth_session_id is null
    or p_session_scope is null
    or p_attempt_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    return false;
  end if;

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = p_attempt_id,
    claimed_at = coalesce(recovery_grant.claimed_at, claim_time)
  from private.identity_recovery_sessions as recovery_session
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.auth_session_id = p_auth_session_id
    and recovery_grant.expires_at > claim_time
    and recovery_session.auth_session_id = recovery_grant.auth_session_id
    and recovery_session.user_id = recovery_grant.user_id
    and recovery_session.session_scope = p_session_scope
    and recovery_session.closed_at is null
    and (
      recovery_grant.claim_attempt_id is null
      or recovery_grant.claim_attempt_id = p_attempt_id
    )
  returning true into grant_claimed;

  return coalesce(grant_claimed, false);
end;
$function$;

create function private.release_identity_recovery_context(
  p_token uuid,
  p_user_id uuid,
  p_auth_session_id uuid,
  p_session_scope uuid,
  p_attempt_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  grant_released boolean;
begin
  if p_token is null
    or p_user_id is null
    or p_auth_session_id is null
    or p_session_scope is null
    or p_attempt_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    return false;
  end if;

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = null,
    claimed_at = null
  from private.identity_recovery_sessions as recovery_session
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.auth_session_id = p_auth_session_id
    and recovery_grant.claim_attempt_id = p_attempt_id
    and recovery_grant.expires_at > pg_catalog.statement_timestamp()
    and recovery_session.auth_session_id = recovery_grant.auth_session_id
    and recovery_session.user_id = recovery_grant.user_id
    and recovery_session.session_scope = p_session_scope
    and recovery_session.closed_at is null
  returning true into grant_released;

  return coalesce(grant_released, false);
end;
$function$;

create function private.consume_identity_recovery_context(
  p_token uuid,
  p_user_id uuid,
  p_auth_session_id uuid,
  p_session_scope uuid,
  p_attempt_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  grant_consumed boolean;
begin
  if p_token is null
    or p_user_id is null
    or p_auth_session_id is null
    or p_session_scope is null
    or p_attempt_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  perform 1
  from auth.sessions as auth_session
  where auth_session.id = p_auth_session_id
    and auth_session.user_id = p_user_id
  for key share;

  if not found then
    return false;
  end if;

  delete from private.identity_recovery_grants as recovery_grant
  using private.identity_recovery_sessions as recovery_session
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.auth_session_id = p_auth_session_id
    and recovery_grant.claim_attempt_id = p_attempt_id
    and recovery_session.auth_session_id = recovery_grant.auth_session_id
    and recovery_session.user_id = recovery_grant.user_id
    and recovery_session.session_scope = p_session_scope
    and recovery_session.closed_at is null
  returning true into grant_consumed;

  return coalesce(grant_consumed, false);
end;
$function$;

create function private.close_identity_recovery_session(
  p_user_id uuid,
  p_auth_session_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  binding_closed boolean;
begin
  if p_user_id is null or p_auth_session_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_session';
  end if;

  update private.identity_recovery_sessions as recovery_session
  set closed_at = coalesce(
    recovery_session.closed_at,
    pg_catalog.clock_timestamp()
  )
  where recovery_session.auth_session_id = p_auth_session_id
    and recovery_session.user_id = p_user_id
  returning true into binding_closed;

  if coalesce(binding_closed, false) then
    delete from private.identity_recovery_grants as recovery_grant
    where recovery_grant.auth_session_id = p_auth_session_id
      and recovery_grant.user_id = p_user_id;
  end if;

  return coalesce(binding_closed, false);
end;
$function$;

revoke all on function private.issue_identity_recovery_grant(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.has_identity_recovery_grant(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.claim_identity_recovery_grant(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.release_identity_recovery_grant(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.consume_identity_recovery_grant(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;

revoke all on function private.issue_identity_recovery_context(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.inspect_identity_recovery_session(uuid, uuid, timestamptz, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.claim_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.release_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.consume_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.close_identity_recovery_session(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;

grant execute on function private.issue_identity_recovery_context(uuid, uuid, timestamptz)
  to app_dal;
grant execute on function private.inspect_identity_recovery_session(uuid, uuid, timestamptz, uuid, uuid)
  to app_dal;
grant execute on function private.claim_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)
  to app_dal;
grant execute on function private.release_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)
  to app_dal;
grant execute on function private.consume_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)
  to app_dal;
grant execute on function private.close_identity_recovery_session(uuid, uuid)
  to app_dal;

comment on function private.issue_identity_recovery_context(uuid, uuid, timestamptz)
  is 'Emite atomicamente binding por session_id Auth, scope opaco e grant de 15 minutos após validar auth.sessions.';
comment on function private.inspect_identity_recovery_session(uuid, uuid, timestamptz, uuid, uuid)
  is 'Classifica binding/tombstone pelo session_id assinado, estende retenção ao JWT observado e só autoriza grant/escopo ativos correspondentes.';
comment on function private.claim_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)
  is 'Reserva exclusivamente grant vigente que corresponde a user, session_id e scope da binding ativa.';
comment on function private.release_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)
  is 'Libera somente a reserva vigente da mesma tentativa e binding ativa após rejeição segura.';
comment on function private.consume_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)
  is 'Consome o grant da tentativa sem remover o tombstone da sessão recovery.';
comment on function private.close_identity_recovery_session(uuid, uuid)
  is 'Fecha a binding e remove seu grant; o tombstone persiste para bloquear replay da sessão Auth.';

create or replace function private.check_readiness(expected_version text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with runtime_role as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = 'app_dal'
      and not role.rolcanlogin
      and not role.rolinherit
      and not role.rolsuper
      and not role.rolcreatedb
      and not role.rolcreaterole
      and not role.rolreplication
      and not role.rolbypassrls
      and role.rolconfig is null
      and not exists (
        select 1
        from pg_catalog.pg_db_role_setting as setting
        where setting.setrole = role.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_auth_members as membership
        where membership.member = role.oid
      )
  ),
  jwt_expiry_pinned as (
    select pg_catalog.current_setting('app.settings.jwt_exp', true)
      is not distinct from '3600' as restricted
  ),
  authorized_acl_dependencies as (
    select
      pg_catalog.count(*) = 10
      and pg_catalog.bool_and(
        (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regnamespace('private')
          and dependency.objsubid = 0
        )
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure('private.check_readiness(text)')
          and dependency.objsubid = 0
        )
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.check_runtime_readiness(text)'
          )
          and dependency.objsubid = 0
        )
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)'
          )
          and dependency.objsubid = 0
        )
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.issue_identity_recovery_context(uuid,uuid,timestamptz)'
          )
          and dependency.objsubid = 0
        )
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.inspect_identity_recovery_session(uuid,uuid,timestamptz,uuid,uuid)'
          )
          and dependency.objsubid = 0
        )
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.claim_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'
          )
          and dependency.objsubid = 0
        )
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.release_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'
          )
          and dependency.objsubid = 0
        )
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.consume_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'
          )
          and dependency.objsubid = 0
        )
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.close_identity_recovery_session(uuid,uuid)'
          )
          and dependency.objsubid = 0
        )
      ) as restricted
    from pg_catalog.pg_shdepend as dependency
    join runtime_role on runtime_role.oid = dependency.refobjid
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and dependency.deptype = 'a'
  ),
  authorized_schema_privilege as (
    select
      pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        privilege.grantee = runtime_role.oid
        and privilege.grantor <> runtime_role.oid
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
    cross join runtime_role
    where namespace.oid = pg_catalog.to_regnamespace('private')
      and (privilege.grantee = runtime_role.oid or privilege.grantor = runtime_role.oid)
  ),
  authorized_routine_privilege as (
    select
      pg_catalog.count(*) = 9
      and pg_catalog.bool_and(
        privilege.grantee = runtime_role.oid
        and privilege.grantor <> runtime_role.oid
        and privilege.privilege_type = 'EXECUTE'
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_proc as routine
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    cross join runtime_role
    where routine.oid in (
        pg_catalog.to_regprocedure('private.check_readiness(text)'),
        pg_catalog.to_regprocedure('private.check_runtime_readiness(text)'),
        pg_catalog.to_regprocedure(
          'private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)'
        ),
        pg_catalog.to_regprocedure(
          'private.issue_identity_recovery_context(uuid,uuid,timestamptz)'
        ),
        pg_catalog.to_regprocedure(
          'private.inspect_identity_recovery_session(uuid,uuid,timestamptz,uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.claim_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.release_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.consume_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.close_identity_recovery_session(uuid,uuid)'
        )
      )
      and (privilege.grantee = runtime_role.oid or privilege.grantor = runtime_role.oid)
  ),
  public_schema_privileges_restricted as (
    select
      pg_catalog.count(*) = 2
      and pg_catalog.bool_and(
        namespace.nspname in ('information_schema', 'pg_catalog')
        and privilege.grantor = namespace.nspowner
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        namespace.nspacl,
        pg_catalog.acldefault('n', namespace.nspowner)
      )
    ) as privilege
    where privilege.grantee = 0
  ),
  public_database_privileges_restricted as (
    select
      pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        privilege.grantor = database.datdba
        and privilege.privilege_type = 'CONNECT'
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_database as database
    cross join lateral pg_catalog.aclexplode(
      coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
    ) as privilege
    where database.datname = pg_catalog.current_database()
      and privilege.grantee = 0
  ),
  runtime_role_temporary_privilege_restricted as (
    select not pg_catalog.has_database_privilege(
      runtime_role.oid,
      pg_catalog.current_database(),
      'TEMPORARY'
    ) as restricted
    from runtime_role
  ),
  public_default_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_default_acl as defaults
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
      where privilege.grantee = 0
    ) as restricted
  ),
  public_large_object_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_largeobject_metadata as large_object
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          large_object.lomacl,
          pg_catalog.acldefault('L', large_object.lomowner)
        )
      ) as privilege
      where privilege.grantee = 0
    ) as restricted
  ),
  public_parameter_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_parameter_acl as parameter
      cross join lateral pg_catalog.aclexplode(parameter.paracl) as privilege
      where privilege.grantee = 0
    ) as restricted
  ),
  public_foreign_data_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_foreign_data_wrapper as wrapper
      cross join lateral pg_catalog.aclexplode(
        coalesce(wrapper.fdwacl, pg_catalog.acldefault('F', wrapper.fdwowner))
      ) as privilege
      where privilege.grantee = 0

      union all

      select 1
      from pg_catalog.pg_foreign_server as server
      cross join lateral pg_catalog.aclexplode(
        coalesce(server.srvacl, pg_catalog.acldefault('S', server.srvowner))
      ) as privilege
      where privilege.grantee = 0
    ) as restricted
  ),
  public_tablespace_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_tablespace as tablespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          tablespace.spcacl,
          pg_catalog.acldefault('t', tablespace.spcowner)
        )
      ) as privilege
      where privilege.grantee = 0
    ) as restricted
  ),
  public_language_privileges_restricted as (
    select
      pg_catalog.count(*) = 4
      and pg_catalog.bool_and(
        language.lanname in ('c', 'internal', 'plpgsql', 'sql')
        and privilege.grantor = language.lanowner
        and privilege.privilege_type = 'USAGE'
        and not privilege.is_grantable
      ) as restricted
    from pg_catalog.pg_language as language
    cross join lateral pg_catalog.aclexplode(
      coalesce(language.lanacl, pg_catalog.acldefault('l', language.lanowner))
    ) as privilege
    where privilege.grantee = 0
  ),
  sensitive_catalog_relations as (
    select relation.oid, relation.relowner
    from pg_catalog.pg_class as relation
    where relation.oid in (
      'pg_catalog.pg_db_role_setting'::pg_catalog.regclass,
      'pg_catalog.pg_roles'::pg_catalog.regclass,
      'pg_catalog.pg_user'::pg_catalog.regclass
    )
  ),
  sensitive_catalog_privileges_restricted as (
    select
      (
        select pg_catalog.count(*) = 3
          and pg_catalog.bool_and(
            relation.relowner = (
              select role.oid
              from pg_catalog.pg_roles as role
              where role.rolname = 'supabase_admin'
            )
          )
        from sensitive_catalog_relations as relation
      )
      and (
        select pg_catalog.count(*) = 3
          and pg_catalog.bool_and(
            privilege.grantor = relation.relowner
            and privilege.privilege_type = 'SELECT'
            and not privilege.is_grantable
          )
        from sensitive_catalog_relations as relation
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            (select catalog.relacl from pg_catalog.pg_class as catalog where catalog.oid = relation.oid),
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) as privilege
        where privilege.grantee = (
          select role.oid
          from pg_catalog.pg_roles as role
          where role.rolname = 'postgres'
        )
      )
      and not exists (
        select 1
        from sensitive_catalog_relations as relation
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            (select catalog.relacl from pg_catalog.pg_class as catalog where catalog.oid = relation.oid),
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) as privilege
        where not (
          (
            privilege.grantee = relation.relowner
            and privilege.grantor = relation.relowner
            and not privilege.is_grantable
          )
          or (
            privilege.grantee = (
              select role.oid
              from pg_catalog.pg_roles as role
              where role.rolname = 'postgres'
            )
            and privilege.grantor = relation.relowner
            and privilege.privilege_type = 'SELECT'
            and not privilege.is_grantable
          )
        )
      )
      and not exists (
        select 1
        from sensitive_catalog_relations as relation
        join pg_catalog.pg_attribute as attribute on attribute.attrelid = relation.oid
        cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
        where attribute.attnum > 0
          and not attribute.attisdropped
      )
      and not exists (
        select 1
        from sensitive_catalog_relations as relation
        cross join pg_catalog.pg_roles as role
        where (
            role.rolname in (
              'anon',
              'app_dal',
              'authenticated',
              'service_role'
            )
            or (
              role.rolname = session_user
              and role.rolname not in ('postgres', 'supabase_admin')
            )
          )
          and (
            pg_catalog.has_table_privilege(role.oid, relation.oid, 'SELECT')
            or pg_catalog.has_any_column_privilege(role.oid, relation.oid, 'SELECT')
          )
      ) as restricted
  ),
  public_catalog_relation_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          relation.relacl,
          pg_catalog.acldefault(
            case
              when relation.relkind = 'S'
                then 's'::pg_catalog."char"
              else 'r'::pg_catalog."char"
            end,
            relation.relowner
          )
        )
      ) as current_privilege
      where namespace.nspname = 'pg_catalog'
        and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
        and current_privilege.grantee = 0
        and not exists (
          select 1
          from pg_catalog.pg_init_privs as initial_acl
          cross join lateral pg_catalog.aclexplode(
            initial_acl.initprivs
          ) as initial_privilege
          where initial_acl.classoid =
              'pg_catalog.pg_class'::pg_catalog.regclass
            and initial_acl.objoid = relation.oid
            and initial_acl.objsubid = 0
            and initial_acl.privtype in ('i', 'e')
            and initial_privilege.grantee = 0
            and initial_privilege.privilege_type =
              current_privilege.privilege_type
            and (
              not current_privilege.is_grantable
              or initial_privilege.is_grantable
            )
        )

      union all

      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation.oid
      cross join lateral pg_catalog.aclexplode(
        attribute.attacl
      ) as current_privilege
      where namespace.nspname = 'pg_catalog'
        and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
        and attribute.attnum > 0
        and not attribute.attisdropped
        and current_privilege.grantee = 0
        and not exists (
          select 1
          from pg_catalog.pg_init_privs as initial_acl
          cross join lateral pg_catalog.aclexplode(
            initial_acl.initprivs
          ) as initial_privilege
          where initial_acl.classoid =
              'pg_catalog.pg_class'::pg_catalog.regclass
            and initial_acl.objoid = relation.oid
            and initial_acl.objsubid in (0, attribute.attnum)
            and initial_acl.privtype in ('i', 'e')
            and initial_privilege.grantee = 0
            and initial_privilege.privilege_type =
              current_privilege.privilege_type
            and (
              not current_privilege.is_grantable
              or initial_privilege.is_grantable
            )
        )
    ) as restricted
  ),
  implicit_catalog_routine_owners_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
      left join pg_catalog.pg_depend as dependency
        on dependency.classid =
            'pg_catalog.pg_proc'::pg_catalog.regclass
        and dependency.objid = routine.oid
        and dependency.objsubid = 0
        and dependency.refclassid =
            'pg_catalog.pg_extension'::pg_catalog.regclass
        and dependency.deptype = 'e'
      left join pg_catalog.pg_extension as extension
        on extension.oid = dependency.refobjid
      where namespace.nspname = 'pg_catalog'
        and not exists (
          select 1
          from pg_catalog.pg_init_privs as initial_acl
          where initial_acl.classoid =
              'pg_catalog.pg_proc'::pg_catalog.regclass
            and initial_acl.objoid = routine.oid
            and initial_acl.objsubid = 0
            and initial_acl.privtype in ('i', 'e')
        )
        and (
          (
            extension.oid is not null
            and routine.proowner <> extension.extowner
          )
          or (
            extension.oid is null
            and routine.oid < 16384
            and routine.proowner <> 10
          )
        )
    ) as restricted
  ),
  public_catalog_routine_privileges_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
      left join pg_catalog.pg_depend as dependency
        on dependency.classid =
            'pg_catalog.pg_proc'::pg_catalog.regclass
        and dependency.objid = routine.oid
        and dependency.objsubid = 0
        and dependency.refclassid =
            'pg_catalog.pg_extension'::pg_catalog.regclass
        and dependency.deptype = 'e'
      left join pg_catalog.pg_extension as extension
        on extension.oid = dependency.refobjid
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) as current_privilege
      where namespace.nspname = 'pg_catalog'
        and current_privilege.grantee = 0
        and not (
          exists (
            select 1
            from pg_catalog.pg_init_privs as initial_acl
            cross join lateral pg_catalog.aclexplode(
              initial_acl.initprivs
            ) as initial_privilege
            where initial_acl.classoid =
                'pg_catalog.pg_proc'::pg_catalog.regclass
              and initial_acl.objoid = routine.oid
              and initial_acl.objsubid = 0
              and initial_acl.privtype in ('i', 'e')
              and initial_privilege.grantee = current_privilege.grantee
              and initial_privilege.grantor = current_privilege.grantor
              and initial_privilege.privilege_type =
                current_privilege.privilege_type
              and (
                not current_privilege.is_grantable
                or initial_privilege.is_grantable
              )
          )
          or (
            not exists (
              select 1
              from pg_catalog.pg_init_privs as initial_acl
              where initial_acl.classoid =
                  'pg_catalog.pg_proc'::pg_catalog.regclass
                and initial_acl.objoid = routine.oid
                and initial_acl.objsubid = 0
                and initial_acl.privtype in ('i', 'e')
            )
            and (
              (
                extension.oid is not null
                and routine.proowner = extension.extowner
                and exists (
                  select 1
                  from pg_catalog.aclexplode(
                    pg_catalog.acldefault('f', extension.extowner)
                  ) as initial_privilege
                  where initial_privilege.grantee =
                      current_privilege.grantee
                    and initial_privilege.grantor =
                      current_privilege.grantor
                    and initial_privilege.privilege_type =
                      current_privilege.privilege_type
                    and (
                      not current_privilege.is_grantable
                      or initial_privilege.is_grantable
                    )
                )
              )
              or (
                extension.oid is null
                and routine.oid < 16384
                and routine.proowner = 10
                and exists (
                  select 1
                  from pg_catalog.aclexplode(
                    pg_catalog.acldefault('f', 10::pg_catalog.oid)
                  ) as initial_privilege
                  where initial_privilege.grantee =
                      current_privilege.grantee
                    and initial_privilege.grantor =
                      current_privilege.grantor
                    and initial_privilege.privilege_type =
                      current_privilege.privilege_type
                    and (
                      not current_privilege.is_grantable
                      or initial_privilege.is_grantable
                    )
                )
              )
            )
          )
        )
    ) as restricted
  ),
  database_global_settings_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_db_role_setting as setting
      cross join lateral pg_catalog.unnest(setting.setconfig) as configuration(value)
      where setting.setrole = 0
        and setting.setdatabase = (
          select database.oid
          from pg_catalog.pg_database as database
          where database.datname = pg_catalog.current_database()
        )
        and pg_catalog.split_part(configuration.value, '=', 1)
          not in ('app.settings.jwt_exp', 'app.settings.jwt_secret')
    ) as restricted
  ),
  public_private_object_privileges_restricted as (
    select not exists (
      select 1
      from (
        select privilege.grantee
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            relation.relacl,
            pg_catalog.acldefault(
              case
                when relation.relkind = 'S'
                  then 's'::pg_catalog."char"
                else 'r'::pg_catalog."char"
              end,
              relation.relowner
            )
          )
        ) as privilege
        where namespace.nspname = 'private'
          and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')

        union all

        select privilege.grantee
        from pg_catalog.pg_attribute as attribute
        join pg_catalog.pg_class as relation
          on relation.oid = attribute.attrelid
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            attribute.attacl,
            pg_catalog.acldefault('c', relation.relowner)
          )
        ) as privilege
        where namespace.nspname = 'private'
          and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
          and attribute.attnum > 0
          and not attribute.attisdropped

        union all

        select privilege.grantee
        from pg_catalog.pg_proc as routine
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = routine.pronamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )
        ) as privilege
        where namespace.nspname = 'private'

        union all

        select privilege.grantee
        from pg_catalog.pg_type as type_object
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = type_object.typnamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            type_object.typacl,
            pg_catalog.acldefault('T', type_object.typowner)
          )
        ) as privilege
        where namespace.nspname = 'private'
          and not exists (
            select 1
            from pg_catalog.pg_type as element_type
            where element_type.typarray = type_object.oid
          )
          and not exists (
            select 1
            from pg_catalog.pg_range as range_type
            where range_type.rngmultitypid = type_object.oid
          )
          and (
            type_object.typrelid = 0
            or exists (
              select 1
              from pg_catalog.pg_class as composite_relation
              where composite_relation.oid = type_object.typrelid
                and composite_relation.relkind = 'c'
            )
          )
      ) as private_object_privilege
      where private_object_privilege.grantee = 0
    ) as restricted
  )
  select coalesce(
    (
      select pg_catalog.max(schema_migrations.version)::text = expected_version
      from supabase_migrations.schema_migrations
    )
    and (select restricted from jwt_expiry_pinned)
    and (select restricted from authorized_acl_dependencies)
    and (select restricted from authorized_schema_privilege)
    and (select restricted from authorized_routine_privilege)
    and (select restricted from public_schema_privileges_restricted)
    and (select restricted from public_database_privileges_restricted)
    and (select restricted from runtime_role_temporary_privilege_restricted)
    and (select restricted from public_default_privileges_restricted)
    and (select restricted from public_large_object_privileges_restricted)
    and (select restricted from public_parameter_privileges_restricted)
    and (select restricted from public_foreign_data_privileges_restricted)
    and (select restricted from public_tablespace_privileges_restricted)
    and (select restricted from public_language_privileges_restricted)
    and (select restricted from sensitive_catalog_privileges_restricted)
    and (select restricted from public_catalog_relation_privileges_restricted)
    and (select restricted from implicit_catalog_routine_owners_restricted)
    and (select restricted from public_catalog_routine_privileges_restricted)
    and (select restricted from database_global_settings_restricted)
    and (select restricted from public_private_object_privileges_restricted)
    and not exists (
      select 1
      from pg_catalog.pg_shdepend as dependency
      join runtime_role on runtime_role.oid = dependency.refobjid
      where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        and dependency.deptype = 'o'
    ),
    false
  );
$function$;
