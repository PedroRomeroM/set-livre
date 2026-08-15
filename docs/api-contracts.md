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

Outras actions privadas acrescentam somente as asserções específicas que seu contrato exigir. No registry implementado, `expectedScope` pertence aos dois comandos de perfil e aos três comandos de dono/recebedor; estes três também exigem `idempotencyKey`. A rota Auth especializada de logout recebe `expectedScope` em seu schema próprio. A asserção é sempre UUID estrito, nunca ownership, e não vira campo genérico aceito silenciosamente por outros envelopes.

Headers:

- `Content-Type: application/json`;
- `X-Request-Id` opcional, validado;
- cookie de sessão;
- `Origin` confiável;
- `Idempotency-Key` pode ser header ou envelope, mas uma política única deve ser escolhida no código; os três comandos FEAT-004 usam exclusivamente `idempotencyKey` no envelope.

`X-Request-Id`/`requestId` identifica a request HTTP e nunca substitui `idempotencyKey`. A chave de idempotência identifica a tentativa lógica repetível e pode atravessar retries com novos request IDs; ela não é copiada para o campo público de correlação.

Limite padrão planejado: 128 KiB. A superfície Auth já implementada na FEAT-002 usa o limite mais restritivo de 16 KiB e consome o stream independentemente de `Content-Length`.

### 2.1 Superfície implementada na FEAT-002

- `identity.register` entra exclusivamente por `POST /api/auth/register`; a rota pública aceita apenas esse envelope estrito e conserva origem, fachada, limite de stream, limiter específico e DAL. `POST /api/commands` é privado: valida a sessão autoritativa antes de consumir o body e aceita somente os dois comandos de perfil e os três comandos de dono/recebedor registrados; action desconhecida ou pertencente a feature futura é rejeitada pelo schema fechado;
- todos os `POST` exigem `Origin` e `Host` exatos de `NEXT_PUBLIC_APP_URL`; em produção, `X-Forwarded-Host` e `X-Forwarded-Proto=https` também precisam ter sido sobrescritos pela borda confiável;
- um bucket de fachada é consumido antes do parse/Zod; depois do parse, cadastro/login/recovery/callback usam somente hashes de e-mail, usuário ou token. Em produção, a fachada exige um único IP canônico em `X-Forwarded-For`, sobrescrito pelo Nginx da borda confiável previsto em PEND-003; header ausente, composto ou inválido falha fechado;
- somente `application/json` e schemas Zod `strict` são aceitos;
- sucesso e erro usam envelope JSON com `requestId`, `private, no-store` e sem payload de provider, SQL ou PII;
- o pedido de recovery responde sempre `202` com o mesmo corpo, inclusive quando o provider rejeita ou está indisponível; somente o evento redigido marca a degradação, sem permitir inferir se o e-mail existe;
- o cliente interrompe qualquer request de identidade após dez segundos e retorna estado recuperável sem preservar payload sensível;
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
- o destino autenticado possui allowlist literal: `/entrar?sessao=ativa`, `/conta`, `/conta/seguranca`, `/dono` e `/dono/recebimentos`. A query da rota usa `retorno`; somente depois da validação o componente envia o campo interno `returnTo` no payload efêmero de login. Sucesso preserva exatamente o destino aprovado. Falha de rede, timeout, envelope inválido ou `AUTH_SESSION_RECHECK_REQUIRED` depois do início de `setSession` preserva o mesmo destino na URL de verificação SSR; URL absoluta, protocol-relative, query/fragmento extra, path traversal, barra invertida, valor codificado ou array falha fechado para o destino padrão.

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

Campos de CPF/CNPJ nunca são aceitos como ownership. CPF é normalizado em onze dígitos; CNPJ aceita a forma numérica legada e a forma alfanumérica oficial de quatorze posições definida na OPEN-009.

Na FEAT-003, os envelopes Zod estritos de `profile.complete` e `profile.update` exigem `expectedScope` UUID no nível superior. Esse valor repete apenas o usuário do recorte SSR que originou o formulário; é uma asserção do cliente, nunca ownership ou substituto da sessão. Depois das validações globais de origem e fachada, a rota privada autentica a sessão antes de consumir o corpo; então o registry compara `expectedScope` com o `session.userId` autoritativo. Divergência retorna `409 SESSION_CHANGED` antes do limiter específico de perfil, serviço e DAL. Envelope sem a asserção, com UUID inválido ou campo extra retorna `422 VALIDATION_FAILED` e também não alcança o serviço.

### 5.2 Dono/recebedor

| Action                         | Efeito                                                 |
| ------------------------------ | ------------------------------------------------------ |
| `owner.activate`               | cria owner profile e aceite vigente de forma atômica   |
| `recipient.onboarding.start`   | inicia operação idempotente no adapter server-only     |
| `recipient.onboarding.refresh` | consulta e aplica snapshot mapeado com fence de versão |

Os três envelopes Zod estritos exigem `expectedScope` e `idempotencyKey` UUID, sem `ownerUserId`, status, provider ou referência externa fornecidos pelo cliente. `recipient.bank.update` permanece ausente até existir token ou handoff provider-owned aprovado. `owner.activate` retorna a projeção `activation` de 21 colunas porque a superfície precisa conservar o documento jurídico completo. `recipient.onboarding.start | refresh` retornam a projeção `recipient` de 16 colunas: apenas referência mínima do contrato (`id`, `source`, `effectiveAt`), status seguros, requisitos, próxima ação, versões monotônicas e `reservationsEligible`; título, versão textual, hash e corpo Markdown não atravessam esse contrato. Nenhuma das respostas contém PII, provider ID ou payload bruto.

Nos três comandos, a rota encaminha o `requestId` da API fora do payload de domínio. Na ativação, o DAL envia correlação e chave lógica como parâmetros SQL distintos; no onboarding do recebedor, `prepare` reserva a `idempotencyKey` e `apply` recebe o `requestId`, recuperando a chave da operação reservada. Fatos novos em `audit.events` usam `request_id` somente para correlação e `idempotency_key` somente para unicidade/replay. Repetir a mesma chave lógica em outra request não cria outro fato nem troca a correlação do efeito original.

As duas leituras autenticadas aplicam no servidor um deadline de 2.000 ms e usam contratos distintos:

- `/dono` e `GET /api/owner/activation` chamam `get_owner_activation_status()` e retornam a projeção completa `activation` de 21 colunas;
- `/dono/recebimentos` e `GET /api/owner/recipient` chamam `get_owner_recipient_status()` e retornam a projeção compacta `recipient` de 16 colunas, sem título, versão textual, hash ou corpo do contrato.

Cada read model encaminha um `AbortSignal` real à RPC e usa race independente para encerrar no prazo mesmo se o transporte não cooperar; o timer é limpo em sucesso/erro, e resolução ou rejeição tardia não publica estado. Um signal externo também encerra a operação. Os GETs traduzem indisponibilidade para `503` seguro, e as rotas SSR permanecem sob seu estado de erro e recuperação, sem fallback factual inventado.

Uma resposta `CONFLICT` ou `VALIDATION_FAILED` sem `fieldErrors` bloqueia novo submit até `GET` autoritativo; o cliente nunca repete automaticamente o POST. `VALIDATION_FAILED` com `fieldErrors` continua sendo erro editável do formulário. Assim, uma corrida de estado usa recuperação por leitura, enquanto o checkbox do contrato ainda recebe feedback de campo normal. Em particular, SQLSTATE `42501` acompanhado exatamente de `owner_contract_not_current` é traduzido para `409 CONFLICT`, pois uma nova versão vigente exige releitura e novo aceite; qualquer outro `42501` permanece `403 FORBIDDEN`. A mensagem SQL serve apenas à classificação interna e não entra no payload público.

No patch local de correlação, `npm ci`, format, lint, typecheck, 42/42 unitários focados, 12/12 guardas de privacidade, 718/718 unitários integrais em 74 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check passaram. Um único reset, geração e `test:db` passou em 358/358 (`158 + 78 + 57 + 65`) no head `20260815000100`, com gerados sincronizados, readiness no head atual, recusa do anterior e tabelas finais em zero.

A focada P3 anterior permanece verde em 23/23. Depois de uma integral diagnóstica de 79 passados, uma falha e 34 não executados no teste de fundação WebKit, o oráculo foi corrigido para separar as páginas; o crítico passou em 3/3 e a integral aceita passou exatamente em 114/114, 17 specs e 16 projetos, preservando 23/23 da FEAT-004, privacidade e cleanup. Um único build passou com 26 rotas web, quatro do backoffice e zero warning; um único smoke customizado passou em 2,4 segundos com os três probes guest `401`/UUID, dois redirects, 14/11 nonces e banco/Mailpit `0 → 0`. A release canônica local final do commit funcional `2a86acc4dc3a005213d5f22384084e3aba0160be`, com 15 migrations/head `20260815000100`, foi gerada e recebeu duas auditorias independentes `NO-BLOCKER`. Na captura remota de `2026-08-15T19:38:32Z`, a publicação estava verificada até `dda95b3b9108930489a3b10275ef41c2f203ae24`, e a thread P3 estava respondida, resolvida, atual e entre zero threads não resolvidas. O commit/push deste registro, atualização do body se necessária, novo review/espera mínima de 60 minutos, captura final única, ready e merge ainda não foram executados; toda a evidência permanece local x64.

As fotografias anteriores de 718/718 unitários, 23/23 focados, 114/114 integrais, build/smoke e release `440c81f6...` permanecem evidência histórica do patch anterior. As novas execuções e a release `2a86acc4...` acima são provas independentes do P3; somente a release antiga continua sem a migration e sem a correlação atual.

### 5.3 Estúdio e revisão

| Action                           | Efeito                            |
| -------------------------------- | --------------------------------- |
| `studio.create`                  | cria studio + revisão draft       |
| `studio.revision.updateCore`     | dados, endereço, capacidade, tipo |
| `studio.revision.updateTaxonomy` | tags/amenities                    |
| `studio.revision.updateContent`  | descrição/regras/FAQ/YouTube      |
| `studio.revision.submit`         | valida completude e envia         |
| `studio.pause`                   | pausa novas reservas              |
| `studio.resume`                  | retoma se elegível                |
| `studio.draft.discard`           | descarta draft sem dependência    |
| `studio.media.upload.prepare`    | emite upload assinado             |
| `studio.media.upload.finalize`   | valida objeto/metadados           |
| `studio.media.reorder`           | posição                           |
| `studio.media.cover.set`         | capa                              |
| `studio.media.delete`            | remove se seguro                  |

`studio.revision.update*` usa optimistic concurrency (`expectedUpdatedAt` ou revision token).

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

| Action                                 | Papel                     |
| -------------------------------------- | ------------------------- |
| `admin.studio.approve`                 | reviewer/admin            |
| `admin.studio.reject`                  | reviewer/admin            |
| `admin.studio.disable`                 | admin                     |
| `admin.studio.restore`                 | admin                     |
| `admin.user.suspend`                   | support/admin             |
| `admin.user.restore`                   | support/admin             |
| `admin.role.grant/revoke`              | admin                     |
| `admin.taxonomy.create/update/archive` | admin                     |
| `admin.refund.request/retry`           | finance/admin             |
| `admin.payout.retry/block/unblock`     | finance/admin             |
| `admin.fiscal.export`                  | finance/admin             |
| `admin.account.deletion.execute`       | admin + confirmação forte |

Toda action administrativa gera `audit.events`.

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
- `get_owner_studio_editor`;
- `get_owner_calendar`;
- `list_owner_reservations`;
- `list_owner_payments`;
- `get_owner_activation_status`: contrato completo somente para `/dono`;
- `get_owner_recipient_status`: status compacto para recebimentos e refetch.

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

- studio/revision;
- nome;
- MIME;
- tamanho;
- checksum opcional.

Retorna:

- signed upload URL;
- path;
- media draft ID;
- expiração.

### Finalização

Verifica:

- objeto existe;
- tamanho/MIME reais;
- imagem decodificável;
- dimensões mínimas/máximas;
- path esperado;
- ownership;
- limite;
- checksum.

Só então `status=ready`.

## 9. Query invalidation map

Documento/código devem manter mapa único. Regras:

- qualquer mudança pública invalida list/detail;
- calendário invalida availability/quote;
- pagamento confirmado invalida calendar/reservation/payment;
- cancelamento invalida calendar/reservation/payment/payout;
- admin review invalida fila/status/public;
- taxonomy invalida filtros e editores.

Na FEAT-002, `identityQueryKeys.sessions = ["identity", "session"]` é o prefixo de invalidação e `identityQueryKeys.session(userId | "anonymous")` cria a key privada escopada. Recovery usa o prefixo `identityQueryKeys.recoveryStatuses = ["identity", "recovery", "status"]` e a factory `identityQueryKeys.recoveryStatus(scope)`, em que `scope` é o UUID público/opaco recebido pelo Server Component ou `anonymous`. O normalizer rejeita uma resposta cujo scope não corresponda antes de publicá-la no cache. O formulário de nova senha só monta com `allowed=true`, scope correspondente e `fetchStatus="idle"`; `fetching` ou `paused` mantém a verificação fechada, e uma troca de scope remove as famílias recovery/session e recompõe a rota no servidor.

Antes de renderizar PII de sessão, o cliente remove scopes anteriores e também substitui uma instância preexistente da mesma key pelo `initialData` SSR atual. Refetch em execução ou pausado, observer ainda ligado à Query removida e retorno de outro usuário mantêm a tela bloqueada; mudança autoritativa de escopo limpa o cache e recompõe `/entrar` no servidor. Login publica somente a sessão escopada; recovery remove a família privada e logout limpa integralmente o `QueryClient` antes da navegação SSR. Token de callback, senha, grant, `session_id` e e-mail de formulário nunca entram em query key ou cache.

Na FEAT-003, cada mutation sensível de perfil envia `{ action, expectedScope, payload }` a partir de uma ref one-shot e usa `networkMode: "always"`; ausência de rede é executada como erro e nunca vira fila pausada retomável sob outra sessão. `SESSION_CHANGED` ou `UNAUTHENTICATED` fecham o DOM privado, limpam `MutationCache` e as famílias `account/profile` + `identity/session` e forçam nova composição SSR. O logout repete o fence com closure sem `variables` nas duas superfícies, mas limpa integralmente o `QueryClient` antes do reload SSR em qualquer resposta terminal ou incerta. Uma closure stale de A não encerra B: após `getClaims`, a classificação termina antes de o fluxo obter explicitamente o cookie store e antes dos efeitos destrutivos explícitos de recovery, deleção de cookies ou `signOut`; a tentativa offline executa uma única request sem retomada tardia. Reseeds autoritativos normais em login, perfil e segurança fazem a limpeza privada preservando queries públicas. No sucesso do perfil, a publicação sobrescreve a query observada sem removê-la, descarta scopes privados incompatíveis e rejeita callback tardio se a key esperada já tiver sido removida por uma transição A→B.

Na FEAT-004, as famílias privadas são `owner/private/activation/<userId>` e `owner/private/recipient/<userId>`; projeção e usuário fazem parte da identidade do cache. O refetch de `/dono` chama somente o GET completo de ativação, enquanto recebimentos usa somente o GET compacto. Sucesso de `owner.activate` publica `activation`; `recipient.onboarding.start | refresh` publicam `recipient`. Um erro concorrente `409` ou uma validação sem campo exige GET explícito antes de habilitar nova ação, sem replay do comando.

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

Implementado no processo local único da FEAT-002: fachada pré-Zod `300/min` por ação e origem de rede confiável; cadastro `5/h` por hash de e-mail; login `10/15 min` por hash de e-mail; pedido de recovery `5/h` por hash de e-mail; callback `10/10 min` por hash do token; atualização de senha `5/h` por usuário. Nenhum discriminador bruto é armazenado. No runtime local direto, a fachada usa um único bucket deliberado porque a stack não é exposta; produção permanece bloqueada por PEND-003 até o Nginx sobrescrever o header e aplicar também o limiter de borda.

O limiter in-memory mantém até 10.000 buckets exatos e nunca remove um bucket vivo. Quando essa capacidade está cheia, uma chave inédita passa a compartilhar um contador overflow sticky da sua ação até o reset da janela; a cota já esgotada de uma chave exata não pode ser reiniciada por churn. O overflow aceita até 64 partições de ação e falha fechado para uma nova partição quando esse limite continua ocupado depois da limpeza de contadores expirados. Essa degradação pode gerar rejeição conservadora dentro da ação, mas não transfere pressão para a cota exata de outra classe. Produção continua dependente do limiter Nginx de PEND-003, e horizontalização futura exige armazenamento compartilhado.

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
