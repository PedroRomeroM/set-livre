# ADR-021 — Produção Oracle E2 Micro x86_64

## Status

Aceito em 2026-08-18 por instrução humana explícita.

## Contexto

O ADR-014 definiu a produção em uma VM Oracle Ubuntu com systemd, Nginx e releases imutáveis por SHA. O ADR-019 adotou inicialmente `VM.Standard.A1.Flex`/ARM64 para essa fronteira, mas a única availability domain de `sa-saopaulo-1` respondeu `OUT_OF_HOST_CAPACITY` às combinações Always Free tentadas.

O responsável do produto substituiu explicitamente o alvo A1/ARM64 por `VM.Standard.E2.1.Micro` Always Free x86_64. A tenancy admite duas instâncias E2 Micro elegíveis ao Always Free; uma já existia fora do projeto Set Livre. Quando provisionada, `set-livre-production` usa, portanto, a segunda e última posição E2 Micro Always Free disponível nessa tenancy.

Em 2026-08-18, uma VM diagnóstica `set-livre-production` foi comprovada em estado `RUNNING` em `sa-saopaulo-1`, com shape fixo `VM.Standard.E2.1.Micro`, metadata OCI de 1 OCPU, capacidade efetiva Always Free descrita pelo provedor como 1/8 OCPU burstable, aproximadamente 1 GB de RAM, arquitetura x86_64, Ubuntu 24.04, boot volume de 50 GB e IMDSv2-only. O SSH administrativo por chave foi confirmado. A rede isolada usa VCN `10.20.0.0/16`, subnet regional pública `10.20.1.0/24` e NSG com 22/TCP apenas do IPv4 administrativo `/32`, 80/443 públicos e ICMP para PMTU. Depois de revelar uma falha no bootstrap predecessor, a instância e seu boot volume foram terminados para evitar preservar configuração parcial. Na última evidência OCI preservada, em `2026-08-19T09:45:42Z`, não havia VM Set Livre ativa e o Plan E2 encerrou fail-closed com `OUT_OF_HOST_CAPACITY`.

Esses fatos não comprovam hardening, instalação do runtime, Nginx/systemd ativos, agente de deploy, release, migrations Cloud, TLS, DNS ou go-live.

## Decisão

- este ADR substitui somente o shape e a arquitetura de produção definidos nos ADRs 014 e 019: o alvo passa a ser `VM.Standard.E2.1.Micro` x86_64, com a metadata fixa exposta pela OCI e aproximadamente 1 GB de RAM; não se apresenta a metadata de 1 OCPU como capacidade dedicada, pois o contrato Always Free publicado descreve 1/8 OCPU burstable;
- o sistema operacional permanece Ubuntu 24.04; Nginx, processos Node sem root geridos por systemd, agente pull outbound-only, dispatcher root-owned allowlisted e releases imutáveis por SHA permanecem obrigatórios;
- produção continua sem Docker, Docker Compose, Caddy, registry de imagem, runner GitHub self-hosted ou SSH de deploy;
- build/package de produção deve ocorrer em Linux x86_64 GitHub-hosted, gerar artefato e dependências nativas compatíveis com x86_64 e registrar `platform`/`arch` no manifesto; build Windows continua não canônico;
- o boot volume permanece em 50 GB e a instância permanece IMDSv2-only;
- a topologia de rede permanece isolada no VCN/subnet do Set Livre. A porta 22 continua restrita ao `/32` administrativo; 80/443 podem ser públicos; portas de aplicação permanecem em loopback; ICMP PMTU permanece permitido. O host é deliberadamente IPv4-only: IPv6 é desativado por sysctl persistente, Nginx/SSH não escutam IPv6 e as units aceitam somente `AF_INET`/`AF_UNIX`;
- o host Ubuntu OCI usa `iptables` persistido por `netfilter-persistent`, com cadeia Set Livre própria e sem flush. UFW é removido porque não é a ferramenta suportada para preservar as regras essenciais de iSCSI da imagem; o bootstrap compara essas regras antes/depois e falha fechado diante de qualquer divergência;
- a VM de aproximadamente 1 GB exige orçamento explícito de memória, monitoramento de OOM/pressão de memória e smoke de carga antes do go-live. O contrato em fonte limita web/backoffice/agente a, respectivamente, `240/160/192 MiB` de `MemoryMax` (`592 MiB` agregados), preserva no mínimo `320 MiB` físicos para Ubuntu/Nginx, usa `MemoryHigh`, heaps Node menores, `MemorySwapMax` e `OOMPolicy=kill`; esses limites e o swap só podem ser apresentados como ativos depois de instalados e consultados novamente no systemd;
- quando ativa, a instância Set Livre consome a segunda e última posição E2 Micro Always Free da tenancy. Na última evidência preservada (`2026-08-19T09:45:42Z`), a posição lógica estava liberada e o Plan E2 reportava falta de capacidade física. Escala horizontal, substituição paralela ou outro host gratuito não podem ser presumidos; qualquer shape pago exige nova decisão humana e evidência de custo;
- `PRD_DEPLOY_ENABLED` permanece `false` até uma VM ativa, hardening, agente, secrets exclusivos do host, migrations Cloud, smoke, rollback, DNS e TLS serem comprovados. O antigo estado `RUNNING` e a prova histórica de SSH não equivalem a deploy.

## Alternativas

- aguardar indefinidamente capacidade A1/ARM64: rejeitado por decisão humana explícita após os relatórios de falta de capacidade;
- usar shape pago ou maior: rejeitado sem nova aprovação humana e comprovação de custo;
- executar containers em produção: rejeitado; não altera a decisão dos ADRs 014 e 019;
- reutilizar VM ou rede de outro projeto: rejeitado por isolamento, blast radius e auditoria.

## Consequências

- claims vivos de A1/ARM64 nos ADRs 014, 019 e 020 e nos documentos operacionais passam a ser lidos como substituídos por este ADR; evidências históricas explicitamente datadas permanecem válidas apenas para seus snapshots;
- pipeline, manifesto, verificações do agente e smoke de produção precisam validar Linux x86_64; a CLI Supabase fica fora do artifact e é instalada/verificada como ferramenta root-owned do host;
- a baixa memória aumenta o risco de OOM e disputa entre web/backoffice; budgets, observabilidade, carga e rollback são gates de go-live;
- a VM continua sendo ponto único de falha, agora sem outra posição E2 Micro Always Free disponível na tenancy; backup, restore drill e plano de substituição são obrigatórios;
- a VM diagnóstica e seu boot volume foram terminados; hardening, deploy, TLS, DNS e URL pública da plataforma continuam pendentes e não podem ser inferidos deste ADR. O reprovisionamento aguarda capacidade `AVAILABLE` no Plan canônico.
