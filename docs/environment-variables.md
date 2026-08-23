# Variáveis de ambiente

## 1. Regras

- apenas `NEXT_PUBLIC_*` entra no browser;
- nenhuma URL de banco privada no client;
- env separada por app/worker;
- validação Zod no boot;
- uma rota que depende de variável crítica falha fechada; `/ready` responde `503` quando `APP_RELEASE_SHA` é ausente/inválido ou o banco não está utilizável, enquanto `/live` permanece `200` e identifica release desconhecido sem expor configuração;
- logs mostram apenas nomes ausentes, nunca valores.

## 2. Fundação local

`.env.example` e `.env.e2e.example` contêm somente nomes e endpoints locais não secretos. `npm run supabase:reset` gera três arquivos ignorados e protegidos: POSIX exige modo `0600`; Windows exige arquivo físico sem reparse point, owner esperado e DACL protegida com allowlist do usuário atual, `SYSTEM` e administradores. Antes de alterar Docker ou banco, o bootstrap faz um preflight ancorado na raiz física do repositório e recusa ancestral simbólico/reparse. Na publicação de cada arquivo, ele recaptura a cadeia física e revalida sua identidade. Cada conteúdo é gravado em arquivo temporário exclusivo e protegido no mesmo diretório, sincronizado e publicado por rename atômico; o destino nunca é aberto para escrita, portanto links preexistentes não fazem o setup sobrescrever outro alvo. Como Node não expõe `renameat` descriptor-relative de forma portátil, a prova detecta mudanças observadas entre as inspeções, mas pressupõe que nenhum principal com permissão de escrita altere o checkout ou o temporário concorrentemente durante a publicação.

O bootstrap PostgreSQL não descobre nem executa `psql`: ele usa `pg@8.23.0` fixado no workspace, aceita somente `127.0.0.1:54322`, força `ssl: false`, aplica timeouts explícitos e elimina variáveis `PG*`/`PSQL*` herdadas. Antes de continuar, comprova `current_user`, `session_user`, banco e timeouts esperados; a conexão DAL assume apenas `app_dal`. Isso mantém a mesma autoridade em Windows 11 nativo e Linux. O `psql 18.6` instalado no Windows serve exclusivamente a diagnóstico manual do operador. A CLI Supabase também vem do workspace, mas o executor não chama o launcher `node_modules/supabase/dist/supabase.js`: ele valida `supabase@2.113.0`, o pacote nativo opcional da mesma versão e executa diretamente `node_modules/@supabase/cli-windows-x64/bin/supabase.exe` no Windows x64 ou `node_modules/@supabase/cli-linux-x64/bin/supabase` no Linux x64. Não há `npx`, CLI global ou lookup em `PATH`; o ambiente remove `NODE_OPTIONS`, `NODE_PATH`, `SUPABASE_CLI_BINARY_OVERRIDE` e nomes não allowlisted. Esta garantia começa com Docker Desktop/Engine e a árvore `node_modules` íntegros e não cria vínculo atômico contra um escritor privilegiado concorrente.

Os arquivos `.env.local` da aplicação pública e do backoffice contêm somente runtime:

- `APP_ENV=local`;
- `APP_RELEASE_SHA=local`;
- `NEXT_PUBLIC_APP_URL` da respectiva aplicação, `NEXT_PUBLIC_SUPABASE_URL` e anon key local;
- `DATABASE_URL_APP_DAL`: login local sem herança e sem outra membership que assume explicitamente `app_dal` por `options=-c role=app_dal`;

O arquivo separado `.env.e2e.local`, lido apenas pelo harness, contém:

- `E2E_DATABASE_URL`: conexão administrativa local usada somente pelo guard/test tooling, nunca pelo runtime;
- `E2E_DATABASE_MARKER`: marcador efêmero comprovado por conexão antes da suíte;
- `E2E_BASE_URL`, `E2E_BACKOFFICE_URL`, Supabase local, DAL restrita e `E2E_ALLOW_LOCAL=1`.

Esses valores não pertencem a `package.json` nem a qualquer comando npm. `scripts.knip` é exatamente `knip`: quando a análise carrega o config Playwright, o helper existente obtém os valores do `.env.e2e.local` físico e ignorado, em vez de duplicá-los como literais no manifesto. A unidade da CLI npm confiável fixa esse comando e recusa `E2E_DATABASE_URL`, `DATABASE_URL_APP_DAL` ou URI PostgreSQL em qualquer script npm dos quatro manifests canônicos — raiz, backoffice, contracts e UI. Esse hardening foi criado depois que uma build P5 compilou com sucesso, mas teve o standalone rejeitado por copiar o manifesto antigo com strings locais; nenhum smoke foi iniciado. O recorte 4/4 e o Knip com as sete variáveis E2E explicitamente unset passaram.

A build seguinte confirmou que manifesto, standalone, static e log estavam limpos, mas manteve exatamente uma ocorrência DAL no cache Turbopack de cada app; o gate foi recusado e o smoke permaneceu em zero. Como o cache não pertence ao runtime empacotado, `scripts/next-build.mjs` é agora a entrada única dos builds web/backoffice e do gerador de release. Com ambiente allowlisted no release, o wrapper reutiliza `resolveTrustedNextCliLaunch` dentro da operação primária para validar ancestrais físicos/protegidos do manifesto, Node/npm e pacote/binário/versão Next antes do spawn; mesmo se essa validação ou o build falharem, tenta remover fisicamente somente `<app>/.next/cache`. Falha do cleanup reprova e falha dupla vira `AggregateError`; standalone/static são preservados, e raiz ou ancestral simbólico/externo é recusado sem spawn nem travessia. O preview também limpa no supervisor pai após qualquer desfecho do grupo de build; cleanup falho impede validação/start, e a integração prova remoção de um valor DAL sintético antes do servidor. O run direcionado final passou em 40/40 por quatro arquivos — 12 de cache/wrapper, quatro do npm confiável, 16 de Next/local server e oito do supervisor de preview — junto a ESLint zero, checks Node, Knip com sete variáveis E2E unset e diff-check.

A cadeia estática final única passou em 764/764 testes por 76 arquivos, com `npm ci` 447/451/zero vulnerabilidades, todos os typechecks, docs 34/200/18, audit zero, Knip/diff-check e freeze 53/34/19. A build final, depois da remoção física dos dois `.next`, rodou exatamente uma vez via wrapper e passou em 14,733 s; log SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. A auditoria independente SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d` terminou `NO-BLOCKER`, com caches/retired e resíduos locais em zero. Esse era o estado pré-release.

No commit funcional `2045d1a00c15889007b3c5c04c08d0467fc3d9b3`, o gerador canônico rodou exatamente uma vez, exit `0`/21,26 s, e aprovou o primeiro smoke P5 embutido. O archive local modo `0600` e os artefatos manifestados não contêm env/secrets/PII; duas auditorias `NO-BLOCKER` encontraram caches/incoming/retired/portas/processos/DB/Mailpit/dblink em zero e paridade 2.871 sem mismatch. Essa fotografia local é ignorada e não publicada; o gate vigente exige release Linux x86_64 do HEAD atual e deploy/smoke na VM E2 Micro x86_64. PEND-003 e o remoto continuam pendentes.

O Playwright parseia o arquivo E2E protegido — modo `0600` em POSIX; DACL protegida, owner esperado e ausência de reparse point em Windows — sem incorporá-lo ao ambiente global, rejeita origem, host, protocolo, porta ou identidade divergentes e comprova banco, usuário e marcador local antes da suíte. Depois que o runner é iniciado por Node/npm confiáveis, o config sobrepõe dinamicamente todos os nomes herdados antes do merge interno de `webServer.env` e restaura somente a allowlist operacional do wrapper. No Windows, essa fronteira inclui `LOCALAPPDATA` exclusivamente para o guardian localizar seu cache físico privado; o guardian volta a validar caminho, reparse points e DACL antes de compilar ou executar qualquer byte, e o launcher seguinte não repassa essa variável ao processo Next. Cada app é iniciado pelo Node absoluto e pelo mesmo launcher single-app usado no desenvolvimento; ele relê o `.env.local` físico protegido, valida arquivo, manifesto, `bin` e versão exata da CLI Next, preserva o runtime local, substitui somente `APP_ENV` por `test` e inicia Next diretamente, sem npm filho ou shell. Assim, após essa fronteira, credenciais administrativas, npmrc do host, `NODE_OPTIONS`, loaders, PG, SSH e outros secrets não alcançam Next nem substituem anon key ou runtime local. Como esses dois processos Next são serviços persistentes, saída natural com código `0` é falha `1`; códigos não zero e sinais naturais mantêm seus valores reais. No POSIX, `exec` mantém wrapper e Next no único grupo controlado pelo Playwright; o wrapper reconhece e encaminha sinais, e finaliza o PGID com `SIGKILL` depois da fase graciosa. No Windows, o guardian versionado do ADR-023 cria Next suspenso, associa-o a um Job Object com `KILL_ON_JOB_CLOSE` e só então retoma a execução. Fechar o guardian — por shutdown, saída da raiz ou queda abrupta do supervisor — elimina todos os descendentes pelo kernel sem `taskkill`, enumeração de PID ou ambiente auxiliar. Cada processo de browser recebe separadamente apenas uma allowlist de paths, home/temporários, locale/fuso/terminal e integração gráfica local; credenciais, variáveis de banco, SSH, npm, loader e Snap são excluídas por construção. Senhas não entram em migration, log, screenshot ou arquivo versionado.

Durante a fronteira local-first, a release exige o `.env.local` de cada app antes do primeiro build e ignora `DATABASE_URL_APP_DAL` herdada do processo. No POSIX, cada arquivo precisa ser físico, regular, exclusivo e `0600`; a leitura usa `O_NOFOLLOW` e só entrega o conteúdo depois de revalidar por descritor e caminho a mesma identidade física, modo e quantidade de links. O parser aceita exatamente os seis nomes runtime locais e comprova também as origens da aplicação e do Supabase. As URLs da aplicação, do Supabase e da DAL precisam escrever o host exatamente como o IPv4 literal `127.0.0.1`; `localhost`, IPv6, IPv4 abreviado, inteiro, hexadecimal, octal, com ponto final ou percent-encoding são recusados mesmo quando o parser de URL os normalizaria para loopback. A DAL usa ainda a porta local `54322`; arquivo ausente/inseguro ou valor remoto/divergente interrompe a release antes de usar o secret. Durante o smoke, os handlers de `SIGHUP`/`SIGINT`/`SIGTERM` existem antes do primeiro servidor; `SIGHUP` encerra os dois PGIDs detached, força descendentes remanescentes após a janela graciosa e devolve código `129`.

`npm run dev`, `npm run dev:backoffice` e o `dev` do workspace backoffice passam obrigatoriamente por um launcher single-app. `node scripts/dev-all.mjs` reutiliza esse mesmo contrato, faz preflight dos dois `.env.local` antes de iniciar qualquer app e evita uma camada npm filha. Em POSIX, cada arquivo precisa ser físico, regular, aberto sem seguir link e usar modo `0600`; no Windows, precisa ser físico, sem reparse point, pertencer ao owner esperado e ter DACL protegida limitada aos principals autorizados. O conteúdo aceita exatamente os seis nomes runtime documentados nesta seção, exige `APP_ENV=local`, `APP_RELEASE_SHA=local`, Supabase HTTP no host literal `127.0.0.1` e porta `54321`, além da origem esperada de cada filho (`127.0.0.1:3000` para web e `127.0.0.1:3001` para backoffice). A URL DAL deve usar PostgreSQL no mesmo host literal, porta `54322`, banco `postgres`, login `app_runtime_local` com senha e exatamente `options=-c role=app_dal`. Antes de resolver ou iniciar a CLI, cada app também recusa `.env`, `.env.development` e `.env.development.local`; assim o carregador interno do `next dev` não encontra uma segunda fonte em disco e `.env.local` permanece a única permitida. Cada filho recebe separadamente apenas seu arquivo validado e uma allowlist operacional mínima do host; URLs cloud, credenciais, variáveis E2E, Git, npm e SSH exportadas não substituem o ambiente local. O launcher usa o Node absoluto de `process.execPath`, comprova a versão fixada de Node/npm e valida o arquivo físico, manifesto, `bin`, versão e ancestrais da CLI Next antes de executá-la por caminho absoluto, sem shell ou busca em `PATH`. No POSIX, cada filho de `dev-all` lidera seu próprio PGID; `SIGHUP` (código 129), `SIGINT` e `SIGTERM` percorrem o mesmo shutdown completo e, mesmo que o processo raiz feche antes dos descendentes, o grupo permanece rastreado até desaparecer ou receber `SIGKILL` após a janela graciosa. No Windows, cada filho nasce dentro de Job Object antes de executar; os sinais normais, a falha do outro app, a saída natural da raiz e a morte do supervisor fecham o guardian e eliminam a árvore por identidade de kernel. Como `next dev` é persistente, qualquer saída natural é falha: mesmo um código `0` vira código `1`, preservando a mensagem diagnóstica original e limpando a outra árvore antes de `dev-all` terminar. O supervisor só devolve `0` após shutdown explicitamente solicitado; o build finito do preview registra sua conclusão esperada antes do handler genérico e solicita esse shutdown. Sinais solicitados continuam preservando `129`, `130` ou `143`. Um npm pai, seu shell e opções Node já executaram antes de o launcher de um `npm run` assumir controle; por isso o guard garante o filho Next a partir de sua entrada íntegra, mas não recupera um chamador ou preloader já comprometido. As entradas diretas `node scripts/local-development-server.mjs web|backoffice` e `node scripts/dev-all.mjs` removem essa etapa anterior quando executadas com Node e shell confiáveis. Nenhuma variante protege uma alteração concorrente da toolchain, do checkout ou de qualquer arquivo `.env*` durante toda a vida do servidor por um principal com permissão de escrita.

Os três previews de produção locais — `npm start`, `npm run start:backoffice` e o `start` do workspace backoffice — passam pelo mesmo contrato por meio de `scripts/local-production-server.mjs`. O launcher relê uma vez o `.env.local` da aplicação, exige `APP_ENV=local` e `APP_RELEASE_SHA=local`, mantém app, Supabase e DAL nas portas documentadas e no host IPv4 literal `127.0.0.1`, e ignora integralmente valores runtime ou secrets herdados. `.env`, `.env.production` e `.env.production.local` são recusados antes do primeiro spawn. Depois de instalar handlers para os três sinais, no Linux a entrada exige `.next` física no mesmo dispositivo do diretório pai, consulta `/proc/self/mountinfo` para cobrir também bind mounts no mesmo dispositivo e percorre a árvore com `lstat`, recusando mudança de dispositivo e tratando symlink como folha. A identidade de todos os nós é comparada novamente depois do `rename` atômico para um irmão exclusivo e antes da remoção recursiva; um link interno é removido sem atravessar nem alterar seu alvo externo. No Windows, o alvo `.next` precisa estar na allowlist, no mesmo volume e manter identidade física; reparse points são recusados, e caminho/árvore retirados são revalidados antes da remoção. Em macOS e outras plataformas sem prova implementada, uma `.next` preexistente é recusada e requer remoção manual. Em seguida chama `next build` com o ambiente local sanitizado, exige código `0` e `BUILD_ID` fresco e chama `next start` com exatamente o mesmo ambiente em `127.0.0.1:3000` ou `:3001`. Node e CLI Next são físicos e absolutos; não há shell nem lookup em `PATH`. Um servidor que encerra sozinho, mesmo com código `0`, faz o wrapper devolver `1`; interrupções solicitadas limpam o grupo e preservam `129`, `130` ou `143`. No Windows, build e servidor são guardians distintos, cada alvo é associado a seu Job Object antes de executar e todo descendente é eliminado ao fechar o guardian, inclusive após saída natural da raiz. Assim, configuração cloud herdada ou incorporada em `.next` anterior não alcança o preview. A garantia começa na entrada íntegra do launcher e pressupõe ausência de outro writer sobre `.env.local`, `.next`, toolchain e checkout até o servidor iniciar; a invocação npm conserva a ressalva do processo pai. O runtime standalone de release permanece separado e usa apenas o ambiente empacotado validado pelo smoke Linux.

## 3. Aplicação pública

### Públicas

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_PAYMENT_PROVIDER_PUBLIC_KEY` somente se provider exigir
- `NEXT_PUBLIC_ENVIRONMENT` somente se uma UI futura realmente precisar expor esse estado; a fundação usa `APP_ENV` server-side

### Server-only

- `DATABASE_URL_APP_DAL`
- `SUPABASE_SERVICE_ROLE_KEY` somente para casos isolados aprovados; não no fluxo normal
- `PAYMENT_PROVIDER`
- `PAYMENT_PROVIDER_SECRET_KEY`
- `PAYMENT_WEBHOOK_SECRET`
- `EMAIL_PROVIDER`
- `EMAIL_FROM`
- `EMAIL_SECRET`
- `SENTRY_DSN` somente server-side; uma integração browser futura exige variável `NEXT_PUBLIC_*` distinta e aprovação de privacidade
- `REQUEST_ID_SECRET`
- `CURSOR_SIGNING_SECRET`
- `FIELD_ENCRYPTION_KEY`
- `APP_RELEASE_SHA`

`DATABASE_URL_APP_DAL` nunca aponta para `postgres`, `service_role` ou usuário proprietário. O parser exige protocolo PostgreSQL, login/senha/banco explícitos e exatamente um `options=-c role=app_dal`, permitindo parâmetros TLS sem aceitar overrides de identidade. Readiness também prova `current_user=app_dal` sem atributos privilegiados nem memberships de saída, além do manifesto exato do `session_user`: somente `CONNECT`, membership DAL, referência administrativa `postgres` sem `SET/INHERIT`, limite de dez conexões, validade infinita, ausência de ACL/ownership residual e a máscara vazia do GUC JWT local. Como web e backoffice executam simultaneamente com a mesma credencial, o orçamento completo é seis conexões para o pool compartilhado de comandos web, duas para o readiness web e duas para o readiness do backoffice (`6 + 2 + 2 = 10`); nenhum desses processos pode interpretar o limite da role como orçamento próprio. Em produção, a credencial e a garantia de que nenhum material de assinatura seja legível por GUC/current_setting ou diretamente em `pg_roles`, `pg_user`/`pg_db_role_setting` permanecem bloqueadas por PEND-002.

A FEAT-002 reutiliza os seis nomes do runtime local já documentados: `APP_ENV`, `APP_RELEASE_SHA`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `DATABASE_URL_APP_DAL`; não introduz service role no app, SMTP de produção ou segredo browser. Apesar do prefixo público exigido pelo SDK, a anon key não é autoridade: RLS/grants e o trigger protegido continuam obrigatórios. `local`/`test` aceitam apenas os dois endpoints HTTP `127.0.0.1` exatos; `development`/`production` exigem HTTPS tanto para a aplicação quanto para o Supabase e mantêm `Secure` nos cookies.

Na FEAT-004, `APP_ENV` também deriva server-side a capacidade de onboarding do recebedor. `local | test` resulta em `recipientOnboardingCapability="local_adapter"`; `development | production`, valor ausente ou inválido resultam em `"unavailable"`. Essa derivação é fail-closed mesmo quando outra validação de boot também recusar a configuração. Nenhuma variável `NEXT_PUBLIC_*`, campo do browser ou futuro `PAYMENT_PROVIDER` habilita o adapter local, e a fatia atual não consome credencial de gateway.

O mesmo `APP_ENV`, combinado server-side com `ownerContract.source`, deriva uma capability separada de ativação. Contrato `approved` sempre resulta em `ownerActivationCapability="available"`; `local_fixture` resulta em `"available"` somente em `local | test`, enquanto `development | production`, ausência ou valor inválido resultam em `"unavailable"`. Não existe variável nova, override público ou campo enviado pelo browser. Essa capability não representa validade jurídica, readiness, estado de banco ou provider e não torna `/ready` dependente do conteúdo contratual.

## 4. Backoffice

- `NEXT_PUBLIC_APP_URL` apontando para a origem do backoffice;
- `BACKOFFICE_APP_URL` server-side somente quando um consumidor real exigir;
- Supabase public/session;
- `DATABASE_URL_APP_DAL`;
- secrets necessários a ações admin server-only;
- `BACKOFFICE_ALLOWED_NETWORKS` quando implementado no app além do Nginx;
- `APP_RELEASE_SHA`.

Não compartilhar cookie name/domain com app público sem decisão.

## 5. Workers

- `DATABASE_URL_APP_DAL`;
- provider secrets;
- e-mail;
- Object Storage credentials;
- `WORKER_ID`;
- `APP_RELEASE_SHA`;
- intervalos/limites.

## 6. Deploy/CI

O workflow de build/package Linux x86_64 usa somente variáveis de repositório deliberadamente públicas. Elas alimentam o bundle do browser e não conferem autoridade server-side:

| Tipo                | Nome                       | Contrato                                                                |
| ------------------- | -------------------------- | ----------------------------------------------------------------------- |
| repository variable | `PRD_DEPLOY_ENABLED`       | permanece `false`; `true` somente após bootstrap/smoke e decisão humana |
| repository variable | `SET_LIVRE_REPOSITORY_ID`  | ID exato `1328339374`, comprovado pela API                              |
| repository variable | `CI_GITHUB_WORKFLOW_ID`    | ID do path CI ativo; preenchido somente depois do registro na `main`    |
| repository variable | `PRD_GITHUB_WORKFLOW_ID`   | ID distinto do path PRD ativo; preenchido no mesmo boundary             |
| repository variable | `PRD_PUBLIC_APP_URL`       | origem exata `https://setlivre.com`                                     |
| repository variable | `PRD_BACKOFFICE_APP_URL`   | origem exata `https://ops.setlivre.com`                                 |
| repository variable | `PRD_SUPABASE_PROJECT_REF` | ref pública do projeto produtivo em São Paulo; 20 caracteres `[a-z0-9]` |
| repository variable | `PRD_SUPABASE_URL`         | URL exata do projeto produtivo em São Paulo; projeto canadense proibido |
| repository variable | `PRD_SUPABASE_ANON_KEY`    | chave pública do projeto de São Paulo; nunca autoridade ou secret       |

O host separa configuração operacional de credenciais. `/etc/setlivre-deployer/production.env` é um arquivo físico `root:setlivre-deployer` modo `0640` e contém somente valores não secretos consumidos por `EnvironmentFile`:

| Nome                        | Contrato                                                             |
| --------------------------- | -------------------------------------------------------------------- |
| `GITHUB_REPOSITORY_ID`      | ID fixo `1328339374`, conferido pela identidade atual do repositório |
| `CI_GITHUB_WORKFLOW_ID`     | ID positivo do path registrado `.github/workflows/ci.yaml`           |
| `PRD_GITHUB_WORKFLOW_ID`    | ID positivo e distinto do path `.github/workflows/prd-deploy.yaml`   |
| `PRD_PUBLIC_APP_URL`        | origem exata `https://setlivre.com`                                  |
| `PRD_BACKOFFICE_APP_URL`    | origem exata `https://ops.setlivre.com`                              |
| `PRD_SUPABASE_PROJECT_REF`  | ref pública obrigatória do projeto produtivo em São Paulo            |
| `PRD_SUPABASE_URL`          | URL pública exata do projeto produtivo em São Paulo                  |
| `PRD_SUPABASE_ANON_KEY`     | chave pública do mesmo projeto; não confere autoridade server-side   |
| `SUPABASE_SERVER_CA_SHA256` | SHA-256 do Server root certificate oficial entregue por credencial   |
| `PRD_DEPLOY_ENABLED`        | segunda trava local; permanece `false` até habilitação coordenada    |

Secrets e o certificado CA ficam exclusivamente em `/etc/setlivre-deployer/credentials`, diretório físico `root:root` modo `0700`. O configurador exige exatamente estes cinco arquivos físicos `root:root` modo `0600` e os entrega ao poller por `systemd LoadCredential`, sob nomes equivalentes dentro de `$CREDENTIALS_DIRECTORY`:

| Arquivo                  | Conteúdo/uso                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `github-deploy-token`    | token fine-grained: Contents read; Actions read/write somente para regeneração validada |
| `supabase-access-token`  | token da CLI de migration, com menor escopo e rotação                                   |
| `supabase-db-password`   | senha administrativa usada somente no push de migrations                                |
| `database-url-app-dal`   | URL do login runtime restrito que assume apenas `app_dal`, com TLS obrigatório          |
| `supabase-server-ca.pem` | Server root certificate oficial cujo SHA-256 corresponde ao valor em `production.env`   |

Nenhum secret Supabase/DAL pertence a `production.env`, GitHub Actions, repository/environment secret, PR, `.env.example`, artifact ou log. `LoadCredential` materializa as cinco fontes em diretório privado gerenciado pelo systemd durante a execução; o agente lê esses arquivos, não variáveis de ambiente contendo os secrets. O CA é baixado do painel **Connect** do projeto produtivo, validado como certificado PEM e fixado por `SUPABASE_SERVER_CA_SHA256`; os envs runtime root-owned recebem o caminho específico da unit em `$CREDENTIALS_DIRECTORY` e usam verificação completa de CA e hostname. Os contratos `authorization-contract.json`, `baseline-authorization-contract.json` e `authorization-head.json` são gerados deterministicamente dentro do artifact assinado, não são credenciais externas. `PRD_SUPABASE_PROJECT_REF`, `PRD_SUPABASE_URL` e `PRD_SUPABASE_ANON_KEY` são públicos por contrato e existem como variáveis do repositório e no host. A ref é obrigatória, precisa corresponder a `^[a-z0-9]{20}$`, e a URL é aceita somente quando for exatamente `https://<PRD_SUPABASE_PROJECT_REF>.supabase.co`; ref, URL e chave precisam pertencer ao mesmo projeto produtivo de São Paulo nos dois lados da fronteira. Os três IDs GitHub não são secrets, mas são autoridade operacional e também existem nos dois lados: `SET_LIVRE_REPOSITORY_ID` mais os dois workflow IDs como variáveis do repositório, e os equivalentes `GITHUB_REPOSITORY_ID`/workflow IDs no host. Os workflow IDs só podem ser preenchidos depois que o GitHub registrar os paths exatos, usando os comandos fail-closed de `configuration-seteps.md`; precisam ser positivos e distintos, e o repository ID consultado deve ser exatamente `1328339374`. O Environment GitHub `production` permanece cadastrado somente para a política de branch `main`, sem secrets ou mutação. Com um único colaborador, autoaprovação não é usada como controle; os ciclos de `@codex review`, o merge protegido e as duas travas `PRD_DEPLOY_ENABLED` formam fronteiras independentes. O contrato não possui `PRD_SSH_HOST`, `PRD_SSH_USER`, `PRD_SSH_PRIVATE_KEY` ou `PRD_SSH_KNOWN_HOSTS`; SSH administrativo humano usa configuração local separada e porta 22 restrita ao CIDR `/32`.

Build/package usa GitHub-hosted `ubuntu-24.04`, exige Linux x86_64 e `RUNNER_ARCH=X64` antes do build e publica o artifact por action fixada; essa fase não usa secrets server-side. O bootstrap da VM recebe apenas `<admin-cidr-/32> <release-manager-source> <release-manager-sha256>`, congela a fonte física absoluta e valida o hash calculado antes da elevação. Depois, `configure-production-deployer.sh` instala o agente pull, smoke, dispatcher e timer usando fontes e hashes fixados. O usuário dedicado só pode chamar o dispatcher root-owned allowlisted por uma regra sudoers exata; não existe variável que habilite sudo genérico.

O agente remove os valores do próprio ambiente depois de capturá-los, baixa somente por HTTPS outbound e escreve os envs runtime no staging privado para o manager root-owned. Sua sandbox systemd permite escrita somente em `/var/lib/setlivre-deployer/.setlivre`, `/opt/setlivre` e `/run/lock`; conceder `/run` inteiro é expansão proibida. O deploy prova o head remoto exato `20260819000100` separadamente; o readiness aceita somente a janela de compatibilidade `20260819000100` + `20260815000100`, sob expand/migrate/contract. Object Storage, provider sandbox e Sentry não possuem credencial ativa nesta liberação e continuam dependentes de decisão própria. A lista operacional e a rotação ficam em `configuration-seteps.md`.

O projeto Supabase produtivo em `sa-east-1` (São Paulo) ainda não foi criado. O projeto existente em `ca-central-1` não é produção e sua ref, URL ou chave não podem preencher `PRD_SUPABASE_PROJECT_REF`, `PRD_SUPABASE_URL` ou `PRD_SUPABASE_ANON_KEY` para habilitar entrega. Na última evidência OCI preservada (`2026-08-19T09:45:42Z`), `PRD_DEPLOY_ENABLED=false`, não havia VM Set Livre ativa e o Plan E2 encerrou fail-closed com `OUT_OF_HOST_CAPACITY`; agente/configuração do host e migrations Cloud não estavam aplicados, o domínio raiz/`www` ainda apontava para parking, `ops` não tinha origem e TLS não estava comprovado. PR, merge e deploy não foram executados. A presença dos nomes acima não constitui gate, configuração válida ou deploy, e sessão/inventário OCI devem ser revalidados antes de nova mutação.

## 7. Defaults não secretos

- `APP_TIMEZONE=America/Sao_Paulo`;
- `BOOKING_HORIZON_DAYS=365`;
- `CARD_HOLD_MINUTES=15`;
- `PIX_DEFAULT_EXPIRY_MINUTES=15`;
- `PAYOUT_DELAY_HOURS=24`;
- `REMINDER_LEAD_HOURS=24`;
- `PUBLIC_PAGE_SIZE=24`;
- `ADMIN_PAGE_SIZE=50`;
- `MAX_STUDIO_PHOTOS=20`;
- `MAX_PHOTO_BYTES=15728640`;
- `MAX_ICAL_BYTES=2097152`.

Defaults de negócio idealmente ficam em configuração versionada; env é aceitável para global operacional.

## 8. Rotação

Documentar owner, criado, último rotate, próximo rotate e impacto. Rotação de cursor/encryption precisa de key ring/versão, não troca destrutiva.
