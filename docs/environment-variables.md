# Variáveis de ambiente

## 1. Regras

- apenas `NEXT_PUBLIC_*` entra no browser;
- nenhuma URL de banco privada no client;
- env separada por app/worker;
- validação Zod no boot;
- startup falha com variável crítica ausente;
- logs mostram apenas nomes ausentes, nunca valores.

## 2. Aplicação pública

### Públicas

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_PAYMENT_PROVIDER_PUBLIC_KEY` somente se provider exigir
- `NEXT_PUBLIC_ENVIRONMENT`

### Server-only

- `DATABASE_URL_APP_DAL`
- `SUPABASE_SERVICE_ROLE_KEY` somente para casos isolados aprovados; não no fluxo normal
- `PAYMENT_PROVIDER`
- `PAYMENT_PROVIDER_SECRET_KEY`
- `PAYMENT_WEBHOOK_SECRET`
- `EMAIL_PROVIDER`
- `EMAIL_FROM`
- `EMAIL_SECRET`
- `SENTRY_DSN` server e public conforme configuração
- `REQUEST_ID_SECRET`
- `CURSOR_SIGNING_SECRET`
- `FIELD_ENCRYPTION_KEY`
- `APP_RELEASE_SHA`

## 3. Backoffice

- `BACKOFFICE_APP_URL`
- Supabase public/session;
- `DATABASE_URL_APP_DAL`;
- secrets necessários a ações admin server-only;
- `BACKOFFICE_ALLOWED_NETWORKS` quando implementado no app além do Nginx;
- `APP_RELEASE_SHA`.

Não compartilhar cookie name/domain com app público sem decisão.

## 4. Workers

- `DATABASE_URL_APP_DAL`;
- provider secrets;
- e-mail;
- Object Storage credentials;
- `WORKER_ID`;
- `APP_RELEASE_SHA`;
- intervalos/limites.

## 5. Deploy/CI

- host/user/key;
- known_hosts;
- Object Storage;
- migration DB URL;
- Supabase project refs;
- provider sandbox;
- Sentry auth token para sourcemaps.

## 6. Defaults não secretos

- `APP_TIMEZONE=America/Sao_Paulo`;
- `BOOKING_HORIZON_DAYS=365`;
- `CARD_HOLD_MINUTES=15`;
- `PIX_DEFAULT_EXPIRY_MINUTES=15`;
- `PAYOUT_DELAY_HOURS=24`;
- `REMINDER_LEAD_HOURS=24`;
- `PUBLIC_PAGE_SIZE=24`;
- `ADMIN_PAGE_SIZE=50`;
- `MAX_STUDIO_PHOTOS=20`;
- `MAX_PHOTO_BYTES=15728640`;
- `MAX_ICAL_BYTES=2097152`.

Defaults de negócio idealmente ficam em configuração versionada; env é aceitável para global operacional.

## 7. Rotação

Documentar owner, criado, último rotate, próximo rotate e impacto. Rotação de cursor/encryption precisa de key ring/versão, não troca destrutiva.
