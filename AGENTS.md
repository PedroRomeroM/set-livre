# AGENTS.md — Set Livre Plataforma Completa

Este arquivo é um contrato operacional obrigatório para qualquer agente ou pessoa que implemente, revise ou altere a plataforma.

## 1. Ordem de autoridade

A precedência é:

1. `docs/reference/architecture-blueprint.md`;
2. ADRs aceitos em `docs/adr/`;
3. `docs/specification.md`;
4. documentos vivos especializados em `docs/`;
5. documentos de feature em `docs/features/`;
6. migrations, contratos e testes;
7. código.

O Blueprint define princípios e contratos arquiteturais. ADRs adaptam esses princípios ao domínio Set Livre. Uma divergência deliberada exige ADR explícito, citação da seção afetada, consequências e aprovação humana.

Não resolva contradição por suposição silenciosa. Pare a mudança, registre o conflito em `docs/open-decisions.md` e preserve o comportamento seguro existente.

## 2. Escopo obrigatório

Implemente a plataforma de aluguel de estúdios descrita neste pacote. Não implemente o mini fórum.

A baseline inclui calendário próprio avançado, reservas, pagamento, split, repasse, backoffice e infraestrutura. Itens marcados como fora de escopo não devem aparecer como tela falsa, botão desativado, schema antecipado ou dependência “para o futuro”.

## 3. Stack obrigatória

- npm; não usar pnpm, Yarn ou Bun;
- Next.js 16 App Router;
- React 19;
- TypeScript estrito;
- CSS Modules e CSS variables;
- primitives visuais próprias;
- TanStack Query para todo estado remoto interativo;
- Zod para validação de comandos e payloads externos;
- Supabase Cloud para Auth, Postgres e Storage;
- Supabase local para banco, Auth e testes destrutivos;
- cliente Supabase browser/server para sessão e leituras autorizadas;
- driver `pg` em módulos `server-only` para DAL crítico;
- PostgreSQL com migrations append-only, grants mínimos e RLS;
- Vitest;
- Playwright com axe;
- ESLint, `tsc --noEmit`, Knip e `npm audit`;
- build Next.js standalone;
- Oracle Cloud `VM.Standard.E2.1.Micro` Always Free x86_64, Ubuntu 24.04, systemd e Nginx;
- releases imutáveis por SHA com symlink atômico.

Não introduza ORM, Tailwind, shadcn/ui, CSS-in-JS, Redux, Zustand para estado remoto, Redis, fila externa, Kubernetes, Docker em produção, Caddy, GHCR, CMS ou serviço adicional sem ADR aprovado.

## 4. Fluxo obrigatório antes de codificar

1. Leia o Blueprint e os ADRs relacionados.
2. Leia `docs/specification.md` e o documento da feature.
3. Confirme dependências, estados e cenários QA.
4. Abra `docs/changes/YYYY-MM-DD-<slug>.md`.
5. Modele a fonte canônica, read models, comandos, RLS e correções.
6. Implemente uma fatia vertical completa.
7. Adicione/atualize testes unitários, SQL/RLS e Playwright.
8. Atualize toda documentação afetada no mesmo commit.
9. Execute os gates.
10. Atualize a matriz de rastreabilidade antes de declarar conclusão.

## 5. Escritas críticas

Toda escrita crítica segue:

`POST /api/commands` → origem/sessão → limite de corpo/rate limit → Zod estrito → registry modular → DAL `server-only` → função SQL privada → transação/lock → retorno autoritativo → invalidação TanStack Query.

Exceções permitidas:

- métodos do Supabase Auth;
- upload direto para URL assinada emitida pelo servidor;
- preferência visual de baixo risco, se autorizada por RLS e documentada;
- webhooks externos em endpoint próprio com assinatura e idempotência.

O navegador nunca coordena várias mutações para simular atomicidade.

## 6. Leitura

- Leituras usam read models pequenos, tipados, filtrados e paginados no servidor.
- Não usar `select('*')`.
- Não transferir tabelas inteiras para calcular disponibilidade, preço, totais ou permissões no navegador.
- Paginação de listas crescentes é keyset, com `items + nextCursor`.
- Toda query key inclui usuário/escopo, filtros e cursor.
- Mudança de filtro reseta cursor.
- Normalizers validam payloads na fronteira.

## 7. Banco e Supabase

- Migration aplicada é imutável.
- Tabelas públicas começam sem acesso.
- RLS e grants são camadas independentes e obrigatórias.
- Funções `security definer` ficam em schema não exposto, usam `search_path = ''` e objetos qualificados.
- Role DAL recebe somente `execute` nos comandos autorizados.
- Status evolutivos usam `text` com `check`, não enum PostgreSQL.
- Índices somente quando estruturais ou comprovados por `EXPLAIN (ANALYZE, BUFFERS)`.
- Valores monetários são inteiros em centavos.
- Timestamps são UTC; regras civis usam `America/Sao_Paulo`.
- Testes devem provar isolamento entre ao menos dois usuários, um dono e um admin.
- Concorrência de reserva é garantida pelo banco; o frontend não é lock.

## 8. Interface

- Server Components por padrão; Client Components nas bordas interativas.
- Nenhum sistema visual paralelo.
- Mobile é composição própria, não desktop comprimido.
- Suporte mínimo: 320 px, touch target de 44 px, safe areas e zoom de 200%.
- WCAG 2.2 AA.
- Toda tela implementa loading, vazio, erro, conflito, sucesso e recuperação.
- Modais, drawers, date pickers e filtros usam primitives documentadas.
- Não usar hover como único acesso à informação.
- Não criar card com ações internas conflitantes com clique do card.

## 9. Segurança

- Nenhum segredo em variável pública, bundle, log, trace ou screenshot.
- Nunca armazenar PAN ou CVV.
- IDs do cliente nunca provam ownership.
- Webhooks validam assinatura, timestamp, unicidade e replay.
- Toda ação administrativa é verificada server-side e auditada.
- Backoffice é aplicação separada em `apps/backoffice`.
- Erros públicos não expõem SQL, stack, provider payload ou PII.
- Logs usam `requestId` e redaction.
- Dependência nova exige justificativa e avaliação de supply chain.

## 10. Playwright por feature

Cada `FEAT-xxx` possui:

- spec obrigatório;
- cenários com ID estável;
- prioridade P0/P1/P2;
- viewport desktop e mobile quando relevante;
- teste axe nos fluxos centrais;
- evidência de caminho feliz e pelo menos um cenário negativo.

Proibido:

- `waitForTimeout`;
- seletor CSS frágil quando semântica resolve;
- `.only` ou `.skip`;
- retry permanente para mascarar flakiness;
- dados sem namespace de QA;
- teste destrutivo fora do ambiente local.

## 11. Documentação viva

Toda mudança em código, infraestrutura, migrations, CI ou configuração deve alterar ao menos um `.md`.

Além disso:

- mudança de comportamento atualiza a feature e o QA;
- mudança de schema atualiza `database.md`, tipos, guardrails e contexto;
- mudança estrutural cria ou altera ADR;
- mudança visual altera `design-system.md`;
- mudança operacional altera `infrastructure.md`/runbook;
- nova dívida atualiza `technical-debt.md`;
- toda mudança técnica atualiza `contexto-projeto-set-livre.html` como resumo executivo direto do estado implementado, sem antecipar feature ou integração;
- todo PR cria um registro em `docs/changes/`.

## 12. Proibições

Não usar:

- `any`, `@ts-ignore` ou cast para esconder contrato;
- `console.log`;
- `TODO`/`FIXME` sem registro formal de dívida;
- mock em produção;
- tela, métrica, botão ou integração falsa;
- status aceito diretamente do cliente;
- service role no browser;
- edição manual de banco como fluxo normal;
- offset pagination em listas crescentes;
- exclusão física de histórico financeiro;
- Google Calendar na baseline;
- feature fora de escopo “preparada” no schema.

Correções devem ser canônicas. É proibido aceitar como solução final qualquer gambiarra,
workaround, bypass de segurança, supressão de erro, downgrade oportunista, edição manual de
artefato gerado ou enfraquecimento de teste para acomodar comportamento incorreto. Quando uma
versão, ferramenta ou abordagem for incompatível, remova-a por completo da fronteira afetada e
implemente a alternativa suportada na fonte, com testes, documentação e rollback. Se a correção
correta não puder ser comprovada, mantenha o fluxo fail-closed e registre o bloqueio; não declare a
etapa concluída. Compatibilidade deliberada só existe quando for requisito real do produto ou de
migração, estiver definida em ADR e preservar integralmente segurança e invariantes.

## 13. Gates mínimos

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run supabase:reset
npm run test:db
npm run docs:check
npm run test:e2e:affected
npm run build
npm run audit
npm run knip
```

`main` e release exigem suíte Playwright completa, build das duas aplicações e smoke do artefato standalone Linux x86_64 na VM Oracle E2 Micro.

## 14. Ciclo completo obrigatório de review e deploy

Toda mudança destinada a `main` segue integralmente
[`docs/review-deploy-cycle.md`](docs/review-deploy-cycle.md): branch criada de `main` atualizada,
gates relevantes antes de cada commit candidato, PR não draft, comentário `@codex review`, espera
real mínima de 60 minutos e inspeção de reviews, comentários de topo, comentários inline, threads e
checks. Finding aplicável é corrigido na causa, procurado nas superfícies equivalentes e coberto por
teste; finding rejeitado exige justificativa técnica no PR. Depois de qualquer push, um novo review e
uma nova espera integral são obrigatórios.

Merge só ocorre quando o Codex declarar explicitamente não ter encontrado problema relevante no SHA
atual, todos os checks estiverem verdes e todas as conversas estiverem resolvidas. Depois do merge, o
agente acompanha Supabase, Oracle e health público até estado terminal. Falha pós-merge é corrigida em
nova branch e novo PR, repetindo todo o ciclo. Timeout, ausência de resposta, interrupção ou serviço
externo indisponível são inconclusivos e nunca contam como aprovação, gate verde ou deploy concluído.
Push direto, merge administrativo, autoaprovação ou bypass desse contrato são proibidos.

## 15. Definition of Done

Uma feature somente é concluída quando:

- produto e copy atendem à intenção;
- fonte canônica e regras de correção estão claras;
- migration, constraints, grants e RLS estão verdes;
- comando é atômico e idempotente quando aplicável;
- read models e invalidações são corretos;
- desktop/mobile/acessibilidade estão comprovados;
- Playwright da feature está verde;
- documentação viva está coerente;
- logs, métricas, suporte e rollback estão definidos.
