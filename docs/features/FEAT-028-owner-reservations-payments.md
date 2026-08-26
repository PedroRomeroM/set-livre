# FEAT-028 — Reservas, agenda financeira e repasses do dono

## Metadados

| Campo            | Valor                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                                                |
| Prioridade       | P0                                                                                                                                       |
| Domínio          | `owners-ops`                                                                                                                             |
| Specs Playwright | `tests/e2e/critical/feat-028-owner-reservations-payments.spec.ts`<br>`tests/e2e/regression/feat-028-owner-reservations-payments.spec.ts` |

## Objetivo

Oferecer ao dono operação das reservas de seus estúdios e visibilidade financeira permitida.

## Papéis

- dono

## Rotas e superfícies

- /dono/reservas
- /dono/pagamentos
- /dono/recebimentos

## Dependências

- FEAT-024
- FEAT-026

## Incluído

- Filtros por estúdio, data e status.
- Cursor.
- Reservation detail seguro.
- Upcoming.
- Status de pagamento e repasse.
- Totals scoped.
- Solicitação de cancelamento ao suporte.

## Fora desta feature

- dados completos do cartão
- editar reserva
- relatório BI

## Regras de produto e domínio

- Dono vê dados operacionais mínimos do locatário: nome/contato apenas quando necessário e conforme política.
- Valores financeiros usam snapshot.
- Status payout factual.
- No direct refund.
- Filtro por múltiplos estúdios.

## Dados canônicos afetados

- reservations/payments/payouts safe projections

## Read models

- `list_owner_reservations`
- `list_owner_payments`

## Comandos e integrações

- reservation.owner.cancelRequest

## UX e estados obrigatórios

- Desktop dense rows.
- Mobile cards.
- Filters URL.
- Status badges.
- Contact disclosure explained.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Ownership via studio.
- Minimização de dados pessoais.
- Export not baseline.
- Sem IDs internos do provider.

## Critérios de aceitação

- Dono sees own.
- Filter/cursor.
- Payment/payout statuses.
- Other owner denied.
- A solicitação de cancelamento cria caso de suporte e auditoria.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                               | Spec                                                                |
| --------------- | ---------- | ---------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| SL-F028-E2E-001 | P0         | critical   | desktop  | dono lista reservas de múltiplos estúdios             | `tests/e2e/critical/feat-028-owner-reservations-payments.spec.ts`   |
| SL-F028-E2E-002 | P0         | critical   | desktop  | dono vê financeiro correto sem provider IDs           | `tests/e2e/critical/feat-028-owner-reservations-payments.spec.ts`   |
| SL-F028-E2E-003 | P0         | critical   | desktop  | dono A não vê B                                       | `tests/e2e/critical/feat-028-owner-reservations-payments.spec.ts`   |
| SL-F028-E2E-004 | P1         | regression | mobile   | filtros e cards                                       | `tests/e2e/regression/feat-028-owner-reservations-payments.spec.ts` |
| SL-F028-E2E-005 | P1         | regression | desktop  | solicitação de cancelamento entra no fluxo de suporte | `tests/e2e/regression/feat-028-owner-reservations-payments.spec.ts` |
| SL-F028-E2E-006 | P1         | regression | desktop  | PII limitada/mascarada conforme estado                | `tests/e2e/regression/feat-028-owner-reservations-payments.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: owner projections/RLS
- unitário: financial DTO
- privacy tests

## Documentação viva afetada

- security-privacy.md
- ux-blueprint.md
- qa-test-plan.md

Enquanto este plano existir, qualquer mudança de escopo atualiza este arquivo e o catálogo QA.

## Definition of Done da feature

- todos os critérios acima comprovados;
- migration/grants/RLS verdes quando aplicável;
- read model/command e invalidação documentados;
- Playwright listado e verde;
- desktop/mobile/teclado/axe verificados;
- logs e métricas necessários;
- rollback/correção definidos;
- nenhuma funcionalidade fora de escopo introduzida.
