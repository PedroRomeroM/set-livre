# FEAT-018 — Configuração de reserva e cotação autoritativa

## Metadados

| Campo            | Valor                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                                                      |
| Prioridade       | P0                                                                                                                                             |
| Domínio          | `booking`                                                                                                                                      |
| Specs Playwright | `tests/e2e/critical/feat-018-reservation-configurator-quote.spec.ts`<br>`tests/e2e/regression/feat-018-reservation-configurator-quote.spec.ts` |

## Objetivo

Permitir selecionar data, início, duração, pessoas, adicionais e observações, apresentando preço/availability autoritativos.

## Papéis

- visitante
- locatário

## Rotas e superfícies

- /reservar/[studioId]

## Dependências

- FEAT-011
- FEAT-012
- FEAT-013
- FEAT-016
- FEAT-017

## Incluído

- Campos completos.
- Slots disponíveis.
- Quote de 5 min.
- Itens de linha.
- Capacidade.
- Estados indisponível/preço alterado.
- CTA para autenticação ou pagamento.

## Fora desta feature

- hold antes do pagamento
- vários estúdios
- carrinho

## Regras de produto e domínio

- Quote não garante vaga.
- Data pré-configurada da busca.
- Hora/duração consecutivas.
- Guest <= capacity.
- Notes <=1000.
- Server revalida tudo.
- O resumo de preço explica os multiplicadores.

## Dados canônicos afetados

- reservation_quotes/items
- read models de disponibilidade e preço

## Read models

- get_studio_availability
- booking.quote.create

## Comandos e integrações

- booking.quote.create

## UX e estados obrigatórios

- Configurator ao lado/sticky summary desktop.
- Mobile steps ou stack.
- Slots disabled com reason genérico.
- Debounce controlado e envio explícito para gerar a cotação.
- Expiry visível sem ansiedade.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Sem detalhes de outras reservas.
- Limite de taxa para cotações.
- Payload limits.
- O preço enviado pelo cliente não é confiável.

## Critérios de aceitação

- Quote válida criada.
- Indisponível/capacidade/max falha.
- Os itens de linha são corretos.
- Quote expira.
- O visitante é levado à autenticação sem perder o rascunho.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                                 | Spec                                                                   |
| --------------- | ---------- | ---------- | -------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| SL-F018-E2E-001 | P0         | critical   | desktop  | configurar e criar quote detalhada                      | `tests/e2e/critical/feat-018-reservation-configurator-quote.spec.ts`   |
| SL-F018-E2E-002 | P0         | critical   | desktop  | slot ocupado/capacidade/duração inválida são bloqueados | `tests/e2e/critical/feat-018-reservation-configurator-quote.spec.ts`   |
| SL-F018-E2E-003 | P0         | critical   | desktop  | quote expira e recalcula                                | `tests/e2e/critical/feat-018-reservation-configurator-quote.spec.ts`   |
| SL-F018-E2E-004 | P1         | regression | mobile   | configurator 320px e sticky CTA                         | `tests/e2e/regression/feat-018-reservation-configurator-quote.spec.ts` |
| SL-F018-E2E-005 | P0         | critical   | desktop  | dados de outra reserva não vazam                        | `tests/e2e/critical/feat-018-reservation-configurator-quote.spec.ts`   |
| SL-F018-E2E-006 | P1         | regression | desktop  | axe, teclado, data, horário e quantidade                | `tests/e2e/regression/feat-018-reservation-configurator-quote.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: quote schema/line items
- banco: quote creation availability
- timezone boundary

## Documentação viva afetada

- calendar-reservations.md
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
