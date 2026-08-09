# FEAT-011 — Detalhe público, galeria e SEO

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `public-web` |
| Specs Playwright | `tests/e2e/smoke/feat-011-public-studio-detail-seo.spec.ts`<br>`tests/e2e/critical/feat-011-public-studio-detail-seo.spec.ts`<br>`tests/e2e/regression/feat-011-public-studio-detail-seo.spec.ts` |

## Objetivo

Apresentar toda informação aprovada necessária para decidir e iniciar reserva, com SEO e acessibilidade.

## Papéis

- visitante
- usuário autenticado

## Rotas e superfícies

- /estudios/[studioId]

## Dependências

- FEAT-008
- FEAT-009
- FEAT-012
- FEAT-016

## Incluído

- Galeria/lightbox.
- Nome, endereço completo, tipo, capacidade.
- Descrição, regras, amenities, tags, FAQ.
- YouTube.
- Preço base e resumo.
- Disponibilidade/calendário.
- CTA reservar.
- Metadata/OG/JSON-LD/canonical.

## Fora desta feature

- mapa
- avaliação
- chat
- slug obrigatório

## Regras de produto e domínio

- Somente revisão publicada.
- ID inexistente/não publicado = 404.
- Uma alteração pendente não é exposta.
- Endereço completo público por decisão.
- CTA respeita operational eligibility.
- Dados estruturados não prometem disponibilidade/preço incorreto.

## Dados canônicos afetados

- revisão publicada
- media
- taxonomy
- resumo de calendário e preço

## Read models

- get_studio_detail
- get_studio_availability

## Comandos e integrações

- nenhum comando; CTA navega

## UX e estados obrigatórios

- Gallery responsive.
- Sticky CTA mobile.
- Calendário com alternativa textual.
- FAQ sem hover.
- Vídeo lazy.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- DTO público mínimo.
- Sem dados pessoais do dono.
- XSS escape.
- URLs de mídia controladas.

## Critérios de aceitação

- Publicado renderiza.
- Rascunho e revisão pendente não são expostos.
- SEO correto.
- Gallery teclado/mobile.
- CTA leva configurador com contexto.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F011-E2E-001 | P0 | smoke | desktop | detalhe publicado renderiza conteúdo aprovado | `tests/e2e/smoke/feat-011-public-studio-detail-seo.spec.ts` |
| SL-F011-E2E-002 | P0 | critical | desktop | revisão pendente não aparece | `tests/e2e/critical/feat-011-public-studio-detail-seo.spec.ts` |
| SL-F011-E2E-003 | P0 | critical | desktop | estúdio não publicado retorna 404 segura | `tests/e2e/critical/feat-011-public-studio-detail-seo.spec.ts` |
| SL-F011-E2E-004 | P1 | regression | mobile | galeria, lightbox e CTA fixo | `tests/e2e/regression/feat-011-public-studio-detail-seo.spec.ts` |
| SL-F011-E2E-005 | P1 | regression | desktop | metadados canonical, OG e JSON-LD | `tests/e2e/regression/feat-011-public-studio-detail-seo.spec.ts` |
| SL-F011-E2E-006 | P1 | regression | desktop | axe e teclado no FAQ/galeria | `tests/e2e/regression/feat-011-public-studio-detail-seo.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: metadata/YouTube/DTO
- banco: visibilidade do detalhe público
- snapshot SEO

## Documentação viva afetada

- media.md
- ux-blueprint.md
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
