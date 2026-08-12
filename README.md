# Set Livre — Plataforma Completa

## Implementação end-to-end orientada pela especificação 1.1

Este repositório contém a especificação viva e a implementação da **plataforma completa de aluguel de estúdios audiovisuais Set Livre**. A baseline documental define produto, arquitetura, contratos de dados, fluxos, qualidade e ordem; o código avança em fatias verticais rastreáveis.

O projeto não descreve o mini fórum comunitário. A aplicação é o marketplace comercial de estúdios, com calendário próprio, reservas, pagamentos, split, repasses, backoffice e operação de produção.

## Estado atual

- fundação local executável incorporada a `main`, sem feature de produto simulada;
- FEAT-002 incorporada a `main` pelo [PR #2](https://github.com/PedroRomeroM/set-livre/pull/2), no merge `d272657`; é a primeira das 34 features concluídas no repositório. Uma revisão posterior ao merge apontou dois hardenings P2, já corrigidos e validados integralmente na branch da FEAT-003;
- FEAT-003 concluída e incorporada a `main` pelo [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4), no merge `465d195`; o HEAD final `1530f62589` recebeu a revisão Codex limpa `5262964258` às `06:00:43Z`, as cinco threads do PR ficaram resolvidas e a feature passa a ser a segunda das 34 concluídas no repositório;
- FEAT-004 em implementação na branch própria: contratos, comandos, DAL, adapter local, read models e interfaces de ativação do dono/recebedor estão implementados sem antecipar gateway externo, checkout, fallback administrativo ou dados bancários; seus sete IDs continuam automatizados, elevando o catálogo de 200 cenários para 23 automatizados — FEAT-002 7 + FEAT-003 9 + FEAT-004 7 — e 177 planejados. A branch `feat/feat-004-owner-onboarding-recipient` foi publicada, e o [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) está `OPEN`, em draft e com base `main`. O review `PRR_kwDOTyzZrs8AAAABJQvhhQ`, concluído em `2026-08-12T12:32:57Z` sobre o HEAD `07dcbb06b4f07fdb477211c90c77e0aed759a0cb`, abriu dois P2 ainda não resolvidos. As correções locais separam ativação completa (21 colunas com documento, `GET /api/owner/activation`) de recebimentos compactos (16 sem título, versão textual, hash ou corpo, `GET /api/owner/recipient`) e exigem GET autoritativo para `CONFLICT` ou `VALIDATION_FAILED` sem erro de campo, sem replay do POST. Nova release, publicação do novo HEAD, respostas/resolução das threads, re-review, promoção e merge permanecem pendentes;
- aplicações pública e backoffice separadas;
- Node/npm e dependências fixados em lockfile;
- Supabase local via Docker com 14 migrations append-only e head `20260812000200`; Node 24 passou reset, geração e `test:db`, e as quatro suítes permanecem em 355/355 asserts pgTAP (`158 + 78 + 57 + 62`). Readiness aceita o head atual e recusa `20260812000100`; o probe transacional e o pgTAP comprovam ativação com 21 colunas/corpo e recebimentos com 16/sem corpo, com gerados sincronizados e cleanup zero;
- no snapshot publicado anterior ao review, a matriz final das quatro specs FEAT-004 cobriu 14 projetos e terminou com zero resultado inesperado, skip, flake, erro ou attachment; os IDs 001–007 passaram em `3 + 3 + 3 + 4 + 3 + 4 + 3`. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos tiveram 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP do relatório. Banco, Mailpit, portas e processos terminaram sem resíduo. O `index.html` do relatório possui SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`;
- nesse mesmo snapshot anterior, os gates pós-código passaram em 707/707 unitários, 11/11 estáticos de privacidade e na cadeia restante; essa contagem permanece apenas histórica;
- a matriz Playwright integral limpa pré-review permanece histórica: 114/114 em cerca de 5,9 minutos, com relatório SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`;
- no estado local pós-review, os gates completos Node 24 passaram: format, lint sem warnings, typecheck integral, 716/716 unitários em 74 arquivos, docs:check em 34 features/200 cenários/18 ADRs, audit com zero vulnerabilidade, Knip e diff-check; o banco permaneceu em 355/355;
- a matriz focada atual passou em uma única execução: 23/23, quatro specs, 14 projetos e 126,0 segundos, com IDs `3 + 3 + 3 + 4 + 3 + 4 + 3`, zero resultado inesperado, flake, skip, erro, retry ou attachment. SHA-256: relatório `64f80b00b8846a8157fe31708f95c28203ec5a843d383a75ae5b846e823c6df5`, `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903` e stdout `9937c3af59131be284ad176f49c289cc6e713e77e20bc015c436f42c06abf757`; a auditoria aceitou 26 e-mails QA em 26 títulos `Fill` e nenhum dado sensível fora da allowlist;
- o guard integral coletou 114 testes em 17 specs e a execução única atual passou em 114/114 por 16 projetos, em cerca de 5,7 minutos, sem resultado inesperado, flake, skip, erro, retry ou attachment; a FEAT-004 permaneceu em 23/23 na mesma distribuição. SHA-256: relatório `c2143d928e122aef944ead5c5999287828446c5f1d081c11daa0a33240f7f66f`, `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`, stdout `27092f939a36f3dde07eeb3c27ec3bf52cace5d034243591ad04748b0f3fe559` e lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`;
- a auditoria integral pós-review encontrou zero dado sensível e zero telefone. Os 88 e-mails QA únicos apareceram em 140 ocorrências somente em títulos de steps allowlisted: FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. As 15 relações do banco, Mailpit, dblink, portas, processos e temporários terminaram em zero;
- o run integral 114/114 anterior permanece apenas como diagnóstico histórico: sua evidência foi rejeitada por 18 telefones QA em 61 títulos `Fill` e quatro snippets; o helper e sete call sites foram redigidos antes da execução limpa final;
- o build canônico pós-review foi executado uma única vez em Node 24: `npm run build` terminou com exit `0`, 26 rotas web e quatro do backoffice, sem rerun; log SHA-256 `ae46bace1364f77876042025799515a6be0f78ef48afea0d6f343c12ed0d7e68`. Os artefatos auditados somam web `1.576 + 1`, hash `e62803b6…`, e backoffice `1.275 + 1`, hash `a905ef2f…`; o agregado técnico está estável em `960cc18a…`;
- o smoke runtime final autorizado terminou com exit `0`: root/prefetch, API, erros globais, live/ready, estáticos, probes adversariais, CSP/nonces, admin e isolamento entre apps ficaram verdes; foram 14 nonces web e 11 backoffice únicos. Log SHA-256 `85db0dad1e7cbd999e4427222fdd1b685a3747ffde154eb5a46b444e9cf8f735`; server log redigido `4da1f9af3e0bb34285be99be0ef71d4cefa22108bbe817c23c4c8983828755bf`. Na FEAT-004, os dois GETs guest retornaram `401 UNAUTHENTICATED` com `requestId` UUID, `/dono` e `/dono/recebimentos` emitiram redirects streaming exatos, e o POST sintético com Host/Origin exatos e sem cookie retornou `401` com UUID. As 15 relações ficaram `0 → 0`; secrets canônicos, PIDs, portas e temporários terminaram em zero;
- o snapshot funcional histórico da FEAT-004 foi congelado no commit `c115dcd726929f289777cd897cccc97d33a179ee` e gerou localmente `set-livre-c115dcd726929f289777cd897cccc97d33a179ee.tar.gz`, com 24.891.031 bytes, SHA-256 `484d60e67f17768688619acf58b998a43fabc2420e9dd8b221f17a112e9aaa6c` e 2.859 payloads: web 1.568, backoffice 1.276, migrations 13, lockfile 1 e manifesto 1. O manifesto possui 678.902 bytes e SHA-256 `a62f1d4c4aaf317ce5d74232a959adff01367f863efe8f7b8de3fb17b89ee018`; os `BUILD_ID` equivalem ao commit, e o head empacotado é `20260812000100_owner_onboarding_recipient.sql`. O smoke padrão do gerador passou, mas o artefato agora está stale em relação à migration `20260812000200` e aos dois P2 locais. Nova release/publicação/re-review seguem pendentes. Isso não aprova produção nem ARM64: o smoke nativo ARM64 e PEND-003 — Nginx, TLS e trusted proxy — continuam pendentes. A feature permanece **Em implementação**;
- no snapshot funcional final da FEAT-003, passaram 578/578 unitários de 60 arquivos e uma matriz Playwright/axe integral de 91/91 em 3,9 minutos — 32/32 da feature, cobrindo sem alterar contagens os IDs `SL-F003-E2E-001` a `009`. O ID 004 passou em 3/3 projeções: logout stale recebeu `409`, a sessão e o perfil de B permaneceram intactos e houve zero `pageerror` ou erro React; o ID 009 passou em 4/4, com falha offline imediata, exatamente uma request e nenhum POST tardio após reconexão;
- a auditoria browser histórica da FEAT-003 terminou com zero resultado inesperado, flake, skip, erro ou attachment e não encontrou sentinelas, tokens, cookies Auth nem documentos crus. Os 62 e-mails QA sintéticos únicos apareceram em 114 ocorrências exclusivamente nos títulos automáticos allowlisted dos steps: `Fill` 84, `Visible` 18, `Count` 4 e `Type` 8. Cleanup de banco, Mailpit, portas e processos terminou sem resíduos;
- os builds históricos da FEAT-003 em Next.js 16.3 passaram para web e backoffice sem warnings, com manifests standalone, 17 arquivos obrigatórios e `BUILD_ID` local em cada app; os smokes aprovaram live/ready/root, CSP, `no-store`, assets, nonces e probes adversariais, incluindo `/entrar` 200 no web e 404 no backoffice. Lockfile e gerados permaneceram inalterados, e o cleanup terminou com zero porta ou processo residual. Logs: build `2e3b…4310`; smoke `c9e5…da97`;
- a release `f4f3b1d13238bdb67a2bc77bff55c119132040dc`, com 2.809 artefatos e SHA-256 `571a0dbdee91d17c47158e0b00aaa0c6bcd4ce6d2f4ffa7f06f1fb6afc4ff887`, permanece como evidência histórica anterior aos dois P2 da FEAT-003. O snapshot funcional final dessa mesma feature, no commit `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7`, gerou localmente `set-livre-e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7.tar.gz` com 24.757.341 bytes e SHA-256 `6edb2e246e0b3f46cf83f62ce8685e14b91cb31ac1437931f476fc649621273a`. São 2.809 artefatos — web 1.519, backoffice 1.276, migrations 12, lockfile 1 e manifesto 1 —; o manifesto possui 667.285 bytes e SHA-256 `733dac5409c04d8fd1c39fcd2b867d0f812a75b4792479ead416ecf9f11f0135`. Ambos os `BUILD_ID` equivalem ao commit, em Linux x64 com Node 24.18/npm 11.19. A auditoria integral de tar, staging e manifesto terminou `NO-BLOCKER`, sem segredo de runtime nem dado PII/QA e sem resíduo;
- resumo executivo vivo em `contexto-projeto-set-livre.html`, atualizado junto de cada mudança técnica;
- 2 de 34 features estão concluídas; as demais seguem a sequência canônica de `docs/implementation-order.md`, uma por branch/PR.

CI/CD, Supabase Cloud, Oracle Cloud e providers externos estão temporariamente diferidos pelo ADR-018 e rastreados em `pendencias.md`; isso bloqueia go-live, não a implementação local possível.

## Ordem obrigatória de leitura

1. `AGENTS.md`
2. `CODEX_HANDOFF.md`
3. `docs/00-source-of-truth.md`
4. `docs/reference/architecture-blueprint.md`
5. `docs/adr/`
6. `docs/specification.md`
7. `docs/architecture.md`
8. `docs/database.md`
9. `docs/calendar-reservations.md`
10. `docs/payments.md`
11. `docs/ux-blueprint.md`
12. `docs/qa-test-plan.md`
13. `docs/features/` na ordem do catálogo

## Escopo-alvo desta versão

A versão 1.1 implementa o **MVP Completo comercializável** aprovado:

- lançamento inicial em Curitiba/PR;
- locatários, donos de estúdio e backoffice administrativo;
- home pública, listagem filtrada e página de detalhe;
- cadastro e gestão de múltiplos estúdios por dono;
- revisão editorial e publicação;
- fotos de alta qualidade e vídeo por YouTube;
- calendário próprio avançado;
- regras de disponibilidade, exceções, bloqueios, buffer e duração;
- importação e exportação iCal;
- preço base, multiplicadores por dia e faixa horária;
- adicionais;
- reserva instantânea com prevenção de concorrência;
- cartão, PIX, split 80/20, repasse após o uso, retentativa e reembolso;
- e-mails transacionais;
- SEO completo, WCAG 2.2 AA, mobile a partir de 320 px;
- LGPD, exclusão/exportação de dados e backoffice separado;
- deploy em VM Oracle Cloud Free Tier com Nginx, systemd e releases imutáveis por SHA.

## Fora desta versão

Não implementar sem novo ADR e alteração formal de escopo:

- mini fórum ou comunidade;
- aplicativo nativo;
- chat;
- avaliações;
- mapa;
- assinatura;
- seguros;
- cupons;
- busca textual livre;
- múltiplos gestores por estúdio;
- carrinho com vários estúdios;
- Google Calendar automático;
- emissão automática de nota fiscal;
- multi-região e múltiplos fusos;
- relatórios analíticos avançados.

## Stack normativa

- Next.js 16 com App Router;
- React 19;
- TypeScript `strict`;
- npm com lockfile;
- CSS Modules, CSS variables e primitives próprias;
- TanStack Query para estado remoto;
- Supabase Cloud para Auth, PostgreSQL e Storage;
- Supabase local via CLI e Docker para desenvolvimento/CI;
- Zod nos limites de entrada;
- `pg` server-only para o DAL de comandos;
- Vitest, Playwright, axe, ESLint e Knip;
- GitHub Actions;
- Oracle Cloud Ampere A1 ARM64;
- Nginx, systemd e releases por SHA.

## Regra de conclusão

Nenhuma feature é considerada concluída apenas porque a interface funciona. A entrega exige coerência entre:

- especificação;
- ADRs;
- migrations;
- grants e RLS;
- comandos e read models;
- UI desktop/mobile;
- testes;
- observabilidade;
- documentação viva;
- deploy e rollback.

Leia `AGENTS.md` antes de qualquer alteração.

## Validação

Consulte `contexto-projeto-set-livre.html` para acompanhar o progresso em alto nível, `docs/validation-report.md` para a baseline recebida, `MANIFEST_SHA256.md` para sua integridade histórica e `docs/changes/` para a evolução executável.
