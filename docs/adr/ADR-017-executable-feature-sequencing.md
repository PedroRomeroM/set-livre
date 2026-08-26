# ADR-017 — Dependências e sequência executável das features

## Status

Aceito em 2026-08-09, com aprovação humana expressa para decidir pendências técnicas com autonomia.

## Contexto

Os documentos de feature usavam “dependência” tanto para pré-requisitos de início quanto para
capacidades necessárias à experiência final. Isso formava ciclos como FEAT-002/FEAT-034,
FEAT-007/FEAT-031, FEAT-008/FEAT-009/FEAT-030, FEAT-017/FEAT-018 e
FEAT-024/FEAT-026/FEAT-029. Fontes antigas também agrupavam parte das features de formas diferentes.

Uma leitura estritamente topológica impediria o início da implementação. Resolver o conflito silenciosamente violaria o Blueprint, seção 2, e a cadeia de autoridade do ADR-001.

## Decisão

Cada dependência passa a ser declarada em uma destas categorias:

1. **dependency-to-start:** aresta forte; a fonte canônica ou jornada indicada precisa estar mergeada antes da branch consumidora e o conjunto deve formar um DAG;
2. **dependency-to-complete:** integração posterior com proprietário e cenário definidos; não autoriza feature parcial, botão desabilitado ou mock visual;
3. **dependency-to-release:** implementação local é permitida, mas o go-live fica bloqueado por provider, conteúdo jurídico ou infraestrutura externa;
4. **contrato bootstrap:** menor infraestrutura interna necessária ao primeiro consumidor real, sem rota, tela, permissão ou schema antecipado sem uso no mesmo PR.

Uma branch implementa somente uma feature de produto. Contratos bootstrap compartilhados entram na fundação ou na primeira feature que possui legitimamente a fonte canônica. A branch não antecipa UI, permissões ou comportamento público de outra feature.

O estado e a ordem executável vigentes ficam exclusivamente em [`docs/roadmap.md`](../roadmap.md). A
ordem aprovada por este ADR é:

1. FEAT-002 — autenticação e `legal-core`;
2. FEAT-003 — perfil;
3. FEAT-004 — dono, recebedor e primeiro recorte do provider;
4. FEAT-006 — estúdio, revisão e `taxonomy-core`;
5. FEAT-007 — conteúdo e taxonomias do estúdio;
6. FEAT-031 — usuários, papéis e taxonomias administrativas;
7. FEAT-008 — mídia;
8. FEAT-009 — submissão editorial e outbox mínima;
9. FEAT-030 — revisão e publicação pelo backoffice;
10. FEAT-012 — disponibilidade semanal;
11. FEAT-013 — exceções, bloqueios e alocações;
12. FEAT-016 — precificação;
13. FEAT-017 — adicionais;
14. FEAT-010 — listagem pública;
15. FEAT-011 — detalhe público e SEO;
16. FEAT-001 — shell/home com destinos reais;
17. FEAT-018 — configurador e cotação;
18. FEAT-019 — retorno pós-login;
19. FEAT-020 — início de pagamento e hold;
20. FEAT-021 — cartão;
21. FEAT-022 — PIX;
22. FEAT-023 — webhooks e reconciliação;
23. FEAT-024 — confirmação e ciclo da reserva;
24. FEAT-014 — calendário avançado com reservas reais;
25. FEAT-015 — iCal;
26. FEAT-025 — cancelamento e reembolso;
27. FEAT-026 — split e repasse;
28. FEAT-029 — e-mail e worker da outbox;
29. FEAT-005 — dashboard completo do dono;
30. FEAT-027 — área do locatário;
31. FEAT-028 — reservas e financeiro do dono;
32. FEAT-032 — backoffice financeiro e fiscal;
33. FEAT-033 — operações, jobs e auditoria;
34. FEAT-034 — LGPD e direitos de dados completos.

Exemplos de quebra dos ciclos:

- termos versionados são contrato bootstrap de identidade; FEAT-034 implementa os direitos LGPD completos depois do histórico financeiro;
- taxonomias iniciais existem como seed estrutural; FEAT-007 as consome e FEAT-031 adiciona sua administração;
- FEAT-009 implementa submissão e estados editoriais; FEAT-030 implementa a decisão administrativa e publicação atômica;
- FEAT-017 implementa adicionais; FEAT-018 os consome na cotação;
- FEAT-024 emite contratos de outbox e intenção de repasse; FEAT-026 e FEAT-029 implementam os processadores e experiências específicas.

## Alternativas

- Implementar todas as features de um ciclo no mesmo PR: rejeitado por ampliar risco e violar a regra de uma feature por branch.
- Ignorar as dependências declaradas: rejeitado por perder contratos do produto.
- Manter a ordem numérica: rejeitado porque não produz cortes verticais utilizáveis.

## Consequências

- a sequência passa a ser executável e revisável;
- alguns contratos internos surgem antes da UI que os opera;
- cada feature continua responsável por seus próprios cenários e Definition of Done;
- integrações futuras não permitem declarar produção pronta antes de suas dependências reais;
- `docs:check` deve provar presença única das 34 features e coerência entre status e planos transitórios;
- mudanças nessa sequência exigem atualizar este ADR e `docs/roadmap.md` no mesmo PR.
