# Mudança: FEAT-004 — ativação de dono e onboarding de recebedor

- Data: 2026-08-12
- Autor/agente: Codex
- Issue/PR: a definir
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

## Arquivos/componentes

Implementados: contratos estritos em `packages/contracts/src/owner.ts`; domínio server/client em `src/domains/owners`; renderer jurídico compartilhado em `src/domains/legal`; rotas `/dono`, `/dono/recebimentos` e `GET /api/owner/recipient`; registry modular em `src/domains/commands`; migration append-only, seed local, pgTAP `0004`, helpers e quatro specs FEAT-004. Os DALs de comando usam um pool restrito compartilhado; web/readiness/backoffice conservam `6 + 2 + 2 = 10`, sem ampliar o teto do login runtime.

## Banco, migration, grants e RLS

A migration `20260812000100_owner_onboarding_recipient.sql` é a décima terceira da cadeia. Ela cria autoridade de dono, recebedor seguro, operações privadas e fatos mínimos de aceite/auditoria; comandos entram por quatro funções concedidas à `app_dal`, e os read models `security invoker` filtram por `auth.uid()`. O contrato jurídico ganha kind `owner_contract` em RPC autenticada própria, sem ampliar `get_current_legal_terms()` nem a leitura anônima do cadastro. Nenhum schema de estúdio, checkout, repasse ou papel administrativo foi antecipado.

Reset e geração passaram no head `20260812000100`. As quatro suítes pgTAP passaram em 355/355 asserts (`158 + 78 + 57 + 62`); a `0004` cobre ACL/RLS, A/B, personas owner/admin sem bypass, ativação/prepare/apply, renovação, drift, bloqueio, concorrência com a mesma chave e replay. O cleanup final comprovou zero linha nas 15 relações inspecionadas, zero fixture nos dez checks, zero órfão e zero sessão dblink; uma mensagem Mailpit da fixture concorrente foi removida por ID exato, terminando em 0/0.

## Segurança e privacidade

O provider é chamado somente no servidor. Identificadores externos, payloads, KYC e dados bancários completos não entram em DTO, cache, DOM, URL ou log. `expectedScope` repete o recorte SSR somente como asserção; a sessão validada continua sendo a autoridade. As quatro specs FEAT-004 desativam trace, screenshot e vídeo porque o provisionamento atravessa PII sintética e referências privadas; a evidência usa asserções semânticas e varreduras negativas, sem persistir esses artefatos.

## Read models, comandos e invalidação

`owner.activate`, `recipient.onboarding.start` e `recipient.onboarding.refresh` estão no registry privado com retorno autoritativo, idempotência explícita e invalidação de query keys escopadas por usuário. `recipient.bank.update` fica diferido até existir token ou handoff provider-owned aprovado. A elegibilidade exige dono ativo, contrato vigente aceito, recebedor ativo e a mesma versão de perfil sincronizada; nova versão contratual preserva o histórico e exige novo aceite. A FEAT-020 revalidará o fato antes da cobrança.

O read model autenticado usado pelos dois Server Components e pelo `GET /api/owner/recipient` possui deadline interno de 2.000 ms. Ele combina signal externo com um `AbortSignal` próprio, faz race contra transporte não cooperativo, limpa o timer em todo desfecho e ignora resolução/rejeição tardia; assim, o timeout de dez segundos do browser não é a única proteção das requests SSR.

## UX, mobile e acessibilidade

O checklist factual, o contrato vigente, o CTA derivado do requisito pendente e as mensagens seguras do adapter estão implementados nas duas rotas. Os estilos e as specs cobrem os contratos de 320 px, zoom de 200%, teclado, touch de 44 px, axe e reflow; os sete IDs foram promovidos a automatizados após as matrizes browser limpas descritas abaixo. Nenhuma tela afirma aprovação real de gateway.

Após resultado ambíguo, `Verificar estado atual` fecha a superfície privada enquanto o `GET /api/owner/recipient` está em curso. Se a leitura autoritativa passar, o foco programático retorna ao heading do checklist; se falhar, a UI mantém apenas a mensagem segura e foca seu alerta. A partir desse alerta, `Tentar novamente` usa o mesmo intent: fecha a superfície no novo GET e devolve o foco ao heading somente após sucesso. Os IDs 004/007 exigem `toBeFocused()` no heading após a recuperação bem-sucedida, sem reenviar o comando anterior; o ID 007 também cobre GET 503, retry, GET real 200 e heading focado.

Anônimos em `/dono` e `/dono/recebimentos` chegam a `/entrar` com a query `retorno`; a allowlist aceita literalmente somente essas duas rotas e as superfícies `/conta*` já existentes. Após validação, o payload usa `returnTo`. Sucesso e resultado ambíguo preservam o destino aprovado, enquanto vetores de open redirect falham fechados.

## Testes e IDs QA

Os IDs `SL-F004-E2E-001` a `007` permanecem estáveis e agora estão automatizados pela matriz específica final. Os testes unitários de contratos, mapper/provider, serviço, DAL, API, cache e UI passaram na suíte integral final pós-código em 707/707. A rodada estática de privacidade passou em 11/11; format, ESLint, typechecks, docs:check, audit com zero vulnerabilidade, Knip, a coleta estática dos 23 testes Playwright e o diff-check também passaram.

A primeira tentativa da matriz Playwright foi interrompida com uma falha e 22 testes não executados porque um locator textual era ambíguo; ele foi corrigido com `exact: true`. A execução seguinte chegou ao ID 005 e terminou com 7 testes passados, uma falha e 15 não executados: após o hard reload, o oráculo tentou `fulfill` do POST já tratado e recebeu `Route is already handled`. Esses dois desfechos permanecem como histórico diagnóstico inconclusivo e pertencem ao oráculo, não ao comportamento do produto.

Antes dessa falha do oráculo, o trecho browser do ID 005 comprovou um GET de B retido na página e no `QueryClient` de A, fechamento pelo boundary, desconexão da superfície A observada no `pagehide`, recomposição SSR somente com B e zero `pageerror`/erro React. A garantia complementar de callback tardio é unitária: usa `MutationObserver` real e latch para impedir publicação após a transição, e prova separadamente que a key de A não é recriada depois do seed autoritativo de B. As quatro specs continuam cobrindo critical, regression, accessibility e reflow sem persistir trace, screenshot ou vídeo.

A invocação final pós-correções das quatro specs passou em 23/23, exit `0`, em cerca de 2,0 minutos, distribuída por 14 projetos; os IDs 001–007 somaram respectivamente `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório terminou com zero resultado inesperado, skip, flake, erro ou attachment. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos tiveram 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP. Banco, Mailpit, portas e processos terminaram sem resíduo. O `index.html` possui SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`. Essa é a evidência final da matriz específica FEAT-004; a integral limpa e os builds posteriores são registrados separadamente abaixo, sem antecipar release.

A primeira matriz Playwright integral posterior terminou funcionalmente em 114/114, mas sua evidência foi rejeitada pela auditoria de privacidade: 18 telefones QA apareceram em 61 títulos automáticos `Fill` e quatro snippets. O helper foi corrigido para aplicar o setter nativo e disparar `InputEvent` dentro de `Locator.evaluate`, sem passar o valor por `fill`; os sete call sites foram migrados para esse caminho redigido. A prova estática pós-patch passou em 11/11, e lint, Prettier e typecheck dos testes ficaram verdes. Essa execução permanece somente como diagnóstico histórico.

A invocação integral final, executada em Node 24 com `workers=1`, `max-failures=1` e `retries=0`, passou em 114/114, exit `0`, cerca de 5,9 minutos, 17 specs e 16 projetos. Não houve resultado inesperado, skip, flake, erro, attachment ou mídia. A FEAT-004 manteve 23/23, com os IDs 001–007 distribuídos em `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório tem SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`.

A auditoria integral encontrou zero ocorrência dos 28 telefones QA, inclusive formatos e sequências, zero `Fill`/`Type`/`PressSequentially` sensível e zero sentinela, token, cookie Auth, URL de banco, referência privada do provider ou documento QA. Os 88 e-mails QA únicos tiveram 140 ocorrências somente em títulos allowlisted: FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Banco, Mailpit, portas e processos terminaram em zero.

Os builds Next.js de web e backoffice passaram sem warning ou erro. Manifests, rotas e árvores standalone foram validados, e `next-env.d.ts` permaneceu canônico. O smoke padrão release-equivalent passou em roots, prefetch, erros globais, live/ready, assets, CSP, nonces, probes adversariais, isolamento entre apps e redirects streaming da área do dono. O log possui SHA-256 `dbbaff2344e7841a12c4489e0a669a681ecd90755afc9649b1db723679b80ca1`.

O boundary guest standalone da FEAT-004 também passou: exatamente um `POST /api/commands` em `127.0.0.1:3000`, com `Host`/`Origin` naturais exatos, sem cookies e comando sintético válido de início de recebedor, retornou `401 UNAUTHENTICATED`. O `requestId` UUID-v4 coincidiu no header e body; as oito contagens owner/Auth/audit ficaram em zero antes/depois. Porta, temporário e PGID terminaram em zero, e o log redigido possui SHA-256 `af8d01d798739f14d1e060b30314e72fb3c1cda7a793b90a81dd4299b259c36b`.

O snapshot funcional foi congelado no commit `c115dcd726929f289777cd897cccc97d33a179ee` e gerou `set-livre-c115dcd726929f289777cd897cccc97d33a179ee.tar.gz`, com 24.891.031 bytes e SHA-256 `484d60e67f17768688619acf58b998a43fabc2420e9dd8b221f17a112e9aaa6c`. A árvore contém 2.859 payloads: web 1.568, backoffice 1.276, migrations 13, lockfile 1 e manifesto 1. O manifesto possui 678.902 bytes e SHA-256 `a62f1d4c4aaf317ce5d74232a959adff01367f863efe8f7b8de3fb17b89ee018`; os `BUILD_ID` equivalem ao commit, e o head empacotado é `20260812000100_owner_onboarding_recipient.sql`.

O smoke padrão do gerador passou. A auditoria integral encontrou correspondência exata entre tar, staging e manifesto e terminou `NO-BLOCKER` somente para a release local Linux x64, Node 24.18/npm 11.19. As varreduras canônicas do gerador antes e depois do smoke não encontraram segredo de runtime nem PII de cliente/QA. Esta evidência não aprova produção ou ARM64: o smoke nativo ARM64 e PEND-003 — Nginx, TLS e trusted proxy — permanecem pendentes. Publicação, review e merge também ainda não ocorreram.

## Observabilidade e operação

Eventos allowlisted registram ação, resultado, duração e `requestId`, sem PII nem payload externo. O adapter e o contrato `local_fixture` são recusados fora de local/test; PEND-004/PEND-006 continuam como bloqueadores explícitos de produção.

## Documentação atualizada

Este registro acompanha FEAT-004, pagamentos, banco, API, cache, segurança, UX, observabilidade, QA, contexto e resumo HTML no mesmo recorte.

## Rollback/correção

Antes de qualquer aplicação remota, a branch pode ser revertida como unidade. Depois de aplicar a migration local, qualquer correção estrutural usa nova migration append-only; fatos de aceite ou integração não serão corrigidos por edição manual.

## Evidência de conclusão

Contratos, backend, UI, migration, reset, geração e banco estão implementados; o pgTAP passou em 355/355 no head `20260812000100`, com cleanup exato e zero resíduo final. Unitários finais passaram em 707/707, os gates não-browser citados estão verdes, a matriz específica FEAT-004 passou em 23/23, a integral limpa em 114/114, e builds, smoke padrão, boundary guest standalone e release local canônica x64 ficaram verdes. A feature permanece **Em implementação**: publicação, review e merge desta branch ainda não ocorreram, e a evidência local x64 não substitui PEND-003 nem o smoke ARM64 nativo.
