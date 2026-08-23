# Ciclo completo obrigatório de review e deploy

## Status e alcance

Este contrato é obrigatório para toda feature, correção, mudança de infraestrutura, migration,
configuração ou documentação que será incorporada a `main`. Ele complementa as proteções do
GitHub: check verde e conversa resolvida são necessários, mas não substituem a revisão Codex limpa
do SHA final nem o acompanhamento do deploy.

Push direto em `main`, merge administrativo, autoaprovação, redução de teste, comentário ignorado
ou deploy manual para contornar este ciclo são proibidos. Timeout, resposta ausente, comando
interrompido, check cancelado ou serviço externo indisponível são resultados inconclusivos; nunca
equivalem a aprovação.

## Ciclo antes do merge

1. Atualize `main` a partir de `origin/main` e crie uma branch curta e exclusiva para a mudança. A
   branch não pode carregar trabalho não relacionado.
2. Implemente código, migrations, testes, documentação viva e o registro em `docs/changes/` no mesmo
   escopo. Todo bug visível corrigido ganha teste de regressão; procure proativamente a mesma classe
   de defeito nas superfícies equivalentes.
3. Antes de cada commit candidato a review, execute todos os gates relevantes. Antes do primeiro
   pedido de review e de cada novo pedido após correção, execute novamente os gates integrais
   exigidos pelo escopo; feature e release incluem banco local, Playwright completo, builds das duas
   aplicações e smoke aplicável.
4. Faça commit intencional, push da branch e abra um pull request **não draft** para `main`, com
   escopo, riscos, testes, rollback e evidências factuais.
5. Publique o comentário exato `@codex review` e registre URL, horário e SHA do head. Aguarde no
   mínimo 60 minutos corridos antes de avaliar a resposta. Novo push invalida o pedido anterior e
   exige outro comentário e uma nova espera integral.
6. Após a espera, inspecione todas as superfícies: reviews, comentários de topo, comentários inline,
   threads de review, checks e estado de merge. Uma mensagem não encontrada em uma dessas
   superfícies não pode ser presumida ausente nas demais.
7. Para cada finding, confirme tecnicamente sua pertinência ao Set Livre. Finding aplicável é
   corrigido na causa, tem cobertura que o teria prevenido e leva à busca da mesma falha no restante
   do escopo. Finding rejeitado permanece documentado no PR com justificativa técnica curta e
   verificável.
8. Resolva uma thread somente depois de a correção estar publicada e testada. Thread rejeitada só é
   resolvida depois da justificativa no próprio PR. Não use resolução para ocultar trabalho pendente.
9. Faça commit e push das correções, repita os gates, publique novo `@codex review`, aguarde outros
   60 minutos e repita o ciclo até que o Codex declare explicitamente não ter encontrado problema
   relevante no SHA atual.
10. Faça merge somente quando o último review limpo corresponder ao head atual, todos os checks
    obrigatórios estiverem verdes, não houver conversa pendente e o PR estiver mergeável. Preserve o
    SHA do merge e os IDs dos runs como evidência.

## Ciclo depois do merge

1. Acompanhe o workflow do SHA incorporado a `main` até estado terminal. Para releases habilitadas,
   acompanhe separadamente migrations/readiness do Supabase, publicação/rollback da VM Oracle e os
   health checks públicos.
2. Confirme que a URL pública serve o SHA esperado e que live, ready, aplicação pública, login e
   backoffice atendem ao runbook. Sucesso do job sem smoke factual não encerra o deploy.
3. Falha de código, migration, artifact, configuração ou deploy abre uma **nova branch e um novo
   PR**. A correção repete integralmente este contrato; não altere produção à mão nem reabra o PR já
   incorporado para escapar da revisão.
4. Bloqueio externo genuíno é registrado com evidência e mantém a entrega fail-closed. Ele não
   autoriza fallback de região, shape, versão, segurança ou provider.

## Evidência mínima de encerramento

- branch/base e SHA final revisado;
- comandos e resultados dos gates;
- URL/horário de cada `@codex review` e prova da espera mínima;
- inventário de reviews, comentários, threads e checks;
- justificativas e resolução de todos os findings;
- mensagem explícita do review limpo sobre o SHA final;
- SHA do merge e IDs dos workflows;
- resultado terminal dos deploys, rollback quando aplicável e health público do SHA esperado.

Sem esse conjunto, o PR, a feature e o deploy permanecem em andamento.
