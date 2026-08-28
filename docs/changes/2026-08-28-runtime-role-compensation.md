# Mudança: compensação segura da role de produção

- Data: 2026-08-28
- Escopo: recuperação do runtime PostgreSQL no deploy de produção
- Risco: alto — autenticação do runtime e isolamento da DAL
- Rollback: release anterior permanece ativa; a compensação mantém a role em `NOLOGIN`

O provisionamento passa a distinguir inicialização, retomada e validação da credencial de
`app_runtime_production`. Depois de uma falha de ativação, a compensação preserva o verificador,
encerra sessões existentes e comprova em uma conexão independente `NOLOGIN`, verificador presente e
zero sessões. Uma nova tentativa retoma a mesma credencial sem rotação implícita.

Os contratos duráveis estão em:

- [`infrastructure.md`](../infrastructure.md): ativação, compensação, retomada e rotação dedicada;
- [`database.md`](../database.md): estados canônicos da role e verificação independente;
- [`security-privacy.md`](../security-privacy.md): fronteira de privilégio mínimo;
- [`ADR-019`](../adr/ADR-019-controlled-cloud-delivery.md): decisão arquitetural da entrega controlada.

Findings, testes e evidências terminais permanecem no PR, nos checks e no histórico Git.
