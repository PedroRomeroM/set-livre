# FEAT-002 — Cadastro, confirmação, login, logout e recuperação

## Metadados

| Campo            | Valor                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Concluída e incorporada a `main` pelo PR #2                                                                                                                          |
| Prioridade       | P0                                                                                                                                                                   |
| Domínio          | `identity`                                                                                                                                                           |
| Specs Playwright | `tests/e2e/critical/feat-002-authentication.spec.ts`<br>`tests/e2e/regression/feat-002-authentication.spec.ts`<br>`tests/e2e/reflow/feat-002-authentication.spec.ts` |

## Objetivo

Permitir autenticação segura por e-mail/senha e criar uma sessão server-side confiável sem revelar existência de contas.

## Papéis

- visitante
- usuário autenticado

## Rotas e superfícies

- /cadastro
- /entrar
- /recuperar-senha
- /auth/callback

## Dependências

- `dependency-to-start`: nenhuma feature; a fundação local já incorporada fornece apps, Supabase local e gates;
- capacidade bootstrap deste PR: Supabase Auth local, `legal-core` e templates Auth locais, todos limitados ao primeiro consumidor real;
- `dependency-to-complete`: a FEAT-002 fornece identidade e histórico jurídico para os direitos LGPD completos da FEAT-034; a feature posterior não bloqueia este início;
- `dependency-to-release`: PEND-002 (Supabase Cloud), PEND-003 (Nginx/TLS e borda confiável), PEND-005 (SMTP) e PEND-006 (conteúdo jurídico aprovado).

## Incluído

- Cadastro PF/PJ inicia Auth e exige aceite vigente.
- Confirmação de e-mail.
- Login e logout.
- Recuperação e definição de nova senha.
- Redirecionamento allowlisted.
- Mensagens em PT-BR para erros conhecidos.
- Termos e privacidade renderizam o subset Markdown de headings, parágrafos, listas, ênfase e links com HTML tratado como texto.

## Fora desta feature

- login social
- magic link como fluxo principal
- MFA do usuário comum

## Regras de produto e domínio

- A senha segue a regra real do provider.
- O tipo de cadastro usa o rádio nativo como fonte única: o valor vem do `FormData`, passa pelo Zod estrito e não pode divergir de um estado React durante a hidratação.
- O cadastro falha fechado antes da hidratação. `useSyncExternalStore` projeta `false` no servidor e `true` no cliente; no HTML SSR existe um único `form`, com `inert`, `method=post` e `aria-busy`, contendo um `fieldset` externo disabled. Os sete controles nomeados e o submit também começam disabled. Somente depois da hidratação o fluxo interativo normal é habilitado.
- Cadastro não considera perfil concluído até FEAT-003.
- Recuperação retorna resposta genérica.
- Logout invalida caches privados. Nas superfícies autenticadas de `/entrar` e `/conta/seguranca`, a mutation executa uma closure sem `variables`, usa `networkMode: "always"` e carrega `expectedScope` UUID somente como asserção do recorte SSR, nunca como autoridade.
- O servidor executa `getClaims`, que pode renovar ou manter a sessão internamente, e termina a classificação antes de obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw retorna `503 SERVICE_UNAVAILABLE`; resultado com erro ou contexto assinado ausente retorna `401 UNAUTHENTICATED`; somente um `userId` válido diferente de `expectedScope` retorna `409 SESSION_CHANGED`. Os três ramos têm zero efeitos destrutivos explícitos de logout e conduzem o browser ao boundary fechado, `QueryClient.clear()` e recomposição SSR.
- Se a resposta de logout for perdida ou ambígua, a UI oculta imediatamente os dados privados e recarrega a rota SSR; a tela então informa se a sessão continua ativa ou se a ausência local foi confirmada.
- Se o cliente perder ou não conseguir validar a resposta do login, e portanto não puder saber se cookies já foram publicados, a UI apaga a referência efêmera e o formulário de credenciais, limpa o cache privado e recarrega `/entrar` para uma decisão SSR autoritativa. Falha/throw depois de iniciar `setSession` recebe `AUTH_SESSION_RECHECK_REQUIRED` e segue a mesma transição, mesmo se o cleanup exato falhar; somente rejeições API comprovadamente anteriores à publicação permanecem recuperáveis no formulário.
- A projeção da preferência após `setSession` chama `get_my_profile()` com `AbortSignal` e deadline server-side de um segundo. Timeout ou falha usa `system`; resolver a RPC depois do deadline não pode publicar cookie de tema nem acionar `signOut` após a resposta.
- Token inválido/expirado não mostra formulário funcional.
- Em callbacks de signup e recovery, somente uma resposta API válida `SERVICE_UNAVAILABLE` emitida antes de iniciar `verifyOtp` permite retry. Depois do envio, falha de rede, timeout, resposta inválida, erro desconhecido do provider ou publicação ambígua encerram a tentativa com `AUTH_RESTART_REQUIRED`/`RECOVERY_RESTART_REQUIRED`, limpam cookies e sessão Auth exatos e orientam solicitar novo link sem reutilizar o OTP possivelmente consumido.
- Cada callback de recovery cria uma binding/tombstone privada pelo `session_id` do JWT assinado e pela linha canônica de `auth.sessions`; a sessão nunca pode ser promovida a login comum. O grant adicional fica vinculado à mesma binding, expira em 15 minutos e é one-shot: uma claim exclusiva precede o provider; somente rejeição explicitamente sem efeito e ocorrida antes da expiração permite release e retry.
- O cookie `sl-recovery-session` carrega somente um UUID público, opaco e não autoritativo para escopar SSR/cache. Perda, expiração ou remoção desse marker não remove a classificação durável da sessão Auth.
- O formulário de nova senha não é montado durante `fetching` nem `paused`; somente `allowed=true`, scope correspondente e `fetchStatus=idle` autorizam a interface. Após consumo, expiração, ausência canônica ou saída da superfície de recovery, a binding é fechada, o grant é invalidado e a sessão/cookies Auth exatos são encerrados.
- Uma rejeição pública e retryable da troca de senha é copiada somente como mensagem, scope público de origem e erros dos campos `password | confirmPassword` para o boundary de recovery. Esse feedback sobrevive ao refetch autoritativo que desmonta o formulário, reaparece apenas no mesmo scope ainda autorizado e é descartado em nova submissão, sucesso, negação ou troca de scope.
- Um refetch de sessão valida o usuário/escopo antes de publicar o payload no TanStack; uma troca autoritativa limpa a família e recarrega SSR sem gravar B sob a key de A.
- Uma conta suspensa pode autenticar no provider, mas não acessa o produto.

## Dados canônicos afetados

- `auth.users`;
- `profiles` mínimo criado pelo trigger do signup;
- `terms_versions` e `terms_acceptances`;
- `private.signup_legal_intents`, expiráveis e one-shot;
- `private.identity_recovery_grants`, persistidos até expiração/consumo e vinculados à sessão Auth;
- `private.identity_recovery_sessions`, binding/tombstone por `session_id` assinado, com retenção conservadora mesmo depois do grant e dos cookies. Os três estados privados usam RLS sem policy, zero grants runtime e nenhuma leitura do browser.

## Read models

- sessão server-side
- termos vigentes
- status autoritativo do grant e da binding da sessão atual de recovery, retornado com scope público opaco

## Comandos e integrações

- `identity.register` cria uma intenção legal opaca antes do Auth; o trigger cria perfil mínimo e aceites atomicamente
- métodos Supabase Auth para login, logout, callback e recovery
- DAL privado emite binding+grant, inspeciona a sessão, reserva, libera, consome e fecha o contexto de recovery

## UX e estados obrigatórios

- Formulários preservam e-mail em erro seguro.
- Enquanto o cadastro ainda não hidratou, o texto **Preparando o formulário seguro…** aparece como `role=status` fora do formulário inerte; nenhum campo ou submit fica operável nesse estado.
- PasswordInput com mostrar/ocultar e requisitos.
- Os callbacks de signup e recovery apresentam carregamento e falha recuperável somente quando a repetição é comprovadamente segura; qualquer resultado ambíguo após o envio encerra o payload one-shot e exige novo link.
- A verificação inicial e todo refetch de recovery apresentam somente loading durante `fetching` ou `paused`; um estado `allowed` em cache não mantém o formulário no DOM.
- Um login com desfecho de transporte ambíguo apresenta somente o boundary de verificação até o hard reload; a composição SSR seguinte mostra a sessão autenticada caso os cookies tenham sido publicados ou uma cópia explícita de entrada não confirmada caso permaneça anônima.
- Toda request interativa expira em dez segundos e reabilita uma recuperação acionável.
- ReturnTo não permite URL externa.
- O título canônico da página permanece como único `h1`; um `#` inicial igual ao título do documento é omitido e os demais headings preservam a hierarquia a partir de `h2`.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Cookies Secure/SameSite.
- Cookies de sessão são server-side e `HttpOnly`; `Secure` só é relaxado no HTTP loopback local.
- Sem enumeração de e-mail.
- Limite de taxa e proteção antiabuso.
- O limiter in-memory mantém no máximo 10.000 buckets exatos e nunca remove um bucket vivo. Depois da saturação, chaves inéditas compartilham um contador overflow sticky por ação; até 64 partíções ficam limitadas e uma partíção adicional falha fechado, sem resetar a cota de um discriminador por churn. A borda Nginx continua obrigatória em produção.
- Sessão sempre validada no servidor para comando.
- E-mails, senhas e o `TokenHash` de cadastro, login, callback e recovery usam refs one-shot e não são persistidos como `variables` no MutationCache.
- O boundary SSR do cadastro impede submit HTML nativo pré-hidratação: o formulário inerte usa método POST como defesa adicional, e o `fieldset`, os sete controles nomeados e o botão submit permanecem disabled até o snapshot de cliente. Assim, valores de cadastro não podem migrar para a query por fallback GET antes de React assumir o evento.
- Logout também chama `mutate()` sem `variables`; sua closure one-shot é apagada em todo settle, e `networkMode: "always"` impede fila offline retomável depois de uma troca de identidade.
- O conteúdo jurídico não usa `dangerouslySetInnerHTML`: somente o subset explicitamente reconhecido vira elementos React, e sintaxe/HTML não suportados permanecem texto escapado. Links aceitam apenas path interno absoluto sem destino protocol-relative/barra invertida ou URL `https:` sem credenciais; um destino rejeitado perde o link e preserva somente o rótulo.

## Critérios de aceitação

- Usuário cria conta e confirma.
- Cadastro permanece inerte e sem query quando JavaScript está desabilitado; depois da hidratação, o fluxo normal continua funcional.
- Login cria sessão SSR.
- Logout remove acesso e cache.
- Reset funciona com token válido e falha seguro com inválido.
- Open redirect impossível.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport  | Cenário                                                  | Spec                                                   |
| --------------- | ---------- | ---------- | --------- | -------------------------------------------------------- | ------------------------------------------------------ |
| SL-F002-E2E-001 | P0         | critical   | desktop   | cadastro fecha pré-hidratação e depois envia confirmação | `tests/e2e/critical/feat-002-authentication.spec.ts`   |
| SL-F002-E2E-002 | P0         | critical   | desktop   | login/logout controla rota autenticada                   | `tests/e2e/critical/feat-002-authentication.spec.ts`   |
| SL-F002-E2E-003 | P0         | critical   | mobile    | recuperação e nova senha funcionam                       | `tests/e2e/critical/feat-002-authentication.spec.ts`   |
| SL-F002-E2E-004 | P1         | regression | desktop   | e-mail inexistente recebe resposta genérica              | `tests/e2e/regression/feat-002-authentication.spec.ts` |
| SL-F002-E2E-005 | P0         | critical   | desktop   | returnTo externo é rejeitado                             | `tests/e2e/critical/feat-002-authentication.spec.ts`   |
| SL-F002-E2E-006 | P1         | regression | mobile    | axe e teclado nos formulários                            | `tests/e2e/regression/feat-002-authentication.spec.ts` |
| SL-F002-E2E-007 | P1         | reflow     | zoom 200% | autenticação preserva conteúdo e operação em 160x360     | `tests/e2e/reflow/feat-002-authentication.spec.ts`     |

Regras:

- fluxos P0 passam pela UI;
- sem criar ID, `SL-F002-E2E-001` abre também um BrowserContext com JavaScript desabilitado e exige status de preparo, `form` inerte com método POST, `fieldset`, campos sensíveis e submit disabled, além de path `/cadastro` sem query; o contexto normal preserva o cadastro completo;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- senha nunca entra no DOM nem em `fill`, `type` ou `keyboard`: o helper valida input, form e nome em allowlist dentro de `Locator.evaluate` e instala um listener `formdata` one-shot que injeta o segredo somente no `FormData`, fora de `ariaSnapshot` e `error-context`;
- trace, vídeo e screenshot ficam desativados nas specs Auth para não persistir token ou senha; helpers convertem falhas sensíveis em mensagens estáticas e a rodada varre sentinela e token nos artefatos;
- dados com namespace QA.

## Testes unitários, integração e banco

- unitário: contratos Auth, allowlist de `returnTo`, erros públicos, limites, rate limiter sem evicção viva e overflow limitado, cache recovery escopado/pausado, binding da sessão, fronteira retryable/terminal dos callbacks, publicação parcial, cleanup exato, classificação fail-closed do logout antes de obter explicitamente o cookie store e antes dos efeitos destrutivos explícitos de recovery, deleção de cookies ou `signOut`, deadline/abort da projeção de preferência, boundary SSR/hidratação do cadastro, templates, parser Markdown jurídico e helpers QA;
- banco/RLS: perfil e aceites próprios para usuários A/B, intenção expirada/replay/concorrência, trigger atômico, metadata scrub, binding/tombstone recovery, grant com claim/release/consume concorrente, expiração e ausência canônica, retenção conservadora, pin `jwt_exp=3600`, grants e readiness;
- segurança: cookies, origem/request host, corpo limitado, callback em fragmento, redaction e cleanup local exato;
- Playwright: os sete IDs possuem specs físicas; 23 execuções Auth e a matriz integral de 59 casos passaram depois da ampliação de `SL-F002-E2E-003`, sem criar ID nem alterar o catálogo de 194 cenários.

O hardening pré-hidratação passou em 2/2 testes unitários próprios e em 22/22 na guarda combinada de segurança da identidade. O snapshot integral pós-hardening passou em 749/749 unitários por 75 arquivos e no banco em 358/358. Depois da correção da race de `SL-F004-E2E-004`, a focada passou em 23/23 por quatro specs/14 projetos, com auditoria de privacidade e cleanup verdes.

A rodada attribute-fixed coletou 114 testes em 17 specs/16 projetos e sua única execução passou em 114/114 em 5,6 minutos, com zero retry, erro ou attachment. Sem alterar ID ou contagem, o contexto sem JavaScript de `SL-F002-E2E-001` passou em `critical-chromium`, `critical-firefox` e `critical-webkit`; o caminho hidratado permaneceu dentro do mesmo cenário.

A auditoria contou 140 ocorrências dos 88 e-mails QA somente em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22 —, com zero secret, PII ou outro dado sensível e cleanup zero. Evidência segura: `.artifacts/p5-owner-activation-capability-attribute-fixed/full.audit.json`, SHA-256 `5704c67cf21bdcc6e92b733bfdb8788972c216d48f850c885200b6d4d78a37d6`. As execuções rejeitadas anteriores permanecem histórico diagnóstico: o defeito pré-hidratação inicial foi corrigido, e as rejeições seguintes pertencem ao harness/oráculo, não ao produto atual. Static 749/749, DB 358/358, focada 23/23 e integral 114/114 estão verdes.

Uma única build P5 compilou 26 + 4 rotas com exit `0`, mas o artefato standalone foi recusado porque o `package.json` copiado ainda continha strings locais de banco no antigo `scripts.knip`; nenhum smoke iniciou. O script agora é somente `knip`, o config continua lendo o `.env.e2e.local` físico e a unidade de npm confiável rejeita URLs de banco nos scripts npm dos quatro manifests canônicos — raiz, backoffice, contracts e UI. Checks direcionados, 4/4 unitários, Knip com as sete variáveis E2E explicitamente unset e diff-check passaram sem mudança no lockfile. A execução pós-manifesto que testou esse fix está registrada abaixo; esse blocker de empacotamento não reabre o contrato de hidratação da FEAT-002 já comprovado no browser.

A build pós-manifesto seguinte terminou uma única vez com exit `0`, mas o audit recusou uma ocorrência DAL em cada cache Turbopack; standalone, static e log ficaram limpos, e o smoke permaneceu em zero. O wrapper único `scripts/next-build.mjs`, compartilhado pelos dois apps e pelo gerador de release, valida app/toolchain física antes do spawn e sempre tenta remover apenas o cache autorizado, inclusive se validação ou build falharem; cleanup falho aborta e falha dupla vira `AggregateError`. O preview usa o mesmo cleanup no supervisor antes de validar/startar. O run direcionado final passou em 40/40 — 12 de cache/wrapper, quatro do npm confiável, 16 de Next/local server e oito do supervisor de preview — com ESLint, checks Node, Knip env-unset e diff-check verdes.

A cadeia estática final única passou em 764/764 testes por 76 arquivos, mantendo DB 358/358, focada 23/23 e integral 114/114. A build final via wrapper, após remoção física dos dois `.next`, rodou exatamente uma vez e terminou exit `0` em 14,733 s; log SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. A auditoria independente SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d` terminou `NO-BLOCKER`, com caches/retired/resíduos zero. O smoke permanece não executado e será primeiro somente o embutido no gerador canônico após commit limpo; isso não reabre o hardening SSR/browser da FEAT-002.

## Documentação viva afetada

- security-privacy.md
- ux-blueprint.md
- notifications.md
- qa-test-plan.md

Toda mudança desta feature também atualiza este arquivo, o catálogo QA e `docs/changes/`.

## Definition of Done da feature

- todos os critérios acima comprovados;
- migration/grants/RLS verdes quando aplicável;
- read model/command e invalidação documentados;
- Playwright listado e verde;
- desktop/mobile/teclado/axe verificados;
- logs e métricas necessários;
- rollback/correção definidos;
- nenhuma funcionalidade fora de escopo introduzida.

## Delimitação executável

A resolução OPEN-008 mantém esta fatia restrita ao perfil mínimo e ao `legal-core`. FEAT-003 continua proprietária da conclusão e dos dados pessoais, FEAT-019 do retorno a draft/reserva e FEAT-034 dos direitos LGPD completos e do conteúdo jurídico aprovado. Nesta feature, `/entrar` é também a superfície autenticada usada para provar sessão SSR e logout; `/conta` não é antecipada.
