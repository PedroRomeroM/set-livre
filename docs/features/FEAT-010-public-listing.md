# FEAT-010 — Listagem, filtros, ordenação e cursor

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `public-web` |
| Specs Playwright | `tests/e2e/critical/feat-010-public-listing.spec.ts`<br>`tests/e2e/regression/feat-010-public-listing.spec.ts` |

## Objetivo

Permitir comparar estúdios publicados por filtros úteis e disponibilidade real sem offset ou busca textual.

## Papéis

- visitante
- usuário autenticado

## Rotas e superfícies

- /estudios

## Dependências

- FEAT-009
- FEAT-012
- FEAT-016

## Incluído

- Filtros: bairro, data, preço, tipo, capacidade, tags/amenities.
- Ordenação por preço crescente ou decrescente.
- Cards definidos.
- Keyset cursor.
- URL compartilhável.
- Carregar mais.

## Fora desta feature

- busca textual
- relevância
- avaliação
- mapa
- page numbers

## Regras de produto e domínio

- Somente estúdios publicados e reserváveis conforme as regras.
- Data usa disponibilidade real.
- Sem data, availableOnDate=null.
- Cursor inclui filtro/order e expira/rejeita quando inválido.
- Máximo 24.
- Preço exibido é base exata por hora; disponibilidade/quote pode variar por multiplicador.

## Dados canônicos afetados

- read model da revisão publicada
- resumo de disponibilidade
- pricing

## Read models

- list_studios

## Comandos e integrações

- nenhum comando

## UX e estados obrigatórios

- Desktop filtros + grid.
- Mobile sheet e chips.
- O carregamento mantém os controles estáveis.
- Empty explica limpar filtros.
- Card inteiro clicável.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Sem PII.
- Cursor assinado/opaco.
- Limites defensivos.
- Parâmetros de consulta validados por allowlist.

## Critérios de aceitação

- Filtros combinam corretamente.
- Ordenação estável.
- Cursor não duplica/omite em dataset estável.
- Estúdios pendentes ou pausados não aparecem.
- Disponibilidade correta.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F010-E2E-001 | P0 | critical | desktop | listar apenas publicados e ordenar preço asc/desc | `tests/e2e/critical/feat-010-public-listing.spec.ts` |
| SL-F010-E2E-002 | P0 | critical | desktop | filtro de data exclui indisponíveis | `tests/e2e/critical/feat-010-public-listing.spec.ts` |
| SL-F010-E2E-003 | P1 | regression | mobile | sheet aplica/limpa filtros e URL | `tests/e2e/regression/feat-010-public-listing.spec.ts` |
| SL-F010-E2E-004 | P0 | critical | desktop | cursor carrega sem duplicação | `tests/e2e/critical/feat-010-public-listing.spec.ts` |
| SL-F010-E2E-005 | P0 | critical | desktop | pendentes, pausados e desativados não aparecem | `tests/e2e/critical/feat-010-public-listing.spec.ts` |
| SL-F010-E2E-006 | P1 | regression | mobile | estados vazio, carregamento e erro são acessíveis | `tests/e2e/regression/feat-010-public-listing.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: read model/cursor/visibility
- unitário: cursor encode/decode/filter key
- EXPLAIN com volume plausível

## Documentação viva afetada

- api-contracts.md
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
