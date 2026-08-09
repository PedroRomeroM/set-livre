# FEAT-025 — Cancelamento e reembolso total

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `reservations-payments` |
| Specs Playwright | `tests/e2e/critical/feat-025-cancellation-refund.spec.ts`<br>`tests/e2e/regression/feat-025-cancellation-refund.spec.ts` |

## Objetivo

Permitir cancelamento elegível com reembolso total e liberação segura do calendário, mantendo pendências visíveis.

## Papéis

- locatário
- dono
- finance/admin

## Rotas e superfícies

- /conta/reservas/[reservationId]
- /dono/reservas
- backoffice /reembolsos

## Dependências

- FEAT-024
- FEAT-023

## Incluído

- Cancelamento antes do início pelo locatário.
- Solicitação do dono para suporte.
- Refund automático.
- Retentativa e fallback manual.
- Liberação do calendário.
- Emails/status.

## Fora desta feature

- reembolso parcial
- políticas por estúdio
- cancelamento pós-início automático

## Regras de produto e domínio

- Total refund.
- State intermediário.
- Payout bloqueado.
- Network call fora de transação longa.
- Uma falha permanece pendente.
- Após o início, somente o backoffice decide.
- A alocação é liberada uma única vez, quando cancelamento e reembolso atingem o ponto autoritativo definido pela saga.

## Dados canônicos afetados

- refunds
- eventos de status de reserva e pagamento
- payouts
- allocations
- outbox

## Read models

- status de reserva e reembolso

## Comandos e integrações

- reservation.cancel
- reservation.owner.cancelRequest
- admin.refund.request/retry

## UX e estados obrigatórios

- Confirmação de impacto.
- Show total.
- O estado pendente permanece visível.
- A falha oferece suporte e `requestId`.
- No optimistic 'refunded'.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Ownership e papel são validados.
- Idempotency.
- O provider é acessado somente no servidor.
- A operação manual é auditada.

## Critérios de aceitação

- Cancelamento elegível.
- After start blocked.
- Uma falha no reembolso permanece pendente.
- A retentativa pode concluir com sucesso.
- Calendar/payout correct.
- Evento duplicado não gera reembolso duplo.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F025-E2E-001 | P0 | critical | desktop | locatário cancela antes do início e recebe refund total | `tests/e2e/critical/feat-025-cancellation-refund.spec.ts` |
| SL-F025-E2E-002 | P0 | critical | desktop | cancelamento pós-início é bloqueado para usuário | `tests/e2e/critical/feat-025-cancellation-refund.spec.ts` |
| SL-F025-E2E-003 | P0 | critical | desktop | falha do provider mantém reembolso pendente e ocupação conforme a saga | `tests/e2e/critical/feat-025-cancellation-refund.spec.ts` |
| SL-F025-E2E-004 | P0 | critical | desktop | retentativa não duplica reembolso | `tests/e2e/critical/feat-025-cancellation-refund.spec.ts` |
| SL-F025-E2E-005 | P0 | critical | desktop | payout é bloqueado/cancelado | `tests/e2e/critical/feat-025-cancellation-refund.spec.ts` |
| SL-F025-E2E-006 | P1 | regression | mobile | confirmação e status pendente acessíveis | `tests/e2e/regression/feat-025-cancellation-refund.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: state locks/idempotency
- contrato de reembolso do provider
- unitário: eligibility
- integração: payout/calendar effects

## Documentação viva afetada

- payments.md
- calendar-reservations.md
- qa-test-plan.md

Toda mudança desta feature também atualiza este arquivo, o catálogo QA e `docs/changes/`.

## Definition of Done da feature

- todos os critérios acima comprovados;
- migration/grants/RLS verdes quando aplicável;
- read model/command e invalidação documentados;
- Playwright listado e verde;
- desktop/mobile/teclado/axe verificados;
- logs e métricas necessários;
- rollback/correção definidos;
- nenhuma funcionalidade fora de escopo introduzida.
