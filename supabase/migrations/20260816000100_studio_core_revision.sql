-- FEAT-006: núcleo canônico do estúdio e revisão editável.
-- O catálogo nasce vazio em produção; as quatro opções de desenvolvimento
-- pertencem exclusivamente ao seed local.

create table public.studio_types (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint studio_types_name_shape_check check (
    pg_catalog.char_length(name) between 2 and 80
    and name = pg_catalog.btrim(name)
    and name !~ '[[:cntrl:]]'
  ),
  constraint studio_types_slug_key unique (slug),
  constraint studio_types_slug_shape_check check (
    pg_catalog.char_length(slug) between 2 and 80
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint studio_types_description_shape_check check (
    description is null
    or (
      pg_catalog.char_length(description) between 1 and 240
      and description = pg_catalog.btrim(description)
      and description !~ '[[:cntrl:]]'
    )
  ),
  constraint studio_types_sort_order_check check (sort_order >= 0),
  constraint studio_types_updated_after_created_check check (
    updated_at >= created_at
  )
);

comment on table public.studio_types
  is 'Taxonomia administrativa mínima dos tipos de estúdio; produção começa sem linhas e não recebe fixtures locais.';

create table public.studios (
  id uuid primary key,
  owner_user_id uuid not null
    references public.owner_profiles(user_id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  published_revision_id uuid,
  draft_revision_id uuid,
  edit_version bigint not null default 1 check (
    edit_version between 1 and 9007199254740991
  ),
  last_revision_number bigint not null default 1
    check (last_revision_number between 1 and 9007199254740991),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint studios_revision_pointers_distinct_check check (
    published_revision_id is null
    or draft_revision_id is null
    or published_revision_id <> draft_revision_id
  ),
  constraint studios_status_revision_shape_check check (
    (
      status = 'draft'
      and published_revision_id is null
      and draft_revision_id is not null
    )
    or (
      status = 'published'
      and published_revision_id is not null
    )
  ),
  constraint studios_updated_after_created_check check (
    updated_at >= created_at
  )
);

comment on table public.studios
  is 'Agregado raiz do estúdio; edit_version é monotônica no agregado e evita ABA entre clone, edição e descarte.';
comment on column public.studios.id
  is 'UUID pré-gerado pelo navegador/app para recuperação ambígua; nunca comprova ownership.';
comment on column public.studios.edit_version
  is 'Token otimista monotônico do agregado, independente do número da revisão.';
comment on column public.studios.last_revision_number
  is 'Maior revision_number já alocado; descartes nunca reduzem este contador anti-reuso.';

create index studios_owner_user_id_idx
on public.studios (owner_user_id);

create table public.studio_revisions (
  id uuid primary key default extensions.gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  revision_number bigint not null check (
    revision_number between 1 and 9007199254740991
  ),
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'approved')),
  name text not null,
  description text not null,
  street text not null,
  street_number text not null,
  address_complement text,
  neighborhood text not null,
  city text not null default 'Curitiba',
  state text not null default 'PR',
  postal_code text not null,
  capacity integer not null,
  studio_type_id uuid not null
    references public.studio_types(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint studio_revisions_studio_number_key
    unique (studio_id, revision_number),
  constraint studio_revisions_studio_id_id_key
    unique (studio_id, id),
  constraint studio_revisions_name_shape_check check (
    pg_catalog.char_length(name) between 2 and 120
    and name = pg_catalog.btrim(name)
    and name !~ '[[:cntrl:]]'
  ),
  constraint studio_revisions_description_shape_check check (
    pg_catalog.char_length(description) between 20 and 5000
    and description = pg_catalog.btrim(description)
    and pg_catalog.replace(description, E'\n', '') !~ '[[:cntrl:]]'
  ),
  constraint studio_revisions_street_shape_check check (
    pg_catalog.char_length(street) between 2 and 160
    and street = pg_catalog.btrim(street)
    and street !~ '[[:cntrl:]]'
  ),
  constraint studio_revisions_street_number_shape_check check (
    pg_catalog.char_length(street_number) between 1 and 20
    and street_number = pg_catalog.btrim(street_number)
    and street_number !~ '[[:cntrl:]]'
  ),
  constraint studio_revisions_address_complement_shape_check check (
    address_complement is null
    or (
      pg_catalog.char_length(address_complement) between 1 and 120
      and address_complement = pg_catalog.btrim(address_complement)
      and address_complement !~ '[[:cntrl:]]'
    )
  ),
  constraint studio_revisions_neighborhood_shape_check check (
    pg_catalog.char_length(neighborhood) between 2 and 120
    and neighborhood = pg_catalog.btrim(neighborhood)
    and neighborhood !~ '[[:cntrl:]]'
  ),
  constraint studio_revisions_city_check check (city = 'Curitiba'),
  constraint studio_revisions_state_check check (state = 'PR'),
  constraint studio_revisions_postal_code_check check (
    postal_code ~ '^[0-9]{8}$'
  ),
  constraint studio_revisions_capacity_check check (
    capacity between 1 and 500
  ),
  constraint studio_revisions_updated_after_created_check check (
    updated_at >= created_at
  )
);

comment on table public.studio_revisions
  is 'Snapshot canônico do núcleo do estúdio; revisões não draft são imutáveis.';
comment on column public.studio_revisions.city
  is 'Cidade fixa da baseline, derivada pelo servidor e nunca aceita do payload.';
comment on column public.studio_revisions.state
  is 'UF fixa da baseline, derivada pelo servidor e nunca aceita do payload.';

create unique index studio_revisions_one_draft_per_studio_idx
on public.studio_revisions (studio_id)
where status = 'draft';

create index studio_revisions_studio_type_id_idx
on public.studio_revisions (studio_type_id);

-- As referências compostas e diferidas resolvem o ciclo com segurança: o
-- estúdio pode apontar para o UUID da primeira revisão antes de a revisão ser
-- inserida, mas o commit somente ocorre quando o ponteiro pertence ao mesmo
-- agregado.
alter table public.studios
  add constraint studios_published_revision_fk
    foreign key (id, published_revision_id)
    references public.studio_revisions(studio_id, id)
    deferrable initially deferred,
  add constraint studios_draft_revision_fk
    foreign key (id, draft_revision_id)
    references public.studio_revisions(studio_id, id)
    deferrable initially deferred;

create table private.studio_command_requests (
  owner_user_id uuid not null
    references public.owner_profiles(user_id) on delete cascade,
  idempotency_key uuid not null,
  action text not null check (
    action in (
      'studio.create',
      'studio.revision.updateCore',
      'studio.draft.discard'
    )
  ),
  studio_id uuid not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  result_kind text not null check (
    result_kind in ('editor', 'draft_discarded', 'studio_deleted')
  ),
  resulting_edit_version bigint,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (owner_user_id, idempotency_key),
  constraint studio_command_requests_result_check check (
    (
      result_kind in ('editor', 'draft_discarded')
      and resulting_edit_version is not null
      and resulting_edit_version between 1 and 9007199254740991
    )
    or (
      result_kind = 'studio_deleted'
      and resulting_edit_version is null
    )
  )
);

comment on table private.studio_command_requests
  is 'Deduplicação privada dos comandos FEAT-006; studio_id não possui FK para preservar o tombstone de um rascunho removido.';

create unique index studio_command_requests_create_studio_id_key
on private.studio_command_requests (studio_id)
where action = 'studio.create';

alter table public.studio_types enable row level security;
alter table public.studios enable row level security;
alter table public.studio_revisions enable row level security;
alter table private.studio_command_requests enable row level security;

create policy studio_types_select_authenticated
on public.studio_types
for select
to authenticated
using (
  active
  or exists (
    select 1
    from public.studio_revisions as revision
    join public.studios as studio
      on studio.id = revision.studio_id
    where revision.studio_type_id = studio_types.id
      and studio.owner_user_id = (select auth.uid())
  )
);

create policy studios_select_owner
on public.studios
for select
to authenticated
using (owner_user_id = (select auth.uid()));

create policy studio_revisions_select_owner
on public.studio_revisions
for select
to authenticated
using (
  exists (
    select 1
    from public.studios as studio
    where studio.id = studio_revisions.studio_id
      and studio.owner_user_id = (select auth.uid())
  )
);

revoke all on table public.studio_types
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.studios
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.studio_revisions
  from public, anon, authenticated, service_role, app_dal;
revoke all on table private.studio_command_requests
  from public, anon, authenticated, service_role, app_dal;

grant select (
  id, name, active, sort_order
) on public.studio_types to authenticated;
grant select (
  id, owner_user_id, status, published_revision_id, draft_revision_id,
  edit_version
) on public.studios to authenticated;
grant select (
  id, studio_id, revision_number, name, description, street,
  street_number, address_complement, neighborhood, city, state, postal_code,
  capacity, studio_type_id
) on public.studio_revisions to authenticated;

create function private.studio_core_is_valid(
  p_name text,
  p_description text,
  p_street text,
  p_street_number text,
  p_address_complement text,
  p_neighborhood text,
  p_postal_code text,
  p_capacity integer
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_name is not null
    and pg_catalog.char_length(p_name) between 2 and 120
    and p_name = pg_catalog.btrim(p_name)
    and p_name !~ '[[:cntrl:]]'
    and p_description is not null
    and pg_catalog.char_length(p_description) between 20 and 5000
    and p_description = pg_catalog.btrim(p_description)
    and pg_catalog.replace(p_description, E'\n', '') !~ '[[:cntrl:]]'
    and p_street is not null
    and pg_catalog.char_length(p_street) between 2 and 160
    and p_street = pg_catalog.btrim(p_street)
    and p_street !~ '[[:cntrl:]]'
    and p_street_number is not null
    and pg_catalog.char_length(p_street_number) between 1 and 20
    and p_street_number = pg_catalog.btrim(p_street_number)
    and p_street_number !~ '[[:cntrl:]]'
    and (
      p_address_complement is null
      or (
        pg_catalog.char_length(p_address_complement) between 1 and 120
        and p_address_complement = pg_catalog.btrim(p_address_complement)
        and p_address_complement !~ '[[:cntrl:]]'
      )
    )
    and p_neighborhood is not null
    and pg_catalog.char_length(p_neighborhood) between 2 and 120
    and p_neighborhood = pg_catalog.btrim(p_neighborhood)
    and p_neighborhood !~ '[[:cntrl:]]'
    and p_postal_code is not null
    and p_postal_code ~ '^[0-9]{8}$'
    and p_capacity between 1 and 500,
    false
  );
$function$;

create function private.studio_command_payload_hash(p_payload jsonb)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $function$
  select pg_catalog.encode(
    extensions.digest(p_payload::text, 'sha256'::text),
    'hex'::text
  );
$function$;

create function private.assert_studio_owner_authority(p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  profile_status text;
  profile_completed_at timestamptz;
  owner_status text;
begin
  if p_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'owner_authority_required';
  end if;

  select profile.status, profile.completed_at, owner.status
  into profile_status, profile_completed_at, owner_status
  from public.profiles as profile
  join public.owner_profiles as owner
    on owner.user_id = profile.id
  where profile.id = p_user_id
  for share of profile, owner;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'owner_authority_required';
  end if;

  if profile_status <> 'active' or profile_completed_at is null then
    raise exception using
      errcode = '42501',
      message = 'owner_profile_inactive';
  end if;

  if owner_status <> 'active' then
    raise exception using
      errcode = '42501',
      message = 'owner_blocked';
  end if;
end;
$function$;

create function private.enforce_studio_revision_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  max_safe_integer constant bigint := 9007199254740991;
  expected_revision_number bigint;
  current_last_revision_number bigint;
  has_revision boolean;
begin
  if tg_op = 'INSERT' then
    select studio.last_revision_number
    into current_last_revision_number
    from public.studios as studio
    where studio.id = new.studio_id
    for update;

    if not found then
      raise exception using
        errcode = '23503',
        message = 'studio_parent_missing';
    end if;

    if new.status <> 'draft' then
      raise exception using
        errcode = 'P0001',
        message = 'studio_revision_is_immutable';
    end if;

    select exists (
      select 1
      from public.studio_revisions as revision
      where revision.studio_id = new.studio_id
    ) into has_revision;

    if has_revision and current_last_revision_number >= max_safe_integer then
      raise exception using
        errcode = '22003',
        message = 'studio_revision_number_exhausted';
    end if;

    expected_revision_number := case
      when has_revision then current_last_revision_number + 1
      else 1
    end;

    if (not has_revision and current_last_revision_number <> 1)
      or new.revision_number <> expected_revision_number
    then
      raise exception using
        errcode = '23514',
        message = 'studio_revision_number_invalid';
    end if;

    if has_revision then
      update public.studios as studio
      set last_revision_number = new.revision_number
      where studio.id = new.studio_id;
    end if;

    return new;
  end if;

  if old.status <> 'draft' then
    raise exception using
      errcode = 'P0001',
      message = 'studio_revision_is_immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.id is distinct from old.id
    or new.studio_id is distinct from old.studio_id
    or new.revision_number is distinct from old.revision_number
    or new.status is distinct from old.status
    or new.created_at is distinct from old.created_at
  then
    raise exception using
      errcode = 'P0001',
      message = 'studio_revision_is_immutable';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create trigger studio_revisions_enforce_lifecycle
before insert or update or delete on public.studio_revisions
for each row execute function private.enforce_studio_revision_lifecycle();

create function private.validate_studio_revision_pointers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_studio_id uuid;
  current_published_revision_id uuid;
  current_draft_revision_id uuid;
begin
  if tg_table_name = 'studios' then
    current_studio_id := new.id;
  elsif tg_op = 'DELETE' then
    current_studio_id := old.studio_id;
  else
    current_studio_id := new.studio_id;
  end if;

  select studio.published_revision_id, studio.draft_revision_id
  into current_published_revision_id, current_draft_revision_id
  from public.studios as studio
  where studio.id = current_studio_id;

  if not found then
    return null;
  end if;

  if current_published_revision_id is not null
    and not exists (
      select 1
      from public.studio_revisions as revision
      where revision.studio_id = current_studio_id
        and revision.id = current_published_revision_id
        and revision.status = 'approved'
    )
  then
    raise exception using
      errcode = 'P0001',
      message = 'studio_revision_pointer_invalid';
  end if;

  if current_draft_revision_id is not null
    and not exists (
      select 1
      from public.studio_revisions as revision
      where revision.studio_id = current_studio_id
        and revision.id = current_draft_revision_id
        and revision.status = 'draft'
    )
  then
    raise exception using
      errcode = 'P0001',
      message = 'studio_revision_pointer_invalid';
  end if;

  return null;
end;
$function$;

create constraint trigger studios_validate_revision_pointers
after insert or update on public.studios
deferrable initially deferred
for each row execute function private.validate_studio_revision_pointers();

create constraint trigger studio_revisions_validate_revision_pointers
after insert or update or delete on public.studio_revisions
deferrable initially deferred
for each row execute function private.validate_studio_revision_pointers();

create function private.owner_studio_editor_row(
  p_user_id uuid,
  p_studio_id uuid
)
returns table (
  scope uuid,
  studio_id uuid,
  studio_status text,
  edit_version bigint,
  draft_revision_id uuid,
  draft_revision_number bigint,
  draft_name text,
  draft_description text,
  draft_street text,
  draft_street_number text,
  draft_address_complement text,
  draft_neighborhood text,
  draft_city text,
  draft_state text,
  draft_postal_code text,
  draft_capacity integer,
  draft_studio_type_id uuid,
  draft_studio_type_name text,
  published_revision_id uuid,
  published_revision_number bigint,
  published_name text,
  published_description text,
  published_street text,
  published_street_number text,
  published_address_complement text,
  published_neighborhood text,
  published_city text,
  published_state text,
  published_postal_code text,
  published_capacity integer,
  published_studio_type_id uuid,
  published_studio_type_name text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    studio.owner_user_id,
    studio.id,
    studio.status,
    studio.edit_version,
    draft_revision.id,
    draft_revision.revision_number,
    draft_revision.name,
    draft_revision.description,
    draft_revision.street,
    draft_revision.street_number,
    draft_revision.address_complement,
    draft_revision.neighborhood,
    draft_revision.city,
    draft_revision.state,
    draft_revision.postal_code,
    draft_revision.capacity,
    draft_revision.studio_type_id,
    draft_type.name,
    published_revision.id,
    published_revision.revision_number,
    published_revision.name,
    published_revision.description,
    published_revision.street,
    published_revision.street_number,
    published_revision.address_complement,
    published_revision.neighborhood,
    published_revision.city,
    published_revision.state,
    published_revision.postal_code,
    published_revision.capacity,
    published_revision.studio_type_id,
    published_type.name
  from public.studios as studio
  left join public.studio_revisions as draft_revision
    on draft_revision.id = studio.draft_revision_id
    and draft_revision.studio_id = studio.id
  left join public.studio_types as draft_type
    on draft_type.id = draft_revision.studio_type_id
  left join public.studio_revisions as published_revision
    on published_revision.id = studio.published_revision_id
    and published_revision.studio_id = studio.id
  left join public.studio_types as published_type
    on published_type.id = published_revision.studio_type_id
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id;
$function$;

create function public.list_active_studio_types()
returns table (
  id uuid,
  name text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select studio_type.id, studio_type.name
  from public.studio_types as studio_type
  where studio_type.active
  order by studio_type.sort_order, studio_type.name, studio_type.id;
$function$;

create function public.get_owner_studio_editor(p_studio_id uuid)
returns table (
  scope uuid,
  studio_id uuid,
  studio_status text,
  edit_version bigint,
  draft_revision_id uuid,
  draft_revision_number bigint,
  draft_name text,
  draft_description text,
  draft_street text,
  draft_street_number text,
  draft_address_complement text,
  draft_neighborhood text,
  draft_city text,
  draft_state text,
  draft_postal_code text,
  draft_capacity integer,
  draft_studio_type_id uuid,
  draft_studio_type_name text,
  published_revision_id uuid,
  published_revision_number bigint,
  published_name text,
  published_description text,
  published_street text,
  published_street_number text,
  published_address_complement text,
  published_neighborhood text,
  published_city text,
  published_state text,
  published_postal_code text,
  published_capacity integer,
  published_studio_type_id uuid,
  published_studio_type_name text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    studio.owner_user_id,
    studio.id,
    studio.status,
    studio.edit_version,
    draft_revision.id,
    draft_revision.revision_number,
    draft_revision.name,
    draft_revision.description,
    draft_revision.street,
    draft_revision.street_number,
    draft_revision.address_complement,
    draft_revision.neighborhood,
    draft_revision.city,
    draft_revision.state,
    draft_revision.postal_code,
    draft_revision.capacity,
    draft_revision.studio_type_id,
    draft_type.name,
    published_revision.id,
    published_revision.revision_number,
    published_revision.name,
    published_revision.description,
    published_revision.street,
    published_revision.street_number,
    published_revision.address_complement,
    published_revision.neighborhood,
    published_revision.city,
    published_revision.state,
    published_revision.postal_code,
    published_revision.capacity,
    published_revision.studio_type_id,
    published_type.name
  from public.studios as studio
  left join public.studio_revisions as draft_revision
    on draft_revision.id = studio.draft_revision_id
    and draft_revision.studio_id = studio.id
  left join public.studio_types as draft_type
    on draft_type.id = draft_revision.studio_type_id
  left join public.studio_revisions as published_revision
    on published_revision.id = studio.published_revision_id
    and published_revision.studio_id = studio.id
  left join public.studio_types as published_type
    on published_type.id = published_revision.studio_type_id
  where studio.id = p_studio_id
    and studio.owner_user_id = (select auth.uid());
$function$;

revoke all on function private.studio_core_is_valid(
  text, text, text, text, text, text, text, integer
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_command_payload_hash(jsonb)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.assert_studio_owner_authority(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.enforce_studio_revision_lifecycle()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.validate_studio_revision_pointers()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.owner_studio_editor_row(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function public.list_active_studio_types()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function public.get_owner_studio_editor(uuid)
  from public, anon, authenticated, service_role, app_dal;

grant execute on function public.list_active_studio_types()
  to authenticated;
grant execute on function public.get_owner_studio_editor(uuid)
  to authenticated;

comment on function public.list_active_studio_types()
  is 'Read model pequeno das opções ativas do seletor de tipo de estúdio.';
comment on function public.get_owner_studio_editor(uuid)
  is 'Read model RLS do editor; retorna zero linhas para estúdio ausente ou de outro dono.';

create function private.create_studio(
  p_user_id uuid,
  p_studio_id uuid,
  p_idempotency_key uuid,
  p_name text,
  p_description text,
  p_street text,
  p_street_number text,
  p_address_complement text,
  p_neighborhood text,
  p_postal_code text,
  p_capacity integer,
  p_studio_type_id uuid
)
returns table (
  scope uuid,
  studio_id uuid,
  studio_status text,
  edit_version bigint,
  draft_revision_id uuid,
  draft_revision_number bigint,
  draft_name text,
  draft_description text,
  draft_street text,
  draft_street_number text,
  draft_address_complement text,
  draft_neighborhood text,
  draft_city text,
  draft_state text,
  draft_postal_code text,
  draft_capacity integer,
  draft_studio_type_id uuid,
  draft_studio_type_name text,
  published_revision_id uuid,
  published_revision_number bigint,
  published_name text,
  published_description text,
  published_street text,
  published_street_number text,
  published_address_complement text,
  published_neighborhood text,
  published_city text,
  published_state text,
  published_postal_code text,
  published_capacity integer,
  published_studio_type_id uuid,
  published_studio_type_name text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  command_hash text;
  current_request private.studio_command_requests%rowtype;
  current_studio public.studios%rowtype;
  new_revision_id uuid := extensions.gen_random_uuid();
begin
  if p_studio_id is null
    or p_idempotency_key is null
    or p_studio_type_id is null
    or not private.studio_core_is_valid(
      p_name,
      p_description,
      p_street,
      p_street_number,
      p_address_complement,
      p_neighborhood,
      p_postal_code,
      p_capacity
    )
  then
    raise exception using
      errcode = '22023',
      message = 'studio_core_invalid';
  end if;

  perform private.assert_studio_owner_authority(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  command_hash := private.studio_command_payload_hash(
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'name', p_name,
      'description', p_description,
      'street', p_street,
      'streetNumber', p_street_number,
      'addressComplement', p_address_complement,
      'neighborhood', p_neighborhood,
      'postalCode', p_postal_code,
      'capacity', p_capacity,
      'studioTypeId', p_studio_type_id
    )
  );

  select request.*
  into current_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key
  for update;

  if found then
    if current_request.action <> 'studio.create'
      or current_request.studio_id <> p_studio_id
      or current_request.payload_hash <> command_hash
    then
      raise exception using
        errcode = '40001',
        message = 'studio_idempotency_conflict';
    end if;

    select studio.*
    into current_studio
    from public.studios as studio
    where studio.id = p_studio_id
      and studio.owner_user_id = p_user_id
    for update;

    if not found
      or current_studio.edit_version is distinct from
        current_request.resulting_edit_version
    then
      raise exception using
        errcode = '40001',
        message = 'studio_result_no_longer_available';
    end if;

    return query
    select *
    from private.owner_studio_editor_row(p_user_id, p_studio_id);
    return;
  end if;

  if not exists (
    select 1
    from public.studio_types as studio_type
    where studio_type.id = p_studio_type_id
      and studio_type.active
  ) then
    raise exception using
      errcode = '23514',
      message = 'studio_type_unavailable';
  end if;

  if exists (
    select 1
    from private.studio_command_requests as previous_request
    where previous_request.studio_id = p_studio_id
      and previous_request.action = 'studio.create'
  ) then
    raise exception using
      errcode = '40001',
      message = 'studio_identifier_unavailable';
  end if;

  begin
    insert into public.studios (
      id,
      owner_user_id,
      status,
      draft_revision_id,
      edit_version
    ) values (
      p_studio_id,
      p_user_id,
      'draft',
      new_revision_id,
      1
    );
  exception
    when unique_violation then
      raise exception using
        errcode = '40001',
        message = 'studio_identifier_unavailable';
  end;

  insert into public.studio_revisions (
    id,
    studio_id,
    revision_number,
    status,
    name,
    description,
    street,
    street_number,
    address_complement,
    neighborhood,
    city,
    state,
    postal_code,
    capacity,
    studio_type_id
  ) values (
    new_revision_id,
    p_studio_id,
    1,
    'draft',
    p_name,
    p_description,
    p_street,
    p_street_number,
    p_address_complement,
    p_neighborhood,
    'Curitiba',
    'PR',
    p_postal_code,
    p_capacity,
    p_studio_type_id
  );

  begin
    insert into private.studio_command_requests (
      owner_user_id,
      idempotency_key,
      action,
      studio_id,
      payload_hash,
      result_kind,
      resulting_edit_version
    ) values (
      p_user_id,
      p_idempotency_key,
      'studio.create',
      p_studio_id,
      command_hash,
      'editor',
      1
    );
  exception
    when unique_violation then
      raise exception using
        errcode = '40001',
        message = 'studio_identifier_unavailable';
  end;

  return query
  select *
  from private.owner_studio_editor_row(p_user_id, p_studio_id);
end;
$function$;

create function private.update_studio_revision_core(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_edit_version bigint,
  p_idempotency_key uuid,
  p_name text,
  p_description text,
  p_street text,
  p_street_number text,
  p_address_complement text,
  p_neighborhood text,
  p_postal_code text,
  p_capacity integer,
  p_studio_type_id uuid
)
returns table (
  scope uuid,
  studio_id uuid,
  studio_status text,
  edit_version bigint,
  draft_revision_id uuid,
  draft_revision_number bigint,
  draft_name text,
  draft_description text,
  draft_street text,
  draft_street_number text,
  draft_address_complement text,
  draft_neighborhood text,
  draft_city text,
  draft_state text,
  draft_postal_code text,
  draft_capacity integer,
  draft_studio_type_id uuid,
  draft_studio_type_name text,
  published_revision_id uuid,
  published_revision_number bigint,
  published_name text,
  published_description text,
  published_street text,
  published_street_number text,
  published_address_complement text,
  published_neighborhood text,
  published_city text,
  published_state text,
  published_postal_code text,
  published_capacity integer,
  published_studio_type_id uuid,
  published_studio_type_name text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  max_safe_integer constant bigint := 9007199254740991;
  command_hash text;
  current_request private.studio_command_requests%rowtype;
  current_studio public.studios%rowtype;
  current_revision public.studio_revisions%rowtype;
  new_revision_id uuid;
  new_revision_number bigint;
begin
  if p_studio_id is null
    or p_idempotency_key is null
    or p_expected_edit_version is null
    or p_expected_edit_version < 1
    or p_studio_type_id is null
    or not private.studio_core_is_valid(
      p_name,
      p_description,
      p_street,
      p_street_number,
      p_address_complement,
      p_neighborhood,
      p_postal_code,
      p_capacity
    )
  then
    raise exception using
      errcode = '22023',
      message = 'studio_core_invalid';
  end if;

  perform private.assert_studio_owner_authority(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  command_hash := private.studio_command_payload_hash(
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedEditVersion', p_expected_edit_version,
      'name', p_name,
      'description', p_description,
      'street', p_street,
      'streetNumber', p_street_number,
      'addressComplement', p_address_complement,
      'neighborhood', p_neighborhood,
      'postalCode', p_postal_code,
      'capacity', p_capacity,
      'studioTypeId', p_studio_type_id
    )
  );

  select request.*
  into current_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key
  for update;

  if found then
    if current_request.action <> 'studio.revision.updateCore'
      or current_request.studio_id <> p_studio_id
      or current_request.payload_hash <> command_hash
    then
      raise exception using
        errcode = '40001',
        message = 'studio_idempotency_conflict';
    end if;

    select studio.*
    into current_studio
    from public.studios as studio
    where studio.id = p_studio_id
      and studio.owner_user_id = p_user_id
    for update;

    if not found
      or current_studio.edit_version is distinct from
        current_request.resulting_edit_version
    then
      raise exception using
        errcode = '40001',
        message = 'studio_result_no_longer_available';
    end if;

    return query
    select *
    from private.owner_studio_editor_row(p_user_id, p_studio_id);
    return;
  end if;

  select studio.*
  into current_studio
  from public.studios as studio
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'studio_not_found';
  end if;

  select revision.*
  into current_revision
  from public.studio_revisions as revision
  where revision.studio_id = current_studio.id
    and revision.id = coalesce(
      current_studio.draft_revision_id,
      current_studio.published_revision_id
    );

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'studio_revision_pointer_invalid';
  end if;

  if current_revision.name = p_name
    and current_revision.description = p_description
    and current_revision.street = p_street
    and current_revision.street_number = p_street_number
    and current_revision.address_complement is not distinct from p_address_complement
    and current_revision.neighborhood = p_neighborhood
    and current_revision.postal_code = p_postal_code
    and current_revision.capacity = p_capacity
    and current_revision.studio_type_id = p_studio_type_id
  then
    insert into private.studio_command_requests (
      owner_user_id,
      idempotency_key,
      action,
      studio_id,
      payload_hash,
      result_kind,
      resulting_edit_version
    ) values (
      p_user_id,
      p_idempotency_key,
      'studio.revision.updateCore',
      p_studio_id,
      command_hash,
      'editor',
      current_studio.edit_version
    );

    return query
    select *
    from private.owner_studio_editor_row(p_user_id, p_studio_id);
    return;
  end if;

  if current_studio.edit_version <> p_expected_edit_version then
    raise exception using
      errcode = '40001',
      message = 'studio_edit_version_conflict';
  end if;

  if not exists (
    select 1
    from public.studio_types as studio_type
    where studio_type.id = p_studio_type_id
      and studio_type.active
  ) then
    raise exception using
      errcode = '23514',
      message = 'studio_type_unavailable';
  end if;

  if current_studio.edit_version >= max_safe_integer then
    raise exception using
      errcode = '22003',
      message = 'studio_edit_version_exhausted';
  end if;

  if current_studio.draft_revision_id is null
    and current_studio.last_revision_number >= max_safe_integer
  then
    raise exception using
      errcode = '22003',
      message = 'studio_revision_number_exhausted';
  end if;

  if current_studio.draft_revision_id is null then
    new_revision_id := extensions.gen_random_uuid();
    new_revision_number := current_studio.last_revision_number + 1;

    insert into public.studio_revisions (
      id,
      studio_id,
      revision_number,
      status,
      name,
      description,
      street,
      street_number,
      address_complement,
      neighborhood,
      city,
      state,
      postal_code,
      capacity,
      studio_type_id
    )
    select
      new_revision_id,
      published_revision.studio_id,
      new_revision_number,
      'draft',
      published_revision.name,
      published_revision.description,
      published_revision.street,
      published_revision.street_number,
      published_revision.address_complement,
      published_revision.neighborhood,
      'Curitiba',
      'PR',
      published_revision.postal_code,
      published_revision.capacity,
      published_revision.studio_type_id
    from public.studio_revisions as published_revision
    where published_revision.studio_id = current_studio.id
      and published_revision.id = current_studio.published_revision_id
      and published_revision.status = 'approved';

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'studio_revision_pointer_invalid';
    end if;

    update public.studios as studio
    set draft_revision_id = new_revision_id,
        edit_version = studio.edit_version + 1,
        updated_at = pg_catalog.clock_timestamp()
    where studio.id = current_studio.id;

    update public.studio_revisions as revision
    set name = p_name,
        description = p_description,
        street = p_street,
        street_number = p_street_number,
        address_complement = p_address_complement,
        neighborhood = p_neighborhood,
        city = 'Curitiba',
        state = 'PR',
        postal_code = p_postal_code,
        capacity = p_capacity,
        studio_type_id = p_studio_type_id
    where revision.id = new_revision_id
      and revision.studio_id = current_studio.id;
  else
    update public.studio_revisions as revision
    set name = p_name,
        description = p_description,
        street = p_street,
        street_number = p_street_number,
        address_complement = p_address_complement,
        neighborhood = p_neighborhood,
        city = 'Curitiba',
        state = 'PR',
        postal_code = p_postal_code,
        capacity = p_capacity,
        studio_type_id = p_studio_type_id
    where revision.id = current_studio.draft_revision_id
      and revision.studio_id = current_studio.id;

    update public.studios as studio
    set edit_version = studio.edit_version + 1,
        updated_at = pg_catalog.clock_timestamp()
    where studio.id = current_studio.id;
  end if;

  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    studio_id,
    payload_hash,
    result_kind,
    resulting_edit_version
  )
  select
    p_user_id,
    p_idempotency_key,
    'studio.revision.updateCore',
    p_studio_id,
    command_hash,
    'editor',
    studio.edit_version
  from public.studios as studio
  where studio.id = p_studio_id;

  return query
  select *
  from private.owner_studio_editor_row(p_user_id, p_studio_id);
end;
$function$;

create function private.discard_studio_draft(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_edit_version bigint,
  p_idempotency_key uuid
)
returns table (
  scope uuid,
  studio_id uuid,
  studio_deleted boolean,
  draft_discarded boolean,
  edit_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  max_safe_integer constant bigint := 9007199254740991;
  command_hash text;
  current_request private.studio_command_requests%rowtype;
  current_studio public.studios%rowtype;
  removed_revision_id uuid;
  resulting_version bigint;
begin
  if p_studio_id is null
    or p_idempotency_key is null
    or p_expected_edit_version is null
    or p_expected_edit_version < 1
  then
    raise exception using
      errcode = '22023',
      message = 'studio_core_invalid';
  end if;

  perform private.assert_studio_owner_authority(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  command_hash := private.studio_command_payload_hash(
    pg_catalog.jsonb_build_object(
      'studioId', p_studio_id,
      'expectedEditVersion', p_expected_edit_version
    )
  );

  select request.*
  into current_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key
  for update;

  if found then
    if current_request.action <> 'studio.draft.discard'
      or current_request.studio_id <> p_studio_id
      or current_request.payload_hash <> command_hash
    then
      raise exception using
        errcode = '40001',
        message = 'studio_idempotency_conflict';
    end if;

    if current_request.result_kind = 'draft_discarded' then
      select studio.*
      into current_studio
      from public.studios as studio
      where studio.id = p_studio_id
        and studio.owner_user_id = p_user_id
      for update;

      if not found
        or current_studio.edit_version is distinct from
          current_request.resulting_edit_version
        or current_studio.draft_revision_id is not null
      then
        raise exception using
          errcode = '40001',
          message = 'studio_result_no_longer_available';
      end if;
    end if;

    return query
    select
      p_user_id,
      p_studio_id,
      current_request.result_kind = 'studio_deleted',
      current_request.result_kind = 'draft_discarded',
      current_request.resulting_edit_version;
    return;
  end if;

  select studio.*
  into current_studio
  from public.studios as studio
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'studio_not_found';
  end if;

  if current_studio.edit_version <> p_expected_edit_version then
    raise exception using
      errcode = '40001',
      message = 'studio_edit_version_conflict';
  end if;

  if current_studio.draft_revision_id is null then
    raise exception using
      errcode = '23514',
      message = 'studio_draft_missing';
  end if;

  removed_revision_id := current_studio.draft_revision_id;

  if current_studio.published_revision_id is null then
    insert into private.studio_command_requests (
      owner_user_id,
      idempotency_key,
      action,
      studio_id,
      payload_hash,
      result_kind,
      resulting_edit_version
    ) values (
      p_user_id,
      p_idempotency_key,
      'studio.draft.discard',
      p_studio_id,
      command_hash,
      'studio_deleted',
      null
    );

    delete from public.studios as studio
    where studio.id = current_studio.id;

    return query
    select p_user_id, p_studio_id, true, false, null::bigint;
    return;
  end if;

  if current_studio.edit_version >= max_safe_integer then
    raise exception using
      errcode = '22003',
      message = 'studio_edit_version_exhausted';
  end if;

  update public.studios as studio
  set draft_revision_id = null,
      edit_version = studio.edit_version + 1,
      updated_at = pg_catalog.clock_timestamp()
  where studio.id = current_studio.id
  returning studio.edit_version into resulting_version;

  delete from public.studio_revisions as revision
  where revision.id = removed_revision_id
    and revision.studio_id = current_studio.id;

  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    studio_id,
    payload_hash,
    result_kind,
    resulting_edit_version
  ) values (
    p_user_id,
    p_idempotency_key,
    'studio.draft.discard',
    p_studio_id,
    command_hash,
    'draft_discarded',
    resulting_version
  );

  return query
  select p_user_id, p_studio_id, false, true, resulting_version;
end;
$function$;

revoke all on function private.create_studio(
  uuid, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.update_studio_revision_core(
  uuid, uuid, bigint, uuid, text, text, text, text, text, text, text, integer, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.discard_studio_draft(uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, app_dal;

grant execute on function private.create_studio(
  uuid, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) to app_dal;
grant execute on function private.update_studio_revision_core(
  uuid, uuid, bigint, uuid, text, text, text, text, text, text, text, integer, uuid
) to app_dal;
grant execute on function private.discard_studio_draft(uuid, uuid, bigint, uuid)
  to app_dal;

comment on function private.create_studio(
  uuid, uuid, uuid, text, text, text, text, text, text, text, integer, uuid
) is 'Cria agregado e primeira revisão em uma transação; studioId pré-gerado não concede autoridade.';
comment on function private.update_studio_revision_core(
  uuid, uuid, bigint, uuid, text, text, text, text, text, text, text, integer, uuid
) is 'Atualiza ou clona a revisão draft com convergência idempotente e edit_version otimista.';
comment on function private.discard_studio_draft(uuid, uuid, bigint, uuid)
  is 'Descarta draft; remove o agregado nunca publicado e preserva tombstone idempotente.';

-- Amplia de forma guardada o manifesto exato da app_dal: três comandos e
-- nenhuma relação, sequência, função pública ou grant option adicional.
do $readiness$
declare
  definition text;
  previous_definition text;
  dependency_tail text := $dependency_tail$            pg_catalog.to_regprocedure(
              'private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'
            )
          )
          and dependency.objsubid = 0
        )
      ) as restricted$dependency_tail$;
  dependency_replacement text := $dependency_replacement$            pg_catalog.to_regprocedure(
              'private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'
            ),
            pg_catalog.to_regprocedure(
              'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
            ),
            pg_catalog.to_regprocedure(
              'private.update_studio_revision_core(uuid,uuid,bigint,uuid,text,text,text,text,text,text,text,integer,uuid)'
            ),
            pg_catalog.to_regprocedure(
              'private.discard_studio_draft(uuid,uuid,bigint,uuid)'
            )
          )
          and dependency.objsubid = 0
        )
      ) as restricted$dependency_replacement$;
  routine_tail text := $routine_tail$        pg_catalog.to_regprocedure(
          'private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'
        )
      )
      and (privilege.grantee = runtime_role.oid or privilege.grantor = runtime_role.oid)$routine_tail$;
  routine_replacement text := $routine_replacement$        pg_catalog.to_regprocedure(
          'private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'
        ),
        pg_catalog.to_regprocedure(
          'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.update_studio_revision_core(uuid,uuid,bigint,uuid,text,text,text,text,text,text,text,integer,uuid)'
        ),
        pg_catalog.to_regprocedure(
          'private.discard_studio_draft(uuid,uuid,bigint,uuid)'
        )
      )
      and (privilege.grantee = runtime_role.oid or privilege.grantor = runtime_role.oid)$routine_replacement$;
begin
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('private.check_readiness(text)')
  )
  into definition;

  if definition is null
    or pg_catalog.strpos(definition, 'pg_catalog.count(*) = 17') = 0
    or pg_catalog.strpos(definition, 'pg_catalog.count(*) = 16') = 0
    or pg_catalog.strpos(definition, dependency_tail) = 0
    or pg_catalog.strpos(definition, routine_tail) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'unexpected_studio_readiness_predecessor';
  end if;

  previous_definition := definition;
  definition := pg_catalog.replace(
    definition,
    'pg_catalog.count(*) = 17',
    'pg_catalog.count(*) = 20'
  );
  definition := pg_catalog.replace(
    definition,
    'pg_catalog.count(*) = 16',
    'pg_catalog.count(*) = 19'
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
    or pg_catalog.strpos(definition, 'pg_catalog.count(*) = 20') = 0
    or pg_catalog.strpos(definition, 'pg_catalog.count(*) = 19') = 0
    or pg_catalog.strpos(
      definition,
      'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) = 0
    or pg_catalog.strpos(
      definition,
      'private.update_studio_revision_core(uuid,uuid,bigint,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) = 0
    or pg_catalog.strpos(
      definition,
      'private.discard_studio_draft(uuid,uuid,bigint,uuid)'
    ) = 0
  then
    raise exception using
      errcode = 'P0001',
      message = 'studio_readiness_allowlist_update_failed';
  end if;

  execute definition;
end;
$readiness$;

revoke all on function private.check_readiness(text)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function private.check_readiness(text)
  to app_dal;
