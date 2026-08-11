# Query keys, cache e invalidação

## 1. Query key registry

Um único módulo exporta factories. Nenhuma key literal espalhada.

Famílias:

- `identityQueryKeys.sessions = ["identity", "session"]` é somente o prefixo de invalidação;
- `identityQueryKeys.session(scope) = ["identity", "session", userId | "anonymous"]`;
- `identityQueryKeys.recoveryStatus = ["identity", "recovery", "current-session"]`;
- `public.homeTaxonomies`;
- `public.studioList(filters,cursor)`;
- `public.studioDetail(id,date)`;
- `public.availability(id,range)`;
- `booking.quote(selectionHash)`;
- `account.profile(userId)`;
- `renter.reservations(userId,filters,cursor)`;
- `owner.overview(userId)`;
- `owner.studios(userId,filters,cursor)`;
- `owner.studioEditor(userId,studioId)`;
- `owner.calendar(userId,studioIds,range)`;
- `owner.reservations(...)`;
- `owner.payments(...)`;
- `admin.reviewQueue(...)`;
- `admin.finance(...)`;
- `admin.operations(...)`.

## 2. Scope

- user ID/role scope obrigatório em privado;
- sessão Auth usa o `userId` validado no SSR como escopo concreto; o estado anônimo usa a sentinela `anonymous`, nunca e-mail ou token;
- filtros canonicalizados;
- cursor;
- published revision/version quando relevante;
- environment não entra na key porque caches não cruzam runtime.

## 3. Stale defaults

- taxonomias públicas: 10 min;
- list/detail: 1–5 min com invalidation;
- availability/quote: 0–30 s;
- owner editor: 0;
- calendar: 15 s;
- payment status: polling adaptativo;
- admin queues: 15–30 s.

Medir; não usar Infinity em dado operacional.

## 4. Mutation map

| Command prefix        | Invalida                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `identity.register`   | nenhuma key privada; sucesso aguarda confirmação Auth                                               |
| login/callback        | remove scopes anteriores e publica `identityQueryKeys.session(userId)`; foco da aba revalida        |
| logout                | limpa integralmente o `QueryClient` antes da navegação SSR                                          |
| recovery              | consulta o grant da sessão atual; revalida após update e foco; senha/token/e-mail ficam fora da key |
| `profile.*`           | account/profile, owner overview                                                                     |
| `recipient.*`         | recipient, owner overview, public eligibility                                                       |
| `studio.revision.*`   | editor, owner studios, review queue                                                                 |
| `studio.media.*`      | editor/media                                                                                        |
| `studio.pause/resume` | owner, public list/detail, availability                                                             |
| `admin.studio.*`      | review, owner, public                                                                               |
| `calendar.*`          | owner calendar, public availability, quotes                                                         |
| `pricing.*`           | editor, public detail, quotes                                                                       |
| `addon.*`             | editor, quotes                                                                                      |
| `booking.quote.*`     | quote only                                                                                          |
| `booking.payment.*`   | attempt/payment, availability                                                                       |
| payment webhook       | attempt, reservation, calendar, owner/renter, finance                                               |
| `reservation.cancel`  | reservation, calendar, payment, payout                                                              |
| payout/refund         | finance, owner/renter detail                                                                        |
| taxonomy admin        | public taxonomy/list filters, editors                                                               |
| account deletion      | session/all private                                                                                 |

## 5. UX

- SSR e a primeira hidratação publicam o mesmo boundary sem PII; depois do mount, um efeito sem observer privado remove a família, semeia o `initialData` autoritativo e só então libera o painel;
- cada nova revisão de props RSC faz o boundary voltar imediatamente ao estado fechado, desmonta o observer anterior e repete remove + seed antes de renderizar a mesma identidade ou outro usuário;
- durante refetch por foco, a identidade fica oculta em todo `fetchStatus` não ocioso, inclusive `paused` offline; o payload autoritativo é validado contra o escopo antes de entrar no cache e, se o servidor retornar outro usuário/estado anônimo, o cache privado é limpo e a rota SSR é recarregada;
- authoritative mutation success shown immediately;
- invalidation may run background;
- refetch error does not reverse confirmed mutation;
- optimistic updates only for reversible low-risk visual actions;
- never optimistic payment/reservation;
- calendar drag can preview but reverts until command success.
