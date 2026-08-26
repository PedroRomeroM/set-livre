# Mudança: simplificação da infraestrutura e entrega controlada

- Data: 2026-08-26
- Autor/agente: Codex
- Features: fundação transversal, sem nova feature de produto
- ADRs: ADR-001, ADR-014, ADR-019, ADR-020, ADR-021, ADR-022, ADR-023, ADR-024 e ADR-025
- Risco: alto — baseline única do banco, CI obrigatório e deploy de produção
- Rollback: releases web voltam pelo symlink atômico; migrations são forward-only e exigem expand/contract

## Resumo

Consolida a fundação operacional, remove automação e documentação históricas que não pertenciam ao
estado operacional, estabelece o ciclo obrigatório de review e define a entrega da `main` ao Supabase
Cloud e à VM Oracle `VM.Standard.E2.1.Micro`.

## Motivo

O bootstrap anterior acumulou scripts, evidências transitórias e contratos sobrepostos. A mudança reduz
a superfície rastreada, preserva somente automação executável e deixa PR, checks, deployment e logs como
fontes de evidência por execução.

## Contratos resultantes

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
deploys seguintes apenas validam a credencial existente, sem rotação implícita. Readiness usa uma
allowlist exata de comandos DAL, rejeita ACL herdada por `PUBLIC`, ownership ou membership inesperada e
aceita somente `CONNECT` como grant direto do login. O health preserva heads aplicados para rollback
expand/contract, enquanto o deploy exige o maior head remoto exatamente igual ao candidato.

## Segurança e privacidade

Secrets permanecem somente no environment `production` do GitHub. PRs não os recebem. SSH usa chave
exclusiva e comando forçado; a VM expõe apenas 22, 80 e 443, mantém 3000/3001 em loopback e serve cabeçalho
`X-Robots-Tag` e `robots.txt` bloqueando indexação. O bootstrap publica Node somente após validação
integral, substitui o alias legado por link canônico recuperável, rejeita certificado com menos de 24
horas restantes, preserva apenas swapfiles que cumpram o manifesto e a borda encaminha o UUID de
correlação para validação pela aplicação. O contrato também recusa qualquer identidade, unit, credencial,
ferramenta ou árvore remanescente do deploy pull aposentado; sua retirada é uma migração administrativa
única e não adiciona outro mecanismo permanente ao repositório.

## Read models, comandos e invalidação

Não há mudança funcional nesses contratos. A baseline preserva os comandos privados, read models e
invariantes das features já implementadas.

## UX, mobile e acessibilidade

Não há mudança funcional de interface. Os gates visuais existentes continuam cobrindo engines e
viewports aplicáveis, safe areas, zoom de 200% e Axe.

## Qualidade e QA

- CI Linux e Windows executa os gates estáticos, unitários, SQL, Playwright e builds aplicáveis;
- falha Playwright preserva relatório, traces, screenshots e vídeos por sete dias sem acumular artifact
  em execução verde;
- cenários visíveis permanecem determinísticos entre engines, sem retries ou timeouts ampliados para
  mascarar falhas;
- o ambiente Supabase local preserva as permissões exigidas pelos serviços oficiais sem ampliar o
  acesso das roles da aplicação;
- o laboratório Ubuntu cobre upload, ativação, interrupção, recuperação, rollback e smoke do artifact
  standalone sob as mesmas fronteiras instaladas na VM;
- o empacotamento aceita somente conteúdo regular originado da release e das dependências instaladas
  pelo lockfile, enquanto o host rejeita entradas fora desse contrato.

Resultados de execução, diagnósticos, contagens e histórico de correções permanecem no PR, nos checks e
no Git.

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

## Evidência de execução

Review, merge, migrations, deployment e health são comprovados nas superfícies autoritativas do PR, dos
checks e do Git, sem duplicação de logs ou cronologia neste documento.
