# Segurança, privacidade e LGPD

Este documento define controles duráveis. Detalhes de payload e fluxo ficam em
[`api-contracts.md`](api-contracts.md), e grants/RLS em [`database.md`](database.md).

## Modelo de ameaça

Ativos prioritários: contas, documentos, endereços, calendários, reservas, pagamentos, referências de
provider, mídia, secrets e funções administrativas.

Ameaças prioritárias: acesso entre usuários, escalada de papel, IDOR, dupla reserva, webhook forjado ou
replay, upload malicioso, abuso de comandos, vazamento em logs/artifacts, deploy comprometido, exclusão
indevida e fraude financeira.

Ausência de configuração sempre falha fechado. Complexidade adicional exige uma ameaça ou incidente
concreto, conforme ADR-022.

## Autenticação e sessão

- Supabase Auth fornece e-mail/senha, confirmação e recovery;
- clientes SSR são criados por request e o servidor valida a identidade autoritativa;
- cookies são `HttpOnly`, `SameSite` e `Secure` fora do loopback local;
- `returnTo` usa allowlist e logout limpa caches privados;
- recovery não revela existência de conta e separa sessão comum de grant one-shot;
- confirmação/recovery aceitam somente tokens e tipos esperados, sem publicar segredo em query/log;
- estado de sessão ambíguo nunca é repetido automaticamente; o usuário reinicia ou força recomposição
  SSR;
- conta suspensa não executa comando e backoffice revalida papel no servidor.

Os formulários com segredo não podem funcionar antes da hidratação se isso permitir fallback GET. Rede,
timeout ou resposta inválida depois de uma possível publicação de sessão são tratados como ambíguos e
terminais, com cleanup restrito aos cookies canônicos.

## Autorização e banco

As camadas são rota, origem, sessão, papel/status, ownership no DAL, função SQL, constraints e
grants/RLS. IDs, role, status ou ownership recebidos do cliente nunca são autoridade.

`app_dal` é `NOLOGIN/NOINHERIT`, não possui objetos e recebe somente `USAGE private` e `EXECUTE` nos
comandos publicados. O login de produção `app_runtime_production`:

- usa senha própria e TLS `verify-full` pelo Supavisor session pooler;
- pode apenas conectar e assumir `app_dal`;
- tem limite de dez conexões;
- não possui superuser, inherit, criação, replicação, bypass RLS, TEMP ou objetos;
- falha no provisionamento e no health se ele ou `app_dal` receber `CREATE`/`TEMP` no database;
- não possui GUC próprio em produção; se catálogos gerenciados forem efetivamente legíveis, readiness
  exige que nenhum setting de role/database tenha nome de secret, password, token, credential ou key;
- não alcança `pg_net`; habilitar acesso ao schema `net` derruba readiness e bloqueia novo deploy.

Tabelas públicas nascem sem acesso, com RLS e grants independentes. Funções `security definer` usam
`search_path=''` e objetos qualificados. Leituras autenticadas pequenas permanecem `security invoker`,
sob `auth.uid()` e RLS. Readiness verifica o resultado objetivo; não duplica o catálogo inteiro como uma
segunda fonte de autorização.

Dados de CPF/CNPJ e documento permanecem em colunas privadas e não entram no read model. O navegador
mantém valores sensíveis apenas pelo tempo da ação e não os coloca em query key, URL, mutation cache ou
evidência Playwright.

## Comandos, origem e abuso

Escritas cookie-based exigem método, body limitado, content type, `Origin`/`Host` exatos e, em produção,
`X-Forwarded-Host` e `X-Forwarded-Proto=https` substituídos pelo Nginx confiável.
`X-Forwarded-For` recebe um único `$remote_addr`; cadeia fornecida pelo cliente é descartada. A borda
gera um UUIDv4 a partir do `$request_id` interno, substitui o header não confiável de entrada e usa o
mesmo valor no upstream, na resposta e no log. O access log do Nginx substitui o formato `combined`:
registra somente horário, método, status, bytes, durações e esse request ID, sem IP, host, target/query,
referer ou user-agent. O rate limiter registra eventos por-request abaixo do threshold do error log para
que respostas `429` não recoloquem endereço ou URI em outro sink. Como o formato nativo de erro não é
redigível e inclui request/IP em falhas rotineiras de proxy, a persistência fica em severidade `crit`;
respostas `502` permanecem observáveis no access log redigido pelo request ID autoritativo. A localização
ACME recusa symlinks também nos arquivos-folha em tempo de request e descarta o diagnóstico nativo dessa
recusa, que contém IP e target; o access log redigido preserva status e request ID.

Rate limiting ocorre antes do parse e novamente por ação/identidade pseudonimizada. A camada em memória
protege o processo único; iptables/Fail2ban, Nginx e constraints/idempotência formam as demais camadas. Horizontalizar
exigirá armazenamento compartilhado medido, não um Redis antecipado.

Webhooks não usam sessão: validam assinatura, timestamp, unicidade, idempotência e replay. O navegador
nunca coordena mutações múltiplas para simular atomicidade.

## Produção e supply chain

- somente `main` aprovada produz release;
- PRs não recebem secrets de produção;
- `npm ci`, lockfile, audit e actions oficiais fixadas por SHA;
- builds ocorrem em runner Linux x86_64, nunca na VM;
- caches transitórios do Next são removidos após sucesso ou falha; erro de limpeza invalida o build;
- archive é identificado por SHA-256 e manifesto com o commit completo;
- VM aceita SSH somente por chave; senha e root login ficam desabilitados, arquivos e diretórios da
  configuração exigem ownership root sem escrita não privilegiada, e políticas condicionais `Match` ou
  includes fora da superfície global canônica são recusados antes do reload;
- antes de migrations forward-only, o deploy exige uma única host key Ed25519 para o IP canônico e
  autentica a chave privada contra o comando SSH forçado; o preflight atravessa `sudo` não interativo,
  o instalador root e seu lock, recusa estado de bootstrap/recovery pendente e não altera a release;
- a mesma fronteira relê as duas roles e seus memberships; se já existem, o readiness do head atualmente
  implantado precisa aprovar grants, ownership, RLS e superfícies DAL antes de qualquer alteração de
  schema, e uma runtime ativa também precisa assumir `app_dal` e passar no readiness restrito;
- usuário de deploy possui apenas um comando sudo allowlisted;
- arquivos gerenciados do host recusam symlink/hardlink, usam staging privado `root:root 0700` no mesmo
  filesystem e entram por rename atômico; o bloqueio de bootstrap precede qualquer restrição que possa
  retirar o acesso dos serviços ao CA;
- Fail2ban fixa a ação efetiva `nftables` com cold start imediato, recusa override local e permanece ativo
  durante a transição atômica do firewall, com ação/tabela/chain/daemon/jail comprovados antes e depois
  dela;
- serviços Node rodam sem root, em loopback e com hardening systemd;
- release é imutável, ativada por symlink e revertida por readiness;
- migrations são forward-only e não usam seed em produção.

Recuperação manual usa o mesmo workflow, gates, environment e secrets do push. Ela só é autorizada por
opt-in quando o evento foi disparado sobre `main` e o SHA digitado coincide exatamente com o
`github.sha` já protegido; o input nunca escolhe o checkout nem permite branch ou commit arbitrário.

Secrets ficam no environment do GitHub ou nos arquivos imutáveis da release ativa:
`/opt/set-livre/current/.runtime/web.env` como `root:setlivre-web 0640` e
`/opt/set-livre/current/.runtime/backoffice.env` como `root:setlivre-backoffice 0640`. Os antigos
`/etc/set-livre/*.env` não são uma superfície de runtime e são removidos pelo bootstrap. Nenhum secret
entra em variável `NEXT_PUBLIC`, artifact, log, screenshot ou documentação. Publishable key e host key
SSH não são secrets; URL DAL, senhas, access token e chave privada são.
Ferramentas Supabase executadas pelo wrapper nunca herdam stderr: em erro, apenas a mensagem JSON
reconhecida e com URL de banco redigida é emitida.

## Borda e headers

Next gera CSP com nonce por request e não usa `unsafe-inline`/`unsafe-eval` em produção. Nginx preserva
os headers da aplicação, remove informação de versão e termina TLS. A baseline inclui HSTS depois da
emissão do certificado, `nosniff`, referrer policy, permissions policy e bloqueio de framing.
Antes do go-live, Nginx aceita somente o Host do IP reservado, não expõe o backoffice e envia `noindex`
em toda resposta pública, além de bloquear crawling no `robots.txt`.

Novas origens CSP entram apenas com a integração consumidora e teste. Respostas autenticadas e HTML
dinâmico não são cacheados; assets com hash podem receber cache imutável.

Uploads futuros usam URL assinada curta, path derivado, allowlist de MIME, validação dos bytes, tamanho
limitado, Storage RLS e cleanup. SVG e nomes de usuário nunca chegam a processamento shell.

## Ambiente local

Supabase local e E2E usam somente a fronteira local validada, dados QA descartáveis e credenciais próprias
geradas a cada reset. O preflight recusa banco/URL não local antes de abrir navegador; o wrapper também
recusa daemon, bridge, política do Docker Desktop, container ou binding divergente. Docker Desktop não é
uma fronteira de produção e não recebe firewall customizado; o controle decisivo continua sendo não
reutilizar dado ou credencial real.

Arquivos `.env.local` são ignorados e escritos com permissão privada quando a plataforma oferece essa
semântica. Antes de interpretar `.env.e2e.local`, o leitor recusa links e arquivos não regulares ou com
mais de um hard link; em POSIX também exige owner igual ao usuário efetivo e modo exato `0600`. No
Windows não se simulam permissões POSIX inexistentes.

## Privacidade e LGPD

Inventário atual: nome, e-mail no Auth, telefone, CPF/CNPJ, documento adicional, aceites jurídicos,
estado do dono/recebedor e histórico operacional. Dados bancários completos, PAN e CVV nunca são
armazenados; provider futuro deve custodiar o que puder.

Princípios:

- minimização em coleta, read models, logs e auditoria;
- termos versionados com hash, data e aceite não pré-selecionado;
- correção do perfil sem reescrever fatos financeiros;
- exportação privada, temporária e autorizada;
- exclusão por solicitação, bloqueio de novos fluxos, resolução financeira, anonimização, revogação de
  Auth e preservação legal mínima;
- retenção definida pelo jurídico antes do go-live.

Defaults ainda sujeitos a aprovação: logs técnicos 30 dias, uploads órfãos 24 horas, exportações 7 dias
e backups 30 dias. Fatos fiscais/financeiros seguem obrigação legal, não hard delete.

## Incidentes e testes

Incidente segue identificação, contenção, preservação redigida, rotação, avaliação, comunicação,
correção e revisão dos controles.

Cobertura proporcional inclui:

- isolamento entre ao menos dois usuários, dono e admin;
- role escalation, IDOR, origem inválida e body grande;
- concorrência/idempotência de reserva e pagamento quando implementados;
- webhook inválido/replay e upload spoof quando suas features existirem;
- redaction, CSP, secret scan e release/rollback;
- exportação/exclusão quando FEAT-034 for implementada.

Testes de risco futuro não devem ser criados antes do comportamento consumidor.
