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

### 1.1 Estado implementado até a FEAT-004

A árvore possui 13 migrations append-only e head `20260812000100`. Reset e geração passaram nesse head; as quatro suítes pgTAP passaram em 355/355 asserts. A fundação continua intacta; a FEAT-002 fornece identidade mínima, `legal-core` e recovery, a FEAT-003 completa o perfil e a FEAT-004 acrescenta a autoridade de dono e o recebedor local:

- `20260809000100_security_baseline.sql`: extensões estruturais, schemas `private`/`audit`, role `app_dal NOLOGIN NOINHERIT`, revogações e default privileges fechados;
- `20260809000200_readiness_contract.sql`: `private.check_readiness(text)` como `security definer`, `search_path = ''` e `execute` exclusivo para `app_dal`;
- `20260809000300_security_default_privileges_hardening.sql`: fecha o default global de `execute` de funções, normaliza `app_dal` e recusa atributos privilegiados que exigiriam superuser;
- `20260810000100_app_dal_readiness_authorization.sql`: incorpora ao readiness os manifestos exatos de `app_dal` e do login da sessão, cria `private.check_runtime_readiness(text)`, fecha a baseline pública e impede ACL pública efetiva nos objetos alcançáveis de `private` e nos objetos compartilhados monitorados;
- `20260810000200_pg_catalog_public_acl_hardening.sql`: mantém a leitura pública canônica dos catálogos do PostgreSQL, mas faz o readiness recusar qualquer privilégio de `PUBLIC` em relação ou coluna de `pg_catalog` que exceda a baseline inicial registrada em `pg_init_privs`, inclusive acesso a `pg_authid` ou `rolpassword`;
- `20260810000300_pg_catalog_public_routine_acl_hardening.sql`: estende o mesmo containment às rotinas de `pg_catalog`, por OID de cada overload, e recusa grantor, privilégio ou grant option público além da ACL inicial canônica;
- `20260810000400_pg_catalog_implicit_routine_owner_hardening.sql`: elimina `proowner` mutável da derivação das baselines implícitas de rotinas `pg_catalog`; objetos initdb sem membership usam o owner bootstrap OID `10`, membros de extensão usam `pg_extension.extowner`, e qualquer owner divergente falha mesmo sem `EXECUTE` público;
- `20260811000100_database_temporary_privilege_hardening.sql`: revoga `TEMPORARY` de `PUBLIC` no banco atual, preserva sem ampliar os grants explícitos administrados pela stack e faz os dois entrypoints de readiness recusarem a capacidade efetiva para `app_dal` e para o login restrito;
- `20260811000200_authentication_legal_core.sql`: cria a base mínima de `profiles`, versões e aceites jurídicos, intenções privadas de cadastro e grants de recovery persistidos no banco, expiráveis e one-shot, trigger atômico em `auth.users`, read models vigentes/próprios, RLS e grants mínimos;
- `20260811000300_authentication_review_hardening.sql`: habilita RLS sem policy em `private.signup_legal_intents` e impede que `release_identity_recovery_grant` reabra uma claim depois da expiração, sem alterar grants ou a allowlist da DAL;
- `20260811000400_recovery_session_binding.sql`: invalida grants antigos sem contexto de sessão, vincula cada novo recovery ao `session_id` assinado e à linha canônica de `auth.sessions`, cria a binding/tombstone privada retida depois do grant/cookies, exige `app.settings.jwt_exp=3600` e substitui as cinco operações antigas por seis comandos escopados ao contexto;
- `20260811000500_profile_account.sql`: adiciona nome, telefone E.164, CPF/CNPJ, documento adicional, máscaras generated e versão otimista a `profiles`; cria `user_preferences` 1:1 com versão independente; valida CPF e CNPJ numérico/alfanumérico no banco; materializa um read model público invoker, três comandos privados e amplia o readiness sem alterar migrations anteriores;
- `20260812000100_owner_onboarding_recipient.sql`: acrescenta contrato do dono, autoridade e recebedor versionados, preparação/aplicação privada idempotente, projeções seguras, auditoria mínima e quatro entrypoints DAL; reset, geração e sua suíte pgTAP estão verdes.
- login `app_runtime_local` criado e rotacionado fora das migrations pelo bootstrap local, com atributos, memberships, parâmetros, ownership e grants diretos reconciliados antes de assumir `app_dal` explicitamente. Seu manifesto permite somente `CONNECT` direto no banco atual, a membership de saída para `app_dal`, a referência administrativa de `postgres` sem `SET/INHERIT` e uma máscara vazia para o GUC local de assinatura JWT; qualquer ACL, ownership, parâmetro ou membro adicional falha fechado. O mesmo bootstrap usa somente o superuser da stack local para fechar schema, tabelas, sequências, funções e defaults de `net`, preservando exclusivamente os privilégios administrativos exigidos pelo worker `pg_net` sob `postgres`;
- readiness consulta as duas funções de saúde por um subpath compartilhado `server-only` e falha se o login ou a role efetiva `app_dal` possuir login, herança, criação, replicação, superuser, `BYPASSRLS` ou `TEMPORARY` no banco; `app_dal` também deve permanecer sem qualquer membership de saída, pois `NOINHERIT` não impede `SET ROLE`;
- o manifesto mínimo de `app_dal` permite diretamente apenas `USAGE` no schema `private` e `EXECUTE` nas dezesseis rotinas autorizadas: os dois checks de readiness, a criação da intenção legal, seis operações de recovery (`issue context`, `inspect session`, `claim`, `release`, `consume`, `close`), três comandos de perfil (`complete`, `update identity`, `update appearance`) e os quatro entrypoints FEAT-004 (`get owner recipient for user`, `activate owner`, `prepare recipient operation`, `apply recipient operation`). Todos ficam sem grant option. A allowlist exige exatamente dezessete dependências ACL em `pg_shdepend` e inspeciona seus `aclitem`; as leituras públicas invoker `get_my_profile()` e `get_owner_recipient_status()` não recebem grant DAL. O readiness também rejeita referências da role como grantor e grants adicionais de banco, schema, relação, coluna, função, tipo, objeto grande, linguagem, foreign data wrapper/server, tablespace, parâmetro e default privilege sem depender de enumeração frouxa. Como `USAGE private` torna grants de `PUBLIC` efetivos para a DAL, o guard expande ACLs atuais ou padrão (`acldefault`) de relações, colunas, sequências, rotinas e tipos autônomos desse schema e recusa qualquer entrada pública. Row types de relações, arrays e multiranges implícitos seguem seus objetos canônicos e não são tratados como tipos autônomos; composites explícitos continuam monitorados. Ownership é recusado pelo catálogo compartilhado. O pgTAP introduz cada drift transacionalmente, comprova a falha fechada, restaura o catálogo e exige readiness verde antes do cenário seguinte;
- `app_dal` não pode assumir nenhuma role. Em sentido inverso, o manifesto permite exatamente o login da sessão com `SET=true`, sem `ADMIN/INHERIT`, e a membership administrativa de `postgres` criada pelo PostgreSQL 17 com `ADMIN=true`, sem `SET/INHERIT`; o login também só pode ser administrado por essa referência `postgres` sem `SET/INHERIT`, portanto uma cadeia intermediária até `app_dal` derruba readiness;
- a baseline pública permite exatamente `USAGE` em `pg_catalog`/`information_schema`, `CONNECT` no banco e `USAGE` nas quatro linguagens internas, sem grant option. `TEMPORARY` fica restrito aos grants explícitos que a própria stack administra, como o da dashboard local; a migration não cria uma allowlist paralela nem amplia nenhuma role. Ela recusa ACL pública em outros schemas, defaults, objetos grandes, parâmetros, FDW/servers e tablespaces. Em toda relação ou coluna de `pg_catalog`, um privilégio efetivo de `PUBLIC` precisa já existir nos privilégios iniciais `i`/`e` de `pg_init_privs`; privilégios por coluna podem ser cobertos pelo grant inicial da própria coluna ou da relação. Nas rotinas desse schema, cada entrada pública atual precisa estar contida, com grantor e grant option, na ACL `i`/`e` do OID exato. Sem esse registro, a baseline implícita nunca deriva de `proowner`: membros de extensão usam `acldefault('f', pg_extension.extowner)`, exigindo o mesmo owner no objeto, e demais rotinas initdb (`OID < 16384`) usam `acldefault('f', 10)`, com owner bootstrap OID `10` obrigatório. Uma rotina normal posterior sem `pg_init_privs` tem baseline pública vazia. A checagem de owner é independente da presença de `EXECUTE` público, portanto revogar a ACL não mascara ownership adulterado. Isso preserva, por exemplo, o `EXECUTE` built-in de `current_database()` e uma extensão canônica sem init row, sem aceitar um grant em `pg_read_file(text)`, uma função normal nova ou grantor recalculado a partir de owner mutável. `pg_roles`, `pg_user` e `pg_db_role_setting` conservam ainda a baseline mais estrita de somente owner administrativo e `SELECT` de `postgres`, sem ACL por coluna; roles web/DAL também não podem alcançar esses três catálogos por membership transitiva. O contrato não classifica a segurança semântica de cada rotina, não cobre por si só grants a roles nomeadas nem afirma que todo catálogo built-in seja confidencial. Enquanto o ADR-018 suspender APIs externas, `app_dal`, `anon`, `authenticated`, `service_role` e `PUBLIC` não usam nem leem/escrevem/executam o schema `net`; o worker administrativo local conserva apenas o acesso necessário;
- 355 asserts pgTAP: 158 da baseline de segurança, 78 do `legal-core`, 57 do perfil e 62 da FEAT-004. A suíte `0004_owner_onboarding_recipient.sql` prova ACL/RLS e isolamento A/B, personas adversariais owner/admin sem bypass, ativação e aceite, prepare/apply, renovação contratual, drift de perfil/readiness, transições e bloqueio terminal, concorrência real com a mesma chave e replay convergente. A inspeção final encontrou zero linha nas 15 relações Auth/perfil/dono/operação/auditoria/aceites/intenções, zero ocorrência nas dez verificações QA/fixture, zero órfão, zero sessão dblink e Mailpit 0/0; a única mensagem criada pela fixture concorrente foi removida pelo ID exato;
- snapshot SQL em `supabase/schema.generated.sql` e tipos em `packages/contracts/src/database.generated.ts`.

`npm run supabase:schema` direciona o dump a um temporário exclusivo e irmão de `schema.generated.sql`; após a CLI terminar com sucesso, comprova que o arquivo físico não mudou, exige declarações dos schemas `audit`, `private` e `public`, normaliza a quebra de linha final, sincroniza em disco e publica por substituição atômica. `npm run supabase:types` usa o mesmo padrão para os tipos, valida os exports e a sintaxe TypeScript e aplica a configuração Prettier versionada antes da publicação. Uma falha da stack local, CLI, leitura, normalização, validação ou formatação preserva o artefato rastreado anterior e não deixa saída parcial.

`npm run test:db` executa o pgTAP e, ainda contra a instância local, torna obrigatória a conferência dos dois artefatos. O gate valida a raiz e cada diretório ancestral físico, gera snapshot e tipos em destinos irmãos exclusivos, nunca nos arquivos rastreados, e preserva as extensões `.sql`/`.ts` para aplicar a mesma normalização e formatação dos comandos de publicação. As leituras usam `O_NOFOLLOW`; identidade e bytes dos quatro arquivos são revalidados depois dos dois geradores e então comparados. Qualquer diferença ou troca detectada pelas revalidações falha e exige correção; o cleanup tenta ambos os nomes temporários exatos, preserva a causa original se uma remoção também falhar e nunca recorre a remoção recursiva ou publica nos contratos versionados.

As migrations aplicadas são imutáveis. Fora dos objetos usados diretamente pelas FEAT-002/003/004, tabelas, RLS e comandos dos demais domínios entram apenas na respectiva fatia vertical.
Quando uma feature autorizar nova função para `app_dal`, a mesma migration append-only deve atualizar o manifesto de readiness; conceder `EXECUTE` sem ampliar explicitamente a allowlist mantém os apps em `unready`.

O gate Git usa a mesma base segura escolhida pelos checks documentais e percorre cada snapshot da cadeia `first-parent` até `HEAD`. Antes de confiar em histórico, índice ou untracked, `git rev-parse --show-toplevel` precisa resolver para o mesmo caminho canônico e o mesmo diretório físico, por dispositivo e inode, da raiz auditada; ambos são revalidados depois da consulta. Um `core.worktree` que desvie o Git para outra árvore falha, enquanto um linked worktree legítimo continua válido quando a raiz informada é o próprio worktree. Todo checkout com `HEAD` precisa expor histórico completo: clone shallow, qualquer referência em `refs/replace` e `info/grafts` legado não vazio falham antes da leitura da cadeia. Depois que uma migration aparece em um commit, caminho, blob e modo tornam-se imutáveis nos commits seguintes; remoção e rename também falham. A base precisa pertencer à cadeia `first-parent`, e uma referência apenas ancestral por outro parent falha fechado em vez de formar uma transição falsa. Cada grupo de migrations introduzido no mesmo commit pode conter vários arquivos, mas todas as versões precisam ser únicas e avançar estritamente o head do snapshot anterior.

O índice e o worktree são comparados separadamente com `HEAD`, inclusive para migrations introduzidas anteriormente na própria feature. Flags `assume-unchanged`, `skip-worktree`, conflitos e nós não físicos são recusados; novas migrations precisam permanecer arquivos regulares exclusivos sob ancestrais físicos e usar nomes canônicos. Toda entrada física do diretório precisa estar no índice ou aparecer exatamente como untracked em `git ls-files --others --exclude-standard`, executado no ambiente Git fechado. Assim uma migration nova e visível continua válida antes do stage, enquanto `.gitignore`, `.git/info/exclude` ou outra regra de ignore não podem esconder SQL físico do gate. Bootstrap sem `HEAD` e o commit raiz continuam aceitando a cadeia inicial, sem dispensar nomes, tipos, exclusividade ou o contrato do head atual.

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
- ip_hash;
- metadata redigida.

Na FEAT-004, a tabela é append-only e aceita somente `owner.activated`, `owner.contract_renewed` e `recipient.status_transitioned`, com unicidade `(action, target_id, request_id)`. A FK de `actor_user_id` usa `on delete set null`, preservando o fato; o índice parcial sobre o ator sustenta a FK sem criar acesso público. Payload, requisito bruto, provider e referência externa não entram na metadata.

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

Implementados nas FEAT-002/003/004:

- `public.get_current_legal_terms()`: retorna somente `id`, tipo, versão, título, Markdown, hash, origem e vigência atuais; `anon` e `authenticated` podem executar;
- `public.get_own_identity_context()`: retorna 0/1 linha com usuário, tipo de pessoa, status e conclusão derivada; somente `authenticated` pode executar;
- leitura direta de `terms_acceptances` é limitada por coluna e RLS aos fatos do próprio usuário;
- `public.get_my_profile()`: read model `security invoker` que retorna 0/1 linha segura com identidade, máscaras, conclusão e versões de perfil/aparência; não recebe UUID, filtra `auth.uid()` e somente `authenticated` pode executar;
- `public.get_current_owner_contract()`: retorna exclusivamente a versão vigente de `owner_contract` para `authenticated`; `anon` não recebe `EXECUTE` nem leitura dessa espécie jurídica;
- `public.get_owner_recipient_status()`: não recebe UUID, filtra `auth.uid()`, repete o `scope` e retorna somente contrato, status internos, requisitos allowlisted, próxima ação, versões e elegibilidade derivada; nunca retorna PII, provider ou referência externa.

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
- `public.get_owner_studio_editor(uuid)`;
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
- `private.get_owner_recipient_status_for_user(uuid)`: retorna a mesma projeção segura para o usuário já autenticado pelo servidor, sem expor as tabelas privadas ao DAL;
- `private.activate_owner(uuid, uuid, uuid, text)`: sob lock do perfil, valida contrato vigente e perfil completo, cria/renova a autoridade e o aceite de forma idempotente e retorna o estado autoritativo;
- `private.prepare_owner_recipient_operation(uuid, text, uuid)`: sob ordem global de locks, reserva `start | refresh`, sequência e versão do perfil antes de qualquer chamada ao adapter;
- `private.apply_owner_recipient_operation(uuid, uuid, text, text, text, text[])`: aplica somente a operação preparada ainda vigente, recusa resultado tardio/divergente e registra a transição redigida.

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

Dono lê seus estúdios/revisões/configurações. Público lê somente read models de publicado. Não conceder select público direto em revisões.

### 8.3 Reservas

Locatário lê próprias. Dono lê reservas dos próprios estúdios por read model. Tabela direta permanece restrita.

### 8.4 Pagamentos

Nenhum pagamento é exposto diretamente. Read model devolve status/valores permitidos.

### 8.5 Storage

Upload permitido somente por URL assinada. Leitura pública de mídia passa por URL controlada/assinada ou CDN somente para mídia de revisão publicada.

## 9. Índices estruturais iniciais

Implementados até a FEAT-004: PKs, FKs, uniques de `(kind, version)`, `(request_id, terms_version_id)`, `request_id` da intenção, chaves de ativação/operação e sequência, GiST de vigência jurídica e B-trees usadas pelos purges obrigatórios. `audit.events` possui índice parcial estrutural em `actor_user_id` para sua FK. `user_preferences`, `owner_profiles` e `owner_payment_recipients` usam suas PKs/FKs 1:1; CPF/CNPJ não recebe índice ou unique. Nenhum índice alheio aos caminhos implementados foi criado por antecipação.

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
