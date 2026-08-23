# Dependências e ferramentas utilizadas

## Regra de registro

Este arquivo lista dependências diretas e ferramentas instaladas ou adotadas pelo projeto. Dependências transitivas permanecem rastreadas pelo `package-lock.json` e auditadas por `npm audit`.

Cada entrada registra versão fixada, finalidade, superfície client/server, licença e avaliação resumida de supply chain.

## Runtime e ferramentas externas

| Item                    |                     Versão | Finalidade                                          | Instalação/uso                                                                    | Licença                     | Avaliação                                                                                    |
| ----------------------- | -------------------------: | --------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| Windows 11              |                         11 | workstation de desenvolvimento nativa, sem WSL      | Long Paths, Hyper-V e SVM habilitados; reboot concluído em 2026-08-17             | proprietária                | `VirtualizationFirmwareEnabled=True`; contexto operacional local padrão                      |
| PowerShell              |                      7.6.5 | shell oficial do operador e checks locais           | MSI oficial x64; binário físico em `C:\\Program Files\\PowerShell\\7\\pwsh.exe`   | MIT                         | hash oficial e assinatura Microsoft validados; MSIX redundante removido; não entra no bundle |
| Windows PowerShell      |                        5.1 | guardian do mutex global do Supabase local          | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`                       | MIT/proprietária do Windows | executável físico validado; mutex nomeado do kernel; sem elevação                            |
| Microsoft C# compiler   |   .NET Framework 4.0.30319 | compilar o guardian Job Object Windows              | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`                         | proprietária do Windows     | físico/absoluto; bytes entram no hash do cache; sem pacote ou download nativo                |
| `reg.exe`/`where.exe`   |                 Windows 11 | localizar PowerShell 7 instalado pelo MSI em testes | executáveis físicos do `System32`; uso unitário somente                           | proprietária do Windows     | declarados no Knip; não entram no bundle nem recebem secrets                                 |
| Git                     |                     2.55.0 | versionamento e fluxo de branches                   | instalado no Windows; opções locais LF/NTFS explícitas                            | GPL-2.0                     | `autocrlf=false`, `symlinks=false`, `ignorecase=true`, `protectNTFS=true`, long paths        |
| GitHub CLI              |                     2.97.0 | autenticação, push e apoio ao fluxo de PR           | autenticado como `PedroRomeroM` via browser; HTTPS e token no keyring             | MIT                         | `gh repo view` comprovou `ADMIN` em `PedroRomeroM/set-livre`; token não é logado             |
| `actions/github-script` |                      9.0.0 | validar pela API a cadeia imutável CI/publicação    | action oficial GitHub fixada no commit `3a2844b7e9c422d3c10d287c895573f7108da1b3` | MIT                         | roda somente em GitHub-hosted; substitui curl/Python inline e não entra no bundle            |
| actionlint              |                     1.7.12 | validar workflows GitHub Actions                    | pacote oficial instalado pelo WinGet; execução local somente                      | MIT                         | parser especializado; os workflows atuais passam sem diagnóstico                             |
| ShellCheck              |                     0.11.0 | análise estática dos blocos e scripts Bash          | pacote oficial instalado pelo WinGet; execução local/CI                           | GPL-3.0                     | não entra no bundle; complementa `bash -n` nos scripts operacionais                          |
| Docker Desktop          |                       4.86 | executar Supabase local em containers Linux         | Hyper-V; `desktop-linux`/`npipe:////./pipe/dockerDesktopLinuxEngine`              | comercial/Apache-2.0        | Windows usa `Localhost only`; Linux preserva bind literal                                    |
| Node.js                 |                    24.18.0 | runtime LTS dos apps e ferramentas                  | instalação física nativa do Windows, fixada no repositório                        | MIT e licenças de terceiros | versão única exigida por `engines` e `devEngines`                                            |
| npm                     |                    11.19.0 | workspaces, lockfile e auditoria                    | CLI física adjacente ao Node fixado                                               | Artistic-2.0                | scripts de instalação negados por padrão                                                     |
| Oracle OCI CLI          |                     3.90.1 | discovery e operação controlada da VM Oracle        | perfil `SET_LIVRE` autenticado por sessão browser temporária                      | UPL-1.0/Apache-2.0          | alvo E2 Micro x86_64; diagnóstico terminado; reprovisionamento bloqueado por capacidade      |
| PostgreSQL client       |                       18.6 | diagnóstico manual opcional                         | `psql` instalado no Windows; não é autoridade do bootstrap                        | PostgreSQL                  | setup usa `pg` do workspace e não descobre binário pelo `PATH`                               |
| PostgreSQL `dblink`     |                        1.2 | simular ACL administrativa em teste pgTAP local     | fornecido pela imagem PostgreSQL; criado somente dentro de rollback               | PostgreSQL                  | não persiste extensão nem grant; conexão limitada à instância local                          |
| GNU tar                 |                       1.35 | criar e verificar o pacote global da release        | dependência exclusiva do Ubuntu em CI/release                                     | GPL-3.0-or-later            | empacota somente `.artifacts/release` já validado                                            |
| util-linux `flock`      |                     2.41.3 | serializar a geração de release                     | dependência exclusiva do Ubuntu em CI/release                                     | Expat                       | lock advisory por descritor; env allowlisted e liberação automática no exit                  |
| uutils `mkfifo`         |                      0.8.0 | criar FIFO adversarial em teste unitário POSIX      | dependência exclusiva das fixtures Linux/CI                                       | MIT                         | fixture sem runtime de app, rede, lifecycle npm ou inclusão no artefato                      |
| Chromium Playwright     | 151.0.7922.34 / build 1234 | E2E desktop/mobile e axe                            | cache Windows instalada com sucesso pela CLI fixada                               | BSD-3-Clause e terceiros    | browser fixado pelo Playwright 1.62.1; não integra o bundle                                  |
| Firefox Playwright      |         153.0 / build 1538 | segundo engine dos fluxos críticos                  | cache Windows instalada com sucesso pela CLI fixada                               | MPL-2.0 e terceiros         | binário fixado pelo Playwright; usado somente em teste                                       |
| WebKit Playwright       |          26.5 / build 2336 | terceiro engine dos fluxos críticos                 | cache Windows instalada com sucesso pela CLI fixada                               | BSD/LGPL e terceiros        | binário fixado pelo Playwright; usado somente em teste                                       |

Esses mesmos builds fixados já haviam sido instalados e validados no snapshot Linux anterior; a coluna de instalação agora registra adicionalmente a cache Windows concluída, sem invalidar aquela evidência histórica.

A workstation atual usa as versões físicas registradas nesta tabela. O Docker Desktop aplica a fronteira nativa `Localhost only`, e o ADR-023 adiciona o guardian Job Object compilado pelo `csc.exe` físico do sistema; essas dependências de host não entram no bundle. O catálogo documental atual contém 200 cenários.

A prova Supabase local atual contém 16 migrations, predecessor `20260815000100` e head `20260819000100`. Reset, geração canônica e pgTAP passaram em 4 arquivos e 361/361 testes, com readiness de 17 dependências ACL e 16 rotinas DAL. Essa evidência não comprova os demais gates da branch, Supabase Cloud, VM, PR ou deploy.

### Snapshot anterior da workstation Linux — histórico

Esta fotografia foi substituída pelo ambiente Windows e não descreve a instalação atual. Ela é preservada sem reescrever suas versões ou conclusões:

| Item              | Versão  | Evidência histórica                                                                     |
| ----------------- | ------- | --------------------------------------------------------------------------------------- |
| Git               | 2.53.0  | já estava disponível no ambiente Linux                                                  |
| GitHub CLI        | 2.93.0  | já estava disponível no ambiente Linux                                                  |
| Docker Engine     | 29.6.2  | daemon local no contexto `default`                                                      |
| NVM               | 0.40.3  | clone do tag em `/home/ritu/.local/share/nvm-set-livre`                                 |
| Node.js           | 24.18.0 | instalado pelo NVM e fixado em `.nvmrc`/`.node-version`                                 |
| npm               | 11.19.0 | CLI física adjacente ao Node fixado                                                     |
| PostgreSQL client | 18.4    | usado então pelo `local:setup`; o ADR-020 substituiu essa autoridade por `pg` workspace |

### Imagens da stack Supabase local

No snapshot Linux anterior, as imagens abaixo foram baixadas e executadas exclusivamente pelo Supabase CLI no daemon local. Seus tags ficam fixados pela configuração/versão da CLI e não compõem o artefato Next.js. No Windows, a opção oficial `Localhost only` e a inspeção efetiva restringem os quatro listeners a `127.0.0.1`; a prova local atual passou em 4 arquivos e 361/361 testes pgTAP. Linux e CI continuam com `127.0.0.1` literal.

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

| Pacote                              | Versão    | Superfície/finalidade                                   | Licença    | Justificativa                                                      | Avaliação de supply chain                                                                |
| ----------------------------------- | --------- | ------------------------------------------------------- | ---------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `@axe-core/playwright`              | `4.12.1`  | testes; auditoria de acessibilidade em browser          | MPL-2.0    | automatiza violações axe nos fluxos centrais                       | pacote oficial da Deque, somente em teste, com versão e integridade fixadas no lockfile  |
| `@playwright/test`                  | `1.62.1`  | testes; E2E nos três engines                            | Apache-2.0 | comprova jornadas, responsividade e contratos reais de browser     | projeto Microsoft maduro; browsers separados e versão exata reduzem variação             |
| `@supabase/ssr`                     | `0.12.4`  | runtime server; sessão Auth por request e cookies SSR   | MIT        | integra refresh e publicação segura de cookies no App Router       | pacote oficial Supabase; versão e integridade fixadas, sem cliente global compartilhado  |
| `@supabase/supabase-js`             | `2.112.3` | runtime server; Auth e read models permitidos por RLS   | MIT        | cliente oficial normativo para sessão e fronteiras Supabase        | pacote oficial, usado somente com chave anon pública e contratos server-side estritos    |
| `@tanstack/react-query`             | `5.101.4` | runtime client; estado remoto interativo                | MIT        | centraliza mutations, cache e invalidação dos fluxos de identidade | projeto maduro; provider por app, versão exata e nenhum estado canônico no browser       |
| `@types/node`                       | `24.13.3` | desenvolvimento; tipos do runtime e scripts             | MIT        | alinha os contratos TypeScript à major do Node fixado              | pacote DefinitelyTyped sem runtime, auditado e preso ao lockfile                         |
| `@types/pg`                         | `8.21.0`  | desenvolvimento server-only; tipos do driver            | MIT        | tipa conexões, resultados e erros do DAL PostgreSQL                | pacote DefinitelyTyped sem runtime, com versão e integridade fixadas                     |
| `@types/react`                      | `19.2.18` | desenvolvimento server/client; tipos JSX e React        | MIT        | fornece os contratos de componentes para apps e pacote UI          | pacote DefinitelyTyped sem runtime, restrito à toolchain e preso ao lockfile             |
| `@types/react-dom`                  | `19.2.4`  | desenvolvimento server/client; tipos de renderização    | MIT        | completa os contratos do renderer React usados pelos dois apps     | pacote DefinitelyTyped sem runtime, restrito à toolchain e preso ao lockfile             |
| `eslint`                            | `9.39.5`  | desenvolvimento; análise estática                       | MIT        | aplica regras de qualidade com zero warnings                       | projeto consolidado; sem runtime de produção e com versão exata no lockfile              |
| `eslint-config-next`                | `16.3.0`  | desenvolvimento; regras Next, React e Core Web Vitals   | MIT        | mantém o lint alinhado exatamente ao framework                     | pacote oficial do Next, sem runtime de produção e fixado na mesma versão do framework    |
| `eslint-import-resolver-typescript` | `3.10.1`  | desenvolvimento; resolução de imports tipados           | ISC        | permite que regras de ciclo/import resolvam os workspaces          | já transitivo do config Next; postinstall bloqueado e artefatos presos ao lockfile       |
| `knip`                              | `6.32.0`  | desenvolvimento; código, dependências e exports mortos  | ISC        | detecta superfície não utilizada nos quatro workspaces             | ferramenta sem runtime de produção, versão exata e entrypoints explicitamente limitados  |
| `next`                              | `16.3.0`  | runtime server/client dos dois apps App Router          | MIT        | stack normativa com build standalone e headers nativos             | projeto oficial e amplamente mantido; versão exata, audit e lockfile obrigatórios        |
| `pg`                                | `8.23.0`  | tooling/runtime server-only; bootstrap, readiness e DAL | MIT        | mantém setup nativo e operações críticas sem depender de `psql`    | pacote maduro; isolado do browser, sem lifecycle liberado e com integridade no lockfile  |
| `prettier`                          | `3.9.6`   | desenvolvimento; formatação determinística              | MIT        | uniformiza código e Markdown alterado sem reformatar o Blueprint   | ferramenta consolidada, sem runtime de produção e fixada por versão/integridade          |
| `react`                             | `19.2.8`  | runtime server/client; composição da interface          | MIT        | biblioteca normativa suportada pelo Next fixado                    | projeto oficial e maduro; versão exata compartilhada por todos os consumidores           |
| `react-dom`                         | `19.2.8`  | runtime server/client; renderer web                     | MIT        | renderer oficial compatível com a versão React adotada             | projeto oficial e maduro; paridade exata com React e integridade fixada no lockfile      |
| `server-only`                       | `0.0.1`   | runtime server-only; bloqueio de import no client       | MIT        | impede importar DAL e secrets em componentes de cliente            | pacote oficial mínimo, sem dependências e sem execução de lifecycle liberada             |
| `supabase`                          | `2.113.0` | desenvolvimento local; Auth, banco, Storage e pgTAP     | MIT        | fornece a CLI normativa para reset e geração de contratos locais   | CLI fixada, cloud/link proibidos e lifecycle bloqueado pela configuração npm             |
| `typescript`                        | `5.9.3`   | desenvolvimento; tipagem estrita dos quatro workspaces  | Apache-2.0 | comprova contratos estáticos e compatibilidade entre as aplicações | compiler oficial, sem runtime de produção e fixado abaixo da incompatibilidade conhecida |
| `vitest`                            | `4.1.10`  | desenvolvimento; testes unitários e guardrails          | MIT        | executa testes rápidos em TypeScript e JavaScript                  | projeto mantido no ecossistema Vite; sem runtime de produção e preso ao lockfile         |
| `zod`                               | `4.4.3`   | runtime server/client; validação de fronteiras          | MIT        | rejeita payloads permissivos e compartilha contratos tipados       | pacote amplamente usado, sem lifecycle liberado e com versão/integridade fixadas         |

A CLI Supabase de produção não é dependência npm nem conteúdo do artifact. O bootstrap baixa exclusivamente a release oficial `2.113.0` para Linux amd64 por HTTPS, fixa o SHA-256 do archive e dos binários `supabase`/`supabase-go`, valida o ELF x86_64 e instala a ferramenta root-owned em `/usr/local/libexec/setlivre-host-tools/2.113.0`. O agente valida novamente identidade, owner/modo, versão e hashes antes de ler configuração privada ou iniciar migration; artifact e usuário de deploy não conseguem atualizar essa ferramenta. A dependência `supabase@2.113.0` da tabela continua exclusiva ao ambiente local/CI e traz seus pacotes opcionais por plataforma somente para esse uso.

Esta tabela é um contrato legível pelo gate: existe exatamente uma linha por pacote externo direto, com nome e versão idênticos aos quatro manifests canônicos. Os pacotes internos `@set-livre/*` são conferidos diretamente contra nome e versão dos workspaces e não representam supply chain externa.

Todas as versões são exatas e o `package-lock.json` registra transitivas e integridade. O gate recusa linha agrupada, duplicada, sem avaliação, stale, com alias, com `overrides` não vazio ou divergente dos manifests. A validação pós-SVM retornou zero vulnerabilidades em `npm audit`.

## Instalações de sistema para o navegador — histórico Linux

O comando oficial do Playwright instalou, no snapshot Linux anterior, somente os itens Ubuntu ausentes abaixo. Bibliotecas de browser já presentes foram apenas verificadas e marcadas pelo gerenciador de pacotes. No Windows, `npm run test:e2e:install` instalou com sucesso os três browsers sem `--with-deps`; essas dependências Ubuntu não devem ser reproduzidas localmente. A execução E2E integral do SHA final ainda é um gate pendente e não é inferida da instalação dos browsers. A stack é efêmera e deve ser encerrada com `npm run supabase:stop` após cada uso.

| Pacotes                                                                                                  | Versões                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fonts-freefont-ttf`; `fonts-ipafont-gothic`; `fonts-tlwg-loma-otf`; `fonts-unifont`; `fonts-wqy-zenhei` | `20211204+svn4273-4build1`; `00303-23ubuntu1`; `1:0.7.3-1build1`; `1:16.0.04-1build1`; `0.9.45-8build1` |
| `xfonts-cyrillic`; `xfonts-scalable`; `xvfb`                                                             | `1:1.0.5+nmu1build1`; `1:1.0.3-1.3build1`; `2:21.1.22-1ubuntu1`                                         |

## Exceção de script transitivo revisada

`unrs-resolver@1.12.2` (MIT), transitivo de `eslint-import-resolver-typescript`, declara `postinstall`. O conteúdo foi inspecionado, mas a política do projeto é mais restritiva: `ignore-scripts=true` impede sua execução e a de qualquer outro lifecycle durante `npm ci`; o binding opcional precisa funcionar apenas com os artefatos já fixados por integridade no lockfile, comprovado pelos gates após instalação limpa. `strict-allow-scripts=true`, ausência obrigatória de `allowScripts` e `dangerously-allow-all-scripts=false` fecham overrides acidentais, enquanto hooks do root/workspaces também são recusados pelo gate documental.

TanStack Query e os clientes Supabase SSR/JS entraram somente com a primeira consumidora real, a FEAT-002. Ícones e providers externos continuam ausentes até uma feature aprovada exigir seu uso.
