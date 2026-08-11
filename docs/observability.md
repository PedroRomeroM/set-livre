# Observabilidade, health checks e operação

## 1. Objetivo

Detectar falha antes de gerar dupla reserva, cobrança sem reserva, e-mail perdido ou repasse atrasado.

### 1.1 Estado implementado até a FEAT-002

Os dois apps já expõem `/live` e `/ready` sem cache, com aplicação, release, timestamp e `requestId`; um UUID de entrada válido é propagado e qualquer valor inválido é substituído. Liveness não depende de configuração: `APP_RELEASE_SHA` ausente ou inválido mantém `200`, `status=live` e usa `release=unknown`. Readiness valida o mesmo valor antes de consultar dependências e, nesse caso, retorna `503`, `status=unready` e `release=unknown`, preservando `requestId` e `cache-control: no-store` sem expor configuração. Com release válido, consulta duas funções privadas com timeout e comprova atributos, memberships de entrada/saída, grants/ownership de `app_dal` e do login, a baseline pública exata, ACLs efetivas de `private` e a negação dos catálogos sensíveis. Qualquer ampliação retorna somente `unready`, sem erro de banco; um erro de cliente ocioso mantém o pool único.

A FEAT-002 introduz o primeiro evento operacional real: cada request de cadastro, login, logout, callback, pedido/status/atualização de recovery ou sessão emite somente `event=identity.request`, `requestId`, ação allowlisted, duração arredondada, status e resultado (`accepted`, `rejected` ou `unavailable`). Para não permitir enumeração, um erro do provider durante o pedido de recovery conserva a resposta pública `202` idêntica, mas registra internamente somente `outcome=unavailable`, sem código ou payload externo. E-mail, senha, token, cookie, URL, payload do provider e evidência bruta não são campos aceitos. Error tracking, alertas externos e dashboards continuam dependentes de PEND-008.

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
- `current_user=app_dal` sem atributo privilegiado, membership de saída, ownership ou grant direto além de `USAGE private` e `EXECUTE` nas oito rotinas autorizadas: dois checks de readiness, criação da intenção legal e cinco operações do grant recovery, sempre sem grant option;
- `PUBLIC` conserva somente `USAGE` em `pg_catalog`/`information_schema`, `CONNECT` no banco e `USAGE` nas quatro linguagens internas; `TEMPORARY` é recusado efetivamente à DAL/runtime, não há default ACL, objeto grande, parâmetro, FDW/server ou tablespace público, e `net` permanece inacessível às roles runtime;
- nenhuma relação, coluna, sequência, rotina ou tipo autônomo de `private` concede privilégio efetivo a `PUBLIC`; row types, arrays e multiranges implícitos seguem o objeto canônico. Em relações e colunas de `pg_catalog`, ACLs públicas podem apenas reproduzir privilégios iniciais `i`/`e` registrados em `pg_init_privs`. Rotinas são confrontadas por OID/overload, grantor e grant option com essa mesma origem; sem init row, a baseline usa `pg_extension.extowner` para membros de extensão ou o owner bootstrap OID `10` para os demais objetos initdb, nunca `proowner`, e exige ownership canônico mesmo sem `EXECUTE` público. Rotina normal posterior continua sem baseline. Expansões como `SELECT` em `pg_authid`, `EXECUTE` em `pg_read_file(text)` ou owner/grantor recalculado após drift tornam readiness indisponível. `pg_roles`, `pg_user` e `pg_db_role_setting` negam ainda leitura direta ou transitiva às roles web/DAL; os demais catálogos mantêm somente a acessibilidade built-in. Essa métrica não promete confidencialidade genérica nem substitui manifestos de grants a roles nomeadas;
- exatamente `session_user` restrito pode assumir `app_dal`; as referências administrativas `postgres` não possuem `SET/INHERIT`, nenhuma role intermediária assume o login, e esse login conserva somente `CONNECT`, membership DAL e a máscara vazia do GUC JWT local;
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
