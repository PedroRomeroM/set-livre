# Contexto técnico vivo

## Estado vivo verificado

- Projeto: Set Livre.
- Produto alvo: plataforma web completa de aluguel de estúdios audiovisuais.
- Mercado inicial: Curitiba/PR.
- Equipe informada: três desenvolvedores com disponibilidade média de duas horas produtivas por dia cada.
- Repositório remoto: `PedroRomeroM/set-livre`.
- A fundação executável, a FEAT-002 e a FEAT-003 foram incorporadas a `main`; os PRs #2 e #4 concluem duas das 34 features.
- O commit `d755c9f`, citado no pacote recebido, não pertence ao histórico efetivamente encontrado.
- O fluxo autorizado é branch separada, PR para `main`, suíte completa e ciclos de `@codex review` antes de merge.
- O progresso resumido para acompanhamento e apresentação fica em `contexto-projeto-set-livre.html`; toda mudança técnica precisa mantê-lo sincronizado sem substituir as fontes canônicas.
- Nenhum arquivo do projeto Spenses foi alterado.

## Estado desta documentação

Este pacote substitui a especificação anterior do mini fórum. A plataforma descrita é o marketplace final comercializável, dentro do escopo aprovado do MVP Completo.

## Decisões fechadas

- Next.js + React no frontend e runtime server-side.
- Supabase Cloud para Auth, PostgreSQL e Storage.
- VM Oracle Cloud Free Tier para runtime.
- Calendário próprio é a fonte de verdade.
- Google Calendar não integra a baseline.
- Reserva instantânea somente após confirmação de pagamento.
- Cartão e PIX.
- Split 80/20 sobre valor bruto.
- Taxas do gateway absorvidas pela plataforma.
- Repasse ao dono após o uso.
- Reembolso total, com processamento automatizado quando possível e fallback administrativo.
- Conteúdo publicado passa por aprovação; edição cria nova revisão.
- Home e listagem são páginas distintas.
- Home não lista estúdios.
- Listagem usa filtros e ordenação por preço.
- Sem busca textual, avaliação e mapa.
- Backoffice é aplicação separada.
- Mobile a partir de 320 px e WCAG 2.2 AA.
- Toda alteração de código atualiza documentação viva.
- Toda feature possui Playwright.
- Dependências de feature são classificadas pelo ADR-017; `docs/implementation-order.md` é a única sequência executável das 34 features.
- A etapa atual é local-first conforme ADR-018; CI/CD, Supabase Cloud, Oracle e APIs externas permanecem dependências de release.
- A release local falha fechada antes de cleanup quando `.artifacts` ou uma árvore gerada é/contém mount; no Linux a prova usa o `mountinfo` do namespace, inspeção física e retiro atômico, sem atravessar volumes externos.
- A baseline do banco revoga `TEMPORARY` de `PUBLIC`; DAL e login runtime não podem criar tabelas temporárias, enquanto grants explícitos administrados pela stack permanecem intactos.
- A FEAT-002 implementa Auth e `legal-core` sem antecipar `/conta`, dados pessoais completos ou retorno de reserva: uma intenção opaca no DAL é consumida pelo trigger de `auth.users` para criar perfil mínimo e aceites na mesma transação; a metadata transitória é removida e os callbacks mantêm o token somente no fragmento até o POST server-side.
- A FEAT-003 está concluída e incorporada a `main` pelo PR #4: completa o perfil PF/PJ, introduz `/conta` e `/conta/seguranca`, mantém CPF/CNPJ e documento adicional somente no DAL privado e projeta apenas máscaras e a preferência visual autoritativa para a interface.
- A FEAT-004 está em implementação na branch própria, com o [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6). O terceiro P2 e sua release funcional `2a86acc4...` permanecem evidência histórica. O review `PRR_kwDOTyzZrs8AAAABJrjWnQ`/REST `4944615069`, submetido em `2026-08-15T20:02:30Z` sobre `11464a37593d510f5774af6af6fe655e671a9c35`, abriu a thread atual e não resolvida `PRRT_kwDOTyzZrs6ZigTV`, comentário `PRRC_kwDOTyzZrs7h6SPS`/REST `3790152658`. O quarto P2 introduz `recipientOnboardingCapability: "local_adapter" | "unavailable"` obrigatória nas duas projeções e nos três retornos POST, derivada no servidor por request: `APP_ENV=local | test` habilita somente o adapter local; `development | production`, ausência ou valor inválido falham fechados. Em `unavailable`, os fatos permanecem consultáveis, start/refresh retornam `503 PAYMENT_PROVIDER_UNAVAILABLE` antes de `prepare`/reserva de operação e a UI remove notice/CTAs, exibindo o alerta factual de integração indisponível. O fechamento local passou com 734/734 unitários, banco 358/358, browser focado 23/23 e integral 114/114; um único build passou com 26 + 4 rotas e `BUILD_ID=local`. O smoke customizado não produziu evidência verde: três tentativas foram recusadas por problemas do próprio harness. A release canônica local `969f30cd...` foi gerada uma vez; seu smoke embutido, secrets, paridade e cleanup passaram, e duas auditorias terminaram `NO-BLOCKER`. Não há provider externo, migration, publicação, resolução, aprovação, ready ou merge. PEND-003/004/006 e o smoke ARM64 nativo continuam bloqueando produção.

## Baseline técnica

- Next.js 16;
- React 19;
- Node.js LTS suportado, fixado no repositório;
- npm e `package-lock.json`;
- TypeScript estrito;
- CSS Modules e CSS variables;
- TanStack Query;
- Zod;
- Supabase JS/SSR;
- `pg` server-only;
- Vitest, Playwright, axe;
- ESLint, Knip e npm audit;
- GitHub Actions;
- Nginx e systemd;
- output standalone;
- release imutável por SHA.

## Próxima ação operacional

A FEAT-003 foi incorporada a `main` pelo [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4), no merge `465d195ac6bed86a329ef961dafec5b38d9ebf6f`, em `2026-08-12T06:57:15Z`. O HEAD final `1530f62589ed9f823ca9c7356ad530ecda8a8d4b` recebeu a revisão Codex limpa `5262964258` às `06:00:43Z`, com a mensagem “Codex Review: Didn't find any major issues. Swish!”, e as cinco threads do PR ficaram resolvidas.

O snapshot funcional final da FEAT-003 passou em 578/578 unitários distribuídos por 60 arquivos, 293/293 asserts pgTAP (158 + 78 + 57), head `20260811000500`, 91/91 execuções Playwright/axe e 32/32 execuções da própria feature. Lint, typecheck, audit com zero vulnerabilidade, Knip, builds e smokes de web/backoffice também passaram. A release local canônica do commit `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7` contém 2.809 artefatos e possui SHA-256 `6edb2e246e0b3f46cf83f62ce8685e14b91cb31ac1437931f476fc649621273a`; ela continua sendo evidência histórica local, sem significar go-live ou deploy de produção.

Publicar o commit funcional e a documentação da release canônica local do quarto P2 no [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6), responder e resolver `PRRT_kwDOTyzZrs6ZigTV`, solicitar novo `@codex review`, aguardar no mínimo 60 minutos e fazer uma captura final única. Ready e merge dependem dessa leitura limpa. PEND-003 e o smoke ARM64 nativo continuam bloqueando produção.
