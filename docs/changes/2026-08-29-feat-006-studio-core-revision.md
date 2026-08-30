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
- revalida sessão, conta, perfil, autoridade de dono e contrato também durante a criação: enquanto a
  releitura está pendente o formulário fica oculto, o mesmo escopo elegível preserva o rascunho local
  e qualquer revogação limpa o boundary antes de recompor a rota;
- torna criação aceita um estado terminal com navegação explícita, congela payloads de resultado
  ambíguo, recupera conflitos de descarte por releitura e mantém estúdio desabilitado somente leitura;
- mantém tokens otimistas independentes para edição e descarte mesmo após refetch; update só adota o
  token remoto após escolha explícita na comparação, e conflito de descarte avança apenas seu próprio
  token, exigindo nova confirmação sem liberar save stale;
- só aceita uma releitura de conflito quando o GET termina com sucesso, preserva o estado pendente
  após falha transitória e sincroniza update/descarte no retry manual sem usar dados stale do cache;
- revalida conta, perfil, autoridade de dono e contrato em cada GET do editor; uma revogação recompõe
  a rota SSR, e descarte concluído elimina o redirect one-shot e mantém uma `ButtonLink` nativa para
  navegação explícita e repetível;
- classifica `studio_type_inactive` sem expor detalhe SQL, relê a taxonomia e exige uma seleção ativa
  tanto na criação quanto na edição quando o tipo é arquivado durante o preenchimento;
- adiciona `Textarea` à UI compartilhada e invalidação/cache privado por usuário + estúdio;
- habilita runner pgTAP efêmero sem bind mount no Windows e restaura artefatos Playwright em falhas;
- faz o preflight global E2E rejeitar identidades QA residuais, preserva a validação do marcador
  local durante limpezas em andamento e amplia apenas o bucket de rede do login em `APP_ENV=test`,
  sem alterar os limites por identidade ou de produção.

## Operação e rollback

Antes do merge não há rollback externo: a branch pode ser descartada. Depois de aplicada, a migration
é append-only e não deve ser revertida manualmente; regressão exige nova migration corretiva e novo PR.
As superfícies ainda não são públicas e não alteram conteúdo já servido em produção até o deploy.

## Correções de review da FEAT-031

- o diretório administrativo deixa de devolver nome bruto; PII completa continua exclusivamente no
  reveal temporário, motivado e auditado;
- suspensão e restauração tornam-se comandos explícitos, e o banco deriva a transição sem aceitar
  status de destino do navegador;
- sessão e papéis são relidos no mount, foco, intervalo e eventos entre abas; divergência fecha o DOM
  privado, limpa o cache e recompõe a rota;
- conflitos otimistas de conta, papel e taxonomia removem o alvo obsoleto, relêem o estado canônico e
  exigem nova confirmação;
- criação de taxonomia é serializada e limitada a 500 itens combinados, sem bloquear atualização de
  itens existentes;
- a origem de produção do backoffice passa a refletir a fronteira realmente implantada: loopback
  `127.0.0.1:3001` acessado por túnel SSH, sem domínio ou proxy público inexistente.
- os pools DAL/readiness passam a ser únicos por processo mesmo entre bundles do Next; o orçamento
  explícito de `2 + 1 + 2 + 1 = 6` preserva quatro conexões do limite dez e elimina a saturação vista
  somente na suíte Playwright longa.
