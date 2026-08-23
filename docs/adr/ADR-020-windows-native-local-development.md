# ADR-020 — Desenvolvimento local Windows nativo

## Status

Aceito em 2026-08-16 por instrução humana explícita. A supervisão de processos Windows foi
atualizada pelo ADR-023 em 2026-08-19.

## Contexto

O Blueprint, seções 6, 18, 19, 21, 23 e 26, exige um ambiente local reproduzível, testes destrutivos isolados, proteção física de segredos, gates executáveis e produção Linux. Os ADRs 014 e 019 fixam Oracle Ubuntu, systemd, Nginx e releases imutáveis como fronteira de produção; o ADR-021 atualiza essa fronteira para `VM.Standard.E2.1.Micro` x86_64. Nenhum deles exige que a estação de desenvolvimento também seja Linux.

A estação de trabalho canônica passou a ser Windows 11 nativo. A implementação anterior continha pressupostos POSIX no bootstrap PostgreSQL, na resolução da CLI Supabase, nos comandos npm do Playwright, na remoção física de `.next`, na proteção de arquivos de ambiente e em testes do empacotamento Linux. Usar WSL ocultaria essas divergências e foi expressamente recusado pelo responsável.

## Decisão

- desenvolvimento, preview, build, Supabase local, testes SQL e Playwright devem funcionar em Windows nativo, sem WSL;
- Docker Desktop usa somente containers Linux com backend Hyper-V; virtualização de firmware e Hyper-V são pré-requisitos locais, e contexts remotos, TCP, SSH ou engine Windows continuam proibidos pelo guard;
- a bridge Supabase e o daemon continuam com bind default `127.0.0.1`, e o Docker Desktop Windows precisa usar sua opção oficial **Port binding behavior = Localhost only**. O wrapper abre o `settings-store.json` físico do perfil antes do start, exige `PortBindingBehavior=local-only-port-binding` e revalida identidade/tamanho por descritor. Depois do start, aceita apenas `HostIp=127.0.0.1` literal ou a representação local-only `127.0.0.1` + `::`; wildcard IPv4 é sempre recusado. A fronteira foi comprovada por listeners somente em `127.0.0.1` e falha de conexão pelas interfaces não-loopback. A compensação anterior por regra customizada do Windows Firewall foi aposentada em favor do controle nativo suportado. Linux continua exigindo `HostIp=127.0.0.1` literal;
- Node `24.18.0` e npm `11.19.0` são instalações físicas adjacentes; shims baseados em junction de gerenciadores de versão não substituem esse contrato;
- o bootstrap do banco usa o driver `pg` já fixado no workspace, com destino loopback, SSL desligado, timeouts e identidades `current_user`/`session_user` comprovadas; um executável `psql` externo deixa de ser autoridade do setup local;
- a CLI Supabase e o instalador de browsers Playwright são dependências fixadas do workspace, executadas pelo Node confiável através de entrypoints absolutos, físicos e com cadeia DACL sem escritor não confiável. No Windows, os ambientes filhos são reconstruídos por allowlist case-insensitive; nenhuma grafia alternativa de `NODE_OPTIONS`, `NODE_PATH`, override de binário ou variável desconhecida atravessa a fronteira;
- arquivos de ambiente no Windows usam DACL protegida, owner esperado e allowlist restrita ao usuário atual, `SYSTEM` e `Administrators`; arquivo ou ancestral com reparse point é rejeitado antes e depois de escrita/rename;
- a remoção de `.next` no Windows valida o alvo autorizado, volume e identidade física, rejeita junctions/reparse points e remove uma árvore aposentada sem atravessar outro volume;
- scripts npm não usam atribuição POSIX de variável de ambiente; o bootstrap privado continua sendo a fonte de `E2E_ALLOW_LOCAL`;
- testes de produto e de portabilidade rodam nas duas plataformas. Provas que exercem especificamente GNU tar, `flock`, `umask`, bits POSIX ou a release canônica rodam somente no Linux e permanecem obrigatórias no CI/release;
- checkout Windows preserva LF canônico para código e documentação, CRLF explícito para `*.ps1`, long paths do sistema/Git e configuração local explícita `core.autocrlf=false`, `core.filemode=false`, `core.symlinks=false`, `core.longpaths=true`, `core.ignorecase=true` e `core.protectNTFS=true`;
- PowerShell `7.6.5` é a instalação oficial disponível ao operador; o `pwsh` empacotado no runtime interno do Codex não é a instalação do host nem autoridade do projeto. A exclusão global das operações Supabase usa exclusivamente o Windows PowerShell `5.1` físico em `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` para manter um mutex nomeado do kernel, sem elevação, script externo ou override de policy;
- no Windows, todo processo Next persistente nasce suspenso através do guardian versionado do
  ADR-023, entra em um Job Object com `KILL_ON_JOB_CLOSE` antes de executar e só então é retomado.
  Shutdown solicitado, saída natural da raiz ou queda abrupta do supervisor fecham o Job e eliminam
  todos os descendentes sem `taskkill`, enumeração ou reutilização de PID;
- CI continua Ubuntu e produção continua Oracle Ubuntu 24.04 x86_64 sem Docker. Caminhos `/opt`, systemd, Nginx, SSH, GNU tar e o symlink atômico de release não serão convertidos para Windows.

## Alternativas

- usar WSL para manter os scripts existentes: rejeitado pela escolha explícita da estação e porque deixaria o caminho Windows sem cobertura;
- instalar ferramentas GNU isoladas para simular Linux: rejeitado para desenvolvimento comum; a release Linux continua provada no ambiente correto;
- manter `psql` como subprocesso confiável nas duas plataformas: rejeitado porque o driver `pg` já pertence à stack, reduz a superfície de PATH/ACL e executa todo o SQL necessário sem metacomandos;
- usar Docker com backend WSL2: rejeitado; Hyper-V é a única fronteira local permitida nesta estação;
- afrouxar validações de owner, ACL ou reparse point no Windows: rejeitado porque arquivos `.env` e árvores removidas são superfícies de segredo e integridade, não exceções de conveniência.

## Consequências

- o primeiro start do Docker exige reinício após habilitar Hyper-V e virtualização VT-x/AMD-V/SVM no firmware;
- no Windows, a defesa é composta pelo bind solicitado em `127.0.0.1`, pela opção oficial `Localhost only`, pela bridge dedicada e pela inspeção efetiva de cada publicação. A stack contém somente dados QA descartáveis e deve ser encerrada ao terminar os testes;
- diferenças entre DACL/NTFS e modo POSIX passam a ter implementações e testes próprios, preservando a mesma intenção de segurança;
- o checkout e os roots das toolchains precisam negar escrita a principals fora de usuário atual, `SYSTEM`, `Administrators` e `TrustedInstaller`; os validadores apenas inspecionam e falham fechados, sem corrigir ACL do host;
- o compilador Microsoft físico, as fontes versionadas, o cache privado e o canal de lifecycle do
  guardian são obrigatórios; qualquer falha nessa cadeia bloqueia o spawn, sem fallback para cleanup
  parcial;
- a suíte unitária Windows faz feature detection somente para operações de symlink que exigem privilégio/Developer Mode; cobertura Linux continua obrigatória para esses casos e para release;
- `npm ci` precisa reconstruir `node_modules` ao trocar de plataforma, pois bindings e shims não são portáveis;
- artefatos de release produzidos no Windows não são canônicos e devem falhar cedo; somente o build/package controlado em Linux x86_64 pode satisfazer o contrato de publicação;
- documentação operacional deve distinguir requisitos da workstation Windows das instruções Linux da VM, sem reescrever evidências históricas.
