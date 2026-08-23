# Fundação de entrega cloud controlada

## Estado

Em implementação. GitHub, MCP Supabase e a rede OCI isolada têm evidência externa. O projeto Supabase existente está no Canadá e não é produção; o projeto de São Paulo ainda não foi criado. A VM E2 Micro diagnóstica chegou a `RUNNING`, comprovou SSH e foi depois terminada com o boot volume para eliminar o host parcial; novos Plans retornam `OUT_OF_HOST_CAPACITY`. Nenhum PR, workflow hospedado, merge ou deploy desta revisão foi executado; hardening, agente e produção continuam fail-closed por `PRD_DEPLOY_ENABLED=false`.

## Motivação

O responsável criou o projeto Supabase `set-livre`, adquiriu `setlivre.com` e autorizou retomar CI/CD e infraestrutura cloud que o ADR-018 havia suspendido temporariamente. O projeto criado em `ca-central-1` permanece fora de produção; o destino brasileiro precisa ser um novo projeto em `sa-east-1` (São Paulo), criado somente após autorização humana de custo. A mudança preserva Supabase local para testes destrutivos, migrations append-only, DAL restrita, release Oracle Linux sem Docker e revisão humana antes de produção. O ADR-021, aceito depois deste registro inicial, fixa o alvo atual em E2 Micro x86_64.

## Mudanças

- ADR-019 libera somente CI, Supabase Cloud, Oracle, DNS e TLS; providers externos continuam suspensos;
- o workflow CI copiado de outro projeto deixa de usar runner/nome/toolchain Spenses e passa a executar os gates normativos com Node 24.18/npm 11.19, PostgreSQL 18.4, Supabase local e Playwright;
- a proteção de `main` também exige `Windows native contracts`: uma segunda fronteira GitHub-hosted `windows-2025` executa a suíte unitária integral e impede que Job Object, DACL, PowerShell ou Docker Desktop sejam considerados cobertos apenas por skips Linux;
- cada `push` de `main` recebe CI não cancelável em grupo por SHA. O workflow de produção deixa de disparar no fechamento bruto do PR: ele consome o SHA aprovado, exige `workflow_run.path=.github/workflows/ci.yaml`, repositórios do run/origem iguais ao atual, pertencimento ao `main`, Environment/flag, identidade e ancestralidade monotônicas;
- como o repositório é público, build/package roda exclusivamente em GitHub-hosted Linux x86_64, sem secrets server-side ou mutação, e publica artifact imutável por action fixada. A VM não hospeda runner do GitHub e não aceita SSH de deploy;
- o Environment `production` build-only aceita somente `main`, não contém secrets nem muta Cloud/VM. Com um único colaborador, autoaprovação não é tratada como controle: a autorização vigente combina ciclos de `@codex review` até parecer limpo, merge protegido e as travas independentes do repositório/host;
- a identidade CI/publicação usa `actions/github-script` oficial `v9.0.0`, fixada pelo commit `3a2844b7e9c422d3c10d287c895573f7108da1b3`, removendo curl autenticado, JSON temporário e Python inline dessa fronteira. Os blocos `run:` ficam abaixo de 4 KiB e permanecem analisáveis pela integração Actionlint/ShellCheck no Windows;
- um agente pull outbound-only separado de root consulta artifacts aprovados pela API do GitHub e valida repositório, workflow, run, branch, SHA, digest, tamanho, manifesto schema 4, `publicBuildConfigSha256`, runtime e ancestralidade antes de mutar qualquer sistema. O artifact não contém CLI administrativa; a CLI Supabase oficial é instalada e verificada como ferramenta root-owned do host, fora da autoridade da release/agente. A origem ordena/checkpointa a fila independentemente do run provedor de uma recuperação; paginação limitada percorre páginas até fim comprovado, sem esconder origem ou recovery. O `curl` autenticado começa por `--disable`;
- a release inclui catálogo SQL somente leitura e contrato semântico assinado da transição N−1/N. A prova local aplica os dois heads, captura relações/RLS/policies/ACLs e exige aprovação exata para toda ampliação. O estado limpo atual contém 16 migrations, com predecessor `20260815000100` e head `20260819000100`; o delta Cloud será produzido e revisado no primeiro deploy, sem presumir resultado antes da execução. No host, o agente persiste o snapshot Cloud anterior ao push e recusa qualquer pós-delta divergente ou autoridade incondicionalmente perigosa;
- o agente cruza privilégio somente pelo dispatcher root-owned allowlisted; a verificação exige grupo efetivo com um único membro e exatamente uma entrada `sudo -ll` root para o dispatcher, sem `setenv` ou sudo genérico. O bootstrap recebe somente `<admin-cidr-/32> <release-manager-source> <release-manager-sha256>`, congela a fonte antes de qualquer pacote, não recebe chave/usuário/SSH de deploy, e `configure-production-deployer.sh` instala/verifica agente, smoke, dispatcher e timer por hashes fixados. Atualização posterior do manager usa transação administrativa root-owned própria, nunca agente ou artifact;
- builds/packages podem progredir fora da produção; o timer do host serializa a mutação e a validação monotônica recusa downgrade em ordem inesperada;
- o bootstrap de npm baixa o tarball oficial `11.19.0`, valida SHA-512 e SHA-256 fixados e instala somente o arquivo local com scripts desativados; download adulterado ou identidade divergente falha antes da instalação;
- a release de produção contém web, backoffice e migrations por SHA; não contém runtime secret nem usa Docker na VM;
- o release manager protocolo v3 copia staging para área root-owned, valida manifesto schema 4, hash público, runtime, head e árvore antes de qualquer migration e reusa exatamente os mesmos bytes na ativação. Depois sincroniza release, runtime, proveniência, estados e symlinks. Uma unit root-owned recupera e prova um único `pending` antes de web, backoffice e Nginx iniciarem; `confirm` torna a confirmação durável antes de desarmar o watchdog;
- readiness aceita a janela explícita `20260819000100` + predecessor `20260815000100`, enquanto o deploy prova separadamente que o head remoto é exatamente `20260819000100`. O primeiro deploy estabelece a baseline; cada delta posterior exige o marcador expand-only, recusa contrações conhecidas e executa smoke do SHA N-1 contra o banco já migrado antes da ativação;
- os secrets Supabase/DAL e o token GitHub de leitura de Actions ficam somente em `/etc/setlivre-deployer/production.env`; GitHub Actions recebe apenas variáveis públicas do bundle e `PRD_DEPLOY_ENABLED` permanece uma variável de repositório falsa;
- a reconciliação de 2026-08-18 fixa `GITHUB_REPOSITORY_ID=1328339374` no host e exige IDs positivos e distintos para os workflows CI/PRD. Eles só podem ser consultados pelos paths exatos depois do registro no GitHub; até o preenchimento e `verify`, as travas de deploy permanecem falsas;
- o primeiro merge usa bootstrap explícito sem commit vazio: preserva o run `CI` do `push` inicial, registra os IDs e verifica o host com ambas as travas falsas; depois da habilitação coordenada, uma única reexecução desse mesmo run conserva SHA/ref, incrementa o attempt e produz o `workflow_run: completed` validado pela publicação. `workflow_dispatch` continua restrito à regeneração de artefato de uma publicação anterior aprovada;
- a sandbox systemd do agente foi estreitada para escrita somente em `/var/lib/setlivre-deployer/.setlivre`, `/opt/setlivre` e `/run/lock`; `/run` inteiro não integra o contrato;
- o smoke exige `application` e `release` exatos em live/ready, cobre home, login, backoffice, negação Auth e redirects HTTP canônicos. Falha HTTPS ou de redirect aciona rollback e comprova novamente a release N-1; primeiro deploy falho deixa os serviços inativos;
- DNS/TLS converge para um único certificado SAN `setlivre.com` que também cobre `www` e `ops`; a emissão usa helper root-owned sobre `certbot certonly --webroot`, o plugin Nginx não é instalado, e a ativação/renovação passa por outro helper root-owned que valida certificado, configuração e rollback;
- `configuration-seteps.md` lista MCP/OAuth, Supabase Auth/banco, GitHub Environment/proteções, OCI/SSH administrativo, DNS/TLS, hardening, backup, monitoramento e verificações humanas;
- documentos vivos distinguem configuração em código de recursos realmente criados e preservam as pendências até evidência externa.

## Evidência externa desta rodada

- no Windows, a configuração ativa separa `supabase`/Set Livre de `supabase_spenses`; em `2026-08-18`, uma leitura MCP retornou o projeto Set Livre em `ca-central-1` e a lista remota de migrations vazia. Esse projeto não é produção e não receberá o deploy;
- os Security Advisors do projeto canadense reportaram 2 WARN relacionados a `rls_auto_enable`. A correção canônica existe somente na migration local append-only `20260819000100_supabase_rls_event_trigger_acl_hardening.sql`; ela ainda não foi aplicada no Cloud. O projeto de São Paulo precisará de advisors próprios após a criação, sem transportar o diagnóstico canadense como prova;
- OCI CLI oficial `3.90.1` foi instalada no Windows e o perfil `SET_LIVRE` autenticado por browser; discovery e chamadas de criação usaram o compartment isolado, sem reutilizar recursos de outros projetos;
- no discovery inicial, foram confirmados `sa-saopaulo-1`, uma AD, A1 Flex, Ubuntu 24.04 ARM64 e disponibilidade de limite A1. Também foram identificados recursos de Spenses/outro projeto, recusados como alvo;
- naquela fase A1, foram criados apenas compartment/VCN/subnet/route/IGW/security list/NSG próprios; os relatórios 2/12, 1/6, 1/12 e 2/6 retornaram `OUT_OF_HOST_CAPACITY`. Naquele snapshot, nenhuma VM/VNIC/IP havia sido criada e não houve fallback pago/x86;
- depois da aprovação humana registrada no ADR-021, uma instância diagnóstica `set-livre-production` foi comprovada `RUNNING` em `sa-saopaulo-1`, no shape `VM.Standard.E2.1.Micro` x86_64, com 1 OCPU, aproximadamente 1 GB, Ubuntu 24.04, boot 50 GB, IMDSv2-only e SSH administrativo confirmado. Ela e o boot volume foram depois terminados; a posição de quota está liberada, mas novos Plans retornam `OUT_OF_HOST_CAPACITY`. Hardening e deploy não estão comprovados.

Nenhum token, chave, senha, OCID completo ou URL de banco foi registrado no repositório.

## Segurança e rollback

- workflows têm `contents: read`, checkout sem credencial persistida e SHA/projeto validados; nenhum secret de produção entra no Actions;
- a política hospedada do repositório aceita somente Actions GitHub-owned e exige pin por SHA completo; creators verificados genéricos e patterns adicionais ficam desabilitados;
- PR usa somente Supabase local; segredos de produção permanecem apenas no host e são removidos do ambiente do agente depois da captura;
- produção nunca executa reset, seed ou `config push`; migrations aplicadas não recebem down automático;
- falha de migration ou do smoke N-1 pós-migration impede a troca da aplicação; falha de health, smoke, cancelamento, crash/reboot com `pending` ou lease não confirmado restaura e volta a testar a release anterior quando disponível, ou comprova os serviços inativos no primeiro deploy falho;
- a VM não possui runner GitHub nem aceita ingress SSH de deploy; o agente pull usa outbound, conta sem login, dispatcher allowlisted e release manager v3 root-owned;
- hardening, DNS/TLS e go-live permanecem bloqueados até configuração humana e smoke;
- correção de workflow ou schema usa novo PR/migration, sem editar história aplicada.

## Validação atual

- o catálogo documental limpo contém 200 cenários;
- a cadeia local possui 16 migrations, predecessor `20260815000100` e head `20260819000100`;
- `npm run supabase:reset`, a geração canônica e `npm run test:db` comprovaram o estado local; o pgTAP passou em 4 arquivos e 361/361 testes;
- o readiness atual confere exatamente 17 dependências ACL e 16 rotinas DAL;
- essas provas são locais. Não representam projeto Supabase de São Paulo, migration remota, VM ativa, hardening, workflow hospedado, PR, merge, deploy, smoke público ou produção;
- os demais gates da branch e o primeiro run GitHub permanecem pendentes e não são inferidos desta validação dirigida.

## Pendências para conclusão

1. concluir os gates integrais da branch sem enfraquecer testes ou aceitar workaround;
2. obter autorização humana de custo, criar o projeto Supabase em `sa-east-1`, atualizar MCP/variáveis e comprovar Auth, runtime DAL, advisors e backups; o projeto canadense permanece excluído;
3. aguardar capacidade e provisionar uma E2 Micro x86_64 limpa; concluir e provar hardening, budgets de memória, IP/SSH administrativo `/32`, agente e dispatcher;
4. criar o PR, concluir os ciclos de `@codex review`, resolver todas as conversas e preservar as proteções de `main`;
5. após o merge, acompanhar CI, migrations Cloud, artifact, primeiro deploy Oracle, smoke de 15 minutos, confirmação e watchdog até estado terminal;
6. configurar DNS/TLS para `setlivre.com`, `www.setlivre.com` e `ops.setlivre.com` e atualizar a evidência sem fechar pendências antes das provas.
