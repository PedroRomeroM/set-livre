# FEAT-002 — Cadastro, confirmação, login, logout e recuperação

## Metadados

| Campo            | Valor                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Validada localmente; aguardando review do PR                                                                                                                         |
| Prioridade       | P0                                                                                                                                                                   |
| Domínio          | `identity`                                                                                                                                                           |
| Specs Playwright | `tests/e2e/critical/feat-002-authentication.spec.ts`<br>`tests/e2e/regression/feat-002-authentication.spec.ts`<br>`tests/e2e/reflow/feat-002-authentication.spec.ts` |

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

- `dependency-to-start`: nenhuma feature; a fundação local já incorporada fornece apps, Supabase local e gates;
- capacidade bootstrap deste PR: Supabase Auth local, `legal-core` e templates Auth locais, todos limitados ao primeiro consumidor real;
- `dependency-to-complete`: a FEAT-002 fornece identidade e histórico jurídico para os direitos LGPD completos da FEAT-034; a feature posterior não bloqueia este início;
- `dependency-to-release`: PEND-002 (Supabase Cloud), PEND-003 (Nginx/TLS e borda confiável), PEND-005 (SMTP) e PEND-006 (conteúdo jurídico aprovado).

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
- Se a resposta de logout for perdida ou ambígua, a UI oculta imediatamente os dados privados e recarrega a rota SSR; a tela então informa se a sessão continua ativa ou se a ausência local foi confirmada.
- Token inválido/expirado não mostra formulário funcional.
- O grant adicional de recovery fica persistido no banco, vinculado ao usuário, expira em 15 minutos e é one-shot: uma claim exclusiva precede o provider; somente rejeição explicitamente sem efeito permite release e retry.
- O formulário de nova senha fica bloqueado durante toda revalidação autoritativa; após o consumo, o cache marca o grant como negado e descarta a sessão privada em memória.
- Uma conta suspensa pode autenticar no provider, mas não acessa o produto.

## Dados canônicos afetados

- `auth.users`;
- `profiles` mínimo criado pelo trigger do signup;
- `terms_versions` e `terms_acceptances`;
- `private.signup_legal_intents`, expiráveis e one-shot, e `private.identity_recovery_grants`, persistidos no banco até expiração/consumo; ambos sem leitura do browser.

## Read models

- sessão server-side
- termos vigentes
- status autoritativo do grant da sessão atual de recovery

## Comandos e integrações

- `identity.register` cria uma intenção legal opaca antes do Auth; o trigger cria perfil mínimo e aceites atomicamente
- métodos Supabase Auth para login, logout, callback e recovery
- DAL privado emite, consulta, reserva, libera e consome o grant de recovery

## UX e estados obrigatórios

- Formulários preservam e-mail em erro seguro.
- PasswordInput com mostrar/ocultar e requisitos.
- O callback apresenta carregamento e falha recuperável.
- A verificação inicial e o refetch de recovery apresentam loading sem reutilizar um estado `allowed` em cache.
- Toda request interativa expira em dez segundos e reabilita uma recuperação acionável.
- ReturnTo não permite URL externa.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Cookies Secure/SameSite.
- Cookies de sessão são server-side e `HttpOnly`; `Secure` só é relaxado no HTTP loopback local.
- Sem enumeração de e-mail.
- Limite de taxa e proteção antiabuso.
- Sessão sempre validada no servidor para comando.
- E-mails, senhas e o `TokenHash` de cadastro, login, callback e recovery usam refs one-shot e não são persistidos como `variables` no MutationCache.

## Critérios de aceitação

- Usuário cria conta e confirma.
- Login cria sessão SSR.
- Logout remove acesso e cache.
- Reset funciona com token válido e falha seguro com inválido.
- Open redirect impossível.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport  | Cenário                                              | Spec                                                   |
| --------------- | ---------- | ---------- | --------- | ---------------------------------------------------- | ------------------------------------------------------ |
| SL-F002-E2E-001 | P0         | critical   | desktop   | cadastro completo envia confirmação e aceita termos  | `tests/e2e/critical/feat-002-authentication.spec.ts`   |
| SL-F002-E2E-002 | P0         | critical   | desktop   | login/logout controla rota autenticada               | `tests/e2e/critical/feat-002-authentication.spec.ts`   |
| SL-F002-E2E-003 | P0         | critical   | mobile    | recuperação e nova senha funcionam                   | `tests/e2e/critical/feat-002-authentication.spec.ts`   |
| SL-F002-E2E-004 | P1         | regression | desktop   | e-mail inexistente recebe resposta genérica          | `tests/e2e/regression/feat-002-authentication.spec.ts` |
| SL-F002-E2E-005 | P0         | critical   | desktop   | returnTo externo é rejeitado                         | `tests/e2e/critical/feat-002-authentication.spec.ts`   |
| SL-F002-E2E-006 | P1         | regression | mobile    | axe e teclado nos formulários                        | `tests/e2e/regression/feat-002-authentication.spec.ts` |
| SL-F002-E2E-007 | P1         | reflow     | zoom 200% | autenticação preserva conteúdo e operação em 160x360 | `tests/e2e/reflow/feat-002-authentication.spec.ts`     |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- senha nunca entra no DOM nem em `fill`, `type` ou `keyboard`: o helper valida input, form e nome em allowlist dentro de `Locator.evaluate` e instala um listener `formdata` one-shot que injeta o segredo somente no `FormData`, fora de `ariaSnapshot` e `error-context`;
- trace, vídeo e screenshot ficam desativados nas specs Auth para não persistir token ou senha; helpers convertem falhas sensíveis em mensagens estáticas e a rodada varre sentinela e token nos artefatos;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: contratos Auth, allowlist de `returnTo`, erros públicos, limites, rate limiter, recovery grant, templates e helpers QA;
- banco/RLS: perfil e aceites próprios para usuários A/B, intenção expirada/replay/concorrência, trigger atômico, metadata scrub, grant recovery com claim/release/consume concorrente, grants e readiness;
- segurança: cookies, origem/request host, corpo limitado, callback em fragmento, redaction e cleanup local exato;
- Playwright: os sete IDs possuem specs físicas; as 23 execuções Auth e a matriz integral de 59 casos passaram nos browsers.

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

## Delimitação executável

A resolução OPEN-008 mantém esta fatia restrita ao perfil mínimo e ao `legal-core`. FEAT-003 continua proprietária da conclusão e dos dados pessoais, FEAT-019 do retorno a draft/reserva e FEAT-034 dos direitos LGPD completos e do conteúdo jurídico aprovado. Nesta feature, `/entrar` é também a superfície autenticada usada para provar sessão SSR e logout; `/conta` não é antecipada.
