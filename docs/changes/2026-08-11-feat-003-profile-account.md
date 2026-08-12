# Mudança: FEAT-003 — perfil PF/PJ, conta e preferências

- Data: 2026-08-11
- Autor/agente: Codex
- Issue/PR: [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4), incorporado a `main` no merge `465d195`
- Features: FEAT-002, FEAT-003
- ADRs: ADR-003, ADR-004, ADR-005, ADR-013, ADR-015, ADR-016, ADR-017 e ADR-018
- Risco: alto — PII, RLS, comandos autenticados e cache privado
- Rollback: reverter a fatia antes de qualquer ambiente remoto; depois de aplicar schema, corrigir exclusivamente por migration append-only

## Resumo

Implementa a segunda fatia vertical da plataforma: conclusão e manutenção do perfil PF/PJ, conta, segurança e preferência visual, sobre a identidade mínima da FEAT-002. O hardening final vincula mutations ao escopo SSR, impede retomada/publicação sob outra sessão, bloqueia os efeitos destrutivos explícitos de logout obsoleto/offline antes de recovery, deleção de cookies ou `signOut` e limita a projeção de preferência pós-login a um segundo no servidor.

## Motivo

A FEAT-003 é a próxima feature na sequência canônica e transforma o perfil mínimo do cadastro em uma conta utilizável sem antecipar owner, reserva ou direitos LGPD completos. O mesmo ciclo absorve dois achados pós-merge da dependência Auth porque ambos afetam diretamente a segurança da entrada e da recuperação usadas pelas novas rotas de conta.

## Comportamento anterior

- `profiles` guardava apenas tipo, status e conclusão mínima criados pela FEAT-002;
- não existiam `/conta`, `/conta/seguranca`, preferência visual persistida nem read model mascarado do próprio perfil;
- CPF/CNPJ e documento adicional não possuíam contrato canônico, comandos ou isolamento RLS da FEAT-003;
- resposta de transporte ambígua do login podia deixar o formulário visível sem revalidar cookies eventualmente publicados;
- erro público da troca de senha era perdido quando o refetch desmontava o formulário, e a transição de scope podia rearmar hard reloads;
- a largura intrínseca da opção nativa do `select` criava overflow no WebKit a 160 CSS px.
- uma mutation de perfil iniciada por A podia ficar pausada pelo modo de rede padrão e retomar depois de a sessão/cookie mudar para B; como o servidor via a sessão B e versões A/B podiam coincidir, dados crus de A poderiam alcançar o perfil de B;
- reseeds SSR normais removiam queries, mas não garantiam o descarte conjunto do `MutationCache` e das duas famílias privadas; uma resposta tardia também podia tentar republicar a key de A depois do reseed B.
- a closure de logout podia ser pausada offline e retomar depois de A ter sido substituído por B; sem terminar a classificação do recorte antes de obter explicitamente o cookie store e antes de recovery, deleção de cookies ou `signOut`, a ação antiga podia encerrar a sessão nova;
- a projeção `get_my_profile()` iniciada depois de `setSession` não possuía deadline próprio, de modo que uma RPC pendente podia reter a resposta e resolver tarde demais para governar cookie/cleanup com segurança.

## Comportamento novo

- perfil PF/PJ completo, edição permitida, documento sempre mascarado e preferência `system | light | dark`;
- conta e segurança com sessão SSR, boundaries fechados e comandos autoritativos;
- login ambíguo apaga refs, DOM e caches antes de revalidar SSR; falha depois de iniciar a publicação recebe `AUTH_SESSION_RECHECK_REQUIRED` mesmo quando o cleanup exato também falha;
- recovery conserva somente feedback público no mesmo scope e faz uma única transição idempotente quando a autorização muda;
- `Select` nativo mantém a semântica e contém a largura intrínseca no reflow WebKit.
- a máscara de telefone reconhece somente o DDI brasileiro `55` em forma explícita/estrutural, preserva excesso estrangeiro e deixa o schema rejeitá-lo sem truncar para outro número válido.
- `profile.complete` e `profile.update` exigem `expectedScope` UUID estrito, comparado à sessão autoritativa antes do limiter específico de perfil, serviço e DAL; divergência recebe `409 SESSION_CHANGED` sem executar escrita;
- mutations sensíveis usam `networkMode: "always"`, nunca entram em fila offline e limpam `{ expectedScope, payload }` da ref one-shot em todo desfecho;
- `SESSION_CHANGED`/`UNAUTHENTICATED` fecham DOM/cache e recompõem SSR; reseeds normais limpam mutations e as famílias perfil/sessão preservando cache público, enquanto logout e login ambíguo mantêm limpeza integral;
- a publicação autoritativa preserva o observer atual; uma transição marca o latch e remove o DOM privado antes de limpar cache/recarregar, e todo callback tardio de A consulta esse fence antes de publicar.
- logout em `/entrar` e `/conta/seguranca` usa closure sem `variables`, `networkMode: "always"` e `expectedScope` UUID como asserção não autoritativa. `getClaims` pode renovar ou manter a sessão internamente; depois dele, a classificação termina antes de obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw retorna `503 SERVICE_UNAVAILABLE`, erro/contexto assinado ausente retorna `401 UNAUTHENTICATED`, e UUID válido divergente retorna `409 SESSION_CHANGED`. Os três ramos têm zero efeitos destrutivos explícitos de logout; o browser fecha boundary, limpa o `QueryClient` e recompõe SSR;
- a projeção de preferência no login passa `AbortSignal` a `get_my_profile()`, expira em um segundo no servidor, usa `system` como fallback e ignora resolução tardia sem cookie nem `signOut` posterior à resposta;
- operações privadas permanecem em `/api/commands`, que autentica antes de consumir o body; `identity.register` foi isolado na rota pública fechada `/api/auth/register`, conforme a emenda do ADR-004.

## Arquivos/componentes

A fatia altera contratos compartilhados de perfil/identidade, a migration e os pgTAP, DAL/read model/serviço/rotas de conta, componentes e primitives UI, cache TanStack, helpers e specs Playwright, além da documentação viva e do resumo HTML. Os hardenings Auth ficam concentrados em `login-panel`, `recovery-flow` e seus helpers/testes focados.

## Dependências e fronteiras

- FEAT-002 é a única `dependency-to-start` e já está incorporada a `main`.
- FEAT-034 é consumidora posterior dos dados para direitos LGPD completos; não bloqueia esta implementação e nenhuma rota falsa de dados/exportação será criada.
- E-mail permanece sob Supabase Auth. Esta feature o exibe como somente leitura e oferece apenas recuperação de senha e logout já reais.
- Upload/verificação documental, dados bancários, owner profile e checkout continuam fora do escopo.
- O ciclo também absorve dois hardenings pós-merge da FEAT-002: login com resposta de transporte ambígua passa por revalidação SSR sem manter credenciais/cache, e feedback retryable da troca de senha permanece no boundary externo durante o refetch autoritativo de recovery.

## Decisões de domínio

- OPEN-009 registra a entrada em produção do CNPJ alfanumérico e substitui o antigo pressuposto “somente dígitos”.
- CPF usa onze dígitos; CNPJ usa doze caracteres `A-Z`/`0-9` e dois DVs numéricos, com validação duplicada em TypeScript e PostgreSQL.
- PF/PJ pode ser corrigido somente enquanto o perfil ainda está incompleto.
- Documento adicional é texto opaco opcional de 3 a 40 caracteres, sem tipo canônico ou valor probatório.
- A única preferência visual inicial é `system | light | dark`; o banco é canônico e o cookie allowlisted é apenas projeção de apresentação.
- Depois da conclusão, nome e telefone são editáveis; CPF/CNPJ pode ser substituído e o documento adicional pode ser mantido, substituído ou removido explicitamente. Nenhum fato histórico é reescrito.

## Banco, migration, grants e RLS

A migration append-only `20260811000500_profile_account.sql` completa `profiles`, cria `user_preferences`, validadores CPF/CNPJ e máscaras generated. `public.get_my_profile()` é `security invoker`, sem UUID e sob `auth.uid()` + RLS; `app_dal` recebe somente os três comandos privados. O readiness passa a doze rotinas/treze dependências. Reset, geração e 293/293 asserts pgTAP provam isolamento A/B, checks, concorrência e ausência de grants sobre documentos crus. Os 57 asserts da FEAT-003 incluem duas personas Auth adversariais, marcadas apenas na fixture como owner/admin: continuam `authenticated`, leem só a própria conta, não escrevem tabelas nem executam `private`; as autoridades canônicas permanecem sequenciadas para FEAT-004/031.

## Segurança e privacidade

CPF/CNPJ e documento adicional vivem apenas em `FormData` e refs one-shot durante o comando, nunca em query key, state React, `MutationCache`, log ou resposta pública. A ref agora contém também o `expectedScope` do recorte SSR e cada mutation usa `networkMode: "always"`, de modo que indisponibilidade não produz fila pausada retomável. `expectedScope` não prova ownership: o read model e toda escrita continuam vinculados ao `session.userId`; divergência retorna `409 SESSION_CHANGED` antes do limiter específico de perfil, serviço e DAL. Logout aplica a mesma asserção em schema próprio: após `getClaims`, a classificação de indisponibilidade, ausência e divergência termina antes de obter explicitamente o cookie store e antes dos efeitos destrutivos explícitos de recovery, deleção de cookies ou `signOut`. `SESSION_CHANGED`/`UNAUTHENTICATED` apagam ref, DOM e caches privados antes de recarregar. O login ambíguo remove controles e credenciais efêmeras; feedback recovery guarda somente mensagem pública, scope UUID público e campos allowlisted, sem `Error`, stack, token ou senha.

## Read models, comandos e invalidação

- read model público invoker `get_my_profile()`, filtrado pela sessão Auth/RLS e normalizado com escopo repetido;
- `profile.complete` para a primeira conclusão;
- `profile.update` discriminado entre identidade e aparência;
- optimistic concurrency pela versão autoritativa;
- cache `account.profile(userId)`, nunca por e-mail/documento, fechado durante hidratação, refetch e troca de sessão; versões regressivas são ignoradas e forçam refetch, e divergência descarta MutationCache/queries privadas antes do reload;
- reseeds autoritativos de login, perfil e segurança limpam `MutationCache`, `account/profile` e `identity/session` preservando queries públicas; logout e incerteza de login limpam o `QueryClient` integral;
- conclusão sincroniza a sessão; mutations publicam o DTO autoritativo sem update otimista de PII, preservam o observer da query corrente e rejeitam resultado tardio cujo escopo já não possui key ativa.
- a projeção de aparência no login consulta `get_my_profile()` com `AbortSignal` e deadline de um segundo, degrada para `system` e não permite side effect tardio;
- logout executa uma closure sem `variables`, nunca fica pausado e termina em boundary fechado + limpeza integral + SSR; uma closure de A não encerra B.

## UX, mobile e acessibilidade

As rotas `/conta` e `/conta/seguranca` possuem composição desktop/mobile, 320 px, reflow a 200%, teclado, axe, loading, vazio, erro de campo/seção, conflito, timeout, sucesso, conta suspensa e recuperação. O documento salvo nunca volta em claro ao DOM. O `Select` mantém semântica nativa, mas contém a largura intrínseca da opção no WebKit para não criar scroll horizontal a 160 CSS px.

## Testes e IDs QA

No snapshot integral publicado anterior, os IDs `SL-F003-E2E-001` a `009` permaneceram implementados em quatro specs e somaram 32/32 execuções aprovadas; a suíte completa passou em 91/91. Esse resultado precede os dois P2 da revisão das `03:45Z`. Sem alterar IDs, contagens ou catálogo, a correção P2 posterior ampliou o ID 004 para provar que logout stale de A mantém B e o ID 009 para provar uma request offline e zero request tardia depois da reconexão. No snapshot funcional final, uma nova matriz Playwright/axe integral passou em 91/91 numa única execução de 3,9 minutos, incluindo novamente 32/32 da FEAT-003. O ID 004 passou em 3/3 projeções com `409` para logout stale, sessão e perfil de B intactos e zero `pageerror` ou erro React; o ID 009 passou em 4/4 com falha offline imediata, exatamente uma request e nenhum POST tardio após reconexão. O run terminou sem resultado inesperado, flake, skip, erro ou attachment e sem sentinelas, tokens, cookies Auth ou documentos crus. Os 62 e-mails QA únicos apareceram em 114 títulos automáticos allowlisted (`Fill` 84, `Visible` 18, `Count` 4 e `Type` 8); banco, Mailpit, portas e processos ficaram sem resíduo.

No patch P0 publicado, 563/563 unidades em 59 arquivos cobriram o envelope estrito, a ordem do `SESSION_CHANGED`, `networkMode: "always"`, cleanup one-shot, reseeds privados, preservação do observer, callback tardio A→B e o boundary React-safe. Sem aumentar os nove IDs ou as 32 execuções catalogadas, `SL-F003-E2E-004` e `SL-F003-E2E-009` provaram respectivamente a submissão stale A→B e a ausência de fila/POST tardio offline. Duas execuções integrais anteriores foram interrompidas em 46 aprovados e serviram somente ao diagnóstico: primeiro, a leitura do body `409` começou tarde demais, após o hard reload; depois de antecipá-la, o oráculo baseado em `document.body.textContent` incluiu scripts Flight/RSC com o snapshot SSR de A, fora da superfície visual, sem distinguir esses bytes de nós ainda renderizados. Esse match não comprovou vazamento visual. O boundary passou a fechar por commit React síncrono seguro, e o probe passou a varrer somente `main` e exigir heading, resumo, formulário e controles desconectados; a terceira matriz integral ficou verde. Os builds e smokes standalone também passaram sem warnings. O snapshot funcional foi congelado no commit `f4f3b1d13238bdb67a2bc77bff55c119132040dc`, a release local canônica foi gerada e o conjunto foi publicado com o commit documental `9c23ef3f0818d60a84b4f6321905c389cff5b7fa` antes da segunda revisão descrita a seguir.

## Segunda revisão do PR

O snapshot funcional `f4f3b1d13238bdb67a2bc77bff55c119132040dc` e o commit documental `9c23ef3f0818d60a84b4f6321905c389cff5b7fa` foram publicados no draft [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4). O trigger `5261407908` foi enviado às `02:29:08Z`; depois da espera integral de 60 minutos, a inspeção thread-aware confirmou a resposta Codex `5261469771`, publicada às `02:35:40Z` e vinculada ao commit revisado `9c23ef3f08`: “Didn't find any major issues”. As três threads da primeira revisão estavam resolvidas, não havia thread aberta e o HEAD remoto conferido era `9c23ef3f0818d60a84b4f6321905c389cff5b7fa`. Naquele momento, o PR continuava `OPEN`/draft e o merge permanecia pendente; esse é um registro histórico anterior às revisões seguintes e ao merge final.

## Terceira revisão do PR

O PR foi marcado ready no HEAD `9531815`. A revisão Codex publicada às `03:45Z` abriu dois P2, portanto a leitura anterior de zero thread e “somente merge pendente” passou a descrever apenas aquele snapshot histórico. O primeiro achado exigiu que logout offline/obsoleto não retomasse sob outra identidade nem alcançasse efeitos destrutivos explícitos de recovery, deleção de cookies ou `signOut` antes da classificação autoritativa; o segundo exigiu deadline para a projeção de preferência no login. As correções foram congeladas no commit `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7`, publicadas e submetidas a nova revisão.

As rodadas focadas passaram em 37/37 para o timeout da projeção, 96/96 no auditor combinado e 65/65 após o refinamento final da classificação de logout. A suíte unitária integral passou em 578/578 testes distribuídos por 60 arquivos. Reset, geração e banco passaram em 293/293 asserts pgTAP, distribuídos em 158 + 78 + 57, com head `20260811000500` e zero resíduo. A matriz Playwright/axe final passou em 91/91 em 3,9 minutos, com a evidência de segurança e cleanup registrada acima. Lint, typecheck, audit com zero vulnerabilidade e Knip também passaram. Os builds Next.js 16.3 de web/backoffice ficaram verdes sem warnings, com manifests standalone, 17 arquivos obrigatórios e `BUILD_ID` local em cada app. Os smokes validaram live/ready/root, CSP, `no-store`, assets, nonces e probes adversariais, incluindo `/entrar` 200 no web e 404 no backoffice; lockfile/gerados não mudaram, portas/processos ficaram limpos e os logs têm hashes `2e3b…4310` e `c9e5…da97`.

A release local canônica do commit P2 `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7` foi gerada como `set-livre-e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7.tar.gz`, com 24.757.341 bytes e SHA-256 `6edb2e246e0b3f46cf83f62ce8685e14b91cb31ac1437931f476fc649621273a`. O pacote contém 2.809 artefatos: web 1.519, backoffice 1.276, migrations 12, lockfile 1 e manifesto 1. O manifesto possui 667.285 bytes e SHA-256 `733dac5409c04d8fd1c39fcd2b867d0f812a75b4792479ead416ecf9f11f0135`; os `BUILD_ID` de web e backoffice equivalem ao commit. A geração ocorreu em Linux x64 com Node 24.18/npm 11.19, e a auditoria integral de tar, staging e manifesto terminou `NO-BLOCKER`, sem segredo de runtime nem dado PII/QA e sem resíduo. A release `f4f3b1d13238bdb67a2bc77bff55c119132040dc` permanece registrada como a evidência histórica anterior aos dois P2.

## Revisão final e merge

O HEAD final `1530f62589ed9f823ca9c7356ad530ecda8a8d4b` recebeu o comentário Codex `5262964258`, publicado às `06:00:43Z` e iniciado por “Codex Review: Didn't find any major issues. Swish!”. As cinco threads do PR ficaram resolvidas. O [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4) foi incorporado a `main` no merge `465d195ac6bed86a329ef961dafec5b38d9ebf6f`, em `2026-08-12T06:57:15Z`.

## Observabilidade e operação

Eventos usam ação, `requestId`, duração, status e resultado; nunca nome, telefone, CPF/CNPJ, documento, e-mail ou payload. Readiness inclui a migration head e as rotinas/ACL exatas; reset e testes destrutivos permanecem restritos à stack local. Supabase Cloud, SMTP e produção continuam fora deste ciclo conforme ADR-018 e pendências vigentes.

## Documentação atualizada

Este registro acompanha FEAT-002/003, contratos API/banco/cache, segurança, domínio, UX, design system, observabilidade, migration plan, catálogo/QA, índices, README e `contexto-projeto-set-livre.html`. OPEN-009 registra o CNPJ alfanumérico oficial sem alterar o escopo de FEAT-034.

## Rollback/correção

Antes de qualquer aplicação remota, a branch pode ser revertida como unidade. Depois de aplicar `20260811000500`, qualquer correção de schema, grants ou funções usa exclusivamente nova migration append-only; dados pessoais não são corrigidos por edição manual. Componentes e hardenings Auth podem ser revertidos pelo commit da feature somente se os contratos/testes correspondentes também voltarem juntos.

## Evidência de conclusão

Concluída. O snapshot funcional final `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7` passou em 578/578 unitários de 60 arquivos, lint, typecheck, audit com zero vulnerabilidade e Knip, além das rodadas focadas 37/37, 96/96 e 65/65. Reset/geração/banco passaram em 293/293 asserts pgTAP (158 + 78 + 57), head `20260811000500` e zero resíduo; a matriz Playwright/axe integral passou em 91/91 em 3,9 minutos, com 32/32 da FEAT-003, zero resultado inesperado/flake/skip/erro/attachment, varredura sensível negativa e cleanup total. Builds e smokes de web/backoffice também ficaram verdes, sem warning ou resíduo e sem alterar lockfile/gerados. A release local canônica foi gerada e auditada integralmente. O HEAD documental final recebeu revisão Codex limpa, as cinco threads ficaram resolvidas e o PR #4 foi incorporado a `main` no merge `465d195ac6bed86a329ef961dafec5b38d9ebf6f`.
