# ADR-010 — Mídia de estúdios

## Status

Aceito; detalhado para a implementação da FEAT-008 em 2026-08-31.

## Contexto

Fotos são decisivas para a escolha do estúdio, mas upload irrestrito compromete segurança, custo e
performance. Uma revisão publicada também não pode perder mídia quando o dono abre um novo rascunho.
Objetos abandonados precisam ser removidos pela Storage API, porque manipular o schema interno do
Storage por SQL deixa banco e objeto divergentes.

## Decisão

- originais ficam no bucket privado `studio-media`;
- upload usa token assinado, path derivado e envio direto do browser, sem proxy da VM;
- a VM baixa uma cópia limitada somente na finalização para validar assinatura, MIME decodificado,
  tamanho, página única, dimensões, teto de pixels e SHA-256, sob processamento single-flight;
- `studio_media` representa o objeto imutável e `studio_revision_media` a associação versionada;
- previews do dono usam URLs assinadas curtas geradas no servidor após leitura DAL privada. Paths e
  permissão de assinatura não chegam ao browser. Reviewer e delivery público só entram com suas
  features;
- JPEG, PNG, WebP e AVIF são permitidos; SVG, GIF, conteúdo incompatível e overwrite são recusados;
- originais são preservados e a aplicação não depende de transformação paga do Storage;
- vídeo próprio permanece rejeitado; vídeo comercial usa apenas ID YouTube validado;
- órfãos e deleções físicas são processados por uma Edge Function pequena, autenticada por secret key,
  que chama RPCs concedidos somente a `service_role` e remove paths pela Storage API;
- a release web inclui um invocador Node mínimo. Uma oneshot `systemd`, executada como `setlivre-web`,
  chama por HTTPS somente `media-cleanup-<SHA-da-release-ativa>` com a secret key do EnvironmentFile
  já necessário ao servidor; um timer existente no host agenda essa oneshot a cada dez minutos;
- banco e runtime não habilitam Cron, `pg_net` ou Vault para esse fluxo. `anon`, `authenticated`,
  `app_dal` e o login da aplicação não alcançam `maintenance`; `service_role` executa somente quatro
  fachadas RPC públicas e estreitas;
- claim com lease, `SKIP LOCKED`, replay e backoff torna a limpeza repetível sem daemon, container ou
  processo residente adicional na VM.

O ADR-019 permanece sem exceção: `pg_net` não pertence à baseline. O deploy publica a Function
imutável, invoca a candidata diretamente por HTTPS com objetos descartáveis reais e só então ativa a
release cujo SHA determina o slug periódico. A ativação executa a oneshot uma vez antes de iniciar o
timer. O ledger fecha as contagens; falha da candidata impede a ativação e falha da oneshot aciona o
rollback já existente da release.

## Alternativas

- upload ou cleanup físico pela VM: rejeitado por tráfego e por acoplar Storage ao host. A VM apenas
  dispara a Function; a secret key no runtime web também permanece restrita às operações server-only
  de upload, leitura e verificação autorizadas pelo DAL e nunca chega ao browser;
- apagar linhas do schema Storage: rejeitado pelo contrato oficial do provider;
- bucket público sem registro canônico: rejeitado por privacidade e perda de versionamento;
- copiar o objeto a cada nova revisão: rejeitado por custo e risco de divergência;
- cleanup síncrono como única defesa: rejeitado porque browser fechado deixa upload pendente;
- Supabase Cron/`pg_net`/Vault: rejeitado porque adiciona três superfícies gerenciadas e uma exceção de
  privilégio sem benefício sobre o timer já operado e autenticado da única VM;
- scheduler próprio, daemon ou container permanente: rejeitado; a unit `systemd` reaproveita o
  supervisor, a identidade e o rollback já obrigatórios no host;
- publicar a função com chave pública: rejeitado porque permitiria invocação abusiva mesmo com operação
  idempotente.

## Consequências

- a release inclui `sharp` como dependência direta e comprova o binário Linux x86_64;
- deploy publica migration e Edge Function antes da ativação e só conclui depois do canário direto,
  health da release, oneshot inicial e timer ativo;
- não há novo secret humano: o workflow obtém a secret key moderna padrão pela Management API usando o
  access token já restrito ao ambiente de produção, mascara-a e a publica somente no EnvironmentFile
  do web; a Function recebe a mesma chave pelo ambiente gerenciado do próprio Supabase. Backoffice,
  artifact, logs e outputs não a recebem;
- retenção preserva a candidata e o SHA anunciado pelo health vivo, mantendo no máximo quatro versões
  imutáveis da Function;
- falha de Storage preserva o estado `delete_pending` e agenda retry, sem row fantasma;
- run interrompido é terminalizado automaticamente depois de 30 minutos pela próxima execução, com
  leases vencidos novamente elegíveis e readiness restaurada somente por sucesso posterior;
- canário interrompido preserva seu checkpoint; depois de 30 minutos o configurador serializado remove
  os dois paths, comprova `404/NoSuchKey` e só então o terminaliza como abortado, sem aceitar `400` como
  evidência de ausência;
- observabilidade usa contagens e códigos allowlisted, nunca path, chave ou payload do provider;
- egress, duração do cleanup e pressão da VM precisam ser medidos antes de ampliar limites.
