# FEAT-013 — Exceções, bloqueios, buffer e duração

## Metadados

| Campo            | Valor                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                                              |
| Prioridade       | P0                                                                                                                                     |
| Domínio          | `calendar`                                                                                                                             |
| Specs Playwright | `tests/e2e/critical/feat-013-calendar-exceptions-blocks.spec.ts`<br>`tests/e2e/regression/feat-013-calendar-exceptions-blocks.spec.ts` |

## Objetivo

Permitir que o dono ajuste datas específicas, bloqueie períodos e configure limites sem violar reservas existentes.

## Papéis

- dono

## Rotas e superfícies

- /dono/estudios/[studioId]/disponibilidade

## Dependências

- FEAT-012

## Incluído

- Exceção fechada ou horários especiais.
- Bloqueio manual.
- Edição/remoção de bloqueio futuro.
- Buffer antes/depois 0–4h.
- Duração min/max 1–24h.
- Pré-visualização de conflitos.

## Fora desta feature

- recorrência de bloqueio
- buffer em minutos
- feriados importados automaticamente

## Regras de produto e domínio

- Uma exceção por data.
- Janelas em hora cheia e sem overlap.
- Blocked period incorpora buffer.
- Exceção/block não pode sobrepor reserva ativa.
- Alterar buffer não reescreve allocations históricas; novas cotações usam novo valor.
- Manual block usa label interna não pública.

## Dados canônicos afetados

- studio_date_exceptions
- studio_exception_windows
- studio_calendar_settings
- calendar_allocations

## Read models

- get_owner_calendar
- get_studio_availability

## Comandos e integrações

- calendar.settings.update
- calendar.exception.upsert/delete
- calendar.block.create/update/delete

## UX e estados obrigatórios

- Calendário + forms.
- Conflito mostra período e ação possível.
- Confirmação ao excluir.
- Mobile usa sheet/fullscreen.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Ownership.
- Constraint de exclusão de intervalos.
- Controle de concorrência otimista.
- Label sanitizada.

## Critérios de aceitação

- Exceção fecha/abre corretamente.
- Manual block ocupa.
- Buffer impede adjacente.
- Reserva impede mudança destrutiva.
- Configuração min/max aplicada.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                     | Spec                                                               |
| --------------- | ---------- | ---------- | -------- | ------------------------------------------- | ------------------------------------------------------------------ |
| SL-F013-E2E-001 | P0         | critical   | desktop  | criar exceção fechada e horário especial    | `tests/e2e/critical/feat-013-calendar-exceptions-blocks.spec.ts`   |
| SL-F013-E2E-002 | P0         | critical   | desktop  | criar, mover e remover bloqueio manual      | `tests/e2e/critical/feat-013-calendar-exceptions-blocks.spec.ts`   |
| SL-F013-E2E-003 | P0         | critical   | desktop  | buffer bloqueia período adjacente           | `tests/e2e/critical/feat-013-calendar-exceptions-blocks.spec.ts`   |
| SL-F013-E2E-004 | P0         | critical   | desktop  | não sobrepor reserva                        | `tests/e2e/critical/feat-013-calendar-exceptions-blocks.spec.ts`   |
| SL-F013-E2E-005 | P1         | regression | mobile   | editar configurações com conflito acessível | `tests/e2e/regression/feat-013-calendar-exceptions-blocks.spec.ts` |
| SL-F013-E2E-006 | P1         | regression | desktop  | alterar buffer não modifica histórico       | `tests/e2e/regression/feat-013-calendar-exceptions-blocks.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: exclusion/transactions
- unitário: blocked period/min-max
- timezone/date exceptions

## Documentação viva afetada

- calendar-reservations.md
- database.md
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
