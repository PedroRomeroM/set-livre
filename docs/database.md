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
- Schema snapshot é gerado.

### 1.1 Estado implementado na fundação

A migration head atual é `20260809000300`. A fundação não antecipa nenhuma tabela de domínio e aplica somente:

- `20260809000100_security_baseline.sql`: extensões estruturais, schemas `private`/`audit`, role `app_dal NOLOGIN NOINHERIT`, revogações e default privileges fechados;
- `20260809000200_readiness_contract.sql`: `private.check_readiness(text)` como `security definer`, `search_path = ''` e `execute` exclusivo para `app_dal`;
- `20260809000300_security_default_privileges_hardening.sql`: fecha o default global de `execute` de funções, normaliza `app_dal` e recusa atributos privilegiados que exigiriam superuser;
- login `app_runtime_local` criado e rotacionado fora das migrations pelo bootstrap local, com atributos, memberships, parâmetros, ownership e grants diretos normalizados antes de assumir `app_dal` explicitamente;
- readiness consulta o catálogo por um subpath compartilhado `server-only` e falha se o login ou a role efetiva `app_dal` possuir login, herança, criação, replicação, superuser ou `BYPASSRLS`; `app_dal` também deve permanecer sem qualquer membership, pois `NOINHERIT` não impede `SET ROLE`; o teste SQL adultera atributos e membership transacionalmente, comprova a detecção e restaura a role;
- 56 asserts pgTAP, incluindo funções-probe que comprovam deny-by-default nos três schemas, o estado exato das roles e a detecção de atributos ou memberships adulterados em `app_dal`;
- snapshot SQL em `supabase/schema.generated.sql` e tipos em `packages/contracts/src/database.generated.ts`.

`npm run supabase:schema` direciona o dump a um temporário exclusivo e irmão de `schema.generated.sql`; após a CLI terminar com sucesso, comprova que o arquivo físico não mudou, exige declarações dos schemas `audit`, `private` e `public`, normaliza a quebra de linha final, sincroniza em disco e publica por substituição atômica. `npm run supabase:types` usa o mesmo padrão para os tipos, valida os exports e a sintaxe TypeScript e aplica a configuração Prettier versionada antes da publicação. Uma falha da stack local, CLI, leitura, normalização, validação ou formatação preserva o artefato rastreado anterior e não deixa saída parcial.

As migrations aplicadas são imutáveis. Tabelas, RLS e comandos de cada domínio entram apenas na respectiva fatia vertical.

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

| Coluna                     | Tipo             | Regra                                          |
| -------------------------- | ---------------- | ---------------------------------------------- |
| `id`                       | uuid             | PK/FK `auth.users`, cascade                    |
| `person_type`              | text             | `individual/company`                           |
| `display_name`             | text             | 2–120                                          |
| `phone_e164`               | text             | formato normalizado                            |
| `tax_document_type`        | text             | `cpf/cnpj` coerente                            |
| `tax_document_number`      | text             | dígitos, acesso privado                        |
| `identity_document_number` | text null        | até 30                                         |
| `status`                   | text             | `active/suspended/deletion_pending/anonymized` |
| `created_at`               | timestamptz      | UTC                                            |
| `updated_at`               | timestamptz      | UTC                                            |
| `anonymized_at`            | timestamptz null |                                                |

O e-mail canônico permanece no Auth. Read models privados podem obtê-lo server-side quando necessário.

### 4.2 `owner_profiles`

| Coluna               | Regra            |
| -------------------- | ---------------- |
| `user_id`            | PK/FK profile    |
| `business_name`      | 2–160            |
| `support_phone_e164` | opcional         |
| `terms_version_id`   | aceite do dono   |
| `status`             | `active/blocked` |

### 4.3 `platform_roles`

- `user_id`;
- `role`: `reviewer/support/finance/admin`;
- `granted_by`;
- `created_at`;
- PK `(user_id, role)`.

Sem escrita pelo browser.

### 4.4 `terms_versions`

- `id`;
- `kind`: `terms/privacy/cancellation/owner_agreement`;
- `version`;
- `content_hash`;
- `effective_at`;
- `retired_at`;
- unique `(kind, version)`.

### 4.5 `terms_acceptances`

- `user_id`;
- `terms_version_id`;
- `accepted_at`;
- `ip_hash`;
- `user_agent_hash`;
- PK composta.

### 4.6 Taxonomias

`studio_types`, `amenities`, `tags`:

- UUID;
- nome;
- slug;
- descrição curta;
- `active`;
- `sort_order`;
- timestamps;
- slug único.

Browser lê ativos; somente backoffice altera via comando.

### 4.7 `studios`

| Coluna                  | Tipo/Regra                |
| ----------------------- | ------------------------- |
| `id`                    | uuid PK                   |
| `owner_user_id`         | FK profile, not null      |
| `status`                | check de ciclo            |
| `published_revision_id` | FK revision null          |
| `draft_revision_id`     | FK revision null          |
| `timezone`              | default America/Sao_Paulo |
| `reservations_enabled`  | boolean                   |
| `disabled_reason`       | text null                 |
| `created_at/updated_at` | timestamptz               |
| `paused_at/disabled_at` | timestamptz null          |

A FK circular revisão↔estúdio é criada em etapas de migration.

### 4.8 `studio_revisions`

Campos públicos versionados:

- `id`, `studio_id`, `revision_number`;
- `status`;
- `name` 2–120;
- `description` 20–5000;
- endereço estruturado;
- `city` fixada/validada para Curitiba na baseline;
- `state` = PR;
- `postal_code`;
- `capacity` 1–500;
- `rules_text` até 5000;
- `youtube_video_id` null;
- `studio_type_id`;
- `submitted_at`, `reviewed_at`, `reviewed_by`, `review_notes`;
- timestamps;
- unique `(studio_id, revision_number)`.

Uma revisão submetida/aprovada/rejeitada é imutável por trigger/comando.

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
- `provider`;
- `provider_recipient_id` criptografado/privado;
- `status`: `not_started/pending/active/refused/suspended/blocked`;
- `requirements_snapshot` JSONB limitado;
- timestamps.

Não exposto ao browser diretamente; read model retorna estado seguro.

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
- ip_hash;
- metadata redigida.

### 4.34 Idempotência e jobs

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

### Públicos

- `public.list_studios(...)`;
- `public.get_studio_detail(uuid, date)`;
- `public.get_studio_availability(uuid, date, date)`;
- `public.get_reservation_quote(...)`;
- `public.list_active_taxonomies()`.

### Autenticados

- `public.get_my_profile()`;
- `public.list_my_reservations(...)`;
- `public.get_my_reservation(uuid)`;
- `public.list_owner_studios(...)`;
- `public.get_owner_studio_editor(uuid)`;
- `public.get_owner_calendar(...)`;
- `public.list_owner_reservations(...)`;
- `public.list_owner_payments(...)`;
- `public.get_owner_recipient_status()`.

### Backoffice/private

- `private.list_review_queue(...)`;
- `private.get_review_case(uuid)`;
- `private.list_admin_users(...)`;
- `private.list_admin_payments(...)`;
- `private.get_operational_overview(...)`.

## 5.1 Contrato de paginação dos read models

Listas crescentes usam paginação **keyset** e retornam `items + nextCursor`. O cursor é opaco, incorpora a ordenação e o ID de desempate, e nunca é implementado como número de página/offset. Filtros fazem parte do recorte e uma mudança de filtro reinicia o cursor.

## 6. Comandos privados principais

- profile/account;
- owner activation/recipient;
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

Usuário lê próprio perfil. Não lê documento de outro. Atualização crítica via comando.

### 8.2 Estúdios

Dono lê seus estúdios/revisões/configurações. Público lê somente read models de publicado. Não conceder select público direto em revisões.

### 8.3 Reservas

Locatário lê próprias. Dono lê reservas dos próprios estúdios por read model. Tabela direta permanece restrita.

### 8.4 Pagamentos

Nenhum pagamento é exposto diretamente. Read model devolve status/valores permitidos.

### 8.5 Storage

Upload permitido somente por URL assinada. Leitura pública de mídia passa por URL controlada/assinada ou CDN somente para mídia de revisão publicada.

## 9. Índices estruturais iniciais

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

Qualquer outro índice precisa de evidência em `docs/changes`.

## 10. Testes de banco obrigatórios

- reset do zero;
- migration chain;
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
