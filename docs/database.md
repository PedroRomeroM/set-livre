# Banco de dados, migrations, grants e RLS

## 1. Princípios

- PostgreSQL é a defesa final de integridade.
- Migrations são append-only.
- `public` não significa acesso público; grants são explícitos.
- Tabela nova nasce revogada.
- RLS e grants são obrigatórios e testados.
- Comandos críticos ficam em `private`.
- Status evolutivos usam `text` + `check`.
- Dinheiro usa `bigint` em centavos.
- Índices não estruturais exigem evidência.
- Schema snapshot e tipos são gerados.

### 1.1 Estado versionado atual

A árvore versionada começa na baseline `20260824000100`, define a role de produção em
`20260828174500_default_production_dal_role` e mantém features e correções exclusivamente por
migrations append-only. A migration mais recente deste recorte é
`20260905134031_bind_pii_reveal_audited_attempt`, criada depois de
`20260905123458_serialize_media_cleanup_claim_replay`; uma feature nova nunca é inserida antes de uma
migration já versionada. Antes do primeiro deploy, enquanto o projeto Supabase de produção
ainda não possuía migrations, tabelas ou usuários da aplicação, o histórico local de construção foi
consolidado uma única vez pelo squash oficial schema-only do Supabase CLI. O preâmbulo versionado
preserva roles globais e ACLs de banco, que não fazem parte do dump de schema. O runner executa setup
idempotente e suítes pgTAP para baseline/isolamento, identidade/legal, perfil, dono/recebedor,
estúdios, mídia, publicação e backoffice; as quantidades são derivadas pelos gates, não documentadas.

A baseline implementada inclui:

- schemas `private` e `audit`, `app_dal NOLOGIN NOINHERIT`, grants mínimos e RLS;
- identidade mínima, termos/aceites, recovery one-shot e perfil privado;
- autoridade do dono, estado do recebedor, idempotência e correlação de auditoria;
- núcleo de estúdio/revisão, taxonomias ativas, conteúdo comercial, concorrência otimista, ownership e
  descarte seguro;
- mídia privada cuja finalização é serializada antes do processamento externo e cuja reserva persistida
  é terminalizada como `superseded` antes de um conflito de revisão autorizar nova preparação,
  liberando a quota sem depender da versão corrente;
- workflow editorial do dono com checklist autoritativo, revisão pendente imutável, pausa/retomada,
  idempotência, outbox mínima e versão de publicação independente;
- usuários administrativos, binding curto de sessão, papéis `support/reviewer/admin`, PII temporária,
  taxonomias versionadas, revisão/moderação editorial, idempotência e auditoria redigida;
- relógio lógico monotônico no binding administrativo e nos dez pares `created_at/updated_at` do
  domínio, preservado no banco mesmo quando o relógio de parede do host sofre uma correção regressiva;
- read models públicos `security invoker` sob `auth.uid()`;
- comandos privados `security definer` com `search_path = ''`;
- `app_runtime_production NOLOGIN` preparado para ativação administrativa e limite de dez conexões;
- readiness da fronteira gerenciada: `pg_net` inacessível, nenhum GUC sensível legível pelos
  catálogos internos do Cloud, nenhum `CREATE/TEMP` direto para DAL/runtime no database e nenhum
  `USAGE/CREATE` efetivo de `app_dal` fora de `private` e dos schemas internos do PostgreSQL.

O ciclo de inicialização, retomada, validação e compensação dessa role pertence ao contrato operacional
canônico em [infrastructure.md, Banco de produção](infrastructure.md#banco-de-producao). Este documento
mantém somente o estado estrutural e as invariantes de banco.

A baseline encerra com readiness objetivo: migration esperada presente no histórico aplicado, JWT
expiry, atributos mínimos de `app_dal`, allowlist exata de comandos, comandos allowlisted preservados
como `security definer` com a configuração exata `search_path = ''`, ACL do schema `private` restrita
ao owner canônico `postgres` e ao `USAGE` da DAL, ownership do schema e de toda rotina privada fixado
em `postgres`, ACL de rotinas privadas restrita a esse owner e aos `EXECUTE` allowlisted da DAL,
ausência de acesso direto ou via `PUBLIC` a dados, ausência de acesso efetivo a schemas externos mesmo
quando herdado por `PUBLIC`, ownership nulo, memberships reversas conhecidas, RLS em tabelas públicas e
negação de `CREATE/TEMP`.
O check do runtime prova login restrito, membership única com `SET app_dal` e allowlist
reversa exata: somente `postgres` pode administrar `app_runtime_production`, sem `SET` ou `INHERIT`;
qualquer identidade assumível é rejeitada. O runtime mantém exatamente um setting próprio em
produção: `role=app_dal`, limitado ao database `postgres`, não secreto e validado byte a byte. Essa é
a autoridade que aplica privilégio mínimo em toda conexão, inclusive quando o Supavisor não encaminha
parâmetros arbitrários do startup packet. A role conserva somente `CONNECT` como ACL direta e ausência
de ownership. No Supabase local, o bootstrap administrativo nega leitura efetiva de `pg_roles`,
`pg_user` e `pg_db_role_setting` às roles da aplicação, preservando em `pg_roles` somente o acesso
exigido pelo `supabase_storage_admin`; no Cloud, esses objetos continuam gerenciados por
`supabase_admin`, então a alternativa suportada também exige ausência global de settings com nome de
segredo enquanto houver leitura herdada. Drift retorna apenas `false`.

O health da aplicação aceita seu head enquanto ele constar no histórico aplicado. Essa semântica é
deliberada para que a release imediatamente anterior permaneça apta ao rollback durante uma migration
expand/contract. O deploy mantém a barreira mais forte: depois do `db push` e antes de habilitar ou
validar o login, o provisionador exige que o maior head remoto seja exatamente o head compilado pelo
candidato. Assim, compatibilidade operacional não permite publicar schema divergente.

`npm run supabase:lint` executa o linter oficial com warnings fatais sobre os schemas próprios
`public`, `private` e `audit`; extensões de terceiros, incluindo pgTAP, não são atribuídas à aplicação.
`npm run supabase:generate`
recria o snapshot SQL e os tipos em temporários irmãos, valida o formato e publica por rename
atômico. `npm run test:db` executa pgTAP e compara ambos com a geração atual. Falha preserva os
arquivos rastreados anteriores e não deixa saída parcial.

Essa consolidação pré-produção não se repete. A partir do primeiro deploy, toda migration aplicada é
imutável e a evolução é estritamente append-only/forward-only. Novos objetos entram apenas na fatia
vertical que os consome; nova função DAL atualiza grants, readiness, tipos, documentação e testes no
mesmo PR.

`npm run migrations:check` compara byte a byte as migrations presentes na base `main`, rejeita edição
ou exclusão, aceita somente novos timestamps posteriores e exige que `databaseMigrationHead` identifique
a migration mais recente antes de qualquer `db push`. A exceção autoextinguível desta entrega
aceita a baseline consolidada apenas enquanto `main` ainda não contém essa baseline e aponta para o
commit auditado que foi comprovado contra a produção vazia. Se a base avançar, o gate falha fechado e
exige nova verificação explícita antes de qualquer consolidação.

## 2. Extensões

Obrigatórias:

- `pgcrypto` para UUID/hash;
- `btree_gist` para exclusão por estúdio + range;
- extensões gerenciadas pelo Supabase necessárias ao Auth/Storage.

Não habilitar extensão por conveniência.

## 3. Schemas

```sql
create schema if not exists private;
create schema if not exists audit;
```

- `public`: tabelas/read models deliberados;
- `private`: comandos, helpers, jobs;
- `audit`: eventos sensíveis, sem exposição pela Data API.

## 4. Tabelas

### 4.1 `profiles`

| Coluna                       | Tipo        | Regra                                                                  |
| ---------------------------- | ----------- | ---------------------------------------------------------------------- |
| `id`                         | uuid        | PK/FK `auth.users`, cascade controlada                                 |
| `person_type`                | text        | `individual/company`; só muda junto da primeira conclusão              |
| `status`                     | text        | `active/suspended`; comandos de perfil não o aceitam                   |
| `name`                       | text        | 2–160, trim, sem caracteres de controle                                |
| `phone_e164`                 | text        | telefone brasileiro canônico `+55`; validação estrutural               |
| `tax_id`                     | text        | CPF de 11 dígitos ou CNPJ `[0-9A-Z]{12}[0-9]{2}` com DVs válidos       |
| `additional_document`        | text        | opcional, 3–40, uppercase ASCII com separadores internos controlados   |
| `tax_id_masked`              | text        | generated; revela somente os dois DVs                                  |
| `additional_document_masked` | text        | generated; revela somente os dois últimos caracteres                   |
| `profile_version`            | bigint      | versão otimista monotônica, inicia em zero                             |
| `account_version`            | bigint      | versão independente do status da conta, inicia em zero                 |
| `completed_at`               | timestamptz | nulo enquanto os dados pessoais crus são nulos; imutável após concluir |
| `created_at`                 | timestamptz | UTC                                                                    |
| `updated_at`                 | timestamptz | UTC, mantido por trigger                                               |

O e-mail canônico permanece no Auth. Antes da conclusão, todos os campos pessoais crus permanecem nulos; depois dela, nome, telefone e CPF/CNPJ são obrigatórios. Não há unicidade em `tax_id`: formato/DV não comprova existência, situação cadastral ou titularidade. PF/PJ e `completed_at` ficam imutáveis após concluir.

`public.get_my_profile()` é `security invoker`, usa `search_path = ''`, não recebe UUID e filtra obrigatoriamente por `auth.uid()`. Somente `authenticated` o executa, com `SELECT` apenas nas colunas seguras necessárias sob RLS; CPF/CNPJ e documento adicional crus continuam sem grant. Os três comandos `complete_profile(...)`, `update_profile_identity(...)` e `update_profile_appearance(...)` são `security definer` e recebem o usuário validado pelo servidor. Um helper `private.profile_command_result(uuid)` produz o mesmo retorno mascarado para os comandos, mas não possui grant runtime e não é read model. `complete` verifica os aceites preexistentes. Retries com o mesmo alvo são no-op; divergência versionada usa SQLSTATE `40001`. Perfis não ativos são bloqueados e `app_dal` recebe `EXECUTE` somente nos três comandos.

#### `user_preferences`

| Coluna                  | Tipo        | Regra                                   |
| ----------------------- | ----------- | --------------------------------------- |
| `user_id`               | uuid        | PK/FK `profiles`, uma linha por perfil  |
| `color_scheme`          | text        | `system/light/dark`, default `system`   |
| `preferences_version`   | bigint      | versão otimista própria, inicia em zero |
| `created_at/updated_at` | timestamptz | UTC; trigger controla atualização       |

A migration faz backfill dos perfis existentes e o trigger de perfil cria a preferência futura na mesma transação. RLS limita leitura ao próprio `auth.uid()`; `authenticated` recebe `SELECT` somente em `user_id`, `color_scheme` e `preferences_version` para o read model invoker. Não há escrita direta. Aparência e identidade mantêm versões independentes.

### 4.2 `owner_profiles`

| Coluna                               | Regra                                      |
| ------------------------------------ | ------------------------------------------ |
| `user_id`                            | PK/FK `profiles`; autoridade única de dono |
| `accepted_owner_contract_version_id` | versão aceita do `owner_contract`          |
| `status`                             | `active/blocked`                           |
| `owner_version`                      | versão monotônica própria                  |
| `activated_at`                       | instante UTC da ativação                   |
| `created_at/updated_at`              | timestamps UTC                             |

Nome, telefone e documentos continuam canônicos em `profiles`; esta tabela não duplica PII nem cria edição comercial paralela.

### 4.3 `platform_roles`

- `user_id`;
- `role`: `support/reviewer/admin` no recorte implementado;
- `granted_by`;
- `created_at`;
- PK `(user_id, role)`.

Sem escrita pelo browser. `reviewer` é consumido exclusivamente pela revisão editorial; `finance`
continua ausente até sua feature proprietária. O primeiro
admin usa o bootstrap privado one-shot; depois disso, somente admin com autenticação recente altera
papéis, e a salvaguarda transacional mantém ao menos um admin ativo. Um trigger em toda concessão ou
revogação incrementa `profiles.account_version`; essa versão opaca invalida sessão/clientes sem publicar
o conjunto de papéis no browser. Uma concessão nova exige `profiles.status = 'active'` e
`completed_at` preenchido na própria função transacional; revogações permanecem disponíveis para
reduzir privilégios mesmo quando a conta perdeu elegibilidade.

#### `private.backoffice_sessions`

Binding por `auth_session_id`, usuário, abertura, último uso, expiração absoluta e fechamento. A
sessão expira após 30 minutos de inatividade ou oito horas, respeita a sessão Auth canônica e exige
login feito nos últimos cinco minutos para gestão de papéis. Remoção de todos os papéis ou suspensão
fecha bindings existentes. `private.backoffice_session_context(..., p_required_role,
p_require_strong_authentication, p_touch_activity)` exige `support`, `reviewer` ou `admin` na própria
fachada; `admin` substitui os dois papéis operacionais somente por regra explícita. O valor especial
`backoffice` valida apenas a existência de algum papel para abrir/reler a sessão. O último argumento separa
revalidação passiva de atividade real: `get_backoffice_session` passa `false`, enquanto leituras
operacionais e comandos passam `true`. A revalidação passiva mantém `FOR SHARE` na binding: leituras
simultâneas da mesma sessão não se serializam, mas fechamento concorrente ainda espera o snapshot
terminar. Caminhos que renovam `last_seen_at` preservam `FOR UPDATE`.

#### `private.backoffice_command_requests`

Ledger idempotente por ator + chave. Guarda action, hash de payload, alvo e hash do resultado
autoritativo. Para revelação de PII, não guarda valor nem hash reutilizável: conserva somente versões
canônicas de perfil/Auth para recusar replay stale. RLS fica habilitada sem policy e sem grant web.
`private.reveal_backoffice_user_pii` compõe o eco de tentativa pela action desse ledger e pela
chave/motivo do evento `audit.events` bem-sucedido do mesmo ator/alvo, tanto na primeira execução
quanto no replay. A unicidade existente de ação/alvo/chave limita essa leitura; não há novo índice,
coluna nem cópia de PII. Evento ausente ou motivo divergente falha fechado. O `request_id` de um
replay pode mudar sem alterar a identidade auditada. O contrato HTTP fica em
[`api-contracts.md`](api-contracts.md#57-adminbackoffice).
Essa alteração de JSON é incompatível com o consumidor estrito anterior: rollback exige código
compatível com o eco auditado ou nova migration corretiva forward-only, nunca remoção manual dos
campos nem edição da migration aplicada.

### 4.4 `terms_versions`

- `id`, `kind` (`terms/privacy/owner_contract`), `version` e `title`;
- `body_markdown` com 1–200.000 caracteres e `content_hash` SHA-256 gerado pelo banco;
- `source`: `local_fixture/approved`, exposto no read model para não inferir aprovação pelo ambiente;
- `effective_at`, `retired_at` e `created_at` em UTC;
- unique `(kind, version)` e exclusão GiST que impede vigências sobrepostas por `kind`;
- conteúdo, identidade e início de vigência são imutáveis; somente `retired_at: null → valor presente/futuro` é aceito uma vez, sem aposentadoria retroativa.

### 4.5 `terms_acceptances`

- `user_id`, `terms_version_id` e PK composta;
- `accepted_content_hash` como snapshot validado contra a versão;
- `accepted_at`, `request_id`, `ip_hash` nulo quando a origem não for confiável e `user_agent_hash` opcional;
- fato imutável: update e delete direto falham; a única remoção é a cascata controlada iniciada em `auth.users`.

`private.signup_legal_intents` guarda temporariamente token UUID aleatório, duas versões esperadas, tipo de pessoa, evidência já hasheada e expiração máxima de 15 minutos. `private.create_signup_legal_intent(...)` purga intenções expiradas e é idempotente por `request_id` enquanto a intenção permanece pendente. O trigger `set_livre_bootstrap_signup_identity` revalida a vigência, cria perfil e dois aceites, apaga a intenção exata sob lock e remove `sl_legal_intent` de `auth.users.raw_user_meta_data` dentro da mesma transação. Assim, a evidência permanece somente nos aceites canônicos; replay não duplica efeito público e qualquer falha restaura todas as etapas. Cadastro direto sem intenção aborta integralmente. Como estado canônico privado, a tabela tem RLS habilitada sem policy e nenhum grant runtime; somente as rotinas privadas autorizadas alcançam suas linhas.

`private.identity_recovery_sessions` classifica cada sessão de recovery pelo `session_id` do JWT assinado e pelo usuário da linha canônica de `auth.sessions`. Ela guarda somente o scope UUID público, expirações e o estado de fechamento/ausência; não guarda token Auth, senha ou PII. A binding persiste como tombstone depois do grant e dos cookies. Cada JWT observado pode ampliar `auth_expires_at`; quando `auth.sessions` fica ausente, a primeira observação fecha a binding, remove o grant e estende a retenção por uma janela pinada de 60 minutos mais cinco minutos. Purge exige uma invocação posterior, `retain_until` vencido e ausência canônica ainda comprovada. Emissão, inspeção e readiness recusam qualquer `app.settings.jwt_exp` diferente de `3600`.

`private.identity_recovery_grants` substitui estado process-local por um token UUID opaco persistido somente no banco, vinculado à mesma binding/usuário e limitado a 15 minutos. `issue context` cria binding+grant atomicamente; `inspect session` classifica a sessão e autoriza apenas token/scope correspondentes; `claim` reserva a linha atomicamente e permite retry idempotente somente da mesma tentativa; `release` desfaz a reserva apenas enquanto o grant e a sessão canônica continuam vigentes; `consume` apaga o grant depois do sucesso; `close` fecha a binding sem remover o tombstone. Se a expiração for atingida antes do release, a função retorna `false`, preserva a claim e o serviço encerra a tentativa, limpa cookie/sessão Auth exatos e exige novo link. Falha de transporte ou resultado desconhecido segue o mesmo caminho terminal. As duas tabelas têm RLS sem policy, zero grants runtime e cascata apenas pela exclusão canônica do usuário.

### 4.6 Taxonomias

O recorte implementado possui `studio_types`, `tags` e `amenities`, todos com:

- UUID;
- nome;
- slug;
- `active`;
- `sort_order`;
- timestamps;
- slug único.

Quatro tipos, oito tags e oito comodidades mínimas são seedados deterministicamente. Browser
autenticado recebe somente opções ativas para novas escolhas por `list_active_studio_types()` e
`list_active_studio_taxonomies()`. As policies também conservam legíveis tipo, tags e comodidades
arquivados quando são referenciados por revisão pertencente ao `auth.uid()`, permitindo abrir o
histórico sem expor esses itens a outro dono nem aceitá-los em nova mutação. Escrita direta permanece
revogada. A administração da FEAT-031 usa funções privadas somente para `admin`, versão otimista e
retorno com contagem de uso. Criar/editar incrementa `taxonomy_version`; arquivar remove novas escolhas
sem apagar relações históricas, e reativar preserva o histórico.

### 4.7 `studios`

| Coluna                  | Tipo/Regra                 |
| ----------------------- | -------------------------- |
| `id`                    | uuid PK                    |
| `owner_user_id`         | FK owner profile, not null |
| `status`                | check de ciclo             |
| `published_revision_id` | FK revision null           |
| `draft_revision_id`     | FK revision null           |
| `publication_version`   | bigint positivo, default 1 |
| `created_at/updated_at` | timestamptz                |

As FKs de ponteiro são criadas depois das duas tabelas. Um constraint trigger com autoridade interna
prova ao fim de cada instrução atômica que existe ao menos um ponteiro e que ambos pertencem ao mesmo
estúdio. O índice parcial garante no máximo uma revisão `draft` por estúdio. A fronteira editorial
incrementa `publication_version` exatamente uma vez quando status ou ponteiros mudam, deriva
`changes_pending` ao abrir candidata sobre uma revisão publicada e rejeita saltos de estado ou versão.

### 4.8 `studio_revisions`

Campos públicos versionados:

- `id`, `studio_id`, `revision_number`, `revision_version`;
- `status`;
- `name` 2–120;
- `description` 20–5000;
- endereço estruturado;
- `city` fixada/validada para Curitiba na baseline;
- `state` = PR;
- `postal_code`;
- `capacity` 1–500;
- `studio_type_id`;
- `usage_rules` plain text, aparado e limitado a 5.000 caracteres;
- `youtube_video_id` nulo ou ID allowlisted de 11 caracteres;
- timestamps;
- unique `(studio_id, revision_number)`.

Somente `draft` pode ser atualizada ou removida, e cada atualização incrementa exatamente
`revision_version`. Revisão `pending`, `approved`, `rejected` ou `superseded` é imutável por trigger.

### 4.9 Relações da revisão

- `studio_revision_amenities(revision_id, amenity_id)`;
- `studio_revision_tags(revision_id, tag_id)`;
- `studio_faqs(id, revision_id, question, answer, position)`;
- unique de posição por revisão;
- limites de 20 FAQs, 20 tags e 20 comodidades validados no comando;
- trigger impede escrita nas relações de revisão não draft;
- ao abrir draft a partir de uma revisão aprovada, colunas, tags, comodidades e FAQs são clonadas na
  mesma transação antes da alteração solicitada.

RLS permite leitura dessas relações somente ao dono da revisão; grants autenticados são apenas por
coluna e toda escrita direta permanece revogada. Os comandos privados revalidam taxonomia ativa,
ownership, fence otimista e idempotência; auditoria registra somente contagens, versão e presença de
vídeo, nunca regras ou FAQ.

### 4.10 `studio_media`

- identidade: `id`, `studio_id`, `prepared_revision_id`, `uploaded_by`;
- objeto: bucket privado fixo, `storage_path` original e `preview_storage_path` WebP;
- declaração: MIME, bytes e SHA-256 opcional recebidos antes do upload;
- verificação: MIME, bytes, dimensões e SHA-256 autoritativos;
- ciclo: `pending_upload/ready/rejected/delete_pending/deleted`, primeira emissão confirmada do token,
  código de rejeição e timestamps;
- cleanup: instante elegível, tentativas, claim/lease cercado por token, backoff e resultado terminal.

`studio_revision_media(revision_id, media_id, position, is_cover)` mantém a associação versionada. A
mesma mídia pode permanecer na revisão publicada e no novo draft; posição é contínua de 1 a 20 e o
índice único parcial admite no máximo uma capa por revisão.

Constraints:

- original e prévia possuem paths únicos e derivados do namespace owner/studio/revision/media;
- declaração e fatos verificados permanecem imutáveis depois de preenchidos;
- transições de estado seguem somente o ciclo permitido;
- relação só pode ser alterada em revisão draft e referencia mídia `ready` do mesmo estúdio;
- mídia `ready` referenciada por revisão `pending` ou `approved` não pode entrar em `delete_pending`;
  a exclusão do agregado usa um fence privado da transação/backend, agenda os objetos e elimina o
  fence por cascade junto do estúdio;
- no máximo 20 associações ou candidatos pendentes por revisão, sob lock; `rejected` deixa a quota
  imediatamente, mesmo quando a revisão avançou durante a verificação, porque a transição terminal é
  cercada por `media_id/studio_id/prepared_revision_id/uploaded_by`, mas preserva o objeto até a janela
  segura de cleanup;
- candidato `pending_upload` expirado não consome cota e não pode ser finalizado; renovação cria nova
  identidade, enquanto o objeto anterior segue para cleanup;
- remover a última associação agenda o par de objetos para cleanup em vez de apagar linha do Storage.

`confirm_studio_media_upload_token` e `reject_unsigned_studio_media_upload` compartilham o advisory lock
da mídia e liquidam a fronteira após a chamada externa: confirmação grava a primeira emissão;
compensação grava `upload_token_signing_failed`, libera cota e agenda cleanup imediato somente quando
nenhuma emissão foi confirmada. O helper genérico de rejeição continua revogado do `app_dal`, e nenhuma
transação ou conexão permanece presa durante o Storage.

As tabelas não concedem ao browser paths nem escrita direta. O dono elegível lê o JSON estrito apenas
pela rotina privada do DAL. A única leitura adicional em `storage.objects` é a policy da FEAT-030:
`authenticated` pode ler um objeto `ready` somente quando `auth.uid()` + `session_id` correspondem a
uma binding ativa com `reviewer/admin` e a relação pertence à submissão `pending` ainda apontada ou à
revisão `published` escolhida para moderação/restauração pelo admin. Um draft não submetido nunca
qualifica. `storage.allow_only_operation('storage.object.sign_many')` limita essa policy à assinatura
em lote usada pelo servidor; listagem e download autenticado direto continuam sem linhas. Isso permite
criar URL assinada curta sem liberar listagem ou assinatura arbitrária. O `app_dal` recebe `execute`
somente no read model, prepare, begin/renew/release do
claim, fachadas terminalizadoras cercadas e ordem/capa/exclusão. Candidato, replay e mutações internas
não são invocáveis diretamente. A manutenção expõe ao `service_role` apenas as fachadas RPC estreitas do
cleanup; `maintenance` permanece inacessível diretamente e nenhuma role da aplicação alcança `net`.
Cron, `pg_net` e Vault não fazem parte desse fluxo.

`private.studio_media_finalize_claims(owner_user_id, idempotency_key)` é uma única tabela privada que
registra hash e identidade imutável do comando, revisão esperada, `media_id` único, request mais recente,
lease de 30 segundos e resultado terminal. Ela não referencia `studios` nem `studio_media`: o tombstone
sobrevive ao cleanup da identidade mutável e recusa para sempre outra chave sobre a mesma mídia; somente
a remoção canônica do usuário encerra esse escopo. RLS fica habilitada sem policy e nenhuma role de API
recebe grant de tabela.

`begin_studio_media_finalize_claim` persiste a chave antes de Storage/Sharp e só devolve o candidato
validado junto do token cercado. A mesma chave ativa aguarda, com a conexão já devolvida ao pool; lease
expirada permite takeover com token novo. Outra chave aguarda somente enquanto a primeira está ativa e,
depois, recebe conflito determinístico. Replay terminal devolve o ledger ou a rejeição persistida sem
reabrir trabalho externo. O orçamento de 30 segundos cobre até quatro segundos de fila, quinze de
processamento e margem transacional; o serviço exige ao menos 22 segundos antes de entrar na fila.

Antes do upload da prévia, `renew_studio_media_finalize_claim` estende atomicamente por 30 segundos uma
lease ainda vigente; token expirado ou substituído não pode ressuscitar. Como o download, Sharp e upload
compartilham deadline absoluto de 15 segundos, essa janela impede takeover entre a renovação e o commit
terminal. Begin e fachadas claimed obedecem à ordem global advisory da idempotência → dono → claim →
revisão/mídia. As fachadas recebem apenas token, request e fatos verificados: owner, estúdio, revisão,
chave e mídia são derivados da linha sob lock. Finalização grava mídia, associação, ledger e terminal na
mesma transação; rejeição faz o mesmo com o tombstone correspondente. O DAL libera somente o token atual
em `finally`; token anterior não afeta takeover. A assinatura das URLs acontece depois dessa liberação,
sem manter conexão PostgreSQL durante fila, download, Sharp, Storage ou signing.

`maintenance.studio_media_cleanup_runs` registra `run_id`, slug imutável, estado e contagens terminais,
sem paths ou secrets. `maintenance.studio_media_cleanup_run_items` registra o pertencimento histórico
imutável de cada mídia ou probe ao run que a reclamou, sem grant para roles da aplicação. O resultado
só transita de pendente para `deleted` ou `failed`; reutilizar a lease em outro run nunca reatribui o
item histórico. A criação entra diretamente em `running`; a conclusão é somente
`succeeded`/`failed`, com replay idêntico e fechamento obrigatório `claimed = deleted + failed`.
O claim serializa chamadas com o mesmo token por advisory lock transacional antes de ler reservas.
Assim, um retry cuja primeira transação ainda está confirmando relê o lote e suas tentativas, sem
reservar outro lote; tokens distintos continuam concorrentes com `SKIP LOCKED`.
Readiness exige um sucesso terminal nos últimos 30 minutos e reprova execução travada nesse intervalo
ou falha sem sucesso posterior. Ao abrir um novo
run, o banco terminaliza como `cleanup_run_abandoned` qualquer execução diferente que permaneceu
`running` além desse limite. As contagens são derivadas exclusivamente do pertencimento histórico do
run; itens ainda pendentes viram `failed` antes da agregação, preservando
`claimed = deleted + failed`. Claims e completion tokens mutáveis continuam representando somente o
estado operacional atual da mídia ou probe; leases vencidos continuam
elegíveis ao claim seguinte e um sucesso posterior restaura readiness sem edição manual. O canário de deploy usa objetos reais e somente uma
execução terminal saudável libera a ativação da release; a VM deriva o slug periódico do próprio SHA
ativo.

#### 4.10.1 Workflow editorial da FEAT-009

`public.studio_review_events` registra fatos `submitted | approved | rejected` por estúdio e revisão.
O motivo existe somente na rejeição, uma revisão recebe no máximo um fato de cada tipo e uma única
decisão terminal. `submitted` exige a candidata `pending`, ainda apontada e em estado editorial de
revisão, com o próprio dono como ator. Uma decisão exige ator não nulo, submissão anterior da mesma
revisão e `approved | rejected` já refletido na revisão. O dono só pode originar `submitted`; update arbitrário é rejeitado e a única
mutação interna aceita é anonimizar o ator quando a identidade for removida. A remoção física fica
restrita ao owner canônico para limpeza transacional de fixtures/contas, sem grant runtime. Cada fato
recebe `event_sequence bigint identity` única; o read model ordena por essa sequência causal, nunca por
`occurred_at` ou UUID, e nenhuma role runtime recebe acesso à sequence.

`private.studio_command_requests` continua sendo o único ledger idempotente de estúdio e inclui
`studio.revision.submit | studio.pause | studio.resume` na allowlist canônica. A PK
`(owner_user_id, idempotency_key)`, os hashes do payload/resultado e a referência da revisão fazem o
replay convergir enquanto o resultado autoritativo permanecer idêntico; resultado posterior divergente
falha como stale e chave reutilizada com payload diferente falha como conflito. Não existe ledger nem
coluna paralela para duplicar `publication_version`: a versão factual da transição fica na auditoria. A
tabela usa RLS sem policy e nenhuma role runtime recebe acesso direto.

O submit trava owner/chave, revalida e mantém locks compartilhados determinísticos no tipo, tags e
comodidades ativos e só então trava estúdio/revisão. Um fence compara as relações antes e depois desses
locks; arquivamento concorrente espera a submissão concluir, enquanto item já inativo produz
`studio_submission_incomplete` sem efeito parcial. Depois disso, o comando exige revisão draft atual e
checklist completo, muda a revisão para `pending`, registra evento, outbox, ledger e auditoria na mesma
transação e preserva a revisão publicada durante uma reapreciação. O checklist também denuncia
taxonomia arquivada e exige ao menos uma mídia `ready`, exatamente uma capa e nenhum upload pendente não
expirado. Pausa e retomada usam `publication_version`; preservam os ponteiros e derivam `published` ou
`changes_pending` conforme o candidato privado ainda exista.

Os FKs de `studio_review_events` e `email_outbox` para estúdio e revisão usam cascade exclusivamente
para acompanhar a exclusão do agregado nunca publicado. Assim, descartar a correção criada após uma
primeira rejeição remove eventos e intenção pendente na mesma transação. O comando nunca exclui um
estúdio com `published_revision_id`; nesse caso, preserva o histórico e volta ao ponteiro aprovado.

#### 4.10.2 Decisão e moderação da FEAT-030

`studios.disabled_from_status` guarda exclusivamente `published | changes_pending | paused` enquanto o
estúdio está `disabled`; fora desse estado permanece nulo. A constraint de ponteiros exige publicação
vigente e conserva a candidata quando a origem era `changes_pending`. Assim, restaurar usa o fato
persistido, nunca inferência por ponteiro, auditoria ou evento.

`private.list_backoffice_studio_reviews(...)` deriva a fila diretamente de estúdio, ponteiros, revisão e
sequência causal do evento; pagina por `(event_sequence, studio_id)` e não cria tabela de casos.
`private.get_backoffice_studio_review(..., p_touch_activity)` escolhe a candidata somente quando ela
permanece `pending`; em moderação/restauração escolhe exclusivamente `published_revision_id`, sem
projetar draft privado. O argumento booleano é obrigatório na DAL e permite que polling passivo execute
a mesma revalidação de binding/papel sem atualizar `last_seen_at`; a chamada operacional usa `true`.
Depois compõe publicação, checklist, capacidades e paths de mídia somente para assinatura server-side.
`private.execute_backoffice_studio_command(...)` decide
ou modera sob lock de estúdio/revisões, fence de versão e ledger idempotente. Aprovação/rejeição usam o
ID exato da candidata; desativação/restauração exigem admin. Evento editorial, outbox e auditoria entram
na mesma transação. Aprovação também bloqueia as taxonomias referenciadas e recalcula o checklist antes
da primeira transição; arquivamento posterior à submissão falha sem publicação, ledger ou fence residual.
A rejeição clona dados centrais, taxonomias, FAQ e relações de mídia para novo draft sem copiar o objeto
físico.

Transições temporárias de status de revisão usam `private.studio_review_transition_fences`, vinculadas à
transação e ao backend, para satisfazer as invariantes dos triggers. O comando remove o fence antes do
retorno e os testes exigem zero resíduo. Toda alteração de status ou ponteiro continua incrementando
`publication_version` pelo trigger canônico.

### 4.11 `owner_payment_recipients`

- `owner_user_id`;
- `status`: `not_started/pending/active/refused/suspended/blocked`;
- `requirements`: array limitado a `identity_review/additional_information/provider_contact`;
- `profile_version_synced`;
- `recipient_version`;
- timestamps.

RLS limita a linha ao próprio `auth.uid()` e grants por coluna permitem somente a projeção segura. `private.owner_activation_requests` registra o replay de ativação por `(owner_user_id, idempotency_key)`. `private.owner_recipient_operations` reserva `start | refresh` por chave e sequência antes do adapter e aplica somente o resultado correspondente; provider e referência opaca permanecem nessa tabela privada, sem grant web. A elegibilidade nunca é persistida: deriva de dono `active`, versão vigente do `owner_contract` aceita, recipient `active` e `profile_version_synced = profiles.profile_version`.

### 4.12 `studio_calendar_settings`

- `studio_id` PK;
- `slot_minutes` check = 60;
- `min_duration_hours` 1–24;
- `max_duration_hours` 1–24 e >= min;
- `buffer_before_hours` 0–4;
- `buffer_after_hours` 0–4;
- `booking_horizon_days` default 365;
- timestamps.

### 4.13 `studio_weekly_windows`

- `id`;
- `studio_id`;
- `weekday` 0–6;
- `start_local` time;
- `end_local` time;
- `active`;
- check fim > início;
- horários em hora cheia;
- comando impede sobreposição.

### 4.14 `studio_date_exceptions`

- `id`;
- `studio_id`;
- `local_date`;
- `kind`: `closed/custom_windows`;
- `windows` JSONB validado ou tabela filha;
- `reason` até 300;
- unique `(studio_id, local_date)`.

Como janelas são consultadas e validadas, preferir tabela filha:

`studio_exception_windows(exception_id, start_local, end_local)`.

### 4.15 `calendar_allocations`

| Coluna               | Regra                               |
| -------------------- | ----------------------------------- |
| `id`                 | uuid                                |
| `studio_id`          | FK                                  |
| `kind`               | `hold/reservation/manual/ical`      |
| `actual_period`      | tstzrange `[)`                      |
| `blocked_period`     | tstzrange `[)` incluindo buffer     |
| `status`             | `active/released/cancelled/expired` |
| `expires_at`         | apenas hold                         |
| `created_by_user_id` | null para system                    |
| `label`              | texto seguro                        |
| timestamps           |                                     |

Constraint estrutural:

```sql
exclude using gist (
  studio_id with =,
  blocked_period with &&
)
where (status = 'active');
```

O comando libera hold expirado antes de inserir.

### 4.16 iCal

`ical_import_batches`:

- id, studio_id, imported_by, file_hash, original_name sanitizado;
- imported_at;
- status;
- total_events;
- range.

`ical_import_events`:

- batch_id;
- external_uid_hash;
- start/end;
- summary sanitizado;
- allocation_id;
- unique por batch/uid/start.

### 4.17 Pricing

`studio_pricing`:

- studio_id PK;
- base_hourly_cents > 0;
- currency = BRL;
- updated_at.

`studio_day_multipliers`:

- studio_id;
- weekday;
- multiplier numeric(8,4), 0.1–5.0;
- PK.

`studio_time_bands`:

- id, studio_id, name;
- start_local/end_local em hora cheia;
- multiplier 0.1–5.0;
- posição;
- comando impede overlap.

### 4.18 `studio_addons`

- id, studio_id;
- name 2–120;
- description até 500;
- unit_price_cents >= 0;
- max_quantity 1–99;
- active;
- timestamps.

Adicional usado em reserva não é hard deleted; fica inativo.

### 4.19 `reservation_quotes`

- id;
- studio_id;
- renter_user_id null para anônimo;
- local_date;
- start_at/end_at UTC;
- guest_count;
- notes sanitizadas até 1000;
- hourly_subtotal_cents;
- addons_subtotal_cents;
- total_cents;
- currency;
- pricing_version/hash;
- expires_at (5 min);
- created_at.

### 4.20 `reservation_quote_items`

- quote_id;
- kind: `hour/addon`;
- reference_id null;
- label_snapshot;
- quantity;
- unit_amount_cents;
- day_multiplier;
- time_multiplier;
- total_cents;
- sort_order.

### 4.21 `booking_attempts`

- id;
- quote_id;
- renter_user_id;
- studio_id;
- status;
- idempotency_key;
- provider;
- provider_checkout_id privado;
- failure_code seguro;
- timestamps;
- unique `(renter_user_id, idempotency_key)`.

### 4.22 `booking_holds`

- id;
- attempt_id unique;
- allocation_id unique;
- expires_at;
- status;
- timestamps.

### 4.23 `payments`

- id;
- attempt_id unique;
- provider;
- provider_payment_id privado;
- method `card/pix`;
- status;
- amount_cents;
- currency;
- pix_qr_code payload protegido/expirável;
- pix_qr_code_url;
- provider_expires_at;
- paid_at/refunded_at;
- timestamps.

Nunca guardar PAN/CVV/token reutilizável do cartão.

### 4.24 `webhook_events`

- provider;
- external_event_id;
- event_type;
- payload_hash;
- payload_redacted JSONB opcional;
- received_at;
- processed_at;
- status;
- error_code;
- unique `(provider, external_event_id)`.

### 4.25 `payment_events`

- payment_id;
- provider_status;
- domain_status;
- occurred_at;
- webhook_event_id;
- metadata redigida.

### 4.26 `reservations`

- id;
- studio_id;
- renter_user_id;
- owner_user_id_snapshot;
- studio_revision_id_snapshot;
- quote_id unique;
- payment_id unique;
- allocation_id unique;
- status;
- start_at/end_at;
- guest_count;
- notes;
- total_cents;
- owner_share_cents;
- platform_share_cents;
- gateway_fee_cents null;
- cancellation_terms_version_id;
- confirmed_at/cancelled_at/completed_at;
- timestamps.

### 4.27 `reservation_addons`

Snapshot:

- reservation_id;
- addon_id null;
- name_snapshot;
- unit_price_cents;
- quantity;
- total_cents.

### 4.28 `reservation_status_events`

- reservation_id;
- from_status;
- to_status;
- reason_code;
- actor_user_id null;
- occurred_at;
- request_id;
- metadata limitada.

### 4.29 `refunds`

- id;
- reservation_id;
- payment_id;
- status;
- amount_cents = total;
- provider_refund_id;
- reason;
- requested_by;
- timestamps.

### 4.30 `payouts`

- id;
- reservation_id unique;
- owner_user_id;
- provider;
- provider_transfer_id;
- amount_cents = owner_share;
- scheduled_for;
- status;
- blocked_reason;
- attempts;
- paid_at;
- timestamps.

`payout_events` registra cada tentativa.

### 4.31 E-mail

Na FEAT-009, `email_outbox` nasce deliberadamente mínima para a intenção
`studio.review.submitted`: `studio_id`, `revision_id`, audiência allowlisted
`studio_reviewers`, deduplicação única, estado `pending` e timestamp. RLS permanece habilitada sem
policy e sem grants runtime; trigger exige que a mesma revisão possua o evento `submitted`.

A FEAT-029 amplia essa mesma fonte canônica, sem criar outbox paralela, para o contrato operacional:

- id;
- template_key;
- recipient_user_id;
- recipient_address encrypted/server-only when needed;
- payload JSONB limitado;
- deduplication_key unique;
- status;
- scheduled_for;
- attempts;
- last_error_code;
- claimed_at/claimed_by;
- timestamps.

`email_delivery_events` guarda provider message/status sem conteúdo completo.

### 4.32 Fiscal

`fiscal_exports`:

- id;
- period_start/end;
- requested_by;
- status;
- storage_path privado;
- checksum;
- generated_at/expires_at.

### 4.33 Auditoria

`audit.events`:

- id;
- occurred_at;
- actor_user_id;
- actor_role;
- action;
- target_type/id;
- result;
- request_id;
- idempotency_key;
- ip_hash;
- metadata redigida.

Na FEAT-006, a allowlist acrescenta `studio.created`, `studio.revision_updated` e
`studio.draft_discarded`; a FEAT-009 acrescenta `studio.revision_submitted`, `studio.paused` e
`studio.resumed`. `request_id` correlaciona a request HTTP e `idempotency_key` identifica a
tentativa lógica; a unicidade é `(action, target_id, idempotency_key)`, portanto request ID não
deduplica domínio. A FK de `actor_user_id` usa `on delete set null`, preservando o fato; o índice
parcial sobre o ator sustenta a FK sem criar acesso público. A chave idempotente permanece coluna
privada para replay e não entra em log operacional, DTO ou metadata; conteúdo e endereço do estúdio,
payload, requisito bruto, provider e referência externa também não entram na metadata.

### 4.34 Idempotência e jobs

Implementado para a FEAT-006, `private.studio_command_requests` usa
`(owner_user_id, idempotency_key)` como PK e guarda somente action, hashes SHA-256 do payload e do
resultado JSON exato, IDs e versão resultante ou o tombstone de exclusão. Não replica nome, descrição
ou endereço. Cada fachada trava a chave lógica, revalida a autoridade corrente antes do replay e
reconstrói o resultado: hash divergente falha fechado como resultado stale, nunca retorna o estado
atual como se fosse a resposta original.

Os três comandos editoriais reutilizam esse ledger conforme o
[workflow da FEAT-009](#4101-workflow-editorial-da-feat-009); não criam tabela, versão nem payload
paralelos.

Planejado para domínios futuros, `private.idempotency_keys`:

`private.idempotency_keys`:

- scope;
- key;
- actor_id;
- request_hash;
- result JSONB;
- status;
- expires_at;
- unique `(scope, actor_id, key)`.

`private.job_locks` pode guardar lease quando advisory lock não for suficiente.

## 5. Read models

Implementados nas FEAT-002/003/004/006/007/008/009:

- `public.get_current_legal_terms()`: retorna somente `id`, tipo, versão, título, Markdown, hash, origem e vigência atuais; `anon` e `authenticated` podem executar;
- `public.get_own_identity_context()`: retorna 0/1 linha com usuário, tipo de pessoa, status e conclusão derivada; somente `authenticated` pode executar;
- leitura direta de `terms_acceptances` é limitada por coluna e RLS aos fatos do próprio usuário;
- `public.get_my_profile()`: read model `security invoker` que retorna 0/1 linha segura com identidade, máscaras, conclusão e versões de perfil/aparência; não recebe UUID, filtra `auth.uid()` e somente `authenticated` pode executar;
- `public.get_current_owner_contract()`: retorna exclusivamente a versão vigente de `owner_contract` para `authenticated`; `anon` não recebe `EXECUTE` nem leitura dessa espécie jurídica;
- `public.get_owner_activation_status()`: não recebe UUID, filtra `auth.uid()` e retorna 21 colunas, incluindo o contrato completo necessário exclusivamente à leitura/aceite em `/dono`;
- `public.get_owner_recipient_status()`: não recebe UUID, filtra `auth.uid()`, repete o `scope` e retorna 16 colunas com somente a referência mínima do contrato, status internos, requisitos allowlisted, próxima ação, versões e elegibilidade derivada; nunca retorna título, versão textual, hash, corpo Markdown, PII, provider ou referência externa.
- `public.list_active_studio_types()`: retorna somente `id`, nome e ordem dos tipos ativos para
  `authenticated`;
- `public.list_active_studio_taxonomies()`: retorna somente `id`, nome e ordem de tags e comodidades
  ativas para `authenticated`;
- `public.get_owner_studio_editor(uuid)`: retorna 0/1 editor do próprio `auth.uid()`, escolhe o draft
  atual ou a revisão publicada, preserva descritores de tipo, tags e comodidades históricas arquivadas
  e nunca revela a existência do estúdio de outro dono; tanto a função quanto o RLS exigem ainda
  conta ativa, perfil completo, autoridade de dono ativa e aceite íntegro do `owner_contract` vigente.
- `private.get_owner_studio_media(uuid, uuid)`: recebe a identidade autenticada do DAL e o estúdio,
  retorna somente a galeria versionada do dono elegível e conserva o path privado no servidor para
  assinatura de prévias; nenhuma URL ou permissão arbitrária de Storage é concedida ao browser.
- `private.get_owner_studio_publication(uuid, uuid)`: recebe a identidade já autenticada do DAL e o
  estúdio, retorna 0/1 estado editorial estrito do próprio dono, checklist, revisão atual/publicada,
  último fato de review e capacidades derivadas; paths privados de capa não atravessam a API.

A FEAT-004 preserva `public.get_current_legal_terms()` em exatamente `terms | privacy`; o contrato do dono permanece numa leitura autenticada separada.

### Públicos planejados

- `public.list_studios(...)`;
- `public.get_studio_detail(uuid, date)`;
- `public.get_studio_availability(uuid, date, date)`;
- `public.get_reservation_quote(...)`;

### Autenticados planejados

- `public.list_my_reservations(...)`;
- `public.get_my_reservation(uuid)`;
- `public.list_owner_studios(...)`;
- `public.get_owner_calendar(...)`;
- `public.list_owner_reservations(...)`;
- `public.list_owner_payments(...)`;

### Backoffice/private implementados

- `private.list_backoffice_users(...)` usa busca server-side somente por prefixo de e-mail ou UUID
  exato e paginação keyset por `created_at + id`, devolvendo somente e-mail mascarado, status e versão
  opaca, sem papéis; nome bruto não participa do filtro e permanece exclusivo da revelação auditada;
- `private.get_backoffice_user_access(...)` exige admin e compõe no servidor uma única conta com seus
  papéis, status e elegibilidade de perfil para a rota de detalhe;
- `private.list_backoffice_taxonomies(...)` exige admin e devolve versão + contagem de uso.
- `private.list_backoffice_studio_reviews(...)` exige reviewer/admin e devolve fila keyset; somente
  admin recebe linhas de moderação/desativação;
- `private.get_backoffice_studio_review(...)` exige reviewer/admin e devolve o detalhe editorial; casos
  sem candidata pendente e estúdios desabilitados são exclusivos de admin.

### Backoffice/private planejados

- `private.list_admin_payments(...)`;
- `private.get_operational_overview(...)`.

## 5.1 Contrato de paginação dos read models

Listas crescentes usam paginação **keyset** e retornam `items + nextCursor`. O cursor é opaco, incorpora a ordenação e o ID de desempate, e nunca é implementado como número de página/offset. Filtros fazem parte do recorte e uma mudança de filtro reinicia o cursor.

## 6. Comandos privados principais

Implementados:

- `private.create_signup_legal_intent(uuid, uuid, text, uuid, jsonb)`: retorna o token opaco usado somente como metadata transitória do signup; SQLSTATE `23514` identifica versão jurídica stale;
- `private.issue_identity_recovery_context(uuid, uuid, timestamptz)`: valida `auth.sessions` e cria atomicamente binding, scope opaco e grant de 15 minutos;
- `private.inspect_identity_recovery_session(uuid, uuid, timestamptz, uuid, uuid)`: classifica binding/tombstone, observa expiração do JWT e autoriza apenas grant/scope correspondentes;
- `private.claim_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)`: reserva exclusivamente a tentativa da sessão/scope vigentes;
- `private.release_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)`: libera a mesma tentativa ainda vigente após rejeição externa comprovadamente sem efeito;
- `private.consume_identity_recovery_context(uuid, uuid, uuid, uuid, uuid)`: apaga o grant consumido sem remover o tombstone;
- `private.close_identity_recovery_session(uuid, uuid)`: fecha a binding e remove seu grant, preservando a classificação contra replay;
- `private.complete_profile(uuid, bigint, text, text, text, text, text)`: conclui uma vez, permite a correção final de PF/PJ, exige os aceites existentes e retorna a projeção mascarada;
- `private.update_profile_identity(uuid, bigint, text, text, boolean, text, boolean, text)`: corrige perfil concluído, preserva documentos não reenviados e usa substituição explícita para PII;
- `private.update_profile_appearance(uuid, bigint, text)`: altera somente `system/light/dark` com versão própria;
- `private.get_owner_recipient_status_for_user(uuid)`: continua como entrypoint privado; os consumidores selecionam explicitamente somente as 16 colunas compactas, sem transferir o documento jurídico para `start | refresh`;
- `private.activate_owner(uuid, uuid, uuid, uuid, text)`: recebe `user_id`, versão do contrato, `idempotency_key`, `request_id` e hash do user-agent em campos distintos; sob lock do perfil, cria/renova a autoridade e o aceite de forma idempotente, registra a correlação real e retorna a projeção completa de ativação;
- `private.prepare_owner_recipient_operation(uuid, text, uuid)`: sob ordem global de locks, reserva `start | refresh`, sequência e versão do perfil antes de qualquer chamada ao adapter;
- `private.apply_owner_recipient_operation(uuid, uuid, uuid, text, text, text, text[])`: recebe `user_id`, operação, `request_id`, provider, referência, status e requisitos; aplica somente a operação preparada ainda vigente, recusa resultado tardio/divergente e registra a transição redigida. A chave idempotente continua vinculada à operação reservada, sem ocupar o campo de correlação.
- as fachadas FEAT-006/007 criam, atualizam, descartam e leem revisões, taxonomia e conteúdo de
  estúdio sob autoridade do dono, versão otimista e idempotência;
- as fachadas FEAT-008 preparam e liquidam autorização de upload, cercam finalização externa,
  reordenam, definem capa, removem associações e operam cleanup sem manter transação durante Storage;
- `private.get_owner_studio_publication(...)`, `private.submit_studio_revision(...)`,
  `private.pause_studio(...)` e `private.resume_studio(...)` compõem a fronteira editorial da
  FEAT-009; somente `app_dal` executa essas assinaturas;
- `private.open/get/close_backoffice_session(...)` vinculam a sessão Auth ao banco; GET passivo não
  renova a janela de inatividade;
- `private.get_backoffice_user_access(...)` expõe papéis, status e completude do perfil somente à
  composição server-only de um alvo para admin revalidado;
- `private.set_backoffice_user_status(...)` e `private.reveal_backoffice_user_pii(...)` atendem
  `support/admin`, com versão e auditoria;
- `private.set_backoffice_user_role(...)` deriva somente uma das seis actions explícitas de
  concessão/revogação `support/reviewer/admin`, compara `expectedAccountVersion`, exige admin com
  autenticação recente, aceita novas concessões somente para conta ativa com perfil completo e
  protege o último admin ativo;
- `private.upsert_backoffice_taxonomy(...)` e `private.transition_backoffice_taxonomy(...)` exigem
  admin, versão otimista e preservação histórica; a transição deriva o estado da action explícita.
- `private.execute_backoffice_studio_command(...)` deriva `approve/reject/disable/restore` da action
  allowlisted, exige versão e revisão esperadas, serializa a decisão e registra ledger/audit/outbox.

Planejados por suas features proprietárias:

- calendar;
- pricing/addons;
- quote/attempt/hold;
- webhook/payment/reservation;
- cancellation/refund;
- payout;
- admin financeiro/fiscal;
- privacy/export/delete.

Detalhados em `api-contracts.md`.

## 7. Grants

### 7.1 Princípio

Após criar tabela:

```sql
revoke all on table ... from public, anon, authenticated;
```

Conceder somente:

- `anon/authenticated select` em tabelas/read models públicos estritamente necessários;
- `authenticated select` em dados próprios com RLS;
- escrita direta somente em exceção aprovada;
- `app_dal execute` em funções privadas;
- nenhuma escrita de tabela crítica ao browser.

### 7.2 Funções

- revoke de `public`, `anon`, `authenticated`;
- grant execute por função;
- read models públicos podem ter execute para anon/authenticated;
- comandos jamais expostos pela Data API.

## 8. RLS

### 8.1 Perfis

Usuário lê somente as colunas seguras necessárias aos read models invoker do próprio perfil; `tax_id` e `additional_document` crus permanecem sem grant. Não há grant de escrita. Aceites e preferências usam policy própria pelo mesmo `auth.uid()`; a leitura anônima continua limitada a Termos e Privacidade. `owner_profiles` e `owner_payment_recipients` usam policies próprias pelo mesmo `auth.uid()` e grants apenas nas colunas da projeção segura. Os testes materializam usuários A/B e comprovam que perfil, preferências, aceites, autoridade e recebedor não atravessam ownership. Metadata Auth nunca concede autoridade de dono ou papel operacional: essas autoridades nascem exclusivamente em `owner_profiles` e `platform_roles`. Os estados `private.signup_legal_intents`, `private.identity_recovery_grants`, `private.identity_recovery_sessions`, `private.owner_activation_requests`, `private.owner_recipient_operations`, `private.backoffice_sessions`, `private.backoffice_command_requests`, `public.platform_roles` e `audit.events` mantêm RLS sem policy e zero grants para as roles web; o pgTAP falha se essa fronteira for ampliada.

### 8.2 Estúdios

Dono autenticado recebe `select` somente nas colunas allowlisted de seus próprios estúdios e revisões.
Além de `auth.uid()`, as policies e `get_owner_studio_editor` derivam no banco a elegibilidade canônica:
conta ativa, perfil completo, `owner_profiles.status = active` e aceite cujo hash corresponde ao
`owner_contract` vigente. Suspensão, perfil incompleto, bloqueio do dono ou expiração do contrato
retornam zero linhas também em acesso direto pela Data API. Outro dono igualmente obtém zero linhas.
`anon`, `service_role` e `app_dal` não recebem acesso às tabelas; a DAL executa somente as funções
privadas da allowlist. Eventos de review, outbox e ledger editorial também mantêm RLS sem policy e
zero grants runtime. As policies de tipo, tags e comodidades permitem item ativo ou referência histórica do dono
elegível, enquanto os read models de seleção continuam filtrando somente ativos. Conteúdo ainda não
aprovado não possui read model público.

### 8.3 Reservas

Locatário lê próprias. Dono lê reservas dos próprios estúdios por read model. Tabela direta permanece restrita.

### 8.4 Pagamentos

Nenhum pagamento é exposto diretamente. Read model devolve status/valores permitidos.

### 8.5 Storage

Upload permitido somente por URL assinada. Leitura pública de mídia passa por URL controlada/assinada ou CDN somente para mídia de revisão publicada.

## 9. Índices estruturais iniciais

Implementados até a FEAT-009: além dos índices anteriores, `studios.owner_user_id`, os dois ponteiros
de revisão não nulos, a FK de tipo, as FKs reversas de tag/comodidade/mídia e os uniques
`(studio_id, revision_number)`, de um único draft ativo, posição da FAQ, path de objeto, posição e capa
por revisão. A fila de cleanup possui índice parcial por elegibilidade; `studio_media` também indexa as
FKs nullable, `uploaded_by` e a referência privada do ledger idempotente. O workflow editorial
indexa a timeline por `(studio_id, event_sequence desc)`, ator, revisão, decisão terminal e a
referência de revisão do ledger; uniques sustentam evento/tipo, decisão terminal e deduplicação da
outbox. Todos sustentam FK,
invariante ou claim ordenado; nenhum índice de busca pública foi antecipado.

Permitidos sem `EXPLAIN` adicional porque sustentam invariantes/FKs/cursor definido:

- FKs de alto uso;
- unique de slug;
- unique de revisão;
- unique parcial de capa;
- GiST de allocation;
- cursor de listagem por preço/id em publicados;
- cursor de eventos por occurred_at/id;
- unique provider event;
- unique idempotency;
- índices de outbox por status/scheduled_for;
- índices de payout/refund pendentes.

Qualquer outro índice precisa de evidência por `EXPLAIN (ANALYZE, BUFFERS)` no PR que o introduz.

## 10. Testes de banco obrigatórios

- reset do zero;
- baseline do zero e futuras migrations forward-only;
- manifesto de tabelas;
- manifesto de grants;
- RLS entre usuário A/B;
- dono A não lê/edita estúdio B;
- locatário não lê reserva alheia;
- anon só vê publicado;
- revisão pendente não aparece;
- comando sem ownership falha;
- overlap de allocation falha;
- hold expirado pode ser substituído;
- webhook duplicado não duplica;
- cotação e pagamento divergentes falham;
- split soma 100%;
- payout de refund falha;
- security definer com search path seguro;
- funções privadas sem execute público;
- checks de texto/status/dinheiro;
- cursor estável.
