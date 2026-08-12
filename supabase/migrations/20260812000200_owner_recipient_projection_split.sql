-- FEAT-004 review hardening: split the legal document from recipient reads.
-- The activation view deliberately keeps the complete owner contract. Recipient
-- SSR, refetches and command responses consume only the compact status tuple.

alter function public.get_owner_recipient_status()
  rename to get_owner_activation_status;

comment on function public.get_owner_activation_status()
  is 'Activation-only authenticated projection with the complete current owner contract.';

create function public.get_owner_recipient_status()
returns table (
  scope uuid,
  owner_status text,
  owner_version bigint,
  accepted_owner_contract_version_id uuid,
  owner_contract_accepted boolean,
  owner_contract_id uuid,
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

revoke all on function public.get_owner_activation_status()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function public.get_owner_recipient_status()
  from public, anon, authenticated, service_role, app_dal;

grant execute on function public.get_owner_activation_status()
  to authenticated;
grant execute on function public.get_owner_recipient_status()
  to authenticated;

comment on function public.get_owner_recipient_status()
  is 'Compact authenticated recipient projection; never returns owner contract title, version, hash or Markdown body.';
