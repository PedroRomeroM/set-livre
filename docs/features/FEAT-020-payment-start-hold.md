# FEAT-020 — Início de pagamento, hold e concorrência

## Metadados

| Campo            | Valor                                                    |
| ---------------- | -------------------------------------------------------- |
| Status           | Planejada                                                |
| Prioridade       | P0                                                       |
| Domínio          | `booking-core`                                           |
| Specs Playwright | `tests/e2e/critical/feat-020-payment-start-hold.spec.ts` |

## Objetivo

Adquirir hold somente após o provider confirmar início e garantir exclusão no banco sob concorrência.

## Papéis

- locatário

## Rotas e superfícies

- /checkout/[attemptId]

## Dependências

- FEAT-018
- FEAT-019
- FEAT-004
- PaymentProvider

## Incluído

- Chave de idempotência.
- Revalidação da cotação.
- Início da transação no provider.
- Persistência do pagamento.
- Aquisição transacional do hold.
- Compensar conflito.
- Expiração job.

## Fora desta feature

- lock frontend
- hold antes do início confirmado pelo provider
- fila externa

## Regras de produto e domínio

- Hold do cartão por 15 minutos; hold do PIX até a expiração informada pelo provider.
- Uma cotação não gera duas reservas.
- Um conflito cancela ou invalida a tentativa criada no provider.
- A tentativa expirada libera o horário.
- Pagamento aprovado após perda do hold abre incidente de reembolso.
- O recebedor deve estar elegível.

## Dados canônicos afetados

- booking_attempts
- payments
- booking_holds
- calendar_allocations
- idempotency

## Read models

- status seguro da tentativa e do pagamento

## Comandos e integrações

- booking.payment.start
- booking.attempt.cancel

## UX e estados obrigatórios

- O botão é desabilitado durante o envio.
- O estado de processamento informa a fase real.
- A mensagem de conflito explica que o horário deixou de estar disponível.
- Não mostrar QR Code nem sucesso do cartão antes da aquisição do hold.
- A retentativa possui caminho explícito.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Pipeline de comandos.
- Constraint de exclusão de intervalos.
- Advisory lock quando necessário.
- Idempotency.
- Limite de taxa.

## Critérios de aceitação

- Uma de duas concorrentes adquire.
- O duplo clique é idempotente.
- Um conflito após iniciar o provider executa compensação.
- Tentativas expiradas liberam o horário.
- Divergência entre cotação e valor é rejeitada.

## Playwright obrigatório

| ID              | Prioridade | Suíte    | Viewport | Cenário                                              | Spec                                                     |
| --------------- | ---------- | -------- | -------- | ---------------------------------------------------- | -------------------------------------------------------- |
| SL-F020-E2E-001 | P0         | critical | desktop  | duplo clique cria uma tentativa/hold                 | `tests/e2e/critical/feat-020-payment-start-hold.spec.ts` |
| SL-F020-E2E-002 | P0         | critical | desktop  | dois usuários mesmo slot: somente um hold            | `tests/e2e/critical/feat-020-payment-start-hold.spec.ts` |
| SL-F020-E2E-003 | P0         | critical | desktop  | provider iniciado mas conflito é compensado          | `tests/e2e/critical/feat-020-payment-start-hold.spec.ts` |
| SL-F020-E2E-004 | P0         | critical | desktop  | hold expirado libera                                 | `tests/e2e/critical/feat-020-payment-start-hold.spec.ts` |
| SL-F020-E2E-005 | P0         | critical | desktop  | cotação ou valor alterado exige nova confirmação     | `tests/e2e/critical/feat-020-payment-start-hold.spec.ts` |
| SL-F020-E2E-006 | P0         | critical | desktop  | recebedor inativo bloqueia antes de cobrança efetiva | `tests/e2e/critical/feat-020-payment-start-hold.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: exclusion/concurrent transactions
- integração: compensação com provider falso
- testes de idempotência
- job de expiração

## Documentação viva afetada

- calendar-reservations.md
- payments.md
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
