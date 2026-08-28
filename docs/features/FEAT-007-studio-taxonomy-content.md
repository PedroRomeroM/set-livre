# FEAT-007 — Tags, comodidades, regras, FAQ e vídeo

## Metadados

| Campo            | Valor                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                                        |
| Prioridade       | P0                                                                                                                               |
| Domínio          | `studios`                                                                                                                        |
| Specs Playwright | `tests/e2e/critical/feat-007-studio-taxonomy-content.spec.ts`<br>`tests/e2e/regression/feat-007-studio-taxonomy-content.spec.ts` |

## Objetivo

Completar o conteúdo comercial da revisão com taxonomias administradas e textos seguros.

## Papéis

- dono

## Rotas e superfícies

- /dono/estudios/[studioId]/dados

## Dependências

- FEAT-006
- FEAT-031

## Incluído

- Tipo de estúdio.
- Tags e comodidades.
- Regras de uso.
- FAQ ordenável.
- Vídeo por YouTube ID.
- Validações de limite e ativos.

## Fora desta feature

- HTML/Markdown arbitrário
- upload de vídeo
- tag criada pelo dono

## Regras de produto e domínio

- Somente taxonomia ativa pode ser selecionada.
- Máximo 20 tags e 20 FAQs.
- FAQ question 160/answer 2000.
- Vídeo é ID validado.
- Textos são plain text renderizados com escape.
- A alteração ocorre apenas no rascunho.

## Dados canônicos afetados

- studio_revision_tags
- studio_revision_amenities
- studio_faqs
- youtube_video_id

## Read models

- get_owner_studio_editor
- list_active_taxonomies

## Comandos e integrações

- studio.revision.updateTaxonomy
- studio.revision.updateContent

## UX e estados obrigatórios

- Multi-select acessível com busca local da lista carregada.
- Inclusão, reordenação e exclusão de FAQ.
- Pré-visualização do vídeo.
- Empty taxonomy orienta contato/admin, não cria improviso.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Sem XSS.
- IDs validados e ownership da revisão.
- Taxonomias inativas não entram.
- URL do YouTube validada por allowlist.

## Critérios de aceitação

- Conteúdo salva e renderiza com escape.
- Taxonomias inválidas falham.
- FAQ ordena.
- YouTube inválido falha.
- Outro dono não altera.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                   | Spec                                                            |
| --------------- | ---------- | ---------- | -------- | ----------------------------------------- | --------------------------------------------------------------- |
| SL-F007-E2E-001 | P0         | critical   | desktop  | salvar tags, comodidades, regras e FAQ    | `tests/e2e/critical/feat-007-studio-taxonomy-content.spec.ts`   |
| SL-F007-E2E-002 | P1         | regression | mobile   | reordenar FAQ e preservar conteúdo        | `tests/e2e/regression/feat-007-studio-taxonomy-content.spec.ts` |
| SL-F007-E2E-003 | P0         | critical   | desktop  | tag inativa/externa é rejeitada           | `tests/e2e/critical/feat-007-studio-taxonomy-content.spec.ts`   |
| SL-F007-E2E-004 | P1         | regression | desktop  | YouTube válido renderiza e inválido falha | `tests/e2e/regression/feat-007-studio-taxonomy-content.spec.ts` |
| SL-F007-E2E-005 | P0         | critical   | desktop  | texto malicioso não executa script        | `tests/e2e/critical/feat-007-studio-taxonomy-content.spec.ts`   |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: YouTube parser/text limits
- banco: joins/active validation via command
- segurança: XSS render

## Documentação viva afetada

- media.md
- design-system.md
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
