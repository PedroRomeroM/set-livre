# Plano de migrations

## Regras

- nomes com timestamp/ordem e intenção;
- append-only;
- uma mudança coerente por migration;
- data backfill separado quando volumoso;
- toda migration possui testes;
- expand/migrate/contract em produção.

## Sequência inicial sugerida

O repositório materializa essa sequência por migrations timestampadas e append-only, sem renomear as já aplicadas. A fundação ocupa oito migrations até `20260811000100`; a FEAT-002 adiciona `20260811000200_authentication_legal_core.sql`, que corresponde somente ao perfil mínimo, termos/aceites, intenção privada, grant de recovery durável no banco e expirável, read models e hardening do manifesto DAL. A correção append-only `20260811000300_authentication_review_hardening.sql` habilita RLS na intenção privada e impede release de grant já expirado. A migration `20260811000400_recovery_session_binding.sql` vincula o grant ao `session_id` assinado e à linha canônica de `auth.sessions`, conserva uma binding/tombstone depois do grant, exige `jwt_exp=3600` e invalida os grants anteriores sem `session_id`; como a cadeia ainda não foi aplicada em ambiente remoto, o primeiro deploy executa todas as migrations antes de expor o app e links anteriores exigem nova solicitação. As tabelas pessoais completas previstas no item lógico 3 continuam pertencendo à FEAT-003.

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
