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
  )
on conflict do nothing;
