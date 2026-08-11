# Infraestrutura, ambientes e deploy

## 1. Topologia

```mermaid
flowchart TB
    DNS[DNS] --> OCI[Oracle Cloud VM ARM64]
    OCI --> FW[VCN + Firewall]
    FW --> NG[Nginx :80/:443]
    NG --> WEB[setlivre-web :3000]
    NG --> BO[setlivre-backoffice :3001]
    OCI --> WK[Workers systemd]

    WEB --> SB[Supabase Cloud]
    BO --> SB
    WK --> SB

    WEB --> PAY[Gateway]
    WK --> PAY
    WK --> MAIL[E-mail]
    OCI --> OBJ[OCI Object Storage backups]
    CI[GitHub Actions ARM64] --> OCI
```

## 2. Ambientes

### Local

- Supabase CLI + Docker;
- app público e backoffice;
- provider fake/sandbox;
- e-mail sink;
- único alvo de E2E destrutivo.

### Acceptance

- projeto Supabase separado;
- VM/serviço ativado sob demanda ou namespace isolado;
- provider sandbox;
- dados sintéticos;
- não manter ocioso sem necessidade.

### Production

- Supabase dedicado;
- VM persistente;
- provider live;
- e-mail live;
- domínio/TLS;
- backups;
- alertas.

Credenciais nunca são compartilhadas.

## 3. Oracle Cloud

### 3.1 Shape

Default: `VM.Standard.A1.Flex` ARM64 dentro da elegibilidade Always Free da tenancy/região. Dimensionamento de referência: 2 OCPUs e 12 GB, sujeito à disponibilidade e limites atuais da conta.

Sistema: Ubuntu LTS ARM64 mínimo.

### 3.2 Disco

- volume boot com margem para três releases, logs e build;
- aplicação não guarda mídia canônica;
- journald com limite;
- releases antigas limpas após retenção;
- alerta a 70/85/95%.

### 3.3 Rede

Expor:

- 80/TCP para redirecionamento/certificado;
- 443/TCP;
- 22/TCP somente de IP/VPN administrativa.

Portas 3000/3001/worker somente loopback. Backoffice pode usar subdomínio com allowlist/VPN.

## 4. Usuários e diretórios

```text
/opt/setlivre/
├── releases/<sha>/
│   ├── web/
│   ├── backoffice/
│   ├── workers/
│   └── RELEASE.md
├── current -> releases/<sha>
├── previous -> releases/<sha>
└── shared/
    ├── web.env
    ├── backoffice.env
    ├── worker.env
    └── runtime/
```

Usuário `setlivre` sem sudo executa serviços. Deploy user só escreve releases e troca symlinks via script restrito.

## 5. Build

- Next `output: "standalone"`;
- CI release em Linux ARM64;
- `npm ci`;
- gates;
- build público/backoffice/workers;
- copiar `.next/standalone`, `.next/static`, `public`;
- manifest com SHA, Node, lock hash e migration head;
- tar comprimido;
- checksum;
- artifact assinado/protegido quando disponível.

Não usar GHCR.

Na fundação local, `node scripts/release-manifest.mjs` já recompila um checkout limpo com ambientes isolados por app e `BUILD_ID` igual ao SHA, empacota os dois entrypoints com static/public, migrations e lockfile, recusa raiz de artefatos simbólica, montada ou fora do repositório, configuração local, secret incorporado e link externo, e revalida a árvore completa após o smoke. Antes de qualquer `chmod`, lock ou build, o preflight Linux consulta o `mountinfo` do próprio namespace; toda árvore antiga ou candidata passa por inspeção física completa, recusa mount na raiz ou abaixo, é retirada por rename atômico e só então removida após nova comprovação de identidade, forma e mounts. Assim, bind mounts e volumes esquecidos não são atravessados por limpeza recursiva; fora do Linux, uma árvore preexistente exige remoção manual. A entrada direta deriva a versão npm do manifesto da instalação adjacente ao Node atual, validada contra `packageManager`/`devEngines` antes do primeiro build, sem `npm.cmd`, shell ou resolução por `PATH`. Um lock advisory de kernel, mantido por descritor com `util-linux flock`, serializa toda a geração por checkout antes de qualquer build ou temporário compartilhado e é liberado automaticamente ao encerrar o processo. Cada `.env.local` é obrigatório, físico, exclusivo e `0600`; o script o abre sem seguir links, mantém o descritor até terminar a leitura e revalida identidade e modo antes de interpretar o runtime local exato. O readiness empacotado usa somente a URL DAL desse arquivo, validada para o host IPv4 escrito literalmente como `127.0.0.1` e a porta Supabase local, sem aceitar alias, representação alternativa ou override exportado pelo host. Os handlers de interrupção são instalados antes do primeiro spawn; em POSIX, `SIGHUP` encerra ambos os PGIDs detached, elimina descendentes remanescentes e preserva código `129`. O tar usa ordem, ownership, timestamp e modos determinísticos (`0755` para diretórios/executáveis e `0644` para os demais arquivos, sempre removendo `setuid`, `setgid` e `sticky`), é reextraído e comparado à árvore manifestada; um SHA existente nunca é sobrescrito por bytes divergentes. O artefato registra `platform`/`arch`; ele não é apresentado como ARM64 até o smoke real de PEND-003.

## 6. systemd

Serviços:

- `setlivre-web.service`;
- `setlivre-backoffice.service`;
- `setlivre-email-worker.service`;
- timers para expiração/reconciliação/payout/backup, ou workers persistentes conforme implementação.

Baseline de unit:

```ini
[Service]
User=setlivre
WorkingDirectory=/opt/setlivre/current/web
EnvironmentFile=/opt/setlivre/shared/web.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/setlivre/shared/runtime
MemoryMax=2G
TasksMax=256
```

Ajustar paths necessários; não copiar unit sem testar.

## 7. Nginx

Responsabilidades:

- TLS;
- redirect HTTP→HTTPS;
- reverse proxy;
- request/body limits;
- timeouts;
- headers;
- compressão;
- cache de estáticos;
- logs;
- rate limiting de borda quando útil.

Para liberar as rotas Auth em produção, o bloco Nginx precisa preservar o `Host` público exato e substituir — nunca anexar — `X-Forwarded-Host`, `X-Forwarded-Proto=https` e `X-Forwarded-For` pelo host, protocolo e endereço remoto canônicos recebidos na borda. O app recusa qualquer divergência e aplica o bucket pré-Zod por ação/IP. A camada interna preserva buckets exatos vivos e, quando satura, usa overflow sticky e conservador por ação; ela continua restrita ao processo e não absorve sozinha um ataque distribuído. O limiter Nginx permanece obrigatório para impedir que tráfego hostil alcance o processo Node. Essa prova integra o critério externo de PEND-003 e não é simulada pelo loopback local.

Rotas:

- `www/setlivre` → 3000;
- `ops` → 3001 + restrição;
- `/api/webhooks` com body limit específico e sem cache;
- `/_next/static` cache longo com hash.

Não cachear resposta autenticada ou checkout.

A CSP de HTML nasce no Proxy de cada app, antes da renderização, porque o nonce precisa existir simultaneamente no request interno, no header da response e nos scripts emitidos pelo Next. O matcher não confia em headers de prefetch, prefixos parecidos com rotas reservadas nem no pressuposto de que toda resposta sob `/_next/static/` será um asset: o Proxy também cobre esse namespace para proteger os erros HTML que o framework pode produzir, sem alterar o `Cache-Control` imutável dos arquivos válidos. Os root layouts chamam `connection()` deliberadamente: toda rota HTML abaixo deles é dinâmica, recebe nonce novo e `Cache-Control` privado sem armazenamento, portanto não usa geração estática, ISR, PPR ou cache de HTML em CDN. O fallback global é um HTML mínimo, sem scripts e com `no-store`, para não reutilizar o documento estático interno do framework. Esse custo de render por request é aceito pela baseline de segurança e deve ser medido antes de qualquer mudança; Nginx preserva a CSP da aplicação e continua cacheando somente assets imutáveis `/_next/static`.

## 8. TLS

- Certbot/ACME;
- renovação systemd timer;
- alerta de expiração;
- HSTS somente após validar subdomínios;
- TLS moderno.

## 9. CI de pull request

1. checkout action por SHA;
2. setup Node;
3. `npm ci`;
4. format;
5. lint;
6. typecheck;
7. unit;
8. Supabase start/reset;
9. DB/RLS guards;
10. docs check;
11. build das duas apps;
12. Playwright affected;
13. audit;
14. Knip;
15. artifacts de falha.

## 10. Release

1. merge em main;
2. suíte completa;
3. build ARM64;
4. gerar artifact/checksum;
5. upload para `/opt/setlivre/releases/<sha>.incoming`;
6. verificar checksum;
7. extrair em diretório novo;
8. validar env e versão;
9. aplicar migrations com lock;
10. apontar `previous`;
11. trocar `current` atomicamente;
12. daemon-reload se necessário;
13. restart workers/backoffice/web;
14. health interno;
15. smoke HTTPS;
16. registrar release.

## 11. Rollback

Se health/smoke falhar:

1. trocar `current` para `previous`;
2. restart;
3. smoke;
4. registrar incidente;
5. não reverter migration destrutiva automaticamente.

Migrations usam expand/migrate/contract para compatibilidade entre release atual/anterior.

## 12. Secrets

Separados:

- web public/server;
- backoffice;
- workers;
- CI deploy.

Permissões 600. Rotação e owner documentados. Não ecoar em scripts.

## 13. Jobs

### Expiração

Cada minuto.

### Reconciliação

A cada 2 minutos ou worker contínuo com backoff.

### Payout

A cada 10 minutos.

### E-mail

Contínuo/intervalo curto.

### Backup

Diário em horário de menor uso.

Todos usam locks e métricas.

## 14. Capacidade e gatilhos

A VM free tier é baseline, não promessa de escala.

Migrar/expandir quando:

- CPU p95 > 70% por 15 min recorrente;
- memória > 80%;
- swap;
- event loop lag;
- fila > SLO;
- deploy impacta runtime;
- necessidade de alta disponibilidade;
- backoffice disputa recursos;
- tráfego supera egress;
- Oracle reclaim/availability incompatível.

## 15. Supabase em produção

Para fotos e operação comercial, o plano gratuito pode ser insuficiente. Produção deve revisar:

- storage;
- egress;
- database size;
- backups;
- Auth MAU;
- image transformation;
- SLA/suporte.

Acceptance e produção também precisam fixar a expiração do JWT Auth em exatamente `3600` segundos antes de receber tráfego. A binding/tombstone de recovery deriva sua retenção do `exp` assinado, e as funções privadas de emissão/inspeção e o readiness falham fechado quando `app.settings.jwt_exp` diverge. Alterar essa duração exige adaptar primeiro o contrato de retenção e seus testes; PEND-002 continua bloqueando a prova correspondente no Supabase Cloud.

O custo do Supabase e providers não está coberto pela VM gratuita.
