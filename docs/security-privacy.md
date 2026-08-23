# Segurança, privacidade e LGPD

## 1. Modelo de ameaça

Ativos:

- contas;
- CPF/CNPJ/documentos;
- endereço de estúdios;
- calendários;
- reservas;
- pagamentos;
- IDs de provider;
- mídia;
- secrets;
- funções administrativas.

Ameaças prioritárias:

- acesso entre usuários;
- escalada de papel;
- dupla reserva;
- webhook forjado/replay;
- IDOR;
- upload malicioso;
- vazamento em logs;
- abuso de comandos;
- deploy comprometido;
- exclusão indevida;
- fraude financeira.

## 2. Autenticação

- e-mail/senha via Supabase;
- confirmação de e-mail;
- recovery sem revelar existência;
- cookies seguros;
- servidor valida usuário;
- logout limpa caches;
- returnTo em allowlist;
- conta suspensa não executa comando;
- backoffice verifica role a cada request sensível.

Na FEAT-002, os clientes Supabase são criados por request no servidor, a sessão é validada por claims e pelo read model do próprio perfil, e os cookies são `HttpOnly`, `SameSite=Lax` (`Strict` para o grant temporário e o marcador de escopo de recovery) e `Secure` fora do HTTP loopback local. Os ambientes `development`/`production` recusam origens sem HTTPS para a aplicação ou o Supabase; somente `local`/`test` aceitam os endpoints HTTP `127.0.0.1` exatos. Confirmação e recovery aceitam somente `signup`/`recovery`: templates locais colocam o `TokenHash` no fragmento `#`, que não é enviado ao servidor no primeiro GET, e a UI apaga query/fragmento antes de publicar o JSON.

O cadastro também falha fechado antes de React assumir o submit. O único `RegistrationForm` presente no HTML SSR usa `useSyncExternalStore` com snapshot `false` no servidor e `true` no cliente. Enquanto o snapshot permanece fechado, o status **Preparando o formulário seguro…** fica fora do `form`; o próprio formulário recebe `inert`, `method=post` e `aria-busy`, e um `fieldset` externo, os sete controles nomeados e o submit ficam disabled. Somente depois da hidratação eles voltam ao fluxo normal. O método POST é defesa adicional; a garantia principal é não existir controle operável capaz de acionar fallback GET com e-mail, senhas ou aceites na query.

Nos dois callbacks, somente uma resposta válida `SERVICE_UNAVAILABLE` produzida antes de iniciar `verifyOtp` preserva o payload exclusivamente em memória para retry. Após o POST, rede indisponível, timeout ou resposta inválida são ambíguos para o cliente; depois que `verifyOtp` começa, erro de transporte/desconhecido ou publicação de sessão inconclusiva pode suceder ao consumo do OTP. Esses casos são terminais: o servidor devolve `AUTH_RESTART_REQUIRED` no signup ou `RECOVERY_RESTART_REQUIRED` no recovery, descarta a sessão e somente o cookie Supabase Auth base e seus chunks numéricos exatos, e o cliente apaga o payload sem oferecer retry. O mesmo fallback remove publicação parcial de login e cookies residuais quando o sign-out final de recovery não pode ser comprovado, sem apagar cookies de prefixo semelhante ou mascarar a causa pública redigida.

No login, `NETWORK_UNAVAILABLE`, `REQUEST_TIMEOUT` e `RESPONSE_INVALID` após o envio também são ambíguos para o browser: a resposta pode ter se perdido depois da publicação dos cookies. O servidor usa `AUTH_SESSION_RECHECK_REQUIRED` quando `setSession` já começou e a publicação ou seu cleanup exato termina inconclusivo; esse código válido continua sendo terminal, não uma indisponibilidade pré-publicação. Antes de recarregar `/entrar`, o cliente apaga a referência one-shot, oculta e reseta os controles, limpa o `QueryClient` e publica somente uma sentinela anônima. A rota SSR decide então entre a sessão realmente ativa e a cópia de entrada não confirmada; somente rejeições comprovadamente anteriores à publicação, como credencial inválida, rate limit ou indisponibilidade do provider durante a autenticação inicial, continuam no formulário sem essa transição.

A projeção de preferência executada depois de `setSession` recebe `AbortSignal` e deadline server-side de um segundo na chamada a `get_my_profile()`. Timeout ou falha projeta `system`; o fence da operação impede que uma resolução tardia escreva o cookie `sl-color-scheme` ou dispare `signOut` depois de a resposta já ter sido devolvida.

Logout usa o mesmo contrato nas superfícies autenticadas de `/entrar` e `/conta/seguranca`: uma closure one-shot sem `variables`, `networkMode: "always"` e `expectedScope` UUID apenas como asserção. O servidor executa `getClaims`, que pode renovar ou manter a sessão internamente, e termina a classificação antes de obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw retorna `503 SERVICE_UNAVAILABLE`; `claimsResult.error` ou contexto assinado ausente retorna `401 UNAUTHENTICATED`; somente um `userId` válido divergente retorna `409 SESSION_CHANGED`. Esses três ramos têm zero efeitos destrutivos explícitos de logout. O cliente fecha o boundary privado, executa `QueryClient.clear()` e força composição SSR; assim, uma closure stale de A não encerra B e uma tentativa offline não fica pausada para reenviar após reconexão.

Erros retryable de atualização recovery não conservam o objeto `Error` nem códigos, stack ou credenciais. Somente a mensagem pública, o scope UUID público de origem e os erros allowlisted de senha/confirmação pertencem ao boundary externo; eles atravessam o refetch que desmonta o formulário e só voltam ao DOM depois de `allowed=true`, scope idêntico e `fetchStatus=idle`.

No callback de recovery, `sub`, `session_id` e `exp` vêm do JWT validado pelo Supabase e precisam corresponder à sessão canônica em `auth.sessions`. O banco cria uma binding/tombstone por `session_id`, vinculada ao usuário, e um grant opaco one-shot de 15 minutos. O UUID `session_scope` é deliberadamente público, opaco e não autoritativo: ele chega à interface apenas para isolar cookie, resposta e cache, mas nunca substitui o JWT assinado, a binding ou o grant na decisão de acesso.

O grant só volta ao estado livre após uma rejeição explícita que prove ausência de efeito e enquanto ainda está vigente; expiração ou falha ambígua mantém a tentativa terminal e exige novo link. Consumo, fechamento, expiração, marcador ausente/divergente ou uso da sessão fora das superfícies de recovery encerram a sessão Auth local, removem o grant e preservam a tombstone para impedir replay mesmo sem os cookies auxiliares. Uma sessão Auth comum sem binding não é classificada como recovery; um marcador residual é apenas descartado. O tempo de JWT Auth fica pinado em `3600` segundos e integra o readiness. Quando a ausência da sessão canônica é observada, a tombstone é fechada e retida conservadoramente por pelo menos mais 65 minutos; purge só ocorre depois de `retain_until` e enquanto `auth.sessions` continua ausente. `private.signup_legal_intents`, `private.identity_recovery_grants` e `private.identity_recovery_sessions` usam RLS sem policy e zero grants runtime. Respostas de recovery não distinguem conta existente.

## 3. Autorização

Camadas:

1. rota;
2. sessão;
3. status/papel;
4. ownership no handler/DAL;
5. função SQL;
6. constraints;
7. grants/RLS.

Nunca aceitar `owner_user_id`, `role`, `status`, shares ou `approved` do cliente como autoridade.

Na DAL, `app_dal` é `NOLOGIN`/`NOINHERIT` e pode ser assumida somente pelo login restrito configurado; as referências administrativas `postgres` exigidas pelo PostgreSQL 17 não possuem `SET/INHERIT`, e nenhuma role intermediária pode assumir o login. O readiness aplica allowlists exatas às duas identidades: `app_dal` não possui objetos nem default privileges e recebe diretamente apenas `USAGE` em `private` e `EXECUTE` nas dezesseis rotinas autorizadas — os dois checks de readiness, a criação da intenção legal, `issue`/`inspect`/`claim`/`release`/`consume`/`close` do contexto recovery, os três comandos `complete`/`update identity`/`update appearance` do perfil e os quatro entrypoints FEAT-004 `get_owner_recipient_status_for_user`/`activate_owner`/`prepare_owner_recipient_operation`/`apply_owner_recipient_operation` —, totalizando dezessete dependências ACL. As leituras autenticadas `public.get_my_profile()`, `public.get_owner_activation_status()` e `public.get_owner_recipient_status()` permanecem fora dessa role, como `security invoker`, sem UUID de entrada e sob `auth.uid()` + RLS. O login recebe somente `CONNECT`, sua membership DAL, limite de dez conexões, validade infinita e a máscara local vazia do GUC de assinatura. Esse teto é compartilhado pelos processos simultâneos: o pool de comandos web usa no máximo seis conexões, o readiness web duas e o readiness do backoffice duas (`6 + 2 + 2 = 10`), sem aumentar o limite da role. `TEMPORARY` é revogado de `PUBLIC`, não é concedido à DAL nem ao login e sua ausência efetiva é verificada nos dois entrypoints de readiness; grants explícitos administrados pela stack permanecem intocados. A inspeção recusa grants por coluna, a role como grantor, parâmetros residuais, terceiro membro ou ownership fora do manifesto. A baseline pública é exata; objetos alcançáveis de `private` e objetos compartilhados monitorados falham fechado. Em `pg_catalog`, cada privilégio de relação ou coluna concedido a `PUBLIC` precisa estar contido na baseline inicial `i`/`e` do próprio objeto registrada em `pg_init_privs`; isso preserva as leituras built-in do PostgreSQL sem aceitar expansões posteriores, como `SELECT` em `pg_authid` ou em `rolpassword`. Rotinas são comparadas pelo OID do overload: ACL `i`/`e` prevalece; sem esse registro, membros de extensão usam `pg_extension.extowner` e demais built-ins initdb (`OID < 16384`) usam o owner bootstrap OID `10`, nunca o `proowner` mutável do objeto. O owner precisa coincidir com essa origem mesmo quando `PUBLIC` não conserva `EXECUTE`; uma rotina normal posterior começa com baseline pública vazia. Grantor e grant option também precisam caber na origem canônica, portanto o default interno e membros legítimos de extensão continuam válidos sem liberar `pg_read_file(text)`, função nova ou grantor derivado de owner adulterado. `pg_roles`, `pg_user` e `pg_db_role_setting` continuam sob a garantia adicional de ACL/owner exatos e inacessibilidade direta, por coluna ou transitiva às roles web/DAL. Row types, arrays e multiranges implícitos seguem seus objetos canônicos; composites explícitos continuam monitorados. O contrato restringe expansão direta de `PUBLIC`; ele não avalia sozinho a semântica da rotina, grants a roles nomeadas nem afirma que todo catálogo built-in seja confidencial. As personas adversariais owner/admin das fixtures permanecem sob `authenticated`, veem apenas a própria conta e não ganham escrita direta nem execução privada; as autoridades canônicas entram somente pelos fatos FEAT-004, nunca por metadata Auth.

O documento jurídico do dono segue minimização por intenção. Somente `/dono` e `GET /api/owner/activation` recebem a projeção de ativação com 21 colunas e corpo Markdown. `/dono/recebimentos`, `GET /api/owner/recipient` e os retornos de `recipient.onboarding.start | refresh` recebem 16 colunas e omitem título, versão textual, hash e corpo. Usuário e projeção também separam as query keys privadas, evitando que o contrato completo seja reutilizado no cache operacional de recebimentos.

A disponibilidade operacional do onboarding também falha fechada. `recipientOnboardingCapability` é derivada exclusivamente de `APP_ENV` no servidor e nunca aceita do cliente: somente `local | test` produz `local_adapter`; `development | production`, valor ausente ou inválido produzem `unavailable`. O campo não concede autoridade, não altera `providerMode`/`nextAction` e não é persistido. Quando indisponível, start/refresh retornam `503 PAYMENT_PROVIDER_UNAVAILABLE` antes de `prepare`, sem reservar chave, chamar adapter ou alterar o recebedor; a leitura factual permanece disponível somente para consulta.

A disponibilidade jurídica da ativação usa uma capability diferente e exclusiva da projeção completa. `ownerActivationCapability` combina a fonte validada do contrato com `APP_ENV` no servidor: `approved` é sempre `available`; `local_fixture` é `available` somente em `local | test`, e `development | production`, valor ausente ou inválido produzem `unavailable`. O navegador não fornece o campo, e ele não concede autoridade, aprova a fixture, altera `source`/`nextAction` nem persiste configuração. A leitura autenticada conserva o documento completo para consulta; o comando indisponível retorna `503 SERVICE_UNAVAILABLE` antes de `activateOwnerProfile`, de criar aceite/autoridade ou de auditar um fato. Essa garantia não alega que a recusa precede a leitura DAL necessária para classificar a fonte.

Concorrência não autoriza replay automático. `CONFLICT` e `VALIDATION_FAILED` sem `fieldErrors` fecham a ação até um GET autoritativo; validação realmente ligada ao campo continua editável. A classificação server-side trata somente `42501 + owner_contract_not_current` como `409 CONFLICT`, porque contrato superado exige nova leitura; `owner_blocked`, `recipient_blocked` e qualquer outro `42501` permanecem `403 FORBIDDEN`. O payload público recebe apenas código e mensagem seguros, nunca a mensagem SQL usada nessa decisão. A execução browser anterior ao novo P2 aceitou o cenário de dois contextos: exatamente um POST stale, um `409`, zero GET antes da decisão do usuário, um GET autoritativo e nenhum novo POST durante a recuperação.

Correlação e replay também são fronteiras separadas. O `requestId` selecionado/validado pela rota percorre apenas o contexto server-side e chega a `audit.events.request_id`; a `idempotencyKey` do envelope permanece privada e aparece somente nas tabelas de operação/replay e em `audit.events.idempotency_key`, necessária à unicidade do fato. Ela não entra em log/evento operacional, resposta, DTO, DOM, URL ou metadata. Linhas anteriores à migration `20260815000100` preservam o valor legado — uma chave idempotente — nos dois campos; o request ID HTTP verdadeiro não é recuperável e não é fabricado.

Na FEAT-003, CPF/CNPJ e documento adicional permanecem somente nas colunas privadas alcançadas pela DAL e nunca são selecionados pelo read model. O DTO próprio contém apenas máscaras estruturais, nome e telefone do titular autenticado. `profile.complete` e `profile.update` exigem `expectedScope` UUID no envelope estrito para repetir o recorte SSR, mas esse campo é apenas asserção do cliente: `session.userId` permanece a autoridade. Depois de origem e fachada, a rota privada autentica antes de consumir o body; divergência recebe `409 SESSION_CHANGED` antes do limiter específico de perfil, serviço e DAL.

CPF/CNPJ e documento adicional não entram em query key, estado React, `MutationCache`, log ou retorno de conflito: os inputs não controlados são lidos via `FormData`, copiados com o `expectedScope` para uma referência one-shot apenas durante o comando e limpos em todo desfecho remoto. As mutations usam `networkMode: "always"`; offline é erro imediato/limitado pelo timeout da request, nunca uma mutation pausada capaz de retomar depois de uma troca de sessão. `SESSION_CHANGED` e `UNAUTHENTICATED` fecham o DOM privado, descartam a ref, o `MutationCache` e as famílias de perfil/sessão antes do reload SSR.

Telefones QA também não podem ser persistidos em títulos ou snippets Playwright. Uma matriz integral chegou funcionalmente a 114/114, mas sua evidência foi rejeitada após encontrar 18 telefones em 61 títulos `Fill` e quatro snippets; esse run permanece como diagnóstico histórico. O helper foi endurecido para aplicar o setter nativo e um `InputEvent` dentro de `Locator.evaluate`, e sete call sites deixaram de passar o valor por `fill`.

A matriz 114/114, o build/smoke e a release local `2a86acc4...` permanecem uma fotografia histórica do terceiro P2. O quarto P2 fechou em 734/734 unitários, banco 358/358, browser 23/23 e 114/114, build e release canônica `969f30cd...`; toda essa prova é histórica para `ownerActivationCapability`.

No quinto P2, o snapshot inicial passou em 747/747 unitários e 358/358 no banco. A primeira rodada browser focada coletou 23 testes em quatro specs/14 projetos (`615bf589...`) e terminou uma única vez com exit `1`: 12 passados, falha em `SL-F004-E2E-001`/`critical-webkit`, dez não executados e zero rerun. O provisionamento compartilha o cadastro da FEAT-002 e expôs o fallback GET pré-hidratação com campos sintéticos na query. É uma falha real de privacidade, não evidência da capability; o ID 004 não foi alcançado e a integral não iniciou. Somente stdout redigido `f4d0595a...` e auditoria `13859c3c...` foram preservados, os brutos foram removidos sem reproduzir valores/endereço e o cleanup terminou em zero.

Depois da correção, o teste unitário SSR/hidratação passou em 2/2 e a guarda combinada da identidade em 22/22; `SL-F002-E2E-001` foi estendido sem novo ID com contexto sem JavaScript. A cadeia estática pós-hardening passou integralmente em Node 24/npm 11, com 749/749 unitários em 75 arquivos, e o banco passou em 358/358 com gerados byte-identical e head de 15 migrations. Uma asserção auxiliar errada do hash de `next-env` interrompeu somente a orquestração após typecheck; os gates restantes continuaram com autorização e nenhum gate do projeto falhou. No banco, a primeira invocação interrompida após `0001` é inválida e teve cleanup limpo; uma única nova invocação autorizada, sem repetir reset/geração, passou. A afirmação de que nenhuma prova x64 substituía ARM64 ou encerrava PEND-003 pertence àquele snapshot pré-ADR-021; o gate operacional atual foi substituído pelo smoke Linux x86_64 na `VM.Standard.E2.1.Micro`.

A focada race-fixed passou em 23/23 por quatro specs/14 projetos e teve seu reuse validado pela auditoria final. A rodada attribute-fixed coletou 114 testes em 17 specs/16 projetos e sua única execução passou em 114/114 em 5,6 minutos, com zero retry, erro ou attachment. A FEAT-004 permaneceu em 23/23 na distribuição `3 + 3 + 3 + 4 + 3 + 4 + 3`; o contexto sem JavaScript da FEAT-002 passou nos três engines dentro do mesmo ID e da contagem existente.

A auditoria contou 140 ocorrências dos 88 e-mails QA somente em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Fora dessa allowlist ficaram em zero outros e-mails decodificados, secrets, sentinelas, URL de banco, JWT, cookie Auth, query sensível, campos de senha/token, telefones, documentos, identificadores/referências de provider e corpo contratual. Cleanup de banco, Mailpit, dblink, portas transitórias e processos terminou em zero. Evidência segura: `.artifacts/p5-owner-activation-capability-attribute-fixed/full.audit.json`, SHA-256 `5704c67cf21bdcc6e92b733bfdb8788972c216d48f850c885200b6d4d78a37d6`.

As execuções rejeitadas anteriores permanecem histórico diagnóstico: a primeira revelou o defeito de privacidade pré-hidratação já corrigido, e as seguintes registram problemas de harness/oráculo. Nenhuma indica falha atual do produto. Static 749/749, DB 358/358, focada 23/23 e integral 114/114 estão verdes.

A build P5 foi invocada uma única vez e compilou 26 + 4 rotas com exit `0`, zero warning e `BUILD_ID=local`, mas o artefato não passou na auditoria de privacidade. O standalone copiou o `package.json` raiz, no qual `scripts.knip` ainda continha strings locais administrativas/DAL; por isso esse resultado não é build verde, e nenhum smoke foi iniciado. A correção remove todos os literais do script, que agora é exatamente `knip`; o config continua lendo os valores necessários do `.env.e2e.local` físico. A unidade do npm confiável fixa o comando e recusa `E2E_DATABASE_URL`, `DATABASE_URL_APP_DAL` ou URI PostgreSQL em qualquer script npm dos quatro manifests canônicos — raiz, backoffice, contracts e UI. O recorte 4/4, Prettier/ESLint direcionados, Knip com as sete variáveis E2E explicitamente unset e diff-check passaram, e o lockfile permaneceu idêntico.

A única build pós-manifesto também terminou com exit `0`, mas o audit encontrou exatamente uma ocorrência DAL no cache Turbopack de cada app; standalone, static e o log privado `d8e50e0f...` ficaram limpos. O smoke continuou em zero. O wrapper único `scripts/next-build.mjs` é a única entrada dos scripts web/backoffice e também é reutilizado por `release-manifest.mjs`, com ambiente allowlisted. Dentro da operação primária, `resolveTrustedNextCliLaunch` valida ancestrais físicos/protegidos do manifesto do app, Node/npm e pacote/binário/versão Next antes do spawn; depois o wrapper sempre tenta a remoção física canônica apenas de `<app>/.next/cache`, inclusive após falha dessa validação ou do build. Falha de cleanup aborta, e falhas simultâneas são preservadas em `AggregateError`; standalone/static são preservados, e raiz/ancestral simbólico ou externo é recusado sem spawn nem travessia. O preview passa `cleanupBuild` ao supervisor pai e limpa depois de qualquer desfecho do grupo de build, antes de validar ou iniciar o servidor; cleanup falho bloqueia o start, falha dupla vira `AggregateError` e a integração prova remoção de um valor DAL sintético. O run direcionado final passou em 40/40 por quatro arquivos — 12 de cache/wrapper, quatro do npm confiável, 16 de Next/local server e oito do supervisor de preview —, com ESLint zero, checks Node, Knip env-unset e diff-check. O 31/32 diagnóstico anterior foi apenas um texto esperado antigo, corrigido somente no oráculo.

A cadeia estática final única passou em 764/764 unitários por 76 arquivos, com npm ci 447/451/zero vulnerabilidades, format, lint zero, typecheck dos cinco recortes, docs 34/200/18, audit zero, Knip, diff-check e freeze 53/34/19. Após a remoção física dos dois `.next`, a build final via wrapper terminou em uma única execução, exit `0`/14,733 s; log privado de 2.155 bytes/SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. A auditoria independente SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d` ficou `NO-BLOCKER`: caches/retired zero, standalone/static/log/packages/symlinks/privacy/inputs/cleanup verdes e DB 15/legal 3/dblink/Mailpit/portas/processos sem resíduo. Nesse fechamento pré-release, o smoke ainda estava em zero.

O gerador canônico executou exatamente uma vez para `2045d1a00c15889007b3c5c04c08d0467fc3d9b3`, exit `0` em 21,26 s; o primeiro smoke P5, embutido, ficou verde antes da publicação local do archive. Duas auditorias `NO-BLOCKER` comprovaram live/manifest/tar 2.871 sem mismatch, 3.455 membros seguros e zero cache, secret, env incorporado, PII, incoming/retired, porta, processo, relação DB residual, Mailpit ou dblink. Archive modo `0600` SHA-256 `282f9d173eebf99ba63466d81f4aa4b9061e7d73668c267fb0a25e9e86043b92`; manifesto SHA-256 `d8b698ecef6b6c52f4961e8783ef2c1e68b5ab00239de4de9206cb9f2f2d2026`. A release permanece local, ignorada e não publicada. A afirmação de que nenhuma prova x64 substituía ARM64/PEND-003, enquanto o remoto permanecia pendente, pertence àquele snapshot pré-ADR-021; o gate operacional atual foi substituído pelo smoke Linux x86_64 na `VM.Standard.E2.1.Micro`.

O cache de conta é escopado por `userId` e mantém PII fora do DOM durante hidratação, refetch, pausa offline, erro ou troca de sessão. Reseeds autoritativos normais de login, perfil e segurança limpam `MutationCache`, `account/profile` e `identity/session`, preservando cache público. Logout e login ambíguo continuam limpando o `QueryClient` integralmente. A publicação autoritativa de uma mutation preserva o observer da Query de perfil corrente, remove scopes privados incompatíveis e exige que a key esperada ainda exista; assim, um callback tardio de A depois do reseed B não recria nem publica o perfil de A. `sl-color-scheme` é uma projeção HttpOnly allowlisted de `system | light | dark`, apagada antes de trocar identidade e reemitida apenas a partir do perfil autoritativo dentro do deadline da operação.

O `pg_net` fornecido pela stack Supabase concede capacidades HTTP e de fila por ACLs gerenciados por `supabase_admin`, que a role de migration não pode revogar. Durante a fronteira local-first do ADR-018, o bootstrap usa exclusivamente o superuser local, em loopback, para revogar schema, tabelas, sequências, funções e defaults de `net` para `PUBLIC` e todas as roles runtime; somente o worker administrativo configurado como `postgres` mantém o acesso técnico necessário. A normalização equivalente na Supabase Cloud permanece bloqueada por PEND-002 e precisa garantir que o login DAL não leia material de assinatura nem por GUC/current_setting nem diretamente em `pg_roles`, `pg_user` ou `pg_db_role_setting` antes de liberar tráfego.

## 4. Dados pessoais

Inventário:

- nome;
- e-mail;
- telefone;
- CPF/CNPJ;
- documento;
- IP/user-agent hashed para evidência;
- fatos de autoridade do dono e versão sincronizada do perfil;
- referência opaca do recebedor, somente no schema privado;
- histórico de reserva/pagamento.

Minimização:

- banco Set Livre não guarda dados bancários completos se provider pode custodiar;
- a FEAT-004 não coleta endereço adicional, KYC nem dados bancários; qualquer handoff futuro precisa ser provider-owned e aprovado;
- e-mail do Auth não é replicado publicamente;
- read models limitam;
- logs pseudonimizam;
- payload de webhook é redigido.

## 5. Criptografia e secrets

- TLS;
- secrets em env server-side;
- `.env` fora do Git;
- provider IDs/tokens privados;
- rotação documentada;
- backups criptografados no Object Storage;
- chaves de criptografia fora do repositório;
- nenhum secret em GitHub artifact sem proteção.

## 6. CSRF/origin

Comandos cookie-based validam:

- `Origin` e `Host` exatos contra a origem configurada; em produção, também `X-Forwarded-Host` exato e `X-Forwarded-Proto=https` sobrescritos pela borda confiável;
- método;
- content type;
- SameSite.

Webhooks não usam sessão; usam assinatura.

## 7. Rate limiting

VM única: memória por processo é primeira camada. Operações críticas também usam idempotência e constraints.

- toda rota de escrita consome um bucket de fachada antes do parse/Zod e um bucket pseudonimizado específico depois da validação;
- no local direto, a fachada é compartilhada porque somente loopback é permitido; em produção, o app falha fechado sem um único `X-Forwarded-For` canônico sobrescrito pelo Nginx confiável;
- o armazenamento local mantém no máximo 10.000 buckets exatos e nunca remove um bucket vivo; um discriminador exato com cota esgotada continua recebendo `429` até o fim de sua janela, mesmo sob churn de cardinalidade;
- quando a capacidade exata está cheia, chaves inéditas compartilham um contador overflow sticky por classe de ação até o reset da janela. Existem no máximo 64 partições overflow; se uma nova classe exceder esse limite depois da remoção dos contadores expirados, a admissão falha fechado. A pressão de uma ação não reinicia a cota exata de outra, embora o compartilhamento conservador possa rejeitar chaves legítimas da própria classe;
- a camada in-memory continua limitada ao processo e não substitui o limiter obrigatório da borda, necessário para absorver tráfego hostil e coordenar qualquer futura execução com mais de uma instância;
- normalizar IP confiando apenas em proxy configurado;
- fail-closed para payment/admin;
- fail-open controlado para leitura baixa;
- resposta 429 genérica;
- métricas.

## 8. Upload

- signed URL curta;
- path derivado;
- MIME e bytes reais;
- limites;
- sem SVG;
- imagem decodificável;
- nenhum processamento shell com nome do usuário;
- cleanup;
- Storage RLS.

## 9. Headers

Nginx/Next:

- HSTS;
- CSP;
- `nosniff`;
- referrer policy;
- permissions policy;
- frame ancestors;
- remoção de `X-Powered-By`.

CSP inclui somente Supabase, provider de pagamento, YouTube privacy embed e origens necessárias. Alteração exige teste.

Na fundação local, a CSP permite somente a própria origem e dados/imagens necessários à tela técnica. Cada app gera no Proxy um nonce criptograficamente novo por request, envia a mesma política nos headers internos da renderização e da response e autoriza o bootstrap do App Router com `script-src 'nonce-<valor>' 'strict-dynamic'`. O Proxy cobre toda resposta, inclusive prefetches, caminhos apenas parecidos com endpoints reservados e o namespace `/_next/static/`: assets válidos preservam o cache imutável e erros de método, range ou path não escapam da CSP caso o framework os transforme em HTML. Produção não possui `unsafe-inline` nem `unsafe-eval` em `script-src`; `unsafe-eval` e conexões HTTP/WebSocket localhost existem somente em desenvolvimento para o runtime Next. O nonce não é secret, mas nunca é fixo nem reutilizado. Testes conferem a correspondência entre header e scripts do mesmo HTML, a renovação entre requests e o bootstrap real nos dois apps; o fallback global catastrófico é um documento mínimo sem JavaScript e sem cache. O smoke standalone repete esses contratos sem expor o valor do nonce em diagnósticos. Novas origens entram somente no PR da integração consumidora e com teste correspondente.

A stack Supabase local usa uma bridge Docker exclusiva com publicação efetiva somente em `127.0.0.1`. Antes de qualquer operação, inclusive `stop`, o bootstrap e os wrappers locais recusam `DOCKER_HOST`/`DOCKER_CONTEXT` remotos, exigem o contexto ativo `default` e comprovam o endpoint local documentado (`unix:///var/run/docker.sock` ou o named pipe padrão do Windows). Depois dessa inspeção local de metadados, todos os subprocessos operacionais Docker e Supabase recebem explicitamente esse endpoint somente no próprio ambiente, sem executar `docker context use` nem alterar configuração global. O bootstrap para apenas containers rotulados para o projeto `set-livre` quando encontra estado anterior inseguro, valida a matriz 54321–54324 depois do start e falha fechado se a bridge preexistente tiver configuração divergente. Todo comando Supabase mantém `stderr` em pipe privado e o descarta; comandos interativos preservam somente `stdout` herdado quando necessário. Em qualquer falha, buffers e erro original são substituídos por diagnóstico contendo apenas código ou sinal seguro, impedindo que URL de banco, chaves do status ou output sensível sejam impressos.

O empacotamento local usa a entrada direta `node scripts/release-manifest.mjs` e não herda o ambiente amplo do shell nos subprocessos: build, tar e smoke recebem uma allowlist operacional, complementada apenas pelo arquivo runtime específico de cada app quando aplicável. O preflight deriva a instalação npm do Node selecionado e valida imediatamente Node, CLI, ancestrais, manifests e versões fixadas antes do primeiro build. A fronteira confia no processo chamador, checkout e toolchain sem alteração concorrente por nenhum principal com permissão de escrita; não declara identidade atômica portátil entre arquivo e execução. Credenciais E2E/admin não chegam aos filhos, valores sensíveis conhecidos são procurados na release inteira antes e depois do smoke, e logs de falha redigem tokens, cookies, autenticação e URLs de banco.

Na release histórica do segundo P2, o gerador foi invocado uma única vez para `440c81f6...`; tar, smoke, guardas de segurança, secrets/PII e cleanup ficaram verdes. Ela não contém `20260815000100` nem valida o patch atual. A afirmação de que tampouco substituía PEND-003 ou o smoke ARM64 nativo pertence àquele snapshot pré-ADR-021; o gate operacional atual foi substituído pelo smoke Linux x86_64 na `VM.Standard.E2.1.Micro`.

O fato de `.artifacts` ser ignorado pelo Git não o torna uma fronteira confiável. Antes de qualquer mudança de modo, lock, build ou cleanup, a release Linux valida o mountinfo do namespace atual e recusa `.artifacts` montada. Diretórios gerados são percorridos somente por `lstat`, com links tratados como folhas, e mounts na raiz ou em descendentes são recusados antes do rename e novamente antes da remoção recursiva. Arquivos, links e nós especiais seguem contratos distintos e nunca são usados para atravessar um alvo externo. A checagem falha fechada quando não consegue provar a topologia, sem tentar desmontar ou apagar o volume.

Os processos Chromium, Firefox e WebKit também partem de allowlist própria e mínima. Nenhuma variável de banco, SSH, npm, Node, loader dinâmico, Snap ou secret conhecido é encaminhada pelo Playwright; valores operacionais ligados a caminhos Snap são descartados e o `PATH` não aceita entradas vazias.

O arquivo opcional `.env.e2e.local` também é uma fronteira privada: antes do parse, sua raiz e todos os ancestrais precisam ser diretórios físicos estáveis, e o alvo precisa ser arquivo regular exclusivo (`nlink = 1`), aberto com `O_NOFOLLOW` e revalidado pelo descriptor e pelo caminho antes e depois da leitura. Em sistemas POSIX, o owner precisa coincidir com o usuário efetivo e o modo precisa ser exatamente `0600` em todas essas observações; no Windows, não se simulam owner ou permissão POSIX inexistentes. Symlinks, hardlinks e trocas concorrentes falham fechado, e os diagnósticos nunca incluem o conteúdo lido.

## 10. Supply chain

- npm lock;
- `npm ci`;
- audit;
- actions fixadas por SHA;
- dependências justificadas;
- renovate/dependabot controlado;
- build reproduzível;
- nenhuma action não confiável em deploy.

## 11. LGPD

### 11.1 Consentimento

Termos versionados. Aceite grava versão/hash/data. Checkbox não pré-selecionado.

O `legal-core` da FEAT-002 materializa essa regra: versões vigentes não se sobrepõem, o hash SHA-256 é gerado pelo banco, a aposentadoria não pode ser retroativa, e dois fatos de aceite imutáveis são criados na mesma transação do perfil mínimo. A intenção opaca expira em dez minutos, é idempotente por `requestId` somente enquanto pendente, não contém e-mail e é apagada da tabela privada e de `raw_user_meta_data` no consumo; intenções expiradas são purgadas pelo próximo create. IP permanece nulo enquanto não houver proxy confiável; somente hash de user-agent é aceito como evidência minimizada. O seed `local_fixture` nunca representa texto jurídico aprovado.

### 11.2 Acesso/exportação

Usuário solicita na conta. Job gera arquivo privado/expirável com:

- perfil;
- aceites;
- estúdios próprios;
- reservas;
- transações permitidas;
- histórico de solicitações.

### 11.3 Correção

Perfil pode ser atualizado. Fatos financeiros são ajustados por eventos, não reescritos para apagar histórico.

### 11.4 Exclusão

Processo:

1. confirmar identidade;
2. criar request;
3. bloquear novos fluxos;
4. avaliar reservas futuras/pagamentos;
5. cancelar ou exigir resolução;
6. remover mídia não necessária;
7. anonimizar perfil;
8. revogar Auth;
9. preservar fatos mínimos;
10. registrar conclusão;
11. expurgar backups no ciclo documentado.

### 11.5 Retenção inicial

A confirmar juridicamente. Defaults operacionais:

- logs técnicos: 30 dias;
- audit financeiro/admin: conforme obrigação legal;
- uploads órfãos: 24h;
- export de dados: 7 dias;
- fiscal: conforme obrigação;
- backups do banco: 7 pontos diários no Supabase Pro; retenção maior ou cópia independente somente
  depois de implementação, custo e restore comprovados;
- webhook redigido: 90 dias ou necessidade de disputa.

## 12. Incidentes

Runbook:

- identificar;
- conter;
- preservar evidência;
- rotacionar;
- avaliar dados/impacto;
- comunicar responsáveis;
- corrigir;
- documentar;
- revisar controles.

## 13. Testes

- usuário A/B;
- role escalation;
- IDOR;
- origin inválida;
- body grande;
- webhook inválido/replay;
- upload spoof;
- log redaction;
- app público sem admin;
- export/deletion;
- CSP;
- secrets scan.
