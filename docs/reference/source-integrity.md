# Integridade da fonte arquitetural

## Arquivo

- Caminho: `docs/reference/architecture-blueprint.md`.
- Papel: primeira autoridade arquitetural do projeto.
- SHA-256 da baseline 1.1: `3bdc55794381eeff77dad4a6e8c364e466debf19fa2acf24c688545e01184339`.

## Regra

O arquivo é uma cópia integral da fonte anexada e não deve ser editado para adaptar o produto. Adaptações do domínio Set Livre são registradas em ADRs. Uma nova versão da fonte precisa:

1. ser adicionada ou substituída deliberadamente;
2. atualizar este checksum;
3. registrar a substituição no PR e, se houver decisão arquitetural, em ADR;
4. avaliar todos os ADRs impactados;
5. atualizar `AGENTS.md` e `docs/README.md` se a ordem de autoridade mudar.

## Verificação

```bash
sha256sum docs/reference/architecture-blueprint.md
```

O valor esperado nesta baseline é `3bdc55794381eeff77dad4a6e8c364e466debf19fa2acf24c688545e01184339`.
