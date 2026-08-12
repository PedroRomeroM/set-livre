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
- provider IDs e requisitos sensíveis permanecem privados, enquanto a UI recebe apenas status internos, requisitos e próximos passos allowlisted;
- retentativas usam chave UUID, locks e fences de versão/sequência; mudanças de sessão falham fechadas;
- `/dono` e `/dono/recebimentos` implementam loading, refetch, vazio, erro, timeout, conflito, sucesso e recuperação em composições desktop/mobile.

### Correções locais do primeiro review draft

O review Codex do HEAD publicado `07dcbb06b4f07fdb477211c90c77e0aed759a0cb` terminou em `2026-08-12T12:32:57Z`, sob o ID `PRR_kwDOTyzZrs8AAAABJQvhhQ`, com dois P2 ainda abertos. O primeiro identificou que a leitura de recebimentos carregava desnecessariamente o corpo jurídico de até 200.000 caracteres. O segundo identificou que uma resposta `VALIDATION_FAILED` causada por estado stale podia oferecer nova tentativa do mesmo POST sem revalidar o fato canônico.

As correções estão no worktree e ainda não foram publicadas. A migration append-only `20260812000200_owner_recipient_projection_split.sql` preserva a migration aplicada anterior, renomeia sua projeção completa para `get_owner_activation_status()` e recria `get_owner_recipient_status()` como tuple compacta de 16 colunas. `/dono` e `GET /api/owner/activation` usam as 21 colunas necessárias para renderizar e aceitar o contrato; `/dono/recebimentos`, `GET /api/owner/recipient` e os retornos de `start | refresh` não transferem título, versão textual, hash nem corpo Markdown.

No cliente, `CONFLICT` e `VALIDATION_FAILED` sem `fieldErrors` fecham a repetição e exigem um GET autoritativo. Somente validação realmente vinculada a campo permanece editável. O cenário `SL-F004-E2E-004` agora usa dois contextos concorrentes: a aba stale precisa receber `409`, manter zero GET até a decisão explícita, executar exatamente um GET de recuperação e não repetir o POST. A matriz final pós-review executou e aceitou essa extensão.

## Arquivos/componentes

Implementados: contratos estritos em `packages/contracts/src/owner.ts`; domínio server/client em `src/domains/owners`; renderer jurídico compartilhado em `src/domains/legal`; rotas `/dono`, `/dono/recebimentos`, `GET /api/owner/activation` e `GET /api/owner/recipient`; registry modular em `src/domains/commands`; migrations append-only, seed local, pgTAP `0004`, helpers e quatro specs FEAT-004. Os DALs de comando usam um pool restrito compartilhado; web/readiness/backoffice conservam `6 + 2 + 2 = 10`, sem ampliar o teto do login runtime.

## Banco, migration, grants e RLS

A migration `20260812000100_owner_onboarding_recipient.sql` é a décima terceira da cadeia. Ela cria autoridade de dono, recebedor seguro, operações privadas e fatos mínimos de aceite/auditoria; comandos entram por quatro funções concedidas à `app_dal`, e os read models `security invoker` filtram por `auth.uid()`. O contrato jurídico ganha kind `owner_contract` em RPC autenticada própria, sem ampliar `get_current_legal_terms()` nem a leitura anônima do cadastro. Nenhum schema de estúdio, checkout, repasse ou papel administrativo foi antecipado.

Reset e geração passaram no head `20260812000100`. As quatro suítes pgTAP passaram em 355/355 asserts (`158 + 78 + 57 + 62`); a `0004` cobre ACL/RLS, A/B, personas owner/admin sem bypass, ativação/prepare/apply, renovação, drift, bloqueio, concorrência com a mesma chave e replay. O cleanup final comprovou zero linha nas 15 relações inspecionadas, zero fixture nos dez checks, zero órfão e zero sessão dblink; uma mensagem Mailpit da fixture concorrente foi removida por ID exato, terminando em 0/0.

A correção P2 adiciona `20260812000200_owner_recipient_projection_split.sql` como a décima quarta migration, sem editar `20260812000100`. A árvore e o contrato de head agora apontam para `20260812000200`. Uma tentativa posterior ao ajuste literal foi recusada sob Node 22 pelo `devEngines`, antes de alcançar SQL; em seguida, Node 24 passou reset, geração e `test:db` com os mesmos 355/355 asserts. Readiness aceitou o head atual e recusou `20260812000100`; o probe transacional/pgTAP comprovou 21 colunas com corpo em ativação e 16 sem corpo em recebimentos. Os artefatos gerados estão sincronizados, e a inspeção final terminou com zero linha nas 15 relações, zero fixture nos dez checks, zero entre quatro classes de órfão, zero sessão dblink e Mailpit 0/0.

## Segurança e privacidade

O provider é chamado somente no servidor. Identificadores externos, payloads, KYC e dados bancários completos não entram em DTO, cache, DOM, URL ou log. `expectedScope` repete o recorte SSR somente como asserção; a sessão validada continua sendo a autoridade. As quatro specs FEAT-004 desativam trace, screenshot e vídeo porque o provisionamento atravessa PII sintética e referências privadas; a evidência usa asserções semânticas e varreduras negativas, sem persistir esses artefatos.

## Read models, comandos e invalidação

`owner.activate`, `recipient.onboarding.start` e `recipient.onboarding.refresh` estão no registry privado com retorno autoritativo, idempotência explícita e invalidação de query keys escopadas por usuário. `recipient.bank.update` fica diferido até existir token ou handoff provider-owned aprovado. A elegibilidade exige dono ativo, contrato vigente aceito, recebedor ativo e a mesma versão de perfil sincronizada; nova versão contratual preserva o histórico e exige novo aceite. A FEAT-020 revalidará o fato antes da cobrança.

Os read models autenticados de ativação e recebimentos possuem deadline interno de 2.000 ms. Ambos combinam signal externo com um `AbortSignal` próprio, fazem race contra transporte não cooperativo, limpam o timer em todo desfecho e ignoram resolução/rejeição tardia; assim, o timeout de dez segundos do browser não é a única proteção das requests SSR. A key privada também inclui a projeção (`activation | recipient`), impedindo que o DTO completo e o compacto compartilhem cache.

## UX, mobile e acessibilidade

O checklist factual, o contrato vigente, o CTA derivado do requisito pendente e as mensagens seguras do adapter estão implementados nas duas rotas. Os estilos e as specs cobrem os contratos de 320 px, zoom de 200%, teclado, touch de 44 px, axe e reflow; os sete IDs foram promovidos a automatizados após as matrizes browser limpas descritas abaixo. Nenhuma tela afirma aprovação real de gateway.

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

### Evidência local pós-review aceita

Node 24 passou toda a cadeia atual: format, lint com zero warnings, typecheck integral, 716/716 unitários em 74 arquivos, docs:check em 34 features/200 cenários/18 ADRs, audit com zero vulnerabilidade, Knip e diff-check; o banco permaneceu em 355/355. A execução focada única passou em 23/23, quatro specs, 14 projetos e 126,0 segundos, com IDs `3 + 3 + 3 + 4 + 3 + 4 + 3` e zero resultado inesperado, flake, skip, erro, retry ou attachment. SHA-256: relatório `64f80b00b8846a8157fe31708f95c28203ec5a843d383a75ae5b846e823c6df5`, `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903` e stdout `9937c3af59131be284ad176f49c289cc6e713e77e20bc015c436f42c06abf757`. A auditoria aceitou 26 e-mails em 26 títulos `Fill`, com privacidade e cleanup verdes.

O guard integral coletou 114 testes em 17 specs; a execução única passou em 114/114 por 16 projetos, em cerca de 5,7 minutos, com zero resultado inesperado, flake, skip, erro, retry ou attachment. A FEAT-004 preservou 23/23 e a mesma distribuição. SHA-256: relatório `c2143d928e122aef944ead5c5999287828446c5f1d081c11daa0a33240f7f66f`, `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`, stdout `27092f939a36f3dde07eeb3c27ec3bf52cace5d034243591ad04748b0f3fe559` e lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`. A auditoria encontrou zero dado sensível e zero telefone; os 88 e-mails tiveram 140 ocorrências apenas em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8, `Expect` 22. As 15 relações do banco, Mailpit, dblink, portas, processos e temporários terminaram em zero.

O build canônico pós-review foi executado uma única vez em Node 24: `npm run build` terminou com exit `0`, 26 rotas web e quatro do backoffice, sem rerun; log SHA-256 `ae46bace1364f77876042025799515a6be0f78ef48afea0d6f343c12ed0d7e68`. Os artefatos auditados ficaram em web `1.576 + 1`, hash `e62803b6…`, e backoffice `1.275 + 1`, hash `a905ef2f…`; o agregado técnico permaneceu estável em `960cc18a…`.

O smoke runtime final autorizado terminou com exit `0`; log SHA-256 `85db0dad1e7cbd999e4427222fdd1b685a3747ffde154eb5a46b444e9cf8f735` e server log redigido `4da1f9af3e0bb34285be99be0ef71d4cefa22108bbe817c23c4c8983828755bf`. Root/prefetch, API, erros globais, live/ready, estáticos, probes adversariais, CSP/nonces, admin e isolamento entre apps ficaram verdes, com 14 nonces web e 11 backoffice únicos. Os GETs guest de ativação/recebimentos retornaram `401 UNAUTHENTICATED` com UUID; `/dono` e `/dono/recebimentos` produziram redirects streaming exatos; o POST sintético com Host/Origin exatos e sem cookie retornou `401` com UUID. As 15 relações ficaram `0 → 0`; dois secrets canônicos, PIDs, portas e temporários terminaram em zero.

Duas tentativas do harness customizado foram recusadas antes de qualquer spawn, servidor ou request: primeiro pela ocorrência pública de `E2E_BASE_URL`, depois pela ocorrência rastreada de `E2E_DATABASE_URL` em `package.json`. O scanner final, ciente de paths e da ocorrência canônica exata, passou; a URL administrativa E2E apareceu somente no `package.json` rastreado esperado. Esses rejects são diagnóstico do harness e não runs de smoke.

O commit funcional local `79376b62bdce788c9eb7e1f1696d5acfde0cb215` foi processado pelo gerador uma única vez. A invocação terminou com exit `0`, e seu log tem SHA-256 `1e8f5bf3d472f2000d8b32d53b0dca2165ec72513f79f407800e4d8d9d56afba`. O archive canônico atual `.artifacts/set-livre-79376b62bdce788c9eb7e1f1696d5acfde0cb215.tar.gz` possui 24.902.933 bytes e SHA-256 `af39e5d2f8f6d919e2adc554e27e214fa170dac12a7285ca8ec9630a7d1f8a1c`; o sidecar tem SHA-256 `0c6bade3db133ccec9a01695a1cd7003d86d0e4275a739f389e3b63a78add5f5`. O manifesto possui 681.311 bytes e SHA-256 `c6514c43d37b8e687731fa2d8788da52df8df53acec11a640aa7707f4cb1d584`.

O tar contém 3.453 membros — 584 diretórios, 2.867 arquivos e dois links —; manifesto e árvore final cobrem 2.869 folhas: web 1.577, backoffice 1.276, migrations 14, lockfile 1 e manifesto 1. Os `BUILD_ID` de ambos os apps equivalem exatamente ao commit, o head empacotado é `20260812000200`, e a plataforma registrada é Linux x64 com Node 24.18/npm 11.19. Smoke canônico embutido, guardas de segurança, buscas de secrets/PII e cleanup ficaram verdes. A auditoria final independente conferiu a release e os 13 caminhos documentais e terminou `NO-BLOCKER`. Esta é a release local canônica atual, sem equivaler a ARM64 ou produção; PEND-003 e o smoke ARM64 nativo permanecem pendentes.

O snapshot funcional foi congelado no commit `c115dcd726929f289777cd897cccc97d33a179ee` e gerou `set-livre-c115dcd726929f289777cd897cccc97d33a179ee.tar.gz`, com 24.891.031 bytes e SHA-256 `484d60e67f17768688619acf58b998a43fabc2420e9dd8b221f17a112e9aaa6c`. A árvore contém 2.859 payloads: web 1.568, backoffice 1.276, migrations 13, lockfile 1 e manifesto 1. O manifesto possui 678.902 bytes e SHA-256 `a62f1d4c4aaf317ce5d74232a959adff01367f863efe8f7b8de3fb17b89ee018`; os `BUILD_ID` equivalem ao commit, e o head empacotado é `20260812000100_owner_onboarding_recipient.sql`.

O smoke padrão daquele gerador passou. A auditoria integral encontrou correspondência exata entre tar, staging e manifesto e terminou `NO-BLOCKER` somente para aquela release local Linux x64, Node 24.18/npm 11.19. As varreduras canônicas antes e depois do smoke não encontraram segredo de runtime nem PII de cliente/QA. O snapshot permanece histórico e stale, anterior aos dois P2, e não aprova produção ou ARM64.

## Publicação

A branch `feat/feat-004-owner-onboarding-recipient` foi publicada, e o [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) está `OPEN`, em draft e com base `main`. O review `PRR_kwDOTyzZrs8AAAABJQvhhQ`, concluído às `12:32:57Z` sobre `07dcbb06b4f07fdb477211c90c77e0aed759a0cb`, mantém dois P2 abertos. O snapshot publicado reúne o commit funcional `c115dcd726929f289777cd897cccc97d33a179ee` e a evidência documental `4bf6ec51ce27486f274dcad1f708372947055240`; ele permanece válido apenas como evidência histórica do estado anterior. Gates, browser, build, smoke e release local canônica atuais estão verdes; publicação do novo HEAD, resposta e resolução das threads, novo review, promoção para ready e merge continuam pendentes.

## Observabilidade e operação

Eventos allowlisted registram ação, resultado, duração e `requestId`, sem PII nem payload externo. O adapter e o contrato `local_fixture` são recusados fora de local/test; PEND-004/PEND-006 continuam como bloqueadores explícitos de produção.

## Documentação atualizada

Este registro acompanha FEAT-004, pagamentos, banco, API, cache, segurança, UX, observabilidade, QA, contexto e resumo HTML no mesmo recorte.

## Rollback/correção

Antes de qualquer aplicação remota, a branch pode ser revertida como unidade. Depois de aplicar a migration local, qualquer correção estrutural usa nova migration append-only; fatos de aceite ou integração não serão corrigidos por edição manual.

## Evidência de conclusão

Contratos, backend, UI, migrations e testes dos dois P2 estão implementados localmente. No novo head `20260812000200`, banco 355/355, gates completos, matriz focada 23/23, matriz integral 114/114, build, smoke e release local canônica passaram. A evidência antiga de 707/707, os hashes browser/build/smoke pré-review e a release `c115dcd...` pertencem ao snapshot publicado anterior. Publicação e re-review ainda não foram executados para os P2. A feature permanece **Em implementação**; os dois P2 continuam abertos até publicação e resolução, e nenhuma evidência local substitui PEND-003 ou o smoke ARM64 nativo.
