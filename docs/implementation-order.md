# Ordem de implementação

## Princípio

A implementação deve avançar por fatias verticais completas. Não construir todas as tabelas, depois todas as APIs e só então a UI.

## Fase 0 — Governança e fundação

1. aplicar `AGENTS.md`;
2. configurar npm workspaces;
3. criar aplicação pública e backoffice vazio;
4. configurar TypeScript strict, lint, format, Vitest, Playwright, axe e Knip;
5. configurar Supabase local;
6. configurar docs check;
7. configurar CI sem deploy;
8. criar primeiro registro de mudança.

Gate: `npm ci`, lint, typecheck, unit, build e smoke local.

## Fase 1 — Identidade e primeiro corte vertical

1. FEAT-002 autenticação;
2. FEAT-003 perfil;
3. FEAT-005 portfólio do dono;
4. FEAT-006 estúdio rascunho;
5. FEAT-009 revisão/publicação;
6. FEAT-010 listagem pública;
7. FEAT-011 detalhe público.

Gate: um dono cria, envia, admin aprova e visitante visualiza com isolamento comprovado.

## Fase 2 — Calendário e preço

1. FEAT-012 horário semanal;
2. FEAT-013 exceções/buffer/duração;
3. FEAT-014 calendário avançado;
4. FEAT-015 iCal;
5. FEAT-016 precificação;
6. FEAT-017 adicionais;
7. FEAT-018 configuração/cotação.

Gate: disponibilidade e preço são reproduzíveis no banco e testados em virada de dia/fuso.

## Fase 3 — Reserva e pagamento

1. FEAT-019 retorno pós-login;
2. FEAT-020 hold/concorrência;
3. FEAT-021 cartão;
4. FEAT-022 PIX;
5. FEAT-023 webhooks/reconciliação;
6. FEAT-024 ciclo da reserva;
7. FEAT-025 cancelamento/reembolso;
8. FEAT-026 split/repasse.

Gate: duas tentativas concorrentes produzem no máximo uma reserva; pagamento duplicado é idempotente.

## Fase 4 — Áreas operacionais

1. FEAT-027 área do locatário;
2. FEAT-028 área do dono;
3. FEAT-029 e-mails;
4. FEAT-030 revisão admin;
5. FEAT-031 usuários/taxonomias;
6. FEAT-032 pagamentos/fiscal;
7. FEAT-033 operação/auditoria;
8. FEAT-034 privacidade/LGPD.

## Fase 5 — Produção

1. infraestrutura Oracle;
2. Nginx e TLS;
3. systemd;
4. release por SHA;
5. migrations automatizadas;
6. backups e restore;
7. logs, métricas, alertas;
8. teste de carga dos caminhos críticos;
9. smoke HTTPS;
10. ensaio de rollback.

## Regra de paralelismo

Equipes podem paralelizar apenas quando não alteram a mesma fonte canônica ou contrato. Calendário, hold, pagamento e reserva devem ter um responsável técnico integrador.
