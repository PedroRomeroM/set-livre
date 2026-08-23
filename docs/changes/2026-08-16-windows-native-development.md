# Mudança: desenvolvimento local Windows nativo

- Data: 2026-08-16
- Autor/agente: Codex
- Issue/PR: branch `codex/windows-native-development`
- Features: infraestrutura transversal; sem nova feature de produto
- ADRs: ADR-014, ADR-018, ADR-019, ADR-020 e ADR-023
- Risco: alto — bootstrap local, arquivos secretos, cleanup de build e gates multiplataforma
- Rollback: reverter esta branch e reinstalar dependências a partir do lock; a fotografia Codex anterior à importação permanece fora do repositório até validação humana

## Resumo

Converte a estação de desenvolvimento para Windows 11 nativo, sem WSL, preservando CI e produção Linux. Naquele snapshot de 2026-08-16, anterior ao ADR-021, a mudança removia pressupostos POSIX do caminho local, adicionava equivalentes NTFS/DACL e ainda mantinha o empacotamento/release em Linux/ARM64. O alvo vivo posterior é Linux x86_64/E2 Micro, conforme o ADR-021; esta frase preserva somente o histórico datado.

## Motivo

O repositório foi transferido de uma workstation Linux para Windows. O setup existente recusava Windows antes do reset local, os scripts E2E usavam sintaxe de shell POSIX, a CLI Supabase dependia de shim não executável por `spawn` nativo e o cleanup de `.next` só aceitava Linux. Arquivos `.env` copiados também não possuíam uma prova DACL equivalente a `0600`.

## Comportamento anterior

- `local:setup` exigia `psql` físico e falhava deliberadamente no Windows;
- scripts E2E prefixavam `E2E_ALLOW_LOCAL=1` no comando npm;
- Supabase era chamado pelo nome `supabase` no `PATH`;
- Docker Desktop aceitava apenas o context/pipe `default`;
- árvores `.next` existentes não podiam ser removidas com segurança no Windows;
- guards de segredo pulavam modo/owner sem validar uma DACL Windows;
- testes de release GNU/POSIX eram coletados como se fossem portáveis.

## Comportamento novo

- setup local usa `pg` diretamente e comprova as identidades administrativas/DAL;
- CLI Supabase é resolvida no workspace e executada pelo Node fixado;
- Docker aceita somente os pares locais seguros `default`/`docker_engine` e `desktop-linux`/`dockerDesktopLinuxEngine`, exigindo engine Linux;
- no Docker Desktop Windows canônico, a opção oficial `Localhost only` é validada no arquivo físico do perfil antes do start; a inspeção aceita apenas `127.0.0.1` literal ou a representação local-only `127.0.0.1` + `::` e vincula exatamente Kong/Postgres/Studio/Inbucket a `8000/5432/3000/8025` TCP e `54321/54322/54323/54324`, recusando wildcard IPv4, UDP, troca, extra, ausência ou duplicação; Linux continua exigindo bind literal em `127.0.0.1`;
- E2E recebe autorização exclusivamente do arquivo privado criado pelo bootstrap;
- secrets usam DACL protegida; inspeções nativas têm timeout finito e falham fechadas; árvores removíveis rejeitam reparse points e arquivos regulares exigem allowlist exata antes de qualquer unlink no Windows;
- testes Linux-only ficam condicionados à plataforma, enquanto cenários Windows usam junction/feature detection quando aplicável;
- naquele snapshot inicial, Playwright mantinha o suporte Windows por `taskkill` e ausência de
  `gracefulShutdown` POSIX; o antigo prefixo de variável POSIX foi removido. Essa fronteira foi
  substituída canonicamente pelo ADR-023 no delta posterior descrito abaixo;
- executores Supabase/Playwright validam Node, manifesto, pacote fixado, entrypoint físico e cadeia DACL; no Windows, o ambiente filho nasce de allowlist case-insensitive, sem variantes de loaders/overrides/secrets, e o webServer substitui qualquer `ComSpec` pelo `SystemRoot\System32\cmd.exe` físico;
- a instalação do firewall usa Windows PowerShell `5.1` físico absoluto, policy efetiva `RemoteSigned`, `Process=Undefined` e PS1 absoluto; recusa qualquer `Bypass`, override de processo ou escopo fora de `Undefined`/`RemoteSigned`, cria cópia aleatória com DACL privada, bloqueia a fonte contra escrita durante a cópia, confere SHA-256 e solicita UAC somente para a cópia por `EncodedCommand`;
- saída natural de processo persistente no Windows continuava falhando sem mirar PID liberado e
  registrava o bloqueio. O delta posterior fechou essa lacuna com ADR e implementação próprios, sem
  reclassificar a evidência daquele snapshot como se já contivesse Job Object.

## Delta posterior — Job Object canônico

O ADR-023 remove `taskkill`, o módulo antigo de árvore Windows e a tolerância a possível órfão do
caminho atual. `scripts/windows-job-object-guardian.cs` cria o alvo com `CREATE_SUSPENDED`, associa-o
a um Job Object `KILL_ON_JOB_CLOSE` e somente então executa. Um canal de lifecycle fecha o Job se o
supervisor Node terminar; saída natural da raiz também fecha o handle e elimina descendentes.

O resolver usa exclusivamente o `csc.exe` físico do Microsoft .NET Framework sob `SystemRoot`, fonte
versionada e cache privado em `%LOCALAPPDATA%\SetLivre`. Fonte do guardian, fonte do supervisor e
bytes do compilador formam a versão SHA-256; mudança concorrente, DACL ampla, reparse point, falha de
compilação, handshake ou associação ao Job bloqueiam o spawn sem fallback. As provas Windows reais
cobrem raiz encerrando primeiro, supervisor abrupto, descendants mortos e porta reutilizável.

## Arquivos/componentes

- scripts de setup, Supabase, Docker, Playwright e filesystem seguro;
- testes unitários de setup, guards, cleanup, release e snapshots;
- `package.json`, workflow CI e `.gitattributes`;
- job GitHub-hosted `Windows native contracts`, obrigatório na proteção de `main`, para executar a suíte unitária integral na plataforma real em vez de aceitar os skips condicionais do Linux;
- ADR-020 e documentação viva de ambiente, tooling, QA, infraestrutura e contexto.

## Banco, migration, grants e RLS

Nenhuma migration, grant, policy ou RLS muda. O mesmo PostgreSQL local em `127.0.0.1:54322` continua descartável; apenas o transporte do bootstrap passa de `psql` externo para `pg` do workspace.

## Segurança e privacidade

O Windows passa a provar owner, DACL protegida e ausência de reparse point para arquivos de ambiente. CLIs locais recusam writers DACL amplos e recebem somente ambiente allowlisted sem diferenciar caixa; `ComSpec` herdado deixa de ser autoridade. Docker continua restrito a endpoint local e engine Linux. A fronteira de publicação usa a opção nativa e suportada `Localhost only`; o wrapper falha antes do start se o setting físico divergir e reprova os containers se os bindings efetivos não forem locais. A antiga compensação por firewall foi removida, em vez de preservar duas fontes de autoridade. Nenhuma credencial, conteúdo de `.env`, token Codex ou configuração OCI entra no repositório. Supabase Cloud e produção Linux não mudam.

## Read models, comandos e invalidação

Sem alteração.

## UX, mobile e acessibilidade

Sem alteração de produto.

## Testes e IDs QA

Sem novos IDs de feature. Entram testes unitários multiplataforma para resolução de CLI, context Docker, conexão `pg`, DACL/reparse point, cleanup Windows e capabilities de filesystem. Playwright continua cobrindo os IDs existentes após instalação dos browsers Windows.

## Observabilidade e operação

A workstation recebeu Node `24.18.0`, npm `11.19.0`, Git, GitHub CLI, OCI CLI, PostgreSQL client, PowerShell oficial `7.6.5` e Docker Desktop/Hyper-V. O `pwsh` do runtime interno do Codex não substitui a instalação do host; o guardian do mutex Supabase fixa Windows PowerShell `5.1` físico sem elevação. O daemon Docker depende de reinício e de virtualização habilitada no firmware. CI/release/produção continuam observáveis no Linux definido pelos ADRs 014/019.

## Documentação atualizada

ADR-020, registro desta mudança, README, tooling, ambiente, stack, dependências, infraestrutura, QA, runbook, contexto e resumo executivo.

## Rollback/correção

Reverter os commits da branch restaura os wrappers anteriores. Depois, executar `npm ci` na plataforma escolhida. A reversão não toca migrations nem dados. A cópia de rollback do estado Codex só será removida após confirmação humana de conversas, memórias e MCPs.

## Evidência atual relevante

- SVM está habilitado e o Docker Desktop `4.86` opera no backend Hyper-V/Linux, sem WSL;
- o setting Docker Desktop `PortBindingBehavior=local-only-port-binding` está ativo; o wrapper continua fail-closed se o arquivo físico, os bindings efetivos ou a matriz de portas divergirem;
- o ADR-023 substituiu integralmente `taskkill` pelo guardian de Job Object, sem fallback ou tolerância a processo órfão;
- a cadeia Supabase local do branch de infraestrutura contém 16 migrations, predecessor `20260815000100` e head `20260819000100`; o pgTAP passou em 4 arquivos e 361/361 testes, com readiness de 17 dependências ACL e 16 rotinas DAL;
- o catálogo documental atual contém 200 cenários;
- a stack continua efêmera, exclusiva para QA descartável e deve ser encerrada com `npm run supabase:stop` após cada uso;
- a suíte integral da branch, o PR, os ciclos de review, o merge, o projeto Supabase de São Paulo, o provisionamento da VM e os deploys ainda estão pendentes. Nenhum desses estados é inferido das provas locais acima.
