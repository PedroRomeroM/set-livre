# ADR-019 — Entrega cloud controlada para Set Livre

## Status

Aceito em 2026-08-16 por instrução humana explícita.

## Contexto

O Blueprint, seções 6, 19, 23, 24 e 26, e o ADR-014 exigem CI, Supabase Cloud e uma VM Oracle ARM64 com release imutável. O ADR-018 suspendeu temporariamente essas ações durante a fundação local-first. O responsável do produto criou o projeto Supabase `set-livre`, ref `klzxatkgiiznymzuzadd`, adquiriu `setlivre.com` e autorizou a implantação da fronteira de entrega cloud.

A autorização não elimina os contratos locais: banco, Auth e testes destrutivos continuam no Supabase local; credenciais cloud não entram em PRs; produção não usa Docker; migrations aplicadas continuam append-only. Também não autoriza provider de pagamento, SMTP, observabilidade externa ou qualquer integração ainda suspensa pelo ADR-018.

## Decisão

- este ADR substitui somente a proibição temporária do ADR-018 sobre `.github/workflows`, Supabase Cloud, Oracle Cloud, DNS, TLS e secrets de deploy;
- a suspensão de APIs/providers externos do ADR-018 permanece vigente até decisão própria;
- `.github/workflows/ci.yaml` executa os gates normativos em runner efêmero Ubuntu, Node `24.18.0`, npm `11.19.0`, PostgreSQL client `18.4`, Docker e Supabase local isolado; PR não recebe secret de produção;
- o workflow de produção só é elegível após CI verde no `push` de `main`, SHA exato, repositório de origem igual, environment GitHub `production` e flag explícita `PRD_DEPLOY_ENABLED=true`;
- produção usa o projeto Supabase de ref exata `klzxatkgiiznymzuzadd`; o pipeline aceita somente migrations versionadas com `supabase db push`, primeiro em `--dry-run`, e nunca executa `db reset`, seed ou `config push` remoto;
- configurações Auth, redirects, SMTP, captcha, Storage e secrets do projeto são ações humanas auditáveis; `supabase/config.toml` permanece local e não é enviado ao Cloud;
- o runtime conecta ao banco somente por login restrito capaz de assumir `app_dal`; o deploy prova `private.check_runtime_readiness(session_user)` antes de tocar a VM;
- a release é construída nativamente em ARM64, contém os standalones web/backoffice e migrations, é identificada pelo SHA completo e transferida por SSH com host key fixada;
- a VM segue o ADR-014: Ubuntu LTS ARM64, Nginx, systemd, processos sem root, `/opt/setlivre/releases/<sha>`, troca atômica de `current`, health checks e rollback da aplicação;
- nenhuma VM ou rede é criada sem prova read-only de home region, compartment, AD, quota, shape, imagem, VCN/subnet, chave SSH e elegibilidade Always Free; nomes ou redes de outros projetos nunca são reutilizados por conveniência;
- DNS e TLS só avançam depois de IP reservado/estável, firewall/NSG mínimo e origem inequívoca; renovação TLS é responsabilidade operacional do host, não uma reparação destrutiva em cada deploy;
- secrets ficam em GitHub Environments, arquivos `0600` ou `0640` root-owned no host; não entram em argumento público, bundle, artifact, log, screenshot ou documento;
- o agente acompanha os jobs de cada merge até estado terminal e corrige falhas por novo patch/PR; workflow não recebe permissão para alterar código ou contornar review automaticamente.

## Alternativas

- continuar somente local: rejeitado para a fronteira de infraestrutura porque o responsável liberou os recursos e pediu deploy pós-merge;
- reutilizar VCN/compartment de Spenses ou de outro projeto: rejeitado por isolamento, blast radius e auditoria;
- executar Docker Compose em produção: rejeitado pelo Blueprint e ADR-014;
- aplicar `schema.generated.sql` ou reset remoto: rejeitado porque migrations são a história canônica e produção é forward-only;
- fazer deploy direto no fechamento de qualquer PR: rejeitado porque não prova CI do SHA já incorporado a `main`;
- armazenar service role ou credencial administrativa no runtime: rejeitado pelos ADRs 005 e 014.

## Consequências

- CI e deploy passam a existir como código, mas ficam fail-closed até os itens humanos de `configuration-seteps.md` e o primeiro run real serem comprovados;
- o build/deploy ARM64 depende da disponibilidade do label GitHub adotado ou de runner ARM64 equivalente aprovado;
- migrations podem permanecer após rollback do app; por isso toda mudança de schema de release precisa ser expand/migrate/contract e compatível com a release anterior;
- uma VM continua sendo ponto único de falha; backup, restore drill, monitoramento e patching são obrigatórios antes do go-live;
- a capacidade Oracle A1 e a condição Always Free são fatos de conta/região e precisam ser revalidados imediatamente antes do launch;
- ADR-018 continua normativo para pagamentos e demais APIs externas não liberadas.
