# ADR-023 — Supervisão de processos Windows por Job Object

## Status

Aceito em 2026-08-19 como correção canônica do bloqueio registrado no ADR-020 e em conformidade com
o ADR-022.

## Contexto

Os launchers locais de desenvolvimento, preview e Playwright iniciam processos Next persistentes que
podem criar descendentes. No POSIX, um grupo de processos criado antes do spawn conserva identidade
estável mesmo quando a raiz encerra. O contrato Windows anterior chamava `taskkill.exe /T /F` enquanto
o PID raiz ainda existia, mas não podia provar cleanup depois de saída natural ou queda abrupta do
supervisor sem correr o risco de atingir um PID reutilizado. O ADR-020 deixou essa lacuna bloqueada até
uma decisão própria sobre Job Object.

O ADR-022 proíbe tolerar órfãos, enfraquecer testes ou manter `taskkill` como aproximação quando o
Windows oferece uma primitiva de kernel própria para o ciclo de vida de uma árvore de processos.

## Decisão

- todo processo persistente iniciado pelos wrappers Windows passa por um guardian nativo versionado;
- o guardian cria o alvo com `CREATE_SUSPENDED`, cria um Job Object com
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, associa o processo ao Job e somente então chama
  `ResumeThread`. O código da aplicação nunca executa fora da fronteira supervisionada;
- os descendentes permanecem no mesmo Job Object pelas regras do kernel. Saída da raiz, shutdown
  solicitado, falha de outro app ou término abrupto do supervisor fecham o handle e encerram a árvore
  completa sem enumerar PIDs;
- um pipe herdado e dedicado vincula a vida do guardian ao supervisor Node. EOF ou erro desse canal
  fecha o Job de forma fail-closed. O pipe transporta somente ciclo de vida; como launcher confiável,
  o guardian recebe o ambiente já allowlisted destinado ao próprio alvo para `CreateProcessW`, sem
  payload secundário de cleanup, serialização de segredo ou outro utilitário;
- o guardian é implementado em `scripts/windows-job-object-guardian.cs` e compilado pelo
  `csc.exe` físico do Microsoft .NET Framework instalado no `SystemRoot`. O projeto não baixa binding,
  executável ou pacote nativo;
- fonte do guardian, fonte do supervisor e bytes do compilador compõem a versão SHA-256 do cache. A
  compilação usa caminho absoluto, `shell=false`, ambiente mínimo, warnings como erros e candidato
  privado; alteração concorrente de qualquer entrada reprova;
- o executável fica em cache privado sob `%LOCALAPPDATA%\SetLivre`, com ancestrais sem reparse point e
  DACL restrita. O cache nunca é fonte de autoridade: o hash das três entradas seleciona uma nova
  versão;
- o launcher aceita no Windows somente executável alvo absoluto, argumentos sem NUL, `shell=false` e
  `stdio="inherit"`. A ausência do compilador, do canal ou de qualquer prova física/ACL interrompe o
  spawn;
- `taskkill.exe`, tolerância a possível órfão e módulos antigos de enumeração por PID são removidos do
  caminho atual. Os grupos POSIX continuam inalterados para CI, release e produção Linux;
- testes Windows reais precisam provar, além dos contratos estáticos, raiz encerrando antes do
  descendente, supervisor encerrando abruptamente, processos eliminados e porta reutilizável.

## Alternativas rejeitadas

- continuar com `taskkill /T /F`: rejeitado porque depende da identidade efêmera do PID raiz e não
  cobre queda abrupta do supervisor;
- enumerar descendentes por WMI, CIM ou snapshots: rejeitado por corrida entre enumeração e criação de
  novos processos e por reutilização de PID;
- tolerar órfãos e apenas registrar warning: rejeitado pelos ADRs 020 e 022;
- usar pacote npm ou binding nativo de terceiro: rejeitado porque amplia supply chain sem necessidade;
- executar o alvo e associá-lo ao Job depois: rejeitado porque existe janela em que o processo pode
  criar descendentes fora do Job;
- usar WSL ou ferramentas POSIX no host: rejeitado pelo ADR-020.

## Consequências

- a workstation Windows precisa manter o .NET Framework do sistema e seu compilador físico íntegros;
- a primeira execução de uma versão compila o guardian e pode ser mais lenta; testes de integração
  usam prazo compatível com essa operação real, sem desabilitar timeout;
- um encerramento natural inesperado continua sendo falha, mas não deixa descendentes fora de
  controle;
- fechar o processo guardian é a única operação necessária no supervisor; o kernel encerra a árvore e
  evita sinalizar PID já liberado;
- qualquer falha de compilação, ACL, reparse point, handshake, associação ao Job ou resume bloqueia o
  processo local em vez de degradar para cleanup parcial;
- esta decisão substitui somente as cláusulas do ADR-020 que mantinham `taskkill` e o bloqueio de Job
  Object. As demais decisões Windows, Docker, DACL e fronteiras Linux permanecem válidas.
