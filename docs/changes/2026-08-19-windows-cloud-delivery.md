# Mudança — ambiente Windows e entrega cloud controlada

Data: 2026-08-19
Status: em validação; produção ainda não publicada

## Objetivo

Consolidar o desenvolvimento nativo no Windows e preparar CI/CD para Supabase Cloud e uma VM Oracle Cloud `VM.Standard.E2.1.Micro` Always Free, sem carregar adaptações provisórias do ambiente Linux nem declarar recursos externos antes de comprová-los.

## Alterações

- adiciona contratos nativos de filesystem, supervisão por Windows Job Object e Docker Desktop/Supabase local com port binding oficial `Localhost only`;
- serializa toda operação destrutiva ou administrativa do Supabase local com mutex de kernel host-global no Windows e `flock` por descritor/inode estável no Linux, adquiridos antes de qualquer inspeção do Docker e recuperáveis após crash sem lockfile stale ou PID heurístico;
- mantém a compatibilidade Linux somente nas superfícies necessárias ao runner GitHub e ao host Oracle, em implementações próprias e testadas;
- substitui os workflows copiados de outro projeto por CI Node 24/npm 11 e deploy fail-closed específico do Set Livre;
- adiciona provisionamento OCI idempotente e estrito para `VM.Standard.E2.1.Micro`, Ubuntu 24.04 x86_64, rede dedicada, NSG mínimo e IMDSv2;
- adiciona bootstrap, deploy, rollback, smoke e manifesto de release específicos da VM, com secrets entregues por credencial do systemd em vez de ambiente persistente da unidade;
- vincula recovery ao SHA-256 do archive e ao `publicBuildConfigSha256` publicados no metadata do artifact original; reconstrução divergente ou metadata ausente falha antes do upload;
- torna o cleanup do agente e do manager crash-safe, sincronizando a intenção com targets exatos antes do rename e recuperando somente retired trees autorizadas após interrupção abrupta;
- acrescenta a migration append-only `20260819000100_supabase_rls_event_trigger_acl_hardening.sql` e atualiza o head de readiness sem editar migrations aplicadas;
- formaliza no ADR-022 que workaround, fallback silencioso, edição manual de artefato gerado e tolerância a incompatibilidade não são critérios aceitáveis de entrega.
- consolida `docs/review-deploy-cycle.md` como política obrigatória de toda mudança destinada a
  `main`: PR não draft, revisão Codex do SHA final, espera mínima de 60 minutos por ciclo, inspeção de
  todas as superfícies, correção/teste/resolução dos findings e novo PR para qualquer regressão de
  deploy pós-merge.

## Evidência já obtida

- GitHub CLI autenticada como `PedroRomeroM` e branch baseada diretamente em `origin/main`;
- Node 24.18.0, npm 11.19.0, Git, Docker Desktop, OCI CLI, Actionlint e ShellCheck disponíveis no Windows;
- o check hospedado Windows executa a suíte unitária integral e compila os dois standalones com identidades reservadas sem autoridade; ele valida `BUILD_ID`, diretórios físicos e ausência de drift em `next-env.d.ts`, sem publicar esses builds sintéticos como release;
- cadeia local do banco concluída em `supabase:reset` → `supabase:generate` → `test:db`, com 16 migrations, head `20260819000100`, 361/361 asserts pgTAP em quatro arquivos e artefatos gerados sincronizados;
- exclusão host-global comprovada no Windows por 5/5 testes comportamentais: concorrência fail-fast, liberação normal, recuperação após `taskkill` do guardião, bloqueio dos dois wrappers antes de Docker/secret hostil e contrato sem bypass/lockfile stale; `supabase:start` e `supabase:status` também passaram com a stack real após reinício limpo do Docker Desktop;
- a cadeia local integral do snapshot atual passou em Node 24/npm 11: `npm ci`, format, lint, typecheck, 991 unitários com 27 skips condicionais de plataforma, docs:check 34/200/23, audit sem vulnerabilidades, Knip e diff-check;
- a cadeia canônica do banco passou em 361/361, a matriz Playwright integral em 114/114 por 17 specs/16 projetos, sem retry, e os builds standalone web/backoffice em 26 + 4 rotas;
- checks direcionados dos scripts de produção, systemd, rollback e smoke aprovados; CI hospedado, release Linux x86_64 e deploy continuam gates independentes.
- testes direcionados provaram duas reconstruções do mesmo SHA com configuração pública alterada e interrupção real entre rename/remoção nos dois processos; a segunda reconstrução foi recusada e os recoveries preservaram paths alheios.

## Fronteiras externas ainda abertas

- a autenticação OCI precisa terminar e o plano deve comprovar capacidade atual e elegibilidade Always Free antes de qualquer criação;
- o projeto Supabase de produção deve ser criado em São Paulo (`sa-east-1`) somente após confirmação explícita do custo mensal exibido pelo provedor;
- GitHub Environment, variables, secrets, domínio, DNS e TLS precisam ser comprovados na configuração real;
- o deploy fica desativado até os gates locais, o PR, os ciclos de review e a preparação externa estarem concluídos.

## Rollback

- código e workflows: reverter este change set antes de habilitar `PRD_DEPLOY_ENABLED`;
- banco: migrations já aplicadas não são alteradas ou removidas; uma correção posterior é sempre forward-only;
- cloud: o provisionador conserva estado privado e recusa alvo divergente. Recursos somente podem ser removidos após inventário e confirmação de que pertencem ao Set Livre;
- release: o gerenciador mantém release anterior e só troca o symlink após manifesto, health e smoke; falha posterior aciona rollback comprovado.

## Próximos gates

Executar integralmente os gates de `AGENTS.md`, fazer auditoria leve pós-commit, abrir PR para `main`, solicitar `@codex review` e repetir correção/review até resultado limpo. Somente depois do merge serão aceitos como evidência os deploys reais no Supabase e na VM Oracle.
