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
- A leitura autenticada compartilhada por SSR e `GET /api/owner/recipient` expira no servidor em 2.000 ms com `AbortSignal` e race real; transporte não cooperativo ou resultado tardio não mantém a request nem publica estado depois do prazo.

## Dados canônicos afetados

- `owner_profiles`
- `owner_payment_recipients`
- `terms_acceptances`
- `audit.events`

## Read models

- get_owner_recipient_status

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

| ID              | Prioridade | Suíte         | Viewport       | Cenário                                                    | Spec                                                                  |
| --------------- | ---------- | ------------- | -------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| SL-F004-E2E-001 | P0         | critical      | desktop        | ativar perfil de dono com aceite                           | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-002 | P0         | critical      | desktop        | iniciar onboarding no adapter local e exibir pendência     | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-003 | P0         | critical      | desktop        | recebedor ativo libera elegibilidade de reserva            | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-004 | P1         | regression    | mobile         | recuperação fecha a superfície e devolve foco ao checklist | `tests/e2e/regression/feat-004-owner-onboarding-recipient.spec.ts`    |
| SL-F004-E2E-005 | P0         | critical      | desktop        | GET retido fecha A e recompõe SSR somente com B            | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`      |
| SL-F004-E2E-006 | P1         | accessibility | desktop/mobile | axe, teclado, foco e nomes acessíveis nas duas rotas       | `tests/e2e/accessibility/feat-004-owner-onboarding-recipient.spec.ts` |
| SL-F004-E2E-007 | P1         | reflow        | 160x360        | 503/GET fecham a superfície e restauram foco em 160x360    | `tests/e2e/reflow/feat-004-owner-onboarding-recipient.spec.ts`        |

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

A suíte unitária integral final pós-código passou em 707/707. A rodada estática de privacidade passou em 11/11; format, ESLint, typechecks, docs:check, audit com zero vulnerabilidade, Knip, coleta estática de 23 testes Playwright e diff-check também passaram.

A primeira matriz browser foi interrompida com uma falha e 22 testes não executados por locator ambíguo, corrigido depois com `exact: true`. A execução seguinte chegou ao ID 005 e terminou com 7 testes passados, uma falha e 15 não executados: o oráculo tentou `fulfill` de um POST depois do hard reload e recebeu `Route is already handled`. Ambos são resultados diagnósticos inconclusivos, não evidência final nem falha do produto.

Após as correções, uma única invocação das quatro specs FEAT-004 passou em 23/23, exit `0`, em cerca de 2,0 minutos, distribuída por 14 projetos; os IDs 001–007 passaram respectivamente em `3 + 3 + 3 + 4 + 3 + 4 + 3` execuções. Houve zero resultado inesperado, skip, flake, erro ou attachment. A auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider; os 26 e-mails QA únicos apareceram em 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP do relatório. Banco, Mailpit, portas e processos terminaram em zero. O `index.html` do relatório tem SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`.

Os IDs `SL-F004-E2E-001` a `007` estão `automatizado`. A primeira integral seguinte terminou funcionalmente em 114/114, mas sua evidência foi rejeitada porque 18 telefones QA apareceram em 61 títulos `Fill` e quatro snippets; esse run permanece somente como diagnóstico histórico. O helper passou a preencher o input dentro de `Locator.evaluate`, usando setter nativo e `InputEvent`, e os sete call sites foram redigidos.

Após o patch de privacidade, uma única invocação Node 24 com `workers=1`, `max-failures=1` e `retries=0` passou a matriz integral limpa em 114/114, exit `0`, cerca de 5,9 minutos, 17 specs e 16 projetos. Houve zero resultado inesperado, skip, flake, erro, attachment ou mídia. A FEAT-004 permaneceu em 23/23, com IDs 001–007 em `3 + 3 + 3 + 4 + 3 + 4 + 3`. O relatório tem SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`, e `.last-run.json`, SHA-256 `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`.

A auditoria encontrou zero ocorrência dos 28 telefones QA, inclusive formatos e sequências, zero step sensível `Fill`/`Type`/`PressSequentially` e zero sentinela, token, cookie Auth, URL de banco, referência privada do provider ou documento QA. Os 88 e-mails QA únicos apareceram em 140 ocorrências somente nos títulos allowlisted: FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Banco, Mailpit, portas e processos terminaram em zero.

Os builds web/backoffice passaram sem warning ou erro; manifests, rotas e standalone foram validados e `next-env.d.ts` permaneceu canônico. O smoke padrão release-equivalent aprovou roots, prefetch, erros globais, live/ready, assets, CSP, nonces, probes adversariais, isolamento e redirects streaming da área do dono; log SHA-256 `dbbaff2344e7841a12c4489e0a669a681ecd90755afc9649b1db723679b80ca1`.

O boundary guest standalone passou no probe exata origem: exatamente um `POST /api/commands` em `127.0.0.1:3000`, com `Host`/`Origin` naturais exatos, sem cookie e comando sintético válido de início de recebedor, retornou `401 UNAUTHENTICATED`; o `requestId` UUID-v4 coincidiu no header/body. As oito contagens owner/Auth/audit ficaram em zero antes/depois, e porta, temporário e PGID terminaram em zero. Log redigido SHA-256 `af8d01d798739f14d1e060b30314e72fb3c1cda7a793b90a81dd4299b259c36b`. Review e release continuam pendentes, e a feature permanece **Em implementação**.

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
