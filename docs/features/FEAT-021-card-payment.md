# FEAT-021 — Pagamento com cartão

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `payments` |
| Specs Playwright | `tests/e2e/critical/feat-021-card-payment.spec.ts`<br>`tests/e2e/regression/feat-021-card-payment.spec.ts` |

## Objetivo

Processar cartão por tokenização do provider sem armazenar dados sensíveis e confirmar somente por estado autoritativo.

## Papéis

- locatário

## Rotas e superfícies

- /checkout/[attemptId]

## Dependências

- FEAT-020
- PaymentProvider

## Incluído

- Formulário de cartão hospedado ou tokenizado pelo provider.
- Billing/customer data.
- Estados pendente, aprovado e recusado.
- 3DS quando exigido pelo provider.
- Retentativa segura.
- Status do comprovante.

## Fora desta feature

- armazenar PAN/CVV
- parcelamento se não aprovado
- cartão offline

## Regras de produto e domínio

- Server recebe token de uso limitado, nunca PAN/CVV.
- Resposta síncrona não é reserva final se webhook pendente.
- Uma recusa libera ou expira o hold conforme o provider.
- Uma retentativa cria nova tentativa.
- 3DS return allowlisted.

## Dados canônicos afetados

- payments/events
- tentativa e hold

## Read models

- status do pagamento

## Comandos e integrações

- booking.payment.start/retry
- webhook

## UX e estados obrigatórios

- Campos de cartão fornecidos pelo provider.
- Carregamento, redirecionamento 3DS, recusa e pendência.
- Não reter valores dos campos indevidamente.
- Teclado mobile adequado.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- PCI scope minimizado.
- CSP compatível com o provider.
- Nenhum token é registrado em log.
- Origin/idempotency.

## Critérios de aceitação

- Aprovação em sandbox confirma por webhook.
- Uma recusa não confirma reserva.
- 3DS return seguro.
- Duplo envio não duplica cobrança.
- Dados de cartão não aparecem em logs nem no banco.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F021-E2E-001 | P0 | critical | desktop | cartão sandbox aprovado confirma uma reserva | `tests/e2e/critical/feat-021-card-payment.spec.ts` |
| SL-F021-E2E-002 | P0 | critical | desktop | cartão recusado não confirma e permite retentativa | `tests/e2e/critical/feat-021-card-payment.spec.ts` |
| SL-F021-E2E-003 | P0 | critical | desktop | duplo envio não duplica cobrança | `tests/e2e/critical/feat-021-card-payment.spec.ts` |
| SL-F021-E2E-004 | P1 | regression | mobile | formulário, 3DS e erros acessíveis | `tests/e2e/regression/feat-021-card-payment.spec.ts` |
| SL-F021-E2E-005 | P0 | critical | desktop | DB/log não contém PAN/CVV/token | `tests/e2e/critical/feat-021-card-payment.spec.ts` |
| SL-F021-E2E-006 | P0 | critical | desktop | callback externo de 3DS é rejeitado | `tests/e2e/critical/feat-021-card-payment.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- testes de contrato do provider
- security log scan
- mapeamento de estados de pagamento
- E2E em sandbox/provedor falso

## Documentação viva afetada

- payments.md
- security-privacy.md
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
