# FEAT-034 — Documentos legais, consentimento, exportação e exclusão

## Metadados

| Campo            | Valor                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Status           | Planejada                                                                                                                      |
| Prioridade       | P0                                                                                                                             |
| Domínio          | `privacy`                                                                                                                      |
| Specs Playwright | `tests/e2e/critical/feat-034-lgpd-legal-data-rights.spec.ts`<br>`tests/e2e/regression/feat-034-lgpd-legal-data-rights.spec.ts` |

## Objetivo

Cumprir consentimento e direitos de dados com processo interno que preserve obrigações históricas.

## Papéis

- visitante
- usuário
- admin

## Rotas e superfícies

- /termos
- /privacidade
- /cancelamento
- /conta/dados

## Dependências

- FEAT-002
- FEAT-003
- FEAT-004
- FEAT-032

## Incluído

- Páginas legais versionadas.
- Aceites.
- Solicitação de exportação e expiração do download.
- Solicitação, cancelamento e status da exclusão.
- Anonimização.
- Revogação do acesso no Auth.
- Execução administrativa e auditoria.

## Fora desta feature

- conteúdo jurídico inventado
- cascade delete financeiro
- exportação pública de dados

## Regras de produto e domínio

- Os termos vigentes são obrigatórios.
- Uma nova versão material pode exigir novo aceite.
- A exportação é privada e expira em 7 dias.
- A exclusão verifica reservas futuras e pagamentos.
- Fatos históricos são retidos no mínimo necessário.
- Exportação, anonimização, retenção e exclusão abrangem também autoridade de dono, aceite `owner_contract` e referências privadas do recebedor criadas pela FEAT-004.
- Backups expiram conforme a política.
- Uma conta anonimizada não pode entrar.

## Dados canônicos afetados

- terms_versions/acceptances
- solicitações de exclusão
- exports
- audit

## Read models

- documentos legais vigentes
- account data status

## Comandos e integrações

- account.export.request
- account.deletion.request/cancel
- admin.account.deletion.execute

## UX e estados obrigatórios

- Páginas legais em linguagem clara e legível.
- Checkbox not preselected.
- Progress/status.
- Confirmação forte.
- A retenção é explicada.

Além do fluxo nominal, a interface contempla somente os estados que possuem transição real nesta feature, como loading, vazio, erro, conflito, timeout, sucesso e recuperação quando aplicáveis. Não se cria estado artificial para preencher checklist.

## Segurança e privacidade

- Confirmação de identidade.
- Download privado e assinado.
- Minimização de dados pessoais.
- Auditoria obrigatória.
- Backup policy.

## Critérios de aceitação

- Acceptances versioned.
- A exportação é completa, autorizada e expira.
- A exclusão é bloqueada enquanto houver pendência e depois anonimiza.
- O histórico permanece sem identificação pessoal.
- Acesso não autorizado é rejeitado.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport | Cenário                                                                      | Spec                                                           |
| --------------- | ---------- | ---------- | -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SL-F034-E2E-001 | P0         | critical   | desktop  | cadastro registra as versões legais exatas                                   | `tests/e2e/critical/feat-034-lgpd-legal-data-rights.spec.ts`   |
| SL-F034-E2E-002 | P0         | critical   | desktop  | solicitação de exportação gera pacote privado e expirável                    | `tests/e2e/critical/feat-034-lgpd-legal-data-rights.spec.ts`   |
| SL-F034-E2E-003 | P0         | critical   | desktop  | usuário B não baixa a exportação de A                                        | `tests/e2e/critical/feat-034-lgpd-legal-data-rights.spec.ts`   |
| SL-F034-E2E-004 | P0         | critical   | desktop  | exclusão com reserva futura é bloqueada e apresenta ação possível            | `tests/e2e/critical/feat-034-lgpd-legal-data-rights.spec.ts`   |
| SL-F034-E2E-005 | P0         | critical   | desktop  | exclusão elegível anonimiza e revoga acesso preservando histórico financeiro | `tests/e2e/critical/feat-034-lgpd-legal-data-rights.spec.ts`   |
| SL-F034-E2E-006 | P1         | regression | mobile   | páginas legais, consentimento e confirmação são acessíveis                   | `tests/e2e/regression/feat-034-lgpd-legal-data-rights.spec.ts` |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace/screenshot em falha;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: acceptances/export/deletion state
- integração: anonymization cascade
- segurança de URLs assinadas
- documentação de retenção de backup

## Documentação viva afetada

- security-privacy.md
- backup-restore.md
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
