# Modelo de domínio

## 1. Linguagem do produto

| Termo                         | Definição                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Estúdio                       | entidade operacional pertencente a um dono                                                               |
| Revisão                       | versão editável/aprovável do conteúdo público                                                            |
| Disponibilidade               | resultado derivado de regras, exceções e alocações                                                       |
| Alocação                      | período que ocupa calendário: hold, reserva, bloqueio ou iCal                                            |
| Cotação                       | snapshot de preço e seleção, com validade curta                                                          |
| Tentativa                     | jornada de pagamento ainda não convertida em reserva                                                     |
| Hold                          | alocação temporária adquirida após início do pagamento                                                   |
| Reserva                       | fato confirmado após pagamento                                                                           |
| Pagamento                     | estado financeiro reportado e reconciliado com provider                                                  |
| Split                         | regra financeira 80/20 sobre bruto                                                                       |
| Repasse                       | transferência programada/executada após o uso                                                            |
| Reembolso                     | devolução total vinculada ao pagamento                                                                   |
| Evento operacional            | transição relevante e auditável                                                                          |
| Read model                    | projeção para uma tela; não é fonte canônica                                                             |
| Intenção jurídica de cadastro | token opaco, temporário e one-shot que coordena Auth com os aceites sem transferir autoridade ao browser |

## 2. Classificação

### 2.1 Entidades

- perfil;
- perfil de dono;
- estúdio;
- revisão;
- taxonomias;
- adicional;
- provider recipient.

### 2.2 Configurações

- horário semanal;
- exceção;
- buffer;
- duração;
- preço base;
- multiplicadores;
- política/versão legal;
- configuração de lembrete/repasse global.

### 2.3 Fatos

- pagamento recebido;
- reserva confirmada;
- cancelamento;
- reembolso;
- repasse;
- aprovação/rejeição;
- aceite legal.

### 2.4 Eventos

- transições de status;
- webhook recebido;
- ação administrativa;
- alteração sensível;
- falha/retry.

### 2.5 Snapshots

- revisão publicada;
- cotação;
- line items;
- dados mínimos das partes na reserva;
- política de cancelamento vigente;
- exportação fiscal.

### 2.6 Read models

- listagem pública;
- detalhe;
- disponibilidade;
- agenda;
- painéis;
- filas de backoffice;
- históricos financeiros.

## 3. Fontes canônicas

| Conceito                   | Fonte                                        |
| -------------------------- | -------------------------------------------- |
| Conta                      | Supabase Auth + `profiles`                   |
| Preferência visual         | `user_preferences`                           |
| Versão jurídica            | `terms_versions`                             |
| Aceite jurídico            | `terms_acceptances`                          |
| Autoridade de dono         | `owner_profiles`                             |
| Estado seguro do recebedor | `owner_payment_recipients`                   |
| Operação/referência local  | `private.owner_recipient_operations`         |
| Papel administrativo       | `platform_roles`                             |
| Estúdio operacional        | `studios`                                    |
| Conteúdo público           | revisão apontada por `published_revision_id` |
| Conteúdo em edição         | `draft_revision_id`                          |
| Taxonomia                  | `studio_types`, `amenities`, `tags`          |
| Disponibilidade recorrente | `studio_weekly_windows`                      |
| Exceção por data           | `studio_date_exceptions`                     |
| Ocupação                   | `calendar_allocations`                       |
| Preço atual                | tabelas de pricing                           |
| Preço histórico            | `reservation_quotes` e items                 |
| Tentativa                  | `booking_attempts`                           |
| Hold                       | `booking_holds` + allocation                 |
| Reserva                    | `reservations`                               |
| Pagamento                  | `payments`                                   |
| Provider events            | `webhook_events` e `payment_events`          |
| Reembolso                  | `refunds`                                    |
| Repasse                    | `payouts`                                    |
| E-mail pendente            | `email_outbox`                               |
| Ação sensível              | `audit.events`                               |

## 4. Ownership

### 4.1 Usuário

`profiles.id = auth.users.id`.

O perfil mínimo e os dois aceites nascem atomicamente no trigger de `auth.users` após consumo de uma intenção privada válida. A intenção não é fato de negócio e pode expirar; o aceite preserva para sempre versão, hash, instante, `requestId` e evidência minimizada.

A FEAT-003 completa `profiles` com nome, telefone E.164, CPF/CNPJ, documento adicional opcional, máscaras derivadas e `profile_version`. Antes da conclusão os dados pessoais permanecem todos nulos. CPF usa onze dígitos; CNPJ preserva os registros numéricos e aceita o formato alfanumérico uppercase de doze caracteres mais dois DVs numéricos. A validação local prova somente formato e DV, nunca existência ou titularidade, e o CPF/CNPJ não é unique.

`person_type` pode ser corrigido somente no comando atômico de primeira conclusão e torna-se imutável depois. Nome, telefone e documentos atuais podem ser corrigidos sem reescrever snapshots históricos futuros. Retries idênticos convergem sem nova versão; mudanças concorrentes divergentes usam a versão otimista e retornam conflito.

`user_preferences` é configuração 1:1 criada com o perfil, limitada a `system/light/dark` e versionada separadamente. Aparência e identidade não incrementam a versão uma da outra.

`account_version` é o fence independente do status `active/suspended`. Suspender uma conta não altera
`profile_version`; qualquer comando privado continua revalidando o status canônico.

A leitura da conta usa `public.get_my_profile()` como read model `security invoker`, sem argumento de usuário e sempre filtrado por `auth.uid()`. Os comandos privados usam uma projeção interna sem grant runtime para devolver o mesmo estado mascarado; essa projeção não transfere autoridade nem constitui read model.

### 4.2 Dono e recebedor

`owner_profiles.user_id = profiles.id` é a única autoridade canônica de dono; claim ou metadata Auth não concede esse estado. A linha guarda somente status, versão, instante de ativação e a versão vigente de `owner_contract` aceita. Identidade e PII continuam exclusivamente em `profiles`, enquanto cada aceite imutável permanece em `terms_acceptances`.

`owner_payment_recipients.owner_user_id = owner_profiles.user_id` guarda somente status interno, requisitos allowlisted, versão sincronizada do perfil e versão do recebedor. Provider, referência e operações idempotentes ficam em `private.owner_recipient_operations`; o navegador nunca os recebe. A elegibilidade é derivada e falha fechada diante de contrato vencido, dono/recebedor inativo ou drift de perfil.

### 4.3 Estúdio

`studios.owner_user_id` referencia a autoridade em `owner_profiles` e é `not null`. Uma conta pode
possuir vários estúdios; não existe membership nesta versão. O registro operacional guarda somente
estado e os ponteiros `published_revision_id`/`draft_revision_id`; todo conteúdo editável fica em
`studio_revisions`.

Um estúdio possui ao menos um dos ponteiros e no máximo um draft. O ponteiro sempre referencia uma
revisão do próprio estúdio. A primeira criação gera estúdio + revisão 1/draft atomicamente. Atualizar
draft incrementa `revision_version`; editar uma revisão aprovada sem draft cria o próximo
`revision_number` e preserva a aprovada. Descartar o único draft remove o estúdio ainda inédito;
descartar um draft sobre publicação volta ao ponteiro aprovado sem alterar histórico público.

`draft_revision_id` é o ponteiro histórico para a candidata editorial atual, não uma autorização de
escrita. Ele aponta para `draft` enquanto editável e permanece apontando para a mesma revisão quando a
submissão a torna `pending`. Nesse estado, revisão, taxonomias, FAQ e associações de mídia são
imutáveis. A FEAT-030 decide essa candidata: aprovação move o ponteiro publicado e limpa a candidata;
rejeição registra motivo em evento editorial próprio e cria uma nova candidata `draft` a partir do
conteúdo rejeitado, sem usar `audit.events` como read model de produto.

Se essa primeira correção for descartada antes de qualquer aprovação, continua valendo a regra do
agregado inédito: o estúdio, suas revisões, eventos editoriais e intenções de e-mail são removidos na
mesma transação. A auditoria e o ledger terminal de idempotência permanecem como evidência operacional.

Toda mutação revalida no banco perfil ativo/completo, dono ativo e aceite vigente de
`owner_contract`, inclusive em replay idempotente. O navegador envia somente conteúdo e o fence
`{expectedRevisionId, expectedRevisionVersion}`; status, número e ownership nunca vêm do cliente. O
ledger compara hashes do payload e do resultado original: replay devolve exatamente a resposta
registrada ou falha fechado quando uma mudança posterior impede reconstruí-la.

Tipo arquivado continua legível somente ao dono de revisão que o referencia, preservando o histórico.
Ele não reaparece na lista ativa e nenhuma nova mutação pode selecioná-lo.

Regras de uso e YouTube ID pertencem à revisão. Tags, comodidades e FAQ ordenada são relações filhas
do mesmo `revision_id`; só uma revisão draft pode alterá-las. Taxonomia precisa estar ativa no instante
do comando, e uma corrida de arquivamento falha sem efeito parcial. Ao editar conteúdo aprovado sem
draft, a nova revisão clona integralmente esse conjunto antes de aplicar a mudança, preservando a
fonte pública aprovada.

### 4.4 Reserva

`reservations.renter_user_id` identifica o locatário. `reservations.studio_id` e snapshots preservam o dono/estúdio do momento.

### 4.5 Backoffice

Papéis são globais e não alteram ownership. A FEAT-031 materializa somente `support` e `admin`:
support opera contas e PII justificada; admin também gerencia papéis e taxonomias. Claims/metadata Auth
não concedem papel. O primeiro admin nasce por bootstrap privado one-shot e o último admin ativo não
pode ser suspenso ou removido.

Uma sessão operacional é a interseção entre sessão Auth canônica, perfil ativo/concluído, papel atual e
`private.backoffice_sessions`. A binding expira por inatividade/tempo absoluto e é fechada quando a
conta perde todos os papéis ou é suspensa. Alterar papel exige autenticação recente.

Listas de usuário contêm e-mail mascarado; PII crua continua nas fontes canônicas Auth/`profiles` e é
uma resposta efêmera, motivada e auditada, não um novo read model persistido. Comandos administrativos
usam versão esperada, idempotência e auditoria. Taxonomia usada nunca é apagada: `active=false` bloqueia
novas seleções, preserva referências e incrementa `taxonomy_version`.

## 5. Estado de estúdio

Estados operacionais:

- `draft`: nunca publicado;
- `pending_review`: primeira revisão aguardando;
- `published`: revisão aprovada e reservável;
- `changes_pending`: versão pública ativa e nova revisão aguardando;
- `paused`: oculto pelo dono;
- `rejected`: primeira revisão rejeitada, sem versão pública;
- `disabled`: bloqueio administrativo.

Transições:

```text
draft → pending_review
pending_review → published | rejected
published → changes_pending | paused | disabled
changes_pending → published | paused | disabled
paused → published | changes_pending | disabled
rejected → pending_review
disabled → published | paused (somente admin)
```

Regras:

- `published_revision_id` pode existir em `published`, `changes_pending`, `paused`, `disabled`;
- `draft_revision_id` e `published_revision_id`, quando presentes, são diferentes e pertencem ao
  próprio estúdio;
- estúdio ainda inédito aponta para exatamente um draft; descartar esse draft remove a entidade;
- primeira aprovação é obrigatória;
- rejeitar alteração não remove revisão pública;
- pausa não cancela reservas;
- `paused` preserva os dois ponteiros. Retomar deriva `changes_pending` quando a candidata apontada
  está `pending`; caso contrário deriva `published`, preserva a candidata privada e mantém uma
  candidata `draft` completa disponível para submissão;
- uma candidata só entra em `pending` com tipo, tags e comodidades ainda ativos sob lock transacional;
  arquivamento anterior bloqueia o submit e arquivamento concorrente espera a decisão atômica;
- a timeline editorial usa uma sequência causal monotônica do banco; `occurred_at` descreve o fato,
  mas não decide qual review é o mais recente;
- disabled bloqueia novas ações e exige auditoria.

## 6. Estado de revisão

- `draft`;
- `pending`;
- `approved`;
- `rejected`;
- `superseded`.

Somente draft pode ser editada ou removida; o trigger exige incremento exato de
`revision_version`. Ao enviar, fica imutável. Correção após envio cria nova draft ou admin rejeita com
motivo. Aprovação marca revisão anterior como superseded.

Eventos editoriais são append-only e referenciam estúdio, revisão, ator, tipo e instante. O motivo de
rejeição vive nesse histórico próprio; auditoria continua registrando quem executou a ação, mas não é
fonte da mensagem exibida ao dono. Append-only vale durante a vida do agregado; a exclusão canônica de
um estúdio nunca publicado remove seus filhos por cascade, sem permitir deleção isolada de evento.

## 7. Estado de tentativa/hold

### Tentativa

- `created`;
- `provider_started`;
- `hold_acquired`;
- `payment_pending`;
- `converted`;
- `conflict`;
- `failed`;
- `expired`;
- `cancelled`.

### Hold

- `active`;
- `converted`;
- `expired`;
- `released`.

Um hold ativo possui `expires_at` e allocation ativa. Converter cria reserva e mantém período sem janela livre.

## 8. Estado de pagamento

- `created`;
- `pending`;
- `authorized`;
- `paid`;
- `failed`;
- `expired`;
- `cancelled`;
- `refund_pending`;
- `partially_refunded` (reservado ao provider; domínio não oferece parcial);
- `refunded`;
- `disputed`.

A baseline solicita reembolso total. `partially_refunded` só representa fato externo inesperado e gera alerta.

## 9. Estado de reserva

- `confirmed`;
- `cancel_pending`;
- `cancelled`;
- `in_progress` derivado ou persistido por job quando necessário;
- `completed`;
- `refund_pending`;
- `refunded`;
- `disputed`.

`in_progress` e `completed` podem ser derivados por tempo, mas `completed_at` é persistido quando o job fecha a reserva para liberar repasse.

## 10. Estado de repasse

- `scheduled`;
- `blocked`;
- `processing`;
- `paid`;
- `failed`;
- `cancelled`.

Bloqueios:

- reserva cancelada;
- reembolso;
- disputa;
- recipient não ativo;
- provider indisponível;
- hold administrativo.

## 11. Correção e exclusão

| Objeto                           | Estratégia                                                          |
| -------------------------------- | ------------------------------------------------------------------- |
| Draft de revisão sem dependência | hard delete                                                         |
| Revisão submetida                | imutável; nova revisão                                              |
| Estúdio publicado                | pause/disable; não apagar histórico                                 |
| Janela semanal                   | editar                                                              |
| Exceção futura                   | editar/remover                                                      |
| Bloqueio manual futuro           | editar/remover                                                      |
| Reserva confirmada               | cancelar/compensar                                                  |
| Pagamento                        | evento/reembolso; nunca apagar                                      |
| Repasse                          | evento corretivo                                                    |
| Perfil sem histórico             | exclusão                                                            |
| Perfil com histórico             | anonimização                                                        |
| Mídia não publicada              | remover após cleanup                                                |
| Mídia publicada antiga           | manter enquanto revisão for necessária; depois política de retenção |

## 12. Tempo

- `date`: data civil da disponibilidade/exceção.
- `time`: horários locais de funcionamento.
- `timestamptz`: alocações, reservas, eventos e auditoria.
- conversão local→UTC acontece no comando/read model;
- intervalos são `[start, end)`;
- fim às 18h não conflita com início às 18h;
- slot de 60 minutos;
- fuso do estúdio fixado em `America/Sao_Paulo` nesta versão.

## 13. Dinheiro

- centavos inteiros em todas as transações;
- multiplicadores `numeric(8,4)`;
- percentuais de split em basis points: 8000/2000;
- soma de line items define total;
- provider amount deve igualar snapshot;
- divergência bloqueia confirmação e alerta.

## 14. Privacidade

PII pertence a perfil/provider integration, não a read models públicos. Reserva guarda snapshot mínimo para operação e fiscal. E-mail não deve ser duplicado em tabelas públicas.

## 15. Invariantes centrais

1. no máximo uma allocation ativa sobreposta por estúdio;
2. reserva confirmada possui pagamento pago;
3. pagamento pago converte uma única tentativa;
4. total do pagamento = total da cotação;
5. split soma 100%;
6. owner e studio do snapshot correspondem no momento da confirmação;
7. período confirmado atende duração/slots;
8. revisão pública foi aprovada;
9. estúdio público está publicado;
10. ação administrativa sensível possui audit event;
11. provider event é idempotente;
12. repasse pago não existe para reserva reembolsada.
