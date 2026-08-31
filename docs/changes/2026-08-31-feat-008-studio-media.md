# FEAT-008 — Galeria privada do estúdio

## Estado

Em implementação na branch `codex/platform-foundation-batch`. Este registro acompanha somente a
quarta fatia vertical do lote de fundação e não antecipa publicação, catálogo público ou SEO.

## Mudança

- adicionar upload direto e privado de fotos para a revisão editável do estúdio;
- validar o arquivo no servidor antes de associá-lo à revisão;
- permitir capa, ordenação, exclusão e recuperação de conflito;
- manter RLS, grants e comandos privados como fronteiras independentes;
- remover objetos órfãos pela Storage API através de uma Edge Function imutável;
- invocar a limpeza a cada dez minutos por uma unit `systemd` da VM, sem `pg_net`, Cron ou Vault.

## Fonte canônica e operação

`studio_media` representa o objeto imutável e `studio_revision_media` representa a associação
versionada. A fila e o ledger de limpeza permanecem no banco; a Edge Function realiza somente o lote
autorizado pela Storage API. O runtime da VM agenda a invocação HTTPS usando a release ativa e o
segredo server-side já existente.

Previews assinadas entram na CSP somente pela origem Supabase exata. A chave moderna do cleanup trafega
apenas em `apikey`. A fronteira server-only da galeria usa diretamente o `StorageClient` dedicado para
impedir que o fallback de autenticação do cliente composto replique `sb_secret_...` em `Authorization`;
um teste comportamental intercepta o request real do adapter. O canário usa lock de sessão e recupera
checkpoints abandonados depois de 30 minutos, mas só os encerra após a Storage API comprovar ambos os
paths como `404/NoSuchKey`.

O Deno 2.9.5 que valida a Edge Function fica preso ao `package-lock.json` e integra o gate raiz de
typecheck nos runners Linux e Windows. O workflow não depende de Action externa e continua compatível
com a allowlist restrita do repositório.

## Evidência requerida antes do commit

- reset completo do Supabase local e tipos/schema regenerados;
- pgTAP para constraints, grants, RLS, idempotência, concorrência e cleanup;
- regressão de interrupção prova terminalização do run abandonado e restauração automática de
  readiness por sucesso posterior;
- unitários para contratos, DAL, imagem, Edge Function, release e invocador da VM;
- Playwright dos cenários `SL-F008-E2E-001` a `SL-F008-E2E-012`;
- lint, typecheck, documentação, build, audit, Knip e `git diff --check` verdes;
- auditoria manual do diff, dos secrets e do rollback.

## Rollback

Antes de haver dados produtivos dependentes, a aplicação pode retornar à release anterior por symlink.
A migration é forward-only: registros novos ficam inacessíveis à release anterior e a fila de limpeza
permanece preservada para processamento posterior; nenhum rollback apaga objetos diretamente no
schema interno do Storage.
