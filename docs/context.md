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
- A FEAT-004 está em implementação na branch própria, com o [PR #6](https://github.com/PedroRomeroM/set-livre/pull/6). O quarto P2 e sua release funcional `969f30cd...` permanecem evidência histórica. O review `PRR_kwDOTyzZrs8AAAABJsAUGQ`/REST `4945089561`, submetido em `2026-08-16T01:07:18Z` sobre `0decf00`, abriu `PRRT_kwDOTyzZrs6Zj15h`, comentário `PRRC_kwDOTyzZrs7h8LaV`/REST `3790648981`. O quinto P2 adiciona `ownerActivationCapability: "available" | "unavailable"` somente à projeção completa, mantém a fixture consultiva fora de `local | test`, recusa `owner.activate` antes da escrita e omite form/checkbox/CTA na UI indisponível. Seu primeiro snapshot passou em 747/747 unitários e 358/358 no banco.
- A primeira rodada browser focada coletou 23 testes em quatro specs/14 projetos (`615bf589...`) e terminou uma única vez com exit `1`: 12 passados, falha em `SL-F004-E2E-001`/`critical-webkit`, dez não executados e zero rerun. O provisionamento expôs submit GET nativo no cadastro antes da hidratação, com campos sintéticos na query. É uma falha real de privacidade da FEAT-002 compartilhada, não evidência da capability; o ID 004 não foi alcançado e a integral não iniciou. Somente stdout redigido `f4d0595a...` e auditoria `13859c3c...` foram preservados; os brutos foram removidos sem reproduzir valores/endereço e o cleanup terminou em zero.
- O cadastro agora falha fechado no único `form` SSR: `useSyncExternalStore` retorna `false` no servidor e `true` no cliente; o status **Preparando o formulário seguro…** fica fora do formulário inerte, que usa POST/`aria-busy`, `fieldset`, sete controles nomeados e submit disabled até a hidratação. Depois dela, o fluxo normal é restaurado. Os unitários direcionados passaram em 2/2 e a guarda combinada da identidade em 22/22; `SL-F002-E2E-001` foi estendido sem novo ID com contexto sem JavaScript.
- A focada race-fixed passou em 23/23 por quatro specs/14 projetos e teve seu reuse validado. A rodada attribute-fixed coletou 114 testes em 17 specs/16 projetos e sua única execução passou em 114/114 em 5,6 minutos, com zero retry, erro ou attachment. A FEAT-004 permaneceu em 23/23 na distribuição `3 + 3 + 3 + 4 + 3 + 4 + 3`; o no-JS da FEAT-002 passou nos três engines sem novo ID ou contagem.
- A auditoria encontrou 140 ocorrências dos 88 e-mails QA apenas em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22 —, zero secret/PII ou outro dado sensível e cleanup zero. Evidência segura: `.artifacts/p5-owner-activation-capability-attribute-fixed/full.audit.json`, SHA-256 `5704c67cf21bdcc6e92b733bfdb8788972c216d48f850c885200b6d4d78a37d6`. As execuções rejeitadas anteriores permanecem histórico diagnóstico: o defeito inicial foi corrigido e os demais desfechos pertencem ao harness/oráculo, sem falha atual do produto.
- O snapshot do fechamento browser ficou verde em Node 24/npm 11, com static então vigente de 749/749, banco 358/358, focada 23/23 e integral 114/114; a asserção auxiliar de `next-env` e a primeira invocação parcial de banco permanecem registradas como inválidas, sem falha em gate do projeto. Uma única build P5 compilou 26 + 4 rotas com exit `0`, zero warning e `BUILD_ID=local`, mas seu artefato foi recusado: o standalone copiou as strings de conexão administrativas/DAL locais que estavam inline no `scripts.knip` do manifesto raiz. O smoke permaneceu em zero. A correção deixa o script como `knip`, mantém os valores no `.env.e2e.local` físico e adiciona uma guarda unitária sobre os quatro manifests canônicos — raiz, backoffice, contracts e UI — contra URL de banco em scripts npm; checks direcionados, 4/4 unitários, Knip com as sete variáveis E2E explicitamente unset e diff-check passaram sem alterar o lockfile. A execução pós-manifesto que testou esse fix está registrada no item seguinte. Não há provider externo, migration, publicação, resposta, resolução, ready ou merge deste delta. PEND-003/004/006 e o smoke ARM64 nativo continuam bloqueando produção.
- A build pós-manifesto seguinte terminou uma única vez com exit `0` e log privado SHA-256 `d8e50e0fb0b7080bf021aa910bef7ededc6677ba6dfaa71d4789a1d6226e1a8e`, mas o audit encontrou uma ocorrência DAL em cada cache Turbopack; standalone, static e log ficaram limpos e o smoke permaneceu em zero. O wrapper único `scripts/next-build.mjs` serve os dois apps e o gerador de release com ambiente allowlisted: dentro da operação primária, o resolver confiável valida ancestrais físicos/protegidos do app e a toolchain Next antes do spawn, e o wrapper sempre tenta remover fisicamente apenas `.next/cache`, inclusive após falha de validação/build. Cleanup falho aborta, falha dupla vira `AggregateError` e raízes/ancestrais simbólicos ou externos são recusados sem spawn/travessia. O preview limpa no supervisor pai após qualquer desfecho do grupo de build, antes da validação/start; cleanup falho bloqueia o servidor, e a integração prova cache sintético ausente. O run direcionado final passou em 40/40 — 12 de cache/wrapper, quatro do npm confiável, 16 de Next/local server e oito do supervisor de preview — com ESLint zero, checks Node, Knip env-unset e diff-check.
- O fechamento final preserva DB 358/358, focada 23/23 e integral 114/114 e avança static para 764/764 em 76 arquivos. A cadeia única Node 24/npm 11 passou em npm ci 447/451/zero vulnerabilidades, format, lint zero, cinco typechecks, docs 34/200/18, audit zero, Knip/diff-check e freeze 53/34/19. A build final, após remoção física dos dois `.next`, rodou exatamente uma vez via wrapper e terminou exit `0` em 14,733 s; log de 2.155 bytes/SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. Audit independente SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d`: `NO-BLOCKER`, 26 + 4 rotas, warnings/cache/retired/resíduos zero e quatro `BUILD_ID=local`. Esse era o fechamento pré-release.
- O gerador canônico processou exatamente uma vez o commit `2045d1a00c15889007b3c5c04c08d0467fc3d9b3`, exit `0` em 21,26 s, e aprovou o primeiro smoke P5 embutido. A release local possui 2.871 artefatos/3.455 membros, dois `BUILD_ID` iguais ao commit, head `20260815000100`, lock `485ec8...` e duas auditorias `NO-BLOCKER`, sem mismatch, segredo, PII, cache ou resíduo. Archive ignorado e não publicado; ARM64/Oracle/PEND-003 e remoto permanecem pendentes.

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

Com browser 23/23 + 114/114, static 764/764, build e release local/smoke embutido verdes, o próximo passo é commitar esta documentação, fazer push, atualizar o body, responder e resolver `PRRT_kwDOTyzZrs6Zj15h`, solicitar novo `@codex review`, aguardar no mínimo 60 minutos e fazer uma captura final única antes de ready/merge. PEND-003 e o smoke ARM64 nativo continuam bloqueando produção.
