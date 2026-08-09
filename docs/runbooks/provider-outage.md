# Runbook — indisponibilidade do gateway

## Sinais
Erro elevado, timeout, webhook lag, reconciliation failures.

## Ações
1. confirmar provider status;
2. desabilitar novos starts via feature flag operacional se necessário;
3. não desabilitar leitura/reservas existentes;
4. preservar attempts/holds;
5. deixar holds expirarem com verificação;
6. alertar suporte;
7. reconciliar após retorno;
8. identificar paid sem reservation;
9. registrar incidente.

## Não fazer
Não marcar paid manualmente sem evidência; não estender holds indefinidamente; não apagar events.
