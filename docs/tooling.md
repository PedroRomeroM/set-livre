# Tooling e comandos do repositório

## 1. Runtime

- Node.js LTS suportado pelo Next.js 16, fixado em `.nvmrc`/`engines`;
- default documental: Node 24.x;
- npm 11.x;
- um `package-lock.json`;
- `npm ci` em CI.

## 2. Workspaces

```json
{
  "workspaces": [
    "apps/*",
    "packages/*"
  ]
}
```

A aplicação pública usa o package raiz. Backoffice e packages usam workspaces.

## 3. Scripts obrigatórios

```json
{
  "scripts": {
    "dev": "executa app público",
    "dev:backoffice": "executa backoffice",
    "dev:all": "executa apps e workers locais",
    "build": "build público + backoffice + workers",
    "build:web": "next build",
    "build:backoffice": "npm --workspace apps/backoffice run build",
    "start": "next start",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit && workspaces typecheck",
    "test:unit": "vitest run",
    "test:unit:watch": "vitest",
    "supabase:start": "supabase start",
    "supabase:stop": "supabase stop",
    "supabase:reset": "supabase db reset",
    "test:db": "executa pgTAP/SQL/integration",
    "test:e2e": "playwright test",
    "test:e2e:affected": "seleciona features alteradas",
    "test:e2e:critical": "playwright test tests/e2e/critical",
    "test:a11y": "suíte axe",
    "docs:check": "links, IDs, mudanças, source chain",
    "audit": "npm audit --audit-level=high",
    "knip": "knip",
    "release:manifest": "gera manifest do artifact"
  }
}
```

Os comandos reais devem ser implementados sem shell não portável desnecessário.

## 4. TypeScript

- `strict: true`;
- `noUncheckedIndexedAccess`;
- `exactOptionalPropertyTypes`;
- `noImplicitOverride`;
- `useUnknownInCatchVariables`;
- aliases estáveis;
- `server-only` para DAL/providers;
- tipos de banco gerados após migration.

## 5. ESLint

Gates:

- regras Next/React;
- imports;
- no floating promises;
- no explicit any;
- no console;
- hooks;
- server/client boundary guard;
- no restricted imports (`pg` fora server, backoffice/public crossing).

## 6. Formatting

Prettier apenas formata. Não substitui lint. Markdown também é formatado/verificado.

## 7. Vitest

Cobrir:

- normalizers;
- Zod schemas;
- preço;
- data/fuso;
- estado;
- cursor;
- provider mapping;
- templates;
- route helpers.

Não mockar domínio até o teste deixar de provar contrato.

## 8. Playwright

Config:

- webServer local;
- projects;
- trace on-first-retry ou failure;
- screenshot only-on-failure;
- retries 0 local, máximo controlado CI;
- one worker para specs stateful quando necessário;
- global safety guard.

## 9. Supabase

Local setup:

1. Docker;
2. `supabase start`;
3. `supabase db reset`;
4. seed;
5. roles;
6. users QA;
7. type generation;
8. DB tests.

## 10. Knip

Configurar workspaces/entrypoints. Exceção documentada; nenhuma lista ampla para esconder código morto.

## 11. Docs check

Falha quando:

- mudança técnica sem `.md`;
- change record ausente;
- feature/scenario ID duplicado;
- feature sem Playwright;
- migration sem banco/QA;
- link inexistente;
- termo proibido introduzido como stack;
- Blueprint ausente/alterado sem registro.
