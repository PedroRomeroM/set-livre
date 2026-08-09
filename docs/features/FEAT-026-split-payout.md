# FEAT-026 — Split 80/20, agenda de repasse e fallback

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `finance` |
| Specs Playwright | `tests/e2e/critical/feat-026-split-payout.spec.ts`<br>`tests/e2e/regression/feat-026-split-payout.spec.ts` |

## Objetivo

Calcular shares sobre o bruto e efetuar/registrar repasse ao dono após o uso, com taxas da plataforma e bloqueios.

## Papéis

- dono
- finance/admin
- sistema

## Rotas e superfícies

- /dono/pagamentos
- /dono/recebimentos
- backoffice /repasses

## Dependências

- FEAT-004
- FEAT-024
- PaymentProvider

## Incluído

- Participações do dono e da plataforma.
- Split no provider.
- Payout scheduled.
- Completion eligibility.
- Worker de processamento.
- Falha e retentativa.
- Fallback manual.
- Visão do dono.

## Fora desta feature

- share configurável por studio
- escrow não contratado
- antecipação

## Regras de produto e domínio

- 8000/2000 bps.
- Gateway fee platform.
- Scheduled default end+24h.
- Reembolso, disputa ou bloqueio do recebedor impedem repasse.
- Um repasse pago é imutável; correções ocorrem por evento.
- A conclusão manual exige referência e auditoria.

## Dados canônicos afetados

- payouts/events
- snapshot financeiro da reserva
- status do recebedor

## Read models

- pagamentos e repasses do dono
- fila administrativa de repasses

## Comandos e integrações

- agendamento e processamento privado de repasse
- admin.payout.retry/block/unblock/manualComplete

## UX e estados obrigatórios

- Dono vê bruto, share e status.
- Sem detalhes internos do provider.
- O admin visualiza motivo e tentativas.
- A diferença entre agendado e pago é clara.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Papel financeiro obrigatório.
- Idempotency.
- Amount derived.
- Auditoria obrigatória.
- Segredos do provider permanecem somente no servidor.

## Critérios de aceitação

- Shares sum.
- Fee platform.
- Não há repasse antes do término.
- Refund/dispute blocks.
- Retentativa e conclusão manual são auditadas.
- O dono acessa apenas os próprios dados.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F026-E2E-001 | P0 | critical | desktop | split 80/20 calculado sobre bruto | `tests/e2e/critical/feat-026-split-payout.spec.ts` |
| SL-F026-E2E-002 | P0 | critical | desktop | payout não executa antes de end+24h | `tests/e2e/critical/feat-026-split-payout.spec.ts` |
| SL-F026-E2E-003 | P0 | critical | desktop | completed eligible paga uma vez | `tests/e2e/critical/feat-026-split-payout.spec.ts` |
| SL-F026-E2E-004 | P0 | critical | desktop | refund/dispute/recipient inactive bloqueiam | `tests/e2e/critical/feat-026-split-payout.spec.ts` |
| SL-F026-E2E-005 | P1 | regression | desktop | fallback manual exige confirmação e auditoria | `tests/e2e/regression/feat-026-split-payout.spec.ts` |
| SL-F026-E2E-006 | P0 | critical | desktop | dono A não vê payout B | `tests/e2e/critical/feat-026-split-payout.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: basis points/fees
- banco: payout eligibility/unique
- provider contract
- concorrência do worker

## Documentação viva afetada

- payments.md
- backoffice.md
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
