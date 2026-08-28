# Mudança: simplificação da infraestrutura e entrega controlada

- Data: 2026-08-26
- Escopo: fundação transversal, sem nova feature de produto
- Risco: alto — baseline de produção, CI obrigatório e deploy remoto
- Rollback: release por symlink atômico; migrations forward-only por expand/contract

Este registro existe apenas como índice do PR e não replica diff, cronologia, resultados de execução ou
detalhes internos. Os contratos duráveis estão nas fontes canônicas:

- [`infrastructure.md`](../infrastructure.md): VM, CI/CD, release, recovery, HTTPS e observabilidade;
- [`database.md`](../database.md): baseline, roles, migrations, grants e RLS;
- [`development.md`](../development.md): ambiente local, Supabase CLI e gates;
- [`security-privacy.md`](../security-privacy.md): fronteiras de segurança e redaction;
- [`review-deploy-cycle.md`](../review-deploy-cycle.md): ciclo obrigatório de review, merge e deploy;
- [`backup-restore.md`](../backup-restore.md): reconstrução e continuidade.

O contrato final também autentica a configuração corrente no reuso de um SHA, a árvore completa antes
de preservar uma release durante bootstrap e as superfícies efetivas de SSH, Nginx e systemd antes de
qualquer migration.

Rationale da entrega, findings, testes, contagens e evidência terminal permanecem no PR nº 7, nos
checks e no histórico Git.
