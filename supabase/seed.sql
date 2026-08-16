-- FEAT-002 usa estas versões somente no Supabase local. O source e o próprio
-- texto impedem que a fixture seja confundida com conteúdo jurídico aprovado.
insert into public.terms_versions (
  id,
  kind,
  version,
  title,
  body_markdown,
  source,
  effective_at
)
values
  (
    '00000000-0000-4000-8000-000000000201',
    'terms',
    'local-2026-08-01',
    'Termos de uso — fixture local',
    E'# Termos de uso — fixture local\n\nConteúdo exclusivo para desenvolvimento e testes locais. Não constitui texto jurídico aprovado para produção.',
    'local_fixture',
    '2026-08-01 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-000000000202',
    'privacy',
    'local-2026-08-01',
    'Privacidade — fixture local',
    E'# Privacidade — fixture local\n\nConteúdo exclusivo para desenvolvimento e testes locais. Não constitui política de privacidade aprovada para produção.',
    'local_fixture',
    '2026-08-01 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-000000000204',
    'owner_contract',
    'local-2026-08-12',
    'Contrato do dono — fixture local',
    E'# Contrato do dono — fixture local\n\nConteúdo exclusivo para desenvolvimento e testes locais. Não constitui contrato jurídico aprovado para produção.',
    'local_fixture',
    '2026-08-12 00:00:00+00'
  )
on conflict do nothing;

-- FEAT-006 usa estes tipos somente no Supabase local. Produção começa com a
-- taxonomia vazia e depende de cadastro administrativo factual posterior.
insert into public.studio_types (
  id,
  name,
  slug,
  description,
  active,
  sort_order
)
values
  (
    '00000000-0000-4000-8000-000000000601',
    'Fotografia',
    'fotografia',
    'Fixture local de tipo de estúdio para desenvolvimento e testes.',
    true,
    10
  ),
  (
    '00000000-0000-4000-8000-000000000602',
    'Vídeo',
    'video',
    'Fixture local de tipo de estúdio para desenvolvimento e testes.',
    true,
    20
  ),
  (
    '00000000-0000-4000-8000-000000000603',
    'Podcast',
    'podcast',
    'Fixture local de tipo de estúdio para desenvolvimento e testes.',
    true,
    30
  ),
  (
    '00000000-0000-4000-8000-000000000604',
    'Multifuncional',
    'multifuncional',
    'Fixture local de tipo de estúdio para desenvolvimento e testes.',
    true,
    40
  )
on conflict do nothing;
