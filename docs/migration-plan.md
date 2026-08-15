# Plano de migrations

## Regras

- nomes com timestamp/ordem e intenção;
- append-only;
- uma mudança coerente por migration;
- data backfill separado quando volumoso;
- toda migration possui testes;
- expand/migrate/contract em produção.

## Sequência inicial sugerida

O repositório materializa essa sequência por migrations timestampadas e append-only, sem renomear as já aplicadas. A fundação ocupa oito migrations até `20260811000100`; a FEAT-002 adiciona `20260811000200_authentication_legal_core.sql`, que corresponde somente ao perfil mínimo, termos/aceites, intenção privada, grant de recovery durável no banco e expirável, read models e hardening do manifesto DAL. A correção append-only `20260811000300_authentication_review_hardening.sql` habilita RLS na intenção privada e impede release de grant já expirado. A migration `20260811000400_recovery_session_binding.sql` vincula o grant ao `session_id` assinado e à linha canônica de `auth.sessions`, conserva uma binding/tombstone depois do grant, exige `jwt_exp=3600` e invalida os grants anteriores sem `session_id`.

A FEAT-003 adiciona somente `20260811000500_profile_account.sql`: expande `profiles`, cria `user_preferences`, validadores documentais, máscaras, versões otimistas, o read model público invoker e três comandos privados. A allowlist DAL passa a doze rotinas/treze dependências; o helper de retorno dos comandos não recebe grant. Nenhuma migration aplicada anterior é alterada. Como a cadeia ainda não foi aplicada em ambiente remoto, o primeiro deploy executa todas as migrations antes de expor o app; links de recovery anteriores à binding exigem nova solicitação.

A FEAT-004 acrescenta `20260812000100_owner_onboarding_recipient.sql` como a décima terceira migration append-only. Ela materializa `owner_contract`, autoridade de dono, projeção segura do recebedor, referências/operações privadas e auditoria mínima; preserva `get_current_legal_terms()` em exatamente `terms | privacy`, cria leitura autenticada específica do contrato do dono e amplia o manifesto DAL/readiness somente para dezesseis rotinas e dezessete dependências ACL. O adapter local é chamado fora da transação entre uma preparação idempotente e uma aplicação condicional cercada por sequência; nenhuma migration anterior foi editada. Reset e geração passaram no head novo, e as quatro suítes pgTAP passaram em 355/355 asserts (`158 + 78 + 57 + 62`).

O primeiro review draft da FEAT-004 exigiu separar o documento jurídico da leitura operacional. A correção entra exclusivamente por `20260812000200_owner_recipient_projection_split.sql`, a décima quarta migration append-only: a função completa anterior é renomeada para `get_owner_activation_status()` e uma nova `get_owner_recipient_status()` compacta retorna 16 colunas, sem título, versão textual, hash ou corpo Markdown; ativação conserva 21. Grants permanecem restritos a `authenticated`, e nenhuma rotina privada é acrescentada à DAL/readiness. Node 24 executou reset, geração e `test:db` com 355/355 asserts no head `20260812000200`; readiness aceitou o head atual e recusou `20260812000100`, e os artefatos gerados autoritativos ficaram sincronizados. As 13 migrations anteriores, inclusive `20260812000100`, não foram editadas.

O patch atual corrige somente o mapeamento HTTP de `owner_contract_not_current`, não altera schema nem exige migration. Um único reset seguido de `test:db` manteve o banco em 355/355 no head `20260812000200`, com 14 migrations, readiness e cleanup verdes. Os demais gates Node 24 passaram, inclusive 718/718 unitários em 74 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check. As matrizes focada única 23/23 e integral única 114/114, o build único sem warnings e o smoke real padrão mais FEAT-004 também passaram sem criar migration adicional. A release canônica local do commit `440c81f6cc44cc95ed281d84e9a5124ae98a59c4` contém as mesmas 14 migrations/head `20260812000200` e inclui o patch; o commit funcional e a documentação da release em `011a48f4910baa0e17b26dee6eda3c678d910572` foram publicados. Essa publicação não comprova aplicação de migration ou checks remotos; a release `79376b62...` continua histórica.

1. `0001_extensions_and_schemas`
2. `0002_roles_and_security_baseline`
3. `0003_profiles_owner_roles_terms`
4. `0004_taxonomies`
5. `0005_studios_and_revisions`
6. `0006_studio_revision_relations_faq`
7. `0007_studio_media_and_storage_policies`
8. `0008_recipient_integrations`
9. `0009_calendar_settings_weekly_exceptions`
10. `0010_calendar_allocations_exclusion`
11. `0011_ical_batches`
12. `0012_pricing_and_addons`
13. `0013_quotes_and_items`
14. `0014_booking_attempts_holds_payments`
15. `0015_webhook_and_payment_events`
16. `0016_reservations_and_status_events`
17. `0017_refunds_payouts`
18. `0018_email_outbox`
19. `0019_fiscal_exports_audit`
20. `0020_idempotency_and_worker_heartbeats`
21. `0021_public_read_models`
22. `0022_owner_read_models`
23. `0023_backoffice_read_models`
24. `0024_private_profile_studio_commands`
25. `0025_private_calendar_pricing_commands`
26. `0026_private_booking_payment_commands`
27. `0027_private_admin_privacy_commands`
28. `0028_grants_rls_manifest_hardening`
29. `0029_seed_taxonomies_local`
30. `0030_performance_indexes_proven`

`0030` só inclui índices comprovados; índices estruturais entram junto da tabela/constraint.

## Circularidade studio/revision

Criar tabelas sem ponteiros, depois adicionar FKs `published_revision_id`/`draft_revision_id` deferrable conforme necessário. Comandos garantem revision pertence ao studio.

## Funções

Funções privadas são criadas após tabelas. `search_path=''`, objetos qualificados, grants explícitos.

## Read models

Criados após RLS/tabelas e testados com roles anon/authenticated.

## Seeds

Produção não recebe usuários/dados QA. Taxonomias iniciais entram em migration/seed estrutural aprovado. Local seed é idempotente.

## Verificação

- DB reset;
- schema diff;
- generated types;
- grants manifest;
- RLS tests;
- command tests;
- snapshot generated.
