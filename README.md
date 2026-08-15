# Set Livre — Plataforma Completa

## Implementação end-to-end orientada pela especificação 1.1

Este repositório contém a especificação viva e a implementação da **plataforma completa de aluguel de estúdios audiovisuais Set Livre**. A baseline documental define produto, arquitetura, contratos de dados, fluxos, qualidade e ordem; o código avança em fatias verticais rastreáveis.

O projeto não descreve o mini fórum comunitário. A aplicação é o marketplace comercial de estúdios, com calendário próprio, reservas, pagamentos, split, repasses, backoffice e operação de produção.

## Estado atual

- fundação local executável incorporada a `main`, sem feature de produto simulada;
- FEAT-002 incorporada a `main` pelo [PR #2](https://github.com/PedroRomeroM/set-livre/pull/2), no merge `d272657`; é a primeira das 34 features concluídas no repositório. Uma revisão posterior ao merge apontou dois hardenings P2, já corrigidos e validados integralmente na branch da FEAT-003;
- FEAT-003 concluída e incorporada a `main` pelo [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4), no merge `465d195`; o HEAD final `1530f62589` recebeu a revisão Codex limpa `5262964258` às `06:00:43Z`, as cinco threads do PR ficaram resolvidas e a feature passa a ser a segunda das 34 concluídas no repositório;
- FEAT-004 em implementação na branch própria: contratos, comandos, DAL, adapter local, read models e interfaces de ativação do dono/recebedor estão implementados sem antecipar gateway externo, checkout, fallback administrativo ou dados bancários; seus sete IDs continuam automatizados, elevando o catálogo de 200 cenários para 23 automatizados — FEAT-002 7 + FEAT-003 9 + FEAT-004 7 — e 177 planejados. A branch `feat/feat-004-owner-onboarding-recipient` foi publicada até `3e3f866c42302df9b0499e9af75575c7c092f3f0`. As duas threads do primeiro review foram respondidas e resolvidas. O segundo review `PRR_kwDOTyzZrs8AAAABJV08Cw`, submetido em `2026-08-12T22:59:35Z` sobre esse commit, abriu o P2 atual `PRRT_kwDOTyzZrs6YwM7k`: contrato superado ainda caía no mapeamento genérico `42501 -> 403`. O patch local agora converte somente `42501 + owner_contract_not_current` em `409 CONFLICT`, preserva bloqueios e outros `42501` como `403 FORBIDDEN` e reutiliza o GET verification-first sem replay. A validação integral atual está verde em Node 24, banco, browser, build e smoke; nova release canônica, publicação, resposta/resolução, novo review, promoção e merge permanecem pendentes;
- aplicações pública e backoffice separadas;
- Node/npm e dependências fixados em lockfile;
- Supabase local via Docker com 14 migrations append-only e head `20260812000200`; Node 24 passou reset, geração e `test:db`, e as quatro suítes permanecem em 355/355 asserts pgTAP (`158 + 78 + 57 + 62`). Readiness aceita o head atual e recusa `20260812000100`; o probe transacional e o pgTAP comprovam ativação com 21 colunas/corpo e recebimentos com 16/sem corpo, com gerados sincronizados e cleanup zero;
- no snapshot publicado anterior ao review, a matriz final das quatro specs FEAT-004 cobriu 14 projetos e terminou com zero resultado inesperado, skip, flake, erro ou attachment; os IDs 001–007 passaram em `3 + 3 + 3 + 4 + 3 + 4 + 3`. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos tiveram 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP do relatório. Banco, Mailpit, portas e processos terminaram sem resíduo. O `index.html` do relatório possui SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`;
- nesse mesmo snapshot anterior, os gates pós-código passaram em 707/707 unitários, 11/11 estáticos de privacidade e na cadeia restante; essa contagem permanece apenas histórica;
- a matriz Playwright integral limpa pré-review permanece histórica: 114/114 em cerca de 5,9 minutos, com relatório SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`;
- no patch atual, os gates completos Node 24 passaram: format, lint sem warnings, typecheck integral, 718/718 unitários em 74 arquivos, docs:check em 34 features/200 cenários/18 ADRs, audit com zero vulnerabilidade, Knip e diff-check; um único reset seguido de `test:db` passou em 355/355, com banco e ambiente limpos;
- a matriz focada atual foi executada uma única vez e passou em 23/23, quatro specs e 14 projetos. SHA-256: relatório `66a4b5ceea14c7affa848748c525adccf684641b377f755a3a9ce3fb05aec6c6`, stdout `ba57e0bd52d165bf422fccc6500eb4fb920c48f785a226baac24e8265c11fe0c` e lista `ed851b7bca361d0e3e50b5632f12251859b5098a12123a2ee2b8ebbb6f11bf59`;
- o guard integral atual coletou 114 testes em 17 specs; uma única execução passou em 114/114 por 16 projetos, preservando 23/23 da FEAT-004. SHA-256: relatório `b68c70ff6f17f55142d11394dd9b6113958a7e49ef82d2c5c70324dfcafe6227`, stdout `7b8b7971f91e8a571cec6ac8bb63fed665bbfcd1b9ead4997a6e0436b76114bc` e lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`; privacidade e cleanup ficaram verdes, sem secrets, PII, resíduo de banco, Mailpit, portas, processos ou temporários;
- o run integral 114/114 anterior permanece apenas como diagnóstico histórico: sua evidência foi rejeitada por 18 telefones QA em 61 títulos `Fill` e quatro snippets; o helper e sete call sites foram redigidos antes da execução limpa final;
- o build atual foi executado uma única vez em Node 24: `npm run build` terminou com exit `0`, sem warnings; log SHA-256 `db0d0049b248dd7b3d438d57ffa0faa465d3cd7a15a9bdd0d6267dc11a4ac162`;
- o smoke runtime real atual, padrão mais FEAT-004, terminou com exit `0`: resumo SHA-256 `a8d41974344ba6eb3b6cb83d626e4b77e9853a2d98e58814d9c795cca356ad0b`, stdout `e15829cc6525d58cab4fa2ed49c33d9e5d6225512b77ec96a21fa2ea3b9703dba` e server log redigido SHA-256 `7ea7719b4af0257044c24c32f252f9327920a069d74b31cac25d3f23d8f089c5`. Foram 14 nonces web, 11 backoffice, três boundaries e dois redirects; as relações ficaram `0 → 0`, e Mailpit, portas, processos, temporários, secrets e PII terminaram em zero;
- por transparência, a primeira tentativa do runner temporário foi recusada antes de spawn por consultar `profile_preferences` em vez de `user_preferences`; log SHA-256 `9757fbc1baf5afcffc4840468f7f7af5c7c1677a924997184376617b8752e2db`. Não houve servidor, request ou temporário residual; a correção alterou somente o harness e foi seguida pela única execução real verde;
- o commit funcional local `79376b62bdce788c9eb7e1f1696d5acfde0cb215` gerou uma única vez, com exit `0` e log SHA-256 `1e8f5bf3d472f2000d8b32d53b0dca2165ec72513f79f407800e4d8d9d56afba`, a release da fotografia anterior `.artifacts/set-livre-79376b62bdce788c9eb7e1f1696d5acfde0cb215.tar.gz`. O archive possui 24.902.933 bytes e SHA-256 `af39e5d2f8f6d919e2adc554e27e214fa170dac12a7285ca8ec9630a7d1f8a1c`; o sidecar tem SHA-256 `0c6bade3db133ccec9a01695a1cd7003d86d0e4275a739f389e3b63a78add5f5`; e o manifesto possui 681.311 bytes e SHA-256 `c6514c43d37b8e687731fa2d8788da52df8df53acec11a640aa7707f4cb1d584`. O tar contém 3.453 membros — 584 diretórios, 2.867 arquivos e dois links —, enquanto manifesto e release cobrem 2.869 folhas: web 1.577, backoffice 1.276, migrations 14, lockfile 1 e manifesto 1. Os dois `BUILD_ID` equivalem ao commit, o head é `20260812000200`, e o gerador rodou em Linux x64 com Node 24.18/npm 11.19; smoke canônico embutido, segurança, buscas de secrets/PII e cleanup ficaram verdes. A auditoria final independente terminou `NO-BLOCKER`. Essa evidência é histórica para o patch local, não ARM64 nem produção; PEND-003 e o smoke ARM64 nativo permanecem pendentes;
- as releases `c115dcd726929f289777cd897cccc97d33a179ee` e `79376b62bdce788c9eb7e1f1696d5acfde0cb215` permanecem fotografias históricas anteriores ao delta local atual e não contêm o patch. Nova release canônica, publicação, resposta/resolução da thread atual, novo review, promoção e merge permanecem pendentes; a feature permanece **Em implementação**, e PEND-003 e o smoke ARM64 nativo continuam obrigatórios para produção;
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
