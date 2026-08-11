-- FEAT-002: identidade mínima e núcleo legal necessário ao cadastro local.
-- O conteúdo jurídico real continua bloqueado por validação humana; o seed
-- desta feature contém somente fixtures locais explicitamente não produtivas.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  person_type text not null
    check (person_type in ('individual', 'company')),
  status text not null default 'active'
    check (status in ('active', 'suspended')),
  completed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  check (completed_at is null or completed_at >= created_at),
  check (updated_at >= created_at)
);

comment on table public.profiles
  is 'Identidade mínima criada atomicamente com auth.users; FEAT-003 completa os dados pessoais.';
comment on column public.profiles.completed_at
  is 'Permanece nulo até o comando de conclusão pertencente à FEAT-003.';

create table public.terms_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  kind text not null check (kind in ('terms', 'privacy')),
  version text not null
    check (pg_catalog.char_length(version) between 1 and 40),
  title text not null
    check (
      pg_catalog.char_length(pg_catalog.btrim(title)) between 3 and 160
      and title = pg_catalog.btrim(title)
    ),
  body_markdown text not null
    check (
      pg_catalog.char_length(pg_catalog.btrim(body_markdown)) between 1 and 200000
      and body_markdown = pg_catalog.btrim(body_markdown)
    ),
  source text not null check (source in ('local_fixture', 'approved')),
  effective_at timestamptz not null,
  retired_at timestamptz,
  content_hash text generated always as (
    pg_catalog.encode(
      extensions.digest(body_markdown, 'sha256'::text),
      'hex'::text
    )
  ) stored,
  created_at timestamptz not null default pg_catalog.now(),
  constraint terms_versions_kind_version_key unique (kind, version),
  constraint terms_versions_retirement_after_effective_check
    check (retired_at is null or retired_at > effective_at),
  constraint terms_versions_content_hash_check
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint terms_versions_effective_period_exclusion
    exclude using gist (
      kind with =,
      tstzrange(effective_at, retired_at, '[)') with &&
    )
);

comment on table public.terms_versions
  is 'Versões jurídicas append-only; somente aposentadoria nula para definida é permitida.';
comment on column public.terms_versions.source
  is 'local_fixture identifica conteúdo exclusivo do ambiente local; approved exige aprovação humana externa.';

create table private.signup_legal_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  terms_version_id uuid not null
    references public.terms_versions(id) on delete restrict,
  privacy_version_id uuid not null
    references public.terms_versions(id) on delete restrict,
  person_type text not null
    check (person_type in ('individual', 'company')),
  request_id uuid not null unique,
  ip_hash text
    check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent_hash text
    check (user_agent_hash is null or user_agent_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  check (terms_version_id <> privacy_version_id),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '15 minutes')
);

comment on table private.signup_legal_intents
  is 'Token aleatório e temporário removido atomicamente ao ser consumido ou após expirar.';

create index signup_legal_intents_expires_at_idx
on private.signup_legal_intents (expires_at);

create table private.identity_recovery_grants (
  token uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null
    references auth.users(id) on delete cascade,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  claim_attempt_id uuid,
  claimed_at timestamptz,
  constraint identity_recovery_grants_expiry_check
    check (
      expires_at > issued_at
      and expires_at <= issued_at + interval '15 minutes'
    ),
  constraint identity_recovery_grants_claim_pair_check
    check (
      (claim_attempt_id is null and claimed_at is null)
      or (
        claim_attempt_id is not null
        and claimed_at is not null
        and claimed_at >= issued_at
        and claimed_at < expires_at
      )
    )
);

comment on table private.identity_recovery_grants
  is 'Grant opaco de recuperação, válido por até 15 minutos e removido após consumo.';
comment on column private.identity_recovery_grants.claim_attempt_id
  is 'Reserva exclusiva e idempotente da tentativa que pode chamar o provedor Auth.';

create index identity_recovery_grants_expires_at_idx
on private.identity_recovery_grants (expires_at);

create table public.terms_acceptances (
  user_id uuid not null
    references public.profiles(id) on delete cascade,
  terms_version_id uuid not null
    references public.terms_versions(id) on delete restrict,
  accepted_content_hash text not null
    check (accepted_content_hash ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz not null,
  request_id uuid not null,
  ip_hash text
    check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent_hash text
    check (user_agent_hash is null or user_agent_hash ~ '^[0-9a-f]{64}$'),
  primary key (user_id, terms_version_id),
  unique (request_id, terms_version_id)
);

comment on table public.terms_acceptances
  is 'Fato jurídico imutável com snapshot do hash aceito e evidência minimizada.';
comment on column public.terms_acceptances.ip_hash
  is 'Nulo quando a origem não fornece endereço confiável; nunca recebe IP encaminhado sem confiança.';

revoke all on table public.profiles
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.terms_versions
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.terms_acceptances
  from public, anon, authenticated, service_role, app_dal;
revoke all on table private.signup_legal_intents
  from public, anon, authenticated, service_role, app_dal;
revoke all on table private.identity_recovery_grants
  from public, anon, authenticated, service_role, app_dal;

alter table public.profiles enable row level security;
alter table public.terms_versions enable row level security;
alter table public.terms_acceptances enable row level security;
alter table private.identity_recovery_grants enable row level security;

create policy profiles_select_own
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy terms_versions_select_current
on public.terms_versions
for select
to anon, authenticated
using (
  effective_at <= pg_catalog.now()
  and (retired_at is null or pg_catalog.now() < retired_at)
);

create policy terms_acceptances_select_own
on public.terms_acceptances
for select
to authenticated
using ((select auth.uid()) = user_id);

grant select (id, person_type, status, completed_at)
on table public.profiles
to authenticated;

grant select (
  id,
  kind,
  version,
  title,
  body_markdown,
  content_hash,
  source,
  effective_at,
  retired_at
)
on table public.terms_versions
to anon, authenticated;

grant select (
  user_id,
  terms_version_id,
  accepted_content_hash,
  accepted_at
)
on table public.terms_acceptances
to authenticated;

create function private.set_profile_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_profile_updated_at();

create function private.protect_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = old.id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'profile_delete_requires_auth_cascade';
  end if;

  return old;
end;
$function$;

create trigger profiles_protect_delete
before delete on public.profiles
for each row execute function private.protect_profile_delete();

create function private.protect_terms_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'P0001',
      message = 'terms_version_is_immutable';
  end if;

  if old.id is not distinct from new.id
    and old.kind is not distinct from new.kind
    and old.version is not distinct from new.version
    and old.title is not distinct from new.title
    and old.body_markdown is not distinct from new.body_markdown
    and old.source is not distinct from new.source
    and old.effective_at is not distinct from new.effective_at
    and old.created_at is not distinct from new.created_at
    and old.retired_at is null
    and new.retired_at is not null
    and new.retired_at >= pg_catalog.statement_timestamp()
  then
    return new;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'terms_version_is_immutable';
end;
$function$;

create trigger terms_versions_protect_immutability
before update or delete on public.terms_versions
for each row execute function private.protect_terms_version();

create function private.validate_terms_acceptance_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  expected_hash text;
  version_effective_at timestamptz;
  version_retired_at timestamptz;
begin
  select
    legal_version.content_hash,
    legal_version.effective_at,
    legal_version.retired_at
  into
    expected_hash,
    version_effective_at,
    version_retired_at
  from public.terms_versions as legal_version
  where legal_version.id = new.terms_version_id;

  if expected_hash is null
    or expected_hash <> new.accepted_content_hash
    or new.accepted_at < version_effective_at
    or (
      version_retired_at is not null
      and new.accepted_at >= version_retired_at
    )
    or new.accepted_at > pg_catalog.clock_timestamp()
  then
    raise exception using
      errcode = 'P0001',
      message = 'terms_acceptance_snapshot_mismatch';
  end if;

  return new;
end;
$function$;

create trigger terms_acceptances_validate_snapshot
before insert on public.terms_acceptances
for each row execute function private.validate_terms_acceptance_snapshot();

create function private.protect_terms_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' then
    raise exception using
      errcode = 'P0001',
      message = 'terms_acceptance_is_immutable';
  end if;

  if exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = old.user_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'terms_acceptance_delete_requires_auth_cascade';
  end if;

  return old;
end;
$function$;

create trigger terms_acceptances_protect_immutability
before update or delete on public.terms_acceptances
for each row execute function private.protect_terms_acceptance();

create function public.get_current_legal_terms()
returns table (
  id uuid,
  kind text,
  version text,
  title text,
  body_markdown text,
  content_hash text,
  source text,
  effective_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    legal_version.id,
    legal_version.kind,
    legal_version.version,
    legal_version.title,
    legal_version.body_markdown,
    legal_version.content_hash,
    legal_version.source,
    legal_version.effective_at
  from public.terms_versions as legal_version
  where legal_version.effective_at <= pg_catalog.now()
    and (
      legal_version.retired_at is null
      or pg_catalog.now() < legal_version.retired_at
    )
  order by legal_version.kind;
$function$;

create function public.get_own_identity_context()
returns table (
  user_id uuid,
  person_type text,
  status text,
  is_complete boolean
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    profile.id,
    profile.person_type,
    profile.status,
    profile.completed_at is not null
  from public.profiles as profile
  where profile.id = (select auth.uid());
$function$;

revoke all on function public.get_current_legal_terms()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function public.get_own_identity_context()
  from public, anon, authenticated, service_role, app_dal;
grant execute on function public.get_current_legal_terms()
  to anon, authenticated;
grant execute on function public.get_own_identity_context()
  to authenticated;

create function private.create_signup_legal_intent(
  expected_terms_version_id uuid,
  expected_privacy_version_id uuid,
  person_type text,
  request_id uuid,
  evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing_intent private.signup_legal_intents%rowtype;
  intent_created_at timestamptz;
  intent_id uuid;
  normalized_ip_hash text;
  normalized_user_agent_hash text;
begin
  if expected_terms_version_id is null
    or expected_privacy_version_id is null
    or person_type is null
    or request_id is null
    or evidence is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_signup_legal_intent';
  end if;

  if person_type not in ('individual', 'company')
    or pg_catalog.jsonb_typeof(evidence) <> 'object'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(evidence) as evidence_key(key)
      where evidence_key.key not in ('ipHash', 'userAgentHash')
    )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_signup_legal_intent';
  end if;

  normalized_ip_hash := evidence ->> 'ipHash';
  normalized_user_agent_hash := evidence ->> 'userAgentHash';

  if (
      normalized_ip_hash is not null
      and normalized_ip_hash !~ '^[0-9a-f]{64}$'
    )
    or (
      normalized_user_agent_hash is not null
      and normalized_user_agent_hash !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_signup_legal_evidence';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = expected_terms_version_id
    and legal_version.kind = 'terms'
    and legal_version.effective_at <= pg_catalog.clock_timestamp()
    and (
      legal_version.retired_at is null
      or pg_catalog.clock_timestamp() < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = expected_privacy_version_id
    and legal_version.kind = 'privacy'
    and legal_version.effective_at <= pg_catalog.clock_timestamp()
    and (
      legal_version.retired_at is null
      or pg_catalog.clock_timestamp() < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  delete from private.signup_legal_intents as expired_intent
  where expired_intent.expires_at <= pg_catalog.clock_timestamp();

  intent_created_at := pg_catalog.clock_timestamp();

  insert into private.signup_legal_intents (
    terms_version_id,
    privacy_version_id,
    person_type,
    request_id,
    ip_hash,
    user_agent_hash,
    created_at,
    expires_at
  )
  values (
    expected_terms_version_id,
    expected_privacy_version_id,
    create_signup_legal_intent.person_type,
    create_signup_legal_intent.request_id,
    normalized_ip_hash,
    normalized_user_agent_hash,
    intent_created_at,
    intent_created_at + interval '10 minutes'
  )
  on conflict on constraint signup_legal_intents_request_id_key do nothing
  returning id into intent_id;

  if found then
    return intent_id;
  end if;

  select intent.*
  into existing_intent
  from private.signup_legal_intents as intent
  where intent.request_id = create_signup_legal_intent.request_id
  for update;

  if found
    and existing_intent.expires_at > pg_catalog.clock_timestamp()
    and existing_intent.terms_version_id = expected_terms_version_id
    and existing_intent.privacy_version_id = expected_privacy_version_id
    and existing_intent.person_type = create_signup_legal_intent.person_type
    and existing_intent.ip_hash is not distinct from normalized_ip_hash
    and existing_intent.user_agent_hash
      is not distinct from normalized_user_agent_hash
  then
    return existing_intent.id;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'signup_legal_request_conflict';
end;
$function$;

create function private.issue_identity_recovery_grant(p_user_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  grant_issued_at timestamptz;
  grant_token uuid;
begin
  if p_user_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  grant_issued_at := pg_catalog.clock_timestamp();

  delete from private.identity_recovery_grants as expired_grant
  where expired_grant.expires_at <= grant_issued_at;

  insert into private.identity_recovery_grants (
    user_id,
    issued_at,
    expires_at
  )
  values (
    p_user_id,
    grant_issued_at,
    grant_issued_at + interval '15 minutes'
  )
  returning token into grant_token;

  return grant_token;
end;
$function$;

create function private.has_identity_recovery_grant(
  p_token uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_token is null or p_user_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  return exists (
    select 1
    from private.identity_recovery_grants as recovery_grant
    where recovery_grant.token = p_token
      and recovery_grant.user_id = p_user_id
      and recovery_grant.expires_at > pg_catalog.statement_timestamp()
      and recovery_grant.claim_attempt_id is null
  );
end;
$function$;

create function private.claim_identity_recovery_grant(
  p_token uuid,
  p_user_id uuid,
  p_attempt_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claim_time timestamptz;
  grant_claimed boolean;
begin
  if p_token is null or p_user_id is null or p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  claim_time := pg_catalog.clock_timestamp();

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = p_attempt_id,
    claimed_at = coalesce(recovery_grant.claimed_at, claim_time)
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.expires_at > claim_time
    and (
      recovery_grant.claim_attempt_id is null
      or recovery_grant.claim_attempt_id = p_attempt_id
    )
  returning true into grant_claimed;

  return coalesce(grant_claimed, false);
end;
$function$;

create function private.release_identity_recovery_grant(
  p_token uuid,
  p_user_id uuid,
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
  if p_token is null or p_user_id is null or p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  update private.identity_recovery_grants as recovery_grant
  set
    claim_attempt_id = null,
    claimed_at = null
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.claim_attempt_id = p_attempt_id
  returning true into grant_released;

  return coalesce(grant_released, false);
end;
$function$;

create function private.consume_identity_recovery_grant(
  p_token uuid,
  p_user_id uuid,
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
  if p_token is null or p_user_id is null or p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_identity_recovery_grant';
  end if;

  delete from private.identity_recovery_grants as recovery_grant
  where recovery_grant.token = p_token
    and recovery_grant.user_id = p_user_id
    and recovery_grant.claim_attempt_id = p_attempt_id
  returning true into grant_consumed;

  return coalesce(grant_consumed, false);
end;
$function$;

create function private.bootstrap_signup_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  accepted_at timestamptz := pg_catalog.clock_timestamp();
  intent private.signup_legal_intents%rowtype;
  intent_token_text text;
begin
  intent_token_text := new.raw_user_meta_data ->> 'sl_legal_intent';

  if intent_token_text is null
    or intent_token_text !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_intent_required';
  end if;

  select pending_intent.*
  into intent
  from private.signup_legal_intents as pending_intent
  where pending_intent.id = intent_token_text::uuid
  for update;

  if not found or intent.expires_at <= accepted_at then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_intent_invalid';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = intent.terms_version_id
    and legal_version.kind = 'terms'
    and legal_version.effective_at <= accepted_at
    and (
      legal_version.retired_at is null
      or accepted_at < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  perform 1
  from public.terms_versions as legal_version
  where legal_version.id = intent.privacy_version_id
    and legal_version.kind = 'privacy'
    and legal_version.effective_at <= accepted_at
    and (
      legal_version.retired_at is null
      or accepted_at < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'signup_legal_terms_stale';
  end if;

  insert into public.profiles (
    id,
    person_type,
    status,
    completed_at
  )
  values (
    new.id,
    intent.person_type,
    'active',
    null
  );

  insert into public.terms_acceptances (
    user_id,
    terms_version_id,
    accepted_content_hash,
    accepted_at,
    request_id,
    ip_hash,
    user_agent_hash
  )
  select
    new.id,
    legal_version.id,
    legal_version.content_hash,
    accepted_at,
    intent.request_id,
    intent.ip_hash,
    intent.user_agent_hash
  from public.terms_versions as legal_version
  where legal_version.id in (
    intent.terms_version_id,
    intent.privacy_version_id
  );

  delete from private.signup_legal_intents as pending_intent
  where pending_intent.id = intent.id;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_intent_invalid';
  end if;

  update auth.users as auth_user
  set raw_user_meta_data =
    coalesce(auth_user.raw_user_meta_data, '{}'::jsonb)
      - 'sl_legal_intent'
  where auth_user.id = new.id;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'signup_legal_metadata_scrub_failed';
  end if;

  return new;
end;
$function$;

create trigger set_livre_bootstrap_signup_identity
after insert on auth.users
for each row execute function private.bootstrap_signup_identity();

revoke all on function private.set_profile_updated_at()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.protect_profile_delete()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.protect_terms_version()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.validate_terms_acceptance_snapshot()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.protect_terms_acceptance()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.bootstrap_signup_identity()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.create_signup_legal_intent(uuid, uuid, text, uuid, jsonb)
  from public, anon, authenticated, service_role, app_dal;
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
grant execute on function private.create_signup_legal_intent(uuid, uuid, text, uuid, jsonb)
  to app_dal;
grant execute on function private.issue_identity_recovery_grant(uuid)
  to app_dal;
grant execute on function private.has_identity_recovery_grant(uuid, uuid)
  to app_dal;
grant execute on function private.claim_identity_recovery_grant(uuid, uuid, uuid)
  to app_dal;
grant execute on function private.release_identity_recovery_grant(uuid, uuid, uuid)
  to app_dal;
grant execute on function private.consume_identity_recovery_grant(uuid, uuid, uuid)
  to app_dal;

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
  authorized_acl_dependencies as (
    select
      pg_catalog.count(*) = 9
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
            'private.issue_identity_recovery_grant(uuid)'
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
            'private.has_identity_recovery_grant(uuid,uuid)'
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
            'private.claim_identity_recovery_grant(uuid,uuid,uuid)'
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
            'private.release_identity_recovery_grant(uuid,uuid,uuid)'
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
            'private.consume_identity_recovery_grant(uuid,uuid,uuid)'
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
      pg_catalog.count(*) = 8
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
          'private.issue_identity_recovery_grant(uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.has_identity_recovery_grant(uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.claim_identity_recovery_grant(uuid,uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.release_identity_recovery_grant(uuid,uuid,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.consume_identity_recovery_grant(uuid,uuid,uuid)'
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


comment on function private.create_signup_legal_intent(uuid, uuid, text, uuid, jsonb)
  is 'Purga tokens expirados e cria token opaco idempotente enquanto o request_id permanece pendente.';
comment on function private.issue_identity_recovery_grant(uuid)
  is 'Purga grants expirados e emite token opaco vinculado ao usuário por 15 minutos.';
comment on function private.has_identity_recovery_grant(uuid, uuid)
  is 'Confirma somente grant vigente, vinculado ao usuário e ainda não reservado.';
comment on function private.claim_identity_recovery_grant(uuid, uuid, uuid)
  is 'Reserva exclusivamente um grant vigente; retry da mesma tentativa é idempotente.';
comment on function private.release_identity_recovery_grant(uuid, uuid, uuid)
  is 'Libera somente a reserva da tentativa informada para retry após falha do provedor.';
comment on function private.consume_identity_recovery_grant(uuid, uuid, uuid)
  is 'Remove somente o grant reservado pela tentativa após sucesso do provedor.';
comment on function private.bootstrap_signup_identity()
  is 'Apaga a intenção válida no INSERT de auth.users e cria perfil, aceites e scrub de metadata atomicamente.';
comment on function private.check_readiness(text)
  is 'Valida migration head, superfície pública e manifesto exato da role DAL, incluindo cadastro e recovery.';

revoke all on function private.check_readiness(text)
  from public, anon, authenticated, service_role;
grant execute on function private.check_readiness(text)
  to app_dal;
