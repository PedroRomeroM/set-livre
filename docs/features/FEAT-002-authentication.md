# FEAT-002 — Cadastro, confirmação, login, logout e recuperação

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `identity` |
| Specs Playwright | `tests/e2e/critical/feat-002-authentication.spec.ts`<br>`tests/e2e/regression/feat-002-authentication.spec.ts` |

## Objetivo

Permitir autenticação segura por e-mail/senha e criar uma sessão server-side confiável sem revelar existência de contas.

## Papéis

- visitante
- usuário autenticado

## Rotas e superfícies

- /cadastro
- /entrar
- /recuperar-senha
- /auth/callback

## Dependências

- Supabase Auth
- FEAT-034 termos
- mail templates

## Incluído

- Cadastro PF/PJ inicia Auth e exige aceite vigente.
- Confirmação de e-mail.
- Login e logout.
- Recuperação e definição de nova senha.
- Redirecionamento allowlisted.
- Mensagens em PT-BR para erros conhecidos.

## Fora desta feature

- login social
- magic link como fluxo principal
- MFA do usuário comum

## Regras de produto e domínio

- A senha segue a regra real do provider.
- Cadastro não considera perfil concluído até FEAT-003.
- Recuperação retorna resposta genérica.
- Logout invalida caches privados.
- Token inválido/expirado não mostra formulário funcional.
- Uma conta suspensa pode autenticar no provider, mas não acessa o produto.

## Dados canônicos afetados

- auth.users
- terms_versions/acceptances
- profiles parcialmente criado conforme comando

## Read models

- sessão server-side
- termos vigentes

## Comandos e integrações

- profile.complete após Auth
- métodos Supabase Auth

## UX e estados obrigatórios

- Formulários preservam e-mail em erro seguro.
- PasswordInput com mostrar/ocultar e requisitos.
- O callback apresenta carregamento e falha recuperável.
- ReturnTo não permite URL externa.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Cookies Secure/SameSite.
- Sem enumeração de e-mail.
- Limite de taxa e proteção antiabuso.
- Sessão sempre validada no servidor para comando.

## Critérios de aceitação

- Usuário cria conta e confirma.
- Login cria sessão SSR.
- Logout remove acesso e cache.
- Reset funciona com token válido e falha seguro com inválido.
- Open redirect impossível.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F002-E2E-001 | P0 | critical | desktop | cadastro completo envia confirmação e aceita termos | `tests/e2e/critical/feat-002-authentication.spec.ts` |
| SL-F002-E2E-002 | P0 | critical | desktop | login/logout controla rota autenticada | `tests/e2e/critical/feat-002-authentication.spec.ts` |
| SL-F002-E2E-003 | P0 | critical | mobile | recuperação e nova senha funcionam | `tests/e2e/critical/feat-002-authentication.spec.ts` |
| SL-F002-E2E-004 | P1 | regression | desktop | e-mail inexistente recebe resposta genérica | `tests/e2e/regression/feat-002-authentication.spec.ts` |
| SL-F002-E2E-005 | P0 | critical | desktop | returnTo externo é rejeitado | `tests/e2e/critical/feat-002-authentication.spec.ts` |
| SL-F002-E2E-006 | P1 | regression | mobile | axe e teclado nos formulários | `tests/e2e/regression/feat-002-authentication.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: allowlist de `returnTo` e tradução de erros
- banco/RLS: aceite pertence ao usuário
- segurança: cookies/headers

## Documentação viva afetada

- security-privacy.md
- ux-blueprint.md
- notifications.md
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
