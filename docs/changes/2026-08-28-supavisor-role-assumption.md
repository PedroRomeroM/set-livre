# Mudança: assunção canônica da role DAL em produção

- Data: 2026-08-28
- Escopo: correção pós-merge do primeiro deploy de produção
- Risco: alto — autenticação do runtime no banco
- Rollback: release anterior; migration forward-only preserva a fronteira de menor privilégio

O primeiro deploy comprovou que o Supavisor em session mode não encaminha de forma confiável o
`options=-c role=app_dal` do startup packet. O provisionamento falhou fechado antes de ativar a release
e compensou `app_runtime_production` para `NOLOGIN`.

A migration append-only `20260828174500_default_production_dal_role` torna `role=app_dal` o único
setting não secreto desse login no database `postgres`. Assim, o próprio PostgreSQL aplica a fronteira
em toda sessão nova. Readiness, pgTAP e contratos de conexão validam setting, identidade de sessão,
role efetiva, membership e ACL antes de qualquer ativação. O gate `test:db` também abre uma conexão
nova como `app_runtime_production`, sem `options` no startup packet, prova a assunção automática e
restaura o login para `NOLOGIN` em bloco de limpeza obrigatório.

A auditoria pré-commit também eliminou uma corrida no cenário Playwright de navegação por teclado: o
teste agora aguarda semanticamente os formulários hidratados e habilitados antes de enviar `Tab`,
mantendo a validação de foco real sem timeout arbitrário ou retry.

Os contratos duráveis estão em [`database.md`](../database.md),
[`infrastructure.md`](../infrastructure.md), [`security-privacy.md`](../security-privacy.md) e
[`ADR-019`](../adr/ADR-019-controlled-cloud-delivery.md). Evidência terminal e ciclos de review ficam
no PR corretivo e nos checks do GitHub.
