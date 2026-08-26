# Mudança: simplificação da infraestrutura e entrega controlada

- Data: 2026-08-26
- Autor/agente: Codex
- Issue/PR: PR da branch `codex/infra-cicd-simplification`; o GitHub é a fonte autoritativa do número e dos reviews
- Features: fundação transversal, sem nova feature de produto
- ADRs: ADR-001, ADR-014, ADR-019, ADR-020, ADR-021, ADR-022, ADR-023, ADR-024 e ADR-025
- Risco: alto — baseline única do banco, CI obrigatório e primeiro deploy cloud
- Rollback: releases web voltam pelo symlink atômico; migrations são forward-only e exigem expand/contract

## Resumo

Consolida a fundação já implementada, remove automação e documentação históricas que não pertenciam ao
estado operacional, estabelece o ciclo obrigatório de review e prepara a entrega da `main` ao Supabase
Cloud e à VM Oracle `VM.Standard.E2.1.Micro`.

## Motivo

O bootstrap anterior acumulou scripts, evidências transitórias e contratos sobrepostos. A mudança reduz
a superfície rastreada, preserva somente automação executável e deixa PR, checks, deployment e logs como
fontes de evidência por execução.

## Comportamento anterior

- não havia uma produção web acessível nem uma baseline aplicada no novo projeto Supabase;
- a automação misturava contratos históricos, preparação e operação recorrente;
- secrets, proteção de branch, host e deploy não formavam um caminho único comprovável;
- release, ambientes e rollback podiam divergir durante uma ativação interrompida.

## Comportamento novo

- CI Linux e Windows executa gates completos antes de permitir merge;
- produção aplica migrations forward-only e publica releases standalone imutáveis por SHA;
- artifact e ambientes do mesmo SHA são ativados por um único symlink, com rollback e recuperação no boot;
- a configuração instalada na VM é vinculada a um digest determinístico e falha fechada quando diverge;
- o site permanece em HTTPS pelo IP `147.15.97.227`, com indexação bloqueada e DNS adiado.

## Arquivos/componentes

As mudanças concentram-se em `.github/workflows/ci.yml`, `ops/`, `scripts/`, configuração do Supabase,
documentação canônica e remoção dos artefatos redundantes identificados na auditoria de organização.

## Banco, migration, grants e RLS

A produção vazia recebe somente `20260824000100_initial_production_baseline.sql`. A migration cria a
baseline final, grants mínimos, RLS e as roles restritas. O login runtime é inicializado uma única vez;
deploys seguintes apenas validam a credencial existente, sem rotação implícita.

## Segurança e privacidade

Secrets permanecem somente no environment `production` do GitHub. PRs não os recebem. SSH usa chave
exclusiva e comando forçado; a VM expõe apenas 22, 80 e 443, mantém 3000/3001 em loopback e serve cabeçalho
`X-Robots-Tag` e `robots.txt` bloqueando indexação.

## Read models, comandos e invalidação

Não há mudança funcional nesses contratos. A baseline preserva os comandos privados, read models e
invariantes das features já implementadas.

## UX, mobile e acessibilidade

Não há nova interface. As composições existentes foram revalidadas nas três engines, viewports móveis,
safe areas, zoom de 200% e Axe.

## Testes e IDs QA

No candidato pré-PR: 573 testes unitários, 213 asserts pgTAP e 114 cenários Playwright passaram; format,
ESLint, TypeScript, docs, migration guard, Knip, npm audit, actionlint e ShellCheck também passaram. O CI
repete os gates no SHA publicado e permanece a evidência autoritativa para merge.

O primeiro check Linux do PR revelou que Knip carregava `playwright.config.ts` antes de existir o
ambiente E2E local e, por isso, classificava todas as specs como não usadas. A configuração agora impede
o carregamento dinâmico e declara o arquivo de configuração e as specs como entradas estáticas, conforme
o contrato oficial do plugin; um teste unitário impede a regressão. A execução que falhou é diagnóstico,
não evidência de aprovação, e o novo SHA precisa repetir CI e review integralmente.

O CI seguinte passou todos os gates Windows, estáticos e de banco, mas revelou uma corrida real no
Firefox Linux: 113/114 cenários passaram e o login ficou pausado quando o monitor de conectividade mudou
antes da mutation. Cadastro, login e recovery agora executam uma única tentativa com
`networkMode: "always"`, limpam as refs efêmeras em qualquer desfecho e nunca reenviam credenciais após
reconexão. O cenário P0 força explicitamente o estado offline, comprova que a request foi iniciada e
repete a revalidação SSR; o novo SHA precisa repetir CI e review integralmente.

O review Codex desse SHA anterior encontrou quatro contratos incompletos. O instalador agora recupera
staging residual validado depois de `SIGKILL`/reboot; a baseline e o provisionador bloqueiam `pg_net` e
configuração sensível visível por catálogos gerenciados antes de habilitar o login; a role de produção
não grava mais GUC vazio; e o artifact Linux é compilado com fixtures das coordenadas de produção antes
do smoke. O ambiente Cloud foi inspecionado sem mutação: `pg_net` está ausente e os catálogos pertencem
a `supabase_admin`. Como o `postgres` gerenciado não possui grant option, um `REVOKE` direto seria um
no-op com warning; o contrato suportado preserva a ACL da plataforma e falha fechado sobre o resultado
de segurança. Testes SQL, unitários e de host cobrem as quatro regressões. O próximo review precisa ser
pedido somente depois do novo commit e de todos os gates.

No candidato corrigido, 575 testes unitários e 217 asserts pgTAP passaram; format, lint, typecheck,
docs, migrations, audit sem vulnerabilidades, Knip, lint do banco, builds nativos dos dois apps e
empacotamento da release também ficaram verdes. O cenário crítico de autenticação passou nos três
engines (36/36) no SHA anterior; o novo SHA repete a suíte Playwright completa e o build Linux no CI.

Enquanto o primeiro lote era corrigido, outra resposta Codex do SHA anterior publicou quatro findings
adicionais. A fronteira de banco agora rejeita `CREATE/TEMP` antes e depois do login; uploads ficam sob
lock e limitados a um SHA; bootstrap incompatível interrompe os apps antes de mutar o host; e uma path unit
aguarda o fim do lock para recuperar symlink, serviços e health após `SIGKILL`. O teste Ubuntu exerce
upload abandonado, espera real pelo lock e os modos de recovery. Como houve novo código depois de
`6f05b4f`, esse commit também é apenas histórico e um novo SHA reiniciará CI e review integralmente.

O primeiro CI desse novo SHA passou Playwright, banco e builds, mas revelou que o teste de host executava
o comando SSH como o usuário restrito diretamente a partir do checkout privado do runner. A produção não
usa esse caminho: o bootstrap instala uma cópia `root:root` em `/usr/local/sbin`. O teste agora instala e
invoca exatamente esse artefato, preservando a restrição de leitura do workspace e exercitando a mesma
fronteira de execução da VM. A execução que revelou a divergência continua sendo evidência diagnóstica;
o próximo SHA deve repetir todos os gates e reiniciar o ciclo de review.

Na repetição, 113/114 cenários Playwright passaram e o Firefox não liquidou de forma consistente o
`fetch` quando o interceptador usou um aborto genérico. O cenário continua colocando o TanStack em estado
offline, exige que a mutation realmente comece e comprova redaction mais reload SSR, mas agora injeta uma
resposta 200 sintaticamente inválida, que representa resultado ambíguo de forma determinística entre os
três engines. Timeout e rejeição real de transporte permanecem cobertos diretamente em unitários, sem
retry, aumento de timeout ou enfraquecimento da asserção E2E.

Ao recuperar o laboratório local depois de uma degradação do Docker Desktop, o Storage oficial
`v1.71.0` revelou que seu upgrade consulta `pg_roles`. O hardening local negava corretamente os três
catálogos às roles da aplicação, mas também havia removido o acesso herdado da identidade interna do
Storage. O bootstrap agora devolve somente `SELECT` em `pg_roles` a `supabase_storage_admin`; o teste
SQL prova simultaneamente essa compatibilidade e a negação efetiva para `app_dal`. Nenhuma role pública
ou da aplicação recebeu acesso adicional.

No candidato atual, o reset integral do Supabase local, lint do schema, 217 asserts pgTAP, 576 testes
unitários e 114 cenários Playwright passaram. Format, ESLint, TypeScript, docs, audit sem vulnerabilidades,
Knip e os builds nativos de web/backoffice também ficaram verdes. O CI ainda precisa repetir esse conjunto
no SHA publicado e o review obrigatório recomeça do zero depois do push.

O CI Linux desse candidato revelou uma corrida exclusiva do cenário composto de perfil em dois viewports
Chromium: a escrita autoritativa terminava em `200`, mas o teste emitia um evento de foco enquanto o observer
se estabilizava e depois aguardava uma barreira interna sem timeout próprio. A revalidação agora repete o evento
real de visibilidade somente até a request interceptada comprovar que o observer iniciou o fetch; todas as
barreiras do cenário também falham cedo com diagnóstico nominal. Não houve retry de teste, aumento do timeout
global nem mudança de produção. Depois da correção, os dois viewports que falharam passaram dez repetições
consecutivas e a suíte integral passou 114/114; os gates estáticos, 576 testes unitários, 217 asserts pgTAP,
builds dos dois apps e empacotamento da release também permaneceram verdes. O próximo SHA deve repetir esse
conjunto no CI e reiniciar o review.

Na repetição em CI, o mesmo cenário composto concluiu o `POST` de recuperação, mas a observação genérica
de `page.waitForResponse` permaneceu sem diagnóstico até consumir os 180 segundos globais. O teste agora
espera a confirmação visível dentro de 15 segundos, prova a contagem exata de comandos e relê o perfil pela
API autoritativa; nenhuma etapa assíncrona depende mais do timeout total do cenário. A mesma execução mostrou
que `networkidle` não é um contrato de prontidão válido para o HMR do `next dev` no Firefox. O teste de reflow
passou a usar somente o heading renderizado e a barreira já existente de `document.readyState`, viewport e
ausência de overflow. As duas mudanças removem esperas ambientais sem retry, relaxamento de asserção ou
alteração do código de produção.

O CI seguinte comprovou 112/114 cenários, mas expôs outro deadlock no mesmo teste composto: para simular uma
leitura que excede o timeout, o callback de `page.route` aguardava uma Promise externa mesmo depois do
`AbortController` da aplicação cancelar o `fetch`. O navegador encerrava a operação, mas a interceptação do
runner continuava pendente até os 180 segundos globais em dois viewports Chromium. A simulação agora instala
no próprio documento um transporte pendente que rejeita exatamente quando recebe o AbortSignal real da
aplicação. Ela mantém a asserção E2E da mensagem e da remoção de PII, termina deterministicamente e passou
20/20 repetições nos dois perfis que falharam, sem retry, aumento do timeout ou mudança de produção.

O CI Linux posterior passou 113/114 cenários e expôs uma corrida no último teste de reflow WebKit:
`scrollIntoViewIfNeeded` rolava uma única vez, enquanto o matcher repetia apenas a medição; se o layout do
segundo app estabilizasse depois dessa ação, a nota final permanecia fora da viewport em todas as tentativas.
A prova agora, em cada amostra limitada pelo mesmo timeout, rola até o fim atual do documento e mede diretamente
se a nota está alcançável. A ausência de overflow horizontal continua sendo verificada separadamente e não houve
retry de cenário, aumento de timeout, alteração de produção ou relaxamento do critério de visibilidade.

Com os 114 cenários e o build Linux verdes, o teste real do instalador revelou que o standalone podia
compartilhar inodes e o GNU tar serializava a segunda ocorrência como hard link. O receptor recusou a
entrada conforme seu contrato estrito. Os dois produtores de archive agora usam `--hard-dereference`,
materializando cada ocorrência como arquivo regular; o instalador continua rejeitando links. Um teste
unitário fixa esse contrato tanto no workflow de produção quanto no laboratório do host.

## Observabilidade e operação

Systemd separa web, backoffice e recuperação de release. Nginx publica somente a web, health checks
validam aplicação e SHA, Fail2ban e firewall persistente protegem a borda, e o workflow acompanha o
deployment até estado terminal.

## Documentação atualizada

Blueprint, ADRs, infraestrutura, desenvolvimento, segurança, review/deploy, configuração humana,
`AGENTS.md`, `README.md` e o resumo executivo HTML foram reconciliados com o estado implementado.

## Rollback/correção

Falha antes da ativação não altera `current`; falha depois da troca recupera a release anterior. Sem
release anterior, os serviços param. Falhas de migration não são revertidas automaticamente e exigem
nova migration corretiva append-only.

## Evidência de conclusão

Este registro descreve o candidato. Review limpo, merge, migration cloud, deployment e health público
serão comprovados nas superfícies autoritativas do PR e do GitHub Actions, sem copiar logs transitórios
para o repositório.
