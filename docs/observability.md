# Observabilidade, health checks e operação

## 1. Objetivo

Detectar falha antes de gerar dupla reserva, cobrança sem reserva, e-mail perdido ou repasse atrasado.

### 1.1 Estado da fundação local

Os dois apps já expõem `/live` e `/ready` sem cache, com aplicação, release, timestamp e `requestId`; um UUID de entrada válido é propagado e qualquer valor inválido é substituído. Liveness não depende de configuração: `APP_RELEASE_SHA` ausente ou inválido mantém `200`, `status=live` e usa `release=unknown`. Readiness valida o mesmo valor antes de consultar dependências e, nesse caso, retorna `503`, `status=unready` e `release=unknown`, preservando `requestId` e `cache-control: no-store` sem expor configuração. Com release válido, consulta a função privada com timeout e comprova separadamente os atributos restritos e a ausência de memberships da role efetiva `app_dal`, além dos atributos do login e sua única membership permitida. Qualquer ampliação de privilégio retorna somente `unready`, sem erro de banco; um erro de cliente ocioso mantém o pool único.

Ainda não existe evento de domínio que justifique logger, métrica ou alerta falso. O logger JSON com redaction entra junto ao primeiro comando real; error tracking, alertas externos e dashboards dependem de PEND-008.

## 2. Logs

Formato JSON:

```json
{
  "timestamp": "...",
  "level": "info",
  "environment": "production",
  "service": "web",
  "release": "<sha>",
  "requestId": "...",
  "route": "/api/commands",
  "action": "booking.payment.start",
  "durationMs": 123,
  "result": "success",
  "errorCode": null,
  "actorHash": "..."
}
```

Redaction:

- tokens;
- cookies;
- CPF/CNPJ;
- e-mail/telefone;
- provider payload;
- QR Pix completo;
- URL de banco;
- notas livres.

## 3. Health

### `/api/health/live`

- processo responde;
- não consulta dependência;
- sempre responde 200/JSON controlado; release ausente ou inválido aparece apenas como `unknown`.

### `/api/health/ready`

- conexão DB simples com timeout;
- migration head compatível;
- `current_user=app_dal` sem atributo privilegiado ou qualquer membership, e `session_user` restrito com somente a membership esperada;
- configuração crítica presente;
- sem revelar detalhes;
- provider não deve tornar app inteiro unready por falha temporária, mas estado aparece em métrica.

### Worker health

Heartbeat no banco com serviço/release/last_success.

## 4. Métricas

### Web

- requests;
- p50/p95/p99;
- 4xx/5xx;
- command por action;
- rate limit;
- body rejected;
- auth failures;
- Core Web Vitals.

### Banco

- conexões;
- slow queries;
- lock waits;
- constraint conflicts;
- RLS advisor findings;
- crescimento;
- outbox depth.

### Domínio

- quotes;
- attempts;
- hold acquisition success/conflict;
- holds expirados;
- payment pending/paid/failed;
- webhook lag;
- payment sem reserva;
- reservation confirmations;
- refunds;
- payouts atrasados;
- review queue age.

### Infra

- CPU;
- memória;
- disco;
- event loop lag;
- Nginx 5xx;
- cert expiry;
- deploy.

## 5. Alertas

P0:

- pagamento pago sem reserva;
- duas reservas conflitantes detectadas;
- webhook signature failures anormais;
- DB indisponível;
- backup falhou;
- payout processado para refund;
- readiness falha.

P1:

- 5xx elevado;
- webhook lag > 5 min;
- outbox > 10 min;
- payout > 24h atrasado;
- disco > 85%;
- certificado < 14 dias;
- reconciliação falhando.

Alerta deve ter runbook e owner.

## 6. Error tracking

Default permitido: Sentry com:

- release;
- environment;
- source maps privados;
- PII scrub;
- session replay desabilitado por default;
- sampling;
- custo monitorado.

Não enviar formulário, CPF, QR, payload de payment ou notas.

## 7. Request IDs

- Nginx cria/propaga;
- app aceita apenas formato válido;
- response inclui;
- SQL/event/audit inclui;
- provider metadata pode incluir request correlation não sensível.

## 8. Dashboards

- saúde técnica;
- booking/payment funnel técnico;
- filas;
- infraestrutura;
- custos.

Analytics de produto mais amplo é decisão separada; não coletar conteúdo privado por conveniência.

## 9. Runbooks

Links obrigatórios:

- deploy/rollback;
- DB outage;
- provider outage;
- paid-without-reservation;
- double-booking suspicion;
- refund/payout;
- backup/restore;
- security incident.
