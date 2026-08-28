# FEAT-030 — Backoffice de revisão e moderação de estúdios

## Metadados

| Campo            | Valor                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                                                                                                         |
| Prioridade       | P0                                                                                                                                                                                                |
| Domínio          | `backoffice`                                                                                                                                                                                      |
| Specs Playwright | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`<br>`tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`<br>`tests/e2e/smoke/feat-030-backoffice-studio-review.spec.ts` |

## Objetivo

Permitir revisão integral e publicação atômica por operador autorizado em aplicação separada.

## Papéis

- reviewer
- admin

## Rotas e superfícies

- backoffice /estudios
- backoffice /estudios/[id]

## Dependências

- FEAT-009
- FEAT-008
- ADR-014

## Incluído

- Fila de revisão.
- Comparação entre versão vigente e pendente.
- Inspeção de mídia, conteúdo, endereço e resumo de preço.
- Aprovação ou rejeição com motivo.
- Desativação e restauração pelo admin.
- Auditoria obrigatória.

## Fora desta feature

- reviewer editar conteúdo
- rota admin pública

## Regras de produto e domínio

- A aprovação troca o ponteiro publicado atomicamente.
- A rejeição mantém a versão pública vigente.
- A primeira revisão rejeitada mantém o estúdio fora do público.
- A ação é idempotente e consciente de conflitos.
- A desativação administrativa é separada e mais restritiva.
- O dono é notificado.

## Dados canônicos afetados

- revisões, eventos de revisão, auditoria e outbox

## Read models

- listagem e detalhe privados do caso de revisão

## Comandos e integrações

- admin.studio.approve/reject/disable/restore

## UX e estados obrigatórios

- Comparação densa e legível.
- Galeria de mídia.
- Checklist de revisão.
- Confirmação de impacto.
- Conflito quando o caso já foi tratado.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Rede, sessão e papel do backoffice são validados.
- A service role nunca chega ao navegador.
- Auditoria obrigatória.
- Somente os dados pessoais necessários são exibidos.

## Critérios de aceitação

- A fila é correta.
- A aprovação publica.
- A rejeição mantém a versão anterior.
- Papel não autorizado é rejeitado.
- Auditoria e outbox são geradas.
- O aplicativo público não expõe administração.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                               | Spec                                                             |
| --------------- | ---------- | ---------- | -------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| SL-F030-E2E-001 | P0         | critical   | desktop  | reviewer aprova primeira revisão e publica            | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`   |
| SL-F030-E2E-002 | P0         | critical   | desktop  | rejeitar alteração mantém versão pública              | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`   |
| SL-F030-E2E-003 | P0         | critical   | desktop  | revisor sem papel autorizado é rejeitado              | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`   |
| SL-F030-E2E-004 | P0         | critical   | desktop  | duas revisões concorrentes: a segunda recebe conflito | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`   |
| SL-F030-E2E-005 | P1         | regression | desktop  | desativar ou restaurar exige admin e auditoria        | `tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts` |
| SL-F030-E2E-006 | P0         | smoke      | desktop  | app público não expõe /admin                          | `tests/e2e/smoke/feat-030-backoffice-studio-review.spec.ts`      |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: transação de aprovação/rejeição e papéis
- auditoria e outbox
- isolamento de rotas do backoffice

## Documentação viva afetada

- backoffice.md
- domain-model.md
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
