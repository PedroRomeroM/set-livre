# ADR-012 — Paginação keyset e índices por evidência

## Status

Aceito.

## Contexto

Listagens e históricos crescem e offset degrada desempenho/consistência.

## Decisão

Usar cursores opacos baseados em tuplas estáveis, como `(price_cents, id)` ou `(occurred_at, id)`. Contrato: `{ items, nextCursor }`.

Índices são criados apenas quando:

- sustentam constraint/FK;
- sustentam query crítica definida;
- plano medido prova benefício.

Toda adição não estrutural registra consulta, volume e `EXPLAIN`.

## Alternativas

- página/offset: rejeitada.
- índices preventivos: rejeitados.

## Consequências

- UI não promete número de página;
- ordenações precisam de desempate por ID;
- filtros fazem parte da identidade do cursor.
