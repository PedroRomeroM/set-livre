# FEAT-014 — Calendário avançado semana/mês/dia e drag-and-drop

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `calendar-ui` |
| Specs Playwright | `tests/e2e/critical/feat-014-advanced-calendar.spec.ts`<br>`tests/e2e/regression/feat-014-advanced-calendar.spec.ts` |

## Objetivo

Oferecer operação visual completa do calendário interno com alternativas acessíveis e revalidação server-side.

## Papéis

- dono

## Rotas e superfícies

- /dono/agenda
- /dono/estudios/[studioId]/disponibilidade

## Dependências

- FEAT-012
- FEAT-013
- FEAT-024

## Incluído

- Views mês/semana/dia.
- Navegação temporal.
- Hoje.
- Eventos por tipo.
- Arrastar e redimensionar bloqueios manuais.
- Detalhe de reserva somente leitura.
- Conflitos e buffer.
- Filtro por estúdio.

## Fora desta feature

- mover reserva confirmada
- editar iCal individual
- sync Google

## Regras de produto e domínio

- A visualização padrão é dia no mobile e semana no desktop.
- O arraste é uma pré-visualização; o comando no servidor é autoritativo.
- Alternativa via formulário para teclado/touch.
- Reservations/holds não são arrastáveis.
- Query limita janela.
- Eventos não revelam locatário fora da área autorizada.

## Dados canônicos afetados

- alocações de calendário
- read model seguro de reservas

## Read models

- get_owner_calendar

## Comandos e integrações

- calendar.block.create/update/delete

## UX e estados obrigatórios

- Grid acessível.
- Legend com texto/ícone.
- Tooltip não essencial.
- Focus e zoom.
- Loading preserva navegação.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Ownership.
- DTO seguro.
- Limite de taxa para movimentações.
- Conflito reverte.

## Critérios de aceitação

- Views coerentes.
- O arraste de bloqueio manual funciona e um conflito reverte a interface.
- Há alternativa por teclado.
- A reserva é somente leitura.
- Mobile 320/short height.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F014-E2E-001 | P0 | critical | desktop | alternar visualizações e navegar mantendo eventos | `tests/e2e/critical/feat-014-advanced-calendar.spec.ts` |
| SL-F014-E2E-002 | P0 | critical | desktop | arrastar bloqueio manual confirma no servidor | `tests/e2e/critical/feat-014-advanced-calendar.spec.ts` |
| SL-F014-E2E-003 | P0 | critical | desktop | arraste conflitante reverte e anuncia o erro | `tests/e2e/critical/feat-014-advanced-calendar.spec.ts` |
| SL-F014-E2E-004 | P1 | regression | mobile | visualização diária e formulário alternativo | `tests/e2e/regression/feat-014-advanced-calendar.spec.ts` |
| SL-F014-E2E-005 | P0 | critical | desktop | reserva não é arrastável | `tests/e2e/critical/feat-014-advanced-calendar.spec.ts` |
| SL-F014-E2E-006 | P1 | regression | desktop | axe, teclado e rótulos do calendário | `tests/e2e/regression/feat-014-advanced-calendar.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: event normalization
- integração: command conflict
- visual responsive screenshots

## Documentação viva afetada

- design-system.md
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
