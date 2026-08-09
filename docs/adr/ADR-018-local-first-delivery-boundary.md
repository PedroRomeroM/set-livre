# ADR-018 — Fronteira local-first durante a implementação integral

## Status

Aceito em 2026-08-09 por instrução humana explícita.

## Contexto

O Blueprint, seções 6, 19, 23 e 26, e o ADR-014 descrevem CI/CD, Supabase Cloud e Oracle Cloud como partes da entrega final. Para esta etapa, foi determinado que a implementação avance integralmente em ambiente local, sem configurar CI/CD, Supabase Cloud, Oracle Cloud ou APIs externas.

É uma divergência temporária e deliberada, não uma alteração da arquitetura final.

A restrição de APIs externas também suspende temporariamente três instruções relacionadas ao provider de pagamento: a implementação Pagar.me sandbox de referência no ADR-009, seção “Decisão”; o default de implementação da OPEN-001; e `docs/payments.md`, seção 2, “Fronteira do provider”. A interface `PaymentProvider`, os estados e as invariantes de domínio permanecem normativos; somente SDK, chamada HTTP, credencial, webhook remoto e payload específico de provider ficam adiados.

## Decisão

- desenvolvimento, Auth, banco, Storage e testes destrutivos usam somente Supabase local via Docker;
- todos os gates são executados localmente em cada branch e após cada correção de review;
- nenhum workflow em `.github/workflows`, projeto Supabase remoto, recurso Oracle, DNS, TLS ou secret cloud será criado nesta etapa;
- providers externos usam interfaces server-only e adapters locais determinísticos apenas em desenvolvimento/teste;
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
- PRs não terão checks automáticos nesta fase, portanto a evidência local completa é obrigatória;
- go-live, smoke HTTPS, backup cloud e validação de providers permanecem bloqueados;
- cenários que citam sandbox comprovam apenas o contrato local determinístico até a integração externa ser liberada e nunca podem ser apresentados como aprovação real do provider;
- ao liberar as ações externas, este ADR deve ser revisado, PEND-004 deve ser encerrada com evidência e a implementação de referência do ADR-009 pode ser retomada sem alterar a fronteira de domínio.
