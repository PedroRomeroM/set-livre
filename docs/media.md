# Mídia, qualidade visual e Storage

## 1. Objetivo

Fotos precisam preservar qualidade suficiente para decisão de compra sem transferir originais indiscriminadamente. Vídeo será incorporado via YouTube.

## 2. Limites

Defaults:

- 1 a 20 fotos por revisão;
- máximo 15 MB por original;
- JPEG, PNG, WebP ou AVIF;
- sem SVG, GIF, HEIC ou vídeo próprio;
- largura/altura mínimas recomendadas: 1.200 px no lado maior;
- limite técnico de 12.000 px por dimensão;
- uma capa obrigatória;
- alt text derivado do nome/posição, editável se produto decidir.

Arquivos fora do contrato são rejeitados antes da publicação.

## 3. Buckets

### 3.1 `studio-media`

Bucket privado.

Path:

```text
owners/<ownerId>/studios/<studioId>/revisions/<revisionId>/<mediaId>.<ext>
```

Nenhum ID de usuário enviado pelo cliente é aceito sem derivação server-side.

### 3.2 Visibilidade

- draft/pending: URLs assinadas e curtas para owner/reviewer;
- approved/published: delivery controlado pela aplicação/CDN;
- superseded: acessível apenas quando necessário à auditoria/revisão;
- deleted/orphan: job remove.

## 4. Upload

1. UI lê arquivo e valida extensão/tamanho como feedback.
2. `studio.media.upload.prepare` valida sessão, ownership, revisão draft e limite.
3. Servidor cria media row `uploaded` e signed URL.
4. Browser envia direto ao Storage.
5. `studio.media.upload.finalize` verifica objeto real.
6. Servidor decodifica header/metadados, MIME, tamanho, dimensão e checksum.
7. Media vira `ready`.
8. UI invalida editor.

Não passar binário pela VM.

## 5. Qualidade e otimização

- original é preservado;
- cards e galeria usam `next/image`;
- `sizes` explícito por composição;
- `quality` por caso, sem 100 por padrão;
- preload somente da imagem LCP;
- dimensões evitam CLS;
- lazy load nas demais;
- cache imutável quando path inclui media ID/hash;
- não gerar dezenas de variantes antecipadamente;
- transformação paga do Supabase não é dependência obrigatória;
- medir egress e cache hit.

O artifact Linux x86_64 precisa incluir qualquer dependência nativa realmente usada por `next/image` e
ser validado no build/smoke de produção.

## 6. Ordenação e capa

Comando transacional recebe lista completa de IDs pertencentes à revisão.

Regras:

- sem duplicados;
- mesmo conjunto atual;
- posições contínuas;
- no máximo uma capa;
- excluir capa exige selecionar outra antes de submit;
- optimistic UI reverte em erro.

## 7. Exclusão

- draft sem uso: remover row e objeto;
- revisão submetida: mídia imutável;
- para mudar, criar/editar nova revisão;
- cleanup de upload não finalizado após 24h;
- falha de Storage gera retry e alerta, não row fantasma.

## 8. YouTube

Aceitar URL e extrair ID de formatos permitidos. Persistir apenas `youtube_video_id`.

- validar host/ID;
- embed com domínio de privacidade aprimorada quando possível;
- lazy load;
- título acessível;
- sem autoplay;
- erro mostra fallback e link seguro;
- nenhum HTML arbitrário.

## 9. Moderação

Reviewer visualiza:

- original/preview;
- ordem/capa;
- metadados;
- conteúdo completo.

Rejeição da revisão inclui motivo. Não existe rejeição isolada que altere revisão submetida; owner corrige em nova draft.

## 10. Testes

- tipo/tamanho inválido;
- MIME spoof;
- path/ownership;
- limite 20;
- duas capas;
- reorder concorrente;
- upload órfão;
- mídia pending não pública;
- mídia approved pública;
- LCP sem layout shift;
- gallery keyboard/mobile;
- YouTube inválido.
