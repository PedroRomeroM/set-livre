# Runbook de release e rollback

Este runbook é Linux-only para geração, release, deploy e rollback. A workstation Windows 11 nativa, sem WSL, executa desenvolvimento, build e testes de produto; ela não substitui o Ubuntu de CI/release nem a validação Linux x86_64 da VM E2. `flock`, GNU tar, `umask`, modos POSIX, symlinks atômicos, `/opt`, systemd, Nginx e hardening continuam obrigatórios no Linux.

## Pré-release

- [ ] ciclo completo de [`review-deploy-cycle.md`](review-deploy-cycle.md) encerrado no SHA atual;
- [ ] main verde;
- [ ] changelog;
- [ ] migration revisada;
- [ ] compatibilidade com previous;
- [ ] ponto de recuperação gerenciado recente ou, em operação destrutiva excepcional, backup lógico restaurado e aprovado;
- [ ] provider sandbox/contracts;
- [ ] artifact Linux x86_64;
- [ ] checksum;
- [ ] release notes;
- [ ] aprovação.

Na release canônica Linux, a geração exige um `.env.local` físico, regular, exclusivo e `0600` para cada aplicação. A identidade e o modo precisam permanecer estáveis entre caminho e descritor durante a leitura; arquivo ausente, link ou permissão ampla aborta antes do build. O smoke local do artefato usa exclusivamente a URL DAL desse arquivo. A URL precisa apontar para a instância Supabase no host IPv4 literal `127.0.0.1:54322`, com `app_runtime_local` assumindo `app_dal`; uma variável homônima exportada no host não tem precedência e uma URL local inválida aborta antes de iniciar os servidores empacotados. Os ADRs 019 e 021 não transformam um artefato local em produção apenas porque ele é x64: o workflow produz separadamente o bundle Linux x86_64 com origens públicas aprovadas e injeta secrets somente no runtime da VM.

A release exige Linux com GNU tar e `util-linux flock`. O lock exclusivo cobre build, `releaseRoot`, smoke, candidatos `.incoming`, verificação e publicação; invocações simultâneas esperam em vez de compartilhar temporários. Não remova `.artifacts/release.lock`: o arquivo permanece, sem lock ativo, para que todas as invocações usem o mesmo inode. Confirme os requisitos com `tar --version` e `flock --version`; ausência de `flock` interrompe o comando antes do build. Não tente substituir esses contratos por `tar.exe`, lockfile por presença, WSL ou permissões NTFS.

Antes de executar a release, confirme que `.artifacts` não é mount e não contém volume, bind mount ou cache montado nos caminhos gerados. O script comprova isso pelo `/proc/self/mountinfo` do namespace Linux atual antes de alterar permissões ou iniciar o build, e repete a prova em cada árvore antes e depois do retiro por rename atômico. Se `mountinfo` não puder ser lido/interpretado, se um mount for encontrado ou se a identidade física mudar, a execução aborta sem atravessar a árvore; inspecione e desmonte manualmente o caminho antes de repetir. Nunca remova `.artifacts` recursivamente para contornar esse erro. A prova assume que nenhum principal privilegiado altera mounts ou arquivos concorrentemente.

O tar normaliza modos independentemente do `umask`: diretórios e arquivos executáveis são `0755`; arquivos regulares não executáveis são `0644`; bits especiais `setuid`, `setgid` e `sticky` são removidos. Rebuild do mesmo SHA precisa reproduzir checksum idêntico.

O smoke registra `SIGHUP`, `SIGINT` e `SIGTERM` antes de iniciar qualquer servidor. Se a sessão de terminal/SSH encerrar, `SIGHUP` limpa os dois grupos de processo detached — inclusive descendentes após a saída do líder — e a release termina com código `129`; confirme que as portas temporárias foram liberadas antes de repetir.

## Deploy

Este fluxo ainda não foi executado nesta branch. O projeto Supabase produtivo
`oirvvnojgkzdppkdvhej` está saudável em `sa-east-1`, vazio e sem branches; não há VM Set Livre
provisionada. PR, review, merge, migrations Cloud e deploy permanecem pendentes; mantenha o fluxo
fail-closed e não substitua nenhum pré-requisito por workaround.

### Preflight cloud obrigatório

1. workflow `CI` verde, não cancelado, no SHA incorporado a `main`;
2. ciclo completo de [`review-deploy-cycle.md`](review-deploy-cycle.md): PR não draft, pedido
   `@codex review`, espera mínima de 60 minutos a cada pedido, todas as superfícies inspecionadas,
   resposta explicitamente limpa sobre o SHA final, conversas resolvidas e merge protegido; o
   Environment build-only não simula aprovação por um segundo colaborador inexistente;
3. projeto Supabase produtivo de São Paulo e valores públicos iguais no repositório/host; `PRD_SUPABASE_PROJECT_REF=oirvvnojgkzdppkdvhej` e `PRD_SUPABASE_URL=https://oirvvnojgkzdppkdvhej.supabase.co`, com outra ref recusada antes de migration;
4. `supabase db push --dry-run --include-all` revisado;
5. head remoto comprovado separadamente como `20260819000100` e readiness restrito aceitando somente `20260819000100` + predecessor `20260815000100`;
6. build/package em GitHub-hosted Linux x86_64, artifact publicado por action fixada e `BUILD_ID` dos dois apps iguais ao SHA, sem secrets ou mutação;
7. agente pull outbound-only instalado/verificado na VM pública sem runner self-hosted ou SSH de deploy;
8. validação do artifact cobrindo repositório, workflow, run de origem, run provedor, branch, SHA, digest, tamanho, manifesto schema 4, `publicBuildConfigSha256` e ancestralidade;
9. VM `VM.Standard.E2.1.Micro` x86_64, hardening, budgets para aproximadamente 1 GB, dispatcher root-owned, release manager protocolo v3, checkpoint/proveniência, unit de recuperação antes dos serviços, redirects HTTP canônicos, disco e serviços comprovados;
10. ponto de recuperação gerenciado recente, restore drill vigente e compatibilidade da release anterior;
11. DNS/TLS e `/32` administrativo sem drift;
12. nenhum secret server-side em GitHub/build/archive/log/`production.env`; cinco fontes privadas somente em `/etc/setlivre-deployer/credentials`, `root:root`/`0600`, entregues por `systemd LoadCredential`.

Bootstrap administrativo inicial, uma única vez por host refeito:

```bash
manager_source="$(realpath scripts/production-release-manager.sh)"
manager_sha256="$(sha256sum -- "$manager_source" | cut -d' ' -f1)"
sudo bash scripts/bootstrap-oracle-host.sh \
  "$SET_LIVRE_ADMIN_CIDR" \
  "$manager_source" \
  "$manager_sha256"
```

Não passe deploy public key/user/SSH: a assinatura termina em `<admin-cidr-/32> <release-manager-source> <release-manager-sha256>`. O bootstrap congela a fonte antes da primeira mutação. Depois, em sessão administrativa separada, instale o agente com `scripts/configure-production-deployer.sh install <agent> <agent-sha256> <smoke> <smoke-sha256>` e execute `verify`. As fontes devem ser físicas, root-owned e ter hashes previamente revisados. Atualizações futuras do manager usam somente a operação administrativa transacional do configurador, com preparação root-owned, hash/versão, troca atômica, verificação e rollback do próprio manager; agente e artifact não recebem essa autoridade. Depois que o GitHub registrar os workflows, use exclusivamente a consulta por path de `configuration-seteps.md`, grave `SET_LIVRE_REPOSITORY_ID`, os dois workflow IDs, `PRD_SUPABASE_PROJECT_REF`, `PRD_SUPABASE_URL` e a chave publicável como repository variables, e preencha os equivalentes públicos em `/etc/setlivre-deployer/production.env`; os workflows precisam estar ativos, seus IDs devem ser positivos/distintos/iguais nos dois lados, a ref precisa ter 20 caracteres `[a-z0-9]`, a URL precisa ser exatamente `https://<ref>.supabase.co` e o hash CA precisa corresponder ao Server root certificate oficial. Esse arquivo contém somente configuração não secreta. Token GitHub, token/senha Supabase, URL DAL e CA ocupam os cinco arquivos exatos em `/etc/setlivre-deployer/credentials`; confirme `root:root`/`0600`, inventário fechado e as cinco entradas `LoadCredential` da unit. Os três contratos de autorização são gerados e validados dentro do artifact assinado, nunca copiados manualmente para o host. Mantenha a trava `false`, repita `verify` e prove a sandbox gravável exata `/var/lib/setlivre-deployer/.setlivre /opt/setlivre /run/lock` antes de habilitar o timer mutável. Ausência/divergência nunca autoriza valor adivinhado, sandbox mais ampla ou bypass.

No primeiro merge, preserve o ID do run `CI` originado pelo `push` de `main`, ainda com deploy desabilitado. Depois que os dois workflow IDs estiverem registrados, o host estiver integralmente verificado e as travas forem habilitadas de forma coordenada, reexecute exatamente esse run uma vez com `gh run rerun <RUN_ID> --repo PedroRomeroM/set-livre`. A reexecução preserva SHA/ref, incrementa `run_attempt` e o `workflow_run: completed` aciona a publicação canônica. Isso é o bootstrap explícito da primeira entrega; commit vazio, run de PR ou `workflow_dispatch` sem uma publicação anterior aprovada são inválidos.

Depois que DNS `A/CNAME` dos três nomes resolverem para a VNIC, emita um único certificado SAN pelo helper root-owned: `sudo /usr/local/sbin/setlivre-issue-tls-certificate '<email-operacional>'`. Ele invoca exclusivamente `certbot certonly --webroot` para `setlivre.com`, `www.setlivre.com` e `ops.setlivre.com`; o plugin Nginx não é instalado. Execute então `sudo /usr/local/sbin/setlivre-enable-tls`. O helper de ativação precisa validar o conjunto SAN exato, validade, owner/modo e `nginx -t`, com restauração transacional do site anterior; o deploy hook root-owned da renovação chama o mesmo helper. `certbot renew --dry-run` e o timer ativo são gates, não documentação substitutiva.

Quando o operador estiver na workstation Windows, faça as verificações públicas com PowerShell/OpenSSH nativos e validação TLS padrão, sem desabilitar certificate ou host-key checking:

```powershell
Resolve-DnsName setlivre.com -Type A
Invoke-WebRequest -Uri "https://setlivre.com/api/health/live" -Method Get

$knownHosts = Join-Path $env:USERPROFILE ".ssh\set-livre-known-hosts"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$knownHosts" "$env:SET_LIVRE_ADMIN_USER@$env:SET_LIVRE_ADMIN_HOST" true
```

Compare previamente a host key por um canal OCI confiável. `SET_LIVRE_ADMIN_USER` e `SET_LIVRE_ADMIN_HOST` são variáveis efêmeras do shell humano, não nomes do workflow ou do Environment GitHub. Os comandos locais apenas verificam a fronteira; provisionamento, owners, modos, firewall, fail2ban, systemd, Nginx e demais hardening continuam sendo executados e auditados na VM Ubuntu. O workflow não usa SSH, e a porta 22 nunca é aberta para o GitHub.

Se qualquer item faltar, mantenha `PRD_DEPLOY_ENABLED=false` tanto no repositório quanto no host e pare sem mutação. O token fine-grained do agente limita-se a `Contents: read` e `Actions: read and write`; `Actions: write` serve somente ao dispatch de regeneração de artefato expirado e não autoriza escrita de conteúdo, configuração ou secrets. Nunca compense uma configuração ausente com `StrictHostKeyChecking=no`, service role no app, reset remoto, deploy in-place ou Docker na VM.

1. gerar em GitHub-hosted Linux x86_64 o archive determinístico e o manifesto schema 4, contendo commit, Node/plataforma/arquitetura, lock hash, hash da configuração pública, migration head e `migrations.mode=expand-only`, sem CLI administrativa, secrets server-side ou mutação;
2. publicar o artifact por action fixada por SHA e vinculá-lo ao SHA/ID esperado;
3. o workflow exige `workflow_run.path=.github/workflows/ci.yaml` e repositórios do run/origem iguais ao atual; o agente pull consulta somente runs concluídos/aprovados do workflow/repositório esperados na branch `main`. A release é identificada pelo SHA upstream comprovado, título, artifact e manifesto; o `head_sha` downstream é apenas proveniência do provedor e pode legitimamente já refletir um merge posterior;
4. conferir IDs de repositório/workflow/run, SHA, digest SHA-256 da API, tamanho e o nome exato `set-livre-<sha>-<archive-sha256>-<public-build-config-sha256>` antes/depois do download;
5. usar o checkpoint root-owned mesmo se o run correspondente já saiu da paginação; ignorar run posterior do SHA já corrente, mas recusar identidade/SHA divergente no mesmo número, replay divergente, run antigo não canônico e downgrade;
6. validar sidecar/archive, manifesto schema 4, `publicBuildConfigSha256` recalculado no host, runtime Linux x86_64, lockfile, head, catálogo SQL somente leitura, contrato semântico N−1/N e ancestralidade; antes de capturar secrets, validar separadamente a CLI Supabase root-owned do host por caminho, owner/modo, versão, ELF x86_64 e hashes fixados;
7. no primeiro deploy, estabelecer a baseline versionada; em todo delta posterior, exigir `-- set-livre:migration-mode=expand-only` como primeira linha e aprovação do guardrail de contrações antes de chamar a CLI Cloud. O parser aceita somente expansões conhecidas, o bloco condicional byte-canônico do helper RLS gerenciado e o hardening readiness exato versionado; qualquer variação, `DO` opaco, `REVOKE` ou `CREATE OR REPLACE` genéricos permanece bloqueada;
8. capturar e persistir o snapshot Cloud anterior de relações, RLS, policies e ACLs efetivas com o catálogo assinado;
9. executar dry-run/push e provar separadamente o head remoto exato `20260819000100`, `session_user=app_runtime_prod`, `current_user=app_dal`, readiness na janela `20260819000100` + `20260815000100` e igualdade exata entre o delta de autorização Cloud e o contrato assinado; adição não aprovada ou autoridade proibida interrompe o deploy;
10. ainda antes da ativação, executar smoke curto do SHA N-1 contra o banco já migrado; se falhar, manter os symlinks e abrir forward fix, sem down migration;
11. criar staging privado recuperável no home de `setlivre-deployer`, sem transferência SSH;
12. comprovar grupo efetivo com apenas `setlivre-deployer` e `sudo -ll` com uma única entrada root, sem `setenv`, para `/usr/local/sbin/setlivre-deploy-dispatch`;
13. chamar via `sudo -n` somente esse dispatcher, que encaminha argumentos válidos ao `/usr/local/sbin/setlivre-release-manager` v3;
14. o manager copia archive/envs para staging root-owned, valida checksum, manifesto schema 4, árvore, runtime, head e configuração pública e conclui esse preflight antes de qualquer migration;
15. executar migrations somente após o preflight root-owned; instalar e sincronizar release/envs imutáveis por SHA usando exatamente os mesmos bytes públicos; persistir `pending`, armar lease/watchdog de 20 minutos e só então trocar/sincronizar os dois symlinks;
16. reiniciar os dois serviços, exigir readiness interno exato e preservar o `previous` real;
17. executar HTTPS smoke:

- home;
- login;
- backoffice restrito;
- rejeição de leitura privada: `GET /api/account/profile` retorna `401 UNAUTHENTICATED` com `requestId` válido;
- rejeição de comando privado: `POST /api/commands` sem sessão retorna `401 UNAUTHENTICATED` antes de consumir body;
- HTTP 80 aceita ACME no caminho dedicado e redireciona `setlivre.com`, `www.setlivre.com` e `ops.setlivre.com` para os hosts HTTPS canônicos;

18. monitorar 15 minutos;
19. somente então executar `confirm <sha>`; confirmar/sincronizar o estado root-owned antes de desarmar o watchdog e remover `pending`;
20. remover staging e valores capturados do ambiente em todo caminho terminal e marcar sucesso.

Recovery de artifact expirado é uma reconstrução verificada, não uma nova release. O agente lê os dois digests exclusivamente do metadata do artifact do run original aprovado e os envia como inputs obrigatórios. O CI recompila o SHA exato e recusa antes do upload se o archive SHA-256 ou o `publicBuildConfigSha256` não forem idênticos. O workflow de publicação repete a prova contra o metadata do run original e contra o handoff reconstruído. Artifact original ausente dos metadados, duplicidade, digest alterado ou configuração pública nova exigem uma release nova em outro SHA; não faça dispatch manual com valores recalculados.

Cleanup de staging é transacional. Antes do primeiro rename, o agente ou manager grava e sincroniza o estado fixo com todos os targets exatos. Se a máquina cair, preserve esse arquivo: a próxima execução encontra o retired path derivado do target registrado, revalida a árvore e conclui a remoção. Não apague `.cleanup-retired-*`, não remova o state e não use glob manual; um path não registrado deve permanecer intocado e ser investigado.

O agente repete todas as superfícies acima, os três redirects, as três exceções ACME e `/api/health/live`/`ready` de web/backoffice por 37 ciclos separados por 25 segundos, sempre exigindo `application` e `release` iguais ao SHA esperado. Em cada novo ciclo, `checkpoint` recupera sob lock um único `pending` após crash/reboot, inclusive quando apenas um dos links `current` mudou, e prova N-1 antes de responder. A unit root-owned de recuperação executa `Before`/`Requires` web, backoffice e Nginx, impedindo exposição de estado pendente durante boot. Falha interna, HTTPS, redirect, interrupção ou ausência de confirmação antes do lease de 20 minutos aciona rollback pelo protocolo restrito, comprova internamente a release anterior e repete seu smoke HTTPS; no primeiro deploy falho, remove a ativação e comprova os dois serviços inativos. Um estado terminal vermelho não autoriza correção direta em `main`: preserve logs redigidos, abra patch/PR, rode todos os reviews/gates e acompanhe a nova execução. Migrations aplicadas continuam no banco e exigem forward fix compatível.

## Rollback de código

1. identificar o SHA anterior preservado pelo protocolo v3 e conferir o checkpoint root-owned confirmado;
2. verificar compatibilidade na janela de schema e o head remoto exato separadamente;
3. executar rollback somente pelo dispatcher/release manager;
4. trocar `current` atomicamente sem perder o `previous` real em retry do mesmo SHA;
5. reiniciar e comprovar health interno da release anterior;
6. repetir smoke público quando houver release anterior;
7. no primeiro deploy, comprovar ausência de symlink ativo e serviços inativos;
8. registrar.

## Migration falhou antes da troca

- abortar;
- não mudar symlink;
- analisar;
- restaurar apenas se houve alteração parcial fora de transação.

## Migration incompatível já aplicada

- não executar down destrutivo;
- implantar forward fix ou compat layer;
- restore somente com decisão de incidente e perda avaliada.

## Pós-release

- [ ] 5xx normal;
- [ ] latência;
- [ ] workers;
- [ ] webhook;
- [ ] outbox;
- [ ] holds;
- [ ] payments;
- [ ] backup agendado;
- [ ] docs context com SHA;
- [ ] limpar releases além da retenção (manter mínimo 3).
