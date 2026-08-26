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

No candidato pré-PR: 572 testes unitários, 213 asserts pgTAP e 114 cenários Playwright passaram; format,
ESLint, TypeScript, docs, migration guard, Knip, npm audit, actionlint e ShellCheck também passaram. O CI
repete os gates no SHA publicado e permanece a evidência autoritativa para merge.

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
