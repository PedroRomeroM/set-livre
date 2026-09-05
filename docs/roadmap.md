# Roadmap de produto

Esta é a fonte canônica de ordem e estado. `Planejada` ainda não entrou em implementação; `Em andamento`
ainda não concluiu o candidato; `Concluída` satisfez a transição definida no
[`ADR-015`](adr/ADR-015-living-documentation-and-qa.md). O histórico de entrega permanece no PR e nos
checks.

| Ordem | ID       | Feature                             | Estado    | Depende de                                       | Plano                                                         |
| ----: | -------- | ----------------------------------- | --------- | ------------------------------------------------ | ------------------------------------------------------------- |
|     1 | FEAT-002 | Autenticação e recuperação          | Concluída | —                                                | —                                                             |
|     2 | FEAT-003 | Perfil, conta e preferências        | Concluída | FEAT-002                                         | —                                                             |
|     3 | FEAT-004 | Ativação de dono e recebedor        | Concluída | FEAT-003                                         | —                                                             |
|     4 | FEAT-006 | Núcleo e revisões de estúdio        | Concluída | FEAT-003, FEAT-004                               | —                                                             |
|     5 | FEAT-007 | Taxonomias e conteúdo de estúdio    | Concluída | FEAT-006                                         | —                                                             |
|     6 | FEAT-031 | Backoffice de usuários e taxonomias | Concluída | FEAT-003, FEAT-007                               | —                                                             |
|     7 | FEAT-008 | Mídia de estúdio                    | Concluída | FEAT-006                                         | —                                                             |
|     8 | FEAT-009 | Submissão e controle editorial      | Concluída | FEAT-006, FEAT-007, FEAT-008                     | —                                                             |
|     9 | FEAT-030 | Backoffice de revisão de estúdio    | Concluída | FEAT-008, FEAT-009                               | —                                                             |
|    10 | FEAT-012 | Disponibilidade semanal             | Planejada | FEAT-006                                         | [plano](features/FEAT-012-weekly-availability.md)             |
|    11 | FEAT-013 | Exceções e bloqueios de agenda      | Planejada | FEAT-012                                         | [plano](features/FEAT-013-calendar-exceptions-blocks.md)      |
|    12 | FEAT-016 | Precificação                        | Planejada | FEAT-006, FEAT-012                               | [plano](features/FEAT-016-pricing.md)                         |
|    13 | FEAT-017 | Adicionais                          | Planejada | FEAT-006                                         | [plano](features/FEAT-017-addons.md)                          |
|    14 | FEAT-010 | Listagem pública                    | Planejada | FEAT-009, FEAT-012, FEAT-016                     | [plano](features/FEAT-010-public-listing.md)                  |
|    15 | FEAT-011 | Detalhe público e SEO               | Planejada | FEAT-008, FEAT-009, FEAT-012, FEAT-016           | [plano](features/FEAT-011-public-studio-detail-seo.md)        |
|    16 | FEAT-001 | Shell público e home                | Planejada | FEAT-002, FEAT-010, FEAT-011                     | [plano](features/FEAT-001-public-shell-home.md)               |
|    17 | FEAT-018 | Configurador e cotação              | Planejada | FEAT-011, FEAT-012, FEAT-013, FEAT-016, FEAT-017 | [plano](features/FEAT-018-reservation-configurator-quote.md)  |
|    18 | FEAT-019 | Retorno pós-login e intenção        | Planejada | FEAT-002, FEAT-018                               | [plano](features/FEAT-019-auth-return-draft.md)               |
|    19 | FEAT-020 | Início de pagamento e hold          | Planejada | FEAT-004, FEAT-018, FEAT-019                     | [plano](features/FEAT-020-payment-start-hold.md)              |
|    20 | FEAT-021 | Pagamento com cartão                | Planejada | FEAT-020                                         | [plano](features/FEAT-021-card-payment.md)                    |
|    21 | FEAT-022 | Pagamento com PIX                   | Planejada | FEAT-020                                         | [plano](features/FEAT-022-pix-payment.md)                     |
|    22 | FEAT-023 | Webhooks e reconciliação            | Planejada | FEAT-021, FEAT-022                               | [plano](features/FEAT-023-payment-webhooks-reconciliation.md) |
|    23 | FEAT-024 | Ciclo de vida da reserva            | Planejada | FEAT-023                                         | [plano](features/FEAT-024-reservation-lifecycle.md)           |
|    24 | FEAT-014 | Calendário avançado                 | Planejada | FEAT-012, FEAT-013, FEAT-024                     | [plano](features/FEAT-014-advanced-calendar.md)               |
|    25 | FEAT-015 | iCal e agenda consolidada           | Planejada | FEAT-014                                         | [plano](features/FEAT-015-ical-consolidated.md)               |
|    26 | FEAT-025 | Cancelamento e reembolso            | Planejada | FEAT-023, FEAT-024                               | [plano](features/FEAT-025-cancellation-refund.md)             |
|    27 | FEAT-026 | Split e repasse                     | Planejada | FEAT-004, FEAT-024                               | [plano](features/FEAT-026-split-payout.md)                    |
|    28 | FEAT-029 | Notificações transacionais          | Planejada | FEAT-009, FEAT-024, FEAT-025, FEAT-026           | [plano](features/FEAT-029-transactional-email.md)             |
|    29 | FEAT-005 | Dashboard do dono                   | Planejada | FEAT-004, FEAT-006                               | [plano](features/FEAT-005-owner-dashboard-portfolio.md)       |
|    30 | FEAT-027 | Reservas do locatário               | Planejada | FEAT-024, FEAT-025                               | [plano](features/FEAT-027-renter-reservations.md)             |
|    31 | FEAT-028 | Operação financeira do dono         | Planejada | FEAT-024, FEAT-026                               | [plano](features/FEAT-028-owner-reservations-payments.md)     |
|    32 | FEAT-032 | Backoffice financeiro               | Planejada | FEAT-023, FEAT-025, FEAT-026                     | [plano](features/FEAT-032-backoffice-finance-fiscal.md)       |
|    33 | FEAT-033 | Backoffice operacional e auditoria  | Planejada | FEAT-029, FEAT-031, FEAT-032                     | [plano](features/FEAT-033-backoffice-operations-audit.md)     |
|    34 | FEAT-034 | LGPD e direitos de dados            | Planejada | FEAT-002, FEAT-003, FEAT-032                     | [plano](features/FEAT-034-lgpd-legal-data-rights.md)          |

## Regra de avanço

Uma feature começa pela primeira linha `Planejada` cujas dependências estejam concluídas. Toda mudança de
estado e remoção de plano segue o `ADR-015`; dependências continuam obrigatórias mesmo quando várias
fatias compartilham o mesmo PR de fundação.
