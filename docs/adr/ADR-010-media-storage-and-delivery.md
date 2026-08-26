# ADR-010 — Mídia de estúdios

## Status

Aceito.

## Contexto

Fotos são decisivas para conversão, mas upload irrestrito compromete custo, segurança e performance.

## Decisão

Guardar originais no Supabase Storage em bucket privado. Upload usa URL assinada, validação de metadados e comando de finalização.

A aplicação:

- aceita JPEG, PNG, WebP e AVIF;
- rejeita SVG, GIF e conteúdo incompatível;
- guarda dimensões, MIME, tamanho e checksum;
- usa Next Image e cache HTTP para entrega responsiva;
- preserva original;
- não depende obrigatoriamente de transformação paga do Storage;
- usa vídeo apenas por URL YouTube validada.

## Alternativas

- upload pela VM: rejeitado.
- vídeo próprio: rejeitado.
- bucket público sem media record: rejeitado.
- compressão destrutiva única: rejeitada.

## Consequências

- delivery precisa considerar egress/otimização;
- imagem só vira pública quando revisão é aprovada;
- cleanup remove uploads órfãos.
