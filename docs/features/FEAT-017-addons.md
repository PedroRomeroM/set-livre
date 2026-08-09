# FEAT-017 — Adicionais por unidade

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `pricing` |
| Specs Playwright | `tests/e2e/critical/feat-017-addons.spec.ts`<br>`tests/e2e/regression/feat-017-addons.spec.ts` |

## Objetivo

Permitir itens extras opcionais com preço e quantidade incorporados à cotação e reserva.

## Papéis

- dono
- locatário

## Rotas e superfícies

- /dono/estudios/[studioId]/adicionais

## Dependências

- FEAT-006
- FEAT-018

## Incluído

- CRUD/arquivamento.
- Nome, descrição, preço unitário e quantidade máxima.
- Seleção/quantidade no configurador.
- Snapshot na reserva.

## Fora desta feature

- estoque complexo
- preço por hora
- bundles

## Regras de produto e domínio

- Adicional é por unidade/reserva.
- 0–max no configurador; 0 omitido.
- Usado não é hard deleted.
- Inativo não aparece em nova quote.
- Quote valida preço e max atual.
- Reserva guarda nome/preço.

## Dados canônicos afetados

- studio_addons
- reservation_quote_items
- reservation_addons

## Read models

- lista de adicionais ativos
- adicionais do dono

## Comandos e integrações

- addon.create/update/archive

## UX e estados obrigatórios

- Lista + formulário.
- Quantity stepper 44px.
- Preço formatado.
- Empty state.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Ownership.
- O cliente não envia preço unitário autoritativo.
- Text limits.

## Critérios de aceitação

- CRUD funciona.
- Arquivamento preserva histórico.
- Quantidade impacta total.
- Max é aplicado.
- Outro dono não altera.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F017-E2E-001 | P0 | critical | desktop | criar/editar/arquivar adicional | `tests/e2e/critical/feat-017-addons.spec.ts` |
| SL-F017-E2E-002 | P0 | critical | desktop | quantidade atualiza cotação server-side | `tests/e2e/critical/feat-017-addons.spec.ts` |
| SL-F017-E2E-003 | P0 | critical | desktop | preço enviado pelo cliente é ignorado ou rejeitado | `tests/e2e/critical/feat-017-addons.spec.ts` |
| SL-F017-E2E-004 | P1 | regression | mobile | quantity controls acessíveis | `tests/e2e/regression/feat-017-addons.spec.ts` |
| SL-F017-E2E-005 | P0 | critical | desktop | histórico preserva addon arquivado | `tests/e2e/critical/feat-017-addons.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: addon totals/schema
- banco: archive/ownership
- integração com cotação

## Documentação viva afetada

- database.md
- ux-blueprint.md
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
