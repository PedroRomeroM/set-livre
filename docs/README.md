# Índice da documentação

## Finalidade

Este diretório contém a documentação canônica e viva da **plataforma completa Set Livre**. O conjunto foi dividido para que produto, arquitetura, banco, infraestrutura, UX, QA e operação possam evoluir sem concentrar decisões incompatíveis em um único arquivo.

Esta documentação não descreve o mini fórum.

## Cadeia de autoridade

1. `reference/architecture-blueprint.md`;
2. ADRs aceitos em `adr/`;
3. `specification.md`;
4. documentos vivos especializados deste diretório;
5. documentos de feature em `features/`;
6. migrations, contratos e testes;
7. código.

A forma de resolver divergências está em `00-source-of-truth.md` e `../AGENTS.md`.

## Leitura por responsabilidade

| Necessidade | Documento principal | Complementos |
|---|---|---|
| Entender produto e escopo | `specification.md` | `context.md`, `roadmap.md`, `requirements-traceability.md` |
| Entender arquitetura | `architecture.md` | `reference/architecture-blueprint.md`, `adr/` |
| Implementar banco | `database.md` | `domain-model.md`, `migration-plan.md`, `api-contracts.md` |
| Implementar leituras/cache | `query-cache-invalidation.md` | `api-contracts.md`, ADR-003 |
| Implementar comandos | `api-contracts.md` | ADR-004, ADR-005, `security-privacy.md` |
| Implementar calendário/reserva | `calendar-reservations.md` | FEAT-012 a FEAT-025 |
| Implementar pagamentos | `payments.md` | FEAT-004, FEAT-020 a FEAT-026, FEAT-032 |
| Implementar mídia | `media.md` | FEAT-008, ADR-010 |
| Implementar UX | `ux-blueprint.md` | `design-system.md`, `accessibility.md` |
| Implementar backoffice | `backoffice.md` | FEAT-030 a FEAT-033 |
| Implantar e operar | `infrastructure.md` | `release-runbook.md`, `backup-restore.md`, `runbooks/` |
| Executar QA | `qa-test-plan.md` | `qa-traceability.md`, `feature-catalog.md` |
| Ver ordem de implementação | `implementation-order.md` | `CODEX_HANDOFF.md` na raiz |
| Registrar mudança | `changes/README.md` | `templates/change.md` |
| Registrar decisão | `templates/adr.md` | `00-source-of-truth.md` |
| Registrar dívida | `technical-debt.md` | `templates/technical-debt.md` |

## Inventário da baseline 1.1

- **34** documentos de feature;
- **16** ADRs iniciais;
- **193** cenários Playwright catalogados;
- especificação canônica, modelo de domínio, banco, APIs, segurança, UX, design, infraestrutura, observabilidade, QA e runbooks;
- fonte arquitetural anexada preservada integralmente em `reference/architecture-blueprint.md`.

## Regra de formato

Todos os documentos deste pacote permanecem em Markdown. Não versionar PDF, DOCX, exportações renderizadas ou arquivos binários como fonte de verdade.

## Regra de manutenção

Toda mudança em código, banco, infraestrutura, configuração, CI ou comportamento precisa atualizar os `.md` afetados no mesmo PR. Todo PR cria um registro em `changes/`.
