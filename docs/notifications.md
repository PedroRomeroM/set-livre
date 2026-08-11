# E-mails transacionais e notificações

## 1. Escopo

Canal desta versão: e-mail. Não há push, WhatsApp, SMS ou inbox realtime.

## 2. Templates

| Chave                          | Destinatário   | Gatilho                           |
| ------------------------------ | -------------- | --------------------------------- |
| `account.welcome`              | usuário        | perfil concluído                  |
| `studio.review.submitted`      | admin/reviewer | envio                             |
| `studio.review.approved`       | dono           | aprovação                         |
| `studio.review.rejected`       | dono           | rejeição                          |
| `booking.payment.pending`      | locatário      | PIX/checkout iniciado quando útil |
| `reservation.confirmed.renter` | locatário      | pagamento confirmado              |
| `reservation.confirmed.owner`  | dono           | nova reserva                      |
| `reservation.reminder.renter`  | locatário      | 24h antes                         |
| `reservation.cancelled`        | partes         | cancelamento                      |
| `refund.confirmed`             | locatário      | reembolso                         |
| `payout.paid`                  | dono           | repasse                           |
| `account.deletion`             | usuário        | solicitação/conclusão             |

Supabase Auth é responsável por confirmação e reset. A FEAT-002 já fornece templates locais PT-BR com assuntos estáveis; eles usam `TokenHash` somente no fragmento do callback allowlisted e nunca o endpoint intermediário `auth/v1/verify`. As specs físicas usam Mailpit em `127.0.0.1:54324` como sink real dos dois fluxos e o cleanup remove somente mensagem/usuário QA exatos; o resultado da rodada browser pertence à evidência final do PR. SMTP e remetente de produção continuam bloqueados por PEND-005.

## 3. Outbox

Mudança de domínio e enfileiramento ocorrem na mesma transação.

`email_outbox` possui deduplication key, por exemplo:

```text
reservation.confirmed.renter:<reservationId>
```

Worker:

1. claim `for update skip locked`;
2. marcar processing/lease;
3. renderizar template;
4. enviar pelo adapter;
5. registrar provider ID/status;
6. retry com backoff;
7. dead-letter lógico após limite;
8. alerta.

## 4. Provider

Interface:

```ts
interface TransactionalEmailProvider {
  send(message: {
    to: string;
    templateKey: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }>;
}
```

Produção pode usar SMTP/OCI Email Delivery ou outro provider aprovado. A escolha não altera domínio.

## 5. Conteúdo

- PT-BR;
- nome e datas formatados;
- timezone explícito quando útil;
- CTA com URL absoluta/allowlist;
- versão texto;
- sem PII excessiva;
- sem detalhes financeiros do dono para locatário;
- sem provider IDs;
- links expiram quando sensíveis.

## 6. Lembretes

Job consulta reservas confirmadas cuja janela de lembrete entrou e ainda não possui dedup key.

- default 24h;
- não enviar cancelada/refunded;
- job idempotente;
- atraso registrado;
- timezone do estúdio.

## 7. Falhas

Falha de e-mail não desfaz reserva/pagamento. UI deve mostrar estado autoritativo. Backoffice vê falhas e retry.

## 8. Testes

- outbox na transação;
- deduplicação;
- retry;
- template sem dados errados;
- cancelamento impede reminder;
- links corretos;
- HTML e text;
- provider indisponível;
- nenhuma PII em log.
