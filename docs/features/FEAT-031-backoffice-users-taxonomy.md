# FEAT-031 — Usuários, papéis e taxonomias no backoffice

## Metadados

| Campo            | Valor                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Status           | Planejada                                                                                                                            |
| Prioridade       | P0                                                                                                                                   |
| Domínio          | `backoffice`                                                                                                                         |
| Specs Playwright | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`<br>`tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts` |

## Objetivo

Administrar contas, acessos e filtros públicos com least privilege e histórico.

## Papéis

- support
- admin

## Rotas e superfícies

- backoffice /usuarios
- backoffice /taxonomias
- backoffice /acessos

## Dependências

- FEAT-003
- FEAT-007

## Incluído

- Busca e status de usuários.
- Suspend/restore.
- Conceder ou revogar papel é exclusivo do admin.
- CRUD e arquivamento de tipos, tags e comodidades.
- Pré-visualização do impacto de uso.
- Auditoria obrigatória.

## Fora desta feature

- impersonation
- exclusão física de usuário com histórico
- tags criadas pelo dono

## Regras de produto e domínio

- Suspension blocks commands/sessions product.
- Mudanças de papel exigem admin e reautenticação.
- Taxonomia usada é arquivada, não excluída.
- Slug unique.
- Item inativo não aceita nova seleção, mas continua em histórico.

## Dados canônicos afetados

- perfis, papéis, taxonomias e auditoria

## Read models

- leituras privadas de usuários e taxonomias

## Comandos e integrações

- admin.user.suspend/restore
- admin.role.grant/revoke
- admin.taxonomy.*

## UX e estados obrigatórios

- Dados pessoais mascarados.
- Impact preview.
- Confirmação forte.
- Filters/cursor.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- O papel é validado no servidor.
- O último admin não pode ser removido sem salvaguarda.
- Auditoria obrigatória.
- RLS e leituras privadas.

## Critérios de aceitação

- Suspend blocks.
- Restore.
- Papéis seguem menor privilégio.
- Taxonomia ativa ou inativa.
- O histórico permanece estável.
- Acesso não autorizado é rejeitado.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                                                 | Spec                                                              |
| --------------- | ---------- | ---------- | -------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| SL-F031-E2E-001 | P0         | critical   | desktop  | support suspende/restaura usuário e comandos bloqueiam                  | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`   |
| SL-F031-E2E-002 | P0         | critical   | desktop  | somente admin gerencia roles                                            | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`   |
| SL-F031-E2E-003 | P0         | critical   | desktop  | não remover último admin                                                | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`   |
| SL-F031-E2E-004 | P0         | critical   | desktop  | arquivar taxonomia remove novas seleções e preserva o histórico público | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`   |
| SL-F031-E2E-005 | P1         | regression | desktop  | dados pessoais ficam mascarados até revelação autorizada e auditada     | `tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts` |
| SL-F031-E2E-006 | P1         | regression | desktop  | cursor e busca de usuários são processados no servidor                  | `tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: role constraints/last admin guard
- uso e arquivamento de taxonomia
- auditoria e segurança

## Documentação viva afetada

- backoffice.md
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
