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

Na fotografia local atual pós-review, todos os gates Node 24 ficaram verdes: format, lint com zero warnings, typecheck integral, 716/716 unitários em 74 arquivos, docs:check em 34 features/200 cenários/18 ADRs, audit com zero vulnerabilidade, Knip e diff-check; o banco permaneceu em 355/355. A execução focada única passou em 23/23, quatro specs/14 projetos e 126,0 segundos, com distribuição `3 + 3 + 3 + 4 + 3 + 4 + 3` e zero resultado inesperado, flake, skip, erro, retry ou attachment. Seus SHA-256 são `64f80b00b8846a8157fe31708f95c28203ec5a843d383a75ae5b846e823c6df5` para o relatório, `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903` para `.last-run.json` e `9937c3af59131be284ad176f49c289cc6e713e77e20bc015c436f42c06abf757` para stdout. A auditoria aceitou os 26 e-mails QA em 26 títulos `Fill`, sem exposição fora da allowlist.

O guard integral atual coletou 114 testes em 17 specs; a execução única passou em 114/114 por 16 projetos, em cerca de 5,7 minutos, com zero resultado inesperado, flake, skip, erro, retry ou attachment. A FEAT-004 preservou 23/23 e a mesma distribuição. SHA-256: relatório `c2143d928e122aef944ead5c5999287828446c5f1d081c11daa0a33240f7f66f`, `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`, stdout `27092f939a36f3dde07eeb3c27ec3bf52cace5d034243591ad04748b0f3fe559` e lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`. A auditoria encontrou zero dado sensível e zero telefone; os 88 e-mails apareceram 140 vezes somente em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. As 15 relações do banco, Mailpit, dblink, portas, processos e temporários terminaram em zero.

O build canônico pós-review foi executado uma única vez em Node 24: `npm run build` terminou com exit `0`, 26 rotas web e quatro do backoffice, sem rerun; log SHA-256 `ae46bace1364f77876042025799515a6be0f78ef48afea0d6f343c12ed0d7e68`. Os artefatos auditados ficaram em web `1.576 + 1`, hash `e62803b6…`, e backoffice `1.275 + 1`, hash `a905ef2f…`; agregado técnico estável `960cc18a…`.

O smoke runtime final autorizado terminou com exit `0`; log SHA-256 `85db0dad1e7cbd999e4427222fdd1b685a3747ffde154eb5a46b444e9cf8f735` e server log redigido `4da1f9af3e0bb34285be99be0ef71d4cefa22108bbe817c23c4c8983828755bf`. Root/prefetch, API, erros globais, live/ready, estáticos, probes adversariais, CSP/nonces, admin e isolamento entre apps ficaram verdes, com 14 nonces web e 11 backoffice únicos. Os GETs guest de ativação/recebimentos retornaram `401` com UUID; `/dono` e `/dono/recebimentos` produziram redirects streaming exatos; o POST sintético com Host/Origin exatos e sem cookie retornou `401` com UUID. As 15 relações ficaram `0 → 0`; dois secrets canônicos, PIDs, portas e temporários terminaram em zero.

O commit funcional local `79376b62bdce788c9eb7e1f1696d5acfde0cb215` gerou uma única vez, com exit `0` e log SHA-256 `1e8f5bf3d472f2000d8b32d53b0dca2165ec72513f79f407800e4d8d9d56afba`, a release canônica atual `.artifacts/set-livre-79376b62bdce788c9eb7e1f1696d5acfde0cb215.tar.gz`. O archive possui 24.902.933 bytes e SHA-256 `af39e5d2f8f6d919e2adc554e27e214fa170dac12a7285ca8ec9630a7d1f8a1c`; o sidecar tem SHA-256 `0c6bade3db133ccec9a01695a1cd7003d86d0e4275a739f389e3b63a78add5f5`; e o manifesto possui 681.311 bytes e SHA-256 `c6514c43d37b8e687731fa2d8788da52df8df53acec11a640aa7707f4cb1d584`. O tar contém 3.453 membros — 584 diretórios, 2.867 arquivos e dois links —; manifesto e release cobrem 2.869 folhas: web 1.577, backoffice 1.276, migrations 14, lockfile 1 e manifesto 1. Os dois `BUILD_ID` equivalem ao commit, o head é `20260812000200`, e a plataforma registrada é Linux x64 com Node 24.18/npm 11.19. Smoke canônico embutido, segurança, buscas de secrets/PII e cleanup ficaram verdes. A auditoria final independente terminou `NO-BLOCKER`. Isso não é evidência ARM64 nem produção: smoke ARM64 nativo e PEND-003 — Nginx, TLS e trusted proxy — permanecem pendentes.

A release `c115dcd726929f289777cd897cccc97d33a179ee`, de 2.859 payloads e 13 migrations, permanece histórica e stale em relação aos dois P2. A FEAT-004 segue **Em implementação**. A branch `feat/feat-004-owner-onboarding-recipient` foi publicada, e o [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) está `OPEN`, em draft e com base `main`; o snapshot remoto ainda reúne `c115dcd726929f289777cd897cccc97d33a179ee` e sua evidência documental `4bf6ec51ce27486f274dcad1f708372947055240`.

O primeiro review draft, `PRR_kwDOTyzZrs8AAAABJQvhhQ`, terminou em `2026-08-12T12:32:57Z` sobre o HEAD `07dcbb06b4f07fdb477211c90c77e0aed759a0cb` e abriu dois P2 ainda não resolvidos. A correção append-only leva a árvore a 14 migrations e ao head `20260812000200`: ativação usa 21 colunas com documento por `get_owner_activation_status`/`GET /api/owner/activation`; recebimentos, `GET /api/owner/recipient` e `start | refresh` usam 16 sem título, versão textual, hash ou corpo. `CONFLICT` e `VALIDATION_FAILED` sem `fieldErrors` exigem GET autoritativo sem replay, enquanto erro de campo continua editável. Banco, gates, browser, build, smoke e release local canônica pós-review estão verdes. Publicação do novo HEAD, resolução das threads, novo review, promoção e merge permanecem pendentes.

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
