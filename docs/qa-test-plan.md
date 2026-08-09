# Plano de QA e testes

## 1. Objetivo

Comprovar contratos de produto, segurança, dados, concorrência, acessibilidade e operação. Cobertura não é apenas percentual de linhas.

## 2. Camadas

1. format/lint/typecheck;
2. unitários;
3. guardrails documentais;
4. schema/grants/RLS;
5. integração local;
6. Playwright;
7. provider contract;
8. performance/carga;
9. deploy smoke;
10. restore drill.

## 3. IDs e rastreabilidade

Cada comportamento possui ID `SL-Fxxx-E2E-nnn`. IDs não são reutilizados. O catálogo completo está em `qa-traceability.md`.

Prioridades:

- P0: impede release;
- P1: deve automatizar antes da feature concluída;
- P2: pode entrar em regressão planejada com dívida formal.

Suítes:

- smoke;
- critical;
- regression.

## 4. Ambientes

E2E destrutivo somente local:

- host localhost;
- Supabase local;
- provider fake/sandbox isolado;
- e-mail sink;
- prefixo QA;
- cleanup restrito.

O runner deve abortar antes de abrir browser se detectar production/acceptance host ou DB.

## 5. Projetos Playwright

- Chromium desktop;
- Firefox desktop para critical;
- WebKit desktop para critical;
- Chromium mobile 390x844;
- telefone estreito 320x720 em regressão;
- reflow equivalente a 320x720 com zoom 200%: layout viewport 160x360 nos três engines, com escala física 2 quando suportada pelo engine;
- height compact;
- backoffice desktop;
- axe em claro/escuro e nos viewports móveis de 390 e 320 px;
- safe-area móvel com insets não nulos.

A matriz completa pode distribuir specs, mas todos os P0 passam em Chromium e pelo menos um segundo engine nos fluxos críticos de auth/booking/payment.

## 6. Dados

Fixtures:

- visitor;
- renter A/B;
- owner A/B;
- reviewer/support/finance/admin;
- studios draft/published/paused;
- schedules/pricing;
- reservations/payments/refunds/payouts.

Dados nomeados `qa_<worker>_<test>`. Cleanup não usa wildcard amplo.

## 7. Testes de banco

SQL/integration deve provar:

- migration from zero;
- grants manifest;
- RLS A/B;
- private functions inaccessible;
- status checks;
- revision immutability;
- allocation exclusion;
- idempotency;
- amount/split;
- webhook unique;
- payout/refund invariants;
- cursor;
- outbox;
- anonymization.

## 8. Concorrência

Usar chamadas paralelas reais contra DB local:

- dois holds;
- duplo webhook;
- cancel vs payout;
- expiry vs paid;
- review approve concorrente;
- reorder/media version conflict.

Não considerar teste sequencial prova de race condition.

## 9. Providers

Fake provider implementa contrato e permite:

- approve/decline/pending;
- webhook duplicate/out-of-order;
- delayed paid;
- refund fail/success;
- payout fail/success;
- recipient statuses.

Fixtures de sandbox do provider real são sanitizadas e testes de contrato não rodam contra live.

## 10. Acessibilidade

- axe em páginas e flows;
- teclado;
- focus trap/restore;
- aria errors/live regions;
- zoom 200% com redução real do layout viewport, sem substituir o cenário de texto ampliado;
- contrast;
- touch target;
- calendar alternative;
- reduced motion;
- responsive reflow.

Axe não substitui teclado/leitor.

## 11. Visual/responsivo

Capturas aprovadas para:

- home;
- listagem;
- detail;
- configurator;
- checkout PIX/card;
- owner editor/calendar;
- backoffice review.

Comparar desktop quando CSS mobile muda.

## 12. Performance

Antes de go-live:

- list public com volume plausível;
- availability 31 days;
- quote;
- hold concurrency;
- owner calendar;
- admin queues;
- image LCP;
- build bundle;
- web vitals.

Índice novo somente com plano.

## 13. Smoke de deploy

- release SHA;
- live/ready;
- home;
- list;
- login;
- public app no admin;
- backoffice restricted;
- DB read;
- command unauth;
- worker heartbeat;
- TLS.

## 14. Relatório

CI gera:

- commit/release;
- ambiente;
- comandos/duração;
- cenários;
- falhas;
- trace/screenshots;
- migration head;
- browser versions;
- pendências.

Timeout sem resumo é inconclusivo.

## 15. Gate por mudança

| Mudança          | Gate                                       |
| ---------------- | ------------------------------------------ |
| UI               | unit + affected E2E + axe/responsive       |
| Command          | unit + integration + E2E                   |
| Schema/RLS       | reset + DB suite + affected E2E            |
| Calendar/payment | concurrency + full critical                |
| Infra            | build + shell/static checks + deploy smoke |
| Docs             | docs check/link/ID                         |
| Dependency       | audit + build + tests                      |

## 16. Critério de release

- zero P0 falho;
- zero P1 flakey conhecido sem dívida aprovada;
- zero grant/RLS violation;
- build das duas apps;
- restore recente;
- smoke/rollback;
- performance dentro do baseline;
- docs/traceability atualizados.
