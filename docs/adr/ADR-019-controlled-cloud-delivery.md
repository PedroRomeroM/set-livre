# ADR-019 — Entrega cloud controlada

## Status

Aceito em 2026-08-24, consolidando autorizações humanas anteriores.

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
- a publicação usa release imutável, configuração de host cercada por digest, ambientes sincronizados,
  symlink atômico, health interno/público, retenção limitada e rollback da aplicação + ambientes;
- branch protection, checks do GitHub e o ciclo documentado de review são a autoridade de merge;
- depois da revisão limpa, o agente publica o status `Codex review contract` no SHA exato, apontando
  para a evidência; a branch protection exige esse status e qualquer push o invalida;
- um control plane próprio de review só poderá ser reconsiderado depois de uma limitação concreta,
  recorrente e medida dos mecanismos nativos;
- secrets permanecem no ambiente que os consome e nunca entram em workflow de PR, artifact, log ou
  documentação;
- deploy permanece desabilitado durante o bootstrap e só é ativado quando certificado, credenciais,
  gates e review estiverem prontos, imediatamente antes do merge aprovado; o health posterior ao
  merge comprova o primeiro ciclo completo.

## Alternativas

- continuar somente local: rejeitado porque a infraestrutura foi explicitamente liberada;
- customizar uma plataforma de CI/review/deploy: rejeitado por custo cognitivo e operacional;
- executar código de PR na VM: rejeitado por segurança;
- deploy in-place: rejeitado por rollback frágil.

## Consequências

- CI e publicação usam serviços já adotados, com pouco código próprio;
- a VM precisa somente de OpenSSH e do instalador de release; não existe agente próprio;
- falha de provider continua inconclusiva e fail-closed, mas não exige modelar antecipadamente todos
  os estados imagináveis;
- pagamento, SMTP, conteúdo jurídico final e outros bloqueios permanecem em `pendencias.md`.
