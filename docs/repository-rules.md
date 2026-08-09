# Regras do repositório

## 1. Organização

A aplicação pública permanece na raiz. O backoffice fica em `apps/backoffice`. Pacotes compartilhados são limitados a contratos e primitives realmente usados pelas duas aplicações.

```text
.
├── apps/
│   └── backoffice/
├── packages/
│   ├── contracts/
│   └── ui/
├── src/
├── supabase/
├── tests/
├── scripts/
├── docs/
├── AGENTS.md
├── README.md
└── package.json
```

## 2. npm workspaces

O `package.json` raiz controla:

- aplicação pública;
- backoffice;
- contratos compartilhados;
- design primitives compartilhadas.

Somente um `package-lock.json` é versionado. CI usa `npm ci`.

## 3. Branches e commits

- `main` deve estar sempre implantável;
- branches curtas por feature/correção;
- commit de documentação/governança separado da implementação quando isso facilita revisão;
- migrations não são misturadas com refatorações sem relação;
- mensagem de commit em Conventional Commits;
- commit não inclui artefatos de Playwright, builds, `.env`, dumps ou secrets.

## 4. Mudanças obrigatórias de documentação

Alteração em qualquer caminho abaixo exige mudança `.md`:

- `src/**`;
- `apps/**`;
- `packages/**`;
- `supabase/**`;
- `scripts/**`;
- `.github/**`;
- arquivos de configuração;
- arquivos de deploy.

Todo PR cria `docs/changes/YYYY-MM-DD-<slug>.md`.

## 5. Dependências

Dependência nova exige no PR:

- problema resolvido;
- motivo para não usar plataforma/standard library;
- impacto client/server;
- licença;
- tamanho e manutenção;
- risco de supply chain;
- plano de remoção quando experimental.

## 6. Código

- nomes de domínio em inglês no código e português na copy;
- nenhum `any`;
- tipos derivados de Zod ou gerados do banco quando possível;
- módulos server-only identificados;
- DTO público explícito;
- nenhuma consulta SQL em componente;
- nenhum provider global de domínio;
- nenhum erro técnico exibido ao usuário;
- nenhuma PII em logs.

## 7. Banco

- migrations append-only;
- reset local do zero em CI;
- seed previsível;
- schema snapshot gerado, nunca editado;
- manifesto de tabelas/grants/policies;
- teste positivo e negativo de RLS;
- índice não estrutural acompanhado de evidência `EXPLAIN`.

## 8. QA

- todo comportamento possui ID;
- cada feature tem spec Playwright;
- cenário P0 nunca pode ser manual;
- teste flakey é bug;
- traces e screenshots só em falha;
- ambiente destrutivo somente local;
- desktop e mobile cobertos.

## 9. Merge

Merge exige:

- gates verdes;
- documentação coerente;
- comentários resolvidos;
- migration reproduzível;
- rollback conhecido;
- risco e dívida registrados;
- nenhuma decisão estrutural sem ADR.
