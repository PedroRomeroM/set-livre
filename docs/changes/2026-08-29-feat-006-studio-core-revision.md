# FEAT-006 — núcleo e revisões de estúdio

## Estado

Em andamento na branch `codex/platform-foundation-batch`. Este registro não declara conclusão:
faltam commit, PR, review limpo no SHA atual, merge e deploy monitorado.

## Mudança

- adiciona `studio_types`, `studios`, `studio_revisions` e o ledger privado mínimo de idempotência;
- implementa criação, atualização/clone e descarte por três funções SQL privadas atômicas;
- revalida perfil, autoridade de dono e contrato vigente antes inclusive de replay;
- aplica grants mínimos, RLS por `auth.uid()`, imutabilidade e ponteiros/revisões canônicos;
- adiciona read models estritos para tipos ativos e editor do próprio dono;
- entrega `/dono/estudios/novo` e `/dono/estudios/[studioId]/dados`, preview local, validação,
  conflito comparável, descarte confirmado e boundary integral de hidratação;
- adiciona `Textarea` à UI compartilhada e invalidação/cache privado por usuário + estúdio;
- habilita runner pgTAP efêmero sem bind mount no Windows e restaura artefatos Playwright em falhas.

## Evidência local atual

- reset do Supabase do zero, lint sem warnings nos schemas próprios e 6 arquivos/264 testes SQL verdes;
- 69 arquivos/678 testes unitários verdes, com 3 skips condicionais previstos;
- formatação, documentação, imutabilidade de migrations, ESLint, typecheck, audit sem vulnerabilidades e
  Knip verdes;
- build standalone de web e backoffice verde;
- matriz FEAT-006 final com 24/24 execuções Playwright verdes em 2,9 minutos;
- teardown com quiescência comprovada, sem `404/503` artificiais; somente os `409` de conflito e `404`
  deliberados do isolamento entre donos apareceram no log.

## Operação e rollback

Antes do merge não há rollback externo: a branch pode ser descartada. Depois de aplicada, a migration
é append-only e não deve ser revertida manualmente; regressão exige nova migration corretiva e novo PR.
As superfícies ainda não são públicas e não alteram conteúdo já servido em produção até o deploy.
