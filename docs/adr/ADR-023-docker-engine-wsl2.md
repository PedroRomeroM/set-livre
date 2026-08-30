# ADR-023 — Docker Engine dedicado no WSL2

## Status

Aceito em 2026-08-30. Substitui somente a decisão de runtime de containers do ADR-020.

## Contexto

Docker Desktop 4.88.1 no Windows 11 build 26200 voltou a falhar depois de uma parada graciosa. O
backend não conseguia remover `sailor-ingest.sock`; reinstalação limpa, reinício da máquina e novo ciclo
de stop/start reproduziram o defeito. A aplicação precisa de um daemon compatível com a Supabase CLI,
mas não precisa mover Node, Next.js ou Playwright para Linux.

## Decisão

- aplicação, Vitest e Playwright continuam nativos no Windows;
- somente o daemon roda na distro WSL2 `SetLivreDocker`, Ubuntu 24.04, com `systemd` e pacotes do
  repositório oficial Docker;
- a CLI Supabase Linux instalada na distro precisa ter exatamente a versão fixada no projeto; o wrapper
  valida essa igualdade antes de cada comando e converte somente caminhos Windows absolutos;
- Docker CLI oficial no Windows usa o contexto `set-livre-wsl`, preso exatamente a
  `tcp://127.0.0.1:2375`; o daemon conserva também seu socket Unix interno;
- o wrapper inicia `docker.service` sob demanda; os parâmetros oficiais
  `[general] instanceIdleTimeout=28800000` e `[wsl2] vmIdleTimeout=28800000` mantêm respectivamente a
  distro e a VM por oito horas desde a última atividade, sem tarefa ou processo artificial de
  manutenção;
- o wrapper local recusa seletores de ambiente, outro contexto, endpoint não exato, engine não Linux,
  bridge divergente e qualquer publicação de container fora de `127.0.0.1`;
- a API sem TLS é permitida apenas nesse loopback local, nunca é encaminhada e nunca recebe dados ou
  credenciais de produção;
- produção continua sem Docker e não depende desta decisão.

## Alternativas

- manter Docker Desktop: rejeitado porque o crash foi reproduzido na instalação limpa;
- fazer downgrade para uma versão antiga: rejeitado por não existir versão suportada com correção
  comprovada nesta build do Windows;
- mover todo o desenvolvimento para WSL: rejeitado por ampliar a migração sem necessidade;
- usar daemon remoto ou a VM de produção: rejeitado por quebrar isolamento e segurança dos testes.

## Consequências

- desaparecem GUI, backend e sockets NTFS próprios do Docker Desktop;
- o ambiente ganha uma dependência WSL2 pequena e explícita, sem transformar o projeto em checkout
  Linux;
- as configurações `instanceIdleTimeout` e `vmIdleTimeout` são globais ao WSL2 desta estação e precisam
  ser reavaliadas antes de introduzir outra distro com contrato de ciclo de vida diferente;
- o listener local é privilegiado e exige loopback estrito, contexto exato e dados descartáveis;
- atualização de Docker ou Windows exige repetir stop/start do runtime, smoke de container e reset
  completo do Supabase antes de promovê-la como suportada.
