# Mudança: fechamento documental pós-merge da FEAT-002

- Data: 2026-08-11
- Autor/agente: Codex
- Issue/PR: branch `docs/feat-002-completion`; PR documental deste ciclo
- Features: FEAT-002
- ADRs: ADR-017 e ADR-018
- Risco: baixo — somente estado documental
- Rollback: reverter este commit documental

## Resumo

Registra que o PR #2 foi integrado a `main` no merge `d272657` e promove a FEAT-002 para a primeira das 34 features concluídas no repositório.

## Motivo

Os documentos vivos foram deliberadamente mantidos em 0/34 até o merge. Depois da integração, esse estado passou a contradizer o histórico Git e o próprio Definition of Done já comprovado.

## Comportamento anterior

README, feature, contexto técnico e resumo HTML ainda apresentavam a FEAT-002 como em validação ou aguardando merge.

## Comportamento novo

A documentação registra 1/34, referencia o PR e o merge exatos e separa a conclusão no repositório dos bloqueios externos de go-live.

## Arquivos/componentes

Somente documentos vivos, catálogo, índice e resumo executivo HTML.

## Banco, migration, grants e RLS

Nenhuma mudança. Permanecem 11 migrations, head `20260811000400` e 236 asserts pgTAP verdes.

## Segurança e privacidade

Nenhuma fronteira de segurança foi alterada. As pendências externas PEND-002, PEND-003, PEND-005 e PEND-006 continuam abertas.

## Read models, comandos e invalidação

Nenhuma mudança de runtime.

## UX, mobile e acessibilidade

Nenhuma mudança de interface; o HTML executivo conserva estrutura, navegação e semântica existentes.

## Testes e IDs QA

Nenhum cenário foi acrescentado. Permanecem 194 cenários catalogados, 59/59 execuções Playwright, 458/458 unitários e 236/236 asserts pgTAP na evidência da feature.

## Observabilidade e operação

Nenhuma mudança operacional. A release local imutável continua vinculada ao commit técnico `da34f46`, sem atribuí-la ao merge ou a este ajuste documental.

## Documentação atualizada

README, índice do pacote, contexto técnico, catálogo, documento da feature, plano de migrations, `pendencias.md` com referências estáveis aos PRs #1/#2, registro principal da FEAT-002 e resumo HTML.

## Rollback/correção

Reverter este commit restaura apenas a fotografia documental anterior; nenhum artefato técnico ou dado é afetado.

## Evidência de conclusão

O `main` local e `origin/main` apontavam para o merge `d27265728b7c675d373c1bc8425f227aa3e3641e` antes deste ajuste. `format:check`, `docs:check` e `git diff --check` passaram antes da publicação do PR documental.
