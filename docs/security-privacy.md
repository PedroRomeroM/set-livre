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

Os formulários com segredo não podem funcionar antes da hidratação se isso permitir fallback HTTP ou
perda silenciosa de entrada quando o React assume o HTML. Cadastro público, login operacional e chave
local usam estado servidor-fechado, `inert`, método POST e controles nativos desabilitados; a
ausência de JavaScript mantém a fronteira fechada e mostra recuperação explícita por habilitação e
reload. A reautenticação de papel só é criada depois de uma ação já hidratada. Rede, timeout ou resposta inválida
depois de uma possível publicação de sessão são tratados como ambíguos e terminais, com cleanup restrito
aos cookies canônicos.

## Autorização e banco

As camadas são rota, origem, sessão, papel/status, ownership no DAL, função SQL, constraints e
grants/RLS. IDs, role, status ou ownership recebidos do cliente nunca são autoridade.

`app_dal` é `NOLOGIN/NOINHERIT`, não possui objetos e recebe somente `USAGE private` e `EXECUTE` nos
comandos publicados. O login de produção `app_runtime_production`:

- usa senha própria e TLS `verify-full` pelo Supavisor session pooler;
- pode apenas conectar e assumir `app_dal`;
- tem limite de dez conexões;
- não possui superuser, inherit, criação, replicação, bypass RLS, TEMP ou objetos;
- ativação e recuperação seguem o contrato fail-closed canônico em
  [infrastructure.md, Banco de produção](infrastructure.md#banco-de-producao);
- falha no provisionamento e no health se ele ou `app_dal` receber `CREATE`/`TEMP` no database;
- assume `app_dal` por um único setting não secreto, limitado ao database `postgres` e validado
  exatamente pelo readiness; a segurança não depende de o Supavisor encaminhar opções do cliente;
- se catálogos gerenciados forem efetivamente legíveis, readiness exige que nenhum setting de
  role/database tenha nome de secret, password, token, credential ou key;
- não alcança `pg_net`; habilitar acesso ao schema `net` derruba readiness e bloqueia novo deploy.

Tabelas públicas nascem sem acesso, com RLS e grants independentes. Funções `security definer` usam
`search_path=''` e objetos qualificados. Leituras autenticadas pequenas permanecem `security invoker`,
sob `auth.uid()` e RLS. Readiness verifica o resultado objetivo; não duplica o catálogo inteiro como uma
segunda fonte de autorização.

Dados de CPF/CNPJ e documento permanecem em colunas privadas e não entram no read model. O navegador
mantém valores sensíveis apenas pelo tempo da ação e não os coloca em query key, URL, mutation cache ou
evidência Playwright.

Na FEAT-006, nome, descrição e endereço de revisão ainda não aprovada são acessíveis somente ao próprio
dono autenticado e elegível por grants de coluna, `auth.uid()` e RLS. A policy e o read model derivam
novamente perfil ativo/completo, autoridade de dono ativa e aceite íntegro do contrato vigente; qualquer
revogação retorna zero linhas mesmo em chamada direta à Data API, e outro dono recebe a mesma ausência.
`app_dal` não lê tabelas e executa apenas as cinco fachadas privadas de estúdio. Cada uma revalida perfil
ativo/completo, autoridade e contrato vigente antes inclusive de replay idempotente. O ledger guarda
somente hash e referências; auditoria e logs operacionais não recebem conteúdo ou endereço. O browser
mantém o editor em key com usuário + estúdio e callbacks tardios não recriam cache após troca de sessão.

Na FEAT-007, regras, FAQ e taxonomias da revisão seguem o mesmo isolamento. Tabelas filhas nascem
revogadas, com RLS independente; `app_dal` recebe somente execução nas duas novas fachadas. O comando
aceita apenas taxonomia ativa e plain text validado, persiste somente o YouTube ID e mantém URLs/HTML
fora do banco. React escapa a prévia, e o único frame remoto permitido pelo CSP é
`www.youtube-nocookie.com`; auditoria guarda contagens e presença de vídeo, sem conteúdo comercial.

Na FEAT-031, o backoffice usa storage key de cookie própria e binding no banco pelo `session_id` Auth:
30 minutos de inatividade, oito horas absolutas e cinco minutos de autenticação forte para alterar
papéis. O polling de sessão é deliberadamente passivo: revalida toda a fronteira sem atualizar
`last_seen_at`; somente leituras operacionais e comandos renovam atividade. Cada leitura e comando
revalida sessão Auth canônica, perfil ativo/concluído e papel atual;
remover todos os papéis ou suspender a conta fecha bindings existentes. `support` alcança somente
usuários e revelação temporária de PII; catálogo administrativo, taxonomias e papéis exigem `admin` no
banco, mesmo se uma rota for chamada diretamente. Papéis permanecem no servidor: o DTO de sessão e a
lista enviada ao browser carregam somente uma versão opaca de autorização; o detalhe de uma única conta
é composto por fachada admin-only no Server Component. Cada concessão/revogação é uma action explícita
contra `expectedAccountVersion`. O último admin ativo é protegido sob lock global.

PII aparece mascarada no read model. A busca comum aceita somente prefixo de e-mail ou UUID exato e
nunca avalia `profiles.name`; nome bruto fica exclusivamente na revelação por motivo allowlisted, fora
de URL/QueryCache, por até 60 segundos. A resposta só é consumida se a aba estiver
visível e é descartada se terminar durante ocultação. Um observador relê a sessão no mount, foco,
intervalo curto e eventos entre abas; identidade ou versão de autorização divergente ocultam o DOM
privado e limpam o cache antes da recomposição. Ledger e auditoria registram ator, ação, alvo,
motivo/versões e correlação, nunca o valor nem hash reutilizável da PII. Taxonomia é versionada, limitada
transacionalmente a 500 itens e arquivada sem apagar referências.

Além da sessão e da autorização no banco, toda mutação exige um desbloqueio local do runtime. A chave de
43 caracteres base64url existe apenas no EnvironmentFile do processo e na entrada efêmera do formulário;
ela não é armazenada no browser. O servidor compara seu digest em tempo constante e emite por cinco
minutos um token HMAC em cookie HttpOnly, SameSite estrito e vinculado a usuário + `session_id` Auth.
Token ausente, expirado, adulterado ou de outra sessão falha fechado antes da DAL; transições de
autenticação apagam o cookie. A release recusa a chave em artifact e o CI a transporta somente pelo
environment protegido de produção.

## Comandos, origem e abuso

Escritas cookie-based exigem método, body limitado, content type e `Origin`/`Host` exatos. Na aplicação
pública e em futura exposição HTTPS do backoffice, produção também exige `X-Forwarded-Host` e
`X-Forwarded-Proto=https` substituídos pelo Nginx confiável. Na fase atual, o backoffice não passa pelo
Nginx: escuta somente em `127.0.0.1:3001`, aceita a origem literal homônima via túnel SSH e rejeita
headers de proxy. O trecho remoto é cifrado pelo túnel; o pequeno trecho HTTP existe apenas no
loopback do navegador e permite o cookie host-only necessário à origem efetivamente acessível.
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
  o instalador root e seu lock, recusa estado de bootstrap, recovery ou ativação pendente e não altera
  a release; certificado, Nginx e rota HTTPS pública também precisam estar íntegros;
- build de produção, scan, archive determinístico, ambientes efêmeros e staging root-owned validado na
  VM terminam antes da primeira migration; a ativação posterior não aceita reupload;
- a mesma fronteira relê as duas roles e seus memberships; se já existem, o readiness do head atualmente
  implantado precisa aprovar grants, ownership, RLS e superfícies DAL antes de qualquer alteração de
  schema, e uma runtime ativa também precisa assumir `app_dal` e passar no readiness restrito; se ambas
  as roles estão ausentes, o ledger de migrations precisa estar ausente ou vazio e a superfície de
  aplicação precisa estar comprovadamente vazia, sem aceitar objetos órfãos como primeiro bootstrap;
- usuário de deploy possui apenas um comando sudo allowlisted;
- a política SSH efetiva impede ambiente persistente do usuário e aceita do cliente somente locale
  (`LANG`/`LC_*`), recusando `BASH_ENV`, qualquer padrão adicional e qualquer `ForceCommand` global que
  pudesse substituir o comando restrito da chave antes do reload;
- arquivos gerenciados do host recusam symlink/hardlink, usam staging privado `root:root 0700` no mesmo
  filesystem e entram por rename atômico; o bloqueio de bootstrap precede qualquer restrição que possa
  retirar o acesso dos serviços ao CA;
- Fail2ban fixa a ação efetiva `nftables` com cold start imediato, recusa override local e permanece ativo
  durante a transição atômica do firewall, com ação/tabela/chain/daemon/jail comprovados antes e depois
  dela;
- serviços Node rodam sem root, em loopback e com hardening systemd;
- antes das migrations, o preflight relê os arquivos operacionais instalados, o hash do Node, o site e
  link Nginx efetivos e as units carregadas com seus estados de enablement, sem confiar isoladamente no
  digest persistido;
- release é imutável, ativada por symlink e revertida por readiness;
- migrations são forward-only e não usam seed em produção.

Recuperação manual usa o mesmo workflow, gates, environment e secrets do push. Ela só é autorizada por
opt-in quando o evento foi disparado sobre `main` e o SHA digitado coincide exatamente com o
`github.sha` já protegido; o input nunca escolhe o checkout nem permite branch ou commit arbitrário.

Secrets ficam no environment do GitHub ou nos arquivos imutáveis da release ativa:
`/opt/set-livre/current/.runtime/web.env` como `root:setlivre-web 0640` e
`/opt/set-livre/current/.runtime/backoffice.env` como `root:setlivre-backoffice 0640`. Os antigos
`/etc/set-livre/*.env` não são uma superfície de runtime e são removidos pelo bootstrap. A release guarda
somente um SHA-256 não secreto do par de ambientes para impedir reuso do mesmo SHA depois de rotação. Nenhum secret
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
recusa daemon, contexto, endpoint, bridge, container ou binding divergente. No Windows, somente o
contexto `set-livre-wsl` para `tcp://127.0.0.1:2375` é aceito; containers precisam publicar cada porta
em `127.0.0.1`, sem wildcard ou equivalência IPv6. A API local do Docker é privilegiada, por isso não
pode ser encaminhada nem exposta à LAN. Ela não é fronteira de produção e não recebe firewall
customizado; os controles decisivos continuam sendo loopback estrito e nunca reutilizar dado ou
credencial real.

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
- expiração/revogação da sessão administrativa, último admin, PII efêmera e fronteira
  `support/admin`;
- concorrência/idempotência de reserva e pagamento quando implementados;
- webhook inválido/replay e upload spoof quando suas features existirem;
- redaction, CSP, secret scan e release/rollback;
- exportação/exclusão quando FEAT-034 for implementada.

Testes de risco futuro não devem ser criados antes do comportamento consumidor.
