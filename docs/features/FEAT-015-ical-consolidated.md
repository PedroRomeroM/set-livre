# FEAT-015 — Importação/exportação iCal e agenda consolidada

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P1 |
| Domínio | `calendar-integrations` |
| Specs Playwright | `tests/e2e/regression/feat-015-ical-consolidated.spec.ts`<br>`tests/e2e/critical/feat-015-ical-consolidated.spec.ts` |

## Objetivo

Permitir interoperabilidade manual e visão conjunta dos estúdios sem sincronização automática.

## Papéis

- dono

## Rotas e superfícies

- /dono/agenda

## Dependências

- FEAT-014

## Incluído

- Pré-visualização e confirmação da importação.
- Batch e remoção.
- Export por intervalo.
- Agenda todos/selecionados.
- Timezone/recurrence limitada.
- Relatório de ignorados/conflitos.

## Fora desta feature

- subscription feed
- Google Calendar
- editar evento importado individualmente

## Regras de produto e domínio

- ICS ≤2MB e ≤2000 ocorrências.
- Janela -30/+365 dias.
- Conflito com reserva é ignorado/reportado.
- Batch delete não afeta outro source.
- Export sem PII.
- UID estável.

## Dados canônicos afetados

- ical_import_batches/events
- calendar_allocations

## Read models

- get_owner_calendar
- export read

## Comandos e integrações

- calendar.ical.import
- calendar.ical.batch.delete
- GET export autenticado

## UX e estados obrigatórios

- Upload com pré-visualização.
- Resumo de importados/ignorados.
- Filtro multiestúdio.
- Download nomeado.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Parser server-side.
- Filename sanitizado.
- Ownership.
- Sem conteúdo HTML/PII.

## Critérios de aceitação

- ICS válido importa.
- Inválido/oversize falha.
- Conflito não sobrescreve.
- Delete batch libera.
- Export reimportável e sem PII.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F015-E2E-001 | P1 | regression | desktop | importar ICS válido com pré-visualização e lote | `tests/e2e/regression/feat-015-ical-consolidated.spec.ts` |
| SL-F015-E2E-002 | P0 | critical | desktop | evento conflitante não sobrescreve reserva | `tests/e2e/critical/feat-015-ical-consolidated.spec.ts` |
| SL-F015-E2E-003 | P1 | regression | desktop | arquivo inválido/oversize/recurrence excessiva falha | `tests/e2e/regression/feat-015-ical-consolidated.spec.ts` |
| SL-F015-E2E-004 | P1 | regression | desktop | remover batch libera somente seus eventos | `tests/e2e/regression/feat-015-ical-consolidated.spec.ts` |
| SL-F015-E2E-005 | P1 | regression | mobile | agenda consolidada filtra estúdios | `tests/e2e/regression/feat-015-ical-consolidated.spec.ts` |
| SL-F015-E2E-006 | P1 | regression | desktop | export contém timezone/UID e não PII | `tests/e2e/regression/feat-015-ical-consolidated.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: ICS parser/sanitization/timezone
- banco: batch ownership
- roundtrip export/import

## Documentação viva afetada

- calendar-reservations.md
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
