# Mudança: FEAT-003 — perfil PF/PJ, conta e preferências

- Data: 2026-08-11
- Autor/agente: Codex
- Issue/PR: branch `feat/feat-003-profile-account`; draft [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4) aberto
- Features: FEAT-002, FEAT-003
- ADRs: ADR-003, ADR-004, ADR-005, ADR-013, ADR-015, ADR-016, ADR-017 e ADR-018
- Risco: alto — PII, RLS, comandos autenticados e cache privado
- Rollback: reverter a fatia antes de qualquer ambiente remoto; depois de aplicar schema, corrigir exclusivamente por migration append-only

## Resumo

Implementa a segunda fatia vertical da plataforma: conclusão e manutenção do perfil PF/PJ, conta, segurança e preferência visual, sobre a identidade mínima da FEAT-002. O patch P0 corrente vincula cada mutation ao escopo SSR que originou o formulário e impede retomada/publicação sob outra sessão.

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

CPF/CNPJ e documento adicional vivem apenas em `FormData` e refs one-shot durante o comando, nunca em query key, state React, `MutationCache`, log ou resposta pública. A ref agora contém também o `expectedScope` do recorte SSR e cada mutation usa `networkMode: "always"`, de modo que indisponibilidade não produz fila pausada retomável. `expectedScope` não prova ownership: o read model e toda escrita continuam vinculados ao `session.userId`; divergência retorna `409 SESSION_CHANGED` antes do limiter específico de perfil, serviço e DAL. `SESSION_CHANGED`/`UNAUTHENTICATED` apagam ref, DOM e caches privados antes de recarregar. O login ambíguo remove controles e credenciais efêmeras; feedback recovery guarda somente mensagem pública, scope UUID público e campos allowlisted, sem `Error`, stack, token ou senha.

## Read models, comandos e invalidação

- read model público invoker `get_my_profile()`, filtrado pela sessão Auth/RLS e normalizado com escopo repetido;
- `profile.complete` para a primeira conclusão;
- `profile.update` discriminado entre identidade e aparência;
- optimistic concurrency pela versão autoritativa;
- cache `account.profile(userId)`, nunca por e-mail/documento, fechado durante hidratação, refetch e troca de sessão; versões regressivas são ignoradas e forçam refetch, e divergência descarta MutationCache/queries privadas antes do reload;
- reseeds autoritativos de login, perfil e segurança limpam `MutationCache`, `account/profile` e `identity/session` preservando queries públicas; logout e incerteza de login limpam o `QueryClient` integral;
- conclusão sincroniza a sessão; mutations publicam o DTO autoritativo sem update otimista de PII, preservam o observer da query corrente e rejeitam resultado tardio cujo escopo já não possui key ativa.

## UX, mobile e acessibilidade

As rotas `/conta` e `/conta/seguranca` possuem composição desktop/mobile, 320 px, reflow a 200%, teclado, axe, loading, vazio, erro de campo/seção, conflito, timeout, sucesso, conta suspensa e recuperação. O documento salvo nunca volta em claro ao DOM. O `Select` mantém semântica nativa, mas contém a largura intrínseca da opção no WebKit para não criar scroll horizontal a 160 CSS px.

## Testes e IDs QA

No snapshot corrente, os IDs `SL-F003-E2E-001` a `009` permanecem implementados em quatro specs e somam 32/32 execuções aprovadas: critical, regression, axe claro/escuro/mobile e reflow nos três engines. A suíte integral passou em 91/91, sem erros finais/de execução e sem attachments. O ID 004 ficou verde nas três projeções com marcador `pagehide=clear`, zero `pageerror`, zero erro React no console e B inalterado; o ID 009 ficou verde nas quatro projeções de fila offline e recuperação. A auditoria encontrou 102 ocorrências de 62 endereços sintéticos únicos `qa_f002|qa_f003_*@example.test`, exclusivamente nos títulos automáticos allowlisted dos steps — `Fill` 84, `Visible` 10 e `Type` 8 — e nenhum segredo ou resíduo final.

No patch P0 local, 563/563 unidades em 59 arquivos cobrem o envelope estrito, a ordem do `SESSION_CHANGED`, `networkMode: "always"`, cleanup one-shot, reseeds privados, preservação do observer, callback tardio A→B e o boundary React-safe. Sem aumentar os nove IDs ou as 32 execuções catalogadas, `SL-F003-E2E-004` e `SL-F003-E2E-009` provam respectivamente a submissão stale A→B e a ausência de fila/POST tardio offline. Duas execuções integrais anteriores foram interrompidas em 46 aprovados e serviram somente ao diagnóstico: primeiro, a leitura do body `409` começou tarde demais, após o hard reload; depois de antecipá-la, o oráculo baseado em `document.body.textContent` incluiu scripts Flight/RSC com o snapshot SSR de A, fora da superfície visual, sem distinguir esses bytes de nós ainda renderizados. Esse match não comprovou vazamento visual. O boundary passou a fechar por commit React síncrono seguro, e o probe passou a varrer somente `main` e exigir heading, resumo, formulário e controles desconectados; a terceira matriz integral ficou verde. Os builds e smokes standalone também passaram sem warnings. Permanecem pendentes apenas a release, commit/push e o novo review do snapshot.

## Observabilidade e operação

Eventos usam ação, `requestId`, duração, status e resultado; nunca nome, telefone, CPF/CNPJ, documento, e-mail ou payload. Readiness inclui a migration head e as rotinas/ACL exatas; reset e testes destrutivos permanecem restritos à stack local. Supabase Cloud, SMTP e produção continuam fora deste ciclo conforme ADR-018 e pendências vigentes.

## Documentação atualizada

Este registro acompanha FEAT-002/003, contratos API/banco/cache, segurança, domínio, UX, design system, observabilidade, migration plan, catálogo/QA, índices, README e `contexto-projeto-set-livre.html`. OPEN-009 registra o CNPJ alfanumérico oficial sem alterar o escopo de FEAT-034.

## Rollback/correção

Antes de qualquer aplicação remota, a branch pode ser revertida como unidade. Depois de aplicar `20260811000500`, qualquer correção de schema, grants ou funções usa exclusivamente nova migration append-only; dados pessoais não são corrigidos por edição manual. Componentes e hardenings Auth podem ser revertidos pelo commit da feature somente se os contratos/testes correspondentes também voltarem juntos.

## Evidência de conclusão

Em andamento. O snapshot local corrente passou em 563/563 unitários distribuídos por 59 arquivos, 293/293 asserts pgTAP, 91/91 execuções Playwright/axe e nos builds/smokes standalone dos dois apps sem warnings, incluindo 32/32 da FEAT-003 e auditoria sem erros finais, attachments, segredos ou resíduos. O snapshot anterior, congelado no commit `727eecdb05cddb6ea53e11c8b9d374002d6c2dfe`, originou a última release local, com 2.801 artefatos e SHA-256 `2f1dafc636b6ea1552961d3177033dad1ac30e850fc96b710db26c992accf490`; essa release não valida o hardening atual. Ainda faltam nova release, commit/push, novo review e merge do draft [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4). A FEAT-003 não é declarada concluída neste registro.
