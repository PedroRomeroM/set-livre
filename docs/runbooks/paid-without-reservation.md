# Runbook — pagamento pago sem reserva

## Severidade

P0 financeiro.

## Ações

1. bloquear novos efeitos da attempt;
2. verificar hold/allocation e conflito;
3. não criar reserva se período já pertence a outro;
4. iniciar reembolso total idempotente;
5. alertar finance/support;
6. comunicar usuário de forma factual;
7. correlacionar request/webhook/provider;
8. preservar evidências;
9. revisar race/teste.

## Saída

Refund confirmado ou reserva criada somente se invariantes comprovarem segurança.
