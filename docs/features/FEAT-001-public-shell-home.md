# FEAT-001 — Shell público e home

## Metadados

| Campo            | Valor                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                                                                                    |
| Prioridade       | P0                                                                                                                                                                           |
| Domínio          | `public-web`                                                                                                                                                                 |
| Specs Playwright | `tests/e2e/smoke/feat-001-public-shell-home.spec.ts`<br>`tests/e2e/critical/feat-001-public-shell-home.spec.ts`<br>`tests/e2e/regression/feat-001-public-shell-home.spec.ts` |

## Objetivo

Apresentar a proposta Set Livre, oferecer navegação pública e transformar a intenção inicial em filtros válidos para a listagem, sem renderizar estúdios na home.

## Papéis

- visitante
- locatário
- dono

## Rotas e superfícies

- /
- /termos
- /privacidade
- /cancelamento

## Dependências

- design-system
- taxonomias públicas
- SEO
- Nginx/SSR

## Incluído

- Header e footer responsivos com links reais.
- Hero com data, bairro opcional e tipo de estúdio opcional.
- Conteúdo comercial fixo: categorias, como funciona, benefícios e CTA para donos.
- O envio serializa os filtros na URL de `/estudios`.
- Conteúdo essencial renderizado no servidor e indexável.
- Home não executa consulta de listagem nem exibe cards de estúdio.

## Fora desta feature

- CMS
- destaques dinâmicos
- recomendação algorítmica
- busca textual

## Regras de produto e domínio

- Data inválida não navega e mostra erro associado.
- Bairro e tipo usam taxonomias ativas.
- Filtros não selecionados são omitidos da URL.
- Links legais apontam para versões vigentes.
- CTA para dono leva ao fluxo autenticado/explicativo.

## Dados canônicos afetados

- taxonomias ativas
- versões legais

## Read models

- list_active_taxonomies
- metadata pública

## Comandos e integrações

- nenhum comando crítico; apenas navegação

## UX e estados obrigatórios

- Desktop com hero e seções; mobile com formulário em uma coluna.
- DatePicker acessível e input de 16px.
- O carregamento das taxonomias não remove o CTA; falha usa opção sem filtro.
- Sem JavaScript, conteúdo e links ainda são úteis.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Nenhuma PII.
- Sem dados de sessão em cache público.
- CSP e links externos seguros.

## Critérios de aceitação

- Home renderiza sem sessão.
- Nenhum estúdio/card aparece.
- Filtros válidos chegam à listagem.
- 320px sem overflow.
- Metadata, canonical e headings válidos.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                                | Spec                                                      |
| --------------- | ---------- | ---------- | -------- | ------------------------------------------------------ | --------------------------------------------------------- |
| SL-F001-E2E-001 | P0         | smoke      | desktop  | home pública renderiza, navega e não lista estúdios    | `tests/e2e/smoke/feat-001-public-shell-home.spec.ts`      |
| SL-F001-E2E-002 | P0         | critical   | mobile   | formulário envia data/bairro/tipo para URL da listagem | `tests/e2e/critical/feat-001-public-shell-home.spec.ts`   |
| SL-F001-E2E-003 | P1         | regression | desktop  | data inválida bloqueia navegação com erro acessível    | `tests/e2e/regression/feat-001-public-shell-home.spec.ts` |
| SL-F001-E2E-004 | P1         | regression | mobile   | header, menu e CTA funcionam a 320px                   | `tests/e2e/regression/feat-001-public-shell-home.spec.ts` |
| SL-F001-E2E-005 | P1         | regression | desktop  | axe não encontra violações críticas                    | `tests/e2e/regression/feat-001-public-shell-home.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: serialização de filtros e validação de data
- banco: taxonomias inativas não aparecem

## Documentação viva afetada

- ux-blueprint.md
- design-system.md
- qa-test-plan.md
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
