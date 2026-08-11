# Set Livre — Plataforma Completa

## Implementação end-to-end orientada pela especificação 1.1

Este repositório contém a especificação viva e a implementação da **plataforma completa de aluguel de estúdios audiovisuais Set Livre**. A baseline documental define produto, arquitetura, contratos de dados, fluxos, qualidade e ordem; o código avança em fatias verticais rastreáveis.

O projeto não descreve o mini fórum comunitário. A aplicação é o marketplace comercial de estúdios, com calendário próprio, reservas, pagamentos, split, repasses, backoffice e operação de produção.

## Estado atual

- fundação local executável incorporada a `main`, sem feature de produto simulada;
- FEAT-002 na branch `feat/feat-002-auth-legal-core`, com as correções do quarto ciclo de review em validação e ainda fora da contagem de features concluídas;
- aplicações pública e backoffice separadas;
- Node/npm e dependências fixados em lockfile;
- Supabase local via Docker com 11 migrations append-only, head `20260811000400` e 236 asserts pgTAP verdes;
- rodada atual com 458 unitários e 59 execuções Playwright/axe verdes, combinando os 36 casos técnicos da fundação com as 23 execuções próprias da FEAT-002;
- `npm ci`, formatação, lint, TypeScript estrito, documentação, Knip, audit e builds das duas aplicações passaram sobre o quarto review; smokes standalone, release imutável e auditoria do índice ainda serão reemitidos após o commit técnico;
- resumo executivo vivo em `contexto-projeto-set-livre.html`, atualizado junto de cada mudança técnica;
- 34 features seguem a sequência canônica de `docs/implementation-order.md`, uma por branch/PR.

CI/CD, Supabase Cloud, Oracle Cloud e providers externos estão temporariamente diferidos pelo ADR-018 e rastreados em `pendencias.md`; isso bloqueia go-live, não a implementação local possível.

## Ordem obrigatória de leitura

1. `AGENTS.md`
2. `CODEX_HANDOFF.md`
3. `docs/00-source-of-truth.md`
4. `docs/reference/architecture-blueprint.md`
5. `docs/adr/`
6. `docs/specification.md`
7. `docs/architecture.md`
8. `docs/database.md`
9. `docs/calendar-reservations.md`
10. `docs/payments.md`
11. `docs/ux-blueprint.md`
12. `docs/qa-test-plan.md`
13. `docs/features/` na ordem do catálogo

## Escopo-alvo desta versão

A versão 1.1 implementa o **MVP Completo comercializável** aprovado:

- lançamento inicial em Curitiba/PR;
- locatários, donos de estúdio e backoffice administrativo;
- home pública, listagem filtrada e página de detalhe;
- cadastro e gestão de múltiplos estúdios por dono;
- revisão editorial e publicação;
- fotos de alta qualidade e vídeo por YouTube;
- calendário próprio avançado;
- regras de disponibilidade, exceções, bloqueios, buffer e duração;
- importação e exportação iCal;
- preço base, multiplicadores por dia e faixa horária;
- adicionais;
- reserva instantânea com prevenção de concorrência;
- cartão, PIX, split 80/20, repasse após o uso, retentativa e reembolso;
- e-mails transacionais;
- SEO completo, WCAG 2.2 AA, mobile a partir de 320 px;
- LGPD, exclusão/exportação de dados e backoffice separado;
- deploy em VM Oracle Cloud Free Tier com Nginx, systemd e releases imutáveis por SHA.

## Fora desta versão

Não implementar sem novo ADR e alteração formal de escopo:

- mini fórum ou comunidade;
- aplicativo nativo;
- chat;
- avaliações;
- mapa;
- assinatura;
- seguros;
- cupons;
- busca textual livre;
- múltiplos gestores por estúdio;
- carrinho com vários estúdios;
- Google Calendar automático;
- emissão automática de nota fiscal;
- multi-região e múltiplos fusos;
- relatórios analíticos avançados.

## Stack normativa

- Next.js 16 com App Router;
- React 19;
- TypeScript `strict`;
- npm com lockfile;
- CSS Modules, CSS variables e primitives próprias;
- TanStack Query para estado remoto;
- Supabase Cloud para Auth, PostgreSQL e Storage;
- Supabase local via CLI e Docker para desenvolvimento/CI;
- Zod nos limites de entrada;
- `pg` server-only para o DAL de comandos;
- Vitest, Playwright, axe, ESLint e Knip;
- GitHub Actions;
- Oracle Cloud Ampere A1 ARM64;
- Nginx, systemd e releases por SHA.

## Regra de conclusão

Nenhuma feature é considerada concluída apenas porque a interface funciona. A entrega exige coerência entre:

- especificação;
- ADRs;
- migrations;
- grants e RLS;
- comandos e read models;
- UI desktop/mobile;
- testes;
- observabilidade;
- documentação viva;
- deploy e rollback.

Leia `AGENTS.md` antes de qualquer alteração.

## Validação

Consulte `contexto-projeto-set-livre.html` para acompanhar o progresso em alto nível, `docs/validation-report.md` para a baseline recebida, `MANIFEST_SHA256.md` para sua integridade histórica e `docs/changes/` para a evolução executável.
