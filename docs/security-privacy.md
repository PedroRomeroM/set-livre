# Segurança, privacidade e LGPD

## 1. Modelo de ameaça

Ativos:

- contas;
- CPF/CNPJ/documentos;
- endereço de estúdios;
- calendários;
- reservas;
- pagamentos;
- IDs de provider;
- mídia;
- secrets;
- funções administrativas.

Ameaças prioritárias:

- acesso entre usuários;
- escalada de papel;
- dupla reserva;
- webhook forjado/replay;
- IDOR;
- upload malicioso;
- vazamento em logs;
- abuso de comandos;
- deploy comprometido;
- exclusão indevida;
- fraude financeira.

## 2. Autenticação

- e-mail/senha via Supabase;
- confirmação de e-mail;
- recovery sem revelar existência;
- cookies seguros;
- servidor valida usuário;
- logout limpa caches;
- returnTo em allowlist;
- conta suspensa não executa comando;
- backoffice verifica role a cada request sensível.

Na FEAT-002, os clientes Supabase são criados por request no servidor, a sessão é validada por claims e pelo read model do próprio perfil, e os cookies são `HttpOnly`, `SameSite=Lax` (`Strict` para o grant temporário e o marcador de escopo de recovery) e `Secure` fora do HTTP loopback local. Os ambientes `development`/`production` recusam origens sem HTTPS para a aplicação ou o Supabase; somente `local`/`test` aceitam os endpoints HTTP `127.0.0.1` exatos. Confirmação e recovery aceitam somente `signup`/`recovery`: templates locais colocam o `TokenHash` no fragmento `#`, que não é enviado ao servidor no primeiro GET, e a UI apaga query/fragmento antes de publicar o JSON.

Nos dois callbacks, somente uma resposta válida `SERVICE_UNAVAILABLE` produzida antes de iniciar `verifyOtp` preserva o payload exclusivamente em memória para retry. Após o POST, rede indisponível, timeout ou resposta inválida são ambíguos para o cliente; depois que `verifyOtp` começa, erro de transporte/desconhecido ou publicação de sessão inconclusiva pode suceder ao consumo do OTP. Esses casos são terminais: o servidor devolve `AUTH_RESTART_REQUIRED` no signup ou `RECOVERY_RESTART_REQUIRED` no recovery, descarta a sessão e somente o cookie Supabase Auth base e seus chunks numéricos exatos, e o cliente apaga o payload sem oferecer retry. O mesmo fallback remove publicação parcial de login e cookies residuais quando o sign-out final de recovery não pode ser comprovado, sem apagar cookies de prefixo semelhante ou mascarar a causa pública redigida.

No login, `NETWORK_UNAVAILABLE`, `REQUEST_TIMEOUT` e `RESPONSE_INVALID` após o envio também são ambíguos para o browser: a resposta pode ter se perdido depois da publicação dos cookies. O servidor usa `AUTH_SESSION_RECHECK_REQUIRED` quando `setSession` já começou e a publicação ou seu cleanup exato termina inconclusivo; esse código válido continua sendo terminal, não uma indisponibilidade pré-publicação. Antes de recarregar `/entrar`, o cliente apaga a referência one-shot, oculta e reseta os controles, limpa o `QueryClient` e publica somente uma sentinela anônima. A rota SSR decide então entre a sessão realmente ativa e a cópia de entrada não confirmada; somente rejeições comprovadamente anteriores à publicação, como credencial inválida, rate limit ou indisponibilidade do provider durante a autenticação inicial, continuam no formulário sem essa transição.

Erros retryable de atualização recovery não conservam o objeto `Error` nem códigos, stack ou credenciais. Somente a mensagem pública, o scope UUID público de origem e os erros allowlisted de senha/confirmação pertencem ao boundary externo; eles atravessam o refetch que desmonta o formulário e só voltam ao DOM depois de `allowed=true`, scope idêntico e `fetchStatus=idle`.

No callback de recovery, `sub`, `session_id` e `exp` vêm do JWT validado pelo Supabase e precisam corresponder à sessão canônica em `auth.sessions`. O banco cria uma binding/tombstone por `session_id`, vinculada ao usuário, e um grant opaco one-shot de 15 minutos. O UUID `session_scope` é deliberadamente público, opaco e não autoritativo: ele chega à interface apenas para isolar cookie, resposta e cache, mas nunca substitui o JWT assinado, a binding ou o grant na decisão de acesso.

O grant só volta ao estado livre após uma rejeição explícita que prove ausência de efeito e enquanto ainda está vigente; expiração ou falha ambígua mantém a tentativa terminal e exige novo link. Consumo, fechamento, expiração, marcador ausente/divergente ou uso da sessão fora das superfícies de recovery encerram a sessão Auth local, removem o grant e preservam a tombstone para impedir replay mesmo sem os cookies auxiliares. Uma sessão Auth comum sem binding não é classificada como recovery; um marcador residual é apenas descartado. O tempo de JWT Auth fica pinado em `3600` segundos e integra o readiness. Quando a ausência da sessão canônica é observada, a tombstone é fechada e retida conservadoramente por pelo menos mais 65 minutos; purge só ocorre depois de `retain_until` e enquanto `auth.sessions` continua ausente. `private.signup_legal_intents`, `private.identity_recovery_grants` e `private.identity_recovery_sessions` usam RLS sem policy e zero grants runtime. Respostas de recovery não distinguem conta existente.

## 3. Autorização

Camadas:

1. rota;
2. sessão;
3. status/papel;
4. ownership no handler/DAL;
5. função SQL;
6. constraints;
7. grants/RLS.

Nunca aceitar `owner_user_id`, `role`, `status`, shares ou `approved` do cliente como autoridade.

Na DAL, `app_dal` é `NOLOGIN`/`NOINHERIT` e pode ser assumida somente pelo login restrito configurado; as referências administrativas `postgres` exigidas pelo PostgreSQL 17 não possuem `SET/INHERIT`, e nenhuma role intermediária pode assumir o login. O readiness aplica allowlists exatas às duas identidades: `app_dal` não possui objetos nem default privileges e recebe diretamente apenas `USAGE` em `private` e `EXECUTE` nas doze rotinas autorizadas — os dois checks de readiness, a criação da intenção legal, `issue`/`inspect`/`claim`/`release`/`consume`/`close` do contexto recovery e os três comandos `complete`/`update identity`/`update appearance` do perfil —, totalizando treze dependências ACL; a leitura de perfil usa `public.get_my_profile()` como `security invoker`, sem UUID de entrada e sob `auth.uid()` + RLS. O login recebe somente `CONNECT`, sua membership DAL, limite de dez conexões, validade infinita e a máscara local vazia do GUC de assinatura. `TEMPORARY` é revogado de `PUBLIC`, não é concedido à DAL nem ao login e sua ausência efetiva é verificada nos dois entrypoints de readiness; grants explícitos administrados pela stack permanecem intocados. A inspeção recusa grants por coluna, a role como grantor, parâmetros residuais, terceiro membro ou ownership fora do manifesto. A baseline pública é exata; objetos alcançáveis de `private` e objetos compartilhados monitorados falham fechado. Em `pg_catalog`, cada privilégio de relação ou coluna concedido a `PUBLIC` precisa estar contido na baseline inicial `i`/`e` do próprio objeto registrada em `pg_init_privs`; isso preserva as leituras built-in do PostgreSQL sem aceitar expansões posteriores, como `SELECT` em `pg_authid` ou em `rolpassword`. Rotinas são comparadas pelo OID do overload: ACL `i`/`e` prevalece; sem esse registro, membros de extensão usam `pg_extension.extowner` e demais built-ins initdb (`OID < 16384`) usam o owner bootstrap OID `10`, nunca o `proowner` mutável do objeto. O owner precisa coincidir com essa origem mesmo quando `PUBLIC` não conserva `EXECUTE`; uma rotina normal posterior começa com baseline pública vazia. Grantor e grant option também precisam caber na origem canônica, portanto o default interno e membros legítimos de extensão continuam válidos sem liberar `pg_read_file(text)`, função nova ou grantor derivado de owner adulterado. `pg_roles`, `pg_user` e `pg_db_role_setting` continuam sob a garantia adicional de ACL/owner exatos e inacessibilidade direta, por coluna ou transitiva às roles web/DAL. Row types, arrays e multiranges implícitos seguem seus objetos canônicos; composites explícitos continuam monitorados. O contrato restringe expansão direta de `PUBLIC`; ele não avalia sozinho a semântica da rotina, grants a roles nomeadas nem afirma que todo catálogo interno seja confidencial.

Na FEAT-003, CPF/CNPJ e documento adicional permanecem somente nas colunas privadas alcançadas pela DAL e nunca são selecionados pelo read model. O DTO próprio contém apenas máscaras estruturais, nome e telefone do titular autenticado; qualquer `user_id` divergente da sessão falha antes de publicar resposta ou cookie. CPF/CNPJ e documento adicional não entram em query key, estado React, `MutationCache`, log ou retorno de conflito: os inputs não controlados são lidos via `FormData`, copiados para uma referência one-shot somente durante o comando e limpos em todo desfecho remoto. O cache de conta é escopado por `userId` e mantém PII fora do DOM durante hidratação, refetch, pausa offline, erro ou troca de sessão. `sl-color-scheme` é uma projeção HttpOnly allowlisted de `system | light | dark`, apagada antes de trocar identidade e reemitida apenas a partir do perfil autoritativo.

O `pg_net` fornecido pela stack Supabase concede capacidades HTTP e de fila por ACLs gerenciados por `supabase_admin`, que a role de migration não pode revogar. Durante a fronteira local-first do ADR-018, o bootstrap usa exclusivamente o superuser local, em loopback, para revogar schema, tabelas, sequências, funções e defaults de `net` para `PUBLIC` e todas as roles runtime; somente o worker administrativo configurado como `postgres` mantém o acesso técnico necessário. A normalização equivalente na Supabase Cloud permanece bloqueada por PEND-002 e precisa garantir que o login DAL não leia material de assinatura nem por GUC/current_setting nem diretamente em `pg_roles`, `pg_user` ou `pg_db_role_setting` antes de liberar tráfego.

## 4. Dados pessoais

Inventário:

- nome;
- e-mail;
- telefone;
- CPF/CNPJ;
- documento;
- IP/user-agent hashed para evidência;
- endereço do dono quando provider exigir;
- dados bancários enviados ao provider;
- histórico de reserva/pagamento.

Minimização:

- banco Set Livre não guarda dados bancários completos se provider pode custodiar;
- e-mail do Auth não é replicado publicamente;
- read models limitam;
- logs pseudonimizam;
- payload de webhook é redigido.

## 5. Criptografia e secrets

- TLS;
- secrets em env server-side;
- `.env` fora do Git;
- provider IDs/tokens privados;
- rotação documentada;
- backups criptografados no Object Storage;
- chaves de criptografia fora do repositório;
- nenhum secret em GitHub artifact sem proteção.

## 6. CSRF/origin

Comandos cookie-based validam:

- `Origin` e `Host` exatos contra a origem configurada; em produção, também `X-Forwarded-Host` exato e `X-Forwarded-Proto=https` sobrescritos pela borda confiável;
- método;
- content type;
- SameSite.

Webhooks não usam sessão; usam assinatura.

## 7. Rate limiting

VM única: memória por processo é primeira camada. Operações críticas também usam idempotência e constraints.

- toda rota de escrita consome um bucket de fachada antes do parse/Zod e um bucket pseudonimizado específico depois da validação;
- no local direto, a fachada é compartilhada porque somente loopback é permitido; em produção, o app falha fechado sem um único `X-Forwarded-For` canônico sobrescrito pelo Nginx confiável;
- o armazenamento local mantém no máximo 10.000 buckets exatos e nunca remove um bucket vivo; um discriminador exato com cota esgotada continua recebendo `429` até o fim de sua janela, mesmo sob churn de cardinalidade;
- quando a capacidade exata está cheia, chaves inéditas compartilham um contador overflow sticky por classe de ação até o reset da janela. Existem no máximo 64 partições overflow; se uma nova classe exceder esse limite depois da remoção dos contadores expirados, a admissão falha fechado. A pressão de uma ação não reinicia a cota exata de outra, embora o compartilhamento conservador possa rejeitar chaves legítimas da própria classe;
- a camada in-memory continua limitada ao processo e não substitui o limiter obrigatório da borda, necessário para absorver tráfego hostil e coordenar qualquer futura execução com mais de uma instância;
- normalizar IP confiando apenas em proxy configurado;
- fail-closed para payment/admin;
- fail-open controlado para leitura baixa;
- resposta 429 genérica;
- métricas.

## 8. Upload

- signed URL curta;
- path derivado;
- MIME e bytes reais;
- limites;
- sem SVG;
- imagem decodificável;
- nenhum processamento shell com nome do usuário;
- cleanup;
- Storage RLS.

## 9. Headers

Nginx/Next:

- HSTS;
- CSP;
- `nosniff`;
- referrer policy;
- permissions policy;
- frame ancestors;
- remoção de `X-Powered-By`.

CSP inclui somente Supabase, provider de pagamento, YouTube privacy embed e origens necessárias. Alteração exige teste.

Na fundação local, a CSP permite somente a própria origem e dados/imagens necessários à tela técnica. Cada app gera no Proxy um nonce criptograficamente novo por request, envia a mesma política nos headers internos da renderização e da response e autoriza o bootstrap do App Router com `script-src 'nonce-<valor>' 'strict-dynamic'`. O Proxy cobre toda resposta, inclusive prefetches, caminhos apenas parecidos com endpoints reservados e o namespace `/_next/static/`: assets válidos preservam o cache imutável e erros de método, range ou path não escapam da CSP caso o framework os transforme em HTML. Produção não possui `unsafe-inline` nem `unsafe-eval` em `script-src`; `unsafe-eval` e conexões HTTP/WebSocket localhost existem somente em desenvolvimento para o runtime Next. O nonce não é secret, mas nunca é fixo nem reutilizado. Testes conferem a correspondência entre header e scripts do mesmo HTML, a renovação entre requests e o bootstrap real nos dois apps; o fallback global catastrófico é um documento mínimo sem JavaScript e sem cache. O smoke standalone repete esses contratos sem expor o valor do nonce em diagnósticos. Novas origens entram somente no PR da integração consumidora e com teste correspondente.

A stack Supabase local usa uma bridge Docker exclusiva com publicação efetiva somente em `127.0.0.1`. Antes de qualquer operação, inclusive `stop`, o bootstrap e os wrappers locais recusam `DOCKER_HOST`/`DOCKER_CONTEXT` remotos, exigem o contexto ativo `default` e comprovam o endpoint local documentado (`unix:///var/run/docker.sock` ou o named pipe padrão do Windows). Depois dessa inspeção local de metadados, todos os subprocessos operacionais Docker e Supabase recebem explicitamente esse endpoint somente no próprio ambiente, sem executar `docker context use` nem alterar configuração global. O bootstrap para apenas containers rotulados para o projeto `set-livre` quando encontra estado anterior inseguro, valida a matriz 54321–54324 depois do start e falha fechado se a bridge preexistente tiver configuração divergente. Todo comando Supabase mantém `stderr` em pipe privado e o descarta; comandos interativos preservam somente `stdout` herdado quando necessário. Em qualquer falha, buffers e erro original são substituídos por diagnóstico contendo apenas código ou sinal seguro, impedindo que URL de banco, chaves do status ou output sensível sejam impressos.

O empacotamento local usa a entrada direta `node scripts/release-manifest.mjs` e não herda o ambiente amplo do shell nos subprocessos: build, tar e smoke recebem uma allowlist operacional, complementada apenas pelo arquivo runtime específico de cada app quando aplicável. O preflight deriva a instalação npm do Node selecionado e valida imediatamente Node, CLI, ancestrais, manifests e versões fixadas antes do primeiro build. A fronteira confia no processo chamador, checkout e toolchain sem alteração concorrente por nenhum principal com permissão de escrita; não declara identidade atômica portátil entre arquivo e execução. Credenciais E2E/admin não chegam aos filhos, valores sensíveis conhecidos são procurados na release inteira antes e depois do smoke, e logs de falha redigem tokens, cookies, autenticação e URLs de banco.

O fato de `.artifacts` ser ignorado pelo Git não o torna uma fronteira confiável. Antes de qualquer mudança de modo, lock, build ou cleanup, a release Linux valida o mountinfo do namespace atual e recusa `.artifacts` montada. Diretórios gerados são percorridos somente por `lstat`, com links tratados como folhas, e mounts na raiz ou em descendentes são recusados antes do rename e novamente antes da remoção recursiva. Arquivos, links e nós especiais seguem contratos distintos e nunca são usados para atravessar um alvo externo. A checagem falha fechada quando não consegue provar a topologia, sem tentar desmontar ou apagar o volume.

Os processos Chromium, Firefox e WebKit também partem de allowlist própria e mínima. Nenhuma variável de banco, SSH, npm, Node, loader dinâmico, Snap ou secret conhecido é encaminhada pelo Playwright; valores operacionais ligados a caminhos Snap são descartados e o `PATH` não aceita entradas vazias.

O arquivo opcional `.env.e2e.local` também é uma fronteira privada: antes do parse, sua raiz e todos os ancestrais precisam ser diretórios físicos estáveis, e o alvo precisa ser arquivo regular exclusivo (`nlink = 1`), aberto com `O_NOFOLLOW` e revalidado pelo descriptor e pelo caminho antes e depois da leitura. Em sistemas POSIX, o owner precisa coincidir com o usuário efetivo e o modo precisa ser exatamente `0600` em todas essas observações; no Windows, não se simulam owner ou permissão POSIX inexistentes. Symlinks, hardlinks e trocas concorrentes falham fechado, e os diagnósticos nunca incluem o conteúdo lido.

## 10. Supply chain

- npm lock;
- `npm ci`;
- audit;
- actions fixadas por SHA;
- dependências justificadas;
- renovate/dependabot controlado;
- build reproduzível;
- nenhuma action não confiável em deploy.

## 11. LGPD

### 11.1 Consentimento

Termos versionados. Aceite grava versão/hash/data. Checkbox não pré-selecionado.

O `legal-core` da FEAT-002 materializa essa regra: versões vigentes não se sobrepõem, o hash SHA-256 é gerado pelo banco, a aposentadoria não pode ser retroativa, e dois fatos de aceite imutáveis são criados na mesma transação do perfil mínimo. A intenção opaca expira em dez minutos, é idempotente por `requestId` somente enquanto pendente, não contém e-mail e é apagada da tabela privada e de `raw_user_meta_data` no consumo; intenções expiradas são purgadas pelo próximo create. IP permanece nulo enquanto não houver proxy confiável; somente hash de user-agent é aceito como evidência minimizada. O seed `local_fixture` nunca representa texto jurídico aprovado.

### 11.2 Acesso/exportação

Usuário solicita na conta. Job gera arquivo privado/expirável com:

- perfil;
- aceites;
- estúdios próprios;
- reservas;
- transações permitidas;
- histórico de solicitações.

### 11.3 Correção

Perfil pode ser atualizado. Fatos financeiros são ajustados por eventos, não reescritos para apagar histórico.

### 11.4 Exclusão

Processo:

1. confirmar identidade;
2. criar request;
3. bloquear novos fluxos;
4. avaliar reservas futuras/pagamentos;
5. cancelar ou exigir resolução;
6. remover mídia não necessária;
7. anonimizar perfil;
8. revogar Auth;
9. preservar fatos mínimos;
10. registrar conclusão;
11. expurgar backups no ciclo documentado.

### 11.5 Retenção inicial

A confirmar juridicamente. Defaults operacionais:

- logs técnicos: 30 dias;
- audit financeiro/admin: conforme obrigação legal;
- uploads órfãos: 24h;
- export de dados: 7 dias;
- fiscal: conforme obrigação;
- backups: 30 dias;
- webhook redigido: 90 dias ou necessidade de disputa.

## 12. Incidentes

Runbook:

- identificar;
- conter;
- preservar evidência;
- rotacionar;
- avaliar dados/impacto;
- comunicar responsáveis;
- corrigir;
- documentar;
- revisar controles.

## 13. Testes

- usuário A/B;
- role escalation;
- IDOR;
- origin inválida;
- body grande;
- webhook inválido/replay;
- upload spoof;
- log redaction;
- app público sem admin;
- export/deletion;
- CSP;
- secrets scan.
