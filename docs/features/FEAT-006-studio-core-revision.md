# FEAT-006 — Criação do estúdio e dados centrais versionados

## Metadados

| Campo            | Valor                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Em andamento                                                                                                                                                                                                                                              |
| Prioridade       | P0                                                                                                                                                                                                                                                        |
| Domínio          | `studios`                                                                                                                                                                                                                                                 |
| Specs Playwright | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`<br>`tests/e2e/regression/feat-006-studio-core-revision.spec.ts`<br>`tests/e2e/accessibility/feat-006-studio-core-revision.spec.ts`<br>`tests/e2e/reflow/feat-006-studio-core-revision.spec.ts` |

## Objetivo

Criar a entidade estúdio e uma revisão editável com dados públicos completos, preservando a versão aprovada.

## Papéis

- dono

## Rotas e superfícies

- /dono/estudios/novo
- /dono/estudios/[studioId]/dados

## Dependências

- FEAT-003
- FEAT-004
- taxonomias

## Incluído

- Nome, descrição, endereço completo, bairro/cidade/UF/CEP.
- Capacidade e tipo.
- Criação do estúdio e da revisão em rascunho.
- Edição com controle de concorrência otimista.
- Validação de Curitiba/PR na baseline.
- Pré-visualização da revisão.

## Fora desta feature

- mapa/geocoding
- múltiplos donos
- slug customizado

## Regras de produto e domínio

- O dono pode ter múltiplos estúdios.
- Um estúdio tem no máximo um rascunho ativo.
- Revisão submetida é imutável.
- Editar publicado clona revisão aprovada.
- Endereço completo será público após aprovação.
- Revision number cresce monotonicamente.

## Dados canônicos afetados

- studios
- studio_revisions

## Read models

- get_owner_studio_editor

## Comandos e integrações

- studio.create
- studio.revision.updateCore
- studio.draft.discard

## UX e estados obrigatórios

- Form por seções.
- Salvar explícito.
- Conflito de versão mostra recarregar/comparar.
- A pré-visualização não é publicada.
- Campos longos com contador.
- Dados SSR privados ficam ocultos até a releitura autoritativa do mesmo escopo.
- Toda releitura revalida conta, perfil, autoridade de dono e contrato vigente; revogação recompõe a
  superfície factual antes de nova ação.
- Criação aceita entra em estado terminal e oferece navegação explícita para o editor.
- Tipo arquivado continua histórico, mas exige escolha ativa para salvar.
- Estúdio administrativamente desabilitado permanece somente leitura.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Ownership em todas as referências.
- Endereço/PII não aparece antes de aprovado.
- Zod + checks de banco.
- Não aceitar status nem número de revisão enviados pelo cliente.

## Critérios de aceitação

- Criação atômica.
- Edição não altera publicado.
- Conflito concorrente não perde silenciosamente.
- Curitiba/PR validado.
- Outro dono não edita.

## Playwright obrigatório

| ID              | Prioridade | Suíte         | Viewport                   | Cenário                                                         | Spec                                                            |
| --------------- | ---------- | ------------- | -------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| SL-F006-E2E-001 | P0         | critical      | desktop                    | criar estúdio e salvar revisão em rascunho                      | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`      |
| SL-F006-E2E-002 | P0         | critical      | 3 engines                  | editar publicado clona draft e preserva a revisão aprovada      | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`      |
| SL-F006-E2E-003 | P0         | critical      | 3 engines                  | dono B não lê nem altera estúdio A e a rota não revela dados    | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`      |
| SL-F006-E2E-004 | P1         | regression    | desktop/mobile/320/compact | validação preserva dados inválidos e não envia POST             | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts`    |
| SL-F006-E2E-005 | P1         | regression    | desktop/mobile/320/compact | retry compara valores e nomes de tipos, sem UUID ou cache stale | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts`    |
| SL-F006-E2E-006 | P1         | accessibility | desktop/mobile/320/dark    | axe, teclado, toque e alvos de 44 px                            | `tests/e2e/accessibility/feat-006-studio-core-revision.spec.ts` |
| SL-F006-E2E-007 | P2         | reflow        | 3 engines                  | criação e editor sem overflow no viewport equivalente a 200%    | `tests/e2e/reflow/feat-006-studio-core-revision.spec.ts`        |
| SL-F006-E2E-008 | P0         | critical      | 3 engines                  | troca de sessão oculta o editor antes da releitura              | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`      |
| SL-F006-E2E-009 | P1         | regression    | desktop/mobile/320/compact | criação aceita fica terminal antes da navegação                 | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts`    |
| SL-F006-E2E-010 | P1         | regression    | desktop/mobile/320/compact | retry ambíguo congela e reutiliza payload/chave                 | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts`    |
| SL-F006-E2E-011 | P1         | regression    | desktop/mobile/320/compact | descarte recupera refetch e navegação explícita sem token stale | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts`    |
| SL-F006-E2E-012 | P1         | regression    | desktop/mobile/320/compact | estúdio desabilitado fica estritamente somente leitura          | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts`    |
| SL-F006-E2E-013 | P1         | regression    | desktop/mobile/320/compact | arquivamento concorrente recupera o editor                      | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts`    |
| SL-F006-E2E-014 | P1         | regression    | desktop/mobile/320/compact | arquivamento concorrente recupera a criação                     | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts`    |
| SL-F006-E2E-015 | P1         | regression    | desktop/mobile/320/compact | revogação de conta bloqueia e recompõe o editor aberto          | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts`    |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: criação atômica, ownership/RLS/grants, contrato vigente, replay de resultado exato,
  histórico de tipo arquivado, unicidade de draft, imutabilidade, clone, descarte e auditoria sem
  conteúdo privado;
- unitário: contratos Zod, DAL, serviço, registry, rotas, read models, API browser, cache privado,
  conflito e boundary de hidratação;
- integração/Playwright: clone de revisão aprovada, isolamento entre donos e sessões, validação,
  recuperação de conflito/update/descarte, refetch concorrente, retry ambíguo, estados
  terminal/desabilitado e arquivamento concorrente em criação/edição, acessibilidade e reflow.

## Documentação viva afetada

- database.md
- domain-model.md
- api-contracts.md
- query-cache-invalidation.md
- qa-test-plan.md
- design-system.md
- ux-blueprint.md

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
