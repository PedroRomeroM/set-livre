# Validações externas de capacidade — não substituem o Blueprint

Data de verificação: 2026-08-09.

Estas referências confirmam capacidades de fornecedores. Elas não alteram a cadeia de decisões arquiteturais.

## Oracle Cloud

A documentação oficial consultada informa:

- existência de recursos Always Free;
- shape `VM.Standard.A1.Flex` elegível;
- referência equivalente de 2 OCPUs/12 GB dentro das horas gratuitas;
- Object Storage Always Free total de 20 GB.

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

Documentação oficial confirma suporte a runners ARM64. O pipeline deve escolher runner compatível com o plano/repositório e não compartilhar runner de release com código não confiável.
