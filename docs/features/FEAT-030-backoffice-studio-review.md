# FEAT-030 — Backoffice de revisão e moderação de estúdios

## Metadados

| Campo            | Valor                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Em andamento                                                                                                                                                                                                                                                                                                                             |
| Prioridade       | P0                                                                                                                                                                                                                                                                                                                                       |
| Domínio          | `backoffice`                                                                                                                                                                                                                                                                                                                             |
| Specs Playwright | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`<br>`tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`<br>`tests/e2e/smoke/feat-030-backoffice-studio-review.spec.ts`<br>`tests/e2e/accessibility/feat-030-backoffice-studio-review.spec.ts`<br>`tests/e2e/reflow/feat-030-backoffice-studio-review.spec.ts` |

## Objetivo

Permitir que operadores autorizados revisem uma candidata editorial completa e decidam sua publicação
atomicamente, sem editar conteúdo em nome do dono e sem criar um modelo paralelo ao workflow da
FEAT-009.

O candidato local está implementado. Este plano permanece até suíte completa, documentação permanente
e review incremental verde, conforme ADR-015.

## Papéis

- `reviewer`: lê fila/detalhe e executa `approve/reject`;
- `admin`: substituto deliberado de `reviewer` e único papel que executa `disable/restore`;
- `support`: não recebe rota, read model, preview de Storage nem comando de revisão.

`private.backoffice_session_context(...)` recebe o papel exigido em cada superfície. A substituição por
`admin` é explícita; possuir qualquer papel do backoffice não concede implicitamente outra capacidade.

## Rotas e superfícies

- `/estudios`: fila privada, paginada por keyset em blocos de até 50 itens;
- `/estudios/[studioId]`: detalhe privado da candidata, comparação com a revisão publicada, checklist,
  mídia assinada e somente as ações permitidas pelo estado/papel;
- `POST /api/studios` e `GET /api/studios/[studioId]`: read models server-only;
- `POST /api/commands`: fronteira única das quatro escritas críticas.

## Dependências canônicas

- FEAT-009 — workflow editorial, ponteiros, eventos, checklist, ledger e outbox;
- FEAT-031 — sessão, autorização, desbloqueio, navegação e aplicação separada de backoffice;
- ADR-005 — Postgres/RLS, DAL restrita, migrations append-only e comandos privados;
- ADR-003 — TanStack Query, scope, arbitragem e invalidação autoritativa;
- ADR-017 — lote excepcional da fundação e review incremental por fatia.

A mídia é lida pelo contrato já integrado ao agregado editorial; FEAT-030 não cria pipeline de mídia.
ADR-014 trata de Oracle/systemd/Nginx e não é dependência editorial desta feature.
O hardening que mantém o deadline do driver posterior ao `statement_timeout` foi um pré-requisito
descoberto pela suíte global e não adiciona capacidade de produto à FEAT-030.

## Incluído

- fila derivada dos fatos e ponteiros editoriais existentes, sem tabela de “caso” paralela;
- comparação entre candidata e versão vigente, se houver;
- inspeção de conteúdo, endereço, taxonomias, FAQ, regras, vídeo e mídia privada;
- aprovação ou rejeição com motivo obrigatório;
- desativação e restauração exata pelo admin;
- auditoria, outbox e replay idempotente na mesma transação;
- loading, vazio, erro, conflito, sucesso e recuperação factual;
- composições responsivas, teclado, toque, axe e reflow a 200%.

## Fora desta feature

- reviewer editar conteúdo;
- preço ou precificação, que pertencem à FEAT-016 e não são antecipados;
- envio de e-mail, retry ou provider, que pertencem à FEAT-029;
- rota administrativa no aplicativo público;
- infraestrutura operacional/auditoria geral da FEAT-033.

## Regras de produto e domínio

- aprovação exige a candidata `pending`, o fence exato de revisão/publicação e move o ponteiro publicado
  atomicamente;
- rejeição mantém a versão pública vigente, registra o motivo e clona o conteúdo rejeitado para uma
  nova candidata `draft` editável pelo dono;
- rejeitar a primeira candidata mantém o estúdio fora do público;
- desativação guarda `disabled_from_status`; restauração recupera exatamente `published`,
  `changes_pending` ou `paused`, sem inferir o estado;
- cada comando recebe `expectedPublicationVersion` e `idempotencyKey`; decisões também recebem
  `expectedRevisionId`;
- replay idêntico devolve o resultado autoritativo; chave divergente, fence vencido ou segunda decisão
  produz conflito sem efeito parcial;
- transições incompatíveis são serializadas pelo banco; o browser nunca coordena mutações para simular
  atomicidade;
- aprovação/rejeição criam intenção deduplicada ao dono, mas não afirmam entrega de e-mail.

## Dados canônicos afetados

- `public.platform_roles`: inclui `reviewer`;
- `public.studios.disabled_from_status`: origem explícita de restauração administrativa;
- `private.studio_review_transition_fences`: fence transacional sem estado residual após comando;
- `public.studio_revisions`, `public.studio_review_events`, `public.studios`, `audit.events`,
  `public.email_outbox` e `private.backoffice_command_requests`: fontes existentes reutilizadas.

## Read models

- `private.list_backoffice_studio_reviews(...)`: fila keyset de pendências para reviewer/admin e,
  somente para admin, moderação/restauração;
- `private.get_backoffice_studio_review(...)`: detalhe tipado, checklist, capacidades e paths privados;
- o servidor assina previews de Storage por sessão autenticada; URL/expiração são projeções efêmeras e
  nenhum path ou service role é entregue como autoridade ao navegador. A candidata só é selecionada
  quando está `pending`; moderação/restauração usam a publicação e nunca expõem draft não submetido.

## Comandos e cache

- `backoffice.studio.approve` — reviewer/admin;
- `backoffice.studio.reject` — reviewer/admin;
- `backoffice.studio.disable` — admin;
- `backoffice.studio.restore` — admin.

As keys são `backoffice.studios(scope)` e `backoffice.studio(scope, studioId)`. Não há atualização
otimista. Sucesso substitui o detalhe autoritativo e invalida fila/detalhe; conflito exige GET antes de
outra decisão; resposta ambígua preserva exatamente payload e chave para repetição idempotente.

## UX e estados obrigatórios

- fila legível com estado editorial e continuidade keyset;
- comparação densa em seções semânticas, sem depender apenas de posição ou cor;
- galeria com dimensões limitadas e URLs assinadas de curta duração;
- confirmação de impacto em fluxo normal, com motivo obrigatório na rejeição;
- ações indisponíveis ausentes ou desabilitadas de acordo com papel e estado autoritativos;
- 320 px, 390 px, altura compacta, toque de 44 px, teclado, tema escuro e reflow a 160 CSS px.

## Segurança e privacidade

- origem, sessão, binding, papel, rate limit, tamanho, Zod e desbloqueio local são validados antes da
  DAL;
- a DAL `server-only` executa somente as fachadas allowlisted;
- grants e RLS são independentes; tabelas editoriais, fence, auditoria, outbox e ledger continuam sem
  acesso direto pelas roles web;
- a policy de Storage concede ao usuário autenticado apenas previews vinculados a uma candidata que
  ele pode revisar; `support`, `anon` e outros usuários recebem zero linhas;
- service role, SQL, stack, PII e paths privados não chegam ao navegador ou aos logs públicos;
- toda ação administrativa é auditada com request ID e payload redigido.

## Critérios de aceitação

- fila e detalhe mostram somente itens autorizados;
- aprovação publica a candidata exata;
- aprovação só permanece disponível com checklist completo e o recalcula sob locks antes de publicar;
- rejeição preserva a publicação e cria novo draft;
- duas sessões reviewer independentes disputam o caso e a segunda decisão recebe `409` sem transição
  duplicada;
- reviewer/support não ganham superfícies indevidas; admin substitui reviewer deliberadamente;
- disable/restore preservam o estado de origem exato;
- auditoria, outbox e replay idempotente são atômicos;
- o aplicativo público responde 404 para `/admin`.

## Playwright obrigatório

| ID              | Prioridade | Suíte         | Viewport/engine                | Cenário                                                    | Spec                                                                |
| --------------- | ---------- | ------------- | ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| SL-F030-E2E-001 | P0         | critical      | desktop, 3 engines             | reviewer aprova primeira revisão e publica                 | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`      |
| SL-F030-E2E-002 | P0         | critical      | desktop, 3 engines             | rejeitar alteração mantém versão pública e cria correção   | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`      |
| SL-F030-E2E-003 | P0         | critical      | desktop, 3 engines             | support autenticado é recusado na UI, rota e API           | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`      |
| SL-F030-E2E-004 | P0         | critical      | desktop, 3 engines             | duas decisões concorrentes: a segunda recebe conflito      | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`      |
| SL-F030-E2E-005 | P1         | regression    | desktop/mobile/320/compacto    | admin desativa e restaura o estado exato                   | `tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`    |
| SL-F030-E2E-006 | P0         | smoke         | desktop/mobile/320/compacto    | app público não expõe `/admin`                             | `tests/e2e/smoke/feat-030-backoffice-studio-review.spec.ts`         |
| SL-F030-E2E-007 | P1         | accessibility | desktop/mobile/320/tema escuro | axe, teclado e alvos de toque na decisão                   | `tests/e2e/accessibility/feat-030-backoffice-studio-review.spec.ts` |
| SL-F030-E2E-008 | P1         | reflow        | 160 × 360 CSS px, 3 engines    | comparação não cria overflow e mantém ação operável a 200% | `tests/e2e/reflow/feat-030-backoffice-studio-review.spec.ts`        |
| SL-F030-E2E-009 | P0         | critical      | desktop, 3 engines             | grant/revoke de reviewer atualiza a sessão já aberta       | `tests/e2e/critical/feat-030-backoffice-studio-review.spec.ts`      |
| SL-F030-E2E-010 | P0         | regression    | desktop/mobile/320/compacto    | resposta perdida repete payload e idempotência exatos      | `tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`    |
| SL-F030-E2E-011 | P1         | regression    | desktop/mobile/320/compacto    | preview inválida bloqueia decisão e renovação recupera     | `tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`    |
| SL-F030-E2E-012 | P0         | regression    | desktop/mobile/320/compacto    | conflito e releitura falha permanecem fechados             | `tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`    |
| SL-F030-E2E-013 | P1         | regression    | desktop/mobile/320/compacto    | fila recupera erro inicial e de página sem perder fatos    | `tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`    |
| SL-F030-E2E-014 | P0         | regression    | desktop/mobile/320/compacto    | 404 do comando descarta formulário e snapshot antes do GET | `tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`    |
| SL-F030-E2E-015 | P0         | regression    | desktop/mobile/320/compacto    | boundaries e 404 terminal descartam toda visão privada     | `tests/e2e/regression/feat-030-backoffice-studio-review.spec.ts`    |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup usa somente helper local com namespace QA;
- locators semânticos primeiro, sem `waitForTimeout`, `.skip` ou retry permanente;
- screenshots/traces pertencem apenas à evidência de falha.

## Testes unitários, integração e banco

- contratos Zod e autorização provam `support | reviewer | admin`, incluindo a substituição deliberada
  por admin;
- pgTAP prova schema, grants, RLS, Storage A/B, fila/detalhe, keyset com desempate, decisões,
  moderação, concorrência entre reviewers independentes, checklist revalidado após arquivamento,
  leituras simultâneas da mesma sessão sem lock exclusivo, idempotência, auditoria, outbox e ausência de
  fence residual;
- Playwright usa Auth, Storage, API, DAL e banco locais reais nos cenários terminais.

## Documentação viva afetada

- `backoffice.md`, `database.md`, `domain-model.md`, `api-contracts.md`;
- `query-cache-invalidation.md`, `notifications.md`, `design-system.md`;
- `qa-test-plan.md`, `roadmap.md`, `contexto-projeto-set-livre.html`.

Este plano permanece enquanto a feature estiver em andamento. O candidato só poderá removê-lo e marcar
o roadmap como concluído após implementação, suíte completa, documentação permanente e review
incremental verde no SHA candidato, conforme ADR-015.

## Definition of Done da feature

- todos os critérios acima comprovados;
- migration/grants/RLS verdes;
- read model, comando e invalidação documentados;
- suíte Playwright completa verde;
- desktop/mobile/teclado/axe/reflow verificados;
- logs, métricas e rollback/correção definidos;
- review incremental explicitamente limpo;
- nenhuma funcionalidade fora de escopo introduzida.
