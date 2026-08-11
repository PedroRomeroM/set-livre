# Dependências e ferramentas utilizadas

## Regra de registro

Este arquivo lista dependências diretas e ferramentas instaladas ou adotadas pelo projeto. Dependências transitivas permanecem rastreadas pelo `package-lock.json` e auditadas por `npm audit`.

Cada entrada registra versão fixada, finalidade, superfície client/server, licença e avaliação resumida de supply chain.

## Runtime e ferramentas externas

| Item                |                     Versão | Finalidade                                              | Instalação/uso                                                      | Licença                     | Avaliação                                                                      |
| ------------------- | -------------------------: | ------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| Git                 |                     2.53.0 | versionamento e fluxo de branches                       | já disponível no ambiente                                           | GPL-2.0                     | ferramenta consolidada; nenhum conteúdo executado no bundle                    |
| GitHub CLI          |                     2.93.0 | autenticação, push e apoio ao fluxo de PR               | já disponível no ambiente                                           | MIT                         | oficial do GitHub; acesso restrito ao repositório autorizado                   |
| Docker              |                     29.6.2 | executar Supabase local e testes destrutivos            | já disponível no ambiente                                           | Apache-2.0                  | daemon local no contexto `default`; stack nunca exposta externamente           |
| NVM                 |                     0.40.3 | instalar e selecionar o runtime fixado                  | clone local do tag em `/home/ritu/.local/share/nvm-set-livre`       | MIT                         | upstream oficial; assinatura não autenticada neste host; não entra no artefato |
| Node.js             |                    24.18.0 | runtime LTS dos apps e ferramentas                      | instalado pelo NVM e fixado em `.nvmrc`/`.node-version`             | MIT e licenças de terceiros | versão única exigida por `engines` e `devEngines`                              |
| npm                 |                    11.19.0 | workspaces, lockfile e auditoria                        | instalado no runtime Node fixado                                    | Artistic-2.0                | CLI física adjacente ao Node; scripts de instalação negados por padrão         |
| PostgreSQL client   |                       18.4 | provisionar e comprovar a role DAL exclusivamente local | já disponível no ambiente; usado por `local:setup`                  | PostgreSQL                  | recebe segredo por ambiente/stdin, nunca por log ou migration                  |
| PostgreSQL `dblink` |                        1.2 | simular ACL administrativa em teste pgTAP local         | fornecido pela imagem PostgreSQL; criado somente dentro de rollback | PostgreSQL                  | não persiste extensão nem grant; conexão limitada à instância local            |
| GNU tar             |                       1.35 | criar e verificar o pacote global da release local      | já disponível; usado por `scripts/release-manifest.mjs`             | GPL-3.0-or-later            | empacota somente `.artifacts/release` já validado                              |
| util-linux `flock`  |                     2.41.3 | serializar a geração local de release no Linux          | já disponível; exigido por `scripts/release-manifest.mjs`           | Expat                       | lock advisory por descritor; env allowlisted e liberação automática no exit    |
| uutils `mkfifo`     |                      0.8.0 | criar FIFO adversarial em teste unitário POSIX          | `/usr/bin/mkfifo`; usado somente pelo guard de migrations           | MIT                         | fixture local sem runtime de app, rede, lifecycle npm ou inclusão no artefato  |
| Chromium Playwright | 151.0.7922.34 / build 1234 | E2E desktop/mobile e axe                                | cache local instalado por `playwright install --with-deps chromium` | BSD-3-Clause e terceiros    | browser fixado pelo Playwright 1.62.1; não integra o bundle                    |
| Firefox Playwright  |         153.0 / build 1538 | segundo engine dos fluxos críticos                      | cache local instalado por `playwright install firefox`              | MPL-2.0 e terceiros         | binário fixado pelo Playwright; usado somente em teste                         |
| WebKit Playwright   |          26.5 / build 2336 | terceiro engine dos fluxos críticos                     | cache local instalado por `playwright install webkit`               | BSD/LGPL e terceiros        | binário fixado pelo Playwright; usado somente em teste                         |

### Imagens da stack Supabase local

As imagens abaixo foram baixadas e executadas exclusivamente pelo Supabase CLI no daemon local; seus tags ficam fixados pela configuração/versão da CLI e não compõem o artefato Next.js.

| Serviço       | Imagem/tag                                              |
| ------------- | ------------------------------------------------------- |
| PostgreSQL    | `public.ecr.aws/supabase/postgres:17.6.1.158`           |
| Auth/GoTrue   | `public.ecr.aws/supabase/gotrue:v2.195.0`               |
| PostgREST     | `public.ecr.aws/supabase/postgrest:v14.16`              |
| Storage API   | `public.ecr.aws/supabase/storage-api:v1.68.10`          |
| Realtime      | `public.ecr.aws/supabase/realtime:v2.124.2`             |
| Kong          | `public.ecr.aws/supabase/kong:2.8.1`                    |
| Studio        | `public.ecr.aws/supabase/studio:2026.08.03-sha-022b374` |
| Postgres Meta | `public.ecr.aws/supabase/postgres-meta:v0.96.8`         |
| Mailpit       | `public.ecr.aws/supabase/mailpit:v1.30.2`               |

## Dependências npm diretas

| Pacote                              | Versão    | Superfície/finalidade                                  | Licença    | Justificativa                                                      | Avaliação de supply chain                                                                |
| ----------------------------------- | --------- | ------------------------------------------------------ | ---------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `@axe-core/playwright`              | `4.12.1`  | testes; auditoria de acessibilidade em browser         | MPL-2.0    | automatiza violações axe nos fluxos centrais                       | pacote oficial da Deque, somente em teste, com versão e integridade fixadas no lockfile  |
| `@playwright/test`                  | `1.62.1`  | testes; E2E nos três engines                           | Apache-2.0 | comprova jornadas, responsividade e contratos reais de browser     | projeto Microsoft maduro; browsers separados e versão exata reduzem variação             |
| `@supabase/ssr`                     | `0.12.4`  | runtime server; sessão Auth por request e cookies SSR  | MIT        | integra refresh e publicação segura de cookies no App Router       | pacote oficial Supabase; versão e integridade fixadas, sem cliente global compartilhado  |
| `@supabase/supabase-js`             | `2.112.3` | runtime server; Auth e read models permitidos por RLS  | MIT        | cliente oficial normativo para sessão e fronteiras Supabase        | pacote oficial, usado somente com chave anon pública e contratos server-side estritos    |
| `@tanstack/react-query`             | `5.101.4` | runtime client; estado remoto interativo               | MIT        | centraliza mutations, cache e invalidação dos fluxos de identidade | projeto maduro; provider por app, versão exata e nenhum estado canônico no browser       |
| `@types/node`                       | `24.13.3` | desenvolvimento; tipos do runtime e scripts            | MIT        | alinha os contratos TypeScript à major do Node fixado              | pacote DefinitelyTyped sem runtime, auditado e preso ao lockfile                         |
| `@types/pg`                         | `8.21.0`  | desenvolvimento server-only; tipos do driver           | MIT        | tipa conexões, resultados e erros do DAL PostgreSQL                | pacote DefinitelyTyped sem runtime, com versão e integridade fixadas                     |
| `@types/react`                      | `19.2.18` | desenvolvimento server/client; tipos JSX e React       | MIT        | fornece os contratos de componentes para apps e pacote UI          | pacote DefinitelyTyped sem runtime, restrito à toolchain e preso ao lockfile             |
| `@types/react-dom`                  | `19.2.4`  | desenvolvimento server/client; tipos de renderização   | MIT        | completa os contratos do renderer React usados pelos dois apps     | pacote DefinitelyTyped sem runtime, restrito à toolchain e preso ao lockfile             |
| `eslint`                            | `9.39.5`  | desenvolvimento; análise estática                      | MIT        | aplica regras de qualidade com zero warnings                       | projeto consolidado; sem runtime de produção e com versão exata no lockfile              |
| `eslint-config-next`                | `16.3.0`  | desenvolvimento; regras Next, React e Core Web Vitals  | MIT        | mantém o lint alinhado exatamente ao framework                     | pacote oficial do Next, sem runtime de produção e fixado na mesma versão do framework    |
| `eslint-import-resolver-typescript` | `3.10.1`  | desenvolvimento; resolução de imports tipados          | ISC        | permite que regras de ciclo/import resolvam os workspaces          | já transitivo do config Next; postinstall bloqueado e artefatos presos ao lockfile       |
| `knip`                              | `6.32.0`  | desenvolvimento; código, dependências e exports mortos | ISC        | detecta superfície não utilizada nos quatro workspaces             | ferramenta sem runtime de produção, versão exata e entrypoints explicitamente limitados  |
| `next`                              | `16.3.0`  | runtime server/client dos dois apps App Router         | MIT        | stack normativa com build standalone e headers nativos             | projeto oficial e amplamente mantido; versão exata, audit e lockfile obrigatórios        |
| `pg`                                | `8.23.0`  | runtime server-only; readiness e DAL crítico           | MIT        | driver normativo permite role restrita e transações PostgreSQL     | pacote maduro; isolado do browser, sem lifecycle liberado e com integridade no lockfile  |
| `prettier`                          | `3.9.6`   | desenvolvimento; formatação determinística             | MIT        | uniformiza código e Markdown alterado sem reformatar o Blueprint   | ferramenta consolidada, sem runtime de produção e fixada por versão/integridade          |
| `react`                             | `19.2.8`  | runtime server/client; composição da interface         | MIT        | biblioteca normativa suportada pelo Next fixado                    | projeto oficial e maduro; versão exata compartilhada por todos os consumidores           |
| `react-dom`                         | `19.2.8`  | runtime server/client; renderer web                    | MIT        | renderer oficial compatível com a versão React adotada             | projeto oficial e maduro; paridade exata com React e integridade fixada no lockfile      |
| `server-only`                       | `0.0.1`   | runtime server-only; bloqueio de import no client      | MIT        | impede importar DAL e secrets em componentes de cliente            | pacote oficial mínimo, sem dependências e sem execução de lifecycle liberada             |
| `supabase`                          | `2.113.0` | desenvolvimento local; Auth, banco, Storage e pgTAP    | MIT        | fornece a CLI normativa para reset e geração de contratos locais   | CLI fixada, cloud/link proibidos e lifecycle bloqueado pela configuração npm             |
| `typescript`                        | `5.9.3`   | desenvolvimento; tipagem estrita dos quatro workspaces | Apache-2.0 | comprova contratos estáticos e compatibilidade entre as aplicações | compiler oficial, sem runtime de produção e fixado abaixo da incompatibilidade conhecida |
| `vitest`                            | `4.1.10`  | desenvolvimento; testes unitários e guardrails         | MIT        | executa testes rápidos em TypeScript e JavaScript                  | projeto mantido no ecossistema Vite; sem runtime de produção e preso ao lockfile         |
| `zod`                               | `4.4.3`   | runtime server/client; validação de fronteiras         | MIT        | rejeita payloads permissivos e compartilha contratos tipados       | pacote amplamente usado, sem lifecycle liberado e com versão/integridade fixadas         |

Esta tabela é um contrato legível pelo gate: existe exatamente uma linha por pacote externo direto, com nome e versão idênticos aos quatro manifests canônicos. Os pacotes internos `@set-livre/*` são conferidos diretamente contra nome e versão dos workspaces e não representam supply chain externa.

Todas as versões são exatas e o `package-lock.json` registra transitivas e integridade. O gate recusa linha agrupada, duplicada, sem avaliação, stale, com alias, com `overrides` não vazio ou divergente dos manifests. A primeira instalação retornou zero vulnerabilidades em `npm audit`.

## Instalações de sistema para o navegador

O comando oficial do Playwright instalou, via pacotes Ubuntu, somente os itens ausentes abaixo. Bibliotecas de browser já presentes foram apenas verificadas e marcadas pelo gerenciador de pacotes.

| Pacotes                                                                                                  | Versões                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fonts-freefont-ttf`; `fonts-ipafont-gothic`; `fonts-tlwg-loma-otf`; `fonts-unifont`; `fonts-wqy-zenhei` | `20211204+svn4273-4build1`; `00303-23ubuntu1`; `1:0.7.3-1build1`; `1:16.0.04-1build1`; `0.9.45-8build1` |
| `xfonts-cyrillic`; `xfonts-scalable`; `xvfb`                                                             | `1:1.0.5+nmu1build1`; `1:1.0.3-1.3build1`; `2:21.1.22-1ubuntu1`                                         |

## Exceção de script transitivo revisada

`unrs-resolver@1.12.2` (MIT), transitivo de `eslint-import-resolver-typescript`, declara `postinstall`. O conteúdo foi inspecionado, mas a política do projeto é mais restritiva: `ignore-scripts=true` impede sua execução e a de qualquer outro lifecycle durante `npm ci`; o binding opcional precisa funcionar apenas com os artefatos já fixados por integridade no lockfile, comprovado pelos gates após instalação limpa. `strict-allow-scripts=true`, ausência obrigatória de `allowScripts` e `dangerously-allow-all-scripts=false` fecham overrides acidentais, enquanto hooks do root/workspaces também são recusados pelo gate documental.

TanStack Query e os clientes Supabase SSR/JS entraram somente com a primeira consumidora real, a FEAT-002. Ícones e providers externos continuam ausentes até uma feature aprovada exigir seu uso.
