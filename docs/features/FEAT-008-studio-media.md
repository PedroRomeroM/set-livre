# FEAT-008 — Galeria privada do estúdio

## Estado e recorte

| Campo            | Valor                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Em andamento                                                                                                                                                                                                              |
| Prioridade       | P0                                                                                                                                                                                                                        |
| Domínio          | `media`                                                                                                                                                                                                                   |
| Superfície       | `/dono/estudios/[studioId]/midia`                                                                                                                                                                                         |
| Specs Playwright | `tests/e2e/critical/feat-008-studio-media.spec.ts`<br>`tests/e2e/regression/feat-008-studio-media.spec.ts`<br>`tests/e2e/accessibility/feat-008-studio-media.spec.ts`<br>`tests/e2e/reflow/feat-008-studio-media.spec.ts` |

A feature permite ao dono enviar e organizar as fotos da revisão editável do próprio estúdio. Ela
depende de FEAT-006 e do Supabase Storage. Revisão editorial, submissão, catálogo público e SEO
pertencem respectivamente a FEAT-030, FEAT-009 e FEAT-011 e não são antecipados aqui.

## Contrato vertical

- a revisão editável aceita de zero a vinte fotos; a exigência de ao menos uma foto e de uma capa é
  validada somente ao enviar a revisão;
- JPEG, PNG, WebP e AVIF são aceitos até 15 MiB, 8.192 px por dimensão e 36 milhões de pixels;
- `studio.media.upload.prepare` deriva o path e emite token assinado sem sobrescrita. Reserva
  expirada ou rejeitada pelo servidor deixa de consumir a cota imediatamente; renovar cria nova
  idempotência, mídia, path e token;
- o browser envia o arquivo diretamente ao bucket privado `studio-media`;
- `studio.media.upload.finalize` verifica replay antes de baixar, comprova bytes, MIME real,
  decodificação, dimensões e SHA-256, gera uma prévia WebP de até 1.280 px/3 MiB e só então associa o
  objeto à revisão. Download, decode e preview compartilham um deadline absoluto server-side de 15
  segundos e um único slot, sem `Promise.race` que abandone trabalho nativo;
- `studio.media.reorder`, `studio.media.cover.set` e `studio.media.delete` usam versão otimista da
  revisão, idempotência e retorno autoritativo;
- a associação é versionada por revisão. Criar um novo rascunho preserva os mesmos objetos da revisão
  publicada até que o dono altere a nova associação; os paths imutáveis conservam a revisão de origem
  do objeto clonado;
- exclusão física ocorre somente sem associação remanescente, via Storage API. A autorização de upload
  expira em duas horas e deixa de consumir cota; o órfão fica elegível para limpeza após 24 horas,
  enquanto rejeição e exclusão entram imediatamente na fila com retry cercado por claim;
- a leitura do dono obtém paths somente por função DAL privada e os assina em lote no servidor com a
  secret key dedicada por cinco minutos; o browser não recebe paths nem permissão para assinar ou ler
  objetos e o original ou a revisão nunca se tornam públicos;
- o runtime x86_64 processa no máximo uma imagem por vez, com fila pequena e deadline explícito. Excesso
  retorna indisponibilidade recuperável antes de pressionar a VM de 1 GiB.

## UX obrigatória

- hidratação fail-closed e releitura privada por usuário + estúdio;
- fila sequencial em memória, deadline de upload de 60 segundos, estado por arquivo e recuperação
  explícita tanto antes quanto depois de uma resposta perdida;
- recusa definitiva da Storage API ainda exige verificação server-side; renovação só aparece depois de
  `object_missing` persistido liberar a reserva antiga;
- respostas atrasadas nunca fazem o cache regredir: número da revisão e versão formam o fence
  monotônico, e toda mutação bem-sucedida termina com releitura autoritativa; descartar a draft remove
  a query exata de mídia antes de restaurar a revisão publicada;
- ordenação completa por botões acessíveis e teclado, sem depender de drag;
- escolha de capa, confirmação de exclusão e lightbox com retorno de foco;
- composição própria em 320 px, zoom de 200%, touch targets de 44 px e axe no fluxo principal;
- loading, vazio, erro, conflito, sucesso e expiração de prévia somente onde há transição real.

## Segurança e dados

- tabelas `studio_media` e `studio_revision_media`, RLS habilitada e grants mínimos;
- estados do objeto: `pending_upload`, `ready`, `rejected`, `delete_pending` e `deleted`;
- paths canônicos `owners/<ownerId>/studios/<studioId>/revisions/<revisionId>/<mediaId>.<ext>` e
  `<mediaId>.preview.webp`;
- nenhum ID do cliente prova ownership e nenhuma operação usa secret/service role no browser. A
  aplicação pública da VM recebe a secret key somente em `EnvironmentFile` root-only para operações
  estreitas de Storage, depois que sessão, ownership e paths foram validados pelo DAL;
- Edge Function de cleanup autentica uma secret key exclusivamente no header `apikey`, executa lote
  limitado e remove o objeto somente pela Storage API;
- ledger interrompido é recuperado sem edição manual: após 30 minutos, a próxima execução fecha o run
  abandonado, reassume leases vencidos e precisa concluir com sucesso para restaurar readiness. A
  ausência de sucesso terminal por 30 minutos também fecha readiness;
- a VM invoca somente o slug imutável da release ativa por uma oneshot e timer `systemd`; Cron,
  `pg_net` e Vault não pertencem ao fluxo, `maintenance` permanece privado e `service_role` recebe
  apenas as fachadas RPC estreitas;
- o retorno ao browser omite `storagePath`; grants de tabela/Storage não permitem descoberta nem
  assinatura direta e URL assinada não entra em persistência nem cache público.
- a CSP admite a origem Supabase exata em `img-src` e `connect-src`, e o canário interrompido permanece
  recuperável: após 30 minutos, ausência dos dois paths precisa ser provada por `404/NoSuchKey` antes
  de o checkpoint virar `aborted`.

## Cenários de aceitação

| ID              | Prioridade | Suíte      | Viewport | Cenário                                                       |
| --------------- | ---------- | ---------- | -------- | ------------------------------------------------------------- |
| SL-F008-E2E-001 | P0         | critical   | desktop  | upload válido, finalização, capa e ordenação                  |
| SL-F008-E2E-002 | P0         | critical   | desktop  | MIME forjado e arquivo acima do limite são rejeitados         |
| SL-F008-E2E-003 | P0         | critical   | desktop  | mídia pendente não aparece e falha permite recuperação segura |
| SL-F008-E2E-004 | P1         | regression | matriz   | prévia expirada e cancelamento recuperam estado e foco        |
| SL-F008-E2E-005 | P1         | regression | desktop  | dimensões reservadas evitam salto na galeria privada          |
| SL-F008-E2E-006 | P0         | critical   | desktop  | dono A não lê nem obtém upload para o estúdio do dono B       |
| SL-F008-E2E-007 | P1         | regression | desktop  | hidratação fecha dados e resposta perdida não duplica comando |
| SL-F008-E2E-008 | P1         | regression | desktop  | conflito bloqueia ações até aceitar o estado autoritativo     |
| SL-F008-E2E-009 | P1         | regression | desktop  | sem JavaScript não há mídia nem controle privado no DOM       |
| SL-F008-E2E-010 | P1         | axe        | matriz   | teclado, foco, tema escuro e viewports passam acessibilidade  |
| SL-F008-E2E-011 | P2         | reflow     | 200%     | galeria, fila e lightbox permanecem operáveis sem overflow    |
| SL-F008-E2E-012 | P1         | regression | matriz   | conflito no upload exige estado salvo e reserva nova          |
| SL-F008-E2E-013 | P0         | critical   | desktop  | recusa do Storage libera a reserva antes de renovar           |

Os P0 atravessam a UI. Setup e limpeza usam apenas o Supabase local, dados com namespace QA,
locators semânticos, sem `waitForTimeout`, `.skip`, `.only` ou retry que esconda flakiness.

## Evidência antes de concluir

- unitários: envelopes estritos, formatos/decodificação e orquestração do cleanup;
- pgTAP: constraints, grants, RLS A/B, limite 20, liberação de reserva rejeitada, clone de revisão,
  idempotência, concorrência, claims e heartbeat do cleanup;
- Playwright: os treze cenários acima, incluindo mobile, teclado, axe e reflow;
- gates completos, review limpo no SHA, merge, migration, bucket e Function imutável em produção,
  canário HTTPS real da candidata, oneshot/timer de dez minutos na VM, ledger saudável e health público
  verde.

Após esse ciclo, os fatos duráveis são consolidados nos documentos de domínio e este plano transitório
é removido.
