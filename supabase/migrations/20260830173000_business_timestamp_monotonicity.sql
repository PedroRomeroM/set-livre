create or replace function private.normalize_updated_at_monotonic()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := greatest(
    old.updated_at,
    new.created_at,
    pg_catalog.clock_timestamp()
  );
  return new;
end;
$function$;

alter function private.normalize_updated_at_monotonic() owner to postgres;

comment on function private.normalize_updated_at_monotonic() is
  'Mantém updated_at monotônico quando o relógio de parede do host recua.';

revoke all on function private.normalize_updated_at_monotonic()
  from public, anon, authenticated, service_role, app_dal;

-- Triggers BEFORE da mesma classe executam em ordem alfabética no PostgreSQL. O prefixo zzzz
-- garante que a normalização rode depois dos triggers de versão, estado e imutabilidade existentes.
create trigger zzzz_normalize_updated_at
  before update on public.profiles
  for each row execute function private.normalize_updated_at_monotonic();

create trigger zzzz_normalize_updated_at
  before update on public.user_preferences
  for each row execute function private.normalize_updated_at_monotonic();

create trigger zzzz_normalize_updated_at
  before update on public.owner_profiles
  for each row execute function private.normalize_updated_at_monotonic();

create trigger zzzz_normalize_updated_at
  before update on public.owner_payment_recipients
  for each row execute function private.normalize_updated_at_monotonic();

create trigger zzzz_normalize_updated_at
  before update on public.studio_types
  for each row execute function private.normalize_updated_at_monotonic();

create trigger zzzz_normalize_updated_at
  before update on public.studios
  for each row execute function private.normalize_updated_at_monotonic();

create trigger zzzz_normalize_updated_at
  before update on public.studio_revisions
  for each row execute function private.normalize_updated_at_monotonic();

create trigger zzzz_normalize_updated_at
  before update on public.tags
  for each row execute function private.normalize_updated_at_monotonic();

create trigger zzzz_normalize_updated_at
  before update on public.amenities
  for each row execute function private.normalize_updated_at_monotonic();

create trigger zzzz_normalize_updated_at
  before update on public.studio_faqs
  for each row execute function private.normalize_updated_at_monotonic();
