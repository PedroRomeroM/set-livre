# ADR-004 — Pipeline central de comandos críticos

## Status
Aceito.

## Contexto
Reservas, calendário, revisão editorial e pagamento exigem autenticação, validação, log, atomicidade e idempotência consistentes.

## Decisão
Toda escrita crítica usa `POST /api/commands`:

1. validar método, content type, tamanho e origem;
2. validar sessão autoritativa;
3. aplicar rate limit;
4. validar `action` e payload com Zod estrito;
5. chamar handler modular;
6. chamar DAL server-only;
7. executar função privada do banco com role restrita;
8. retornar resultado autoritativo e `requestId`;
9. invalidar read models afetados.

Webhooks e upload assinado são endpoints especializados documentados.

## Alternativas
- Server Actions distribuídas: rejeitado para comandos críticos.
- escrita direta Supabase do browser: permitida somente para exceções de baixo risco.
- API REST por tabela: rejeitada por expor modelo interno e multiplicar contratos.

## Consequências
- segurança e logs centralizados;
- registry deve permanecer modular;
- limites de corpo exigem caminho próprio para mídia binária.
