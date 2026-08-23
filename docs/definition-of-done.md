# Definition of Done

## Produto

- intenção clara;
- rules approved;
- included/out excluded;
- copy factual;
- correction path;
- no hidden promise.

## Architecture

- canonical source;
- read/write contracts;
- query keys/invalidation;
- provider boundary;
- no accidental coupling.

## Data/Security

- migration;
- checks/FKs;
- grants/RLS;
- private commands;
- ownership;
- idempotency/locks;
- privacy;
- audit.

## UI

- primitives;
- desktop/mobile 320;
- states;
- keyboard/axe;
- 200% zoom;
- names long;
- no overflow/CLS.

## QA

- IDs;
- unit;
- DB;
- integration;
- Playwright;
- concurrency if relevant;
- smoke.

## Review e merge

- branch criada de `main` atualizada;
- PR não draft com escopo, risco, evidência e rollback;
- gates relevantes repetidos no SHA final;
- `@codex review` seguido de espera mínima de 60 minutos;
- reviews, comentários, threads e checks integralmente inspecionados;
- findings corrigidos ou tecnicamente justificados e conversas resolvidas;
- review Codex explicitamente limpo para o head atual;
- merge protegido sem bypass, seguido de monitoramento terminal do deploy e health público;
- falha pós-merge corrigida em nova branch/PR pelo mesmo ciclo.

## Docs

- feature;
- change record;
- living docs;
- ADR if structural;
- QA trace;
- context/changelog.

## Ops

- logs/metrics;
- alert/runbook;
- deploy/rollback;
- backup impact;
- cost impact.

A feature não é concluída se qualquer item obrigatório estiver ausente. Timeout, review ausente,
comando interrompido, check cancelado ou provedor indisponível são inconclusivos e não satisfazem o
ciclo definido em [`review-deploy-cycle.md`](review-deploy-cycle.md).
