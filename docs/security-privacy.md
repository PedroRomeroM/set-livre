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

- `Origin`;
- `Host`/forwarded host;
- método;
- content type;
- SameSite.

Webhooks não usam sessão; usam assinatura.

## 7. Rate limiting

VM única: memória por processo é primeira camada. Operações críticas também usam idempotência e constraints.

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

Na fundação local, a CSP permite somente a própria origem e dados/imagens necessários à tela técnica. `unsafe-eval` e conexões HTTP/WebSocket localhost existem apenas em desenvolvimento para o runtime Next; o smoke standalone recusa ambos no build de produção. Novas origens entram somente no PR da integração consumidora e com teste correspondente.

A stack Supabase local usa uma bridge Docker exclusiva com publicação efetiva somente em `127.0.0.1`. Antes de qualquer operação, inclusive `stop`, o bootstrap e os wrappers locais recusam `DOCKER_HOST`/`DOCKER_CONTEXT` remotos, exigem o contexto ativo `default` e comprovam o endpoint local documentado (`unix:///var/run/docker.sock` ou o named pipe padrão do Windows). Depois dessa inspeção local de metadados, todos os subprocessos operacionais Docker e Supabase recebem explicitamente esse endpoint somente no próprio ambiente, sem executar `docker context use` nem alterar configuração global. O bootstrap para apenas containers rotulados para o projeto `set-livre` quando encontra estado anterior inseguro, valida a matriz 54321–54324 depois do start e falha fechado se a bridge preexistente tiver configuração divergente. Todo comando Supabase mantém `stderr` em pipe privado e o descarta; comandos interativos preservam somente `stdout` herdado quando necessário. Em qualquer falha, buffers e erro original são substituídos por diagnóstico contendo apenas código ou sinal seguro, impedindo que URL de banco, chaves do status ou output sensível sejam impressos.

O empacotamento local usa a entrada direta `node scripts/release-manifest.mjs` e não herda o ambiente amplo do shell nos subprocessos: build, tar e smoke recebem uma allowlist operacional, complementada apenas pelo arquivo runtime específico de cada app quando aplicável. O preflight deriva a instalação npm do Node selecionado e valida imediatamente Node, CLI, ancestrais, manifests e versões fixadas antes do primeiro build. A fronteira confia no processo chamador, checkout e toolchain sem alteração concorrente por nenhum principal com permissão de escrita; não declara identidade atômica portátil entre arquivo e execução. Credenciais E2E/admin não chegam aos filhos, valores sensíveis conhecidos são procurados na release inteira antes e depois do smoke, e logs de falha redigem tokens, cookies, autenticação e URLs de banco.

Os processos Chromium, Firefox e WebKit também partem de allowlist própria e mínima. Nenhuma variável de banco, SSH, npm, Node, loader dinâmico, Snap ou secret conhecido é encaminhada pelo Playwright; valores operacionais ligados a caminhos Snap são descartados e o `PATH` não aceita entradas vazias.

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
