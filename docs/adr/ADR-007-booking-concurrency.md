# ADR-007 — Concorrência de reserva no banco

## Status
Aceito.

## Contexto
Dois usuários podem iniciar pagamento para o mesmo estúdio e período. O frontend, cache e gateway não garantem exclusão mútua.

## Decisão
Usar `calendar_allocations` com `tstzrange` e constraint de exclusão GiST por estúdio para períodos ativos.

O fluxo:

1. gerar cotação autoritativa;
2. iniciar pagamento no provider;
3. após confirmação de início, executar comando transacional de hold;
4. liberar holds expirados do estúdio;
5. inserir alocação com período bloqueado incluindo buffer;
6. se houver conflito, cancelar/invalidar a tentativa no provider;
7. webhook pago converte hold em reserva de forma idempotente;
8. job expira holds.

Advisory lock por estúdio pode reduzir contenção, mas a constraint é a defesa final.

## Alternativas
- flag no frontend: rejeitada.
- unique por slot: rejeitada porque buffer e intervalos são melhor representados por range.
- lock distribuído externo: rejeitado antes de necessidade comprovada.

## Consequências
- exige extensão `btree_gist`;
- testes concorrentes são P0;
- hold expirado deve ser limpo antes de nova inserção e por job.
