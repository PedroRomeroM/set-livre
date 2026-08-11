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

O cenário `SL-F002-E2E-003` também deve expirar de forma determinística o grant exato no Supabase local, sem `waitForTimeout`, comprovar que o formulário deixa de ser funcional e que a sessão Auth criada pelo recovery não autentica `/entrar`. Setup e cleanup usam apenas helper local parametrizado, após o mesmo preflight destrutivo, e não imprimem token, scope, `session_id`, e-mail ou senha.

O contrato unitário do cache Auth prova keys distintas por `userId`, sentinela anônima sem e-mail/token, preservação do `initialData` SSR do usuário atual, remoção da família anterior e bloqueio de renderização durante refetch, inclusive quando a ausência de rede deixa `fetchStatus: paused` com `isFetching: false`. Um guard estrutural mantém SSR e a primeira hidratação no mesmo boundary fechado, sem `useQuery` ou assinatura direta do QueryCache nessa fase. Além de A→B, a suíte reproduz a mesma identidade com uma sessão antiga `active` já fresca no cache e uma resposta SSR atual `suspended`: o boundary desmonta o observer, remove a família e somente então monta outro observer sobre o seed SSR. Uma segunda revisão de props RSC no mesmo `LoginPanel` repete essa fase sem depender de remount do componente externo; um refetch autoritativo posterior não reinicia o preparo. Na troca A→B, a PII de A continua invisível enquanto a request está pendente e B nunca é renderizado sob a key de A; a UI limpa o cache e força nova composição SSR antes de publicar a identidade atual.

O contrato de cache recovery deve provar keys diferentes para `anonymous` e para cada UUID público, remoção de scopes antigos, rejeição da resposta divergente antes da escrita e ausência de grant, token, `session_id`, user ID ou e-mail na key. O formulário só pode ser autorizado por `allowed=true` com scope correspondente e `fetchStatus: idle`; `fetching` e `paused` permanecem no estado de verificação, mesmo quando uma resposta `allowed=true` já existe no cache. Mudança de scope remove as famílias recovery/session e exige nova composição SSR.

Os testes de serviço tratam como terminal qualquer resultado ambíguo de signup depois do envio de `verifyOtp`, descartam a ref one-shot e exigem novo link. Eles também simulam publicação parcial no login e sign-out final inconclusivo no recovery: o fallback tenta apagar o cookie Auth base e todos os chunks numéricos observados, continua após uma deleção falhar, preserva cookies semelhantes/alheios e não expõe a falha causal.

A extensão de segurança recovery deve validar `sub`, `session_id` e `exp` assinados, emissão de binding/grant apenas para a linha correspondente de `auth.sessions`, fechamento por expiração/consumo, marcador ausente/divergente e navegação fora da superfície permitida. A classificação precisa sobreviver à remoção dos cookies auxiliares por meio da tombstone; em contrapartida, uma sessão comum sem binding não pode sofrer logout por marcador residual. Testes do Proxy, read models e DAL cobrem cardinalidade estrita, limpeza exata e falha fechada sem expor contexto sensível.

O rate limiter unitário deve manter uma chave exata esgotada sob churn até o fim da janela, reutilizar um overflow sticky por ação quando os 10.000 buckets exatos estão ocupados, isolar as partições, recolher entradas expiradas e falhar fechado para uma nova partição além do limite de 64 overflows. Compartilhamento conservador pode rejeitar uma chave legítima da mesma ação; evicção de bucket vivo ou reinício silencioso de cota é regressão.

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

O arquivo `0002_authentication_legal_core.sql` cobre RLS entre dois usuários, RLS sem policy nos estados privados, leitura anônima apenas de versões vigentes, criação concorrente/idempotente da intenção, expiração/replay, atomicidade do trigger, snapshot/hash, aposentadoria não retroativa, scrub seletivo da metadata, cascata Auth e ausência de grants extras. Para recovery, a suíte deve provar emissão/inspeção por `user_id + session_id`, grant one-shot de 15 minutos, claim/release/consume concorrentes, fechamento sem remover a tombstone e rejeição de binding, scope ou sessão canônica divergente.

O banco também deve recusar `jwt_exp` diferente de `3600` na emissão, inspeção e readiness. A ausência em `auth.sessions` fecha a binding, remove o grant e estende a retenção por pelo menos 65 minutos; o purge só pode apagar a tombstone após `retain_until` e nova prova de ausência, nunca enquanto a sessão canônica existir. O total de asserts é publicado somente depois do reset e do gate pgTAP sobre a migration nova.

Fixtures abertas por `dblink` usam UUIDs reservados de QA, preflight exato antes da transação pgTAP e cleanup persistente depois do rollback. Assim, uma execução interrompida é recuperável e duas chamadas consecutivas de `test:db` não dependem de reset intermediário nem deixam usuário, sessão, binding ou grant residual.

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
