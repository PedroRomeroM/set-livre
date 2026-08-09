# FEAT-005 — Dashboard do dono e portfólio de estúdios

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `owners` |
| Specs Playwright | `tests/e2e/critical/feat-005-owner-dashboard-portfolio.spec.ts`<br>`tests/e2e/regression/feat-005-owner-dashboard-portfolio.spec.ts` |

## Objetivo

Oferecer visão operacional dos estúdios, status, próximas reservas e pendências sem baixar dados excessivos.

## Papéis

- dono

## Rotas e superfícies

- /dono
- /dono/estudios

## Dependências

- FEAT-004
- FEAT-006

## Incluído

- Cards/rows dos estúdios do dono.
- Status editorial e operacional.
- CTAs para criar/continuar/corrigir.
- Resumo de próximas reservas e repasses.
- Alertas de recebedor, revisão e calendário.
- Paginação por cursor quando necessário.

## Fora desta feature

- analytics avançado
- gráficos sem uso
- comparação entre donos

## Regras de produto e domínio

- Os contadores vêm de read model.
- Status de revisão e disponibilidade são distintos.
- Estúdio pausado não aparece como erro.
- Empty state cria primeiro estúdio.
- O dono com vários estúdios escolhe o contexto.

## Dados canônicos afetados

- studios
- revisions
- reservations
- payouts
- status do recebedor

## Read models

- list_owner_studios
- get_owner_overview

## Comandos e integrações

- nenhum comando próprio além de navegação; studio.pause/resume por FEAT-009

## UX e estados obrigatórios

- Desktop com resumo e lista.
- Mobile prioriza alertas e CTAs.
- Refetch não desmonta controles.
- Nomes longos e statuses acessíveis.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- RLS/ownership.
- Sem dados de locatário no overview.
- Valores financeiros agregados apenas do dono.

## Critérios de aceitação

- Dono vê somente seus estúdios.
- Status e CTAs coerentes.
- Empty state orienta.
- Cursor preserva filtro.
- Mobile sem overflow.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F005-E2E-001 | P0 | critical | desktop | dono com múltiplos estúdios vê portfólio correto | `tests/e2e/critical/feat-005-owner-dashboard-portfolio.spec.ts` |
| SL-F005-E2E-002 | P0 | critical | desktop | dono A não vê estúdio B | `tests/e2e/critical/feat-005-owner-dashboard-portfolio.spec.ts` |
| SL-F005-E2E-003 | P1 | regression | mobile | estado vazio oferece criação de estúdio | `tests/e2e/regression/feat-005-owner-dashboard-portfolio.spec.ts` |
| SL-F005-E2E-004 | P1 | regression | desktop | alerta de revisão/recebedor aponta a rota correta | `tests/e2e/regression/feat-005-owner-dashboard-portfolio.spec.ts` |
| SL-F005-E2E-005 | P1 | regression | mobile | axe e nomes longos | `tests/e2e/regression/feat-005-owner-dashboard-portfolio.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: owner read model/ownership
- unitário: status presentation
- query key filters

## Documentação viva afetada

- ux-blueprint.md
- api-contracts.md
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
