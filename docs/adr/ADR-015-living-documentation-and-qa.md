# ADR-015 — Documentação viva e rastreabilidade QA

## Status

Aceito.

## Contexto

Sem obrigação mecânica, documentação e testes deixam de acompanhar mudanças.

## Decisão

Somente alterações que mudam um fato durável atualizam sua documentação canônica no mesmo PR. Diff,
rationale da entrega, execução de gates e comentários permanecem no GitHub. Uma feature planejada ou
em implementação possui plano e cenários Playwright com IDs estáveis. Depois de implementação, suíte
completa, documentação permanente e reviews incrementais verdes, o candidato final remove o plano e
atualiza o roadmap antes da revisão holística. Merge e deploy permanecem gates obrigatórios de entrega,
mas não justificam conservar documentação transitória já consolidada.

O checker documental verifica objetivamente:

- fontes obrigatórias e links locais;
- IDs de ADR, feature e cenário sem duplicação;
- coerência entre status do roadmap e existência ou remoção do plano transitório;
- título/status estrutural de ADRs e planos.

O checker não tenta inferir intenção a partir do diff. Atualização da fonte canônica, impacto de
migration e automação P0 são comprovados pelos gates correspondentes e inspecionados no review do PR.

## Alternativas

- documentação periódica: rejeitada.
- testes sem catálogo: rejeitados.
- comentários no código como documentação principal: rejeitados.

## Consequências

- PRs não criam arquivos de evidência que apenas copiam conteúdo já preservado pelo GitHub;
- regressões são rastreáveis a comportamento;
- dívida “temporária” precisa de registro e saída.
