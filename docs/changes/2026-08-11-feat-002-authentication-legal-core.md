# Mudança: FEAT-002 — autenticação e legal-core

- Data: 2026-08-11
- Autor/agente: Codex
- Issue/PR: [PR #2](https://github.com/PedroRomeroM/set-livre/pull/2), incorporado a `main` no merge `d272657`
- Features: FEAT-002
- ADRs: ADR-001, ADR-002, ADR-003, ADR-004, ADR-005, ADR-013, ADR-015, ADR-016, ADR-017 e ADR-018
- Risco: alto — identidade, sessão, aceite legal e fronteiras de autorização
- Rollback: correção append-only para banco aplicado; revert do código antes de qualquer feature dependente

## Resumo

Implementa a primeira fatia vertical de produto: cadastro por e-mail e senha, confirmação, login, logout, recuperação, sessão SSR e o bootstrap `legal-core` com versões jurídicas locais e aceites autoritativos.

## Motivo

A fundação local já está integrada e o ADR-017 define a FEAT-002 como primeira consumidora real. Identidade é pré-requisito de perfil, oferta, reserva e direitos LGPD posteriores.

## Dependências classificadas

- `dependency-to-start`: nenhuma feature; a fundação local já está incorporada;
- bootstrap deste PR: Supabase Auth local, `legal-core` e templates Auth locais, sem antecipar direitos LGPD completos;
- `dependency-to-complete`: a FEAT-034 consumirá a identidade e o histórico jurídico para exportação, exclusão, anonimização e retenção;
- `dependency-to-release`: PEND-002, PEND-003, PEND-005 e PEND-006 impedem go-live, mas não a prova local.

## Comportamento anterior

Os dois apps possuem somente a superfície técnica da fundação. Não existem rotas de autenticação, sessão de usuário, dependências Supabase de runtime, tabelas de identidade/legal, comando de produto nem cenários FEAT-002 automatizados.

## Comportamento novo

- `/cadastro`, `/entrar`, `/recuperar-senha` e `/auth/callback` executam os fluxos reais do Supabase Auth local;
- o estado autenticado de `/entrar` comprova a sessão SSR e oferece logout sem antecipar `/conta`;
- o cadastro cria um perfil mínimo PF/PJ e dois aceites legais por meio de uma intenção opaca, consumida atomicamente no `INSERT` de `auth.users`;
- termos e privacidade vigentes possuem leitura pública mínima e fixtures explicitamente locais;
- o corpo jurídico preserva headings, parágrafos, listas, ênfase e links por um subset Markdown local, sem HTML bruto ou dependência adicional;
- recovery permanece genérico e o formulário de nova senha só aparece após token válido e revalidação concluída, sem reaproveitar autorização em cache durante refetch;
- `returnTo` aceita somente destinos internos existentes e explicitamente allowlisted.
- o primeiro review substitui a rejeição global por um limiter limitado e particionado por ação e preserva a estrutura dos documentos jurídicos por um subset Markdown seguro;
- o segundo review encerra recovery ambíguo depois do envio do OTP sem oferecer retry e isola o cache de sessão por identidade, substituindo inclusive uma Query fresca da mesma identidade pelo snapshot SSR atual antes de liberar PII.
- o terceiro review torna também o signup ambíguo terminal, fecha cookies parcialmente publicados em login/recovery, habilita RLS na intenção privada e impede release de grant já expirado;
- o quarto review elimina a evicção de buckets vivos do limiter, escopa e bloqueia o cache de recovery até uma resposta autoritativa idle e vincula toda sessão Auth de recovery a uma binding/tombstone durável, impedindo que abandono, expiração ou remoção de cookies a transformem em login comum.
- fora do PR #2 já incorporado, a branch da FEAT-003 absorve uma revisão pós-merge com dois P2 adicionais: desfecho de transporte ambíguo do login redige credenciais/cache e força revalidação SSR, enquanto feedback público da troca de senha pertence ao boundary externo e sobrevive somente ao refetch do mesmo scope autorizado.

## Arquivos/componentes

Implementados: contratos compartilhados, primitives usadas pela feature, domínio `identity`, clientes Supabase server-side, Proxy de sessão, rotas App Router, templates Auth locais, migration/seed, testes e documentação viva.

## Banco, migration, grants e RLS

A migration append-only `20260811000200` cria o perfil mínimo, versões legais, aceites, intenções privadas e grants de recovery duráveis. A correção `20260811000300` habilita RLS sem policy na intenção privada e impede release depois da expiração. A nova `20260811000400` invalida grants anteriores sem `session_id`, cria `private.identity_recovery_sessions`, vincula grant, usuário, sessão Auth e scope opaco, exige `jwt_exp=3600` e conserva uma tombstone depois do grant/cookies. Ausência em `auth.sessions` fecha a binding, remove o grant e inicia retenção conservadora; purge requer nova prova de ausência depois da janela. Os três estados privados usam RLS sem policy. A DAL recebe somente `USAGE private` e `EXECUTE` nas nove rotinas autorizadas — dois checks de readiness, criação da intenção e seis operações do contexto recovery —, totalizando dez dependências ACL exatas. O trigger remove a metadata transitória sem apagar chaves alheias. O seed contém somente textos locais não aprovados para produção.

## Segurança e privacidade

O comando de cadastro aplica origem e host da request, limite de corpo, rate limit, Zod estrito e redaction. Senha, token, cookie, e-mail, IP e user-agent brutos não entram em logs ou tabelas de evidência. No browser, e-mails, senhas e `TokenHash` passam por refs one-shot e deixam `variables` do MutationCache vazias. O limiter conserva até 10.000 buckets exatos sem evicção viva; depois da saturação, chaves novas compartilham overflow sticky por ação, limitado a 64 partições e fail-closed além desse teto. Depois que um callback é enviado, rede, timeout, resposta inválida e resultado desconhecido são terminais. Recovery recebe uma binding autoritativa pelo `session_id` assinado; o UUID exposto em cookie/SSR serve somente para escopar UI/cache. Perda do marker, expiração do grant ou saída da superfície de recovery fecham a binding e a sessão Auth exata. Cookies de produção são seguros; apenas HTTP loopback local usa a exceção limitada. O renderer jurídico não usa `dangerouslySetInnerHTML`; links são fail-closed para path interno absoluto ou HTTPS sem credenciais.

## Read models, comandos e invalidação

- comando visitante `identity.register`, originalmente compartilhado em `POST /api/commands` e agora isolado em `POST /api/auth/register`; a rota privada autentica antes de consumir o body;
- métodos Auth server-side para login, logout, callback e recovery;
- read models explícitos para documentos legais vigentes e contexto da própria identidade;
- sessão usa key por `userId`/anônimo; Query preexistente, refetch ativo/pausado, observer antigo ou troca de usuário bloqueiam PII até remover a família, semear o SSR atual ou recarregar a rota;
- logout limpa integralmente o cache privado do TanStack Query e força nova renderização server-side;
- status de recovery usa key `recoveryStatus(scope)`; resposta com outro scope é rejeitada antes do cache e `fetching`/`paused` exibem somente verificação, sem montar o formulário;
- no hardening pós-merge mantido na branch da FEAT-003, erros retryable da troca de senha mantêm apenas mensagem, scope UUID público e erros allowlisted acima do formulário desmontável; troca de scope, negação, nova tentativa ou sucesso descartam o snapshot;
- no mesmo hardening posterior ao PR #2, login cuja resposta de transporte não pode ser validada oculta e reseta os controles, limpa integralmente o `QueryClient`, semeia somente a sessão anônima e recarrega a rota SSR antes de voltar a expor credenciais ou sessão;
- a troca de senha marca o grant como consumido no cache, remove a família de sessão e encerra binding, grant e sessão Auth antes do próximo login.

## UX, mobile e acessibilidade

Formulários em PT-BR usam labels persistentes, `PasswordInput`, erros associados, live regions, alvos de 44 px e composição própria até 320 px e reflow de 160 CSS px. O tipo PF/PJ é lido diretamente do `FormData`, sem uma segunda fonte em estado React que possa divergir durante a hidratação. O callback apresenta loading e retry apenas quando a repetição é comprovadamente segura; recovery ambíguo orienta novo link. A sessão privada fica oculta durante qualquer revalidação ou troca de snapshot. Ausência de versão legal e token inválido falham fechado. Nas páginas jurídicas, o título canônico é o único `h1`; headings do corpo começam em `h2`, listas mantêm a semântica ordenada ou não ordenada e ênfases/links usam elementos nativos.

## Testes e IDs QA

Os IDs `SL-F002-E2E-001` a `007` possuem specs físicas. O quarto review acrescenta unidades adversariais para churn/overflow, cache de recovery online/offline e binding/tombstone; `SL-F002-E2E-003` foi ampliado, sem novo ID, para provar cache pausado sem formulário, sucesso nominal, expiração real e encerramento de binding, grant, sessão Auth e cookies. A evidência incorporada do quarto review passou em 458/458 unitários, 236/236 asserts pgTAP e 59/59 execuções Playwright, com sentinela e `token_hash` ausentes dos artefatos e cleanup Auth/Mailpit em zero. A prova focada posterior ao merge estende `SL-F002-E2E-002/003` para login ambíguo, feedback retryable e navegação de scope idempotente; a consolidação integral pertence ao ciclo da FEAT-003.

## Observabilidade e operação

O primeiro comando real introduz evento JSON seguro com `requestId`, ação, duração e resultado, sem PII. O funil técnico local cobre cadastro, login, callback, logout e recovery. Supabase Cloud, Nginx/TLS com borda confiável, SMTP real e textos jurídicos aprovados continuam bloqueados, respectivamente, por PEND-002, PEND-003, PEND-005 e PEND-006.

## Documentação atualizada

Este registro acompanha a mudança junto de feature, API, banco, segurança, UX, design system, notificações, cache, observabilidade, QA, dependências, contexto, pendências, índices e resumo HTML. A evidência histórica do terceiro review permanece separada da rodada atual, para que cada release continue atribuída ao SHA técnico exato que a produziu.

## Rollback/correção

Enquanto nenhuma feature consumidora tiver iniciado, o merge `d272657` pode ser revertido como unidade. Depois de aplicada a migration, correções de schema, grants, trigger ou readiness usam exclusivamente nova migration append-only. A `00400` invalida grants antigos sem `session_id`, que exigem novo link; essa transição é segura porque `00200`/`00300` nunca foram aplicadas em ambiente remoto e o primeiro deploy executará a cadeia completa antes de liberar tráfego. Fixtures locais podem ser substituídas por reset; nenhum recurso cloud foi criado neste ciclo.

## Evidência histórica — terceiro review

- Node `24.18.0`, npm `11.19.0` e `npm ci` concluíram no ambiente canônico;
- formatação, lint, TypeScript estrito, Knip, documentação e auditoria de dependências passaram, com zero vulnerabilidades reportadas;
- `407/407` testes unitários, `224/224` asserts pgTAP e `59/59` execuções Playwright ficaram verdes sobre as correções do terceiro review;
- reset limpo, snapshot SQL e tipos gerados coincidiram com a instância local no head `20260811000300`;
- builds e smokes standalone de web e backoffice passaram sem deixar processos ou portas residuais;
- o release imutável das correções do terceiro review, commit `3bb6cb34f10d8dbb6dd14d94a781a1508789cd1b`, validou `2.754` artefatos e publicou o archive local com SHA-256 `94c52f375b1e0d53b4e08f7f08cda0df90bcad67bd252867a3dc4afc5eb9c9cd`;
- scans de artefatos Auth não encontraram sentinela de senha nem `token_hash`; cleanup final confirmou zero usuários QA e zero mensagens QA;
- auditorias independentes de segurança, QA, documentação, diff, índice técnico e release encerraram sem blocker; a evidência do release foi publicada em `e77b28d`.
- as cinco threads do terceiro review receberam respostas ancoradas no commit técnico e na evidência de release, foram resolvidas individualmente e o fetch thread-aware confirmou zero thread aberta.

## Evidência do quarto review

- reset limpo, geração e duas execuções consecutivas de `236/236` asserts pgTAP passaram no head `20260811000400`, com cleanup persistente da fixture `dblink` fora do rollback;
- `458/458` testes unitários e `59/59` execuções Playwright passaram; o run browser terminou sem sentinela de senha, `token_hash`, usuário QA ou mensagem QA residual;
- `npm ci`, formatação, lint, typecheck integral, documentação, builds das duas aplicações, audit sem vulnerabilidades e Knip passaram sobre o mesmo snapshot;
- a auditoria do índice técnico congelou 44 paths exatos — 35 modificados e nove novos —, sem arquivo fora do escopo, migration anterior reescrita, binário, symlink, artefato gerado indevido, segredo ou PII;
- o commit técnico `da34f4630948ec549b1b215c718a60e375c0d73a` foi publicado e os smokes standalone de web/backoffice passaram sem deixar processo ou porta local;
- a release imutável validou 2.756 artefatos — 1.467 de web, 1.276 de backoffice, 11 migrations, lockfile e manifesto — e publicou `.artifacts/set-livre-da34f4630948ec549b1b215c718a60e375c0d73a.tar.gz` com SHA-256 `33f0289b5a0a2ff491ac449958694417e6f43f8ab4630167e197975242ec7e47`;
- os 2.755 nós descritos no manifesto conferem por hash com a árvore, o manifesto embutido no archive é byte-idêntico, os dois `BUILD_ID` correspondem ao commit e o pacote contém 11 migrations no head `20260811000400`.
- as três threads do quarto review receberam respostas ancoradas nos commits técnico/de evidência, foram resolvidas individualmente e o fetch thread-aware confirmou 12 threads totais e zero abertas.
- o Codex revisou o snapshot final `656a5dc1c04a33e3246edd389c5c0d877cbe37ae` e registrou que não encontrou problema relevante, sem criar thread adicional.

O PR #2 foi integrado a `main` no merge `d27265728b7c675d373c1bc8425f227aa3e3641e`; a FEAT-002 passa a ser a primeira das 34 features concluídas no repositório. PEND-002, PEND-003, PEND-005 e PEND-006 continuam bloqueando go-live, sem reabrir a conclusão local.
