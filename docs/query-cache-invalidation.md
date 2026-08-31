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
- `backoffice.users(scope,filterFingerprint)`;
- `backoffice.taxonomies(scope)`;
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
- backoffice usa o UUID da sessão validada como scope; busca entra somente como SHA-256 normalizado,
  nunca e-mail/nome, e cursor pertence às páginas da mesma key.

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

| Command prefix          | Invalida                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `identity.register`     | nenhuma key privada; sucesso aguarda confirmação Auth                                                                              |
| login/callback          | remove scopes anteriores e publica `identityQueryKeys.session(userId)`; foco da aba revalida                                       |
| logout                  | closure sem `variables`, `networkMode: "always"`; limpa integralmente o `QueryClient`, fecha o boundary e recompõe SSR             |
| recovery                | consulta `recoveryStatus(scope)`; remove scopes antigos; senha/token/e-mail/session_id ficam fora                                  |
| `profile.*`             | publica o `account/profile` autoritativo mascarado; limpa mutations/outros scopes privados; invalida owner overview quando existir |
| `recipient.*`           | recipient, owner overview, public eligibility                                                                                      |
| `studio.revision.*`     | editor, owner studios, review queue                                                                                                |
| `studio.media.*`        | editor/media                                                                                                                       |
| `studio.pause/resume`   | owner, public list/detail, availability                                                                                            |
| `admin.studio.*`        | review, owner, public                                                                                                              |
| `backoffice.user.*`     | diretório do scope atual; PII revelada não entra no QueryCache                                                                     |
| `backoffice.access.*`   | diretório do scope atual; remoção de acesso força nova validação da sessão                                                         |
| `backoffice.taxonomy.*` | catálogo administrativo e, quando expostos, catálogos públicos/editores                                                            |
| `calendar.*`            | owner calendar, public availability, quotes                                                                                        |
| `pricing.*`             | editor, public detail, quotes                                                                                                      |
| `addon.*`               | editor, quotes                                                                                                                     |
| `booking.quote.*`       | quote only                                                                                                                         |
| `booking.payment.*`     | attempt/payment, availability                                                                                                      |
| payment webhook         | attempt, reservation, calendar, owner/renter, finance                                                                              |
| `reservation.cancel`    | reservation, calendar, payment, payout                                                                                             |
| payout/refund           | finance, owner/renter detail                                                                                                       |
| taxonomy admin          | public taxonomy/list filters, editors                                                                                              |
| account deletion        | session/all private                                                                                                                |

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
- cadastro, login, pedido de recovery e troca de senha chamam `mutate()` sem credenciais em `variables` e usam `networkMode: "always"`; ausência de rede produz erro terminal e limpeza da ref one-shot, nunca uma mutation pausada capaz de reenviar e-mail ou senha depois da reconexão;
- as duas mutations de logout chamam `mutate()` sem `variables`; a closure one-shot contém somente o `expectedScope` UUID e usa `networkMode: "always"`. `getClaims` pode renovar ou manter a sessão internamente; depois dele, a classificação server-side termina antes de obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw → `SERVICE_UNAVAILABLE`, erro ou contexto assinado ausente → `UNAUTHENTICATED`, UUID válido divergente → `SESSION_CHANGED`. Os três ramos têm zero efeitos destrutivos explícitos de logout. Qualquer desfecho terminal fecha o boundary e recompõe SSR depois de `QueryClient.clear()`;
- a projeção de aparência do login não pertence ao cache interativo: `get_my_profile()` recebe `AbortSignal`, expira no servidor em um segundo e usa `system` como fallback. Resultado tardio não atualiza cookie nem aciona `signOut` após a resposta;
- login com resposta de transporte ambígua reseta e oculta o formulário, limpa integralmente o `QueryClient`, semeia apenas a sessão anônima e força `/entrar?entrada=verificar`; a resposta SSR seguinte é a única autoridade para voltar a mostrar sessão ou credenciais;
- troca de usuário ou divergência descartam primeiro o `MutationCache`, removem conjuntamente as famílias de perfil e sessão e só então fazem hard reload; cache público pode permanecer. Logout e resultado ambíguo de login são exceções deliberadas e limpam o `QueryClient` integralmente;
- os read models de dono usam as keys privadas distintas `owner/private/activation/<userId>` e `owner/private/recipient/<userId>`; usuário e projeção fazem parte da identidade. Ambas usam `staleTime: 0`, refetch autoritativo em mount/foco e `retry: false`; `fetching`, pausa, erro de scope/projeção ou reseed ocultam status, elegibilidade e CTA privados;
- `/dono` e `GET /api/owner/activation` semeiam/refazem somente `activation`, cuja projeção possui o contrato completo. `/dono/recebimentos`, `GET /api/owner/recipient` e `recipient.onboarding.start | refresh` publicam somente `recipient`, sem título, versão textual, hash ou corpo Markdown. Um DTO nunca é aceito na key da outra projeção;
- `owner.activate` e `recipient.onboarding.*` mantêm `{ expectedScope, idempotencyKey }` em closure/ref one-shot, usam `networkMode: "always"`, não fazem optimistic update e só publicam DTO monotônico se a key/scope/projeção esperados ainda existirem;
- `CONFLICT` e `VALIDATION_FAILED` sem `fieldErrors` desabilitam a ação até um GET autoritativo explícito e nunca repetem o POST. `VALIDATION_FAILED` com erro de campo continua no formulário e pode ser corrigido sem forçar releitura. A combinação privada exata `42501 + owner_contract_not_current` vira `409 CONFLICT` para usar esse fence; outros `42501`, inclusive bloqueios, permanecem `403 FORBIDDEN` e não são reclassificados como recuperáveis;
- conflito de estado fecha a ação até uma leitura autoritativa explícita: não há replay automático de POST;
- alteração de perfil invalida também o status do recebedor, pois pode tornar `profileVersionSynced` divergente. Troca de sessão remove conjuntamente `identity`, `account`, `owner` e `MutationCache`; callback tardio de A nunca recria a key de A sob B;
- tipos de estúdio usam a key privada autenticada
  `owner/private/studio-taxonomies/<userId>/types`; tags e comodidades ativas usam
  `owner/private/studio-taxonomies/<userId>/content`; editores usam
  `owner/private/studio-editor/<userId>/<studioId>`. Usuário e estúdio fazem parte da identidade, e o
  logout/troca de sessão remove conjuntamente as famílias `owner/private/studio-editor` e
  `owner/private/studio-taxonomies`;
- o token otimista do editor permanece ligado aos valores visíveis durante refetch em foco; update só
  adota o token remoto após escolha explícita na comparação. Descarte mantém token independente e,
  depois de conflito rejeitado, bloqueia todos os painéis até a releitura e a aceitação explícita do
  editor autoritativo inteiro; só então todos os tokens avançam juntos e uma nova confirmação pode ser
  aberta, sem rebasear silenciosamente um save pendente.
  `STUDIO_TYPE_UNAVAILABLE` limpa a seleção arquivada e refaz a key `types` do usuário atual; erro nessa
  releitura mantém os controles bloqueados e oferece retry somente do GET;
- o editor começa com `initialData` validado e `staleTime: 0`, mas não renderiza nenhum valor privado
  até o GET autoritativo do mesmo usuário/estúdio terminar em `idle` sem erro. Refetch de montagem,
  foco ou conflito volta ao boundary neutro; erro de sessão/acesso limpa o cliente inteiro e recompõe
  SSR. Resultado de mutation só publica sobre uma key já existente do mesmo usuário/estúdio; callback
  tardio depois da limpeza falha fechado e não recria dados privados. Outros estúdios do mesmo dono
  são preservados e scopes de outro usuário são removidos;
- create mantém uma única tentativa `{expectedScope, idempotencyKey, payload}` em ref e só repete a
  mesma chave quando o resultado é ambíguo. Campos e ações concorrentes ficam bloqueados durante esse
  retry. Criação aceita entra em estado terminal e exige navegação explícita para o editor, sem gerar
  uma segunda chave. Update/discard seguem o mesmo contrato. Sucesso de update substitui o editor
  autoritativo. Se o descarte excluir um estúdio inédito, o observer é desabilitado, a key exata é
  cancelada/removida e a rota excluída é substituída pelo novo formulário; se houver publicação, o
  editor aprovado é publicado e a fronteira coordenadora reinicializa somente o painel comercial com
  essa revisão, eliminando valores do draft removido sem apagar edições locais em refetches ordinários;
- conflito otimista de update faz GET do editor, conserva o formulário local e mostra comparação;
  `Usar versão salva` troca os valores sem POST, e `Continuar com minhas alterações` exige novo submit
  com o token recente. Conflito de descarte fecha o diálogo, descarta o comando vencido, relê o editor
  e exige nova confirmação. `OWNER_CONTRACT_CHANGED`, `SESSION_CHANGED`, `UNAUTHENTICATED`,
  `FORBIDDEN`, `ACCOUNT_SUSPENDED` e `NOT_FOUND` recompõem a rota SSR em vez de entrar nessa comparação;
- conflito de taxonomia relê editor e catálogo ativo em paralelo, preserva texto e seleções ainda
  válidas, remove somente IDs arquivados e exige novo submit. Sucesso de core, taxonomia ou conteúdo
  publica o `StudioEditor` autoritativo e propaga seu token aos painéis irmãos sem apagar inputs
  locais; refetch ordinário não participa desse handoff. Retry existe apenas para a mesma tentativa
  idempotente ambígua;
- no backoffice, login/reautenticação mantêm e-mail/senha somente em refs efêmeras e chamam
  `mutate()` sem variables; qualquer desfecho limpa os inputs. Login ambíguo limpa o QueryClient e
  recompõe `/` para que a sessão server-side decida o estado;
- diretório usa uma única unidade `{query,fingerprint}` para impedir que o texto de uma busca seja
  executado sob a key de outra. Páginas mantêm keyset/cursor no mesmo scope e nunca colocam o filtro
  na URL;
- comandos administrativos não fazem optimistic update. Uma resposta ambígua preserva comando,
  payload e `idempotencyKey`, bloqueia edição incompatível e oferece repetição da mesma tentativa;
  resposta conclusiva descarta a tentativa e invalida o read model. PII usa apenas estado React
  efêmero, expira em 60 segundos/aba oculta e a MutationCache recebe somente o marcador redigido;
- authoritative mutation success shown immediately;
- invalidation may run background;
- refetch error does not reverse confirmed mutation;
- optimistic updates only for reversible low-risk visual actions;
- never optimistic payment/reservation;
- calendar drag can preview but reverts until command success.
