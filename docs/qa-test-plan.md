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

Uma row marcada como `automatizado` somente é válida quando aponta para uma spec Playwright física e regular dentro de `tests/e2e/`, sem symlink no arquivo ou em seus diretórios. A spec precisa importar em runtime o binding nomeado `test` de `@playwright/test` (alias explícito é aceito) e registrar diretamente no módulo, ou no callback direto de `test.describe(...)`, uma chamada desse binding com callback e título literal (string ou template sem interpolação) contendo o mesmo ID estável. Comentário, constante, texto morto, binding local ou sombreado, função arbitrária, branch condicional, `describe` sem teste, título interpolado, outro arquivo ou spec sem o ID não comprovam automação; `test.only` e `test.skip` continuam proibidos pelo guard global.

Prioridades:

- P0: impede release;
- P1: deve automatizar antes da feature concluída;
- P2: pode entrar em regressão planejada com dívida formal.

Suítes:

- smoke;
- critical;
- regression;
- reflow: contrato dedicado de zoom 200%/viewport equivalente, executado nos três engines e sem substituir a regressão funcional.

## 4. Ambientes

E2E destrutivo somente local:

- host IPv4 literal `127.0.0.1`;
- Supabase local;
- provider fake/sandbox isolado;
- e-mail sink;
- prefixo QA;
- cleanup restrito.

O runner deve abortar antes de abrir browser se detectar production/acceptance host ou DB.

Quando `.env.e2e.local` existir, o preflight somente o lê como arquivo regular exclusivo sob ancestrais físicos, com identidade estável e, em POSIX, owner igual ao usuário efetivo e modo `0600`. A suíte unitária prova ausência opcional, ramo Windows, rejeição anterior à leitura para modo amplo, owner divergente, symlink, hardlink e ancestral simbólico, além de trocas concorrentes do arquivo e do ancestral sem expor o conteúdo em erros.

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

Na FEAT-002, cada execução cria e-mail/senha únicos sob namespace `qa_f002_*@example.test`. Mailpit é consultado somente em `127.0.0.1:54324`, por destinatário exato e limite temporal; o callback precisa ser único, usar origem/path fixos e carregar apenas `token_hash` + `type` no fragmento. O `finally` exclui a mensagem pelo ID e destinatário e o usuário Auth por UUID + e-mail parametrizados, sempre depois do preflight local. Nenhum helper imprime e-mail, token, senha, URL admin ou payload do provider. As specs Auth sobrescrevem trace, vídeo e screenshot para `off`; a senha nunca entra no DOM nem em `fill`, `type` ou `keyboard`. Em um step estático de `Locator.evaluate`, o helper valida o realm do input, o form e o nome fechado `password|confirmPassword`, então instala um listener `formdata` one-shot que injeta o segredo somente no `FormData`, fora de `ariaSnapshot` e `error-context`. Uma execução real com sentinela deve terminar com varredura negativa da saída, do relatório e dos artefatos Playwright.

O rádio PF/PJ também usa o `FormData` como fonte canônica. O helper mantém o locator selecionado e confirma `toBeChecked()` imediatamente antes do submit, para detectar remount ou hidratação que pudesse restaurar o valor inicial antes de criar o usuário.

Transições Auth assíncronas aguardam a resposta HTTP exata, o destino sanitizado sem fragmento e o estado visual autoritativo. O fluxo não usa espera temporal fixa para compensar latência de logout, callback ou renderização SSR; a confirmação da sessão possui limite explícito maior que o timeout do comando público, para distinguir indisponibilidade real de carregamento ainda em curso sem registrar a URL sensível intermediária.

O contrato unitário do cache Auth prova keys distintas por `userId`, sentinela anônima sem e-mail/token, preservação do `initialData` SSR do usuário atual, remoção da família anterior e bloqueio de renderização durante refetch, inclusive quando a ausência de rede deixa `fetchStatus: paused` com `isFetching: false`. Um guard estrutural mantém SSR e a primeira hidratação no mesmo boundary fechado, sem `useQuery` ou assinatura direta do QueryCache nessa fase. Além de A→B, a suíte reproduz a mesma identidade com uma sessão antiga `active` já fresca no cache e uma resposta SSR atual `suspended`: o boundary desmonta o observer, remove a família e somente então monta outro observer sobre o seed SSR. Uma segunda revisão de props RSC no mesmo `LoginPanel` repete essa fase sem depender de remount do componente externo; um refetch autoritativo posterior não reinicia o preparo. Na troca A→B, a PII de A continua invisível enquanto a request está pendente e B nunca é renderizado sob a key de A; a UI limpa o cache e força nova composição SSR antes de publicar a identidade atual.

O teste unitário do conteúdo jurídico cobre CRLF, parágrafo multilinha, headings ATX, omissão do `h1` duplicado, listas ordenadas e não ordenadas, início ordinal diferente de um, `strong`, `em` e links internos/HTTPS. A prova do renderer usa markup estático real para conferir a semântica e o escape de HTML. `javascript:`, `data:`, HTTP, destino protocol-relative, credenciais, barra invertida e separador codificado são rejeitados sem perder o rótulo; um guard adicional impede a introdução de `dangerouslySetInnerHTML`.

## 7. Testes de banco

SQL/integration deve provar:

- migration from zero;
- grants manifest;
- `TEMPORARY` ausente efetivamente para `PUBLIC`, `app_dal` e login runtime, sem remover grants explícitos administrados pela stack;
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

O arquivo `0002_authentication_legal_core.sql` acrescenta 68 casos da FEAT-002: RLS entre dois usuários, leitura anônima apenas de versões vigentes, criação concorrente/idempotente da intenção, expiração/replay, atomicidade do trigger, snapshot/hash, aposentadoria não retroativa, scrub seletivo da metadata, cascata Auth e ausência de grants extras. O mesmo arquivo prova o grant durável e one-shot de recovery: emissão/consulta, expiração e purge, claim exclusiva, retry idempotente da mesma tentativa, release seguro, consume com delete, corrida entre tentativas e cascata controlada pelo Auth. Com os 156 casos da fundação, o plano atual soma 224 asserts.

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
