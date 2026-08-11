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
- Comando não aceita status/userId e `profile.update` significa exclusivamente o titular autenticado da própria linha.
- CPF/CNPJ e documento adicional nunca retornam em claro no DTO; substituições usam campo novo vazio e ação explícita `manter | substituir | remover` quando aplicável.
- respostas concorrentes só entram no cache se `profileVersion` e `preferencesVersion` não regredirem; divergência de escopo descarta mutations/queries privadas antes da recomposição SSR.

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

## Testes unitários, integração e banco

- unitário: CPF, CNPJ numérico, CNPJ alfanumérico e normalização de telefone
- banco: checks e RLS A/B
- unitário: DTO redaction

Evidência corrente: 538/538 testes unitários, 284/284 asserts pgTAP e 91/91 execuções Playwright/axe integrais passaram. As 32 execuções próprias da FEAT-003 cobrem os nove IDs nos projetos previstos. Builds e smokes standalone dos dois apps também passaram; o status permanece `Em implementação` até auditoria do snapshot, release por SHA, review e merge.

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
