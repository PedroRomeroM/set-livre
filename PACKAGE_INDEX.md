# Índice do pacote de implementação — Set Livre 1.1

## Baseline recebida e repositório vivo

A baseline recebida continha somente arquivos `.md` e representava a documentação de implementação end-to-end. Ela foi preservada no commit `e0cca5a`. O repositório atual também contém código, migrations, testes e configuração; este índice não deve ser usado como inventário da árvore viva.

## Arquivos de entrada obrigatórios

1. `AGENTS.md` — contrato operacional dos agentes;
2. `CODEX_HANDOFF.md` — instruções de início e execução do Codex;
3. `docs/00-source-of-truth.md` — precedência e resolução de conflito;
4. `docs/reference/architecture-blueprint.md` — fonte arquitetural fornecida;
5. `docs/specification.md` — escopo canônico do produto;
6. `docs/implementation-order.md` — sequência de construção;
7. `docs/feature-catalog.md` — catálogo das 34 features;
8. `docs/qa-traceability.md` — catálogo vivo dos 198 cenários.
9. `docs/validation-report.md` — validação estrutural da baseline.
10. `MANIFEST_SHA256.md` — hashes de integridade do pacote.
11. `contexto-projeto-set-livre.html` — resumo executivo vivo para acompanhar o progresso e apresentar o estado implementado; não substitui as fontes canônicas.

## Indicadores da especificação de produto

| Item                | Quantidade |
| ------------------- | ---------: |
| Features            |         34 |
| ADRs                |         18 |
| Cenários Playwright |        198 |
| Cenários P0         |        134 |
| Cenários P1         |         64 |
| Runbooks            |          6 |

A baseline recebida continha 193 cenários de produto. O catálogo vivo agora soma 198: a FEAT-002 acrescentou um contrato de reflow e a FEAT-003 acrescenta quatro IDs para acessibilidade, reflow, tema/hidratação e estados adversos. Há 16 IDs automatizados; o snapshot corrente passou em 91/91 execuções browser — 59 da fundação + FEAT-002 e 32/32 da FEAT-003, nos IDs `SL-F003-E2E-001` a `009`. A árvore possui 12 migrations, head `20260811000500`; o hardening corrente também passou em 563/563 unitários distribuídos por 59 arquivos e 293/293 asserts pgTAP. A auditoria browser terminou sem erros finais, attachments, segredos ou resíduos; os 62 e-mails QA únicos aparecem em 102 ocorrências exclusivamente nos títulos automáticos allowlisted (`Fill` 84, `Visible` 10 e `Type` 8). Os builds e smokes standalone dos dois apps também passaram sem warnings; o snapshot anterior `727eecd` permanece como a última release imutável, com 2.801 artefatos. Release, commit/push e novo review do snapshot corrente ainda estão pendentes no draft [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4). A FEAT-002 permanece a primeira das 34 features concluídas; a FEAT-003 segue em implementação até review e merge.

## Garantias documentais

- o mini fórum está explicitamente fora desta especificação;
- a arquitetura segue a cadeia Blueprint → ADRs → especificação → docs vivas → testes/migrations → código;
- as aplicações pública e de backoffice são separadas;
- calendário, reserva, pagamento, split, reembolso e repasse possuem contratos próprios;
- cada feature possui cenários Playwright concretos e rastreáveis;
- nenhuma decisão aberta pode ser preenchida silenciosamente pelo agente;
- o manifesto histórico prova a baseline no commit indicado; mudanças posteriores são provadas por Git, registros em `docs/changes/` e gates locais.

## Estado inicial efetivamente verificado

- o remoto `PedroRomeroM/set-livre` não possuía refs;
- a baseline documental foi publicada em `main` no commit `e0cca5a`;
- a fundação executável passou a ser desenvolvida em branch separada;
- nenhum código de outro projeto foi copiado para este repositório.
