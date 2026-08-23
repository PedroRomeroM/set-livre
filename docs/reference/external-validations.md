# Validações externas de capacidade — não substituem o Blueprint

Data da última verificação: 2026-08-19.

Estas referências confirmam capacidades de fornecedores. Elas não alteram a cadeia de decisões arquiteturais.

## Oracle Cloud

A documentação oficial consultada informa:

- existência de recursos Always Free na home region da tenancy;
- até duas instâncias Always Free no shape AMD `VM.Standard.E2.1.Micro`;
- 1 GB de memória, capacidade burstable descrita como 1/8 OCPU com uso adicional e uma VNIC/IP público dentro do contrato do shape;
- imagens Ubuntu marcadas como Always Free Eligible e boot volume mínimo de 47 GB;
- Object Storage Always Free dentro das cotas publicadas pelo provedor.

O alvo vivo do Set Livre é exclusivamente `VM.Standard.E2.1.Micro`, Ubuntu 24.04 x86_64 e boot de 50 GB. A capacidade física continua sendo consultada imediatamente antes da criação; a documentação da Oracle trata `OUT_OF_HOST_CAPACITY` como indisponibilidade temporária e isso não autoriza fallback de shape, região ou custo.

Disponibilidade depende da tenancy e região; não é garantia de capacidade.

## Next.js

Documentação oficial confirma:

- Next.js 16;
- `output: "standalone"` para artefato mínimo de produção.

## Supabase

Documentação oficial confirma:

- Auth, Postgres, Storage e RLS;
- funções `security definer` devem permanecer fora de schemas expostos e usar search path seguro;
- backup de banco não inclui objetos do Storage;
- CLI permite backup/restore;
- transformações de imagem e quotas têm custo/limite por plano.

## Gateways

Documentação oficial consultada confirma que Pagar.me e Asaas possuem recursos relacionados a cartão, PIX, split, recebedores/subcontas, webhooks e reembolso. A capacidade comercial efetiva depende de contrato e onboarding.

## GitHub Actions

No snapshot de consulta de 2026-08-09, a documentação oficial confirmava suporte a runners ARM64. Essa evidência histórica não define mais o alvo vivo: após o ADR-021, build/package e produção exigem Linux x86_64, sem runner de release compartilhado com código não confiável.

Na validação de 2026-08-19, a documentação oficial de
[reexecução de workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
confirmou que um rerun conserva `GITHUB_SHA` e `GITHUB_REF` e incrementa o attempt. A documentação do
[evento `workflow_run`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
confirma a atividade `completed` e esclarece que somente `requested` deixa de ocorrer em rerun. Esse
é o fundamento externo do bootstrap canônico da primeira entrega, sem commit vazio. A mesma tabela
define `GITHUB_SHA` desse workflow downstream como o último commit do branch padrão; por isso o SHA
downstream é apenas proveniência do provedor e a release continua identificada pelo run upstream,
título canônico, artifact e manifesto.
