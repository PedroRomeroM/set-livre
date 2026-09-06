# ADR-019 — Entrega cloud controlada

## Status

Aceito em 2026-08-24, consolidando autorizações humanas anteriores.
Separação de preflight estrutural e saúde operacional, com recuperação inicial limitada, aprovada
explicitamente em 2026-09-06 (OPEN-007).

## Contexto

O ADR-018 suspendeu CI e cloud durante a fundação local. O responsável posteriormente autorizou
GitHub Actions, Supabase Cloud, Oracle Cloud e TLS. Existem um projeto Supabase de produção em São
Paulo, uma VM Oracle dedicada e o domínio `setlivre.com`. O domínio foi adquirido, mas seu apontamento
foi deliberadamente adiado até o go-live; pagamento, SMTP e outros providers continuam bloqueados por
decisões próprias.

A primeira implementação dessa liberação concentrou infraestrutura, review e deploy em frameworks
customizados. A complexidade não era proporcional ao estágio do produto.

## Decisão

- este ADR substitui a suspensão de CI, Supabase Cloud, Oracle e TLS do ADR-018; DNS está autorizado,
  mas sua ativação permanece adiada por decisão posterior do responsável;
- Supabase local continua sendo o único ambiente de desenvolvimento e de testes destrutivos;
- `main` é a única origem de produção; não haverá Supabase Branching nesta fase;
- como o projeto cloud estava vazio, a cadeia local de construção foi consolidada uma única vez na
  baseline inicial antes do primeiro deploy; depois dele toda migration é imutável e forward-only;
- pull requests executam gates sem secrets de produção;
- merge em `main` produz um artifact Linux x86_64 identificado pelo SHA completo;
- GitHub Actions envia o artifact à conta SSH exclusiva de deploy, que só pode executar o instalador
  root allowlisted por um comando SSH forçado;
- migrations de produção são forward-only e executadas antes da ativação do novo runtime;
- a publicação reúne artifact, ambientes e identidade do SHA em uma release imutável, cercada pelo
  digest do host; um único symlink, health interno/público, retenção limitada e marcador recuperável
  controlam ativação e rollback;
- a árvore staged persiste um digest de todos os seus demais bytes e o recalcula imediatamente antes da
  ativação; um digest separado e não secreto vincula os dois ambientes ao contrato corrente. Retry do
  mesmo SHA só reutiliza a release quando ambos continuam idênticos, em vez de recompilar;
- o preflight anterior às migrations recalcula o digest dos arquivos operacionais instalados, autentica
  o binário Node, o site/link Nginx ativo e as units carregadas, rejeitando fragmento, drop-in, reload ou
  enablement divergente;
- uploads ficam serializados e limitados aos três arquivos de um SHA; cancelamento remove o candidato
  anterior na próxima conexão, sem retenção indefinida no disco;
- uma path unit aguarda o lock e recupera `SIGKILL`; o bootstrap recalcula a árvore completa antes de
  reutilizar a release ativa, interrompe release incompatível antes de mutar o host e só a release do
  novo digest volta a iniciar os apps;
- ativação e recuperação do runtime de banco são fail-closed e seguem o contrato operacional em
  [infrastructure.md, Banco de produção](../infrastructure.md#banco-de-producao); rotação implícita
  permanece fora do deploy normal;
- o preflight anterior às migrations comprova a estrutura do head remoto, as permissões e a identidade
  real da conexão, sem exigir saúde da rotina que o próprio deploy precisa reparar. O helper estrutural
  é exclusivo da administração; readiness dos aplicativos e ativação continuam exigindo também cleanup
  saudável. A separação não libera grants, RLS, credenciais inválidas ou drift estrutural;
- o startup packet do cliente não é autoridade para a role efetiva porque o Supavisor pode não
  encaminhar opções arbitrárias. Uma migration append-only fixa o setting não secreto `role=app_dal`
  para `app_runtime_production` somente no database `postgres`, e o readiness valida a configuração e
  a sessão real antes da ativação;
- objetos internos do Supabase permanecem sob a identidade gerenciada `supabase_admin`, que não pode
  ser assumida pelo `postgres` do projeto. A produção não armazena segredo em GUC de role/database e
  o readiness falha se catálogos efetivamente legíveis contiverem configuração com nome sensível;
- `pg_net`, Cron e Vault não pertencem à baseline das aplicações. A FEAT-008 usa a Edge Function para
  remover objetos e o timer `systemd` já controlado da VM apenas para invocá-la. Se `anon`,
  `authenticated`, `app_dal` ou o login de produção alcançar `maintenance`, ou qualquer role da
  aplicação alcançar `net`, o provisionamento falha antes de habilitar o login e o health existente
  fica indisponível; `service_role` recebe somente execução nas fachadas RPC estreitas do cleanup;
- `CREATE/TEMP` direto no database para DAL ou login de produção também invalida essa fronteira;
- branch protection, checks do GitHub e o ciclo documentado de review são a autoridade de merge;
- depois da revisão limpa, o agente publica o status `Codex review contract` no SHA exato, apontando
  para a evidência; a branch protection exige esse status e qualquer push o invalida;
- um control plane próprio de review só poderá ser reconsiderado depois de uma limitação concreta,
  recorrente e medida dos mecanismos nativos;
- o agente pull anterior, suas credenciais no host, identidades, units e ferramentas próprias são
  retirados uma única vez pela administração; o bootstrap definitivo apenas prova sua ausência e falha
  fechado se essa superfície reaparecer, sem carregar código permanente de migração;
- secrets permanecem no ambiente que os consome e nunca entram em workflow de PR, artifact, log ou
  documentação;
- deploy permanece desabilitado durante o bootstrap e só é ativado quando certificado, credenciais,
  gates e review estiverem prontos, imediatamente antes do merge aprovado; o health posterior ao
  merge comprova o primeiro ciclo completo.

### Recuperação inicial do cleanup

A primeira migration dessa separação não consegue desbloquear o preflight antigo que impede sua
própria aplicação. A autorização de 2026-09-06 permite, somente para essa transição, publicar primeiro
a Function corrigida a partir do SHA de `main` aprovado pelo ciclo completo, compatível com o schema
já aplicado, e executar o canário real. Somente após comprovar o ledger saudável o workflow normal
retoma, aplica a migration append-only e valida a ativação. O procedimento está no runbook de
[infraestrutura](../infrastructure.md#recuperação-inicial-do-cleanup).

A seleção da query administrativa acompanha a versão realmente aplicada: antes de `20260906051637`,
o preflight usa o readiness completo legado, pois o helper estrutural ainda não existe; a partir desse
marco, exige `private.check_deployment_structure(text)`. A seleção ocorre antes de preparar a query,
sem capturar erro de função ausente para tentar outra verificação. Essa compatibilidade de migração
não dispensa o cleanup na primeira recuperação nem aceita helper ausente em schema novo.

Não há flag permanente para ignorar preflight, alteração manual do banco, fabricação de checkpoint ou
publicação de código não revisado. Falha em qualquer prova interrompe a recuperação; autorização não
equivale a execução concluída.

## Alternativas

- continuar somente local: rejeitado porque a infraestrutura foi explicitamente liberada;
- customizar uma plataforma de CI/review/deploy: rejeitado por custo cognitivo e operacional;
- executar código de PR na VM: rejeitado por segurança;
- deploy in-place: rejeitado por rollback frágil.
- tentar alterar ACLs pertencentes a `supabase_admin`: rejeitado porque o Cloud gerenciado não concede
  essa identidade ao projeto; um `REVOKE` sem grant option apenas emite warning e não endurece nada.

## Consequências

- CI e publicação usam serviços já adotados, com pouco código próprio;
- a VM precisa somente de OpenSSH e do instalador de release; não existe agente próprio;
- falha de provider continua inconclusiva e fail-closed, mas não exige modelar antecipadamente todos
  os estados imagináveis;
- pagamento, SMTP, conteúdo jurídico final e outros bloqueios permanecem em `pendencias.md`.
