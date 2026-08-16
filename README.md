# Set Livre — Plataforma Completa

## Implementação end-to-end orientada pela especificação 1.1

Este repositório contém a especificação viva e a implementação da **plataforma completa de aluguel de estúdios audiovisuais Set Livre**. A baseline documental define produto, arquitetura, contratos de dados, fluxos, qualidade e ordem; o código avança em fatias verticais rastreáveis.

Para uma visão direta das tecnologias verificadas no repositório, consulte [`docs/technology-stack.md`](docs/technology-stack.md).

O projeto não descreve o mini fórum comunitário. A aplicação é o marketplace comercial de estúdios, com calendário próprio, reservas, pagamentos, split, repasses, backoffice e operação de produção.

## Estado atual

### FEAT-004 concluída e incorporada

- A FEAT-004 foi concluída e incorporada a `main` pelo [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6), no merge `b4f40035b3e7eda64d94726483d82ece9f01c7ed`, em `2026-08-16T09:24:06Z`. O HEAD final revisado foi `44854dca545ca3aa89e780d83a8a5025007f8b12`; depois da espera integral de 60 minutos, o comentário final REST `5306520356` não encontrou problema relevante, e as seis threads ficaram resolvidas. Ela é a terceira das 34 features concluídas; a próxima fatia da sequência executável é a FEAT-006. Esta captura não atribui `reviewDecision` nem check rollup não observados.
- Na fotografia histórica do quinto P2, o review `PRR_kwDOTyzZrs8AAAABJsAUGQ`/REST `4945089561`, submetido em `2026-08-16T01:07:18Z` sobre `0decf00`, abriu a thread `PRRT_kwDOTyzZrs6Zj15h`, comentário `PRRC_kwDOTyzZrs7h8LaV`/REST `3790648981`, em `owner-recipient-panel.tsx` linha 489. Naquela captura, a thread estava atual, não resolvida e não desatualizada: o documento `local_fixture` podia continuar acompanhado do formulário de aceite em um runtime no qual a ativação seria recusada.
- A correção acrescenta `ownerActivationCapability: "available" | "unavailable"` somente à projeção completa `activation` e ao retorno de sucesso de `owner.activate`. Uma fonte `approved` é sempre `available`; `local_fixture` é `available` somente em `APP_ENV=local | test` e falha fechada nos demais valores, na ausência ou em valor inválido. A projeção compacta de recebimentos e seus retornos permanecem sem esse campo.
- A leitura completa deixa de falhar por causa da fixture: contrato e fatos permanecem consultáveis. Em `unavailable`, `owner.activate` retorna `503 SERVICE_UNAVAILABLE` antes de `activateOwnerProfile` e de qualquer escrita. A UI mantém o documento, mas não monta checkbox, formulário ou CTA; apresenta o alerta **Ativação como dono indisponível** com o texto **A versão aprovada do contrato do dono ainda não está disponível neste ambiente. O contrato atual permanece somente para consulta.** Não há controle desabilitado, aprovação jurídica simulada, migration ou provider novo.
- Antes do browser, o snapshot da capability passou na cadeia estática integral com 747/747 unitários e no banco com 358/358. A primeira rodada focada coletou 23 testes em quatro specs/14 projetos — lista SHA-256 `615bf589...` — e terminou uma única vez com exit `1`: 12 passaram, `SL-F004-E2E-001` falhou em `critical-webkit`, dez não executaram e houve zero rerun. O provisionamento compartilhado acionou o submit HTML nativo do cadastro antes da hidratação, transformou-o em GET e colocou campos sintéticos na query. Isso é uma falha real de privacidade da FEAT-002, não evidência da capability P5; a suíte integral não iniciou. O stdout redigido `f4d0595a...` e a auditoria `13859c3c...` são os únicos artefatos preservados; os brutos foram removidos sem reproduzir valores ou endereço, e o cleanup terminou em zero.
- A correção fecha o `RegistrationForm` no HTML SSR: `useSyncExternalStore` entrega `false` no servidor e `true` no cliente; o status **Preparando o formulário seguro…** fica fora do único `form`, que usa `inert`, `method=post` e `aria-busy`, enquanto um `fieldset` externo, os sete controles nomeados e o submit permanecem disabled até a hidratação. Depois dela, o fluxo normal é restaurado. Os novos unitários passaram em 2/2 e a guarda de identidade combinada em 22/22; `SL-F002-E2E-001` foi ampliado, sem novo ID, com contexto sem JavaScript.
- Depois da rejeição diagnóstica da race, a focada race-fixed executou os mesmos 23 testes em quatro specs/14 projetos e passou em 23/23; esse resultado foi reutilizado e validado pela auditoria final.
- A rodada attribute-fixed coletou 114 testes em 17 specs/16 projetos e sua única execução passou em 114/114 em 5,6 minutos, com zero retry, erro ou attachment. A FEAT-004 preservou 23/23 na distribuição `3 + 3 + 3 + 4 + 3 + 4 + 3`; a extensão sem JavaScript de `SL-F002-E2E-001` passou nos três engines dentro da contagem existente.
- A auditoria encontrou 140 ocorrências dos 88 e-mails QA, somente em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22 — e zero secret, PII ou evidência sensível fora da allowlist. Cleanup terminou em zero. Evidência segura: `.artifacts/p5-owner-activation-capability-attribute-fixed/full.audit.json`, SHA-256 `5704c67cf21bdcc6e92b733bfdb8788972c216d48f850c885200b6d4d78a37d6`.
- As execuções rejeitadas anteriores permanecem histórico diagnóstico: a primeira revelou o defeito pré-hidratação já corrigido; as demais registram races de harness/oráculo. Elas não descrevem falha atual do produto. No fechamento browser anterior ao hardening de build, static 749/749, DB 358/358, focada 23/23 e integral 114/114 ficaram verdes. Depois do browser, uma única invocação `APP_RELEASE_SHA=local npm run build` em Node 24/npm 11 terminou com exit `0`, 26 rotas web, quatro do backoffice, zero warning e `BUILD_ID=local`; o log privado tem SHA-256 `3b03b8f64e70dcf29e713f8b6ab006f4a544e43fd761ce0eb8b283eac9de432c`. Isso não aprovou o gate: a auditoria recusou o artefato porque o standalone copiou o `package.json` raiz, cujo `scripts.knip` ainda continha strings de conexão administrativas/DAL locais. Nenhum smoke foi iniciado (`0`).
- A correção reduz `scripts.knip` ao comando exato `knip`; os valores E2E continuam vindo do `.env.e2e.local` físico já lido pelo config, sem literais no manifesto. A unidade de npm confiável fixa esse contrato e recusa `E2E_DATABASE_URL`, `DATABASE_URL_APP_DAL` ou URI PostgreSQL em qualquer script npm dos quatro manifests canônicos — raiz, backoffice, contracts e UI. Prettier/ESLint direcionados, o recorte unitário 4/4, `npm run knip` com as sete variáveis E2E explicitamente unset e diff-check passaram; o lockfile não mudou.
- A build pós-manifesto foi então executada uma única vez e terminou com exit `0`; o log privado `.artifacts/p5-owner-activation-capability-build-smoke-fixed/build.log` tem SHA-256 `d8e50e0fb0b7080bf021aa910bef7ededc6677ba6dfaa71d4789a1d6226e1a8e`. O audit recusou novamente o gate porque restou exatamente uma ocorrência DAL em cada cache Turbopack, enquanto standalone, static e log ficaram limpos; o smoke permaneceu em zero. O wrapper único `scripts/next-build.mjs`, chamado sozinho pelos scripts de build dos dois apps e reutilizado pelo gerador de release com ambiente allowlisted, autoriza a raiz web/backoffice. Dentro da operação primária, `resolveTrustedNextCliLaunch` valida ancestrais físicos/protegidos do manifesto do app, Node/npm e pacote/binário/versão Next antes do spawn; depois o wrapper sempre tenta remover fisicamente apenas o `.next/cache` autorizado, inclusive quando essa validação ou o build falham. Falha de cleanup reprova o comando, e falhas simultâneas são preservadas em `AggregateError`; standalone/static não são tocados e raiz externa é recusada. O preview `npm start` também entrega `cleanupBuild` ao supervisor pai depois que o grupo de build encerra por sucesso, exit, sinal ou falha; cleanup falho impede validação/start, e falha dupla vira `AggregateError`. A integração prova que um valor DAL sintético no cache some antes do servidor. O run direcionado final passou em 40/40 por quatro arquivos — 12 de cache/wrapper, quatro do npm confiável, 16 de Next/local server e oito do supervisor de preview — junto a Prettier/diff-check, ESLint zero, checks Node e Knip com as sete variáveis E2E unset. Um run diagnóstico anterior ficou em 31/32 apenas por texto esperado antigo e foi corrigido somente no oráculo, sem falha de produto.
- O snapshot pós-hardening fechou a cadeia estática em Node 24/npm 11: `npm ci` 447 instalados/451 auditados/zero vulnerabilidades, format, lint, typecheck, 749/749 unitários em 75 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check. Uma asserção auxiliar incorreta do hash de `next-env` interrompeu a orquestração depois do typecheck; somente os gates restantes foram retomados com autorização, e nenhum gate do projeto falhou. O banco pós-hardening também passou em 358/358 (`158 + 78 + 57 + 65`), com gerados byte-identical, 15 migrations e head `20260815000100`. A pausa cruzou reset e geração; a primeira invocação `test:db`, interrompida após `0001`, é inválida, teve cleanup limpo e foi substituída por uma única invocação autorizada sem novo reset/geração. Os 23/23, 114/114, build e release `969f30cd...` permanecem históricos do quarto P2. Naquele boundary, a FEAT-004 ainda estava em implementação; PEND-003 e o smoke ARM64 nativo continuam obrigatórios para produção.
- A cadeia estática final foi executada uma única vez em Node 24/npm 11 e ficou verde: `npm ci` 447/451/zero vulnerabilidades, format, lint zero, typecheck de web/backoffice/contracts/UI/testes, 764/764 unitários em 76 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check; o freeze permaneceu em 53 paths, sendo 34 tech e 19 docs. Depois da remoção física dos dois `.next`, a build final via wrapper foi executada exatamente uma vez, terminou com exit `0` em 14,733 s e gravou `.artifacts/p5-owner-activation-capability-build-smoke-cache-clean/build.log`, 2.155 bytes, SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. A auditoria independente `build.audit.json`, SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d`, terminou `NO-BLOCKER`: 26 + 4 rotas, zero warning, quatro `BUILD_ID=local`, zero cache/retired, standalone/static/log/packages/symlinks/privacy/inputs/cleanup verdes e DB 15/Mailpit/dblink/portas/processos sem resíduo. Nesse fechamento pré-release, o smoke ainda estava em zero.
- O commit funcional `2045d1a00c15889007b3c5c04c08d0467fc3d9b3` foi processado exatamente uma vez pelo gerador canônico: exit `0` em 21,26 s. O primeiro smoke P5 foi o embutido e ficou verde antes da publicação local do archive. `.artifacts/set-livre-2045d1a...tar.gz` possui 24.896.963 bytes, modo `0600` e SHA-256 `282f9d173eebf99ba63466d81f4aa4b9061e7d73668c267fb0a25e9e86043b92`; sidecar 124 bytes/`8955c004a68401dfd27190d26ac1e92157a635fbf191977c2d7408e4c95f1eb0`, manifesto 681.762 bytes/`d8b698ecef6b6c52f4961e8783ef2c1e68b5ab00239de4de9206cb9f2f2d2026` e log 2.097 bytes/`505a5fd915bacd59d3deea9c16c615cee82a9026ba17ac66ac6e4475a4c8d40e`. São 2.871 artefatos e 3.455 membros no tar; ambos os `BUILD_ID` equivalem ao commit. Duas auditorias `NO-BLOCKER` fecharam paridade, smoke, privacidade e cleanup sem mismatch ou resíduo. A release é somente local Linux x64 Node 24.18/npm 11.19, ignorada pelo Git e não publicada; ARM64/Oracle/PEND-003 continuam pendentes e o merge não equivale a go-live.

### FEAT-006 em implementação

O snapshot funcional mantém 3/34 features concluídas e a FEAT-006 em implementação. OPEN-012,
OPEN-013 e FEAT-031 bloqueiam sua conclusão. `20260816000100` permanece imutável; a 17ª migration
append-only, `20260816000200`, é o head/readiness de fonte, com predecessor imediato `00100` esperado
falso. O último banco comprovadamente verde continua em 431 asserts no head anterior
(`158 + 78 + 57 + 65 + 73`). A fonte atual eleva o plano da feature a 83 casos e o total esperado a
441, ainda sem execução; `schema.generated.sql` e `database.generated.ts` estão defasados e exigem o
ciclo canônico reset → geração → teste. Readiness conserva 19 rotinas e 20 dependências.

O catálogo vivo contém 201 cenários: P0 134, P1 67, P2 0, smoke 3, critical 131, regression 61,
accessibility 2 e reflow 4. São 29 automatizados — `7 + 9 + 7 + 6` — e 172 planejados; quatro
cenários exigem zoom 200%. Os seis IDs da FEAT-006 são `SL-F006-E2E-001` a `006`: o ID 001 prova
pending no mesmo escopo, um único POST e preservação do bruto; o 002 descarta com
`draft_removed`; o 003 fecha a troca dirty A → B; o 004 cobre teclado; e o 006 dedica a prova de
reflow a 200%. A fonte atual projeta a focada em 20 testes, três specs e dez projetos, e a coleção
integral em 134 testes. Essas duas coleções ainda não foram executadas.

A única evidência browser aceita permanece histórica: 17/17 em duas specs/sete projetos, anterior
aos seis IDs atuais. A lista integral histórica tinha 131 testes, 19 specs e 16 projetos, sem run
verde. No browser, stale/compare é a atribuição correta; tombstone pertence a SQL/unitários. A
última suíte unitária integral também é histórica, 893/893 antes do helper e do hardening atuais.
O recorte dirigido anterior passou em 124/124 por dez arquivos; o atual passou em 141/141 por 12
arquivos FEAT-006/studio sob Node 24, incluindo correlação e remount. Nenhum é uma integral ou prova
SQL. A tentativa da suíte
completa atual falhou em 12 testes de infraestrutura por limites do sandbox — nested spawn `EPERM`,
remapeamento de ownership raiz e timeouts de process group ou stdout vazio — e não é gate verde.

O header de escopo esperado do GET é somente uma asserção de coerência e nunca autenticação. O
probe dirty/pending fecha o DOM e referências brutas, sem consultar nem popular o `QueryCache`; um
latch de unmount/pós-`await` suprime callbacks tardios. Nenhum payload sensível pode chegar à URL,
storage ou cache. Na criação ambígua, o escopo estável é S1 e cada nova tentativa usa uma chave K
nova. A fonte desktop-chromium do ID 005 fixa a sequência K1/S1/A ambígua → GET 404 → usuário edita
B → K1 confirma A → K2/S1/B recebe 409 → comparação A/B. “Usar versão atual” navega explicitamente
para A; “reaplicar” preserva B e um save explícito usa K3 para atualizar o único S1 com
`expectedEditVersion`. Esse roteiro está implementado na fonte, mas continua sem execução e sem selo
verde; o fluxo nunca repete POST automaticamente.

Create/update serializam a seleção ativa com `FOR SHARE`; a FEAT-031 deve arquivar tipo-only ou
preservar a ordem agregado → tipo do update, com prova bidirecional se também travar studio. Publicado sem draft clona
mesmo com core idêntico; no-op só vale para draft existente idêntico e ainda remonta o form. Auditoria
usa `requestId` e chave em campos separados, metadata estrutural e uma ação por efeito; replay
preserva o primeiro fato, enquanto no-op/falha/conflito geram zero.

Continuam pendentes o `docs:check` canônico, a suíte unitária integral, reset/geração/DB 441, a
focada browser 20 e a integral 134, build das duas aplicações, smoke, release e validação ARM64,
além de OPEN-012/013 e FEAT-031. A migration `00200` teve apenas inspeção estática/diff; os arquivos
SQL/pgTAP novos ainda estão untracked, logo nenhum checksum Git substitui a futura prova do banco
aplicado. Nenhum desses gates é apresentado como verde.

### Fotografia histórica até o quarto P2

Os registros abaixo pertencem aos snapshots fechados dos quatro P2 anteriores. Seus artefatos 23/23, 114/114, builds, smokes e releases permanecem históricos; não validam `ownerActivationCapability`.

- fundação local executável incorporada a `main`, sem feature de produto simulada;
- FEAT-002 incorporada a `main` pelo [PR #2](https://github.com/PedroRomeroM/set-livre/pull/2), no merge `d272657`; é a primeira das 34 features concluídas no repositório. Uma revisão posterior ao merge apontou dois hardenings P2, já corrigidos e validados integralmente na branch da FEAT-003;
- FEAT-003 concluída e incorporada a `main` pelo [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4), no merge `465d195`; o HEAD final `1530f62589` recebeu a revisão Codex limpa `5262964258` às `06:00:43Z`, as cinco threads do PR ficaram resolvidas e a feature passa a ser a segunda das 34 concluídas no repositório;
- FEAT-004 concluída e incorporada a `main`: contratos, comandos, DAL, adapter local, read models e interfaces de ativação do dono/recebedor foram entregues sem antecipar gateway externo, checkout, fallback administrativo ou dados bancários; seus sete IDs continuam automatizados, elevando o catálogo de 200 cenários para 23 automatizados — FEAT-002 7 + FEAT-003 9 + FEAT-004 7 — e 177 planejados. Na fotografia publicada do segundo P2, a branch `feat/feat-004-owner-onboarding-recipient` avançou no remoto de `3e3f866c42302df9b0499e9af75575c7c092f3f0` até `011a48f4910baa0e17b26dee6eda3c678d910572`: o commit funcional era `440c81f6cc44cc95ed281d84e9a5124ae98a59c4`, e `011a48f4...` registrava a documentação da release. Naquele snapshot, HEAD local e remoto coincidiam em `011a48f4...`. As duas threads do primeiro review foram respondidas e resolvidas. O segundo review `PRR_kwDOTyzZrs8AAAABJV08Cw`, submetido em `2026-08-12T22:59:35Z` sobre `3e3f866c...`, abriu o P2 `PRRT_kwDOTyzZrs6YwM7k`: contrato superado ainda caía no mapeamento genérico `42501 -> 403`. O patch publicado converte somente `42501 + owner_contract_not_current` em `409 CONFLICT`, preserva bloqueios e outros `42501` como `403 FORBIDDEN` e reutiliza o GET verification-first sem replay. A thread recebeu a resposta [`PRRC_kwDOTyzZrs7h4a21`](https://github.com/PedroRomeroM/set-livre/pull/6#discussion_r3789663669), REST `3789663669`, em `2026-08-15T15:36:08Z`; a resposta foi verificada na própria thread, que então foi resolvida por `PedroRomeroM` ainda atual e não outdated. Naquela fotografia, a validação integral ficou verde em Node 24, banco, browser, build, smoke e release canônica local. O terceiro e o quarto P2 posteriores também foram publicados, respondidos e resolvidos em fotografias próprias. Na captura do quinto review, publicação, resposta e resolução ainda eram pendentes; o fechamento pós-merge está registrado no início desta seção;
- aplicações pública e backoffice separadas;
- Node/npm e dependências fixados em lockfile;
- na fotografia histórica, Supabase local possuía 14 migrations/head `20260812000200` e passou em 355/355 pgTAP; esse head foi superado por `20260815000100`;
- no snapshot publicado anterior ao review, a matriz final das quatro specs FEAT-004 cobriu 14 projetos e terminou com zero resultado inesperado, skip, flake, erro ou attachment; os IDs 001–007 passaram em `3 + 3 + 3 + 4 + 3 + 4 + 3`. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos tiveram 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP do relatório. Banco, Mailpit, portas e processos terminaram sem resíduo. O `index.html` do relatório possui SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`;
- nesse mesmo snapshot anterior, os gates pós-código passaram em 707/707 unitários, 11/11 estáticos de privacidade e na cadeia restante; essa contagem permanece apenas histórica;
- a matriz Playwright integral limpa pré-review permanece histórica: 114/114 em cerca de 5,9 minutos, com relatório SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`;
- no segundo P2 histórico, os gates completos passaram em 718/718 unitários, banco 355/355, browser focado 23/23 e integral 114/114; os hashes permanecem registrados nos documentos especializados;
- o run integral 114/114 anterior permanece apenas como diagnóstico histórico: sua evidência foi rejeitada por 18 telefones QA em 61 títulos `Fill` e quatro snippets; o helper e sete call sites foram redigidos antes da execução limpa final;
- o build histórico terminou sem warnings; log SHA-256 `db0d0049b248dd7b3d438d57ffa0faa465d3cd7a15a9bdd0d6267dc11a4ac162`;
- o smoke runtime real histórico do segundo P2, padrão mais FEAT-004, terminou com exit `0`: resumo SHA-256 `a8d41974344ba6eb3b6cb83d626e4b77e9853a2d98e58814d9c795cca356ad0b`, stdout `e15829cc6525d58cab4fa2ed49c33d9e5d6225512b77ec96a21fa2ea3b9703dba` e server log redigido SHA-256 `7ea7719b4af0257044c24c32f252f9327920a069d74b31cac25d3f23d8f089c5`. Foram 14 nonces web, 11 backoffice, três boundaries e dois redirects; as relações ficaram `0 → 0`, e Mailpit, portas, processos, temporários, secrets e PII terminaram em zero;
- por transparência, a primeira tentativa do runner temporário foi recusada antes de spawn por consultar `profile_preferences` em vez de `user_preferences`; log SHA-256 `9757fbc1baf5afcffc4840468f7f7af5c7c1677a924997184376617b8752e2db`. Não houve servidor, request ou temporário residual; a correção alterou somente o harness e foi seguida pela única execução real verde;
- a release `440c81f6...` foi canônica somente para o segundo P2: possui 14 migrations/head `20260812000200` e agora é histórica, assim como `c115dcd...`, `79376b62...` e a release do terceiro P2; nenhuma contém a capability final. Naquele recorte a feature permanecia em implementação; PEND-003/smoke ARM64 continuam obrigatórios para produção;
- no snapshot funcional final da FEAT-003, passaram 578/578 unitários de 60 arquivos e uma matriz Playwright/axe integral de 91/91 em 3,9 minutos — 32/32 da feature, cobrindo sem alterar contagens os IDs `SL-F003-E2E-001` a `009`. O ID 004 passou em 3/3 projeções: logout stale recebeu `409`, a sessão e o perfil de B permaneceram intactos e houve zero `pageerror` ou erro React; o ID 009 passou em 4/4, com falha offline imediata, exatamente uma request e nenhum POST tardio após reconexão;
- a auditoria browser histórica da FEAT-003 terminou com zero resultado inesperado, flake, skip, erro ou attachment e não encontrou sentinelas, tokens, cookies Auth nem documentos crus. Os 62 e-mails QA sintéticos únicos apareceram em 114 ocorrências exclusivamente nos títulos automáticos allowlisted dos steps: `Fill` 84, `Visible` 18, `Count` 4 e `Type` 8. Cleanup de banco, Mailpit, portas e processos terminou sem resíduos;
- os builds históricos da FEAT-003 em Next.js 16.3 passaram para web e backoffice sem warnings, com manifests standalone, 17 arquivos obrigatórios e `BUILD_ID` local em cada app; os smokes aprovaram live/ready/root, CSP, `no-store`, assets, nonces e probes adversariais, incluindo `/entrar` 200 no web e 404 no backoffice. Lockfile e gerados permaneceram inalterados, e o cleanup terminou com zero porta ou processo residual. Logs: build `2e3b…4310`; smoke `c9e5…da97`;
- a release `f4f3b1d13238bdb67a2bc77bff55c119132040dc`, com 2.809 artefatos e SHA-256 `571a0dbdee91d17c47158e0b00aaa0c6bcd4ce6d2f4ffa7f06f1fb6afc4ff887`, permanece como evidência histórica anterior aos dois P2 da FEAT-003. O snapshot funcional final dessa mesma feature, no commit `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7`, gerou localmente `set-livre-e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7.tar.gz` com 24.757.341 bytes e SHA-256 `6edb2e246e0b3f46cf83f62ce8685e14b91cb31ac1437931f476fc649621273a`. São 2.809 artefatos — web 1.519, backoffice 1.276, migrations 12, lockfile 1 e manifesto 1 —; o manifesto possui 667.285 bytes e SHA-256 `733dac5409c04d8fd1c39fcd2b867d0f812a75b4792479ead416ecf9f11f0135`. Ambos os `BUILD_ID` equivalem ao commit, em Linux x64 com Node 24.18/npm 11.19. A auditoria integral de tar, staging e manifesto terminou `NO-BLOCKER`, sem segredo de runtime nem dado PII/QA e sem resíduo;
- resumo executivo vivo em `contexto-projeto-set-livre.html`, atualizado junto de cada mudança técnica;
- 3 de 34 features estão concluídas; a próxima é a FEAT-006, conforme a sequência canônica de `docs/implementation-order.md`, uma por branch/PR.

O ADR-019 liberou a configuração controlada de CI/CD, Supabase Cloud, Oracle, DNS e TLS. Isso ainda não é go-live: PEND-001/002/003 só fecham após environment/secrets, DAL Cloud, VM/hardening, DNS/TLS, runs e smokes reais. Supabase local permanece obrigatório para testes destrutivos, e pagamentos/demais APIs externas continuam suspensos pelo ADR-018.

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
