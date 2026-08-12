# Set Livre — Plataforma Completa

## Implementação end-to-end orientada pela especificação 1.1

Este repositório contém a especificação viva e a implementação da **plataforma completa de aluguel de estúdios audiovisuais Set Livre**. A baseline documental define produto, arquitetura, contratos de dados, fluxos, qualidade e ordem; o código avança em fatias verticais rastreáveis.

O projeto não descreve o mini fórum comunitário. A aplicação é o marketplace comercial de estúdios, com calendário próprio, reservas, pagamentos, split, repasses, backoffice e operação de produção.

## Estado atual

- fundação local executável incorporada a `main`, sem feature de produto simulada;
- FEAT-002 incorporada a `main` pelo [PR #2](https://github.com/PedroRomeroM/set-livre/pull/2), no merge `d272657`; é a primeira das 34 features concluídas no repositório. Uma revisão posterior ao merge apontou dois hardenings P2, já corrigidos e validados integralmente na branch da FEAT-003;
- FEAT-003 concluída e incorporada a `main` pelo [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4), no merge `465d195`; o HEAD final `1530f62589` recebeu a revisão Codex limpa `5262964258` às `06:00:43Z`, as cinco threads do PR ficaram resolvidas e a feature passa a ser a segunda das 34 concluídas no repositório;
- FEAT-004 em implementação na branch própria: contratos, comandos, DAL, adapter local, read model e interfaces de ativação do dono/recebedor estão implementados sem antecipar gateway externo, checkout, fallback administrativo ou dados bancários; seus sete IDs estão automatizados, elevando o catálogo de 200 cenários para 23 automatizados — FEAT-002 7 + FEAT-003 9 + FEAT-004 7 — e 177 planejados. A branch `feat/feat-004-owner-onboarding-recipient` foi publicada, e o [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) está `OPEN`, em draft e com base `main`; o HEAD remoto `4bf6ec51ce27486f274dcad1f708372947055240` contém o commit funcional `c115dcd726929f289777cd897cccc97d33a179ee` e o commit de documentação de release `4bf6ec51ce27486f274dcad1f708372947055240`. Publicação concluída; review, promoção para ready e merge permanecem pendentes;
- aplicações pública e backoffice separadas;
- Node/npm e dependências fixados em lockfile;
- Supabase local via Docker com 13 migrations append-only e head `20260812000100`; reset e geração passaram, e as quatro suítes somam 355/355 asserts pgTAP (`158 + 78 + 57 + 62`). A `0004_owner_onboarding_recipient.sql` prova ACL/RLS, isolamento entre usuários, personas owner/admin sem bypass, ativação, prepare/apply, renovação contratual, drift, concorrência com a mesma chave e cleanup exato. A matriz específica da FEAT-004 passou em 23/23, e a matriz Playwright integral limpa passou em 114/114;
- a matriz final das quatro specs FEAT-004 cobriu 14 projetos e terminou com zero resultado inesperado, skip, flake, erro ou attachment; os IDs 001–007 passaram em `3 + 3 + 3 + 4 + 3 + 4 + 3`. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos tiveram 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP do relatório. Banco, Mailpit, portas e processos terminaram sem resíduo. O `index.html` do relatório possui SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`;
- os gates finais pós-código da FEAT-004 passaram em 707/707 unitários, 11/11 estáticos de privacidade, format, lint, typechecks, docs:check, audit com zero vulnerabilidade, Knip e diff-check;
- a matriz Playwright integral limpa foi executada em uma única invocação Node 24, `workers=1`, `max-failures=1`, `retries=0`: 114/114 passaram, exit `0`, em cerca de 5,9 minutos, cobrindo 17 specs e 16 projetos; houve zero resultado inesperado, skip, flake, erro, attachment ou mídia. A FEAT-004 manteve 23/23, com IDs 001–007 em `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório possui SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`;
- a auditoria integral encontrou zero ocorrência dos 28 telefones QA, inclusive formatos e sequências, zero `Fill`/`Type`/`PressSequentially` sensível e zero sentinela, token, cookie Auth, URL de banco, referência privada do provider ou documento QA. Os 88 e-mails QA únicos apareceram em 140 ocorrências somente em títulos de steps allowlisted: FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Banco, Mailpit, portas e processos terminaram em zero;
- o run integral 114/114 anterior permanece apenas como diagnóstico histórico: sua evidência foi rejeitada por 18 telefones QA em 61 títulos `Fill` e quatro snippets; o helper e sete call sites foram redigidos antes da execução limpa final;
- os builds Next.js de web e backoffice passaram sem warning ou erro; manifests, rotas e árvores standalone foram validados, e `next-env.d.ts` permaneceu canônico. O smoke padrão release-equivalent passou em roots, prefetch, erros globais, live/ready, assets, CSP, nonces, probes adversariais, isolamento entre apps e redirects streaming da área do dono. O log possui SHA-256 `dbbaff2344e7841a12c4489e0a669a681ecd90755afc9649b1db723679b80ca1`;
- o boundary guest standalone da FEAT-004 passou no probe de origem exata: exatamente um `POST /api/commands` em `127.0.0.1:3000`, com `Host`/`Origin` naturais exatos, sem cookies e payload sintético válido de início de recebedor, recebeu `401 UNAUTHENTICATED`; o `requestId` UUID-v4 coincidiu no header e body. As contagens owner/Auth/audit ficaram em zero antes e depois, e portas, temporários e PGID terminaram em zero. Log redigido SHA-256 `af8d01d798739f14d1e060b30314e72fb3c1cda7a793b90a81dd4299b259c36b`;
- o snapshot funcional da FEAT-004 foi congelado no commit `c115dcd726929f289777cd897cccc97d33a179ee` e gerou localmente `set-livre-c115dcd726929f289777cd897cccc97d33a179ee.tar.gz`, com 24.891.031 bytes, SHA-256 `484d60e67f17768688619acf58b998a43fabc2420e9dd8b221f17a112e9aaa6c` e 2.859 payloads: web 1.568, backoffice 1.276, migrations 13, lockfile 1 e manifesto 1. O manifesto possui 678.902 bytes e SHA-256 `a62f1d4c4aaf317ce5d74232a959adff01367f863efe8f7b8de3fb17b89ee018`; os `BUILD_ID` equivalem ao commit, e o head empacotado é `20260812000100_owner_onboarding_recipient.sql`. O smoke padrão do gerador passou. Tar, staging e manifesto foram auditados integralmente com resultado `NO-BLOCKER` no escopo local Linux x64, Node 24.18/npm 11.19; as varreduras canônicas do gerador antes e depois do smoke não encontraram segredo de runtime nem PII de cliente/QA. Isso não aprova produção nem ARM64: o smoke nativo ARM64 e PEND-003 — Nginx, TLS e trusted proxy — continuam pendentes. A feature permanece **Em implementação**; sua publicação foi concluída no PR #6, enquanto review, promoção para ready e merge ainda não ocorreram;
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
