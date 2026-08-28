# ADR-001 — Cadeia de fonte de verdade

## Status

Aceito.

## Contexto

A especificação anterior concentrava produto, arquitetura e operação, facilitando decisões contraditórias e alterações de código sem atualização documental.

## Decisão

Adotar a cadeia:

`Blueprint → ADRs → especificação → documentos vivos → migrations/contratos/testes → código`.

O Blueprint anexado é a referência arquitetural confiável. ADRs aplicam seus princípios ao domínio. A especificação fecha produto. Documentos vivos descrevem o estado atual.

A árvore da seção 5 do Blueprint é ilustrativa, não um manifesto literal de arquivos. A organização
vigente está no índice `docs/README.md`; documentos podem ser consolidados ou renomeados por ADR sem
editar a cópia íntegra do Blueprint. Por isso o antigo `docs/context.md` foi absorvido pelas fontes
especializadas e pelo resumo executivo `contexto-projeto-set-livre.html`.

## Alternativas

- Documento único: rejeitado por acoplamento e dificuldade de manutenção.
- Código/teste como única verdade: rejeitado porque não expressa intenção, alternativas e regras de produto.

## Consequências

- Toda decisão estrutural é rastreável.
- Mudanças exigem mais disciplina documental.
- Contradições deixam de ser resolvidas silenciosamente.

## Revisão

Revisar se a estrutura documental impedir entrega em vez de proteger contratos.
