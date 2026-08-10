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
| desenvolvimento    | `npm run dev`, `dev:backoffice`; `node scripts/dev-all.mjs`                           | portas 3000/3001; o launcher direto valida env local, isola os filhos e encaminha sinais                             |
| build/runtime      | `build`, `build:web`, `build:backoffice`, `start`, `start:backoffice`                 | os dois apps geram standalone; `agentRules: false` preserva o `AGENTS.md` canônico                                   |
| código             | `format`, `format:check`, `lint`, `typecheck`                                         | Prettier no código e Markdown alterado; ESLint sem warnings; quatro workspaces e testes tipados                      |
| unitário           | `test:unit`, `test:unit:watch`                                                        | Vitest em contratos e guardrails puros                                                                               |
| Supabase           | `supabase:start`, `supabase:stop`, `supabase:status`, `supabase:reset`, `test:db`     | somente stack local; reset provisiona ambiente e role DAL restrita antes do pgTAP                                    |
| artefatos de banco | `supabase:schema`, `supabase:types`, `supabase:generate`                              | snapshot SQL normalizado em `supabase/schema.generated.sql`; tipos em `packages/contracts/src/database.generated.ts` |
| browser            | `test:e2e:install`, `test:e2e`, `test:e2e:affected`, `test:e2e:critical`, `test:a11y` | browsers reproduzíveis; execução exige opt-in e endpoints locais validados                                           |
| governança         | `docs:check`, `audit`, `knip`                                                         | sequência das 34 features, docs vivas, supply chain e código morto                                                   |
| release local      | `node scripts/release-manifest.mjs`                                                   | rebuild limpo; pacote, hashes, tar/checksum e smoke dos dois standalones                                             |

Nesta fundação, `test:e2e:affected` executa conservadoramente a suíte completa. Seleção por feature só será introduzida quando houver specs de produto reais.

`npm run dev`, `npm run dev:backoffice` e `npm run dev --workspace @set-livre/backoffice` convergem no mesmo launcher single-app; nenhum desses scripts chama `next` ou outro `npm run` diretamente. O launcher relê o `.env.local` físico `0600` da aplicação, exige os seis nomes runtime exatos, comprova origem, Supabase em loopback e identidade DAL local restrita e constrói o ambiente filho por allowlist. Assim, uma `DATABASE_URL_APP_DAL` cloud, credencial E2E, opção Node/npm, loader ou secret exportado no host não substitui o arquivo local nem chega ao processo Next. Node vem de `process.execPath`; a CLI Next é um caminho absoluto, sem shell ou lookup em `PATH`, e precisa ser arquivo físico protegido cujo manifesto, versão exata e declaração `bin` correspondam ao `next` fixado no manifesto raiz.

`node scripts/dev-all.mjs` faz o mesmo preflight para os dois apps antes do primeiro spawn e inicia diretamente as duas CLIs Next, sem uma camada npm intermediária. Em POSIX, cada filho lidera seu próprio PGID e recebe encerramento gracioso seguido de `SIGKILL`; no Windows, a árvore inteira é encerrada pelo `taskkill.exe` absoluto e limitado. Os comandos npm diretos agora não contornam o guard, mas o npm pai, seu shell e eventuais `NODE_OPTIONS` já executaram antes de o código do launcher assumir controle; a fronteira não promete recuperar um chamador ou preloader já comprometido. Para eliminar essa etapa anterior, execute `node scripts/local-development-server.mjs web|backoffice` ou `node scripts/dev-all.mjs` a partir de Node `24.18.0` e shell confiáveis. Em todos os casos, a garantia também pressupõe que nenhum principal com permissão de escrita altere Node, npm, Next ou checkout concorrentemente; não existe vínculo atômico portátil entre inspeção e execução. O validador da URL DAL é compartilhado com o smoke de release.

Os artefatos rastreados do banco nunca são o destino direto de uma CLI. `supabase:schema` entrega ao dump um arquivo temporário exclusivo e irmão de `schema.generated.sql`; depois de saída bem-sucedida, reabre o arquivo e comprova sua identidade física estável antes de qualquer escrita, recusa saída vazia ou sem declarações de `audit`, `private` e `public`, normaliza a quebra de linha final, restaura o modo do destino, sincroniza o descritor e publica com `rename` atômico. `supabase:types` aplica o mesmo contrato de publicação a `database.generated.ts`, além de exigir os exports esperados, validar a sintaxe TypeScript e aplicar a configuração Prettier do repositório. Falha de Docker, stack, CLI, leitura, normalização, validação ou formatação remove por nome somente o respectivo temporário e preserva integralmente a versão anterior.

`node scripts/release-manifest.mjs` exige checkout limpo e uma `.artifacts` física dentro do repositório antes de qualquer remoção. A entrada direta evita configuração do npm pai; antes do primeiro build, o script deriva e valida a instalação Node/npm adjacente e lê a versão do manifesto npm fixado, sem executar `npm.cmd`, shell ou lookup em `PATH`, sob a mesma fronteira confiável descrita para desenvolvimento. No ambiente Linux de release, um lock advisory exclusivo do `util-linux flock` é adquirido por descritor antes de ler o SHA e permanece ativo durante builds, montagem de `releaseRoot`, smoke, temporários, verificação e publicação. Uma segunda invocação espera o mesmo lock; o kernel o libera se o processo encerra, e o arquivo físico `release.lock` não deve ser removido porque seu inode estável é parte da exclusão mútua. Ausência da instalação validada falha antes do build com erro explícito, e o subprocesso herda somente a allowlist operacional.

Cada app é recompilado com seu próprio `.env.local`, limitado aos nomes runtime documentados, `BUILD_ID` igual ao SHA e uma allowlist operacional; outros arquivos `.env` de produção, credenciais E2E, banco, tokens, opções de processo e secrets não são herdados pelo build. O pacote inclui static/public/migrations e o lockfile, recusa configuração local, secret conhecido e link externo, e revalida hashes e o conjunto exato de nós da release após o smoke.

Depois o comando inicia exatamente `web/server.js` e `backoffice/apps/backoffice/server.js` com ambientes runtime separados. A URL DAL vem exclusivamente do `.env.local` do respectivo app e precisa comprovar protocolo PostgreSQL, loopback na porta `54322`, login `app_runtime_local`, banco `postgres` e `options=-c role=app_dal`; uma `DATABASE_URL_APP_DAL` exportada no host nunca a substitui. O smoke exercita páginas, health, readiness, headers e asset estático, redige eventual log de falha e produz tar/checksum determinísticos a partir do timestamp do commit. Além de ordem, tempo e ownership, o GNU tar normaliza diretórios e executáveis para `0755` e arquivos regulares não executáveis para `0644`, tornando o pacote independente do `umask`. O tar candidato é reextraído em diretório privado e comparado, por tipo e hash, à árvore validada antes de ser publicado. Um artefato já existente para o mesmo SHA só é reutilizado se os bytes forem idênticos; conteúdo divergente nunca é sobrescrito. O manifesto registra plataforma/arquitetura; validação ARM64 continua bloqueada por PEND-003.

Os launchers diretos `scripts/dev-all.mjs`/`scripts/release-manifest.mjs` e os workers em `tests/fixtures/` são entradas explícitas do Knip porque não dependem de import estático. O binário de sistema `flock`, versionado e documentado na matriz de dependências, é a única exceção de binário externo da análise.

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

O Blueprint tem checksum canônico e não é reformatado. `scripts/format-scope.mjs` verifica todo código/config mantido e o Markdown alterado, inclusive depois do commit da branch. Entre `origin/main` e `main` local, a base Git escolhida é a candidata válida cujo `merge-base` está a menos commits de `HEAD`; assim uma ref remota atrasada não amplia o diff com trabalho já incorporado à `main` local. Em uma feature recém-criada no mesmo commit da candidata, o próprio `HEAD` é a base e somente mudanças working/staged/untracked podem exigir o novo registro; no checkout da própria `main`, a candidata idêntica continua cedendo ao histórico alcançável para preservar a verificação de seus commits. Empates preservam a precedência remota e, sem candidata útil, o gate usa o commit raiz alcançável; em um repositório ainda no commit inicial, todos os arquivos rastreados entram no conjunto. Os filtros incluem mudança de tipo Git `T`, portanto trocas entre arquivo regular e symlink permanecem no escopo documental e de formatação; antes de ler ou escrever qualquer candidato, o formatador rejeita symlinks e nós especiais com erro controlado, sem seguir um alvo externo. A ausência ou defasagem da ref remota nunca elimina Markdown commitado nem permite reutilizar um change record anterior. Prettier não substitui lint ou validação documental.

## 7. Playwright e axe

Pré-requisito de máquina:

```bash
npm run test:e2e:install
```

O config parseia `.env.e2e.local` sem contaminar `process.env`, rejeita origem/host/protocolo/porta remotos, exige `E2E_ALLOW_LOCAL=1` e comprova por conexão um marcador efêmero da instância. Depois que o runner Playwright é iniciado por uma toolchain confiável, um overlay neutraliza todos os nomes herdados antes do merge interno de cada webServer e restaura somente a allowlist operacional. O comando usa o executável Node absoluto e um wrapper single-app versionado; esse wrapper reutiliza o mesmo guard dos comandos dev, relê o `.env.local` físico, valida a CLI Next fixada, preserva os valores runtime/anon locais, substitui somente `APP_ENV=test` e inicia Next diretamente, sem npm filho ou shell. No POSIX, o prefixo `exec` mantém wrapper e Next no PGID que o Playwright controla; `SIGHUP`/`SIGINT`/`SIGTERM` são encaminhados e o fechamento solicitado conclui com limpeza `SIGKILL` do grupo. No Windows, o runner encerra a árvore pelo `taskkill.exe` absoluto derivado de `SystemRoot/System32`, com `/PID`, `/T` e `/F`, sem shell nem lookup em `PATH`; o utilitário recebe somente `SystemRoot` e `WINDIR`, nunca a DAL ou os secrets do app, e cada tentativa fica limitada a cinco segundos. Credencial administrativa, npmrc remoto, secrets e valores PG/SSH herdados não alcançam os apps após essa fronteira; cada app recebe somente sua DAL restrita e o runtime local validado. A matriz cobre 1440×900, 390×844, 320×720, altura compacta, backoffice isolado, axe claro/escuro/mobile e os fluxos críticos nos três engines, com retries zero e artefatos somente em falha.

O processo de cada browser recebe uma allowlist operacional independente do ambiente dos apps: paths/home/temporários, locale/fuso/terminal, variáveis gráficas locais não ligadas a Snap e os equivalentes mínimos do Windows. Segredos, URLs de banco, SSH, npm, opções Node, variáveis `SNAP*`, `LD_*`/`DYLD_*` e qualquer nome não enumerado nunca são herdados. Segmentos Snap e entradas vazias também são removidos do `PATH`/`Path`, evitando tanto bibliotecas do host incompatíveis quanto resolução pelo diretório atual.

## 8. Supabase local

`npm run supabase:reset` executa:

1. comprovação do daemon Docker;
2. criação idempotente da bridge `set-livre-loopback`, cujo default de publicação é `127.0.0.1` sem alterar o daemon Docker;
3. parada restrita à stack `set-livre` se containers preexistentes estiverem em outra rede ou binding;
4. `supabase start --network-id set-livre-loopback`, validação dos bindings efetivos e `supabase db reset --local`;
5. migrations e seed;
6. autenticação local explícita como `supabase_admin` superuser, usando a mesma credencial efêmera da stack e sem expô-la, para fechar `public`/`net`, defaults gerenciados, catálogos sensíveis e membros residuais de `app_dal`/login;
7. criação/rotação local de `app_runtime_local` com estado exato e somente `CONNECT` direto;
8. reconciliação exata das duas referências a `app_dal`: `postgres` administrativa sem `SET/INHERIT` e runtime sem `ADMIN/INHERIT` com `SET` explícito;
9. smoke da identidade efetiva e das duas probes privadas de readiness antes de publicar qualquer ambiente;
10. gravação separada dos dois `.env.local` de runtime e de `.env.e2e.local`, todos com modo `0600`, sem imprimir secrets.

A URL administrativa fica em `E2E_DATABASE_URL` somente no arquivo do harness. Runtime usa `DATABASE_URL_APP_DAL` com `SET ROLE app_dal`. Antes de qualquer branch, inclusive `stop`, bootstrap e wrappers recusam overrides Docker remotos, exigem o contexto `default`, comprovam o socket/named pipe local e pinam esse endpoint no ambiente de cada comando Docker/Supabase. Os wrappers de start/status/test/dump/types recusam stack fora da bridge; todo `stderr` fica em pipe privado e é descartado, falhas substituem integralmente buffers e erro original, e o status completo com chaves nunca é impresso. Somente o `stdout` necessário a pgTAP e geração de tipos pode ser herdado. Nenhuma migration contém senha e nenhum comando usa `supabase link` ou cloud.

## 9. Knip e supply chain

Knip descobre os quatro workspaces pelos manifests/configs. A única exceção é restrita aos packages `@types/react` e `@types/react-dom` necessários ao JSX do pacote UI. `npm audit --audit-level=high`, `ignore-scripts=true`, `strict-allow-scripts=true` e `dangerously-allow-all-scripts=false` completam o gate: `npm ci` não executa lifecycle de dependência, root ou workspace, nenhuma entrada `allowScripts` é aceita e um override isolado de `ignore-scripts` ainda falha no preflight estrito. Esse contrato pressupõe a invocação canônica sem override `NPM_CONFIG_*` hostil; um chamador já comprometido está fora da fronteira.

## 10. Docs check

O gate falha, entre outros casos, quando:

- o Blueprint muda sem novo contrato;
- feature, cenário ou ADR duplica ID;
- a sequência não contém exatamente as 34 features;
- `dependency-to-start` cria ciclo ou aponta para frente;
- integração posterior não possui proprietário;
- dependência de release não referencia `pendencias.md`;
- link local está quebrado;
- dependência proibida entra em qualquer seção instalável, substituível ou empacotável de qualquer workspace; o manifesto raiz precisa preservar exatamente `apps/*` e `packages/*`, os três manifests de workspace precisam ser arquivos físicos no conjunto canônico e nenhum outro diretório imediato pode casar os globs; o gate cobre dependências runtime, desenvolvimento, opcionais, peers, bundles, aliases `npm:` e overrides aninhados, além de recusar hooks de instalação, `binding.gyp` implícito, shrinkwrap ou lock paralelo no root/workspaces; specs diretas ou replacements por URL, Git, tarball ou arquivo local também são recusadas, deixando versões do registry, alias npm e referência `$` somente em overrides como formas explícitas permitidas;
- código contém marcador de dívida informal;
- Playwright contém `.only`, `.skip` ou `waitForTimeout`;
- um intervalo de features na tabela normativa ou em `pendencias.md` é descendente;
- uma mudança em código, testes, banco ou qualquer configuração mantida, na raiz ou aninhada — inclusive dotfiles, exemplos de ambiente, versões de runtime, configs JSON/TypeScript e contratos legíveis por máquina como `docs/feature-sequence.json` — não possui registro em `docs/changes/`;
- o registro correspondente em `docs/changes/` foi apenas modificado, renomeado ou excluído: o gate exige ao menos um arquivo com status Git `A` e ainda presente;
- nenhuma base Git segura pode ser lida; a mesma seleção pelo `merge-base` mais próximo, com fallback no commit raiz, usada pelo formatador preserva mudanças já commitadas sem aceitar registros herdados de uma `main` local mais nova que `origin/main`.
