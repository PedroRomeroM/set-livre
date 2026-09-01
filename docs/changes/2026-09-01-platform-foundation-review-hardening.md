# Hardening do review da base da plataforma

## Motivo

O review do PR #11 identificou três contratos incompletos no SHA `fed5dfd`: histórico mutável do
cleanup de mídia, assinatura de token de upload sem deadline e logout do backoffice acionável antes da
hidratação.

## Mudanças

- o cleanup persiste pertencimento e resultado por run em ledger privado imutável; abandono e conclusão
  derivam as contagens desse histórico;
- a assinatura privilegiada do token de upload possui deadline server-side de dois segundos e aborta a
  request ao Storage;
- o logout global permanece nativamente desabilitado até a hidratação;
- o job Linux recebe 75 minutos para concluir a suíte completa e os contratos de build/host, corrigindo
  o cancelamento observado depois de 45 minutos com os 323 testes de browser já verdes;
- contratos, schema gerado e documentação viva acompanham a migration head
  `20260901023051_preserve_studio_media_cleanup_run_membership`.

## Evidência exigida

- pgTAP comprova que um run abandonado conserva `1/0/1` depois que outro run reassume e conclui o mesmo
  item com `1/1/0`;
- unitário comprova deadline, aborto e limpeza do timer de assinatura;
- Playwright comprova que o logout sem JavaScript não despacha clique nem navegação;
- unitário fixa o orçamento do job Linux acima da duração medida da suíte completa;
- gates completos e novo Codex review precisam estar verdes no SHA publicado antes do merge.

## Rollback

Código e interface podem voltar para a release anterior pelo mecanismo de release imutável. A migration
é append-only: o ledger permanece instalado e compatível; eventual correção posterior deve ser uma nova
migration, nunca edição ou remoção da aplicada.
