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
- o primeiro review substitui a rejeição global por um limiter limitado e particionado por ação, com evicção controlada sob saturação, e preserva a estrutura dos documentos jurídicos por um subset Markdown seguro.
- o segundo review encerra recovery ambíguo depois do envio do OTP sem oferecer retry e isola o cache de sessão por identidade, substituindo inclusive uma Query fresca da mesma identidade pelo snapshot SSR atual antes de liberar PII.
- o terceiro review torna também o signup ambíguo terminal, fecha cookies parcialmente publicados em login/recovery, habilita RLS na intenção privada e impede release de grant já expirado.

## Arquivos/componentes

Implementados: contratos compartilhados, primitives usadas pela feature, domínio `identity`, clientes Supabase server-side, Proxy de sessão, rotas App Router, templates Auth locais, migration/seed, testes e documentação viva.

## Banco, migration, grants e RLS

A migration append-only `20260811000200` cria o perfil mínimo, versões legais, aceites, intenções privadas e grants de recovery duráveis no banco e expiráveis. A correção append-only `20260811000300` habilita RLS sem policy em `private.signup_legal_intents` e faz o release recusar grant já expirado, sem alterar grants ou a allowlist DAL. Tabelas começam revogadas; RLS separa leitura pública vigente da leitura própria; nenhum browser escreve aceite ou grant. A DAL recebe somente `USAGE` em `private` e `EXECUTE` nas oito rotinas autorizadas — dois checks de readiness, criação da intenção e cinco operações de recovery —, totalizando nove dependências ACL exatas. Claim exclusiva, release de falha comprovadamente sem efeito e ainda vigente e consume com delete mantêm retry e one-shot duráveis entre processos. O trigger remove a metadata transitória sem apagar chaves alheias. O seed contém somente textos locais não aprovados para produção.

## Segurança e privacidade

O comando de cadastro aplica origem e host da request, limite de corpo, rate limit, Zod estrito e redaction. Senha, token, cookie, e-mail, IP e user-agent brutos não entram em logs ou tabelas de evidência. No browser, e-mails, senhas e `TokenHash` de cadastro, login, callback e recovery passam por refs one-shot e deixam `variables` do MutationCache vazias. Metadata do Auth carrega somente um identificador opaco temporário e não é usada como autoridade de perfil. O `TokenHash` de confirmação/recovery fica no fragmento, é apagado antes do `POST` e nunca integra a primeira request. Depois que um callback de signup ou recovery é enviado, rede/timeout/resposta inválida e qualquer resultado desconhecido de `verifyOtp` são terminais: o payload é descartado, cookies/sessão Auth exatos são limpos e a UI solicita novo link. O mesmo fallback fecha publicação parcial de login e sign-out final inconclusivo do recovery, sem remover cookies alheios. Cookies de produção são seguros; apenas desenvolvimento e testes no HTTP loopback local usam a exceção estritamente limitada. O renderer jurídico não usa `dangerouslySetInnerHTML`: tags e sintaxe fora do subset permanecem texto escapado pelo React. Links são fail-closed para path interno absoluto ou HTTPS sem credenciais; destino rejeitado preserva somente o rótulo.

## Read models, comandos e invalidação

- comando visitante `identity.register` em `POST /api/commands`;
- métodos Auth server-side para login, logout, callback e recovery;
- read models explícitos para documentos legais vigentes e contexto da própria identidade;
- sessão usa key por `userId`/anônimo; Query preexistente, refetch ativo/pausado, observer antigo ou troca de usuário bloqueiam PII até remover a família, semear o SSR atual ou recarregar a rota;
- logout limpa integralmente o cache privado do TanStack Query e força nova renderização server-side;
- a troca de senha marca o grant de recovery como consumido no cache e remove a sessão privada armazenada antes do próximo login.

## UX, mobile e acessibilidade

Formulários em PT-BR usam labels persistentes, `PasswordInput`, erros associados, live regions, alvos de 44 px e composição própria até 320 px e reflow de 160 CSS px. O tipo PF/PJ é lido diretamente do `FormData`, sem uma segunda fonte em estado React que possa divergir durante a hidratação. O callback apresenta loading e retry apenas quando a repetição é comprovadamente segura; recovery ambíguo orienta novo link. A sessão privada fica oculta durante qualquer revalidação ou troca de snapshot. Ausência de versão legal e token inválido falham fechado. Nas páginas jurídicas, o título canônico é o único `h1`; headings do corpo começam em `h2`, listas mantêm a semântica ordenada ou não ordenada e ênfases/links usam elementos nativos.

## Testes e IDs QA

Os IDs `SL-F002-E2E-001` a `007` possuem specs físicas, totalizando 23 execuções verdes na matriz dedicada: Supabase Auth e Mailpit reais, confirmação, sessão SSR, recovery mobile, resposta genérica, matriz adversarial de `returnTo`, teclado, axe e reflow a 160x360 nos três engines. Senhas QA nunca entram no DOM ou em passos que serializam o valor: um `Locator.evaluate` valida input/form/nome e instala um listener `formdata` one-shot, deixando o segredo somente no `FormData`; trace, vídeo e screenshot permanecem desligados e a saída/artefatos passam por scan de sentinela e token. O tipo PF/PJ é verificado novamente imediatamente antes do submit, fechando a corrida de hidratação reproduzida no WebKit. Logout e callback aguardam respostas, destinos sanitizados e estados visuais reais, sem depender do limite visual padrão de cinco segundos nem registrar a URL sensível intermediária. O parser jurídico possui prova unitária e de markup estático real para headings, parágrafos, listas, ênfase, links, hierarquia do título, escape de HTML e rejeição de hrefs inseguros. Os testes de sessão reproduzem A→B, mesmo usuário com novo snapshot SSR, observer antigo, refetch offline pausado e rejeição do payload antes de B entrar na key de A; os testes Auth cobrem os dois callbacks ambíguos, publicação parcial, cookies fragmentados, cleanup e redaction. Com as 36 execuções técnicas da fundação, a rodada Playwright integral passou em 59/59. A rodada atual soma 407 unitários; 224 asserts pgTAP cobrem a baseline e o `legal-core`, incluindo constraints, grants, RLS A/B e nos estados privados, trigger, readiness, corrida, purge, scrub, claim/release/consume concorrente, expiração e imutabilidade.

## Observabilidade e operação

O primeiro comando real introduz evento JSON seguro com `requestId`, ação, duração e resultado, sem PII. O funil técnico local cobre cadastro, login, callback, logout e recovery. Supabase Cloud, Nginx/TLS com borda confiável, SMTP real e textos jurídicos aprovados continuam bloqueados, respectivamente, por PEND-002, PEND-003, PEND-005 e PEND-006.

## Documentação atualizada

Este registro acompanha a mudança junto de feature, API, banco, segurança, UX, design system, notificações, cache, observabilidade, QA, dependências, contexto, pendências, índices e resumo HTML. A evidência abaixo separa os gates atuais do release histórico do segundo review; o snapshot corrente será reempacotado depois do commit técnico e o review do PR continua sendo a última etapa antes do merge.

## Rollback/correção

Antes de qualquer consumidor mergeado, o código pode ser revertido junto da branch. Depois de aplicada a migration, correções de schema, grants, trigger ou readiness usam exclusivamente nova migration append-only. Fixtures locais podem ser substituídas por reset; nenhum recurso cloud será criado neste ciclo.

## Evidência de conclusão

- Node `24.18.0`, npm `11.19.0` e `npm ci` concluíram no ambiente canônico;
- formatação, lint, TypeScript estrito, Knip, documentação e auditoria de dependências passaram, com zero vulnerabilidades reportadas;
- `407/407` testes unitários, `224/224` asserts pgTAP e `59/59` execuções Playwright ficaram verdes sobre as correções do terceiro review;
- reset limpo, snapshot SQL e tipos gerados coincidiram com a instância local no head `20260811000300`;
- builds de web e backoffice passaram no patch atual; smokes standalone serão repetidos pelo release imutável depois do commit técnico;
- o release imutável das correções do segundo review, commit `7083d49bf68a430e6db239cd12e6fc24fdf58e86`, validou `2.753` artefatos e publicou o archive local com SHA-256 `2382c53e6c04174004132bb601a28d961f75734d1e2d7c8f2e8bf064172fc9b5`;
- scans de artefatos Auth não encontraram sentinela de senha nem `token_hash`; cleanup final confirmou zero usuários QA e zero mensagens QA;
- auditorias independentes de segurança, QA, documentação e diff encerraram sem blocker; o índice staged será auditado antes do commit.

A implementação está validada localmente e segue fora da contagem de features concluídas até o review do PR e o merge.
