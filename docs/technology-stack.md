# Tecnologias usadas no Set Livre

Este resumo descreve a stack encontrada no código e nas decisões arquiteturais atuais. O projeto é um monorepo com uma aplicação pública, um backoffice separado e pacotes compartilhados.

## Aplicações e linguagem

| Tecnologia                   | Onde aparece                                                    | Por que é usada                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js 24.18 e npm 11.19    | `package.json`, `package-lock.json` e scripts em `scripts/`     | Executam as ferramentas em Windows 11 nativo e Linux e mantêm instalações reproduzíveis com `npm ci`. Os npm workspaces organizam a aplicação pública, o backoffice e os pacotes compartilhados. |
| Next.js 16 com App Router    | `src/app/`, `src/app/api/` e `apps/backoffice/src/app/`         | Estrutura páginas, Server Components, Route Handlers, layouts e os builds independentes das duas aplicações.                                                                                     |
| React 19                     | Componentes em `src/`, `apps/backoffice/src/` e `packages/ui/`  | Constrói a interface declarativa e mantém interatividade apenas nas bordas que precisam dela.                                                                                                    |
| TypeScript 5 em modo estrito | Arquivos `.ts`/`.tsx`, `tsconfig.base.json` e demais `tsconfig` | Torna explícitos os contratos entre interface, API, domínio e banco e detecta inconsistências antes da execução.                                                                                 |

## Interface e contratos

| Tecnologia                  | Onde aparece                                                                  | Por que é usada                                                                                |
| --------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| CSS Modules e CSS variables | `packages/ui/src/tokens.css`, arquivos `*.module.css` e `src/app/globals.css` | As variables centralizam tokens visuais; os Modules isolam os estilos de cada componente.      |
| Primitives React próprias   | `packages/ui/`                                                                | Compartilham componentes básicos entre as aplicações sem introduzir um segundo sistema visual. |
| TanStack Query              | `src/app/providers.tsx` e componentes/keys de query em `src/domains/`         | Mantém cache, carregamento, refetch e invalidação do estado remoto interativo.                 |
| Zod                         | `packages/contracts/`, rotas e módulos de servidor                            | Valida comandos, respostas, configuração e payloads externos nas fronteiras do sistema.        |

## Dados e autenticação

| Tecnologia                                 | Onde aparece                                                                               | Por que é usada                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase local e Supabase CLI do workspace | `supabase/config.toml`, `supabase/migrations/`, `supabase/seed.sql` e scripts `supabase:*` | Fornecem Auth, PostgreSQL e Storage locais e um ambiente descartável para desenvolvimento e testes destrutivos; o entrypoint fixado é executado pelo Node absoluto, sem CLI global. |
| `@supabase/ssr` e `@supabase/supabase-js`  | `src/lib/supabase/`                                                                        | Gerenciam sessão/cookies no servidor e acessos deliberadamente autorizados pelo Supabase.                                                                                           |
| PostgreSQL 17                              | Migrations, schema gerado e testes SQL em `supabase/`                                      | É a fonte canônica de dados e garante integridade com constraints, transações, locks, grants e RLS.                                                                                 |
| Driver `pg` e módulos `server-only`        | bootstrap local, `src/lib/server/dal-pool.ts`, DALs de domínio e backoffice                | Substituem `psql` como autoridade do setup e executam operações críticas no servidor com uma role restrita, sem expor credenciais ao navegador.                                     |
| Docker Desktop com containers Linux        | Scripts de ambiente local e stack iniciada pela Supabase CLI                               | No Windows 11 usa backend Hyper-V, sem WSL, e named pipe local; isola o Supabase e não participa da produção.                                                                       |

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

Os dois `next.config.ts` usam `output: "standalone"`. Desenvolvimento, preview, build, Supabase local, pgTAP e Playwright são suportados em Windows 11 nativo, sem WSL. O script `scripts/release-manifest.mjs` é um gate Linux-only: no Ubuntu de CI/release ele empacota a aplicação pública, o backoffice, migrations e metadados em releases reproduzíveis por SHA usando `flock`, GNU tar, modos POSIX e prova de mounts.

A arquitetura final prevê Supabase Cloud e uma VM Oracle Cloud `VM.Standard.E2.1.Micro` x86_64 com Ubuntu 24.04, processos Node sem root geridos por systemd, Nginx como proxy e troca atômica do symlink da release. CI, release e produção permanecem Linux; Docker não é instalado na VM. O ADR-019 liberou a configuração controlada de CI, Supabase, Oracle, DNS e TLS; o ADR-021 substituiu o alvo histórico A1/ARM64 por E2 Micro x86_64. A instância diagnóstica foi terminada após a prova de SSH. Em `2026-08-23`, não havia VM Set Livre ativa e sondas do Plan E2, sobre toda a única AD e sem fault domain fixo, encerraram fail-closed com `OUT_OF_HOST_CAPACITY`. O Supabase produtivo está saudável, com Auth/SSL configurados e credenciais locais protegidas; o GitHub já possui environment/repository guardrails, mas migrations, instalação das credenciais, runtime DAL, hardening, agente, DNS/TLS e primeiro run continuam fail-closed em PEND-001/002/003. A suspensão do ADR-018 permanece para pagamentos e APIs externas não liberadas.

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
- `docs/adr/ADR-020-windows-native-local-development.md`
- `docs/adr/ADR-021-oracle-e2-micro-production.md`
- `docs/adr/ADR-022-canonical-solutions-without-workarounds.md`
- `docs/adr/ADR-023-windows-job-object-process-supervision.md`
- `package.json` e manifests dos workspaces
- `next.config.ts`, `apps/backoffice/next.config.ts`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts` e `playwright.config.ts`
- `supabase/config.toml`, código representativo em `src/`, `packages/` e specs em `tests/`
