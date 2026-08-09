# FEAT-024 — Confirmação e ciclo de vida da reserva

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `reservations` |
| Specs Playwright | `tests/e2e/critical/feat-024-reservation-lifecycle.spec.ts`<br>`tests/e2e/regression/feat-024-reservation-lifecycle.spec.ts` |

## Objetivo

Criar o fato reserva somente após pagamento e manter calendário, painéis, e-mails e repasse coerentes.

## Papéis

- locatário
- dono
- sistema

## Rotas e superfícies

- /conta/reservas/[reservationId]
- /dono/reservas

## Dependências

- FEAT-023
- FEAT-029
- FEAT-026

## Incluído

- Transação de confirmação.
- Snapshot do estúdio, dono e cotação.
- Status events.
- Calendar conversion.
- Estados futura, em andamento e concluída.
- Outbox e agendamento de repasse.

## Fora desta feature

- aprovação do dono
- editar período confirmado
- reserva sem pagamento

## Regras de produto e domínio

- Um pagamento corresponde a uma reserva.
- Allocation continuity.
- O valor do pagamento é exato.
- A reserva é marcada como concluída por job idempotente após o término.
- Snapshot histórico.
- Status transitions strict.

## Dados canônicos afetados

- reservations
- status_events
- reservation_addons
- allocations
- outbox
- payout

## Read models

- read models de reservas do locatário e do dono

## Comandos e integrações

- private.confirm_paid_booking
- private.complete_reservations

## UX e estados obrigatórios

- Success page factual.
- Uma tentativa de pagamento pendente não é apresentada como reserva.
- Timeline.
- O dono visualiza a nova reserva.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- A RLS separa locatário e dono.
- O DTO contém o mínimo de dados pessoais.
- O comando é privado e idempotente.
- Anomalias são auditadas.

## Critérios de aceitação

- O pagamento aprovado cria a reserva uma única vez.
- Calendar remains occupied.
- Snapshots correct.
- Complete job.
- Unauthorized inaccessible.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F024-E2E-001 | P0 | critical | desktop | evento de pagamento aprovado cria uma reserva confirmada | `tests/e2e/critical/feat-024-reservation-lifecycle.spec.ts` |
| SL-F024-E2E-002 | P0 | critical | desktop | processamento duplicado não duplica reserva, outbox ou repasse | `tests/e2e/critical/feat-024-reservation-lifecycle.spec.ts` |
| SL-F024-E2E-003 | P0 | critical | desktop | alocação permanece contínua do hold à reserva | `tests/e2e/critical/feat-024-reservation-lifecycle.spec.ts` |
| SL-F024-E2E-004 | P0 | critical | desktop | locatário e dono veem a reserva correta; terceiro não acessa | `tests/e2e/critical/feat-024-reservation-lifecycle.spec.ts` |
| SL-F024-E2E-005 | P1 | regression | desktop | completion job transitions after end | `tests/e2e/regression/feat-024-reservation-lifecycle.spec.ts` |
| SL-F024-E2E-006 | P1 | regression | mobile | sucesso e linha do tempo do detalhe são acessíveis | `tests/e2e/regression/feat-024-reservation-lifecycle.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: transação de confirmação, invariantes e RLS
- unitário: status transition/snapshot
- job completion

## Documentação viva afetada

- domain-model.md
- calendar-reservations.md
- notifications.md
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
