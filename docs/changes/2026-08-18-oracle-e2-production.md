# Oracle E2 Micro como alvo de produção

## Estado

Infraestrutura parcialmente comprovada. A VM diagnóstica chegou a aceitar SSH, mas foi terminada com o boot volume para eliminar a configuração parcial. Na última evidência OCI preservada (`2026-08-19T09:45:42Z`), não havia VM Set Livre ativa e o Plan E2 encerrou fail-closed com `OUT_OF_HOST_CAPACITY`. Hardening, runtime, agente, deploy, TLS e DNS permanecem pendentes.

## Motivação

As tentativas anteriores de obter `VM.Standard.A1.Flex` Always Free em `sa-saopaulo-1` retornaram `OUT_OF_HOST_CAPACITY`. Em 2026-08-18, o responsável do produto aprovou explicitamente a substituição do alvo A1/ARM64 por `VM.Standard.E2.1.Micro` Always Free x86_64.

## Decisão registrada

- o novo ADR-021 substitui somente shape e arquitetura dos ADRs 014 e 019;
- permanecem Ubuntu 24.04, Nginx, systemd, processos sem root, agente pull outbound-only, dispatcher root-owned, release imutável por SHA e ausência de Docker em produção;
- build/package e validações de runtime passam a exigir Linux x86_64;
- a seleção da imagem interpreta a omissão de `listing-type` das imagens oficiais da plataforma como o valor padrão documentado `NONE`, mas rejeita `COMMUNITY` e valores desconhecidos; nome canônico, Ubuntu 24.04, estado disponível e compatibilidade com `VM.Standard.E2.1.Micro` continuam obrigatórios;
- o host não usa UFW, incompatível com as regras essenciais das imagens Ubuntu OCI; o bootstrap adiciona uma cadeia `iptables` dedicada sem flush, persiste-a com `netfilter-persistent` e exige que as regras Oracle de iSCSI permaneçam idênticas antes/depois;
- o contrato de host é IPv4-only: desativa IPv6 persistentemente, remove listeners Nginx IPv6, fixa `AddressFamily inet` no SSH e restringe as units a `AF_INET`/`AF_UNIX`;
- o orçamento E2 Micro fixa `MemoryMax` de `240 MiB` para web, `160 MiB` para backoffice e `192 MiB` para o agente, reserva ao menos `320 MiB` físicos ao host e verifica `MemoryHigh`, `MemoryMax`, `MemorySwapMax` e `OOMPolicy` instalados. O smoke limita cada JSON a 16 KiB e interrompe a leitura incremental antes de alocar resposta excedente;
- evidências históricas A1/ARM64 explicitamente datadas não são reescritas como se tivessem ocorrido no alvo E2.

## Evidência atual

- região: `sa-saopaulo-1`;
- instância: `set-livre-production`;
- lifecycle histórico comprovado em `2026-08-18`: `RUNNING`, seguido de término deliberado com o boot volume; na última evidência preservada (`2026-08-19T09:45:42Z`), não havia VM Set Livre ativa;
- shape: `VM.Standard.E2.1.Micro`, fixo em 1 OCPU e aproximadamente 1 GB de RAM;
- arquitetura e sistema: x86_64, Ubuntu 24.04;
- boot volume: 50 GB;
- metadata service: IMDSv2-only;
- rede exclusiva: VCN `10.20.0.0/16`, subnet regional pública `10.20.1.0/24`;
- NSG: 22/TCP somente do IPv4 administrativo `/32`, 80/443 públicos e ICMP PMTU;
- SSH administrativo por chave: confirmado;
- limite da tenancy: duas E2 Micro Always Free; outra instância já existe fora do projeto. A posição Set Livre foi liberada ao terminar a instância diagnóstica, mas o último Plan E2 preservado reporta `OUT_OF_HOST_CAPACITY` para a nova alocação.

## Reconciliação documental

- claims vivos usam exclusivamente `VM.Standard.E2.1.Micro` Always Free, Ubuntu 24.04 e Linux x86_64;
- A1/ARM64 permanece somente como evidência histórica explicitamente datada e anterior ao ADR-021;
- o Docker Desktop Windows está configurado com o port binding oficial `Localhost only`, e os quatro listeners Supabase foram comprovados somente em `127.0.0.1`; a cadeia limpa atual possui 16 migrations, predecessor `20260815000100` e head `20260819000100`, e o pgTAP passou em 4 arquivos/361 testes, com readiness de 17 dependências ACL e 16 rotinas DAL;
- o catálogo documental atual contém 200 cenários;
- o host fixa `GITHUB_REPOSITORY_ID=1328339374` e exige IDs positivos e distintos para CI/PRD, obtidos canonicamente por path após registro no GitHub; deploy permanece desligado até preenchimento e `verify`;
- a sandbox systemd do agente limita escrita a `/var/lib/setlivre-deployer/.setlivre`, `/opt/setlivre` e `/run/lock`, sem escrita ampla em `/run`;
- a auditoria precommit independente eliminou a igualdade incorreta entre SHA da release e `head_sha` do workflow downstream; merges sobrepostos preservam o SHA upstream no título/artifact/manifesto e mantêm o SHA downstream apenas como proveniência do provedor;
- a migration de hardening recebeu o marcador incremental; o helper RLS gerenciado é tratado por um único bloco condicional byte-canônico porque ele não existe em todas as imagens Supabase locais. O agente admite somente esse bloco, o `REVOKE`/regrant exato de `private.check_readiness` e sua substituição compatível; qualquer variação ou forma genérica continua fail-closed;
- conforme o ADR-022 e o princípio de excelência confirmado pelo responsável do produto, somente soluções canônicas e suportadas são aceitas: nenhuma suppression, bypass, fallback silencioso, downgrade oportunista ou edição manual de artefato gerado pode sustentar claim de sucesso.

OCIDs, IPv4 público, chave e demais dados operacionais privados não são registrados no Git.

## Limites da evidência

Não há claim de VM ativa, hardening concluído, Nginx/systemd ativos, usuários operacionais, agente pull instalado, secrets no host, projeto Supabase de São Paulo criado, migrations Supabase Cloud aplicadas, PR, merge, artifact de produção, deploy, smoke público, rollback, backup, TLS, DNS ou URL pública. O projeto Supabase canadense não é produção. `PRD_DEPLOY_ENABLED` permanece `false` até essas provas.

## Próximos gates

1. validar integralmente scripts, workflow, manifesto e testes para Linux x86_64;
2. executar bootstrap/hardening e provar `iptables-persistent`/NSG com regras essenciais OCI intactas, SSH, usuários, systemd, Nginx, limites de memória, logs e ausência de Docker;
3. instalar/verificar agente, dispatcher, sudoers e configuração privada do host;
4. comprovar backup/restore, carga dentro do envelope de aproximadamente 1 GB e rollback;
5. somente depois executar migrations/deploy pelo fluxo aprovado, configurar DNS/TLS e validar a URL pública.
