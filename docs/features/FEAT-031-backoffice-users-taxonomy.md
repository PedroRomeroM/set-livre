# FEAT-031 — Usuários, papéis e taxonomias no backoffice

## Metadados

| Campo            | Valor                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Status           | Em andamento                                                                                                                         |
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
- backoffice /acessos/[userId]

## Dependências

- FEAT-003
- FEAT-007

## Incluído

- Busca e status de usuários.
- Suspend/restore.
- Conceder ou revogar papel é exclusivo do admin.
- Desbloqueio local do runtime antes de qualquer mutação.
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
- Nenhum papel ou conjunto completo de usuários é publicado ao browser; acessos são lidos no servidor
  somente para o alvo administrativo selecionado.
- A busca comum aceita somente prefixo de e-mail ou UUID exato; nome bruto permanece exclusivo da
  revelação justificada e auditada.
- Comandos, diretório e taxonomias validam a sessão e a binding antes de consumir o bucket de rede ou
  ler o body privado.
- Renovação ou limpeza de cookie ocorrida nessa autenticação também alcança respostas de erro das
  etapas seguintes.
- GET passivo de sessão não renova a janela de inatividade.
- Atividade e encerramento permanecem monotônicos sob correção regressiva do relógio do host.
- Taxonomia usada é arquivada, não excluída.
- Slug unique.
- Item inativo não aceita nova seleção, mas continua em histórico.
- Arquivar e reativar são ações explícitas; o cliente nunca escolhe diretamente o status final.
- Enquanto uma mutação está em voo, cancelamento e troca de alvo permanecem bloqueados. Depois de uma
  resposta perdida, a tentativa idempotente não pode ser abandonada até replay ou releitura
  autoritativa.

## Dados canônicos afetados

- perfis, papéis, taxonomias e auditoria

## Read models

- lista privada de usuários sem papéis no DTO do browser
- detalhe server-only de acessos de um usuário
- catálogo privado de taxonomias

## Comandos e integrações

- backoffice.user.suspend/restore/revealPii
- backoffice.access.grantSupport/revokeSupport/grantAdmin/revokeAdmin
- backoffice.taxonomy.upsert/archive/reactivate

## UX e estados obrigatórios

- Dados pessoais mascarados.
- Impact preview.
- Confirmação forte.
- Chave local efêmera do runtime em cookie HttpOnly vinculado à sessão Auth.
- Filters/cursor.
- Ações interativas renderizadas pelo servidor permanecem desabilitadas até a hidratação, sem aceitar
  cliques que ainda não possuem handler no cliente.
- Login, chave local, busca de usuários e gestão de taxonomias permanecem inertes e nativamente
  desabilitados até a hidratação. A fronteira não apaga valores digitados durante a transição SSR →
  cliente, não oferece fallback HTML para segredos e não aceita uma ação sem handler ativo.
- Resposta ambígua de criação ou edição mantém campos/cancelamento bloqueados, mas conserva habilitado
  o replay da mesma `idempotencyKey` até obter o resultado autoritativo.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- O papel é validado no servidor.
- Requisições sem sessão não consomem a capacidade compartilhada das superfícies privadas.
- Papéis ficam no Server Component e nunca entram no DTO de sessão ou usuário do browser.
- Toda mutação falha fechada com `423/RUNTIME_LOCKED` sem desbloqueio local válido.
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

| ID              | Prioridade | Suíte         | Viewport       | Cenário                                                             | Spec                                                                 |
| --------------- | ---------- | ------------- | -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| SL-F031-E2E-001 | P0         | critical      | desktop        | support suspende/restaura usuário e comandos bloqueiam              | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`      |
| SL-F031-E2E-002 | P0         | critical      | desktop        | somente admin gerencia roles                                        | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`      |
| SL-F031-E2E-003 | P0         | critical      | desktop        | não remover último admin                                            | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`      |
| SL-F031-E2E-004 | P0         | critical      | desktop        | replay de arquivamento preserva histórico e bloqueia novas seleções | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`      |
| SL-F031-E2E-005 | P1         | regression    | desktop        | dados pessoais ficam mascarados até revelação autorizada e auditada | `tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts`    |
| SL-F031-E2E-006 | P1         | regression    | desktop        | cursor e busca de usuários são processados no servidor              | `tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts`    |
| SL-F031-E2E-007 | P1         | accessibility | desktop/mobile | backoffice passa axe, teclado, toque e 320 px sem revelar PII       | `tests/e2e/accessibility/feat-031-backoffice-users-taxonomy.spec.ts` |
| SL-F031-E2E-008 | P1         | regression    | desktop        | mudança de papel encerra a composição privada anterior              | `tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts`    |
| SL-F031-E2E-009 | P1         | regression    | desktop        | conflitos de conta e papel exigem nova revisão                      | `tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts`    |
| SL-F031-E2E-010 | P1         | regression    | desktop        | conflito de taxonomia descarta o editor obsoleto                    | `tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts`    |
| SL-F031-E2E-011 | P0         | critical      | desktop        | runtime bloqueado rejeita mutação até desbloqueio local             | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`      |
| SL-F031-E2E-012 | P1         | regression    | desktop        | resposta de PII concluída em aba oculta é descartada                | `tests/e2e/regression/feat-031-backoffice-users-taxonomy.spec.ts`    |
| SL-F031-E2E-013 | P0         | critical      | desktop        | resposta perdida preserva replay idempotente e bloqueia abandono    | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`      |
| SL-F031-E2E-014 | P0         | critical      | desktop        | resposta perdida de acesso exige replay da mesma transição          | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`      |
| SL-F031-E2E-015 | P0         | critical      | desktop        | ações SSR privadas sem hidratação ficam fechadas com recuperação    | `tests/e2e/critical/feat-031-backoffice-users-taxonomy.spec.ts`      |

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
