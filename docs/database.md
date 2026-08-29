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

### 1.1 Estado versionado até a FEAT-006 em andamento

A árvore possui a baseline inicial `20260824000100`, a migration de role de produção
`20260828174500_default_production_dal_role` e a migration append-only
`20260829103831_feat_006_studio_core_revision`, que é o head da branch atual. Antes do primeiro deploy, enquanto o
projeto Supabase de produção ainda não possuía migrations, tabelas ou usuários da aplicação, as 16
migrations locais de construção foram consolidadas uma única vez pelo squash oficial schema-only do
Supabase CLI. O preâmbulo versionado preserva roles globais e ACLs de banco, que não fazem parte do
dump de schema. O runner executa um setup idempotente e cinco suítes pgTAP; o recorte atual totaliza
275 asserções para baseline/isolamento, identidade/legal, perfil, dono/recebedor e núcleo de estúdio.

A baseline implementada inclui:

- schemas `private` e `audit`, `app_dal NOLOGIN NOINHERIT`, grants mínimos e RLS;
- identidade mínima, termos/aceites, recovery one-shot e perfil privado;
- autoridade do dono, estado do recebedor, idempotência e correlação de auditoria;
- núcleo de estúdio/revisão, taxonomia mínima, concorrência otimista, ownership e descarte seguro;
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
- `role`: `reviewer/support/finance/admin`;
- `granted_by`;
- `created_at`;
- PK `(user_id, role)`.

Sem escrita pelo browser.

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

O recorte implementado possui somente `studio_types`:

- UUID;
- nome;
- slug;
- `active`;
- `sort_order`;
- timestamps;
- slug único.

Quatro tipos mínimos são seedados deterministicamente. `list_active_studio_types()` oferece somente
ativos para novas escolhas. A policy também conserva legível um tipo arquivado quando ele é
referenciado por revisão pertencente ao `auth.uid()`, permitindo abrir o histórico sem expor esse tipo
a outro dono nem aceitá-lo em nova mutação. Escrita runtime permanece revogada. Amenities e tags não
são criadas antecipadamente e pertencem à feature própria.

### 4.7 `studios`

| Coluna                  | Tipo/Regra                 |
| ----------------------- | -------------------------- |
| `id`                    | uuid PK                    |
| `owner_user_id`         | FK owner profile, not null |
| `status`                | check de ciclo             |
| `published_revision_id` | FK revision null           |
| `draft_revision_id`     | FK revision null           |
| `created_at/updated_at` | timestamptz                |

As FKs de ponteiro são criadas depois das duas tabelas. Um constraint trigger com autoridade interna
prova ao fim de cada instrução atômica que existe ao menos um ponteiro e que ambos pertencem ao mesmo
estúdio. O índice parcial garante no máximo uma revisão `draft` por estúdio.

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
- timestamps;
- unique `(studio_id, revision_number)`.

Somente `draft` pode ser atualizada ou removida, e cada atualização incrementa exatamente
`revision_version`. Revisão `pending`, `approved`, `rejected` ou `superseded` é imutável por trigger.

### 4.9 Relações da revisão

- `studio_revision_amenities(revision_id, amenity_id)`;
- `studio_revision_tags(revision_id, tag_id)`;
- `studio_faqs(id, revision_id, question, answer, position)`;
- unique de posição por revisão;
- limites de 20 FAQs e 20 tags validados no comando.

### 4.10 `studio_media`

- `id`;
- `studio_id`;
- `revision_id`;
- `storage_bucket`;
- `storage_path`;
- `mime_type`;
- `byte_size`;
- `width`, `height`;
- `checksum_sha256`;
- `position`;
- `is_cover`;
- `status`: `uploaded/ready/rejected/deleted`;
- `uploaded_by`;
- timestamps.

Constraints:

- uma capa ativa por revisão (índice único parcial estrutural);
- posição única;
- 1–20 por revisão via comando;
- path namespaced pelo owner/studio/revision.

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

`email_outbox`:

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
`studio.draft_discarded`. `request_id` correlaciona a request HTTP e `idempotency_key` identifica a
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

Implementados nas FEAT-002/003/004/006:

- `public.get_current_legal_terms()`: retorna somente `id`, tipo, versão, título, Markdown, hash, origem e vigência atuais; `anon` e `authenticated` podem executar;
- `public.get_own_identity_context()`: retorna 0/1 linha com usuário, tipo de pessoa, status e conclusão derivada; somente `authenticated` pode executar;
- leitura direta de `terms_acceptances` é limitada por coluna e RLS aos fatos do próprio usuário;
- `public.get_my_profile()`: read model `security invoker` que retorna 0/1 linha segura com identidade, máscaras, conclusão e versões de perfil/aparência; não recebe UUID, filtra `auth.uid()` e somente `authenticated` pode executar;
- `public.get_current_owner_contract()`: retorna exclusivamente a versão vigente de `owner_contract` para `authenticated`; `anon` não recebe `EXECUTE` nem leitura dessa espécie jurídica;
- `public.get_owner_activation_status()`: não recebe UUID, filtra `auth.uid()` e retorna 21 colunas, incluindo o contrato completo necessário exclusivamente à leitura/aceite em `/dono`;
- `public.get_owner_recipient_status()`: não recebe UUID, filtra `auth.uid()`, repete o `scope` e retorna 16 colunas com somente a referência mínima do contrato, status internos, requisitos allowlisted, próxima ação, versões e elegibilidade derivada; nunca retorna título, versão textual, hash, corpo Markdown, PII, provider ou referência externa.
- `public.list_active_studio_types()`: retorna somente `id`, nome e ordem dos tipos ativos para
  `authenticated`;
- `public.get_owner_studio_editor(uuid)`: retorna 0/1 editor do próprio `auth.uid()`, escolhe o draft
  atual ou a revisão publicada, preserva o nome do tipo histórico arquivado e nunca revela a existência
  do estúdio de outro dono.

A FEAT-004 preserva `public.get_current_legal_terms()` em exatamente `terms | privacy`; o contrato do dono permanece numa leitura autenticada separada.

### Públicos planejados

- `public.list_studios(...)`;
- `public.get_studio_detail(uuid, date)`;
- `public.get_studio_availability(uuid, date, date)`;
- `public.get_reservation_quote(...)`;
- `public.list_active_taxonomies()`.

### Autenticados planejados

- `public.list_my_reservations(...)`;
- `public.get_my_reservation(uuid)`;
- `public.list_owner_studios(...)`;
- `public.get_owner_calendar(...)`;
- `public.list_owner_reservations(...)`;
- `public.list_owner_payments(...)`;

### Backoffice/private planejados

- `private.list_review_queue(...)`;
- `private.get_review_case(uuid)`;
- `private.list_admin_users(...)`;
- `private.list_admin_payments(...)`;
- `private.get_operational_overview(...)`.

## 5.1 Contrato de paginação dos read models

Listas crescentes usam paginação **keyset** e retornam `items + nextCursor`. O cursor é opaco, incorpora a ordenação e o ID de desempate, e nunca é implementado como número de página/offset. Filtros fazem parte do recorte e uma mudança de filtro reinicia o cursor.

## 6. Comandos privados principais

Implementados nas FEAT-002/003/004:

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

Planejados por suas features proprietárias:

- studio/revision/media;
- review;
- calendar;
- pricing/addons;
- quote/attempt/hold;
- webhook/payment/reservation;
- cancellation/refund;
- payout;
- admin/taxonomy/fiscal;
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

Usuário lê somente as colunas seguras necessárias aos read models invoker do próprio perfil; `tax_id` e `additional_document` crus permanecem sem grant. Não há grant de escrita. Aceites e preferências usam policy própria pelo mesmo `auth.uid()`; a leitura anônima continua limitada a Termos e Privacidade. `owner_profiles` e `owner_payment_recipients` usam policies próprias pelo mesmo `auth.uid()` e grants apenas nas colunas da projeção segura. Os testes materializam usuários A/B e comprovam que perfil, preferências, aceites, autoridade e recebedor não atravessam ownership. As fixtures adicionais com metadata owner/admin continuam apenas `authenticated`: a metadata não concede autoridade, leitura alheia, escrita direta ou execução privada. A autoridade de dono nasce exclusivamente em `owner_profiles`; `platform_roles` continua pertencendo à FEAT-031. Os estados `private.signup_legal_intents`, `private.identity_recovery_grants`, `private.identity_recovery_sessions`, `private.owner_activation_requests`, `private.owner_recipient_operations` e `audit.events` mantêm RLS sem policy e zero grants para as roles web; o pgTAP falha se essa fronteira for ampliada.

### 8.2 Estúdios

Dono autenticado recebe `select` somente nas colunas allowlisted de seus próprios estúdios e revisões;
as policies usam `auth.uid()` e outro dono obtém zero linhas. `anon`, `service_role` e `app_dal` não
recebem acesso às tabelas; a DAL executa apenas três funções privadas. A policy de tipo permite ativo
ou referência histórica do próprio dono, enquanto o read model de seleção continua filtrando somente
ativos. Conteúdo ainda não aprovado não possui read model público.

### 8.3 Reservas

Locatário lê próprias. Dono lê reservas dos próprios estúdios por read model. Tabela direta permanece restrita.

### 8.4 Pagamentos

Nenhum pagamento é exposto diretamente. Read model devolve status/valores permitidos.

### 8.5 Storage

Upload permitido somente por URL assinada. Leitura pública de mídia passa por URL controlada/assinada ou CDN somente para mídia de revisão publicada.

## 9. Índices estruturais iniciais

Implementados até a FEAT-006: além dos índices anteriores, `studios.owner_user_id`, os dois ponteiros
de revisão não nulos, a FK de tipo e os uniques `(studio_id, revision_number)` e de um único draft
ativo. Todos sustentam FK ou invariantes; nenhum índice de busca pública foi antecipado.

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
