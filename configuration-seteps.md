# Etapas de configuração — Set Livre

Este checklist contém somente ações humanas ou valores que não podem ser inferidos com segurança. Não cole secrets em issue, PR, chat, log, screenshot ou comando salvo no histórico. Guarde cada valor em um gerenciador de senhas e informe apenas quando a etapa estiver concluída.

## Estado já comprovado

- [x] Projeto Supabase Cloud `set-livre` criado com ref `klzxatkgiiznymzuzadd`.
- [x] OCI CLI `3.89.0`/SDK `2.181.0` verificada localmente; perfil separado `SET_LIVRE`, config `0600` e diretório `~/.oci` `0700`.
- [x] Discovery OCI read-only de 2026-08-16 validou home region `sa-saopaulo-1`, uma AD, A1 Flex/Ubuntu ARM64 e quota A1 sem uso; não criou recurso.
- [x] Target autorizado: compartment `SetLivre`, VCN `10.20.0.0/16`, subnet `10.20.1.0/24`, NSG público 80/443 e SSH restrito, `VM.Standard.A1.Flex` com 2 OCPUs/12 GB, Ubuntu 24.04 Minimal ARM64, boot 50 GB e IMDSv2-only.
- [ ] VM/rede/IP realmente criados e classificados como Always Free na tela final. Não marque antes de conferir custo estimado `0` e os recursos por OCID.

## 1. Supabase MCP no Codex

Existe hoje um servidor global chamado `supabase` apontando para outro projeto. Não o sobrescreva nem o autentique por engano. Use um nome isolado para Set Livre:

```bash
codex mcp add supabase-set-livre --url 'https://mcp.supabase.com/mcp?project_ref=klzxatkgiiznymzuzadd&features=docs%2Caccount%2Cdatabase%2Cdebugging%2Cdevelopment%2Cfunctions%2Cbranching'
codex mcp get supabase-set-livre
codex mcp login supabase-set-livre
codex mcp list
```

- [ ] A saída de `get/list` mostra a ref exata `klzxatkgiiznymzuzadd` e estado habilitado.
- [ ] O OAuth abriu no navegador e terminou sem autenticar o servidor do outro projeto.
- [ ] Reinicie o Codex e execute `/mcp`; confirme o servidor `supabase-set-livre` e a conta esperada.
- [ ] Faça uma leitura inofensiva de identificação do projeto; não use `db reset`, seed ou edição manual no Cloud.

O `codex mcp add` foi tentado neste sandbox e falhou ao gravar `~/.codex/config.toml` por filesystem read-only. Portanto MCP ainda não está configurado/autenticado nesta sessão.

### Agent Skills opcionais

```bash
npx skills add supabase/agent-skills
```

- [ ] Antes de aceitar, confira que origem e caminho são `supabase/agent-skills` e revise o manifesto/arquivos instalados.
- [ ] Confirme o diretório de destino, versão/commit e ausência de alteração inesperada; reinicie o Codex, pois skills novas só ficam disponíveis em nova sessão.
- [ ] Não trate a simples saída do `npx` como instalação comprovada.

## 2. Supabase Cloud

### Projeto e Auth

- [ ] Em Project Settings, confirme nome/ref, região, organização, owner e contatos de recuperação.
- [ ] Defina uma senha de banco longa e exclusiva; salve como `SUPABASE_DB_PASSWORD` somente no environment GitHub `production`.
- [ ] Copie Project URL e anon/publishable key. A URL esperada é `https://klzxatkgiiznymzuzadd.supabase.co`; a chave pública ainda não é autoridade.
- [ ] Auth Site URL: `https://setlivre.com`.
- [ ] Redirect allowlist mínima: `https://setlivre.com/auth/callback`. Não copie os redirects localhost de `supabase/config.toml` para produção.
- [ ] JWT expiry `3600`, refresh token rotation ativa, anonymous signup desativado, confirmação de e-mail ativa, senha mínima 10 com maiúscula/minúscula/dígito, conforme contrato local.
- [ ] Cadastre os templates PT-BR versionados em `supabase/templates/` sem registrar token/hash em logs.
- [ ] Configure SMTP/remetente e DNS de e-mail somente após escolha aprovada de provider (PEND-005); até lá, não libere cadastro público.
- [ ] Configure captcha/site key somente quando o adapter real e o secret server-side estiverem aprovados; não invente variável pública para habilitar capacidade ausente.

### Banco e runtime restrito

- [ ] Gere uma senha exclusiva para `app_runtime_prod`, diferente da senha administrativa, e armazene-a somente no password manager/GitHub.
- [ ] Após as migrations, crie/normalize o login `app_runtime_prod` pelo procedimento operacional revisado: `LOGIN NOINHERIT`, sem superuser/create role/create DB/replication/bypass RLS, connection limit 10, única membership assumível `app_dal`, somente `CONNECT` e GUC vazio exigido pelo readiness.
- [ ] Monte `PRD_DATABASE_URL_APP_DAL` a partir do endpoint direto ou pooler de sessão aprovado, com TLS e exatamente `options=-c role=app_dal`; nunca use `postgres`, `service_role`, owner ou pooler transacional sem prova.
- [ ] Prove pela própria URL: `current_user=app_dal`, `session_user=app_runtime_prod` e `private.check_runtime_readiness(session_user)=true`. Não imprima a URL.
- [ ] Confirme que migrations Cloud correspondem ao head versionado. Produção usa somente `supabase db push --dry-run` seguido de `db push`; nunca `db reset`, seed ou `config push`.
- [ ] Valide grants/RLS com duas pessoas, um dono e um admin sintéticos; remova os dados QA exatos depois.
- [ ] Configure backup/PITR ou export lógico criptografado, retenção, owner e teste de restore. Verifique custo antes de habilitar add-on.

## 3. GitHub

Crie o environment `production`, restrito à branch `main`, com reviewer humano obrigatório e sem auto-approval do autor do PR.

### Environment variables

- [ ] `PRD_DEPLOY_ENABLED=false` durante bootstrap; mude para `true` só após todos os smokes manuais.
- [ ] `PRD_PUBLIC_APP_URL=https://setlivre.com`.
- [ ] `PRD_BACKOFFICE_APP_URL=https://ops.setlivre.com` (ou origem separada decidida e protegida; nunca igual ao app público).
- [ ] `PRD_SUPABASE_URL=https://klzxatkgiiznymzuzadd.supabase.co`.
- [ ] `PRD_SSH_HOST` com IP reservado ou hostname operacional validado.
- [ ] `PRD_SSH_USER` com usuário de deploy sem root.

### Environment secrets

- [ ] `SUPABASE_ACCESS_TOKEN` com o menor escopo/owner possível e data de rotação registrada.
- [ ] `SUPABASE_DB_PASSWORD` administrativa, usada apenas pela CLI de migration.
- [ ] `PRD_SUPABASE_ANON_KEY`.
- [ ] `PRD_DATABASE_URL_APP_DAL` restrita.
- [ ] `PRD_SSH_PRIVATE_KEY` de uma chave dedicada ao deploy; não reutilize a chave identificada como outro projeto.
- [ ] `PRD_SSH_KNOWN_HOSTS` obtido após comparar a host key da VM por canal OCI confiável; não aceite `StrictHostKeyChecking=no`.

### Proteções

- [ ] Proteja `main`: PR obrigatório, ao menos um review, threads resolvidas, branch atualizada, force-push/deletion bloqueados.
- [ ] Exija o check `Quality, local Supabase and browser gates` do workflow `CI`.
- [ ] Restrinja bypass/admin e exija approval do environment antes do deploy.
- [ ] Confirme que o repositório/plano oferece runner `ubuntu-24.04-arm`; se não oferecer, aprove runner ARM64 isolado por ADR antes de habilitar deploy.
- [ ] Rode um PR de teste sem secrets: CI precisa passar com Supabase local. Confirme que PR de fork não recebe environment/secrets.

## 4. Oracle Cloud e VM

- [ ] Instale a OCI CLI oficial em venv/pipx user-local estável e valide `oci --version`; o wrapper usado nesta rodada fica em `/tmp` e é efêmero. Não dependa do shebang antigo do Snap.
- [ ] Refaça `oci session authenticate` no perfil `SET_LIVRE` quando a sessão de 60 minutos expirar; nunca edite/cole o security token.
- [ ] Informe um CIDR administrativo IPv4 `/32` atual para SSH; nunca abra porta 22 para `0.0.0.0/0`.
- [ ] Gere chave SSH Ed25519 dedicada `set-livre-production`; guarde a privada `0600`, backup offline e fingerprint. Só a pública entra no launch.
- [ ] Antes do launch, revalide A1 core/memory `available`, capacidade física da AD e badge/estimativa Always Free. Quota disponível não garante capacidade nem custo zero.
- [ ] Confirme compartment/VCN/subnet/NSG novos de Set Livre; não reutilize `SpensesApp`, `spenses-vcn`, `vcn-piadas-leves` ou suas subnets.
- [ ] Reserve IP público estável se elegível/custo zero; registre OCIDs privados no inventário operacional, não no Git.
- [ ] Ative backup de boot volume/Object Storage apenas depois de conferir cota Always Free/custo e retenção.

### Hardening a comprovar na VM

- [ ] Ubuntu atualizado; reboot quando kernel exigir; `unattended-upgrades` e janela de manutenção configurados.
- [ ] IMDSv2-only; nenhum secret em user-data; serial console/boot diagnostics revisados.
- [ ] Usuários separados `setlivre` (runtime sem login) e deploy; SSH por chave, `PermitRootLogin no`, senha e forwarding desativados quando não necessários.
- [ ] NSG e UFW: 80/443 públicos, 22 somente CIDR administrativo; portas 3000/3001 apenas loopback.
- [ ] Nginx instalado por pacote oficial, `server_tokens off`, limites de body/rate, timeouts, headers, canonical host e sobrescrita de `X-Forwarded-For` por IP único confiável.
- [ ] `setlivre-web.service` e `setlivre-backoffice.service` executam sem root, com hardening systemd, env root-owned `0640`, restart limitado e logs redigidos.
- [ ] Estrutura `/opt/setlivre/releases/<sha>`, symlinks `current/previous`, owners mínimos e sudoers restrito apenas aos serviços/comandos necessários.
- [ ] `fail2ban`, journald/rotação, monitor de disco/memória/certificado e timer de health configurados. Não instale Docker em produção.

## 5. Domínio e TLS

- [ ] No registrador de `setlivre.com`, ative MFA, registry lock quando disponível, auto-renew e contatos de recuperação.
- [ ] Com TTL temporário de 300 s, crie `A setlivre.com -> IP reservado`, `CNAME www -> setlivre.com` e `A ops -> IP reservado` somente depois do Nginx pronto.
- [ ] Não publique `AAAA` sem IPv6 configurado/testado ponta a ponta.
- [ ] Adicione CAA para a CA escolhida e DNSSEC se o registrador/zone provider suportar com procedimento de recuperação.
- [ ] Emita TLS somente após propagação DNS; certificado público deve cobrir `setlivre.com`/`www`. `ops` pode usar certificado próprio e continua protegido por rede/autorização.
- [ ] Habilite redirect HTTP→HTTPS, OCSP/renovação automática, alerta de expiração e teste `nginx -t` antes de reload.

Verificação pública sem revelar configuração:

```bash
dig +short A setlivre.com
curl --fail --silent --show-error https://setlivre.com/api/health/live
curl --fail --silent --show-error https://setlivre.com/api/health/ready
openssl s_client -connect setlivre.com:443 -servername setlivre.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

## 6. Primeiro deploy, backup e operação

- [ ] Mantenha `PRD_DEPLOY_ENABLED=false`; execute bootstrap da VM, smoke interno dos dois serviços e smoke HTTPS manual.
- [ ] Aplique migrations em dry-run e revise a lista. Confirme compatibilidade expand/migrate/contract com a release anterior.
- [ ] Faça o primeiro deploy pelo environment protegido; acompanhe CI e deploy até estado terminal. Não faça deploy manual in-place.
- [ ] Confirme SHA em `/api/health/live`, readiness DAL, symlink `current`, serviços ativos, Nginx e ausência de secret no artifact/log.
- [ ] Force um health check controlado a falhar em ambiente seguro e prove rollback de aplicação para `previous`; migrations não sofrem down automático.
- [ ] Defina backup diário, retenção, criptografia, restore drill trimestral, owner e alerta de falha para banco e VM.
- [ ] Defina alertas de uptime/readiness, CPU/RAM/disco, 5xx, systemd restart loop, certificado e falha de backup. Sentry/provider externo continua dependente de aprovação própria.
- [ ] Registre data/owner/próxima rotação de cada token, senha, chave SSH e certificado.
- [ ] Só então mude `PRD_DEPLOY_ENABLED=true`. Em cada merge futuro, confira CI → migrations dry-run/push → release Oracle → monitoramento pós-deploy; falha exige patch/PR e nova execução, nunca bypass.

Quando todos os itens aplicáveis estiverem marcados, avise. O agente então executará os testes finais possíveis, verificará os environments sem ler valores e acompanhará o primeiro deploy real.
