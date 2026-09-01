# FEAT-009 — Submissão, status e controle editorial

## Metadados

| Campo            | Valor                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Em andamento                                                                                                                                                                                                                                                                          |
| Prioridade       | P0                                                                                                                                                                                                                                                                                    |
| Domínio          | `studios`                                                                                                                                                                                                                                                                             |
| Specs Playwright | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`<br>`tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts`<br>`tests/e2e/accessibility/feat-009-studio-publication-workflow.spec.ts`<br>`tests/e2e/reflow/feat-009-studio-publication-workflow.spec.ts` |

## Objetivo

Gerenciar o ciclo editorial do dono com checklist de completude, reaprovação e versão pública estável.

## Papéis

- dono

## Rotas e superfícies

- /dono/estudios/[studioId]/publicacao

## Dependências

- `dependency-to-start`: FEAT-006, FEAT-007 e FEAT-008;
- `dependency-to-complete`: FEAT-030 decide a candidata no backoffice e produz a aprovação ou
  rejeição real;
- `dependency-to-release`: FEAT-010/011 aplicam a visibilidade pública, FEAT-018/020 aplicam a
  elegibilidade de cotação/checkout e FEAT-024 prova que pausa não cancela reservas existentes;
- `contrato bootstrap`: esta feature cria somente o evento editorial e a outbox mínima consumidos
  imediatamente pela submissão real. Worker, provider, retry e experiência operacional pertencem à
  FEAT-029.

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
- A submissão produz uma única intenção deduplicada `studio.review.submitted` para a audiência de
  revisão. Aprovação/rejeição notificam o dono somente quando a FEAT-030 produzir esses fatos.
- A revisão candidata continua apontada por `draft_revision_id`, embora deixe de ser mutável quando
  seu status passa de `draft` para `pending`; o nome histórico da coluna não concede editabilidade.
- Em `paused`, uma candidata pode continuar privada. Retomar deriva `changes_pending` quando ela
  estiver `pending`; sem candidata pendente, deriva `published`. Uma candidata `draft` preservada
  continua privada e, com checklist completo, pode ser enviada sem nova edição artificial.
- O checklist e o submit revalidam tipo, tags e comodidades ativos. O submit mantém locks
  compartilhados determinísticos sobre a taxonomia referenciada até concluir a transação; um
  arquivamento concorrente não pode tornar pendente uma revisão baseada em item inativo.
- `occurred_at` é informação factual, não relógio de ordenação. O último fato editorial é escolhido
  pela sequência causal monotônica gerada pelo banco, inclusive quando timestamps empatam ou regridem.
- `submitted` só existe para a candidata `pending` ainda apontada pelo estúdio e com ator igual ao
  dono. `approved | rejected` exigem ator, submissão anterior da mesma revisão e estado terminal
  correspondente; fixtures locais preservam essa ordem causal.
- A FEAT-009 lê `disabled` de forma estritamente factual e bloqueia ações, mas não instala transições
  administrativas para entrar ou sair desse estado. Esse comando, sua fonte de restauração e sua
  auditoria pertencem à FEAT-030.

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
- Pausa grava o estado canônico e preserva ponteiros; FEAT-010/011 ocultam esse estado do público.
- Retomar restaura `published` ou `changes_pending` quando existe revisão aprovada e a autoridade do
  dono continua apta.
- Bloqueio de cotação/checkout e preservação de reservas são provas das respectivas features
  consumidoras, não afirmações artificiais desta fatia.

## Playwright obrigatório

| ID              | Prioridade | Suíte         | Viewport       | Cenário                                                                    | Spec                                                                   |
| --------------- | ---------- | ------------- | -------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| SL-F009-E2E-001 | P0         | critical      | desktop        | envio completo ocorre uma vez, vira pendente e bloqueia edição             | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`      |
| SL-F009-E2E-002 | P0         | critical      | desktop        | incompleto aponta seções sem POST, transição ou outbox                     | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`      |
| SL-F009-E2E-003 | P0         | critical      | desktop        | alteração publicada vira `changes_pending` sem trocar a versão pública     | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`      |
| SL-F009-E2E-004 | P0         | critical      | desktop        | resposta ambígua repete chave/payload sem duplicar transição ou outbox     | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`      |
| SL-F009-E2E-005 | P0         | critical      | desktop        | pausa/retomada preservam ponteiros e derivam draft ou pending corretamente | `tests/e2e/critical/feat-009-studio-publication-workflow.spec.ts`      |
| SL-F009-E2E-006 | P1         | regression    | mobile         | motivo semeado de rejeição navega à correção e preserva o publicado        | `tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts`    |
| SL-F009-E2E-007 | P1         | accessibility | desktop/mobile | fluxo central passa axe, teclado, foco, toque, 320 px e tema escuro        | `tests/e2e/accessibility/feat-009-studio-publication-workflow.spec.ts` |
| SL-F009-E2E-008 | P2         | reflow        | desktop        | publicação permanece operável em zoom de 200% nos três engines             | `tests/e2e/reflow/feat-009-studio-publication-workflow.spec.ts`        |
| SL-F009-E2E-009 | P1         | regression    | desktop/mobile | conflito ao pausar relê, move foco e não repete a transição                | `tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts`    |
| SL-F009-E2E-010 | P1         | regression    | desktop/mobile | sem JavaScript, conteúdo e ações privadas permanecem fechados              | `tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts`    |
| SL-F009-E2E-012 | P1         | regression    | desktop/mobile | divergência no mesmo fence recompõe SSR sem aceitar projeção mista         | `tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts`    |
| SL-F009-E2E-013 | P1         | regression    | desktop/mobile | taxonomia arquivada após leitura falha fechada, relê e não cria efeitos    | `tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts`    |
| SL-F009-E2E-014 | P1         | regression    | desktop/mobile | releitura autoritativa encerra ambiguidade sem repetir o comando           | `tests/e2e/regression/feat-009-studio-publication-workflow.spec.ts`    |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: evaluator canônico de completude, matriz de transições, imutabilidade de revisão/mídia,
  ordem causal, grants/RLS, idempotência, outbox e locks concorrentes de taxonomia;
- unitário: schemas e parsers estritos, contratos de comandos/read model, invalidação de cache e
  fronteiras server-only;
- integração: comando, releitura autoritativa e outbox transacional pelo banco local.

## Documentação viva afetada

- domain-model.md
- database.md
- api-contracts.md
- query-cache-invalidation.md
- notifications.md
- qa-test-plan.md
- ux-blueprint.md
- roadmap.md

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
