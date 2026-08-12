# Pagamentos, split, reembolso e repasse

## 1. Escopo financeiro

- cartão;
- PIX;
- split 80/20;
- taxas do gateway pagas pela plataforma;
- recebedor por dono;
- repasse após o uso;
- retentativa;
- reembolso total;
- fallback manual;
- exportação fiscal manual.

## 2. Fronteira do provider

```ts
interface PaymentProvider {
  ensureCustomer(input: CustomerInput): Promise<CustomerRef>;
  ensureRecipient(input: RecipientInput): Promise<RecipientResult>;
  startCardPayment(input: CardPaymentInput): Promise<PaymentStart>;
  startPixPayment(input: PixPaymentInput): Promise<PixPaymentStart>;
  cancelPayment(input: CancelInput): Promise<CancelResult>;
  getPayment(input: PaymentLookup): Promise<ProviderPayment>;
  refundPayment(input: RefundInput): Promise<RefundResult>;
  createOrSchedulePayout(input: PayoutInput): Promise<PayoutResult>;
  getPayout(input: PayoutLookup): Promise<ProviderPayout>;
  verifyWebhook(rawBody: Uint8Array, headers: Headers): VerifiedEvent;
}
```

Implementação inicial: Pagar.me sandbox. Produção depende de contrato aprovado. Adapter Asaas futuro deve obedecer ao mesmo domínio.

## 3. PCI e dados de cartão

- PAN/CVV nunca passam pelo servidor Set Livre se o provider oferece tokenização/hosted fields.
- Nenhum log contém dado de cartão.
- Token de uso único é tratado como segredo e não persistido além do necessário.
- UI deixa claro que pagamento é processado pelo provider.
- CSP permite apenas origens estritas do provider.
- Testes usam tokens sandbox.

## 4. Cliente e recebedor

### 4.1 Cliente pagador

Provider customer é criado/atualizado server-side a partir de perfil validado. ID fica privado.

### 4.2 Recebedor do dono

Onboarding precisa de dados exigidos pelo contrato. A plataforma não cria “verificação própria”; exibe status do provider:

- não iniciado;
- pendente;
- ativo;
- recusado;
- suspenso;
- bloqueado.

Enquanto o ADR-018 estiver vigente, “provider” nesta fatia significa somente uma interface server-only com adapter local determinístico, sem SDK, HTTP, credencial ou sandbox remoto. O fluxo nominal local faz `start -> pending` e `refresh -> active`; os estados restantes são exercitados por mapper e fixtures de teste, nunca por e-mail/UUID mágico.

A projeção segura conserva `profile_version_synced`. A elegibilidade de reserva é verdadeira somente quando o dono está `active`, aceitou o `owner_contract` vigente, o recebedor está `active` e essa versão coincide com a versão canônica atual de `profiles`; qualquer ausência, refetch ou divergência falha fechada. Nova versão contratual preserva o histórico e exige novo aceite. O checkout real da FEAT-020 revalida o fato no banco antes de cobrar.

Estúdio pode ser publicado sem recipient ativo? Baseline:

- conteúdo pode ser aprovado;
- `reservations_enabled=false` até recipient ativo e sincronizado; fallback financeiro pertence à FEAT-032 e não existe nesta fatia;
- listagem pode exibir estúdio, mas CTA de reserva informa indisponibilidade operacional apenas se produto aprovar. Default seguro: não listar como disponível.

## 5. Valores

Para total bruto `G`:

- dono: `round(G × 0,80)`;
- plataforma: `G - dono`;
- fee do gateway: plataforma;
- soma de split = G.

Guardar basis points e valores calculados no snapshot.

## 6. Cartão

Fluxo:

1. UI coleta/tokeniza no provider;
2. `booking.payment.start`;
3. provider cria cobrança/pedido;
4. persistir payment pending;
5. adquirir hold;
6. UI aguarda estado;
7. webhook paid confirma reserva;
8. falha expira/release;
9. autorização sem captura somente se provider/contrato exigir; baseline usa fluxo mais simples aprovado.

Estados e copy:

- processando;
- aguardando;
- aprovado;
- recusado;
- conflito de agenda;
- erro temporário;
- expirado.

Não confiar apenas na resposta síncrona do browser.

## 7. PIX

Fluxo:

1. provider cria QR com expiração;
2. persistir QR/payload com acesso do dono da tentativa;
3. adquirir hold até `provider_expires_at`;
4. UI mostra QR e copia/cola, contador e polling moderado;
5. webhook pago confirma;
6. expiração libera;
7. retry cria nova attempt/QR/idempotency key.

QR expirado não é reutilizado.

## 8. Webhooks

- bytes brutos;
- assinatura;
- timestamp/replay;
- external event unique;
- resposta rápida;
- payload redigido;
- processamento idempotente;
- eventos fora de ordem reconciliados pelo estado autoritativo do provider quando necessário.

Mapeamento provider→domínio vive no adapter, não espalhado.

## 9. Reconciliação

Worker:

- seleciona payments pendentes/ambíguos por cursor;
- claim com lock;
- consulta provider;
- aplica transição idempotente;
- limita tentativas/backoff;
- alerta atraso;
- não consulta indefinidamente pagamento encerrado.

Metas iniciais:

- pending card: reconciliar em 2, 5, 15 min;
- pending PIX: até expiração + margem;
- refund: 5, 30, 120 min;
- payout: 15 min, 2h, 24h.

## 10. Retentativa

Permitida quando:

- attempt falhou/expirou;
- não existe reservation confirmada;
- quote é revalidada;
- disponibilidade existe;
- rate limit.

Uma retentativa é nova payment/attempt e pode reutilizar intenção, nunca provider ID antigo.

## 11. Reembolso

Política: total.

Fluxo:

1. comando valida cancelamento;
2. cria refund pending;
3. provider refund com idempotency key;
4. webhook/consulta confirma;
5. atualiza payment/reservation;
6. release calendar;
7. cancela payout;
8. e-mails.

Se provider não suporta/retorna falha:

- manter pendência;
- criar caso no backoffice;
- permitir retry;
- fallback manual exige referência/comprovante e auditoria.

## 12. Repasse

### 12.1 Agendamento

Ao confirmar reserva:

- payout `scheduled`;
- `scheduled_for = end_at + 24h`.

### 12.2 Pré-condições

- reservation completed;
- payment paid;
- sem refund/dispute;
- recipient active;
- valor correto;
- não bloqueado.

### 12.3 Execução

Worker:

1. claim payout;
2. revalidar;
3. chamar provider;
4. persistir reference;
5. status processing/paid;
6. evento;
7. e-mail opcional ao dono.

### 12.4 Fallback

Se split já distribui recebíveis segundo contrato, o adapter representa o cronograma real. Se repasse diferido não for suportado, produção precisa de decisão comercial/jurídica; não simular escrow.

Fallback manual:

- finance visualiza pendência;
- registra transferência externa;
- anexa referência, sem arquivo sensível;
- ação auditada.

## 13. Disputa/chargeback

Mesmo não sendo fluxo comercial principal, evento externo pode ocorrer:

- payment `disputed`;
- reservation marcada;
- payout bloqueado se não pago;
- se já pago, incidente financeiro;
- alerta admin;
- não alterar calendário passado.

## 14. Fiscal

Exportação CSV/PDF futuro? Nesta versão gerar CSV estruturado (arquivo de dados), não emissão.

Campos:

- reserva;
- data de competência;
- pagador/recebedor conforme acesso legal;
- CPF/CNPJ;
- bruto;
- owner share;
- platform share;
- fee;
- refund;
- payout;
- status.

Arquivo privado, expirável, auditado.

## 15. Segurança

- secrets apenas server-side;
- redaction;
- webhook signature;
- provider IDs privados;
- rate limit;
- idempotency;
- nenhuma confiança em amount do client;
- reconciliação;
- audit em ações financeiras.

## 16. Testes P0

- cartão pago confirma uma vez;
- cartão recusado não reserva;
- PIX pago confirma;
- PIX expira e libera;
- webhook duplicado;
- webhook fora de ordem;
- valor divergente;
- dois pagamentos concorrentes;
- refund total;
- payout não ocorre antes do fim;
- payout bloqueado por refund;
- taxa atribuída à plataforma;
- recipient inativo impede fluxo;
- fallback manual auditado.
