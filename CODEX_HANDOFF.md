# Handoff de implementação para Codex — Set Livre Plataforma Completa

## Missão

Implementar integralmente a plataforma final Set Livre, um marketplace web de aluguel de estúdios audiovisuais, conforme este pacote documental.

A implementação deve produzir uma aplicação comercializável e operável, e não apenas telas demonstrativas. O mini fórum não faz parte deste trabalho.

## Estado vivo do repositório

- Remoto autorizado: `PedroRomeroM/set-livre`.
- `main` contém a baseline documental no commit `e0cca5a`.
- A fundação local está isolada em `agent/foundation-local-platform`.
- O identificador `d755c9f` veio do pacote, mas não existe no histórico verificado deste repositório.
- Cada feature posterior deve usar branch e PR próprios, sem implementação paralela de outra feature.
- Nenhum arquivo do Spenses foi alterado.

Não reescreva a baseline. Push, PR e merge seguem a autorização operacional do usuário: execute os gates completos, publique o PR, solicite `@codex review` e aguarde 60 minutos completos antes de consultar o resultado. Se houver correção pertinente, implemente-a, rode novamente todos os gates e a suíte Playwright completa, faça commit e push, solicite um novo `@codex review` e aguarde outros 60 minutos completos. Repita esse ciclo até o review não apontar problema corrigível; somente então faça o merge.

## Ações de fundação

1. Preservar o Blueprint e sua precedência.
2. Validar a fundação executável com todos os gates locais.
3. Publicar o PR técnico e concluir o ciclo de revisão.
4. Somente após o merge iniciar a FEAT-002, na ordem canônica.

## Ordem de leitura obrigatória

1. `AGENTS.md`;
2. `docs/00-source-of-truth.md`;
3. `docs/reference/architecture-blueprint.md`;
4. todos os ADRs aceitos em `docs/adr/`;
5. `docs/specification.md`;
6. `docs/architecture.md`;
7. `docs/domain-model.md`;
8. `docs/database.md`;
9. `docs/api-contracts.md`;
10. `docs/calendar-reservations.md`;
11. `docs/payments.md`;
12. `docs/ux-blueprint.md` e `docs/design-system.md`;
13. `docs/security-privacy.md` e `docs/infrastructure.md`;
14. `docs/qa-test-plan.md` e `docs/qa-traceability.md`;
15. `docs/implementation-order.md`;
16. documento da feature a ser implementada.

## Contratos inegociáveis

- npm e um único `package-lock.json`;
- Next.js App Router, React e TypeScript `strict`;
- CSS Modules, CSS variables e primitives próprias;
- TanStack Query para estado remoto interativo;
- Supabase Auth/Postgres/Storage;
- migrations append-only;
- grants mínimos e RLS testados entre usuários;
- leituras por read models pequenos, tipados, filtrados e paginados;
- keyset cursor com `items + nextCursor`;
- escritas críticas por `POST /api/commands` → sessão → limites → Zod → registry → DAL `server-only` → comando SQL privado;
- atomicidade e concorrência garantidas no banco;
- backoffice em `apps/backoffice`;
- build standalone, systemd, Nginx e releases imutáveis por SHA;
- suporte a 320 px, safe areas, alvo de toque de 44 px e zoom de 200%;
- WCAG 2.2 AA e axe;
- Playwright para toda feature;
- documentação viva atualizada no mesmo PR.

## Estratégia de execução

Implemente por fatia vertical, nunca por camadas horizontais incompletas. Para cada feature:

1. abrir `docs/changes/YYYY-MM-DD-<slug>.md`;
2. confirmar requisitos, comandos, read models, tabelas e cenários;
3. criar migration e guardrails quando aplicável;
4. implementar contrato server-side e autorização;
5. implementar UI desktop e composição mobile;
6. implementar correção, erro, vazio, loading, conflito e recuperação;
7. adicionar unitários, banco/RLS, integração e Playwright;
8. atualizar docs e rastreabilidade;
9. executar gates;
10. fazer commit pequeno, coerente e reversível.

Não declare uma feature pronta com mocks visuais, dados fixos, botão sem ação real ou integração falsa.

## Fases obrigatórias

### Fase 0 — Governança e fundação local

- documentos e ADRs;
- npm workspaces;
- aplicações pública e backoffice;
- TypeScript strict, lint, Vitest, Playwright, Knip;
- design tokens/primitives iniciais;
- Supabase local e migrations;
- gates locais reproduzíveis;
- headers, erros e observabilidade base.

Durante a vigência do ADR-018, CI/CD, Supabase Cloud, Oracle, DNS e TLS são dependências de release registradas em `pendencias.md`, não tarefas da fundação local.

### Fases 1 a 4 — Features em sequência executável

A única ordem operacional das 34 features é `docs/implementation-order.md`, derivada do ADR-017. Não inferir ordem por número, faixa ou domínio.

Antes de abrir a branch de uma feature:

1. confirmar suas `dependency-to-start` já mergeadas;
2. identificar integrações `dependency-to-complete` e o cenário/proprietário posterior;
3. registrar como `dependency-to-release` qualquer bloqueio externo;
4. introduzir capacidade bootstrap somente se houver uso real no mesmo PR;
5. confirmar que nenhuma outra feature de produto será implementada na branch.

Os gates de jornada são:

- identidade, oferta e publicação atômica;
- disponibilidade, preço e descoberta pública;
- cotação, pagamento autoritativo e reserva concorrente;
- calendário integrado, operação, financeiro, comunicação e direitos de dados.

### Fase 5 — Dependências de release

Executar somente após a liberação das pendências externas e conforme ADR-014, ADR-018 e a Fase 5 de `docs/implementation-order.md`:

- CI e política de branches;
- Supabase Cloud e providers reais;
- conteúdo jurídico final;
- build ARM64 standalone;
- systemd/Nginx/TLS;
- release por SHA e rollback;
- jobs, backup e restore ensaiado;
- smoke real, observabilidade e runbooks.

## Stop conditions

Não invente nem escolha silenciosamente:

- gateway de produção/contrato comercial;
- conteúdo jurídico final;
- identidade visual final;
- dados reais de SMTP, DNS, domínio, Supabase e Oracle;
- política diferente de repasse/cancelamento;
- qualquer feature fora de escopo.

Quando uma decisão bloquear produção, use adapter/fake apenas em ambiente local ou sandbox, marque o bloqueio em `docs/open-decisions.md` e preserve o domínio independente do fornecedor.

## Gates obrigatórios

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

Antes de release:

- suíte Playwright completa;
- build das duas aplicações;
- smoke do artefato standalone ARM64;
- migrations em banco vazio;
- rollback ensaiado;
- restore ensaiado;
- validação de secrets e logs;
- todos os P0 verdes.

## Evidência esperada ao final de cada etapa

- commits e diff explicáveis;
- lista de migrations;
- comandos/read models implementados;
- cenários QA automatizados com IDs;
- saída dos gates;
- riscos/dívidas remanescentes;
- docs alteradas;
- instrução de rollback;
- nenhuma alteração fora do escopo.

## Prompt operacional resumido

> Implemente a Set Livre obedecendo integralmente `AGENTS.md` e a cadeia de autoridade documental. Trabalhe na ordem de `docs/implementation-order.md`, uma fatia vertical por vez. Para cada mudança, crie registro em `docs/changes/`, implemente migrations/grants/RLS, read models, comandos server-side, UI responsiva/acessível, testes de banco e Playwright com os IDs catalogados, e atualize a documentação no mesmo commit. Não resolva decisões abertas por suposição, não implemente itens fora de escopo e nunca trate mock/sandbox como produção. Publique somente pela branch/PR autorizada e conclua o ciclo de revisão antes do merge.
