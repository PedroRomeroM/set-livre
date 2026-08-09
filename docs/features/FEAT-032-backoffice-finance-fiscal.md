# FEAT-032 — Financeiro, reembolso, repasse e exportação fiscal

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `backoffice-finance` |
| Specs Playwright | `tests/e2e/critical/feat-032-backoffice-finance-fiscal.spec.ts`<br>`tests/e2e/regression/feat-032-backoffice-finance-fiscal.spec.ts` |

## Objetivo

Operar exceções financeiras e gerar dados para emissão fiscal manual sem alterar fatos diretamente.

## Papéis

- finance
- admin

## Rotas e superfícies

- backoffice /pagamentos
- /reembolsos
- /repasses
- /fiscal

## Dependências

- FEAT-023
- FEAT-025
- FEAT-026

## Incluído

- Lista e detalhe de pagamentos.
- Linha do tempo de webhooks.
- Fila, retentativa e operação manual de reembolso.
- Fila, retentativa, bloqueio e operação manual de repasse.
- Exportação fiscal.
- Auditoria obrigatória.

## Fora desta feature

- editar amount
- emissão NFS-e
- refund parcial de produto

## Regras de produto e domínio

- Actions by state.
- Impact preview.
- A conclusão manual exige referência externa.
- A exportação é privada e expira.
- Registros financeiros nunca são excluídos.
- Amount derived.

## Dados canônicos afetados

- pagamentos, eventos, reembolsos, repasses, exportações fiscais e auditoria

## Read models

- leituras financeiras privadas

## Comandos e integrações

- admin.refund.*
- admin.payout.*
- admin.fiscal.export

## UX e estados obrigatórios

- Tabelas densas, filtros e cursores.
- Timeline.
- Confirmação forte.
- Status do download.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Papel financeiro obrigatório.
- Somente os dados pessoais necessários são exibidos.
- Segredos do provider permanecem no servidor.
- Auditoria obrigatória.
- O acesso à exportação é autorizado.

## Critérios de aceitação

- Queues correct.
- A retentativa é idempotente.
- A operação manual é auditada.
- Campos, checksum e expiração da exportação.
- Acesso não autorizado é rejeitado.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F032-E2E-001 | P0 | critical | desktop | financeiro revisa linha do tempo de pagamento e eventos | `tests/e2e/critical/feat-032-backoffice-finance-fiscal.spec.ts` |
| SL-F032-E2E-002 | P0 | critical | desktop | retentativa de reembolso ou repasse é idempotente | `tests/e2e/critical/feat-032-backoffice-finance-fiscal.spec.ts` |
| SL-F032-E2E-003 | P0 | critical | desktop | fallback manual exige referência e auditoria | `tests/e2e/critical/feat-032-backoffice-finance-fiscal.spec.ts` |
| SL-F032-E2E-004 | P0 | critical | desktop | exportação fiscal é gerada de forma privada e expira | `tests/e2e/critical/feat-032-backoffice-finance-fiscal.spec.ts` |
| SL-F032-E2E-005 | P0 | critical | desktop | suporte e revisor não executam ações financeiras | `tests/e2e/critical/feat-032-backoffice-finance-fiscal.spec.ts` |
| SL-F032-E2E-006 | P1 | regression | desktop | filtros e cursor preservam o estado | `tests/e2e/regression/feat-032-backoffice-finance-fiscal.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: finance role/actions/idempotency
- conteúdo e checksum da exportação
- provider falso

## Documentação viva afetada

- payments.md
- backoffice.md
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
