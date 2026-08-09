# FEAT-004 — Ativação de dono e onboarding de recebedor

## Metadados

| Campo | Valor |
|---|---|
| Status | Planejada |
| Prioridade | P0 |
| Domínio | `owners-payments` |
| Specs Playwright | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts`<br>`tests/e2e/regression/feat-004-owner-onboarding-recipient.spec.ts` |

## Objetivo

Permitir que um usuário atue como dono e conclua o cadastro exigido pelo gateway para receber 80% das reservas.

## Papéis

- usuário autenticado
- dono

## Rotas e superfícies

- /dono/inicio
- /dono/recebimentos

## Dependências

- FEAT-003
- FEAT-034
- PaymentProvider

## Incluído

- Aceite do contrato do dono.
- Criação do perfil de dono.
- Coleta ou encaminhamento dos dados exigidos pelo provider.
- Status e requisitos pendentes.
- Atualização de status e retentativa.
- Bloqueio de reservas quando o recebedor não está apto.

## Fora desta feature

- KYC próprio
- armazenar credenciais bancárias completas
- escolher múltiplos gateways

## Regras de produto e domínio

- A ativação como dono não concede papel administrativo.
- O identificador do recebedor permanece privado.
- O status externo é mapeado para o contrato interno.
- Estúdio pode ser editado antes da ativação, mas não reservar.
- Fallback financeiro precisa de liberação de admin e auditoria.

## Dados canônicos afetados

- owner_profiles
- owner_payment_recipients
- terms_acceptances
- audit.events

## Read models

- get_owner_recipient_status

## Comandos e integrações

- owner.activate
- recipient.onboarding.start
- recipient.onboarding.refresh
- recipient.bank.update

## UX e estados obrigatórios

- Checklist com status factual.
- Os erros do provider são traduzidos para mensagens seguras.
- Sem mostrar payload/KYC desnecessário.
- CTA depende do requisito pendente.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- O provider é chamado somente no servidor.
- Dados sensíveis minimizados.
- Limite de taxa.
- Webhook/consulta valida status.

## Critérios de aceitação

- Usuário vira dono após aceite.
- Os estados pendente, ativo e recusado do recebedor são apresentados corretamente.
- Um recebedor inativo impede o checkout.
- Outro usuário não lê status.
- A retentativa é idempotente.

## Playwright obrigatório

| ID | Prioridade | Suíte | Viewport | Cenário | Spec |
|---|---|---|---|---|---|
| SL-F004-E2E-001 | P0 | critical | desktop | ativar perfil de dono com aceite | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts` |
| SL-F004-E2E-002 | P0 | critical | desktop | iniciar onboarding sandbox e exibir pendência | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts` |
| SL-F004-E2E-003 | P0 | critical | desktop | recebedor ativo libera elegibilidade de reserva | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts` |
| SL-F004-E2E-004 | P1 | regression | mobile | erro do provider apresenta recuperação acionável | `tests/e2e/regression/feat-004-owner-onboarding-recipient.spec.ts` |
| SL-F004-E2E-005 | P0 | critical | desktop | usuário não lê recebedor alheio | `tests/e2e/critical/feat-004-owner-onboarding-recipient.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: provider status mapping
- integração: fake provider contract
- DB/RLS owner recipient
- auditoria do fallback

## Documentação viva afetada

- payments.md
- security-privacy.md
- open-decisions.md
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
