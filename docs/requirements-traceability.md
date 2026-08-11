# Rastreabilidade de requisitos, decisões e features

## 1. Objetivo

Este documento comprova onde cada requisito central foi transformado em decisão arquitetural, especificação, feature e teste. Ele não substitui os documentos apontados.

## 2. Mudanças arquiteturais solicitadas

| ID       | Requisito                                              | Decisão/documento                                         | Evidência de implementação           |
| -------- | ------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------ |
| ARCH-001 | Blueprint → ADRs → especificação → docs vivas → código | `00-source-of-truth.md`, ADR-001, `AGENTS.md`             | `docs:check` e revisão de PR         |
| ARCH-002 | npm em vez de pnpm                                     | `repository-rules.md`, `tooling.md`, ADR-002              | `package-lock.json`, `npm ci`        |
| ARCH-003 | CSS Modules, CSS variables e primitives próprias       | ADR-013, `design-system.md`                               | lint/visual/Playwright               |
| ARCH-004 | TanStack Query com query keys, cursores e invalidação  | ADR-003, `query-cache-invalidation.md`                    | unitários e testes de UI             |
| ARCH-005 | `POST /api/commands` central para escritas críticas    | ADR-004, `api-contracts.md`                               | testes de comando/segurança          |
| ARCH-006 | DAL `server-only` com role restrita                    | ADR-005, `architecture.md`, `security-privacy.md`         | grants manifest e testes             |
| ARCH-007 | migrations append-only, grants mínimos e RLS           | ADR-005, `database.md`, `migration-plan.md`               | reset, schema guard, RLS A/B         |
| ARCH-008 | read models pequenos, tipados e filtrados              | ADR-003, `api-contracts.md`, `database.md`                | testes de DTO/ownership              |
| ARCH-009 | paginação keyset                                       | ADR-012, `api-contracts.md`                               | cursor estável/sem duplicação        |
| ARCH-010 | índices somente estruturais ou provados por EXPLAIN    | ADR-012, `database.md`                                    | evidência em `docs/changes/`         |
| ARCH-011 | status `text` com `check`                              | ADR-011, `domain-model.md`, `database.md`                 | schema guard e transições            |
| ARCH-012 | backoffice separado                                    | ADR-002, `backoffice.md`                                  | smoke que prova ausência de `/admin` |
| ARCH-013 | standalone, systemd, Nginx e release por SHA           | ADR-014, `infrastructure.md`, `release-runbook.md`        | smoke/rollback de release            |
| ARCH-014 | mobile 320 px, safe areas e toque 44 px                | `design-system.md`, `ux-blueprint.md`, `accessibility.md` | matriz Playwright responsiva         |
| ARCH-015 | WCAG 2.2 AA, teclado, foco, zoom 200% e axe            | `accessibility.md`, `qa-test-plan.md`                     | axe e testes manuais catalogados     |
| ARCH-016 | QA com IDs, prioridade, suíte e rastreabilidade        | ADR-015, `qa-traceability.md`                             | `docs:check` e specs Playwright      |
| ARCH-017 | dívida técnica com impacto/evidência/responsável/saída | `technical-debt.md`, template                             | gate de PR                           |
| ARCH-018 | documentação dividida por responsabilidade             | ADR-015, `docs/README.md`                                 | atualização no mesmo PR              |

## 3. Produto público e identidade

| ID      | Requisito                                                                            | Feature(s)                   | Documento(s)                          | Cenários                               |
| ------- | ------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------- | -------------------------------------- |
| PRD-001 | Lançamento em Curitiba/PR, PT-BR, BRL e fuso único                                   | transversal                  | `specification.md`, `domain-model.md` | features de data/preço                 |
| PRD-002 | Home separada da listagem e sem cards                                                | FEAT-001                     | `ux-blueprint.md`                     | SL-F001-E2E-001                        |
| PRD-003 | Filtros iniciais sem busca textual                                                   | FEAT-001, FEAT-010           | `specification.md`                    | SL-F001-E2E-002, SL-F010-E2E-002       |
| PRD-004 | Listagem por bairro, data, preço, tipo, capacidade, tags/comodidades                 | FEAT-010                     | `api-contracts.md`, `ux-blueprint.md` | SL-F010-E2E-001 a 006                  |
| PRD-005 | Ordenação apenas por preço                                                           | FEAT-010                     | `specification.md`                    | SL-F010-E2E-001                        |
| PRD-006 | Card com foto, nome, bairro, preço, capacidade, tipo, destaques e disponibilidade    | FEAT-010                     | `api-contracts.md`                    | SL-F010-E2E-001/002                    |
| PRD-007 | Detalhe com endereço, galeria, YouTube, regras, FAQ, comodidades, preço e calendário | FEAT-011                     | `ux-blueprint.md`                     | SL-F011-E2E-001 a 006                  |
| PRD-008 | Navegação pública sem login                                                          | FEAT-001, FEAT-010, FEAT-011 | `specification.md`                    | smoke público                          |
| PRD-009 | Login obrigatório para pagar e retorno à intenção                                    | FEAT-002, FEAT-019           | `calendar-reservations.md`            | SL-F019-E2E-001 a 005                  |
| PRD-010 | Cadastro PF/PJ com nome, e-mail, telefone, CPF/CNPJ e documento textual              | FEAT-002, FEAT-003           | `database.md`                         | SL-F002/003                            |
| PRD-011 | Termos versionados, exportação e exclusão                                            | FEAT-002, FEAT-034           | `database.md`, `security-privacy.md`  | SL-F002-E2E-001, SL-F034-E2E-001 a 006 |

## 4. Dono, estúdio e conteúdo

| ID      | Requisito                                             | Feature(s)                   | Documento(s)                     | Cenários                         |
| ------- | ----------------------------------------------------- | ---------------------------- | -------------------------------- | -------------------------------- |
| PRD-012 | Um dono por estúdio e vários estúdios por dono        | FEAT-005, FEAT-006           | `domain-model.md`, `database.md` | SL-F005/006                      |
| PRD-013 | Onboarding do recebedor                               | FEAT-004                     | `payments.md`                    | SL-F004-E2E-001 a 005            |
| PRD-014 | Cadastro completo do estúdio                          | FEAT-006, FEAT-007           | `specification.md`               | SL-F006/007                      |
| PRD-015 | Fotos de alta qualidade, capa, ordem e aprovação      | FEAT-008, FEAT-030           | `media.md`                       | SL-F008, SL-F030                 |
| PRD-016 | Vídeo por YouTube, sem upload                         | FEAT-007, FEAT-011           | `media.md`                       | SL-F007-E2E-004                  |
| PRD-017 | Rascunho, submissão, aprovação integral e reaprovação | FEAT-006, FEAT-009, FEAT-030 | `domain-model.md`                | SL-F006/009/030                  |
| PRD-018 | Edição não altera versão publicada até aprovação      | FEAT-006, FEAT-030           | `database.md`                    | SL-F006-E2E-002, SL-F030-E2E-002 |
| PRD-019 | Pausar/despublicar sem apagar reservas                | FEAT-009                     | `specification.md`               | SL-F009-E2E-004                  |
| PRD-020 | Taxonomias administráveis                             | FEAT-007, FEAT-031           | `backoffice.md`                  | SL-F031-E2E-004                  |

## 5. Calendário e precificação

| ID      | Requisito                                       | Feature(s)                   | Documento(s)                        | Cenários                 |
| ------- | ----------------------------------------------- | ---------------------------- | ----------------------------------- | ------------------------ |
| PRD-021 | Calendário interno como fonte de verdade        | FEAT-012 a FEAT-015          | ADR-006, `calendar-reservations.md` | SL-F012 a SL-F015        |
| PRD-022 | Blocos de 1h e início em hora cheia             | FEAT-012, FEAT-018           | `calendar-reservations.md`          | SL-F012-E2E-002, SL-F018 |
| PRD-023 | Horário semanal e múltiplas janelas             | FEAT-012                     | `database.md`                       | SL-F012-E2E-001          |
| PRD-024 | Exceções, bloqueios manuais e buffer            | FEAT-013                     | `calendar-reservations.md`          | SL-F013-E2E-001 a 005    |
| PRD-025 | Duração mínima/máxima por estúdio               | FEAT-013, FEAT-018           | `database.md`                       | SL-F018-E2E-002          |
| PRD-026 | Views dia/semana/mês e drag-and-drop seguro     | FEAT-014                     | `ux-blueprint.md`                   | SL-F014                  |
| PRD-027 | Importação/exportação iCal e agenda consolidada | FEAT-015                     | `calendar-reservations.md`          | SL-F015                  |
| PRD-028 | Preço base por hora                             | FEAT-016                     | `domain-model.md`                   | SL-F016                  |
| PRD-029 | Multiplicador por dia e faixa horária           | FEAT-016                     | `calendar-reservations.md`          | SL-F016                  |
| PRD-030 | Adicionais por unidade                          | FEAT-017, FEAT-018           | `database.md`                       | SL-F017/018              |
| PRD-031 | Snapshot de preço imutável                      | FEAT-016, FEAT-018, FEAT-024 | ADR-008                             | SL-F016-E2E-005, SL-F024 |

## 6. Reserva e financeiro

| ID      | Requisito                                                                 | Feature(s)         | Documento(s)                        | Cenários              |
| ------- | ------------------------------------------------------------------------- | ------------------ | ----------------------------------- | --------------------- |
| PRD-032 | Configuração com data, início, duração, pessoas, adicionais e observações | FEAT-018           | `ux-blueprint.md`                   | SL-F018-E2E-001 a 006 |
| PRD-033 | Uma reserva por checkout e blocos consecutivos                            | FEAT-018, FEAT-024 | `specification.md`                  | SL-F018/024           |
| PRD-034 | Cotação autoritativa e expiração                                          | FEAT-018           | `api-contracts.md`                  | SL-F018-E2E-004       |
| PRD-035 | Hold somente após início confirmado pelo gateway                          | FEAT-020           | ADR-007, `calendar-reservations.md` | SL-F020-E2E-001 a 006 |
| PRD-036 | Primeiro pagamento válido vence e não há dupla reserva                    | FEAT-020, FEAT-024 | `database.md`                       | concorrência P0       |
| PRD-037 | Cartão                                                                    | FEAT-021           | `payments.md`                       | SL-F021-E2E-001 a 006 |
| PRD-038 | PIX e expiração                                                           | FEAT-022           | `payments.md`                       | SL-F022-E2E-001 a 006 |
| PRD-039 | Webhooks idempotentes, reconciliação e retentativa                        | FEAT-023           | `payments.md`                       | SL-F023-E2E-001 a 006 |
| PRD-040 | Reserva instantânea após pagamento autoritativo                           | FEAT-024           | `calendar-reservations.md`          | SL-F024-E2E-001       |
| PRD-041 | Cancelamento e reembolso total                                            | FEAT-025           | `payments.md`                       | SL-F025               |
| PRD-042 | Split 80/20 sobre bruto e taxa da plataforma                              | FEAT-026           | ADR-008, `payments.md`              | SL-F026               |
| PRD-043 | Repasse após o uso com fallback manual                                    | FEAT-026, FEAT-032 | `payments.md`                       | SL-F026/032           |
| PRD-044 | Apoio fiscal manual por exportação                                        | FEAT-032           | `payments.md`                       | SL-F032-E2E-004       |

## 7. Operação, qualidade e conformidade

| ID      | Requisito                                       | Feature(s)                   | Documento(s)                          | Cenários          |
| ------- | ----------------------------------------------- | ---------------------------- | ------------------------------------- | ----------------- |
| PRD-045 | Área de reservas do locatário                   | FEAT-027                     | `ux-blueprint.md`                     | SL-F027           |
| PRD-046 | Agenda, reservas, pagamentos e repasses do dono | FEAT-028                     | `ux-blueprint.md`                     | SL-F028           |
| PRD-047 | E-mails transacionais e lembrete                | FEAT-029                     | `notifications.md`                    | SL-F029           |
| PRD-048 | Revisão e moderação em backoffice separado      | FEAT-030                     | `backoffice.md`                       | SL-F030           |
| PRD-049 | Usuários, papéis e taxonomias                   | FEAT-031                     | `backoffice.md`                       | SL-F031           |
| PRD-050 | Financeiro, fiscal e operações                  | FEAT-032, FEAT-033           | `backoffice.md`                       | SL-F032/033       |
| NFR-001 | Alta performance e Core Web Vitals              | transversal                  | `performance-seo.md`                  | performance gates |
| NFR-002 | SEO completo                                    | FEAT-001, FEAT-010, FEAT-011 | `performance-seo.md`                  | SL-F011-E2E-005   |
| NFR-003 | Mobile desde 320 px                             | transversal                  | `ux-blueprint.md`, `design-system.md` | matriz responsiva |
| NFR-004 | WCAG 2.2 AA                                     | transversal                  | `accessibility.md`                    | axe/teclado/zoom  |
| NFR-005 | Alta confiabilidade e rollback                  | transversal                  | `infrastructure.md`, runbooks         | smoke/release     |
| NFR-006 | LGPD                                            | FEAT-034                     | ADR-016, `security-privacy.md`        | SL-F034           |
| NFR-007 | Observabilidade e auditoria                     | FEAT-033                     | `observability.md`                    | SL-F033           |
| NFR-008 | Backup/restore                                  | transversal                  | `backup-restore.md`                   | ensaio de restore |

## 8. Fora de escopo protegido

| ID      | Item proibido nesta baseline         | Referência         |
| ------- | ------------------------------------ | ------------------ |
| OUT-001 | Mini fórum/comunidade                | `specification.md` |
| OUT-002 | App nativo                           | `specification.md` |
| OUT-003 | Chat/WhatsApp                        | `specification.md` |
| OUT-004 | Avaliações e relevância              | `specification.md` |
| OUT-005 | Busca textual e mapa                 | `specification.md` |
| OUT-006 | Assinatura, seguro, cupom e caução   | `specification.md` |
| OUT-007 | Múltiplos gestores por estúdio       | `specification.md` |
| OUT-008 | Carrinho multiestúdio                | `specification.md` |
| OUT-009 | Google Calendar automático           | ADR-006            |
| OUT-010 | Emissão automática de NFS-e          | `payments.md`      |
| OUT-011 | Multi-idioma/multi-fuso/multi-região | `specification.md` |
| OUT-012 | BI e recomendação algorítmica        | `specification.md` |
