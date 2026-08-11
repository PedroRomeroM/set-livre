# Mudança: FEAT-003 — perfil PF/PJ, conta e preferências

- Data: 2026-08-11
- Autor/agente: Codex
- Issue/PR: branch `feat/feat-003-profile-account`; PR pendente
- Features: FEAT-002, FEAT-003
- ADRs: ADR-003, ADR-004, ADR-005, ADR-013, ADR-015, ADR-016, ADR-017 e ADR-018
- Risco: alto — PII, RLS, comandos autenticados e cache privado
- Rollback: reverter a fatia antes de qualquer ambiente remoto; depois de aplicar schema, corrigir exclusivamente por migration append-only

## Resumo

Implementa a segunda fatia vertical da plataforma: conclusão e manutenção do perfil PF/PJ, conta, segurança e preferência visual, sobre a identidade mínima da FEAT-002.

## Motivo

A FEAT-003 é a próxima feature na sequência canônica e transforma o perfil mínimo do cadastro em uma conta utilizável sem antecipar owner, reserva ou direitos LGPD completos. O mesmo ciclo absorve dois achados pós-merge da dependência Auth porque ambos afetam diretamente a segurança da entrada e da recuperação usadas pelas novas rotas de conta.

## Comportamento anterior

- `profiles` guardava apenas tipo, status e conclusão mínima criados pela FEAT-002;
- não existiam `/conta`, `/conta/seguranca`, preferência visual persistida nem read model mascarado do próprio perfil;
- CPF/CNPJ e documento adicional não possuíam contrato canônico, comandos ou isolamento RLS da FEAT-003;
- resposta de transporte ambígua do login podia deixar o formulário visível sem revalidar cookies eventualmente publicados;
- erro público da troca de senha era perdido quando o refetch desmontava o formulário, e a transição de scope podia rearmar hard reloads;
- a largura intrínseca da opção nativa do `select` criava overflow no WebKit a 160 CSS px.

## Comportamento novo

- perfil PF/PJ completo, edição permitida, documento sempre mascarado e preferência `system | light | dark`;
- conta e segurança com sessão SSR, boundaries fechados e comandos autoritativos;
- login ambíguo apaga refs, DOM e caches antes de revalidar SSR; falha depois de iniciar a publicação recebe `AUTH_SESSION_RECHECK_REQUIRED` mesmo quando o cleanup exato também falha;
- recovery conserva somente feedback público no mesmo scope e faz uma única transição idempotente quando a autorização muda;
- `Select` nativo mantém a semântica e contém a largura intrínseca no reflow WebKit.
- a máscara de telefone reconhece somente o DDI brasileiro `55` em forma explícita/estrutural, preserva excesso estrangeiro e deixa o schema rejeitá-lo sem truncar para outro número válido.

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

A migration append-only `20260811000500_profile_account.sql` completa `profiles`, cria `user_preferences`, validadores CPF/CNPJ e máscaras generated. `public.get_my_profile()` é `security invoker`, sem UUID e sob `auth.uid()` + RLS; `app_dal` recebe somente os três comandos privados. O readiness passa a doze rotinas/treze dependências. Reset, geração e 284/284 asserts pgTAP provam isolamento A/B, checks, concorrência e ausência de grants sobre documentos crus.

## Segurança e privacidade

CPF/CNPJ e documento adicional vivem apenas em `FormData` e refs one-shot durante o comando, nunca em query key, state React, `MutationCache`, log ou resposta pública. O read model retorna máscaras e repete o vínculo `user_id === session.userId`; divergência limpa queries e mutations antes de qualquer reload. O login ambíguo remove controles e credenciais efêmeras; feedback recovery guarda somente mensagem pública, scope UUID público e campos allowlisted, sem `Error`, stack, token ou senha.

## Read models, comandos e invalidação

- read model público invoker `get_my_profile()`, filtrado pela sessão Auth/RLS e normalizado com escopo repetido;
- `profile.complete` para a primeira conclusão;
- `profile.update` discriminado entre identidade e aparência;
- optimistic concurrency pela versão autoritativa;
- cache `account.profile(userId)`, nunca por e-mail/documento, fechado durante hidratação, refetch e troca de sessão; versões regressivas são ignoradas e forçam refetch, e divergência descarta MutationCache/queries privadas antes do reload;
- conclusão sincroniza a sessão; mutations publicam o DTO autoritativo e não fazem update otimista de PII.

## UX, mobile e acessibilidade

As rotas `/conta` e `/conta/seguranca` possuem composição desktop/mobile, 320 px, reflow a 200%, teclado, axe, loading, vazio, erro de campo/seção, conflito, timeout, sucesso, conta suspensa e recuperação. O documento salvo nunca volta em claro ao DOM. O `Select` mantém semântica nativa, mas contém a largura intrínseca da opção no WebKit para não criar scroll horizontal a 160 CSS px.

## Testes e IDs QA

Os IDs `SL-F003-E2E-001` a `009` estão implementados em quatro specs e somam 32 execuções: critical, regression, axe claro/escuro/mobile e reflow nos três engines. A suíte integral passou em 91/91, sem resultados unexpected, flaky ou skipped, sem erros finais/de execução e sem attachments. A auditoria encontrou 102 ocorrências de 62 endereços sintéticos únicos `qa_f002|qa_f003_*@example.test`, exclusivamente nos títulos automáticos allowlisted dos steps, sob allowlist e com entropia independente das senhas; sentinelas, tokens, documentos, cookies Auth e Bearer ficaram ausentes. Unidades de normalização/DV/redaction/cache e pgTAP para RLS, ACL, checks e concorrência também estão verdes.

## Observabilidade e operação

Eventos usam ação, `requestId`, duração, status e resultado; nunca nome, telefone, CPF/CNPJ, documento, e-mail ou payload. Readiness inclui a migration head e as rotinas/ACL exatas; reset e testes destrutivos permanecem restritos à stack local. Supabase Cloud, SMTP e produção continuam fora deste ciclo conforme ADR-018 e pendências vigentes.

## Documentação atualizada

Este registro acompanha FEAT-002/003, contratos API/banco/cache, segurança, domínio, UX, design system, observabilidade, migration plan, catálogo/QA, índices, README e `contexto-projeto-set-livre.html`. OPEN-009 registra o CNPJ alfanumérico oficial sem alterar o escopo de FEAT-034.

## Rollback/correção

Antes de qualquer aplicação remota, a branch pode ser revertida como unidade. Depois de aplicar `20260811000500`, qualquer correção de schema, grants ou funções usa exclusivamente nova migration append-only; dados pessoais não são corrigidos por edição manual. Componentes e hardenings Auth podem ser revertidos pelo commit da feature somente se os contratos/testes correspondentes também voltarem juntos.

## Evidência de conclusão

Em andamento. O snapshot funcional passou em 538/538 unitários, 284/284 asserts pgTAP, 91/91 execuções Playwright/axe, formatação, lint, typecheck, docs, audit, Knip, builds e smokes standalone dos dois apps. Cleanup local terminou sem usuários/sessões QA, perfis, preferências, grants, mensagens ou processos residuais. O índice congelado de 85 paths foi auditado sem blocker e originou o commit `727eecdb05cddb6ea53e11c8b9d374002d6c2dfe`. A release local imutável contém 2.801 artefatos; o archive `set-livre-727eecdb05cddb6ea53e11c8b9d374002d6c2dfe.tar.gz` possui SHA-256 `2f1dafc636b6ea1552961d3177033dad1ac30e850fc96b710db26c992accf490`. Ainda faltam publicação, review e merge; por isso a FEAT-003 não é declarada concluída neste registro.
