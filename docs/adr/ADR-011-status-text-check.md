# ADR-011 — Estados com `text` e `check`

## Status
Aceito.

## Contexto
Ciclos de estúdio, pagamento e reserva tendem a evoluir. Enums PostgreSQL tornam remoção/alteração rígida.

## Decisão
Persistir estados como `text` com constraints `check` versionadas em migrations. Transições permitidas ficam em comandos privados e tabelas de evento quando relevantes.

## Alternativas
- enum PostgreSQL: rejeitado para estados evolutivos.
- texto sem constraint: rejeitado.
- estado somente na aplicação: rejeitado.

## Consequências
- migrations alteram checks por expansão/contração;
- TypeScript usa união literal;
- testes guardam a lista e transições.
