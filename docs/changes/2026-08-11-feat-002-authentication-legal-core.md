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

## Arquivos/componentes

Implementados: contratos compartilhados, primitives usadas pela feature, domínio `identity`, clientes Supabase server-side, Proxy de sessão, rotas App Router, templates Auth locais, migration/seed, testes e documentação viva.

## Banco, migration, grants e RLS

A migration append-only `20260811000200` cria o perfil mínimo, versões legais, aceites, intenções privadas e grants de recovery duráveis no banco e expiráveis. Tabelas começam revogadas; RLS separa leitura pública vigente da leitura própria; nenhum browser escreve aceite ou grant. A DAL recebe somente `USAGE` em `private` e `EXECUTE` nas oito rotinas autorizadas — dois checks de readiness, criação da intenção e cinco operações de recovery —, totalizando nove dependências ACL exatas. Claim exclusiva, release de falha comprovadamente sem efeito e consume com delete mantêm retry e one-shot duráveis entre processos. O trigger remove a metadata transitória sem apagar chaves alheias. O seed contém somente textos locais não aprovados para produção.

## Segurança e privacidade

O comando de cadastro aplica origem e host da request, limite de corpo, rate limit, Zod estrito e redaction. Senha, token, cookie, e-mail, IP e user-agent brutos não entram em logs ou tabelas de evidência. No browser, e-mails, senhas e `TokenHash` de cadastro, login, callback e recovery passam por refs one-shot e deixam `variables` do MutationCache vazias. Metadata do Auth carrega somente um identificador opaco temporário e não é usada como autoridade de perfil. O `TokenHash` de confirmação/recovery fica no fragmento, é apagado antes do `POST` e nunca integra a primeira request. Cookies de produção são seguros; apenas desenvolvimento e testes no HTTP loopback local usam a exceção estritamente limitada. O renderer jurídico não usa `dangerouslySetInnerHTML`: tags e sintaxe fora do subset permanecem texto escapado pelo React. Links são fail-closed para path interno absoluto ou HTTPS sem credenciais; destino rejeitado preserva somente o rótulo.

## Read models, comandos e invalidação

- comando visitante `identity.register` em `POST /api/commands`;
- métodos Auth server-side para login, logout, callback e recovery;
- read models explícitos para documentos legais vigentes e contexto da própria identidade;
- logout limpa integralmente o cache privado do TanStack Query e força nova renderização server-side;
- a troca de senha marca o grant de recovery como consumido no cache e remove a sessão privada armazenada antes do próximo login.

## UX, mobile e acessibilidade

Formulários em PT-BR usam labels persistentes, `PasswordInput`, erros associados, live regions, alvos de 44 px e composição própria até 320 px e reflow de 160 CSS px. O callback apresenta loading e falha recuperável; ausência de versão legal e token inválido falham fechado. Nas páginas jurídicas, o título canônico é o único `h1`; headings do corpo começam em `h2`, listas mantêm a semântica ordenada ou não ordenada e ênfases/links usam elementos nativos.

## Testes e IDs QA

Os IDs `SL-F002-E2E-001` a `007` possuem specs físicas, totalizando 23 execuções verdes na matriz dedicada: Supabase Auth e Mailpit reais, confirmação, sessão SSR, recovery mobile, resposta genérica, matriz adversarial de `returnTo`, teclado, axe e reflow a 160x360 nos três engines. Senhas QA nunca entram no DOM ou em passos que serializam o valor: um `Locator.evaluate` valida input/form/nome e instala um listener `formdata` one-shot, deixando o segredo somente no `FormData`; trace, vídeo e screenshot permanecem desligados e a saída/artefatos passam por scan de sentinela e token. Logout e callback aguardam respostas, destinos sanitizados e estados visuais reais, sem depender do limite visual padrão de cinco segundos nem registrar a URL sensível intermediária. O parser jurídico possui prova unitária e de markup estático real para headings, parágrafos, listas, ênfase, links, hierarquia do título, escape de HTML e rejeição de hrefs inseguros. Com as 36 execuções técnicas da fundação, a rodada Playwright integral passou em 59/59. A rodada atual soma 386 unitários; 224 asserts pgTAP cobrem a baseline e o `legal-core`, incluindo constraints, grants, RLS A/B, trigger, readiness, corrida, purge, scrub, claim/release/consume concorrente e imutabilidade.

## Observabilidade e operação

O primeiro comando real introduz evento JSON seguro com `requestId`, ação, duração e resultado, sem PII. O funil técnico local cobre cadastro, login, callback, logout e recovery. Supabase Cloud, Nginx/TLS com borda confiável, SMTP real e textos jurídicos aprovados continuam bloqueados, respectivamente, por PEND-002, PEND-003, PEND-005 e PEND-006.

## Documentação atualizada

Este registro acompanha a mudança junto de feature, API, banco, segurança, UX, design system, notificações, cache, observabilidade, QA, dependências, contexto, pendências, índices e resumo HTML. A evidência abaixo registra os gates e o release local já executados; o review do PR continua sendo a última etapa antes do merge.

## Rollback/correção

Antes de qualquer consumidor mergeado, o código pode ser revertido junto da branch. Depois de aplicada a migration, correções de schema, grants, trigger ou readiness usam exclusivamente nova migration append-only. Fixtures locais podem ser substituídas por reset; nenhum recurso cloud será criado neste ciclo.

## Evidência de conclusão

- Node `24.18.0`, npm `11.19.0` e `npm ci` concluíram no ambiente canônico;
- formatação, lint, TypeScript estrito, Knip, documentação e auditoria de dependências passaram, com zero vulnerabilidades reportadas;
- `386/386` testes unitários, `224/224` asserts pgTAP e a matriz Playwright integral `59/59` ficaram verdes;
- reset limpo, snapshot SQL e tipos gerados coincidiram com a instância local no head `20260811000200`;
- builds e smokes standalone de web e backoffice passaram sem deixar processos ou portas residuais;
- o release imutável do commit `0e5451d6f29c85db3e3dcab1c7b0c9ce3ef061fd` validou `2.752` artefatos e publicou o archive local com SHA-256 `b5b2a90edfc8b40dec492de55c6333adccb0321e02c988cee74eeb51f09b7626`;
- scans de artefatos Auth não encontraram sentinela de senha nem `token_hash`; cleanup final confirmou zero usuários QA e zero mensagens QA;
- auditorias independentes de segurança, QA, documentação, diff e índice staged encerraram sem blocker.

A implementação está validada localmente e segue fora da contagem de features concluídas até o review do PR e o merge.
