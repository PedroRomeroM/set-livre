# Tooling e comandos do repositório

## 1. Runtime reproduzível

- Node.js `24.18.0`, fixado em `.nvmrc`, `.node-version`, `engines` e `devEngines`;
- npm `11.19.0`, fixado em `packageManager` e `devEngines`;
- um único `package-lock.json` para todos os workspaces;
- `npm ci` é o bootstrap reproduzível; `npm install` somente altera dependências deliberadamente;
- dependências e ferramentas adotadas ficam em `docs/dependencias-utilizadas.md`.

## 2. Workspaces

```json
{
  "workspaces": ["apps/*", "packages/*"]
}
```

A aplicação pública é o package raiz. `apps/backoffice` é a aplicação administrativa separada. `packages/contracts` e `packages/ui` são compartilhados e não criam um terceiro sistema visual ou domínio paralelo.

## 3. Comandos atuais

| Área               | Comandos                                                                              | Contrato                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| desenvolvimento    | `npm run dev`, `dev:backoffice`, `dev:all`                                            | portas locais 3000/3001; `dev:all` encaminha sinais aos dois filhos                                                  |
| build/runtime      | `build`, `build:web`, `build:backoffice`, `start`, `start:backoffice`                 | os dois apps geram standalone; `agentRules: false` preserva o `AGENTS.md` canônico                                   |
| código             | `format`, `format:check`, `lint`, `typecheck`                                         | Prettier no código e Markdown alterado; ESLint sem warnings; quatro workspaces e testes tipados                      |
| unitário           | `test:unit`, `test:unit:watch`                                                        | Vitest em contratos e guardrails puros                                                                               |
| Supabase           | `supabase:start`, `supabase:stop`, `supabase:status`, `supabase:reset`, `test:db`     | somente stack local; reset provisiona ambiente e role DAL restrita antes do pgTAP                                    |
| artefatos de banco | `supabase:schema`, `supabase:types`, `supabase:generate`                              | snapshot SQL normalizado em `supabase/schema.generated.sql`; tipos em `packages/contracts/src/database.generated.ts` |
| browser            | `test:e2e:install`, `test:e2e`, `test:e2e:affected`, `test:e2e:critical`, `test:a11y` | browsers reproduzíveis; execução exige opt-in e endpoints locais validados                                           |
| governança         | `docs:check`, `audit`, `knip`                                                         | sequência das 34 features, docs vivas, supply chain e código morto                                                   |
| release local      | `release:manifest`                                                                    | rebuild limpo; pacote, hashes, tar/checksum e smoke dos dois standalones                                             |

Nesta fundação, `test:e2e:affected` executa conservadoramente a suíte completa. Seleção por feature só será introduzida quando houver specs de produto reais.

`supabase:types` não usa redirecionamento do shell para o contrato rastreado. A CLI escreve em um arquivo temporário exclusivo no mesmo diretório de `database.generated.ts`; o script exige os exports esperados, valida a sintaxe TypeScript, aplica a configuração Prettier do repositório, sincroniza o arquivo e somente então substitui o destino com `rename` atômico. Falha de Docker, stack, CLI, validação ou formatação remove o temporário e preserva integralmente a versão anterior.

`release:manifest` exige checkout limpo e uma `.artifacts` física dentro do repositório antes de qualquer remoção. Cada app é recompilado com seu próprio `.env.local`, limitado aos nomes runtime documentados, `BUILD_ID` igual ao SHA e uma allowlist operacional; outros arquivos `.env` de produção, credenciais E2E, banco, tokens, opções de processo e secrets não são herdados pelo build. O pacote inclui static/public/migrations e o lockfile, recusa configuração local, secret conhecido e link externo, e revalida hashes e o conjunto exato de nós da release após o smoke.

Depois o comando inicia exatamente `web/server.js` e `backoffice/apps/backoffice/server.js` com ambientes runtime separados. A URL DAL vem exclusivamente do `.env.local` do respectivo app e precisa comprovar protocolo PostgreSQL, loopback na porta `54322`, login `app_runtime_local`, banco `postgres` e `options=-c role=app_dal`; uma `DATABASE_URL_APP_DAL` exportada no host nunca a substitui. O smoke exercita páginas, health, readiness, headers e asset estático, redige eventual log de falha e produz tar/checksum determinísticos a partir do timestamp do commit. O tar candidato é reextraído em diretório privado e comparado, por tipo e hash, à árvore validada antes de ser publicado. Um artefato já existente para o mesmo SHA só é reutilizado se os bytes forem idênticos; conteúdo divergente nunca é sobrescrito. O manifesto registra plataforma/arquitetura; validação ARM64 continua bloqueada por PEND-003.

## 4. TypeScript

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables` e `verbatimModuleSyntax`;
- cada app executa `next typegen` antes de `tsc --noEmit`;
- packages possuem tsconfig próprio;
- `tsconfig.tests.json` cobre Playwright, Vitest, configs e helpers;
- `server-only` e `pg` já protegem o contrato de readiness; comandos de negócio continuarão restritos a módulos DAL server-only.

## 5. ESLint

- ESLint 9 e configs Next/TypeScript alinhados à versão do framework;
- regras React, hooks, Core Web Vitals, imports, ciclos, promises, `any` e `console`;
- imports de DAL/provider são proibidos em qualquer módulo com diretiva `"use client"` e nos diretórios visuais `components`/`packages/ui`, independentemente do caminho da feature;
- Server Components, route handlers e DAL fora das bordas visuais não recebem essa restrição por nome de pasta genérico;
- arquivos gerados e artefatos locais são ignorados explicitamente, nunca por exceção ampla.

## 6. Formatting

O Blueprint tem checksum canônico e não é reformatado. `scripts/format-scope.mjs` verifica todo código/config mantido e o Markdown alterado, inclusive depois do commit da branch. Entre `origin/main` e `main` local, a base Git escolhida é a candidata válida cujo `merge-base` está a menos commits de `HEAD`; assim uma ref remota atrasada não amplia o diff com trabalho já incorporado à `main` local. Empates preservam a precedência remota e, sem candidata útil, o gate usa o commit raiz alcançável; em um repositório ainda no commit inicial, todos os arquivos rastreados entram no conjunto. A ausência ou defasagem da ref remota nunca elimina Markdown commitado nem permite reutilizar um change record anterior. Prettier não substitui lint ou validação documental.

## 7. Playwright e axe

Pré-requisito de máquina:

```bash
npm run test:e2e:install
```

O config parseia `.env.e2e.local` sem contaminar `process.env`, rejeita origem/host/protocolo/porta remotos, exige `E2E_ALLOW_LOCAL=1` e comprova por conexão um marcador efêmero da instância. A credencial administrativa é zerada nos filhos; os apps recebem apenas a DAL restrita. A matriz cobre 1440×900, 390×844, 320×720, altura compacta, backoffice isolado, axe claro/escuro/mobile e os fluxos críticos nos três engines, com retries zero e artefatos somente em falha.

O processo de cada browser recebe uma allowlist operacional independente do ambiente dos apps: paths/home/temporários, locale/fuso/terminal, variáveis gráficas locais não ligadas a Snap e os equivalentes mínimos do Windows. Segredos, URLs de banco, SSH, npm, opções Node, variáveis `SNAP*`, `LD_*`/`DYLD_*` e qualquer nome não enumerado nunca são herdados. Segmentos Snap e entradas vazias também são removidos do `PATH`/`Path`, evitando tanto bibliotecas do host incompatíveis quanto resolução pelo diretório atual.

## 8. Supabase local

`npm run supabase:reset` executa:

1. comprovação do daemon Docker;
2. criação idempotente da bridge `set-livre-loopback`, cujo default de publicação é `127.0.0.1` sem alterar o daemon Docker;
3. parada restrita à stack `set-livre` se containers preexistentes estiverem em outra rede ou binding;
4. `supabase start --network-id set-livre-loopback`, validação dos bindings efetivos e `supabase db reset --local`;
5. migrations e seed;
6. criação/rotação local de `app_runtime_local` com estado exato e somente `CONNECT` direto;
7. associação exclusiva à role `app_dal NOLOGIN`, sem admin/inherit e com `SET ROLE` explícito;
8. smoke de identidade efetiva `current_user=app_dal`;
9. gravação separada dos dois `.env.local` de runtime e de `.env.e2e.local`, todos com modo `0600`, sem imprimir secrets.

A URL administrativa fica em `E2E_DATABASE_URL` somente no arquivo do harness. Runtime usa `DATABASE_URL_APP_DAL` com `SET ROLE app_dal`. Os wrappers de start/status/test/dump/types recusam stack fora da bridge e nunca imprimem o status completo com chaves. Nenhuma migration contém senha e nenhum comando usa `supabase link` ou cloud.

## 9. Knip e supply chain

Knip descobre os quatro workspaces pelos manifests/configs. A única exceção é restrita aos packages `@types/react` e `@types/react-dom` necessários ao JSX do pacote UI. `npm audit --audit-level=high` e a política `allowScripts` completam o gate.

## 10. Docs check

O gate falha, entre outros casos, quando:

- o Blueprint muda sem novo contrato;
- feature, cenário ou ADR duplica ID;
- a sequência não contém exatamente as 34 features;
- `dependency-to-start` cria ciclo ou aponta para frente;
- integração posterior não possui proprietário;
- dependência de release não referencia `pendencias.md`;
- link local está quebrado;
- dependência proibida entra em qualquer workspace;
- código contém marcador de dívida informal;
- Playwright contém `.only`, `.skip` ou `waitForTimeout`;
- um intervalo de features na tabela normativa ou em `pendencias.md` é descendente;
- uma mudança em código, testes, banco ou qualquer configuração mantida, na raiz ou aninhada — inclusive dotfiles, exemplos de ambiente, versões de runtime, configs JSON/TypeScript e contratos legíveis por máquina como `docs/feature-sequence.json` — não possui registro em `docs/changes/`;
- o registro correspondente em `docs/changes/` foi apenas modificado, renomeado ou excluído: o gate exige ao menos um arquivo com status Git `A` e ainda presente;
- nenhuma base Git segura pode ser lida; a mesma seleção pelo `merge-base` mais próximo, com fallback no commit raiz, usada pelo formatador preserva mudanças já commitadas sem aceitar registros herdados de uma `main` local mais nova que `origin/main`.
