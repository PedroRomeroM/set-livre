# FEAT-006 — Criação do estúdio e dados centrais versionados

## Metadados

| Campo            | Valor                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Em implementação                                                                                                                                                                       |
| Prioridade       | P0                                                                                                                                                                                     |
| Domínio          | `studios`                                                                                                                                                                              |
| Specs Playwright | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`<br>`tests/e2e/regression/feat-006-studio-core-revision.spec.ts`<br>`tests/e2e/reflow/feat-006-studio-core-revision.spec.ts` |

## Objetivo

Criar a entidade estúdio e uma revisão editável com dados públicos completos, preservando a versão aprovada.

## Papéis

- dono

## Rotas e superfícies

- /dono/estudios/novo
- /dono/estudios/[studioId]/dados

## Dependências

- `dependency-to-start`: FEAT-003 e FEAT-004, já incorporadas a `main`.
- contrato bootstrap: `studio_types`, criado e consumido nesta feature.
- `dependency-to-complete`: decisões humanas OPEN-012/013 e administração/arquivamento da taxonomia
  pela FEAT-031.

## Incluído

- Nome, descrição, endereço completo, bairro/cidade/UF/CEP.
- Capacidade e tipo.
- Criação do estúdio e da revisão em rascunho.
- Edição com controle de concorrência otimista.
- Validação de Curitiba/PR na baseline.
- Pré-visualização da revisão.

## Fora desta feature

- mapa/geocoding
- múltiplos donos
- slug customizado

## Regras de produto e domínio

- O dono pode ter múltiplos estúdios.
- Um estúdio tem no máximo um rascunho ativo.
- Revisão submetida é imutável.
- Editar publicado sem rascunho clona a revisão aprovada mesmo quando o core enviado é
  semanticamente idêntico; somente um rascunho já existente e idêntico é no-op.
- Endereço completo será público após aprovação.
- Revision number cresce monotonicamente.
- Concorrência otimista usa `editVersion` monotônico; o navegador envia somente `expectedEditVersion`.
- `studio.draft.discard` remove o shell nunca publicado apenas quando a exclusão é segura; em estúdio publicado, remove somente o rascunho.

## Dados canônicos afetados

- studios
- studio_revisions
- studio_types

## Read models

- `list_active_studio_types()`
- `get_owner_studio_editor()`

## Comandos e integrações

- studio.create
- studio.revision.updateCore
- studio.draft.discard

## UX e estados obrigatórios

- Form por seções.
- Salvar explícito.
- Conflito de versão mostra recarregar/comparar.
- A pré-visualização não é publicada.
- Campos longos com contador.
- Ausência de tipo ativo mostra uma dependência factual; o dono não cria taxonomia nesta tela.
- Todo sucesso de save remonta o formulário a partir do retorno autoritativo, inclusive quando um
  rascunho existente produziu no-op e `editVersion` permaneceu igual.

Além do fluxo nominal, a interface DEVE contemplar loading inicial estável, refetch, vazio, erro de campo, erro de seção, conflito, timeout quando aplicável, sucesso e recuperação.

## Segurança e privacidade

- Ownership em todas as referências.
- Endereço e descrição em rascunho ficam restritos ao editor privado do dono; nenhuma superfície
  pública é criada nesta feature.
- Zod + checks de banco.
- Não aceitar status nem número de revisão enviados pelo cliente.
- O GET autentica e recusa conta suspensa com `ACCOUNT_SUSPENDED` e perfil incompleto com
  `FORBIDDEN` antes de interpretar parâmetros ou consultar os read models.
- Todo GET do cliente interativo exige `x-set-livre-expected-scope` UUID. Esse header é apenas uma
  asserção do recorte SSR, nunca autenticação ou ownership: a sessão autoritativa continua sendo a
  única autoridade; ausência/formato inválido retorna `422`, divergência retorna `409 SESSION_CHANGED`
  e nenhum read model é chamado.
- Endereço e descrição nunca entram em URL, log ou erro público. Dados de teste usam exclusivamente
  fixtures sintéticas com namespace `qa_f006_*`; dados reais ou não-namespaceados são proibidos em
  qualquer evidência persistida.
- As três specs desativam trace, screenshot e vídeo porque o provisionamento atravessa senha,
  documentos e cookies de sessão. A evidência equivalente usa locators semânticos, respostas HTTP,
  contadores de request, asserções de DOM, saída/relatório redigidos e varreduras negativas.
- Os três comandos recebem o `requestId` validado da rota apenas no contexto server-side, separado da
  `idempotencyKey` e fora do hash do payload. Um efeito novo grava um único fato append-only em
  `audit.events`; replay conserva a correlação original, enquanto no-op, falha e conflito não auditam.
- Auditoria de estúdio aceita apenas ator `authenticated`, alvo `studio`, resultado `succeeded`, ação
  factual e metadata estrutural de versão. Core, nome, descrição, endereço, tipo e PII são proibidos.

## Critérios de aceitação

- Criação atômica.
- Edição não altera publicado.
- Conflito concorrente não perde silenciosamente.
- Curitiba/PR validado.
- Outro dono não edita.

## Playwright obrigatório

| ID              | Prioridade | Suíte      | Viewport  | Cenário                                                     | Spec                                                         |
| --------------- | ---------- | ---------- | --------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| SL-F006-E2E-001 | P0         | critical   | desktop   | criar estúdio e salvar revisão em rascunho                  | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`   |
| SL-F006-E2E-002 | P0         | critical   | desktop   | editar publicado cria revisão sem alterar a versão aprovada | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`   |
| SL-F006-E2E-003 | P0         | critical   | desktop   | dono A não edita estúdio B                                  | `tests/e2e/critical/feat-006-studio-core-revision.spec.ts`   |
| SL-F006-E2E-004 | P1         | regression | mobile    | validação de endereço/capacidade por teclado                | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts` |
| SL-F006-E2E-005 | P1         | regression | desktop   | create ambíguo compara A/B, reaplica e salva B no único S1  | `tests/e2e/regression/feat-006-studio-core-revision.spec.ts` |
| SL-F006-E2E-006 | P1         | reflow     | zoom 200% | editor preserva conteúdo e operação em 160x360              | `tests/e2e/reflow/feat-006-studio-core-revision.spec.ts`     |

Regras:

- fluxos P0 passam pela UI;
- setup/cleanup pode usar helper de banco somente local;
- locators semânticos primeiro;
- axe no cenário indicado ou no principal da feature;
- sem `waitForTimeout`;
- trace, screenshot e vídeo `off` pela exceção de PII, com evidência redigida equivalente;
- dados com namespace QA.

## Testes unitários, integração e banco

- banco: unicidade/imobilidade de revisão, concorrência, replay/tombstone, lock de tipo ativo versus
  arquivamento, clone publicado idêntico e auditoria atômica/correlacionada;
- unitário: core schema, guards do GET, verification-first, propagação separada de `requestId`,
  remount pós-save e redaction de telemetria;
- integração: clone da revisão aprovada e retorno tardio indisponível sem read pós-commit.

## Fronteira decidida para a implementação

A `OPEN-011` resolve as sobreposições documentais. Esta feature é dona de `description`, `studio_type_id` e `studio.draft.discard`. O bootstrap cria somente `studio_types`; tags, comodidades, regras, FAQ e vídeo permanecem na FEAT-007. As quatro opções locais são fixtures explícitas de desenvolvimento/QA e não representam catálogo comercial aprovado de produção.

## Documentação viva afetada

- database.md
- domain-model.md
- qa-test-plan.md

Toda mudança desta feature também atualiza este arquivo, o catálogo QA e `docs/changes/`.

## Rollback e correção

`20260816000100_studio_core_revision.sql` permanece imutável. O hardening usa exclusivamente a nova
migration forward-only `20260816000200_studio_command_concurrency_hardening.sql`; nenhuma das duas
deve ser editada ou revertida depois de aplicada.
Rollback do app só pode apontar para uma release anterior comprovadamente compatível com o schema
atual, mantendo o head/readiness aceitos. Shells, drafts, revisões e ledger de idempotência são
preservados; correção de schema ou dados usa nova migration forward-only e comando autoritativo, sem
deleção manual de histórico.

## Definition of Done da feature

- todos os critérios acima comprovados;
- migration/grants/RLS verdes quando aplicável;
- read model/command e invalidação documentados;
- Playwright listado e verde;
- desktop/mobile/teclado/axe verificados;
- logs e métricas necessários;
- rollback/correção definidos;
- nenhuma funcionalidade fora de escopo introduzida.

## Estado de implementação atual

FEAT-006 está em implementação. `OPEN-012` mantém a autoridade pré-ativação sem resolução e o editor
fail-closed para perfil/dono ativos; `OPEN-013` impede renomear tipo já usado. As duas decisões,
somadas à administração/arquivamento da FEAT-031, bloqueiam a conclusão. A fonte atual automatiza
seis IDs. Sem criar IDs adicionais, 001 retém um POST de criação já commitado e prova o
probe same-scope durante a mutation pendente, DOM privado fechado e valores crus restaurados ainda
disabled; 002 exige descarte pela UI com `draft_removed`, um POST e versão aprovada inalterada; 003
cobre troca dirty A→B no mesmo page/QueryClient, `SESSION_CHANGED`, fechamento anterior à publicação
tardia e também o `404` indistinguível de outro dono; 004 usa Tab/Enter, foco no primeiro erro e zero
POST inválido; 005 preserva comparação, reaplicação e save explícito; 006 cobre reflow 160x360 nos
três engines. Essa fonte projeta 20 execuções por três specs/dez projetos, mas ainda não foi
executada.

O único browser aceito para esta feature continua sendo a fotografia histórica de 17/17 por duas
specs/sete projetos, anterior às extensões acima. Ela comprova axe, desktop/mobile e stale com
comparação/recuperação; tombstone/replay pertencem às provas unitária/SQL. A coleta integral
histórica enumerou 131 testes em 19 specs/16 projetos, sem matriz verde. A fonte integral atual
projeta 134 execuções e também permanece sem run; nenhum número projetado é apresentado como gate.

O último DB autorizado permanece a fotografia de 16 migrations/head `20260816000100`, 431 asserts
(`158 + 78 + 57 + 65 + 73`), readiness `true`/predecessor `false`, 20 dependências, 19 rotinas,
quatro fixtures locais e cleanup zero. A fonte agora possui 17 migrations e head/readiness
`20260816000200`, com predecessor imediato `20260816000100` esperado como falso e o mesmo manifesto
de 20 dependências/19 rotinas. O pgTAP `0005` declara 83 casos; o total esperado é 441
(`158 + 78 + 57 + 65 + 83`) e permanece pendente de reset, geração e rerun. Tanto
`supabase/schema.generated.sql` quanto `packages/contracts/src/database.generated.ts` estão
objetivamente stale; não existe gate DB verde nem contrato gerado atual após o hardening. A última
cadeia estática integral canônica, anterior aos helpers/hardenings atuais, passou em 893/893 por 85
arquivos. O recorte dirigido anterior de 124/124 por dez arquivos permanece histórico; o recorte
atual passou em 141/141 por 12 arquivos FEAT-006/studio sob Node 24, incluindo propagação de
correlação e remount pós-save, mas não é integral. A tentativa completa atual falhou em 12
testes de infraestrutura por limites do sandbox — nested spawn `EPERM`, remapeamento de ownership
raiz e timeouts de process group ou stdout vazio — e não constitui gate verde.

O GET barra conta suspensa e perfil incompleto antes de header/query/read e exige
`x-set-livre-expected-scope` como asserção, não autoridade. Foco, reconexão e visibilidade disparam um
probe quando o form está dirty ou existe mutation pendente: a superfície privada fecha, valores crus
ficam somente em refs do controller montado e não entram em URL, storage ou QueryCache. Troca de
escopo, unmount ou qualquer retorno pós-`await` aciona o latch e impede callback tardio de republicar
dados. Create/update sem resultado idempotente reconstruível recebem
`40001`/`studio_result_no_longer_available` como `409` verification-first, sem replay automático.

Create/update adquirem `FOR SHARE` sobre o `studio_type` ainda ativo antes do efeito, linearizando a
seleção com o futuro arquivamento. A FEAT-031 deve manter o archive tipo-only. Se também bloquear um
estúdio existente, precisa seguir a ordem agregado → tipo do update ou redesenhar/testar as duas
direções; buscar estúdio depois de tipo silenciosamente é proibido. Arquivar impede novas seleções e
preserva referências; rename de tipo usado continua proibido por `OPEN-013`. Em update, um publicado
sem draft sempre cria a próxima revisão, ainda que o core coincida com a aprovada. Um draft existente
idêntico retorna o estado autoritativo sem incrementar versão nem criar auditoria; a UI ainda remonta
o form e limpa o estado dirty.

Efeitos reais gravam exatamente uma das ações `studio.created`, `studio.revision.updated`,
`studio.draft.discarded` ou `studio.deleted`. A metadata allowlisted é, respectivamente,
`{ editVersion, revisionNumber }`, `{ draftCreated, editVersion, revisionNumber }`,
`{ editVersion, revisionNumber }` ou `{ lastRevisionNumber }`; `requestId` e `idempotencyKey` ocupam
colunas próprias. Replay não duplica nem troca o `requestId` do primeiro efeito; no-op, falha e
conflito gravam zero fato.

Na criação ambígua, o UUID S1 permanece estável e cada tentativa explícita usa nova chave. A fonte
desktop-chromium do ID 005 fixa a sequência determinística K1/S1/A ambígua → GET 404 → usuário edita
B → commit tardio K1 → K2/S1/B recebe 409 → comparação A/B → **Reaplicar** → save explícito K3 como
update do único S1 com `expectedEditVersion` autoritativa. **Editar a partir da versão atual** navega
explicitamente para S1/A. B nunca entra em URL, storage ou QueryCache e não é perdido silenciosamente.
Esse roteiro está implementado na fonte, mas não foi executado e não está verde. A telemetria
direcionada comprova redaction de idempotency key, UUID do estúdio, tipo, nome, endereço, descrição e
user-agent.

A fonte agora contém os contratos browser de teclado, reflow, descarte e probes dirty/pending, mas
eles permanecem sem execução. Continuam pendentes o `docs:check` canônico, a integral unitária atual,
reset + geração + DB 441, browser focado projetado 20 e integral projetado 134, build das duas apps,
smoke, release e ARM64. Nenhum desses itens pode ser inferido dos recortes dirigidos 124/124 ou
141/141 nem do histórico 17/17. A migration `00200` teve apenas inspeção estática/diff e auditoria
estrutural independente `GO` neste ambiente, nunca execução SQL. `00100`, `00200` e `0005` ainda
estão untracked; nenhum checksum Git substitui a
futura prova da cadeia efetivamente aplicada.

Após preclean físico dos dois `.next`, a única invocação `APP_RELEASE_SHA=local npm run build` sob
Node 24/npm 11 compilou a etapa web em 3,9 s e foi rejeitada em
`Could not parse output from TypeScript's --showConfig`; backoffice não iniciou e smoke ficou em
zero. O comando direto e o spawn exato com pipes terminaram `0`, mas stdout/stderr do spawn vieram
com length zero no sandbox. O resultado é rejeição de harness, não falha de produto nem build verde.
O log privado de 449 bytes/modo `0600` tem SHA-256
`0f614f806016737ae887529df0ed728dab3d4b3d62da13b12010925facb6cf68`; `next-env`, lockfile e
caches ficaram canônicos. Build final das duas apps e `docs:check` atual — inconclusivo no pipe de
`git hash-object --stdin` — permanecem pendentes.
