# Mídia, qualidade visual e Storage

## Contrato de fotos

O editor aceita de zero a vinte fotos por revisão. Submissão futura exige ao menos uma foto e uma capa;
a edição não antecipa essa validação. Cada original pode ter até 15 MiB, 8.192 px por dimensão e 36
milhões de pixels no total. Os formatos permitidos são JPEG, PNG, WebP e AVIF; SVG, GIF, HEIC e vídeo
próprio são recusados.

O original é preservado. A aplicação registra MIME comprovado, bytes, dimensões e SHA-256 e gera uma
prévia privada WebP auto-orientada de até 1.280 px e 3 MiB. A galeria usa essa derivada com dimensões
explícitas para evitar layout shift e não depende de transformação paga do Storage.

## Fonte canônica e versionamento

- `studio_media` representa o objeto imutável e seu ciclo
  `pending_upload → ready/rejected → delete_pending → deleted`;
- `studio_revision_media` associa objetos a uma revisão, com posição contínua e no máximo uma capa;
- ao clonar uma revisão publicada para novo rascunho, as associações compartilham os mesmos objetos;
  por isso os paths imutáveis conservam o ID da revisão em que o objeto nasceu, enquanto a associação
  prova a revisão atual;
- alterar ou excluir no rascunho nunca remove a foto ainda referenciada pela revisão publicada;
- exclusão física só é elegível quando nenhuma associação permanece.

O bucket `studio-media` é privado e limita tamanho/MIME. O path é sempre derivado no servidor:

```text
owners/<ownerId>/studios/<studioId>/revisions/<revisionId>/<mediaId>.<ext>
owners/<ownerId>/studios/<studioId>/revisions/<revisionId>/<mediaId>.preview.webp
```

IDs enviados pelo cliente não provam ownership. O read model atual é exclusivo do próprio dono
elegível, lê os paths por uma função privada do DAL e usa a secret key somente no servidor para devolver
URLs assinadas curtas. O browser não recebe `storagePath`, grants de leitura dos registros ou permissão
para assinar objetos. Reviewer e entrega pública serão adicionados somente pelas features que os
consomem.

## Upload e verificação

1. A UI faz somente feedback imediato de tipo, tamanho e limite.
2. `studio.media.upload.prepare` valida sessão, dono, revisão/versionamento e idempotência, cria
   `pending_upload` e emite token assinado sem sobrescrita.
3. O browser envia o original diretamente ao Storage, com deadline de 60 segundos; o upload não
   atravessa a VM. Essa etapa usa o cliente oficial dedicado de Storage com a chave pública e o token
   assinado, sem criar outro cliente Auth nem persistir sessão no navegador.
4. `studio.media.upload.finalize` tenta primeiro o replay exato; somente uma tentativa ainda pendente
   obtém do Storage uma cópia limitada para verificação autoritativa.
5. O servidor compara tamanho declarado, assinatura de bytes, MIME decodificado, página única,
   dimensões, orçamento total de pixels e checksum opcional; um decode mínimo prova que o conteúdo não
   é apenas um header. Download, decode e geração da prévia compartilham um único slot global, fila
   limitada e um deadline absoluto server-side de 15 segundos. O mesmo `AbortSignal` interrompe o
   download e o tempo restante limita o Sharp, preservando a VM de 1 GiB sem liberar o slot antes do
   trabalho subjacente terminar.
6. Arquivo válido produz a prévia WebP privada; retry aceita uma derivada preexistente somente quando
   os bytes são exatamente iguais.
7. O objeto vira `ready` e é associado à revisão na mesma transação. Arquivo inválido vira `rejected`
   com `validation_failed`; ausência comprovada no Storage vira `object_missing`. Ambos liberam a cota
   imediatamente, sem expor detalhe interno do decoder.
8. O retorno autoritativo substitui a galeria privada e invalida o editor relacionado.

O download de verificação é bounded e não transforma a VM em proxy de upload. Erro de rede ou resposta
ambígua exige releitura antes de retry; a UI reutiliza a mesma idempotência quando repete a mesma etapa
e continua com os arquivos seguintes quando a falha atual é definitiva e isolada. Mesmo quando a
Storage API recusa diretamente o upload, a UI pede ao servidor que verifique o objeto antes de oferecer
renovação. Expiração ou ausência comprovada encerram a reserva antiga no banco: ela deixa de consumir a
cota, entra no cleanup e só então a recuperação cria outra idempotência, mídia, path e token, sem tentar
reviver uma autorização vencida.

Toda conclusão de mutação relê a galeria canônica. O DTO inclui o número imutável da revisão e sua
versão; uma resposta atrasada de revisão ou versão anterior é descartada e identidades contraditórias
para o mesmo número falham fechado.

## Capa, ordem e exclusão

Reordenação recebe o conjunto completo de IDs da revisão, sem repetição, e grava posições contínuas sob
lock e versão otimista. Capa e exclusão obedecem à mesma fronteira. A interface oferece botões de ordem
usáveis por teclado e touch; drag não é requisito para concluir a ação.

Excluir a capa é permitido somente quando isso não produz uma transição enganosa; a obrigatoriedade de
capa é revalidada na submissão. Resultado conflitante recompõe a versão remota em vez de manter
otimismo local.

## Cleanup físico

Upload não finalizado fica elegível após 24 horas. Rejeição e objeto sem associação ficam elegíveis
imediatamente. Uma Edge Function:

- autentica a secret key recebida em `apikey` com comparação em tempo constante;
- envia a chave moderna apenas em `apikey`; ela nunca é tratada como JWT em `Authorization`;
- usa a secret key padrão fornecida pelo próprio runtime Supabase; browser nunca a recebe e o processo
  web da VM a usa somente em sua fronteira server-only separada;
- chama RPCs públicos concedidos apenas a `service_role`, que delegam a rotinas de manutenção;
- reivindica até 25 itens com token, `SKIP LOCKED`, lease e replay;
- remove original e prévia somente pela Storage API;
- conclui sucesso ou agenda backoff limitado em falha.

Cada release publica `media-cleanup-<SHA>` sem sobrescrever a versão anterior. Um canário cria um par
real de objetos, invoca a candidata diretamente por HTTPS e exige HTTP 200, remoção física e ledger
terminal com contagens fechadas. Só depois a VM ativa a release: uma oneshot `systemd` chama o slug
derivado do SHA ativo e, se ela passar, o timer repete a execução a cada dez minutos. Falha da oneshot
aciona o rollback atômico da aplicação; sucesso conserva no máximo quatro Functions imutáveis,
preservando candidata e versão anunciada pelo health vivo. Não há Cron, `pg_net`, Vault, daemon ou
container adicional. Roles da aplicação continuam sem acesso a `net` ou `maintenance`; `service_role`
executa somente as fachadas RPC estreitas. Readiness reprova execução travada ou falha sem recuperação
posterior. Também reprova quando nenhum sucesso terminal foi registrado nos últimos 30 minutos, mesmo
que a falha aconteça antes de o worker abrir uma linha nova no ledger. Deploy, recovery e rollback
executam uma oneshot antes dos health checks e só então reativam o timer. Objetos do Storage nunca são
apagados por SQL direto.

O configurador serializa o canário por advisory lock de sessão. Antes de criar uma nova identidade,
ele recupera probes `prepared` ou `queued` sem atualização há 30 minutos: remove os dois paths pela
Storage API, exige para cada download `404` com código `NoSuchKey` e só então registra `aborted` com
código allowlisted. `400`, outro código de `404`, resposta ambígua ou interrupção deixam o checkpoint
não terminal para uma tentativa posterior; assim uma queda entre banco, upload e finalização não
transforma objeto órfão em sucesso documental.

Uma interrupção depois de abrir o ledger não exige reparo manual: a primeira execução posterior fecha
um run diferente envelhecido como `cleanup_run_abandoned`, reaproveita leases vencidos pelo claim
normal e só devolve readiness depois de registrar um sucesso mais recente. O UUID original continua
idempotente se o mesmo invocador conseguir repeti-lo antes dessa recuperação.

## Entrega e qualidade visual

- previews privadas são assinadas em lote por cinco minutos, usam cache privado de 60 segundos e a
  origem Supabase HTTPS exata — ou o loopback local canônico — é a única origem remota admitida pela CSP
  tanto em `img-src` quanto em `connect-src`,
  `next/image`, `sizes` por composição e dimensões persistidas; o DTO carrega a expiração e o cache
  preserva a assinatura mais recente quando respostas da mesma revisão chegam fora de ordem;
- a capa futura pode receber prioridade somente quando for realmente LCP;
- demais imagens permanecem lazy;
- path imutável admite cache do objeto, mas URL assinada e resposta autenticada não entram em cache
  público;
- galeria e lightbox preservam 320 px, zoom de 200%, safe areas, teclado e retorno de foco;
- dependência nativa de imagem precisa existir no artifact Linux x86_64 e passar no smoke da release.

## YouTube

FEAT-007 persiste somente o ID de 11 caracteres. A entrada aceita ID ou URL HTTPS exata dos hosts e
paths allowlisted; userinfo, HTTP, sufixos de host e caminhos extras falham. O embed usa
`https://www.youtube-nocookie.com/embed/<id>`, título acessível, sandbox limitado, sem autoplay e
com link de recuperação. HTML arbitrário nunca é aceito.

## Evidência

A cobertura proporcional inclui contratos/decodificação em Vitest; grants, RLS A/B, constraints,
idempotência, concorrência real, clone, limite e cleanup em pgTAP; e upload, spoof, ownership,
respostas perdidas antes/depois da persistência, capa/ordem, mobile, teclado, axe, reflow e estabilidade
visual em Playwright. Testes destrutivos usam exclusivamente o Supabase local.
