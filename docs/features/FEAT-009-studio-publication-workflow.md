# FEAT-009 — Envio, status, edição, pausa e publicação

## Metadados

| Campo            | Valor                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                                                |
| Prioridade       | P0                                                                                                                                       |
| Domínio          | `studios`                                                                                                                                |
| Specs Playwright | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`<br>`tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts` |

## Objetivo

Gerenciar o ciclo editorial do dono com checklist de completude, reaprovação e versão pública estável.

## Papéis

- dono

## Rotas e superfícies

- /dono/estudios/[studioId]/publicacao

## Dependências

- FEAT-006
- FEAT-007
- FEAT-008
- FEAT-030

## Incluído

- Checklist derivado.
- Enviar para revisão.
- Status e motivo de rejeição.
- Editar publicado em nova revisão.
- Pausar e retomar.
- Pré-visualização da versão pública e do rascunho.

## Fora desta feature

- aprovação automática
- dono publicar sem review
- workflow configurável

## Regras de produto e domínio

- O envio valida todos os requisitos.
- Uma revisão pendente é imutável.
- Versão pública anterior permanece durante changes_pending.
- Pausa remove novas reservas, não cancela existentes.
- Retomar exige publicação aprovada e operação apta.
- Notificar admin e dono pela outbox.

## Dados canônicos afetados

- studios
- studio_revisions
- review events
- email_outbox

## Read models

- status de publicação para o dono

## Comandos e integrações

- studio.revision.submit
- studio.pause
- studio.resume
- studio.draft.discard

## UX e estados obrigatórios

- Checklist aponta seção.
- Status factual.
- Rejeição mostra motivo.
- Confirmação de pausa explica impacto.
- Sem botão sem ação.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Ownership.
- Transições no banco.
- Audit de pausa/retoma relevantes.
- Não confiar no checklist enviado pelo cliente.

## Critérios de aceitação

- Um rascunho incompleto não é enviado.
- Completo envia uma vez.
- Publicado permanece durante alteração.
- Pausa oculta e bloqueia checkout.
- Retomar restaura quando elegível.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                      | Spec                                                                |
| --------------- | ---------- | ---------- | -------- | -------------------------------------------- | ------------------------------------------------------------------- |
| SL-F009-E2E-001 | P0         | critical   | desktop  | envio completo entra em estado pendente      | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`   |
| SL-F009-E2E-002 | P0         | critical   | desktop  | incompleto aponta campos e não transiciona   | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`   |
| SL-F009-E2E-003 | P0         | critical   | desktop  | edição de revisão pendente é bloqueada       | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`   |
| SL-F009-E2E-004 | P0         | critical   | desktop  | pausa oculta estúdio sem cancelar reserva    | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`   |
| SL-F009-E2E-005 | P1         | regression | mobile   | motivo de rejeição e navegação para correção | `tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: transition matrix/immutability
- unitário: completeness evaluator
- integração: outbox

## Documentação viva afetada

- domain-model.md
- notifications.md
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
