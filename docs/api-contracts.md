# Contratos de leitura, comandos e integrações

## 1. Princípios

- rotas representam intenções;
- comandos críticos entram por `POST /api/commands`;
- action names são estáveis e versionadas por contrato;
- payload é Zod `strict`;
- resposta nunca vaza provider/SQL;
- read models retornam DTOs explícitos;
- IDs de provider são privados;
- toda ação declara autorização, idempotência, transação, eventos e invalidação.

## 2. Envelope de comando

```ts
type CommandEnvelope = {
  action: CommandAction;
  payload: unknown;
  idempotencyKey?: string;
};
```

Headers:

- `Content-Type: application/json`;
- `X-Request-Id` opcional, validado;
- cookie de sessão;
- `Origin` confiável;
- `Idempotency-Key` pode ser header ou envelope, mas uma política única deve ser escolhida no código.

Limite padrão: 128 KiB.

## 3. Códigos de erro

| Código | HTTP | Uso |
|---|---:|---|
| `AUTH_REQUIRED` | 401 | sem sessão |
| `FORBIDDEN` | 403 | papel/ownership |
| `ACCOUNT_SUSPENDED` | 403 | conta suspensa |
| `VALIDATION_FAILED` | 422 | campos |
| `NOT_FOUND` | 404 | recurso não visível |
| `CONFLICT` | 409 | estado concorrente |
| `SLOT_UNAVAILABLE` | 409 | calendário |
| `QUOTE_EXPIRED` | 409 | cotação |
| `PAYMENT_PROVIDER_UNAVAILABLE` | 503 | integração |
| `PAYMENT_NOT_STARTED` | 409 | provider não confirmou |
| `PAYMENT_MISMATCH` | 409 | valor/moeda |
| `RATE_LIMITED` | 429 | abuso |
| `PAYLOAD_TOO_LARGE` | 413 | limite |
| `INTERNAL_ERROR` | 500 | inesperado com requestId |

Mensagens de usuário são traduzidas por código. Não usar mensagem SQL.

## 4. Registry

```ts
const commandHandlers = {
  "profile.update": updateProfile,
  "owner.activate": activateOwner,
  "studio.create": createStudio,
  // ...
} satisfies Record<CommandAction, CommandHandler>;
```

Registry não contém lógica de domínio. Cada handler vive no domínio.

## 5. Catálogo de comandos

### 5.1 Perfil e conta

| Action | Autorização | Efeito |
|---|---|---|
| `profile.complete` | authenticated | cria/completa perfil e aceita termos |
| `profile.update` | owner | altera campos permitidos |
| `account.export.request` | owner | agenda exportação |
| `account.deletion.request` | owner | inicia exclusão/análise |
| `account.deletion.cancel` | owner | cancela se ainda possível |

Campos de CPF/CNPJ nunca são aceitos como ownership. Normalizar e validar dígitos.

### 5.2 Dono/recebedor

| Action | Efeito |
|---|---|
| `owner.activate` | cria owner profile e aceite |
| `recipient.onboarding.start` | cria/atualiza recipient no provider |
| `recipient.onboarding.refresh` | consulta requisitos/status |
| `recipient.bank.update` | atualiza via provider, sem persistir segredo desnecessário |

A resposta contém status seguro e próximos passos, não payload bruto.

### 5.3 Estúdio e revisão

| Action | Efeito |
|---|---|
| `studio.create` | cria studio + revisão draft |
| `studio.revision.updateCore` | dados, endereço, capacidade, tipo |
| `studio.revision.updateTaxonomy` | tags/amenities |
| `studio.revision.updateContent` | descrição/regras/FAQ/YouTube |
| `studio.revision.submit` | valida completude e envia |
| `studio.pause` | pausa novas reservas |
| `studio.resume` | retoma se elegível |
| `studio.draft.discard` | descarta draft sem dependência |
| `studio.media.upload.prepare` | emite upload assinado |
| `studio.media.upload.finalize` | valida objeto/metadados |
| `studio.media.reorder` | posição |
| `studio.media.cover.set` | capa |
| `studio.media.delete` | remove se seguro |

`studio.revision.update*` usa optimistic concurrency (`expectedUpdatedAt` ou revision token).

### 5.4 Calendário

| Action | Efeito |
|---|---|
| `calendar.settings.update` | min/max/buffer |
| `calendar.weekly.replace` | substitui janelas em transação |
| `calendar.exception.upsert` | fecha ou define janelas |
| `calendar.exception.delete` | remove futura |
| `calendar.block.create` | alocação manual |
| `calendar.block.update` | move/redimensiona |
| `calendar.block.delete` | libera |
| `calendar.ical.import` | cria lote e alocações |
| `calendar.ical.batch.delete` | remove lote sem afetar reservas |

Comandos validam hora cheia e ownership.

### 5.5 Preço/adicionais

| Action | Efeito |
|---|---|
| `pricing.base.update` | preço base |
| `pricing.dayMultipliers.replace` | 7 dias |
| `pricing.timeBands.replace` | faixas sem overlap |
| `addon.create` | adicional |
| `addon.update` | altera futuro |
| `addon.archive` | inativa |

### 5.6 Reserva/pagamento

| Action | Efeito |
|---|---|
| `booking.quote.create` | cotação autoritativa |
| `booking.payment.start` | revalida quote, inicia provider, adquire hold |
| `booking.payment.retry` | nova tentativa idempotente |
| `booking.attempt.cancel` | cancela tentativa pendente |
| `reservation.cancel` | cancelamento do locatário elegível |
| `reservation.owner.cancelRequest` | solicita suporte |
| `reservation.note.update` | apenas quando permitido |

`booking.payment.start` é um orquestrador server-side; provider call e hold precisam de compensação explícita.

### 5.7 Admin/backoffice

| Action | Papel |
|---|---|
| `admin.studio.approve` | reviewer/admin |
| `admin.studio.reject` | reviewer/admin |
| `admin.studio.disable` | admin |
| `admin.studio.restore` | admin |
| `admin.user.suspend` | support/admin |
| `admin.user.restore` | support/admin |
| `admin.role.grant/revoke` | admin |
| `admin.taxonomy.create/update/archive` | admin |
| `admin.refund.request/retry` | finance/admin |
| `admin.payout.retry/block/unblock` | finance/admin |
| `admin.fiscal.export` | finance/admin |
| `admin.account.deletion.execute` | admin + confirmação forte |

Toda action administrativa gera `audit.events`.

## 6. Read models e DTOs

### 6.1 `list_studios`

Entrada:

```ts
type StudioListInput = {
  neighborhood?: string[];
  date?: string;          // YYYY-MM-DD
  minPriceCents?: number;
  maxPriceCents?: number;
  studioTypeId?: string[];
  minCapacity?: number;
  amenityIds?: string[];
  tagIds?: string[];
  order: "price_asc" | "price_desc";
  cursor?: string;
  limit: number;          // <= 24
};
```

Saída por item:

```ts
type StudioCardDto = {
  id: string;
  name: string;
  neighborhood: string;
  cover: { url: string; width: number; height: number; alt: string };
  exactHourlyPriceCents: number;
  capacity: number;
  studioType: { id: string; name: string };
  highlights: { id: string; name: string; kind: "tag" | "amenity" }[];
  availableOnDate: boolean | null;
};
```

Cursor incorpora ordem, valor e ID; é assinado/opaco.

### 6.2 `get_studio_detail`

DTO:

- identidade e endereço aprovado;
- galeria;
- vídeo ID;
- descrição, regras, FAQ;
- tipo/tags/amenities;
- capacidade;
- preço base;
- resumo de multiplicadores em linguagem útil;
- configurações de duração;
- disponibilidade da janela solicitada;
- metadata SEO.

Não retorna owner PII, revisão pendente, IDs de Storage internos ou notas de review.

### 6.3 `get_studio_availability`

Entrada:

- studio;
- `fromDate`, `toDate`, máximo 31 dias.

Saída por dia:

```ts
type AvailabilityDayDto = {
  date: string;
  slots: {
    start: string;
    end: string;
    available: boolean;
    reason?: "closed" | "allocated" | "outside_duration";
  }[];
};
```

Não expor detalhes da reserva que ocupa o horário.

### 6.4 `get_reservation_quote`

Entrada:

- studio;
- data/start/duração;
- pessoas;
- add-ons/quantidade;
- observação opcional.

Saída:

- quote ID;
- expiresAt;
- line items;
- subtotal hora;
- subtotal adicionais;
- total;
- regras aplicadas;
- disponibilidade no momento;
- aviso de que vaga só é garantida no hold.

### 6.5 Read models privados

Cada um retorna somente campos de tela:

- `get_my_profile`;
- `list_my_reservations`;
- `get_my_reservation`;
- `list_owner_studios`;
- `get_owner_studio_editor`;
- `get_owner_calendar`;
- `list_owner_reservations`;
- `list_owner_payments`;
- `get_owner_recipient_status`.

## 7. Webhook de pagamento

Rota:

`POST /api/webhooks/payments/[provider]`

Pipeline:

1. ler bytes brutos com limite;
2. extrair headers;
3. validar assinatura/timestamp;
4. derivar `external_event_id`;
5. inserir `webhook_events` com unique;
6. responder repetição com 2xx sem duplicar;
7. mapear evento;
8. executar comando privado idempotente;
9. registrar resultado;
10. retornar rápido.

Provider desconhecido = 404. Assinatura inválida = 401/400 sem detalhar.

## 8. Upload de mídia

### Preparação

`studio.media.upload.prepare` recebe:

- studio/revision;
- nome;
- MIME;
- tamanho;
- checksum opcional.

Retorna:

- signed upload URL;
- path;
- media draft ID;
- expiração.

### Finalização

Verifica:

- objeto existe;
- tamanho/MIME reais;
- imagem decodificável;
- dimensões mínimas/máximas;
- path esperado;
- ownership;
- limite;
- checksum.

Só então `status=ready`.

## 9. Query invalidation map

Documento/código devem manter mapa único. Regras:

- qualquer mudança pública invalida list/detail;
- calendário invalida availability/quote;
- pagamento confirmado invalida calendar/reservation/payment;
- cancelamento invalida calendar/reservation/payment/payout;
- admin review invalida fila/status/public;
- taxonomy invalida filtros e editores.

## 10. Rate limits iniciais

Defaults por usuário/IP:

| Classe | Limite |
|---|---|
| Auth | 10/10 min |
| Quote | 60/min |
| Start payment | 5/10 min |
| Retry payment | 5/30 min |
| Studio edits | 60/10 min |
| Upload prepare | 20/h |
| iCal import | 5/h |
| Admin destructive | 20/h |
| Account export/delete | 3/dia |

In-memory é aceitável em VM única. Idempotência/banco protegem operações; migrar limiter para store compartilhado antes de horizontalizar.

## 11. Idempotência

Obrigatória em:

- início/retry de pagamento;
- webhook;
- confirmação de reserva;
- reembolso;
- repasse;
- envio de e-mail;
- exportação;
- exclusão de conta.

Mesmo key + mesmo hash retorna resultado anterior. Mesmo key + payload diferente retorna conflito.
