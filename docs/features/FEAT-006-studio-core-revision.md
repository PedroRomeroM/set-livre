# FEAT-006 — Criação do estúdio e dados centrais versionados

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `studios` |
| Specs Playwright | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`<br>`tests/e2e/regression/feat-006-studio-core-revision.spec.ts` |

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

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

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

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F006-E2E-001 | P0 | critical | desktop | criar estúdio e salvar revisão em rascunho | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts` |
| SL-F006-E2E-002 | P0 | critical | desktop | editar publicado cria revisão sem alterar página pública | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts` |
| SL-F006-E2E-003 | P0 | critical | desktop | dono A não edita estúdio B | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts` |
| SL-F006-E2E-004 | P1 | regression | mobile | validação de endereço/capacidade | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts` |
| SL-F006-E2E-005 | P1 | regression | desktop | conflito de concorrência otimista mostra recuperação | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: revision uniqueness/immutability
- unitário: core schema
- integração: clone approved revision

## Documentação viva afetada

- database.md
- domain-model.md
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
