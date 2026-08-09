# Arquitetura end-to-end

## 1. Visão

```mermaid
flowchart LR
    V[Visitante / Locatário / Dono] --> NG[Nginx + TLS]
    O[Operador] --> VPN[Acesso administrativo restrito]
    VPN --> NG

    NG --> WEB[Next.js público\nstandalone :3000]
    NG --> BO[Next.js backoffice\nstandalone :3001]

    WEB --> TQ[TanStack Query]
    TQ --> RM[Read models Supabase]
    WEB --> CMD[POST /api/commands]
    CMD --> AUTH[Auth + Origin + Rate Limit + Zod]
    AUTH --> DAL[DAL server-only / app_dal]
    DAL --> SQL[Comandos SQL private]
    SQL --> PG[(Supabase PostgreSQL)]
    RM --> PG

    WEB --> ST[Supabase Storage]
    WEB --> PAY[PaymentProvider]
    PAY --> WH[Webhook assinado]
    WH --> WEB

    W[Workers systemd] --> PG
    W --> EMAIL[Provider de e-mail]
    W --> PAY

    PG --> RLS[Constraints + grants + RLS]
    WEB --> LOG[Logs estruturados]
    BO --> LOG
    W --> LOG
```

## 2. Aplicações

### 2.1 Aplicação pública

Responsável por:

- conteúdo público;
- autenticação;
- área de locatário;
- área de dono;
- comandos de domínio;
- webhooks;
- read models SSR;
- upload assinado;
- health endpoints.

Não contém páginas ou bundles de backoffice.

### 2.2 Backoffice

Aplicação Next.js separada em `apps/backoffice`.

Responsável por:

- revisão;
- usuários;
- taxonomias;
- reservas;
- pagamentos/reembolsos/repasses;
- fiscal;
- saúde operacional;
- auditoria.

Tem:

- porta própria;
- domínio/subdomínio próprio;
- cookies e sessão próprios;
- acesso de rede restrito;
- secrets próprios;
- build/deploy independente.

### 2.3 Workers

Processos Node server-only geridos por systemd:

- `email-outbox-worker`;
- `booking-expiration-worker`;
- `payment-reconciliation-worker`;
- `payout-worker`;
- `maintenance-worker`.

Jobs usam locks no banco e são idempotentes. Uma segunda execução não duplica efeitos.

## 3. Estrutura de repositório alvo

```text
.
├── apps/
│   └── backoffice/
│       ├── src/app/
│       ├── src/lib/
│       ├── next.config.ts
│       └── package.json
├── packages/
│   ├── contracts/
│   │   ├── commands/
│   │   ├── read-models/
│   │   └── domain/
│   └── ui/
│       ├── components/
│       ├── tokens/
│       └── styles/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── commands/route.ts
│   │   │   ├── webhooks/payments/[provider]/route.ts
│   │   │   ├── health/live/route.ts
│   │   │   └── health/ready/route.ts
│   │   ├── (public)/
│   │   ├── (auth)/
│   │   ├── conta/
│   │   └── dono/
│   ├── components/
│   ├── domains/
│   └── lib/
│       ├── api/
│       ├── auth/
│       ├── queries/
│       ├── server/
│       └── supabase/
├── supabase/
│   ├── migrations/
│   ├── tests/
│   ├── seed.sql
│   └── schema.generated.sql
├── tests/
│   ├── e2e/
│   ├── integration/
│   └── helpers/
├── scripts/
├── docs/
└── package.json
```

## 4. Dependências

As dependências apontam para dentro:

```text
UI → contracts/query hooks
Route Handler → auth/validation/command handler
Command handler → DAL/provider adapter
DAL → funções SQL privadas
Read hook → read model/normalizer
Banco → invariantes do domínio
```

Proibido:

- componente importar `pg`;
- pacote UI importar domínio;
- banco depender de markup;
- provider externo definir estado de domínio diretamente;
- backoffice importar código de rota pública.

## 5. Contrato de leitura

### 5.1 Públicos

Read models públicos retornam somente estúdios publicados e campos aprovados. O browser usa chave pública e grants explícitos.

### 5.2 Privados

Read models autenticados filtram por `auth.uid()` e RLS. Backoffice usa DAL com função privada quando o dado não deve ser exposto pela Data API.

### 5.3 Formato

```ts
type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};
```

Read model:

- colunas explícitas;
- limite defensivo;
- cursor opaco;
- filtros server-side;
- DTO validado;
- nenhuma PII não necessária.

## 6. Contrato de escrita

### 6.1 Envelope

```ts
type CommandEnvelope<A extends string, P> = {
  action: A;
  payload: P;
  idempotencyKey?: string;
};
```

### 6.2 Resposta

```ts
type CommandResponse<T> =
  | { data: T; requestId: string }
  | {
      error: {
        code: string;
        message: string;
        requestId: string;
        fieldErrors?: Record<string, string>;
      };
    };
```

### 6.3 Pipeline

- `POST` apenas;
- JSON máximo 128 KB por padrão;
- origem/host;
- sessão;
- status de conta;
- rate limit;
- Zod;
- handler;
- DAL;
- SQL;
- log;
- invalidation map.

Arquivos usam upload assinado; iCal usa limite específico de 2 MB.

## 7. Supabase

### 7.1 Serviços

- Auth: e-mail/senha, confirmação e recuperação;
- PostgreSQL: domínio;
- Storage: fotos;
- Data API/RPC: read models deliberados;
- local CLI: desenvolvimento/CI.

### 7.2 Schemas

- `public`: entidades e read models deliberadamente expostos;
- `private`: comandos/helpers;
- `audit`: eventos operacionais, se separado;
- `auth` e `storage`: gerenciados.

### 7.3 Roles

- `anon`: leitura pública mínima;
- `authenticated`: leitura própria/pública;
- `app_dal`: execução de comandos privados;
- roles internas do Supabase conforme plataforma;
- service role somente em scripts administrativos explicitamente isolados, não no caminho normal.

## 8. Estado remoto

### 8.1 Query keys

```ts
const studioKeys = {
  list: (filters: StudioFilters, cursor?: string) =>
    ["studios", "list", stableFilterKey(filters), cursor ?? "first"] as const,
  detail: (studioId: string, date?: string) =>
    ["studios", "detail", studioId, date ?? "none"] as const,
  owner: (userId: string) => ["owner", userId, "studios"] as const,
};

const reservationKeys = {
  mine: (userId: string, filter: string, cursor?: string) =>
    ["reservations", "mine", userId, filter, cursor ?? "first"] as const,
};
```

### 8.2 Invalidação

Cada action declara domínios afetados. Exemplo:

| Action | Invalida |
|---|---|
| `studio.revision.update` | owner studio editor |
| `studio.review.approve` | public list/detail, owner status, review queue |
| `calendar.block.create` | availability, owner calendar, quote |
| `payment.confirm` | reservation, calendar, owner/renter lists, payments |
| `reservation.cancel` | reservation, calendar, payments, payouts |

## 9. Segurança em camadas

1. Nginx e firewall.
2. Sessão/cookie/origin.
3. Rate limit/body limit.
4. Zod.
5. handler e autorização.
6. role DAL restrita.
7. função SQL privada.
8. ownership.
9. constraints/locks.
10. RLS/grants.
11. auditoria/alerta.

## 10. Falhas e recuperação

### 10.1 Provider indisponível

- não confirmar pagamento;
- manter/expirar hold conforme estado;
- mostrar erro acionável;
- reconciliar depois;
- alertar quando limiar exceder.

### 10.2 Banco indisponível

- readiness falha;
- Nginx continua servindo erro controlado;
- nenhum provider call novo deve ocorrer sem capacidade de persistir idempotência.

### 10.3 Worker duplicado

- lock no banco;
- claim `for update skip locked`;
- idempotency key;
- efeito único.

### 10.4 Deploy falho

- health interno;
- smoke HTTPS;
- symlink anterior;
- restart;
- registro do rollback.

## 11. Portabilidade e escala

Não antecipar Kubernetes, Redis ou microserviços. Gatilhos:

- CPU/memória sustentadas;
- necessidade de múltiplas instâncias;
- fila de outbox com atraso;
- conexões saturadas;
- egress/mídia;
- latência de banco;
- indisponibilidade da VM incompatível com negócio.

Escala futura mantém contratos de comandos/read models e pode substituir runtime.
