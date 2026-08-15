# FEAT-004 — Ativação de dono e onboarding de recebedor

## Metadados

| Campo            | Valor                                                                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Em implementação                                                                                                                                                                                                                                                                  |
| Prioridade       | P0                                                                                                                                                                                                                                                                                |
| Domínio          | `owners-payments`                                                                                                                                                                                                                                                                 |
| Specs Playwright | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`<br>`tests/e2e/regression/feat-004-owner-onboarding-recipient.spec.ts`<br>`tests/e2e/accessibility/feat-004-owner-onboarding-recipient.spec.ts`<br>`tests/e2e/reflow/feat-004-owner-onboarding-recipient.spec.ts` |

## Objetivo

Permitir que um usuário atue como dono e conclua o cadastro exigido pelo gateway para receber 80% das reservas.

## Papéis

- usuário autenticado
- dono

## Rotas e superfícies

- /dono
- /dono/recebimentos

## Dependências

- `dependency-to-start`: FEAT-003
- `dependency-to-complete`: FEAT-034, para direitos LGPD sobre os novos fatos
- `dependency-to-release`: PEND-004 e PEND-006
- bootstrap: recorte server-only de `PaymentProvider` com adapter local determinístico

## Incluído

- Aceite do contrato do dono.
- Criação do perfil de dono.
- Encaminhamento server-side do contexto minimizado exigido pelo contrato local do provider.
- Status e requisitos pendentes.
- Atualização de status e retentativa.
- Bloqueio de reservas quando o recebedor não está apto.

## Fora desta feature

- KYC próprio
- armazenar credenciais bancárias completas
- escolher múltiplos gateways
- SDK, HTTP, credenciais, webhook ou sandbox remoto do gateway
- cartão, PIX, split, refund, payout e checkout
- fallback ou autoridade administrativa
- dados comerciais duplicados do perfil

## Regras de produto e domínio

- A ativação como dono não concede papel administrativo.
- O identificador do recebedor permanece privado.
- O status externo é mapeado para o contrato interno.
- Estúdio pode ser editado antes da ativação, mas não reservar.
- Fallback financeiro precisa de liberação de admin e auditoria.
- Nesta fatia, somente dono `active` com contrato vigente aceito e recebedor `active` na versão atual do perfil libera a elegibilidade; o fallback pertence à FEAT-032.
- Nova versão vigente do contrato preserva o aceite anterior como histórico, fecha a elegibilidade e exige novo aceite idempotente.
- “Sandbox” nos cenários significa exclusivamente o adapter local determinístico enquanto o ADR-018 estiver vigente.
- Contrato com `source=local_fixture` e adapter local são recusados fora de `local | test`; nenhum deles representa aprovação jurídica ou comercial.
- Os únicos requisitos públicos são `identity_review | additional_information | provider_contact`; a próxima ação usa `activate_owner | start_onboarding | refresh_status | none`.
- O adapter local nominal faz `start -> pending` e `refresh -> active`. Os demais estados e falhas são fixtures locais de teste e nunca dependem de e-mail ou UUID mágico.
- As leituras autenticadas de ativação e recebimentos expiram no servidor em 2.000 ms com `AbortSignal` e race real; transporte não cooperativo ou resultado tardio não mantém a request nem publica estado depois do prazo.
- `/dono` e `GET /api/owner/activation` consomem a projeção completa de ativação com 21 colunas, inclusive o documento jurídico necessário ao aceite. `/dono/recebimentos`, `GET /api/owner/recipient` e os retornos de `recipient.onboarding.start | refresh` consomem a projeção compacta de 16 colunas, sem título, versão textual, hash ou corpo Markdown do contrato.

## Dados canônicos afetados

- `owner_profiles`
- `owner_payment_recipients`
- `terms_acceptances`
- `audit.events`

## Read models

- `get_owner_activation_status`: projeção completa exclusiva da ativação;
- `get_owner_recipient_status`: projeção compacta do recebedor.

## Comandos e integrações

- owner.activate
- recipient.onboarding.start
- recipient.onboarding.refresh
- `recipient.bank.update` permanece diferido até existir token ou handoff provider-owned aprovado

## UX e estados obrigatórios

- Checklist com status factual.
- Os erros do provider são traduzidos para mensagens seguras.
- Sem mostrar payload/KYC desnecessário.
- CTA depende do requisito pendente.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

Quando `Verificar estado atual` inicia o `GET /api/owner/recipient`, a superfície privada anterior fecha e dá lugar ao boundary neutro de validação. Ao concluir com sucesso, o foco programático retorna ao heading `Etapas para receber reservas`; se a leitura falhar, o foco vai ao alerta seguro da área indisponível. Nesse segundo estado, `Tentar novamente` reutiliza o mesmo intent de foco: fecha a superfície durante o novo GET e retorna ao heading somente depois de uma resposta autoritativa bem-sucedida. Nenhuma das duas ações reenvia o comando ambíguo.

`CONFLICT` e `VALIDATION_FAILED` sem `fieldErrors` indicam que o snapshot pode ter ficado stale: a ação é desabilitada até um GET autoritativo e o POST não é repetido. Validação realmente vinculada a campo, como o aceite local do contrato, continua editável e apresenta `fieldErrors` no próprio formulário.

Quando a preparação de `recipient.onboarding.start | refresh` encontra uma nova versão vigente do contrato, o banco sinaliza exatamente SQLSTATE `42501` com `owner_contract_not_current`. O serviço traduz somente essa combinação para `409 CONFLICT`, ativando a recuperação por leitura já existente. Outros `42501`, inclusive dono ou recebedor bloqueado, continuam `403 FORBIDDEN`; a mensagem privada do banco não atravessa a API.

## Segurança e privacidade

- O provider é chamado somente no servidor.
- Dados sensíveis minimizados.
- Limite de taxa.
- O adapter e a consulta server-side mapeiam somente estados allowlisted; webhook pertence à integração externa futura.

## Critérios de aceitação

- Usuário vira dono após aceite.
- Os estados pendente, ativo e recusado do recebedor são apresentados corretamente.
- Um recebedor inativo impede o checkout.
- Outro usuário não lê status.
- SSR e refetch encerram uma leitura retida em 2.000 ms e oferecem recuperação sem aceitar resultado tardio.
- A retentativa é idempotente.

## Playwright obrigatório

| ID              | Prioridade | Suíte         | Viewport       | Cenário                                                 | Spec                                                                  |
| --------------- | ---------- | ------------- | -------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| SL-F004-E2E-001 | P0         | critical      | desktop        | ativar perfil de dono com aceite                        | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-002 | P0         | critical      | desktop        | iniciar onboarding no adapter local e exibir pendência  | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-003 | P0         | critical      | desktop        | recebedor ativo libera elegibilidade de reserva         | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-004 | P1         | regression    | mobile         | concorrência/ambiguidade exigem GET sem repetir POST    | `tests/e2e/regression/feat-004-owner-onboarding-recipient.spec.ts`    |
| SL-F004-E2E-005 | P0         | critical      | desktop        | GET retido fecha A e recompõe SSR somente com B         | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-006 | P1         | accessibility | desktop/mobile | axe, teclado, foco e nomes acessíveis nas duas rotas    | `tests/e2e/accessibility/feat-004-owner-onboarding-recipient.spec.ts` |
| SL-F004-E2E-007 | P1         | reflow        | 160x360        | 503/GET fecham a superfície e restauram foco em 160x360 | `tests/e2e/reflow/feat-004-owner-onboarding-recipient.spec.ts`        |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- os IDs 004/007 comprovam com `toBeFocused()` o foco restaurado no heading do checklist após o `GET` bem-sucedido; o ID 007 também simula GET 503, aciona `Tentar novamente`, observa um GET real 200 e exige o heading focado;
- no ID 005, o browser retém o GET de B na página e no `QueryClient` ainda montados sob A, exige o boundary antes do hard reload, comprova no `pagehide` que a superfície de A foi desconectada, recompõe SSR somente com B e observa zero `pageerror`/erro React. O callback tardio complementar não é alegado como browser: testes unitários usam `MutationObserver` real com latch e provam que a key de A não é recriada depois do seed autoritativo de B;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace, screenshot e vídeo ficam `off` nas quatro specs para não persistir PII sintética nem referências privadas; a evidência usa asserções semânticas e varredura negativa;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: provider status mapping
- integração: contrato do adapter local determinístico
- DB/RLS owner recipient
- auditoria da ativação e das transições do recebedor

No head `20260812000100`, reset e geração passaram e as quatro suítes pgTAP somaram 355/355 asserts (`158 + 78 + 57 + 62`). A suíte `0004` prova RLS/ACL, A/B, personas adversariais, ativação/prepare/apply, renovação, drift, concorrência com a mesma chave e zero resíduo final.

Após o primeiro review draft do PR #6, a correção publicada acrescentou a migration append-only `20260812000200_owner_recipient_projection_split.sql`; a árvore passou a 14 migrations e o head declarado a `20260812000200`. A migration anterior permanece imutável. Os contratos e testes diferenciam a projeção completa de ativação (21 colunas) da projeção compacta de recebimentos (16), e o cenário 004 provoca concorrência real em dois contextos para exigir `409`, um GET autoritativo e nenhum replay do POST. No commit posteriormente revisado `3e3f866c42302df9b0499e9af75575c7c092f3f0`, Node 24 passou reset, geração e pgTAP em 355/355 no novo head, com readiness verde, head anterior recusado, gerados sincronizados e cleanup zero; gates e browser também ficaram verdes, com evidência limpa aceita. Esses resultados são históricos para o patch local atual, assim como os 23/23, 114/114 e 707/707 descritos imediatamente abaixo pertencem ao snapshot publicado anterior.

Nesse snapshot publicado anterior, a suíte unitária integral final pós-código passou em 707/707. A rodada estática de privacidade passou em 11/11; format, ESLint, typechecks, docs:check, audit com zero vulnerabilidade, Knip, coleta estática de 23 testes Playwright e diff-check também passaram.

A primeira matriz browser foi interrompida com uma falha e 22 testes não executados por locator ambíguo, corrigido depois com `exact: true`. A execução seguinte chegou ao ID 005 e terminou com 7 testes passados, uma falha e 15 não executados: o oráculo tentou `fulfill` de um POST depois do hard reload e recebeu `Route is already handled`. Ambos são resultados diagnósticos inconclusivos, não evidência final nem falha do produto.

Naquela fotografia pré-review, uma única invocação das quatro specs FEAT-004 passou em 23/23, exit `0`, em cerca de 2,0 minutos, distribuída por 14 projetos; os IDs 001–007 passaram respectivamente em `3 + 3 + 3 + 4 + 3 + 4 + 3` execuções. Houve zero resultado inesperado, skip, flake, erro ou attachment. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos apareceram em 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP do relatório. Banco, Mailpit, portas e processos terminaram em zero. O `index.html` histórico tem SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`.

Os IDs `SL-F004-E2E-001` a `007` estão `automatizado`. A primeira integral seguinte terminou funcionalmente em 114/114, mas sua evidência foi rejeitada porque 18 telefones QA apareceram em 61 títulos `Fill` e quatro snippets; esse run permanece somente como diagnóstico histórico. O helper passou a preencher o input dentro de `Locator.evaluate`, usando setter nativo e `InputEvent`, e os sete call sites foram redigidos.

Ainda naquele snapshot pré-review, uma única invocação Node 24 com `workers=1`, `max-failures=1` e `retries=0` passou a matriz integral limpa em 114/114, exit `0`, cerca de 5,9 minutos, 17 specs e 16 projetos. Houve zero resultado inesperado, skip, flake, erro, attachment ou mídia. A FEAT-004 permaneceu em 23/23, com IDs 001–007 em `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório histórico tem SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`.

A auditoria encontrou zero ocorrência dos 28 telefones QA, inclusive formatos e sequências, zero step sensível `Fill`/`Type`/`PressSequentially` e zero sentinela, token, cookie Auth, URL de banco, referência privada do provider ou documento QA. Os 88 e-mails QA únicos apareceram em 140 ocorrências somente nos títulos allowlisted: FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Banco, Mailpit, portas e processos terminaram em zero.

Na fotografia publicada imediatamente anterior ao novo P2, Node 24 passou format, lint sem warnings, typecheck integral, 716/716 unitários em 74 arquivos, docs:check em 34 features/200 cenários/18 ADRs, audit com zero vulnerabilidade, Knip e diff-check; o banco permaneceu em 355/355. A invocação focada única passou em 23/23, quatro specs, 14 projetos e 126,0 segundos, com distribuição `3 + 3 + 3 + 4 + 3 + 4 + 3` e zero resultado inesperado, flake, skip, erro, retry ou attachment. O relatório tem SHA-256 `64f80b00b8846a8157fe31708f95c28203ec5a843d383a75ae5b846e823c6df5`, `.last-run.json` tem `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903` e stdout tem `9937c3af59131be284ad176f49c289cc6e713e77e20bc015c436f42c06abf757`. A auditoria aceitou 26 e-mails em 26 títulos `Fill`, sem dado sensível fora da allowlist. Essa fotografia continua válida para o commit revisado `3e3f866c42302df9b0499e9af75575c7c092f3f0`, mas não valida o patch local posterior.

O guard integral dessa mesma fotografia coletou 114 testes em 17 specs; a execução única passou em 114/114 por 16 projetos, em cerca de 5,7 minutos, sem resultado inesperado, flake, skip, erro, retry ou attachment. A FEAT-004 permaneceu em 23/23 e na mesma distribuição. O relatório tem SHA-256 `c2143d928e122aef944ead5c5999287828446c5f1d081c11daa0a33240f7f66f`, `.last-run.json` tem `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`, stdout tem `27092f939a36f3dde07eeb3c27ec3bf52cace5d034243591ad04748b0f3fe559` e a lista tem `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`. A auditoria encontrou zero dado sensível e zero telefone; os 88 e-mails ficaram nas 140 ocorrências allowlisted, e as 15 relações do banco, Mailpit, dblink, portas, processos e temporários terminaram em zero.

O build canônico da mesma fotografia histórica foi executado uma única vez em Node 24: `npm run build` terminou com exit `0`, 26 rotas web e quatro do backoffice, sem rerun; log SHA-256 `ae46bace1364f77876042025799515a6be0f78ef48afea0d6f343c12ed0d7e68`. Os artefatos auditados ficaram em web `1.576 + 1`, hash `e62803b6…`, e backoffice `1.275 + 1`, hash `a905ef2f…`; agregado técnico estável `960cc18a…`.

O smoke runtime dessa fotografia histórica terminou com exit `0`; log SHA-256 `85db0dad1e7cbd999e4427222fdd1b685a3747ffde154eb5a46b444e9cf8f735` e server log redigido `4da1f9af3e0bb34285be99be0ef71d4cefa22108bbe817c23c4c8983828755bf`. O contrato release-equivalent ficou verde, com 14 nonces web e 11 backoffice únicos. Ativação e recebimentos guest retornaram `401` com UUID; as duas rotas do dono emitiram redirects streaming exatos; o POST sintético com Host/Origin exatos e sem cookie retornou `401` com UUID. As 15 relações ficaram `0 → 0`; dois secrets canônicos, PIDs, portas e temporários terminaram em zero.

O commit funcional local `79376b62bdce788c9eb7e1f1696d5acfde0cb215` foi empacotado uma única vez, com exit `0` e log SHA-256 `1e8f5bf3d472f2000d8b32d53b0dca2165ec72513f79f407800e4d8d9d56afba`. Essa release histórica `.artifacts/set-livre-79376b62bdce788c9eb7e1f1696d5acfde0cb215.tar.gz` possui 24.902.933 bytes e SHA-256 `af39e5d2f8f6d919e2adc554e27e214fa170dac12a7285ca8ec9630a7d1f8a1c`; seu sidecar tem SHA-256 `0c6bade3db133ccec9a01695a1cd7003d86d0e4275a739f389e3b63a78add5f5`. O manifesto possui 681.311 bytes e SHA-256 `c6514c43d37b8e687731fa2d8788da52df8df53acec11a640aa7707f4cb1d584`. O tar contém 3.453 membros — 584 diretórios, 2.867 arquivos e dois links —; manifesto e release cobrem 2.869 folhas: web 1.577, backoffice 1.276, migrations 14, lockfile 1 e manifesto 1. Ambos os `BUILD_ID` equivalem ao commit e o head é `20260812000200`, em Linux x64 com Node 24.18/npm 11.19. O smoke canônico embutido e as verificações de segurança, secrets, PII e cleanup ficaram verdes. A prova é local, não ARM64 ou produção, e não contém o patch atual; PEND-003 e o smoke ARM64 nativo seguem pendentes.

O snapshot `c115dcd726929f289777cd897cccc97d33a179ee`, com 2.859 payloads, 13 migrations e head `20260812000100`, permanece histórico e stale, anterior aos dois P2 do primeiro review. Sua auditoria `NO-BLOCKER` continua válida apenas para aquela fotografia local e tampouco descreve o patch atual.

A branch `feat/feat-004-owner-onboarding-recipient` foi publicada até `3e3f866c42302df9b0499e9af75575c7c092f3f0`. As duas threads do primeiro review `PRR_kwDOTyzZrs8AAAABJQvhhQ` receberam respostas e foram resolvidas: projeção em `PRRT_kwDOTyzZrs6YkS9P`, resposta `PRRC_kwDOTyzZrs7gw9tM`; recovery stale em `PRRT_kwDOTyzZrs6YkS9Y`, resposta `PRRC_kwDOTyzZrs7gw-TX`.

O segundo review, `PRR_kwDOTyzZrs8AAAABJV08Cw`, foi submetido em `2026-08-12T22:59:35Z` sobre `3e3f866c42302df9b0499e9af75575c7c092f3f0` e abriu um novo P2 atual: thread `PRRT_kwDOTyzZrs6YwM7k`, comentário `PRRC_kwDOTyzZrs7gxI26`/REST `3770977722`, em `owner-service.ts` linhas 107–112. O patch local distingue `owner_contract_not_current` dos bloqueios reais. A cadeia integral atual passou em Node 24: format, lint sem warnings, typecheck, 718/718 unitários em 74 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check; reset mais `test:db` passaram uma única vez em 355/355, com cleanup verde. A focada única passou em 23/23, relatório/stdout/lista SHA-256 `66a4b5ceea14c7affa848748c525adccf684641b377f755a3a9ce3fb05aec6c6`/`ba57e0bd52d165bf422fccc6500eb4fb920c48f785a226baac24e8265c11fe0c`/`ed851b7bca361d0e3e50b5632f12251859b5098a12123a2ee2b8ebbb6f11bf59`. A integral única passou em 114/114, com relatório/stdout/lista SHA-256 `b68c70ff6f17f55142d11394dd9b6113958a7e49ef82d2c5c70324dfcafe6227`/`7b8b7971f91e8a571cec6ac8bb63fed665bbfcd1b9ead4997a6e0436b76114bc`/`322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`; privacidade e cleanup ficaram verdes.

O build atual foi único, exit `0`, sem warnings, com log SHA-256 `db0d0049b248dd7b3d438d57ffa0faa465d3cd7a15a9bdd0d6267dc11a4ac162`. O smoke real padrão mais FEAT-004 passou com exit `0`: resumo SHA-256 `a8d41974344ba6eb3b6cb83d626e4b77e9853a2d98e58814d9c795cca356ad0b`, stdout `e15829cc6525d58cab4fa2ed49c33d9e5d6225512b77ec96a21fa2ea3b9703dba` e server log SHA-256 `7ea7719b4af0257044c24c32f252f9327920a069d74b31cac25d3f23d8f089c5`; 14/11 nonces, três boundaries, dois redirects, banco `0 → 0` e Mailpit/portas/processos/temporários/secrets/PII zero. A tentativa inicial do runner temporário foi recusada antes de spawn por usar `profile_preferences` em vez de `user_preferences`, log `9757fbc1baf5afcffc4840468f7f7af5c7c1677a924997184376617b8752e2db`, sem servidor, request ou resíduo; somente o harness foi corrigido antes da única execução real verde. A release `79376b62...` continua histórica e não contém o patch. Nova release canônica, publicação, resposta/resolução, novo review, promoção para ready e merge permanecem pendentes. O [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) e a feature continuam **Em implementação**; PEND-003 e o smoke ARM64 nativo permanecem obrigatórios para produção.

## Documentação viva afetada

- payments.md
- security-privacy.md
- open-decisions.md
- qa-test-plan.md

Toda mudança desta feature também atualiza este arquivo, o catálogo QA e `docs/changes/`.

## Definition of Done da feature

- todos os critérios acima comprovados;
- migration/grants/RLS verdes quando aplicável;
- read model/command e invalidação documentados;
- Playwright listado e verde;
- desktop/mobile/teclado/axe verificados;
- logs e métricas necessários;
- rollback/correção definidos;
- nenhuma funcionalidade fora de escopo introduzida.
