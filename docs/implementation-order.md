# Ordem de implementação

## Autoridade e princípio

Esta ordem aplica o Blueprint por meio do ADR-017. O Blueprint continua sendo a referência arquitetural superior; o ADR-017 resolve somente a ambiguidade documental entre pré-requisitos, integrações posteriores e bloqueios de produção.

A implementação avança por fatias verticais completas. Não construir todas as tabelas, depois todas as APIs e só então a UI. Cada branch e PR implementa exatamente uma feature de produto, com documentação, banco, contratos, UI e testes proporcionais ao seu escopo.

## Contrato de dependências

- **`dependency-to-start`:** aresta forte. A capacidade ou feature precisa estar mergeada, testada e disponível antes da abertura da branch consumidora. Essas arestas formam um grafo acíclico.
- **`dependency-to-complete`:** integração posterior com proprietário e cenário QA definidos. Não autoriza feature parcial, teste pulado, botão desabilitado, tela falsa ou mock de produção. O gate da jornada permanece aberto até a integração ficar verde.
- **`dependency-to-release`:** provider, conteúdo jurídico, CI/CD, cloud ou infraestrutura externa que não bloqueia a implementação local, mas impede go-live. Toda ocorrência fica registrada em `pendencias.md` e, quando aplicável, em `docs/open-decisions.md`.

Quando um documento de feature ainda usar a seção genérica “Dependências”, o ADR-017 e esta ordem determinam a classificação operacional. A classificação deve ser explicitada no registro de mudança antes de codificar a feature, sem alterar silenciosamente seu escopo.

`docs/feature-sequence.json` é a representação legível por máquina desta decisão. `docs:check` prova unicidade, cobertura, precedência, ausência de ciclos, propriedade das integrações posteriores e vínculo das dependências de release com `pendencias.md`.

## Capacidades bootstrap

Uma capacidade bootstrap é o menor contrato interno necessário ao primeiro consumidor real. Ela entra na fundação ou no PR da primeira feature que possui legitimamente sua fonte canônica. Não pode antecipar rota, tela, permissão, comando ou schema sem uso no mesmo PR.

| Capacidade                           | Primeiro proprietário/consumidor | Limite inicial                                                                                                                   |
| ------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| fundação local                       | Fase 0                           | workspaces, apps, qualidade, Supabase local, primitives, erros, observabilidade e contratos transversais sem entidade de negócio |
| `legal-core`                         | FEAT-002                         | versões vigentes, leitura e aceite; direitos LGPD completos pertencem à FEAT-034                                                 |
| recorte de recebedor do provider     | FEAT-004                         | interface server-only e adapter local determinístico; não antecipa cartão, PIX, refund ou payout                                 |
| `taxonomy-core` e revisão versionada | FEAT-006                         | taxonomias estruturais consumidas pelo editor e estados editoriais necessários ao rascunho                                       |
| RBAC e auditoria administrativos     | FEAT-031                         | papéis, salvaguardas e eventos necessários às ações reais do backoffice                                                          |
| outbox transacional mínima           | FEAT-009                         | enqueue atômico dos eventos editoriais; envio e operação pertencem à FEAT-029                                                    |
| disponibilidade e alocações          | FEAT-012/FEAT-013                | regras semanais, exceções, bloqueios e invariantes de ocupação                                                                   |
| dinheiro e precificação              | FEAT-016                         | cálculo determinístico em centavos; snapshots são materializados pelos consumidores                                              |
| adicionais                           | FEAT-017                         | CRUD, arquivamento e leitura; seleção e cotação pertencem à FEAT-018                                                             |
| cotação                              | FEAT-018                         | disponibilidade, itens e snapshot autoritativo sem garantir vaga                                                                 |
| tentativa e hold                     | FEAT-020                         | aquisição concorrente e expiração, sem confirmação antecipada de reserva                                                         |
| eventos de pagamento                 | FEAT-023                         | assinatura, idempotência, precedência e reconciliação                                                                            |
| reserva e intenção de repasse        | FEAT-024                         | confirmação, snapshots, continuidade da alocação, outbox e obrigação financeira; processamento pertence às FEAT-026/029          |

Contratos externos crescem apenas com consumidores reais. O adapter local nunca representa prontidão de produção.

## Fase 0 — Governança e fundação local

1. aplicar `AGENTS.md`, ADR-017 e ADR-018;
2. configurar npm workspaces e um único lockfile;
3. criar a aplicação pública e o backoffice separado;
4. configurar TypeScript strict, lint, format, Vitest, Playwright, axe e Knip;
5. configurar Supabase local para Auth, banco, Storage e testes destrutivos;
6. configurar `docs:check`, inclusive validação da sequência e unicidade das 34 features;
7. criar primitives/tokens, contratos de erro, requestId e observabilidade mínima;
8. registrar a mudança e as pendências externas.

CI/CD, Supabase Cloud, Oracle, DNS e TLS são `dependency-to-release` durante a vigência do ADR-018 e não fazem parte desta fundação local.

Gate: `npm ci`, format, lint, typecheck, unitários, `docs:check`, builds das duas aplicações e smoke local.

## Fase 1 — Identidade, oferta e publicação

1. **FEAT-002** — autenticação e `legal-core`;
2. **FEAT-003** — perfil;
3. **FEAT-004** — dono, recebedor e primeiro recorte do provider;
4. **FEAT-006** — estúdio, revisão e `taxonomy-core`;
5. **FEAT-007** — conteúdo e taxonomias do estúdio;
6. **FEAT-031** — usuários, papéis e taxonomias administrativas;
7. **FEAT-008** — mídia;
8. **FEAT-009** — submissão editorial e outbox mínima;
9. **FEAT-030** — revisão e publicação pelo backoffice.

Gate: um usuário completa identidade, torna-se dono, cria uma revisão com conteúdo e mídia, envia para análise e um papel autorizado publica atomicamente, com RLS, auditoria e isolamento comprovados.

## Fase 2 — Disponibilidade, preço e descoberta pública

10. **FEAT-012** — disponibilidade semanal;
11. **FEAT-013** — exceções, bloqueios e alocações;
12. **FEAT-016** — precificação;
13. **FEAT-017** — adicionais;
14. **FEAT-010** — listagem pública;
15. **FEAT-011** — detalhe público e SEO;
16. **FEAT-001** — shell e home com destinos reais.

Gate: disponibilidade e preço são reproduzíveis no banco, os estúdios publicados aparecem em listagem/detalhe e todos os links e filtros da home possuem destinos funcionais.

## Fase 3 — Cotação, pagamento e reserva

17. **FEAT-018** — configurador e cotação;
18. **FEAT-019** — retorno pós-login;
19. **FEAT-020** — início de pagamento e hold;
20. **FEAT-021** — cartão;
21. **FEAT-022** — PIX;
22. **FEAT-023** — webhooks e reconciliação;
23. **FEAT-024** — confirmação e ciclo da reserva.

Gate: duas tentativas concorrentes produzem no máximo um hold/reserva, eventos duplicados são idempotentes e uma reserva somente nasce de pagamento autoritativo com snapshot e alocação contínuos.

## Fase 4 — Calendário integrado e operação completa

24. **FEAT-014** — calendário avançado com reservas reais;
25. **FEAT-015** — iCal;
26. **FEAT-025** — cancelamento e reembolso;
27. **FEAT-026** — split e repasse;
28. **FEAT-029** — e-mail e worker da outbox;
29. **FEAT-005** — dashboard completo do dono;
30. **FEAT-027** — área do locatário;
31. **FEAT-028** — reservas e financeiro do dono;
32. **FEAT-032** — backoffice financeiro e fiscal;
33. **FEAT-033** — operações, jobs e auditoria;
34. **FEAT-034** — LGPD e direitos de dados completos.

Gate: calendário, cancelamento, refund, payout, comunicações, áreas privadas, backoffice e direitos de dados operam sobre os mesmos fatos canônicos e estão cobertos por Playwright, mobile e axe.

## Integrações `dependency-to-complete`

| Provedor inicial                     | Proprietário da integração posterior | Evidência exigida                                                  |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------ |
| FEAT-002 `legal-core`                | FEAT-034                             | exportação, exclusão, anonimização e retenção sobre histórico real |
| FEAT-004 dono/recebedor              | FEAT-034                             | direitos LGPD sobre os novos fatos e referências privadas          |
| FEAT-004 elegibilidade conservadora  | FEAT-032                             | fallback financeiro liberado por admin e auditado                  |
| FEAT-006/FEAT-007 taxonomias         | FEAT-031                             | administração, arquivamento e preservação histórica                |
| FEAT-008/FEAT-009 workflow editorial | FEAT-030                             | aprovação/rejeição, troca atômica da revisão publicada e auditoria |
| FEAT-016 cálculo de preço            | FEAT-018 e FEAT-024                  | snapshot imutável da cotação e da reserva                          |
| FEAT-017 adicionais                  | FEAT-018 e FEAT-024                  | seleção/quantidade na cotação e snapshot histórico na reserva      |
| FEAT-024 outbox/intenção financeira  | FEAT-025, FEAT-026 e FEAT-029        | bloqueio por refund, processamento de payout e entrega de e-mail   |

O cenário cruzado pertence ao PR da feature consumidora. A feature provedora não exibe antecipadamente a ação dependente.

## Fase 5 — Dependências de release

Após a implementação local e a resolução das entradas de `pendencias.md`:

1. configurar CI e política de branches;
2. configurar Supabase Cloud;
3. validar providers externos e conteúdo jurídico final;
4. provisionar Oracle ARM64, Nginx e TLS;
5. configurar systemd e release imutável por SHA;
6. automatizar migrations e jobs;
7. ensaiar backup, restore e rollback;
8. executar carga, smoke HTTPS e acceptance em ambiente real;
9. validar logs, métricas, alertas e secrets;
10. comprovar todos os P0 e o artefato standalone ARM64.

## Regra de execução

- Uma única feature de produto por branch e PR.
- A próxima feature começa somente após merge da anterior e atualização local de `main`.
- Todos os gates e a suíte Playwright completa são executados antes do PR e após cada correção de review.
- Depois de solicitar `@codex review`, aguardar 60 minutos completos antes de consultar o resultado. Cada correção pertinente exige novamente gates completos, suíte Playwright completa, commit e push; toda thread efetivamente atendida deve ser resolvida no PR, enquanto comentário não atendido ou rejeitado permanece aberto com justificativa. Em seguida, solicitar novo `@codex review` e cumprir nova espera integral de 60 minutos. O ciclo termina somente com review sem problema corrigível; então o PR pode ser mergeado.
- Uma mudança de ordem exige atualização do ADR-017, deste documento e da rastreabilidade.
- Calendário, hold, pagamento e reserva mantêm um responsável técnico integrador, mesmo com execução serial.
