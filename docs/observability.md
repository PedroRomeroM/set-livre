# Observabilidade, health checks e operação

## 1. Objetivo

Detectar falha antes de gerar dupla reserva, cobrança sem reserva, e-mail perdido ou repasse atrasado.

### 1.1 Estado implementado até a FEAT-004

Os dois apps já expõem `/live` e `/ready` sem cache, com aplicação, release, timestamp e `requestId`; um UUID de entrada válido é propagado e qualquer valor inválido é substituído. Liveness não depende de configuração: `APP_RELEASE_SHA` ausente ou inválido mantém `200`, `status=live` e usa `release=unknown`. Readiness valida o mesmo valor antes de consultar dependências e, nesse caso, retorna `503`, `status=unready` e `release=unknown`, preservando `requestId` e `cache-control: no-store` sem expor configuração. Com release válido, consulta duas funções privadas com timeout e comprova atributos, memberships de entrada/saída, grants/ownership de `app_dal` e do login, a baseline pública exata, ACLs efetivas de `private` e a negação dos catálogos sensíveis. Qualquer ampliação retorna somente `unready`, sem erro de banco; um erro de cliente ocioso mantém o pool único.

A FEAT-002 introduz o primeiro evento operacional real: cada request de cadastro, login, logout, callback, pedido/status/atualização de recovery ou sessão emite somente `event=identity.request`, `requestId`, ação allowlisted, duração arredondada, status e resultado (`accepted`, `rejected` ou `unavailable`). Para não permitir enumeração, um erro do provider durante o pedido de recovery conserva a resposta pública `202` idêntica, mas registra internamente somente `outcome=unavailable`, sem código ou payload externo. E-mail, senha, token, cookie, URL, payload do provider e evidência bruta não são campos aceitos. Error tracking, alertas externos e dashboards continuam dependentes de PEND-008.

Uma falha browser que carregue campo sintético em endereço, stdout ou relatório deve ser tratada como incidente de evidência: preservar somente saídas redigidas e auditoria segura, remover artefatos brutos e nunca copiar o endereço ou os valores para documentação/log. O boundary SSR do cadastro evita a origem observada desse vazamento mantendo o formulário inerte e todos os controles disabled até a hidratação; não cria evento operacional adicional nem registra o snapshot de hidratação.

A FEAT-003 amplia a mesma allowlist para `profile.read`, `profile.complete` e `profile.update`. Os eventos continuam aceitando apenas ação, `requestId`, duração, status e resultado; nome, telefone, CPF/CNPJ, documento adicional, máscaras e preferência não são campos de log. Conflito otimista e validação aparecem somente como resultado controlado, sem valores recebidos ou retornados.

A FEAT-004 acrescenta `event=owner.request` para `owner.read`; tanto `GET /api/owner/activation` quanto `GET /api/owner/recipient` usam essa action allowlisted, sem registrar a projeção ou o documento. `owner.activate`, `recipient.onboarding.start` e `recipient.onboarding.refresh` usam `event=private.command` na rota compartilhada, com a action específica. Nenhuma ação de dono é rotulada como `identity.request`. Os eventos operacionais aceitam apenas ação, `requestId`, duração arredondada, status e resultado; não aceitam nome, telefone, documento, corpo/hash/título/fonte do contrato, provider/ref externa, requisito bruto, operação, idempotency key ou payload. Indisponibilidade/timeout do adapter, a recusa `PAYMENT_PROVIDER_UNAVAILABLE` do onboarding e a recusa `SERVICE_UNAVAILABLE` da ativação aparecem somente como `outcome=unavailable`, sem registrar `APP_ENV`, capability, fonte contratual, chamar o adapter ou tornar `/ready` indisponível. A recusa de ativação ocorre antes da escrita/auditoria, embora possa depender da leitura necessária para classificar a fonte. Em fatos novos, `audit.events.request_id` recebe o mesmo request ID usado na resposta/log, enquanto a coluna privada `idempotency_key` conserva a chave lógica somente para deduplicação; ela não entra no evento operacional, DTO ou metadata. Linhas anteriores ao head `20260815000100` preservam o valor legado de `request_id`, que era a chave idempotente, e não possuem correlação HTTP histórica recuperável. A mensagem SQL `owner_contract_not_current` participa apenas da classificação interna `409 CONFLICT`; mensagens e detalhes privados do banco não entram no erro público nem no evento operacional. Outros `42501` continuam `403 FORBIDDEN`.

No terceiro P2, o fechamento estático, 358/358 pgTAP, browser 114/114, build, smoke e a release local `2a86acc4...` passaram. O quarto P2 fechou em 734/734 unitários, banco 358/358, browser 23/23 e 114/114, build e release `969f30cd...`; essas fotografias são históricas para a capability de ativação.

No quinto P2, o snapshot pré-hidratação passou em 747/747 unitários e 358/358 no banco. A primeira focada coletou 23 testes em quatro specs/14 projetos (`615bf589...`) e terminou uma vez com exit `1`: 12 passados, uma falha em `SL-F004-E2E-001`/`critical-webkit`, dez não executados e zero rerun. O submit nativo pré-hidratação foi classificado como falha real de privacidade FEAT-002 e não evidência da capability; a integral não iniciou. Foram mantidos apenas stdout redigido `f4d0595a...` e auditoria `13859c3c...`; os brutos foram removidos e o cleanup ficou em zero.

O snapshot pós-hardening passou em 749/749 unitários por 75 arquivos e 358/358 no banco, com gerados byte-identical e head de 15 migrations. A cadeia Node 24/npm 11 também fechou format, lint, typecheck, docs:check, audit zero, Knip e diff-check. Uma asserção auxiliar incorreta do hash de `next-env` interrompeu apenas a orquestração depois do typecheck; nenhum gate do projeto falhou. A primeira invocação de banco interrompida após `0001` é inválida e teve cleanup limpo; uma única nova invocação autorizada, sem novo reset/geração, passou.

A focada race-fixed passou em 23/23 por quatro specs/14 projetos, e seu reuse foi validado pela auditoria final. A rodada attribute-fixed coletou 114 testes em 17 specs/16 projetos e sua única execução passou em 114/114 em 5,6 minutos, com zero retry, erro ou attachment. A FEAT-004 permaneceu em 23/23 na distribuição `3 + 3 + 3 + 4 + 3 + 4 + 3`; o no-JS da FEAT-002 passou nos três engines sem alterar ID ou total.

A auditoria contou 140 ocorrências dos 88 e-mails QA exclusivamente em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22 —, com zero secret, PII ou outro dado sensível e cleanup zero. Evidência segura: `.artifacts/p5-owner-activation-capability-attribute-fixed/full.audit.json`, SHA-256 `5704c67cf21bdcc6e92b733bfdb8788972c216d48f850c885200b6d4d78a37d6`. As execuções rejeitadas anteriores permanecem diagnóstico histórico do defeito já corrigido e dos harnesses/oráculos, não falha atual do produto. Static 749/749, DB 358/358, focada 23/23 e integral 114/114 estão verdes.

Uma única build P5 terminou com exit `0`, 26 + 4 rotas, zero warning e `BUILD_ID=local`; o log privado tem SHA-256 `3b03b8f64e70dcf29e713f8b6ab006f4a544e43fd761ce0eb8b283eac9de432c`. O resultado continua rejeitado porque a auditoria encontrou no standalone as strings locais administrativas/DAL copiadas de `scripts.knip`; o smoke permaneceu em zero. O script agora é exatamente `knip`, os valores seguem no `.env.e2e.local` físico e a nova unidade impede URL de banco nos scripts npm dos quatro manifests canônicos — raiz, backoffice, contracts e UI. Checks direcionados, 4/4 unitários, Knip com as sete variáveis E2E explicitamente unset e diff-check passaram sem drift do lockfile. A execução pós-manifesto que testou esse fix está registrada abaixo; nenhuma métrica de runtime, release ou operação remota foi produzida.

A build pós-manifesto seguinte terminou uma única vez com exit `0`; seu log privado tem SHA-256 `d8e50e0fb0b7080bf021aa910bef7ededc6677ba6dfaa71d4789a1d6226e1a8e`. O audit recusou uma ocorrência DAL em cada cache Turbopack; standalone, static e log ficaram limpos e o smoke continuou em zero. O wrapper único de build agora é compartilhado pelos dois apps e pelo gerador de release, valida app/toolchain física antes do spawn, sempre tenta remover só o cache autorizado mesmo após falha da validação/build e preserva falhas duplas em `AggregateError`. O preview limpa no supervisor pai antes de validar/startar; cleanup falho bloqueia o servidor, cache persistente reprova e a integração prova remoção do valor DAL sintético. O run direcionado final passou em 40/40 — 12 de cache/wrapper, quatro do npm confiável, 16 de Next/local server e oito do supervisor de preview —, com ESLint zero, checks Node, Knip env-unset e diff-check.

A cadeia estática final única passou em 764/764 por 76 arquivos e manteve o freeze 53/34/19. A build final via wrapper, depois de remover fisicamente os dois `.next`, rodou exatamente uma vez: exit `0`, 14,733 s, log de 2.155 bytes/SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. A auditoria independente em `.artifacts/p5-owner-activation-capability-build-smoke-cache-clean/build.audit.json`, SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d`, terminou `NO-BLOCKER`, com 26 + 4 rotas, zero warnings/cache/retired/resíduos e quatro `BUILD_ID=local`. Essa evidência produz métricas de build/audit, não de runtime: smoke executado continua zero. O primeiro smoke será somente o embutido no gerador após commit limpo; release/remoto seguem pendentes.

Os relatórios browser, build, smoke e a release vinculados a `440c81f6...` continuam válidos somente como fotografias históricas do patch anterior; esse archive não comprova a correlação de auditoria nem o novo head. O P3 possui execuções próprias e a release canônica `2a86acc4...`, cuja auditoria de secrets/PII e cleanup terminou sem bloqueios no recorte local x64.

## 2. Logs

Formato JSON:

```json
{
  "timestamp": "...",
  "level": "info",
  "environment": "production",
  "service": "web",
  "release": "<sha>",
  "requestId": "...",
  "route": "/api/commands",
  "action": "booking.payment.start",
  "durationMs": 123,
  "result": "success",
  "errorCode": null,
  "actorHash": "..."
}
```

Redaction:

- tokens;
- cookies;
- CPF/CNPJ;
- e-mail/telefone;
- provider payload;
- QR Pix completo;
- URL de banco;
- notas livres.

## 3. Health

### `/api/health/live`

- processo responde;
- não consulta dependência;
- sempre responde 200/JSON controlado; release ausente ou inválido aparece apenas como `unknown`.

### `/api/health/ready`

- conexão DB simples com timeout;
- migration head compatível;
- `current_user=app_dal` sem atributo privilegiado, membership de saída, ownership ou grant direto além de `USAGE private` e `EXECUTE` nas dezesseis rotinas autorizadas: dois checks de readiness, criação da intenção legal, seis operações do contexto recovery, três comandos do perfil e quatro entrypoints privados de dono/recebedor, sempre sem grant option; o manifesto totaliza dezessete dependências ACL exatas. As leituras de perfil e dono ficam fora dessa role e usam RPCs públicos `security invoker`, sem UUID de entrada, com `auth.uid()` + RLS; ativação retorna 21 colunas com contrato completo, e recebimentos retorna 16 sem título, versão textual, hash ou corpo;
- `PUBLIC` conserva somente `USAGE` em `pg_catalog`/`information_schema`, `CONNECT` no banco e `USAGE` nas quatro linguagens internas; `TEMPORARY` é recusado efetivamente à DAL/runtime, não há default ACL, objeto grande, parâmetro, FDW/server ou tablespace público, e `net` permanece inacessível às roles runtime;
- nenhuma relação, coluna, sequência, rotina ou tipo autônomo de `private` concede privilégio efetivo a `PUBLIC`; row types, arrays e multiranges implícitos seguem o objeto canônico. Em relações e colunas de `pg_catalog`, ACLs públicas podem apenas reproduzir privilégios iniciais `i`/`e` registrados em `pg_init_privs`. Rotinas são confrontadas por OID/overload, grantor e grant option com essa mesma origem; sem init row, a baseline usa `pg_extension.extowner` para membros de extensão ou o owner bootstrap OID `10` para os demais objetos initdb, nunca `proowner`, e exige ownership canônico mesmo sem `EXECUTE` público. Rotina normal posterior continua sem baseline. Expansões como `SELECT` em `pg_authid`, `EXECUTE` em `pg_read_file(text)` ou owner/grantor recalculado após drift tornam readiness indisponível. `pg_roles`, `pg_user` e `pg_db_role_setting` negam ainda leitura direta ou transitiva às roles web/DAL; os demais catálogos mantêm somente a acessibilidade built-in. Essa métrica não promete confidencialidade genérica nem substitui manifestos de grants a roles nomeadas;
- exatamente `session_user` restrito pode assumir `app_dal`; as referências administrativas `postgres` não possuem `SET/INHERIT`, nenhuma role intermediária assume o login, e esse login conserva somente `CONNECT`, membership DAL e a máscara vazia do GUC JWT local;
- configuração crítica presente, incluindo `app.settings.jwt_exp=3600`; emissão, inspeção e readiness falham fechado diante de drift;
- sem revelar detalhes;
- provider não deve tornar app inteiro unready por falha temporária, mas estado aparece em métrica.

### Worker health

Heartbeat no banco com serviço/release/last_success.

## 4. Métricas

### Web

- requests;
- p50/p95/p99;
- 4xx/5xx;
- command por action;
- rate limit;
- body rejected;
- auth failures;
- Core Web Vitals.

### Banco

- conexões;
- slow queries;
- lock waits;
- constraint conflicts;
- RLS advisor findings;
- crescimento;
- outbox depth.

### Domínio

- quotes;
- attempts;
- hold acquisition success/conflict;
- holds expirados;
- payment pending/paid/failed;
- webhook lag;
- payment sem reserva;
- reservation confirmations;
- refunds;
- payouts atrasados;
- review queue age.

### Infra

- CPU;
- memória;
- disco;
- event loop lag;
- Nginx 5xx;
- cert expiry;
- deploy.

## 5. Alertas

P0:

- pagamento pago sem reserva;
- duas reservas conflitantes detectadas;
- webhook signature failures anormais;
- DB indisponível;
- backup falhou;
- payout processado para refund;
- readiness falha.

P1:

- 5xx elevado;
- webhook lag > 5 min;
- outbox > 10 min;
- payout > 24h atrasado;
- disco > 85%;
- certificado < 14 dias;
- reconciliação falhando.

Alerta deve ter runbook e owner.

## 6. Error tracking

Default permitido: Sentry com:

- release;
- environment;
- source maps privados;
- PII scrub;
- session replay desabilitado por default;
- sampling;
- custo monitorado.

Não enviar formulário, CPF, QR, payload de payment ou notas.

## 7. Request IDs

- Nginx cria/propaga;
- app aceita apenas formato válido;
- response inclui;
- SQL, evento operacional e auditoria nova incluem o mesmo valor de correlação; fatos legados anteriores a `20260815000100` não permitem recuperar esse valor;
- a chave idempotente não entra em log/evento operacional; no fato de auditoria, fica somente em `audit.events.idempotency_key`, enquanto os stores canônicos de replay conservam suas próprias chaves privadas;
- provider metadata pode incluir request correlation não sensível.

## 8. Dashboards

- saúde técnica;
- booking/payment funnel técnico;
- filas;
- infraestrutura;
- custos.

Analytics de produto mais amplo é decisão separada; não coletar conteúdo privado por conveniência.

## 9. Runbooks

Links obrigatórios:

- deploy/rollback;
- DB outage;
- provider outage;
- paid-without-reservation;
- double-booking suspicion;
- refund/payout;
- backup/restore;
- security incident.
