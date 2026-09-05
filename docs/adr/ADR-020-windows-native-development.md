# ADR-020 — Desenvolvimento Windows nativo e proporcional

## Status

Aceito em 2026-08-24, consolidando a mudança de workstation autorizada em 2026-08-16. A decisão sobre
o runtime de containers foi substituída pelo ADR-023 em 2026-08-30; aplicação e testes permanecem
nativos no Windows.

## Contexto

A estação canônica passou de Linux para Windows 11. CI e produção continuam Linux x86_64. A primeira
adaptação tentou reproduzir no ambiente local controles de filesystem e processo próprios de uma
fronteira hostil de produção, criando milhares de linhas e testes sem ameaça proporcional.

## Decisão

- aplicação, Vitest e Playwright funcionam em Windows nativo;
- Node e npm continuam fixados pelo `package.json` e pelo lockfile;
- Docker Engine e Supabase CLI executam na distro WSL2 dedicada definida pelo ADR-023; a stack local
  contém somente dados QA descartáveis;
- scripts locais validam o mínimo necessário para impedir conexão acidental com produção, mas não
  implementam uma sandbox de sistema operacional;
- encerramento de processos locais pode usar as primitivas simples da plataforma, inclusive
  `taskkill /T` no Windows, porque essa fronteira é temporária e não executa como serviço de produção;
- DACL, reparse points, mount namespaces e identidade física de executáveis só recebem código próprio
  se um incidente ou ameaça demonstrável exigir;
- CI Linux comprova o artifact e as operações POSIX; produção nunca usa scripts Windows;
- um expediente temporário local pode ser usado e removido antes da promoção, conforme ADR-022.

## Alternativas

- executar aplicação e test runner dentro do WSL: rejeitado pela escolha explícita da workstation;
- manter a implementação de Job Object e guards de ACL próprios: rejeitado por complexidade e custo de
  manutenção desproporcionais;
- reutilizar credenciais ou dados produtivos localmente: rejeitado por segurança.

## Consequências

- o ambiente local fica menor e mais compreensível;
- uma interrupção abrupta ainda pode exigir encerrar manualmente um processo local, sem afetar dados
  reais ou a produção;
- segurança de produção permanece integralmente em Linux, systemd, Nginx, NSG/iptables persistente,
  Fail2ban e SSH por chave.
