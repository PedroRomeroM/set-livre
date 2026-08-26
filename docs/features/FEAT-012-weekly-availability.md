# FEAT-012 — Horário semanal e regras básicas de disponibilidade

## Metadados

| Campo            | Valor                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Status           | Planejada                                                                                                                |
| Prioridade       | P0                                                                                                                       |
| Domínio          | `calendar`                                                                                                               |
| Specs Playwright | `tests/e2e/critical/feat-012-weekly-availability.spec.ts`<br>`tests/e2e/regression/feat-012-weekly-availability.spec.ts` |

## Objetivo

Permitir ao dono definir janelas recorrentes de funcionamento que alimentam disponibilidade real.

## Papéis

- dono

## Rotas e superfícies

- /dono/estudios/[studioId]/disponibilidade

## Dependências

- FEAT-006

## Incluído

- Sete dias.
- Múltiplas janelas/dia.
- Abrir/fechar.
- Copiar dia.
- Substituição transacional.
- Pré-visualização semanal.

## Fora desta feature

- recorrência complexa
- feriado automático
- meia hora

## Regras de produto e domínio

- Hora cheia.
- Fim maior que início.
- Sem overlap.
- Timezone fixo.
- Mudança não apaga allocations.
- Conflito com reserva futura é permitido como configuração? Default: comando rejeita janela que tornaria reserva fora do funcionamento e exige decisão administrativa, preservando coerência.

## Dados canônicos afetados

- studio_calendar_settings
- studio_weekly_windows

## Read models

- get_owner_calendar_settings
- disponibilidade

## Comandos e integrações

- calendar.weekly.replace

## UX e estados obrigatórios

- Grid de dias.
- Select de horas.
- Copy action.
- Erros junto ao dia.
- Mobile accordions.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Ownership.
- Version token.
- Banco revalida.
- Sem aceitar `userId` do cliente.

## Critérios de aceitação

- Salvar semana válida.
- Overlap falha.
- Outro dono falha.
- Disponibilidade pública reflete.
- Reserva existente não é corrompida.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                                 | Spec                                                        |
| --------------- | ---------- | ---------- | -------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| SL-F012-E2E-001 | P0         | critical   | desktop  | configurar múltiplas janelas e refletir disponibilidade | `tests/e2e/critical/feat-012-weekly-availability.spec.ts`   |
| SL-F012-E2E-002 | P0         | critical   | desktop  | sobreposição ou horário não cheio é rejeitado           | `tests/e2e/critical/feat-012-weekly-availability.spec.ts`   |
| SL-F012-E2E-003 | P0         | critical   | desktop  | dono A não altera B                                     | `tests/e2e/critical/feat-012-weekly-availability.spec.ts`   |
| SL-F012-E2E-004 | P1         | regression | mobile   | editar semana em acordeões                              | `tests/e2e/regression/feat-012-weekly-availability.spec.ts` |
| SL-F012-E2E-005 | P0         | critical   | desktop  | mudança conflitante com reserva é bloqueada             | `tests/e2e/critical/feat-012-weekly-availability.spec.ts`   |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: window validation
- banco: substituição transacional e ownership
- timezone tests

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
