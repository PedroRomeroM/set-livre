# Contexto técnico vivo

## Estado atual recebido

- Projeto: Set Livre.
- Produto alvo: plataforma web completa de aluguel de estúdios audiovisuais.
- Mercado inicial: Curitiba/PR.
- Equipe informada: três desenvolvedores com disponibilidade média de duas horas produtivas por dia cada.
- Commit local inicial informado: `d755c9f chore: initialize repository architecture foundation`.
- Esse commit contém a inicialização do Git e o Blueprint.
- Nenhum push foi realizado até o estado informado.
- A documentação de governança está prevista para commit separado.
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

## Próxima ação recomendada

O próximo commit deve conter somente a governança e a estrutura documental, sem código de feature. Depois:

1. fundação do monorepo/workspaces;
2. Supabase local e primeira migration;
3. autenticação;
4. primeiro corte vertical: estúdio rascunho → revisão → leitura pública;
5. calendário e disponibilidade;
6. reserva/pagamento;
7. backoffice e operação.
