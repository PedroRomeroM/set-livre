# Índice do pacote de implementação — Set Livre 1.1

## Conteúdo

Este pacote contém somente arquivos `.md` e representa a documentação de implementação end-to-end da plataforma final Set Livre.

## Arquivos de entrada obrigatórios

1. `AGENTS.md` — contrato operacional dos agentes;
2. `CODEX_HANDOFF.md` — instruções de início e execução do Codex;
3. `docs/00-source-of-truth.md` — precedência e resolução de conflito;
4. `docs/reference/architecture-blueprint.md` — fonte arquitetural fornecida;
5. `docs/specification.md` — escopo canônico do produto;
6. `docs/implementation-order.md` — sequência de construção;
7. `docs/feature-catalog.md` — catálogo das 34 features;
8. `docs/qa-traceability.md` — catálogo dos 193 cenários.
9. `docs/validation-report.md` — validação estrutural da baseline.
10. `MANIFEST_SHA256.md` — hashes de integridade do pacote.

## Indicadores do pacote

| Item | Quantidade |
|---|---:|
| Features | 34 |
| ADRs | 16 |
| Cenários Playwright | 193 |
| Cenários P0 | 134 |
| Cenários P1 | 59 |
| Runbooks | 6 |

## Garantias documentais

- o mini fórum está explicitamente fora desta especificação;
- a arquitetura segue a cadeia Blueprint → ADRs → especificação → docs vivas → testes/migrations → código;
- as aplicações pública e de backoffice são separadas;
- calendário, reserva, pagamento, split, reembolso e repasse possuem contratos próprios;
- cada feature possui cenários Playwright concretos e rastreáveis;
- nenhuma decisão aberta pode ser preenchida silenciosamente pelo agente;
- o manifesto de integridade deve ser regenerado após qualquer alteração do pacote.

## Estado inicial do repositório informado

- commit local existente: `d755c9f chore: initialize repository architecture foundation`;
- contém inicialização do Git e o Blueprint;
- nenhum push realizado;
- governança deve entrar em commit separado;
- nenhum arquivo do Spenses foi alterado.
