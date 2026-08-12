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
- A FEAT-004 está em implementação na branch própria, com o [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6) `OPEN`/draft contra `main`. O primeiro review draft, ID `PRR_kwDOTyzZrs8AAAABJQvhhQ`, terminou em `2026-08-12T12:32:57Z` sobre `07dcbb06b4f07fdb477211c90c77e0aed759a0cb` e abriu dois P2 ainda não resolvidos. As correções locais separam a projeção completa de ativação — `get_owner_activation_status`, `/dono` e `GET /api/owner/activation`, 21 colunas com o documento — da projeção operacional de recebimentos — 16 colunas sem título, versão textual, hash ou corpo, usada por `/dono/recebimentos`, `GET /api/owner/recipient` e `start | refresh`. `CONFLICT` e `VALIDATION_FAILED` sem `fieldErrors` agora exigem GET autoritativo e nunca repetem o POST; validação de campo continua editável. A árvore possui 14 migrations no head `20260812000200`; Node 24 passou reset, geração e `test:db` em 355/355 asserts (`158 + 78 + 57 + 62`), com readiness atual verde, head anterior recusado, gerados sincronizados e cleanup zero. Os gates completos pós-review também passaram: format, lint sem warnings, typecheck integral, 716/716 unitários em 74 arquivos, docs 34/200/18, audit zero, Knip e diff-check. A matriz focada atual passou em 23/23, quatro specs/14 projetos/126,0 segundos, e a integral em 114/114, 17 specs/16 projetos/cerca de 5,7 minutos; ambas tiveram zero resultado inesperado, flake, skip, erro, retry ou attachment, auditoria de privacidade aceita e cleanup integral. O build canônico único Node 24 passou com 26 rotas web/quatro backoffice e log `ae46bace…`; o smoke runtime final autorizado passou root/prefetch/API/erros/live/ready/estáticos/adversarial/CSP/nonces/admin/isolamento e os boundaries guest FEAT-004, com logs `85db0dad…` e servidor redigido `4da1f9af…`. O commit funcional `79376b62bdce788c9eb7e1f1696d5acfde0cb215` gerou uma única vez a release local canônica atual: archive de 24.902.933 bytes e SHA-256 `af39e5d2…`, sidecar `0c6bade3…`, manifesto de 681.311 bytes e SHA-256 `c6514c43…`, com 2.869 folhas, 14 migrations, `BUILD_ID` exato e smoke/segurança/secret/PII/cleanup verdes em Linux x64 Node 24.18/npm 11.19. Os resultados antigos 707/707 e hashes browser/build/smoke anteriores permanecem evidência histórica pré-review; a release x64 `c115dcd726929f289777cd897cccc97d33a179ee` de 2.859 payloads também é histórica e está stale. Publicação do novo HEAD, resposta/resolução dos dois P2, novo review, promoção para ready e merge permanecem pendentes. A release atual não é ARM64 ou produção; gateway externo, checkout, fallback administrativo, papel admin, dados bancários, PEND-003/004/006 e o smoke ARM64 nativo continuam fora ou bloqueando produção.

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

Concluir os dois P2 do [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6): gates, banco, browser, build, smoke e release local canônica pós-review já estão verdes; agora faltam publicação do novo HEAD, resposta/resolução das duas threads e novo review antes de promover para ready e fazer merge. A release `c115dcd...` permanece apenas como fotografia histórica anterior ao review; a atual `79376b62...` ainda é local. PEND-003 e o smoke ARM64 nativo continuam bloqueando produção. Mudanças de sequência exigem atualização do ADR-017, da ordem especializada e da rastreabilidade.
