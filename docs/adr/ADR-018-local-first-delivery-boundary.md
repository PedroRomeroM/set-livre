# ADR-018 — Fronteira local-first durante a implementação integral

## Status

Parcialmente substituído pelo ADR-019 em 2026-08-24. A suspensão de CI, Supabase Cloud, Oracle e TLS
terminou; DNS foi autorizado, porém sua ativação foi adiada até o go-live. A fronteira local de testes
destrutivos e a suspensão de providers não aprovados continuam.

## Contexto

O Blueprint, seções 6, 19, 23 e 26, e o ADR-014 descrevem CI/CD, Supabase Cloud e Oracle Cloud como partes da entrega final. Para esta etapa, foi determinado que a implementação avance integralmente em ambiente local, sem configurar CI/CD, Supabase Cloud, Oracle Cloud ou APIs externas.

É uma divergência temporária e deliberada, não uma alteração da arquitetura final.

A restrição de APIs externas também suspende temporariamente três instruções relacionadas ao provider de pagamento: a implementação Pagar.me sandbox de referência no ADR-009, seção “Decisão”; o default de implementação da OPEN-001; e `docs/payments.md`, seção 2, “Fronteira do provider”. A interface `PaymentProvider`, os estados e as invariantes de domínio permanecem normativos; somente SDK, chamada HTTP, credencial, webhook remoto e payload específico de provider ficam adiados.

## Decisão

- desenvolvimento, Auth, banco, Storage e testes destrutivos usam somente Supabase local via Docker;
- todos os gates são executados localmente em cada branch e após cada correção de review;
- CI, Supabase Cloud, Oracle, DNS e TLS ficam suspensos somente até autorização explícita posterior;
- providers externos usam interfaces server-only e adapters locais determinísticos apenas em desenvolvimento/teste;
- o bootstrap Supabase local revoga das roles runtime schema, objetos e funções HTTP de `pg_net`; no Cloud, o ADR-019 mantém a extensão fora da baseline e bloqueia ativação/readiness se qualquer role da aplicação alcançar o schema gerenciado;
- adapters locais nunca são habilitados ou apresentados como integração de produção;
- enquanto este ADR estiver vigente, nenhuma menção a Pagar.me/Asaas sandbox autoriza instalar SDK, chamar endpoint externo, solicitar credencial ou tratar fixture como resposta remota; esses pontos do ADR-009, OPEN-001 e `docs/payments.md` ficam suspensos;
- pendências externas ficam em `pendencias.md`, com critério de desbloqueio e trabalho já concluído;
- o projeto não pode ser declarado pronto para produção enquanto essas pendências permanecerem abertas.

## Alternativas

- Configurar cloud e CI imediatamente: rejeitado por instrução de escopo e dependências externas ainda indisponíveis.
- Omitir contratos externos até o fim: rejeitado porque acoplaria domínio e provider e aumentaria retrabalho.
- Simular integrações como produção: rejeitado por segurança, confiança do usuário e pelos ADRs 009 e 015.

## Consequências

- toda a lógica e UX possíveis podem ser implementadas e verificadas localmente;
- enquanto a suspensão esteve vigente, PRs dependeram de evidência local; o ADR-019 agora exige checks
  automáticos e deploy controlado;
- providers, conteúdo jurídico e observabilidade externa continuam bloqueados por suas próprias
  pendências;
- cenários que citam sandbox comprovam apenas o contrato local determinístico até a integração externa ser liberada e nunca podem ser apresentados como aprovação real do provider;
- PEND-004 precisa ser encerrada com evidência antes de retomar a implementação externa do ADR-009,
  sem alterar a fronteira de domínio.
