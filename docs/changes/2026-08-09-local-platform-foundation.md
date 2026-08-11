# Mudança: fundação local da plataforma

- Data: 2026-08-09
- Autor/agente: Codex
- Issue/PR: branch `agent/foundation-local-platform`; [PR #1](https://github.com/PedroRomeroM/set-livre/pull/1)
- Features: fundação transversal
- ADRs: ADR-017, ADR-018
- Risco: médio
- Rollback: reverter o commit da fundação; a baseline documental permanece em `main`

## Resumo

Cria a fundação executável local da Set Livre: workspaces npm, aplicações pública e de backoffice, pacotes compartilhados, contratos de qualidade, Supabase local, guardrails documentais e smoke tests. CI/CD, Supabase Cloud, Oracle Cloud e providers externos permanecem deliberadamente fora desta etapa.

## Motivo

O repositório remoto estava vazio e o pacote recebido continha somente documentação. A plataforma precisa de uma base reproduzível antes da primeira feature vertical.

## Comportamento anterior

- nenhum repositório Git no diretório recebido;
- nenhum `package.json`, código, migration, teste ou configuração executável;
- remoto GitHub sem refs;
- 193 cenários Playwright somente planejados.

## Comportamento novo

- baseline documental publicada em `main` como commit bootstrap;
- fundação local isolada na branch `agent/foundation-local-platform`;
- aplicações e contratos mínimos executáveis;
- gates locais reproduzíveis;
- pendências externas e dependências instaladas rastreadas.

## Arquivos/componentes

- aplicação pública Next.js no package raiz e backoffice separado em `apps/backoffice`;
- workspaces `packages/contracts` e `packages/ui`, sem domínio ou sistema visual paralelo;
- contratos de health/release, readiness server-only e tipos gerados do banco;
- tokens claro/escuro e superfície técnica `FoundationStatus` responsiva;
- scripts de bootstrap Supabase, desenvolvimento conjunto, docs, formatação e release;
- release local com raiz física privada, ambientes isolados por app, `BUILD_ID` igual ao SHA, árvore pós-smoke exata e tar determinístico sem sobrescrita divergente;
- ESLint, TypeScript, Vitest, Playwright/axe, Knip, Prettier e audit com versões fixadas;
- configuração de segurança, CSP distinta entre desenvolvimento/produção e build standalone.

## Banco, migration, grants e RLS

Sem entidade de feature antecipada. Foram adicionadas as migrations imutáveis:

- `20260809000100_security_baseline.sql`: schemas privados, extensões, role DAL e privilégios fechados;
- `20260809000200_readiness_contract.sql`: função privada mínima vinculada à migration head;
- `20260809000300_security_default_privileges_hardening.sql`: default global de funções fechado e estado da role DAL normalizado;
- `20260810000100_app_dal_readiness_authorization.sql`: manifesto exato de ACL/ownership da DAL, defaults de tipos fechados e recusa de privilégios efetivos herdados de `PUBLIC`;
- `20260810000200_pg_catalog_public_acl_hardening.sql`: baseline canônica das ACLs públicas de relações e colunas de `pg_catalog`, recusando expansões como acesso a `pg_authid.rolpassword`.
- `20260810000300_pg_catalog_public_routine_acl_hardening.sql`: containment por OID/overload das ACLs públicas de rotinas de `pg_catalog`, incluindo grantor e grant option, sem promover defaults de rotinas normais posteriores a baseline.
- `20260810000400_pg_catalog_implicit_routine_owner_hardening.sql`: owner canônico independente de `proowner` para baselines implícitas de rotinas initdb ou membros reais de extensão.
- `20260811000100_database_temporary_privilege_hardening.sql`: remove `TEMPORARY` da baseline pública e faz readiness recusar essa capacidade efetiva na DAL e no login runtime.

O bootstrap cria fora das migrations um login local efêmero com atributos, memberships, parâmetros e manifesto direto exato, que assume `app_dal` explicitamente. Como objetos gerenciados de `pg_net` e catálogos sensíveis pertencem a `supabase_admin`, o bootstrap autentica exclusivamente no loopback como esse superuser local, fecha schema/objetos/defaults de `net`, normaliza `pg_roles`/`pg_user`/`pg_db_role_setting`, preserva somente os acessos administrativos necessários e reconcilia quem pode assumir tanto o login quanto `app_dal`. O segredo JWT global da stack é mascarado para o login local e sua leitura direta é negada; a garantia Cloud equivalente permanece em PEND-002. O snapshot SQL e os tipos são regeneráveis; 156 asserts pgTAP comprovam roles, deny-by-default, ACLs efetivas, ownership, parâmetros, extensões, as duas funções privadas e a rejeição/restauração de drifts de autorização.

## Segurança e privacidade

- nenhum secret versionado;
- runtime e harness E2E usam arquivos separados com modo `0600`;
- guards validam origens exatas, identidades, porta e marcador efêmero conectado antes de qualquer suíte;
- a credencial administrativa é removida do ambiente dos processos Next;
- browsers recebem allowlist operacional mínima e não herdam secrets, banco, SSH, npm, loader, Node ou runtime Snap do host;
- build, tar e smoke herdam somente variáveis operacionais autorizadas; secrets conhecidos são redigidos e procurados na release inteira;
- backoffice permanece aplicação separada;
- CSP de produção não permite `unsafe-eval` nem conexões localhost;
- nenhuma integração cloud é configurada.

## Read models, comandos e invalidação

A fundação implementa somente o read contract de readiness via `private.check_readiness(text)` e `private.check_runtime_readiness(text)`, com timeout, identidades DAL e retorno público não expositivo. Não existe comando de negócio, estado TanStack ou invalidação sem consumidor real.

## UX, mobile e acessibilidade

Tokens e a superfície técnica compartilhada possuem composição própria em 1440, 390 e 320 px, altura compacta, safe areas não nulas, claro/escuro, reflow e texto ampliado a 200% também nos viewports móveis. A tela não possui controles interativos, portanto não afirma evidência artificial de touch target/foco.

## Testes e IDs QA

- 270 testes unitários de docs, segurança E2E/browser/webServer/CSP, isolamento local, ambientes de desenvolvimento e preview, Docker/Supabase, health/release, concorrência, reprodutibilidade, remoção física protegida contra mounts, geração atômica, contratos gerados e migration head;
- 156 asserts pgTAP;
- IDs técnicos estáveis `FOUNDATION-E2E-001` a `011`, fora da matriz das 34 features;
- 36 execuções Playwright: desktop, 390 px, 320 px, reflow equivalente ao zoom 200% em 160 CSS px nos três engines, altura compacta, backoffice, axe claro/escuro/mobile/narrow, safe-area não nula e Chromium/Firefox/WebKit críticos;
- caminho feliz e negativo (`/admin` público retorna 404), readiness real e propagação segura de request ID;
- build standalone das duas aplicações e smoke do pacote de release;
- guardrails adversariais para raiz simbólica/permissiva, herança de credenciais, separação de URLs e redaction do empacotamento.

## Correções do primeiro Codex review

- gates de documentação e formatação resolvem `origin/main`, `main` local e fallback conservador sem eliminar Markdown commitado;
- mudança técnica reconhece todos os configs raiz mantidos e exige change record com status Git `A`;
- Playwright diferencia as superfícies por heading exato e comprova reflow equivalente ao zoom de 200% nos três engines;
- readiness inválida falha fechada com JSON `503/unready`, `release=unknown`, headers autoritativos e sem consulta à DAL;
- threads efetivamente atendidas passam a ser resolvidas no PR antes de cada nova solicitação de review.

## Correções do segundo Codex review

- os gates Git escolhem a base válida cujo `merge-base` está mais próximo de `HEAD`, impedindo que uma `origin/main` defasada reutilize change record já incorporado à `main` local;
- configurações mantidas em diretórios aninhados, inclusive contratos JSON em `docs/`, também exigem documentação e change record novo;
- readiness valida os atributos restritos do login e da role efetiva `app_dal`; um smoke real com `BYPASSRLS` comprova `503/unready` nos dois apps e restaura a role ao final;
- o smoke da release usa exclusivamente a URL DAL local validada de cada aplicação e ignora override remoto herdado do host;
- o bootstrap recusa destinos de ambiente simbólicos ou não regulares e publica arquivos `0600` por substituição atômica sem alterar alvo de symlink ou hard link;
- tipos do banco são gerados, validados, formatados e sincronizados em temporário irmão; qualquer falha preserva o contrato rastreado anterior.

## Correções do terceiro Codex review

- liveness permanece independente de configuração crítica: SHA ausente ou inválido retorna `200/live` com `release=unknown`, enquanto readiness continua falhando fechada;
- readiness exige que a role efetiva `app_dal` não possua nenhuma membership, além de validar seus atributos e a sessão restrita;
- um lock de kernel por descritor serializa toda a geração de release, incluindo builds, montagem, smoke, temporários, verificação e publicação concorrente;
- o GNU tar normaliza modos de diretórios, executáveis e arquivos regulares, reproduzindo o mesmo checksum sob `umask 022` e `077`;
- o Knip trata os workers subprocessados como entradas de teste e reconhece `flock` como binário de sistema documentado, mantendo o gate sem falso positivo.

## Correções do quarto Codex review

- uma feature recém-criada no mesmo SHA da `main` usa `HEAD` como base, sem herdar change record histórico, enquanto o checkout da própria `main` preserva o fallback alcançável;
- mudanças Git de tipo `T` entram nos três diffs e o formatador recusa symlinks ou nós especiais antes de qualquer escrita, sem tocar em alvos externos;
- o tar remove também `setuid`, `setgid` e `sticky`, mantendo diretórios/executáveis em `0755`, arquivos regulares em `0644` e o mesmo checksum entre umasks;
- o launcher direto `node scripts/dev-all.mjs` faz preflight físico dos dois `.env.local`, valida origens, Supabase e DAL locais e cria ambientes separados sem herdar overrides ou credenciais do host após a fronteira de entrada;
- o smoke de release e o launcher de desenvolvimento reutilizam o mesmo validador puro da identidade DAL local.

## Correções do quinto Codex review — registro histórico supersedido onde indicado

- naquele ciclo, a entrada isolada dos dois apps usava uma camada npm endurecida; o sétimo review a substituiu pelo launcher Next direto descrito abaixo;
- uma row QA `automatizado` exige spec Playwright física dentro de `tests/e2e/`, binding runtime nomeado `test` importado de `@playwright/test` e registro direto no módulo ou em `test.describe(...)`, com callback e ID estável no título literal, validado por AST;
- bootstrap e todos os wrappers Supabase comprovam contexto Docker `default` e endpoint local antes de qualquer operação, propagando o daemon pinado a cada subprocesso operacional;
- todo `stderr` da CLI Supabase permanece privado e é descartado; falhas são relançadas sem erro original, buffers, URL de banco ou chaves, enquanto somente o `stdout` necessário a pgTAP e geração de tipos pode ser herdado;
- os dois `webServer` do Playwright neutralizam integralmente o ambiente herdado antes do merge interno do runner, relêem o `.env.local` físico da aplicação em wrapper isolado e encerram a árvore wrapper/Next durante shutdown solicitado com a raiz ainda válida; a fronteira de saída natural posterior foi explicitada no décimo-sétimo review;
- a validação da instalação npm permanece no release; desenvolvimento e Playwright passaram a validar e iniciar diretamente a CLI Next absoluta no sétimo review, sob a fronteira explícita de toolchain/checkout confiáveis e sem alteração concorrente por qualquer principal com permissão de escrita.

## Correções do sexto Codex review

- o snapshot de schema é produzido em temporário irmão exclusivo, validado e sincronizado antes de substituição atômica; falha, dump vazio, schema obrigatório ausente ou troca de arquivo preservam o snapshot rastreado anterior;
- o supervisor de desenvolvimento encerra a árvore completa de cada aplicação no Windows por `taskkill.exe /T /F` absoluto, sem shell e com timeout; no POSIX, mantém o PGID mesmo após o root encerrar para aplicar o fallback `SIGKILL` a qualquer descendente sobrevivente;
- a matriz Playwright foi recontada pelo runner e permanece em 36 execuções: smoke `4 x 4`, critical `1 x 3`, backoffice `1 x 1`, acessibilidade `3 x 4`, safe area `1 x 1` e reflow `1 x 3`.

## Correções do sétimo Codex review

- `dev`, `dev:backoffice`, o workspace administrativo, `dev-all` e os `webServer` Playwright convergem no launcher compartilhado, relêem o ambiente local físico e iniciam a CLI Next validada por caminho absoluto, sem npm filho, shell ou precedência de uma DAL cloud herdada; isso substitui a camada npm descrita nos ciclos anteriores;
- readiness exige os manifestos diretos mínimos de `app_dal` e do login runtime, zero ownership indevido, memberships de entrada/saída exatas, parâmetros restritos e a baseline pública exata; o bootstrap privilegiado fecha `pg_net` para runtimes, preserva o worker administrativo, mascara o GUC JWT local e nega leitura direta/transitiva de `pg_roles`, `pg_user` e `pg_db_role_setting`, enquanto a normalização Cloud permanece bloqueada por PEND-002;
- no Windows, desenvolvimento e o shutdown solicitado do Playwright encerram a árvore enquanto a raiz ainda é válida pelo `taskkill.exe` absoluto derivado de `SystemRoot/System32`, com `/PID /T /F`, ambiente mínimo, sem `PATH`/shell e timeout de cinco segundos; saída natural do Playwright não reutiliza PID liberado, conforme o décimo-sétimo review;
- o gate de supply chain cobre todas as seções instaláveis, bundles, aliases e overrides, fixa os workspaces/manifests físicos e recusa specs não-registry, hooks, `binding.gyp`, shrinkwrap ou lock paralelo; `.npmrc` desabilita todo lifecycle durante `npm ci`, mantém o preflight estrito sem `allowScripts` e bloqueia o escape global perigoso.

## Correções do oitavo Codex review

- o supervisor trata `SIGHUP` pelo mesmo shutdown completo de grupos POSIX usado para os demais sinais, retorna código 129 e comprova por processo real que pai, descendente e porta não sobrevivem ao fechamento do terminal;
- `npm run test:db` gera snapshot SQL e tipos em destinos temporários não rastreados, compara os bytes normalizados/formatados aos contratos versionados e falha sem modificá-los quando qualquer artefato estiver stale.

## Correções do nono Codex review

- o smoke da release instala `SIGHUP`/`SIGINT`/`SIGTERM` antes do primeiro spawn, limpa integralmente os dois PGIDs detached e preserva o código 129, inclusive quando líderes encerram antes dos descendentes;
- a release exige os dois `.env.local` físicos, exclusivos e `0600` antes do build, abre sem seguir links e revalida identidade, modo e quantidade de links antes de interpretar o runtime local;
- o readiness compara toda ACL pública de relação, coluna ou rotina em `pg_catalog` à baseline canônica, preserva somente privilégios iniciais e recusa grants posteriores em catálogos restritos.

## Correções do décimo Codex review

- `start`, `start:backoffice` e o workspace administrativo usam o launcher local fail-closed, retiram qualquer `.next` física anterior, constroem um build fresco com o mesmo ambiente sanitizado do servidor e supervisionam cada fase desde antes do primeiro spawn, preservando sinais, limpando descendentes POSIX/Windows e recusando encerramento prematuro;
- um change record novo só satisfaz o gate quando é Markdown não vazio, físico, regular e exclusivo, sob raiz e ancestrais físicos, aberto com `O_NOFOLLOW` e revalidado contra troca concorrente;
- entrypoints raiz do Next (`proxy`, `middleware`, `instrumentation`, `instrumentation-client` e `mdx-components`) entram no gate documental em todas as extensões reconhecidas, sem classificar nomes apenas semelhantes;
- a política de dependências recusa por nomes, scopes e prefixos delimitados as alternativas mantidas das famílias proibidas, inclusive aliases e overrides de ORM/query builder, CSS-in-JS, estado remoto paralelo, Redis/Kafka/filas e CMS;
- os dois apps geram nonce CSP por request no Proxy, removem `unsafe-inline` de `script-src` em produção, renderizam HTML dinamicamente sem cache e entregam fallback global 500 sem JavaScript; testes hostis cobrem headers de prefetch, prefixos parecidos, erros de método/range/path em assets estáticos, nonce renovado e bootstrap real.

## Correções do décimo-primeiro Codex review

- o gate central de dependências inclui o scope mantido `@griffel/` na proibição de CSS-in-JS e cobre aliases `npm:`, overrides aninhados e nomes apenas semelhantes que devem continuar permitidos;
- a retirada de `.next` recusa mount raiz ou descendente no Linux com mountinfo, dispositivo e snapshot físico antes/depois do rename; em macOS, Windows e plataformas sem prova equivalente, qualquer árvore anterior falha antes de rename, remoção ou spawn e precisa ser inspecionada/removida manualmente.

## Correções do décimo-segundo Codex review

- o gate de dependências inclui o scope `@mui/` na proibição de primitives e CSS-in-JS paralelos, cobrindo Material/System, aliases, overrides e near-misses permitidos;
- uma migration append-only estende o containment de `PUBLIC` às rotinas de `pg_catalog` por OID/overload, grantor e grant option; pgTAP prova `pg_read_file(text)`, grantor alternativo, rotina normal posterior sem baseline e recuperação integral.

## Correções do décimo-terceiro Codex review

- a baseline implícita de rotina `pg_catalog` nunca deriva do `proowner` auditado: membro de extensão usa `extowner`, initdb sem membership usa o owner bootstrap OID `10`, e drift de owner falha mesmo após revogar `PUBLIC`;
- serviços persistentes de desenvolvimento convertem saída natural inesperada `0` em falha `1`, encerram as demais árvores e reservam zero apenas a shutdown explicitamente solicitado ou ao build finito do preview.

## Correções do décimo-quarto Codex review

- a release recusa `.artifacts` montada antes de alterar permissões, adquirir o lock ou construir os apps e não considera um checkout limpo prova de segurança para a árvore ignorada;
- a remoção recursiva de `release` e candidatos de verificação compartilha o guard físico do preview: mountinfo Linux fail-closed, inspeção sem seguir links, retiro atômico e revalidação de identidade, forma e mounts antes de apagar; plataformas sem prova equivalente exigem cleanup manual.
- `contexto-projeto-set-livre.html` passa a ser o resumo executivo vivo e conciso do que já foi implementado; o gate documental exige sua atualização em toda mudança técnica e valida estrutura, idioma e ausência de dependências externas de apresentação.

## Correções do décimo-quinto Codex review

- cada `psql` do bootstrap usa o mesmo caminho POSIX absoluto e fisicamente protegido, comprova PostgreSQL `18.4` antes do start/reset ou acesso a credenciais, recebe somente locale e senha local controlados, ignora por construção `PATH`, `PGHOSTADDR`, services, passfiles, TLS/GSS e demais overrides libpq herdados e redige todos os segredos interpolados antes de expor diagnóstico seguro;
- `.env.e2e.local` é lido apenas como arquivo privado físico, exclusivo, pertencente ao usuário efetivo, `0600` em POSIX e estável em caminho, descriptor e ancestrais, sem conteúdo ou caminho dinâmico em erros;
- os launchers `next dev` recusam `.env`, `.env.development` e `.env.development.local` nos dois apps, preservando `.env.local` como única fonte runtime aceita;
- o gate de supply chain exige uma linha canônica e completa em `docs/dependencias-utilizadas.md` para cada dependência externa direta dos quatro manifests e falha fechado para specs ou overrides ambíguos;
- migrations presentes na base Git permanecem byte a byte imutáveis em cada snapshot `first-parent`; o gate recusa histórico shallow ou reescrito, neutraliza ambiente/configuração Git hostil e compara diretamente bytes e modo do arquivo físico com o blob indexado, sem confiar no stat cache. Toda entrada física precisa estar indexada ou visível canonicamente como untracked — nunca ocultada por uma regra de ignore — e toda adição precisa avançar estritamente o head da base.

## Correções do décimo-sexto Codex review

- a publicação atômica dos três arquivos locais mantém toda a ancestralidade física sob a raiz do repositório aberta e a revalida imediatamente antes e depois da publicação, recusando symlink preexistente acima do diretório-pai, escape da raiz e mudanças observadas entre os checks; um writer concorrente com permissão sobre o checkout permanece fora da fronteira portátil;
- um contrato de rede único exige o host textual e parseado exatamente `127.0.0.1` em runtime, E2E, bootstrap e `psql`, sem aceitar `localhost`, IPv6 ou representações IPv4 alternativas que o parser normalizaria;
- a migration append-only `20260811000100` revoga `TEMPORARY` de `PUBLIC`, preserva somente grants administrativos já explícitos da stack e faz os dois entrypoints de readiness recusarem a capacidade efetiva para `app_dal` e `app_runtime_local`.

## Correções do décimo-sétimo Codex review

- cada Next iniciado como `webServer` persistente do Playwright converte uma saída natural inesperada com código `0` em falha `1`, preserva códigos não zero e sinais naturais e reserva o fluxo de shutdown solicitado para o encerramento coordenado existente; depois de um `close` natural, o wrapper não reutiliza PID já liberado no Windows nem força o PGID POSIX compartilhado, evitando matar outro processo ou apagar o próprio status de falha.

## Observabilidade e operação

`/live` e `/ready` expõem aplicação, release, timestamp e `requestId`, propagam somente UUID válido, desabilitam cache e não revelam falha de banco. Não há evento de domínio que justifique logger falso; logging JSON entra no primeiro comando real e provider externo permanece em PEND-008.

## Destaques da documentação atualizada

A lista abaixo destaca os contratos centrais alterados; o diff Git do PR continua sendo o inventário completo dos arquivos modificados.

- ADR-017;
- ADR-018;
- `README.md`, `PACKAGE_INDEX.md` e `CODEX_HANDOFF.md`;
- `docs/context.md`;
- `docs/database.md`;
- `docs/design-system.md`;
- `docs/environment-variables.md`;
- `docs/observability.md`;
- `docs/tooling.md`;
- `docs/implementation-order.md`;
- `docs/dependencias-utilizadas.md`;
- `docs/open-decisions.md` e `docs/feature-sequence.json`;
- `pendencias.md`.

## Rollback/correção

Reverter o commit da fundação antes de qualquer feature dependente. As migrations já aplicadas continuam append-only; não há dado de produção, migration de domínio ou recurso cloud para remover.

## Evidência de conclusão

Rodada final comprovada no runtime fixado Node `24.18.0`/npm `11.19.0`, na ordem de `AGENTS.md`:

- `npm ci`: 435 packages reproduzidos pelo lockfile, zero vulnerabilidades;
- `npm run format:check`, `lint` e `typecheck`: aprovados sem warning;
- `npm run test:unit`: 270 aprovados;
- `npm run supabase:reset`: banco vazio reaplicado e ambientes runtime/E2E separados;
- `npm run test:db`: 156 aprovados e snapshot SQL/tipos conferidos byte a byte;
- `npm run docs:check`: 34 features, 193 cenários de produto e 18 ADRs coerentes;
- `npm run test:e2e:affected`: 36 aprovados;
- `npm run build`: aplicações pública e backoffice aprovadas;
- `npm run audit`: zero vulnerabilidades;
- `npm run knip`: aprovado sem hint.

`node scripts/release-manifest.mjs` permanece um gate pós-commit porque exige checkout limpo e vincula o pacote ao SHA. A evidência exata de cada publicação e dos ciclos de review fica registrada no PR.
