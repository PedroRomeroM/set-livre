# ADR-004 — Pipeline central de comandos críticos

## Status

Aceito.

## Contexto

Reservas, calendário, revisão editorial e pagamento exigem autenticação, validação, log, atomicidade e idempotência consistentes.

O Blueprint, §§2.5, 10.1 e 25.4, exige que comandos privados validem a sessão autoritativa antes de consumir e interpretar o corpo. Cadastro convidado não possui sessão por definição; compartilhar a mesma URL tornaria impossível decidir, antes do body, se a request pertence ao fluxo público ou privado.

## Decisão

Toda escrita crítica autenticada usa `POST /api/commands`:

1. validar método e origem e aplicar a fachada de rate limit sem consumir o body;
2. validar sessão autoritativa;
3. somente então validar `Content-Type`, limitar/ler o stream e validar `action` e payload com Zod estrito;
4. aplicar o rate limit específico da action/identidade;
5. chamar handler modular;
6. chamar DAL server-only;
7. executar função privada do banco com role restrita;
8. retornar resultado autoritativo e `requestId`;
9. invalidar read models afetados.

Webhooks, upload assinado e operações Auth convidadas são endpoints especializados documentados. Em particular, `identity.register` usa exclusivamente `POST /api/auth/register`: essa rota continua com origem exata, fachada, limite de stream, Zod estrito, limiter específico e DAL restrito, mas não simula uma sessão inexistente. `/api/commands` rejeita a ausência de sessão sem ler o body e não aceita `identity.register` nem revela validação/action ao visitante.

## Alternativas

- Server Actions distribuídas: rejeitado para comandos críticos.
- escrita direta Supabase do browser: permitida somente para exceções de baixo risco.
- API REST por tabela: rejeitada por expor modelo interno e multiplicar contratos.
- Ler `action` antes de autenticar para compartilhar a URL com cadastro convidado: rejeitado porque inverte o pipeline do Blueprint, consome parser sem sessão e cria respostas distinguíveis antes da rejeição autoritativa.

## Consequências

- segurança e logs centralizados;
- registry deve permanecer modular;
- limites de corpo exigem caminho próprio para mídia binária.
- operações públicas especializadas precisam de schema fechado e não podem ampliar o registry privado;
- clientes e testes devem tratar `/api/auth/register` como a única superfície pública de `identity.register`.
