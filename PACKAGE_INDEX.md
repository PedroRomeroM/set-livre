# Índice do pacote de implementação — Set Livre 1.1

## Baseline recebida e repositório vivo

A baseline recebida continha somente arquivos `.md` e representava a documentação de implementação end-to-end. Ela foi preservada no commit `e0cca5a`. O repositório atual também contém código, migrations, testes e configuração; este índice não deve ser usado como inventário da árvore viva.

## Arquivos de entrada obrigatórios

1. `AGENTS.md` — contrato operacional dos agentes;
2. `CODEX_HANDOFF.md` — instruções de início e execução do Codex;
3. `docs/00-source-of-truth.md` — precedência e resolução de conflito;
4. `docs/reference/architecture-blueprint.md` — fonte arquitetural fornecida;
5. `docs/specification.md` — escopo canônico do produto;
6. `docs/implementation-order.md` — sequência de construção;
7. `docs/feature-catalog.md` — catálogo das 34 features;
8. `docs/qa-traceability.md` — catálogo vivo dos 200 cenários.
9. `docs/validation-report.md` — validação estrutural da baseline.
10. `MANIFEST_SHA256.md` — hashes de integridade do pacote.
11. `contexto-projeto-set-livre.html` — resumo executivo vivo para acompanhar o progresso e apresentar o estado implementado; não substitui as fontes canônicas.

Documento vivo de orientação: [`docs/technology-stack.md`](docs/technology-stack.md) resume as tecnologias efetivamente encontradas no código e nas decisões arquiteturais. Ele não altera a precedência das fontes acima nem apresenta cloud ou produção como ativas.

## Indicadores da especificação de produto

| Item                | Quantidade |
| ------------------- | ---------: |
| Features            |         34 |
| ADRs                |         18 |
| Cenários Playwright |        200 |
| Cenários P0         |        134 |
| Cenários P1         |         66 |
| Runbooks            |          6 |

A baseline recebida continha 193 cenários de produto. O catálogo vivo agora soma 200: a FEAT-002 acrescentou um contrato de reflow, a FEAT-003 acrescentou quatro IDs e a preparação da FEAT-004 acrescentou contratos próprios de accessibility e reflow. São 23 IDs automatizados — sete da FEAT-002, nove da FEAT-003 e sete da FEAT-004 — e 177 planejados. O snapshot funcional final da FEAT-003 passou em 578/578 unitários de 60 arquivos e, após reset e geração, em 293/293 asserts pgTAP distribuídos em 158 + 78 + 57, com 12 migrations, head `20260811000500` e zero resíduo. Uma matriz Playwright/axe integral passou em 91/91 em 3,9 minutos, incluindo 32/32 da FEAT-003: o ID 004 ficou verde em 3/3 projeções com `409` para logout stale, sessão/perfil de B intactos e zero erro de página/React; o ID 009 ficou verde em 4/4 com falha offline imediata, exatamente uma request e nenhum POST tardio após reconexão. Não houve resultado inesperado, flake, skip, erro ou attachment; sentinelas, tokens, cookies Auth e documentos crus tiveram zero ocorrência. Os 62 e-mails QA únicos ficaram em 114 títulos allowlisted (`Fill` 84, `Visible` 18, `Count` 4 e `Type` 8), e o cleanup de banco, Mailpit, portas e processos terminou sem resíduos. Os builds Next.js 16.3 de web/backoffice passaram sem warnings, com manifests standalone, 17 arquivos obrigatórios e `BUILD_ID` local em cada app; os smokes aprovaram live/ready/root, CSP, `no-store`, assets, nonces e probes adversariais, incluindo `/entrar` 200 no web e 404 no backoffice. Lockfile/gerados não mudaram, portas/processos ficaram limpos e os logs têm hashes `2e3b…4310` (build) e `c9e5…da97` (smoke). O commit funcional `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7` gerou localmente `set-livre-e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7.tar.gz`, com 24.757.341 bytes, SHA-256 `6edb2e246e0b3f46cf83f62ce8685e14b91cb31ac1437931f476fc649621273a` e 2.809 artefatos: web 1.519, backoffice 1.276, migrations 12, lockfile 1 e manifesto 1. O manifesto tem 667.285 bytes e SHA-256 `733dac5409c04d8fd1c39fcd2b867d0f812a75b4792479ead416ecf9f11f0135`; ambos os `BUILD_ID` equivalem ao commit, em Linux x64 com Node 24.18/npm 11.19. A auditoria integral de tar, staging e manifesto terminou `NO-BLOCKER`, sem segredo de runtime nem dado PII/QA e sem resíduo. O HEAD final `1530f62589` recebeu a revisão Codex limpa `5262964258` às `06:00:43Z`; as cinco threads do PR ficaram resolvidas. O [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4) foi incorporado a `main` no merge `465d195`, em `2026-08-12T06:57:15Z`; a FEAT-003 passa a ser a segunda das 34 features concluídas.

Na fotografia publicada anterior ao primeiro review draft, a matriz específica final da FEAT-004 executou suas quatro specs em uma única invocação pós-correções: 23/23 passaram, exit `0`, em cerca de 2,0 minutos, por 14 projetos; os IDs 001–007 somaram `3 + 3 + 3 + 4 + 3 + 4 + 3`. Não houve resultado inesperado, skip, flake, erro ou attachment. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos tiveram 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP do relatório. O cleanup terminou com banco, Mailpit, portas e processos em zero. O relatório `index.html` tem SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`. Na mesma fotografia, os gates finais pós-código passaram em 707/707 unitários, 11/11 estáticos de privacidade, format, lint, typechecks, docs:check, audit com zero vulnerabilidade, Knip e diff-check. Essa evidência automatiza os IDs `SL-F004-E2E-001` a `007`; a integral limpa posterior está registrada abaixo.

### Estado vivo do quarto P2 da FEAT-004

O review `PRR_kwDOTyzZrs8AAAABJrjWnQ`/REST `4944615069`, submetido em `2026-08-15T20:02:30Z` sobre `11464a37593d510f5774af6af6fe655e671a9c35`, abriu a thread `PRRT_kwDOTyzZrs6ZigTV`. O comentário `PRRC_kwDOTyzZrs7h6SPS`/REST `3790152658`, ancorado em `owner-recipient-panel.tsx` linhas 707–708, estava atual e não resolvido na captura.

A correção adiciona `recipientOnboardingCapability: "local_adapter" | "unavailable"` obrigatória às projeções de ativação/recebimentos e aos três retornos POST. A derivação é server-only por request: `APP_ENV=local | test` habilita exclusivamente o adapter local; `development | production`, ausência ou valor inválido falham fechados. A capability não altera `providerMode`, `nextAction` nem o fato persistido. Em `unavailable`, start/refresh retornam `503 PAYMENT_PROVIDER_UNAVAILABLE` antes de `prepare` ou reserva de operação, enquanto as leituras continuam factuais.

Na UI, `unavailable` remove o notice local e os CTAs de início/refresh e exibe o alerta `role=status` **Cadastro de recebimentos indisponível**, informando que a integração ainda não está disponível e que o estado permanece somente para consulta. Não foi criado provider externo, fake de produção, controle desabilitado, migration ou coluna.

O fechamento local do quarto P2 passou em Node 24 por `npm ci`, format, lint, typecheck, 734/734 unitários em 74 arquivos, docs:check 34/200/18, audit com zero vulnerabilidade, Knip e diff-check. Reset, geração e `test:db` passaram em 358/358 (`158 + 78 + 57 + 65`), com 15 migrations e head `20260815000100`. A rodada browser focada passou em 23/23, quatro specs e 14 projetos; a integral passou em 114/114, 17 specs e 16 projetos, preservando a FEAT-004 em 23/23. Os hashes SHA-256 de auditoria/stdout/relatório/lista são `49d457...`/`f52544...`/`112ff3...`/`7946ed...` na focada e `438da6...`/`c6a76b...`/`8bd8f1...`/`293848...` na integral. A primeira auditoria da integral parou por um `ReferenceError` do próprio harness depois de validar estrutura e privacidade; a correção reaproveitou o mesmo relatório e passou sem nova invocação Playwright, portanto não foi rerun nem flake de produto.

Um único build de validação passou com exit `0`, 26 rotas web, quatro do backoffice, `BUILD_ID=local` e log SHA-256 `ca7d5c3e98449ea03a4cedbc567d93f989db7dbfdac854ea1a19f40f0c26b0b3`. O smoke customizado, porém, **não produziu evidência verde**: três tentativas foram recusadas pelo próprio harness — oráculo de tombstone de cookie, falso positivo do shell pai no postcheck e parser de `pgrp=0` antes dos probes. A segunda chegou a cumprir o contrato funcional completo, mas terminou com exit `1` e foi rejeitada; nenhuma tentativa é apresentada como smoke aprovado.

A release canônica local do quarto P2 foi gerada para o commit funcional `969f30cd0f34b7e36e2a21550b5e3f28f8709406`. O gerador foi executado exatamente uma vez, terminou com exit `0` em 21,15 segundos e produziu archive de 24.904.533 bytes/SHA-256 `d5f544bff8b72314060535333cd2c300a4c56a4e35295c1471beec5ee41cfeeb`, sidecar de 124 bytes/`f3441aee4c9d6758a539b2be2b3b325805bd6d977ad2cf915619bfbb9cd4d8d3`, manifesto de 681.762 bytes/`bc13a94c4084abc46bab677d1115871cb1327d7d17172b982b886c35eb200ada` e log de 2.102 bytes/`5be766c1c967ab7840335c120f2918ff555770efd69544f164023c32378456e7`. São 2.871 artefatos — web 1.578, backoffice 1.276, migrations 15, lockfile 1 e manifesto 1 — e 3.455 membros no tar — 584 diretórios, 2.869 arquivos e dois links seguros. Ambos os `BUILD_ID` equivalem ao commit. Smoke embutido, varredura de secrets, paridade e cleanup ficaram verdes; duas auditorias independentes terminaram `NO-BLOCKER`. A prova é local Linux x64, não ARM64 ou produção; PEND-003 permanece aberto. Publicação, reply/resolve, re-review, espera, ready e merge permanecem pendentes.

### Fotografia histórica do terceiro P2

O review abriu `PRRT_kwDOTyzZrs6ZhR_d`/REST `3789698299` porque `audit.events.request_id` recebia a chave idempotente do browser. A migration append-only `20260815000100_owner_audit_request_correlation.sql` cria `idempotency_key NOT NULL`, move a unicidade para a chave lógica e reserva `request_id` para correlação. O repositório possuía 15 migrations; 42/42 unitários focados e 358/358 pgTAP (`158 + 78 + 57 + 65`) passaram, com readiness, gerados e cleanup naquele head. O fechamento estático precommit passou `npm ci` com 447 pacotes/auditoria zero, format, lint, typecheck, 12/12 guardas de privacidade, 718/718 unitários em 74 arquivos, docs:check 34/200/18, `npm audit` zero, Knip e diff-check. Toda esta evidência é histórica para o quarto P2.

A focada P3 anterior permanece verde em 23/23. Uma integral do snapshot ainda sem a correção do oráculo terminou em 79 passados, uma falha e 34 não executados no `FOUNDATION-E2E-008` WebKit por navegação HMR na mesma página; não houve rerun desse estado, e o relatório diagnóstico tem SHA-256 `ac669d0a2f8056e1b68c44317e9e679cc367daeb5c9a71435ba2f1e6d40ca7ff`. O teste foi separado em páginas distintas, com SHA-256 `7ae803488af54ea58bd06be7820c69c69460ed9038b1b9a5f17e5507d24999a7`; o crítico corrigido passou em 3/3 e a integral corrigida passou exatamente em 114/114, 17 specs e 16 projetos, preservando 23/23 da FEAT-004. O relatório final tem SHA-256 `5abbdc7696273dcf24df6353dea014f9e6dc0738824783171e978cf19d8c2e44`, stdout `a630adc06adb9d461bb9b2fa7d2cc43d8dcf8470312b19b517178ca4f409d678`, e privacidade/cleanup ficaram verdes.

Um único build naquela fotografia passou com exit `0`, 26 rotas web, quatro do backoffice e zero warning; log SHA-256 `8677b868a632e0891499c8450e5c926ddefcde7e27c5d31f9adcb55e27bbfaa2`. Um único smoke customizado do mesmo snapshot passou com exit `0` em 2,4 segundos: três probes guest `401` com UUID, dois redirects exatos, 14/11 nonces, banco/Mailpit `0 → 0`, privacidade e cleanup verdes; hashes SHA-256: stdout `399d3b41dd9d161bdd86288c53e5bf821279285eb4772740c9ff5169845e5abd`, server log `e3c376cdc9403d2739ea8f127244fef193ea0ad4689694fec5c8a097d5ee025b` e resumo `25262fb6efbf93a0a654a16171bc4f6998000ef0078b9d91e40a06beefe79450`.

A release canônica local histórica foi gerada e auditada para o commit funcional `2a86acc4dc3a005213d5f22384084e3aba0160be`. O archive possui 24.903.588 bytes e SHA-256 `0e0c07f41d4a44f0673ce7a5013084942100e8baab1ba72ee6aeea6496be1566`; o sidecar, 124 bytes e SHA-256 `1136df426039335971d515497ce8974dcb25ee583f3764d5c33f9ea1f76ca0ab`; o manifesto, 681.529 bytes e SHA-256 `d3bfb5a5c517edab1004bde6eaf04c7f080c3036c94defbbfa1b82fad44d4d44`; e o log, 2.099 bytes e SHA-256 `e7edaa919daa3b3ed4cd6cf1588c044d2a6efcf1ae84e9877edd5fa42062371e`. São 2.870 artefatos — web 1.577, backoffice 1.276, migrations 15, lockfile 1 e manifesto 1 — e 3.454 membros no tar — 584 diretórios, 2.868 arquivos e dois links seguros. Os dois `BUILD_ID` equivalem ao commit; o head é `20260815000100` (prefixo SHA-256 `ca995243...`) e o lockfile possui prefixo SHA-256 `485ec8e7...`. Smoke, varredura de secrets/PII e cleanup final ficaram verdes em Linux x64, Node 24.18/npm 11.19; duas auditorias independentes terminaram `NO-BLOCKER`. A release não contém nem valida o quarto P2.

Na captura remota histórica de `2026-08-15T19:38:32Z`, o push `3dd11cb → dda95b3` publicou o funcional `2a86acc4...` e a documentação da release até `dda95b3b9108930489a3b10275ef41c2f203ae24`; a release permanece vinculada ao commit funcional, não ao commit documental. O [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) estava `OPEN`/draft, com base `main@174ee16342367caedf55521227d21d5bf076b1a9`, head daquele snapshot `dda95b3b9108930489a3b10275ef41c2f203ae24`, `MERGEABLE`/`CLEAN`, `reviewDecision` vazio e `statusCheckRollup=[]`. `PedroRomeroM` criou a resposta encadeada `PRRC_kwDOTyzZrs7h6HnW`/REST `3790109142`; `PRRT_kwDOTyzZrs6ZhR_d` ficou `isResolved=true`, `isOutdated=false`. A leitura encontrou zero threads não resolvidas naquele instante. Os registros seguintes, inclusive a release `440c81f6...`, são fotografias históricas; nenhuma prova local x64 equivale a ARM64 ou produção.

A primeira execução Playwright integral pós-FEAT-004 terminou funcionalmente em 114/114, mas a auditoria rejeitou sua evidência: 18 telefones QA apareceram em 61 títulos `Fill` e quatro snippets. O helper foi corrigido para preencher o input dentro de `Locator.evaluate`, pelo setter nativo e um `InputEvent`, e os sete call sites passaram a usar o caminho redigido. Esse run permanece somente como diagnóstico histórico.

Ainda nessa fotografia anterior, depois do patch de privacidade, a matriz integral limpa passou em uma única invocação Node 24 com `workers=1`, `max-failures=1` e `retries=0`: 114/114, exit `0`, cerca de 5,9 minutos, 17 specs e 16 projetos, sem resultado inesperado, skip, flake, erro, attachment ou mídia. A FEAT-004 conservou 23/23, distribuídos por ID em `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório tem SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`. A auditoria encontrou zero ocorrência dos 28 telefones QA, seus formatos ou sequências, zero step sensível `Fill`/`Type`/`PressSequentially` e zero sentinela, token, cookie Auth, URL de banco, referência privada do provider ou documento QA. Os 88 e-mails QA únicos apareceram em 140 ocorrências somente em títulos allowlisted: FEAT-002 60, FEAT-003 54 e FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Banco, Mailpit, portas e processos terminaram em zero.

No segundo P2 histórico, todos os gates Node 24 ficaram verdes: 718/718 unitários, banco 355/355 e execução focada 23/23. Essa fotografia não valida os P2 posteriores.

O guard integral histórico passou em 114/114 por 16 projetos e preservou 23/23 da FEAT-004; privacidade e cleanup ficaram verdes naquele snapshot.

O build histórico terminou sem warnings; log SHA-256 `db0d0049b248dd7b3d438d57ffa0faa465d3cd7a15a9bdd0d6267dc11a4ac162`.

O smoke runtime real histórico do segundo P2, padrão mais FEAT-004, terminou com exit `0`: resumo SHA-256 `a8d41974344ba6eb3b6cb83d626e4b77e9853a2d98e58814d9c795cca356ad0b`, stdout `e15829cc6525d58cab4fa2ed49c33d9e5d6225512b77ec96a21fa2ea3b9703dba` e server log redigido SHA-256 `7ea7719b4af0257044c24c32f252f9327920a069d74b31cac25d3f23d8f089c5`. Foram 14 nonces web, 11 backoffice, três boundaries e dois redirects; as relações ficaram `0 → 0`, e Mailpit, portas, processos, temporários, secrets e PII terminaram em zero. A primeira tentativa do runner temporário foi recusada antes de spawn por consultar `profile_preferences` em vez de `user_preferences`; log SHA-256 `9757fbc1baf5afcffc4840468f7f7af5c7c1677a924997184376617b8752e2db`. Ela deixou zero servidor, request ou temporário residual; a correção foi somente no harness e antecedeu a única execução real verde.

O commit `440c81f6...` gerou a release histórica do segundo P2, com 14 migrations/head `20260812000200`; tar, sidecar, smoke, segurança e cleanup ficaram verdes naquele recorte local x64. Ela não contém a migration atual nem comprova ARM64/produção.

A release `440c81f6...`, assim como `c115dcd...`, `79376b62...` e a release do terceiro P2, é histórica diante da capability nova. A FEAT-004 segue **Em implementação**.

As quatro threads anteriores estavam respondidas e resolvidas na fotografia do terceiro P2. O quarto review abriu `PRRT_kwDOTyzZrs6ZigTV`, que estava atual e não resolvida na captura. Não há claim de publicação da correção, resposta, resolução, re-review, ready ou merge.

## Garantias documentais

- o mini fórum está explicitamente fora desta especificação;
- a arquitetura segue a cadeia Blueprint → ADRs → especificação → docs vivas → testes/migrations → código;
- as aplicações pública e de backoffice são separadas;
- calendário, reserva, pagamento, split, reembolso e repasse possuem contratos próprios;
- cada feature possui cenários Playwright concretos e rastreáveis;
- nenhuma decisão aberta pode ser preenchida silenciosamente pelo agente;
- o manifesto histórico prova a baseline no commit indicado; mudanças posteriores são provadas por Git, registros em `docs/changes/` e gates locais.

## Estado inicial efetivamente verificado

- o remoto `PedroRomeroM/set-livre` não possuía refs;
- a baseline documental foi publicada em `main` no commit `e0cca5a`;
- a fundação executável passou a ser desenvolvida em branch separada;
- nenhum código de outro projeto foi copiado para este repositório.
