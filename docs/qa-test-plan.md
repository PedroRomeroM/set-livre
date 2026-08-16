# Plano de QA e testes

## 1. Objetivo

Comprovar contratos de produto, segurança, dados, concorrência, acessibilidade e operação. Cobertura não é apenas percentual de linhas.

## 2. Camadas

1. format/lint/typecheck;
2. unitários;
3. guardrails documentais;
4. schema/grants/RLS;
5. integração local;
6. Playwright;
7. provider contract;
8. performance/carga;
9. deploy smoke;
10. restore drill.

## 3. IDs e rastreabilidade

Cada comportamento possui ID `SL-Fxxx-E2E-nnn`. IDs não são reutilizados. O catálogo completo está em `qa-traceability.md`.

Uma row marcada como `automatizado` somente é válida quando aponta para uma spec Playwright física e regular dentro de `tests/e2e/`, sem symlink no arquivo ou em seus diretórios. A spec precisa importar em runtime o binding nomeado `test` de `@playwright/test` (alias explícito é aceito) e registrar diretamente no módulo, ou no callback direto de `test.describe(...)`, uma chamada desse binding com callback e título literal (string ou template sem interpolação) contendo o mesmo ID estável. Comentário, constante, texto morto, binding local ou sombreado, função arbitrária, branch condicional, `describe` sem teste, título interpolado, outro arquivo ou spec sem o ID não comprovam automação; `test.only` e `test.skip` continuam proibidos pelo guard global.

Prioridades:

- P0: impede release;
- P1: deve automatizar antes da feature concluída;
- P2: pode entrar em regressão planejada com dívida formal.

Suítes:

- smoke;
- critical;
- regression;
- accessibility: axe e teclado na matriz explícita de claro, escuro e mobile;
- reflow: contrato dedicado de zoom 200%/viewport equivalente, executado nos três engines e sem substituir a regressão funcional.

## 4. Ambientes

E2E destrutivo somente local:

- host IPv4 literal `127.0.0.1`;
- Supabase local;
- adapter local determinístico, sem provider externo ou fake de produção;
- e-mail sink;
- prefixo QA;
- cleanup restrito.

O runner deve abortar antes de abrir browser se detectar production/acceptance host ou DB.

Quando `.env.e2e.local` existir, o preflight somente o lê como arquivo regular exclusivo sob ancestrais físicos, com identidade estável e, em POSIX, owner igual ao usuário efetivo e modo `0600`. A suíte unitária prova ausência opcional, ramo Windows, rejeição anterior à leitura para modo amplo, owner divergente, symlink, hardlink e ancestral simbólico, além de trocas concorrentes do arquivo e do ancestral sem expor o conteúdo em erros.

## 5. Projetos Playwright

- Chromium desktop;
- Firefox desktop para critical;
- WebKit desktop para critical;
- Chromium mobile 390x844;
- telefone estreito 320x720 em regressão;
- reflow equivalente a 320x720 com zoom 200%: layout viewport 160x360 nos três engines, com escala física 2 quando suportada pelo engine;
- height compact;
- backoffice desktop;
- axe em claro/escuro e nos viewports móveis de 390 e 320 px;
- safe-area móvel com insets não nulos.

A matriz completa pode distribuir specs, mas todos os P0 passam em Chromium e pelo menos um segundo engine nos fluxos críticos de auth/booking/payment.

## 6. Dados

Fixtures:

- visitor;
- renter A/B;
- owner A/B;
- reviewer/support/finance/admin;
- studios draft/published/paused;
- schedules/pricing;
- reservations/payments/refunds/payouts.

Dados nomeados `qa_<worker>_<test>`. Cleanup não usa wildcard amplo.

Na FEAT-002, cada execução cria e-mail/senha únicos sob namespace `qa_f002_*@example.test`. Mailpit é consultado somente em `127.0.0.1:54324`, por destinatário exato e limite temporal; o callback precisa ser único, usar origem/path fixos e carregar apenas `token_hash` + `type` no fragmento. O `finally` exclui a mensagem pelo ID e destinatário e o usuário Auth por UUID + e-mail parametrizados, sempre depois do preflight local. E-mails QA sintéticos podem aparecer somente nos títulos automáticos `Fill`/`Type`/`Expect` do Playwright, sob allowlist exata `qa_f002|qa_f003_*@example.test`; ficam proibidos em stdout/stderr, erros, attachments e logs da aplicação. Token, senha, URL admin e payload do provider não podem aparecer em nenhum desses destinos. As specs Auth sobrescrevem trace, vídeo e screenshot para `off`; a senha nunca entra no DOM nem em `fill`, `type` ou `keyboard`. Em um step estático de `Locator.evaluate`, o helper valida o realm do input, o form e o nome fechado `password|confirmPassword`, então instala um listener `formdata` one-shot que injeta o segredo somente no `FormData`, fora de `ariaSnapshot` e `error-context`. Uma execução real com sentinela deve terminar com varredura negativa da saída, do relatório e dos artefatos Playwright, permitindo somente as fixtures de e-mail no campo JSON de título automático descrito acima.

O rádio PF/PJ também usa o `FormData` como fonte canônica. O helper mantém o locator selecionado e confirma `toBeChecked()` imediatamente antes do submit, para detectar remount ou hidratação que pudesse restaurar o valor inicial antes de criar o usuário.

Sem criar ID, `SL-F002-E2E-001` inclui agora um BrowserContext com JavaScript desabilitado antes do caminho feliz. O fonte exige o `form` inerte com `method=post` e usa `toHaveAttribute("disabled", "")` no `fieldset` externo, nos controles `email`, `password`, `confirmPassword` e no submit, como prova estrutural do HTML streamed; pathname `/cadastro` e query vazia permanecem no contrato. A execução attribute-fixed comprovou esse ramo nos três engines dentro do mesmo ID e da contagem existente. No contexto hidratado, o cadastro continua sendo submetido pelo fluxo React. Separadamente, o unitário SSR renderiza o markup real e prova `aria-busy`, os sete controles nomeados disabled, status antes do formulário e snapshot de servidor `false`; a guarda estrutural fixa o snapshot de cliente `true` sem habilitação por efeito.

Transições Auth assíncronas aguardam a resposta HTTP exata, o destino sanitizado sem fragmento e o estado visual autoritativo. O fluxo não usa espera temporal fixa para compensar latência de logout, callback ou renderização SSR; a confirmação da sessão possui limite explícito maior que o timeout do comando público, para distinguir indisponibilidade real de carregamento ainda em curso sem registrar a URL sensível intermediária.

O contrato pós-merge do login classifica `NETWORK_UNAVAILABLE`, `REQUEST_TIMEOUT`, `RESPONSE_INVALID` e a resposta válida `AUTH_SESSION_RECHECK_REQUIRED` como desfechos ambíguos depois do envio/início de `setSession`: a prova deve verificar que a referência efêmera, o formulário e todo cache privado são redigidos antes do hard reload, que somente destinos internos allowlisted sobrevivem e que a composição SSR decide entre sessão ativa e entrada não confirmada. Apenas rejeições API comprovadamente anteriores à publicação continuam no mesmo formulário; a unidade de serviço reproduz cookie parcial e cleanup falho sem reclassificar o resultado como retryable.

O cenário `SL-F002-E2E-003` também deve expirar de forma determinística o grant exato no Supabase local, sem `waitForTimeout`, comprovar que o formulário deixa de ser funcional e que a sessão Auth criada pelo recovery não autentica `/entrar`. Setup e cleanup usam apenas helper local parametrizado, após o mesmo preflight destrutivo, e não imprimem token, scope, `session_id`, e-mail ou senha.

O contrato unitário do cache Auth prova keys distintas por `userId`, sentinela anônima sem e-mail/token, preservação do `initialData` SSR do usuário atual, remoção da família anterior e bloqueio de renderização durante refetch, inclusive quando a ausência de rede deixa `fetchStatus: paused` com `isFetching: false`. Um guard estrutural mantém SSR e a primeira hidratação no mesmo boundary fechado, sem `useQuery` ou assinatura direta do QueryCache nessa fase. Além de A→B, a suíte reproduz a mesma identidade com uma sessão antiga `active` já fresca no cache e uma resposta SSR atual `suspended`: o boundary desmonta o observer, remove a família e somente então monta outro observer sobre o seed SSR. Uma segunda revisão de props RSC no mesmo `LoginPanel` repete essa fase sem depender de remount do componente externo; um refetch autoritativo posterior não reinicia o preparo. Na troca A→B, a PII de A continua invisível enquanto a request está pendente e B nunca é renderizado sob a key de A; a UI limpa o cache e força nova composição SSR antes de publicar a identidade atual.

O contrato de cache recovery deve provar keys diferentes para `anonymous` e para cada UUID público, remoção de scopes antigos, rejeição da resposta divergente antes da escrita e ausência de grant, token, `session_id`, user ID ou e-mail na key. O formulário só pode ser autorizado por `allowed=true` com scope correspondente e `fetchStatus: idle`; `fetching` e `paused` permanecem no estado de verificação, mesmo quando uma resposta `allowed=true` já existe no cache. Mudança de scope remove as famílias recovery/session e exige nova composição SSR.

Uma rejeição pública retryable da atualização de senha precisa sobreviver ao ciclo `erro -> fetching/paused -> allowed+idle` no mesmo scope, embora o formulário seja desmontado durante a verificação. O snapshot testado contém apenas mensagem, scope UUID público e erros `password | confirmPassword`; decisão negativa, scope divergente, sucesso ou nova submissão o apagam.

Os testes de serviço tratam como terminal qualquer resultado ambíguo de signup depois do envio de `verifyOtp`, descartam a ref one-shot e exigem novo link. Eles também simulam publicação parcial no login e sign-out final inconclusivo no recovery: o fallback tenta apagar o cookie Auth base e todos os chunks numéricos observados, continua após uma deleção falhar, preserva cookies semelhantes/alheios e não expõe a falha causal.

Na projeção de preferência pós-login, a suíte injeta uma `get_my_profile()` retida, avança o deadline server-side de um segundo e exige fallback `system` por `AbortSignal`. Resolver ou rejeitar a RPC depois do encerramento não pode alterar cookie nem chamar `signOut`. A rodada focada de timeout passou em 37/37 e o auditor combinado passou em 96/96; a suíte unitária integral posterior passou em 578/578 testes distribuídos por 60 arquivos.

A extensão de segurança recovery deve validar `sub`, `session_id` e `exp` assinados, emissão de binding/grant apenas para a linha correspondente de `auth.sessions`, fechamento por expiração/consumo, marcador ausente/divergente e navegação fora da superfície permitida. A classificação precisa sobreviver à remoção dos cookies auxiliares por meio da tombstone; em contrapartida, uma sessão comum sem binding não pode sofrer logout por marcador residual. Testes do Proxy, read models e DAL cobrem cardinalidade estrita, limpeza exata e falha fechada sem expor contexto sensível.

O rate limiter unitário deve manter uma chave exata esgotada sob churn até o fim da janela, reutilizar um overflow sticky por ação quando os 10.000 buckets exatos estão ocupados, isolar as partições, recolher entradas expiradas e falhar fechado para uma nova partição além do limite de 64 overflows. Compartilhamento conservador pode rejeitar uma chave legítima da mesma ação; evicção de bucket vivo ou reinício silencioso de cota é regressão.

O teste unitário do conteúdo jurídico cobre CRLF, parágrafo multilinha, headings ATX, omissão do `h1` duplicado, listas ordenadas e não ordenadas, início ordinal diferente de um, `strong`, `em` e links internos/HTTPS. A prova do renderer usa markup estático real para conferir a semântica e o escape de HTML. `javascript:`, `data:`, HTTP, destino protocol-relative, credenciais, barra invertida e separador codificado são rejeitados sem perder o rótulo; um guard adicional impede a introdução de `dangerouslySetInnerHTML`.

Na FEAT-003, cada execução cria identidade `qa_f003_*@example.test` e reutiliza confirmação, sessão e Mailpit locais da FEAT-002. CPF, CNPJ e documento adicional são sintéticos, estruturalmente válidos quando o cenário exige e inseridos somente por listener `formdata` one-shot sobre os nomes fechados `taxId | additionalDocument`; esses valores nunca passam por `fill`, `type`, `keyboard`, título dinâmico ou asserção que os imprima. As quatro specs sobrescrevem trace, vídeo e screenshot para `off`. O `finally` remove por UUID/e-mail exatos a identidade Auth e as mensagens Mailpit e comprova a ausência das linhas correspondentes em `profiles` e `user_preferences`, sem wildcard. A cobertura mantém os IDs 001–005 e adiciona 006 para axe/teclado na matriz claro-escuro-mobile, 007 para reflow 160x360 nos três engines, 008 para projeção SSR e persistência da preferência e 009 para o boundary fechado durante `fetching`/`paused`, timeout, conflito e recuperação. O ID 003 também cola um prefixo internacional não-`55` e um telefone brasileiro formatado com dígito excedente, exige que a máscara preserve ambos, recebe erro local e prova zero comando antes das rejeições CPF/CNPJ.

No ID 004, o contexto auxiliar serve somente para provisionar B. A transição observada ocorre na mesma página, BrowserContext e árvore React de A: o login local troca a sessão sem navegar, um refetch retido mantém o QueryClient montado e o boundary remove toda PII de A. Quando o DTO de B chega sob a key de A, o guard de escopo limpa o cache e força nova composição SSR; uma sentinela de mutação até `pagehide` exige o marcador `clear`, varre somente `main`, comprova que heading, resumo, formulário e controles antigos estão desconectados e somente a página recomposta expõe B. Scripts Flight/RSC fora da UI não integram esse oráculo. As três projeções também exigem zero `pageerror`, zero erro React no console e B inalterado. A extensão P2 aciona ainda uma closure de logout capturada sob A depois de B ser autoritativo: após `getClaims`, a classificação precisa terminar antes de o fluxo obter explicitamente o cookie store e antes dos efeitos destrutivos explícitos de recovery, deleção de cookies ou `signOut`; B continua autenticado e inalterado. No ID 009, um perfil completo torna nome, telefone e máscaras visíveis antes da prova; refetch retido, `fetchStatus: paused` offline e timeout precisam remover cada um desses valores de texto e controles do DOM, além de preservar recuperação de timeout e conflito nas quatro projeções. A extensão de logout em ambas as superfícies exige exatamente uma request durante a tentativa offline e zero request tardia após reconexão.

O hardening de sessão exige ainda provas unitárias de que `expectedScope` é UUID obrigatório e estrito, mas nunca autoridade; `409 SESSION_CHANGED` ocorre antes do limiter específico de perfil, serviço e DAL; `SESSION_CHANGED`/`UNAUTHENTICATED` disparam a transição fechada; e os reseeds SSR de login, perfil e segurança descartam `MutationCache` e ambas as famílias privadas preservando queries públicas. Logout e login ambíguo devem continuar provando `QueryClient.clear()` integral. Nas duas superfícies de logout, a mutation precisa executar closure sem `variables` em `networkMode: "always"`. A prova admite que `getClaims` renove ou mantenha a sessão internamente, mas exige que a classificação termine antes de o fluxo obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw → `503 SERVICE_UNAVAILABLE`, erro/contexto assinado ausente → `401 UNAUTHENTICATED` e UUID válido divergente → `409 SESSION_CHANGED`. Os três ramos têm zero efeitos destrutivos explícitos de logout. A publicação autoritativa precisa ser exercitada com `QueryObserver` real para confirmar que o observer atual permanece ligado e com callback tardio de A após reseed B para confirmar que a key de A não é recriada.

Sem criar novo ID nem alterar a contagem do catálogo, o ID 004 cobre tanto o formulário vinculado ao `expectedScope` de A quanto a closure stale de logout depois de a sessão mudar para B; nenhum dos dois caminhos pode alterar B. O ID 009 cobre a alteração sensível e o logout offline sem mutation pausada: a tentativa de logout emite uma request e, depois da reconexão, zero request tardia. No snapshot funcional final, a rodada pós-ajuste de logout passou em 65/65, a suíte unitária integral passou em 578/578 testes de 60 arquivos e a matriz Playwright/axe integral passou em 91/91 numa única execução de 3,9 minutos, incluindo 32/32 da FEAT-003. O ID 004 passou em 3/3 projeções com `409` para o logout stale, sessão e perfil de B intactos e zero `pageerror` ou erro React; o ID 009 passou em 4/4 com falha offline imediata, exatamente uma request e nenhum POST tardio após reconexão. Lint, typecheck, audit com zero vulnerabilidade e Knip também passaram. Os builds Next.js 16.3 de web/backoffice ficaram verdes sem warnings, com manifests standalone, 17 arquivos obrigatórios e `BUILD_ID` local em cada app; os smokes validaram live/ready/root, CSP, `no-store`, assets, nonces, probes adversariais, `/entrar` 200 no web e 404 no backoffice. Lockfile/gerados ficaram inalterados, portas/processos sem resíduo e os logs têm hashes `2e3b…4310` e `c9e5…da97`. A release local canônica do commit `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7` foi gerada e auditada; o HEAD final `1530f62589` recebeu revisão Codex limpa, as cinco threads ficaram resolvidas e o PR #4 foi incorporado a `main` no merge `465d195`.

Na FEAT-004, os IDs 001–005 permanecem estáveis e os IDs 006/007 dedicam provas próprias a accessibility e reflow. “Sandbox” passa a significar apenas adapter local determinístico. O ID 001 cobre contrato vigente, checkbox não preselecionado, ativação atômica/idempotente e ausência de autoridade administrativa; 002 cobre `start -> pending`; 003 cobre `refresh -> active` e elegibilidade falsa após drift de `profileVersion`; 004 usa dois BrowserContexts com a mesma sessão para provar estado concorrente, `409`, bloqueio até GET autoritativo, nenhum replay do POST e depois conserva a recuperação de erro/timeout e as capabilities; 005 retém o GET de B na página/`QueryClient` de A, exige boundary antes do hard reload, inspeciona a desconexão de A no `pagehide`, recompõe SSR somente com B e exige zero `pageerror`/erro React; 006 executa axe/teclado/foco nas duas rotas; 007 provoca uma resposta real `503` pelo endpoint de comandos em 160x360, exige o CTA de verificação e observa um `GET /api/owner/recipient` real `200` antes de reabilitar a ação, nos três engines. O complemento de callback tardio do ID 005 é unitário, não browser: um `MutationObserver` real com latch impede publicação após a transição, e outra prova confirma que a key de A não é recriada depois do seed autoritativo de B. Ao acionar `Verificar estado atual`, os IDs 004/007 exigem que a superfície privada permaneça fechada durante o `GET` e usam `toBeFocused()` no heading do checklist após sucesso; uma falha da leitura mantém mensagem redigida e restaura foco programático no alerta seguro. O ID 007 parte então desse alerta, aciona `Tentar novamente`, observa um novo GET real 200 e exige novamente `toBeFocused()` no heading. O mesmo contrato verification-first deve receber `owner_contract_not_current` como `409`, enquanto `owner_blocked`, `recipient_blocked` e outros `42501` permanecem `403`. Helpers usam namespace `qa_f004_*`, cleanup exato e fixtures locais explícitas, sem comportamento de produção baseado em e-mail ou UUID.

No quarto P2, o mesmo ID estável `SL-F004-E2E-004` incorporou a capability do recebedor sem alterar o catálogo. Com `nextAction=start_onboarding`, um GET sintético válido muda somente `recipientOnboardingCapability` para `unavailable`: a UI deve exibir um alerta `role=status` com o título **Cadastro de recebimentos indisponível** e o corpo **A integração de recebimentos ainda não está disponível neste ambiente. O estado atual permanece somente para consulta.**, omitir o notice local e ambos os CTAs e manter zero POST. Ao voltar para `local_adapter`, o CTA de início reaparece. Depois de o estado factual avançar para `pending`/`refresh_status`, a alternância se repete: `unavailable` remove o CTA de refresh sem aumentar o contador de POST, e `local_adapter` o restaura. O oráculo passou na rodada focada 23/23 e na integral 114/114 daquele delta; essa evidência é histórica para o quinto P2.

No quinto P2, o fonte do ID 004 acrescenta, antes do fluxo de recebedor, uma resposta completa `activation` com contrato `local_fixture`. Em `ownerActivationCapability=unavailable`, título, corpo e aviso de fixture continuam legíveis, o alerta mostra exatamente **Ativação como dono indisponível** e **A versão aprovada do contrato do dono ainda não está disponível neste ambiente. O contrato atual permanece somente para consulta.**, checkbox/formulário/CTA ficam ausentes e o contador de POST permanece zero. Alternar somente a capability para `available` restaura aviso, checkbox e CTA sem disparar POST. O ID, a spec, os projetos e os totais permanecem iguais. Depois de corrigir a race do publisher, a focada passou em 23/23 por quatro specs/14 projetos, com privacidade e cleanup verdes.

O primeiro review draft acrescenta um guard estrutural de projeção: ativação deve validar exatamente 21 colunas com corpo, enquanto recebimentos valida exatamente 16 sem título, versão textual, hash ou corpo. Testes unitários cobrem RPCs/GETs/query keys distintos, resposta compacta de `start | refresh`, rejeição de mistura entre projeções e a classificação de `VALIDATION_FAILED` com e sem `fieldErrors`. As fotografias 23/23 e 114/114 imediatamente abaixo pertencem ao snapshot publicado anterior; a evidência aceita do commit posteriormente revisado `3e3f866c42302df9b0499e9af75575c7c092f3f0` está registrada depois delas e não valida os P2 locais posteriores.

As duas threads desse primeiro review foram respondidas e resolvidas. O segundo review `PRR_kwDOTyzZrs8AAAABJV08Cw`, submetido em `2026-08-12T22:59:35Z` sobre `3e3f866c42302df9b0499e9af75575c7c092f3f0`, abriu `PRRT_kwDOTyzZrs6YwM7k`: o teste de serviço precisa provar que somente a dupla `42501 + owner_contract_not_current` vira `409 CONFLICT`, que bloqueios continuam `403 FORBIDDEN` e que mensagem/detalhe privados não vazam. O teste unitário daquela correção prova essa classificação exata. A rodada browser histórica comprova a regressão do boundary verification-first genérico de `CONFLICT`, sem alegar que o E2E injeta diretamente a mensagem SQL privada. O patch foi publicado até `011a48f4910baa0e17b26dee6eda3c678d910572`; a thread recebeu `PRRC_kwDOTyzZrs7h4a21`/REST `3789663669` em `2026-08-15T15:36:08Z`, foi verificada e resolvida por `PedroRomeroM` ainda não outdated.

O contrato de entrada nas rotas do dono também prova a allowlist literal de retorno: a query pública usa `retorno`, o payload validado usa `returnTo`, e somente `/conta`, `/conta/seguranca`, `/dono` e `/dono/recebimentos` atravessam a borda. Sucesso e transição ambígua preservam o destino; open redirect e formas alternativas falham fechados.

Na fotografia pré-review, a suíte unitária integral passou em 707/707. A rodada estática de privacidade passou em 11/11; format, ESLint, typechecks, docs:check, audit com zero vulnerabilidade, Knip, a coleta estática de 23 testes Playwright e o diff-check também passaram.

A primeira matriz browser foi interrompida depois de um locator ambíguo causar uma falha e deixar 22 testes sem execução; o locator foi corrigido com `exact: true`. A execução seguinte chegou ao ID 005 e encerrou em 7 testes passados, uma falha e 15 não executados porque, depois do hard reload, o oráculo tentou `fulfill` de um POST já tratado e recebeu `Route is already handled`. Os dois desfechos são históricos, inconclusivos e não caracterizam falha de produto.

A invocação específica pré-review executou as quatro specs FEAT-004 em cerca de 2,0 minutos e terminou em 23/23, exit `0`, por 14 projetos, com zero resultado inesperado, skip, flake, erro ou attachment. A distribuição dos IDs 001–007 foi `3 + 3 + 3 + 4 + 3 + 4 + 3`. O `index.html` histórico tem SHA-256 `69c9490980cf67ce15990f87bb708fef0e685c7307654158162af723c212a075`. Os sete IDs FEAT-004 permanecem `automatizado`.

As quatro specs FEAT-004 sobrescrevem trace, screenshot e vídeo para `off`. Essa é uma exceção deliberada à captura em falha: o provisionamento atravessa PII sintética e as operações privadas contêm referências que não podem ser persistidas em artefatos. A evidência equivalente usa respostas HTTP observadas, locators semânticos, contadores de request, asserções de DOM e varredura negativa; falhas devem produzir mensagens estáticas redigidas.

Na execução final 23/23, a auditoria encontrou zero sentinela, token, cookie Auth, URL de banco, documento cru ou referência privada do provider. Os 26 e-mails QA únicos apareceram em 26 ocorrências, exclusivamente no campo `title` dos steps `Fill` do JSON ZIP do relatório; nenhuma ocorrência apareceu em erro, attachment ou outro destino. Cleanup de banco, Mailpit, portas e processos terminou em zero.

A primeira matriz integral pós-FEAT-004 terminou funcionalmente em 114/114, mas falhou no critério de evidência privada: 18 telefones QA ficaram registrados em 61 títulos `Fill` e quatro snippets. O helper de telefone passou a receber o valor como argumento de `Locator.evaluate`, chamar o setter nativo de `HTMLInputElement.value` e disparar um `InputEvent`; os sete call sites usam esse helper e não `fill`. Esse run permanece somente como diagnóstico histórico.

Ainda naquela fotografia pré-review, a nova matriz integral limpa foi executada em uma única invocação Node 24, `workers=1`, `max-failures=1` e `retries=0`: 114/114 passaram, exit `0`, em cerca de 5,9 minutos, cobrindo 17 specs e 16 projetos. O relatório histórico tem SHA-256 `b20aafd7e0dd20dbe6bddee837277c8f4a150202ca69c02388286c3a5ebb6076`.

A varredura encontrou zero ocorrência dos 28 telefones QA, inclusive formatos e sequências, zero step sensível `Fill`/`Type`/`PressSequentially` e zero sentinela, token, cookie Auth, URL de banco, referência privada do provider ou documento QA. Os 88 e-mails QA únicos apareceram em 140 ocorrências somente em títulos allowlisted: FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Cleanup de banco, Mailpit, portas e processos terminou em zero.

Na fotografia integral anterior ao novo P2, os gates Node 24 passaram em format, lint com zero warnings, typecheck integral, 716/716 unitários em 74 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check; o banco permaneceu em 355/355. A execução focada foi única: 23/23, quatro specs, 14 projetos, 126,0 segundos, IDs `3 + 3 + 3 + 4 + 3 + 4 + 3` e zero resultado inesperado, flake, skip, erro, retry ou attachment. SHA-256: relatório `64f80b00b8846a8157fe31708f95c28203ec5a843d383a75ae5b846e823c6df5`, `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903` e stdout `9937c3af59131be284ad176f49c289cc6e713e77e20bc015c436f42c06abf757`. A auditoria aceitou 26 e-mails em 26 títulos `Fill` e zero dado sensível fora da allowlist. Essa prova pertence ao commit revisado `3e3f866c42302df9b0499e9af75575c7c092f3f0`, não ao patch local posterior.

O guard integral da mesma fotografia coletou 114 testes em 17 specs; a execução única passou em 114/114 por 16 projetos, em cerca de 5,7 minutos, com zero resultado inesperado, flake, skip, erro, retry ou attachment. A FEAT-004 permaneceu em 23/23 na mesma distribuição. SHA-256: relatório `c2143d928e122aef944ead5c5999287828446c5f1d081c11daa0a33240f7f66f`, `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`, stdout `27092f939a36f3dde07eeb3c27ec3bf52cace5d034243591ad04748b0f3fe559` e lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`. A auditoria encontrou zero dado sensível e zero telefone; os 88 e-mails ficaram nas 140 ocorrências allowlisted. As 15 relações do banco, Mailpit, dblink, portas, processos e temporários terminaram em zero.

O build canônico da fotografia anterior ao novo P2 foi executado uma única vez em Node 24: `npm run build` terminou com exit `0`, 26 rotas web e quatro do backoffice, sem rerun; log SHA-256 `ae46bace1364f77876042025799515a6be0f78ef48afea0d6f343c12ed0d7e68`. O smoke runtime da mesma fotografia também terminou com exit `0`; log SHA-256 `85db0dad1e7cbd999e4427222fdd1b685a3747ffde154eb5a46b444e9cf8f735` e server log redigido `4da1f9af3e0bb34285be99be0ef71d4cefa22108bbe817c23c4c8983828755bf`. Root/prefetch, API, erros globais, live/ready, estáticos, adversarial, CSP/nonces, admin e isolamento ficaram verdes. A FEAT-004 provou `401`/UUID nos dois GETs guest e no POST sintético com Host/Origin exatos sem cookie, além dos redirects streaming exatos das duas rotas. Foram 14 nonces web e 11 backoffice únicos; as 15 relações ficaram `0 → 0`, e secrets, PIDs, portas e temporários terminaram em zero. Esses resultados não validam o patch local atual.

Duas tentativas customizadas foram recusadas pelo harness antes de qualquer spawn, servidor ou request — primeiro pela ocorrência pública de `E2E_BASE_URL`, depois pela ocorrência rastreada de `E2E_DATABASE_URL` em `package.json`. O scanner final path-aware/canônico passou e reconheceu a URL administrativa somente na ocorrência exata esperada. Esses rejects não são execuções falhas do produto nem do smoke final.

O gerador de release foi executado uma única vez sobre o commit funcional `440c81f6cc44cc95ed281d84e9a5124ae98a59c4` e terminou com exit `0`; log SHA-256 `be9e2e2d0d1d2a4db78593c03858c183f93b3ed336bd820d3ce9d64c08ec1ba4`. O archive canônico local histórico do segundo P2, com 24.902.563 bytes, tem SHA-256 `f52210ee52a73a7fda68ee7bf389c4c26e7bd896c4c61f5775ca72ee42913b59`, o sidecar tem SHA-256 `a8082ee69d311a46c8e323913f1aa13d62c726e7b4206942c4309d2c6f56fb4e`, e o manifesto de 681.311 bytes tem SHA-256 `99d673708449287898424deec5188318d3fa329101a704dfd67859fabaf47b82`. Tar, sidecar, smoke embutido, guardas de segurança, buscas de secrets/PII e cleanup passaram; esta evidência inclui somente aquele patch no recorte local Linux x64, não a correção de auditoria, ARM64 ou produção. A release `79376b62...` permanece histórica.

Após o segundo P2, Node 24 passou format, lint sem warnings, typecheck integral, 718/718 unitários em 74 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check. Um único reset seguido de `test:db` passou em 355/355, com cleanup verde. A focada histórica foi única e passou em 23/23, quatro specs/14 projetos: relatório/stdout/lista SHA-256 `66a4b5ceea14c7affa848748c525adccf684641b377f755a3a9ce3fb05aec6c6`/`ba57e0bd52d165bf422fccc6500eb4fb920c48f785a226baac24e8265c11fe0c`/`ed851b7bca361d0e3e50b5632f12251859b5098a12123a2ee2b8ebbb6f11bf59`. A integral histórica também foi única e passou em 114/114, 17 specs/16 projetos: relatório/stdout/lista SHA-256 `b68c70ff6f17f55142d11394dd9b6113958a7e49ef82d2c5c70324dfcafe6227`/`7b8b7971f91e8a571cec6ac8bb63fed665bbfcd1b9ead4997a6e0436b76114bc`/`322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6`. Privacidade e cleanup ficaram verdes naquela fotografia.

O build e smoke históricos do segundo P2 terminaram verdes com os hashes registrados; eles não validam a correção de auditoria.

A tentativa recusada do runner e a release `440c81f6...` pertencem ao snapshot histórico anterior; a release canônica histórica do terceiro P2 é a fotografia independente `2a86acc4...`, descrita abaixo.

O terceiro P2, `PRRT_kwDOTyzZrs6ZhR_d`/REST `3789698299`, mostrou que a auditoria recebia a `idempotencyKey` do browser no lugar do `requestId` da API. O contrato de teste mantém dois UUIDs distintos: `R` percorre rota, serviço, DAL e SQL até `audit.events.request_id`; `I` permanece em `idempotency_key` e nas tabelas privadas de replay. A suíte de banco prova no pós-estado ativação/renovação e transição do recebedor, unicidade por `(action, target_id, I)`, replay com o mesmo `I` sem novo fato, overload antigo ausente, grants novos exatos e readiness no head `20260815000100`. A migration implementa a cópia de `request_id` legado para `idempotency_key` sem fabricar `R`; não houve ensaio de upgrade com linhas pré-existentes que permita afirmar que o backfill foi testado.

Na fotografia do terceiro P2, `npm ci` concluiu com 447 pacotes e auditoria em zero; format, lint, typecheck, os quatro arquivos unitários focados em 42/42, a guarda estática de privacidade em 12/12, a suíte unitária integral em 718/718 por 74 arquivos, docs:check 34/200/18, `npm audit` zero, Knip e diff-check passaram. Um único reset, geração e `test:db` passou em 358/358 (`158 + 78 + 57 + 65`), com gerados/diff limpos, head aceito, anterior recusado e tabelas finais em zero. Essa evidência é histórica para o quarto P2.

A focada P3 anterior permanece verde em 23/23. A primeira integral do snapshot ainda sem a correção do oráculo terminou em 79 passados, uma falha e 34 não executados no `FOUNDATION-E2E-008` WebKit por navegação HMR na mesma página. Esse run não foi repetido e permanece diagnóstico histórico; relatório SHA-256 `ac669d0a2f8056e1b68c44317e9e679cc367daeb5c9a71435ba2f1e6d40ca7ff`. O teste foi separado em páginas distintas, com arquivo SHA-256 `7ae803488af54ea58bd06be7820c69c69460ed9038b1b9a5f17e5507d24999a7`; o crítico corrigido passou em 3/3.

A integral corrigida passou exatamente em 114/114, 17 specs e 16 projetos, preservando 23/23 da FEAT-004. Privacidade e cleanup ficaram verdes. SHA-256: relatório `5abbdc7696273dcf24df6353dea014f9e6dc0738824783171e978cf19d8c2e44`, stdout `a630adc06adb9d461bb9b2fa7d2cc43d8dcf8470312b19b517178ca4f409d678`, lista `322ae32bc132bca0afcd30d4af55d37d4ec31977742e9d721999ab2664e924c6` e `.last-run.json` `91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903`.

O build do terceiro P2 foi executado exatamente uma vez e passou com exit `0`, 26 rotas web, quatro do backoffice e zero warning; log SHA-256 `8677b868a632e0891499c8450e5c926ddefcde7e27c5d31f9adcb55e27bbfaa2`. O smoke customizado daquela fotografia também foi executado exatamente uma vez e passou com exit `0` em 2,4 segundos: três probes guest `401` com UUID, dois redirects exatos, 14/11 nonces, banco/Mailpit `0 → 0`, privacidade e cleanup verdes. SHA-256: stdout `399d3b41dd9d161bdd86288c53e5bf821279285eb4772740c9ff5169845e5abd`, server log `e3c376cdc9403d2739ea8f127244fef193ea0ad4689694fec5c8a097d5ee025b` e resumo `25262fb6efbf93a0a654a16171bc4f6998000ef0078b9d91e40a06beefe79450`. Os hashes 23/23, 114/114 e build/smoke anteriores continuam históricos; nenhuma release valida a capability nova.

A release canônica local histórica do terceiro P2 foi gerada e auditada para o commit funcional `2a86acc4dc3a005213d5f22384084e3aba0160be`. Archive/sidecar/manifesto/log possuem 24.903.588/124/681.529/2.099 bytes e SHA-256 `0e0c07f41d4a44f0673ce7a5013084942100e8baab1ba72ee6aeea6496be1566`/`1136df426039335971d515497ce8974dcb25ee583f3764d5c33f9ea1f76ca0ab`/`d3bfb5a5c517edab1004bde6eaf04c7f080c3036c94defbbfa1b82fad44d4d44`/`e7edaa919daa3b3ed4cd6cf1588c044d2a6efcf1ae84e9877edd5fa42062371e`. São 2.870 artefatos e 3.454 membros no tar; os dois `BUILD_ID` equivalem ao commit, com 15 migrations/head `20260815000100`. Smoke, secrets/PII e cleanup final ficaram verdes em Linux x64, Node 24.18/npm 11.19; duas auditorias independentes terminaram `NO-BLOCKER`. Essa release não contém nem valida o quarto P2.

Na captura remota histórica em `2026-08-15T19:38:32Z`, a publicação do terceiro P2 estava verificada até `dda95b3b9108930489a3b10275ef41c2f203ae24`; o PR estava `OPEN`/draft, `MERGEABLE`/`CLEAN`, sem reviewDecision nem checks no rollup. A resposta `PRRC_kwDOTyzZrs7h6HnW`/REST `3790109142` e a resolução atual/não outdated daquela thread foram confirmadas, com zero threads não resolvidas naquele instante.

O quarto P2 veio do review `PRR_kwDOTyzZrs8AAAABJrjWnQ`/REST `4944615069`, submetido em `2026-08-15T20:02:30Z` sobre `11464a37593d510f5774af6af6fe655e671a9c35`; a thread `PRRT_kwDOTyzZrs6ZigTV`, comentário `PRRC_kwDOTyzZrs7h6SPS`/REST `3790152658`, estava atual e não resolvida na captura. A matriz unitária exige `APP_ENV local | test -> local_adapter` e `development | production | ausente | inválido -> unavailable`; o serviço deve recusar start/refresh antes de reservar operação. `tests/unit/recipient-provider.test.ts` contém `derives APP_ENV=%s as capability %s`; `tests/unit/owner-service.test.ts`, `refuses recipient onboarding %s in APP_ENV=%s before reserving an operation`; `owner-read-model` valida ambos os valores, `owner-api` exige o campo, e `owner-ui` cobre start e refresh sem alterar autoridade ou `nextAction`.

O quinto P2 veio do review `PRR_kwDOTyzZrs8AAAABJsAUGQ`/REST `4945089561`, submetido em `2026-08-16T01:07:18Z` sobre `0decf00`; `PRRT_kwDOTyzZrs6Zj15h`, comentário `PRRC_kwDOTyzZrs7h8LaV`/REST `3790648981`, estava atual, não resolvida e não desatualizada. A matriz unitária prova `approved -> available` em todos os ambientes; `local_fixture -> available` somente em `local | test`; `development | production | ausente | inválido -> unavailable`; campo obrigatório somente em `activation`; leitura completa consultiva; projeção compacta sem o campo; `503 SERVICE_UNAVAILABLE` antes de `activateOwnerProfile`/escrita; e decisão visual sem form/checkbox/CTA. O snapshot pré-hardening passou em 747/747 unitários e 358/358 no banco; a prova pós-hardening é registrada abaixo.

A primeira rodada browser focada coletou 23 testes em quatro specs/14 projetos — lista SHA-256 `615bf589...` — e terminou uma única vez com exit `1`: 12 passados, falha em `SL-F004-E2E-001`/`critical-webkit`, dez não executados e zero rerun. O provisionamento submeteu o cadastro antes da hidratação e expôs campos sintéticos na query por fallback GET. Essa é uma falha real de privacidade da FEAT-002, não evidência da capability P5; o ID 004 não foi alcançado e a integral não iniciou. Somente stdout redigido `f4d0595a...` e auditoria `13859c3c...` foram preservados; os brutos foram removidos sem reproduzir valores/endereço e o cleanup ficou em zero.

O boundary SSR corrigido passou em 2/2 unitários próprios e em 22/22 na guarda combinada da identidade. A cadeia estática pós-hardening passou em Node 24/npm 11: `npm ci` 447 instalados/451 auditados/zero vulnerabilidades, format, lint, typecheck, 749/749 unitários em 75 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check. Uma asserção auxiliar incorreta do hash de `next-env` interrompeu a orquestração após typecheck; a continuação autorizada executou somente os gates restantes, e nenhum gate do projeto falhou.

O banco pós-hardening passou em 358/358 (`158 + 78 + 57 + 65`), com gerados byte-identical, 15 migrations/head `20260815000100`. A pausa atravessou reset/geração; a primeira invocação `test:db`, interrompida após `0001`, é inválida e teve cleanup limpo. Uma única nova invocação autorizada, sem novo reset/geração, passou integralmente.

A focada race-fixed anterior passou em 23/23 por quatro specs/14 projetos, e seu reuse foi validado pela auditoria final. A rodada attribute-fixed coletou 114 testes em 17 specs/16 projetos e sua única execução passou em 114/114 em 5,6 minutos, com zero retry, erro ou attachment. A FEAT-004 permaneceu em 23/23, com IDs 001–007 em `3 + 3 + 3 + 4 + 3 + 4 + 3`; a extensão no-JS da FEAT-002 passou em Chromium, Firefox e WebKit sem criar ID ou contagem.

A auditoria contou 140 ocorrências dos 88 e-mails QA apenas em títulos allowlisted: FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22. Secret, sentinela, URL de banco, JWT, cookie Auth, query sensível, senha/token, telefone, documento, referência de provider e corpo contratual ficaram em zero; cleanup também terminou em zero. Evidência segura: `.artifacts/p5-owner-activation-capability-attribute-fixed/full.audit.json`, SHA-256 `5704c67cf21bdcc6e92b733bfdb8788972c216d48f850c885200b6d4d78a37d6`.

As execuções rejeitadas anteriores permanecem histórico diagnóstico: a primeira revelou o defeito pré-hidratação já corrigido, e as demais registram problemas de harness/oráculo. Nenhuma caracteriza falha atual do produto. Static 749/749, DB 358/358, focada 23/23 e integral 114/114 formaram o fechamento browser anterior ao hardening de build.

O build P5 foi executado exatamente uma vez sob Node 24/npm 11 e terminou com exit `0`, 26 rotas web, quatro do backoffice, zero warning e `BUILD_ID=local`; o log privado tem SHA-256 `3b03b8f64e70dcf29e713f8b6ab006f4a544e43fd761ce0eb8b283eac9de432c`. A auditoria, porém, recusou o artefato: o standalone copiou do manifesto raiz strings locais administrativas/DAL que estavam inline em `scripts.knip`. Não houve smoke (`0`). O fix deixa o script exatamente `knip`, reutiliza o `.env.e2e.local` físico já carregado pelo config e fixa uma unidade que rejeita `E2E_DATABASE_URL`, `DATABASE_URL_APP_DAL` ou URI PostgreSQL em qualquer script npm dos quatro manifests canônicos — raiz, backoffice, contracts e UI. Prettier/ESLint direcionados, 4/4 unitários, `npm run knip` com as sete variáveis E2E explicitamente unset e diff-check passaram; o lockfile não mudou. A execução pós-manifesto que testou esse fix está registrada abaixo; release e operação remota continuam bloqueadas.

A build pós-manifesto seguinte terminou uma única vez com exit `0` e log privado SHA-256 `d8e50e0fb0b7080bf021aa910bef7ededc6677ba6dfaa71d4789a1d6226e1a8e`, mas o audit recusou uma ocorrência DAL em cada cache Turbopack; standalone/static/log ficaram limpos e o smoke permaneceu em zero. O wrapper único `scripts/next-build.mjs` atende os dois package scripts e o gerador de release: dentro da operação primária, o resolver confiável valida app/toolchain física antes do spawn, e o wrapper sempre tenta o cleanup físico do cache, inclusive em falha da validação/build. Cleanup falho aborta, falha dupla vira `AggregateError` e raízes/ancestrais simbólicos ou externos são recusados sem spawn/travessia. O preview executa cleanup no supervisor pai depois do grupo de build e antes de validação/servidor; falha bloqueia o start, cache persistente reprova e a integração prova remoção do DAL sintético. O run final passou em 40/40 por quatro arquivos — 12 de cache/wrapper, quatro do npm confiável, 16 de Next/local server e oito do supervisor de preview — com ESLint, checks Node, Knip env-unset e diff-check verdes. O 31/32 diagnóstico anterior refletiu apenas texto esperado antigo, corrigido no oráculo.

A cadeia estática final única ficou verde em Node 24/npm 11: npm ci 447/451/zero vulnerabilidades, format, lint zero, typecheck web/backoffice/contracts/UI/testes, 764/764 unitários em 76 arquivos, docs 34/200/18, audit zero, Knip/diff-check e freeze 53/34/19. Depois da remoção física dos dois `.next`, a build final via wrapper foi executada exatamente uma vez e passou em 14,733 s; log de 2.155 bytes/SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. O audit independente SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d` terminou `NO-BLOCKER`: 26 + 4 rotas, warnings/cache/retired/resíduos zero, quatro `BUILD_ID=local` e privacidade/inputs/cleanup verdes. Esse era o fechamento pré-release.

O gerador canônico processou `2045d1a00c15889007b3c5c04c08d0467fc3d9b3` exatamente uma vez, exit `0` em 21,26 s. O primeiro smoke P5, embutido, ficou verde antes da publicação local do archive. Manifesto e tar fecharam 2.871 artefatos sem mismatch; tar com 3.455 membros. Duas auditorias `NO-BLOCKER` comprovaram zero cache, secret, env, PII, incoming/retired, porta, processo, relação DB residual, Mailpit ou dblink. A release local não foi publicada; o próximo fluxo é commit docs → push → body/reply/resolve → novo review/60 min/captura → ready/merge. ARM64/PEND-003 permanece separado.

No fechamento histórico do quarto P2 em Node 24, `npm ci`, format, lint, typecheck, 734/734 unitários em 74 arquivos, docs:check 34/200/18, audit zero, Knip e diff-check passaram. Reset, geração e `test:db` ficaram verdes em 358/358 (`158 + 78 + 57 + 65`), com 15 migrations/head `20260815000100`. A rodada focada passou em 23/23, quatro specs e 14 projetos; SHA-256 auditoria/stdout/relatório/lista `49d457c85e3489703ce1c316e83228e40b003d384b492d86830676b832262c0b`/`f525446c0f4b5e61f32179e4d8cdb94e3f3ccc79601be889dfd30d79d3574e2b`/`112ff3b8603ed644260e94218a66bbd96c6f2fc80e7b806ff61a54a29ef984a3`/`7946ed316c84b9992b202787c7db937620b84769b14a6edef790d7791ee8f6af`. A integral passou em 114/114, 17 specs e 16 projetos; hashes `438da6bc8f6a557d9e97006a94dc3ce31505b9d061718c6c9b7b51e493bee8aa`/`c6a76b42d4fc838c7c7b2b84fede68da343f933b9602e2a23cd6c24ccedf2d7e`/`8bd8f19266a9ce8dee5aefafa52059835fe524b2595333785019cf033409c89c`/`293848081639eaeb419208f3279470460638a7476e8debe752cc49933182a492`. A primeira auditoria integral falhou somente ao montar o resumo por `ReferenceError: mailpitTotal is not defined`; a correção associou o campo ao valor já calculado e passou sobre os mesmos artefatos, com uma execução Playwright, zero rerun e zero flake.

Um único build passou com exit `0`, 26 rotas web, quatro do backoffice, `BUILD_ID=local` e log SHA-256 `ca7d5c3e98449ea03a4cedbc567d93f989db7dbfdac854ea1a19f40f0c26b0b3`. O smoke customizado não ficou verde. A tentativa 1 foi recusada por um oráculo incorreto de tombstone de cookie (`e30eb0...`/`fa8974...`/`2f1a9d...`); a tentativa 2 terminou com exit `1` apesar de cumprir três boundaries, dois redirects, 14/11 nonces, privacidade e cleanup, porque o postcheck confundiu o shell pai com descendente (`d84519...`/`7c9b2c...`/`63b674...`); a tentativa 3 foi recusada antes dos probes porque o parser não aceitava `pgrp=0` (`bcd359...`/`b70a26...`). O cleanup foi zero nas três. Nenhuma é apresentada como smoke aprovado.

O gerador canônico executou exatamente uma vez para `969f30cd0f34b7e36e2a21550b5e3f28f8709406`, terminou com exit `0` em 21,15 segundos e produziu a release local auditada. Archive/sidecar/manifesto/log possuem 24.904.533/124/681.762/2.102 bytes e SHA-256 `d5f544bff8b72314060535333cd2c300a4c56a4e35295c1471beec5ee41cfeeb`/`f3441aee4c9d6758a539b2be2b3b325805bd6d977ad2cf915619bfbb9cd4d8d3`/`bc13a94c4084abc46bab677d1115871cb1327d7d17172b982b886c35eb200ada`/`5be766c1c967ab7840335c120f2918ff555770efd69544f164023c32378456e7`. São 2.871 artefatos e 3.455 membros no tar, com web 1.578, backoffice 1.276, 15 migrations e ambos os `BUILD_ID` iguais ao commit. Smoke embutido, secrets, paridade e cleanup ficaram verdes; duas auditorias independentes terminaram `NO-BLOCKER`. A evidência vale apenas para Linux x64.

O push até `e51ab6fcda041e3a9571477fe696dd7ec69e87e5` publicou o funcional `969f30cd...` e a documentação/evidência da release canônica local. O archive permaneceu local e ignorado pelo Git; não houve publicação em GitHub Release. O body do PR foi atualizado. A resposta `PRRC_kwDOTyzZrs7h8CsL`/REST `3790613259`, criada em `2026-08-16T00:43:03Z`, foi confirmada na thread `PRRT_kwDOTyzZrs6ZigTV`, que ficou resolvida e outdated por `PedroRomeroM`. A leitura pós-write encontrou cinco threads, todas resolvidas. Naquela fotografia, o review seguinte, a espera mínima, a captura final, ready e merge ainda não tinham ocorrido; não havia claim de reviewDecision ou checks remotos. O quinto review posterior e os gates pendentes de sua correção estão descritos abaixo. PEND-003 e smoke ARM64 permanecem pendentes.

Em toda execução com navegador, o ID 004 recebe uma sentinela exclusiva em `FEAT003_REPORT_SECRET_SENTINEL`. A saída capturada, o relatório HTML e a árvore de resultados Playwright devem passar por varredura negativa exata dessa sentinela e da senha derivada; ocorrência em qualquer um desses destinos falha a execução. O helper de troca de sessão recebe a credencial somente como argumento de um step `evaluate` estático, não a devolve e converte falhas de avaliação ou contrato em mensagens constantes. Na evidência integral publicada anterior, os 62 e-mails QA únicos ficaram restritos a 102 títulos automáticos allowlisted. No snapshot funcional final, a auditoria terminou com zero resultado inesperado, flake, skip, erro ou attachment e zero ocorrência de sentinelas, tokens, cookies Auth ou documentos crus. Os mesmos 62 e-mails QA únicos apareceram em 114 títulos allowlisted: `Fill` 84, `Visible` 18, `Count` 4 e `Type` 8. O cleanup de banco, Mailpit, portas e processos terminou sem resíduos.

## 7. Testes de banco

SQL/integration deve provar:

- migration from zero;
- grants manifest;
- `TEMPORARY` ausente efetivamente para `PUBLIC`, `app_dal` e login runtime, sem remover grants explícitos administrados pela stack;
- RLS A/B;
- personas adversariais owner/admin ainda sob `authenticated`: metadata não concede autoridade; veem somente dados próprios, não escrevem tabelas nem executam rotinas privadas. A autoridade FEAT-004 nasce apenas em `owner_profiles` por comando `app_dal`, e papéis administrativos continuam diferidos para a FEAT-031;
- private functions inaccessible;
- status checks;
- revision immutability;
- allocation exclusion;
- idempotency;
- amount/split;
- webhook unique;
- payout/refund invariants;
- cursor;
- outbox;
- anonymization.

O arquivo `0002_authentication_legal_core.sql` cobre RLS entre dois usuários, RLS sem policy nos estados privados, leitura anônima apenas de versões vigentes, criação concorrente/idempotente da intenção, expiração/replay, atomicidade do trigger, snapshot/hash, aposentadoria não retroativa, scrub seletivo da metadata, cascata Auth e ausência de grants extras. Para recovery, a suíte deve provar emissão/inspeção por `user_id + session_id`, grant one-shot de 15 minutos, claim/release/consume concorrentes, fechamento sem remover a tombstone e rejeição de binding, scope ou sessão canônica divergente.

O banco também deve recusar `jwt_exp` diferente de `3600` na emissão, inspeção e readiness. A ausência em `auth.sessions` fecha a binding, remove o grant e estende a retenção por pelo menos 65 minutos; o purge só pode apagar a tombstone após `retain_until` e nova prova de ausência, nunca enquanto a sessão canônica existir.

`0004_owner_onboarding_recipient.sql` prova grants/ACL, RLS e isolamento A/B, personas owner/admin sem bypass, ativação/aceite, prepare/apply, renovação contratual, drift de perfil/readiness, bloqueio terminal, concorrência real, replay convergente e separação `request_id`/`idempotency_key`. No snapshot pós-hardening, as quatro suítes somaram `158 + 78 + 57 + 65`, totalizando 358/358 asserts; os gerados permaneceram byte-identical, com 15 migrations/head `20260815000100`. A primeira invocação interrompida após `0001` é inválida; depois de cleanup limpo, uma única nova invocação autorizada passou sem repetir reset/geração. Readiness aceitou o head atual e recusou `20260812000200`; trigger, overloads/grants, gerados e tabelas finais ficaram corretos.

Fixtures abertas por `dblink` usam UUIDs reservados de QA, preflight exato antes da transação pgTAP e cleanup persistente depois do rollback. Assim, uma execução interrompida é recuperável e duas chamadas consecutivas de `test:db` não dependem de reset intermediário nem deixam usuário, sessão, binding ou grant residual.

Na fotografia histórica da FEAT-003, reset e geração alcançaram o head `20260811000500`; as três suítes pgTAP passaram em 158 + 78 + 57, totalizando 293/293 asserts. Na FEAT-004 pós-split, a inspeção final encontrou zero linha nas 15 relações Auth/perfil/dono/operação/auditoria/aceites/intenções, zero fixture nos dez checks dedicados, zero ocorrência nas quatro classes de órfão, zero sessão dblink e Mailpit 0/0.

## 8. Concorrência

Usar chamadas paralelas reais contra DB local:

- dois holds;
- duplo webhook;
- cancel vs payout;
- expiry vs paid;
- review approve concorrente;
- reorder/media version conflict.

Não considerar teste sequencial prova de race condition.

## 9. Providers

Na FEAT-004 atual, somente o adapter local determinístico é exercitável em `APP_ENV=local | test`; `development | production`, valor ausente ou inválido resultam em `recipientOnboardingCapability=unavailable` e recusa antes de qualquer `prepare`. A ativação possui contrato separado: `approved` é sempre acionável; `local_fixture` só é acionável em `local | test`, permanecendo consultiva nos demais casos e falhando antes da escrita. Não se cria provider externo, fake de produção, aprovação jurídica simulada ou CTA desabilitado. Para features financeiras futuras, um fake estritamente de teste poderá implementar o contrato e permitir:

- approve/decline/pending;
- webhook duplicate/out-of-order;
- delayed paid;
- refund fail/success;
- payout fail/success;
- recipient statuses.

Fixtures de sandbox do provider real são sanitizadas e testes de contrato não rodam contra live.

## 10. Acessibilidade

- axe em páginas e flows;
- teclado;
- focus trap/restore;
- aria errors/live regions;
- zoom 200% com redução real do layout viewport, sem substituir o cenário de texto ampliado;
- contrast;
- touch target;
- calendar alternative;
- reduced motion;
- responsive reflow.

Axe não substitui teclado/leitor.

## 11. Visual/responsivo

Capturas aprovadas para:

- home;
- listagem;
- detail;
- configurator;
- checkout PIX/card;
- owner editor/calendar;
- backoffice review.

Comparar desktop quando CSS mobile muda.

## 12. Performance

Antes de go-live:

- list public com volume plausível;
- availability 31 days;
- quote;
- hold concurrency;
- owner calendar;
- admin queues;
- image LCP;
- build bundle;
- web vitals.

Índice novo somente com plano.

## 13. Smoke de deploy

- release SHA;
- live/ready;
- home;
- list;
- login;
- public app no admin;
- backoffice restricted;
- DB read;
- command unauth;
- worker heartbeat;
- TLS.

## 14. Relatório

CI gera:

- commit/release;
- ambiente;
- comandos/duração;
- cenários;
- falhas;
- trace/screenshots, exceto quando a feature documentar `off` por segurança de PII e substituir a captura por evidência redigida equivalente;
- migration head;
- browser versions;
- pendências.

Timeout sem resumo é inconclusivo.

## 15. Gate por mudança

| Mudança          | Gate                                       |
| ---------------- | ------------------------------------------ |
| UI               | unit + affected E2E + axe/responsive       |
| Command          | unit + integration + E2E                   |
| Schema/RLS       | reset + DB suite + affected E2E            |
| Calendar/payment | concurrency + full critical                |
| Infra            | build + shell/static checks + deploy smoke |
| Docs             | docs check/link/ID                         |
| Dependency       | audit + build + tests                      |

## 16. Critério de release

- zero P0 falho;
- zero P1 flakey conhecido sem dívida aprovada;
- zero grant/RLS violation;
- build das duas apps;
- restore recente;
- smoke/rollback;
- performance dentro do baseline;
- docs/traceability atualizados.

## 17. FEAT-006 — estado e gates

Os seis IDs `SL-F006-E2E-001` a `SL-F006-E2E-006` estão automatizados na fonte. O ID 001 valida
pending no mesmo escopo, exatamente um POST e preservação do bruto; o 002 descarta o rascunho com
`draft_removed`; o 003 fecha o boundary dirty A → B; o 004 prova teclado real; e o 006 dedica a
matriz de reflow a zoom 200%. A fonte atual projeta 20 casos focados em três specs/dez projetos e
134 casos na coleção integral. Essas contagens são de descoberta estática: nenhuma das duas matrizes
atuais foi executada.

A evidência browser aceita continua sendo o snapshot histórico 17/17 em duas specs/sete projetos,
anterior à adição dos contratos atuais. A lista integral histórica enumerou 131 testes em 19
specs/16 projetos, mas não houve execução integral verde. No browser, a atribuição correta é
stale/compare; tombstone é coberto por SQL/unitários. Nenhum resultado histórico deve ser promovido
a gate atual.

As três specs mantêm trace, screenshot e vídeo em `off`: provisionamento, documentos, cookies e
referências brutas não podem entrar em artefatos. A evidência equivalente combina locators
semânticos, respostas HTTP, contadores de request, asserções de DOM, stdout/relatório redigidos e
varreduras negativas. Payloads sensíveis não podem aparecer em URL, storage ou `QueryCache`; somente
fixtures sintéticas `qa_f006_*` são admitidas em campos automáticos allowlisted.

O header de escopo esperado enviado ao GET é somente uma assertion de coerência, não autenticação.
O probe dirty/pending deve fechar o DOM e as referências brutas sem consultar nem popular o
`QueryCache`. O latch de unmount e pós-`await` precisa suprimir todo callback tardio. A criação
ambígua preserva o escopo S1 e exige uma nova chave K por tentativa. No ID 005 desktop-chromium, a
fonte implementa K1/S1/A ambígua → GET 404 → usuário B → commit tardio K1 → K2/S1/B 409 → comparação
A/B → `Reaplicar` → save explícito K3 como update do único S1 com `expectedEditVersion`. `Usar versão
atual` navega explicitamente para A. Essa projeção ainda não foi executada e não é verde; não há
perda do rascunho nem replay automático de POST.

O pgTAP `0005` também deve provar: create/update seguram `FOR SHARE` sobre tipo ativo diante do archive
concorrente; publicado sem draft clona mesmo com core idêntico; draft existente idêntico é no-op;
`request_id` e `idempotency_key` permanecem distintos; cada efeito grava a ação/metadata allowlisted
uma vez; replay preserva o primeiro fato/correlação; no-op, falha e conflito auditam zero. Um futuro
teste FEAT-031 deve manter archive tipo-only ou a ordem agregado → tipo do update; se bloquear studio depois do
tipo, precisa provar ausência de deadlock nas duas direções. Unitário de UI exige remount após save,
inclusive no-op com `editVersion` estável.

O último DB verde permanece 431 no head executado `20260816000100`. A fonte agora aponta para
`20260816000200`, predecessor imediato esperado falso, sem reset. O plano pgTAP `0005` contém 83 casos
e o total esperado é 441, ainda não executado; `schema.generated.sql` e `database.generated.ts` estão
defasados e precisam do ciclo reset → geração → teste. O readiness de fonte conserva 19 rotinas e 20
dependências. A migration nova teve somente inspeção estática/diff; migrations/pgTAP/reset/generate
continuam pendentes. `00100`, `00200` e `0005` seguem untracked, portanto checksum Git não substitui
a futura prova do banco aplicado. A última suíte unitária integral verde, 893/893, é histórica e anterior ao
helper/hardening atual. O recorte dirigido anterior passou em 124/124 por dez arquivos; o atual passou
em 141/141 por 12 arquivos FEAT-006/studio sob Node 24, mas não é integral nem executa SQL. A tentativa
completa atual falhou em 12 testes de infraestrutura por limites do
sandbox — nested spawn `EPERM`, remapeamento de ownership raiz e timeouts de process group ou stdout
vazio — e não constitui gate verde.

Permanecem pendentes o `docs:check` canônico, a suíte unitária integral, reset/geração/DB 441, a
focada browser 20 e a integral 134, build das duas aplicações, smoke, release, ARM64 e FEAT-031. A
FEAT-006 continua `Em implementação`; OPEN-012, OPEN-013 e FEAT-031 bloqueiam a conclusão.
