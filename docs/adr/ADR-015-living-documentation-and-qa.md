# ADR-015 — Documentação viva e rastreabilidade QA

## Status
Aceito.

## Contexto
Sem obrigação mecânica, documentação e testes deixam de acompanhar mudanças.

## Decisão
Toda alteração de código/infra exige `.md` no mesmo PR. Cada mudança possui registro em `docs/changes/`. Cada feature possui documento e cenários Playwright com IDs estáveis.

CI verifica:

- mudança técnica sem mudança documental;
- IDs duplicados;
- feature sem spec;
- migration sem atualização de banco/QA;
- link documental quebrado;
- cenário P0 sem automação.

## Alternativas
- documentação periódica: rejeitada.
- testes sem catálogo: rejeitados.
- comentários no código como documentação principal: rejeitados.

## Consequências
- PRs incluem trabalho documental;
- regressões são rastreáveis a comportamento;
- dívida “temporária” precisa de registro e saída.
