# Calendário, disponibilidade, cotação e reserva

## 1. Objetivo

Garantir disponibilidade correta, preço explicável e no máximo uma reserva confirmada por estúdio/período, mesmo com:

- duas abas;
- dois usuários;
- retries;
- webhook duplicado;
- timeout;
- hold expirado;
- buffer;
- importação iCal.

## 2. Unidade e fuso

- Slot comercial: 60 minutos.
- Início e fim: hora cheia local.
- Intervalo: `[start, end)`.
- Fuso: `America/Sao_Paulo`.
- Duração: inteiro de horas.
- Buffer: inteiro de horas, 0–4.
- Horizonte: 365 dias.
- UTC no banco.

## 3. Disponibilidade derivada

Um slot é disponível quando:

1. estúdio está publicado e `reservations_enabled`;
2. a data não é fechada por exceção;
3. o horário está dentro de janela efetiva;
4. todo o período real cabe na janela;
5. duração respeita min/max;
6. período bloqueado com buffer não cruza allocation ativa;
7. não está no passado;
8. não excede horizonte;
9. recebedor/operacional não bloqueia novas reservas.

### 3.1 Regra efetiva do dia

- Se existe exceção `closed`: nenhuma janela.
- Se existe exceção `custom_windows`: usar janelas da exceção.
- Senão: usar janelas semanais do weekday local.

## 4. Alocação

```text
actual_period  = período comprado/bloqueio real
blocked_period = actual expandido por buffer
```

Exemplo:

- reserva 14h–16h;
- buffer antes 1h;
- buffer depois 1h;
- bloqueado 13h–17h.

A UI mostra reserva 14h–16h e indica buffer sem revelar dados privados.

## 5. Tipos

### 5.1 Manual

Criado pelo dono. Pode ter label interna. Editável/removível se futuro e não convertido em fato.

### 5.2 iCal

Importado manualmente. Read-only na agenda; remoção por batch. Não contém dados sensíveis públicos.

### 5.3 Hold

Tem expiração. Ocupa calendário temporariamente. Não é reserva.

### 5.4 Reserva

Allocation ativa vinculada a reserva confirmada/ciclo posterior. Cancelamento libera.

## 6. Constraint de conflito

Usar `btree_gist` e exclusion constraint sobre `blocked_period` quando status ativo.

Comando de inserção:

1. obter advisory lock por `studio_id`;
2. atualizar holds vencidos para expired/released;
3. validar regra efetiva;
4. inserir allocation;
5. tratar violation como `SLOT_UNAVAILABLE`.

A constraint, não o advisory lock, garante invariável.

## 7. Configuração semanal

UI:

- sete dias;
- abrir/fechar dia;
- múltiplas janelas;
- selects de hora;
- copiar para outros dias;
- erro de overlap;
- preview.

Comando `calendar.weekly.replace` substitui todas as janelas do estúdio em transação, com version token.

Alterar disponibilidade não cancela reserva existente. UI mostra conflito histórico e impede esconder reserva.

## 8. Exceções

Tipos:

- fechado;
- horário especial.

Regras:

- uma exceção por data;
- janelas sem overlap;
- data futura ou hoje com cuidado;
- não remover reservation allocation;
- se nova exceção conflita com reserva, comando falha e retorna IDs/horários seguros para resolução; não revela locatário em mensagem genérica.

## 9. Bloqueio manual

Campos:

- data;
- início;
- fim;
- motivo/label opcional;
- recorrência não entra.

Drag-and-drop em calendário chama `calendar.block.update` com:

- allocation ID;
- novo período;
- expectedUpdatedAt.

O servidor revalida tudo. UI faz optimistic preview, mas reverte em conflito.

## 10. Calendário avançado

### 10.1 Views

- mês: densidade/contagens e navegação;
- semana: grade horária operacional;
- dia: detalhe;
- timezone visível;
- today;
- próxima/anterior;
- filtros por estúdio na agenda consolidada.

### 10.2 Cores/semântica

Não depender só de cor. Cada tipo tem label, ícone/padrão e texto acessível.

- reserva;
- hold;
- manual;
- iCal;
- conflito/atenção;
- buffer.

### 10.3 Ações

- abrir detalhe;
- criar bloqueio em espaço vazio;
- mover/redimensionar manual;
- excluir manual;
- remover batch iCal;
- reserva read-only com link operacional.

## 11. iCal

### 11.1 Importação

- `.ics` máximo 2 MB;
- parse server-side;
- rejeitar conteúdo inválido;
- intervalo aceito: 30 dias passados a 365 futuros;
- converter TZID/UTC;
- eventos sem fim recebem erro;
- recorrências devem ser expandidas apenas dentro da janela;
- limite de 2.000 ocorrências por arquivo;
- sanitizar summary;
- hash do arquivo;
- preview de total/conflitos;
- confirmação cria batch e allocations;
- eventos conflitantes com reserva são ignorados/reportados, nunca sobrescritos.

### 11.2 Exportação

- arquivo manual;
- intervalo até 365 dias;
- incluir disponibilidade bloqueada e reservas com título genérico;
- não incluir PII do locatário;
- UID estável;
- timezone correto;
- endpoint autenticado e ownership.

## 12. Agenda consolidada

Dono com vários estúdios escolhe:

- todos;
- um ou mais.

Read model pagina por janela temporal, não retorna histórico inteiro. Cada evento inclui studio name seguro.

## 13. Cotação

### 13.1 Entrada

- studio;
- date;
- start hour;
- duration;
- guest count;
- add-ons;
- notes.

### 13.2 Validação

- publicação/estado;
- capacidade;
- disponibilidade;
- duração;
- add-ons ativos/quantidade;
- preço atual;
- horizonte.

### 13.3 Cálculo

Para cada hora:

1. converter para local;
2. weekday multiplier;
3. time band multiplier;
4. `round(base × day × band)`;
5. criar line item.

Add-ons por unidade. Soma exata.

### 13.4 Snapshot e TTL

Persistir quote por 5 minutos. Quote não segura horário. No início do pagamento:

- recalcular disponibilidade;
- recalcular preço;
- se mudou, retornar nova quote e exigir confirmação;
- não cobrar valor diferente silenciosamente.

## 14. Rascunho anônimo e autenticação

Schema versionado em `sessionStorage`:

```ts
type BookingDraftV1 = {
  version: 1;
  studioId: string;
  date: string;
  startLocal: string;
  durationHours: number;
  guestCount: number;
  addons: { id: string; quantity: number }[];
  notes: string;
  savedAt: string;
};
```

TTL: 2 horas. Não guardar preço como autoritativo. Após login, revalidar.

## 15. Início do pagamento

Orquestração:

1. validar sessão e quote;
2. usar idempotency key;
3. criar attempt;
4. chamar provider para iniciar método;
5. persistir payment;
6. provider confirmou início;
7. adquirir hold em transação;
8. se hold falha:
   - marcar attempt conflict;
   - cancelar/expirar provider quando possível;
   - não exibir QR/cartão como válido;
9. retornar dados de checkout.

Não adquirir hold antes da confirmação do provider, conforme regra de produto.

## 16. Expiração

Job a cada minuto:

- claim holds vencidos;
- verificar provider se estado ambíguo;
- se não pago, expirar/release allocation;
- marcar attempt/payment;
- invalidar disponibilidade;
- não enviar e-mail de falha desnecessário.

Se webhook pago chega simultaneamente, lock e estados garantem uma única resolução. Pagamento pago após perda do hold é incidente: iniciar reembolso automático e alerta; nunca criar dupla reserva.

## 17. Confirmação

Transação `private.confirm_paid_booking`:

1. idempotência por payment/provider event;
2. lock attempt/hold/payment;
3. validar amount/currency;
4. validar hold ativo e allocation;
5. criar reservation;
6. transformar allocation kind/reservation ou vincular;
7. status payment paid;
8. attempt converted;
9. criar status event;
10. criar payout scheduled;
11. inserir e-mails no outbox;
12. retornar reservation ID.

## 18. Cancelamento

Locatário pode cancelar antes de `start_at`.

Transação:

1. lock reservation/payment/payout;
2. validar estado;
3. status cancel_pending/refund_pending;
4. bloquear payout;
5. chamar provider fora ou via saga controlada;
6. após confirmação de refund:
   - status cancelled/refunded;
   - release allocation;
   - e-mails;
7. falha mantém estado pendente e alerta.

Para evitar transação aberta durante rede, use estado intermediário e idempotency key.

## 19. Conflitos a testar

- dois usuários mesmo slot;
- mesma pessoa duplo clique;
- duas abas;
- quote expira;
- preço muda;
- hold expira no instante do webhook;
- webhook duplicado;
- webhook fora de ordem;
- provider paid após hold perdido;
- buffer cria overlap invisível;
- exceção criada sobre reserva;
- iCal sobre reserva;
- DST/timezone;
- cancelamento simultâneo a payout.
