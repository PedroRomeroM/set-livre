# Registro de riscos

| ID | Risco | Prob. | Impacto | Evidência/Gatilho | Mitigação | Owner | Revisão |
|---|---|---:|---:|---|---|---|---|
| R-001 | onboarding/split do gateway não aprovado | alta | crítico | provider/contrato pendente | decisão antes da produção; adapter; sandbox; fallback | produto/finance | antes F021 |
| R-002 | repasse diferido não suportado como imaginado | média | crítico | contrato provider | validar legal/técnico; não simular escrow | finance | antes F026 |
| R-003 | dupla reserva | média | crítico | concorrência | exclusion constraint, locks, P0 | tech lead | contínuo |
| R-004 | pagamento pago sem hold | média | crítico | atraso/webhook | compensação/refund automático e alerta | payments | contínuo |
| R-005 | fotos excedem storage/egress | alta | alto | crescimento | limites, cache, custos, upgrade | infra | mensal |
| R-006 | Supabase Free insuficiente | alta | alto | 0.5GB/1GB/backup | plano pago para produção | stakeholder | pré-go-live |
| R-007 | VM única falha | média | alto | outage | restore runbook, artifacts, DNS, backup | infra | trimestral |
| R-008 | capacidade OCI A1 indisponível | média | médio | provisionamento | região/shape alternativo ou VM paga | infra | setup |
| R-009 | build ARM64 incompatível | média | alto | sharp/native | runner ARM64 e smoke | CI | fundação |
| R-010 | design não disponível | alta | alto | telas bloqueadas | tokens/primitives/default funcional; revisão | produto | marco 1 |
| R-011 | sessões de 2h geram perda de contexto | alta | médio | retrabalho | docs vivas, slices pequenos, changes | equipe | semanal |
| R-012 | iCal malicioso/complexo | média | médio | arquivo grande/recorrência | limits, parser, sandbox, tests | calendar | F015 |
| R-013 | RLS/grants incorretos | média | crítico | advisor/tests | manifest, two-user tests | data | cada migration |
| R-014 | LGPD/textos legais atrasam | alta | alto | conteúdo pendente | implementação versionada; bloqueador de publicação | cliente | pré-go-live |
| R-015 | reembolso/payout fora de ordem | média | crítico | webhooks | state machine, locks, idempotency | payments | contínuo |
| R-016 | e-mail falha e usuário não sabe | média | médio | outbox backlog | UI autoritativa, retry, alert | ops | contínuo |
| R-017 | escopo futuro entra informalmente | alta | alto | pedidos | out-of-scope + ADR + estimativa | PM | contínuo |
| R-018 | backoffice exposto | baixa | crítico | rota/rede | app separada, allowlist, tests | security | release |
