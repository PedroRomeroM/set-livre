# FEAT-027 — Área do locatário e detalhes da reserva

## Metadados

| Campo            | Valor                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Status           | Planejada                                                                                                                |
| Prioridade       | P0                                                                                                                       |
| Domínio          | `renter`                                                                                                                 |
| Specs Playwright | `tests/e2e/critical/feat-027-renter-reservations.spec.ts`<br>`tests/e2e/regression/feat-027-renter-reservations.spec.ts` |

## Objetivo

Permitir ao locatário acompanhar próximas/passadas/canceladas, pagamento, endereço, adicionais e ações elegíveis.

## Papéis

- locatário

## Rotas e superfícies

- /conta/reservas
- /conta/reservas/[reservationId]

## Dependências

- FEAT-024
- FEAT-025

## Incluído

- Tabs/filtros.
- Cursor.
- Cards/rows.
- Detail/timeline.
- Endereço e regras usam snapshot ou versão aprovada vigente conforme o contexto.
- Status de pagamento e reembolso.
- Cancel CTA.

## Fora desta feature

- chat
- review
- download invoice automática

## Regras de produto e domínio

- Próximas e passadas são derivadas por fuso e status.
- Status copy factual.
- O detalhe é acessível somente ao titular.
- Cancellation policy version shown.
- A remoção pública do estúdio não remove o detalhe histórico da reserva.

## Dados canônicos afetados

- snapshots, status, pagamento e reembolso das reservas

## Read models

- list_my_reservations
- get_my_reservation

## Comandos e integrações

- reservation.cancel

## UX e estados obrigatórios

- Lista mobile-first.
- Empty states.
- Timeline.
- Sticky action only if eligible.
- Loading stable.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- RLS owner.
- Nenhum outro usuário acessa.
- Sensitive payment limited.
- Deep link auth.

## Critérios de aceitação

- A listagem é correta.
- Cursor/filter.
- Detail.
- Unauthorized 404.
- Cancel CTA eligibility.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                                     | Spec                                                        |
| --------------- | ---------- | ---------- | -------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| SL-F027-E2E-001 | P0         | critical   | desktop  | listar próximas/passadas/canceladas por cursor              | `tests/e2e/critical/feat-027-renter-reservations.spec.ts`   |
| SL-F027-E2E-002 | P0         | critical   | desktop  | abrir detalhe com snapshot/status                           | `tests/e2e/critical/feat-027-renter-reservations.spec.ts`   |
| SL-F027-E2E-003 | P0         | critical   | desktop  | usuário B não acessa reserva A                              | `tests/e2e/critical/feat-027-renter-reservations.spec.ts`   |
| SL-F027-E2E-004 | P1         | regression | mobile   | lista, detalhe e CTA a 320 px                               | `tests/e2e/regression/feat-027-renter-reservations.spec.ts` |
| SL-F027-E2E-005 | P1         | regression | desktop  | estados vazio, carregamento e refetch não desmontam filtros | `tests/e2e/regression/feat-027-renter-reservations.spec.ts` |
| SL-F027-E2E-006 | P0         | critical   | desktop  | cancel CTA aparece somente elegível                         | `tests/e2e/critical/feat-027-renter-reservations.spec.ts`   |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: renter read models/RLS/cursor
- unitário: time/status presentation
- query keys

## Documentação viva afetada

- ux-blueprint.md
- api-contracts.md
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
