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

Enquanto o ADR-018 estiver vigente, o smoke local do artefato usa exclusivamente a URL DAL do `.env.local` de cada aplicação. A URL precisa apontar para a instância Supabase em loopback `:54322` com `app_runtime_local` assumindo `app_dal`; uma variável homônima exportada no host não tem precedência e uma URL local inválida aborta antes de iniciar os servidores empacotados.

A release local exige Linux com GNU tar e `util-linux flock`. O lock exclusivo cobre build, `releaseRoot`, smoke, candidatos `.incoming`, verificação e publicação; invocações simultâneas esperam em vez de compartilhar temporários. Não remova `.artifacts/release.lock`: o arquivo permanece, sem lock ativo, para que todas as invocações usem o mesmo inode. Confirme os requisitos com `tar --version` e `flock --version`; ausência de `flock` interrompe o comando antes do build.

O tar normaliza modos independentemente do `umask`: diretórios e arquivos executáveis são `0755`; arquivos regulares não executáveis são `0644`; bits especiais `setuid`, `setgid` e `sticky` são removidos. Rebuild do mesmo SHA precisa reproduzir checksum idêntico.

## Deploy

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
