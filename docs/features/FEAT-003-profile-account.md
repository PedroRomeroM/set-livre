# FEAT-003 — Perfil PF/PJ, conta e preferências

## Metadados

| Campo            | Valor                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Em implementação                                                                                                                                                                                                                      |
| Prioridade       | P0                                                                                                                                                                                                                                    |
| Domínio          | `identity`                                                                                                                                                                                                                            |
| Specs Playwright | `tests/e2e/critical/feat-003-profile-account.spec.ts`<br>`tests/e2e/regression/feat-003-profile-account.spec.ts`<br>`tests/e2e/accessibility/feat-003-profile-account.spec.ts`<br>`tests/e2e/reflow/feat-003-profile-account.spec.ts` |

## Objetivo

Completar e manter os dados necessários de locatário/dono com validação brasileira, sem expor PII.

## Papéis

- usuário autenticado

## Rotas e superfícies

- /conta
- /conta/seguranca

## Dependências

- `dependency-to-start`: FEAT-002, já incorporada a `main` pelo PR #2;
- integração posterior: FEAT-034 consome os dados desta feature para exportação, exclusão, anonimização e retenção, mas não bloqueia a conclusão local da FEAT-003;
- nenhuma `dependency-to-release` específica é introduzida nesta fatia.

## Incluído

- Escolha PF/PJ.
- Nome/nome empresarial, telefone, CPF/CNPJ e número de documento.
- Edição de campos permitidos.
- Preferências visuais de baixo risco.
- Status de conta e atalhos reais para recuperação de senha e logout; exportação/exclusão de dados permanece na FEAT-034.

## Fora desta feature

- verificação documental própria
- upload de documento
- dados bancários

## Regras de produto e domínio

- CPF e CNPJ normalizados e validados, com coexistência de CNPJ numérico e alfanumérico conforme a OPEN-009.
- Tipo e tamanho coerentes.
- E-mail alterado via fluxo Auth.
- Documento não aparece em DTO público.
- Dados usados em pagamento são revalidados server-side.
- Uma conta anonimizada não pode ser reativada pela interface.
- PF/PJ pode ser corrigido antes da primeira conclusão e fica imutável depois dela.
- O documento adicional é texto opaco opcional de 3 a 40 caracteres; não representa verificação nem aceita upload.
- A preferência visual inicial é somente `system | light | dark`; cor de marca continua fora do escopo enquanto OPEN-003 estiver aberta.

## Dados canônicos afetados

- profiles
- user_preferences
- terms_acceptances

## Read models

- `public.get_my_profile()` é `security invoker`, não recebe UUID e filtra o titular por `auth.uid()` + RLS; documentos retornam somente mascarados.

## Comandos e integrações

- profile.complete
- profile.update

## UX e estados obrigatórios

- Formulário com máscara apenas visual; CPF canônico usa onze dígitos e CNPJ canônico usa quatorze posições maiúsculas, com letras/números nas doze primeiras e dígitos nas duas finais. Telefone só reconhece DDI quando `+55` é explícito ou quando `55` possui comprimento internacional válido; prefixo estrangeiro/excesso não é truncado e permanece inválido.
- Erros por campo.
- Resumo de privacidade.
- No mobile, o formulário usa uma coluna; no desktop, usa grade de formulário.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- RLS próprio.
- Documento mascarado após salvar.
- Logs sem PII.
- O envelope estrito de `profile.complete`/`profile.update` exige `expectedScope` UUID como asserção do recorte SSR; ele não aceita `userId` como ownership e `session.userId` continua sendo a única autoridade. Divergência retorna `409 SESSION_CHANGED` antes do limiter específico de perfil, serviço e DAL, sem ignorar as proteções globais anteriores da rota.
- CPF/CNPJ e documento adicional nunca retornam em claro no DTO; substituições usam campo novo vazio e ação explícita `manter | substituir | remover` quando aplicável.
- Mutations de perfil usam `networkMode: "always"`: uma submissão offline executa e falha sem entrar na fila pausada. O escopo e o payload existem juntos apenas em uma ref one-shot, limpa em sucesso, erro ou settle.
- As duas superfícies de logout compartilham o mesmo fence: closure sem `variables`, `networkMode: "always"` e `expectedScope` UUID como mera asserção. O servidor executa `getClaims`, que pode renovar ou manter a sessão internamente, e termina a classificação antes de obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw → `503 SERVICE_UNAVAILABLE`; erro/contexto assinado ausente → `401 UNAUTHENTICATED`; UUID válido divergente → `409 SESSION_CHANGED`. Os três ramos têm zero efeitos destrutivos explícitos de logout. O browser fecha o boundary, limpa integralmente o `QueryClient` e recompõe a rota por SSR.
- Depois de publicar a sessão no login, a projeção `get_my_profile()` recebe `AbortSignal` e deadline server-side de um segundo. Timeout/falha projeta `system`; uma resolução posterior ao deadline não escreve cookie nem inicia `signOut`.
- `SESSION_CHANGED` e `UNAUTHENTICATED` são terminais no browser: fecham o boundary/DOM privado, descartam mutations e as famílias `account/profile` + `identity/session` e recompõem a rota por SSR.
- Reseeds autoritativos normais de perfil/sessão limpam `MutationCache` e as duas famílias privadas, preservando cache público; logout e login ambíguo continuam limpando o `QueryClient` integralmente.
- Respostas concorrentes só entram no cache se `profileVersion` e `preferencesVersion` não regredirem. A publicação autoritativa mantém o observer da query atual; um callback tardio de A, depois de reseed B, não pode recriar a key removida nem publicar PII de A.

## Critérios de aceitação

- Perfil completo libera checkout.
- PF e PJ validam.
- Usuário não lê perfil alheio.
- Edição não altera fatos históricos.
- Documento é mascarado.

## Playwright obrigatório

| ID              | Prioridade | Suíte         | Viewport            | Cenário                                                   | Spec                                                       |
| --------------- | ---------- | ------------- | ------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| SL-F003-E2E-001 | P0         | critical      | desktop             | completar perfil PF válido                                | `tests/e2e/critical/feat-003-profile-account.spec.ts`      |
| SL-F003-E2E-002 | P0         | critical      | desktop             | completar perfil PJ válido                                | `tests/e2e/critical/feat-003-profile-account.spec.ts`      |
| SL-F003-E2E-003 | P1         | regression    | mobile              | telefone/CPF/CNPJ inválido mostra erro local              | `tests/e2e/regression/feat-003-profile-account.spec.ts`    |
| SL-F003-E2E-004 | P0         | critical      | desktop             | A→B no mesmo page/QueryClient fecha A antes de publicar B | `tests/e2e/critical/feat-003-profile-account.spec.ts`      |
| SL-F003-E2E-005 | P1         | regression    | desktop             | documento salvo aparece mascarado                         | `tests/e2e/regression/feat-003-profile-account.spec.ts`    |
| SL-F003-E2E-006 | P1         | accessibility | claro/escuro/mobile | axe e teclado na conta                                    | `tests/e2e/accessibility/feat-003-profile-account.spec.ts` |
| SL-F003-E2E-007 | P1         | reflow        | zoom 200%           | conta opera sem overflow a 160x360                        | `tests/e2e/reflow/feat-003-profile-account.spec.ts`        |
| SL-F003-E2E-008 | P1         | regression    | desktop             | tema persiste antes da hidratação                         | `tests/e2e/regression/feat-003-profile-account.spec.ts`    |
| SL-F003-E2E-009 | P1         | regression    | desktop/mobile      | nome, telefone e máscaras somem em fetching/paused        | `tests/e2e/regression/feat-003-profile-account.spec.ts`    |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace, screenshot e vídeo ficam `off` nas specs da feature para que senha, CPF, CNPJ e documento adicional não entrem em artefatos;
- e-mails QA sintéticos podem aparecer somente nos títulos automáticos allowlisted dos steps; stdout/stderr, erros, attachments e logs da aplicação permanecem sem e-mail;
- CPF, CNPJ e documento adicional usam staging `formdata` one-shot em campos allowlisted, nunca `fill`, `type` ou `keyboard`;
- dados com namespace QA.

Sem criar IDs ou alterar contagens, o snapshot integral publicado anterior ampliou as provas dos cenários `SL-F003-E2E-004` e `SL-F003-E2E-009` para mutations de perfil: respectivamente, submissão antiga de A após a sessão mudar para B e submissão offline sem mutation pausada ou POST tardio após reconexão. A correção P2 local estende os mesmos IDs ao logout. A matriz Playwright/axe corrente passou em 91/91 numa única execução de 3,9 minutos, incluindo 32/32 da FEAT-003. O ID 004 passou em 3/3 projeções com `409` para a closure stale de A, sessão e perfil de B intactos e zero `pageerror` ou erro React; o ID 009 passou em 4/4 com falha offline imediata, exatamente uma request e nenhum POST tardio após reconexão. Não houve resultado inesperado, flake, skip, erro ou attachment. Sentinelas, tokens, cookies Auth e documentos crus tiveram zero ocorrência; os 62 e-mails QA únicos ficaram em 114 títulos allowlisted (`Fill` 84, `Visible` 18, `Count` 4 e `Type` 8), e o cleanup de banco, Mailpit, portas e processos terminou sem resíduos.

## Testes unitários, integração e banco

- unitário: CPF, CNPJ numérico, CNPJ alfanumérico e normalização de telefone
- banco: checks, RLS A/B e personas adversariais owner/admin sem bypass ou autoridade antecipada
- unitário: DTO redaction

O snapshot integral publicado anterior passou em 563/563 testes unitários distribuídos por 59 arquivos, 293/293 asserts pgTAP, 91/91 execuções Playwright/axe e builds/smokes standalone, sem alterar os nove IDs ou as 32 execuções da FEAT-003. O commit funcional `f4f3b1d13238bdb67a2bc77bff55c119132040dc` gerou a release local canônica histórica de 2.809 artefatos, SHA-256 `571a0dbdee91d17c47158e0b00aaa0c6bcd4ce6d2f4ffa7f06f1fb6afc4ff887`. Depois, o PR foi marcado ready no HEAD `9531815`; a revisão Codex das `03:45Z` abriu dois P2 sobre logout e deadline da projeção. As correções foram congeladas localmente no commit `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7` depois de passarem em 37/37 no timeout, 96/96 no auditor combinado, 65/65 na rodada pós-ajuste de logout e 578/578 na suíte unitária integral de 60 arquivos. Reset, geração e banco passaram em 293/293 asserts pgTAP, distribuídos em 158 + 78 + 57, com head `20260811000500` e zero resíduo; a matriz Playwright/axe corrente passou em 91/91 em 3,9 minutos, com 32/32 da FEAT-003 e a auditoria/cleanup descritos acima. Lint, typecheck, audit com zero vulnerabilidade e Knip também passaram. Os builds Next.js 16.3 de web/backoffice ficaram verdes sem warnings, com manifests standalone, 17 arquivos obrigatórios e `BUILD_ID` local em cada app; os smokes aprovaram live/ready/root, CSP, `no-store`, assets, nonces e probes adversariais, inclusive `/entrar` 200 no web e 404 no backoffice. Lockfile/gerados permaneceram inalterados, portas/processos ficaram limpos e os logs têm hashes `2e3b…4310` e `c9e5…da97`. A release local canônica foi gerada como `set-livre-e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7.tar.gz`, com 24.757.341 bytes, SHA-256 `6edb2e246e0b3f46cf83f62ce8685e14b91cb31ac1437931f476fc649621273a` e 2.809 artefatos: web 1.519, backoffice 1.276, migrations 12, lockfile 1 e manifesto 1. O manifesto tem 667.285 bytes e SHA-256 `733dac5409c04d8fd1c39fcd2b867d0f812a75b4792479ead416ecf9f11f0135`; ambos os `BUILD_ID` equivalem ao commit, em Linux x64 com Node 24.18/npm 11.19. A auditoria integral de tar, staging e manifesto terminou `NO-BLOCKER`, sem segredo de runtime nem dado PII/QA e sem resíduo. Publicação/push, respostas e resolução dos dois P2, nova revisão e merge continuam pendentes. O [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4) permanece `OPEN` e o status continua `Em implementação`.

## Documentação viva afetada

- security-privacy.md
- database.md
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
