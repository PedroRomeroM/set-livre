-- FEAT-004: ativação de dono, contrato jurídico próprio e recebedor local.
-- A superfície web recebe somente projeções seguras; referências do provider e
-- operações idempotentes permanecem no schema private sem grants runtime.

alter table public.terms_versions
  drop constraint terms_versions_kind_check;

alter table public.terms_versions
  add constraint terms_versions_kind_check
  check (kind in ('terms', 'privacy', 'owner_contract'));

drop policy terms_versions_select_current on public.terms_versions;

create policy terms_versions_select_current_public
on public.terms_versions
for select
to anon
using (
  kind in ('terms', 'privacy')
  and effective_at <= pg_catalog.now()
  and (retired_at is null or pg_catalog.now() < retired_at)
);

create policy terms_versions_select_current_authenticated
on public.terms_versions
for select
to authenticated
using (
  effective_at <= pg_catalog.now()
  and (retired_at is null or pg_catalog.now() < retired_at)
);

create or replace function public.get_current_legal_terms()
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
  where legal_version.kind in ('terms', 'privacy')
    and legal_version.effective_at <= pg_catalog.now()
    and (
      legal_version.retired_at is null
      or pg_catalog.now() < legal_version.retired_at
    )
  order by legal_version.kind;
$function$;

create function public.get_current_owner_contract()
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
  where legal_version.kind = 'owner_contract'
    and legal_version.effective_at <= pg_catalog.now()
    and (
      legal_version.retired_at is null
      or pg_catalog.now() < legal_version.retired_at
    );
$function$;

create table public.owner_profiles (
  user_id uuid primary key
    references public.profiles(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'blocked')),
  accepted_owner_contract_version_id uuid not null
    references public.terms_versions(id) on delete restrict,
  owner_version bigint not null default 1
    check (owner_version >= 1),
  activated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  check (activated_at >= created_at),
  check (updated_at >= created_at)
);

comment on table public.owner_profiles
  is 'Autoridade mínima do dono; identidade e PII permanecem exclusivamente em profiles.';
comment on column public.owner_profiles.accepted_owner_contract_version_id
  is 'Última versão de owner_contract aceita; o histórico imutável permanece em terms_acceptances.';

create table public.owner_payment_recipients (
  owner_user_id uuid primary key
    references public.owner_profiles(user_id) on delete cascade,
  status text not null default 'not_started'
    check (status in (
      'not_started', 'pending', 'active', 'refused', 'suspended', 'blocked'
    )),
  requirements text[] not null default '{}'::text[],
  profile_version_synced bigint
    check (profile_version_synced is null or profile_version_synced >= 0),
  recipient_version bigint not null default 0
    check (recipient_version >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint owner_payment_recipients_requirements_check check (
    pg_catalog.cardinality(requirements) <= 3
    and pg_catalog.array_position(requirements, null) is null
    and requirements <@ array[
      'identity_review', 'additional_information', 'provider_contact'
    ]::text[]
    and (
      pg_catalog.cardinality(requirements) < 2
      or requirements[1] <> requirements[2]
    )
    and (
      pg_catalog.cardinality(requirements) < 3
      or (
        requirements[1] <> requirements[3]
        and requirements[2] <> requirements[3]
      )
    )
  ),
  constraint owner_payment_recipients_active_requirements_check check (
    status <> 'active' or requirements = '{}'::text[]
  ),
  check (updated_at >= created_at)
);

comment on table public.owner_payment_recipients
  is 'Estado seguro e versionado do recebedor; nenhuma referência do provider existe nesta tabela.';

create table private.owner_activation_requests (
  owner_user_id uuid not null
    references public.owner_profiles(user_id) on delete cascade,
  idempotency_key uuid not null,
  owner_contract_version_id uuid not null
    references public.terms_versions(id) on delete restrict,
  resulting_owner_version bigint not null check (resulting_owner_version >= 1),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (owner_user_id, idempotency_key)
);

create table private.owner_recipient_operations (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_user_id uuid not null
    references public.owner_profiles(user_id) on delete cascade,
  action text not null check (action in ('start', 'refresh')),
  idempotency_key uuid not null,
  operation_sequence bigint not null check (operation_sequence >= 1),
  profile_version bigint not null check (profile_version >= 0),
  provider text check (provider is null or provider = 'local'),
  provider_reference text check (
    provider_reference is null
    or (
      pg_catalog.char_length(provider_reference) between 1 and 200
      and provider_reference !~ '[[:cntrl:]]'
      and (
        provider_reference ~ '^local-recipient:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or provider_reference in (
          'local-test-fixture:refused',
          'local-test-fixture:suspended',
          'local-test-fixture:blocked',
          'local-test-fixture:unavailable',
          'local-test-fixture:timeout'
        )
      )
    )
  ),
  result_status text check (
    result_status is null
    or result_status in ('pending', 'active', 'refused', 'suspended', 'blocked')
  ),
  result_requirements text[],
  created_at timestamptz not null default pg_catalog.now(),
  applied_at timestamptz,
  constraint owner_recipient_operations_owner_key_key
    unique (owner_user_id, idempotency_key),
  constraint owner_recipient_operations_owner_sequence_key
    unique (owner_user_id, operation_sequence),
  constraint owner_recipient_operations_result_pair_check check (
    (
      applied_at is null
      and provider is null
      and result_status is null
      and result_requirements is null
    )
    or (
      applied_at is not null
      and applied_at >= created_at
      and provider = 'local'
      and provider_reference is not null
      and result_status is not null
      and result_requirements is not null
    )
  ),
  constraint owner_recipient_operations_result_requirements_check check (
    result_requirements is null
    or (
      pg_catalog.cardinality(result_requirements) <= 3
      and pg_catalog.array_position(result_requirements, null) is null
      and result_requirements <@ array[
        'identity_review', 'additional_information', 'provider_contact'
      ]::text[]
      and (
        pg_catalog.cardinality(result_requirements) < 2
        or result_requirements[1] <> result_requirements[2]
      )
      and (
        pg_catalog.cardinality(result_requirements) < 3
        or (
          result_requirements[1] <> result_requirements[3]
          and result_requirements[2] <> result_requirements[3]
        )
      )
    )
  )
);

comment on table private.owner_recipient_operations
  is 'Prepare/apply idempotente e privado; contém a única referência local do provider nesta fatia.';

create table audit.events (
  id uuid primary key default extensions.gen_random_uuid(),
  occurred_at timestamptz not null default pg_catalog.now(),
  actor_user_id uuid
    references public.profiles(id) on delete set null,
  actor_role text not null check (actor_role = 'authenticated'),
  action text not null check (action in (
    'owner.activated', 'owner.contract_renewed', 'recipient.status_transitioned'
  )),
  target_type text not null check (target_type in (
    'owner_profile', 'owner_payment_recipient'
  )),
  target_id uuid not null,
  result text not null check (result = 'succeeded'),
  request_id uuid not null,
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  unique (action, target_id, request_id)
);

create index audit_events_actor_user_id_idx
on audit.events (actor_user_id)
where actor_user_id is not null;

comment on table audit.events
  is 'Eventos operacionais append-only; referências externas e PII são proibidas em metadata.';

revoke all on table public.owner_profiles
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.owner_payment_recipients
  from public, anon, authenticated, service_role, app_dal;
revoke all on table private.owner_activation_requests
  from public, anon, authenticated, service_role, app_dal;
revoke all on table private.owner_recipient_operations
  from public, anon, authenticated, service_role, app_dal;
revoke all on table audit.events
  from public, anon, authenticated, service_role, app_dal;

alter table public.owner_profiles enable row level security;
alter table public.owner_payment_recipients enable row level security;
alter table private.owner_activation_requests enable row level security;
alter table private.owner_recipient_operations enable row level security;
alter table audit.events enable row level security;

create policy owner_profiles_select_own
on public.owner_profiles
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy owner_payment_recipients_select_own
on public.owner_payment_recipients
for select
to authenticated
using ((select auth.uid()) = owner_user_id);

grant select (
  user_id,
  status,
  accepted_owner_contract_version_id,
  owner_version,
  activated_at
)
on table public.owner_profiles
to authenticated;

grant select (
  owner_user_id,
  status,
  requirements,
  profile_version_synced,
  recipient_version
)
on table public.owner_payment_recipients
to authenticated;

create function private.enforce_owner_profile_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  contract_kind text;
begin
  select legal_version.kind
  into contract_kind
  from public.terms_versions as legal_version
  where legal_version.id = new.accepted_owner_contract_version_id;

  if contract_kind is distinct from 'owner_contract' then
    raise exception using
      errcode = '23514',
      message = 'owner_contract_kind_invalid';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'active' or new.owner_version <> 1 then
      raise exception using
        errcode = '23514',
        message = 'owner_initial_state_invalid';
    end if;
    return new;
  end if;

  if old.status = 'blocked'
    and (
      new.status is distinct from old.status
      or new.accepted_owner_contract_version_id
        is distinct from old.accepted_owner_contract_version_id
    )
  then
    raise exception using
      errcode = '23514',
      message = 'owner_blocked_is_terminal';
  end if;

  new.owner_version := old.owner_version + 1;
  new.activated_at := old.activated_at;
  new.created_at := old.created_at;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create trigger owner_profiles_enforce_state
before insert or update on public.owner_profiles
for each row execute function private.enforce_owner_profile_state();

create function private.enforce_owner_recipient_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'not_started'
      or new.recipient_version <> 0
      or new.profile_version_synced is not null
      or new.requirements <> '{}'::text[]
    then
      raise exception using
        errcode = '23514',
        message = 'recipient_initial_state_invalid';
    end if;
    return new;
  end if;

  if not (
    (old.status = 'not_started' and new.status = 'pending')
    or (
      old.status = 'pending'
      and new.status in ('pending', 'active', 'refused', 'suspended', 'blocked')
    )
    or (
      old.status = 'active'
      and new.status in ('active', 'refused', 'suspended', 'blocked')
    )
    or (
      old.status = 'refused'
      and new.status in ('pending', 'refused', 'blocked')
    )
    or (
      old.status = 'suspended'
      and new.status in ('pending', 'active', 'suspended', 'blocked')
    )
    or (old.status = 'blocked' and new.status = 'blocked')
  ) then
    raise exception using
      errcode = '23514',
      message = 'recipient_transition_invalid';
  end if;

  new.recipient_version := old.recipient_version + 1;
  new.created_at := old.created_at;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create trigger owner_payment_recipients_enforce_state
before insert or update on public.owner_payment_recipients
for each row execute function private.enforce_owner_recipient_state();

create function private.protect_audit_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE'
    and old.actor_user_id is not null
    and new.actor_user_id is null
    and new.id is not distinct from old.id
    and new.occurred_at is not distinct from old.occurred_at
    and new.actor_role is not distinct from old.actor_role
    and new.action is not distinct from old.action
    and new.target_type is not distinct from old.target_type
    and new.target_id is not distinct from old.target_id
    and new.result is not distinct from old.result
    and new.request_id is not distinct from old.request_id
    and new.ip_hash is not distinct from old.ip_hash
    and new.metadata is not distinct from old.metadata
  then
    return new;
  end if;

  if tg_op = 'DELETE' and current_user = 'postgres' then
    return old;
  end if;

  raise exception using
    errcode = '42501',
    message = 'audit_event_is_append_only';
end;
$function$;

create trigger audit_events_protect_append_only
before update or delete on audit.events
for each row execute function private.protect_audit_event();

create function private.owner_recipient_status_row(p_user_id uuid)
returns table (
  scope uuid,
  owner_status text,
  owner_version bigint,
  accepted_owner_contract_version_id uuid,
  owner_contract_accepted boolean,
  owner_contract_id uuid,
  owner_contract_kind text,
  owner_contract_version text,
  owner_contract_title text,
  owner_contract_body_markdown text,
  owner_contract_content_hash text,
  owner_contract_source text,
  owner_contract_effective_at timestamptz,
  recipient_status text,
  requirements text[],
  next_action text,
  profile_version bigint,
  profile_version_synced bigint,
  recipient_version bigint,
  reservations_eligible boolean,
  provider_mode text
)
language sql
stable
security definer
set search_path = ''
as $function$
  with current_contract as (
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
    where legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.now()
      and (
        legal_version.retired_at is null
        or pg_catalog.now() < legal_version.retired_at
      )
  ),
  source_state as (
    select
      profile.id as user_id,
      profile.profile_version,
      profile.status as profile_status,
      profile.completed_at,
      owner.status as canonical_owner_status,
      owner.owner_version,
      owner.accepted_owner_contract_version_id,
      contract.id as contract_id,
      contract.kind as contract_kind,
      contract.version as contract_version,
      contract.title as contract_title,
      contract.body_markdown as contract_body_markdown,
      contract.content_hash as contract_content_hash,
      contract.source as contract_source,
      contract.effective_at as contract_effective_at,
      recipient.status as canonical_recipient_status,
      recipient.requirements as recipient_requirements,
      recipient.profile_version_synced,
      recipient.recipient_version,
      exists (
        select 1
        from public.terms_acceptances as acceptance
        where acceptance.user_id = profile.id
          and acceptance.terms_version_id = contract.id
          and acceptance.accepted_content_hash = contract.content_hash
      ) as current_contract_acceptance_exists
    from public.profiles as profile
    cross join current_contract as contract
    left join public.owner_profiles as owner
      on owner.user_id = profile.id
    left join public.owner_payment_recipients as recipient
      on recipient.owner_user_id = owner.user_id
    where profile.id = p_user_id
  ),
  projected as (
    select
      source_state.*,
      case
        when source_state.profile_status <> 'active'
          or source_state.canonical_owner_status = 'blocked'
          then 'blocked'
        when source_state.canonical_owner_status is null
          then 'inactive'
        else 'active'
      end as projected_owner_status,
      coalesce(source_state.canonical_recipient_status, 'not_started')
        as projected_recipient_status,
      (
        source_state.accepted_owner_contract_version_id = source_state.contract_id
        and source_state.current_contract_acceptance_exists
      ) as projected_contract_accepted
    from source_state
  )
  select
    projected.user_id,
    projected.projected_owner_status,
    coalesce(projected.owner_version, 0::bigint),
    projected.accepted_owner_contract_version_id,
    projected.projected_contract_accepted,
    projected.contract_id,
    projected.contract_kind,
    projected.contract_version,
    projected.contract_title,
    projected.contract_body_markdown,
    projected.contract_content_hash,
    projected.contract_source,
    projected.contract_effective_at,
    projected.projected_recipient_status,
    coalesce(projected.recipient_requirements, '{}'::text[]),
    case
      when projected.projected_owner_status = 'blocked'
        or projected.projected_recipient_status = 'blocked'
        then 'none'
      when projected.projected_owner_status = 'inactive'
        or not projected.projected_contract_accepted
        then 'activate_owner'
      when projected.projected_recipient_status in ('not_started', 'refused')
        then 'start_onboarding'
      when projected.projected_recipient_status in ('pending', 'suspended')
        or (
          projected.projected_recipient_status = 'active'
          and projected.profile_version_synced is distinct from projected.profile_version
        )
        then 'refresh_status'
      else 'none'
    end,
    projected.profile_version,
    projected.profile_version_synced,
    coalesce(projected.recipient_version, 0::bigint),
    (
      projected.projected_owner_status = 'active'
      and projected.projected_contract_accepted
      and projected.projected_recipient_status = 'active'
      and projected.profile_version_synced = projected.profile_version
    ),
    'local'::text
  from projected;
$function$;

create function private.get_owner_recipient_status_for_user(p_user_id uuid)
returns table (
  scope uuid,
  owner_status text,
  owner_version bigint,
  accepted_owner_contract_version_id uuid,
  owner_contract_accepted boolean,
  owner_contract_id uuid,
  owner_contract_kind text,
  owner_contract_version text,
  owner_contract_title text,
  owner_contract_body_markdown text,
  owner_contract_content_hash text,
  owner_contract_source text,
  owner_contract_effective_at timestamptz,
  recipient_status text,
  requirements text[],
  next_action text,
  profile_version bigint,
  profile_version_synced bigint,
  recipient_version bigint,
  reservations_eligible boolean,
  provider_mode text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'invalid_owner_user';
  end if;

  if not exists (
    select 1 from public.profiles as profile where profile.id = p_user_id
  ) then
    raise exception using errcode = 'P0002', message = 'owner_profile_missing';
  end if;

  return query
  select * from private.owner_recipient_status_row(p_user_id);

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_contract_missing';
  end if;
end;
$function$;

create function public.get_owner_recipient_status()
returns table (
  scope uuid,
  owner_status text,
  owner_version bigint,
  accepted_owner_contract_version_id uuid,
  owner_contract_accepted boolean,
  owner_contract_id uuid,
  owner_contract_kind text,
  owner_contract_version text,
  owner_contract_title text,
  owner_contract_body_markdown text,
  owner_contract_content_hash text,
  owner_contract_source text,
  owner_contract_effective_at timestamptz,
  recipient_status text,
  requirements text[],
  next_action text,
  profile_version bigint,
  profile_version_synced bigint,
  recipient_version bigint,
  reservations_eligible boolean,
  provider_mode text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with current_contract as (
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
    where legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.now()
      and (
        legal_version.retired_at is null
        or pg_catalog.now() < legal_version.retired_at
      )
  ),
  source_state as (
    select
      profile.id as user_id,
      profile.profile_version,
      profile.status as profile_status,
      owner.status as canonical_owner_status,
      owner.owner_version,
      owner.accepted_owner_contract_version_id,
      contract.id as contract_id,
      contract.kind as contract_kind,
      contract.version as contract_version,
      contract.title as contract_title,
      contract.body_markdown as contract_body_markdown,
      contract.content_hash as contract_content_hash,
      contract.source as contract_source,
      contract.effective_at as contract_effective_at,
      recipient.status as canonical_recipient_status,
      recipient.requirements as recipient_requirements,
      recipient.profile_version_synced,
      recipient.recipient_version,
      exists (
        select 1
        from public.terms_acceptances as acceptance
        where acceptance.user_id = profile.id
          and acceptance.terms_version_id = contract.id
          and acceptance.accepted_content_hash = contract.content_hash
      ) as current_contract_acceptance_exists
    from public.profiles as profile
    cross join current_contract as contract
    left join public.owner_profiles as owner
      on owner.user_id = profile.id
    left join public.owner_payment_recipients as recipient
      on recipient.owner_user_id = owner.user_id
    where profile.id = (select auth.uid())
  ),
  projected as (
    select
      source_state.*,
      case
        when source_state.profile_status <> 'active'
          or source_state.canonical_owner_status = 'blocked'
          then 'blocked'
        when source_state.canonical_owner_status is null
          then 'inactive'
        else 'active'
      end as projected_owner_status,
      coalesce(source_state.canonical_recipient_status, 'not_started')
        as projected_recipient_status,
      (
        source_state.accepted_owner_contract_version_id = source_state.contract_id
        and source_state.current_contract_acceptance_exists
      ) as projected_contract_accepted
    from source_state
  )
  select
    projected.user_id,
    projected.projected_owner_status,
    coalesce(projected.owner_version, 0::bigint),
    projected.accepted_owner_contract_version_id,
    projected.projected_contract_accepted,
    projected.contract_id,
    projected.contract_kind,
    projected.contract_version,
    projected.contract_title,
    projected.contract_body_markdown,
    projected.contract_content_hash,
    projected.contract_source,
    projected.contract_effective_at,
    projected.projected_recipient_status,
    coalesce(projected.recipient_requirements, '{}'::text[]),
    case
      when projected.projected_owner_status = 'blocked'
        or projected.projected_recipient_status = 'blocked'
        then 'none'
      when projected.projected_owner_status = 'inactive'
        or not projected.projected_contract_accepted
        then 'activate_owner'
      when projected.projected_recipient_status in ('not_started', 'refused')
        then 'start_onboarding'
      when projected.projected_recipient_status in ('pending', 'suspended')
        or (
          projected.projected_recipient_status = 'active'
          and projected.profile_version_synced is distinct from projected.profile_version
        )
        then 'refresh_status'
      else 'none'
    end,
    projected.profile_version,
    projected.profile_version_synced,
    coalesce(projected.recipient_version, 0::bigint),
    (
      projected.projected_owner_status = 'active'
      and projected.projected_contract_accepted
      and projected.projected_recipient_status = 'active'
      and projected.profile_version_synced = projected.profile_version
    ),
    'local'::text
  from projected;
$function$;

create function private.activate_owner(
  p_user_id uuid,
  p_owner_contract_version_id uuid,
  p_idempotency_key uuid,
  p_user_agent_hash text
)
returns table (
  scope uuid,
  owner_status text,
  owner_version bigint,
  accepted_owner_contract_version_id uuid,
  owner_contract_accepted boolean,
  owner_contract_id uuid,
  owner_contract_kind text,
  owner_contract_version text,
  owner_contract_title text,
  owner_contract_body_markdown text,
  owner_contract_content_hash text,
  owner_contract_source text,
  owner_contract_effective_at timestamptz,
  recipient_status text,
  requirements text[],
  next_action text,
  profile_version bigint,
  profile_version_synced bigint,
  recipient_version bigint,
  reservations_eligible boolean,
  provider_mode text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  accepted_at timestamptz := pg_catalog.clock_timestamp();
  contract public.terms_versions%rowtype;
  existing_request private.owner_activation_requests%rowtype;
  owner public.owner_profiles%rowtype;
  profile public.profiles%rowtype;
  transition_action text;
begin
  if p_user_id is null
    or p_owner_contract_version_id is null
    or p_idempotency_key is null
    or (
      p_user_agent_hash is not null
      and p_user_agent_hash !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_owner_activation';
  end if;

  select candidate.*
  into profile
  from public.profiles as candidate
  where candidate.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_profile_missing';
  end if;

  select request.*
  into existing_request
  from private.owner_activation_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key
  for update;

  if found then
    if existing_request.owner_contract_version_id
      is distinct from p_owner_contract_version_id
    then
      raise exception using errcode = '40001', message = 'owner_idempotency_conflict';
    end if;

    return query
    select * from private.owner_recipient_status_row(p_user_id);
    return;
  end if;

  if profile.status <> 'active' or profile.completed_at is null then
    raise exception using errcode = '42501', message = 'owner_profile_inactive';
  end if;

  select legal_version.*
  into contract
  from public.terms_versions as legal_version
  where legal_version.id = p_owner_contract_version_id
    and legal_version.kind = 'owner_contract'
    and legal_version.effective_at <= accepted_at
    and (
      legal_version.retired_at is null
      or accepted_at < legal_version.retired_at
    )
  for share;

  if not found then
    raise exception using errcode = '23514', message = 'owner_contract_stale';
  end if;

  if exists (
    select 1
    from public.terms_acceptances as acceptance
    where acceptance.request_id = p_idempotency_key
      and (
        acceptance.user_id <> p_user_id
        or acceptance.terms_version_id <> p_owner_contract_version_id
      )
  ) then
    raise exception using errcode = '40001', message = 'owner_idempotency_conflict';
  end if;

  select current_owner.*
  into owner
  from public.owner_profiles as current_owner
  where current_owner.user_id = p_user_id
  for update;

  if not found then
    insert into public.owner_profiles (
      user_id,
      status,
      accepted_owner_contract_version_id,
      owner_version
    )
    values (
      p_user_id,
      'active',
      p_owner_contract_version_id,
      1
    )
    returning * into owner;
    transition_action := 'owner.activated';
  elsif owner.status = 'blocked' then
    raise exception using errcode = '42501', message = 'owner_blocked';
  elsif owner.accepted_owner_contract_version_id
    is distinct from p_owner_contract_version_id
  then
    update public.owner_profiles as current_owner
    set accepted_owner_contract_version_id = p_owner_contract_version_id
    where current_owner.user_id = p_user_id
    returning * into owner;
    transition_action := 'owner.contract_renewed';
  end if;

  insert into public.terms_acceptances (
    user_id,
    terms_version_id,
    accepted_content_hash,
    accepted_at,
    request_id,
    ip_hash,
    user_agent_hash
  )
  values (
    p_user_id,
    contract.id,
    contract.content_hash,
    accepted_at,
    p_idempotency_key,
    null,
    p_user_agent_hash
  )
  on conflict (user_id, terms_version_id) do nothing;

  if not exists (
    select 1
    from public.terms_acceptances as acceptance
    where acceptance.user_id = p_user_id
      and acceptance.terms_version_id = contract.id
      and acceptance.accepted_content_hash = contract.content_hash
  ) then
    raise exception using errcode = '23514', message = 'owner_acceptance_invalid';
  end if;

  insert into public.owner_payment_recipients (owner_user_id)
  values (p_user_id)
  on conflict (owner_user_id) do nothing;

  insert into private.owner_activation_requests (
    owner_user_id,
    idempotency_key,
    owner_contract_version_id,
    resulting_owner_version
  )
  values (
    p_user_id,
    p_idempotency_key,
    p_owner_contract_version_id,
    owner.owner_version
  );

  if transition_action is not null then
    insert into audit.events (
      actor_user_id,
      actor_role,
      action,
      target_type,
      target_id,
      result,
      request_id,
      ip_hash,
      metadata
    )
    values (
      p_user_id,
      'authenticated',
      transition_action,
      'owner_profile',
      p_user_id,
      'succeeded',
      p_idempotency_key,
      null,
      pg_catalog.jsonb_build_object(
        'ownerVersion', owner.owner_version,
        'contractVersionId', contract.id
      )
    );
  end if;

  return query
  select * from private.owner_recipient_status_row(p_user_id);
end;
$function$;

create function private.prepare_owner_recipient_operation(
  p_user_id uuid,
  p_action text,
  p_idempotency_key uuid
)
returns table (
  operation_id uuid,
  operation_sequence bigint,
  operation_action text,
  provider_reference text,
  profile_version bigint,
  already_applied boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_operation private.owner_recipient_operations%rowtype;
  current_owner public.owner_profiles%rowtype;
  current_profile public.profiles%rowtype;
  current_recipient public.owner_payment_recipients%rowtype;
  next_sequence bigint;
  prepared_reference text;
  operation_was_found boolean := false;
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_action is null
    or p_action not in ('start', 'refresh')
  then
    raise exception using errcode = '22023', message = 'invalid_recipient_operation';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_profile_missing';
  end if;

  select owner.*
  into current_owner
  from public.owner_profiles as owner
  where owner.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_authority_missing';
  end if;

  select recipient.*
  into current_recipient
  from public.owner_payment_recipients as recipient
  where recipient.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'recipient_state_missing';
  end if;

  select operation.*
  into current_operation
  from private.owner_recipient_operations as operation
  where operation.owner_user_id = p_user_id
    and operation.idempotency_key = p_idempotency_key
  for update;

  operation_was_found := found;

  if operation_was_found then
    if current_operation.action <> p_action then
      raise exception using errcode = '40001', message = 'recipient_idempotency_conflict';
    end if;

    if current_operation.applied_at is not null then
      return query
      select
        current_operation.id,
        current_operation.operation_sequence,
        current_operation.action,
        current_operation.provider_reference,
        current_operation.profile_version,
        true;
      return;
    end if;
  end if;

  if current_profile.status <> 'active' or current_profile.completed_at is null then
    raise exception using errcode = '42501', message = 'owner_profile_inactive';
  end if;

  if current_owner.status <> 'active' then
    raise exception using errcode = '42501', message = 'owner_blocked';
  end if;

  if not exists (
    select 1
    from public.terms_versions as legal_version
    join public.terms_acceptances as acceptance
      on acceptance.user_id = p_user_id
      and acceptance.terms_version_id = legal_version.id
      and acceptance.accepted_content_hash = legal_version.content_hash
    where legal_version.id = current_owner.accepted_owner_contract_version_id
      and legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.clock_timestamp()
      and (
        legal_version.retired_at is null
        or pg_catalog.clock_timestamp() < legal_version.retired_at
      )
  ) then
    raise exception using errcode = '42501', message = 'owner_contract_not_current';
  end if;

  if current_recipient.status = 'blocked' then
    raise exception using errcode = '42501', message = 'recipient_blocked';
  end if;

  if operation_was_found then
    if current_operation.profile_version <> current_profile.profile_version then
      raise exception using errcode = '40001', message = 'recipient_idempotency_conflict';
    end if;

    return query
    select
      current_operation.id,
      current_operation.operation_sequence,
      current_operation.action,
      current_operation.provider_reference,
      current_operation.profile_version,
      false;
    return;
  end if;

  if p_action = 'start'
    and current_recipient.status not in ('not_started', 'refused')
  then
    raise exception using errcode = '23514', message = 'recipient_start_transition_invalid';
  end if;

  if p_action = 'refresh'
    and current_recipient.status not in ('pending', 'active', 'suspended')
  then
    raise exception using errcode = '23514', message = 'recipient_refresh_transition_invalid';
  end if;

  if p_action = 'refresh' then
    select operation.provider_reference
    into prepared_reference
    from private.owner_recipient_operations as operation
    where operation.owner_user_id = p_user_id
      and operation.applied_at is not null
    order by operation.operation_sequence desc
    limit 1;

    if prepared_reference is null then
      raise exception using errcode = '23514', message = 'recipient_provider_reference_missing';
    end if;
  else
    prepared_reference := null;
  end if;

  select coalesce(pg_catalog.max(operation.operation_sequence), 0::bigint) + 1
  into next_sequence
  from private.owner_recipient_operations as operation
  where operation.owner_user_id = p_user_id;

  insert into private.owner_recipient_operations (
    owner_user_id,
    action,
    idempotency_key,
    operation_sequence,
    profile_version,
    provider_reference
  )
  values (
    p_user_id,
    p_action,
    p_idempotency_key,
    next_sequence,
    current_profile.profile_version,
    prepared_reference
  )
  returning * into current_operation;

  return query
  select
    current_operation.id,
    current_operation.operation_sequence,
    current_operation.action,
    current_operation.provider_reference,
    current_operation.profile_version,
    false;
end;
$function$;

create function private.apply_owner_recipient_operation(
  p_user_id uuid,
  p_operation_id uuid,
  p_provider text,
  p_provider_reference text,
  p_status text,
  p_requirements text[]
)
returns table (
  scope uuid,
  owner_status text,
  owner_version bigint,
  accepted_owner_contract_version_id uuid,
  owner_contract_accepted boolean,
  owner_contract_id uuid,
  owner_contract_kind text,
  owner_contract_version text,
  owner_contract_title text,
  owner_contract_body_markdown text,
  owner_contract_content_hash text,
  owner_contract_source text,
  owner_contract_effective_at timestamptz,
  recipient_status text,
  requirements text[],
  next_action text,
  profile_version bigint,
  profile_version_synced bigint,
  recipient_version bigint,
  reservations_eligible boolean,
  provider_mode text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_applied_at timestamptz := pg_catalog.clock_timestamp();
  current_operation private.owner_recipient_operations%rowtype;
  current_profile public.profiles%rowtype;
  current_owner public.owner_profiles%rowtype;
  current_recipient public.owner_payment_recipients%rowtype;
  previous_status text;
  latest_sequence bigint;
begin
  if p_user_id is null
    or p_operation_id is null
    or p_provider is distinct from 'local'
    or p_provider_reference is null
    or pg_catalog.char_length(p_provider_reference) not between 1 and 200
    or p_provider_reference ~ '[[:cntrl:]]'
    or not (
      p_provider_reference ~ '^local-recipient:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or p_provider_reference in (
        'local-test-fixture:refused',
        'local-test-fixture:suspended',
        'local-test-fixture:blocked',
        'local-test-fixture:unavailable',
        'local-test-fixture:timeout'
      )
    )
    or p_status is null
    or p_status not in ('pending', 'active', 'refused', 'suspended', 'blocked')
    or p_requirements is null
    or pg_catalog.cardinality(p_requirements) > 3
    or pg_catalog.array_position(p_requirements, null) is not null
    or not (
      p_requirements <@ array[
        'identity_review', 'additional_information', 'provider_contact'
      ]::text[]
    )
    or (
      pg_catalog.cardinality(p_requirements) >= 2
      and p_requirements[1] = p_requirements[2]
    )
    or (
      pg_catalog.cardinality(p_requirements) >= 3
      and (
        p_requirements[1] = p_requirements[3]
        or p_requirements[2] = p_requirements[3]
      )
    )
    or (p_status = 'active' and p_requirements <> '{}'::text[])
  then
    raise exception using errcode = '22023', message = 'invalid_recipient_result';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_profile_missing';
  end if;

  select owner.*
  into current_owner
  from public.owner_profiles as owner
  where owner.user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'owner_authority_missing';
  end if;

  select recipient.*
  into current_recipient
  from public.owner_payment_recipients as recipient
  where recipient.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'recipient_state_missing';
  end if;

  select operation.*
  into current_operation
  from private.owner_recipient_operations as operation
  where operation.id = p_operation_id
    and operation.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'recipient_operation_missing';
  end if;

  if current_operation.applied_at is not null then
    if current_operation.provider is distinct from p_provider
      or current_operation.provider_reference is distinct from p_provider_reference
      or current_operation.result_status is distinct from p_status
      or current_operation.result_requirements is distinct from p_requirements
    then
      raise exception using errcode = '40001', message = 'recipient_apply_conflict';
    end if;

    return query
    select * from private.owner_recipient_status_row(p_user_id);
    return;
  end if;

  if current_profile.status <> 'active' or current_profile.completed_at is null then
    raise exception using errcode = '42501', message = 'owner_profile_inactive';
  end if;

  if current_owner.status <> 'active' then
    raise exception using errcode = '42501', message = 'owner_blocked';
  end if;

  select pg_catalog.max(operation.operation_sequence)
  into latest_sequence
  from private.owner_recipient_operations as operation
  where operation.owner_user_id = p_user_id;

  if current_operation.operation_sequence <> latest_sequence then
    raise exception using errcode = '40001', message = 'recipient_operation_superseded';
  end if;

  if current_operation.profile_version <> current_profile.profile_version then
    raise exception using errcode = '40001', message = 'recipient_profile_version_changed';
  end if;

  if (
      current_operation.action = 'start'
      and p_provider_reference <> ('local-recipient:' || current_operation.id::text)
    )
    or (
      current_operation.action = 'refresh'
      and p_provider_reference is distinct from current_operation.provider_reference
    )
  then
    raise exception using errcode = '23514', message = 'recipient_provider_reference_changed';
  end if;

  if current_operation.action = 'start'
    and p_status <> 'pending'
  then
    raise exception using errcode = '23514', message = 'recipient_start_result_invalid';
  end if;

  previous_status := current_recipient.status;

  update public.owner_payment_recipients as recipient
  set
    status = p_status,
    requirements = p_requirements,
    profile_version_synced = current_operation.profile_version
  where recipient.owner_user_id = p_user_id
  returning * into current_recipient;

  update private.owner_recipient_operations as operation
  set
    provider = p_provider,
    provider_reference = p_provider_reference,
    result_status = p_status,
    result_requirements = p_requirements,
    applied_at = v_applied_at
  where operation.id = p_operation_id
    and operation.owner_user_id = p_user_id
    and operation.applied_at is null;

  if not found then
    raise exception using errcode = '40001', message = 'recipient_apply_conflict';
  end if;

  insert into audit.events (
    actor_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    request_id,
    ip_hash,
    metadata
  )
  values (
    p_user_id,
    'authenticated',
    'recipient.status_transitioned',
    'owner_payment_recipient',
    p_user_id,
    'succeeded',
    current_operation.idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'fromStatus', previous_status,
      'toStatus', p_status,
      'recipientVersion', current_recipient.recipient_version,
      'operationSequence', current_operation.operation_sequence
    )
  );

  return query
  select * from private.owner_recipient_status_row(p_user_id);
end;
$function$;

revoke all on function private.enforce_owner_profile_state()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.enforce_owner_recipient_state()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.protect_audit_event()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.owner_recipient_status_row(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function public.get_current_owner_contract()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function public.get_owner_recipient_status()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.get_owner_recipient_status_for_user(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.activate_owner(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.prepare_owner_recipient_operation(uuid, text, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.apply_owner_recipient_operation(uuid, uuid, text, text, text, text[])
  from public, anon, authenticated, service_role, app_dal;

grant execute on function public.get_current_owner_contract()
  to authenticated;
grant execute on function public.get_owner_recipient_status()
  to authenticated;
grant execute on function private.get_owner_recipient_status_for_user(uuid)
  to app_dal;
grant execute on function private.activate_owner(uuid, uuid, uuid, text)
  to app_dal;
grant execute on function private.prepare_owner_recipient_operation(uuid, text, uuid)
  to app_dal;
grant execute on function private.apply_owner_recipient_operation(uuid, uuid, text, text, text, text[])
  to app_dal;

-- O readiness anterior já contém todos os guardrails de catálogo, role,
-- ownership, TEMPORARY, parâmetros e ACLs públicas. A cadeia append-only fixa
-- sua forma de entrada; esta transformação guardada amplia somente a allowlist
-- exata da app_dal com os quatro entrypoints da FEAT-004.
do $readiness$
declare
  definition text;
  previous_definition text;
  dependency_tail text := $dependency_tail$          and dependency.objid = pg_catalog.to_regprocedure(
            'private.update_profile_appearance(uuid,bigint,text)'
          )
          and dependency.objsubid = 0
        )
      ) as restricted$dependency_tail$;
  dependency_replacement text := $dependency_replacement$          and dependency.objid = pg_catalog.to_regprocedure(
            'private.update_profile_appearance(uuid,bigint,text)'
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
          and dependency.objid in (
            pg_catalog.to_regprocedure(
              'private.get_owner_recipient_status_for_user(uuid)'
            ),
            pg_catalog.to_regprocedure(
              'private.activate_owner(uuid,uuid,uuid,text)'
            ),
            pg_catalog.to_regprocedure(
              'private.prepare_owner_recipient_operation(uuid,text,uuid)'
            ),
            pg_catalog.to_regprocedure(
              'private.apply_owner_recipient_operation(uuid,uuid,text,text,text,text[])'
            )
          )
          and dependency.objsubid = 0
        )
      ) as restricted$dependency_replacement$;
  routine_tail text := $routine_tail$        pg_catalog.to_regprocedure(
          'private.update_profile_appearance(uuid,bigint,text)'
        )
      )
      and (privilege.grantee = runtime_role.oid or privilege.grantor = runtime_role.oid)$routine_tail$;
  routine_replacement text := $routine_replacement$        pg_catalog.to_regprocedure(
          'private.update_profile_appearance(uuid,bigint,text)'
        ),
        pg_catalog.to_regprocedure(
          'private.get_owner_recipient_status_for_user(uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.activate_owner(uuid,uuid,uuid,text)'
        ),
        pg_catalog.to_regprocedure(
          'private.prepare_owner_recipient_operation(uuid,text,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.apply_owner_recipient_operation(uuid,uuid,text,text,text,text[])'
        )
      )
      and (privilege.grantee = runtime_role.oid or privilege.grantor = runtime_role.oid)$routine_replacement$;
begin
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('private.check_readiness(text)')
  )
  into definition;

  if definition is null
    or pg_catalog.strpos(definition, 'pg_catalog.count(*) = 13') = 0
    or pg_catalog.strpos(definition, 'pg_catalog.count(*) = 12') = 0
    or pg_catalog.strpos(definition, dependency_tail) = 0
    or pg_catalog.strpos(definition, routine_tail) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_readiness_predecessor';
  end if;

  previous_definition := definition;
  definition := pg_catalog.replace(
    definition,
    'pg_catalog.count(*) = 13',
    'pg_catalog.count(*) = 17'
  );
  definition := pg_catalog.replace(
    definition,
    'pg_catalog.count(*) = 12',
    'pg_catalog.count(*) = 16'
  );
  definition := pg_catalog.replace(
    definition,
    dependency_tail,
    dependency_replacement
  );
  definition := pg_catalog.replace(
    definition,
    routine_tail,
    routine_replacement
  );

  if definition = previous_definition
    or pg_catalog.strpos(definition, 'pg_catalog.count(*) = 17') = 0
    or pg_catalog.strpos(definition, 'pg_catalog.count(*) = 16') = 0
    or pg_catalog.strpos(
      definition,
      'private.apply_owner_recipient_operation(uuid,uuid,text,text,text,text[])'
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'readiness_allowlist_update_failed';
  end if;

  execute definition;
end;
$readiness$;

revoke all on function private.check_readiness(text)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function private.check_readiness(text)
  to app_dal;
