# FEAT-006 — Criação do estúdio e dados centrais versionados

## Estado

Em implementação na branch `feat/feat-006-studio-core-revision`, derivada de `main@b4f40035b3e7eda64d94726483d82ece9f01c7ed` depois da incorporação da FEAT-004.

## Intenção

Entregar a primeira vertical do domínio de oferta: um dono autenticado cria um estúdio e sua revisão em rascunho, corrige os dados centrais com concorrência otimista, compara rascunho e versão aprovada e descarta o rascunho quando isso é seguro.

## Autoridade e dependências

- `dependency-to-start`: FEAT-003 e FEAT-004, já incorporadas a `main`;
- bootstrap desta feature: revisão versionada e `studio_types` consumidos pelo editor;
- `dependency-to-complete`: `OPEN-012`, `OPEN-013` e administração/arquivamento taxonômico na
  FEAT-031; até decisão, autoridade permanece fail-closed e rename de tipo usado não entra;
- `dependency-to-release`: nenhuma específica da FEAT-006; as pendências gerais do ADR-018 continuam bloqueando produção, não a implementação local.

## Decisões fechadas antes do código

A `OPEN-011` registra e resolve as sobreposições existentes:

- FEAT-006 é dona de nome, descrição, endereço, capacidade e tipo;
- FEAT-007 fica com tags, comodidades, regras, FAQ e vídeo;
- FEAT-006 cria somente `studio_types`; as demais taxonomias entram com seu primeiro consumidor real;
- as opções locais `Fotografia`, `Vídeo`, `Podcast` e `Multifuncional` são fixtures de desenvolvimento/QA, nunca catálogo aprovado de produção;
- `studio.draft.discard` nasce nesta feature e será apenas reutilizado pela FEAT-009;
- concorrência usa `expectedEditVersion`, não timestamp;
- nenhuma rota pública de estúdio é antecipada.

## Escopo vertical

- migration append-only para `studio_types`, `studios`, `studio_revisions`, constraints, RLS, grants, funções privadas e read models necessários;
- hardening append-only `20260816000200` para lock do tipo, clone publicado idêntico, correlação de
  auditoria e assinaturas privadas, sem editar a migration `20260816000100`;
- contratos Zod/DTOs estritos e integração modular ao registry de `/api/commands`;
- DAL `server-only`, serviço autoritativo e GET autenticado do editor;
- rotas `/dono/estudios/novo` e `/dono/estudios/[studioId]/dados`;
- boundary fechado antes da hidratação e durante probes dirty/pending, controller do formulário
  preservado somente para concluir callbacks seguros, preview privado, refetch e recuperação de
  conflito sem payload persistido;
- query keys escopadas por usuário e estúdio, com limpeza nas transições de sessão;
- unitários, pgTAP e os seis IDs `SL-F006-E2E-001..006`, incluindo o contrato dedicado de reflow;
- documentação viva, HTML executivo, observabilidade, rollback e rastreabilidade no mesmo PR.

## Restrições

- nenhum `amenities`, `tags`, FAQ, mídia, submissão, aprovação, publicação, pausa, portfólio ou página pública;
- nenhum tipo criado pelo dono;
- endereço/descrição nunca entram em URL, log ou erro público; evidência persistida usa somente
  fixtures sintéticas com namespace `qa_f006_*`, sem dados reais ou não-namespaceados;
- as três specs fixam trace, screenshot e vídeo em `off`, pois o provisionamento atravessa senha,
  documentos e cookies; locators, HTTP, contadores, DOM, stdout/relatório redigidos e scans
  negativos formam a evidência equivalente;
- status, número de revisão e versão resultante são sempre server-side;
- ausência de tipo ativo falha de modo factual, sem opção falsa ou controle sem ação.
- no-op só existe para draft atual semanticamente idêntico; publicado sem draft sempre clona, e todo
  sucesso remonta o formulário com o retorno autoritativo.

## Evidência inicial

- Blueprint, especificação, ADRs 001–018, ordem executável, FEAT-006 e documentos especializados foram reavaliados antes da branch;
- `main` local avançou por fast-forward até `b4f40035...` e a branch exclusiva foi aberta com checkout limpo;
- nenhuma dependência nova ou serviço externo é necessário.

## Estado factual do snapshot

FEAT-006 permanece em implementação, com 3/34 features concluídas; `OPEN-012`, `OPEN-013` e FEAT-031
bloqueiam sua conclusão. `20260816000100` continua imutável, e a fonte agora possui a 17ª migration,
`20260816000200_studio_command_concurrency_hardening.sql`, como head/readiness. O predecessor imediato
esperado é `20260816000100` falso; o manifesto permanece em 20 dependências/19 rotinas. O último reset,
geração e `test:db` aceito continua sendo a fotografia anterior de 431 asserts
(`158 + 78 + 57 + 65 + 73`), com quatro fixtures locais e cleanup zero. O pgTAP `0005` agora declara
83 casos e o total esperado é 441 (`158 + 78 + 57 + 65 + 83`), ainda pendente de reset, geração e
rerun. `supabase/schema.generated.sql` e `packages/contracts/src/database.generated.ts` estão stale;
nenhum hash antigo de gerado representa este snapshot e não existe gate DB verde pós-hardening. A
migration `00200` teve somente inspeção estática/diff neste ambiente; uma auditoria independente de
estrutura fechou `GO` sem blocker, mas não executou PostgreSQL. `00100`, `00200` e `0005`
continuam untracked; checksum Git não comprova sua história, que só será atestada pelo reset/banco
aplicado em ambiente compatível.

A última cadeia estática integral canônica, anterior aos helpers/hardenings finais, está verde em
Node 24.18/npm 11.19: npm ci 447/451/zero vulnerabilidades, format/lint, cinco typechecks, 85
arquivos/893 unitários, docs 34/200/18, audit zero, Knip e diff-check. O recorte dirigido anterior
passou em 124/124 por dez arquivos. O atual passou em 141/141 por 12 arquivos FEAT-006/studio sob
Node 24, incluindo correlação separada e remount pós-save; nenhum dos dois é uma integral. A tentativa
completa atual falhou em 12 testes de
infraestrutura por limites do sandbox — nested spawn `EPERM`, remapeamento de ownership raiz e
timeouts de process group ou stdout vazio — e não constitui gate verde.

O run focado aceito passou historicamente em 17/17 por duas specs/sete projetos, cobrindo os cinco
IDs então existentes, axe, desktop/mobile e stale com comparação/recuperação, com privacidade e
cleanup verdes. Tombstone/replay pertencem à prova unitária/SQL, não ao browser. A fonte atual possui
seis IDs e três specs: projeta 20 execuções/dez projetos, enquanto a integral projeta 134; nenhuma
dessas projeções foi executada. As três specs mantêm trace, screenshot e vídeo em `off`; a evidência
permitida usa somente `qa_f006_*`, observações redigidas e scans negativos dos outputs frescos.

Sem criar IDs além do 006, a fonte atual amplia 001 para reter um create já commitado, fechar o DOM
durante GET same-scope e restaurar os valores crus ainda pending/disabled com exatamente um POST; 002
comprova pela UI `draft_removed`, um POST e aprovada inalterada; 003 troca dirty A→B no mesmo
page/QueryClient, exige `409 SESSION_CHANGED`, fecha A antes da publicação tardia e conserva o `404`
indistinguível de outro dono; 004 usa Tab/Enter, foco no primeiro erro e zero POST inválido; 005
preserva stale/compare/reapply; 006 cobre 160x360 nos três engines.

Quatro runs focados anteriores foram rejeitados, respectivamente, por trigger de cleanup, locator
de comparação, trigger de publicação e status soft-404. Permanecem diagnóstico histórico de
harness e não caracterizam falha atual do produto. A coleta integral histórica enumerou 131 testes
em 19 specs/16 projetos; uma execução foi rejeitada pela race do body e outra interrompida no teste
10, portanto não existe matriz integral verde. O sandbox gerenciado atual não permite o localhost
necessário para executar os 20 focados/134 integrais atuais. Build final das duas apps, smoke,
release, remoto, ARM64 e PEND-003 também permanecem pendentes.

Depois do preclean físico dos dois `.next`, houve exatamente uma invocação
`APP_RELEASE_SHA=local npm run build` sob Node 24/npm 11. A etapa web compilou em 3,9 s, mas a
execução foi rejeitada em `Could not parse output from TypeScript's --showConfig`; o backoffice não
iniciou e nenhum smoke foi executado. O diagnóstico independente separou código de harness:
`tsc --showConfig` direto terminou com exit `0`, e o spawn exato com stdout/stderr em pipe também
terminou `0`, porém ambos os buffers tiveram length zero no sandbox. Isso é rejeição de
harness/sandbox, não falha de produto e não build verde.

O log privado da tentativa possui 449 bytes, modo `0600` e SHA-256
`0f614f806016737ae887529df0ed728dab3d4b3d62da13b12010925facb6cf68`. `next-env`, lockfile e
ausência de caches permaneceram canônicos. O build final das duas apps continua pendente. O
`docs:check` desta atualização também é inconclusivo: seu pipe de `git hash-object --stdin` não
produziu saída no mesmo sandbox; a prova anterior 34/200/18 permanece temporal, não aprovação do
snapshot documental atual.

O contrato é verification-first: os read models são `list_active_studio_types()` e
`get_owner_studio_editor()`; o GET recusa conta suspensa/perfil incompleto antes do header, exige
`x-set-livre-expected-scope` UUID como asserção — nunca autenticação ou ownership — e rejeita
ausência/formato com `422` ou divergência com `409 SESSION_CHANGED` antes da query/read. Create/update
cujo resultado idempotente tardio já não pode ser reconstruído emite
`40001`/`studio_result_no_longer_available`, mapeado para `409` e GET explícito, sem replay automático
de POST.

Create/update bloqueiam o `studio_type` ainda ativo com `FOR SHARE` antes do efeito, de modo que a
seleção e o futuro arquivamento sejam linearizados. A FEAT-031 deve manter archive tipo-only; se
também bloquear estúdio existente, segue a ordem agregado → tipo do update ou exige redesenho e teste
bidirecional. Adquirir estúdio depois do tipo silenciosamente é proibido; arquivar preserva o histórico e
remove novas seleções, enquanto rename de tipo usado continua proibido por `OPEN-013`. Um publicado
sem draft clona a aprovada mesmo com core idêntico. No-op fica restrito ao draft existente idêntico e
não incrementa `editVersion`, mas seu sucesso remonta a UI e limpa o estado dirty.

O `requestId` UUID percorre rota, handler, serviço, DAL e SQL fora do payload/hash e aparece depois da
`idempotencyKey` nas assinaturas privadas de 13/14/5 parâmetros. Efeito novo grava um único fato
append-only: `studio.created`, `studio.revision.updated`, `studio.draft.discarded` ou
`studio.deleted`, sempre `authenticated`/`studio`/`succeeded`, `ip_hash=null` e metadata estrutural de
versão. Core e PII nunca entram. Replay preserva o primeiro evento e seu `requestId`; no-op, falha e
conflito gravam zero evento.

Foco, online e visibilidade disparam probe quando o formulário está dirty ou há mutation pendente.
Durante o GET, DOM privado e preview ficam ausentes; o controller permanece montado apenas para
concluir a mutation e guarda valores crus em refs efêmeras, nunca URL, storage ou QueryCache. Mesmo
escopo restaura exatamente os raws; troca de escopo limpa boundary/cache e recarrega. Um latch de
unmount/transição e checks imediatamente após cada `await` suprimem callbacks tardios.

Na criação ambígua, S1 permanece estável e uma tentativa explícita usa chave nova. Se o GET encontra
o core A enquanto o usuário já prepara B, a UI compara A/B: usar a atual navega explicitamente para
S1/A; reaplicar preserva B e transforma a próxima gravação em update de S1 com
`expectedEditVersion` autoritativa e chave nova. A fonte desktop-chromium do ID 005 fixa K1/S1/A
ambígua → GET 404 → usuário B → commit tardio K1 → K2/S1/B 409 → comparação A/B → reaplicação → save
explícito K3 como update do único S1. O roteiro está implementado na fonte, mas não foi executado nem
está verde. Nenhum payload entra em URL/storage/QueryCache. O recorte dirigido anterior 124/124
inclui guards, recuperação, latch e redaction de idempotency key, UUID do estúdio, tipo, nome,
endereço, descrição e user-agent. O atual 141/141 acrescenta correlação, assinaturas e remount; nenhum
substitui a integral.

## Rollback, correção e provas pendentes

`20260816000100` permanece append-only e imutável; `20260816000200` é a correção forward-only e
também não pode ser reescrita depois de aplicada. Rollback do app só usa release anterior compatível
com o schema, preservando head/readiness, shells, drafts, revisões, ledger e auditoria; correção de
schema/dados usa nova migration e comando autoritativo. Permanecem pendentes o `docs:check` canônico,
a integral unitária atual, reset + geração + DB 441, browser focado 20 e integral 134, build das duas
apps, smoke, release, ARM64, as decisões OPEN-012/013 e a integração taxonômica da FEAT-031. Os novos
contratos existem em fonte, não em evidência SQL/browser runtime verde.
