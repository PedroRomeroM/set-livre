# Etapas de configuração — Set Livre

Este checklist contém somente ações humanas ou valores que não podem ser inferidos com segurança. Não cole secrets em issue, PR, chat, log, screenshot ou comando salvo no histórico. Guarde cada valor em um gerenciador de senhas e informe apenas quando a etapa estiver concluída.

## Estado já comprovado

- [x] Projeto Supabase Cloud `set-livre` criado em `ca-central-1`; ele não é produção e não receberá migrations. A identidade canônica deve ser conferida diretamente no dashboard e no MCP project-scoped, sem copiar refs para esta checklist.
- [x] Workstation Windows 11 nativa, sem WSL, com Node `24.18.0`, npm `11.19.0`, Git `2.55.0`, GitHub CLI `2.97.0`, OCI CLI `3.90.1`, `psql` `18.6`, PowerShell oficial `7.6.5`, Docker Desktop `4.86`, actionlint `1.7.12` e ShellCheck `0.11.0` instalados. O PowerShell operacional é exclusivamente o MSI oficial x64 em `C:\\Program Files\\PowerShell\\7\\pwsh.exe`; o MSIX redundante foi removido depois da validação do binário, hash e assinatura.
- [x] Long Paths e Hyper-V habilitados; checkout configurado localmente com `core.autocrlf=false`, `core.filemode=false`, `core.symlinks=false`, `core.longpaths=true`, `core.ignorecase=true` e `core.protectNTFS=true`.
- [x] Browsers Chromium, Firefox e WebKit do Playwright instalados no Windows pela CLI fixada no workspace.
- [x] OCI CLI `3.90.1` instalada pelo MSI oficial do Windows. A instalação Linux anterior (`3.89.0`/SDK `2.181.0`, perfil `SET_LIVRE` e permissões POSIX protegidas) permanece somente como evidência histórica.
- [x] Discovery OCI read-only validou home region `sa-saopaulo-1` e uma AD. Em `2026-08-18`, foram criados o compartment isolado `SetLivre`, VCN `10.20.0.0/16`, subnet pública regional `10.20.1.0/24`, internet gateway, route table, security list sem ingress e NSG com 80/443 públicos, ICMP PMTU e SSH restrito ao `/32` administrativo então vigente.
- [x] Após as tentativas A1/ARM64 retornarem `OUT_OF_HOST_CAPACITY`, o ADR-021 registrou a aprovação humana para o alvo `VM.Standard.E2.1.Micro` x86_64. Uma instância diagnóstica `set-livre-production` chegou a `RUNNING`, com 1 OCPU, aproximadamente 1 GB de RAM, Ubuntu 24.04, boot 50 GB e IMDSv2-only; SSH administrativo por chave foi confirmado. Depois de revelar uma falha real no bootstrap anterior, ela foi terminada com o boot volume para permitir reprovisionamento limpo, sem conservar host parcialmente configurado.
- [x] A tenancy admite duas E2 Micro Always Free e outra instância já existe fora do Set Livre. A posição usada pelo diagnóstico foi liberada. Na última evidência OCI preservada, em `2026-08-19T09:45:42Z`, não havia VM Set Livre ativa e o Plan E2 encerrou fail-closed com `OUT_OF_HOST_CAPACITY`, sem autorização implícita para shape pago, outra região ou outro projeto. Inventário e capacidade devem ser revalidados antes de qualquer nova ação.
- [x] SVM/virtualização habilitada no firmware; após o reboot de `2026-08-17 22:05:28`, `VirtualizationFirmwareEnabled=True`.
- [x] Docker Desktop `4.86` saudável no backend Hyper-V/Linux, contexto `desktop-linux`, endpoint `npipe:////./pipe/dockerDesktopLinuxEngine` e `OSType=linux`.
- [x] GitHub CLI está autenticado. O perfil OCI `SET_LIVRE` foi renovado e validado remotamente em `2026-08-18`; a sessão é temporária e deve ser renovada antes da próxima operação. Os MCPs Supabase permanecem separados por projeto; qualquer renovação OAuth precisa concluir no navegador e ser comprovada por leitura do projeto correto.
- [x] Restauração do Codex confirmada; o backup exato `C:\Users\thefe\OneDrive\Desktop\Projetos\.codex` foi movido para a Lixeira sem esvaziá-la, a instalação ativa permaneceu intacta e não há cwd/configuração POSIX no estado operacional.
- [x] O catálogo documental do branch de infraestrutura contém 200 cenários.
- [x] O fechamento endureceu a DACL do checkout e dos três arquivos `.env.local` ignorados para permitir escrita somente ao usuário atual, `SYSTEM` e `Administrators`; a prova posterior confirmou DACL protegida e zero writer inesperado. Node/npm em `C:\Program Files\nodejs` mantêm `Authenticated Users`/`Users` somente em leitura/execução. Os wrappers continuam fail-closed se uma inspeção futura divergir.
- [x] O Docker Desktop `4.86` usa a opção oficial **Port binding behavior = Localhost only** (`PortBindingBehavior=local-only-port-binding`). O wrapper lê o `settings-store.json` físico e estável do perfil Windows antes do start e falha fechado se a opção estiver ausente, duplicada ou divergente. A inspeção pós-start exige a matriz TCP exata Kong/Postgres/Studio/Inbucket `8000/5432/3000/8025 → 54321/54322/54323/54324` e aceita apenas `127.0.0.1` literal ou a representação local-only `127.0.0.1` + `::` do Docker Desktop; os listeners efetivos foram comprovados exclusivamente em `127.0.0.1` e recusaram as interfaces `172.19.112.1` e `192.168.18.35`. UDP, wildcard IPv4, troca, extra, ausência ou duplicação falham fechados. A regra customizada de firewall foi aposentada porque o produto agora oferece a fronteira nativa correta.
- [x] O ADR-023 adotou o Job Object canônico para wrappers persistentes Windows. O guardian
      versionado cria o alvo suspenso, associa-o ao Job com `KILL_ON_JOB_CLOSE` e só então o executa;
      saída natural da raiz e queda abrupta do supervisor foram provadas com descendentes eliminados e
      porta reutilizável. `taskkill` e tolerância a órfãos foram removidos desse caminho.
- [x] A cadeia Supabase local limpa possui 16 migrations, predecessor `20260815000100` e head `20260819000100`. `supabase:reset`, geração canônica e `test:db` comprovaram o estado local; o pgTAP passou em 4 arquivos e 361/361 testes, com readiness de 17 dependências ACL e 16 rotinas DAL. Essa prova não equivale a projeto ou migration em Supabase Cloud.
- [x] O snapshot Windows atual concluiu `npm ci`, format, lint, typecheck, 991 unitários com 27 skips condicionais de plataforma, docs:check 34/200/23, audit sem vulnerabilidades, Knip, diff-check, banco 361/361, Playwright integral 114/114 por 17 specs/16 projetos e builds standalone web/backoffice de 26 + 4 rotas. PR, ciclos de `@codex review`, merge, release Linux x86_64 e deploy ainda não foram executados; nenhuma fotografia local substitui esses gates externos.
- [x] O launch diagnóstico E2 Micro chegou a `RUNNING` e comprovou shape Always Free, rede/NSG, IPv4 e SSH sem registrar IP ou OCIDs no Git. A instância e seu boot volume foram depois removidos deliberadamente; essa evidência histórica não representa uma VM ativa, hardening ou deploy.

O desenvolvimento local usa Docker Desktop com containers Linux pelo Hyper-V, nunca WSL2. A CLI Supabase executada pelos scripts é o binário nativo fixado em `node_modules/@supabase/cli-windows-x64/bin/supabase.exe` no Windows x64 ou `node_modules/@supabase/cli-linux-x64/bin/supabase` no Linux x64; o launcher `node_modules/supabase/dist/supabase.js`, `npx`, CLI global e lookup em `PATH` não participam. O bootstrap PostgreSQL usa `pg` do workspace; o `psql` instalado serve apenas para diagnóstico do operador.

## 1. Supabase MCP no Codex

A restauração preservou dois servidores distintos: `supabase` aponta para Set Livre e `supabase_spenses` preserva o outro projeto. Não troque os projetos nem autentique o servidor errado. Para uma nova verificação ou renovação, use:

```powershell
codex mcp get supabase
codex mcp get supabase_spenses
codex mcp login supabase
codex mcp list
```

- [x] A configuração mantém Set Livre e Spenses em servidores MCP distintos, ambos habilitados, sem registrar aqui refs históricas.
- [x] Os dois OAuths terminaram no navegador sem trocar os projetos.
- [x] Após reiniciar o Codex, os servidores `supabase` e `supabase_spenses` permaneceram autenticados.
- [x] Leituras inofensivas retornaram os projetos correspondentes aos dois servidores; nenhum `db reset`, seed ou edição manual foi executado no Cloud.
- [x] A leitura do projeto canadense mostrou zero migrations remotas. Os Security Advisors desse projeto reportaram 2 WARN relacionados a `rls_auto_enable`; a correção canônica está na migration append-only local `20260819000100`, ainda não aplicada no Cloud. Esse diagnóstico não é prova do futuro projeto de São Paulo.
- [ ] O projeto vazio atual foi criado em `ca-central-1` (Canadá). Como a região do projeto Supabase não é movida in-place, produção brasileira deve usar um novo projeto em `sa-east-1` (São Paulo), validar a nova ref/MCP/variáveis e só então aposentar o projeto canadense. A criação acrescenta US$ 10/mês no plano atual e exige confirmação humana explícita; nenhuma migration será aplicada ao projeto canadense enquanto essa decisão estiver aberta.
- [ ] Depois de criar o projeto de São Paulo, execute os advisors nele e trate seus resultados próprios. Não copie como prova o INFO `auth_db_connections_absolute` nem os WARN observados no projeto canadense.

A configuração ativa está em `%USERPROFILE%\.codex\config.toml`, com os dois OAuths concluídos e sem configuração operacional POSIX.

### Agent Skills opcionais

```powershell
npx skills add supabase/agent-skills
```

- [x] A origem e o caminho foram conferidos no lock local: `supabase/agent-skills`, via `https://github.com/supabase/agent-skills.git`.
- [x] A instalação em `%USERPROFILE%\.agents\skills` foi comprovada pelo lock version `3`, hashes de diretório e manifests: skill Supabase `0.1.2` e Postgres best practices `1.1.1`.
- [x] O Codex foi reiniciado depois da instalação e a sessão Windows atual carregou as skills `supabase` e `supabase-postgres-best-practices`; a simples saída do `npx` não foi usada como prova.

## 2. Supabase Cloud

### Projeto e Auth

- [ ] Após autorização explícita do custo, crie o projeto produtivo em `sa-east-1` (São Paulo) e confirme nome/ref, região, organização, owner e contatos de recuperação. Não reutilize o projeto canadense.
- [ ] Defina uma senha de banco longa e exclusiva; salve como `SUPABASE_DB_PASSWORD` somente no password manager e, depois que o configurador criar o diretório privado da VM, em `/etc/setlivre-deployer/credentials/supabase-db-password`, arquivo físico `root:root` modo `0600` entregue ao agente por `LoadCredential`.
- [ ] Copie a project ref pública, Project URL e anon/publishable key diretamente do novo projeto de São Paulo já aprovado e comprovado; confira os mesmos valores nas variáveis públicas do repositório e em `production.env` no host. `PRD_SUPABASE_PROJECT_REF` deve ter exatamente 20 caracteres `[a-z0-9]`, e `PRD_SUPABASE_URL` deve ser exatamente `https://<PRD_SUPABASE_PROJECT_REF>.supabase.co`. A chave pública ainda não é autoridade, e valores do projeto canadense são recusados.
- [ ] Auth Site URL: `https://setlivre.com`.
- [ ] Redirect allowlist mínima: `https://setlivre.com/auth/callback`. Não copie os redirects localhost de `supabase/config.toml` para produção.
- [ ] JWT expiry `3600`, refresh token rotation ativa, anonymous signup desativado, confirmação de e-mail ativa, senha mínima 10 com maiúscula/minúscula/dígito, conforme contrato local.
- [ ] Cadastre os templates PT-BR versionados em `supabase/templates/` sem registrar token/hash em logs.
- [ ] Configure SMTP/remetente e DNS de e-mail somente após escolha aprovada de provider (PEND-005); até lá, não libere cadastro público.
- [ ] Configure captcha/site key somente quando o adapter real e o secret server-side estiverem aprovados; não invente variável pública para habilitar capacidade ausente.

### Banco e runtime restrito

- [ ] Gere uma senha exclusiva para `app_runtime_prod`, diferente da senha administrativa, e armazene-a somente no password manager e dentro da URL completa em `/etc/setlivre-deployer/credentials/database-url-app-dal`, arquivo físico `root:root` modo `0600` entregue ao agente por `LoadCredential`.
- [ ] Após as migrations, crie/normalize o login `app_runtime_prod` pelo procedimento operacional revisado: `LOGIN NOINHERIT`, sem superuser/create role/create DB/replication/bypass RLS, connection limit 10, única membership assumível `app_dal`, somente `CONNECT` e GUC vazio exigido pelo readiness.
- [ ] Monte `PRD_DATABASE_URL_APP_DAL` a partir do endpoint direto ou pooler de sessão aprovado, com TLS e exatamente `options=-c role=app_dal`; nunca use `postgres`, `service_role`, owner ou pooler transacional sem prova.
- [ ] Prove pela própria URL: `current_user=app_dal`, `session_user=app_runtime_prod` e `private.check_runtime_readiness(session_user)=true`. Não imprima a URL.
- [ ] Confirme separadamente que o head remoto é exatamente `20260819000100`. O readiness de aplicação aceita a janela explícita `20260819000100` + predecessor compatível `20260815000100`; essa janela não substitui a prova do head exato feita pelo deploy. Produção usa somente `supabase db push --dry-run` seguido de `db push`; nunca `db reset`, seed ou `config push`.
- [ ] Para toda migration posterior à baseline do primeiro deploy, preserve expand/migrate/contract, comece cada arquivo exatamente por `-- set-livre:migration-mode=expand-only` e prove que a release corrente e sua predecessora continuam compatíveis durante migration, smoke N-1 pré-ativação, ativação e eventual rollback. O guardrail aceita o bloco condicional byte-canônico do helper RLS gerenciado e o hardening readiness atual somente por objetos, papéis e forma SQL exatos; nunca use uma variação, `DO`, `REVOKE` ou `CREATE OR REPLACE` genérico para fazê-lo passar.
- [ ] Depois que `20260819000100` for aplicada pelo fluxo aprovado no projeto de São Paulo, rode os Security Advisors e corrija todo finding aplicável; não trate a existência da migration local nem o estado do projeto canadense como correção remota comprovada.
- [ ] Valide grants/RLS com duas pessoas, um dono e um admin sintéticos; remova os dados QA exatos depois.
- [ ] Confirme no projeto Pro o backup diário gerenciado e a retenção visível de 7 dias. Antes de liberar produção, execute um restore isolado, registre RPO/RTO observado e redefina as senhas dos papéis customizados no ambiente restaurado. PITR não integra o baseline; só habilite o add-on após aprovar custo e necessidade de RPO menor que 24 horas.
- [ ] Não libere uploads persistentes em `studio-media` até a cópia independente de objetos estar implementada e comprovada. Backups do banco preservam metadados, não os objetos da Storage API.

## 3. GitHub

O environment `production` já existe e aceita somente a branch `main`. Ele não recebe secrets nem executa mutação remota: apenas delimita a publicação do artifact público. A autorização vigente é o ciclo de `@codex review` até parecer limpo, merge protegido e habilitação coordenada das travas independentes no repositório e no host; não existe autoaprovação ou segundo revisor fictício.

A GitHub CLI `2.97.0` está autenticada no Windows como `PedroRomeroM`, usa HTTPS e mantém a credencial no keyring:

```powershell
gh auth login
gh auth status
```

- [x] `gh auth status` confirmou a conta/host esperados e `gh repo view` comprovou acesso `ADMIN` a `PedroRomeroM/set-livre`.

### Repository variables públicas usadas pelo build

- [x] `PRD_DEPLOY_ENABLED=false` está definida no nível do repositório; mude para `true` apenas após todos os smokes manuais e a trava homônima do host estar pronta.
- [ ] Antes de habilitar entrega, configure e releia `PRD_PUBLIC_APP_URL`, `PRD_BACKOFFICE_APP_URL`, `PRD_SUPABASE_PROJECT_REF`, `PRD_SUPABASE_URL` e `PRD_SUPABASE_ANON_KEY` contra o projeto produtivo de São Paulo. A ref precisa casar com `^[a-z0-9]{20}$`, e a URL precisa ser exatamente `https://<ref>.supabase.co`; valor do projeto canadense não autoriza build ou deploy de produção.
- [x] `SET_LIVRE_REPOSITORY_ID=1328339374` foi consultada pela API e gravada como variável de repositório; ela precisa continuar igual ao `databaseId` atual.
- [ ] Depois que o primeiro merge registrar os dois paths na `main`, consulte-os pela API e grave `CI_GITHUB_WORKFLOW_ID` e `PRD_GITHUB_WORKFLOW_ID` também como variáveis de repositório. Antes disso os endpoints retornam `404`; não use placeholder. Os mesmos IDs comprovados vão para o host.
- [ ] Bootstrap canônico da primeira entrega: preserve o ID do run `CI` do primeiro `push` de `main`; depois de registrar os IDs, instalar/verificar o host e habilitar coordenadamente as duas travas, execute uma única reexecução integral com `gh run rerun <RUN_ID> --repo PedroRomeroM/set-livre`. O GitHub conserva o mesmo `GITHUB_SHA`/`GITHUB_REF`, incrementa `run_attempt` e emite novamente o evento `workflow_run: completed`; acompanhe esse attempt e o workflow de publicação correspondente. A identidade da release é o SHA upstream validado no título/artifact/manifesto; o `head_sha` downstream pode já ser o merge seguinte e serve apenas como proveniência. Não crie commit vazio, não use `workflow_dispatch` sem uma publicação anterior aprovada e não reutilize run de PR.

### Environment `production`

- [x] O Environment aceita somente `main` e não contém variáveis nem secrets; as entradas públicas do build ficam no nível do repositório.
- [x] O Environment não possui required reviewer porque há um único colaborador e o job é build-only, sem secrets ou mutação. A ausência não substitui os ciclos de `@codex review`, as proteções de `main` nem a trava independente do host.
- [x] Não cadastre `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` ou `PRD_DATABASE_URL_APP_DAL` no GitHub. Esses valores ficam exclusivamente no host.

O workflow não usa `PRD_SSH_HOST`, `PRD_SSH_USER`, `PRD_SSH_PRIVATE_KEY` nem `PRD_SSH_KNOWN_HOSTS`. O acesso SSH administrativo é uma operação humana separada, com chave e arquivo `known_hosts` locais; nunca abra a porta 22 para ranges do GitHub.

### Proteções

- [x] `main` exige PR, branch atualizada, histórico linear, os checks `Quality, local Supabase and browser gates` e `Windows native contracts`, conversas resolvidas e bloqueia force-push/deletion inclusive para administradores. O segundo check executa a suíte unitária integral em `windows-2025`; não é substituído por simulação Linux dos contratos de Job Object, DACL, PowerShell ou Docker Desktop.
- [x] GitHub Actions aceita somente Actions mantidas pelo próprio GitHub e exige referência por SHA completo; creators verificados genéricos e patterns adicionais permanecem desabilitados.
- [x] A contagem obrigatória de approvals GitHub permanece `0` enquanto houver um único colaborador; exigir autoaprovação seria uma falsa garantia. Cada PR deve receber ciclos de `@codex review` até não restar finding e todas as conversas precisam estar resolvidas antes do merge.
- [x] Bypass administrativo, force-push e deletion estão bloqueados; o Environment aceita apenas `main`. O artifact build-only não usa approval próprio, e a mutação continua condicionada às duas travas independentes e ao protocolo root-owned da VM.
- [ ] Confirme que build/package de produção roda em GitHub-hosted Linux x86_64 e publica o artifact por action fixada por SHA; essa fase recebe somente variáveis públicas e não muta Cloud/VM.
- [ ] Confirme que o repositório público não possui runner self-hosted. A VM deve executar somente o agente pull outbound-only instalado localmente e nunca código arbitrário de workflow/PR.
- [ ] Valide que o workflow exige o caminho exato `.github/workflows/ci.yaml` e os repositórios do run/origem atuais; o agente deve conferir workflow/run, branch, SHA, digest, tamanho, manifesto schema 4, `publicBuildConfigSha256`, runtime, catálogo SQL somente leitura, contrato semântico N−1/N e ancestralidade. Antes do push, confirme que o snapshot Cloud de relações/RLS/policies/ACLs foi persistido; depois, o delta precisa corresponder exatamente ao contrato assinado, sem policy pública de escrita, grant perigoso ou grant option. O artifact não pode conter CLI Supabase nem outro executável administrativo. Separadamente, o bootstrap instala a CLI oficial `2.113.0` como ferramenta root-owned do host e o agente valida caminho, owner/modo, versão, ELF x86_64 e hashes dos dois binários antes de ler secrets ou iniciar migration. O hash público precisa corresponder exatamente a `setlivre.com`, `ops.setlivre.com`, ao projeto Supabase Set Livre e à chave publicável do host. Checkpoint de origem já fora da paginação e run provedor posterior do SHA corrente são tratados separadamente; divergência no mesmo número ou downgrade falha fechada.
- [ ] Valide o dispatcher root-owned allowlisted e o sudoers: o grupo efetivo deve ter exatamente `setlivre-deployer`, e `sudo -ll -U setlivre-deployer` deve mostrar uma única entrada `RunAsUsers: root`, sem `setenv`, com apenas `/usr/local/sbin/setlivre-deploy-dispatch`; não pode haver sudo genérico nem acesso direto ao release manager.
- [ ] Prove que cada `push` de `main` cria CI não cancelável em grupo por SHA; o timer do host serializa mutações e ignora runs antigos, não aprovados ou não descendentes.
- [ ] Rode um PR de teste sem secrets: CI precisa passar com Supabase local. Confirme que PR de fork não recebe configuração do host nem qualquer autoridade de produção.

## 4. Oracle Cloud e VM

- [x] Instale a OCI CLI pelo MSI oficial do Windows e valide `oci --version`; a versão instalada é `3.90.1`.
- [x] A autenticação inicial do perfil isolado `SET_LIVRE` e a home region `sa-saopaulo-1` foram validadas em `2026-08-17`. Como a sessão é temporária, renove-a antes de cada nova operação quando necessário:

```powershell
oci session authenticate --profile-name SET_LIVRE --region sa-saopaulo-1
oci iam region-subscription list --profile SET_LIVRE
```

Nunca edite/cole o security token. O config fica em `%USERPROFILE%\.oci\config`; valide com `Get-Acl` que config, token e chave não herdam acesso de usuários não autorizados.

Execute o provisionador somente a partir da raiz do repositório, em PowerShell 7. O Plan é read-only quanto a recursos persistentes, cria/atualiza apenas o bundle local privado e imprime os hashes, nunca OCIDs. Use um diretório absoluto fora do repositório; o próprio script cria e valida DACL privada, recusa reparse points e aceita somente o inventário gerenciado:

```powershell
$provisioner = (Resolve-Path '.\scripts\provision-oracle-always-free.ps1').Path
$evidenceDirectory = Join-Path $env:LOCALAPPDATA 'SetLivre\oracle-provisioning'
$administrativeCidr = Read-Host 'CIDR IPv4 administrativo público atual, no formato x.x.x.x/32'

& $provisioner `
  -Plan `
  -AdministrativeCidr $administrativeCidr `
  -EvidenceDirectory $evidenceDirectory
```

Revise localmente `set-livre-oracle-plan.json`, o estimate atual e o selo Always Free. Somente se o plano continuar exatamente `VM.Standard.E2.1.Micro`, x86_64, Ubuntu 24.04, `sa-saopaulo-1` e custo incremental zero, derive o hash dos bytes privados persistidos e execute o Apply canônico:

```powershell
$approvedPlanSha256 = (
  Get-FileHash `
    -LiteralPath (Join-Path $evidenceDirectory 'set-livre-oracle-plan.json') `
    -Algorithm SHA256
).Hash.ToLowerInvariant()

& $provisioner `
  -Apply `
  -AdministrativeCidr $administrativeCidr `
  -EvidenceDirectory $evidenceDirectory `
  -ConfirmationToken 'SET_LIVRE_ALWAYS_FREE' `
  -ApprovedPlanSha256 $approvedPlanSha256 `
  -ZeroCostConfirmation 'OCI_ESTIMATE_AND_BADGE_ZERO_CONFIRMED'
```

Os arquivos `set-livre-oracle-plan.json`, `set-livre-oracle-provisioning.json`, `set-livre-oracle-state.json` e `.requests/` permanecem privados, fora do Git, PR, chat, screenshot e logs publicados. Preserve o diretório com sua DACL original e faça backup privado; o estado contém OCIDs, ownership e tokens de retry necessários à reconciliação segura. Estado diferente entre Plan e Apply, capacidade indisponível, custo não comprovado ou hash divergente deve falhar fechado e exige novo Plan — nunca edição manual do JSON.

- [x] O CIDR administrativo IPv4 `/32` foi validado sem ser publicado e aplicado ao NSG; revalide-o antes de qualquer mudança de rede/SSH e sempre que o endereço externo mudar. Nunca abra porta 22 para `0.0.0.0/0`.
- [x] A chave Ed25519 administrativa foi protegida por DACL limitada ao usuário atual, `SYSTEM` e administradores. O contrato atual não cria nem solicita chave pública, usuário ou secret SSH de deploy.

```powershell
$sshDirectory = Join-Path $env:USERPROFILE ".ssh"
New-Item -ItemType Directory -Force -Path $sshDirectory | Out-Null
$privateKey = Join-Path $sshDirectory "set-livre-production-admin"
ssh-keygen -t ed25519 -a 64 -f $privateKey
Get-Acl -LiteralPath $privateKey | Format-List Owner,AreAccessRulesProtected,Access
```

- [x] A instância diagnóstica `set-livre-production` foi lançada e comprovada `RUNNING` no shape fixo `VM.Standard.E2.1.Micro` Always Free, x86_64, 1 OCPU, aproximadamente 1 GB, boot 50 GB e IMDSv2-only; depois foi terminada com o boot volume para descartar o host parcial.
- [ ] Aguarde um Plan canônico com capacidade `AVAILABLE` e reprovisione uma VM limpa. Na última evidência preservada (`2026-08-19T09:45:42Z`), o Plan E2 retornou `OUT_OF_HOST_CAPACITY`; não usar fallback pago, outra região, outro projeto ou bypass do relatório.
- [x] Compartment/VCN/subnet/NSG novos e exclusivos de Set Livre foram comprovados; `SpensesApp`, `spenses-vcn`, `vcn-piadas-leves` e suas subnets não foram reutilizados.
- [x] O SSH administrativo por chave foi confirmado na rede pública então associada à VM diagnóstica, mantendo 22/TCP restrito ao `/32`; essa evidência histórica não representa VNIC ou IPv4 atual, e IP/OCIDs não são publicados no Git.
- [ ] Depois do reprovisionamento, confirme o tipo e a permanência do novo IPv4 público antes de configurar DNS. Numa substituição da VM/VNIC, atualize o DNS; não presuma IP `RESERVED`, estabilidade permanente ou gratuidade sem nova decisão e evidência de custo.
- [ ] Ative backup de boot volume/Object Storage apenas depois de conferir cota Always Free/custo e retenção.

### Hardening a comprovar na VM

- [ ] Ubuntu atualizado; reboot quando kernel exigir; `unattended-upgrades` e janela de manutenção configurados.
- [x] IMDSv2-only foi comprovado na configuração da instância.
- [ ] Nenhum secret em user-data; serial console e boot diagnostics revisados.
- [ ] Usuários separados `setlivre` (runtime sem login) e `setlivre-deployer` (agente pull sem login interativo); SSH administrativo por chave, `PermitRootLogin no`, senha e forwarding desativados quando não necessários.
- [ ] NSG e `iptables-persistent`: 80/443 públicos, 22 somente CIDR administrativo; portas 3000/3001 apenas loopback. O bootstrap não usa UFW e prova que as regras essenciais de iSCSI da imagem OCI permanecem idênticas antes/depois da configuração e no arquivo persistido.
- [ ] Nginx instalado por pacote oficial, `server_tokens off`, limites de body/rate, timeouts, headers, canonical host e sobrescrita de `X-Forwarded-For` por IP único confiável.
- [ ] `setlivre-web.service` e `setlivre-backoffice.service` executam sem root, com hardening systemd, env root-owned `0640`, restart limitado, logs redigidos e budgets de memória coerentes com aproximadamente 1 GB total.
- [ ] Estrutura `/opt/setlivre/releases/<sha>`, symlinks `current/previous`, owners mínimos, dispatcher root-owned allowlisted e sudoers restrito ao único comando exato.
- [ ] `fail2ban`, journald/rotação, monitor de disco/memória/OOM/certificado e timer de health configurados. Se houver swap, provar arquivo, modo, montagem e persistência; não a presumir. Não instale Docker em produção.

### Bootstrap do host e instalação separada do agente pull

O bootstrap do host recebe exatamente três argumentos e não recebe usuário ou chave pública de deploy. O hash é calculado antes da elevação; o script congela a fonte em staging root-owned antes de qualquer atualização de pacote:

```bash
manager_source="$(realpath scripts/production-release-manager.sh)"
manager_sha256="$(sha256sum -- "$manager_source" | cut -d' ' -f1)"
sudo bash scripts/bootstrap-oracle-host.sh \
  "$SET_LIVRE_ADMIN_CIDR" \
  "$manager_source" \
  "$manager_sha256"
```

- [ ] Defina `SET_LIVRE_ADMIN_CIDR` como IPv4 administrativo exato `/32`; confirme que o segundo argumento é o arquivo físico e revisado do release manager v3 e que o terceiro é seu SHA-256 exato.
- [ ] Verifique o bootstrap, `iptables-persistent`/NSG, preservação das regras essenciais OCI, Nginx, systemd, owners e que `/usr/local/sbin/setlivre-release-manager version` retorna `3`. Não acrescente outro argumento nem crie usuário/chave SSH de deploy.
- [ ] Em atualização posterior do manager, use somente a operação administrativa transacional do
      configurator com fonte/hash revisados; comprove preparação root-owned, troca atômica, versão/hash
      finais e rollback do binário anterior em falha. Nunca entregue essa autoridade ao agente ou artifact.

Instale o agente pull somente depois do bootstrap, usando fontes físicas revisadas e hashes calculados fora do comando de instalação:

```bash
agent=/root/setlivre-bootstrap/production-deploy-agent.sh
smoke=/root/setlivre-bootstrap/production-smoke.mjs
agent_sha256='<sha256-revisado-do-agente>'
smoke_sha256='<sha256-revisado-do-smoke>'
sudo bash /root/setlivre-bootstrap/configure-production-deployer.sh \
  install "$agent" "$agent_sha256" "$smoke" "$smoke_sha256"
sudo bash /root/setlivre-bootstrap/configure-production-deployer.sh verify
```

- [ ] Confirme configurator, agente e smoke físicos/root-owned e os hashes SHA-256 antes da instalação. `verify` precisa comprovar owner/modos, hashes, timer, dispatcher, sudoers, protocolo v3 e a unit root-owned de recuperação executada antes de web/backoffice/Nginx.
- [ ] Somente depois que os dois workflows estiverem registrados pelo GitHub no branch padrão, obtenha suas identidades pelos endpoints exatos abaixo, em uma workstation autenticada. Uma resposta `404`, workflow não `active`, path divergente, ID vazio/não positivo, repository ID diferente de `1328339374` ou IDs de workflow iguais interrompe a configuração; não adivinhe, derive por nome de exibição nem use a posição de uma listagem:

```powershell
$repository = 'PedroRomeroM/set-livre'
$repositoryInfo = gh repo view $repository --json databaseId | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Falha ao consultar a identidade do repositório.' }

$ciWorkflow = gh api "repos/$repository/actions/workflows/ci.yaml" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'CI ainda não está registrado no GitHub.' }
$prdWorkflow = gh api "repos/$repository/actions/workflows/prd-deploy.yaml" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'PRD ainda não está registrado no GitHub.' }

[long]$repositoryId = $repositoryInfo.databaseId
[long]$ciWorkflowId = $ciWorkflow.id
[long]$prdWorkflowId = $prdWorkflow.id
if ($repositoryId -ne 1328339374L) { throw 'Repository ID inesperado.' }
if ($ciWorkflow.path -ne '.github/workflows/ci.yaml' -or $ciWorkflow.state -ne 'active') {
  throw 'Identidade/estado inesperado para CI.'
}
if ($prdWorkflow.path -ne '.github/workflows/prd-deploy.yaml' -or $prdWorkflow.state -ne 'active') {
  throw 'Identidade/estado inesperado para PRD.'
}
if ($ciWorkflowId -le 0 -or $prdWorkflowId -le 0 -or $ciWorkflowId -eq $prdWorkflowId) {
  throw 'Workflow IDs ausentes, inválidos ou iguais.'
}

[pscustomobject]@{
  SET_LIVRE_REPOSITORY_ID = $repositoryId
  CI_GITHUB_WORKFLOW_ID   = $ciWorkflowId
  PRD_GITHUB_WORKFLOW_ID  = $prdWorkflowId
} | Format-List

gh variable set SET_LIVRE_REPOSITORY_ID --repo $repository --body ([string]$repositoryId)
gh variable set CI_GITHUB_WORKFLOW_ID --repo $repository --body ([string]$ciWorkflowId)
gh variable set PRD_GITHUB_WORKFLOW_ID --repo $repository --body ([string]$prdWorkflowId)
```

- [ ] Releia as variáveis públicas de repositório e confirme igualdade com as APIs GitHub/Supabase antes de habilitar qualquer entrega. Preencha `/etc/setlivre-deployer/production.env`, em sessão administrativa protegida, somente com os valores não secretos aceitos pelo template: `GITHUB_REPOSITORY_ID=1328339374`, os dois workflow IDs positivos e distintos, URLs públicas, `PRD_SUPABASE_PROJECT_REF`, URL/chave publicável Supabase, `SUPABASE_SERVER_CA_SHA256` e `PRD_DEPLOY_ENABLED=false`. A ref deve casar com `^[a-z0-9]{20}$` e `PRD_SUPABASE_URL` deve ser exatamente `https://<PRD_SUPABASE_PROJECT_REF>.supabase.co`. Não adicione token, senha ou URL DAL a esse arquivo.
- [ ] No painel **Connect** do projeto produtivo, baixe o **Server root certificate** oficial. Valide o PEM e a validade com `openssl x509`, calcule seu SHA-256 e grave somente o hash em `SUPABASE_SERVER_CA_SHA256`. Não use certificado do sistema, autoassinado, obtido por interceptação TLS ou de outro projeto.
- [ ] Preencha exclusivamente os cinco arquivos criados pelo configurador em `/etc/setlivre-deployer/credentials`: `github-deploy-token`, `supabase-access-token`, `supabase-db-password`, `database-url-app-dal` e `supabase-server-ca.pem`. Faça isso em sessão administrativa protegida, sem argumento de linha de comando, shell history, clipboard compartilhado ou eco; preserve diretório `root:root`/`0700` e arquivos físicos `root:root`/`0600`. O certificado deve ser exatamente o PEM validado cujo SHA-256 consta em `production.env`.
- [ ] Confirme que a unit possui exatamente cinco diretivas `LoadCredential`, uma para cada fonte acima, e que `configure-production-deployer.sh verify` comprova inventário, owner/modo, conteúdo permitido, certificado e round-trip pelo diretório privado `$CREDENTIALS_DIRECTORY`. Os contratos `authorization-contract.json`, `baseline-authorization-contract.json` e `authorization-head.json` pertencem ao artifact assinado da release; nunca são credenciais ou arquivos preenchidos manualmente. O token GitHub deve ser fine-grained, limitado exclusivamente a este repositório, com `Contents: read` e `Actions: read and write`: a escrita em Actions é necessária somente para `workflow_dispatch` da regeneração canônica de artefato expirado; nenhuma permissão de Contents, Administration, Environments ou Secrets em escrita é autorizada.
- [ ] Mantenha `PRD_DEPLOY_ENABLED=false` no arquivo do host e no repositório, execute novamente `configure-production-deployer.sh verify` e confirme que a unit do agente limita escrita a `/var/lib/setlivre-deployer/.setlivre`, `/opt/setlivre` e `/run/lock`; `/run` inteiro não pertence à sandbox gravável. IDs ausentes/divergentes ou sandbox mais ampla bloqueiam a habilitação.
- [ ] Somente depois de todas as provas, faça a habilitação coordenada das duas travas. Não copie segredo para GitHub Actions, shell history, log ou documento e não use workaround, bypass ou fallback silencioso para contornar identidade/configuração incompleta.

## 5. Domínio e TLS

- [ ] No registrador de `setlivre.com`, ative MFA, registry lock quando disponível, auto-renew e contatos de recuperação.
- [ ] Com TTL temporário de 300 s, crie `A setlivre.com -> <IPv4 público EPHEMERAL atual da VNIC>`, `CNAME www -> setlivre.com` e `A ops -> <mesmo IPv4>` somente depois do Nginx pronto.
- [ ] Não publique `AAAA` sem IPv6 configurado/testado ponta a ponta.
- [ ] Adicione CAA para a CA escolhida e DNSSEC se o registrador/zone provider suportar com procedimento de recuperação.
- [ ] Emita TLS somente após a propagação dos três nomes. O contrato do host usa **um único certificado SAN**, salvo em `/etc/letsencrypt/live/setlivre.com`, que precisa cobrir exatamente `setlivre.com`, `www.setlivre.com` e `ops.setlivre.com`; não emita certificado separado para `ops` nem altere manualmente o template Nginx.
- [ ] Na sessão administrativa, substitua somente o e-mail operacional e execute `sudo /usr/local/sbin/setlivre-issue-tls-certificate '<email-operacional>'`. Esse helper root-owned aceita um único e-mail validado e invoca o Certbot fixo em modo `certonly --webroot` para os três nomes; o plugin `python3-certbot-nginx` não integra o host. Em seguida execute `sudo /usr/local/sbin/setlivre-enable-tls`; o segundo helper valida o conjunto SAN exato, validade, owner/modo, ativa o template revisado, roda `nginx -t` e restaura o site anterior se a ativação falhar.
- [ ] Confirme que o deploy hook root-owned do Certbot chama exclusivamente `/usr/local/sbin/setlivre-enable-tls`, que `certbot renew --dry-run` termina verde e que o timer de renovação está ativo. Configure alerta de expiração e só então prove HTTP→HTTPS/HSTS nos três hosts.

Verificação pública sem revelar configuração:

```powershell
Resolve-DnsName setlivre.com -Type A
Invoke-WebRequest -Uri "https://setlivre.com/api/health/live" -Method Get
Invoke-WebRequest -Uri "https://setlivre.com/api/health/ready" -Method Get

$tcp = [Net.Sockets.TcpClient]::new("setlivre.com", 443)
$tls = [Net.Security.SslStream]::new($tcp.GetStream(), $false)
$tls.AuthenticateAsClient("setlivre.com")
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($tls.RemoteCertificate)
$certificate | Select-Object Subject,Issuer,NotBefore,NotAfter,Thumbprint
$tls.Dispose()
$tcp.Dispose()
```

Para validar o SSH **administrativo humano** a partir do Windows, primeiro compare a host key por canal OCI confiável e grave-a em um arquivo dedicado; depois mantenha a verificação estrita. Essas variáveis são locais do operador e não pertencem ao workflow ou ao Environment GitHub:

```powershell
$knownHosts = Join-Path $env:USERPROFILE ".ssh\set-livre-known-hosts"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$knownHosts" "$env:SET_LIVRE_ADMIN_USER@$env:SET_LIVRE_ADMIN_HOST" true
```

## 6. Primeiro deploy, backup e operação

- [ ] Mantenha `PRD_DEPLOY_ENABLED=false`. Na última evidência OCI preservada (`2026-08-19T09:45:42Z`), não havia VM Set Livre ativa e o Plan E2 encerrou fail-closed com `OUT_OF_HOST_CAPACITY`. O projeto Supabase de São Paulo, hardening, agente/configuração privada do host e migrations Cloud continuam pendentes; o projeto canadense não é produção. PR, merge e deploy não foram executados; raiz/`www` ainda apontavam para parking na última leitura, `ops` não tinha origem e TLS não está comprovado. Revalide sessão e inventário OCI antes de agir.
- [ ] Execute e prove bootstrap/hardening da VM E2 x86_64; só então instale/verifique o agente pull e seu timer.
- [ ] Configure DNS para `setlivre.com`, `www.setlivre.com` e `ops.setlivre.com`, emita/renove TLS e prove os endpoints públicos sem desabilitar validação.
- [ ] Aplique migrations em dry-run e revise a lista. No primeiro deploy, registre a baseline; nos próximos, confirme o marcador expand-only e execute smoke do SHA N-1 contra o banco já migrado antes de qualquer ativação.
- [ ] Faça o primeiro deploy pelo fluxo aprovado; acompanhe CI, build/package Linux x86_64 GitHub-hosted, artifact pinned e o agente pull serial até estado terminal. Não faça deploy manual in-place.
- [ ] Prove o protocolo release manager v3: staging copiado imediatamente para área root-owned; manifesto schema 4 e configuração pública validados antes das migrations; ativação usando os mesmos bytes; release/runtime/proveniência/estados/symlinks sincronizados; `confirmed` durável antes de desarmar o watchdog; unit/checkpoint capazes de recuperar um único `pending` antes dos serviços após reboot e links divididos; instalação imutável e preservação de `previous`.
- [ ] Confirme, em cada um dos 37 ciclos separados por 25 segundos, `application` e SHA em `/api/health/live` e `/api/health/ready` de web/backoffice, home, login, negação do backoffice, `GET /api/account/profile -> 401 UNAUTHENTICATED`, `POST /api/commands -> 401 UNAUTHENTICATED`, `requestId`/headers seguros, redirects HTTP canônicos e a exceção ACME em `404`; prove também readiness DAL, symlink `current`, serviços ativos, Nginx e ausência de secret no artifact/log. O deploy só executa `confirm <sha>` depois desse smoke público completo por 15 minutos; qualquer falha HTTPS precisa acionar e comprovar rollback.
- [ ] Force um health check controlado a falhar em ambiente seguro e prove o lease/watchdog de 20 minutos, rollback para `previous` e saúde da release anterior; no primeiro deploy falho, prove serviços inativos. Migrations não sofrem down automático.
- [ ] Confirme o backup diário gerenciado do Supabase Pro, sua retenção de 7 dias e o primeiro restore isolado. Registre owner e alerta de ausência/atraso; a cópia independente do banco e dos objetos permanece uma entrega separada até estar realmente automatizada e testada.
- [ ] Defina alertas de uptime/readiness, CPU/RAM/disco, 5xx, systemd restart loop, certificado e falha de backup. Sentry/provider externo continua dependente de aprovação própria.
- [ ] Registre data/owner/próxima rotação de cada token, senha, chave SSH e certificado.
- [ ] Só então mude coordenadamente `PRD_DEPLOY_ENABLED=true` no repositório e no host. Em cada merge futuro, confira CI por SHA → artifact validado → migrations dry-run/push + head exato → release Oracle → smoke 15 min → confirmação; falha exige rollback/patch/PR e nova execução, nunca bypass.

Quando todos os itens aplicáveis estiverem marcados, avise. O agente então executará os testes finais possíveis, verificará os environments sem ler valores e acompanhará o primeiro deploy real.
