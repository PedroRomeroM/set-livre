-- Corrige duas fronteiras de leitura: elegibilidade do editor de estúdio e busca de PII no backoffice.

drop policy studios_select_own on public.studios;

create policy studios_select_own
  on public.studios
  for select
  to authenticated
  using (
    owner_user_id = (select auth.uid())
    and exists (
      select 1
      from public.profiles as profile
      join public.owner_profiles as owner on owner.user_id = profile.id
      join public.terms_versions as legal_version
        on legal_version.id = owner.accepted_owner_contract_version_id
      join public.terms_acceptances as acceptance
        on acceptance.user_id = owner.user_id
        and acceptance.terms_version_id = legal_version.id
        and acceptance.accepted_content_hash = legal_version.content_hash
      where profile.id = owner_user_id
        and profile.status = 'active'
        and profile.completed_at is not null
        and owner.status = 'active'
        and legal_version.kind = 'owner_contract'
        and legal_version.effective_at <= pg_catalog.now()
        and (
          legal_version.retired_at is null
          or pg_catalog.now() < legal_version.retired_at
        )
    )
  );

comment on policy studios_select_own on public.studios is
  'Lê somente estúdios do auth.uid elegível: conta ativa, perfil completo, dono ativo e contrato vigente aceito.';

drop policy studio_revisions_select_own on public.studio_revisions;

create policy studio_revisions_select_own
  on public.studio_revisions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.studios as studio
      join public.profiles as profile on profile.id = studio.owner_user_id
      join public.owner_profiles as owner on owner.user_id = profile.id
      join public.terms_versions as legal_version
        on legal_version.id = owner.accepted_owner_contract_version_id
      join public.terms_acceptances as acceptance
        on acceptance.user_id = owner.user_id
        and acceptance.terms_version_id = legal_version.id
        and acceptance.accepted_content_hash = legal_version.content_hash
      where studio.id = studio_revisions.studio_id
        and studio.owner_user_id = (select auth.uid())
        and profile.status = 'active'
        and profile.completed_at is not null
        and owner.status = 'active'
        and legal_version.kind = 'owner_contract'
        and legal_version.effective_at <= pg_catalog.now()
        and (
          legal_version.retired_at is null
          or pg_catalog.now() < legal_version.retired_at
        )
    )
  );

comment on policy studio_revisions_select_own on public.studio_revisions is
  'Lê revisões somente sob ownership e elegibilidade canônica vigente do dono.';

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
  studio_type_name text,
  usage_rules text,
  youtube_video_id text,
  tags jsonb,
  amenities jsonb,
  faqs jsonb
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
    studio_type.name,
    revision.usage_rules,
    revision.youtube_video_id,
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', tag.id,
          'name', tag.name,
          'active', tag.active,
          'sortOrder', tag.sort_order
        ) order by tag.sort_order, tag.name, tag.id
      )
      from public.studio_revision_tags as relation
      join public.tags as tag on tag.id = relation.tag_id
      where relation.revision_id = revision.id
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', amenity.id,
          'name', amenity.name,
          'active', amenity.active,
          'sortOrder', amenity.sort_order
        ) order by amenity.sort_order, amenity.name, amenity.id
      )
      from public.studio_revision_amenities as relation
      join public.amenities as amenity on amenity.id = relation.amenity_id
      where relation.revision_id = revision.id
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', faq.id,
          'question', faq.question,
          'answer', faq.answer,
          'position', faq.position
        ) order by faq.position
      )
      from public.studio_faqs as faq
      where faq.revision_id = revision.id
    ), '[]'::jsonb)
  from public.studios as studio
  join public.studio_revisions as revision
    on revision.id = coalesce(studio.draft_revision_id, studio.published_revision_id)
  join public.studio_types as studio_type on studio_type.id = revision.studio_type_id
  where studio.id = p_studio_id
    and studio.owner_user_id = (select auth.uid())
    and exists (
      select 1
      from public.profiles as profile
      join public.owner_profiles as owner on owner.user_id = profile.id
      join public.terms_versions as legal_version
        on legal_version.id = owner.accepted_owner_contract_version_id
      join public.terms_acceptances as acceptance
        on acceptance.user_id = owner.user_id
        and acceptance.terms_version_id = legal_version.id
        and acceptance.accepted_content_hash = legal_version.content_hash
      where profile.id = studio.owner_user_id
        and profile.status = 'active'
        and profile.completed_at is not null
        and owner.status = 'active'
        and legal_version.kind = 'owner_contract'
        and legal_version.effective_at <= pg_catalog.now()
        and (
          legal_version.retired_at is null
          or pg_catalog.now() < legal_version.retired_at
        )
    );
$function$;

alter function public.get_owner_studio_editor(uuid) owner to postgres;

revoke all on function public.get_owner_studio_editor(uuid)
  from public, anon, authenticated, service_role, app_dal;
grant execute on function public.get_owner_studio_editor(uuid) to authenticated;

comment on function public.get_owner_studio_editor(uuid) is
  'Editor privado limitado ao auth.uid elegível, com perfil completo, dono ativo e contrato vigente aceito.';

create or replace function private.list_backoffice_users(
  p_actor_user_id uuid,
  p_auth_session_id uuid,
  p_auth_expires_at timestamptz,
  p_query text,
  p_cursor_created_at timestamptz,
  p_cursor_id uuid,
  p_limit integer
)
returns table (
  account_version bigint,
  created_at timestamptz,
  email_masked text,
  id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_query text := nullif(pg_catalog.btrim(p_query), '');
begin
  perform private.backoffice_session_context(
    p_actor_user_id,
    p_auth_session_id,
    p_auth_expires_at,
    null,
    false,
    true
  );
  if (p_cursor_created_at is null) <> (p_cursor_id is null)
    or p_limit is null
    or p_limit < 1
    or p_limit > 51
    or (normalized_query is not null and pg_catalog.char_length(normalized_query) > 160)
  then
    raise exception using errcode = '22023', message = 'invalid_backoffice_user_query';
  end if;

  return query
  select
    profile.account_version,
    profile.created_at,
    private.mask_backoffice_email(auth_user.email),
    profile.id,
    profile.status
  from public.profiles as profile
  join auth.users as auth_user on auth_user.id = profile.id
  where auth_user.email is not null
    and (
      normalized_query is null
      or pg_catalog.starts_with(
        pg_catalog.lower(auth_user.email),
        pg_catalog.lower(normalized_query)
      )
      or profile.id::text = pg_catalog.lower(normalized_query)
    )
    and (
      p_cursor_created_at is null
      or (profile.created_at, profile.id) < (p_cursor_created_at, p_cursor_id)
    )
  order by profile.created_at desc, profile.id desc
  limit p_limit;
end;
$function$;

alter function private.list_backoffice_users(
  uuid, uuid, timestamptz, text, timestamptz, uuid, integer
) owner to postgres;

revoke all on function private.list_backoffice_users(
  uuid, uuid, timestamptz, text, timestamptz, uuid, integer
) from public, anon, authenticated, service_role, app_dal;
grant execute on function private.list_backoffice_users(
  uuid, uuid, timestamptz, text, timestamptz, uuid, integer
) to app_dal;

comment on function private.list_backoffice_users(
  uuid, uuid, timestamptz, text, timestamptz, uuid, integer
) is 'Diretório privado paginado: busca somente por prefixo de e-mail ou UUID exato e nunca avalia nome bruto.';
