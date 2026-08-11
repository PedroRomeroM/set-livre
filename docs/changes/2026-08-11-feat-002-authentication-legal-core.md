# Mudança: FEAT-002 — autenticação e legal-core

- Data: 2026-08-11
- Autor/agente: Codex
- Issue/PR: branch `feat/feat-002-auth-legal-core`; rastreio pelo PR deste ciclo
- Features: FEAT-002
- ADRs: ADR-001, ADR-002, ADR-003, ADR-004, ADR-005, ADR-013, ADR-015, ADR-016, ADR-017 e ADR-018
- Risco: alto — identidade, sessão, aceite legal e fronteiras de autorização
- Rollback: correção append-only para banco aplicado; revert do código antes de qualquer feature dependente

## Resumo

Implementar a primeira fatia vertical de produto: cadastro por e-mail e senha, confirmação, login, logout, recuperação, sessão SSR e o bootstrap `legal-core` com versões jurídicas locais e aceites autoritativos.

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

## Arquivos/componentes

Implementados: contratos compartilhados, primitives usadas pela feature, domínio `identity`, clientes Supabase server-side, Proxy de sessão, rotas App Router, templates Auth locais, migration/seed, testes e documentação viva.

## Banco, migration, grants e RLS

A migration append-only `20260811000200` cria o perfil mínimo, versões legais, aceites, intenções privadas e grants de recovery duráveis. A correção `20260811000300` habilita RLS sem policy na intenção privada e impede release depois da expiração. A nova `20260811000400` invalida grants anteriores sem `session_id`, cria `private.identity_recovery_sessions`, vincula grant, usuário, sessão Auth e scope opaco, exige `jwt_exp=3600` e conserva uma tombstone depois do grant/cookies. Ausência em `auth.sessions` fecha a binding, remove o grant e inicia retenção conservadora; purge requer nova prova de ausência depois da janela. Os três estados privados usam RLS sem policy. A DAL recebe somente `USAGE private` e `EXECUTE` nas nove rotinas autorizadas — dois checks de readiness, criação da intenção e seis operações do contexto recovery —, totalizando dez dependências ACL exatas. O trigger remove a metadata transitória sem apagar chaves alheias. O seed contém somente textos locais não aprovados para produção.

## Segurança e privacidade

O comando de cadastro aplica origem e host da request, limite de corpo, rate limit, Zod estrito e redaction. Senha, token, cookie, e-mail, IP e user-agent brutos não entram em logs ou tabelas de evidência. No browser, e-mails, senhas e `TokenHash` passam por refs one-shot e deixam `variables` do MutationCache vazias. O limiter conserva até 10.000 buckets exatos sem evicção viva; depois da saturação, chaves novas compartilham overflow sticky por ação, limitado a 64 partições e fail-closed além desse teto. Depois que um callback é enviado, rede, timeout, resposta inválida e resultado desconhecido são terminais. Recovery recebe uma binding autoritativa pelo `session_id` assinado; o UUID exposto em cookie/SSR serve somente para escopar UI/cache. Perda do marker, expiração do grant ou saída da superfície de recovery fecham a binding e a sessão Auth exata. Cookies de produção são seguros; apenas HTTP loopback local usa a exceção limitada. O renderer jurídico não usa `dangerouslySetInnerHTML`; links são fail-closed para path interno absoluto ou HTTPS sem credenciais.

## Read models, comandos e invalidação

- comando visitante `identity.register` em `POST /api/commands`;
- métodos Auth server-side para login, logout, callback e recovery;
- read models explícitos para documentos legais vigentes e contexto da própria identidade;
- sessão usa key por `userId`/anônimo; Query preexistente, refetch ativo/pausado, observer antigo ou troca de usuário bloqueiam PII até remover a família, semear o SSR atual ou recarregar a rota;
- logout limpa integralmente o cache privado do TanStack Query e força nova renderização server-side;
- status de recovery usa key `recoveryStatus(scope)`; resposta com outro scope é rejeitada antes do cache e `fetching`/`paused` exibem somente verificação, sem montar o formulário;
- a troca de senha marca o grant como consumido no cache, remove a família de sessão e encerra binding, grant e sessão Auth antes do próximo login.

## UX, mobile e acessibilidade

Formulários em PT-BR usam labels persistentes, `PasswordInput`, erros associados, live regions, alvos de 44 px e composição própria até 320 px e reflow de 160 CSS px. O tipo PF/PJ é lido diretamente do `FormData`, sem uma segunda fonte em estado React que possa divergir durante a hidratação. O callback apresenta loading e retry apenas quando a repetição é comprovadamente segura; recovery ambíguo orienta novo link. A sessão privada fica oculta durante qualquer revalidação ou troca de snapshot. Ausência de versão legal e token inválido falham fechado. Nas páginas jurídicas, o título canônico é o único `h1`; headings do corpo começam em `h2`, listas mantêm a semântica ordenada ou não ordenada e ênfases/links usam elementos nativos.

## Testes e IDs QA

Os IDs `SL-F002-E2E-001` a `007` possuem specs físicas. O quarto review acrescenta unidades adversariais para churn/overflow, cache de recovery online/offline e binding/tombstone; `SL-F002-E2E-003` foi ampliado, sem novo ID, para provar cache pausado sem formulário, sucesso nominal, expiração real e encerramento de binding, grant, sessão Auth e cookies. A rodada atual passou em 458/458 unitários, 236/236 asserts pgTAP e 59/59 execuções Playwright, com sentinela e `token_hash` ausentes dos artefatos e cleanup Auth/Mailpit em zero.

## Observabilidade e operação

O primeiro comando real introduz evento JSON seguro com `requestId`, ação, duração e resultado, sem PII. O funil técnico local cobre cadastro, login, callback, logout e recovery. Supabase Cloud, Nginx/TLS com borda confiável, SMTP real e textos jurídicos aprovados continuam bloqueados, respectivamente, por PEND-002, PEND-003, PEND-005 e PEND-006.

## Documentação atualizada

Este registro acompanha a mudança junto de feature, API, banco, segurança, UX, design system, notificações, cache, observabilidade, QA, dependências, contexto, pendências, índices e resumo HTML. A evidência abaixo registra a última rodada integral verde, anterior ao quarto review. Os novos gates, release e auditoria do índice serão adicionados em bloco separado depois da estabilização.

## Rollback/correção

Antes de qualquer consumidor mergeado, o código pode ser revertido junto da branch. Depois de aplicada a migration, correções de schema, grants, trigger ou readiness usam exclusivamente nova migration append-only. A `00400` invalida grants antigos sem `session_id`, que exigem novo link; essa transição é segura porque `00200`/`00300` nunca foram aplicadas fora da branch e o primeiro deploy executará a cadeia completa antes de liberar tráfego. Fixtures locais podem ser substituídas por reset; nenhum recurso cloud será criado neste ciclo.

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
- smokes standalone, release imutável e auditoria do índice ainda serão consolidados depois do commit técnico.

A implementação segue fora da contagem de features concluídas até os smokes standalone, release, auditoria do índice, review do PR e merge.
