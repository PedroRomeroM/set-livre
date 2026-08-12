# Variáveis de ambiente

## 1. Regras

- apenas `NEXT_PUBLIC_*` entra no browser;
- nenhuma URL de banco privada no client;
- env separada por app/worker;
- validação Zod no boot;
- uma rota que depende de variável crítica falha fechada; `/ready` responde `503` quando `APP_RELEASE_SHA` é ausente/inválido ou o banco não está utilizável, enquanto `/live` permanece `200` e identifica release desconhecido sem expor configuração;
- logs mostram apenas nomes ausentes, nunca valores.

## 2. Fundação local

`.env.example` e `.env.e2e.example` contêm somente nomes e endpoints locais não secretos. `npm run supabase:reset` gera três arquivos ignorados com modo `0600`. Antes de alterar Docker ou banco, o bootstrap faz um preflight ancorado na raiz física do repositório e recusa qualquer ancestral simbólico. Na publicação de cada arquivo, ele recaptura a cadeia física, mantém os diretórios abertos e os revalida por dispositivo/inode. Cada conteúdo é gravado em arquivo temporário exclusivo no mesmo diretório, sincronizado e publicado por rename atômico; o destino nunca é aberto para escrita, portanto symlink e hard link preexistentes não fazem o setup sobrescrever seu outro alvo. Como Node não expõe `renameat` descriptor-relative de forma portátil, a prova detecta mudanças observadas entre as inspeções, mas pressupõe que nenhum principal com permissão de escrita altere o checkout ou o temporário concorrentemente durante a publicação.

No POSIX, um único preflight de `psql` ocorre depois da comprovação inicial do contexto Docker e antes de iniciar/resetar Supabase, obter `DB_URL` ou gerar senha. `PATH` serve somente para localizar o primeiro candidato: todas as entradas precisam ser absolutas e canônicas, e o candidato, cada link simbólico e todos os ancestrais físicos precisam pertencer a `root`, manter owner/mode/dev/ino/nlink protegidos e permanecer iguais durante as inspeções. O mesmo caminho absoluto original — inclusive `/usr/bin/psql` quando ele aponta para `pg_wrapper` — precisa informar exatamente PostgreSQL `18.4` em uma probe sem senha e sem `PATH`; seu snapshot é revalidado antes de extrair a senha de cada URL, imediatamente antes de cada um dos três spawns e depois da execução. O processo efetivo não recebe `PATH`: a allowlist contém somente `LANG=C`, `LC_ALL=C` e `PGPASSWORD` local controlada; a probe DAL acrescenta apenas `PGOPTIONS=-c role=app_dal`. Todo outro nome libpq/psql, arquivo de configuração, home, locale, loader ou secret herdado é excluído por construção, e host numérico `127.0.0.1:54322`, `--no-password` e `--no-psqlrc` impedem que `PGHOSTADDR`, service/passfile, TLS/GSS ou outro override redirecione o cliente. Windows nativo falha de forma fechada antes do start/reset e do acesso a credenciais porque Node não oferece aqui prova equivalente sem reparse point; WSL pode usar a fronteira POSIX. Esta garantia começa com npm/shell/Node, Docker e Supabase confiáveis — esses comandos ainda usam a toolchain global — e não cria vínculo atômico entre a última inspeção e `exec`: um escritor privilegiado concorrente permanece fora da fronteira.

Os arquivos `.env.local` da aplicação pública e do backoffice contêm somente runtime:

- `APP_ENV=local`;
- `APP_RELEASE_SHA=local`;
- `NEXT_PUBLIC_APP_URL` da respectiva aplicação, `NEXT_PUBLIC_SUPABASE_URL` e anon key local;
- `DATABASE_URL_APP_DAL`: login local sem herança e sem outra membership que assume explicitamente `app_dal` por `options=-c role=app_dal`;

O arquivo separado `.env.e2e.local`, lido apenas pelo harness, contém:

- `E2E_DATABASE_URL`: conexão administrativa local usada somente pelo guard/test tooling, nunca pelo runtime;
- `E2E_DATABASE_MARKER`: marcador efêmero comprovado por conexão antes da suíte;
- `E2E_BASE_URL`, `E2E_BACKOFFICE_URL`, Supabase local, DAL restrita e `E2E_ALLOW_LOCAL=1`.

O Playwright parseia o arquivo E2E sem incorporá-lo ao ambiente global, rejeita origem, host, protocolo, porta ou identidade divergentes e comprova banco, usuário e marcador local antes da suíte. Depois que o runner é iniciado por Node/npm confiáveis, o config sobrepõe dinamicamente todos os nomes herdados antes do merge interno de `webServer.env` e restaura somente a allowlist operacional do wrapper. Cada app é iniciado pelo Node absoluto e pelo mesmo launcher single-app usado no desenvolvimento; ele relê o `.env.local` físico `0600`, valida arquivo, manifesto, `bin` e versão exata da CLI Next, preserva o runtime local, substitui somente `APP_ENV` por `test` e inicia Next diretamente, sem npm filho ou shell. Assim, após essa fronteira, credenciais administrativas, npmrc do host, `NODE_OPTIONS`, loaders, PG, SSH e outros secrets não alcançam Next nem substituem anon key ou runtime local. Como esses dois processos Next são serviços persistentes, saída natural com código `0` é falha `1`; códigos não zero e sinais naturais mantêm seus valores reais. No POSIX, `exec` mantém wrapper e Next no único grupo controlado pelo Playwright; o wrapper reconhece e encaminha sinais, e finaliza o PGID com `SIGKILL` depois da fase graciosa. No Windows, o runner deriva o `taskkill.exe` absoluto de `SystemRoot/System32`, encerra a árvore com `/PID`, `/T` e `/F`, não consulta `PATH` nem abre shell e entrega ao utilitário apenas `SystemRoot` e `WINDIR`; DAL, banco, npm, SSH e demais secrets permanecem fora desse subprocesso. Cada tentativa tem timeout de cinco segundos. A limpeza completa vale para shutdown solicitado com a raiz ainda válida; após `close` natural, o wrapper não reutiliza PID encerrado no Windows nem força o PGID POSIX compartilhado, pois isso arriscaria outro processo ou eliminaria o próprio status de falha. Cobrir descendentes nesse caso exige Job Object/sentinel instalado antes do spawn. Cada processo de browser recebe separadamente apenas uma allowlist de paths, home/temporários, locale/fuso/terminal e integração gráfica local; credenciais, variáveis de banco, SSH, npm, loader e Snap são excluídas por construção. Senhas não entram em migration, log, screenshot ou arquivo versionado.

Durante a fronteira local-first, a release exige o `.env.local` de cada app antes do primeiro build e ignora `DATABASE_URL_APP_DAL` herdada do processo. No POSIX, cada arquivo precisa ser físico, regular, exclusivo e `0600`; a leitura usa `O_NOFOLLOW` e só entrega o conteúdo depois de revalidar por descritor e caminho a mesma identidade física, modo e quantidade de links. O parser aceita exatamente os seis nomes runtime locais e comprova também as origens da aplicação e do Supabase. As URLs da aplicação, do Supabase e da DAL precisam escrever o host exatamente como o IPv4 literal `127.0.0.1`; `localhost`, IPv6, IPv4 abreviado, inteiro, hexadecimal, octal, com ponto final ou percent-encoding são recusados mesmo quando o parser de URL os normalizaria para loopback. A DAL usa ainda a porta local `54322`; arquivo ausente/inseguro ou valor remoto/divergente interrompe a release antes de usar o secret. Durante o smoke, os handlers de `SIGHUP`/`SIGINT`/`SIGTERM` existem antes do primeiro servidor; `SIGHUP` encerra os dois PGIDs detached, força descendentes remanescentes após a janela graciosa e devolve código `129`.

`npm run dev`, `npm run dev:backoffice` e o `dev` do workspace backoffice passam obrigatoriamente por um launcher single-app. `node scripts/dev-all.mjs` reutiliza esse mesmo contrato, faz preflight dos dois `.env.local` antes de iniciar qualquer app e evita uma camada npm filha. Em POSIX, cada arquivo precisa ser físico, regular, aberto sem seguir link e usar modo `0600`. O conteúdo aceita exatamente os seis nomes runtime documentados nesta seção, exige `APP_ENV=local`, `APP_RELEASE_SHA=local`, Supabase HTTP no host literal `127.0.0.1` e porta `54321`, além da origem esperada de cada filho (`127.0.0.1:3000` para web e `127.0.0.1:3001` para backoffice). A URL DAL deve usar PostgreSQL no mesmo host literal, porta `54322`, banco `postgres`, login `app_runtime_local` com senha e exatamente `options=-c role=app_dal`. Antes de resolver ou iniciar a CLI, cada app também recusa `.env`, `.env.development` e `.env.development.local`; assim o carregador interno do `next dev` não encontra uma segunda fonte em disco e `.env.local` permanece a única permitida. Cada filho recebe separadamente apenas seu arquivo validado e uma allowlist operacional mínima do host; URLs cloud, credenciais, variáveis E2E, Git, npm e SSH exportadas não substituem o ambiente local. O launcher usa o Node absoluto de `process.execPath`, comprova a versão fixada de Node/npm e valida o arquivo físico, manifesto, `bin`, versão e ancestrais da CLI Next antes de executá-la por caminho absoluto, sem shell ou busca em `PATH`. No POSIX, cada filho de `dev-all` lidera seu próprio PGID; `SIGHUP` (código 129), `SIGINT` e `SIGTERM` percorrem o mesmo shutdown completo e, mesmo que o processo raiz feche antes dos descendentes, o grupo permanece rastreado até desaparecer ou receber `SIGKILL` após a janela graciosa. No Windows, tanto sinais normais quanto a falha de um app encerram cada árvore restante com o `taskkill.exe` absoluto e argumentos `/PID`, `/T` e `/F`, sem shell; cada tentativa tem limite de cinco segundos e encerra o próprio utilitário à força ao expirar. Como `next dev` é persistente, qualquer saída natural é falha: mesmo um código `0` vira código `1`, preservando a mensagem diagnóstica original e limpando a outra árvore antes de `dev-all` terminar. O supervisor só devolve `0` após shutdown explicitamente solicitado; o build finito do preview registra sua conclusão esperada antes do handler genérico e solicita esse shutdown. Sinais solicitados continuam preservando `129`, `130` ou `143`. Um npm pai, seu shell e opções Node já executaram antes de o launcher de um `npm run` assumir controle; por isso o guard garante o filho Next a partir de sua entrada íntegra, mas não recupera um chamador ou preloader já comprometido. As entradas diretas `node scripts/local-development-server.mjs web|backoffice` e `node scripts/dev-all.mjs` removem essa etapa anterior quando executadas com Node e shell confiáveis. Nenhuma variante protege uma alteração concorrente da toolchain, do checkout ou de qualquer arquivo `.env*` durante toda a vida do servidor por um principal com permissão de escrita.

Os três previews de produção locais — `npm start`, `npm run start:backoffice` e o `start` do workspace backoffice — passam pelo mesmo contrato por meio de `scripts/local-production-server.mjs`. O launcher relê uma vez o `.env.local` da aplicação, exige `APP_ENV=local` e `APP_RELEASE_SHA=local`, mantém app, Supabase e DAL nas portas documentadas e no host IPv4 literal `127.0.0.1`, e ignora integralmente valores runtime ou secrets herdados. `.env`, `.env.production` e `.env.production.local` são recusados antes do primeiro spawn. Depois de instalar handlers para os três sinais, no Linux a entrada exige `.next` física no mesmo dispositivo do diretório pai, consulta `/proc/self/mountinfo` para cobrir também bind mounts no mesmo dispositivo e percorre a árvore com `lstat`, recusando mudança de dispositivo e tratando symlink como folha. A identidade de todos os nós é comparada novamente depois do `rename` atômico para um irmão exclusivo e antes da remoção recursiva; um link interno é removido sem atravessar nem alterar seu alvo externo. Como Node não oferece uma enumeração universal de mounts com a mesma força fora do Linux, em macOS, Windows e outros sistemas uma `.next` preexistente é recusada antes de gerar o nome de retiro, renomear, remover ou iniciar Next; o operador precisa inspecioná-la e removê-la manualmente. A ausência de `.next` continua permitindo um build fresco nessas plataformas. Em seguida chama `next build` com o ambiente local sanitizado, exige código `0` e `BUILD_ID` fresco e chama `next start` com exatamente o mesmo ambiente em `127.0.0.1:3000` ou `:3001`. Node e CLI Next são físicos e absolutos; não há shell nem lookup em `PATH`. Um servidor que encerra sozinho, mesmo com código `0`, faz o wrapper devolver `1`; interrupções solicitadas limpam o grupo e preservam `129`, `130` ou `143`. No Windows, a identidade da árvore continua retida após a saída natural do root para que a tentativa síncrona de `taskkill /T /F` também cubra descendentes lógicos antes da conclusão. Assim, configuração cloud herdada ou incorporada em `.next` anterior não alcança o preview. A garantia começa na entrada íntegra do launcher e pressupõe ausência de outro writer sobre `.env.local`, `.next`, toolchain e checkout até o servidor iniciar; a invocação npm conserva a ressalva do processo pai. O runtime standalone de release permanece separado e usa apenas o ambiente empacotado validado pelo smoke.

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

- host/user/key;
- known_hosts;
- Object Storage;
- migration DB URL;
- Supabase project refs;
- provider sandbox;
- Sentry auth token para sourcemaps.

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
