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
| npm                 |                    11.19.0 | workspaces, lockfile e auditoria                        | instalado no runtime Node fixado                                    | Artistic-2.0                | scripts de instalação negados por padrão e aprovados individualmente           |
| PostgreSQL client   |                       18.4 | provisionar e comprovar a role DAL exclusivamente local | já disponível no ambiente; usado por `local:setup`                  | PostgreSQL                  | recebe segredo por ambiente/stdin, nunca por log ou migration                  |
| GNU tar             |                       1.35 | criar e verificar o pacote global da release local      | já disponível no ambiente; usado por `release:manifest`             | GPL-3.0-or-later            | empacota somente `.artifacts/release` já validado                              |
| util-linux `flock`  |                     2.41.3 | serializar a geração local de release no Linux          | já disponível no ambiente; exigido por `release:manifest`           | Expat                       | lock advisory por descritor; env allowlisted e liberação automática no exit    |
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

| Pacote                              |           Versão | Superfície/finalidade                                      | Licença    | Justificativa e avaliação                                                                        |
| ----------------------------------- | ---------------: | ---------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `next`                              |           16.3.0 | runtime server/client dos dois apps App Router             | MIT        | stack normativa; standalone e headers nativos reduzem infraestrutura adicional                   |
| `react` / `react-dom`               |           19.2.8 | renderização server/client                                 | MIT        | par suportado pelo Next fixado                                                                   |
| `zod`                               |            4.4.3 | contratos e validação nas fronteiras                       | MIT        | impede payload permissivo; usado no pacote de contratos e guard E2E                              |
| `pg`                                |           8.23.0 | readiness server-only e futuro DAL crítico                 | MIT        | driver normativo com timeout e role restrita; nunca entra no browser                             |
| `server-only`                       |            0.0.1 | bloqueio de import server para client                      | MIT        | guard oficial mínimo, sem runtime no browser                                                     |
| `@playwright/test`                  |           1.62.1 | E2E em browser real                                        | Apache-2.0 | stack normativa; browsers são instalados separadamente                                           |
| `@axe-core/playwright`              |           4.12.1 | auditoria automatizada de acessibilidade                   | MPL-2.0    | complementa, sem substituir, teclado/reflow/zoom                                                 |
| `vitest`                            |           4.1.10 | testes unitários                                           | MIT        | integração TypeScript rápida e sem runtime de produção                                           |
| `typescript`                        |            5.9.3 | tipagem estrita de todos os workspaces e testes            | Apache-2.0 | fixado abaixo de 6.1 para compatibilidade do parser ESLint                                       |
| `@types/node`                       |          24.13.3 | tipos do runtime e scripts                                 | MIT        | alinhado à major do Node                                                                         |
| `@types/pg`                         |           8.21.0 | contratos TypeScript do driver PostgreSQL                  | MIT        | usado somente em desenvolvimento server-side                                                     |
| `@types/react` / `@types/react-dom` | 19.2.18 / 19.2.4 | tipos JSX dos apps e pacote UI                             | MIT        | necessários apenas em desenvolvimento                                                            |
| `eslint`                            |           9.39.5 | análise estática com zero warnings                         | MIT        | major 9 exigida pela faixa real dos plugins do Next 16.3                                         |
| `eslint-config-next`                |           16.3.0 | regras Next, React, hooks e Core Web Vitals                | MIT        | alinhado exatamente ao framework                                                                 |
| `eslint-import-resolver-typescript` |           3.10.1 | resolução tipada usada pelas regras de ciclo/import        | ISC        | dependência já transitiva do config Next, declarada para resolver corretamente no workspace raiz |
| `prettier`                          |            3.9.6 | formatação determinística                                  | MIT        | escopo preserva o Blueprint e valida Markdown alterado na branch                                 |
| `knip`                              |           6.32.0 | código/dependências/exports mortos                         | ISC        | workspaces explícitos; exceção restrita somente aos tipos React do pacote UI                     |
| `supabase`                          |          2.113.0 | CLI local de Auth, Postgres, Storage, reset, tipos e pgTAP | MIT        | dependência de desenvolvimento fixada; nenhuma operação `link`/cloud                             |

Todas as versões são exatas e o `package-lock.json` registra transitivas e integridade. A primeira instalação retornou zero vulnerabilidades em `npm audit`.

## Instalações de sistema para o navegador

O comando oficial do Playwright instalou, via pacotes Ubuntu, somente os itens ausentes abaixo. Bibliotecas de browser já presentes foram apenas verificadas e marcadas pelo gerenciador de pacotes.

| Pacotes                                                                                                  | Versões                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fonts-freefont-ttf`; `fonts-ipafont-gothic`; `fonts-tlwg-loma-otf`; `fonts-unifont`; `fonts-wqy-zenhei` | `20211204+svn4273-4build1`; `00303-23ubuntu1`; `1:0.7.3-1build1`; `1:16.0.04-1build1`; `0.9.45-8build1` |
| `xfonts-cyrillic`; `xfonts-scalable`; `xvfb`                                                             | `1:1.0.5+nmu1build1`; `1:1.0.3-1.3build1`; `2:21.1.22-1ubuntu1`                                         |

## Exceção de script transitivo revisada

`unrs-resolver@1.12.2` (MIT), transitivo de `eslint-import-resolver-typescript`, possui `postinstall`. O script foi inspecionado: chama somente `napi-postinstall` para localizar/preparar o binding nativo opcional já fixado no lockfile. A execução foi autorizada de forma exata em `allowScripts`; nenhum outro script de instalação permanece sem decisão.

TanStack Query, clientes Supabase, ícones e providers externos ainda não foram instalados porque não existe consumidor de produto nesta fundação. Cada um entra somente no primeiro PR que o usar.
