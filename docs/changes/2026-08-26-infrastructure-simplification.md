# Mudança: simplificação da infraestrutura e entrega controlada

- Data: 2026-08-26
- Autor/agente: Codex
- Features: fundação transversal, sem nova feature de produto
- ADRs: ADR-001, ADR-014, ADR-019, ADR-020, ADR-021 e ADR-022
- Risco: alto — baseline única do banco, CI obrigatório e deploy de produção
- Rollback: releases web voltam pelo symlink atômico; migrations são forward-only e exigem expand/contract

## Resumo

Consolida a fundação operacional, remove automação e documentação históricas que não pertenciam ao
estado operacional, estabelece o ciclo obrigatório de review e define a entrega da `main` ao Supabase
Cloud e à VM Oracle `VM.Standard.E2.1.Micro`.

## Motivo

O bootstrap anterior acumulou scripts, evidências transitórias e contratos sobrepostos. A mudança reduz
a superfície rastreada, preserva somente automação executável e deixa PR, checks, deployment e logs como
fontes de evidência por execução.

## Contratos resultantes

- CI Linux e Windows executa gates completos antes de permitir merge;
- produção aplica migrations forward-only e publica releases standalone imutáveis por SHA;
- artifact e ambientes do mesmo SHA são ativados por um único symlink, com rollback e recuperação no boot;
- a configuração instalada na VM é vinculada a um digest determinístico e falha fechada quando diverge;
- o site permanece em HTTPS pelo IP `147.15.97.227`, com indexação bloqueada e DNS adiado.

## Arquivos/componentes

As mudanças concentram-se em `.github/workflows/ci.yml`, `ops/`, `scripts/`, configuração do Supabase,
documentação canônica e remoção dos artefatos redundantes identificados na auditoria de organização.

## Banco, migration, grants e RLS

A produção vazia recebe somente `20260824000100_initial_production_baseline.sql`. A migration cria a
baseline final, grants mínimos, RLS e as roles restritas. O login runtime é inicializado uma única vez;
um commit de ativação ambíguo é compensado por conexões administrativas novas e só encerra depois de
reler `NOLOGIN`. Deploys seguintes apenas validam a credencial existente, sem rotação implícita.
Readiness usa uma
allowlist exata de comandos DAL, rejeita ACL herdada por `PUBLIC`, ownership ou membership inesperada e
aceita somente `CONNECT` como grant direto do login. Também rejeita `USAGE/CREATE` efetivo de `app_dal`
em qualquer schema não sistêmico fora de `private`, inclusive quando o acesso nasce de `PUBLIC`. A
propriedade do schema `private` e de todas as rotinas privadas é fixada na role canônica `postgres`; o
owner observado no catálogo nunca é aceito como autoridade por si só. Cada comando allowlisted também
deve continuar `security definer` e manter exatamente `search_path = ''`. A membership reversa aceita
apenas o vínculo
administrativo automático de `postgres`, sem `SET/INHERIT`; qualquer identidade assumível é rejeitada.
O health preserva heads aplicados para rollback
expand/contract, enquanto o deploy exige o maior head remoto exatamente igual ao candidato.

## Segurança e privacidade

Secrets permanecem somente no environment `production` do GitHub. PRs não os recebem. SSH usa chave
exclusiva e comando forçado; a VM expõe apenas 22, 80 e 443, mantém 3000/3001 em loopback e serve cabeçalho
`X-Robots-Tag` e `robots.txt` bloqueando indexação. O bootstrap publica Node somente após validação
integral, substitui o alias legado por link canônico recuperável, rejeita certificado com menos de 24
horas restantes, preserva apenas swapfiles que cumpram o manifesto e a borda encaminha o UUID de
correlação para validação pela aplicação. O contrato também recusa qualquer identidade, unit, credencial,
ferramenta ou árvore remanescente do deploy pull aposentado; sua retirada é uma migração administrativa
única e não adiciona outro mecanismo permanente ao repositório. Antes de publicar a chave, nomes, UIDs,
grupos, homes, shells e bloqueio de senha das identidades do host precisam corresponder ao contrato
canônico. O preflight e o instalador aceitam somente chave Supabase `sb_publishable_`, impedindo que uma
chave privilegiada alcance build ou artifact.

## Read models, comandos e invalidação

Não há mudança funcional nesses contratos. A baseline preserva os comandos privados, read models e
invariantes das features já implementadas.

## UX, mobile e acessibilidade

Não há mudança funcional de interface. Os gates visuais existentes continuam cobrindo engines e
viewports aplicáveis, safe areas, zoom de 200% e Axe.

## Qualidade e QA

- CI Linux e Windows executa os gates estáticos, unitários, SQL, Playwright e builds aplicáveis;
- um dispatch manual repete somente esses gates quando o evento nativo não cria check suite; deploy
  permanece impossível fora de `push` em `main` com a flag habilitada;
- falha Playwright preserva relatório, traces, screenshots e vídeos por sete dias sem acumular artifact
  em execução verde;
- cenários visíveis permanecem determinísticos entre engines, sem retries ou timeouts ampliados para
  mascarar falhas;
- os webServers Playwright neutralizam o ambiente herdado e recebem explicitamente o mesmo conjunto
  local validado pelas fixtures; `.env.e2e.local` prevalece sobre variáveis já exportadas, impedindo
  inclusive que uma publishable key de outro projeto seja combinada com a URL local;
- o ambiente Supabase local preserva as permissões exigidas pelos serviços oficiais sem ampliar o
  acesso das roles da aplicação;
- a Supabase CLI foi atualizada para `2.116.0`, que corrige a colisão do control endpoint entre stacks
  locais coexistentes; o novo default de exposição foi neutralizado explicitamente com
  `auto_expose_new_tables = false` e possui regressão unitária;
- a fronteira de catálogos prova o controle compensatório do ADR-019: leitura gerenciada só é aceita
  quando inexiste qualquer setting de role/database com nome sensível, e a combinação falha fechada;
- o laboratório Ubuntu cobre upload, ativação, interrupção, recuperação, rollback e smoke do artifact
  standalone sob as mesmas fronteiras instaladas na VM, e recusa `current` apontado para um filho da
  release em vez de sua raiz SHA exata;
- o instalador privilegiado readquire o lock de upload depois do `sudo` e o laboratório prova que uma
  sessão concorrente não substitui os inputs enquanto eles viram cópias root-only;
- `/opt/set-livre` e `releases` são abertos por handles `O_NOFOLLOW` com owner, grupo e modo exatos; probes
  nas duas posições recusam symlink sem alterar ou escrever no alvo externo, e o bootstrap valida a
  cadeia de um retry antes de consultar rollback ou `current`;
- o bootstrap remove somente o symlink `current` pendente antes de validar a release ativa, permitindo
  que o próximo artifact aprovado repare um destino perdido sem aceitar ponteiro ambíguo;
- a recuperação de serviços no boot só inicia depois de rede online e Nginx, preservando o marcador se
  essas dependências ainda não estiverem disponíveis, aguarda o lock por no máximo cinco minutos dentro
  de uma unit com orçamento de doze minutos e só o consome depois de health interno e público;
- o laboratório encerra cada falha que preserva o marcador com um retry bem-sucedido e prova sua remoção
  antes de iniciar outro cenário, sem compartilhar estado intermediário entre casos;
- a recuperação anterior a um novo deploy exige o SHA esperado nos health checks internos e no HTTPS
  público; a reexecução do bootstrap arma o rollback antes de liberar as units e só o remove depois de
  validar o mesmo SHA, enquanto falha de health republica o bloqueio antes de desativar o symlink;
- a reexecução do bootstrap aceita os diretórios reutilizados pela arquitetura atual somente depois de
  validar tipo, owner, modo e conteúdo do marcador operacional ou dos marcadores transitórios de retry;
- os grupos que protegem ambientes e entrega recusam membros reversos inesperados; home e `.ssh` do
  deployer são root-owned, diretórios são abertos com `O_NOFOLLOW` e a chave é publicada por rename;
- o empacotador recusa symlink ou junction em qualquer ancestral de `.artifacts/release` antes da
  remoção recursiva, preservando alvos externos;
- o bootstrap publica o in-progress, preserva e invalida o digest ativo e interrompe os serviços antes da
  primeira alteração; as units exigem digest ativo e ausência do marcador, o deploy recusa a transição,
  e uma release compatível permanece sob o recovery de rollback até readiness interno e público;
- a chave de deploy só substitui `authorized_keys` após validação estrutural integral de um único blob
  Ed25519; a extração pré-varre headers em streaming, limita metadata PAX/GNU e interrompe a leitura no
  header lógico 20.001 sem materializar entradas ilimitadas;
- o wrapper local fixa somente o named pipe/socket Docker canônico antes de chamar a CLI Supabase, e o
  readiness rejeita grants no schema ou em comandos privados para qualquer grantee além do owner/DAL
  e rejeita qualquer drift de owner, modo de segurança ou `search_path` nessas superfícies;
- o bootstrap falha antes de publicar `authorized_keys` quando uma identidade preexistente diverge de
  seu home, shell, grupo ou bloqueio de senha canônico;
- o teste SSR de hidratação mantém seu servidor isolado, usa a transformação Oxc nativa do Vite e
  controla preparação/encerramento em hooks da suíte, sem cobrar esse lifecycle do cenário testado;
- gates locais recusam tanto `databaseMigrationHead` divergente da migration mais recente quanto
  referência documental a ADR inexistente;
- o empacotamento aceita somente conteúdo regular originado da release e das dependências instaladas
  pelo lockfile, enquanto o host rejeita entradas fora desse contrato e compara a árvore completa antes
  de reutilizar um diretório do mesmo SHA; o laboratório normaliza seus archives como produção,
  reproduz o mesmo SHA em instantes diferentes, adultera código instalado e prova a recusa.

Resultados de execução, diagnósticos, contagens e histórico de correções permanecem no PR, nos checks e
no Git.

## Observabilidade e operação

Systemd separa web, backoffice e recuperação de release. Nginx publica somente a web, health checks
validam aplicação e SHA, Fail2ban e firewall persistente protegem a borda, e o workflow acompanha o
deployment até estado terminal.

## Documentação atualizada

Blueprint, ADRs, infraestrutura, desenvolvimento, segurança, review/deploy, configuração humana,
`AGENTS.md`, `README.md` e o resumo executivo HTML foram reconciliados com o estado implementado.

## Rollback/correção

Falha antes da ativação não altera `current`; falha depois da troca recupera a release anterior. Sem
release anterior, os serviços param. Falhas de migration não são revertidas automaticamente e exigem
nova migration corretiva append-only.

## Evidência de execução

Review, merge, migrations, deployment e health são comprovados nas superfícies autoritativas do PR, dos
checks e do Git, sem duplicação de logs ou cronologia neste documento.
