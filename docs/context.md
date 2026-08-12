# Contexto técnico vivo

## Estado vivo verificado

- Projeto: Set Livre.
- Produto alvo: plataforma web completa de aluguel de estúdios audiovisuais.
- Mercado inicial: Curitiba/PR.
- Equipe informada: três desenvolvedores com disponibilidade média de duas horas produtivas por dia cada.
- Repositório remoto: `PedroRomeroM/set-livre`.
- A fundação executável e a FEAT-002 foram incorporadas a `main`; o PR #2 concluiu a primeira das 34 features.
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
- A FEAT-003 está em implementação na branch `feat/feat-003-profile-account`: completa o perfil PF/PJ, introduz `/conta` e `/conta/seguranca`, mantém CPF/CNPJ e documento adicional somente no DAL privado e projeta apenas máscaras e a preferência visual autoritativa para a interface.

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

A FEAT-003 é a fatia ativa e ainda não está concluída. O último snapshot integral publicado antes da revisão corrente passou em 563/563 unitários distribuídos por 59 arquivos, 293/293 asserts pgTAP, 91/91 execuções Playwright/axe, builds, smokes e release `f4f3b1d` com 2.809 artefatos; essa release é evidência histórica do estado anterior aos dois P2. O [PR #4](https://github.com/PedroRomeroM/set-livre/pull/4) foi marcado ready no HEAD `9531815`. A revisão Codex publicada às `03:45Z` abriu dois hardenings P2 adicionais: uma closure de logout não pode ficar pausada offline nem encerrar a sessão B a partir do scope stale de A; a projeção de preferência executada durante o login não pode sobreviver indefinidamente à resposta. As correções foram congeladas localmente no commit `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7`.

As correções estão somente no snapshot local. Nas duas superfícies de logout, a mutation chama uma closure sem `variables`, usa `networkMode: "always"` e leva `expectedScope` UUID apenas como asserção, nunca autoridade. O servidor executa `getClaims`, que pode renovar ou manter a sessão internamente, e termina a classificação antes de obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`: throw retorna `503 SERVICE_UNAVAILABLE`, `claimsResult.error` ou contexto assinado ausente retorna `401 UNAUTHENTICATED`, e somente um `userId` válido divergente retorna `409 SESSION_CHANGED`; os três ramos têm zero efeitos destrutivos explícitos de logout. O browser fecha o boundary, limpa integralmente o `QueryClient` e exige recomposição SSR. O ID 004 mantém B intacto diante de uma closure stale de A; o ID 009 limita a tentativa offline a uma request e zero envio tardio depois da reconexão. No login, `get_my_profile()` recebe `AbortSignal` e deadline server-side de um segundo; timeout/falha usa `system`, e uma resolução tardia não pode escrever cookie nem disparar `signOut`.

As rodadas focadas passaram em 37/37 no timeout da projeção, 96/96 no auditor combinado e 65/65 após o refinamento final de logout; a suíte unitária integral passou em 578/578 testes distribuídos por 60 arquivos. Reset, geração e banco passaram em 293/293 asserts pgTAP, distribuídos em 158 + 78 + 57, com head `20260811000500` e zero resíduo. Uma matriz Playwright/axe integral passou em 91/91 em 3,9 minutos, incluindo 32/32 da FEAT-003. O ID 004 passou em 3/3 projeções com `409` no logout stale, sessão e perfil de B intactos e zero `pageerror` ou erro React; o ID 009 passou em 4/4 com falha offline imediata, exatamente uma request e nenhum POST tardio após reconexão. O run terminou sem resultado inesperado, flake, skip, erro ou attachment e com zero ocorrência de sentinelas, tokens, cookies Auth ou documentos crus. Seus 62 e-mails QA únicos ficaram em 114 títulos allowlisted (`Fill` 84, `Visible` 18, `Count` 4 e `Type` 8), e banco, Mailpit, portas e processos ficaram sem resíduo. Lint, typecheck, audit com zero vulnerabilidade e Knip também passaram. Os builds Next.js 16.3 de web e backoffice passaram sem warnings, com manifests standalone, 17 arquivos obrigatórios e `BUILD_ID` local em cada app. Os smokes aprovaram live/ready/root, CSP, `no-store`, assets, nonces e probes adversariais, incluindo `/entrar` 200 no web e 404 no backoffice; lockfile/gerados ficaram inalterados, portas/processos terminaram limpos e os logs têm hashes `2e3b…4310` e `c9e5…da97`. A release local canônica do commit `e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7` foi gerada como `set-livre-e7cc8378c1c0a721f64ad3fc21dd61dca9086ef7.tar.gz`, com 24.757.341 bytes e SHA-256 `6edb2e246e0b3f46cf83f62ce8685e14b91cb31ac1437931f476fc649621273a`. Seus 2.809 artefatos são web 1.519, backoffice 1.276, migrations 12, lockfile 1 e manifesto 1; o manifesto tem 667.285 bytes e SHA-256 `733dac5409c04d8fd1c39fcd2b867d0f812a75b4792479ead416ecf9f11f0135`. Ambos os `BUILD_ID` equivalem ao commit, em Linux x64 com Node 24.18/npm 11.19. A auditoria integral de tar, staging e manifesto terminou `NO-BLOCKER`, sem segredo de runtime nem dado PII/QA e sem resíduo. Publicação/push, respostas e resolução dos dois P2, nova revisão e merge continuam pendentes. Assim, as afirmações anteriores de zero thread e somente merge pendente são históricas para o HEAD `9c23ef3`, não descrevem o estado atual. Nada da FEAT-004 deve ser antecipado; mudanças de sequência exigem atualização do ADR-017, da ordem especializada e da rastreabilidade.
