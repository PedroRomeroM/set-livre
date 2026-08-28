# ADR-003 — Estado remoto e contrato de leitura

## Status

Aceito.

## Contexto

Listas, filtros, calendário e painéis podem divergir quando cada componente administra cache e refetch de forma própria.

## Decisão

Usar TanStack Query como contrato único de estado remoto interativo.

Leituras vêm de read models pequenos, tipados, filtrados e paginados no servidor. Query keys incluem usuário/escopo, filtros e cursor. Normalizers validam a fronteira. Comandos invalidam prefixos documentados.

Server Components podem pré-carregar dados públicos ou iniciais, mas o estado remoto interativo é hidratado no mesmo contrato.

## Alternativas

- Context API para dados remotos: rejeitado.
- Fetch manual por componente: rejeitado.
- Estado global generalista: rejeitado.

## Consequências

- refetch e invalidação previsíveis;
- menos estados duplicados;
- necessidade de catálogo de query keys e impactos.
