# 2026-08-23 — Projeto Supabase de produção

## Estado

Projeto criado e identidade pública vinculada; schema Cloud permanece vazio até merge aprovado.

## Decisão e evidência

- o projeto inicial em `ca-central-1` foi apagado antes de receber migrations;
- o responsável aprovou explicitamente a cotação de US$ 10/mês para um novo projeto;
- `Set Livre Production`, ref pública `oirvvnojgkzdppkdvhej`, foi criado na organização
  `PedroRomeroM's Org`, em `sa-east-1` (São Paulo), e chegou a `ACTIVE_HEALTHY`;
- a leitura inicial comprovou zero migrations, zero tabelas próprias nos schemas da aplicação e zero
  branches;
- o Security Advisor retornou zero findings. O Performance Advisor retornou somente o `INFO`
  `auth_db_connections_absolute`, que deve ser reavaliado se o compute crescer;
- o MCP `supabase` foi reconfigurado para a nova ref e autenticado sem a feature `branching`;
- as repository variables `PRD_SUPABASE_PROJECT_REF`, `PRD_SUPABASE_URL` e
  `PRD_SUPABASE_ANON_KEY` foram atualizadas com round-trip exato; `PRD_DEPLOY_ENABLED=false` foi
  preservado;
- a senha administrativa do banco foi rotacionada com 256 bits aleatórios e guardada somente no
  Gerenciador de Credenciais do Windows, sem impressão ou versionamento;
- Auth foi configurado e relido em 22 invariantes: domínio/callback produtivos, política de senha e
  tokens, confirmação de e-mail, reautenticação e templates PT-BR canônicos. Cadastro permanece
  desativado até a conclusão do SMTP;
- SSL enforcement do PostgreSQL foi ativado. O pooler IPv4 de sessão recusou plaintext e aceitou uma
  conexão administrativa com `verify-full` e o certificado raiz oficial do projeto;
- a credencial `app_runtime_prod` foi gerada separadamente e a URL DAL protegida foi fixada no pooler
  de sessão com `options=-c role=app_dal`; criação/normalização da role permanece exclusiva do deploy
  pós-migration;
- o personal access token autenticado pela Supabase CLI comprovou acesso ao projeto exato e foi
  guardado em target operacional separado para futura instalação no host;
- o Environment GitHub `production` aceita somente `main` e também recusa bypass administrativo;
- o PAT de deploy GitHub fine-grained, separado da sessão administrativa da GitHub CLI, foi limitado
  ao repositório `set-livre`, armazenado no Gerenciador de Credenciais e comprovou repository ID,
  leitura de conteúdo e leitura de Actions sem expor seu valor;
- o gerador de release, o configurador do host e o agente de deploy recusam qualquer ref diferente,
  mesmo que ela tenha formato válido e URL coerente.

## Fronteiras

- Supabase local continua sendo o único banco de desenvolvimento e testes destrutivos;
- não serão usados Supabase Branches nesta fase;
- somente o fluxo protegido de merge em `main` pode produzir e aplicar migrations em produção;
- as 16 migrations locais não foram aplicadas manualmente: o primeiro `db push` continua reservado ao
  deploy pós-merge aprovado;
- após DDL remoto, Security e Performance Advisors precisam ser executados novamente e todo finding
  aplicável deve ser corrigido;
- senha do banco, access token, URL DAL e certificado raiz permanecem fora do repositório; as cópias
  protegidas locais já existem e ainda precisam ser instaladas no host quando a VM existir;
- SMTP, CAPTCHA, owner/MFA organizacional e restore drill continuam ações humanas antes de tráfego
  público. O cadastro permanece fail-closed enquanto o SMTP não estiver comprovado.
