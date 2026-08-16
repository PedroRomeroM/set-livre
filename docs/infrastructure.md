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
- adapter local determinístico quando `APP_ENV=local | test`, sem sandbox remoto;
- e-mail sink;
- único alvo de E2E destrutivo.

### Acceptance

- projeto Supabase separado;
- VM/serviço ativado sob demanda ou namespace isolado;
- provider sandbox somente como topologia alvo após revisão do ADR-018/PEND-004;
- dados sintéticos;
- não manter ocioso sem necessidade.

### Production

- Supabase dedicado;
- VM persistente;
- provider live somente como topologia alvo após contrato e integração aprovados;
- e-mail live;
- domínio/TLS;
- backups;
- alertas.

Credenciais nunca são compartilhadas.

No código implementado nesta etapa, `recipientOnboardingCapability` é derivada server-side por request. `APP_ENV=local | test` produz `local_adapter`; `development | production`, valor ausente ou inválido produzem `unavailable`. Nesses runtimes, recebimentos permanece somente para consulta e start/refresh falham com `503 PAYMENT_PROVIDER_UNAVAILABLE` antes de `prepare`. A tabela acima descreve a topologia final desejada para Acceptance/Production; não afirma sandbox ou provider live já integrados.

A ativação possui capability própria e não é readiness de infraestrutura. Contrato `approved` produz `ownerActivationCapability=available`; `local_fixture` fica disponível somente em `local | test` e consultivo em `development | production`, ambiente ausente ou inválido. Nesses casos, a leitura completa permanece acessível, mas `owner.activate` retorna `503 SERVICE_UNAVAILABLE` antes da escrita. Não há nova variável, migration, serviço externo ou dependência de `/ready`; PEND-006 continua sendo o bloqueio do conteúdo jurídico aprovado.

## 3. Oracle Cloud

### 3.1 Shape

Default: `VM.Standard.A1.Flex` ARM64 dentro da elegibilidade Always Free da tenancy/região. Dimensionamento de referência: 2 OCPUs e 12 GB, sujeito à disponibilidade e limites atuais da conta.

Sistema: Ubuntu LTS ARM64 mínimo.

O discovery read-only de 2026-08-16 comprovou `sa-saopaulo-1` como home region, uma AD, shape A1 Flex e imagem Ubuntu 24.04 Minimal ARM64. Os limites informaram A1 sem uso, mas quota não comprova capacidade física nem gratuidade do launch. As redes encontradas pertencem a Spenses/outro projeto e foram recusadas. O target isolado é um novo compartment `SetLivre`, VCN `10.20.0.0/16`, subnet regional `10.20.1.0/24`, NSG com 80/443 públicos e 22 somente do `/32` administrativo, A1 2 OCPUs/12 GB, boot 50 GB e IMDSv2-only. A definição não equivale a recurso criado; PEND-003 continua aberta até inventário, custo zero, hardening e smoke.

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
│   ├── runtime/          # env root:setlivre 0640, instalado fora do artifact
│   └── RELEASE.md
├── current -> releases/<sha>
├── previous -> releases/<sha>
└── shared/runtime/
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

O patch local do terceiro P2 passou em gates estáticos, 42/42 unitários focados, 718/718 integrais, 358/358 pgTAP no head `20260815000100` e browser corrigido 114/114. Seu build foi executado exatamente uma vez, terminou com exit `0`, 26 rotas web, quatro do backoffice e zero warning; log SHA-256 `8677b868a632e0891499c8450e5c926ddefcde7e27c5d31f9adcb55e27bbfaa2`. O smoke customizado daquele snapshot também terminou com exit `0` em 2,4 segundos: três probes guest `401` com UUID, dois redirects exatos, 14 nonces web, 11 backoffice, banco/Mailpit `0 → 0`, privacidade e cleanup verdes. SHA-256: stdout `399d3b41dd9d161bdd86288c53e5bf821279285eb4772740c9ff5169845e5abd`, server log `e3c376cdc9403d2739ea8f127244fef193ea0ad4689694fec5c8a097d5ee025b` e resumo `25262fb6efbf93a0a654a16171bc4f6998000ef0078b9d91e40a06beefe79450`. Esses resultados são históricos para o delta de capability.

A release canônica local do terceiro P2 foi gerada e auditada para o commit funcional `2a86acc4dc3a005213d5f22384084e3aba0160be`. O archive possui 24.903.588 bytes e SHA-256 `0e0c07f41d4a44f0673ce7a5013084942100e8baab1ba72ee6aeea6496be1566`; o sidecar, 124 bytes e SHA-256 `1136df426039335971d515497ce8974dcb25ee583f3764d5c33f9ea1f76ca0ab`; o manifesto, 681.529 bytes e SHA-256 `d3bfb5a5c517edab1004bde6eaf04c7f080c3036c94defbbfa1b82fad44d4d44`; e o log, 2.099 bytes e SHA-256 `e7edaa919daa3b3ed4cd6cf1588c044d2a6efcf1ae84e9877edd5fa42062371e`. A árvore manifestada soma 2.870 artefatos — web 1.577, backoffice 1.276, migrations 15, lockfile 1 e manifesto 1 —, enquanto o tar soma 3.454 membros — 584 diretórios, 2.868 arquivos e dois links seguros. Os `BUILD_ID` dos dois apps equivalem ao commit. O head empacotado é `20260815000100`, com prefixo SHA-256 `ca995243...`; o lockfile possui prefixo SHA-256 `485ec8e7...`. Em Linux x64 com Node 24.18/npm 11.19, smoke embutido, varreduras de secrets/PII e cleanup final ficaram verdes, e duas auditorias independentes terminaram `NO-BLOCKER`. A captura remota de `2026-08-15T19:38:32Z` verificou publicação até `dda95b3b9108930489a3b10275ef41c2f203ae24`, resposta/resolução e zero threads não resolvidas. Essa prova é histórica para a capability, não equivale a ARM64 ou produção, e PEND-003/smoke ARM64 nativo continuam obrigatórios.

No quarto P2, o fechamento estático (734/734 unitários), o banco 358/358 e o browser 23/23 + 114/114 passaram. Um único build de validação terminou com exit `0`, 26 rotas web, quatro do backoffice e `BUILD_ID=local`; log SHA-256 `ca7d5c3e98449ea03a4cedbc567d93f989db7dbfdac854ea1a19f40f0c26b0b3`. O smoke customizado não é evidência verde. A tentativa 1 foi recusada por um oráculo que tratou tombstone segura de cookie como violação; a tentativa 2 terminou com exit `1` apesar de cumprir o contrato completo — três boundaries, dois redirects, 14/11 nonces, 15 relações e Mailpit em zero —, porque o postcheck produziu um falso positivo contra o shell pai; a tentativa 3 foi recusada antes dos probes porque o parser não aceitava `pgrp=0`. O cleanup terminou em zero nas três; nenhuma tentativa customizada é apresentada como aprovada.

O gerador canônico processou exatamente uma vez o commit funcional `969f30cd0f34b7e36e2a21550b5e3f28f8709406`, terminou com exit `0` em 21,15 segundos e gerou a release local do quarto P2. Archive/sidecar/manifesto/log possuem 24.904.533/124/681.762/2.102 bytes e SHA-256 `d5f544bff8b72314060535333cd2c300a4c56a4e35295c1471beec5ee41cfeeb`/`f3441aee4c9d6758a539b2be2b3b325805bd6d977ad2cf915619bfbb9cd4d8d3`/`bc13a94c4084abc46bab677d1115871cb1327d7d17172b982b886c35eb200ada`/`5be766c1c967ab7840335c120f2918ff555770efd69544f164023c32378456e7`. A árvore soma 2.871 artefatos — web 1.578, backoffice 1.276, migrations 15, lockfile 1 e manifesto 1 —; o tar soma 3.455 membros — 584 diretórios, 2.869 arquivos e dois links seguros. Os dois `BUILD_ID` equivalem ao commit. Smoke embutido, secrets, paridade e cleanup ficaram verdes, e duas auditorias independentes terminaram `NO-BLOCKER`. Essa é prova histórica local Linux x64, não ARM64 ou produção; PEND-003 permanece pendente. O push até `e51ab6f...` publicou o funcional `969f30cd...` e a documentação/evidência da release canônica local. O archive permaneceu local e ignorado pelo Git; não houve publicação em GitHub Release. O body do PR foi atualizado naquela fotografia. O quinto review ocorreu depois; seu estado atual é registrado no parágrafo seguinte, e publicação, resposta, resolução e novo review pós-correção continuam pendentes.

No quinto P2, uma única invocação `APP_RELEASE_SHA=local npm run build` sob Node 24/npm 11 terminou com exit `0`, 26 rotas web, quatro do backoffice, zero warning e `BUILD_ID=local`; o log privado tem SHA-256 `3b03b8f64e70dcf29e713f8b6ab006f4a544e43fd761ce0eb8b283eac9de432c`. O artefato não foi aprovado: o standalone copiou o `package.json` raiz, cujo `scripts.knip` continha strings de conexão administrativas/DAL locais. Nenhum smoke foi iniciado. O patch reduz o script a `knip`, deixa o config obter os valores do `.env.e2e.local` físico e adiciona uma unidade que recusa URLs de banco nos scripts npm dos quatro manifests canônicos — raiz, backoffice, contracts e UI. Prettier/ESLint direcionados, 4/4 unitários, Knip com as sete variáveis E2E explicitamente unset e diff-check passaram; o lockfile não mudou. A execução pós-manifesto que testou esse fix está registrada abaixo; naquele boundary, a release local nova, ARM64 e qualquer operação remota ainda permaneciam pendentes.

A build pós-manifesto seguinte terminou uma única vez com exit `0`; o log privado tem SHA-256 `d8e50e0fb0b7080bf021aa910bef7ededc6677ba6dfaa71d4789a1d6226e1a8e`. O audit encontrou uma ocorrência DAL em cada `.next/cache` Turbopack; standalone, static e log ficaram limpos, mas o gate foi recusado e o smoke permaneceu em zero. `scripts/next-build.mjs` é o wrapper único dos dois package scripts e de `release-manifest.mjs`, que fornece ambiente allowlisted. Dentro da operação primária, `resolveTrustedNextCliLaunch` valida ancestrais físicos/protegidos do manifesto do app, Node/npm e pacote/binário/versão Next antes do spawn; o wrapper tenta sempre remover fisicamente somente o cache correspondente, inclusive em falha da validação/build. Cleanup falho reprova, falha dupla vira `AggregateError`, standalone/static são preservados e raízes/ancestrais simbólicos ou externos são recusados sem spawn/travessia. No preview, o supervisor pai executa `cleanupBuild` depois do grupo de build e antes de validação/servidor em todos os desfechos; cleanup falho bloqueia o start, falha dupla é agregada e cache persistente reprova. O run direcionado final passou em 40/40 por quatro arquivos — 12 de cache/wrapper, quatro do npm confiável, 16 de Next/local server e oito do supervisor de preview —, com ESLint zero, checks Node, Knip env-unset e diff-check.

A cadeia estática final única passou em 764/764 testes por 76 arquivos sob Node 24/npm 11, com npm ci 447/451/zero vulnerabilidades, cinco typechecks, docs 34/200/18, audit zero, Knip/diff-check e freeze 53/34/19. Depois de remover fisicamente os dois `.next`, a build final via wrapper foi executada exatamente uma vez: exit `0` em 14,733 s; log privado `.artifacts/p5-owner-activation-capability-build-smoke-cache-clean/build.log`, 2.155 bytes/SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. A auditoria independente `build.audit.json`, SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d`, terminou `NO-BLOCKER`: 26 + 4 rotas, zero warnings, quatro `BUILD_ID=local`, caches/retired zero, árvores e privacidade verdes, DB 15/legal 3/dblink/Mailpit/portas/processos zero. Esse era o fechamento pré-release.

O gerador canônico executou exatamente uma vez para `2045d1a00c15889007b3c5c04c08d0467fc3d9b3`, exit `0` em 21,26 s, e aprovou o primeiro smoke P5 embutido antes da publicação local. O archive `0600` tem 24.896.963 bytes/SHA-256 `282f9d173eebf99ba63466d81f4aa4b9061e7d73668c267fb0a25e9e86043b92`; sidecar/manifesto/log, 124/681.762/2.097 bytes e hashes `8955c004...`/`d8b698ec...`/`505a5fd9...`. São 2.871 artefatos e 3.455 membros, com dois symlinks internos e `BUILD_ID` iguais ao commit. Duas auditorias `NO-BLOCKER` validaram live/manifest/tar sem mismatch e cleanup zero. Release somente local Linux x64, ignorada/não publicada; ARM64/Oracle/PEND-003 e remoto seguem pendentes.

O build histórico foi executado uma única vez em Node 24: `npm run build` terminou com exit `0`, sem warnings; log SHA-256 `db0d0049b248dd7b3d438d57ffa0faa465d3cd7a15a9bdd0d6267dc11a4ac162`.

A release canônica local histórica foi gerada uma única vez para o commit funcional `440c81f6cc44cc95ed281d84e9a5124ae98a59c4`, com exit `0` e log SHA-256 `be9e2e2d0d1d2a4db78593c03858c183f93b3ed336bd820d3ce9d64c08ec1ba4`. O archive possui 14 migrations/head `20260812000200`; tar, sidecar, smoke embutido, segurança, buscas de secrets/PII e cleanup ficaram verdes naquele snapshot. Ele não contém `20260815000100`, não valida o patch atual e tampouco equivale a ARM64/produção.

As releases `c115dcd726929f289777cd897cccc97d33a179ee`, `79376b62bdce788c9eb7e1f1696d5acfde0cb215` e `440c81f6...` são históricas diante do patch local atual. Nenhuma fotografia comprova ARM64 ou produção. PEND-003 e o smoke ARM64 nativo permanecem obrigatórios.

O smoke runtime histórico, padrão mais FEAT-004, terminou com exit `0`; resumo SHA-256 `a8d41974344ba6eb3b6cb83d626e4b77e9853a2d98e58814d9c795cca356ad0b`, stdout `e15829cc6525d58cab4fa2ed49c33d9e5d6225512b77ec96a21fa2ea3b9703dba` e server log redigido SHA-256 `7ea7719b4af0257044c24c32f252f9327920a069d74b31cac25d3f23d8f089c5`. Esse run não inclui a migration atual.

A primeira tentativa do runner temporário foi recusada antes de spawn porque consultava `profile_preferences` em vez de `user_preferences`; log SHA-256 `9757fbc1baf5afcffc4840468f7f7af5c7c1677a924997184376617b8752e2db`. Não houve servidor, request ou temporário residual. A correção alterou somente o harness e foi seguida pela única execução real verde.

Duas tentativas customizadas foram recusadas pelo harness antes de spawn, servidor ou request: a primeira por `E2E_BASE_URL` pública e a segunda pela ocorrência rastreada de `E2E_DATABASE_URL` em `package.json`. O scanner final path-aware/canônico passou e reconheceu a URL administrativa E2E somente na ocorrência exata esperada do `package.json`; os rejects não são runs de smoke.

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
EnvironmentFile=/opt/setlivre/current/runtime/web.env
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

`.github/workflows/ci.yaml` materializa essa ordem em `ubuntu-24.04`, com actions pinadas por SHA, Node `24.18.0`, npm `11.19.0` e PostgreSQL client `18.4`. PR e `push` de `main` usam somente Supabase local/Docker; PR não recebe secret cloud. O PR executa `test:e2e:affected` — conservadoramente integral enquanto não houver seletor seguro — e `main` executa `test:e2e`. O workflow ainda precisa de primeiro run real e proteção de branch; sua existência em fonte não fecha PEND-001.

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

O workflow `.github/workflows/prd-deploy.yaml` é elegível somente após conclusão verde do workflow `CI` disparado por `push` de `main`, head repository igual, SHA completo e `PRD_DEPLOY_ENABLED=true`. Ele exige environment GitHub `production`, runner `ubuntu-24.04-arm`, ref Supabase fixa `klzxatkgiiznymzuzadd`, executa `supabase db push --dry-run` antes do push, prova a identidade `app_dal`/runtime e então transfere por SSH uma release web+backoffice+migrations com checksum. Não chama seed, reset, `config push`, Docker remoto ou service role no runtime. A troca de `current` ocorre somente no host preparado pelo contrato do ADR-014 e health falho restaura a aplicação anterior quando existe. Migrations permanecem forward-only.

Secrets são escopados por etapa e o checkout não persiste credenciais. O artefato é construído sem URL administrativa/DAL no ambiente de build; runtime entra depois em arquivos root-owned. O workflow não foi executado no GitHub e não comprova hoje runner ARM64, environment, SSH, Supabase Cloud ou host. Os nomes e passos humanos canônicos estão em `configuration-seteps.md`.

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

O único projeto Cloud comprovadamente criado nesta rodada é `set-livre`, ref `klzxatkgiiznymzuzadd`. Ele não é tratado como pronto: OAuth/MCP, Auth URLs/templates, senha, login `app_runtime_prod`, ACLs gerenciadas, backups e secrets GitHub ainda precisam da checklist. `supabase/config.toml` contém portas/URLs locais e nunca é enviado por `config push`; produção recebe somente migrations versionadas. Acceptance separado continua pendente quando necessário e testes destrutivos permanecem exclusivamente locais.

Acceptance e produção também precisam fixar a expiração do JWT Auth em exatamente `3600` segundos antes de receber tráfego. A binding/tombstone de recovery deriva sua retenção do `exp` assinado, e as funções privadas de emissão/inspeção e o readiness falham fechado quando `app.settings.jwt_exp` diverge. Alterar essa duração exige adaptar primeiro o contrato de retenção e seus testes; PEND-002 continua bloqueando a prova correspondente no Supabase Cloud.

O custo do Supabase e providers não está coberto pela VM gratuita.

## 16. Snapshot FEAT-006

FEAT-006 está em implementação local-first. O último reset/generate/test DB autorizado pertence ao
head anterior de 16 migrations, `20260816000100`, e passou uma vez em 431 asserts
(`158 + 78 + 57 + 65 + 73`), readiness `true`/predecessor `false`, DAL 20 dependências/19 rotinas,
quatro fixtures locais e cleanup zero. A fonte possui agora 17 migrations e head/readiness
`20260816000200`, com predecessor imediato `20260816000100` esperado falso e o mesmo manifesto. A
última cadeia estática integral canônica, anterior aos helpers/hardenings finais, passou em
Node24/npm11 com 85
arquivos/893 unitários. O recorte dirigido anterior executou 124/124 em dez arquivos; o atual passou
em 141/141 por 12 arquivos FEAT-006/studio sob Node 24, incluindo correlação e remount. Nenhum é
integral. A tentativa da suíte unitária completa falhou em 12 testes de infraestrutura por limites
do sandbox — nested spawn `EPERM`, remapeamento de ownership raiz e timeouts de process group ou
stdout vazio — e não constitui gate verde.

O pgTAP atual declara 83 casos da feature e total esperado 441, ainda sem reset/rerun. A migration
`00200` recebeu somente inspeção estática/diff neste ambiente; `schema.generated.sql` e
`database.generated.ts` estão stale. Reset, `supabase:generate`, `test:db` e diff dos gerados são
obrigatórios. Assim, 431 continua sendo o último DB verde e 441 é apenas expectativa.

No Next.js 16.3, `cleanDistDir` preserva `cache`, `dev`, `lock` e `trace`. O cleanup pós-build
genérico remove fisicamente apenas `<app>/.next/cache`, tanto em sucesso quanto em falha, e deixa
`<app>/.next/dev` intacto: essa árvore pode pertencer a um `next dev` concorrente e não pode ser
apagada sem exclusão mútua confiável. O alvo e seus ancestrais são revalidados; symlink ou mount
falham fechado sem travessia. `BUILD_ID`, `standalone` e `static` não são removidos. O preview local
e o fluxo de release, em boundary quiescente próprio, continuam responsáveis pelo preclean físico
da árvore `.next` inteira quando aplicável. O teste direcionado `remove-next-build-cache` passou em
12/12; essa prova é isolada e não torna a suíte unitária integral verde.

O browser focado passou historicamente em 17/17 por duas specs/sete projetos, com privacidade e
cleanup verdes. A coleta integral histórica enumerou 131 testes em 19 specs/16 projetos, sem run
verde. A fonte atual projeta 20 execuções por três specs/dez projetos e 134 na integral; nenhuma foi
executada porque o sandbox bloqueia localhost. Build final das duas apps, smoke, release, remoto e
ARM64/PEND-003 permanecem pendentes. A prova histórica é Linux x64 e não representa produção.

Após preclean físico dos dois `.next`, uma única invocação `APP_RELEASE_SHA=local npm run build`
sob Node 24/npm 11 compilou a etapa web em 3,9 s e foi rejeitada em
`Could not parse output from TypeScript's --showConfig`; o backoffice não iniciou e smoke ficou em
zero. O diagnóstico independente executou `tsc --showConfig` diretamente com exit `0` e repetiu o
spawn exato com stdout/stderr em pipe, também exit `0`, mas ambos os buffers tiveram length zero no
sandbox. A classificação é rejeição de harness/sandbox, não falha de produto nem build verde.

O log privado possui 449 bytes, modo `0600` e SHA-256
`0f614f806016737ae887529df0ed728dab3d4b3d62da13b12010925facb6cf68`; `next-env`, lockfile e
ausência de caches permaneceram canônicos. O build final das duas apps continua pendente. O
`docs:check` atual também é inconclusivo porque o pipe de `git hash-object --stdin` não produziu
saída no sandbox; a prova canônica anterior não é promovida para este snapshot.

Os contratos atuais de probe dirty/pending, latch de unmount/pós-`await`, recuperação A/B e reflow
não adicionam serviço, variável, cache distribuído ou dependência externa. Permanecem estritamente
no app local e não alteram readiness: o manifesto corrente continua 20 dependências/19 rotinas.
