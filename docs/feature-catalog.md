# Catálogo de features

## Regra

Cada feature possui documento próprio, cenários com IDs estáveis e um ou mais arquivos Playwright concretos. O status de automação é rastreado em `docs/qa-traceability.md`.

| ID | Feature | Prioridade | Domínio | Documento | Specs Playwright |
|---|---|:---:|---|---|---|
| FEAT-001 | Shell público e home | P0 | `public-web` | `docs/features/FEAT-001-public-shell-home.md` | `tests/e2e/smoke/feat-001-public-shell-home.spec.ts`<br>`tests/e2e/critical/feat-001-public-shell-home.spec.ts`<br>`tests/e2e/regression/feat-001-public-shell-home.spec.ts` |
| FEAT-002 | Cadastro, confirmação, login, logout e recuperação | P0 | `identity` | `docs/features/FEAT-002-authentication.md` | `tests/e2e/critical/feat-002-authentication.spec.ts`<br>`tests/e2e/regression/feat-002-authentication.spec.ts` |
| FEAT-003 | Perfil PF/PJ, conta e preferências | P0 | `identity` | `docs/features/FEAT-003-profile-account.md` | `tests/e2e/critical/feat-003-profile-account.spec.ts`<br>`tests/e2e/regression/feat-003-profile-account.spec.ts` |
| FEAT-004 | Ativação de dono e onboarding de recebedor | P0 | `owners-payments` | `docs/features/FEAT-004-owner-onboarding-recipient.md` | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`<br>`tests/e2e/regression/feat-004-owner-onboarding-recipient.spec.ts` |
| FEAT-005 | Dashboard do dono e portfólio de estúdios | P0 | `owners` | `docs/features/FEAT-005-owner-dashboard-portfolio.md` | `tests/e2e/critical/feat-005-owner-dashboard-portfolio.spec.ts`<br>`tests/e2e/regression/feat-005-owner-dashboard-portfolio.spec.ts` |
| FEAT-006 | Criação do estúdio e dados centrais versionados | P0 | `studios` | `docs/features/FEAT-006-studio-core-revision.md` | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`<br>`tests/e2e/regression/feat-006-studio-core-revision.spec.ts` |
| FEAT-007 | Tags, comodidades, regras, FAQ e vídeo | P0 | `studios` | `docs/features/FEAT-007-studio-taxonomy-content.md` | `tests/e2e/critical/feat-007-studio-taxonomy-content.spec.ts`<br>`tests/e2e/regression/feat-007-studio-taxonomy-content.spec.ts` |
| FEAT-008 | Galeria de fotos, capa e ordenação | P0 | `media` | `docs/features/FEAT-008-studio-media.md` | `tests/e2e/critical/feat-008-studio-media.spec.ts`<br>`tests/e2e/regression/feat-008-studio-media.spec.ts` |
| FEAT-009 | Envio, status, edição, pausa e publicação | P0 | `studios` | `docs/features/FEAT-009-studio-publication-workflow.md` | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`<br>`tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts` |
| FEAT-010 | Listagem, filtros, ordenação e cursor | P0 | `public-web` | `docs/features/FEAT-010-public-listing.md` | `tests/e2e/critical/feat-010-public-listing.spec.ts`<br>`tests/e2e/regression/feat-010-public-listing.spec.ts` |
| FEAT-011 | Detalhe público, galeria e SEO | P0 | `public-web` | `docs/features/FEAT-011-public-studio-detail-seo.md` | `tests/e2e/smoke/feat-011-public-studio-detail-seo.spec.ts`<br>`tests/e2e/critical/feat-011-public-studio-detail-seo.spec.ts`<br>`tests/e2e/regression/feat-011-public-studio-detail-seo.spec.ts` |
| FEAT-012 | Horário semanal e regras básicas de disponibilidade | P0 | `calendar` | `docs/features/FEAT-012-weekly-availability.md` | `tests/e2e/critical/feat-012-weekly-availability.spec.ts`<br>`tests/e2e/regression/feat-012-weekly-availability.spec.ts` |
| FEAT-013 | Exceções, bloqueios, buffer e duração | P0 | `calendar` | `docs/features/FEAT-013-calendar-exceptions-blocks.md` | `tests/e2e/critical/feat-013-calendar-exceptions-blocks.spec.ts`<br>`tests/e2e/regression/feat-013-calendar-exceptions-blocks.spec.ts` |
| FEAT-014 | Calendário avançado semana/mês/dia e drag-and-drop | P0 | `calendar-ui` | `docs/features/FEAT-014-advanced-calendar.md` | `tests/e2e/critical/feat-014-advanced-calendar.spec.ts`<br>`tests/e2e/regression/feat-014-advanced-calendar.spec.ts` |
| FEAT-015 | Importação/exportação iCal e agenda consolidada | P1 | `calendar-integrations` | `docs/features/FEAT-015-ical-consolidated.md` | `tests/e2e/regression/feat-015-ical-consolidated.spec.ts`<br>`tests/e2e/critical/feat-015-ical-consolidated.spec.ts` |
| FEAT-016 | Preço base e multiplicadores por dia/faixa | P0 | `pricing` | `docs/features/FEAT-016-pricing.md` | `tests/e2e/critical/feat-016-pricing.spec.ts`<br>`tests/e2e/regression/feat-016-pricing.spec.ts` |
| FEAT-017 | Adicionais por unidade | P0 | `pricing` | `docs/features/FEAT-017-addons.md` | `tests/e2e/critical/feat-017-addons.spec.ts`<br>`tests/e2e/regression/feat-017-addons.spec.ts` |
| FEAT-018 | Configuração de reserva e cotação autoritativa | P0 | `booking` | `docs/features/FEAT-018-reservation-configurator-quote.md` | `tests/e2e/critical/feat-018-reservation-configurator-quote.spec.ts`<br>`tests/e2e/regression/feat-018-reservation-configurator-quote.spec.ts` |
| FEAT-019 | Retorno pós-login e restauração de intenção | P0 | `booking-auth` | `docs/features/FEAT-019-auth-return-draft.md` | `tests/e2e/critical/feat-019-auth-return-draft.spec.ts`<br>`tests/e2e/regression/feat-019-auth-return-draft.spec.ts` |
| FEAT-020 | Início de pagamento, hold e concorrência | P0 | `booking-core` | `docs/features/FEAT-020-payment-start-hold.md` | `tests/e2e/critical/feat-020-payment-start-hold.spec.ts` |
| FEAT-021 | Pagamento com cartão | P0 | `payments` | `docs/features/FEAT-021-card-payment.md` | `tests/e2e/critical/feat-021-card-payment.spec.ts`<br>`tests/e2e/regression/feat-021-card-payment.spec.ts` |
| FEAT-022 | Pagamento com PIX | P0 | `payments` | `docs/features/FEAT-022-pix-payment.md` | `tests/e2e/critical/feat-022-pix-payment.spec.ts`<br>`tests/e2e/regression/feat-022-pix-payment.spec.ts` |
| FEAT-023 | Webhooks, idempotência, reconciliação e retentativa | P0 | `payments-ops` | `docs/features/FEAT-023-payment-webhooks-reconciliation.md` | `tests/e2e/critical/feat-023-payment-webhooks-reconciliation.spec.ts`<br>`tests/e2e/regression/feat-023-payment-webhooks-reconciliation.spec.ts` |
| FEAT-024 | Confirmação e ciclo de vida da reserva | P0 | `reservations` | `docs/features/FEAT-024-reservation-lifecycle.md` | `tests/e2e/critical/feat-024-reservation-lifecycle.spec.ts`<br>`tests/e2e/regression/feat-024-reservation-lifecycle.spec.ts` |
| FEAT-025 | Cancelamento e reembolso total | P0 | `reservations-payments` | `docs/features/FEAT-025-cancellation-refund.md` | `tests/e2e/critical/feat-025-cancellation-refund.spec.ts`<br>`tests/e2e/regression/feat-025-cancellation-refund.spec.ts` |
| FEAT-026 | Split 80/20, agenda de repasse e fallback | P0 | `finance` | `docs/features/FEAT-026-split-payout.md` | `tests/e2e/critical/feat-026-split-payout.spec.ts`<br>`tests/e2e/regression/feat-026-split-payout.spec.ts` |
| FEAT-027 | Área do locatário e detalhes da reserva | P0 | `renter` | `docs/features/FEAT-027-renter-reservations.md` | `tests/e2e/critical/feat-027-renter-reservations.spec.ts`<br>`tests/e2e/regression/feat-027-renter-reservations.spec.ts` |
| FEAT-028 | Reservas, agenda financeira e repasses do dono | P0 | `owners-ops` | `docs/features/FEAT-028-owner-reservations-payments.md` | `tests/e2e/critical/feat-028-owner-reservations-payments.spec.ts`<br>`tests/e2e/regression/feat-028-owner-reservations-payments.spec.ts` |
| FEAT-029 | E-mails transacionais, outbox e lembretes | P0 | `notifications` | `docs/features/FEAT-029-transactional-email.md` | `tests/e2e/critical/feat-029-transactional-email.spec.ts`<br>`tests/e2e/regression/feat-029-transactional-email.spec.ts` |
| FEAT-030 | Backoffice de revisão e moderação de estúdios | P0 | `backoffice` | `docs/features/FEAT-030-backoffice-studio-review.md` | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`<br>`tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`<br>`tests/e2e/smoke/feat-030-backoffice-studio-review.spec.ts` |
| FEAT-031 | Usuários, papéis e taxonomias no backoffice | P0 | `backoffice` | `docs/features/FEAT-031-backoffice-users-taxonomy.md` | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`<br>`tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts` |
| FEAT-032 | Financeiro, reembolso, repasse e exportação fiscal | P0 | `backoffice-finance` | `docs/features/FEAT-032-backoffice-finance-fiscal.md` | `tests/e2e/critical/feat-032-backoffice-finance-fiscal.spec.ts`<br>`tests/e2e/regression/feat-032-backoffice-finance-fiscal.spec.ts` |
| FEAT-033 | Operação, saúde, jobs e auditoria | P0 | `operations` | `docs/features/FEAT-033-backoffice-operations-audit.md` | `tests/e2e/critical/feat-033-backoffice-operations-audit.spec.ts`<br>`tests/e2e/regression/feat-033-backoffice-operations-audit.spec.ts` |
| FEAT-034 | Documentos legais, consentimento, exportação e exclusão | P0 | `privacy` | `docs/features/FEAT-034-lgpd-legal-data-rights.md` | `tests/e2e/critical/feat-034-lgpd-legal-data-rights.spec.ts`<br>`tests/e2e/regression/feat-034-lgpd-legal-data-rights.spec.ts` |

## Resumo

- Features: **34**.
- Cenários Playwright catalogados: **193**.
- Prioridade: **134 P0**, **59 P1**, **0 P2**.
- Suítes: **3 smoke**, **131 critical**, **59 regression**.
- Viewports primários: **162 desktop**, **31 mobile**; a matriz responsiva adicional está em `docs/qa-test-plan.md`.

## Uso

1. Implementar features na ordem de `docs/implementation-order.md`.
2. Ler o documento da feature e seus ADRs/dependências.
3. Criar os arquivos Playwright listados, sem consolidar cenários de suítes diferentes em caminho incorreto.
4. Atualizar o status em `docs/qa-traceability.md` no mesmo PR.
5. Não marcar uma feature como concluída enquanto todos os cenários P0 aplicáveis estiverem verdes.
