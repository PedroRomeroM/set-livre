# FEAT-004 — Ativação de dono e onboarding de recebedor

## Metadados

| Campo            | Valor                                                                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Concluída e incorporada a `main`                                                                                                                                                                                                                                                  |
| Prioridade       | P0                                                                                                                                                                                                                                                                                |
| Domínio          | `owners-payments`                                                                                                                                                                                                                                                                 |
| Specs Playwright | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`<br>`tests/e2e/regression/feat-004-owner-onboarding-recipient.spec.ts`<br>`tests/e2e/accessibility/feat-004-owner-onboarding-recipient.spec.ts`<br>`tests/e2e/reflow/feat-004-owner-onboarding-recipient.spec.ts` |

## Conclusão no repositório

A feature foi incorporada a `main` pelo [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6), no merge `b4f40035b3e7eda64d94726483d82ece9f01c7ed`, em `2026-08-16T09:24:06Z`. O HEAD final revisado foi `44854dca545ca3aa89e780d83a8a5025007f8b12`; depois da espera integral de 60 minutos, o comentário final REST `5306520356` registrou revisão limpa, e as seis threads ficaram resolvidas. A captura final não inclui `reviewDecision` nem check rollup, portanto este documento não os atribui.

A release canônica permanece prova local Linux x64 do commit funcional `2045d1a00c15889007b3c5c04c08d0467fc3d9b3`, não prova ARM64 ou de produção. Oracle/ARM64/PEND-003 e o smoke ARM64 nativo continuam pendentes. A próxima fatia da sequência executável é a FEAT-006.

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
- Capability de ativação server-derived para distinguir aceite permitido de contrato somente consultivo.
- Capability de onboarding server-derived para distinguir operação local permitida de leitura somente consultiva.
- Atualização de status e retentativa somente quando a capability permite.
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
- Contrato com `source=local_fixture` permanece legível fora de `local | test`, mas sua ativação é recusada; o adapter local também é recusado nesses ambientes. Nenhum deles representa aprovação jurídica ou comercial.
- Os únicos requisitos públicos são `identity_review | additional_information | provider_contact`; a próxima ação usa `activate_owner | start_onboarding | refresh_status | none`.
- `ownerActivationCapability` é obrigatória somente na projeção completa `activation` e no retorno de sucesso de `owner.activate`. Fonte `approved` produz `available`; `local_fixture` produz `available` apenas em `local | test`, enquanto `development | production`, `APP_ENV` ausente ou inválido produzem `unavailable`. Ela não é persistida nem altera `source` ou `nextAction`.
- Em `ownerActivationCapability=unavailable`, a leitura mantém o documento e os fatos para consulta; `owner.activate` retorna `503 SERVICE_UNAVAILABLE` antes de `activateOwnerProfile` e da escrita, sem criar aceite, autoridade ou auditoria.
- `recipientOnboardingCapability` é obrigatória no estado comum das duas projeções e nos três retornos POST. Ela não altera `providerMode`, `nextAction` nem o fato no banco: `local | test` produz `local_adapter`; `development | production`, `APP_ENV` ausente ou inválido produzem `unavailable` de forma fail-closed.
- Em `unavailable`, o estado continua disponível somente para consulta; `recipient.onboarding.start | refresh` retornam `503 PAYMENT_PROVIDER_UNAVAILABLE` antes de `prepare`, sem operação reservada, chamada ao adapter ou mutação parcial.
- O adapter local nominal faz `start -> pending` e `refresh -> active`. Os demais estados e falhas são fixtures locais de teste e nunca dependem de e-mail ou UUID mágico.
- O `requestId` da API e a `idempotencyKey` do browser são contratos distintos: o primeiro correlaciona resposta, log e auditoria; a segunda deduplica o fato. Fatos novos guardam ambos em colunas separadas, e retry com a mesma chave não cria evento novo nem troca a correlação original.
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

As tuples SQL permanecem com 21 e 16 colunas. O normalizer server-side acrescenta `recipientOnboardingCapability` aos dois estados HTTP e `ownerActivationCapability` somente ao estado completo `activation`, sem criar coluna ou segunda fonte canônica.

## Comandos e integrações

- owner.activate
- recipient.onboarding.start
- recipient.onboarding.refresh
- `recipient.bank.update` permanece diferido até existir token ou handoff provider-owned aprovado

## UX e estados obrigatórios

- Checklist com status factual.
- Os erros do provider são traduzidos para mensagens seguras.
- Sem mostrar payload/KYC desnecessário.
- O formulário de aceite depende de `ownerActivationCapability=available`.
- CTA depende simultaneamente do requisito pendente e de `recipientOnboardingCapability=local_adapter`.

Quando `ownerActivationCapability=unavailable`, `/dono` preserva o título, o corpo e o aviso de `local_fixture`, não monta formulário, checkbox ou CTA e mostra um alerta com `role=status`: `Ativação como dono indisponível` e `A versão aprovada do contrato do dono ainda não está disponível neste ambiente. O contrato atual permanece somente para consulta.` O controle não aparece desabilitado e a leitura não sugere aprovação jurídica.

Quando a capability é `unavailable`, a interface preserva o status factual, omite o aviso do adapter local e qualquer CTA de start/refresh e mostra um alerta com `role=status`: `Cadastro de recebimentos indisponível` e `A integração de recebimentos ainda não está disponível neste ambiente. O estado atual permanece somente para consulta.` Não existe controle desabilitado, provider falso ou integração externa antecipada.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

Quando `Verificar estado atual` inicia o `GET /api/owner/recipient`, a superfície privada anterior fecha e dá lugar ao boundary neutro de validação. Ao concluir com sucesso, o foco programático retorna ao heading `Etapas para receber reservas`; se a leitura falhar, o foco vai ao alerta seguro da área indisponível. Nesse segundo estado, `Tentar novamente` reutiliza o mesmo intent de foco: fecha a superfície durante o novo GET e retorna ao heading somente depois de uma resposta autoritativa bem-sucedida. Nenhuma das duas ações reenvia o comando ambíguo.

`CONFLICT` e `VALIDATION_FAILED` sem `fieldErrors` indicam que o snapshot pode ter ficado stale: a ação é desabilitada até um GET autoritativo e o POST não é repetido. Validação realmente vinculada a campo, como o aceite local do contrato, continua editável e apresenta `fieldErrors` no próprio formulário.

Quando a preparação de `recipient.onboarding.start | refresh` encontra uma nova versão vigente do contrato, o banco sinaliza exatamente SQLSTATE `42501` com `owner_contract_not_current`. O serviço traduz somente essa combinação para `409 CONFLICT`, ativando a recuperação por leitura já existente. Outros `42501`, inclusive dono ou recebedor bloqueado, continuam `403 FORBIDDEN`; a mensagem privada do banco não atravessa a API.

## Segurança e privacidade

- O provider é chamado somente no servidor.
- As capabilities são derivadas server-side e nunca aceitas do browser; ativação combina `ownerContract.source` com `APP_ENV`, enquanto onboarding depende apenas da allowlist do ambiente.
- Dados sensíveis minimizados.
- Limite de taxa.
- O adapter e a consulta server-side mapeiam somente estados allowlisted; webhook pertence à integração externa futura.

## Critérios de aceitação

- Usuário vira dono após aceite quando `ownerActivationCapability=available`.
- Um contrato `local_fixture` fora de `local | test` permanece consultável, mas não oferece controle nem produz escrita.
- Os estados pendente, ativo e recusado do recebedor são apresentados corretamente.
- Um recebedor inativo impede o checkout.
- Outro usuário não lê status.
- SSR e refetch encerram uma leitura retida em 2.000 ms e oferecem recuperação sem aceitar resultado tardio.
- A retentativa é idempotente.
- Fora de `local | test`, o estado permanece consultivo e nenhum start/refresh alcança `prepare`.

## Playwright obrigatório

| ID              | Prioridade | Suíte         | Viewport       | Cenário                                                 | Spec                                                                  |
| --------------- | ---------- | ------------- | -------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| SL-F004-E2E-001 | P0         | critical      | desktop        | ativar perfil de dono com aceite                        | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-002 | P0         | critical      | desktop        | iniciar onboarding no adapter local e exibir pendência  | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-003 | P0         | critical      | desktop        | recebedor ativo libera elegibilidade de reserva         | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-004 | P1         | regression    | mobile         | concorrência/capabilities impedem POST indevido         | `tests/e2e/regression/feat-004-owner-onboarding-recipient.spec.ts`    |
| SL-F004-E2E-005 | P0         | critical      | desktop        | GET retido fecha A e recompõe SSR somente com B         | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-006 | P1         | accessibility | desktop/mobile | axe, teclado, foco e nomes acessíveis nas duas rotas    | `tests/e2e/accessibility/feat-004-owner-onboarding-recipient.spec.ts` |
| SL-F004-E2E-007 | P1         | reflow        | 160x360        | 503/GET fecham a superfície e restauram foco em 160x360 | `tests/e2e/reflow/feat-004-owner-onboarding-recipient.spec.ts`        |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- os IDs 004/007 comprovam com `toBeFocused()` o foco restaurado no heading do checklist após o `GET` bem-sucedido; o ID 007 também simula GET 503, aciona `Tentar novamente`, observa um GET real 200 e exige o heading focado;
- sem criar ID novo, o ID 004 alterna somente a capability sobre estados factuais `start_onboarding` e `refresh_status`: `unavailable` mantém o alerta/copy exatos, remove aviso e CTAs e não emite POST; `local_adapter` restaura a ação correspondente. Esse cenário passou na rodada focada 23/23 e na integral 114/114 do novo delta;
- no quinto P2, o mesmo ID 004 recebeu uma extensão que aguarda checkbox e CTA ociosos antes da simulação; os publishers de ativação e recebedor marcam a resposta esperada e exigem exatamente um hit. A execução race-fixed passou em 23/23, com privacidade e cleanup verdes. O contrato continua sendo alternar `ownerActivationCapability` sem mudar contrato ou fatos: `unavailable` mantém título/corpo/aviso da fixture, mostra a copy de ativação exata, omite checkbox/formulário/CTA e conserva zero POST; `available` restaura aviso, checkbox e CTA, ainda sem POST até a ação explícita. Não há novo ID, spec, projeto ou total;
- no ID 005, o browser retém o GET de B na página e no `QueryClient` ainda montados sob A, exige o boundary antes do hard reload, comprova no `pagehide` que a superfície de A foi desconectada, recompõe SSR somente com B e observa zero `pageerror`/erro React. O callback tardio complementar não é alegado como browser: testes unitários usam `MutationObserver` real com latch e provam que a key de A não é recriada depois do seed autoritativo de B;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace, screenshot e vídeo ficam `off` nas quatro specs para não persistir PII sintética nem referências privadas; a evidência usa asserções semânticas e varredura negativa;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: matriz `source + APP_ENV -> ownerActivationCapability`, com `approved` sempre disponível
- unitário: capabilities obrigatórias nas projeções corretas, leitura consultiva da fixture e recusas antes das respectivas escritas
- unitário: decisão visual independente para start/refresh
- unitário: decisão visual de ativação mantém documento e remove integralmente formulário/checkbox/CTA
- integração: contrato do adapter local determinístico
- DB/RLS owner recipient
- auditoria da ativação/renovação e das transições do recebedor, com correlação e idempotência separadas

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

O commit funcional local `440c81f6cc44cc95ed281d84e9a5124ae98a59c4` foi empacotado uma única vez, com exit `0` e log SHA-256 `be9e2e2d0d1d2a4db78593c03858c183f93b3ed336bd820d3ce9d64c08ec1ba4`. Essa release de 14 migrations/head `20260812000200` permanece uma fotografia histórica do segundo P2 e não contém a correção de auditoria nem o head atual. A prova continua válida somente para aquele recorte local x64, não ARM64 ou produção; PEND-003 e o smoke ARM64 nativo seguem pendentes.

O snapshot `c115dcd726929f289777cd897cccc97d33a179ee`, com 2.859 payloads, 13 migrations e head `20260812000100`, permanece histórico e stale, anterior aos dois P2 do primeiro review. Sua auditoria `NO-BLOCKER` continua válida apenas para aquela fotografia local e tampouco descreve o patch atual.

Na fotografia publicada do segundo P2, a branch `feat/feat-004-owner-onboarding-recipient` avançou no remoto de `3e3f866c42302df9b0499e9af75575c7c092f3f0` até `011a48f4910baa0e17b26dee6eda3c678d910572`: `440c81f6cc44cc95ed281d84e9a5124ae98a59c4` era o commit funcional, e `011a48f4...`, o commit da documentação da release. Naquele snapshot confirmado, HEAD local e remoto coincidiam em `011a48f4...`. As duas threads do primeiro review `PRR_kwDOTyzZrs8AAAABJQvhhQ` receberam respostas e foram resolvidas: projeção em `PRRT_kwDOTyzZrs6YkS9P`, resposta `PRRC_kwDOTyzZrs7gw9tM`; recovery stale em `PRRT_kwDOTyzZrs6YkS9Y`, resposta `PRRC_kwDOTyzZrs7gw-TX`.

O segundo review, `PRR_kwDOTyzZrs8AAAABJV08Cw`, foi submetido em `2026-08-12T22:59:35Z` sobre `3e3f866c42302df9b0499e9af75575c7c092f3f0` e abriu o P2 `PRRT_kwDOTyzZrs6YwM7k`, comentário original `PRRC_kwDOTyzZrs7gxI26`/REST `3770977722`, em `owner-service.ts` linhas 107–112. O patch publicado distingue `owner_contract_not_current` dos bloqueios reais. A cadeia integral daquela correção passou em Node 24: format, lint sem warnings, typecheck, 718/718 unitários em 74 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check; reset mais `test:db` passaram uma única vez em 355/355, com cleanup verde. A focada única passou em 23/23, relatório/stdout/lista SHA-256 `66a4b5ceea14c7affa848748c525adccf684641b377f755a3a9ce3fb05aec6c6`/`ba57e0bd52d165bf422fccc6500eb4fb920c48f785a226baac24e8265c11fe0c`/`ed851b7bca361d0e3e50b5632f12251859b5098a12123a2ee2b8ebbb6f11bf59`. A integral única passou em 114/114, com relatório/stdout/lista SHA-256 `b68c70ff6f17f55142d11394dd9b6113958a7e49ef82d2c5c70324dfcafe6227`/`7b8b7971f91e8a571cec6ac8bb63fed665bbfcd1b9ead4997a6e0436b76114bc`/`322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`; privacidade e cleanup ficaram verdes. Em `2026-08-15T15:36:08Z`, a thread recebeu a resposta [`PRRC_kwDOTyzZrs7h4a21`](https://github.com/PedroRomeroM/set-livre/pull/6#discussion_r3789663669), REST `3789663669`; a resposta foi verificada na própria thread, e `PedroRomeroM` então a resolveu com `isOutdated=false`.

O build, smoke e a release `440c81f6...` daquela correção permanecem históricos. A nova leitura de review abriu `PRRT_kwDOTyzZrs6ZhR_d`, comentário `PRRC_kwDOTyzZrs7h4jT7`/REST `3789698299`: `audit.events.request_id` recebia a `idempotencyKey` do browser tanto na ativação/renovação quanto na transição do recebedor. A migration append-only `20260815000100_owner_audit_request_correlation.sql` adiciona `idempotency_key NOT NULL`, move a unicidade para `(action, target_id, idempotency_key)` e faz as novas assinaturas de ativação/aplicação receberem a correlação separadamente. O backfill preserva o valor legado e copia-o para a nova coluna; o request ID HTTP anterior é irrecuperável e não é inventado.

No fechamento precommit do terceiro P2, `npm ci` terminou com 447 pacotes e auditoria em zero; format, lint, typecheck, 42/42 unitários focados, 12/12 guardas de privacidade, 718/718 unitários integrais em 74 arquivos, docs:check 34/200/18, `npm audit` zero, Knip e diff-check passaram. Um único reset, geração e `test:db` passou em 358/358 (`158 + 78 + 57 + 65`) no head `20260815000100`. Readiness aceitou o head e recusou o anterior; trigger, overloads/grants, gerados/diff e tabelas finais ficaram corretos. Essa fotografia é histórica para o delta de capability.

A rodada focada P3 anterior permanece verde em 23/23. A primeira integral do snapshot ainda sem a correção do oráculo terminou em 79 passados, uma falha e 34 não executados no `FOUNDATION-E2E-008` WebKit por navegação HMR na mesma página; essa fotografia não foi repetida. Seu relatório diagnóstico tem SHA-256 `ac669d0a2f8056e1b68c44317e9e679cc367daeb5c9a71435ba2f1e6d40ca7ff`. O teste foi separado em páginas distintas e seu arquivo corrigido tem SHA-256 `7ae803488af54ea58bd06be7820c69c69460ed9038b1b9a5f17e5507d24999a7`; o crítico corrigido passou em 3/3.

A integral corrigida passou exatamente em 114/114, 17 specs e 16 projetos, preservando 23/23 da FEAT-004, com privacidade e cleanup verdes. SHA-256: relatório `5abbdc7696273dcf24df6353dea014f9e6dc0738824783171e978cf19d8c2e44`, stdout `a630adc06adb9d461bb9b2fa7d2cc43d8dcf8470312b19b517178ca4f409d678`, lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6` e `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`.

O build do terceiro P2 foi executado exatamente uma vez e passou com exit `0`, 26 rotas web, quatro do backoffice e zero warning; log SHA-256 `8677b868a632e0891499c8450e5c926ddefcde7e27c5d31f9adcb55e27bbfaa2`. O smoke customizado daquele snapshot também passou uma vez, com exit `0` em 2,4 segundos: três probes guest `401` com UUID, dois redirects exatos, 14/11 nonces, banco/Mailpit `0 → 0`, privacidade e cleanup verdes. SHA-256: stdout `399d3b41dd9d161bdd86288c53e5bf821279285eb4772740c9ff5169845e5abd`, server log `e3c376cdc9403d2739ea8f127244fef193ea0ad4689694fec5c8a097d5ee025b` e resumo `25262fb6efbf93a0a654a16171bc4f6998000ef0078b9d91e40a06beefe79450`.

A release canônica local do terceiro P2 foi gerada e auditada para o commit funcional `2a86acc4dc3a005213d5f22384084e3aba0160be`. O archive de 24.903.588 bytes possui SHA-256 `0e0c07f41d4a44f0673ce7a5013084942100e8baab1ba72ee6aeea6496be1566`; sidecar, manifesto e log possuem, respectivamente, 124, 681.529 e 2.099 bytes, com SHA-256 `1136df426039335971d515497ce8974dcb25ee583f3764d5c33f9ea1f76ca0ab`, `d3bfb5a5c517edab1004bde6eaf04c7f080c3036c94defbbfa1b82fad44d4d44` e `e7edaa919daa3b3ed4cd6cf1588c044d2a6efcf1ae84e9877edd5fa42062371e`. São 2.870 artefatos — web 1.577, backoffice 1.276, migrations 15, lockfile 1 e manifesto 1 —; o tar soma 3.454 membros — 584 diretórios, 2.868 arquivos e dois links seguros. Os `BUILD_ID` equivalem ao commit; o head é `20260815000100` (prefixo SHA-256 `ca995243...`) e o lockfile possui prefixo `485ec8e7...`. Smoke, secrets/PII e cleanup final ficaram verdes em Linux x64, Node 24.18/npm 11.19; duas auditorias independentes terminaram `NO-BLOCKER`. Essa release não contém nem valida a capability posterior.

Na captura remota verificada em `2026-08-15T19:38:32Z`, o push `3dd11cb → dda95b3` publicou o commit funcional `2a86acc4...` e a documentação da release até `dda95b3b9108930489a3b10275ef41c2f203ae24`; a release canônica permanece vinculada ao funcional. O [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) estava `OPEN`/draft, base `main@174ee16342367caedf55521227d21d5bf076b1a9`, head daquela fotografia `dda95b3b9108930489a3b10275ef41c2f203ae24`, `MERGEABLE`/`CLEAN`, `reviewDecision` vazio e `statusCheckRollup=[]`. `PedroRomeroM` criou a resposta encadeada na thread `PRRC_kwDOTyzZrs7h6HnW`/REST `3790109142` no mesmo instante; `PRRT_kwDOTyzZrs6ZhR_d` ficou `isResolved=true`, `isOutdated=false`, resolvida por ele. A leitura encontrou zero threads não resolvidas, e as três anteriores permaneceram resolvidas.

O review `PRR_kwDOTyzZrs8AAAABJrjWnQ`/REST `4944615069`, submetido em `2026-08-15T20:02:30Z` sobre `11464a37593d510f5774af6af6fe655e671a9c35`, abriu o novo P2 [`PRRT_kwDOTyzZrs6ZigTV`](https://github.com/PedroRomeroM/set-livre/pull/6#discussion_r3790152658), comentário `PRRC_kwDOTyzZrs7h6SPS`/REST `3790152658`, em `owner-recipient-panel.tsx` linhas 707–708. Na captura, a thread permanecia atual, não outdated e não resolvida: a UI derivava a ação apenas do estado persistido e podia oferecer o adapter local em um runtime sem provider externo.

O patch congelado acrescenta a capability server-derived, a recusa 503 antes de `prepare` e o estado visual consultivo. No fechamento local em Node 24, a suíte estática passou com 734/734 unitários em 74 arquivos, o banco com 358/358 e as rodadas browser focada/integral com 23/23 e 114/114, preservando os sete IDs da feature. As auditorias browser finais ficaram verdes; a primeira auditoria integral parou por uma variável inexistente no próprio harness e, depois da correção, reaproveitou o mesmo relatório sem nova invocação Playwright. Um único build passou com exit `0`, 26 + 4 rotas, `BUILD_ID=local` e log SHA-256 `ca7d5c3e...`. O smoke customizado não produziu evidência verde após três rejeições exclusivas do harness. O gerador canônico executou exatamente uma vez para `969f30cd...`, passou seu smoke embutido e gerou uma release local com 2.871 artefatos; secrets, paridade, cleanup e duas auditorias `NO-BLOCKER` ficaram verdes. A prova permanece Linux x64, não ARM64 ou produção.

Na captura pós-publicação, o push `11464a3... → e51ab6f...` publicou o funcional `969f30cd...` e a documentação/evidência da release canônica local. O archive permaneceu local e ignorado pelo Git; não houve publicação em GitHub Release. A release permanece ligada a `969f30cd...`. O PR #6 estava `OPEN`/draft, base `main@174ee163...`, head `e51ab6fc...`, e o connector registrou apenas `mergeable=true`; o body foi atualizado. A resposta `PRRC_kwDOTyzZrs7h8CsL`/REST `3790613259`, criada por `PedroRomeroM` em `2026-08-16T00:43:03Z`, foi verificada na thread. `PRRT_kwDOTyzZrs6ZigTV` ficou `isResolved=true`, `isOutdated=true`, resolvida por ele; a leitura thread-aware encontrou cinco threads e zero não resolvidas. Naquela fotografia, o review seguinte, a espera mínima, a captura final, ready e merge ainda não tinham ocorrido, sem claim de `reviewDecision` ou checks. O quinto review posterior e seu estado então pendente aparecem abaixo. Naquele recorte, o PR e a feature continuavam em implementação; PEND-003/smoke ARM64 nativo continuam obrigatórios para produção.

O review seguinte `PRR_kwDOTyzZrs8AAAABJsAUGQ`/REST `4945089561`, submetido em `2026-08-16T01:07:18Z` sobre `0decf00`, abriu [`PRRT_kwDOTyzZrs6Zj15h`](https://github.com/PedroRomeroM/set-livre/pull/6#discussion_r3790648981), comentário `PRRC_kwDOTyzZrs7h8LaV`/REST `3790648981`, em `owner-recipient-panel.tsx` linha 489. Na captura, a thread estava atual, não resolvida e não desatualizada. O patch local introduz a capability exclusiva de ativação, a leitura consultiva e o estado visual sem formulário. Seu snapshot inicial passou na cadeia estática com 747/747 unitários e no banco com 358/358.

A primeira rodada browser focada coletou 23 testes em quatro specs/14 projetos — lista SHA-256 `615bf589...` — e terminou uma única vez com exit `1`: 12 passados, falha em `SL-F004-E2E-001`/`critical-webkit`, dez não executados e zero rerun. O provisionamento compartilhado encontrou um submit HTML nativo pré-hidratação no cadastro da FEAT-002: o fallback GET colocou campos sintéticos na query. A falha é real de privacidade, não evidência da capability P5; o ID 004 não foi alcançado e a suíte integral não iniciou. Permaneceram somente stdout redigido `f4d0595a...` e auditoria `13859c3c...`; os artefatos brutos foram removidos sem reproduzir valores/endereço, e o cleanup fechou em zero.

O hardening compartilhado deixa o único `RegistrationForm` SSR inerte, com método POST, `aria-busy`, `fieldset`, sete controles nomeados e submit disabled até o snapshot hidratado; o status de preparo fica fora do formulário. Seus unitários passaram em 2/2 e a guarda combinada de identidade em 22/22; `SL-F002-E2E-001` foi ampliado sem novo ID com contexto sem JavaScript.

Depois da correção da race, a focada executou os mesmos 23 testes em quatro specs/14 projetos e passou em 23/23; seu reuse foi validado pela auditoria final. A rodada attribute-fixed coletou 114 testes em 17 specs/16 projetos e sua única execução passou em 114/114 em 5,6 minutos, com zero retry, erro ou attachment. A FEAT-004 permaneceu em 23/23, com os IDs 001–007 distribuídos em `3 + 3 + 3 + 4 + 3 + 4 + 3`; o contexto sem JavaScript da FEAT-002 passou nos três engines sem criar contagem nova.

A auditoria contou 140 ocorrências dos 88 e-mails QA apenas em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22 —, com zero secret, PII ou outro dado sensível e cleanup zero. Evidência segura: `.artifacts/p5-owner-activation-capability-attribute-fixed/full.audit.json`, SHA-256 `5704c67cf21bdcc6e92b733bfdb8788972c216d48f850c885200b6d4d78a37d6`. As execuções rejeitadas anteriores permanecem histórico diagnóstico; o defeito inicial já foi corrigido e as rejeições seguintes pertencem ao harness/oráculo, sem falha atual do produto.

No snapshot pós-hardening, Node 24/npm 11 passou por `npm ci` 447/451/zero vulnerabilidades, format, lint, typecheck, 749/749 unitários em 75 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check. Uma asserção auxiliar incorreta do hash de `next-env` interrompeu o orquestrador depois do typecheck; a continuação autorizada executou somente os gates restantes, sem falha em gate do projeto. O banco passou em 358/358 (`158 + 78 + 57 + 65`), com gerados byte-identical e 15 migrations/head `20260815000100`. A pausa cruzou reset/geração; o primeiro `test:db`, interrompido após `0001`, é inválido, teve cleanup limpo e foi substituído por uma única invocação autorizada sem novo reset/geração. Static 749/749, DB 358/358, focada 23/23 e integral 114/114 estão verdes.

Depois desse fechamento, exatamente uma build P5 sob Node 24/npm 11 terminou com exit `0`, 26 rotas web, quatro do backoffice, zero warning e `BUILD_ID=local`; o log privado tem SHA-256 `3b03b8f64e70dcf29e713f8b6ab006f4a544e43fd761ce0eb8b283eac9de432c`. O artefato, porém, foi recusado porque o standalone copiou strings de conexão administrativas/DAL locais do antigo `scripts.knip`; nenhum smoke iniciou. A correção reduz o script a `knip`, conserva os valores no `.env.e2e.local` físico e adiciona uma guarda unitária sobre os quatro manifests canônicos — raiz, backoffice, contracts e UI — contra URLs de banco em scripts npm. Prettier/ESLint direcionados, 4/4 unitários, Knip com as sete variáveis E2E explicitamente unset e diff-check passaram, com lockfile idêntico. A execução pós-manifesto que testou esse fix está registrada abaixo. Toda evidência do quarto P2 permanece histórica; naquele recorte, a feature continuava em implementação. PEND-003/smoke ARM64 nativo continuam obrigatórios.

A build pós-manifesto seguinte terminou uma única vez com exit `0` e log privado SHA-256 `d8e50e0fb0b7080bf021aa910bef7ededc6677ba6dfaa71d4789a1d6226e1a8e`, mas foi recusada por uma ocorrência DAL em cada cache Turbopack; standalone/static/log ficaram limpos e o smoke permaneceu em zero. O wrapper único `scripts/next-build.mjs`, usado sozinho pelos builds web/backoffice e reutilizado pelo gerador de release com ambiente allowlisted, valida app/toolchain física antes do spawn e sempre tenta remover apenas o cache autorizado, inclusive se validação ou build falharem. Cleanup falho aborta, falha dupla vira `AggregateError`, raízes/ancestrais simbólicos ou externos são recusados sem spawn/travessia e standalone/static são preservados. O preview limpa no supervisor pai antes de validar/startar e falha fechado se o cache persistir. O run direcionado final passou em 40/40 — 12 de cache/wrapper, quatro do npm confiável, 16 de Next/local server e oito do supervisor de preview —, ESLint zero, checks Node, Knip env-unset e diff-check.

A cadeia estática final única ficou verde em 764/764 unitários por 76 arquivos, com npm ci 447/451/zero vulnerabilidades, cinco typechecks, docs 34/200/18, audit zero, Knip/diff-check e freeze 53/34/19. A build final via wrapper, depois da remoção física dos dois `.next`, rodou exatamente uma vez: exit `0`, 14,733 s, log de 2.155 bytes/SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. O audit independente SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d` terminou `NO-BLOCKER`: 26 + 4 rotas, zero warning, quatro `BUILD_ID=local`, zero cache/retired e cleanup verde. Esse era o fechamento pré-release.

O gerador canônico processou exatamente uma vez o commit funcional `2045d1a00c15889007b3c5c04c08d0467fc3d9b3`, exit `0` em 21,26 s; o primeiro smoke P5 embutido ficou verde antes da publicação local. Archive `0600` SHA-256 `282f9d173eebf99ba63466d81f4aa4b9061e7d73668c267fb0a25e9e86043b92`, 2.871 artefatos e tar 3.455 membros; duas auditorias `NO-BLOCKER`, sem mismatch, segredo, PII ou resíduo. A release permanece local, ignorada e não publicada; ARM64/Oracle/PEND-003 continuam pendentes. Na fotografia pré-merge, a FEAT-004 ainda estava em implementação; o fechamento atual está na seção de conclusão deste documento.

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

## Limite temporal

Esta feature está concluída e seus 7 IDs, DB e browser pertencem às fotografias FEAT-004/P2
históricas. A FEAT-006 é a fatia posterior em implementação; não reutilizar seus números de DB,
static ou browser como evidência desta feature. Linux x64 e PEND-003 permanecem explicitamente
limitados ao escopo local/histórico.
