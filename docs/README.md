# Documentação do Set Livre

## Comece aqui

1. [`AGENTS.md`](../AGENTS.md): contrato obrigatório de implementação, segurança e entrega.
2. [`specification.md`](specification.md): escopo e comportamento do produto.
3. [`architecture.md`](architecture.md): fronteiras técnicas atuais.
4. [`roadmap.md`](roadmap.md): ordem e estado das features.
5. [`development.md`](development.md): ambiente local, comandos e testes.

O Blueprint de referência fica em [`reference/architecture-blueprint.md`](reference/architecture-blueprint.md),
com checksum e procedimento de atualização em
[`reference/source-integrity.md`](reference/source-integrity.md).
Decisões que adaptam o Blueprint ao produto ficam em [`adr/`](adr/).

## Contratos permanentes

| Área                    | Fonte canônica                                               |
| ----------------------- | ------------------------------------------------------------ |
| API e comandos          | [`api-contracts.md`](api-contracts.md)                       |
| banco, RLS e migrations | [`database.md`](database.md)                                 |
| domínio                 | [`domain-model.md`](domain-model.md)                         |
| segurança e LGPD        | [`security-privacy.md`](security-privacy.md)                 |
| UX e rotas              | [`ux-blueprint.md`](ux-blueprint.md)                         |
| sistema visual          | [`design-system.md`](design-system.md)                       |
| acessibilidade          | [`accessibility.md`](accessibility.md)                       |
| cache remoto            | [`query-cache-invalidation.md`](query-cache-invalidation.md) |
| QA                      | [`qa-test-plan.md`](qa-test-plan.md)                         |

Documentos de domínio especializados existem para calendário/reservas, pagamentos, mídia,
notificações e backoffice. Eles guardam regras duráveis; não repetem o histórico dos PRs.

## Operação

- [`infrastructure.md`](infrastructure.md): Supabase, Oracle, rede, systemd, Nginx e release.
- [`review-deploy-cycle.md`](review-deploy-cycle.md): review obrigatório, merge e acompanhamento.
- [`observability.md`](observability.md): health, logs, métricas e alertas.
- [`runbooks/`](runbooks/): resposta a incidentes concretos.
- [`../configuration-steps.md`](../configuration-steps.md): ações humanas pendentes na entrega atual ou
  em marcos futuros explicitamente adiados.

## Documentos transitórios

- [`features/`](features/): somente features planejadas ou ainda em implementação; o plano é apagado
  quando código, testes e documentação permanente concluem o recorte, sem substituir review/deploy.
- [`open-decisions.md`](open-decisions.md): decisões humanas ainda abertas.
- [`technical-debt.md`](technical-debt.md): dívida aceita com dono e condição de saída.

## Regra contra redundância

Cada fato tem uma fonte canônica. Outros documentos apontam para ela. Histórico detalhado pertence ao
Git, ao PR e aos deployments; documentos vivos descrevem apenas o estado atual.
