# Runbook — indisponibilidade do banco

1. readiness falha;
2. interromper novos payment starts;
3. manter Nginx/error page;
4. verificar Supabase/status/conexões;
5. não reiniciar repetidamente sem evidência;
6. preservar provider webhooks para retry seguro;
7. após retorno, reconciliar payments/holds/outbox;
8. verificar migration head;
9. registrar RTO.
