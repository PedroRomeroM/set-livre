-- FEAT-003: perfil pessoal completo e preferências visuais mínimas.
-- Dados documentais crus permanecem restritos às funções privadas da DAL;
-- todas as respostas autoritativas expõem somente projeções mascaradas.

create function private.is_valid_cpf(candidate text)
returns boolean
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $function$
declare
  position_index integer;
  digit integer;
  digit_sum integer := 0;
  first_check_digit integer;
  second_check_digit integer;
begin
  if candidate !~ '^[0-9]{11}$'
    or candidate ~ '^([0-9])\1{10}$'
  then
    return false;
  end if;

  for position_index in 1..9 loop
    digit := pg_catalog.ascii(pg_catalog.substr(candidate, position_index, 1)) - 48;
    digit_sum := digit_sum + digit * (11 - position_index);
  end loop;

  first_check_digit := digit_sum % 11;
  first_check_digit := case
    when first_check_digit < 2 then 0
    else 11 - first_check_digit
  end;

  if first_check_digit <>
    pg_catalog.ascii(pg_catalog.substr(candidate, 10, 1)) - 48
  then
    return false;
  end if;

  digit_sum := 0;
  for position_index in 1..10 loop
    digit := pg_catalog.ascii(pg_catalog.substr(candidate, position_index, 1)) - 48;
    digit_sum := digit_sum + digit * (12 - position_index);
  end loop;

  second_check_digit := digit_sum % 11;
  second_check_digit := case
    when second_check_digit < 2 then 0
    else 11 - second_check_digit
  end;

  return second_check_digit =
    pg_catalog.ascii(pg_catalog.substr(candidate, 11, 1)) - 48;
end;
$function$;

comment on function private.is_valid_cpf(text)
  is 'Valida o formato canônico de onze dígitos e os dois DVs módulo 11 do CPF; não comprova existência ou titularidade.';

create function private.is_valid_cnpj(candidate text)
returns boolean
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $function$
declare
  first_weights constant integer[] := array[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  second_weights constant integer[] := array[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  position_index integer;
  character_value integer;
  digit_sum integer := 0;
  remainder integer;
  first_check_digit integer;
  second_check_digit integer;
begin
  if candidate !~ '^[0-9A-Z]{12}[0-9]{2}$'
    or candidate ~ '^([0-9A-Z])\1{11}'
  then
    return false;
  end if;

  for position_index in 1..12 loop
    character_value :=
      pg_catalog.ascii(pg_catalog.substr(candidate, position_index, 1)) - 48;
    digit_sum := digit_sum + character_value * first_weights[position_index];
  end loop;

  remainder := digit_sum % 11;
  first_check_digit := case when remainder < 2 then 0 else 11 - remainder end;

  if first_check_digit <>
    pg_catalog.ascii(pg_catalog.substr(candidate, 13, 1)) - 48
  then
    return false;
  end if;

  digit_sum := 0;
  for position_index in 1..13 loop
    character_value :=
      pg_catalog.ascii(pg_catalog.substr(candidate, position_index, 1)) - 48;
    digit_sum := digit_sum + character_value * second_weights[position_index];
  end loop;

  remainder := digit_sum % 11;
  second_check_digit := case when remainder < 2 then 0 else 11 - remainder end;

  return second_check_digit =
    pg_catalog.ascii(pg_catalog.substr(candidate, 14, 1)) - 48;
end;
$function$;

comment on function private.is_valid_cnpj(text)
  is 'Valida CNPJ canônico numérico ou alfanumérico uppercase pelo valor ASCII menos 48 e DVs módulo 11; não comprova existência ou titularidade.';

alter table public.profiles
  add column name text,
  add column phone_e164 text,
  add column tax_id text,
  add column additional_document text,
  add column tax_id_masked text generated always as (
    case
      when tax_id is null then null
      when person_type = 'individual' then
        '***.***.***-' || pg_catalog.right(tax_id, 2)
      else
        '**.***.***/****-' || pg_catalog.right(tax_id, 2)
    end
  ) stored,
  add column additional_document_masked text generated always as (
    case
      when additional_document is null then null
      else
        pg_catalog.repeat(
          '*',
          pg_catalog.char_length(additional_document) - 2
        ) || pg_catalog.right(additional_document, 2)
    end
  ) stored,
  add column profile_version bigint not null default 0,
  add constraint profiles_name_shape_check check (
    name is null
    or (
      pg_catalog.char_length(name) between 2 and 160
      and name = pg_catalog.btrim(name)
      and name !~ '[[:cntrl:]]'
    )
  ),
  add constraint profiles_phone_e164_shape_check check (
    phone_e164 is null
    or phone_e164 ~ '^\+55[1-9][0-9]([2-5][0-9]{7}|9[0-9]{8})$'
  ),
  add constraint profiles_tax_id_person_type_check check (
    tax_id is null
    or (
      person_type = 'individual'
      and private.is_valid_cpf(tax_id)
    )
    or (
      person_type = 'company'
      and private.is_valid_cnpj(tax_id)
    )
  ),
  add constraint profiles_additional_document_shape_check check (
    additional_document is null
    or (
      pg_catalog.char_length(additional_document) between 3 and 40
      and additional_document ~ '^[A-Z0-9]+([./ -][A-Z0-9]+)*$'
    )
  ),
  add constraint profiles_completion_data_check check (
    (
      completed_at is null
      and name is null
      and phone_e164 is null
      and tax_id is null
      and additional_document is null
    )
    or (
      completed_at is not null
      and name is not null
      and phone_e164 is not null
      and tax_id is not null
    )
  ),
  add constraint profiles_profile_version_check check (profile_version >= 0);

comment on column public.profiles.name
  is 'Nome da pessoa ou razão social atual; obrigatório somente após a conclusão do perfil.';
comment on column public.profiles.phone_e164
  is 'Telefone brasileiro canônico em E.164; validação estrutural não confirma titularidade.';
comment on column public.profiles.tax_id
  is 'CPF ou CNPJ canônico atual; PII sem grant de leitura direta para roles runtime.';
comment on column public.profiles.additional_document
  is 'Identificador textual opcional uppercase; tipo, emissor e titularidade não são inferidos.';
comment on column public.profiles.tax_id_masked
  is 'Projeção derivada que revela somente os dois dígitos verificadores.';
comment on column public.profiles.additional_document_masked
  is 'Projeção derivada que revela somente os dois últimos caracteres.';
comment on column public.profiles.profile_version
  is 'Versão otimista monotônica da identidade, independente da aparência.';

create function private.enforce_profile_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if old.completed_at is not null
    and new.completed_at is distinct from old.completed_at
  then
    raise exception using
      errcode = 'P0001',
      message = 'profile_completion_is_immutable';
  end if;

  if new.person_type is distinct from old.person_type
    and not (old.completed_at is null and new.completed_at is not null)
  then
    raise exception using
      errcode = 'P0001',
      message = 'profile_person_type_change_requires_completion';
  end if;

  return new;
end;
$function$;

create trigger profiles_enforce_lifecycle
before update on public.profiles
for each row execute function private.enforce_profile_lifecycle();

create or replace function private.set_profile_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.profile_version := old.profile_version + 1;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create table public.user_preferences (
  user_id uuid primary key
    references public.profiles(id) on delete cascade,
  color_scheme text not null default 'system'
    check (color_scheme in ('system', 'light', 'dark')),
  preferences_version bigint not null default 0
    check (preferences_version >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  check (updated_at >= created_at)
);

comment on table public.user_preferences
  is 'Preferência visual mínima 1:1 do perfil, versionada sem criar conflito com a identidade.';
comment on column public.user_preferences.color_scheme
  is 'Allowlist de aparência: system, light ou dark.';
comment on column public.user_preferences.preferences_version
  is 'Versão otimista monotônica da aparência, independente da identidade.';

revoke all on table public.user_preferences
  from public, anon, authenticated, service_role, app_dal;

alter table public.user_preferences enable row level security;

create policy user_preferences_select_own
on public.user_preferences
for select
to authenticated
using ((select auth.uid()) = user_id);

insert into public.user_preferences (user_id)
select profile.id
from public.profiles as profile
on conflict (user_id) do nothing;

create function private.bootstrap_user_preferences()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.user_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$function$;

create trigger profiles_bootstrap_user_preferences
after insert on public.profiles
for each row execute function private.bootstrap_user_preferences();

create function private.set_user_preferences_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.user_id is distinct from old.user_id then
    raise exception using
      errcode = 'P0001',
      message = 'user_preferences_owner_is_immutable';
  end if;

  new.preferences_version := old.preferences_version + 1;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create trigger user_preferences_set_updated_at
before update on public.user_preferences
for each row execute function private.set_user_preferences_updated_at();

create function public.get_my_profile()
returns table (
  user_id uuid,
  person_type text,
  status text,
  name text,
  phone_e164 text,
  tax_id_masked text,
  additional_document_masked text,
  profile_completed boolean,
  profile_version bigint,
  color_scheme text,
  preferences_version bigint
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
    profile.name,
    profile.phone_e164,
    profile.tax_id_masked,
    profile.additional_document_masked,
    profile.completed_at is not null,
    profile.profile_version,
    preference.color_scheme,
    preference.preferences_version
  from public.profiles as profile
  join public.user_preferences as preference
    on preference.user_id = profile.id
  where profile.id = (select auth.uid());
$function$;

create function private.profile_command_result(p_user_id uuid)
returns table (
  user_id uuid,
  person_type text,
  status text,
  name text,
  phone_e164 text,
  tax_id_masked text,
  additional_document_masked text,
  profile_completed boolean,
  profile_version bigint,
  color_scheme text,
  preferences_version bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    profile.id,
    profile.person_type,
    profile.status,
    profile.name,
    profile.phone_e164,
    profile.tax_id_masked,
    profile.additional_document_masked,
    profile.completed_at is not null,
    profile.profile_version,
    preference.color_scheme,
    preference.preferences_version
  from public.profiles as profile
  join public.user_preferences as preference
    on preference.user_id = profile.id
  where profile.id = p_user_id
    and p_user_id is not null;
$function$;

create function private.complete_profile(
  p_user_id uuid,
  p_expected_profile_version bigint,
  p_person_type text,
  p_name text,
  p_phone_e164 text,
  p_tax_id text,
  p_additional_document text
)
returns table (
  user_id uuid,
  person_type text,
  status text,
  name text,
  phone_e164 text,
  tax_id_masked text,
  additional_document_masked text,
  profile_completed boolean,
  profile_version bigint,
  color_scheme text,
  preferences_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_profile public.profiles%rowtype;
begin
  if p_user_id is null
    or p_expected_profile_version is null
    or p_expected_profile_version < 0
    or p_person_type is null
    or p_person_type not in ('individual', 'company')
    or p_name is null
    or pg_catalog.char_length(p_name) not between 2 and 160
    or p_name <> pg_catalog.btrim(p_name)
    or p_name ~ '[[:cntrl:]]'
    or p_phone_e164 is null
    or p_phone_e164 !~ '^\+55[1-9][0-9]([2-5][0-9]{7}|9[0-9]{8})$'
    or p_tax_id is null
    or (
      p_person_type = 'individual'
      and not private.is_valid_cpf(p_tax_id)
    )
    or (
      p_person_type = 'company'
      and not private.is_valid_cnpj(p_tax_id)
    )
    or (
      p_additional_document is not null
      and (
        pg_catalog.char_length(p_additional_document) not between 3 and 40
        or p_additional_document !~ '^[A-Z0-9]+([./ -][A-Z0-9]+)*$'
      )
    )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_profile_input';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'profile_not_found';
  end if;

  if current_profile.status <> 'active' then
    raise exception using errcode = '42501', message = 'profile_inactive';
  end if;

  if current_profile.completed_at is not null then
    if current_profile.person_type = p_person_type
      and current_profile.name = p_name
      and current_profile.phone_e164 = p_phone_e164
      and current_profile.tax_id = p_tax_id
      and current_profile.additional_document is not distinct from p_additional_document
    then
      return query select * from private.profile_command_result(p_user_id);
      return;
    end if;

    raise exception using errcode = '40001', message = 'profile_already_completed';
  end if;

  if current_profile.profile_version <> p_expected_profile_version then
    raise exception using errcode = '40001', message = 'profile_version_conflict';
  end if;

  if (
    select pg_catalog.count(distinct legal_version.kind)
    from public.terms_acceptances as acceptance
    join public.terms_versions as legal_version
      on legal_version.id = acceptance.terms_version_id
    where acceptance.user_id = p_user_id
      and legal_version.kind in ('terms', 'privacy')
  ) <> 2 then
    raise exception using
      errcode = 'P0001',
      message = 'profile_legal_acceptances_missing';
  end if;

  update public.profiles as profile
  set
    person_type = p_person_type,
    name = p_name,
    phone_e164 = p_phone_e164,
    tax_id = p_tax_id,
    additional_document = p_additional_document,
    completed_at = pg_catalog.clock_timestamp()
  where profile.id = p_user_id;

  return query select * from private.profile_command_result(p_user_id);
end;
$function$;

create function private.update_profile_identity(
  p_user_id uuid,
  p_expected_profile_version bigint,
  p_name text,
  p_phone_e164 text,
  p_replace_tax_id boolean,
  p_tax_id text,
  p_replace_additional_document boolean,
  p_additional_document text
)
returns table (
  user_id uuid,
  person_type text,
  status text,
  name text,
  phone_e164 text,
  tax_id_masked text,
  additional_document_masked text,
  profile_completed boolean,
  profile_version bigint,
  color_scheme text,
  preferences_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_profile public.profiles%rowtype;
  target_tax_id text;
  target_additional_document text;
begin
  if p_user_id is null
    or p_expected_profile_version is null
    or p_expected_profile_version < 0
    or p_name is null
    or pg_catalog.char_length(p_name) not between 2 and 160
    or p_name <> pg_catalog.btrim(p_name)
    or p_name ~ '[[:cntrl:]]'
    or p_phone_e164 is null
    or p_phone_e164 !~ '^\+55[1-9][0-9]([2-5][0-9]{7}|9[0-9]{8})$'
    or p_replace_tax_id is null
    or p_replace_additional_document is null
    or (not p_replace_tax_id and p_tax_id is not null)
    or (p_replace_tax_id and p_tax_id is null)
    or (not p_replace_additional_document and p_additional_document is not null)
    or (
      p_replace_additional_document
      and p_additional_document is not null
      and (
        pg_catalog.char_length(p_additional_document) not between 3 and 40
        or p_additional_document !~ '^[A-Z0-9]+([./ -][A-Z0-9]+)*$'
      )
    )
  then
    raise exception using errcode = '22023', message = 'invalid_profile_input';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'profile_not_found';
  end if;

  if current_profile.status <> 'active' then
    raise exception using errcode = '42501', message = 'profile_inactive';
  end if;

  if current_profile.completed_at is null then
    raise exception using errcode = 'P0001', message = 'profile_incomplete';
  end if;

  target_tax_id := case
    when p_replace_tax_id then p_tax_id
    else current_profile.tax_id
  end;
  target_additional_document := case
    when p_replace_additional_document then p_additional_document
    else current_profile.additional_document
  end;

  if (
    current_profile.person_type = 'individual'
    and not private.is_valid_cpf(target_tax_id)
  ) or (
    current_profile.person_type = 'company'
    and not private.is_valid_cnpj(target_tax_id)
  ) then
    raise exception using errcode = '22023', message = 'invalid_profile_input';
  end if;

  if current_profile.name = p_name
    and current_profile.phone_e164 = p_phone_e164
    and current_profile.tax_id = target_tax_id
    and current_profile.additional_document is not distinct from target_additional_document
  then
    return query select * from private.profile_command_result(p_user_id);
    return;
  end if;

  if current_profile.profile_version <> p_expected_profile_version then
    raise exception using errcode = '40001', message = 'profile_version_conflict';
  end if;

  update public.profiles as profile
  set
    name = p_name,
    phone_e164 = p_phone_e164,
    tax_id = target_tax_id,
    additional_document = target_additional_document
  where profile.id = p_user_id;

  return query select * from private.profile_command_result(p_user_id);
end;
$function$;

create function private.update_profile_appearance(
  p_user_id uuid,
  p_expected_preferences_version bigint,
  p_color_scheme text
)
returns table (
  user_id uuid,
  person_type text,
  status text,
  name text,
  phone_e164 text,
  tax_id_masked text,
  additional_document_masked text,
  profile_completed boolean,
  profile_version bigint,
  color_scheme text,
  preferences_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_profile public.profiles%rowtype;
  current_preference public.user_preferences%rowtype;
begin
  if p_user_id is null
    or p_expected_preferences_version is null
    or p_expected_preferences_version < 0
    or p_color_scheme is null
    or p_color_scheme not in ('system', 'light', 'dark')
  then
    raise exception using errcode = '22023', message = 'invalid_profile_input';
  end if;

  select profile.*
  into current_profile
  from public.profiles as profile
  where profile.id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'profile_not_found';
  end if;

  if current_profile.status <> 'active' then
    raise exception using errcode = '42501', message = 'profile_inactive';
  end if;

  select preference.*
  into current_preference
  from public.user_preferences as preference
  where preference.user_id = p_user_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'profile_preferences_missing';
  end if;

  if current_preference.color_scheme = p_color_scheme then
    return query select * from private.profile_command_result(p_user_id);
    return;
  end if;

  if current_preference.preferences_version <>
    p_expected_preferences_version
  then
    raise exception using
      errcode = '40001',
      message = 'preferences_version_conflict';
  end if;

  update public.user_preferences as preference
  set color_scheme = p_color_scheme
  where preference.user_id = p_user_id;

  return query select * from private.profile_command_result(p_user_id);
end;
$function$;

revoke all on function private.is_valid_cpf(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.is_valid_cnpj(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.enforce_profile_lifecycle()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.set_profile_updated_at()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.bootstrap_user_preferences()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.set_user_preferences_updated_at()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function public.get_my_profile()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.profile_command_result(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.complete_profile(uuid, bigint, text, text, text, text, text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.update_profile_identity(uuid, bigint, text, text, boolean, text, boolean, text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.update_profile_appearance(uuid, bigint, text)
  from public, anon, authenticated, service_role, app_dal;

grant select (
  id,
  person_type,
  status,
  name,
  phone_e164,
  tax_id_masked,
  additional_document_masked,
  completed_at,
  profile_version
)
on table public.profiles
to authenticated;

grant select (
  user_id,
  color_scheme,
  preferences_version
)
on table public.user_preferences
to authenticated;

grant execute on function public.get_my_profile()
  to authenticated;
grant execute on function private.complete_profile(uuid, bigint, text, text, text, text, text)
  to app_dal;
grant execute on function private.update_profile_identity(uuid, bigint, text, text, boolean, text, boolean, text)
  to app_dal;
grant execute on function private.update_profile_appearance(uuid, bigint, text)
  to app_dal;

comment on function public.get_my_profile()
  is 'Read model próprio security invoker filtrado por auth.uid(), com projeção segura e mascarada.';
comment on function private.profile_command_result(uuid)
  is 'Helper interno sem grant runtime que projeta o retorno autoritativo dos comandos de perfil.';
comment on function private.complete_profile(uuid, bigint, text, text, text, text, text)
  is 'Completa uma única vez o perfil ativo, valida aceites preexistentes e permite a correção final de PF/PJ.';
comment on function private.update_profile_identity(uuid, bigint, text, text, boolean, text, boolean, text)
  is 'Atualiza identidade concluída com versão otimista e substituição documental explícita sem reexpor PII.';
comment on function private.update_profile_appearance(uuid, bigint, text)
  is 'Atualiza a allowlist visual com versão independente da identidade.';

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
      pg_catalog.count(*) = 13
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
        or (
          dependency.dbid = (
            select database.oid
            from pg_catalog.pg_database as database
            where database.datname = pg_catalog.current_database()
          )
          and dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          and dependency.objid = pg_catalog.to_regprocedure(
            'private.complete_profile(uuid,bigint,text,text,text,text,text)'
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
            'private.update_profile_identity(uuid,bigint,text,text,boolean,text,boolean,text)'
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
            'private.update_profile_appearance(uuid,bigint,text)'
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
      pg_catalog.count(*) = 12
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
        ),
        pg_catalog.to_regprocedure(
          'private.complete_profile(uuid,bigint,text,text,text,text,text)'
        ),
        pg_catalog.to_regprocedure(
          'private.update_profile_identity(uuid,bigint,text,text,boolean,text,boolean,text)'
        ),
        pg_catalog.to_regprocedure(
          'private.update_profile_appearance(uuid,bigint,text)'
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

revoke all on function private.check_readiness(text)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function private.check_readiness(text)
  to app_dal;
