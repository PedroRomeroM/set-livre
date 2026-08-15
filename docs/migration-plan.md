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

O primeiro review draft da FEAT-004 exigiu separar o documento jurídico da leitura operacional. A correção entra exclusivamente por `20260812000200_owner_recipient_projection_split.sql`, a décima quarta migration append-only: a função completa anterior é renomeada para `get_owner_activation_status()` e uma nova `get_owner_recipient_status()` compacta retorna 16 colunas, sem título, versão textual, hash ou corpo Markdown; ativação conserva 21. Grants permanecem restritos a `authenticated`, e nenhuma rotina privada é acrescentada à DAL/readiness. Naquela fotografia histórica, Node 24 executou reset, geração e `test:db` com 355/355 asserts no head `20260812000200`; readiness aceitou esse head e recusou `20260812000100`, e os artefatos gerados autoritativos ficaram sincronizados. As 13 migrations anteriores, inclusive `20260812000100`, não foram editadas.

O terceiro P2 da FEAT-004 é corrigido exclusivamente por `20260815000100_owner_audit_request_correlation.sql`, a décima quinta migration append-only. Ela preserva `20260812000100`/`20260812000200`, acrescenta `audit.events.idempotency_key NOT NULL`, move a unicidade de `(action, target_id, request_id)` para `(action, target_id, idempotency_key)` e substitui as assinaturas privadas de ativação/aplicação para receber correlação e chave lógica separadamente. O backfill copia o antigo `request_id` — que continha a chave idempotente — para a nova coluna, sem reescrever nem alegar recuperar o request ID histórico verdadeiro. Um único reset, geração e `test:db` passou em 358/358 (`158 + 78 + 57 + 65`) no head `20260815000100`; readiness aceita o atual, recusa `20260812000200`, os overloads antigos estão ausentes, os novos grants são exatos, o trigger permanece habilitado, gerados/diff estão limpos e as tabelas terminam em zero. O fechamento precommit também passou os gates estáticos, 718/718 unitários, browser corrigido 114/114, build e smoke customizado; a release canônica local final do commit funcional `2a86acc4dc3a005213d5f22384084e3aba0160be` contém as 15 migrations no mesmo head e recebeu duas auditorias independentes `NO-BLOCKER`. Commit documental deste fechamento, se houver, publicação do novo HEAD e ciclo final de review ainda estão pendentes. A release `440c81f6...`, com 14 migrations, permanece histórica para esse delta, e a prova x64 não substitui ARM64.

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
