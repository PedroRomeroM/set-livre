# FEAT-016 — Preço base e multiplicadores por dia/faixa

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `pricing` |
| Specs Playwright | `tests/e2e/critical/feat-016-pricing.spec.ts`<br>`tests/e2e/regression/feat-016-pricing.spec.ts` |

## Objetivo

Permitir precificação configurável e cálculo determinístico por bloco de uma hora.

## Papéis

- dono
- visitante/locatário

## Rotas e superfícies

- /dono/estudios/[studioId]/precos

## Dependências

- FEAT-006
- FEAT-012

## Incluído

- Preço base por hora.
- Sete multiplicadores diários.
- Faixas horárias sem overlap.
- Pré-visualização de exemplos.
- Snapshot em cotação.

## Fora desta feature

- preço flutuante
- diária fixa
- cupom
- preço mínimo

## Regras de produto e domínio

- Centavos.
- Multiplier 0.1–5.0.
- Default 1.0.
- Faixas em hora cheia.
- Cada hora aplica dia e faixa.
- Round por linha.
- Alteração não muda quote/reserva existente.

## Dados canônicos afetados

- studio_pricing
- studio_day_multipliers
- studio_time_bands
- quote items

## Read models

- pricing editor
- resumo público de preço
- quote

## Comandos e integrações

- pricing.base.update
- pricing.dayMultipliers.replace
- pricing.timeBands.replace

## UX e estados obrigatórios

- MoneyInput.
- Tabela de dias.
- Faixas com pré-visualização.
- Exemplos em PT-BR.
- Erros de overlap.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Ownership.
- Server recalculates.
- Não aceitar total nem multiplicador aplicado enviados pelo cliente.
- Checks.

## Critérios de aceitação

- Salvar e calcular exemplos.
- Um intervalo entre faixas gera itens de linha corretos.
- Overlap falha.
- Histórico preservado.
- Preço público base exato.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F016-E2E-001 | P0 | critical | desktop | configurar base/dias/faixas | `tests/e2e/critical/feat-016-pricing.spec.ts` |
| SL-F016-E2E-002 | P0 | critical | desktop | cotação atravessando faixas calcula por hora | `tests/e2e/critical/feat-016-pricing.spec.ts` |
| SL-F016-E2E-003 | P0 | critical | desktop | overlap/multiplicador inválido falha | `tests/e2e/critical/feat-016-pricing.spec.ts` |
| SL-F016-E2E-004 | P1 | regression | mobile | editor de preço acessível | `tests/e2e/regression/feat-016-pricing.spec.ts` |
| SL-F016-E2E-005 | P0 | critical | desktop | alteração não muda quote/reserva snapshot | `tests/e2e/critical/feat-016-pricing.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: money/rounding/time bands
- banco: checks/ownership
- property tests de soma

## Documentação viva afetada

- domain-model.md
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
