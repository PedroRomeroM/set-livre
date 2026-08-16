# Runbook de release e rollback

## Pré-release

- [ ] main verde;
- [ ] changelog;
- [ ] migration revisada;
- [ ] compatibilidade com previous;
- [ ] backup recente;
- [ ] provider sandbox/contracts;
- [ ] artifact ARM64;
- [ ] checksum;
- [ ] release notes;
- [ ] aprovação.

Na release canônica local, a geração exige um `.env.local` físico, regular, exclusivo e `0600` para cada aplicação. A identidade e o modo precisam permanecer estáveis entre caminho e descritor durante a leitura; arquivo ausente, link ou permissão ampla aborta antes do build. O smoke local do artefato usa exclusivamente a URL DAL desse arquivo. A URL precisa apontar para a instância Supabase no host IPv4 literal `127.0.0.1:54322`, com `app_runtime_local` assumindo `app_dal`; uma variável homônima exportada no host não tem precedência e uma URL local inválida aborta antes de iniciar os servidores empacotados. O ADR-019 não transforma esse artefato x64/local em produção: o workflow produz separadamente o bundle ARM64 com origens públicas aprovadas e injeta secrets somente no runtime da VM.

A release local exige Linux com GNU tar e `util-linux flock`. O lock exclusivo cobre build, `releaseRoot`, smoke, candidatos `.incoming`, verificação e publicação; invocações simultâneas esperam em vez de compartilhar temporários. Não remova `.artifacts/release.lock`: o arquivo permanece, sem lock ativo, para que todas as invocações usem o mesmo inode. Confirme os requisitos com `tar --version` e `flock --version`; ausência de `flock` interrompe o comando antes do build.

Antes de executar a release, confirme que `.artifacts` não é mount e não contém volume, bind mount ou cache montado nos caminhos gerados. O script comprova isso pelo `/proc/self/mountinfo` do namespace Linux atual antes de alterar permissões ou iniciar o build, e repete a prova em cada árvore antes e depois do retiro por rename atômico. Se `mountinfo` não puder ser lido/interpretado, se um mount for encontrado ou se a identidade física mudar, a execução aborta sem atravessar a árvore; inspecione e desmonte manualmente o caminho antes de repetir. Nunca remova `.artifacts` recursivamente para contornar esse erro. A prova assume que nenhum principal privilegiado altera mounts ou arquivos concorrentemente.

O tar normaliza modos independentemente do `umask`: diretórios e arquivos executáveis são `0755`; arquivos regulares não executáveis são `0644`; bits especiais `setuid`, `setgid` e `sticky` são removidos. Rebuild do mesmo SHA precisa reproduzir checksum idêntico.

O smoke registra `SIGHUP`, `SIGINT` e `SIGTERM` antes de iniciar qualquer servidor. Se a sessão de terminal/SSH encerrar, `SIGHUP` limpa os dois grupos de processo detached — inclusive descendentes após a saída do líder — e a release termina com código `129`; confirme que as portas temporárias foram liberadas antes de repetir.

## Deploy

### Preflight cloud obrigatório

1. workflow `CI` verde no SHA incorporado a `main`;
2. approval humano do environment `production`;
3. projeto Supabase/ref e URLs iguais aos valores canônicos;
4. `supabase db push --dry-run --include-all` revisado;
5. login DAL Cloud restrito com `private.check_runtime_readiness(session_user)=true`;
6. runner/artefato nativo ARM64 e `BUILD_ID` dos dois apps iguais ao SHA;
7. VM, host key, usuário de deploy, disco e serviços comprovados;
8. backup recente/restaurável e compatibilidade da release anterior;
9. DNS/TLS e `/32` administrativo sem drift;
10. nenhum secret em build, archive ou log.

Se qualquer item faltar, mantenha `PRD_DEPLOY_ENABLED=false` e pare sem mutação. Nunca compense uma configuração ausente com `StrictHostKeyChecking=no`, service role no app, reset remoto, deploy in-place ou Docker na VM.

1. verificar capacidade/disco;
2. upload do artifact;
3. checksum;
4. extrair `<sha>`;
5. validar manifest;
6. aplicar migration;
7. smoke direto no server local em porta temporária, se possível;
8. apontar symlink;
9. restart;
10. ready;
11. HTTPS smoke:

- home;
- listagem;
- login;
- backoffice restrito;
- command auth rejection;

12. monitorar 15 minutos;
13. marcar sucesso.

O workflow atual monitora liveness/readiness público após a troca. Um estado terminal vermelho não autoriza correção direta em `main`: preserve logs redigidos, restaure a aplicação anterior quando seguro, abra patch/PR, rode todos os reviews/gates e acompanhe a nova execução. Migrations aplicadas continuam no banco e exigem forward fix compatível.

## Rollback de código

1. identificar SHA anterior;
2. verificar compatibilidade de schema;
3. trocar symlink;
4. restart;
5. health;
6. smoke;
7. registrar.

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
