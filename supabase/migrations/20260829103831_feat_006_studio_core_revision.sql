create table private.dal_routine_allowlist (
  signature text primary key,
  created_at timestamptz not null default pg_catalog.now(),
  constraint dal_routine_allowlist_signature_check check (
    signature = pg_catalog.btrim(signature)
    and signature ~ '^private\.[a-z0-9_]+\([^)]*\)$'
  )
);

alter table private.dal_routine_allowlist owner to postgres;
alter table private.dal_routine_allowlist enable row level security;

comment on table private.dal_routine_allowlist is
  'Allowlist canônica de rotinas privadas executáveis pelo app_dal; somente migrations podem alterá-la.';

insert into private.dal_routine_allowlist (signature)
values
  ('private.activate_owner(uuid,uuid,uuid,uuid,text)'),
  ('private.apply_owner_recipient_operation(uuid,uuid,uuid,text,text,text,text[])'),
  ('private.check_readiness(text)'),
  ('private.check_runtime_readiness(text)'),
  ('private.claim_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'),
  ('private.close_identity_recovery_session(uuid,uuid)'),
  ('private.complete_profile(uuid,bigint,text,text,text,text,text)'),
  ('private.consume_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'),
  ('private.create_signup_legal_intent(uuid,uuid,text,uuid,jsonb)'),
  ('private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,integer,uuid)'),
  ('private.discard_studio_draft(uuid,uuid,uuid,bigint,uuid,uuid)'),
  ('private.get_owner_recipient_status_for_user(uuid)'),
  ('private.inspect_identity_recovery_session(uuid,uuid,timestamptz,uuid,uuid)'),
  ('private.issue_identity_recovery_context(uuid,uuid,timestamptz)'),
  ('private.prepare_owner_recipient_operation(uuid,text,uuid)'),
  ('private.release_identity_recovery_context(uuid,uuid,uuid,uuid,uuid)'),
  ('private.update_profile_appearance(uuid,bigint,text)'),
  ('private.update_profile_identity(uuid,bigint,text,text,boolean,text,boolean,text)'),
  ('private.update_studio_revision_core(uuid,uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,text,text,integer,uuid)');

create table private.studio_command_requests (
  owner_user_id uuid not null,
  idempotency_key uuid not null,
  action text not null,
  payload_hash text not null,
  result_hash text not null,
  studio_id uuid not null,
  resulting_revision_id uuid,
  resulting_revision_version bigint,
  studio_deleted boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (owner_user_id, idempotency_key),
  constraint studio_command_requests_action_check check (
    action = any (array[
      'studio.create'::text,
      'studio.revision.updateCore'::text,
      'studio.draft.discard'::text
    ])
  ),
  constraint studio_command_requests_payload_hash_check check (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint studio_command_requests_result_hash_check check (
    result_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint studio_command_requests_result_check check (
    (
      action = 'studio.draft.discard'
      and (
        (studio_deleted and resulting_revision_id is null and resulting_revision_version is null)
        or (
          not studio_deleted
          and resulting_revision_id is not null
          and resulting_revision_version is not null
        )
      )
    )
    or (
      action <> 'studio.draft.discard'
      and not studio_deleted
      and resulting_revision_id is not null
      and resulting_revision_version is not null
    )
  ),
  constraint studio_command_requests_revision_version_check check (
    resulting_revision_version is null or resulting_revision_version >= 1
  )
);

alter table private.studio_command_requests owner to postgres;
alter table private.studio_command_requests enable row level security;

comment on table private.studio_command_requests is
  'Ledger mínimo de idempotência dos comandos de estúdio; hashes verificam payload e resultado sem replicar conteúdo nem endereço.';

create table public.studio_types (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique,
  name text not null,
  active boolean not null default true,
  sort_order smallint not null default 0,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint studio_types_slug_check check (
    slug = pg_catalog.btrim(slug)
    and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    and pg_catalog.char_length(slug) between 2 and 80
  ),
  constraint studio_types_name_check check (
    name = pg_catalog.btrim(name)
    and pg_catalog.char_length(name) between 2 and 80
  ),
  constraint studio_types_sort_order_check check (sort_order >= 0),
  constraint studio_types_timestamps_check check (updated_at >= created_at)
);

alter table public.studio_types owner to postgres;

comment on table public.studio_types is
  'Taxonomia mínima e administrada de tipos de estúdio usada pelo conteúdo versionado.';

insert into public.studio_types (id, slug, name, sort_order)
values
  ('60000000-0000-4000-8000-000000000001', 'audiovisual', 'Estúdio audiovisual', 10),
  ('60000000-0000-4000-8000-000000000002', 'fotografico', 'Estúdio fotográfico', 20),
  ('60000000-0000-4000-8000-000000000003', 'audio', 'Estúdio de áudio', 30),
  ('60000000-0000-4000-8000-000000000004', 'multiuso', 'Espaço multiuso', 40);

create table public.studios (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_user_id uuid not null,
  status text not null default 'draft',
  published_revision_id uuid,
  draft_revision_id uuid,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint studios_status_check check (
    status = any (array[
      'draft'::text,
      'pending_review'::text,
      'published'::text,
      'changes_pending'::text,
      'paused'::text,
      'rejected'::text,
      'disabled'::text
    ])
  ),
  constraint studios_revision_pointer_check check (
    published_revision_id is null
    or draft_revision_id is null
    or published_revision_id <> draft_revision_id
  ),
  constraint studios_timestamps_check check (updated_at >= created_at),
  constraint studios_owner_user_id_fkey foreign key (owner_user_id)
    references public.owner_profiles (user_id) on delete cascade
);

alter table public.studios owner to postgres;

comment on table public.studios is
  'Entidade operacional do estúdio; conteúdo editável e público vive em revisões apontadas.';

create table public.studio_revisions (
  id uuid primary key default extensions.gen_random_uuid(),
  studio_id uuid not null,
  revision_number bigint not null,
  revision_version bigint not null default 1,
  status text not null default 'draft',
  name text not null,
  description text not null,
  street text not null,
  street_number text not null,
  address_complement text,
  neighborhood text not null,
  city text not null,
  state text not null,
  postal_code text not null,
  capacity integer not null,
  studio_type_id uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint studio_revisions_studio_id_fkey foreign key (studio_id)
    references public.studios (id) on delete cascade,
  constraint studio_revisions_studio_type_id_fkey foreign key (studio_type_id)
    references public.studio_types (id) on delete restrict,
  constraint studio_revisions_number_check check (revision_number >= 1),
  constraint studio_revisions_version_check check (revision_version >= 1),
  constraint studio_revisions_status_check check (
    status = any (array[
      'draft'::text,
      'pending'::text,
      'approved'::text,
      'rejected'::text,
      'superseded'::text
    ])
  ),
  constraint studio_revisions_name_check check (
    name = pg_catalog.btrim(name)
    and pg_catalog.char_length(name) between 2 and 120
  ),
  constraint studio_revisions_description_check check (
    description = pg_catalog.btrim(description)
    and pg_catalog.char_length(description) between 20 and 5000
  ),
  constraint studio_revisions_street_check check (
    street = pg_catalog.btrim(street)
    and pg_catalog.char_length(street) between 2 and 160
  ),
  constraint studio_revisions_street_number_check check (
    street_number = pg_catalog.btrim(street_number)
    and pg_catalog.char_length(street_number) between 1 and 20
  ),
  constraint studio_revisions_address_complement_check check (
    address_complement is null
    or (
      address_complement = pg_catalog.btrim(address_complement)
      and pg_catalog.char_length(address_complement) between 1 and 120
    )
  ),
  constraint studio_revisions_neighborhood_check check (
    neighborhood = pg_catalog.btrim(neighborhood)
    and pg_catalog.char_length(neighborhood) between 2 and 120
  ),
  constraint studio_revisions_city_check check (city = 'Curitiba'),
  constraint studio_revisions_state_check check (state = 'PR'),
  constraint studio_revisions_postal_code_check check (postal_code ~ '^[0-9]{8}$'),
  constraint studio_revisions_capacity_check check (capacity between 1 and 500),
  constraint studio_revisions_timestamps_check check (updated_at >= created_at),
  unique (studio_id, revision_number)
);

alter table public.studio_revisions owner to postgres;

comment on table public.studio_revisions is
  'Conteúdo central versionado do estúdio; somente a revisão draft pode ser alterada ou descartada.';

alter table public.studios
  add constraint studios_published_revision_id_fkey
    foreign key (published_revision_id)
    references public.studio_revisions (id)
    on delete set null,
  add constraint studios_draft_revision_id_fkey
    foreign key (draft_revision_id)
    references public.studio_revisions (id)
    on delete set null;

alter table private.studio_command_requests
  add constraint studio_command_requests_owner_user_id_fkey
    foreign key (owner_user_id)
    references public.owner_profiles (user_id)
    on delete cascade;

create index studios_owner_user_id_idx on public.studios (owner_user_id);
create index studios_published_revision_id_idx on public.studios (published_revision_id)
  where published_revision_id is not null;
create index studios_draft_revision_id_idx on public.studios (draft_revision_id)
  where draft_revision_id is not null;
create index studio_revisions_studio_type_id_idx on public.studio_revisions (studio_type_id);
create unique index studio_revisions_one_draft_per_studio_idx
  on public.studio_revisions (studio_id)
  where status = 'draft';

create or replace function private.set_studio_updated_at() returns trigger
  language plpgsql
  set search_path to ''
as $function$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

alter function private.set_studio_updated_at() owner to postgres;

create trigger studios_set_updated_at
  before update on public.studios
  for each row execute function private.set_studio_updated_at();

create or replace function private.enforce_studio_revision_immutability() returns trigger
  language plpgsql
  set search_path to ''
as $function$
begin
  if old.status <> 'draft' then
    raise exception using errcode = '23514', message = 'studio_revision_immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.id is distinct from old.id
    or new.studio_id is distinct from old.studio_id
    or new.revision_number is distinct from old.revision_number
    or new.created_at is distinct from old.created_at
    or new.revision_version <> old.revision_version + 1
  then
    raise exception using errcode = '23514', message = 'studio_revision_identity_invalid';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

alter function private.enforce_studio_revision_immutability() owner to postgres;

create trigger studio_revisions_enforce_immutability
  before update or delete on public.studio_revisions
  for each row execute function private.enforce_studio_revision_immutability();

create or replace function private.enforce_studio_revision_pointers() returns trigger
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  current_studio public.studios%rowtype;
begin
  select studio.*
  into current_studio
  from public.studios as studio
  where studio.id = new.id;

  if not found then
    return null;
  end if;

  if current_studio.draft_revision_id is null
    and current_studio.published_revision_id is null
  then
    raise exception using errcode = '23514', message = 'studio_revision_pointer_missing';
  end if;

  if current_studio.draft_revision_id is not null
    and not exists (
      select 1
      from public.studio_revisions as revision
      where revision.id = current_studio.draft_revision_id
        and revision.studio_id = current_studio.id
    )
  then
    raise exception using errcode = '23514', message = 'studio_draft_pointer_invalid';
  end if;

  if current_studio.published_revision_id is not null
    and not exists (
      select 1
      from public.studio_revisions as revision
      where revision.id = current_studio.published_revision_id
        and revision.studio_id = current_studio.id
    )
  then
    raise exception using errcode = '23514', message = 'studio_published_pointer_invalid';
  end if;

  return null;
end;
$function$;

alter function private.enforce_studio_revision_pointers() owner to postgres;

comment on function private.enforce_studio_revision_pointers()
  is 'Valida ponteiros ao fim da instrução atômica com autoridade interna mínima.';

create constraint trigger studios_enforce_revision_pointers
  after insert or update of draft_revision_id, published_revision_id on public.studios
  for each row execute function private.enforce_studio_revision_pointers();

create or replace function private.studio_editor_json(
  p_user_id uuid,
  p_studio_id uuid
) returns jsonb
  language sql stable security definer
  set search_path to ''
as $function$
  select pg_catalog.jsonb_build_object(
    'scope', studio.owner_user_id,
    'studioId', studio.id,
    'studioStatus', studio.status,
    'publishedRevisionId', studio.published_revision_id,
    'draftRevisionId', studio.draft_revision_id,
    'hasDraft', studio.draft_revision_id is not null,
    'revision', pg_catalog.jsonb_build_object(
      'id', revision.id,
      'status', revision.status,
      'number', revision.revision_number,
      'version', revision.revision_version,
      'name', revision.name,
      'description', revision.description,
      'street', revision.street,
      'streetNumber', revision.street_number,
      'addressComplement', revision.address_complement,
      'neighborhood', revision.neighborhood,
      'city', revision.city,
      'state', revision.state,
      'postalCode', revision.postal_code,
      'capacity', revision.capacity,
      'studioTypeId', revision.studio_type_id
    ),
    'studioType', pg_catalog.jsonb_build_object(
      'id', studio_type.id,
      'name', studio_type.name
    )
  )
  from public.studios as studio
  join public.studio_revisions as revision
    on revision.id = coalesce(
      studio.draft_revision_id,
      studio.published_revision_id
    )
  join public.studio_types as studio_type on studio_type.id = revision.studio_type_id
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id;
$function$;

alter function private.studio_editor_json(uuid, uuid) owner to postgres;

create or replace function public.list_active_studio_types()
returns table (
  id uuid,
  name text,
  sort_order smallint
)
  language sql stable security invoker
  set search_path to ''
as $function$
  select studio_type.id, studio_type.name, studio_type.sort_order
  from public.studio_types as studio_type
  where studio_type.active
  order by studio_type.sort_order, studio_type.name, studio_type.id;
$function$;

alter function public.list_active_studio_types() owner to postgres;

create or replace function public.get_owner_studio_editor(p_studio_id uuid)
returns table (
  scope uuid,
  studio_id uuid,
  studio_status text,
  published_revision_id uuid,
  draft_revision_id uuid,
  has_draft boolean,
  revision_id uuid,
  revision_status text,
  revision_number bigint,
  revision_version bigint,
  name text,
  description text,
  street text,
  street_number text,
  address_complement text,
  neighborhood text,
  city text,
  state text,
  postal_code text,
  capacity integer,
  studio_type_id uuid,
  studio_type_name text
)
  language sql stable security invoker
  set search_path to ''
as $function$
  select
    studio.owner_user_id,
    studio.id,
    studio.status,
    studio.published_revision_id,
    studio.draft_revision_id,
    studio.draft_revision_id is not null,
    revision.id,
    revision.status,
    revision.revision_number,
    revision.revision_version,
    revision.name,
    revision.description,
    revision.street,
    revision.street_number,
    revision.address_complement,
    revision.neighborhood,
    revision.city,
    revision.state,
    revision.postal_code,
    revision.capacity,
    revision.studio_type_id,
    studio_type.name
  from public.studios as studio
  join public.studio_revisions as revision
    on revision.id = coalesce(
      studio.draft_revision_id,
      studio.published_revision_id
    )
  join public.studio_types as studio_type on studio_type.id = revision.studio_type_id
  where studio.id = p_studio_id
    and studio.owner_user_id = (select auth.uid());
$function$;

alter function public.get_owner_studio_editor(uuid) owner to postgres;

create or replace function private.studio_core_payload_hash(
  p_name text,
  p_description text,
  p_street text,
  p_street_number text,
  p_address_complement text,
  p_neighborhood text,
  p_city text,
  p_state text,
  p_postal_code text,
  p_capacity integer,
  p_studio_type_id uuid
) returns text
  language sql immutable
  set search_path to ''
as $function$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'name', p_name,
          'description', p_description,
          'street', p_street,
          'streetNumber', p_street_number,
          'addressComplement', p_address_complement,
          'neighborhood', p_neighborhood,
          'city', p_city,
          'state', p_state,
          'postalCode', p_postal_code,
          'capacity', p_capacity,
          'studioTypeId', p_studio_type_id
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$function$;

alter function private.studio_core_payload_hash(
  text, text, text, text, text, text, text, text, text, integer, uuid
) owner to postgres;

create or replace function private.studio_result_hash(p_result jsonb) returns text
  language sql immutable
  set search_path to ''
as $function$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(p_result::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$function$;

alter function private.studio_result_hash(jsonb) owner to postgres;

create or replace function private.assert_studio_owner_mutable(p_user_id uuid) returns void
  language plpgsql security definer
  set search_path to ''
as $function$
begin
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'invalid_studio_owner';
  end if;

  perform profile.id
  from public.profiles as profile
  join public.owner_profiles as owner on owner.user_id = profile.id
  where profile.id = p_user_id
    and profile.status = 'active'
    and profile.completed_at is not null
    and owner.status = 'active'
  for update of profile, owner;

  if not found then
    raise exception using errcode = '42501', message = 'studio_owner_inactive';
  end if;

  if not exists (
    select 1
    from public.owner_profiles as owner
    join public.terms_versions as legal_version
      on legal_version.id = owner.accepted_owner_contract_version_id
    join public.terms_acceptances as acceptance
      on acceptance.user_id = owner.user_id
      and acceptance.terms_version_id = legal_version.id
      and acceptance.accepted_content_hash = legal_version.content_hash
    where owner.user_id = p_user_id
      and legal_version.kind = 'owner_contract'
      and legal_version.effective_at <= pg_catalog.clock_timestamp()
      and (
        legal_version.retired_at is null
        or pg_catalog.clock_timestamp() < legal_version.retired_at
      )
  ) then
    raise exception using errcode = '42501', message = 'owner_contract_not_current';
  end if;
end;
$function$;

alter function private.assert_studio_owner_mutable(uuid) owner to postgres;

alter table audit.events drop constraint events_action_check;
alter table audit.events add constraint events_action_check check (
  action = any (array[
    'owner.activated'::text,
    'owner.contract_renewed'::text,
    'recipient.status_transitioned'::text,
    'studio.created'::text,
    'studio.revision_updated'::text,
    'studio.draft_discarded'::text
  ])
);

alter table audit.events drop constraint events_target_type_check;
alter table audit.events add constraint events_target_type_check check (
  target_type = any (array[
    'owner_profile'::text,
    'owner_payment_recipient'::text,
    'studio'::text
  ])
);

create or replace function private.create_studio(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_name text,
  p_description text,
  p_street text,
  p_street_number text,
  p_address_complement text,
  p_neighborhood text,
  p_city text,
  p_state text,
  p_postal_code text,
  p_capacity integer,
  p_studio_type_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  editor jsonb;
  existing_request private.studio_command_requests%rowtype;
  payload_hash text;
  revision_id uuid := extensions.gen_random_uuid();
  studio_id uuid := extensions.gen_random_uuid();
begin
  if p_user_id is null
    or p_idempotency_key is null
    or p_request_id is null
    or p_studio_type_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_create';
  end if;

  payload_hash := private.studio_core_payload_hash(
    p_name,
    p_description,
    p_street,
    p_street_number,
    p_address_complement,
    p_neighborhood,
    p_city,
    p_state,
    p_postal_code,
    p_capacity,
    p_studio_type_id
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  perform private.assert_studio_owner_mutable(p_user_id);

  select request.*
  into existing_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> 'studio.create'
      or existing_request.payload_hash <> payload_hash
    then
      raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
    end if;

    editor := private.studio_editor_json(p_user_id, existing_request.studio_id);
    if editor is null then
      raise exception using errcode = '40001', message = 'studio_create_result_missing';
    end if;
    if private.studio_result_hash(editor) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'studio_create_result_stale';
    end if;
    return editor;
  end if;

  if not exists (
    select 1
    from public.studio_types as studio_type
    where studio_type.id = p_studio_type_id
      and studio_type.active
    for share
  ) then
    raise exception using errcode = '23514', message = 'studio_type_inactive';
  end if;

  with inserted_studio as (
    insert into public.studios (id, owner_user_id, status, draft_revision_id)
    values (studio_id, p_user_id, 'draft', revision_id)
    returning id
  )
  insert into public.studio_revisions (
    id,
    studio_id,
    revision_number,
    revision_version,
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
    revision_id,
    inserted_studio.id,
    1,
    1,
    'draft',
    p_name,
    p_description,
    p_street,
    p_street_number,
    p_address_complement,
    p_neighborhood,
    p_city,
    p_state,
    p_postal_code,
    p_capacity,
    p_studio_type_id
  from inserted_studio;

  editor := private.studio_editor_json(p_user_id, studio_id);
  if editor is null then
    raise exception using errcode = 'P0002', message = 'studio_create_result_missing';
  end if;

  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    studio_id,
    resulting_revision_id,
    resulting_revision_version
  )
  values (
    p_user_id,
    p_idempotency_key,
    'studio.create',
    payload_hash,
    private.studio_result_hash(editor),
    studio_id,
    revision_id,
    1
  );

  insert into audit.events (
    actor_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    request_id,
    idempotency_key,
    ip_hash,
    metadata
  )
  values (
    p_user_id,
    'authenticated',
    'studio.created',
    'studio',
    studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'revisionId', revision_id,
      'revisionNumber', 1,
      'revisionVersion', 1
    )
  );

  return editor;
end;
$function$;

alter function private.create_studio(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, integer, uuid
) owner to postgres;

create or replace function private.update_studio_revision_core(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid,
  p_name text,
  p_description text,
  p_street text,
  p_street_number text,
  p_address_complement text,
  p_neighborhood text,
  p_city text,
  p_state text,
  p_postal_code text,
  p_capacity integer,
  p_studio_type_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  core_hash text;
  current_revision public.studio_revisions%rowtype;
  current_studio public.studios%rowtype;
  editor jsonb;
  existing_request private.studio_command_requests%rowtype;
  next_revision_number bigint;
  payload_hash text;
  resulting_revision_id uuid;
  resulting_revision_version bigint;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
    or p_studio_type_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_update';
  end if;

  core_hash := private.studio_core_payload_hash(
    p_name,
    p_description,
    p_street,
    p_street_number,
    p_address_complement,
    p_neighborhood,
    p_city,
    p_state,
    p_postal_code,
    p_capacity,
    p_studio_type_id
  );
  payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'studioId', p_studio_id,
          'expectedRevisionId', p_expected_revision_id,
          'expectedRevisionVersion', p_expected_revision_version,
          'coreHash', core_hash
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  perform private.assert_studio_owner_mutable(p_user_id);

  select request.*
  into existing_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> 'studio.revision.updateCore'
      or existing_request.payload_hash <> payload_hash
      or existing_request.studio_id <> p_studio_id
    then
      raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
    end if;

    editor := private.studio_editor_json(p_user_id, p_studio_id);
    if editor is null then
      raise exception using errcode = '40001', message = 'studio_update_result_missing';
    end if;
    if private.studio_result_hash(editor) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'studio_update_result_stale';
    end if;
    return editor;
  end if;

  select studio.*
  into current_studio
  from public.studios as studio
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_not_found';
  end if;
  if current_studio.status = 'disabled' then
    raise exception using errcode = '42501', message = 'studio_disabled';
  end if;

  if not exists (
    select 1
    from public.studio_types as studio_type
    where studio_type.id = p_studio_type_id
      and studio_type.active
    for share
  ) then
    raise exception using errcode = '23514', message = 'studio_type_inactive';
  end if;

  select revision.*
  into current_revision
  from public.studio_revisions as revision
  where revision.id = coalesce(
      current_studio.draft_revision_id,
      current_studio.published_revision_id
    )
    and revision.studio_id = current_studio.id
  for update;

  if not found
    or current_revision.id <> p_expected_revision_id
    or current_revision.revision_version <> p_expected_revision_version
  then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  if current_studio.draft_revision_id is not null then
    if current_revision.status <> 'draft' then
      raise exception using errcode = '23514', message = 'studio_draft_state_invalid';
    end if;

    update public.studio_revisions as revision
    set
      revision_version = revision.revision_version + 1,
      name = p_name,
      description = p_description,
      street = p_street,
      street_number = p_street_number,
      address_complement = p_address_complement,
      neighborhood = p_neighborhood,
      city = p_city,
      state = p_state,
      postal_code = p_postal_code,
      capacity = p_capacity,
      studio_type_id = p_studio_type_id
    where revision.id = current_revision.id
      and revision.status = 'draft'
      and revision.revision_version = p_expected_revision_version
    returning revision.id, revision.revision_version
      into resulting_revision_id, resulting_revision_version;

    if not found then
      raise exception using errcode = '40001', message = 'studio_revision_conflict';
    end if;
  else
    if current_revision.status <> 'approved'
      or current_studio.published_revision_id <> current_revision.id
    then
      raise exception using errcode = '23514', message = 'studio_published_state_invalid';
    end if;

    select pg_catalog.max(revision.revision_number) + 1
    into next_revision_number
    from public.studio_revisions as revision
    where revision.studio_id = current_studio.id;

    insert into public.studio_revisions (
      studio_id,
      revision_number,
      revision_version,
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
    values (
      current_studio.id,
      next_revision_number,
      1,
      'draft',
      p_name,
      p_description,
      p_street,
      p_street_number,
      p_address_complement,
      p_neighborhood,
      p_city,
      p_state,
      p_postal_code,
      p_capacity,
      p_studio_type_id
    )
    returning id, revision_version
      into resulting_revision_id, resulting_revision_version;

    update public.studios as studio
    set draft_revision_id = resulting_revision_id
    where studio.id = current_studio.id;
  end if;

  editor := private.studio_editor_json(p_user_id, p_studio_id);
  if editor is null then
    raise exception using errcode = 'P0002', message = 'studio_update_result_missing';
  end if;

  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    studio_id,
    resulting_revision_id,
    resulting_revision_version
  )
  values (
    p_user_id,
    p_idempotency_key,
    'studio.revision.updateCore',
    payload_hash,
    private.studio_result_hash(editor),
    p_studio_id,
    resulting_revision_id,
    resulting_revision_version
  );

  insert into audit.events (
    actor_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    request_id,
    idempotency_key,
    ip_hash,
    metadata
  )
  values (
    p_user_id,
    'authenticated',
    'studio.revision_updated',
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'revisionId', resulting_revision_id,
      'revisionVersion', resulting_revision_version
    )
  );

  return editor;
end;
$function$;

alter function private.update_studio_revision_core(
  uuid, uuid, uuid, bigint, uuid, uuid,
  text, text, text, text, text, text, text, text, text, integer, uuid
) owner to postgres;

create or replace function private.discard_studio_draft(
  p_user_id uuid,
  p_studio_id uuid,
  p_expected_revision_id uuid,
  p_expected_revision_version bigint,
  p_idempotency_key uuid,
  p_request_id uuid
) returns jsonb
  language plpgsql security definer
  set search_path to ''
as $function$
declare
  current_revision public.studio_revisions%rowtype;
  current_studio public.studios%rowtype;
  editor jsonb;
  existing_request private.studio_command_requests%rowtype;
  payload_hash text;
  published_revision public.studio_revisions%rowtype;
  result jsonb;
begin
  if p_user_id is null
    or p_studio_id is null
    or p_expected_revision_id is null
    or p_expected_revision_version is null
    or p_expected_revision_version < 1
    or p_idempotency_key is null
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'invalid_studio_discard';
  end if;

  payload_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'studioId', p_studio_id,
          'expectedRevisionId', p_expected_revision_id,
          'expectedRevisionVersion', p_expected_revision_version
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  perform private.assert_studio_owner_mutable(p_user_id);

  select request.*
  into existing_request
  from private.studio_command_requests as request
  where request.owner_user_id = p_user_id
    and request.idempotency_key = p_idempotency_key;

  if found then
    if existing_request.action <> 'studio.draft.discard'
      or existing_request.payload_hash <> payload_hash
      or existing_request.studio_id <> p_studio_id
    then
      raise exception using errcode = '40001', message = 'studio_idempotency_conflict';
    end if;

    if existing_request.studio_deleted then
      result := pg_catalog.jsonb_build_object(
        'scope', p_user_id,
        'studioId', p_studio_id,
        'studioDeleted', true
      );
    else
      editor := private.studio_editor_json(p_user_id, p_studio_id);
      if editor is null then
        raise exception using errcode = '40001', message = 'studio_discard_result_missing';
      end if;
      result := pg_catalog.jsonb_build_object(
        'scope', p_user_id,
        'studioId', p_studio_id,
        'studioDeleted', false,
        'editor', editor
      );
    end if;
    if private.studio_result_hash(result) <> existing_request.result_hash then
      raise exception using errcode = '40001', message = 'studio_discard_result_stale';
    end if;
    return result;
  end if;

  select studio.*
  into current_studio
  from public.studios as studio
  where studio.id = p_studio_id
    and studio.owner_user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'studio_not_found';
  end if;
  if current_studio.status = 'disabled' then
    raise exception using errcode = '42501', message = 'studio_disabled';
  end if;
  if current_studio.draft_revision_id is null then
    raise exception using errcode = '40001', message = 'studio_draft_missing';
  end if;

  select revision.*
  into current_revision
  from public.studio_revisions as revision
  where revision.id = current_studio.draft_revision_id
    and revision.studio_id = current_studio.id
  for update;

  if not found
    or current_revision.id <> p_expected_revision_id
    or current_revision.revision_version <> p_expected_revision_version
    or current_revision.status <> 'draft'
  then
    raise exception using errcode = '40001', message = 'studio_revision_conflict';
  end if;

  if current_studio.published_revision_id is null then
    result := pg_catalog.jsonb_build_object(
      'scope', p_user_id,
      'studioId', p_studio_id,
      'studioDeleted', true
    );

    insert into private.studio_command_requests (
      owner_user_id,
      idempotency_key,
      action,
      payload_hash,
      result_hash,
      studio_id,
      resulting_revision_id,
      resulting_revision_version,
      studio_deleted
    )
    values (
      p_user_id,
      p_idempotency_key,
      'studio.draft.discard',
      payload_hash,
      private.studio_result_hash(result),
      p_studio_id,
      null,
      null,
      true
    );

    insert into audit.events (
      actor_user_id,
      actor_role,
      action,
      target_type,
      target_id,
      result,
      request_id,
      idempotency_key,
      ip_hash,
      metadata
    )
    values (
      p_user_id,
      'authenticated',
      'studio.draft_discarded',
      'studio',
      p_studio_id,
      'succeeded',
      p_request_id,
      p_idempotency_key,
      null,
      pg_catalog.jsonb_build_object(
        'revisionId', current_revision.id,
        'studioDeleted', true
      )
    );

    delete from public.studios as studio where studio.id = p_studio_id;

    return result;
  end if;

  select revision.*
  into published_revision
  from public.studio_revisions as revision
  where revision.id = current_studio.published_revision_id
    and revision.studio_id = current_studio.id;

  if not found or published_revision.status <> 'approved' then
    raise exception using errcode = '23514', message = 'studio_published_state_invalid';
  end if;

  update public.studios as studio
  set draft_revision_id = null
  where studio.id = p_studio_id;

  delete from public.studio_revisions as revision
  where revision.id = current_revision.id;

  editor := private.studio_editor_json(p_user_id, p_studio_id);
  if editor is null then
    raise exception using errcode = 'P0002', message = 'studio_discard_result_missing';
  end if;
  result := pg_catalog.jsonb_build_object(
    'scope', p_user_id,
    'studioId', p_studio_id,
    'studioDeleted', false,
    'editor', editor
  );

  insert into private.studio_command_requests (
    owner_user_id,
    idempotency_key,
    action,
    payload_hash,
    result_hash,
    studio_id,
    resulting_revision_id,
    resulting_revision_version,
    studio_deleted
  )
  values (
    p_user_id,
    p_idempotency_key,
    'studio.draft.discard',
    payload_hash,
    private.studio_result_hash(result),
    p_studio_id,
    published_revision.id,
    published_revision.revision_version,
    false
  );

  insert into audit.events (
    actor_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    request_id,
    idempotency_key,
    ip_hash,
    metadata
  )
  values (
    p_user_id,
    'authenticated',
    'studio.draft_discarded',
    'studio',
    p_studio_id,
    'succeeded',
    p_request_id,
    p_idempotency_key,
    null,
    pg_catalog.jsonb_build_object(
      'revisionId', current_revision.id,
      'studioDeleted', false
    )
  );

  return result;
end;
$function$;

alter function private.discard_studio_draft(
  uuid, uuid, uuid, bigint, uuid, uuid
) owner to postgres;

create or replace function private.check_readiness(expected_version text) returns boolean
  language sql stable security definer
  set search_path to ''
as $function$
  with dal_role as (
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
        from pg_catalog.pg_auth_members as membership
        where membership.member = role.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_shdepend as dependency
        where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
          and dependency.refobjid = role.oid
          and dependency.deptype = 'o'
      )
  ),
  trusted_owner as (
    select role.oid
    from pg_catalog.pg_roles as role
    where role.rolname = 'postgres'
  ),
  migration_is_applied as (
    select
      expected_version ~ '^[0-9]{14}$'
      and exists (
        select 1
        from supabase_migrations.schema_migrations as migration
        where migration.version = expected_version
      ) as ready
  ),
  authorized_dal_routines as (
    select pg_catalog.to_regprocedure(entry.signature) as oid
    from private.dal_routine_allowlist as entry
  ),
  dal_allowlist_is_trusted as (
    select exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join trusted_owner
      where namespace.nspname = 'private'
        and relation.relname = 'dal_routine_allowlist'
        and relation.relkind = 'r'
        and relation.relowner = trusted_owner.oid
        and relation.relrowsecurity
    ) as ready
  ),
  private_ownership_is_trusted as (
    select
      exists (
        select 1
        from pg_catalog.pg_namespace as namespace
        cross join trusted_owner
        where namespace.nspname = 'private'
          and namespace.nspowner = trusted_owner.oid
      )
      and not exists (
        select 1
        from pg_catalog.pg_proc as routine
        join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
        cross join trusted_owner
        where namespace.nspname = 'private'
          and routine.proowner <> trusted_owner.oid
      ) as ready
  ),
  authorized_dal_routine_attributes_are_trusted as (
    select not exists (
      select 1
      from authorized_dal_routines as authorized
      left join pg_catalog.pg_proc as routine on routine.oid = authorized.oid
      where routine.oid is null
        or not routine.prosecdef
        or routine.proconfig is distinct from array['search_path=""']::text[]
    ) as ready
  ),
  direct_schema_grants_are_restricted as (
    select
      pg_catalog.count(*) filter (where privilege.grantee = dal_role.oid) = 1
      and coalesce(
        pg_catalog.bool_and(
          privilege.grantee = trusted_owner.oid
          or (
            privilege.grantee = dal_role.oid
            and privilege.privilege_type = 'USAGE'
            and not privilege.is_grantable
          )
        ),
        false
      ) as ready
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
    cross join dal_role
    cross join trusted_owner
    where namespace.nspname = 'private'
  ),
  effective_external_schema_access_is_absent as (
    select not exists (
      select 1
      from pg_catalog.pg_namespace as namespace
      where namespace.nspname <> 'private'
        and namespace.nspname <> 'information_schema'
        and namespace.nspname !~ '^pg_'
        and (
          pg_catalog.has_schema_privilege('app_dal', namespace.oid, 'USAGE')
          or pg_catalog.has_schema_privilege('app_dal', namespace.oid, 'CREATE')
        )
    ) as ready
  ),
  direct_routine_grants_are_restricted as (
    select
      pg_catalog.count(*) filter (where privilege.grantee = dal_role.oid)
        = (select pg_catalog.count(*) from authorized_dal_routines)
      and coalesce(
        pg_catalog.bool_and(
          privilege.grantee = trusted_owner.oid
          or (
            privilege.grantee = dal_role.oid
            and routine.oid in (select authorized.oid from authorized_dal_routines as authorized)
            and privilege.privilege_type = 'EXECUTE'
            and not privilege.is_grantable
          )
        ),
        false
      )
      and not exists (
        select 1
        from authorized_dal_routines as authorized
        where authorized.oid is null
      ) as ready
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    cross join dal_role
    cross join trusted_owner
    where namespace.nspname = 'private'
  ),
  effective_private_routine_grants_are_restricted as (
    select not exists (
      select 1
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'private'
        and (
          pg_catalog.has_function_privilege('app_dal', routine.oid, 'EXECUTE')
            <> (routine.oid in (select authorized.oid from authorized_dal_routines as authorized))
          or pg_catalog.has_function_privilege(
            'app_dal',
            routine.oid,
            'EXECUTE WITH GRANT OPTION'
          )
        )
    ) as ready
  ),
  direct_data_grants_are_absent as (
    select not exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
      cross join dal_role
      where namespace.nspname in ('audit', 'private', 'public')
        and privilege.grantee in (0, dal_role.oid)

      union all

      select 1
      from pg_catalog.pg_attribute as attribute
      join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
      join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
      cross join dal_role
      where namespace.nspname in ('audit', 'private', 'public')
        and privilege.grantee in (0, dal_role.oid)

      union all

      select 1
      from pg_catalog.pg_type as type_object
      join pg_catalog.pg_namespace as namespace on namespace.oid = type_object.typnamespace
      cross join lateral pg_catalog.aclexplode(type_object.typacl) as privilege
      cross join dal_role
      where namespace.nspname in ('audit', 'private', 'public')
        and privilege.grantee in (0, dal_role.oid)

      union all

      select 1
      from pg_catalog.pg_default_acl as defaults
      left join pg_catalog.pg_namespace as namespace on namespace.oid = defaults.defaclnamespace
      cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
      cross join dal_role
      where defaults.defaclrole = (
          select role.oid from pg_catalog.pg_roles as role where role.rolname = 'postgres'
        )
        and (defaults.defaclnamespace = 0 or namespace.nspname in ('audit', 'private', 'public'))
        and privilege.grantee in (0, dal_role.oid)
    ) as ready
  ),
  dal_memberships_are_restricted as (
    select
      exists (
        select 1
        from pg_catalog.pg_auth_members as membership
        join pg_catalog.pg_roles as member on member.oid = membership.member
        where membership.roleid = dal_role.oid
          and member.rolname = 'app_runtime_production'
          and not membership.admin_option
          and not membership.inherit_option
          and membership.set_option
      )
      and not exists (
        select 1
        from pg_catalog.pg_auth_members as membership
        join pg_catalog.pg_roles as member on member.oid = membership.member
        where membership.roleid = dal_role.oid
          and not (
            (
              member.rolname = 'app_runtime_production'
              and not membership.admin_option
              and not membership.inherit_option
              and membership.set_option
            )
            or (
              member.rolname = 'app_runtime_local'
              and not membership.admin_option
              and not membership.inherit_option
              and membership.set_option
              and exists (
                select 1
                from pg_catalog.pg_database as database
                where database.datname = pg_catalog.current_database()
                  and pg_catalog.shobj_description(database.oid, 'pg_database')
                    like 'set-livre-e2e:%'
              )
            )
            or (
              member.rolname = 'postgres'
              and membership.admin_option
              and not membership.inherit_option
              and not membership.set_option
            )
          )
      ) as ready
    from dal_role
  ),
  public_tables_use_rls as (
    select coalesce(pg_catalog.bool_and(relation.relrowsecurity), true) as ready
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('p', 'r')
  )
  select coalesce(
    (select ready from migration_is_applied)
    and pg_catalog.current_setting('app.settings.jwt_exp', true) = '3600'
    and (select ready from dal_allowlist_is_trusted)
    and (select ready from private_ownership_is_trusted)
    and (select ready from authorized_dal_routine_attributes_are_trusted)
    and (select ready from direct_schema_grants_are_restricted)
    and (select ready from effective_external_schema_access_is_absent)
    and (select ready from direct_routine_grants_are_restricted)
    and (select ready from effective_private_routine_grants_are_restricted)
    and (select ready from direct_data_grants_are_absent)
    and (select ready from dal_memberships_are_restricted)
    and (select ready from public_tables_use_rls)
    and private.managed_runtime_boundaries_are_ready()
    and not pg_catalog.has_schema_privilege('public', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('anon', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('authenticated', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('service_role', 'public', 'CREATE')
    and not pg_catalog.has_schema_privilege('app_dal', 'public', 'CREATE')
    and not pg_catalog.has_database_privilege(
      'app_dal',
      pg_catalog.current_database(),
      'TEMPORARY'
    ),
    false
  );
$function$;

alter function private.check_readiness(text) owner to postgres;

comment on function private.check_readiness(text) is
  'Health fail-closed: migration, runtime, RLS, ownership e allowlist canônica do app_dal.';

alter table public.studio_types enable row level security;
alter table public.studios enable row level security;
alter table public.studio_revisions enable row level security;

create policy studio_types_select_active
  on public.studio_types
  for select
  to authenticated
  using (
    active
    or exists (
      select 1
      from public.studio_revisions as revision
      join public.studios as studio on studio.id = revision.studio_id
      where revision.studio_type_id = studio_types.id
        and studio.owner_user_id = (select auth.uid())
    )
  );

create policy studios_select_own
  on public.studios
  for select
  to authenticated
  using ((select auth.uid()) = owner_user_id);

create policy studio_revisions_select_own
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

revoke all on table private.dal_routine_allowlist
  from public, anon, authenticated, service_role, app_dal;
revoke all on table private.studio_command_requests
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.studio_types
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.studios
  from public, anon, authenticated, service_role, app_dal;
revoke all on table public.studio_revisions
  from public, anon, authenticated, service_role, app_dal;

grant select (id, name, active, sort_order)
  on table public.studio_types to authenticated;
grant select (id, owner_user_id, status, published_revision_id, draft_revision_id)
  on table public.studios to authenticated;
grant select (
  id,
  studio_id,
  revision_number,
  revision_version,
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
) on table public.studio_revisions to authenticated;

revoke all on function private.set_studio_updated_at()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.enforce_studio_revision_immutability()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.enforce_studio_revision_pointers()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_editor_json(uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_core_payload_hash(
  text, text, text, text, text, text, text, text, text, integer, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.studio_result_hash(jsonb)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.assert_studio_owner_mutable(uuid)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.create_studio(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, integer, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.update_studio_revision_core(
  uuid, uuid, uuid, bigint, uuid, uuid,
  text, text, text, text, text, text, text, text, text, integer, uuid
) from public, anon, authenticated, service_role, app_dal;
revoke all on function private.discard_studio_draft(uuid, uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role, app_dal;

grant execute on function private.create_studio(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, integer, uuid
) to app_dal;
grant execute on function private.update_studio_revision_core(
  uuid, uuid, uuid, bigint, uuid, uuid,
  text, text, text, text, text, text, text, text, text, integer, uuid
) to app_dal;
grant execute on function private.discard_studio_draft(uuid, uuid, uuid, bigint, uuid, uuid)
  to app_dal;

revoke all on function public.list_active_studio_types()
  from public, anon, authenticated, service_role, app_dal;
revoke all on function public.get_owner_studio_editor(uuid)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function public.list_active_studio_types() to authenticated;
grant execute on function public.get_owner_studio_editor(uuid) to authenticated;

comment on function private.create_studio(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, integer, uuid
) is 'Cria estúdio e primeira revisão draft de forma atômica e idempotente.';
comment on function private.update_studio_revision_core(
  uuid, uuid, uuid, bigint, uuid, uuid,
  text, text, text, text, text, text, text, text, text, integer, uuid
) is 'Atualiza draft com concorrência otimista ou clona a revisão publicada sem mutá-la.';
comment on function private.discard_studio_draft(uuid, uuid, uuid, bigint, uuid, uuid)
  is 'Descarta somente draft esperado; remove o estúdio ainda inédito ou preserva a revisão publicada.';
comment on function public.list_active_studio_types()
  is 'Read model autenticado e ordenado da taxonomia ativa exigida pelo editor.';
comment on function public.get_owner_studio_editor(uuid)
  is 'Read model privado do editor, sempre limitado ao auth.uid e à revisão editável ou publicada atual.';
