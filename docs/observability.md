# Observabilidade, health e operação

## Estado implementado

Os dois apps expõem, sem cache:

- `/api/health/live`: prova que o processo responde; não consulta dependências e retorna `200` mesmo
  quando o release é desconhecido;
- `/api/health/ready`: exige SHA local ou Git completo, conexão DAL restrita, migration head atual e
  invariantes mínimas de grants/RLS; retorna somente `ready` ou `unready`, sem detalhe de banco.

Ambos retornam aplicação, release, timestamp e `requestId`. Um UUID de entrada válido é preservado;
qualquer outro valor é substituído. Readiness tem timeout curto e falha fechado.

## Logs

Eventos operacionais são JSON de uma linha em stdout e chegam ao journald. O schema aceita somente:

- evento e ação allowlisted;
- `requestId`;
- duração arredondada;
- status HTTP;
- resultado `accepted | rejected | unavailable`.

Nunca registrar token, cookie, senha, e-mail, telefone, CPF/CNPJ, documento, URL de banco, corpo de
contrato, idempotency key ou payload de provider. Erros públicos não carregam SQL, stack ou payload
externo.

Consultas básicas:

```bash
sudo journalctl -u set-livre-web -u set-livre-backoffice --since today --no-pager
sudo journalctl -u nginx --since today --no-pager
```

O `requestId` correlaciona resposta, evento operacional e novos fatos de auditoria. A chave idempotente
continua privada e separada.

## Deploy

O deployment do GitHub registra SHA, migrations, transferência, ativação e health público. O host
registra restart/falha no journald. O instalador imprime apenas estado e SHA; em falha, inclui as últimas
linhas dos dois serviços e executa rollback.

Um deploy é verde somente quando:

1. workflow chegou a estado terminal de sucesso;
2. os dois endpoints internos retornaram o SHA novo;
3. `https://147.15.97.227/api/health/ready` retornou `web/ready/<sha>`.

O backoffice é provado internamente pelo instalador e não possui endpoint público antes do go-live.
Timeout, falha TLS ou resposta ausente são inconclusivos, nunca aprovação.

## Sinais operacionais

Antes do go-live, as superfícies nativas são suficientes:

- GitHub Actions e deployments;
- Supabase Logs, advisors e conexões;
- Oracle metrics de CPU, memória, rede e disco;
- Nginx access/error logs;
- systemd/journald;
- `snap.certbot.renew.timer`.

PEND-008 decide error tracking, canal de alertas, retenção e orçamento. Até essa decisão, não adicionar
Sentry, agente ou daemon próprio.

## Alertas mínimos de go-live

P0:

- readiness público indisponível;
- banco indisponível;
- pagamento confirmado sem reserva;
- dupla reserva comprovada;
- backup/restore crítico falhou.

P1:

- 5xx recorrente;
- OOM ou restart loop;
- disco acima de 85%;
- falha de renovação do certificado curto de IP ou certificado fora de sua janela operacional;
- fila/reconciliação acima do SLA quando essas features existirem.

Todo alerta ativado precisa de owner e runbook. Métricas de features ainda não implementadas são metas,
não estado atual.

## Diagnóstico rápido

```bash
curl --fail https://147.15.97.227/api/health/live
curl --fail https://147.15.97.227/api/health/ready
ssh ubuntu@<ip-da-vm>
sudo systemctl --failed
sudo systemctl status set-livre-web set-livre-backoffice nginx
sudo journalctl -u set-livre-web -u set-livre-backoffice -n 100 --no-pager
free -h
df -h /
```

Incidentes de reserva/pagamento usam os runbooks em [`runbooks/`](runbooks/). Evidência sensível deve
ser redigida antes de sair do sistema de origem.
