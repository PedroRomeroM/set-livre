# Mudança: FEAT-004 — ativação de dono e onboarding de recebedor

- Data: 2026-08-12
- Autor/agente: Codex
- Issue/PR: [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6)
- Features: FEAT-004
- ADRs: ADR-003, ADR-004, ADR-005, ADR-009, ADR-011, ADR-013, ADR-015, ADR-016, ADR-017 e ADR-018
- Risco: alto — nova autoridade de dono, integração financeira privada, RLS e elegibilidade futura de reserva
- Rollback: reverter a fatia antes de qualquer ambiente remoto; depois de aplicar schema, corrigir exclusivamente por migration append-only

## Resumo

Esta mudança implementa a terceira fatia vertical da plataforma: aceite e ativação do perfil de dono, primeiro recorte server-only de `PaymentProvider`, onboarding local determinístico de recebedor e leitura factual do status próprio. A integração externa permanece bloqueada para release por PEND-004 e não é simulada como produção.

## Motivo

A FEAT-004 é a próxima feature da sequência executável após a conclusão e o merge da FEAT-003. Ela cria a autoridade de dono e o contrato mínimo de recebedor realmente consumidos pela futura criação de estúdio e pelo checkout, sem antecipar cartão, PIX, split, refund, payout, backoffice ou direitos LGPD completos.

## Comportamento anterior

- toda conta autenticada possui identidade e perfil, mas nenhuma autoridade canônica de dono;
- não existem `owner_profiles`, recebedor privado, read model de onboarding nem comandos do domínio;
- as personas owner/admin dos pgTAP anteriores são apenas metadata adversarial e continuam sem papel de negócio;
- `PaymentProvider` existe somente como contrato documental e PEND-004 permanece aberta;
- não existem `/dono` nem `/dono/recebimentos`.

## Comportamento novo

- o titular de um perfil completo aceita a versão local vigente do contrato do dono e cria uma única autoridade canônica em `owner_profiles`;
- um adapter local determinístico implementa exclusivamente o recorte de onboarding/status do recebedor em `local | test`;
- o estado comum expõe `recipientOnboardingCapability: "local_adapter" | "unavailable"`, derivado no servidor a cada request: `local | test` habilitam o adapter local; `development | production`, `APP_ENV` ausente ou inválido falham fechados como indisponíveis;
- provider IDs e requisitos sensíveis permanecem privados, enquanto a UI recebe apenas status internos, requisitos e próximos passos allowlisted;
- retentativas usam chave UUID, locks e fences de versão/sequência; mudanças de sessão falham fechadas;
- `/dono` e `/dono/recebimentos` implementam loading, refetch, vazio, erro, timeout, conflito, sucesso e recuperação em composições desktop/mobile; quando a capability está indisponível, o estado factual continua consultável, mas nenhum início ou refresh é oferecido.

### Correções locais do primeiro review draft

O review Codex do HEAD publicado `07dcbb06b4f07fdb477211c90c77e0aed759a0cb` terminou em `2026-08-12T12:32:57Z`, sob o ID `PRR_kwDOTyzZrs8AAAABJQvhhQ`, com dois P2. O primeiro identificou que a leitura de recebimentos carregava desnecessariamente o corpo jurídico de até 200.000 caracteres. O segundo identificou que uma resposta `VALIDATION_FAILED` causada por estado stale podia oferecer nova tentativa do mesmo POST sem revalidar o fato canônico.

As correções foram publicadas no commit funcional `79376b62bdce788c9eb7e1f1696d5acfde0cb215`. A migration append-only `20260812000200_owner_recipient_projection_split.sql` preserva a migration aplicada anterior, renomeia sua projeção completa para `get_owner_activation_status()` e recria `get_owner_recipient_status()` como tuple compacta de 16 colunas. `/dono` e `GET /api/owner/activation` usam as 21 colunas necessárias para renderizar e aceitar o contrato; `/dono/recebimentos`, `GET /api/owner/recipient` e os retornos de `start | refresh` não transferem título, versão textual, hash nem corpo Markdown.

No cliente, `CONFLICT` e `VALIDATION_FAILED` sem `fieldErrors` fecham a repetição e exigem um GET autoritativo. Somente validação realmente vinculada a campo permanece editável. O cenário `SL-F004-E2E-004` agora usa dois contextos concorrentes: a aba stale precisa receber `409`, manter zero GET até a decisão explícita, executar exatamente um GET de recuperação e não repetir o POST. A matriz final daquele delta executou e aceitou essa extensão.

### Correção e publicação do segundo review

As duas threads anteriores receberam resposta e foram resolvidas: `PRRT_kwDOTyzZrs6YkS9P` por `PRRC_kwDOTyzZrs7gw9tM` e `PRRT_kwDOTyzZrs6YkS9Y` por `PRRC_kwDOTyzZrs7gw-TX`. O review `PRR_kwDOTyzZrs8AAAABJV08Cw`, submetido em `2026-08-12T22:59:35Z` sobre o commit `3e3f866c42302df9b0499e9af75575c7c092f3f0`, abriu o P2 `PRRT_kwDOTyzZrs6YwM7k`, comentário original `PRRC_kwDOTyzZrs7gxI26`/REST `3770977722`, em `owner-service.ts` linhas 107–112. A thread recebeu a resposta [`PRRC_kwDOTyzZrs7h4a21`](https://github.com/PedroRomeroM/set-livre/pull/6#discussion_r3789663669), REST `3789663669`, em `2026-08-15T15:36:08Z`; a resposta foi verificada na própria thread, que `PedroRomeroM` então resolveu ainda atual e com `isOutdated=false`.

O banco já distinguia contrato do dono não vigente por SQLSTATE `42501` e mensagem `owner_contract_not_current`, mas o serviço agrupava esse caso com bloqueios reais e devolvia `403 FORBIDDEN`. O patch local agora traduz somente a combinação exata para `409 CONFLICT`; todo outro `42501`, inclusive `owner_blocked` e `recipient_blocked`, permanece `403`. O cliente e o E2E já possuíam o boundary verification-first de `CONFLICT`, portanto o delta não cria replay nem altera a composição visual.

### Correção local do terceiro P2

A leitura seguinte do review abriu `PRRT_kwDOTyzZrs6ZhR_d`, comentário `PRRC_kwDOTyzZrs7h4jT7`/REST `3789698299`, em [`discussion_r3789698299`](https://github.com/PedroRomeroM/set-livre/pull/6#discussion_r3789698299). A migration inicial usava a `idempotencyKey` do browser como `audit.events.request_id` na ativação/renovação e na transição do recebedor; assim, a resposta/log da API e o fato persistido não compartilhavam a mesma correlação.

O patch local separa os contratos de ponta a ponta. A rota mantém o `requestId` HTTP fora do payload de domínio; serviço e DAL o encaminham em parâmetro próprio, enquanto a chave do envelope continua responsável apenas por replay. A migration append-only `20260815000100_owner_audit_request_correlation.sql` adiciona `audit.events.idempotency_key NOT NULL`, troca a unicidade para `(action, target_id, idempotency_key)` e substitui as assinaturas privadas de ativação/aplicação. Para linhas legadas, o valor antigo de `request_id` é copiado para `idempotency_key` e preservado no campo original: ele representa a chave antiga, e a correlação HTTP histórica verdadeira não pode ser reconstruída.

### Correção local do quarto P2

O review `PRR_kwDOTyzZrs8AAAABJrjWnQ`/REST `4944615069`, submetido em `2026-08-15T20:02:30Z` sobre o commit `11464a37593d510f5774af6af6fe655e671a9c35`, abriu a thread `PRRT_kwDOTyzZrs6ZigTV`. O comentário `PRRC_kwDOTyzZrs7h6SPS`/REST `3790152658`, ancorado em `src/domains/owners/components/owner-recipient-panel.tsx` linhas 707–708 do lado direito, registrou que o CTA local ainda podia aparecer em um ambiente sem integração externa. Na captura, a [thread](https://github.com/PedroRomeroM/set-livre/pull/6#discussion_r3790152658) estava atual (`isOutdated=false`) e não resolvida.

A correção não antecipa provider externo nem muda `providerMode`, `nextAction` ou fatos persistidos. O estado comum das projeções de ativação/recebimentos e dos três retornos POST recebe a capability obrigatória derivada no servidor. `recipient.onboarding.start` e `recipient.onboarding.refresh` recusam `unavailable` com o `503 PAYMENT_PROVIDER_UNAVAILABLE` seguro já existente antes de `prepare`, de reservar operação ou de chamar adapter. A UI preserva o estado somente para consulta e não renderiza notice local, CTA de início/refresh, provider falso ou controle desabilitado.

## Arquivos/componentes

Implementados: contratos estritos em `packages/contracts/src/owner.ts`; domínio server/client em `src/domains/owners`, inclusive derivação server-only da capability; renderer jurídico compartilhado em `src/domains/legal`; rotas `/dono`, `/dono/recebimentos`, `GET /api/owner/activation` e `GET /api/owner/recipient`; registry modular em `src/domains/commands`; migrations append-only, seed local, pgTAP `0004`, helpers e quatro specs FEAT-004. Os DALs de comando usam um pool restrito compartilhado; web/readiness/backoffice conservam `6 + 2 + 2 = 10`, sem ampliar o teto do login runtime. O quarto P2 não cria migration, coluna ou configuração pública.

## Banco, migration, grants e RLS

A migration `20260812000100_owner_onboarding_recipient.sql` é a décima terceira da cadeia. Ela cria autoridade de dono, recebedor seguro, operações privadas e fatos mínimos de aceite/auditoria; comandos entram por quatro funções concedidas à `app_dal`, e os read models `security invoker` filtram por `auth.uid()`. O contrato jurídico ganha kind `owner_contract` em RPC autenticada própria, sem ampliar `get_current_legal_terms()` nem a leitura anônima do cadastro. Nenhum schema de estúdio, checkout, repasse ou papel administrativo foi antecipado.

Reset e geração passaram no head `20260812000100`. As quatro suítes pgTAP passaram em 355/355 asserts (`158 + 78 + 57 + 62`); a `0004` cobre ACL/RLS, A/B, personas owner/admin sem bypass, ativação/prepare/apply, renovação, drift, bloqueio, concorrência com a mesma chave e replay. O cleanup final comprovou zero linha nas 15 relações inspecionadas, zero fixture nos dez checks, zero órfão e zero sessão dblink; uma mensagem Mailpit da fixture concorrente foi removida por ID exato, terminando em 0/0.

A correção P2 adicionou `20260812000200_owner_recipient_projection_split.sql` como a décima quarta migration, sem editar `20260812000100`. Na fotografia histórica desse P2, a árvore e o contrato de head apontavam para `20260812000200`. Uma tentativa posterior ao ajuste literal foi recusada sob Node 22 pelo `devEngines`, antes de alcançar SQL; em seguida, Node 24 passou reset, geração e `test:db` com os mesmos 355/355 asserts. Readiness aceitou aquele head e recusou `20260812000100`; o probe transacional/pgTAP comprovou 21 colunas com corpo em ativação e 16 sem corpo em recebimentos. Os artefatos gerados ficaram sincronizados, e a inspeção final terminou com zero linha nas 15 relações, zero fixture nos dez checks, zero entre quatro classes de órfão, zero sessão dblink e Mailpit 0/0.

A terceira correção acrescenta `20260815000100_owner_audit_request_correlation.sql` como a décima quinta migration, sem editar as catorze anteriores. Um único reset, geração e `test:db` passou em 358/358 (`158 + 78 + 57 + 65`) no novo head. Readiness aceita `20260815000100` e recusa `20260812000200`; o trigger permanece habilitado, os overloads antigos estão ausentes, os novos grants são exatos, gerados/diff estão sincronizados e as tabelas verificadas terminam em zero.

## Segurança e privacidade

O provider é chamado somente no servidor. Identificadores externos, payloads, KYC e dados bancários completos não entram em DTO, cache, DOM, URL ou log. `expectedScope` repete o recorte SSR somente como asserção; a sessão validada continua sendo a autoridade. As quatro specs FEAT-004 desativam trace, screenshot e vídeo porque o provisionamento atravessa PII sintética e referências privadas; a evidência usa asserções semânticas e varreduras negativas, sem persistir esses artefatos.

A classificação adicional também permanece fail-closed: ela exige simultaneamente o SQLSTATE e a mensagem privada allowlisted, não expõe essa mensagem ao cliente e não converte um `42501` desconhecido ou de bloqueio em conflito recuperável.

`recipientOnboardingCapability` é calculada no servidor, nunca aceita do navegador e não revela configuração ou prontidão de provider. A allowlist habilita apenas `APP_ENV=local | test`; `development | production`, valor ausente ou inválido resultam em `unavailable`. A recusa acontece antes de `prepare`, reserva de operação, DAL ou adapter, sem criar efeito financeiro ou fato novo.

## Read models, comandos e invalidação

`owner.activate`, `recipient.onboarding.start` e `recipient.onboarding.refresh` estão no registry privado com retorno autoritativo, idempotência explícita e invalidação de query keys escopadas por usuário. `recipient.bank.update` fica diferido até existir token ou handoff provider-owned aprovado. A elegibilidade exige dono ativo, contrato vigente aceito, recebedor ativo e a mesma versão de perfil sincronizada; nova versão contratual preserva o histórico e exige novo aceite. A FEAT-020 revalidará o fato antes da cobrança.

As projeções SQL mantêm seus fatos canônicos e tuples de 21/16 colunas; a camada HTTP enriquece ambas, e também os três retornos POST, com a capability obrigatória. Ela não recalcula `providerMode` nem `nextAction`. Quando `unavailable`, `start | refresh` retornam `503 PAYMENT_PROVIDER_UNAVAILABLE` antes de preparar ou reservar uma operação; as leituras continuam disponíveis.

Na preparação do recebedor, `owner_contract_not_current` é uma corrida corrigível por releitura, não uma proibição de autoridade: a API responde `409 CONFLICT`, o CTA fica desabilitado e somente um GET explícito pode reabrir o fluxo. Bloqueio canônico continua terminal em `403 FORBIDDEN`.

Os read models autenticados de ativação e recebimentos possuem deadline interno de 2.000 ms. Ambos combinam signal externo com um `AbortSignal` próprio, fazem race contra transporte não cooperativo, limpam o timer em todo desfecho e ignoram resolução/rejeição tardia; assim, o timeout de dez segundos do browser não é a única proteção das requests SSR. A key privada também inclui a projeção (`activation | recipient`), impedindo que o DTO completo e o compacto compartilhem cache.

## UX, mobile e acessibilidade

O checklist factual, o contrato vigente, o CTA derivado do requisito pendente e as mensagens seguras do adapter estão implementados nas duas rotas. Os estilos e as specs cobrem os contratos de 320 px, zoom de 200%, teclado, touch de 44 px, axe e reflow; os sete IDs foram promovidos a automatizados após as matrizes browser limpas descritas abaixo. Nenhuma tela afirma aprovação real de gateway.

Com `local_adapter`, `/dono/recebimentos` conserva o notice e os CTAs locais compatíveis com `nextAction`. Com `unavailable`, omite notice e CTAs de início/refresh e apresenta um alerta `role=status` com o título **Cadastro de recebimentos indisponível** e o corpo **A integração de recebimentos ainda não está disponível neste ambiente. O estado atual permanece somente para consulta.** O fato canônico permanece visível; não há botão falso nem controle desabilitado que sugira integração externa.

Após resultado ambíguo, `Verificar estado atual` fecha a superfície privada enquanto o `GET /api/owner/recipient` está em curso. Se a leitura autoritativa passar, o foco programático retorna ao heading do checklist; se falhar, a UI mantém apenas a mensagem segura e foca seu alerta. A partir desse alerta, `Tentar novamente` usa o mesmo intent: fecha a superfície no novo GET e devolve o foco ao heading somente após sucesso. Os IDs 004/007 exigem `toBeFocused()` no heading após a recuperação bem-sucedida, sem reenviar o comando anterior; o ID 007 também cobre GET 503, retry, GET real 200 e heading focado.

Anônimos em `/dono` e `/dono/recebimentos` chegam a `/entrar` com a query `retorno`; a allowlist aceita literalmente somente essas duas rotas e as superfícies `/conta*` já existentes. Após validação, o payload usa `returnTo`. Sucesso e resultado ambíguo preservam o destino aprovado, enquanto vetores de open redirect falham fechados.

## Testes e IDs QA

No snapshot publicado anterior ao primeiro review draft, os IDs `SL-F004-E2E-001` a `007` permanecem estáveis e foram automatizados pela matriz específica final. Os testes unitários de contratos, mapper/provider, serviço, DAL, API, cache e UI passaram na suíte integral final pós-código em 707/707. A rodada estática de privacidade passou em 11/11; format, ESLint, typechecks, docs:check, audit com zero vulnerabilidade, Knip, a coleta estática dos 23 testes Playwright e o diff-check também passaram.

A primeira tentativa da matriz Playwright foi interrompida com uma falha e 22 testes não executados porque um locator textual era ambíguo; ele foi corrigido com `exact: true`. A execução seguinte chegou ao ID 005 e terminou com 7 testes passados, uma falha e 15 não executados: após o hard reload, o oráculo tentou `fulfill` do POST já tratado e recebeu `Route is already handled`. Esses dois desfechos permanecem como histórico diagnóstico inconclusivo e pertencem ao oráculo, não ao comportamento do produto.

Antes dessa falha do oráculo, o trecho browser do ID 005 comprovou um GET de B retido na página e no `QueryClient` de A, fechamento pelo boundary, desconexão da superfície A observada no `pagehide`, recomposição SSR somente com B e zero `pageerror`/erro React. A garantia complementar de callback tardio é unitária: usa `MutationObserver` real e latch para impedir publicação após a transição, e prova separadamente que a key de A não é recriada depois do seed autoritativo de B. As quatro specs continuam cobrindo critical, regression, accessibility e reflow sem persistir trace, screenshot ou vídeo.

A invocação final pré-review das quatro specs passou em 23/23, exit `0`, em cerca de 2,0 minutos, distribuída por 14 projetos; os IDs 001–007 somaram respectivamente `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório terminou com zero resultado inesperado, skip, flake, erro ou attachment. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos tiveram 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP. Banco, Mailpit, portas e processos terminaram sem resíduo. O `index.html` histórico possui SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`. Essa evidência pertence somente à fotografia anterior ao review.

A primeira matriz Playwright integral posterior terminou funcionalmente em 114/114, mas sua evidência foi rejeitada pela auditoria de privacidade: 18 telefones QA apareceram em 61 títulos automáticos `Fill` e quatro snippets. O helper foi corrigido para aplicar o setter nativo e disparar `InputEvent` dentro de `Locator.evaluate`, sem passar o valor por `fill`; os sete call sites foram migrados para esse caminho redigido. A prova estática pós-patch passou em 11/11, e lint, Prettier e typecheck dos testes ficaram verdes. Essa execução permanece somente como diagnóstico histórico.

Na mesma fotografia pré-review, a invocação integral final passou em 114/114, cerca de 5,9 minutos, 17 specs e 16 projetos. Não houve resultado inesperado, skip, flake, erro, attachment ou mídia. A FEAT-004 manteve 23/23, com os IDs 001–007 distribuídos em `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório histórico tem SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`.

A auditoria integral encontrou zero ocorrência dos 28 telefones QA, inclusive formatos e sequências, zero `Fill`/`Type`/`PressSequentially` sensível e zero sentinela, token, cookie Auth, URL de banco, referência privada do provider ou documento QA. Os 88 e-mails QA únicos tiveram 140 ocorrências somente em títulos allowlisted: FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Banco, Mailpit, portas e processos terminaram em zero.

### Evidência integral anterior ao novo P2

Node 24 passou toda a cadeia do commit posteriormente revisado `3e3f866c42302df9b0499e9af75575c7c092f3f0`: format, lint com zero warnings, typecheck integral, 716/716 unitários em 74 arquivos, docs:check em 34 features/200 cenários/18 ADRs, audit com zero vulnerabilidade, Knip e diff-check; o banco permaneceu em 355/355. A execução focada única passou em 23/23, quatro specs, 14 projetos e 126,0 segundos, com IDs `3 + 3 + 3 + 4 + 3 + 4 + 3` e zero resultado inesperado, flake, skip, erro, retry ou attachment. SHA-256: relatório `64f80b00b8846a8157fe31708f95c28203ec5a843d383a75ae5b846e823c6df5`, `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903` e stdout `9937c3af59131be284ad176f49c289cc6e713e77e20bc015c436f42c06abf757`. A auditoria aceitou 26 e-mails em 26 títulos `Fill`, com privacidade e cleanup verdes. Esses resultados não validam o patch local posterior.

O guard integral coletou 114 testes em 17 specs; a execução única passou em 114/114 por 16 projetos, em cerca de 5,7 minutos, com zero resultado inesperado, flake, skip, erro, retry ou attachment. A FEAT-004 preservou 23/23 e a mesma distribuição. SHA-256: relatório `c2143d928e122aef944ead5c5999287828446c5f1d081c11daa0a33240f7f66f`, `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`, stdout `27092f939a36f3dde07eeb3c27ec3bf52cace5d034243591ad04748b0f3fe559` e lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`. A auditoria encontrou zero dado sensível e zero telefone; os 88 e-mails tiveram 140 ocorrências apenas em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8, `Expect` 22. As 15 relações do banco, Mailpit, dblink, portas, processos e temporários terminaram em zero.

O build canônico pós-review foi executado uma única vez em Node 24: `npm run build` terminou com exit `0`, 26 rotas web e quatro do backoffice, sem rerun; log SHA-256 `ae46bace1364f77876042025799515a6be0f78ef48afea0d6f343c12ed0d7e68`. Os artefatos auditados ficaram em web `1.576 + 1`, hash `e62803b6…`, e backoffice `1.275 + 1`, hash `a905ef2f…`; o agregado técnico permaneceu estável em `960cc18a…`.

O smoke runtime final autorizado terminou com exit `0`; log SHA-256 `85db0dad1e7cbd999e4427222fdd1b685a3747ffde154eb5a46b444e9cf8f735` e server log redigido `4da1f9af3e0bb34285be99be0ef71d4cefa22108bbe817c23c4c8983828755bf`. Root/prefetch, API, erros globais, live/ready, estáticos, probes adversariais, CSP/nonces, admin e isolamento entre apps ficaram verdes, com 14 nonces web e 11 backoffice únicos. Os GETs guest de ativação/recebimentos retornaram `401 UNAUTHENTICATED` com UUID; `/dono` e `/dono/recebimentos` produziram redirects streaming exatos; o POST sintético com Host/Origin exatos e sem cookie retornou `401` com UUID. As 15 relações ficaram `0 → 0`; dois secrets canônicos, PIDs, portas e temporários terminaram em zero.

Duas tentativas do harness customizado foram recusadas antes de qualquer spawn, servidor ou request: primeiro pela ocorrência pública de `E2E_BASE_URL`, depois pela ocorrência rastreada de `E2E_DATABASE_URL` em `package.json`. O scanner final, ciente de paths e da ocorrência canônica exata, passou; a URL administrativa E2E apareceu somente no `package.json` rastreado esperado. Esses rejects são diagnóstico do harness e não runs de smoke.

O commit funcional local `440c81f6cc44cc95ed281d84e9a5124ae98a59c4` foi processado pelo gerador uma única vez. A invocação terminou com exit `0`, e seu log tem SHA-256 `be9e2e2d0d1d2a4db78593c03858c183f93b3ed336bd820d3ce9d64c08ec1ba4`. O archive canônico local histórico `.artifacts/set-livre-440c81f6cc44cc95ed281d84e9a5124ae98a59c4.tar.gz` possui 24.902.563 bytes e SHA-256 `f52210ee52a73a7fda68ee7bf389c4c26e7bd896c4c61f5775ca72ee42913b59`; o sidecar tem SHA-256 `a8082ee69d311a46c8e323913f1aa13d62c726e7b4206942c4309d2c6f56fb4e`. O manifesto possui 681.311 bytes e SHA-256 `99d673708449287898424deec5188318d3fa329101a704dfd67859fabaf47b82`.

O tar contém 3.453 membros — 584 diretórios, 2.867 arquivos e dois links —; manifesto e árvore final cobrem 2.869 folhas: web 1.577, backoffice 1.276, migrations 14, lockfile 1 e manifesto 1. Os `BUILD_ID` de ambos os apps equivalem exatamente ao commit, o head empacotado é `20260812000200`, e a plataforma registrada é Linux x64 com Node 24.18/npm 11.19. Tar, sidecar, smoke canônico embutido, guardas de segurança, buscas de secrets/PII e cleanup ficaram verdes. Essa release inclui o segundo P2 e é sua fotografia canônica local histórica, sem equivaler a ARM64 ou produção; PEND-003 e o smoke ARM64 nativo permanecem pendentes. A release `79376b62...` permanece histórica.

### Evidência integral histórica do segundo P2

Naquele patch, Node 24 passou format, lint com zero warnings, typecheck integral, 718/718 unitários em 74 arquivos, docs:check em 34 features/200 cenários/18 ADRs, audit com zero vulnerabilidade, Knip e diff-check. Um único `supabase:reset` seguido de um único `test:db` passou em 355/355, com readiness, resíduos e gerados limpos.

A matriz focada foi executada uma única vez e passou em 23/23, quatro specs e 14 projetos. SHA-256: relatório `66a4b5ceea14c7affa848748c525adccf684641b377f755a3a9ce3fb05aec6c6`, stdout `ba57e0bd52d165bf422fccc6500eb4fb920c48f785a226baac24e8265c11fe0c` e lista `ed851b7bca361d0e3e50b5632f12251859b5098a12123a2ee2b8ebbb6f11bf59`. O guard integral coletou 114 testes em 17 specs; uma única execução passou em 114/114 por 16 projetos, preservando 23/23 da FEAT-004. SHA-256: relatório `b68c70ff6f17f55142d11394dd9b6113958a7e49ef82d2c5c70324dfcafe6227`, stdout `7b8b7971f91e8a571cec6ac8bb63fed665bbfcd1b9ead4997a6e0436b76114bc` e lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`. Privacidade e cleanup ficaram verdes, sem secrets, PII, resíduo de banco, Mailpit, dblink, portas, processos ou temporários.

O build histórico foi executado uma única vez, terminou com exit `0` e sem warnings; log SHA-256 `db0d0049b248dd7b3d438d57ffa0faa465d3cd7a15a9bdd0d6267dc11a4ac162`. O smoke real histórico, padrão mais FEAT-004, também terminou com exit `0`: resumo SHA-256 `a8d41974344ba6eb3b6cb83d626e4b77e9853a2d98e58814d9c795cca356ad0b`, stdout `e15829cc6525d58cab4fa2ed49c33d9e5d6225512b77ec96a21fa2ea3b9703dba` e server log redigido SHA-256 `7ea7719b4af0257044c24c32f252f9327920a069d74b31cac25d3f23d8f089c5`. O contrato passou com 14 nonces web, 11 backoffice, três boundaries e dois redirects; as relações ficaram `0 → 0`, e Mailpit, portas, processos, temporários, secrets e PII terminaram em zero.

Por transparência, a primeira tentativa do runner temporário foi recusada antes de spawn porque o harness consultava `profile_preferences` em vez de `user_preferences`; log SHA-256 `9757fbc1baf5afcffc4840468f7f7af5c7c1677a924997184376617b8752e2db`. Não houve servidor, request ou temporário residual. A correção foi somente no harness e antecedeu a única execução real verde. A release `79376b62...` continua histórica; a release canônica local `440c81f6...` contém o patch, e o commit documental publicado `011a48f4...` registra essa evidência.

Esses hashes de gates, browser, build, smoke e release pertencem ao segundo P2 e não validam a correção de auditoria. O terceiro P2 possui novas execuções próprias, registradas abaixo; a coincidência das cardinalidades 718/718 e 114/114 não transforma os artefatos antigos em evidência do novo delta.

O snapshot funcional foi congelado no commit `c115dcd726929f289777cd897cccc97d33a179ee` e gerou `set-livre-c115dcd726929f289777cd897cccc97d33a179ee.tar.gz`, com 24.891.031 bytes e SHA-256 `484d60e67f17768688619acf58b998a43fabc2420e9dd8b221f17a112e9aaa6c`. A árvore contém 2.859 payloads: web 1.568, backoffice 1.276, migrations 13, lockfile 1 e manifesto 1. O manifesto possui 678.902 bytes e SHA-256 `a62f1d4c4aaf317ce5d74232a959adff01367f863efe8f7b8de3fb17b89ee018`; os `BUILD_ID` equivalem ao commit, e o head empacotado é `20260812000100_owner_onboarding_recipient.sql`.

O smoke padrão daquele gerador passou. A auditoria integral encontrou correspondência exata entre tar, staging e manifesto e terminou `NO-BLOCKER` somente para aquela release local Linux x64, Node 24.18/npm 11.19. As varreduras canônicas antes e depois do smoke não encontraram segredo de runtime nem PII de cliente/QA. O snapshot permanece histórico e stale, anterior aos dois P2, e não aprova produção ou ARM64.

### Evidência histórica de fechamento local do terceiro P2

Em Node 24, `npm ci` concluiu com 447 pacotes e auditoria em zero. Format, lint, typecheck, os quatro unitários focados em 42/42, a guarda estática de privacidade em 12/12, a suíte unitária integral em 718/718 por 74 arquivos, docs:check em 34 features/200 cenários/18 ADRs, `npm audit` em zero, Knip e diff-check passaram. A cadeia final de banco permaneceu em uma única execução: reset, geração e 358/358 pgTAP (`158 + 78 + 57 + 65`) no head de 15 migrations `20260815000100`, com readiness, overloads/grants, gerados e cleanup corretos.

A focada P3 anterior permanece verde em 23/23. Uma primeira integral do snapshot ainda sem a correção do oráculo terminou em 79 passados, uma falha e 34 não executados no `FOUNDATION-E2E-008` WebKit por navegação HMR na mesma página. Ela não foi repetida, permanece diagnóstico histórico e possui relatório SHA-256 `ac669d0a2f8056e1b68c44317e9e679cc367daeb5c9a71435ba2f1e6d40ca7ff`. O teste foi corrigido para usar páginas distintas; o arquivo resultante possui SHA-256 `7ae803488af54ea58bd06be7820c69c69460ed9038b1b9a5f17e5507d24999a7`, e o recorte crítico corrigido passou em 3/3.

A integral corrigida passou exatamente em 114/114, 17 specs e 16 projetos, preservando 23/23 da FEAT-004. Privacidade e cleanup ficaram verdes. SHA-256: relatório `5abbdc7696273dcf24df6353dea014f9e6dc0738824783171e978cf19d8c2e44`, stdout `a630adc06adb9d461bb9b2fa7d2cc43d8dcf8470312b19b517178ca4f409d678`, lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6` e `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`.

O build daquela fotografia foi executado exatamente uma vez e passou com exit `0`, 26 rotas web, quatro do backoffice e zero warning; log SHA-256 `8677b868a632e0891499c8450e5c926ddefcde7e27c5d31f9adcb55e27bbfaa2`. O smoke customizado do mesmo snapshot também foi executado exatamente uma vez e passou com exit `0` em 2,4 segundos: três probes guest `401` com UUID, dois redirects exatos, 14 nonces web, 11 do backoffice, banco/Mailpit `0 → 0`, privacidade e cleanup verdes. SHA-256: stdout `399d3b41dd9d161bdd86288c53e5bf821279285eb4772740c9ff5169845e5abd`, server log `e3c376cdc9403d2739ea8f127244fef193ea0ad4689694fec5c8a097d5ee025b` e resumo `25262fb6efbf93a0a654a16171bc4f6998000ef0078b9d91e40a06beefe79450`. Esses resultados são históricos e não validam o quarto P2.

### Release canônica final do terceiro P2

A release canônica local final foi gerada e auditada para o commit funcional `2a86acc4dc3a005213d5f22384084e3aba0160be`. O archive possui 24.903.588 bytes e SHA-256 `0e0c07f41d4a44f0673ce7a5013084942100e8baab1ba72ee6aeea6496be1566`; o sidecar, 124 bytes e SHA-256 `1136df426039335971d515497ce8974dcb25ee583f3764d5c33f9ea1f76ca0ab`; o manifesto, 681.529 bytes e SHA-256 `d3bfb5a5c517edab1004bde6eaf04c7f080c3036c94defbbfa1b82fad44d4d44`; e o log, 2.099 bytes e SHA-256 `e7edaa919daa3b3ed4cd6cf1588c044d2a6efcf1ae84e9877edd5fa42062371e`.

A árvore contém 2.870 artefatos — web 1.577, backoffice 1.276, migrations 15, lockfile 1 e manifesto 1 —, e o tar contém 3.454 membros — 584 diretórios, 2.868 arquivos e dois links seguros. Os `BUILD_ID` dos dois apps equivalem ao commit funcional. O head empacotado é `20260815000100`, com prefixo SHA-256 registrado `ca995243...`; o lockfile possui prefixo SHA-256 `485ec8e7...`. Em Linux x64 com Node 24.18/npm 11.19, smoke embutido, varreduras de secrets/PII e cleanup final ficaram verdes; duas auditorias independentes terminaram `NO-BLOCKER`. Esse “final” descreve o artefato funcional local do P3, não ARM64, produção, publicação, feature concluída ou merge.

### Evidência local do quarto P2

No fechamento em Node 24, `npm ci`, format, lint, typecheck, 734/734 unitários em 74 arquivos, docs:check 34/200/18, audit com zero vulnerabilidade, Knip e diff-check passaram. Entre as provas estão `derives APP_ENV=%s as capability %s`, a recusa `before reserving an operation`, o enriquecimento de read model com `local_adapter | unavailable`, o campo obrigatório no contrato HTTP e os helpers de UI independentes para start/refresh. Reset, geração e `test:db` passaram em 358/358 (`158 + 78 + 57 + 65`), com 15 migrations e head `20260815000100`.

O ID estável `SL-F004-E2E-004` foi estendido, sem criar novo ID nem mudar os totais do catálogo. O oráculo alterna somente a capability sobre estados factuais de `start_onboarding` e `refresh_status`, exige alerta/copy exatos e ausência dos CTAs em `unavailable`, verifica zero POST indevido e restaura os controles ao retornar para `local_adapter`. A rodada focada passou em 23/23, quatro specs e 14 projetos; SHA-256: auditoria `49d457c85e3489703ce1c316e83228e40b003d384b492d86830676b832262c0b`, stdout `f525446c0f4b5e61f32179e4d8cdb94e3f3ccc79601be889dfd30d79d3574e2b`, relatório `112ff3b8603ed644260e94218a66bbd96c6f2fc80e7b806ff61a54a29ef984a3` e lista `7946ed316c84b9992b202787c7db937620b84769b14a6edef790d7791ee8f6af`. A integral passou em 114/114, 17 specs e 16 projetos, preservando 23/23 da FEAT-004; SHA-256: auditoria `438da6bc8f6a557d9e97006a94dc3ce31505b9d061718c6c9b7b51e493bee8aa`, stdout `c6a76b42d4fc838c7c7b2b84fede68da343f933b9602e2a23cd6c24ccedf2d7e`, relatório `8bd8f19266a9ce8dee5aefafa52059835fe524b2595333785019cf033409c89c` e lista `293848081639eaeb419208f3279470460638a7476e8debe752cc49933182a492`. A primeira auditoria integral terminou depois de estrutura/privacidade por `ReferenceError: mailpitTotal is not defined`; a correção apenas ligou `cleanup.mailpitTotal` ao valor já calculado, e a segunda auditoria reutilizou os mesmos artefatos com zero nova invocação Playwright. Houve uma execução Playwright, zero rerun e zero flake.

Um único build de validação passou com exit `0`, 26 rotas web, quatro do backoffice, `BUILD_ID=local` e log SHA-256 `ca7d5c3e98449ea03a4cedbc567d93f989db7dbfdac854ea1a19f40f0c26b0b3`. O smoke customizado não produziu evidência verde. A tentativa 1 foi recusada porque o oráculo tratou uma tombstone segura de `Set-Cookie` como violação; hashes SHA-256 stdout/server/resumo `e30eb0c921851fddf75c54262cf252f1aaef29bdba28b48a2d36300bc8781374`/`fa89740ce6562ae79feca91ba5653f2ef6d53cecfa221461e06820227febaf4e`/`2f1a9da9a728fd9907328a0895f7a5870e60c252b7c5138731078507c6677c81`. A tentativa 2 terminou com exit `1` apesar de cumprir o contrato completo — três boundaries, dois redirects, 14 nonces web, 11 backoffice, 15 relações e Mailpit em zero —, porque o postcheck produziu um falso positivo contra o shell pai; hashes `d845197c92915026a3879b5e16633401c84fcd8009c47f6f58deaac43fe45a1c`/`7c9b2c95dc1cf9b872ea024bfece0cb4cf54b852dd5e8c9f1a5f213115e9d42d`/`63b6748f260e43aff1ea04b58bfc613d72dd8f138b8f2bb4834caf6d5d5d93f0`. A tentativa 3 foi recusada antes dos probes porque o parser não aceitava `pgrp=0`; stdout/server `bcd359af5d25942436409dd499d03809f221e772eacf2562d4e4317ddfab4e74`/`b70a26b1f361cb3fcfc37c226743bac615afa4ded7d53aa798725badc3554235`. O cleanup terminou em zero nas três, mas nenhuma conta como smoke aprovado.

### Release canônica local do quarto P2

O gerador canônico processou exatamente uma vez o commit funcional `969f30cd0f34b7e36e2a21550b5e3f28f8709406`, terminou com exit `0` em 21,15 segundos e produziu archive de 24.904.533 bytes/SHA-256 `d5f544bff8b72314060535333cd2c300a4c56a4e35295c1471beec5ee41cfeeb`, sidecar de 124 bytes/`f3441aee4c9d6758a539b2be2b3b325805bd6d977ad2cf915619bfbb9cd4d8d3`, manifesto de 681.762 bytes/`bc13a94c4084abc46bab677d1115871cb1327d7d17172b982b886c35eb200ada` e log de 2.102 bytes/`5be766c1c967ab7840335c120f2918ff555770efd69544f164023c32378456e7`.

A árvore manifestada soma 2.871 artefatos — web 1.578, backoffice 1.276, migrations 15, lockfile 1 e manifesto 1 —, enquanto o tar soma 3.455 membros — 584 diretórios, 2.869 arquivos e dois links seguros. Os `BUILD_ID` dos dois apps equivalem exatamente ao commit funcional. Smoke embutido, varredura de secrets, paridade e cleanup ficaram verdes; duas auditorias independentes terminaram `NO-BLOCKER`. A prova é local Linux x64 e não comprova ARM64 ou produção; PEND-003 e o smoke ARM64 nativo permanecem abertos. Publicação, resposta e resolução estão registradas abaixo; novo review, espera, captura final, ready e merge continuam pendentes.

## Publicação

Na fotografia publicada do segundo P2, a branch `feat/feat-004-owner-onboarding-recipient` avançou no remoto de `3e3f866c42302df9b0499e9af75575c7c092f3f0` até `011a48f4910baa0e17b26dee6eda3c678d910572`. O primeiro era o commit avaliado pelo segundo review; `440c81f6cc44cc95ed281d84e9a5124ae98a59c4` continha o patch funcional e sua release canônica local, enquanto `011a48f4...` registrava a documentação. Naquele snapshot, HEAD local e remoto coincidiam em `011a48f4...`.

### Publicação, resposta e resolução do terceiro P2

Na captura remota verificada em `2026-08-15T19:38:32Z`, o push `3dd11cb → dda95b3` publicou o commit funcional `2a86acc4dc3a005213d5f22384084e3aba0160be` e a documentação da release até `dda95b3b9108930489a3b10275ef41c2f203ae24`. A release canônica permanece vinculada ao funcional `2a86acc4...`; `dda95b3...` é somente o head publicado daquela fotografia, não um claim de HEAD eternamente atual.

Na mesma captura, o [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) estava `OPEN`/draft contra `main@174ee16342367caedf55521227d21d5bf076b1a9`, com head `dda95b3b9108930489a3b10275ef41c2f203ae24`, `MERGEABLE`/`CLEAN`, `reviewDecision` vazio e `statusCheckRollup=[]`. `PedroRomeroM` criou a resposta encadeada na thread `PRRC_kwDOTyzZrs7h6HnW`/REST `3790109142` em `2026-08-15T19:38:32Z`. A thread `PRRT_kwDOTyzZrs6ZhR_d` ficou `isResolved=true`, `isOutdated=false`, resolvida por ele; a leitura encontrou zero threads não resolvidas e confirmou as três anteriores ainda resolvidas.

Esse estado permanece apenas como fotografia histórica do terceiro P2. A publicação atual do quarto P2 é registrada na seção seguinte.

### Review, publicação e resolução do quarto P2

O review `PRR_kwDOTyzZrs8AAAABJrjWnQ`/REST `4944615069` foi submetido em `2026-08-15T20:02:30Z` sobre `11464a37593d510f5774af6af6fe655e671a9c35`. Na captura original, a thread `PRRT_kwDOTyzZrs6ZigTV` e seu comentário `PRRC_kwDOTyzZrs7h6SPS`/REST `3790152658` estavam não resolvidos e não desatualizados.

Na captura pós-write, o push `11464a37593d510f5774af6af6fe655e671a9c35 → e51ab6fcda041e3a9571477fe696dd7ec69e87e5` publicou o commit funcional `969f30cd...` e a documentação/evidência da release canônica local, inclusive `docs/technology-stack.md`. O archive permaneceu local e ignorado pelo Git; não houve publicação em GitHub Release. A release permanece vinculada ao funcional. O [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) continuava `OPEN`/draft contra `main@174ee16342367caedf55521227d21d5bf076b1a9`, com head `e51ab6fcda041e3a9571477fe696dd7ec69e87e5` e `mergeable=true` na fotografia do connector. O body foi atualizado com o P4, as evidências, a release e o estado resolvido.

`PedroRomeroM` criou a resposta encadeada `PRRC_kwDOTyzZrs7h8CsL`/REST `3790613259` em `2026-08-16T00:43:03Z`. A thread `PRRT_kwDOTyzZrs6ZigTV` ficou `isResolved=true`, `isOutdated=true`, resolvida por ele. O script thread-aware pós-write encontrou cinco threads e zero não resolvidas; as quatro anteriores continuaram resolvidas. Não houve captura de `reviewDecision` nem de check rollup. Novo `@codex review`, espera mínima de 60 minutos, captura final, ready e merge continuam pendentes. A feature permanece **Em implementação**.

## Observabilidade e operação

Eventos operacionais allowlisted registram ação, resultado, duração e `requestId`, sem PII, payload externo ou chave idempotente. `audit.events` guarda a chave em coluna privada separada somente para deduplicação; fatos novos usam o request ID real como correlação. O adapter e o contrato `local_fixture` são recusados fora de local/test; PEND-004/PEND-006 continuam como bloqueadores explícitos de produção. Uma tentativa recusada por capability registra somente o resultado allowlisted `unavailable`, sem valor bruto de `APP_ENV`, readiness de provider ou payload de adapter.

## Documentação atualizada

Este registro acompanha FEAT-004, pagamentos, banco, API, cache, segurança, UX, observabilidade, QA, contexto, panorama factual da stack e resumo HTML no mesmo recorte.

## Rollback/correção

Antes de qualquer aplicação remota, a branch pode ser revertida como unidade. Depois de aplicar a migration local, qualquer correção estrutural usa nova migration append-only; fatos de aceite ou integração não serão corrigidos por edição manual.

## Evidência de conclusão

Os três P2 anteriores foram implementados e possuem evidência histórica própria; a release do terceiro P2 não valida a capability nova. Para o quarto P2, o fechamento estático 734/734, banco 358/358, browser focado 23/23, browser integral 114/114 e build 26 + 4 passaram. O smoke customizado não produziu uma execução aceita, mas o gerador canônico executou exatamente uma vez, aprovou seu smoke embutido e produziu a release local auditada de `969f30cd...`. Publicação, body, reply e resolução foram concluídos e verificados no head `e51ab6f...`; novo review, espera, captura final, ready e merge continuam pendentes. A feature permanece **Em implementação**, e nenhuma evidência x64 substitui PEND-003 ou o smoke ARM64 nativo.
