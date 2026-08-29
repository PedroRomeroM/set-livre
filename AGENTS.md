# AGENTS.md — Set Livre Plataforma Completa

Este arquivo é um contrato operacional obrigatório para qualquer agente ou pessoa que implemente, revise ou altere a plataforma.

## 1. Ordem de autoridade

A precedência é:

1. `docs/reference/architecture-blueprint.md`;
2. ADRs aceitos em `docs/adr/`;
3. `docs/specification.md`;
4. documentos vivos especializados em `docs/`;
5. planos transitórios de features ainda não concluídas em `docs/features/`;
6. migrations, contratos e testes;
7. código.

O Blueprint define princípios e contratos arquiteturais. ADRs adaptam esses princípios ao domínio Set
Livre. Eles são aplicados ao risco e à capacidade atualmente em implementação; não autorizam preparar
infraestrutura, abstração ou schema para uma necessidade futura. Uma divergência deliberada exige ADR
explícito, citação da seção afetada, consequências e aprovação humana.

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
- Oracle Cloud `VM.Standard.E2.1.Micro` Always Free-eligible x86_64, Ubuntu 24.04, systemd e Nginx;
- releases imutáveis por SHA com symlink atômico.

Não introduza ORM, Tailwind, shadcn/ui, CSS-in-JS, Redux, Zustand para estado remoto, Redis, fila externa, Kubernetes, Docker em produção, Caddy, GHCR, CMS ou serviço adicional sem ADR aprovado.

## 4. Fluxo obrigatório antes de codificar

1. Leia o Blueprint e os ADRs relacionados.
2. Leia `docs/specification.md` e, quando existir, o plano transitório da feature.
3. Confirme dependências, estados e cenários QA.
4. Modele a fonte canônica, read models, comandos, RLS e correções.
5. Implemente uma fatia vertical completa.
6. Adicione ou atualize testes no menor nível que prove cada risco relevante.
7. Atualize somente a documentação canônica cujo fato durável mudou.
8. Execute os gates.
9. Ao concluir a feature, atualize `docs/roadmap.md`, consolide contratos permanentes e remova seu
   plano em `docs/features/`.

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
- Features de autorização devem provar isolamento entre ao menos dois usuários e as personas
  privilegiadas aplicáveis.
- Concorrência de reserva é garantida pelo banco; o frontend não é lock.

## 8. Interface

- Server Components por padrão; Client Components nas bordas interativas.
- Nenhum sistema visual paralelo.
- Mobile é composição própria, não desktop comprimido.
- Suporte mínimo: 320 px, touch target de 44 px, safe areas e zoom de 200%.
- WCAG 2.2 AA.
- Toda tela implementa os estados que realmente podem ocorrer: loading, vazio, erro, conflito, sucesso
  e recuperação quando aplicáveis. Não fabrique estado ou transição apenas para preencher checklist.
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

## 10. Testes por feature

Cada `FEAT-xxx` implementada possui:

- spec obrigatório;
- cenários com ID estável;
- prioridade P0/P1/P2;
- viewport desktop e mobile quando relevante;
- teste axe nos fluxos centrais;
- evidência de caminho feliz e pelo menos um cenário negativo.

Playwright é a prova principal do comportamento visível. Unitários cobrem regras puras, normalização,
transições difíceis e erros sem navegador. pgTAP cobre RLS, grants, constraints, transações e
concorrência. Não duplique o mesmo cenário em várias camadas nem teste detalhes internos sem risco
demonstrado.

Proibido:

- `waitForTimeout`;
- seletor CSS frágil quando semântica resolve;
- `.only` ou `.skip`;
- retry permanente para mascarar flakiness;
- dados sem namespace de QA;
- teste destrutivo fora do ambiente local.

## 11. Documentação viva

Documentação segue o princípio **um fato, uma fonte canônica**. Mudança de comportamento, arquitetura
ou operação atualiza a fonte afetada; documentos relacionados apontam para ela em vez de copiar o
mesmo conteúdo. Evidência transitória, diff, rationale da entrega e histórico ficam no PR, nos checks e
no Git — não em um novo arquivo obrigatório no repositório.

Além disso:

- mudança de comportamento atualiza o documento permanente do domínio e os testes afetados;
- mudança de schema atualiza `database.md`, tipos e guardrails;
- decisão arquitetural durável cria ou altera ADR; detalhe de implementação não gera ADR artificial;
- mudança visual altera `design-system.md`;
- mudança operacional altera `infrastructure.md`/runbook;
- nova dívida atualiza `technical-debt.md`;
- `contexto-projeto-set-livre.html` é atualizado em marcos que alteram o estado executivo do projeto,
  sem logs de execução ou repetição dos documentos técnicos;
- correção interna sem mudança de contrato não exige alteração documental artificial.

Planos em `docs/features/` existem somente para trabalho planejado ou em andamento. Depois de merge e
deploy verdes, o comportamento durável é consolidado, o roadmap é atualizado e o plano é apagado.
Histórico detalhado permanece no Git e no PR.

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

### Técnicas temporárias e produção

O ADR-022 distingue experimento local, candidato a merge e produção. Uma técnica temporária é
permitida para diagnóstico ou desenvolvimento quando explícita, isolada, reversível, sem dados ou
segredos reais e com critério de saída. Ela não pode mascarar testes, fabricar evidência nem chegar ao
artifact de produção. `main` e produção aceitam somente a solução suportada e comprovada.

Antes de escrever framework próprio, prove por requisito, ameaça ou métrica por que uma ferramenta
existente ou uma solução menor não atende. Complexidade sem justificativa verificável deve ser
removida. Dependência nova exige avaliação proporcional, mas não se deve reconstruir uma ferramenta
madura apenas para evitar uma dependência de desenvolvimento ou operação.

## 13. Gates mínimos

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run migrations:check
npm run supabase:reset
npm run supabase:lint
npm run test:db
npm run docs:check
npm run test:e2e:affected
npm run build
npm run audit
npm run knip
```

`main` e release exigem suíte Playwright completa, build das duas aplicações e smoke do artefato
standalone Linux x86_64.

Mudança operacional executa também `actionlint`, `bash -n`, ShellCheck e, quando afetado, `nginx -t`.

## 14. Ciclo obrigatório de review e deploy

Toda mudança destinada a `main` segue `docs/review-deploy-cycle.md`. Branch protection e checks
nativos são guardrails; não substituem o pedido `@codex review`, o polling a cada 10 minutos até o
status terminal `Completed` no SHA exato, a correção dos findings e a resposta explicitamente limpa
no SHA final. Sessenta minutos sem conclusão é alerta operacional, nunca aprovação. Novo push
reinicia o ciclo. Antes do merge, o mesmo SHA recebe ainda a revisão geral holística obrigatória de
todo o diff contra `main`; finding nessa etapa reinicia também o ciclo integral.
Somente depois dessa evidência, uma credencial confiável do mantenedor publica o status
`Codex review contract` no SHA atual com link para o review limpo; workflows não publicam esse status.
A branch protection o exige, portanto qualquer push volta a bloquear o merge. Falha pós-merge é
corrigida em nova branch e novo PR.

## 15. Definition of Done

Uma feature somente é concluída quando:

- produto e copy atendem à intenção;
- fonte canônica e regras de correção estão claras;
- migration, constraints, grants e RLS estão verdes;
- comando é atômico e idempotente quando aplicável;
- read models e invalidações são corretos;
- desktop/mobile/acessibilidade estão comprovados;
- Playwright da feature está verde;
- plano transitório removido e roadmap atualizado;
- documentação viva está coerente;
- logs, métricas, suporte e rollback estão definidos.
