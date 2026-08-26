# Backup, restore e continuidade

## Baseline atual

O Supabase Cloud é a fonte canônica de banco, Auth e Storage. O projeto ainda não possui usuários ou
dados comerciais; por isso o primeiro deploy comprova migrations e segurança, enquanto backup/restore
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

1. provisionar o shape aprovado ou substituto explicitamente aceito;
2. executar o bootstrap versionado e restaurar os envs pelo cofre;
3. publicar novamente um SHA aprovado;
4. reapontar DNS se o IP mudar;
5. validar readiness interno e HTTPS público.

Perda da VM não pode causar perda de domínio. Logs locais que precisem sobreviver ao host exigirão um
destino externo aprovado antes do go-live.
