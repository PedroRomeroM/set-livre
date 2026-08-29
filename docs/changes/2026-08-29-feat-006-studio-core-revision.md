# FEAT-006 — núcleo e revisões de estúdio

## Mudança

- adiciona `studio_types`, `studios`, `studio_revisions` e o ledger privado mínimo de idempotência,
  com hashes do payload e do resultado exato sem replicar conteúdo ou endereço;
- implementa criação, atualização/clone e descarte por três funções SQL privadas atômicas;
- revalida perfil, autoridade de dono e contrato vigente antes inclusive de replay; resultado antigo que
  já não pode ser reconstruído exatamente falha fechado;
- aplica grants mínimos, RLS por `auth.uid()`, imutabilidade e ponteiros/revisões canônicos;
- mantém tipo arquivado legível somente para o dono de uma revisão histórica, sem recolocá-lo na lista
  de escolhas ativas;
- adiciona read models estritos para tipos ativos e editor do próprio dono;
- entrega `/dono/estudios/novo` e `/dono/estudios/[studioId]/dados`, preview local, validação,
  conflito comparável, descarte confirmado e boundary integral de hidratação e sessão;
- torna criação aceita um estado terminal com navegação explícita, congela payloads de resultado
  ambíguo, recupera conflitos de descarte por releitura e mantém estúdio desabilitado somente leitura;
- adiciona `Textarea` à UI compartilhada e invalidação/cache privado por usuário + estúdio;
- habilita runner pgTAP efêmero sem bind mount no Windows e restaura artefatos Playwright em falhas.

## Operação e rollback

Antes do merge não há rollback externo: a branch pode ser descartada. Depois de aplicada, a migration
é append-only e não deve ser revertida manualmente; regressão exige nova migration corretiva e novo PR.
As superfícies ainda não são públicas e não alteram conteúdo já servido em produção até o deploy.
