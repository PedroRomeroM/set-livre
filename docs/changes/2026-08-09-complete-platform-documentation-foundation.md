# Mudança — Fundação documental da plataforma completa

## Identificação

- Data: 2026-08-09.
- Tipo: documentação e governança.
- Produto: Set Livre — plataforma completa.
- Código de feature: não aplicável.
- Commit anterior informado: `d755c9f chore: initialize repository architecture foundation`.

## Contexto

A especificação anterior estava orientada ao mini fórum. O objetivo desta mudança é substituir essa direção por um pacote de implementação completo para o marketplace final de estúdios, preservando o Blueprint arquitetural anexado como autoridade principal.

## Alterações

- cadeia explícita Blueprint → ADRs → especificação → docs vivas → testes/migrations → código;
- `AGENTS.md`, README, handoff e regras do repositório;
- especificação canônica da plataforma final;
- 16 ADRs iniciais;
- arquitetura end-to-end;
- modelo de domínio e banco;
- contratos de leitura, comandos, cache e invalidação;
- calendário, reserva, pagamentos, mídia e notificações;
- UX, design system, acessibilidade, SEO e performance;
- backoffice separado;
- infraestrutura Oracle/Supabase, releases por SHA, rollback e backup;
- 34 documentos de feature;
- catálogo de QA com 193 cenários Playwright;
- runbooks, riscos, dívida técnica, decisões abertas e roadmap.

## Decisões relevantes

- npm, CSS Modules, CSS variables e primitives próprias;
- TanStack Query para estado remoto;
- `POST /api/commands` e DAL restrito para escritas críticas;
- migrations append-only, grants mínimos e RLS;
- read models e keyset pagination;
- calendário próprio canônico;
- backoffice em aplicação independente;
- Next.js standalone, systemd, Nginx e release imutável por SHA;
- documentação viva e Playwright por feature.

## Compatibilidade

- Não altera código de aplicação.
- Não altera migrations existentes.
- Não altera arquivos do projeto Spenses.
- Não executa push.
- Deve ser commitada separadamente da implementação.

## Validação documental

- todos os arquivos do pacote são `.md`;
- Blueprint preservado byte a byte;
- IDs de feature e cenário sem duplicação;
- cada feature contém critérios de aceitação, Playwright e Definition of Done;
- links internos validados;
- caminhos de specs Playwright concretos, sem placeholder de suíte;
- manifesto SHA-256 gerado ao fim do pacote.

## Rollback

Remover exclusivamente os arquivos adicionados por este commit documental. Não reescrever o commit anterior e não remover o Blueprint original.

## Próximo passo

Criar a fundação do monorepo/workspaces e o primeiro corte vertical descrito em `docs/implementation-order.md`, mantendo documentação, migrations e testes no mesmo fluxo de mudança.
