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

O hardening P0 local ampliou, sem criar IDs ou alterar contagens, as provas dos cenários `SL-F003-E2E-004` e `SL-F003-E2E-009`: respectivamente, submissão antiga de A após a sessão mudar para B e submissão offline sem mutation pausada ou POST tardio após reconexão. A matriz corrente passou em 91/91 execuções Playwright/axe, incluindo 32/32 da FEAT-003 nos IDs `SL-F003-E2E-001` a `009`. O ID 004 passou nas três projeções com marcador `pagehide=clear`, zero `pageerror`, zero erro React no console e B inalterado; o ID 009 passou nas quatro projeções. A auditoria terminou sem erros finais, attachments, segredos ou resíduos e restringiu os 62 e-mails QA únicos às 102 ocorrências em títulos automáticos allowlisted: `Fill` 84, `Visible` 10 e `Type` 8.

## Testes unitários, integração e banco

- unitário: CPF, CNPJ numérico, CNPJ alfanumérico e normalização de telefone
- banco: checks, RLS A/B e personas adversariais owner/admin sem bypass ou autoridade antecipada
- unitário: DTO redaction

Evidência corrente do hardening P0 local: 563/563 testes unitários distribuídos por 59 arquivos, 293/293 asserts pgTAP e 91/91 execuções Playwright/axe passaram, sem alterar os nove IDs ou as 32 execuções da FEAT-003. Os 57 asserts do perfil incluem personas adversariais owner/admin ainda sob `authenticated`, sem bypass de RLS/ACL; os marcadores de fixture não antecipam as autoridades canônicas das FEAT-004/031. Os novos builds e smokes standalone também passaram sem warnings. O snapshot funcional foi congelado no commit local `f4f3b1d13238bdb67a2bc77bff55c119132040dc`, que gerou a release local canônica com 2.809 artefatos; o archive `set-livre-f4f3b1d13238bdb67a2bc77bff55c119132040dc.tar.gz` possui SHA-256 `571a0dbdee91d17c47158e0b00aaa0c6bcd4ce6d2f4ffa7f06f1fb6afc4ff887`. Push, resolução das threads e novo review deste snapshot ainda estão pendentes. O draft [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4) permanece aberto e o status continua `Em implementação` até review e merge.

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
