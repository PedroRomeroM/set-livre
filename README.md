# Set Livre

Marketplace brasileiro para descoberta, contratação e operação de estúdios audiovisuais.

## Estado atual

Implementado:

- autenticação, confirmação, login, logout e recuperação;
- perfil PF/PJ, preferências e conta;
- ativação de dono e onboarding local de recebedor;
- fundação dos apps web e backoffice;
- banco local com migrations, grants, RLS e testes destrutivos;
- health checks de liveness/readiness.

A ordem das próximas features está em [`docs/roadmap.md`](docs/roadmap.md). A infraestrutura de
produção é tratada nesta branch e só será declarada pronta após deploy e health públicos verdes.

## Stack

- Next.js 16, React 19 e TypeScript estrito;
- CSS Modules e primitives próprias;
- TanStack Query e Zod;
- Supabase Auth/Postgres/Storage;
- Vitest, pgTAP, Playwright e axe;
- Oracle Cloud `VM.Standard.E2.1.Micro` Always Free-eligible, Ubuntu 24.04, systemd e Nginx.

O contrato técnico completo está em [`AGENTS.md`](AGENTS.md).

## Desenvolvimento local

Requisitos: Windows 11, Node `24.18.0`, npm `11.19.0` e Docker Desktop em Linux containers.

```powershell
npm ci
npm run supabase:reset
npm run test:e2e:install
npm run dev
```

O web abre em `http://127.0.0.1:3000`. O backoffice usa:

```powershell
npm run dev:backoffice
```

Detalhes de ambiente e diagnóstico: [`docs/development.md`](docs/development.md).

## Gates

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run migrations:check
npm run supabase:reset
npm run supabase:lint
npm run test:db
npm run docs:check
npm run test:e2e
npm run build
npm run audit
npm run knip
```

Playwright e pgTAP operam somente contra a stack local explícita. Timeout ou execução interrompida é
inconclusiva, nunca aprovação.

## Estrutura

```text
apps/backoffice/   aplicação administrativa separada
packages/          contratos e primitives compartilhadas
src/               aplicação pública e domínios implementados
supabase/          configuração, migrations, seed e testes SQL
tests/             unitários e Playwright
scripts/           poucos coordenadores locais/CI
ops/               configuração versionada da VM e release
.github/workflows/ CI e deploy
docs/              contratos vivos, ADRs, roadmap e runbooks
```

`ops/` e os workflows são adicionados pela etapa de infraestrutura atual.

## Documentação

O índice canônico é [`docs/README.md`](docs/README.md). Planos de features são transitórios: depois de
merge e deploy, o arquivo correspondente em `docs/features/` é removido e os contratos duráveis ficam
nos documentos de domínio e testes.

## Entrega

Todo PR destinado a `main` segue [`docs/review-deploy-cycle.md`](docs/review-deploy-cycle.md): checks,
`@codex review`, espera mínima real de 60 minutos, correções e novos ciclos até review explicitamente
limpo no SHA atual. Depois do merge, Supabase, VM Oracle e health público são acompanhados até estado
terminal.
