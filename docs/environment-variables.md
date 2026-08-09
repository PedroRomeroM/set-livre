# Variáveis de ambiente

## 1. Regras

- apenas `NEXT_PUBLIC_*` entra no browser;
- nenhuma URL de banco privada no client;
- env separada por app/worker;
- validação Zod no boot;
- uma rota que depende de variável crítica falha fechada; `/ready` responde `503` quando `APP_RELEASE_SHA` é ausente/inválido ou o banco não está utilizável;
- logs mostram apenas nomes ausentes, nunca valores.

## 2. Fundação local

`.env.example` e `.env.e2e.example` contêm somente nomes e endpoints locais não secretos. `npm run supabase:reset` gera três arquivos ignorados com modo `0600`. Antes de alterar Docker ou banco, o bootstrap recusa destino existente que não seja arquivo regular e recusa diretório-pai simbólico. Cada conteúdo é gravado em arquivo temporário exclusivo no mesmo diretório, sincronizado e publicado por rename atômico; o destino nunca é aberto para escrita, portanto symlink e hard link não fazem o setup sobrescrever seu outro alvo.

Os arquivos `.env.local` da aplicação pública e do backoffice contêm somente runtime:

- `APP_ENV=local`;
- `APP_RELEASE_SHA=local`;
- `NEXT_PUBLIC_APP_URL` da respectiva aplicação, `NEXT_PUBLIC_SUPABASE_URL` e anon key local;
- `DATABASE_URL_APP_DAL`: login local sem herança e sem outra membership que assume explicitamente `app_dal` por `options=-c role=app_dal`;

O arquivo separado `.env.e2e.local`, lido apenas pelo harness, contém:

- `E2E_DATABASE_URL`: conexão administrativa local usada somente pelo guard/test tooling, nunca pelo runtime;
- `E2E_DATABASE_MARKER`: marcador efêmero comprovado por conexão antes da suíte;
- `E2E_BASE_URL`, `E2E_BACKOFFICE_URL`, Supabase local, DAL restrita e `E2E_ALLOW_LOCAL=1`.

O Playwright parseia o arquivo E2E sem incorporá-lo ao ambiente global, rejeita origem, host, protocolo, porta ou identidade divergentes e comprova banco, usuário e marcador local antes da suíte. Os filhos Next recebem `E2E_DATABASE_URL` vazio e seus `.env.local` nunca contêm a credencial administrativa. Cada processo de browser recebe separadamente apenas uma allowlist de paths, home/temporários, locale/fuso/terminal e integração gráfica local; credenciais, variáveis de banco, SSH, npm, loader e Snap são excluídas por construção. Senhas não entram em migration, log, screenshot ou arquivo versionado.

Durante a fronteira local-first, o smoke de release ignora `DATABASE_URL_APP_DAL` herdada do processo e usa somente a entrada do `.env.local` de cada app. Além do contrato de identidade, essa URL precisa usar loopback e a porta local `54322`; valor ausente, remoto ou divergente interrompe o smoke sem iniciar o runtime empacotado.

## 3. Aplicação pública

### Públicas

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_PAYMENT_PROVIDER_PUBLIC_KEY` somente se provider exigir
- `NEXT_PUBLIC_ENVIRONMENT` somente se uma UI futura realmente precisar expor esse estado; a fundação usa `APP_ENV` server-side

### Server-only

- `DATABASE_URL_APP_DAL`
- `SUPABASE_SERVICE_ROLE_KEY` somente para casos isolados aprovados; não no fluxo normal
- `PAYMENT_PROVIDER`
- `PAYMENT_PROVIDER_SECRET_KEY`
- `PAYMENT_WEBHOOK_SECRET`
- `EMAIL_PROVIDER`
- `EMAIL_FROM`
- `EMAIL_SECRET`
- `SENTRY_DSN` somente server-side; uma integração browser futura exige variável `NEXT_PUBLIC_*` distinta e aprovação de privacidade
- `REQUEST_ID_SECRET`
- `CURSOR_SIGNING_SECRET`
- `FIELD_ENCRYPTION_KEY`
- `APP_RELEASE_SHA`

`DATABASE_URL_APP_DAL` nunca aponta para `postgres`, `service_role` ou usuário proprietário. O parser exige protocolo PostgreSQL, login/senha/banco explícitos e exatamente um `options=-c role=app_dal`, permitindo parâmetros TLS sem aceitar overrides de identidade. Readiness também prova `current_user=app_dal`, identidade e atributos restritos do `session_user` e sua única membership antes de responder `200`. Em produção, a credencial de login/membership será provisionada fora das migrations e permanece bloqueada por PEND-002.

## 4. Backoffice

- `NEXT_PUBLIC_APP_URL` apontando para a origem do backoffice;
- `BACKOFFICE_APP_URL` server-side somente quando um consumidor real exigir;
- Supabase public/session;
- `DATABASE_URL_APP_DAL`;
- secrets necessários a ações admin server-only;
- `BACKOFFICE_ALLOWED_NETWORKS` quando implementado no app além do Nginx;
- `APP_RELEASE_SHA`.

Não compartilhar cookie name/domain com app público sem decisão.

## 5. Workers

- `DATABASE_URL_APP_DAL`;
- provider secrets;
- e-mail;
- Object Storage credentials;
- `WORKER_ID`;
- `APP_RELEASE_SHA`;
- intervalos/limites.

## 6. Deploy/CI

- host/user/key;
- known_hosts;
- Object Storage;
- migration DB URL;
- Supabase project refs;
- provider sandbox;
- Sentry auth token para sourcemaps.

## 7. Defaults não secretos

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

## 8. Rotação

Documentar owner, criado, último rotate, próximo rotate e impacto. Rotação de cursor/encryption precisa de key ring/versão, não troca destrutiva.
