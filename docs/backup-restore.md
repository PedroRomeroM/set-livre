# Backup, restore e continuidade

## Baseline atual

O Supabase Cloud é a fonte canônica de banco, Auth e Storage. O projeto ainda não possui usuários ou
dados comerciais; o primeiro deploy já comprovou migrations e segurança, enquanto backup/restore
permanecem gates do go-live. Não se cria antecipadamente um serviço próprio de backup.

- código, migrations, Nginx e units estão no Git;
- secrets permanecem nos cofres que os consomem, nunca no backup do repositório;
- a VM não guarda dados canônicos e pode ser reconstruída por bootstrap + release aprovada;
- status, retenção e recursos de backup gerenciado do plano Supabase devem ser confirmados antes do
  go-live comercial.

`pg_dump` periódico ou réplica em OCI Object Storage só será adotado se a retenção/independência
exigida não for atendida pelo provider ou se houver requisito regulatório aprovado. Não se mantém um
pipeline sem dado real apenas para antecipar essa possibilidade.

## Gates antes do go-live

1. aprovar RPO, RTO e retenção conforme volume, receita e obrigações legais;
2. comprovar backup/PITR disponível no plano contratado;
3. restaurar em projeto isolado e executar migrations, RLS, read models e smoke;
4. definir inventário e recuperação de objetos do Storage quando mídia real existir;
5. registrar duração, lacunas e ação corretiva do ensaio.

Nunca se ensaia restore sobre produção. Mudança destrutiva futura exige backup atual e restore
comprovado antes da migration.

## Recuperação da VM

1. provisionar o shape aprovado, reassociar o IPv4 reservado e confirmar que NSG e subnet expõem
   somente `22`, `80` e `443`;
2. pela Console/Serial Console autenticada da OCI, executar
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256` e
   `awk '{print "147.15.97.227 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub`; comparar o fingerprint
   fora da conexão SSH e só então substituir `PRD_VM_SSH_HOST_KEY` no GitHub. `ssh-keyscan` isolado não
   autentica uma chave nova;
3. executar o bootstrap versionado com a chave pública do deployer. Sem certificado, o estado esperado
   é Nginx em HTTP fail-closed servindo apenas `/.well-known/acme-challenge/`;
4. emitir o certificado público antes de qualquer release:

   ```bash
   sudo /snap/bin/certbot certonly \
     --preferred-profile shortlived \
     --webroot \
     --webroot-path /var/www/set-livre-acme \
     --ip-address 147.15.97.227 \
     --non-interactive \
     --agree-tos \
     --email <email-operacional>
   sudo openssl x509 -checkend 86400 -noout \
     -in /etc/letsencrypt/live/147.15.97.227/fullchain.pem
   sudo openssl x509 -noout -ext subjectAltName \
     -in /etc/letsencrypt/live/147.15.97.227/fullchain.pem \
     | grep --fixed-strings 'IP Address:147.15.97.227'
   ```

5. reexecutar o mesmo bootstrap para que ele valide SAN/validade, ative o template TLS e instale o hook
   de renovação; confirmar `sudo nginx -t` e executar, sem `-k`,
   `curl --fail --show-error https://147.15.97.227/robots.txt`;
6. confirmar as variáveis e secrets do environment `production`; abrir **Actions → CI and production
   delivery → Run workflow**, selecionar `main`, marcar `deploy_production`, copiar o SHA completo atual
   de `main` para `release_sha` e executar. O workflow só publica quando input, `github.sha`, branch,
   flag de deploy e gates completos convergem; validar então os dois readiness internos, o HTTPS público
   e o SHA em `current`;
7. reapontar DNS somente quando houver uma mudança de go-live aprovada. Na fase atual o domínio continua
   deliberadamente sem apontamento.

Essa ordem é obrigatória: o workflow usa `StrictHostKeyChecking=yes`, e o instalador exige readiness
HTTPS durante a ativação. Publicar antes de renovar a confiança SSH ou antes da primeira emissão TLS
falha fechado; nunca se contorna nenhuma dessas verificações.

Perda da VM não pode causar perda de domínio. Logs locais que precisem sobreviver ao host exigirão um
destino externo aprovado antes do go-live.
