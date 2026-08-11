-- FEAT-002 review hardening: fecha o segundo estado privado por RLS e impede
-- que uma rejeição tardia reabra um grant de recuperação já expirado.

alter table private.signup_legal_intents enable row level security;

create or replace function private.release_identity_recovery_grant(
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
    and recovery_grant.expires_at > pg_catalog.statement_timestamp()
  returning true into grant_released;

  return coalesce(grant_released, false);
end;
$function$;

comment on function private.release_identity_recovery_grant(uuid, uuid, uuid)
  is 'Libera somente grant vigente reservado pela tentativa informada após rejeição segura do provedor.';
