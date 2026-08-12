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
- accessibility: axe e teclado na matriz explícita de claro, escuro e mobile;
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

Na FEAT-002, cada execução cria e-mail/senha únicos sob namespace `qa_f002_*@example.test`. Mailpit é consultado somente em `127.0.0.1:54324`, por destinatário exato e limite temporal; o callback precisa ser único, usar origem/path fixos e carregar apenas `token_hash` + `type` no fragmento. O `finally` exclui a mensagem pelo ID e destinatário e o usuário Auth por UUID + e-mail parametrizados, sempre depois do preflight local. E-mails QA sintéticos podem aparecer somente nos títulos automáticos `Fill`/`Type`/`Expect` do Playwright, sob allowlist exata `qa_f002|qa_f003_*@example.test`; ficam proibidos em stdout/stderr, erros, attachments e logs da aplicação. Token, senha, URL admin e payload do provider não podem aparecer em nenhum desses destinos. As specs Auth sobrescrevem trace, vídeo e screenshot para `off`; a senha nunca entra no DOM nem em `fill`, `type` ou `keyboard`. Em um step estático de `Locator.evaluate`, o helper valida o realm do input, o form e o nome fechado `password|confirmPassword`, então instala um listener `formdata` one-shot que injeta o segredo somente no `FormData`, fora de `ariaSnapshot` e `error-context`. Uma execução real com sentinela deve terminar com varredura negativa da saída, do relatório e dos artefatos Playwright, permitindo somente as fixtures de e-mail no campo JSON de título automático descrito acima.

O rádio PF/PJ também usa o `FormData` como fonte canônica. O helper mantém o locator selecionado e confirma `toBeChecked()` imediatamente antes do submit, para detectar remount ou hidratação que pudesse restaurar o valor inicial antes de criar o usuário.

Transições Auth assíncronas aguardam a resposta HTTP exata, o destino sanitizado sem fragmento e o estado visual autoritativo. O fluxo não usa espera temporal fixa para compensar latência de logout, callback ou renderização SSR; a confirmação da sessão possui limite explícito maior que o timeout do comando público, para distinguir indisponibilidade real de carregamento ainda em curso sem registrar a URL sensível intermediária.

O contrato pós-merge do login classifica `NETWORK_UNAVAILABLE`, `REQUEST_TIMEOUT`, `RESPONSE_INVALID` e a resposta válida `AUTH_SESSION_RECHECK_REQUIRED` como desfechos ambíguos depois do envio/início de `setSession`: a prova deve verificar que a referência efêmera, o formulário e todo cache privado são redigidos antes do hard reload, que somente destinos internos allowlisted sobrevivem e que a composição SSR decide entre sessão ativa e entrada não confirmada. Apenas rejeições API comprovadamente anteriores à publicação continuam no mesmo formulário; a unidade de serviço reproduz cookie parcial e cleanup falho sem reclassificar o resultado como retryable.

O cenário `SL-F002-E2E-003` também deve expirar de forma determinística o grant exato no Supabase local, sem `waitForTimeout`, comprovar que o formulário deixa de ser funcional e que a sessão Auth criada pelo recovery não autentica `/entrar`. Setup e cleanup usam apenas helper local parametrizado, após o mesmo preflight destrutivo, e não imprimem token, scope, `session_id`, e-mail ou senha.

O contrato unitário do cache Auth prova keys distintas por `userId`, sentinela anônima sem e-mail/token, preservação do `initialData` SSR do usuário atual, remoção da família anterior e bloqueio de renderização durante refetch, inclusive quando a ausência de rede deixa `fetchStatus: paused` com `isFetching: false`. Um guard estrutural mantém SSR e a primeira hidratação no mesmo boundary fechado, sem `useQuery` ou assinatura direta do QueryCache nessa fase. Além de A→B, a suíte reproduz a mesma identidade com uma sessão antiga `active` já fresca no cache e uma resposta SSR atual `suspended`: o boundary desmonta o observer, remove a família e somente então monta outro observer sobre o seed SSR. Uma segunda revisão de props RSC no mesmo `LoginPanel` repete essa fase sem depender de remount do componente externo; um refetch autoritativo posterior não reinicia o preparo. Na troca A→B, a PII de A continua invisível enquanto a request está pendente e B nunca é renderizado sob a key de A; a UI limpa o cache e força nova composição SSR antes de publicar a identidade atual.

O contrato de cache recovery deve provar keys diferentes para `anonymous` e para cada UUID público, remoção de scopes antigos, rejeição da resposta divergente antes da escrita e ausência de grant, token, `session_id`, user ID ou e-mail na key. O formulário só pode ser autorizado por `allowed=true` com scope correspondente e `fetchStatus: idle`; `fetching` e `paused` permanecem no estado de verificação, mesmo quando uma resposta `allowed=true` já existe no cache. Mudança de scope remove as famílias recovery/session e exige nova composição SSR.

Uma rejeição pública retryable da atualização de senha precisa sobreviver ao ciclo `erro -> fetching/paused -> allowed+idle` no mesmo scope, embora o formulário seja desmontado durante a verificação. O snapshot testado contém apenas mensagem, scope UUID público e erros `password | confirmPassword`; decisão negativa, scope divergente, sucesso ou nova submissão o apagam.

Os testes de serviço tratam como terminal qualquer resultado ambíguo de signup depois do envio de `verifyOtp`, descartam a ref one-shot e exigem novo link. Eles também simulam publicação parcial no login e sign-out final inconclusivo no recovery: o fallback tenta apagar o cookie Auth base e todos os chunks numéricos observados, continua após uma deleção falhar, preserva cookies semelhantes/alheios e não expõe a falha causal.

Na projeção de preferência pós-login, a suíte injeta uma `get_my_profile()` retida, avança o deadline server-side de um segundo e exige fallback `system` por `AbortSignal`. Resolver ou rejeitar a RPC depois do encerramento não pode alterar cookie nem chamar `signOut`. A rodada focada de timeout passou em 37/37 e o auditor combinado passou em 96/96; a suíte unitária integral posterior passou em 578/578 testes distribuídos por 60 arquivos.

A extensão de segurança recovery deve validar `sub`, `session_id` e `exp` assinados, emissão de binding/grant apenas para a linha correspondente de `auth.sessions`, fechamento por expiração/consumo, marcador ausente/divergente e navegação fora da superfície permitida. A classificação precisa sobreviver à remoção dos cookies auxiliares por meio da tombstone; em contrapartida, uma sessão comum sem binding não pode sofrer logout por marcador residual. Testes do Proxy, read models e DAL cobrem cardinalidade estrita, limpeza exata e falha fechada sem expor contexto sensível.

O rate limiter unitário deve manter uma chave exata esgotada sob churn até o fim da janela, reutilizar um overflow sticky por ação quando os 10.000 buckets exatos estão ocupados, isolar as partições, recolher entradas expiradas e falhar fechado para uma nova partição além do limite de 64 overflows. Compartilhamento conservador pode rejeitar uma chave legítima da mesma ação; evicção de bucket vivo ou reinício silencioso de cota é regressão.

O teste unitário do conteúdo jurídico cobre CRLF, parágrafo multilinha, headings ATX, omissão do `h1` duplicado, listas ordenadas e não ordenadas, início ordinal diferente de um, `strong`, `em` e links internos/HTTPS. A prova do renderer usa markup estático real para conferir a semântica e o escape de HTML. `javascript:`, `data:`, HTTP, destino protocol-relative, credenciais, barra invertida e separador codificado são rejeitados sem perder o rótulo; um guard adicional impede a introdução de `dangerouslySetInnerHTML`.

Na FEAT-003, cada execução cria identidade `qa_f003_*@example.test` e reutiliza confirmação, sessão e Mailpit locais da FEAT-002. CPF, CNPJ e documento adicional são sintéticos, estruturalmente válidos quando o cenário exige e inseridos somente por listener `formdata` one-shot sobre os nomes fechados `taxId | additionalDocument`; esses valores nunca passam por `fill`, `type`, `keyboard`, título dinâmico ou asserção que os imprima. As quatro specs sobrescrevem trace, vídeo e screenshot para `off`. O `finally` remove por UUID/e-mail exatos a identidade Auth e as mensagens Mailpit e comprova a ausência das linhas correspondentes em `profiles` e `user_preferences`, sem wildcard. A cobertura mantém os IDs 001–005 e adiciona 006 para axe/teclado na matriz claro-escuro-mobile, 007 para reflow 160x360 nos três engines, 008 para projeção SSR e persistência da preferência e 009 para o boundary fechado durante `fetching`/`paused`, timeout, conflito e recuperação. O ID 003 também cola um prefixo internacional não-`55` e um telefone brasileiro formatado com dígito excedente, exige que a máscara preserve ambos, recebe erro local e prova zero comando antes das rejeições CPF/CNPJ.

No ID 004, o contexto auxiliar serve somente para provisionar B. A transição observada ocorre na mesma página, BrowserContext e árvore React de A: o login local troca a sessão sem navegar, um refetch retido mantém o QueryClient montado e o boundary remove toda PII de A. Quando o DTO de B chega sob a key de A, o guard de escopo limpa o cache e força nova composição SSR; uma sentinela de mutação até `pagehide` exige o marcador `clear`, varre somente `main`, comprova que heading, resumo, formulário e controles antigos estão desconectados e somente a página recomposta expõe B. Scripts Flight/RSC fora da UI não integram esse oráculo. As três projeções também exigem zero `pageerror`, zero erro React no console e B inalterado. A extensão P2 aciona ainda uma closure de logout capturada sob A depois de B ser autoritativo: após `getClaims`, a classificação precisa terminar antes de o fluxo obter explicitamente o cookie store e antes dos efeitos destrutivos explícitos de recovery, deleção de cookies ou `signOut`; B continua autenticado e inalterado. No ID 009, um perfil completo torna nome, telefone e máscaras visíveis antes da prova; refetch retido, `fetchStatus: paused` offline e timeout precisam remover cada um desses valores de texto e controles do DOM, além de preservar recuperação de timeout e conflito nas quatro projeções. A extensão de logout em ambas as superfícies exige exatamente uma request durante a tentativa offline e zero request tardia após reconexão.

O hardening de sessão exige ainda provas unitárias de que `expectedScope` é UUID obrigatório e estrito, mas nunca autoridade; `409 SESSION_CHANGED` ocorre antes do limiter específico de perfil, serviço e DAL; `SESSION_CHANGED`/`UNAUTHENTICATED` disparam a transição fechada; e os reseeds SSR de login, perfil e segurança descartam `MutationCache` e ambas as famílias privadas preservando queries públicas. Logout e login ambíguo devem continuar provando `QueryClient.clear()` integral. Nas duas superfícies de logout, a mutation precisa executar closure sem `variables` em `networkMode: "always"`. A prova admite que `getClaims` renove ou mantenha a sessão internamente, mas exige que a classificação termine antes de o fluxo obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw → `503 SERVICE_UNAVAILABLE`, erro/contexto assinado ausente → `401 UNAUTHENTICATED` e UUID válido divergente → `409 SESSION_CHANGED`. Os três ramos têm zero efeitos destrutivos explícitos de logout. A publicação autoritativa precisa ser exercitada com `QueryObserver` real para confirmar que o observer atual permanece ligado e com callback tardio de A após reseed B para confirmar que a key de A não é recriada.

Sem criar novo ID nem alterar a contagem do catálogo, o ID 004 cobre tanto o formulário vinculado ao `expectedScope` de A quanto a closure stale de logout depois de a sessão mudar para B; nenhum dos dois caminhos pode alterar B. O ID 009 cobre a alteração sensível e o logout offline sem mutation pausada: a tentativa de logout emite uma request e, depois da reconexão, zero request tardia. A matriz publicada anterior passou em 91/91 execuções, sendo 32/32 da FEAT-003, antes dessas extensões de logout. Para o snapshot P2 local, a rodada pós-ajuste de logout passou em 65/65, a suíte unitária integral passou em 578/578 testes de 60 arquivos e a matriz Playwright/axe integral passou em 91/91 numa única execução de 3,9 minutos, incluindo 32/32 da FEAT-003. O ID 004 passou em 3/3 projeções com `409` para o logout stale, sessão e perfil de B intactos e zero `pageerror` ou erro React; o ID 009 passou em 4/4 com falha offline imediata, exatamente uma request e nenhum POST tardio após reconexão. Lint, typecheck, audit com zero vulnerabilidade e Knip também passaram. Os builds Next.js 16.3 de web/backoffice ficaram verdes sem warnings, com manifests standalone, 17 arquivos obrigatórios e `BUILD_ID` local em cada app; os smokes validaram live/ready/root, CSP, `no-store`, assets, nonces, probes adversariais, `/entrar` 200 no web e 404 no backoffice. Lockfile/gerados ficaram inalterados, portas/processos sem resíduo e os logs têm hashes `2e3b…4310` e `c9e5…da97`. Nova release, publicação e revisão continuam pendentes.

Em toda execução com navegador, o ID 004 recebe uma sentinela exclusiva em `FEAT003_REPORT_SECRET_SENTINEL`. A saída capturada, o relatório HTML e a árvore de resultados Playwright devem passar por varredura negativa exata dessa sentinela e da senha derivada; ocorrência em qualquer um desses destinos falha a execução. O helper de troca de sessão recebe a credencial somente como argumento de um step `evaluate` estático, não a devolve e converte falhas de avaliação ou contrato em mensagens constantes. Na evidência integral publicada anterior, os 62 e-mails QA únicos ficaram restritos a 102 títulos automáticos allowlisted. No snapshot P2 corrente, a auditoria terminou com zero resultado inesperado, flake, skip, erro ou attachment e zero ocorrência de sentinelas, tokens, cookies Auth ou documentos crus. Os mesmos 62 e-mails QA únicos apareceram em 114 títulos allowlisted: `Fill` 84, `Visible` 18, `Count` 4 e `Type` 8. O cleanup de banco, Mailpit, portas e processos terminou sem resíduos.

## 7. Testes de banco

SQL/integration deve provar:

- migration from zero;
- grants manifest;
- `TEMPORARY` ausente efetivamente para `PUBLIC`, `app_dal` e login runtime, sem remover grants explícitos administrados pela stack;
- RLS A/B;
- personas adversariais owner/admin ainda sob `authenticated`: somente dados próprios em `profiles`, `user_preferences` e `get_my_profile()`, sem escrita direta nem acesso às rotinas privadas; comandos positivos exclusivamente por `app_dal`, sem antecipar FEAT-004/031;
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

No snapshot P2 corrente, reset e geração alcançaram o head `20260811000500`; as três suítes pgTAP passaram em 158 + 78 + 57, totalizando 293/293 asserts, e a inspeção final encontrou zero resíduo.

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
