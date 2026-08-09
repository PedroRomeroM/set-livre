# FEAT-023 — Webhooks, idempotência, reconciliação e retentativa

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `payments-ops` |
| Specs Playwright | `tests/e2e/critical/feat-023-payment-webhooks-reconciliation.spec.ts`<br>`tests/e2e/regression/feat-023-payment-webhooks-reconciliation.spec.ts` |

## Objetivo

Transformar eventos externos em estados internos consistentes, mesmo duplicados, atrasados ou fora de ordem.

## Papéis

- sistema
- finance/admin

## Rotas e superfícies

- /api/webhooks/payments/[provider]

## Dependências

- FEAT-021
- FEAT-022

## Incluído

- Assinatura e proteção contra replay.
- Event store.
- Mapping.
- Processamento idempotente.
- Worker de reconciliação.
- Backoff.
- Retentativa operacional manual.
- Alerts.

## Fora desta feature

- confiar no browser
- guardar payload bruto indefinidamente

## Regras de produto e domínio

- External event unique.
- O mesmo evento retorna 2xx sem duplicar efeitos.
- Um evento fora de ordem pode exigir consulta ao provider.
- Amount/currency mismatch blocks.
- Terminal states not downgraded.
- O worker reivindica trabalhos com segurança.

## Dados canônicos afetados

- webhook_events
- payment_events
- payments
- job heartbeat

## Read models

- leituras operacionais de pagamento do admin

## Comandos e integrações

- processamento privado de evento de pagamento
- retentativa administrativa

## UX e estados obrigatórios

- O backoffice mostra estado seguro e referência de request/evento.
- Sem payload sensível.
- Retentativa com feedback.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- A assinatura é validada sobre os bytes brutos.
- Timestamp.
- Redação de dados sensíveis.
- Idempotency.
- Rate/size.

## Critérios de aceitação

- Assinaturas válidas e inválidas.
- Duplicidade.
- Out of order.
- Mismatch.
- A reconciliação recupera webhook ausente.
- A retentativa não duplica efeitos.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F023-E2E-001 | P0 | critical | desktop | webhook válido confirma e duplicado é idempotente | `tests/e2e/critical/feat-023-payment-webhooks-reconciliation.spec.ts` |
| SL-F023-E2E-002 | P0 | critical | desktop | assinatura/replay inválidos são rejeitados | `tests/e2e/critical/feat-023-payment-webhooks-reconciliation.spec.ts` |
| SL-F023-E2E-003 | P0 | critical | desktop | evento fora de ordem não regride estado | `tests/e2e/critical/feat-023-payment-webhooks-reconciliation.spec.ts` |
| SL-F023-E2E-004 | P0 | critical | desktop | divergência de valor bloqueia reserva e gera alerta | `tests/e2e/critical/feat-023-payment-webhooks-reconciliation.spec.ts` |
| SL-F023-E2E-005 | P0 | critical | desktop | reconciliação recupera webhook ausente | `tests/e2e/critical/feat-023-payment-webhooks-reconciliation.spec.ts` |
| SL-F023-E2E-006 | P1 | regression | desktop | retentativa administrativa mantém auditoria | `tests/e2e/regression/feat-023-payment-webhooks-reconciliation.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: event mapping/state precedence
- banco: unique/idempotency
- integração: signature fixtures
- backoff do worker

## Documentação viva afetada

- payments.md
- observability.md
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
