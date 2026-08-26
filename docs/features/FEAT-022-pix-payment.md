# FEAT-022 — Pagamento com PIX

## Metadados

| Campo            | Valor                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                |
| Prioridade       | P0                                                                                                       |
| Domínio          | `payments`                                                                                               |
| Specs Playwright | `tests/e2e/critical/feat-022-pix-payment.spec.ts`<br>`tests/e2e/regression/feat-022-pix-payment.spec.ts` |

## Objetivo

Gerar QR/copia-e-cola com expiração, acompanhar estado e liberar o horário quando não pago.

## Papéis

- locatário

## Rotas e superfícies

- /checkout/[attemptId]

## Dependências

- FEAT-020
- PaymentProvider

## Incluído

- QR e payload.
- Copy.
- Countdown.
- Polling moderado.
- Webhook.
- Expiry.
- Gerar novo PIX.

## Fora desta feature

- PIX automático recorrente
- reutilizar QR expirado

## Regras de produto e domínio

- A expiração padrão do provider é 15 minutos.
- O hold dura até a expiração.
- O QR Code é visível somente ao dono da tentativa.
- Um webhook de pagamento aprovado confirma se o hold continua ativo.
- Após expirar, a retentativa cria nova tentativa.
- Pagamento aprovado após liberação abre incidente de reembolso.

## Dados canônicos afetados

- payments
- attempts
- holds

## Read models

- status do pagamento

## Comandos e integrações

- booking.payment.start/retry
- webhook

## UX e estados obrigatórios

- QR Code com texto alternativo e instruções.
- Copy feedback.
- Countdown server-based.
- O estado de expiração é claro.
- Mobile responsive.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Payload protegido.
- Limite de taxa.
- Sem cache público.
- Assinatura do provider.

## Critérios de aceitação

- O QR Code é criado.
- O pagamento aprovado confirma a reserva.
- A expiração libera o horário.
- A retentativa cria novo QR Code.
- Outro usuário não pode visualizar.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                               | Spec                                                |
| --------------- | ---------- | ---------- | -------- | ----------------------------------------------------- | --------------------------------------------------- |
| SL-F022-E2E-001 | P0         | critical   | desktop  | gerar PIX e confirmar por webhook                     | `tests/e2e/critical/feat-022-pix-payment.spec.ts`   |
| SL-F022-E2E-002 | P0         | critical   | desktop  | PIX expira e libera slot                              | `tests/e2e/critical/feat-022-pix-payment.spec.ts`   |
| SL-F022-E2E-003 | P0         | critical   | desktop  | retentativa gera nova tentativa e QR Code             | `tests/e2e/critical/feat-022-pix-payment.spec.ts`   |
| SL-F022-E2E-004 | P0         | critical   | desktop  | usuário B não acessa QR de A                          | `tests/e2e/critical/feat-022-pix-payment.spec.ts`   |
| SL-F022-E2E-005 | P1         | regression | mobile   | QR Code, cópia e contagem regressiva acessíveis       | `tests/e2e/regression/feat-022-pix-payment.spec.ts` |
| SL-F022-E2E-006 | P0         | critical   | desktop  | pagamento tardio sem hold abre incidente de reembolso | `tests/e2e/critical/feat-022-pix-payment.spec.ts`   |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: expiry countdown/status
- DB/RLS payment owner
- contrato de webhook do provider
- concorrência do job de expiração

## Documentação viva afetada

- payments.md
- calendar-reservations.md
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
