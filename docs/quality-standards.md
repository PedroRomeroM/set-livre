# Padrões de qualidade

## 1. Qualidade é contrato

A qualidade inclui:

- correção de domínio;
- segurança;
- privacidade;
- acessibilidade;
- performance;
- custo;
- operação;
- documentação;
- reversibilidade.

Uma feature “funcionando” sem testes, RLS, mobile, logs ou docs não está pronta.

## 2. Código

- TypeScript strict;
- sem `any`;
- funções pequenas por intenção;
- domínio fora de componentes;
- server-only explícito;
- DTOs e Zod;
- erros tipados;
- nenhuma dependência circular;
- nenhum código morto;
- nenhum TODO informal;
- complexidade explicada por ADR/feature.

## 3. Banco

- migration append-only;
- reset from zero;
- constraints;
- grants;
- RLS;
- commands atomic;
- idempotency;
- correction strategy;
- read models;
- EXPLAIN before nonstructural index.

## 4. UI

- primitives;
- loading/empty/error/conflict/success;
- desktop/mobile;
- 320 px;
- 200% zoom;
- keyboard;
- 44 px;
- no layout shift;
- no fake data/actions;
- copy factual.

## 5. Segurança

- least privilege;
- secrets;
- input/body/rate;
- origin;
- webhook;
- upload;
- PII redaction;
- audit;
- supply chain.

## 6. Testes

- behavior IDs;
- unit;
- DB/RLS;
- integration;
- Playwright per feature;
- axe;
- concurrency;
- smoke;
- restore.

## 7. Operação

- structured logs;
- health;
- metrics;
- alert/runbook;
- deploy SHA;
- rollback;
- backup/restore;
- cost trigger.

## 8. Documentação

- `.md` no mesmo PR;
- change record;
- feature;
- QA trace;
- ADR structural;
- context current;
- no stale study docs.

## 9. SLOs de referência

| Indicador | Meta inicial |
|---|---|
| Booking double confirmation | zero |
| Paid sem reservation | zero tolerado; alerta imediato |
| Webhook processing p95 | < 60 s |
| E-mail confirmation p95 | < 5 min |
| Hold expiry lag p95 | < 2 min |
| Payout scheduling lag | < 15 min |
| Public app 5xx | < 0,5% |
| LCP p75 | ≤ 2,5 s |
| INP p75 | ≤ 200 ms |
| CLS p75 | ≤ 0,1 |
| Restore drill | dentro de RTO |

## 10. Review checklist

Antes do merge:

- contrato correto;
- edge cases;
- concurrency;
- authorization;
- data minimization;
- a11y/mobile;
- tests;
- docs;
- logs;
- rollback;
- cost.
