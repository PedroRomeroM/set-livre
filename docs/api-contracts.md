# Contratos de leitura, comandos e integrações

## 1. Princípios

- rotas representam intenções;
- comandos críticos autenticados entram por `POST /api/commands`; Auth convidada usa endpoint especializado e fechado;
- action names são estáveis e versionadas por contrato;
- payload é Zod `strict`;
- resposta nunca vaza provider/SQL;
- read models retornam DTOs explícitos;
- IDs de provider são privados;
- toda ação declara autorização, idempotência, transação, eventos e invalidação.

## 2. Envelope de comando

```ts
type BaseCommandEnvelope<TAction extends CommandAction> = {
  action: TAction;
  payload: unknown;
  idempotencyKey?: string;
};

type ProfileCommandEnvelope = BaseCommandEnvelope<"profile.complete" | "profile.update"> & {
  expectedScope: string;
};

type GuestRegistrationEnvelope = BaseCommandEnvelope<"identity.register"> & {
  expectedScope?: never;
};

type LogoutRequest = {
  expectedScope: string;
};
```

Outras actions privadas acrescentam somente as asserções específicas que seu contrato exigir. No
registry implementado, `expectedScope` pertence aos dois comandos de perfil, aos três comandos de
dono/recebedor e aos treze comandos de estúdio; os dezesseis últimos também exigem `idempotencyKey`. A rota
Auth especializada de logout recebe `expectedScope` em seu schema próprio. A asserção é sempre UUID
estrito, nunca ownership, e não vira campo genérico aceito silenciosamente por outros envelopes.

Headers:

- `Content-Type: application/json`;
- `X-Request-Id` opcional, validado;
- cookie de sessão;
- `Origin` confiável;
- `Idempotency-Key` pode ser header ou envelope, mas uma política única deve ser escolhida no código;
  os comandos FEAT-004, FEAT-006 e FEAT-007 usam exclusivamente `idempotencyKey` no envelope.

`X-Request-Id`/`requestId` identifica a request HTTP e nunca substitui `idempotencyKey`. A chave de idempotência identifica a tentativa lógica repetível e pode atravessar retries com novos request IDs; ela não é copiada para o campo público de correlação.

Limite padrão planejado: 128 KiB. A superfície Auth já implementada na FEAT-002 usa o limite mais
restritivo de 16 KiB. `/api/commands` usa 384 KiB: o teto é derivado do envelope estrito com até vinte
FAQs, respostas de 2.000 caracteres e regras de 5.000 caracteres, incluindo a expansão máxima da
serialização JSON/UTF-8. Assim, todo payload válido cabe sem tornar a rota ilimitada; todo limite consome o stream
independentemente de `Content-Length`.

### 2.1 Superfície implementada na FEAT-002

- `identity.register` entra exclusivamente por `POST /api/auth/register`; a rota pública aceita apenas esse envelope estrito e conserva origem, fachada, limite de stream, limiter específico e DAL. `POST /api/commands` é privado: depois da origem exata, valida a sessão autoritativa antes de consumir a fachada ou ler o body; aceita apenas os comandos registrados, e action desconhecida ou pertencente a feature futura é rejeitada pelo schema fechado;
- todos os `POST` exigem `Origin` e `Host` exatos de `NEXT_PUBLIC_APP_URL`; em produção, `X-Forwarded-Host` e `X-Forwarded-Proto=https` também precisam ter sido sobrescritos pela borda confiável;
- um bucket de fachada é consumido antes do parse/Zod; depois do parse, cadastro/login/recovery/callback usam somente hashes de e-mail, usuário ou token. Em produção, a fachada exige um único IP canônico em `X-Forwarded-For`, sobrescrito pelo Nginx da borda confiável descrito em `infrastructure.md`; header ausente, composto ou inválido falha fechado;
- somente `application/json` e schemas Zod `strict` são aceitos;
- sucesso e erro usam envelope JSON com `requestId`, `private, no-store` e sem payload de provider, SQL ou PII;
- o pedido de recovery responde sempre `202` com o mesmo corpo, inclusive quando o provider rejeita ou está indisponível; somente o evento redigido marca a degradação, sem permitir inferir se o e-mail existe;
- o cliente interrompe qualquer request de identidade após dez segundos e retorna estado recuperável sem preservar payload sensível;
- cadastro, login e as duas mutations de recovery usam `networkMode: "always"`: uma submissão dispara uma única tentativa mesmo quando o monitor de conectividade está offline, termina como erro seguro e limpa a referência efêmera; ela nunca fica pausada para reenviar credenciais após reconexão;
- login, logout, callback, recovery e sessão usam clientes Supabase server-side por request; senha, token, cookie e o `session_id` assinado nunca entram no cache TanStack;
- o callback aceita apenas `signup` ou `recovery`; o `TokenHash` chega ao browser no fragmento, é apagado antes do `POST` e não aparece na request inicial nem no referrer;
- somente um `SERVICE_UNAVAILABLE` recebido em resposta API válida antes de `verifyOtp` permite retry do callback. Depois que o `POST` de signup ou recovery foi despachado, falha de rede, timeout e resposta inválida são ambíguos e terminais no cliente, que apaga sua ref one-shot sem reenviar o token;
- erro desconhecido, throw, sessão incompleta ou falha posterior ao início de `verifyOtp` retornam `AUTH_RESTART_REQUIRED` no signup e `RECOVERY_RESTART_REQUIRED` no recovery, limpam somente a sessão/cookies Auth conhecidos e exigem novo link sem afirmar o estado da conta; rejeição explícita de OTP inválido/expirado preserva sua classificação segura;
- o callback de recovery valida `sub`, `session_id` e `exp` do JWT assinado contra `auth.sessions` antes de emitir atomicamente a binding/tombstone e o grant de 15 minutos. O UUID público `session_scope` é somente um marcador opaco de UI/cache; ele não autoriza nenhuma operação;
- a troca de senha reserva o grant e a binding correspondentes no banco antes do provedor; somente rejeições explícitas sem efeito liberam retry, enquanto resultado ambíguo encerra a autorização e exige novo link;
- uma rejeição pública retryable da troca de senha permanece fora da mutation desmontável como `{ message, fieldErrors, scope }`, com campos limitados a `password | confirmPassword` e o mesmo scope UUID público já usado pela query; o refetch do status não a apaga se esse scope continuar autorizado e o próximo submit sempre a descarta antes de reler o `FormData`;
- publicação parcial no login e descarte da sessão pós-recovery apagam exatamente o cookie Supabase Auth base e seus chunks numéricos observados, preservando cookies de prefixo semelhante e cookies alheios mesmo quando `signOut` ou uma deleção falha. Recovery final só conclui após `signOut` ou prova local de ausência; estado presente/ambíguo falha fechado depois do fallback exato;
- depois que `setSession` começa, qualquer erro/throw de publicação retorna `AUTH_SESSION_RECHECK_REQUIRED`, inclusive se o cleanup exato também falhar; o cliente trata esse código como desfecho ambíguo, apaga controles/refs/cache e força `/entrar?entrada=verificar` para leitura SSR. Falha de rede, timeout ou envelope inválido depois do `POST` segue a mesma transição. O parâmetro é aceito somente por igualdade literal e não carrega identidade ou credencial;
- uma sessão Auth vinculada a recovery nunca é publicada como login comum. Expiração/consumo do grant, binding fechada, marcador ausente/divergente ou navegação fora das superfícies autorizadas fecham a binding, removem o grant e encerram a sessão local; a tombstone persiste para classificar replay pelo `session_id` mesmo sem cookies auxiliares;
- `GET /api/auth/recovery/status` retorna `{ allowed, scope }`: `allowed=true` exige o UUID correspondente, enquanto uma autorização inválida é encerrada e responde `scope="anonymous"`. O cliente pode marcar o UUID atual como negado somente depois de uma atualização de senha confirmada. O scope precisa coincidir com o recorte SSR antes de entrar no cache; ele não contém token, e-mail, user ID nem prova de autorização;
- nas superfícies autenticadas de `/entrar` e `/conta/seguranca`, logout usa uma closure one-shot sem `variables`, `networkMode: "always"` e `expectedScope` UUID como asserção do recorte SSR. O servidor executa `getClaims`, que pode renovar ou manter a sessão internamente, e termina a classificação antes de obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw retorna `503 SERVICE_UNAVAILABLE`, `claimsResult.error` ou contexto assinado ausente retorna `401 UNAUTHENTICATED`, e somente um `userId` válido divergente retorna `409 SESSION_CHANGED`; os três ramos têm zero efeitos destrutivos explícitos de logout. Um erro posterior do provider só pode equivaler a logout concluído quando o cliente server-side comprova ausência da sessão local;
- depois de `setSession`, a projeção de preferência chama `get_my_profile()` com o `AbortSignal` da operação e deadline server-side de um segundo. Timeout ou falha usa `system`; uma resolução tardia é ignorada e não pode publicar cookie nem iniciar `signOut` depois da resposta;
- o destino autenticado possui allowlist canônica: `/entrar?sessao=ativa`, `/conta`, `/conta/seguranca`, `/dono`, `/dono/recebimentos`, `/dono/estudios/novo` e `/dono/estudios/<studioId>/{dados|midia|publicacao}`, sendo `studioId` um UUID minúsculo válido e o único segmento variável. A rota dinâmica normaliza uma representação UUID válida não canônica para o path minúsculo antes de produzir o retorno de login. A query usa `retorno`; somente depois da validação o componente envia o campo interno `returnTo` no payload efêmero de login. Sucesso preserva exatamente o destino aprovado. Falha de rede, timeout, envelope inválido ou `AUTH_SESSION_RECHECK_REQUIRED` depois do início de `setSession` preserva o mesmo destino na URL de verificação SSR; URL absoluta, protocol-relative, query/fragmento extra, path traversal, barra invertida, UUID inválido, valor codificado ou array falha fechado para o destino padrão.

## 3. Códigos de erro

| Código                          | HTTP | Uso                                           |
| ------------------------------- | ---: | --------------------------------------------- |
| `AUTH_REQUIRED`                 |  401 | sem sessão                                    |
| `AUTH_RESTART_REQUIRED`         |  503 | signup OTP ambíguo                            |
| `AUTH_SESSION_RECHECK_REQUIRED` |  503 | publicação de login ambígua                   |
| `FORBIDDEN`                     |  403 | papel/ownership                               |
| `ACCOUNT_SUSPENDED`             |  403 | conta suspensa                                |
| `VALIDATION_FAILED`             |  422 | campos; sem `fieldErrors`, exige releitura    |
| `NOT_FOUND`                     |  404 | recurso não visível                           |
| `CONFLICT`                      |  409 | estado concorrente ou contrato superado       |
| `STUDIO_SUBMISSION_INCOMPLETE`  |  422 | checklist editorial incompleto                |
| `STUDIO_TAXONOMY_UNAVAILABLE`   |  409 | tag/comodidade arquivada durante a gravação   |
| `STUDIO_TYPE_UNAVAILABLE`       |  409 | tipo arquivado durante criação ou edição      |
| `SLOT_UNAVAILABLE`              |  409 | calendário                                    |
| `QUOTE_EXPIRED`                 |  409 | cotação                                       |
| `PAYMENT_PROVIDER_UNAVAILABLE`  |  503 | integração                                    |
| `PAYMENT_NOT_STARTED`           |  409 | provider não confirmou                        |
| `PAYMENT_MISMATCH`              |  409 | valor/moeda                                   |
| `RATE_LIMITED`                  |  429 | abuso                                         |
| `PAYLOAD_TOO_LARGE`             |  413 | limite                                        |
| `RECOVERY_INVALID`              |  403 | recovery inválido/expirado                    |
| `RECOVERY_RESTART_REQUIRED`     |  503 | OTP ambíguo ou consumido                      |
| `SERVICE_UNAVAILABLE`           |  503 | claims/provider indisponíveis                 |
| `SESSION_CHANGED`               |  409 | UUID SSR diverge do usuário válido nas claims |
| `UNAUTHENTICATED`               |  401 | sessão privada ausente/expirada               |
| `INTERNAL_ERROR`                |  500 | inesperado com requestId                      |

Mensagens de usuário são traduzidas por código. Não usar mensagem SQL.

## 4. Registry

```ts
const commandHandlers = {
  "profile.update": updateProfile,
  "owner.activate": activateOwner,
  "studio.create": createStudio,
  // ...
} satisfies Record<CommandAction, CommandHandler>;
```

Registry não contém lógica de domínio. Cada handler vive no domínio.

## 5. Catálogo de comandos

### 5.1 Perfil e conta

| Action                     | Autorização                                                  | Efeito                                                                                                         |
| -------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `identity.register`        | visitante com origem confiável via `POST /api/auth/register` | cria intenção jurídica opaca e inicia signup Auth; perfil mínimo e dois aceites nascem atomicamente no trigger |
| `profile.complete`         | authenticated                                                | completa o perfil mínimo já criado no cadastro, sem reescrever os aceites jurídicos                            |
| `profile.update`           | titular da própria linha                                     | altera somente identidade editável ou preferência visual allowlisted                                           |
| `account.export.request`   | owner                                                        | agenda exportação                                                                                              |
| `account.deletion.request` | owner                                                        | inicia exclusão/análise                                                                                        |
| `account.deletion.cancel`  | owner                                                        | cancela se ainda possível                                                                                      |

Campos de CPF/CNPJ nunca são aceitos como ownership. CPF é normalizado em onze dígitos; CNPJ aceita a forma numérica legada e a forma alfanumérica oficial de quatorze posições, com doze caracteres maiúsculos seguidos por dois dígitos verificadores.

Na FEAT-003, os envelopes Zod estritos de `profile.complete` e `profile.update` exigem `expectedScope` UUID no nível superior. Esse valor repete apenas o usuário do recorte SSR que originou o formulário; é uma asserção do cliente, nunca ownership ou substituto da sessão. Depois das validações globais de origem e fachada, a rota privada autentica a sessão antes de consumir o corpo; então o registry compara `expectedScope` com o `session.userId` autoritativo. Divergência retorna `409 SESSION_CHANGED` antes do limiter específico de perfil, serviço e DAL. Envelope sem a asserção, com UUID inválido ou campo extra retorna `422 VALIDATION_FAILED` e também não alcança o serviço.

### 5.2 Dono/recebedor

| Action                         | Efeito                                                  |
| ------------------------------ | ------------------------------------------------------- |
| `owner.activate`               | cria owner profile e aceite vigente de forma atômica    |
| `recipient.onboarding.start`   | inicia operação idempotente quando a capability permite |
| `recipient.onboarding.refresh` | consulta/aplica snapshot quando a capability permite    |

Os três envelopes Zod estritos exigem `expectedScope` e `idempotencyKey` UUID, sem `ownerUserId`, status, provider, capability ou referência externa fornecidos pelo cliente. `recipient.bank.update` permanece ausente até existir token ou handoff provider-owned aprovado. A tuple SQL de ativação conserva 21 colunas porque a superfície precisa do documento jurídico completo; a tuple de recebimentos conserva 16, apenas com referência mínima do contrato (`id`, `source`, `effectiveAt`), status seguros, requisitos, próxima ação, versões monotônicas e `reservationsEligible`. Título, versão textual, hash e corpo Markdown não atravessam o contrato compacto. Nenhuma das respostas contém PII, provider ID ou payload bruto.

Depois de normalizar a tuple, o servidor acrescenta ao estado comum o campo obrigatório `recipientOnboardingCapability: "local_adapter" | "unavailable"`. As projeções `activation` e `recipient`, assim como os retornos de `owner.activate`, `recipient.onboarding.start` e `recipient.onboarding.refresh`, carregam esse campo. Ele é derivado a cada request: `APP_ENV=local | test` produz `local_adapter`; `development | production`, valor ausente ou inválido produzem `unavailable`. A capability não é aceita do navegador, não é coluna do banco e não altera `providerMode`, `nextAction` ou o estado canônico.

Somente a projeção `activation` exige ainda `ownerActivationCapability: "available" | "unavailable"`; por consequência, `GET /api/owner/activation` e o retorno de sucesso de `owner.activate` carregam o campo, enquanto a projeção compacta e os retornos de `recipient.onboarding.start | refresh` não o aceitam. A fonte `approved` produz `available` em qualquer `APP_ENV`. Para `local_fixture`, somente `local | test` produz `available`; `development | production`, ausência ou valor inválido produzem `unavailable`. A derivação ocorre no servidor, não é persistida e não altera a fonte jurídica ou `nextAction`.

Nos três comandos, a rota encaminha o `requestId` da API fora do payload de domínio. Na ativação, o DAL envia correlação e chave lógica como parâmetros SQL distintos; no onboarding do recebedor, `prepare` reserva a `idempotencyKey` e `apply` recebe o `requestId`, recuperando a chave da operação reservada. Fatos novos em `audit.events` usam `request_id` somente para correlação e `idempotency_key` somente para unicidade/replay. Repetir a mesma chave lógica em outra request não cria outro fato nem troca a correlação do efeito original.

As duas leituras autenticadas aplicam no servidor um deadline de 2.000 ms e usam contratos distintos:

- `/dono` e `GET /api/owner/activation` chamam `get_owner_activation_status()` e retornam a projeção completa `activation` de 21 colunas;
- `/dono/recebimentos` e `GET /api/owner/recipient` chamam `get_owner_recipient_status()` e retornam a projeção compacta `recipient` de 16 colunas, sem título, versão textual, hash ou corpo do contrato.

Cada read model encaminha um `AbortSignal` real à RPC e usa race independente para encerrar no prazo mesmo se o transporte não cooperar; o timer é limpo em sucesso/erro, e resolução ou rejeição tardia não publica estado. Um signal externo também encerra a operação. Os GETs traduzem indisponibilidade para `503` seguro, e as rotas SSR permanecem sob seu estado de erro e recuperação, sem fallback factual inventado.

Quando `recipientOnboardingCapability="unavailable"`, os GETs continuam retornando o estado factual somente para consulta. `recipient.onboarding.start | refresh` retornam `503 PAYMENT_PROVIDER_UNAVAILABLE` antes de chamar `prepare`; portanto não reservam operação, não chamam adapter e não produzem mutação parcial.

Quando `ownerActivationCapability="unavailable"`, a leitura de ativação continua retornando o contrato completo e os fatos para consulta. `owner.activate` responde `503 SERVICE_UNAVAILABLE` com a mensagem pública já definida antes de chamar `activateOwnerProfile` ou produzir aceite, autoridade ou auditoria. Essa recusa pode ocorrer depois da leitura server-side necessária para classificar a fonte; ela não deve ser descrita como anterior a todo acesso DAL.

Uma resposta `CONFLICT` ou `VALIDATION_FAILED` sem `fieldErrors` bloqueia novo submit até `GET` autoritativo; o cliente nunca repete automaticamente o POST. `VALIDATION_FAILED` com `fieldErrors` continua sendo erro editável do formulário. Assim, uma corrida de estado usa recuperação por leitura, enquanto o checkbox do contrato ainda recebe feedback de campo normal. Em particular, SQLSTATE `42501` acompanhado exatamente de `owner_contract_not_current` é traduzido para `409 CONFLICT`, pois uma nova versão vigente exige releitura e novo aceite; qualquer outro `42501` permanece `403 FORBIDDEN`. A mensagem SQL serve apenas à classificação interna e não entra no payload público.

### 5.3 Estúdio e revisão

Implementados nas FEAT-006, FEAT-007, FEAT-008 e FEAT-009:

| Action                           | Efeito                                             |
| -------------------------------- | -------------------------------------------------- |
| `studio.create`                  | cria studio + revisão draft                        |
| `studio.revision.updateCore`     | dados, endereço, capacidade, tipo                  |
| `studio.revision.updateTaxonomy` | tags e comodidades ativas                          |
| `studio.revision.updateContent`  | regras, FAQ ordenada e YouTube ID                  |
| `studio.draft.discard`           | remove draft; preserva publicado ou exclui inédito |
| `studio.media.upload.prepare`    | reserva objeto e emite token assinado              |
| `studio.media.upload.finalize`   | valida original, gera prévia e associa             |
| `studio.media.reorder`           | substitui a ordem completa                         |
| `studio.media.cover.set`         | define capa única                                  |
| `studio.media.delete`            | remove associação e agenda órfão                   |
| `studio.revision.submit`         | valida checklist e envia revisão imutável          |
| `studio.pause`                   | pausa publicação preservando os ponteiros          |
| `studio.resume`                  | retoma para published ou changes_pending           |

Os treze envelopes implementados são estritos e carregam `expectedScope` e `idempotencyKey` UUID. O
payload de criação contém somente os dados centrais. Updates, descarte e mídia recebem `studioId`,
`expectedRevisionId` e `expectedRevisionVersion`; status e número de revisão nunca são aceitos do
browser. Curitiba/PR, CEP, capacidade, tipo ativo e limites textuais são validados por Zod e pelo
banco.

`studio.revision.submit` recebe somente `studioId` e o token
`{expectedRevisionId, expectedRevisionVersion}` da candidata visível. O banco deriva completude,
status e versão de publicação; detalhes, conteúdo e mídia incompletos retornam
`422 STUDIO_SUBMISSION_INCOMPLETE`. `studio.pause | studio.resume` recebem `studioId` e
`expectedPublicationVersion`; o status desejado não vem do browser. Versão ou estado concorrente
retorna `409 CONFLICT` e exige releitura autoritativa antes de uma nova intenção.

Completude inclui tipo, tags e comodidades ainda ativos. O banco trava essas referências em ordem
determinística durante o submit: item já arquivado retorna o mesmo
`422 STUDIO_SUBMISSION_INCOMPLETE`, e arquivamento concorrente não atravessa a transação. A UI trata
esse 422 factual como estado que envelheceu e inicia releitura autoritativa. Como a taxonomia altera o
checklist sem avançar os fences editoriais, o comparador recusa a projeção derivada divergente e
recompõe a rota SSR; a nova tela mostra a pendência sem repetir o POST. O `latestReview` segue a
sequência causal do banco; timestamp e UUID não desempatam a timeline.

O resultado dos três comandos é `StudioPublication`: escopo, status, `publicationVersion`, checklist,
capacidades derivadas, último fato editorial e as revisões atual/publicada. Capas privadas são
assinadas pelo servidor, deduplicadas por path e validadas novamente contra owner/estúdio/revisão;
paths de Storage nunca entram no DTO. Submit grava revisão pendente, evento, intenção de e-mail,
ledger idempotente e auditoria na mesma transação. Pausa/retomada preservam os ponteiros e não criam
novo review. Falha ou timeout ao assinar a prévia depois da transação retorna `503` ambíguo: a UI
mantém a mesma chave para retry exato ou relê o GET, nunca inventa sucesso nem dispara nova intenção.

Taxonomia recebe listas únicas de no máximo 20 UUIDs por grupo e o banco aceita somente registros
ativos. Conteúdo recebe plain text aparado, até 20 FAQs ordenadas e `youtubeVideoId` nulo ou com 11
caracteres allowlisted; URLs são interpretadas apenas na fronteira do browser e nunca persistidas.

Todo sucesso de comando `studio.*` usa `data: {action, idempotencyKey, result}` no envelope HTTP
canônico. O handler ecoa ação e chave validadas somente depois de o serviço concluir; `result` contém
o DTO autoritativo já definido para a operação. O browser valida o envelope estrito, ação, chave,
escopo e, quando o alvo já existe, ID do estúdio antes de devolver somente o DTO à UI. Campo
ausente/divergente é `RESPONSE_INVALID` ambíguo: não anuncia sucesso, não resolve recovery e não libera
upload para Storage; preserva o mesmo comando para recuperação. Assim, resposta de outra tentativa
do mesmo dono/estúdio não confirma criação, publicação ou reserva de mídia, mesmo com conteúdo igual.
A identidade da tentativa não substitui ownership, fences de versão, validação do DTO ou `requestId`
e não integra os read models de GET. Não há envelope alternativo exclusivo de criação.

Create e updates têm `StudioEditor` como resultado. Discard retorna união discriminada:
`studioDeleted=true` sem editor para estúdio inédito ou `studioDeleted=false` com editor da revisão
publicada preservada. A mesma chave/payload não repete efeito e retorna exatamente o resultado cujo
hash foi registrado; se uma mudança posterior impedir reconstruir esse resultado, o replay falha
fechado como conflito em vez de devolver o estado atual. Chave reutilizada com payload divergente
também falha `409 CONFLICT`.

Concorrência otimista usa o token `{revisionId, revisionVersion}` ligado à cópia visível do formulário;
refetch em segundo plano nunca troca esse token silenciosamente. Conflito de update relê
`GET /api/owner/studios/[studioId]` e só a escolha explícita entre valores locais/remotos libera um novo
submit com o token atualizado. Uma mutação própria confirmada pelo servidor avança os tokens de todas
as superfícies e do descarte para a revisão retornada, sem substituir valores irmãos ainda não
submetidos; isso evita falso conflito entre saves locais sequenciais sem aceitar mudança externa.
Descarte mantém token próprio, que também não acompanha refetch em segundo plano. Um conflito fecha a
confirmação e bloqueia todos os painéis até a releitura autoritativa do editor inteiro; o token de
descarte nunca avança isoladamente. Somente a escolha explícita de recarregar substitui os valores
locais, atualiza todos os tokens e permite abrir uma nova confirmação, sem liberar um save stale.
`23514 + studio_type_inactive` vira `409
STUDIO_TYPE_UNAVAILABLE`, limpa a
seleção arquivada, relê `/api/studio-types` e exige opção ativa sem tratar a corrida como conflito de
conteúdo. `23514 + studio_taxonomy_inactive` vira `409 STUDIO_TAXONOMY_UNAVAILABLE`, relê editor e
`/api/studio-taxonomies` e exige remover qualquer item arquivado antes de nova gravação; outros
`23514` preservam o erro interno para resposta `500` redigida, sem falso rebase. Resultado de
transporte ambíguo mantém campos e ações concorrentes bloqueados; somente o
retry do mesmo payload/chave fica disponível. A combinação
interna `42501 + owner_contract_not_current` da guarda de estúdio vira
`409 OWNER_CONTRACT_CHANGED`: o cliente recompõe a rota SSR para exigir o contrato vigente e não
classifica isso como conflito de conteúdo. Outros `42501` permanecem `403 FORBIDDEN`.

Leituras implementadas:

- `GET /api/studio-types`: sessão autenticada e lista estrita de tipos ativos;
- `GET /api/studio-taxonomies`: sessão autenticada e projeção estrita de tags/comodidades ativas;
- `GET /api/owner/studios/[studioId]`: sessão autenticada, conta ativa, perfil completo, autoridade de
  dono ativa e contrato vigente são revalidados em toda leitura; depois disso, UUID estrito e 0/1
  editor do próprio dono, com ID igual ao solicitado também na fronteira usada pelo Server Component.
  UUID inválido ou ownership diferente retornam o mesmo `404 NOT_FOUND` sem
  revelar existência. Revogação durante uma sessão aberta recompõe a rota SSR antes de nova edição.
- `GET /api/owner/studios/[studioId]/publication`: aplica as mesmas guardas e retorna somente o
  `StudioPublication` do dono. Estúdio inválido/alheio continua indistinguível em `404`; falha de
  banco ou assinatura privada retorna `503` redigido e sem fallback factual.

As quatro respondem sem cache e registram evento operacional redigido. A fronteira de banco usa os
timeouts canônicos do pool; a leitura de publicação acrescenta deadline absoluto e abortável de 2
segundos para assinar todas as capas privadas. O retorno encerra no prazo mesmo se um adaptador não
cooperar com o `AbortSignal`; resolução tardia não publica estado.

### 5.4 Calendário

| Action                       | Efeito                          |
| ---------------------------- | ------------------------------- |
| `calendar.settings.update`   | min/max/buffer                  |
| `calendar.weekly.replace`    | substitui janelas em transação  |
| `calendar.exception.upsert`  | fecha ou define janelas         |
| `calendar.exception.delete`  | remove futura                   |
| `calendar.block.create`      | alocação manual                 |
| `calendar.block.update`      | move/redimensiona               |
| `calendar.block.delete`      | libera                          |
| `calendar.ical.import`       | cria lote e alocações           |
| `calendar.ical.batch.delete` | remove lote sem afetar reservas |

Comandos validam hora cheia e ownership.

### 5.5 Preço/adicionais

| Action                           | Efeito             |
| -------------------------------- | ------------------ |
| `pricing.base.update`            | preço base         |
| `pricing.dayMultipliers.replace` | 7 dias             |
| `pricing.timeBands.replace`      | faixas sem overlap |
| `addon.create`                   | adicional          |
| `addon.update`                   | altera futuro      |
| `addon.archive`                  | inativa            |

### 5.6 Reserva/pagamento

| Action                            | Efeito                                        |
| --------------------------------- | --------------------------------------------- |
| `booking.quote.create`            | cotação autoritativa                          |
| `booking.payment.start`           | revalida quote, inicia provider, adquire hold |
| `booking.payment.retry`           | nova tentativa idempotente                    |
| `booking.attempt.cancel`          | cancela tentativa pendente                    |
| `reservation.cancel`              | cancelamento do locatário elegível            |
| `reservation.owner.cancelRequest` | solicita suporte                              |
| `reservation.note.update`         | apenas quando permitido                       |

`booking.payment.start` é um orquestrador server-side; provider call e hold precisam de compensação explícita.

### 5.7 Admin/backoffice

| Action                             | Papel                      |
| ---------------------------------- | -------------------------- |
| `backoffice.studio.approve`        | reviewer/admin             |
| `backoffice.studio.reject`         | reviewer/admin             |
| `backoffice.studio.disable`        | admin                      |
| `backoffice.studio.restore`        | admin                      |
| `backoffice.user.suspend/restore`  | support/admin              |
| `backoffice.user.revealPii`        | support/admin              |
| `backoffice.access.grantSupport`   | admin + autenticação forte |
| `backoffice.access.revokeSupport`  | admin + autenticação forte |
| `backoffice.access.grantReviewer`  | admin + autenticação forte |
| `backoffice.access.revokeReviewer` | admin + autenticação forte |
| `backoffice.access.grantAdmin`     | admin + autenticação forte |
| `backoffice.access.revokeAdmin`    | admin + autenticação forte |
| `backoffice.taxonomy.upsert`       | admin                      |
| `backoffice.taxonomy.archive`      | admin                      |
| `backoffice.taxonomy.reactivate`   | admin                      |
| `admin.refund.request/retry`       | finance/admin              |
| `admin.payout.retry/block/unblock` | finance/admin              |
| `admin.fiscal.export`              | finance/admin              |
| `admin.account.deletion.execute`   | admin + confirmação forte  |

Toda action administrativa gera `audit.events`.

O recorte implementado do backoffice usa endpoints próprios na aplicação `:3001`:

- `POST /api/auth/login`, `POST /api/auth/logout` e `GET /api/auth/session` publicam somente identidade,
  escopo, versão opaca de autorização e expirações; papéis permanecem exclusivamente no servidor;
- `POST /api/auth/unlock` recebe a chave local exata, aplica rate limit e publica somente a expiração de
  um cookie HttpOnly assinado, vinculado ao usuário + `session_id` Auth e válido por cinco minutos;
- `POST /api/users` recebe `{ query?, cursor? }`, limita 50 itens e mantém e-mail/filtro fora da URL;
- `GET /api/taxonomies` devolve catálogo, versão e contagem de uso somente para admin;
- `POST /api/studios` recebe `{ cursor? }` e devolve até 50 casos keyset para reviewer/admin; somente
  admin recebe moderação e restauração;
- `GET /api/studios/[studioId]` devolve a submissão pendente ou, para moderação/restauração, a publicação
  exata, além de checklist, capacidades e URLs assinadas curtas; draft não submetido e paths privados
  nunca entram no DTO; antes de solicitar qualquer assinatura, o serviço confirma novamente que
  `scope` e `studioId` retornados pela DAL correspondem à sessão e à rota;
- `/acessos/[userId]` compõe papéis no Server Component por uma fachada admin-only; listas e DTOs do
  browser nunca carregam o conjunto de papéis;
- `POST /api/commands` aceita exclusivamente a união discriminada allowlisted das actions
  `backoffice.*` acima.

Cursores opacos de usuários ou estúdios que não tenham sido emitidos pela própria listagem retornam
`422 VALIDATION_FAILED`; UUID inválido em rota de detalhe retorna o mesmo `404 NOT_FOUND` seguro de um
registro não visível. As duas fronteiras falham antes de consultar a DAL.

As rotas privadas usam uma fronteira única que valida a sessão administrativa e sua binding e preserva
os headers resultantes antes de executar o callback específico. Rate limit, leitura do body, parse e
serviço só executam depois dessa autenticação; a camada de serviço não abre uma segunda janela antes da
DAL. Os headers permanecem tanto no sucesso quanto se limiter, parse, runtime lock ou DAL rejeitarem a
requisição depois dessa autenticação.

Depois do discriminador Zod, comandos passam também por bucket de identidade + action derivado do
scope autenticado; o bucket de rede do túnel não é a única proteção. Leituras propagam cancelamento e a
assinatura de mídia possui deadline server-side. A expiração publicada de uma preview é contada desde o
início da assinatura, nunca depois de uma chamada lenta. No aplicativo público, comandos de estúdio usam
dez segundos por padrão e `studio.media.upload.finalize` usa 45 segundos, pois seu envelope servidor
inclui espera pela claim e processamento da imagem. No backoffice, login, logout, desbloqueio local e
todas as mutações administrativas, inclusive revelação de PII, usam deadline client-side de dez
segundos; leituras continuam canceláveis pelo consumidor sem timer próprio. Vencimento é resposta
ambígua e conserva payload + `idempotencyKey` exatos quando o comando é idempotente.

Todos os comandos incluem `expectedScope` e `idempotencyKey`. Suspensão e restauração são actions
distintas e recebem somente `expectedAccountVersion`; o cliente nunca envia um status de destino.
Cada concessão/revogação de papel é uma action explícita e recebe somente `expectedAccountVersion`;
o cliente nunca envia o conjunto desejado. Taxonomia recebe sua versão em actions separadas de
arquivamento/reativação, e o banco deriva o booleano final; o cliente nunca envia `active`. O servidor ignora qualquer
autoridade implícita nesses campos, revalida sessão/papel no banco e converte estado obsoleto para
`409/STALE_STATE`. Nesse caso a UI remove a confirmação, limpa o alvo versionado e relê o read model
antes de permitir outra ação. Revelação de PII exige motivo allowlisted, nunca entra em cache e retorna
replay somente enquanto as versões canônicas continuam idênticas. A resposta inclui obrigatoriamente
`action: "backoffice.user.revealPii"`, `idempotencyKey` e `reason`, derivados da tentativa persistida no
ledger/evento auditado pela função privada, além de `scope`, `userId` e os campos sensíveis. DAL e
cliente validam esses cinco identificadores contra a solicitação antes de liberar os dados. O
`requestId` HTTP é correlação, não identidade da tentativa, e pode mudar no replay. Outro scope/alvo
recompõe a fronteira privada; chave/motivo divergentes ou eco ausente/inválido são confirmação ambígua:
o cliente retorna `RESPONSE_INVALID`, não consome PII nem limpa a tentativa e permite repetir somente
o mesmo comando. O servidor não completa campos ausentes com dados da request.
Toda mutação, inclusive revelação de PII, exige o desbloqueio local
vigente; ausência ou expiração retorna `423/RUNTIME_LOCKED` antes da DAL.
Chave ausente no processo retorna `503/RUNTIME_UNLOCK_UNAVAILABLE` e chave divergente retorna
`403/RUNTIME_UNLOCK_DENIED`. Nenhuma resposta expõe SQL, provider, chave ou detalhe de autorização.
Antes de validar a action, falhas de origem, limite, JSON e schema são registradas apenas como
`backoffice.command`; a telemetria recebe a action específica somente depois do discriminador Zod.

Os quatro comandos de estúdio incluem `expectedScope`, `idempotencyKey`, `studioId` e
`expectedPublicationVersion`. Aprovação/rejeição exigem também `expectedRevisionId`; somente rejeição
aceita `reason` não vazio. O cliente nunca envia status, papel efetivo, ponteiro ou estado de
restauração. Conflito conclusivo retorna `409/STALE_STATE`; resposta ambígua conserva exatamente o
mesmo payload e a mesma chave para replay, sem liberar outra decisão.

## 6. Read models e DTOs

### 6.1 `list_studios`

Entrada:

```ts
type StudioListInput = {
  neighborhood?: string[];
  date?: string; // YYYY-MM-DD
  minPriceCents?: number;
  maxPriceCents?: number;
  studioTypeId?: string[];
  minCapacity?: number;
  amenityIds?: string[];
  tagIds?: string[];
  order: "price_asc" | "price_desc";
  cursor?: string;
  limit: number; // <= 24
};
```

Saída por item:

```ts
type StudioCardDto = {
  id: string;
  name: string;
  neighborhood: string;
  cover: { url: string; width: number; height: number; alt: string };
  exactHourlyPriceCents: number;
  capacity: number;
  studioType: { id: string; name: string };
  highlights: { id: string; name: string; kind: "tag" | "amenity" }[];
  availableOnDate: boolean | null;
};
```

Cursor incorpora ordem, valor e ID; é assinado/opaco.

### 6.2 `get_studio_detail`

DTO:

- identidade e endereço aprovado;
- galeria;
- vídeo ID;
- descrição, regras, FAQ;
- tipo/tags/amenities;
- capacidade;
- preço base;
- resumo de multiplicadores em linguagem útil;
- configurações de duração;
- disponibilidade da janela solicitada;
- metadata SEO.

Não retorna owner PII, revisão pendente, IDs de Storage internos ou notas de review.

### 6.3 `get_studio_availability`

Entrada:

- studio;
- `fromDate`, `toDate`, máximo 31 dias.

Saída por dia:

```ts
type AvailabilityDayDto = {
  date: string;
  slots: {
    start: string;
    end: string;
    available: boolean;
    reason?: "closed" | "allocated" | "outside_duration";
  }[];
};
```

Não expor detalhes da reserva que ocupa o horário.

### 6.4 `get_reservation_quote`

Entrada:

- studio;
- data/start/duração;
- pessoas;
- add-ons/quantidade;
- observação opcional.

Saída:

- quote ID;
- expiresAt;
- line items;
- subtotal hora;
- subtotal adicionais;
- total;
- regras aplicadas;
- disponibilidade no momento;
- aviso de que vaga só é garantida no hold.

### 6.5 Read models privados

Cada um retorna somente campos de tela:

- `get_my_profile()` público, `security invoker`, sem argumento de usuário e filtrado por `auth.uid()` + RLS;
- `list_my_reservations`;
- `get_my_reservation`;
- `list_owner_studios`;
- `get_owner_studio_editor`: implementado na FEAT-006; escolhe draft ou publicado e repete `scope`;
- `get_owner_calendar`;
- `list_owner_reservations`;
- `list_owner_payments`;
- `get_owner_activation_status`: contrato completo somente para `/dono`;
- `get_owner_recipient_status`: status compacto para recebimentos e refetch.
- `list_backoffice_studio_reviews`: fila privada derivada, ordenada por sequência causal + estúdio e
  paginada por cursor opaco;
- `get_backoffice_studio_review`: comparação privada da submissão `pending` com a publicação ou, na
  moderação/restauração, projeção exclusiva da publicação; capacidades são autoritativas e mídia contém
  apenas URLs assinadas e expiração. O cliente aceita a projeção somente quando `scope` e `studioId`
  correspondem à key solicitada; loading, erro e 404 iniciais possuem boundaries próprias, e um 404
  conclusivo posterior descarta o detalhe privado do cache. A rota aceita somente a atividade
  allowlisted `interactive | passive` no header interno; ausência significa `interactive`, enquanto o
  polling do cliente envia `passive`. A fábrica Auth e a assinatura Storage nascem dentro do mesmo
  deadline abortável e qualquer cookie renovado continua sendo publicado na resposta da rota.

Durante o login, `get_my_profile()` também fornece somente a projeção allowlisted de aparência. Essa leitura recebe `AbortSignal`, tem deadline server-side de um segundo e degrada para `system`; retorno posterior ao encerramento da operação não pode escrever cookie nem disparar cleanup Auth.

## 7. Webhook de pagamento

Rota:

`POST /api/webhooks/payments/[provider]`

Pipeline:

1. ler bytes brutos com limite;
2. extrair headers;
3. validar assinatura/timestamp;
4. derivar `external_event_id`;
5. inserir `webhook_events` com unique;
6. responder repetição com 2xx sem duplicar;
7. mapear evento;
8. executar comando privado idempotente;
9. registrar resultado;
10. retornar rápido.

Provider desconhecido = 404. Assinatura inválida = 401/400 sem detalhar.

## 8. Upload de mídia

### Preparação

`studio.media.upload.prepare` recebe:

- `studioId`, `expectedRevisionId` e `expectedRevisionVersion`;
- MIME declarado, tamanho em bytes e SHA-256 opcional.

Retorna:

- bucket/path derivados, `mediaId` e token de upload assinado;
- escopo, revisão/versão observadas e expiração de duas horas.

O servidor limita a assinatura privilegiada do token a dois segundos e encaminha o `AbortSignal` ao
cliente Storage. Antes de retornar, confirma no banco a primeira emissão. Timeout, falha de assinatura,
falha de confirmação ou replay já expirado acionam uma compensação estreita pela identidade persistida:
ela rejeita e libera a cota somente se nenhuma tentativa concorrente já confirmou a emissão. As duas
fachadas arbitram pelo mesmo advisory lock e nenhuma transação permanece aberta durante o Storage.
O browser usa o cliente oficial de Storage apenas para `uploadToSignedUrl`, com deadline local de 60
segundos e sem sobrescrita. O token nunca entra no QueryCache ou em persistência. Se a reserva expirar
ou o objeto não for confirmado, a recuperação cria outra idempotência e outra identidade; a reserva
antiga não é reativada nem continua consumindo a cota.

### Finalização

Verifica:

- objeto existe;
- tamanho/MIME reais;
- imagem decodificável;
- dimensões entre 1 e 8.192 px e orçamento máximo de 36 milhões de pixels;
- path esperado;
- ownership;
- limite;
- checksum.

Antes do download, o servidor consulta o replay exato da mesma idempotência. Uma tentativa ainda
pendente baixa no máximo 15 MiB, valida página única, gera uma prévia privada WebP auto-orientada de
até 1.280 px/3 MiB e aceita uma derivada preexistente somente quando os bytes coincidem. Só então a
transação muda `status=ready`, cria a associação e incrementa a revisão uma vez. MIME forjado ou
decode inválido produz rejeição segura; indisponibilidade permanece ambígua e exige releitura.

Ordem recebe exatamente o conjunto completo e sem duplicatas da galeria observada. Capa e exclusão
recebem um `mediaId`. As três ações usam a mesma versão otimista; replay pode reconhecer o snapshot
histórico registrado, mas o cliente sempre relê o GET autoritativo antes de publicar e descarta número
de revisão ou versão regressivos. Conflito bloqueia novas ações até reconciliação explícita. `GET
/api/owner/studios/[studioId]/media` obtém paths pela função DAL privada, usa a secret key somente no
servidor para assinar em lote as prévias por cinco minutos e omite os paths persistidos do payload do
browser. O DTO inclui `previewExpiresAt`; em número/versão iguais, o cache conserva a assinatura com
expiração posterior. `revisionStatus` e `canEdit` são derivados no banco: uma candidata `pending`
continua legível com suas fotos e URLs temporárias, mas retorna `canEdit=false`; a interface a mostra
somente para conferência e os comandos revalidam a imutabilidade na fonte canônica.

## 9. Query invalidation map

Documento/código devem manter mapa único. Regras:

- qualquer mudança pública invalida list/detail;
- calendário invalida availability/quote;
- pagamento confirmado invalida calendar/reservation/payment;
- cancelamento invalida calendar/reservation/payment/payout;
- `backoffice.studio.*` substitui/invalida fila e detalhe no backoffice; consumidores owner/public,
  quando implementados em outra origem, relerão a fonte canônica por seus próprios boundaries e fences;
- taxonomy invalida filtros e editores.

Na FEAT-002, `identityQueryKeys.sessions = ["identity", "session"]` é o prefixo de invalidação e `identityQueryKeys.session(userId | "anonymous")` cria a key privada escopada. Recovery usa o prefixo `identityQueryKeys.recoveryStatuses = ["identity", "recovery", "status"]` e a factory `identityQueryKeys.recoveryStatus(scope)`, em que `scope` é o UUID público/opaco recebido pelo Server Component ou `anonymous`. O normalizer rejeita uma resposta cujo scope não corresponda antes de publicá-la no cache. O formulário de nova senha só monta com `allowed=true`, scope correspondente e `fetchStatus="idle"`; `fetching` ou `paused` mantém a verificação fechada, e uma troca de scope remove as famílias recovery/session e recompõe a rota no servidor.

Antes de renderizar PII de sessão, o cliente remove scopes anteriores e também substitui uma instância preexistente da mesma key pelo `initialData` SSR atual. Refetch em execução ou pausado, observer ainda ligado à Query removida e retorno de outro usuário mantêm a tela bloqueada; mudança autoritativa de escopo limpa o cache e recompõe `/entrar` no servidor. Login publica somente a sessão escopada; recovery remove a família privada e logout limpa integralmente o `QueryClient` antes da navegação SSR. Token de callback, senha, grant, `session_id` e e-mail de formulário nunca entram em query key ou cache.

Na FEAT-003, cada mutation sensível de perfil envia `{ action, expectedScope, payload }` a partir de uma ref one-shot e usa `networkMode: "always"`; ausência de rede é executada como erro e nunca vira fila pausada retomável sob outra sessão. `SESSION_CHANGED` ou `UNAUTHENTICATED` fecham o DOM privado, limpam `MutationCache` e as famílias `account/profile` + `identity/session` e forçam nova composição SSR. O logout repete o fence com closure sem `variables` nas duas superfícies, mas limpa integralmente o `QueryClient` antes do reload SSR em qualquer resposta terminal ou incerta. Uma closure stale de A não encerra B: após `getClaims`, a classificação termina antes de o fluxo obter explicitamente o cookie store e antes dos efeitos destrutivos explícitos de recovery, deleção de cookies ou `signOut`; a tentativa offline executa uma única request sem retomada tardia. Reseeds autoritativos normais em login, perfil e segurança fazem a limpeza privada preservando queries públicas. No sucesso do perfil, a publicação sobrescreve a query observada sem removê-la, descarta scopes privados incompatíveis e rejeita callback tardio se a key esperada já tiver sido removida por uma transição A→B.

Na FEAT-004, as famílias privadas são `owner/private/activation/<userId>` e `owner/private/recipient/<userId>`; projeção e usuário fazem parte da identidade do cache. O refetch de `/dono` chama somente o GET completo de ativação, enquanto recebimentos usa somente o GET compacto. Sucesso de `owner.activate` publica `activation`; `recipient.onboarding.start | refresh` publicam `recipient`. Um erro concorrente `409` ou uma validação sem campo exige GET explícito antes de habilitar nova ação, sem replay do comando.

Na FEAT-006/007, catálogos privados usam
`owner/private/studio-taxonomies/<userId>/types|content` e cada editor usa
`owner/private/studio-editor/<userId>/<studioId>`. Sucesso só publica sobre a key existente do mesmo
escopo; logout ou troca de identidade remove editores e catálogos privados. `initialData` SSR permanece oculto até um GET autoritativo
do mesmo usuário/estúdio terminar sem erro; refetch em curso volta ao boundary neutro. Conflito
otimista relê o editor e preserva os valores locais para comparação. Exclusão de inédito remove a
família; mudança de sessão, acesso ou contrato limpa o cliente e recompõe a rota SSR.

Na FEAT-008, a galeria usa `owner/private/studio-media/<userId>/<studioId>`. O SSR e a primeira
composição do cliente permanecem neutros até o GET autoritativo da mesma identidade/estúdio. Sucesso
publica somente na key já observada e invalida o editor irmão; resposta perdida conserva a
idempotência e primeiro relê a galeria. Logout, troca de conta ou perda de autoridade limpam também
todas as URLs assinadas privadas do cache. Descartar uma draft remove primeiro a query exata da
galeria — inclusive URLs e revisão mais nova — antes de publicar o editor restaurado ou excluir o
estúdio; assim o fence monotônico não preserva no cliente uma galeria pertencente à revisão descartada.

## 10. Rate limits iniciais

Defaults por usuário/IP:

| Classe                | Limite    |
| --------------------- | --------- |
| Auth                  | 10/10 min |
| Quote                 | 60/min    |
| Start payment         | 5/10 min  |
| Retry payment         | 5/30 min  |
| Studio edits          | 60/10 min |
| Upload prepare        | 20/h      |
| iCal import           | 5/h       |
| Admin destructive     | 20/h      |
| Account export/delete | 3/dia     |

Implementado no processo local único da FEAT-002: fachada pré-Zod `300/min` por ação e origem de rede confiável; cadastro `5/h` por hash de e-mail; login `10/15 min` por hash de e-mail; pedido de recovery `5/h` por hash de e-mail; callback `10/10 min` por hash do token; atualização de senha `5/h` por usuário. Nenhum discriminador bruto é armazenado. No runtime local direto, a fachada usa um único bucket deliberado porque a stack não é exposta. Em produção, o Nginx sobrescreve o IP canônico e limita `/api/auth/*` e `/api/commands` por IP antes do app; os limites específicos abaixo permanecem a segunda camada.

O limiter in-memory mantém até 10.000 buckets exatos e nunca remove um bucket vivo. Quando essa capacidade está cheia, uma chave inédita passa a compartilhar um contador overflow sticky da sua ação até o reset da janela; a cota já esgotada de uma chave exata não pode ser reiniciada por churn. O overflow aceita até 64 partições de ação e falha fechado para uma nova partição quando esse limite continua ocupado depois da limpeza de contadores expirados. Essa degradação pode gerar rejeição conservadora dentro da ação, mas não transfere pressão para a cota exata de outra classe. A VM única combina esse contrato com o limiter Nginx versionado; horizontalização futura exige armazenamento compartilhado para a camada específica do app.

No escopo local atual, o limiter in-memory é aceitável porque cada execução usa processo único e não fica exposta. Idempotência e banco protegem operações críticas.

## 11. Idempotência

Obrigatória em:

- início/retry de pagamento;
- webhook;
- confirmação de reserva;
- reembolso;
- repasse;
- envio de e-mail;
- exportação;
- exclusão de conta.

Mesmo key + mesmo hash retorna resultado anterior. Mesmo key + payload diferente retorna conflito.

O primeiro uso concreto é a intenção jurídica do cadastro: enquanto a intenção está pendente, `requestId` igual e mesmo contrato retorna o mesmo token opaco inclusive sob corrida, e payload divergente falha fechado. O trigger apaga a intenção ao concluir, o purge remove expiradas e o token nunca é devolvido ao navegador. Depois do consumo ou da expiração, o mesmo `requestId` pode iniciar uma nova tentativa; isso não recria perfil ou aceite para um usuário já materializado, e replay do token apagado falha fechado.
