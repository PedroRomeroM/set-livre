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
- A FEAT-004 está em implementação na branch própria, com o [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6). As correções dos dois P2 do primeiro review separam ativação completa (21 colunas com documento) de recebimentos compactos (16 sem título, versão textual, hash ou corpo) e exigem GET autoritativo sem replay para conflito/validação sem campo; ambas as threads receberam resposta e foram resolvidas. A branch foi publicada até `3e3f866c42302df9b0499e9af75575c7c092f3f0`. O segundo review `PRR_kwDOTyzZrs8AAAABJV08Cw`, submetido em `2026-08-12T22:59:35Z` sobre esse commit, abriu a thread atual `PRRT_kwDOTyzZrs6YwM7k`: `owner_contract_not_current` era agrupado com outros `42501` e retornava `403`. O patch local traduz somente `42501 + owner_contract_not_current` para `409 CONFLICT`, preserva bloqueios e demais `42501` como `403 FORBIDDEN` e reutiliza o boundary verification-first já existente. A evidência atual está integralmente verde: Node 24 em 718/718 unitários de 74 arquivos e todos os gates estáticos; reset/banco em 355/355; Playwright focado único 23/23 e integral único 114/114, com privacidade/cleanup verdes; build único sem warnings; e smoke real padrão mais FEAT-004 com 14/11 nonces, três boundaries, dois redirects, banco `0 → 0` e cleanup zero. A release `79376b62...` permanece histórica e não contém o patch. Nova release canônica, publicação, resposta/resolução da nova thread, novo review, promoção e merge ainda faltam. A prova x64 também não é ARM64 ou produção; gateway externo, checkout, fallback administrativo, papel admin, dados bancários, PEND-003/004/006 e o smoke ARM64 nativo continuam fora ou bloqueando produção.

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

Concluir o novo P2 do [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6): os gates integrais, banco, browser, build e smoke atuais já estão verdes; agora é preciso gerar a nova release canônica, publicar o novo HEAD, responder e resolver `PRRT_kwDOTyzZrs6YwM7k`, solicitar novo review e somente então promover para ready e fazer merge. As duas threads anteriores já estão respondidas e resolvidas. A release `79376b62...` é fotografia histórica anterior ao delta. PEND-003 e o smoke ARM64 nativo continuam bloqueando produção. Mudanças de sequência exigem atualização do ADR-017, da ordem especializada e da rastreabilidade.
