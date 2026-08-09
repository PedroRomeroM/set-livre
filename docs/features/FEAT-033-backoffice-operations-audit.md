# FEAT-033 — Operação, saúde, jobs e auditoria

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `operations` |
| Specs Playwright | `tests/e2e/critical/feat-033-backoffice-operations-audit.spec.ts`<br>`tests/e2e/regression/feat-033-backoffice-operations-audit.spec.ts` |

## Objetivo

Dar visibilidade acionável a filas, incidentes, releases e ações administrativas sem expor secrets.

## Papéis

- support
- finance
- admin

## Rotas e superfícies

- backoffice /operacao
- backoffice /auditoria

## Dependências

- observability
- workers
- audit

## Incluído

- Health summary.
- Heartbeats dos workers.
- Profundidade das filas.
- Stuck holds/payments/refunds/payouts/emails.
- SHA da release.
- Busca de auditoria.
- Links para runbooks.
- Safe retries by delegated command.

## Fora desta feature

- raw logs full
- secrets
- arbitrary SQL
- shell

## Regras de produto e domínio

- O dashboard usa read model.
- Status stale marked.
- Actions route to domain commands.
- A auditoria é append-only.
- Correlação por `requestId`.
- No fake green.

## Dados canônicos afetados

- job heartbeat
- audit.events
- operational read models

## Read models

- overview operacional e lista de auditoria privados

## Comandos e integrações

- retentativas administrativas limitadas por ações existentes

## UX e estados obrigatórios

- Cards de status com timestamp.
- Tables/cursor.
- Alert severity text+color.
- CTA para o runbook.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Acesso específico por papel.
- No payload/secrets.
- Network restricted.
- Consultas de auditoria são protegidas.

## Critérios de aceitação

- Health correct.
- Alerta de worker sem heartbeat recente.
- Métricas de fila.
- Filtro de auditoria.
- Acesso não autorizado é rejeitado.
- O aplicativo público não expõe essa superfície.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F033-E2E-001 | P0 | critical | desktop | operações mostra release, saúde e atualização dos workers | `tests/e2e/critical/feat-033-backoffice-operations-audit.spec.ts` |
| SL-F033-E2E-002 | P0 | critical | desktop | worker desatualizado ou fila acima do limite gera alerta | `tests/e2e/critical/feat-033-backoffice-operations-audit.spec.ts` |
| SL-F033-E2E-003 | P0 | critical | desktop | auditoria filtra por ator, ação e requestId | `tests/e2e/critical/feat-033-backoffice-operations-audit.spec.ts` |
| SL-F033-E2E-004 | P0 | critical | desktop | nenhum segredo ou payload bruto do provider é renderizado | `tests/e2e/critical/feat-033-backoffice-operations-audit.spec.ts` |
| SL-F033-E2E-005 | P0 | critical | desktop | papel não autorizado é rejeitado | `tests/e2e/critical/feat-033-backoffice-operations-audit.spec.ts` |
| SL-F033-E2E-006 | P1 | regression | desktop | links de runbook apontam para procedimentos vigentes | `tests/e2e/regression/feat-033-backoffice-operations-audit.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: read models operacionais e papéis
- unitário: health aggregation
- security snapshots

## Documentação viva afetada

- observability.md
- infrastructure.md
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
