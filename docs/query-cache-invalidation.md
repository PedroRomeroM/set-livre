# Query keys, cache e invalidação

## 1. Query key registry

Um único módulo exporta factories. Nenhuma key literal espalhada.

Famílias:

- `identityQueryKeys.sessions = ["identity", "session"]` é somente o prefixo de invalidação;
- `identityQueryKeys.session(scope) = ["identity", "session", userId | "anonymous"]`;
- `identityQueryKeys.recoveryStatuses = ["identity", "recovery", "status"]` é o prefixo de invalidação;
- `identityQueryKeys.recoveryStatus(scope) = ["identity", "recovery", "status", UUID | "anonymous"]`;
- `accountQueryKeys.profiles = ["account", "profile"]` é somente o prefixo de invalidação;
- `accountQueryKeys.profile(userId) = ["account", "profile", userId]`;
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
- recovery usa o UUID opaco lido pelo Server Component do marcador `HttpOnly`, ou `anonymous` quando ele não existe/é inválido. Esse UUID é deliberadamente público para a UI e serve somente para separar cache: não é user ID, grant, token, `session_id` nem autoridade;
- a resposta de status precisa repetir o scope esperado e é rejeitada antes de entrar no cache quando houver divergência;
- o perfil próprio repete `scope=userId`; o normalizer rejeita divergência antes da escrita no QueryCache e a key nunca contém e-mail, nome, telefone ou documento;
- `profile.complete` e `profile.update` repetem esse recorte como `expectedScope` UUID no envelope do comando. O valor é uma asserção client-side do SSR, não autoridade: o servidor sempre decide pelo `session.userId` e responde `409 SESSION_CHANGED` quando ambos divergem;
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

| Command prefix        | Invalida                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `identity.register`   | nenhuma key privada; sucesso aguarda confirmação Auth                                                                              |
| login/callback        | remove scopes anteriores e publica `identityQueryKeys.session(userId)`; foco da aba revalida                                       |
| logout                | limpa integralmente o `QueryClient` antes da navegação SSR                                                                         |
| recovery              | consulta `recoveryStatus(scope)`; remove scopes antigos; senha/token/e-mail/session_id ficam fora                                  |
| `profile.*`           | publica o `account/profile` autoritativo mascarado; limpa mutations/outros scopes privados; invalida owner overview quando existir |
| `recipient.*`         | recipient, owner overview, public eligibility                                                                                      |
| `studio.revision.*`   | editor, owner studios, review queue                                                                                                |
| `studio.media.*`      | editor/media                                                                                                                       |
| `studio.pause/resume` | owner, public list/detail, availability                                                                                            |
| `admin.studio.*`      | review, owner, public                                                                                                              |
| `calendar.*`          | owner calendar, public availability, quotes                                                                                        |
| `pricing.*`           | editor, public detail, quotes                                                                                                      |
| `addon.*`             | editor, quotes                                                                                                                     |
| `booking.quote.*`     | quote only                                                                                                                         |
| `booking.payment.*`   | attempt/payment, availability                                                                                                      |
| payment webhook       | attempt, reservation, calendar, owner/renter, finance                                                                              |
| `reservation.cancel`  | reservation, calendar, payment, payout                                                                                             |
| payout/refund         | finance, owner/renter detail                                                                                                       |
| taxonomy admin        | public taxonomy/list filters, editors                                                                                              |
| account deletion      | session/all private                                                                                                                |

## 5. UX

- SSR e a primeira hidratação publicam o mesmo boundary sem PII; depois do mount, um efeito sem observer privado remove a família, semeia o `initialData` autoritativo e só então libera o painel;
- cada nova revisão de props RSC faz o boundary voltar imediatamente ao estado fechado, desmonta o observer anterior e repete remove + seed antes de renderizar a mesma identidade ou outro usuário;
- durante refetch por foco, a identidade fica oculta em todo `fetchStatus` não ocioso, inclusive `paused` offline; o payload autoritativo é validado contra o escopo antes de entrar no cache e, se o servidor retornar outro usuário/estado anônimo, o cache privado é limpo e a rota SSR é recarregada;
- o formulário de nova senha só monta quando recovery retorna `allowed=true`, o scope corresponde ao recorte SSR e `fetchStatus="idle"`; `fetching` e `paused` mantêm a mensagem de verificação sem reutilizar autorização cacheada;
- feedback retryable da troca de senha pertence ao boundary externo, não à mutation que o refetch desmonta. Ele conserva somente copy pública, scope UUID público e erros allowlisted, reaparece depois da mesma autorização idle e é descartado em nova tentativa, sucesso, negação ou troca de scope;
- divergência de scope em recovery remove as famílias `recoveryStatuses` e `sessions` e recompõe `/recuperar-senha` no servidor; consumir a senha marca somente a key do scope atual como negada antes de descartar sessão privada em memória;
- `/conta` usa o mesmo boundary externo sem observer: o reseed autoritativo limpa `MutationCache` e as famílias `account/profile` + `identity/session`, preserva queries públicas, semeia o `initialData` SSR validado e somente então monta o observer privado. `/entrar` e `/conta/seguranca` repetem a limpeza privada antes de semear a sessão. `fetching`, `paused`, erro de scope ou revisão RSC ocultam o painel inteiro;
- `profile.complete` e `profile.update` mantêm `{ expectedScope, payload }` somente em refs one-shot e chamam `mutate()` sem variables. As três mutations usam `networkMode: "always"`, portanto uma submissão offline executa/falha e nunca fica pausada para retomar em outra sessão. Qualquer desfecho remoto apaga a ref e os inputs sensíveis;
- `SESSION_CHANGED` e `UNAUTHENTICATED` são transições terminais: fecham o boundary/DOM, limpam `MutationCache` e conjuntamente `account/profile` + `identity/session`, então fazem hard reload para nova composição SSR;
- sucesso valida o scope e só publica o DTO mascarado se `profileVersion` e `preferencesVersion` não regredirem. A publicação limpa mutations e scopes privados incompatíveis, mas preserva a Query de perfil atual para não destacar seu observer antes de sobrescrever o resultado autoritativo. Se um reseed B já removeu a key de A, o callback tardio de A é rejeitado e não a recria; resposta apenas regressiva dispara refetch autoritativo. O snapshot aceito sincroniza somente `profileCompleted`, `personType` e `status` da sessão;
- aparência possui `preferencesVersion` independente. Somente o snapshot monotônico aceito atualiza a key e o atributo allowlisted do documento; o cookie `HttpOnly` é projeção HTTP, não cache nem autoridade;
- logout limpa integralmente o `QueryClient` antes da navegação SSR, inclusive quando a resposta é incerta;
- login com resposta de transporte ambígua reseta e oculta o formulário, limpa integralmente o `QueryClient`, semeia apenas a sessão anônima e força `/entrar?entrada=verificar`; a resposta SSR seguinte é a única autoridade para voltar a mostrar sessão ou credenciais;
- troca de usuário ou divergência descartam primeiro o `MutationCache`, removem conjuntamente as famílias de perfil e sessão e só então fazem hard reload; cache público pode permanecer. Logout e resultado ambíguo de login são exceções deliberadas e limpam o `QueryClient` integralmente;
- authoritative mutation success shown immediately;
- invalidation may run background;
- refetch error does not reverse confirmed mutation;
- optimistic updates only for reversible low-risk visual actions;
- never optimistic payment/reservation;
- calendar drag can preview but reverts until command success.
