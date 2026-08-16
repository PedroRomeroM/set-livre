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

A leitura da conta usa `public.get_my_profile()` como read model `security invoker`, sem argumento de usuário e sempre filtrado por `auth.uid()`. Os comandos privados usam uma projeção interna sem grant runtime para devolver o mesmo estado mascarado; essa projeção não transfere autoridade nem constitui read model.

### 4.2 Dono e recebedor

`owner_profiles.user_id = profiles.id` é a única autoridade canônica de dono; claim ou metadata Auth não concede esse estado. A linha guarda somente status, versão, instante de ativação e a versão vigente de `owner_contract` aceita. Identidade e PII continuam exclusivamente em `profiles`, enquanto cada aceite imutável permanece em `terms_acceptances`.

`owner_payment_recipients.owner_user_id = owner_profiles.user_id` guarda somente status interno, requisitos allowlisted, versão sincronizada do perfil e versão do recebedor. Provider, referência e operações idempotentes ficam em `private.owner_recipient_operations`; o navegador nunca os recebe. A elegibilidade é derivada e falha fechada diante de contrato vencido, dono/recebedor inativo ou drift de perfil.

### 4.3 Estúdio

`studios.owner_user_id` é `not null`. Uma conta pode possuir vários estúdios. Não existe membership nesta versão.

### 4.4 Reserva

`reservations.renter_user_id` identifica o locatário. `reservations.studio_id` e snapshots preservam o dono/estúdio do momento.

### 4.5 Backoffice

Papéis são globais e não alteram ownership. Ação administrativa passa por função específica e auditoria.

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
- primeira aprovação é obrigatória;
- rejeitar alteração não remove revisão pública;
- pausa não cancela reservas;
- disabled bloqueia novas ações e exige auditoria.

## 6. Estado de revisão

- `draft`;
- `pending`;
- `approved`;
- `rejected`;
- `superseded`.

Somente draft pode ser editada. Ao enviar, fica imutável. Correção após envio cria nova draft ou admin rejeita com motivo. Aprovação marca revisão anterior como superseded.

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
