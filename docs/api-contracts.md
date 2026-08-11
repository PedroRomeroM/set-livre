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

Limite padrão planejado: 128 KiB. A superfície Auth já implementada na FEAT-002 usa o limite mais restritivo de 16 KiB e consome o stream independentemente de `Content-Length`.

### 2.1 Superfície implementada na FEAT-002

- todos os `POST` exigem `Origin` e `Host` exatos de `NEXT_PUBLIC_APP_URL`; em produção, `X-Forwarded-Host` e `X-Forwarded-Proto=https` também precisam ter sido sobrescritos pela borda confiável;
- um bucket de fachada é consumido antes do parse/Zod; depois do parse, cadastro/login/recovery/callback usam somente hashes de e-mail, usuário ou token. Em produção, a fachada exige um único IP canônico em `X-Forwarded-For`, sobrescrito pelo Nginx da borda confiável previsto em PEND-003; header ausente, composto ou inválido falha fechado;
- somente `application/json` e schemas Zod `strict` são aceitos;
- sucesso e erro usam envelope JSON com `requestId`, `private, no-store` e sem payload de provider, SQL ou PII;
- o pedido de recovery responde sempre `202` com o mesmo corpo, inclusive quando o provider rejeita ou está indisponível; somente o evento redigido marca a degradação, sem permitir inferir se o e-mail existe;
- o cliente interrompe qualquer request de identidade após dez segundos e retorna estado recuperável sem preservar payload sensível;
- login, logout, callback, recovery e sessão usam clientes Supabase server-side por request; senha, token e cookie nunca entram no cache TanStack;
- o callback aceita apenas `signup` ou `recovery`; o `TokenHash` chega ao browser no fragmento, é apagado antes do `POST` e não aparece na request inicial nem no referrer;
- em recovery, somente um `SERVICE_UNAVAILABLE` recebido em resposta válida antes de `verifyOtp` permite retry. Falha de rede, timeout ou resposta inválida após o envio são ambíguos no cliente; erro desconhecido, throw, sessão incompleta ou falha de grant depois que `verifyOtp` começa retornam `RECOVERY_RESTART_REQUIRED`, apagam o payload e exigem novo link;
- a troca de senha reserva o grant no banco antes do provedor; somente rejeições explícitas sem efeito liberam retry, enquanto resultado ambíguo encerra a autorização e exige novo link;
- logout e descarte da sessão pós-recovery só aceitam erro do provider como concluído quando o cliente server-side comprova que a sessão local já não existe; estado presente ou ambíguo falha fechado;
- `returnTo` possui allowlist literal; nesta fatia o único destino autenticado é `/entrar?sessao=ativa`.

## 3. Códigos de erro

| Código                         | HTTP | Uso                      |
| ------------------------------ | ---: | ------------------------ |
| `AUTH_REQUIRED`                |  401 | sem sessão               |
| `FORBIDDEN`                    |  403 | papel/ownership          |
| `ACCOUNT_SUSPENDED`            |  403 | conta suspensa           |
| `VALIDATION_FAILED`            |  422 | campos                   |
| `NOT_FOUND`                    |  404 | recurso não visível      |
| `CONFLICT`                     |  409 | estado concorrente       |
| `SLOT_UNAVAILABLE`             |  409 | calendário               |
| `QUOTE_EXPIRED`                |  409 | cotação                  |
| `PAYMENT_PROVIDER_UNAVAILABLE` |  503 | integração               |
| `PAYMENT_NOT_STARTED`          |  409 | provider não confirmou   |
| `PAYMENT_MISMATCH`             |  409 | valor/moeda              |
| `RATE_LIMITED`                 |  429 | abuso                    |
| `PAYLOAD_TOO_LARGE`            |  413 | limite                   |
| `RECOVERY_RESTART_REQUIRED`    |  503 | OTP ambíguo ou consumido |
| `INTERNAL_ERROR`               |  500 | inesperado com requestId |

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

| Action                     | Autorização                    | Efeito                                                                                                         |
| -------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `identity.register`        | visitante com origem confiável | cria intenção jurídica opaca e inicia signup Auth; perfil mínimo e dois aceites nascem atomicamente no trigger |
| `profile.complete`         | authenticated                  | cria/completa perfil e aceita termos                                                                           |
| `profile.update`           | owner                          | altera campos permitidos                                                                                       |
| `account.export.request`   | owner                          | agenda exportação                                                                                              |
| `account.deletion.request` | owner                          | inicia exclusão/análise                                                                                        |
| `account.deletion.cancel`  | owner                          | cancela se ainda possível                                                                                      |

Campos de CPF/CNPJ nunca são aceitos como ownership. Normalizar e validar dígitos.

### 5.2 Dono/recebedor

| Action                         | Efeito                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| `owner.activate`               | cria owner profile e aceite                                |
| `recipient.onboarding.start`   | cria/atualiza recipient no provider                        |
| `recipient.onboarding.refresh` | consulta requisitos/status                                 |
| `recipient.bank.update`        | atualiza via provider, sem persistir segredo desnecessário |

A resposta contém status seguro e próximos passos, não payload bruto.

### 5.3 Estúdio e revisão

| Action                           | Efeito                            |
| -------------------------------- | --------------------------------- |
| `studio.create`                  | cria studio + revisão draft       |
| `studio.revision.updateCore`     | dados, endereço, capacidade, tipo |
| `studio.revision.updateTaxonomy` | tags/amenities                    |
| `studio.revision.updateContent`  | descrição/regras/FAQ/YouTube      |
| `studio.revision.submit`         | valida completude e envia         |
| `studio.pause`                   | pausa novas reservas              |
| `studio.resume`                  | retoma se elegível                |
| `studio.draft.discard`           | descarta draft sem dependência    |
| `studio.media.upload.prepare`    | emite upload assinado             |
| `studio.media.upload.finalize`   | valida objeto/metadados           |
| `studio.media.reorder`           | posição                           |
| `studio.media.cover.set`         | capa                              |
| `studio.media.delete`            | remove se seguro                  |

`studio.revision.update*` usa optimistic concurrency (`expectedUpdatedAt` ou revision token).

### 5.4 Calendário

| Action                       | Efeito                          |
| ---------------------------- | ------------------------------- |
| `calendar.settings.update`   | min/max/buffer                  |
| `calendar.weekly.replace`    | substitui janelas em transação  |
| `calendar.exception.upsert`  | fecha ou define janelas         |
| `calendar.exception.delete`  | remove futura                   |
| `calendar.block.create`      | alocação manual                 |
| `calendar.block.update`      | move/redimensiona               |
| `calendar.block.delete`      | libera                          |
| `calendar.ical.import`       | cria lote e alocações           |
| `calendar.ical.batch.delete` | remove lote sem afetar reservas |

Comandos validam hora cheia e ownership.

### 5.5 Preço/adicionais

| Action                           | Efeito             |
| -------------------------------- | ------------------ |
| `pricing.base.update`            | preço base         |
| `pricing.dayMultipliers.replace` | 7 dias             |
| `pricing.timeBands.replace`      | faixas sem overlap |
| `addon.create`                   | adicional          |
| `addon.update`                   | altera futuro      |
| `addon.archive`                  | inativa            |

### 5.6 Reserva/pagamento

| Action                            | Efeito                                        |
| --------------------------------- | --------------------------------------------- |
| `booking.quote.create`            | cotação autoritativa                          |
| `booking.payment.start`           | revalida quote, inicia provider, adquire hold |
| `booking.payment.retry`           | nova tentativa idempotente                    |
| `booking.attempt.cancel`          | cancela tentativa pendente                    |
| `reservation.cancel`              | cancelamento do locatário elegível            |
| `reservation.owner.cancelRequest` | solicita suporte                              |
| `reservation.note.update`         | apenas quando permitido                       |

`booking.payment.start` é um orquestrador server-side; provider call e hold precisam de compensação explícita.

### 5.7 Admin/backoffice

| Action                                 | Papel                     |
| -------------------------------------- | ------------------------- |
| `admin.studio.approve`                 | reviewer/admin            |
| `admin.studio.reject`                  | reviewer/admin            |
| `admin.studio.disable`                 | admin                     |
| `admin.studio.restore`                 | admin                     |
| `admin.user.suspend`                   | support/admin             |
| `admin.user.restore`                   | support/admin             |
| `admin.role.grant/revoke`              | admin                     |
| `admin.taxonomy.create/update/archive` | admin                     |
| `admin.refund.request/retry`           | finance/admin             |
| `admin.payout.retry/block/unblock`     | finance/admin             |
| `admin.fiscal.export`                  | finance/admin             |
| `admin.account.deletion.execute`       | admin + confirmação forte |

Toda action administrativa gera `audit.events`.

## 6. Read models e DTOs

### 6.1 `list_studios`

Entrada:

```ts
type StudioListInput = {
  neighborhood?: string[];
  date?: string; // YYYY-MM-DD
  minPriceCents?: number;
  maxPriceCents?: number;
  studioTypeId?: string[];
  minCapacity?: number;
  amenityIds?: string[];
  tagIds?: string[];
  order: "price_asc" | "price_desc";
  cursor?: string;
  limit: number; // <= 24
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

Na FEAT-002, `identityQueryKeys.sessions = ["identity", "session"]` é o prefixo de invalidação, `identityQueryKeys.session(userId | "anonymous")` cria a key privada escopada e `identityQueryKeys.recoveryStatus = ["identity", "recovery", "current-session"]` mantém o grant da sessão atual. Antes de renderizar PII, o cliente remove scopes anteriores e também substitui uma instância preexistente da mesma key pelo `initialData` SSR atual. Refetch em execução ou pausado, observer ainda ligado à Query removida e retorno de outro usuário mantêm a tela bloqueada; mudança autoritativa de escopo limpa o cache e recompõe `/entrar` no servidor. Login publica somente a sessão escopada; logout e recovery removem a família privada. Token de callback, senha e e-mail de formulário nunca entram em query key ou cache.

## 10. Rate limits iniciais

Defaults por usuário/IP:

| Classe                | Limite    |
| --------------------- | --------- |
| Auth                  | 10/10 min |
| Quote                 | 60/min    |
| Start payment         | 5/10 min  |
| Retry payment         | 5/30 min  |
| Studio edits          | 60/10 min |
| Upload prepare        | 20/h      |
| iCal import           | 5/h       |
| Admin destructive     | 20/h      |
| Account export/delete | 3/dia     |

Implementado no processo local único da FEAT-002: fachada pré-Zod `300/min` por ação e origem de rede confiável; cadastro `5/h` por hash de e-mail; login `10/15 min` por hash de e-mail; pedido de recovery `5/h` por hash de e-mail; callback `10/10 min` por hash do token; atualização de senha `5/h` por usuário. Nenhum discriminador bruto é armazenado. No runtime local direto, a fachada usa um único bucket deliberado porque a stack não é exposta; produção permanece bloqueada por PEND-003 até o Nginx sobrescrever o header e aplicar também o limiter de borda.

O limiter in-memory limita o processo a 10.000 buckets totais e separa a pressão de capacidade por ação. Quando todos estão vivos, uma chave nova toma o bucket mais antigo da maior partição até equilibrar as classes; se a própria ação já for uma das maiores, a evicção ocorre nela. A seleção percorre somente as classes internas e a remoção do bucket é O(1), sem varrer os 10.000 discriminadores a cada admissão. Assim, encher o armazenamento com discriminadores sintéticos não transforma capacidade interna em `429` global nem monopoliza todas as vagas, enquanto uma chave presente em outra partição que já consumiu sua cota continua bloqueada. A evicção pode reduzir a precisão dessa primeira camada sob ataque de cardinalidade, por isso produção continua dependente do limiter Nginx de PEND-003, e horizontalização futura exige store compartilhado.

No escopo local atual, o limiter in-memory é aceitável porque cada execução usa processo único e não fica exposta. Idempotência e banco protegem operações críticas.

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

O primeiro uso concreto é a intenção jurídica do cadastro: enquanto a intenção está pendente, `requestId` igual e mesmo contrato retorna o mesmo token opaco inclusive sob corrida, e payload divergente falha fechado. O trigger apaga a intenção ao concluir, o purge remove expiradas e o token nunca é devolvido ao navegador. Depois do consumo ou da expiração, o mesmo `requestId` pode iniciar uma nova tentativa; isso não recria perfil ou aceite para um usuário já materializado, e replay do token apagado falha fechado.
