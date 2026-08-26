# FEAT-029 — E-mails transacionais, outbox e lembretes

## Metadados

| Campo            | Valor                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Status           | Planejada                                                                                                                |
| Prioridade       | P0                                                                                                                       |
| Domínio          | `notifications`                                                                                                          |
| Specs Playwright | `tests/e2e/critical/feat-029-transactional-email.spec.ts`<br>`tests/e2e/regression/feat-029-transactional-email.spec.ts` |

## Objetivo

Enviar comunicação confiável sem acoplar sucesso do domínio à disponibilidade do e-mail.

## Papéis

- sistema
- usuários
- admin

## Rotas e superfícies

- nenhuma rota principal; links para rotas existentes

## Dependências

- FEAT-009
- FEAT-024
- FEAT-025
- FEAT-026

## Incluído

- Templates transacionais listados.
- Outbox transacional.
- Worker de processamento.
- Retentativa e dead letter.
- Lembrete 24 horas antes.
- Eventos de entrega.
- Retentativa administrativa.

## Fora desta feature

- push
- SMS
- WhatsApp
- marketing automation

## Regras de produto e domínio

- A outbox é criada na mesma transação do fato.
- Chaves de deduplicação.
- Uma falha de e-mail não desfaz a reserva.
- Reserva cancelada não recebe lembrete.
- URLs seguem allowlist.
- Versões texto e HTML.

## Dados canônicos afetados

- email_outbox/delivery_events

## Read models

- saúde dos e-mails para o admin

## Comandos e integrações

- private.enqueue/claim/mark email
- retentativa administrativa

## UX e estados obrigatórios

- E-mails responsivos e acessíveis.
- PT-BR.
- Datas e fuso corretos.
- CTA claro.
- Sem segredos.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Dados pessoais mínimos.
- O provider é acessado somente no servidor.
- Redação de dados sensíveis.
- E-mails transacionais não exigem descadastro, mas incluem rodapé legal.

## Critérios de aceitação

- Cada evento entra na fila uma única vez.
- O worker envia e realiza retentativas.
- Reserva cancelada não recebe lembrete.
- O link é correto.
- A falha fica visível ao admin.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                                                 | Spec                                                        |
| --------------- | ---------- | ---------- | -------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| SL-F029-E2E-001 | P0         | critical   | desktop  | confirmação da reserva enfileira e envia uma vez ao locatário e ao dono | `tests/e2e/critical/feat-029-transactional-email.spec.ts`   |
| SL-F029-E2E-002 | P0         | critical   | desktop  | evento de domínio duplicado não duplica e-mail                          | `tests/e2e/critical/feat-029-transactional-email.spec.ts`   |
| SL-F029-E2E-003 | P0         | critical   | desktop  | reserva cancelada não recebe lembrete                                   | `tests/e2e/critical/feat-029-transactional-email.spec.ts`   |
| SL-F029-E2E-004 | P1         | regression | desktop  | falha do provider é retentada e aparece em operações                    | `tests/e2e/regression/feat-029-transactional-email.spec.ts` |
| SL-F029-E2E-005 | P1         | regression | mobile   | snapshot HTML do e-mail é responsivo e acessível                        | `tests/e2e/regression/feat-029-transactional-email.spec.ts` |
| SL-F029-E2E-006 | P0         | critical   | desktop  | logs não contêm corpo completo nem dados pessoais excessivos            | `tests/e2e/critical/feat-029-transactional-email.spec.ts`   |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: outbox atômica, deduplicação e claim seguro
- unitário: templates/URLs
- contrato com provider falso
- fuso horário dos jobs

## Documentação viva afetada

- notifications.md
- observability.md
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
