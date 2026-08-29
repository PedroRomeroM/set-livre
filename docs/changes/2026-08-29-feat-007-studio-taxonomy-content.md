# FEAT-007 — Taxonomias e conteúdo do estúdio

## Contrato da mudança

- criar tags e comodidades iniciais, expondo somente itens ativos para novas escolhas e preservando,
  sob ownership, referências históricas que forem arquivadas depois;
- versionar seleções, regras de uso, FAQ ordenada e somente o ID validado de vídeo do YouTube;
- salvar taxonomia e conteúdo por comandos atômicos, idempotentes e com concorrência otimista;
- preservar integralmente a revisão publicada ao iniciar uma nova draft;
- oferecer busca local acessível, ordenação por botões, prévia segura e recuperação de conflito;
- sincronizar toda a composição com a revisão publicada quando um rascunho for descartado, sem apagar
  valores locais em refetches comuns;
- comprovar limites, ownership, taxonomia ativa, escape de texto e URLs permitidas em SQL, unitários e Playwright.

## Correções da auditoria local

- um replay retorna somente o resultado exato cujo hash foi registrado; se arquivamento ou alteração
  posterior impedir sua reconstrução sem guardar conteúdo privado no ledger, o comando falha fechado
  como conflito, enquanto a validação de catálogo ativo continua obrigatória para uma solicitação nova;
- os itens ativos selecionados recebem lock compartilhado até o commit e o helper interno
  `security definer` não concede execução a nenhum papel de runtime;
- descartar um rascunho publicado reinicializa explicitamente o painel comercial com a revisão
  aprovada, impedindo que estado React da revisão removida seja salvo de volta por engano; o painel
  central permanece montado para conservar a confirmação visível do descarte concluído;
- os painéis central e comercial propagam entre si somente revisões confirmadas por mutação. Isso
  permite sequenciar saves e descarte sem falso conflito, preserva valores ainda não submetidos no
  painel irmão e não transforma refetch de fundo em rebase silencioso; cada confirmação própria
  avança o token global das três superfícies e do descarte, enquanto rebase causado por estado externo
  continua exigindo comparação e escolha explícitas;
- a regressão `SL-F007-E2E-008` comprova o handoff nas duas direções e então recria o descarte
  completo, com tags, regras e FAQ retornando juntas ao conteúdo publicado antes de qualquer novo
  save;
- o painel comercial agora permanece oculto até a releitura autoritativa de editor e catálogo, fecha
  seu observador antes de um descarte terminal e bloqueia novos comandos enquanto uma resposta
  ambígua só pode ser repetida com a mesma chave idempotente;
- a regressão `SL-F007-E2E-009` prova que uma troca de sessão remove inclusive conteúdo comercial
  local ainda não salvo antes de qualquer resposta privada da sessão anterior;
- a regressão `SL-F007-E2E-010` prova que uma resposta perdida congela os dois formulários e que o
  retry reutiliza byte a byte o comando idempotente original;
- a regressão `SL-F007-E2E-011` prova que um refetch não troca silenciosamente a versão otimista dos
  valores locais: o primeiro save conflita e o rebase só ocorre após aviso explícito;
- as recuperações fail-closed do editor central e do conteúdo comercial possuem nomes acessíveis
  distintos, para que dois painéis indisponíveis nunca produzam controles ambíguos;
- a metadata da rota descreve a composição real de dados centrais e conteúdo comercial, sem manter a
  descrição incompleta da FEAT-006.
