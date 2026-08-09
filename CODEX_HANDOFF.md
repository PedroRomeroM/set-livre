# Handoff de implementação para Codex — Set Livre Plataforma Completa

## Missão

Implementar integralmente a plataforma final Set Livre, um marketplace web de aluguel de estúdios audiovisuais, conforme este pacote documental.

A implementação deve produzir uma aplicação comercializável e operável, e não apenas telas demonstrativas. O mini fórum não faz parte deste trabalho.

## Estado do repositório recebido

- Primeiro commit local: `d755c9f chore: initialize repository architecture foundation`.
- O commit contém a inicialização do Git e o Blueprint.
- Nenhum push foi realizado no estado informado.
- A documentação de governança está preparada para um commit separado.
- Nenhum arquivo do Spenses foi alterado.

Não reescreva esse commit. Não execute `push` sem instrução humana explícita.

## Primeiras ações obrigatórias

1. Confirmar branch, status e conteúdo do commit informado.
2. Copiar este pacote para o repositório preservando caminhos e conteúdo.
3. Verificar que `docs/reference/architecture-blueprint.md` é idêntico à fonte existente.
4. Executar ou criar o validador `npm run docs:check`.
5. Criar um commit exclusivo para governança/documentação.
6. Somente depois iniciar fundação de código.

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

### Fase 0 — Governança e fundação

- documentos e ADRs;
- npm workspaces;
- aplicações pública e backoffice;
- TypeScript strict, lint, Vitest, Playwright, Knip;
- design tokens/primitives iniciais;
- Supabase local e migrations;
- CI inicial;
- headers, erros e observabilidade base.

### Fase 1 — Identidade e primeiro corte vertical

- FEAT-001 a FEAT-011;
- autenticação e perfil;
- dono/recebedor em sandbox;
- criação, revisão, mídia, publicação;
- listagem e detalhe público;
- primeiro ciclo completo de RLS, comando, read model, UI, Playwright e docs.

### Fase 2 — Calendário e preço

- FEAT-012 a FEAT-017;
- regras semanais, exceções e alocações;
- constraint de exclusão;
- calendário avançado;
- iCal;
- preço e adicionais.

### Fase 3 — Reserva e pagamento

- FEAT-018 a FEAT-026;
- cotação e retorno pós-login;
- tentativa, início no provedor e hold;
- cartão/PIX;
- webhooks e reconciliação;
- reserva, cancelamento, reembolso, split e repasse.

### Fase 4 — Operação

- FEAT-027 a FEAT-034;
- áreas de locatário e dono;
- e-mails;
- backoffice;
- financeiro/fiscal;
- operação/auditoria;
- LGPD.

### Fase 5 — Produção

- acceptance;
- build ARM64 standalone;
- systemd/Nginx/TLS;
- release por SHA e rollback;
- jobs;
- backup e restore ensaiado;
- smoke real;
- observabilidade e runbooks.

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

> Implemente a Set Livre obedecendo integralmente `AGENTS.md` e a cadeia de autoridade documental. Trabalhe na ordem de `docs/implementation-order.md`, uma fatia vertical por vez. Para cada mudança, crie registro em `docs/changes/`, implemente migrations/grants/RLS, read models, comandos server-side, UI responsiva/acessível, testes de banco e Playwright com os IDs catalogados, e atualize a documentação no mesmo commit. Não resolva decisões abertas por suposição, não implemente itens fora de escopo, não faça push sem autorização e nunca trate mock/sandbox como produção.
