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

A matriz específica final da FEAT-004 executou suas quatro specs em uma única invocação pós-correções: 23/23 passaram, exit `0`, em cerca de 2,0 minutos, por 14 projetos; os IDs 001–007 somaram `3 + 3 + 3 + 4 + 3 + 4 + 3`. Não houve resultado inesperado, skip, flake, erro ou attachment. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos tiveram 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP do relatório. O cleanup terminou com banco, Mailpit, portas e processos em zero. O relatório `index.html` tem SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`. Os gates finais pós-código passaram em 707/707 unitários, 11/11 estáticos de privacidade, format, lint, typechecks, docs:check, audit com zero vulnerabilidade, Knip e diff-check. Essa evidência automatiza os IDs `SL-F004-E2E-001` a `007`; a integral limpa posterior está registrada abaixo.

A primeira execução Playwright integral pós-FEAT-004 terminou funcionalmente em 114/114, mas a auditoria rejeitou sua evidência: 18 telefones QA apareceram em 61 títulos `Fill` e quatro snippets. O helper foi corrigido para preencher o input dentro de `Locator.evaluate`, pelo setter nativo e um `InputEvent`, e os sete call sites passaram a usar o caminho redigido. Esse run permanece somente como diagnóstico histórico.

Depois do patch, a matriz integral limpa passou em uma única invocação Node 24 com `workers=1`, `max-failures=1` e `retries=0`: 114/114, exit `0`, cerca de 5,9 minutos, 17 specs e 16 projetos, sem resultado inesperado, skip, flake, erro, attachment ou mídia. A FEAT-004 conservou 23/23, distribuídos por ID em `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório tem SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`. A auditoria encontrou zero ocorrência dos 28 telefones QA, seus formatos ou sequências, zero step sensível `Fill`/`Type`/`PressSequentially` e zero sentinela, token, cookie Auth, URL de banco, referência privada do provider ou documento QA. Os 88 e-mails QA únicos apareceram em 140 ocorrências somente em títulos allowlisted: FEAT-002 60, FEAT-003 54 e FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Banco, Mailpit, portas e processos terminaram em zero.

Os builds web/backoffice passaram sem warning ou erro; manifests, rotas, standalone e `next-env.d.ts` canônico foram validados. O smoke padrão release-equivalent passou em roots, prefetch, erros globais, live/ready, assets, CSP, nonces, probes adversariais, isolamento e redirects streaming da área do dono. O log tem SHA-256 `dbbaff2344e7841a12c4489e0a669a681ecd90755afc9649b1db723679b80ca1`.

O boundary guest standalone da FEAT-004 passou no probe de origem exata: exatamente um `POST /api/commands` em `127.0.0.1:3000`, com `Host`/`Origin` naturais exatos, sem cookies e payload sintético válido de `recipient.onboarding.start`, recebeu `401 UNAUTHENTICATED`; o `requestId` UUID-v4 coincidiu no header e body. As oito contagens owner/Auth/audit ficaram em zero antes e depois, e portas, temporários e PGID terminaram em zero. O log redigido tem SHA-256 `af8d01d798739f14d1e060b30314e72fb3c1cda7a793b90a81dd4299b259c36b`.

O commit funcional `c115dcd726929f289777cd897cccc97d33a179ee` gerou localmente `set-livre-c115dcd726929f289777cd897cccc97d33a179ee.tar.gz`, com 24.891.031 bytes, SHA-256 `484d60e67f17768688619acf58b998a43fabc2420e9dd8b221f17a112e9aaa6c` e 2.859 payloads: web 1.568, backoffice 1.276, migrations 13, lockfile 1 e manifesto 1. O manifesto possui 678.902 bytes e SHA-256 `a62f1d4c4aaf317ce5d74232a959adff01367f863efe8f7b8de3fb17b89ee018`; os `BUILD_ID` equivalem ao commit, e o head empacotado é `20260812000100_owner_onboarding_recipient.sql`. O smoke padrão do gerador passou. Tar, staging e manifesto foram auditados integralmente com resultado `NO-BLOCKER` somente no escopo local Linux x64, Node 24.18/npm 11.19; as varreduras canônicas do gerador antes e depois do smoke não encontraram segredo de runtime nem PII de cliente/QA. O pacote não é evidência ARM64 nem produção: smoke ARM64 nativo e PEND-003 — Nginx, TLS e trusted proxy — permanecem pendentes. A FEAT-004 segue **Em implementação**; publicação, review e merge ainda não ocorreram.

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
