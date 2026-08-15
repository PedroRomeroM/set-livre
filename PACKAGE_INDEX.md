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

A primeira execução Playwright integral pós-FEAT-004 terminou funcionalmente em 114/114, mas a auditoria rejeitou sua evidência: 18 telefones QA apareceram em 61 títulos `Fill` e quatro snippets. O helper foi corrigido para preencher o input dentro de `Locator.evaluate`, pelo setter nativo e um `InputEvent`, e os sete call sites passaram a usar o caminho redigido. Esse run permanece somente como diagnóstico histórico.

Ainda nessa fotografia anterior, depois do patch de privacidade, a matriz integral limpa passou em uma única invocação Node 24 com `workers=1`, `max-failures=1` e `retries=0`: 114/114, exit `0`, cerca de 5,9 minutos, 17 specs e 16 projetos, sem resultado inesperado, skip, flake, erro, attachment ou mídia. A FEAT-004 conservou 23/23, distribuídos por ID em `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório tem SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`. A auditoria encontrou zero ocorrência dos 28 telefones QA, seus formatos ou sequências, zero step sensível `Fill`/`Type`/`PressSequentially` e zero sentinela, token, cookie Auth, URL de banco, referência privada do provider ou documento QA. Os 88 e-mails QA únicos apareceram em 140 ocorrências somente em títulos allowlisted: FEAT-002 60, FEAT-003 54 e FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Banco, Mailpit, portas e processos terminaram em zero.

No patch atual, todos os gates Node 24 ficaram verdes: format, lint com zero warnings, typecheck integral, 718/718 unitários em 74 arquivos, docs:check em 34 features/200 cenários/18 ADRs, audit com zero vulnerabilidade, Knip e diff-check. Um único reset seguido de `test:db` passou em 355/355, com banco e ambiente limpos. A execução focada atual foi única e passou em 23/23, quatro specs/14 projetos. SHA-256: relatório `66a4b5ceea14c7affa848748c525adccf684641b377f755a3a9ce3fb05aec6c6`, stdout `ba57e0bd52d165bf422fccc6500eb4fb920c48f785a226baac24e8265c11fe0c` e lista `ed851b7bca361d0e3e50b5632f12251859b5098a12123a2ee2b8ebbb6f11bf59`.

O guard integral atual coletou 114 testes em 17 specs; uma única execução passou em 114/114 por 16 projetos e preservou 23/23 da FEAT-004. SHA-256: relatório `b68c70ff6f17f55142d11394dd9b6113958a7e49ef82d2c5c70324dfcafe6227`, stdout `7b8b7971f91e8a571cec6ac8bb63fed665bbfcd1b9ead4997a6e0436b76114bc` e lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`. Privacidade e cleanup ficaram verdes, sem secrets, PII, resíduo de banco, Mailpit, dblink, portas, processos ou temporários.

O build atual foi executado uma única vez em Node 24: `npm run build` terminou com exit `0`, sem warnings; log SHA-256 `db0d0049b248dd7b3d438d57ffa0faa465d3cd7a15a9bdd0d6267dc11a4ac162`.

O smoke runtime real atual, padrão mais FEAT-004, terminou com exit `0`: resumo SHA-256 `a8d41974344ba6eb3b6cb83d626e4b77e9853a2d98e58814d9c795cca356ad0b`, stdout `e15829cc6525d58cab4fa2ed49c33d9e5d6225512b77ec96a21fa2ea3b9703dba` e server log redigido SHA-256 `7ea7719b4af0257044c24c32f252f9327920a069d74b31cac25d3f23d8f089c5`. Foram 14 nonces web, 11 backoffice, três boundaries e dois redirects; as relações ficaram `0 → 0`, e Mailpit, portas, processos, temporários, secrets e PII terminaram em zero. A primeira tentativa do runner temporário foi recusada antes de spawn por consultar `profile_preferences` em vez de `user_preferences`; log SHA-256 `9757fbc1baf5afcffc4840468f7f7af5c7c1677a924997184376617b8752e2db`. Ela deixou zero servidor, request ou temporário residual; a correção foi somente no harness e antecedeu a única execução real verde.

O commit funcional local `440c81f6cc44cc95ed281d84e9a5124ae98a59c4` gerou uma única vez, com exit `0` e log SHA-256 `be9e2e2d0d1d2a4db78593c03858c183f93b3ed336bd820d3ce9d64c08ec1ba4`, a release canônica local atual `.artifacts/set-livre-440c81f6cc44cc95ed281d84e9a5124ae98a59c4.tar.gz`. O archive possui 24.902.563 bytes e SHA-256 `f52210ee52a73a7fda68ee7bf389c4c26e7bd896c4c61f5775ca72ee42913b59`; o sidecar tem SHA-256 `a8082ee69d311a46c8e323913f1aa13d62c726e7b4206942c4309d2c6f56fb4e`; e o manifesto possui 681.311 bytes e SHA-256 `99d673708449287898424deec5188318d3fa329101a704dfd67859fabaf47b82`. O tar contém 3.453 membros — 584 diretórios, 2.867 arquivos e dois links —; manifesto e release cobrem 2.869 folhas: web 1.577, backoffice 1.276, migrations 14, lockfile 1 e manifesto 1. Os dois `BUILD_ID` equivalem ao commit, o head é `20260812000200`, e a plataforma registrada é Linux x64 com Node 24.18/npm 11.19. Tar, sidecar, smoke canônico embutido, segurança, buscas de secrets/PII e cleanup ficaram verdes. Isso comprova o patch somente no recorte local x64, não ARM64 ou produção: smoke ARM64 nativo e PEND-003 — Nginx, TLS e trusted proxy — permanecem pendentes.

A release `c115dcd726929f289777cd897cccc97d33a179ee`, de 2.859 payloads e 13 migrations, permanece histórica e stale em relação aos dois P2 iniciais; a release `79376b62...` também é anterior ao delta local atual. A release `440c81f6...` é a fotografia canônica local atual. A FEAT-004 segue **Em implementação**. A branch `feat/feat-004-owner-onboarding-recipient` foi publicada até `3e3f866c42302df9b0499e9af75575c7c092f3f0`; o commit funcional posterior ainda não foi publicado.

As duas threads do primeiro review `PRR_kwDOTyzZrs8AAAABJQvhhQ` receberam resposta e foram resolvidas. O segundo review `PRR_kwDOTyzZrs8AAAABJV08Cw`, submetido em `2026-08-12T22:59:35Z` sobre `3e3f866c42302df9b0499e9af75575c7c092f3f0`, abriu a thread atual `PRRT_kwDOTyzZrs6YwM7k` sobre `owner_contract_not_current`. O patch local converte somente `42501 + owner_contract_not_current` em `409 CONFLICT`, preserva outros `42501` como `403 FORBIDDEN` e mantém a mensagem SQL privada. Full gates, banco, browser, build, smoke e a release canônica local `440c81f6...` estão verdes. Publicação, resposta/resolução, novo review, promoção e merge permanecem pendentes; a FEAT-004 segue **Em implementação**, e PEND-003/smoke ARM64 nativo permanecem obrigatórios para produção.

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
