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
- logout nas superfícies `/entrar` e `/conta/seguranca` também captura o UUID SSR como `expectedScope`, mas a rota decide exclusivamente pelas claims autoritativas. Depois de `getClaims`, classifica ausência/erro, indisponibilidade e divergência antes de obter explicitamente o cookie store e antes dos efeitos destrutivos explícitos de recovery, deleção de cookies ou `signOut`;
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
| logout                | closure sem `variables`, `networkMode: "always"`; limpa integralmente o `QueryClient`, fecha o boundary e recompõe SSR             |
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
- as duas mutations de logout chamam `mutate()` sem `variables`; a closure one-shot contém somente o `expectedScope` UUID e usa `networkMode: "always"`. `getClaims` pode renovar ou manter a sessão internamente; depois dele, a classificação server-side termina antes de obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw → `SERVICE_UNAVAILABLE`, erro ou contexto assinado ausente → `UNAUTHENTICATED`, UUID válido divergente → `SESSION_CHANGED`. Os três ramos têm zero efeitos destrutivos explícitos de logout. Qualquer desfecho terminal fecha o boundary e recompõe SSR depois de `QueryClient.clear()`;
- a projeção de aparência do login não pertence ao cache interativo: `get_my_profile()` recebe `AbortSignal`, expira no servidor em um segundo e usa `system` como fallback. Resultado tardio não atualiza cookie nem aciona `signOut` após a resposta;
- login com resposta de transporte ambígua reseta e oculta o formulário, limpa integralmente o `QueryClient`, semeia apenas a sessão anônima e força `/entrar?entrada=verificar`; a resposta SSR seguinte é a única autoridade para voltar a mostrar sessão ou credenciais;
- troca de usuário ou divergência descartam primeiro o `MutationCache`, removem conjuntamente as famílias de perfil e sessão e só então fazem hard reload; cache público pode permanecer. Logout e resultado ambíguo de login são exceções deliberadas e limpam o `QueryClient` integralmente;
- os read models de dono usam as keys privadas distintas `owner/private/activation/<userId>` e `owner/private/recipient/<userId>`; usuário e projeção fazem parte da identidade. Ambas usam `staleTime: 0`, refetch autoritativo em mount/foco e `retry: false`; `fetching`, pausa, erro de scope/projeção ou reseed ocultam status, elegibilidade e CTA privados;
- `/dono` e `GET /api/owner/activation` semeiam/refazem somente `activation`, cuja projeção possui o contrato completo. `/dono/recebimentos`, `GET /api/owner/recipient` e `recipient.onboarding.start | refresh` publicam somente `recipient`, sem título, versão textual, hash ou corpo Markdown. Um DTO nunca é aceito na key da outra projeção;
- `owner.activate` e `recipient.onboarding.*` mantêm `{ expectedScope, idempotencyKey }` em closure/ref one-shot, usam `networkMode: "always"`, não fazem optimistic update e só publicam DTO monotônico se a key/scope/projeção esperados ainda existirem;
- `CONFLICT` e `VALIDATION_FAILED` sem `fieldErrors` desabilitam a ação até um GET autoritativo explícito e nunca repetem o POST. `VALIDATION_FAILED` com erro de campo continua no formulário e pode ser corrigido sem forçar releitura. A combinação privada exata `42501 + owner_contract_not_current` vira `409 CONFLICT` para usar esse fence; outros `42501`, inclusive bloqueios, permanecem `403 FORBIDDEN` e não são reclassificados como recuperáveis;
- conflito de estado fecha a ação até uma leitura autoritativa explícita: não há replay automático de POST;\n- alteração de perfil invalida também o status do recebedor, pois pode tornar `profileVersionSynced` divergente. Troca de sessão remove conjuntamente `identity`, `account`, `owner` e `MutationCache`; callback tardio de A nunca recria a key de A sob B;
- authoritative mutation success shown immediately;
- invalidation may run background;
- refetch error does not reverse confirmed mutation;
- optimistic updates only for reversible low-risk visual actions;
- never optimistic payment/reservation;
- calendar drag can preview but reverts until command success.
