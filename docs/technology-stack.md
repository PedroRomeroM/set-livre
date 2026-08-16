# Tecnologias usadas no Set Livre

Este resumo descreve a stack encontrada no código e nas decisões arquiteturais atuais. O projeto é um monorepo com uma aplicação pública, um backoffice separado e pacotes compartilhados.

## Aplicações e linguagem

| Tecnologia                   | Onde aparece                                                    | Por que é usada                                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js 24 e npm 11          | `package.json`, `package-lock.json` e scripts em `scripts/`     | Executam as ferramentas do projeto e mantêm instalações reproduzíveis com `npm ci`. Os npm workspaces organizam a aplicação pública, o backoffice e os pacotes compartilhados. |
| Next.js 16 com App Router    | `src/app/`, `src/app/api/` e `apps/backoffice/src/app/`         | Estrutura páginas, Server Components, Route Handlers, layouts e os builds independentes das duas aplicações.                                                                   |
| React 19                     | Componentes em `src/`, `apps/backoffice/src/` e `packages/ui/`  | Constrói a interface declarativa e mantém interatividade apenas nas bordas que precisam dela.                                                                                  |
| TypeScript 5 em modo estrito | Arquivos `.ts`/`.tsx`, `tsconfig.base.json` e demais `tsconfig` | Torna explícitos os contratos entre interface, API, domínio e banco e detecta inconsistências antes da execução.                                                               |

## Interface e contratos

| Tecnologia                  | Onde aparece                                                                  | Por que é usada                                                                                |
| --------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| CSS Modules e CSS variables | `packages/ui/src/tokens.css`, arquivos `*.module.css` e `src/app/globals.css` | As variables centralizam tokens visuais; os Modules isolam os estilos de cada componente.      |
| Primitives React próprias   | `packages/ui/`                                                                | Compartilham componentes básicos entre as aplicações sem introduzir um segundo sistema visual. |
| TanStack Query              | `src/app/providers.tsx` e componentes/keys de query em `src/domains/`         | Mantém cache, carregamento, refetch e invalidação do estado remoto interativo.                 |
| Zod                         | `packages/contracts/`, rotas e módulos de servidor                            | Valida comandos, respostas, configuração e payloads externos nas fronteiras do sistema.        |

## Dados e autenticação

| Tecnologia                                | Onde aparece                                                                               | Por que é usada                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Supabase local e Supabase CLI             | `supabase/config.toml`, `supabase/migrations/`, `supabase/seed.sql` e scripts `supabase:*` | Fornecem Auth, PostgreSQL e Storage locais e um ambiente descartável para desenvolvimento e testes destrutivos. |
| `@supabase/ssr` e `@supabase/supabase-js` | `src/lib/supabase/`                                                                        | Gerenciam sessão/cookies no servidor e acessos deliberadamente autorizados pelo Supabase.                       |
| PostgreSQL 17                             | Migrations, schema gerado e testes SQL em `supabase/`                                      | É a fonte canônica de dados e garante integridade com constraints, transações, locks, grants e RLS.             |
| Driver `pg` e módulos `server-only`       | `src/lib/server/dal-pool.ts`, DALs de domínio e backoffice                                 | Executam operações críticas no servidor com uma role de banco restrita, sem expor credenciais ao navegador.     |
| Docker                                    | Scripts de ambiente local e stack iniciada pela Supabase CLI                               | Isola os serviços locais do Supabase. Não é a estratégia prevista para produção.                                |

## Qualidade

| Tecnologia                   | Onde aparece                                                 | Por que é usada                                                                                      |
| ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Vitest                       | `vitest.config.ts` e `tests/unit/`                           | Executa testes unitários e guardrails rápidos.                                                       |
| Playwright                   | `playwright.config.ts` e `tests/e2e/`                        | Valida fluxos reais no desktop, mobile, Chromium, Firefox e WebKit.                                  |
| axe-core                     | Specs em `tests/e2e/accessibility/` e regressões centrais    | Automatiza verificações de acessibilidade junto aos testes de navegador.                             |
| ESLint e `tsc --noEmit`      | `eslint.config.mjs`, `tsconfig*` e scripts do `package.json` | Aplicam regras de código, tipos e fronteiras entre UI e módulos exclusivos do servidor.              |
| Prettier, Knip e `npm audit` | Dependências e scripts do `package.json`                     | Padronizam formatação, detectam código/dependências sem uso e verificam vulnerabilidades conhecidas. |
| pgTAP pela stack local       | `supabase/tests/` e script `test:db`                         | Prova migrations, permissões, RLS, isolamento entre usuários e invariantes do banco.                 |

## Build e destino operacional

Os dois `next.config.ts` usam `output: "standalone"`. O script `scripts/release-manifest.mjs` empacota a aplicação pública, o backoffice, migrations e metadados em releases locais reproduzíveis por SHA.

A arquitetura final prevê Supabase Cloud e uma VM Oracle Cloud ARM64 com Ubuntu, processos Node sem root geridos por systemd, Nginx como proxy e troca atômica do symlink da release. O ADR-019 liberou a configuração controlada de CI, Supabase, Oracle, DNS e TLS, sem remover o Supabase local dos testes destrutivos. Workflows e target existem em fonte, mas produção ainda não está ativa: environment/secrets, runtime DAL, VM, DNS/TLS e primeiro run continuam fail-closed em PEND-001/002/003. A suspensão do ADR-018 permanece para pagamentos e APIs externas não liberadas.

## Fontes verificadas

- `AGENTS.md`
- `docs/reference/architecture-blueprint.md`
- `docs/adr/ADR-002-repository-and-app-boundaries.md`
- `docs/adr/ADR-003-remote-state-and-read-contract.md`
- `docs/adr/ADR-004-critical-command-pipeline.md`
- `docs/adr/ADR-005-supabase-and-database-security.md`
- `docs/adr/ADR-013-css-modules-and-primitives.md`
- `docs/adr/ADR-014-oracle-systemd-nginx-releases.md`
- `docs/adr/ADR-018-local-first-delivery-boundary.md`
- `docs/adr/ADR-019-controlled-cloud-delivery.md`
- `package.json` e manifests dos workspaces
- `next.config.ts`, `apps/backoffice/next.config.ts`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts` e `playwright.config.ts`
- `supabase/config.toml`, código representativo em `src/`, `packages/` e specs em `tests/`
