# ADR-021 — Produção Oracle E2 Micro x86_64

## Status

Aceito em 2026-08-24, consolidando a escolha humana explícita de `VM.Standard.E2.1.Micro`.

## Contexto

O ADR-014 adotou Oracle, systemd, Nginx e releases por SHA, originalmente sobre ARM64. A capacidade
ARM não estava disponível de forma útil e o responsável escolheu a alternativa x86_64 também marcada
pela Oracle como Always Free-eligible. A instância dedicada já existe em São Paulo com Ubuntu 24.04 e
boot volume de 50 GB.

## Decisão

- o alvo exato é `VM.Standard.E2.1.Micro` Always Free-eligible, x86_64, Ubuntu 24.04 e 50 GB;
- a produção usa um IPv4 público reservado regional, reassociável em caso de substituição da VM;
- produção não usa Docker, runner self-hosted ou build na própria VM;
- GitHub Actions produz o standalone Linux x86_64;
- Nginx expõe somente 80/443; aplicações escutam em loopback e rodam sem root por systemd;
- antes do go-live, somente o web é exposto por HTTPS no IPv4 reservado, com `noindex`; DNS e a
  exposição do backoffice ficam adiados para uma mudança própria;
- administração e deploy usam contas SSH separadas, somente por chave Ed25519; a conta de deploy possui
  comando SSH forçado, um único comando sudo allowlisted e o fluxo normal não depende de login OCI;
- OCI Bastion é opcional para emergência e não participa do pipeline;
- releases ficam em `/opt/set-livre/releases/<sha>`, são ativadas por symlink atômico e limitadas a
  quatro versões preservando a atual e a anterior;
- o host mantém configuração simples de memória/swap compatível com aproximadamente 1 GB e monitora
  OOM; limites serão ajustados por medição, não por uma matriz antecipada de estados;
- a VM é ponto único de falha aceito nesta fase; backup, restore e rollback são gates de go-live.

## Alternativas

- aguardar ARM indefinidamente: rejeitado pela decisão humana;
- usar shape pago: exige nova autorização de custo;
- SSH por senha, root ou sudo geral: rejeitado; SSH público por chave, limitado por NSG, iptables
  persistente, Fail2ban e conta dedicada, foi escolhido por ser suportado e operacionalmente
  proporcional;
- UFW: rejeitado nesta imagem porque pode remover regras `InstanceServices` necessárias à infraestrutura
  Oracle, conforme o
  [registro oficial de known issues](https://docs.oracle.com/en-us/iaas/Content/Compute/known-issues.htm);
  a cadeia própria de entrada preserva e verifica essas regras antes de persistir o estado;
- IP público efêmero: rejeitado porque é excluído com a VNIC e não pode ser reassociado durante uma
  recuperação; a
  [semântica oficial dos dois tipos](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm)
  sustenta a escolha do IP reservado;
- construir na VM: rejeitado por consumo de memória e falta de isolamento.
- servir HTTP por IP: rejeitado porque sessão, cookies e validação de origem exigem HTTPS; o certificado
  curto de IP da Let's Encrypt é renovado pelo Certbot oficial.

## Consequências

- todos os documentos e artifacts passam a declarar Linux x86_64;
- a baixa memória exige serviços enxutos e impede adicionar daemons sem necessidade medida;
- OCI CLI é necessária para mudanças de infraestrutura e sessões administrativas, não para cada merge.
