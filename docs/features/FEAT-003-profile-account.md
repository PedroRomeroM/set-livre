# FEAT-003 — Perfil PF/PJ, conta e preferências

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `identity` |
| Specs Playwright | `tests/e2e/critical/feat-003-profile-account.spec.ts`<br>`tests/e2e/regression/feat-003-profile-account.spec.ts` |

## Objetivo

Completar e manter os dados necessários de locatário/dono com validação brasileira, sem expor PII.

## Papéis

- usuário autenticado

## Rotas e superfícies

- /conta
- /conta/seguranca

## Dependências

- FEAT-002
- FEAT-034

## Incluído

- Escolha PF/PJ.
- Nome/nome empresarial, telefone, CPF/CNPJ e número de documento.
- Edição de campos permitidos.
- Preferências visuais de baixo risco.
- Status de conta e atalhos para dados.

## Fora desta feature

- verificação documental própria
- upload de documento
- dados bancários

## Regras de produto e domínio

- CPF/CNPJ normalizados e validados.
- Tipo e tamanho coerentes.
- E-mail alterado via fluxo Auth.
- Documento não aparece em DTO público.
- Dados usados em pagamento são revalidados server-side.
- Uma conta anonimizada não pode ser reativada pela interface.

## Dados canônicos afetados

- profiles
- user_preferences
- terms_acceptances

## Read models

- get_my_profile

## Comandos e integrações

- profile.complete
- profile.update

## UX e estados obrigatórios

- Formulário com máscara apenas visual; valor canônico são dígitos.
- Erros por campo.
- Resumo de privacidade.
- No mobile, o formulário usa uma coluna; no desktop, usa grade de formulário.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- RLS próprio.
- Documento mascarado após salvar.
- Logs sem PII.
- Comando não aceita status/userId.

## Critérios de aceitação

- Perfil completo libera checkout.
- PF e PJ validam.
- Usuário não lê perfil alheio.
- Edição não altera fatos históricos.
- Documento é mascarado.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F003-E2E-001 | P0 | critical | desktop | completar perfil PF válido | `tests/e2e/critical/feat-003-profile-account.spec.ts` |
| SL-F003-E2E-002 | P0 | critical | desktop | completar perfil PJ válido | `tests/e2e/critical/feat-003-profile-account.spec.ts` |
| SL-F003-E2E-003 | P1 | regression | mobile | CPF/CNPJ inválido mostra erro local | `tests/e2e/regression/feat-003-profile-account.spec.ts` |
| SL-F003-E2E-004 | P0 | critical | desktop | usuário A não acessa perfil B | `tests/e2e/critical/feat-003-profile-account.spec.ts` |
| SL-F003-E2E-005 | P1 | regression | desktop | documento salvo aparece mascarado | `tests/e2e/regression/feat-003-profile-account.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: CPF/CNPJ/phone normalization
- banco: checks e RLS A/B
- unitário: DTO redaction

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
