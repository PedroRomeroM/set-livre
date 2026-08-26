# FEAT-019 — Retorno pós-login e restauração de intenção

## Metadados

| Campo            | Valor                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Status           | Planejada                                                                                                            |
| Prioridade       | P0                                                                                                                   |
| Domínio          | `booking-auth`                                                                                                       |
| Specs Playwright | `tests/e2e/critical/feat-019-auth-return-draft.spec.ts`<br>`tests/e2e/regression/feat-019-auth-return-draft.spec.ts` |

## Objetivo

Preservar a configuração do visitante durante autenticação e revalidá-la sem prometer preço ou vaga.

## Papéis

- visitante
- locatário

## Rotas e superfícies

- /reservar/[studioId]
- /entrar
- /cadastro
- /auth/callback

## Dependências

- FEAT-002
- FEAT-018

## Incluído

- BookingDraftV1 em sessionStorage.
- TTL 2h.
- `returnTo` validado por allowlist.
- Restauração após login ou cadastro.
- Revalidação e mensagens de mudança.
- Consumo/cleanup do parâmetro.

## Fora desta feature

- persistir rascunho remoto anônimo
- garantia de slot
- URL externa

## Regras de produto e domínio

- O rascunho não contém preço autoritativo.
- Schema inválido/antigo é descartado com mensagem.
- Slot mudou: manter demais campos e sugerir.
- Após sucesso/expiração, limpar.
- Fechar modal não reabre por query.

## Dados canônicos afetados

- nenhuma tabela canônica; session state

## Read models

- disponibilidade e cotação após restauração

## Comandos e integrações

- `booking.quote.create` após restauração

## UX e estados obrigatórios

- Mensagem de retorno.
- Diff de preço quando mudou.
- Erro não apaga notas.
- Autenticação e retorno funcionam no mobile.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- `returnTo` validado por allowlist.
- Sem PII sensível além da observação na aba; TTL.
- XSS por rascunho armazenado é impedido por schema e escape.

## Critérios de aceitação

- O rascunho é restaurado.
- Externo rejeitado.
- TTL/schema inválido limpa.
- Mudança revalida.
- Sucesso limpa.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                      | Spec                                                      |
| --------------- | ---------- | ---------- | -------- | -------------------------------------------- | --------------------------------------------------------- |
| SL-F019-E2E-001 | P0         | critical   | desktop  | visitante autentica e retorna com o rascunho | `tests/e2e/critical/feat-019-auth-return-draft.spec.ts`   |
| SL-F019-E2E-002 | P0         | critical   | desktop  | returnTo externo não executa                 | `tests/e2e/critical/feat-019-auth-return-draft.spec.ts`   |
| SL-F019-E2E-003 | P1         | regression | desktop  | rascunho expirado ou inválido é descartado   | `tests/e2e/regression/feat-019-auth-return-draft.spec.ts` |
| SL-F019-E2E-004 | P0         | critical   | desktop  | slot/preço alterado é informado e revalidado | `tests/e2e/critical/feat-019-auth-return-draft.spec.ts`   |
| SL-F019-E2E-005 | P1         | regression | mobile   | cadastro e retorno preservam campos          | `tests/e2e/regression/feat-019-auth-return-draft.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: schema do rascunho, TTL e allowlist
- integração: auth callback redirect
- segurança: injection

## Documentação viva afetada

- ux-blueprint.md
- security-privacy.md
- qa-test-plan.md

Enquanto este plano existir, qualquer mudança de escopo atualiza este arquivo e o catálogo QA.

## Definition of Done da feature

- todos os critérios acima comprovados;
- migration/grants/RLS verdes quando aplicável;
- read model/command e invalidação documentados;
- Playwright listado e verde;
- desktop/mobile/teclado/axe verificados;
- logs e métricas necessários;
- rollback/correção definidos;
- nenhuma funcionalidade fora de escopo introduzida.
