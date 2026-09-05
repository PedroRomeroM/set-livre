# Estratégia de QA

## Princípio

Testamos o risco no nível mais barato que ainda prova o comportamento. Quantidade de testes não é
meta. Uma camada adicional precisa detectar uma classe de falha diferente, e não repetir a mesma
implementação.

## Camadas

### Playwright

É a prova principal de comportamento visível:

- caminho feliz P0;
- pelo menos um erro ou conflito relevante;
- autenticação e navegação reais;
- composição desktop e mobile;
- teclado, foco e axe nos fluxos centrais;
- regressão para todo bug visível corrigido.

As specs implementadas e seus títulos são a fonte de verdade dos cenários concluídos. Cenários ainda
planejados ficam somente no plano transitório da feature.

### PostgreSQL/pgTAP

Usar para regras que pertencem ao banco:

- RLS e isolamento entre usuários;
- grants e fronteira `app_dal`;
- constraints e transações;
- concorrência e locks;
- idempotência de comandos;
- auditoria e invariantes financeiras.

Não transformar catálogo interno do PostgreSQL ou detalhes de uma versão do Supabase em manifesto
exaustivo. Readiness prova disponibilidade e privilégios essenciais; a suíte SQL prova as regras de
segurança e domínio.

### Unitários

Usar para:

- funções puras com combinações relevantes;
- schemas Zod e normalizers de fronteira;
- transições de estado difíceis de montar no navegador;
- tradução de erros de provider/banco;
- cache e invalidação quando a regra não é evidente no fluxo E2E.

Evitar testes de wrappers, argumentos triviais, árvore de processos, inodes, chamadas privadas e mocks
que apenas repetem o código. Refatoração interna sem mudança de comportamento não deve exigir reescrever
dezenas de testes.

### Estáticos e build

- Prettier;
- ESLint sem warnings;
- TypeScript estrito;
- Knip;
- `npm audit --audit-level=high`;
- build standalone das duas aplicações;
- `docs:check` sem marcadores de dívida soltos na implementação nem construções Playwright proibidas.

## Matriz Playwright

`playwright.config.ts` é a configuração canônica. A suíte cobre:

- desktop Chromium `1440 × 900`;
- mobile Chromium `390 × 844`;
- largura mínima `320 × 720`;
- altura compacta `1024 × 600`;
- fluxos críticos em Chromium, Firefox e WebKit;
- axe em desktop, mobile, 320 px e tema escuro;
- reflow/zoom 200% nos três engines;
- backoffice separado em `127.0.0.1:3001`.

Os testes são serializados por padrão porque compartilham um banco local destrutivo. Não há retry
permanente nem `waitForTimeout`. O gate `docs:check` varre todos os specs TypeScript/TSX em
`tests/e2e` e falha se encontrar `waitForTimeout`, `.only` ou `.skip`.

Os cenários transversais usam marcadores semânticos próprios de cada superfície. A raiz pública ainda
expõe o estado técnico; a raiz do backoffice, após a FEAT-031, redireciona visitantes sem sessão para
a autenticação real. Responsividade, ampliação textual e reflow precisam validar o conteúdo terminal
de cada aplicação, sem impor ao backoffice o placeholder removido. A regressão autenticada também
prova que login preserva os destinos canônicos de criação e edição de estúdio sem aceitar URL externa,
codificação alternativa ou UUID inválido; uma rota de edição com UUID válido em maiúsculas é
redirecionada primeiro ao path minúsculo e somente esse destino canônico atravessa o login.
Em resultado de login ambíguo, credenciais efêmeras, formulário e caches privados são redigidos antes
de o browser solicitar a releitura SSR; a fronteira visual fail-closed é commitada sincronamente com
`flushSync` antes dessa solicitação, e nenhuma atualização React ocorre depois que a navegação começa.
O cenário P0 exige a requisição de documento e o resultado autoritativo nos três engines.

## Segurança do E2E

Antes de qualquer mutação, os helpers exigem:

- `E2E_ALLOW_LOCAL=1`;
- web em `http://127.0.0.1:3000`;
- backoffice em `http://127.0.0.1:3001`;
- Supabase em `http://127.0.0.1:54321`;
- chave pública Supabase `sb_publishable_...` ou JWT com role `anon`;
- chave server-only emitida pelo Supabase CLI local, com JWT de role `service_role`, somente no
  processo web e nos helpers que limpam fixtures;
- PostgreSQL em `127.0.0.1:54322`;
- login DAL `app_runtime_local` com `options=-c role=app_dal`;
- marcador aleatório gravado no comentário do banco pelo último reset.

Qualquer URL cloud, representação alternativa, chave pública com role `service_role` ou chave
server-only fora do campo dedicado falha antes do teste. O backoffice nunca recebe a chave
server-only. Os servidores web recebem explicitamente esse contrato validado, sem herdar valores de
aplicação potencialmente divergentes do shell. O arquivo opcional `.env.e2e.local` só é interpretado depois de
provar arquivo regular, inode exclusivo e metadados estáveis; em POSIX, abertura no-follow, owner
efetivo e modo `0600` também são obrigatórios.

A leitura desse ambiente é explícita e lazy: importar um helper Playwright para testar suas funções
puras não lê credencial nem exige que o processo Vitest possua configuração destrutiva. A validação
fail-closed ocorre ao carregar a configuração Playwright ou imediatamente antes da primeira operação
real de banco. Assim, runners unitários limpos continuam independentes sem criar valor padrão,
fallback ou caminho que permita executar E2E sem o contrato completo.

O preflight global também exige zero identidades `qa_*@example.test`; resíduo de execução
interrompida exige `npm run supabase:reset` e nunca é tratado como fixture válida. Durante cada
processo worker, a primeira operação destrutiva revalida o mesmo marcador local; o resultado seguro é
compartilhado apenas durante aquela execução e não exige ausência da própria identidade QA já em uso.
Antes de cada ação que dispara Supabase Auth, o helper captura no Mailpit os IDs já existentes para o
destinatário QA exato. O polling aceita somente um ID novo com callback do tipo esperado; `Created`
ordena mensagens dentro do próprio Mailpit, mas nunca é comparado ao relógio do processo Windows.
Assim, drift entre Windows e WSL2 não produz falso timeout nem relaxa destinatário, callback ou cleanup.
Os servidores Playwright usam
`APP_ENV=test`: somente os buckets de rede compartilhados do login e do desbloqueio local recebem
capacidade para a matriz multibrowser de identidades únicas. Os buckets por identidade continuam
limitados a dez tentativas, e os runtimes `local`, `development` e `production` preservam o limite de
rede de 30 tentativas por 15 minutos. Esse mesmo ambiente desativa, pela opção suportada
`devIndicators`, o chrome visual do Next nos dois aplicativos: reflow e overflow medem apenas a UI do
produto, enquanto erros de build e runtime continuam sendo emitidos pelo framework.

Os dois servidores Next compartilham cada pool PostgreSQL no escopo global do respectivo processo,
inclusive entre bundles e recompilações do modo de desenvolvimento. O orçamento completo é exercitado
por teste unitário como `2 + 1 + 2 + 1 = 6`, preservando quatro das dez conexões do runtime para os
helpers restritos, readiness, recuperação e variação operacional. A suíte crítica longa é regressão
obrigatória para impedir que instâncias duplicadas voltem a saturar `app_runtime_local`.
O deadline de cada chamada do driver é deliberadamente posterior ao `statement_timeout` autoritativo
do PostgreSQL: `3 s > 2 s` nos pools de comando e E2E, e `2 s > 1 s` no readiness. Assim, uma
instrução lenta retorna o erro terminal do banco e deixa o estado transacional conhecido, enquanto a
margem restante cobre fila curta do pool e transporte sem aumentar o tempo permitido à instrução SQL.

Os helpers do próprio runner mantêm somente um pool administrativo e um pool DAL por processo, cada
um com no máximo uma conexão. Toda operação adquire e libera um cliente do pool; transações permanecem
presas ao mesmo cliente. Criar e encerrar um pool por consulta é proibido: além de anular o pooling,
esse churn esgota portas TCP efêmeras no gate Windows durante a matriz completa.
Antes de apagar identidades ou linhas de domínio, o teardown fecha as páginas relacionadas e deixa a
navegação já iniciada alcançar `domcontentloaded`. Fechar o browser não cancela uma consulta SQL já
enviada: exclusões Auth QA, exatas ou bulk, adquirem o advisory lock transacional exclusivo existente
`set-livre:backoffice-authorization` antes dos locks de linha do cascade. Isso aguarda leitores de
sessão que usam o lock compartilhado, sem inverter a ordem binding/Auth e sem retries. O cenário
`SL-F031-E2E-036` mantém esse leitor aberto em outra conexão, observa a espera real em `pg_locks` e
comprova a conclusão exata e idempotente após liberá-lo. Esse mecanismo é somente do teardown local.

Recomposições de segurança aguardam a superfície autoritativa final e suas evidências de escopo, não
uma navegação intermediária. Reload seguido de redirect ou nova composição SSR pode cancelar um
documento transitório legitimamente; o teste continua exigindo a tela final, a ausência dos dados
privados anteriores e, quando aplicável, a evidência explícita de que o reload ocorreu.
Gestos que iniciam logout commitam sincronamente a fronteira neutra antes da mutation e da requisição;
o cenário mantém a resposta suspensa e comprova que PII e controles privados já saíram da composição.

## Matriz da FEAT-006

Os cenários estáveis `SL-F006-E2E-*` cobrem:

- P0 de criação, clone de publicado, isolamento entre donos, troca de sessão no editor e na criação
  ainda não salva e revogação da autoridade de dono durante a criação nos três engines;
- validação, tokens locais independentes de update/descarte preservados após refetch, resposta de
  comando atrasada incapaz de abortar uma leitura autoritativa pendente ou regredir cache, formulário,
  estado operacional e fences irmãos, estado terminal de criação, recuperação idempotente após reload,
  liberação segura de uma nova tentativa após rejeição conclusiva, retry ambíguo, reconfirmação de
  descarte sem liberar save stale, bloqueio administrativo,
  arquivamento concorrente do tipo em criação/edição, falha transitória na releitura de conflito,
  navegação terminal explícita após descarte e revogação de conta em desktop, mobile, 320 px e altura
  compacta;
- `SL-F006-E2E-020/021/022` rejeitam respostas com escopo, estúdio ou tentativa divergentes antes de persistir
  recovery ou remover painéis, preservam o replay da intenção original e comprovam a reconciliação;
  a criação também recebe uma resposta real de outra tentativa do mesmo dono, com o mesmo conteúdo,
  e só resolve a recuperação depois de conferir a chave original no replay. O cenário 022 envia UUID
  com letras maiúsculas e exige correlação com a chave minúscula persistida, preservando o comando
  original na recuperação sem confundir uma chave realmente diferente;
  o descarte definitivo remove também as abas do estúdio, enquanto descartar somente uma revisão
  mantém a navegação da publicação existente;
- `SL-F006-E2E-023/024` esgotam a quota da aba somente após a criação real: preservam a intenção
  original, bloqueiam uma confirmação não durável e recuperam a persistência sem novo comando;
  reload reconcilia a mesma chave sem duplicar, e uma nova criação só começa após o consumo seguro;
- `SL-F006-E2E-025` inicia a fronteira de criação offline, exige erro recuperável sem formulário
  privado, revalida o acesso por tentativa explícita e cria um único estúdio;
- `SL-F006-E2E-026` resolve uma criação após perda real da resposta, descarta o estúdio em outra aba,
  visita o 404 e encerra explicitamente a resolução obsoleta. Não há comando no encerramento; somente
  o envio posterior cria outro estúdio com chave distinta. `023/024` não oferecem essa ação enquanto
  a confirmação não for durável;
- axe/teclado/toque/alvos em desktop, mobile, 320 px e tema escuro;
- reflow a 200% em Chromium, Firefox e WebKit.

O helper cria dono real pelo fluxo UI, prova pré-requisitos no banco e limita queries administrativas
ao ambiente E2E já validado. O teardown aguarda o documento carregado e fecha a página antes da
remoção transacional das fixtures; cada helper de comando já aguarda a resposta específica que gerou o
estado observado. A criação só retorna ao cenário depois da leitura inicial do editor responder `200`; assim a
fixture de conflito avança uma versão já observada, sem competir com o refetch de montagem. As specs
herdam a retenção global de
trace, screenshot e vídeo somente em falha; nenhuma desativa essa evidência localmente.

No banco, `0005_studio_core_revision.sql` prova os contratos de domínio e segurança. O setup
`0000_test_setup.sql` habilita pgTAP idempotentemente antes das suítes.

## Matriz da FEAT-007

Os cenários `SL-F007-E2E-*` cobrem:

- P0 salva conteúdo/taxonomia, rejeita catálogo inativo/externo e prova plain text nos três engines;
- FAQ mobile, YouTube permitido/bloqueado, handoff de revisão confirmada entre os painéis e reset
  integral após descarte em desktop, 390 px, 320 px e altura compacta;
- troca de sessão oculta editor e conteúdo comercial privados antes da releitura nos três engines;
- resposta ambígua congela ambos os formulários e repete o comando idempotente intacto nas quatro
  composições de regressão;
- refetch preserva a versão otimista associada aos valores locais, aceita substituição autoritativa de
  revisão, ponteiros e estado operacional sem abortar a leitura pendente nem permitir que resultado
  tardio de comando reverta a projeção causal mais nova, exige conflito explícito antes do rebase e
  impede sobrescrita concorrente silenciosa nas quatro composições de regressão;
- axe, teclado, toque e alvos em desktop, mobile, 320 px e tema escuro;
- reflow a 200% em Chromium, Firefox e WebKit.

`0006_studio_taxonomy_content.sql` prova schema, grants/RLS, isolamento entre donos, idempotência,
concorrência, clone de publicado, taxonomia ativa, FAQ/vídeo e auditoria redigida.

## Matriz da FEAT-031

Os cenários `SL-F031-E2E-*` cobrem:

- P0 de suspensão/restauração, bloqueio de comandos, papéis/último admin e taxonomia histórica nos
  três engines;
- P0 prova que o runtime bloqueado retorna `423` sem mutação e que somente o desbloqueio local válido
  permite prosseguir, nos três engines;
- P0 segura respostas de status, acesso e taxonomia ainda em voo para provar que cancelamento e troca
  de ação ficam bloqueados; depois perde cada resposta já commitada e repete a tentativa idempotente
  até obter o resultado autoritativo, nos três engines. Criação e edição de taxonomia também perdem a
  resposta e comprovam que os campos ficam congelados enquanto o botão de replay permanece alcançável;
- P0 desabilita JavaScript e prova que login, desbloqueio, busca de usuários e gestão de taxonomias
  permanecem inertes, sem fallback de segredos ou ação sem handler e com instrução explícita de
  recuperação, nos três engines;
- PII mascarada até revelação justificada, com o motivo auditado imutável durante a requisição e
  descarte imediato do valor anterior quando o motivo muda, além de busca/cursor server-side em
  desktop, 390 px, 320 px e altura compacta;
- `SL-F031-E2E-005` entrega à nova tentativa a resposta real de outra revelação do mesmo operador/alvo,
  preservando a correlação HTTP atual: dados continuam ocultos e motivo bloqueado até replay da
  chave/payload exatos, sem auditoria duplicada. Unitários isolam chave, motivo e action
  ausentes/divergentes na resposta; pgTAP prova o eco vindo do ledger/evento auditado e sua
  estabilidade no replay, com recusa de motivo trocado e resultado stale;
- resposta de PII que conclui depois de a aba ficar oculta é descartada nas quatro composições de
  regressão;
- revalidação de sessão/papel, auto-suspensão confirmada ou com resposta perdida, login ambíguo em outra
  aba e reautenticação inconclusiva fecham a composição privada anterior; a reautenticação válida
  conserva a aba autora, publica a sessão renovada no cache antes de avisar somente as demais abas,
  exige novo desbloqueio local e permite concluir a ação revisada; revogar o próprio papel
  administrativo fecha a composição tanto no sucesso quanto diante de resposta perdida, e o logout
  offline começa imediatamente e oculta a shell sem aguardar reconexão;
  a expiração autoritativa também fecha a shell quando a rede está indisponível, enquanto um deadline
  antigo não invalida uma sessão já renovada; conflitos de conta, papel e taxonomia descartam
  confirmações versionadas e exigem nova leitura nas quatro composições de regressão;
- uma nova busca descarta somente a confirmação de status ainda não enviada; busca e submit
  permanecem bloqueados durante mutação pendente ou resultado ambíguo, preservando alvo, payload e
  chave idempotente até a reconciliação. O fingerprint assíncrono serializa submissões, e a busca
  normaliza caixa e espaços de forma consistente com SQL e cursor;
- `SL-F031-E2E-030` entrega primeiro confirmações com outra chave/action para a mesma conta/versão;
  mantém a seleção e repete exatamente o comando, sem auditoria duplicada. Depois retém a resposta
  RSC após a confirmação válida, verifica o prazo real de
  dez segundos sem acelerar as leituras concorrentes de sessão e recupera sem repetir o comando;
- `SL-F031-E2E-031/032/033` interrompem a leitura após comandos reais de criação/edição de taxonomia,
  arquivamento/reativação e suspensão/restauração. Preservam confirmação e formulário, bloqueiam ações,
  busca e paginação e recuperam somente a leitura do mesmo recorte, sem duplicar comando ou auditoria;
- `SL-F031-E2E-034` desloca a última conta visível após um cadastro concorrente: a verificação por UUID
  recupera uma falha de leitura sem reenviar suspensão, preserva o filtro/páginas da tela e permite
  alcançar o alvo pela paginação normal, sem duplicar auditoria;
- `SL-F031-E2E-035` corrompe estado, campos, versão e chave após comandos reais de conta/taxonomia;
  rejeita a confirmação incoerente, preserva a tentativa e recupera por replay idempotente, com
  auditoria única. Unitários cobrem também arquivamento/reativação e concessão/revogação de papéis;
- unitários de DAL recusam eco ausente ou outra chave nos cinco entrypoints; os contratos/clientes
  rejeitam metadata inválida antes do consumo. `0007_backoffice_users_taxonomy.sql` compara
  confirmações novas/replays com o ledger real e prova hashes históricos intactos, novo requestId
  sem nova tentativa e conflito ao trocar o papel na mesma chave;
- `SL-F031-E2E-037`, em `feat-031-protected-layout-recovery.spec.ts`, provoca timeout real da leitura
  DAL do layout, exige fallback ancestral sem conteúdo privado, prova uma nova consulta no retry e
  recupera após liberar o lock. Revogar o papel durante a falha mantém o acesso fechado no retry;
  axe, teclado e ausência de overflow cobrem a composição de erro;
- ordem de taxonomia vazia é rejeitada no próprio campo antes de enviar criação ou edição; zero
  explícito permanece válido. Unitários de fronteira rejeitam usuário, ID ou tipo de taxonomia
  diferentes do comando e comprovam deadline das leituras, inclusive durante consumo do corpo;
- listas privadas de usuários e taxonomias rejeitam uma resposta cujo `scope` já pertence a outra
  composição antes que o TanStack Query a aceite no cache; PII revelada valida `scope` e `userId`
  solicitados antes do consumidor efêmero e recompõe a fronteira sem renderizar em qualquer divergência;
- o detalhe de acessos oferece concessões somente para conta ativa com perfil completo, explica a
  restrição e mantém disponíveis as revogações de papéis já concedidos; UUID válido de uma conta que
  deixou de existir retorna a fronteira contextual de not-found com HTTP 404 e `noindex`, sem
  renderizar detalhes privados; no viewport de 320 px, o mesmo cenário mantém escala 1, largura
  física estável e prova por hit testing que o link de retorno é o alvo superior no seu ponto central,
  inclusive com o e-mail operacional longo da fixture;
- logout confirmado oculta sincronamente todo o shell privado antes da navegação, inclusive quando a
  resposta da próxima rota permanece suspensa;
- axe, teclado, toque, contraste e ausência de overflow em desktop, mobile, 320 px e tema escuro.

Os testes provam a fronteira `support/admin` pela UI, rota, API e banco. PII efêmera nunca entra no
QueryCache nem em fixture persistida; o helper cria identidades reais no Supabase local, usa a role DAL
restrita e remove usuários/taxonomias após cada cenário. `0007_backoffice_users_taxonomy.sql` prova
grants/RLS, binding curto, polling passivo sem renovação, correção regressiva do
relógio, expiração, bootstrap one-shot,
papel/último admin, rejeição direta de concessão a conta suspensa ou perfil incompleto, versão de
conta, PII redigida, idempotência, taxonomia histórica, limite de catálogo e encerramento de sessões. O
regressão transversal de tempo força timestamps
persistidos à frente do relógio observado e comprova a normalização compartilhada nas dez tabelas de
domínio que mantêm `created_at/updated_at`.

## Matriz da FEAT-008

Os cenários `SL-F008-E2E-*` e `SL-F008-CACHE-*` cobrem:

- P0 percorre upload/finalização, capa, ordem, exclusão, MIME forjado, limite local e respostas perdidas
  antes/depois da persistência, reconciliação autoritativa que reutiliza o token já assinado quando a
  confirmação ambígua foi commitada, retomada dos demais itens enfileirados após verificação segura,
  recusa definitiva com liberação server-side da reserva e isolamento entre donos nos três engines;
- regressões em desktop, 390 px, 320 px e altura compacta provam controles acessíveis, dimensões
  reservadas/CLS, hidratação fail-closed, conflito autoritativo de galeria, avanço concorrente logo
  após o preparo com terminalização server-side, resposta perdida, replay da mesma chave idempotente
  e upload com reserva nova, além da ausência de controles privados sem JavaScript. `SL-F007-E2E-008`
  prova o descarte na própria aba; `SL-F008-CACHE-001` prova que uma releitura não cancelada adota o
  rollback autoritativo `N+1 → N` feito em outra aba sem restaurar uma resposta de comando obsoleta;
- o teste unitário do cliente comprova que uma finalização válida pode ultrapassar o deadline genérico
  sem exceder o envelope dedicado de 45 segundos, sem adicionar espera real à matriz Playwright;
- `SL-F008-E2E-015` devolve uma reserva real de tentativa irmã do mesmo estúdio: chave ou ação
  divergentes impedem qualquer upload ao Storage, preservam o comando e só a confirmação do retry
  original permite finalizar a mídia correta;
- axe, teclado, foco, tema escuro e viewports móveis executam em quatro composições;
- reflow a 200% executa em Chromium, Firefox e WebKit.

O helper usa Auth, Storage e banco locais reais, envia bytes por token assinado, remove original e
prévia e encerra requests da página antes do teardown. `0009_studio_media.sql` prova schema, grants/RLS
e Storage A/B, limite e liberação de reservas rejeitadas, clone, idempotência,
liquidação da emissão do token nas duas ordens possíveis da corrida, compensação idempotente e liberação
imediata da vigésima vaga quando o Storage não entrega autorização,
claim único pré-processamento/replay/rejeição, renovação terminal que impede takeover após a expiração
anterior, token stale, conflito definitivo entre chaves, ausência de sessão presa e ordem global de locks
com begin sobreposto às fachadas claimed de finalize e reject via `dblink`, além de contagens de
abandono, backoff e heartbeat do cleanup. A regressão do ledger prova que o run A conserva seu item e
fecha `1/0/1` mesmo depois de o run B reassumir a lease e concluir o mesmo objeto com `1/1/0`.
Replay renova a reserva de mídia e probe antes de devolver paths, preservando tentativas e histórico;
duas conexões provam que outro token não captura a mídia durante nem após essa renovação. O lifecycle
do probe continua recusando retrocesso do prazo, troca de token e alteração de paths.

## Matriz da FEAT-009

Os cenários `SL-F009-E2E-*` exercitam a matriz permanente desta feature:

- cinco P0 nos três engines cobrem submissão completa/incompleta, preservação da versão publicada,
  replay idempotente e pausa/retomada com ponteiros estáveis;
- regressões em desktop, 390 px, 320 px e altura compacta cobrem rejeição orientada à correção,
  conflito com releitura e foco, JavaScript desabilitado fail-closed, recomposição SSR quando o mesmo
  fence retorna projeção derivada divergente, taxonomia arquivada entre leitura e submit sem efeito
  parcial e descarte integral da correção criada após a primeira rejeição;
- `SL-F009-E2E-014` retém o envio na fronteira de transporte até o timeout real do navegador, lê o
  estado pré-commit e só então aplica o POST real perdendo sua resposta. Não simula SQL por 10s:
  o `statement_timeout` real de 2s permanece intacto. GETs reais antes e depois do commit não liberam
  novas intenções nem oferecem aceite da ambiguidade; só o replay explícito com ação, payload e chave
  originais confirma a tentativa, com uma única submissão, outbox, request e auditoria no banco;
- `SL-F009-E2E-017` recusa chave e ação divergentes em respostas estruturalmente válidas, não anuncia
  conclusão, preserva o replay exato e comprova uma única submissão, outbox e auditoria no banco;
- axe, teclado, foco, toque, 320 px e tema escuro executam em quatro composições;
- reflow a 200% executa em Chromium, Firefox e WebKit.

O helper cria dono, estúdio e mídia reais no ambiente local, usa o fluxo UI para as transições P0 e
consulta somente evidência administrativa allowlisted. `0010_studio_publication_workflow.sql` prova
schema, grants/RLS, ownership, checklist derivado, imutabilidade pendente, ponteiros, idempotência,
ordem causal, corrida entre submit e arquivamento de taxonomia, pausa/retomada, suspensão de conta,
outbox, auditoria, índices estruturais e cascade restrito ao agregado nunca publicado.

## Matriz da FEAT-030

Os cenários `SL-F030-E2E-*` cobrem:

- aprovação inicial, rejeição de alteração com preservação pública, recusa de conta sem papel e duas
  decisões concorrentes com uma única transição nos três engines;
- concessão/revogação de `reviewer` pela UI, com invalidação da sessão já aberta nos três engines;
- desativação/restauração do estado exato em desktop, 390 px, 320 px e altura compacta;
- resposta perdida após commit com repetição byte a byte da mesma intenção; preview inválida com
  bloqueio da decisão e renovação; conflito seguido de releitura `503/404` e `404` direto do comando,
  ambos descartando formulário, mídia e snapshot antes da nova leitura;
- `SL-F030-E2E-017` entrega uma rejeição realmente persistida para o mesmo operador/estúdio/revisão,
  action e versão, mas com outra chave/motivo. Não anuncia sucesso, mantém o motivo original bloqueado
  e reenvia a tentativa original; seu conflito real exige releitura sem atribuir o resultado alheio.
  `0011_backoffice_studio_review.sql` prova eco do ledger nas quatro ações e replays, preservação dos
  hashes históricos e recusa de outro motivo na mesma chave;
- recuperação da carga inicial e da próxima página da fila sem descartar itens já confirmados;
- `SL-F030-E2E-016` inicia a fila offline, exige erro sem cards ou falso estado vazio e recupera
  o item real por nova leitura explícita, sem evento online nem comando;
- loading, erro inicial recuperável e 404 contextual da rota; 404 conclusivo em refetch elimina o
  detalhe privado anterior e impede nova decisão;
- ausência de `/admin` no aplicativo público;
- axe, teclado, foco, alvos de toque e tema escuro nas quatro composições;
- comparação sem overflow e ação operável a 200% em Chromium, Firefox e WebKit; o cenário de 160 ×
  360 configura os recuos simulados de `safe-area` antes do foco, como em uma viewport já
  estabelecida, comprova que um inset superior de 59 px mantém o link integralmente oculto sem foco e
  verifica depois do foco tanto a caixa quanto os limites subpixel crus do texto do link em relação à
  caixa de conteúdo. Uma versão autoritativa nova substitui o painel com descrição, regras, taxonomias e
  FAQ com sequências contínuas de `A`, incluindo pares com kerning em DejaVu Sans. A reprodução Linux
  deve incluir `fonts-dejavu-core`, instalado explicitamente pelo CI: a imagem Playwright sem esse
  pacote pode usar WenQuanYi e deixar de reproduzir o defeito. Os cenários existentes do editor
  principal, comercial e da publicação também exercitam descrição, regras e FAQ nos limites de
  tamanho. Depois da estabilização das fontes, todos os
  elementos continuam sujeitos às provas globais de caixa e
  overflow interno, e corpo e documento precisam permanecer sem qualquer largura rolável adicional.

O helper cria identidades `support/reviewer/admin`, dono, estúdio, candidata, publicação e mídia reais
no Supabase local. As decisões P0 atravessam UI, Auth, Storage, API, DAL e banco. O teardown fecha as
páginas antes de remover fixtures. `0011_backoffice_studio_review.sql` prova papéis e separação de
capacidades, grants/RLS, policy A/B de Storage, fila/detalhe, keyset real com desempate e cursor DAL,
decisões, restauração exata, locks, idempotência, auditoria/outbox, clone integral da rejeição e
ausência de fence residual. A corrida de aprovação usa dois reviewers com sessões independentes; outro
cenário arquiva uma taxonomia após a submissão e prova que read model e comando removem a aprovação sem
qualquer efeito parcial.

## Contrato por feature

Enquanto planejada ou em andamento, cada feature possui cenários P0/P1 rastreáveis. A validação deve:

1. implementar a fatia vertical e as regressões necessárias;
2. manter IDs estáveis nos títulos/comentários das specs quando úteis à rastreabilidade;
3. executar SQL, unitários e Playwright aplicáveis;
4. executar a suíte Playwright completa antes de release;
5. consolidar contratos permanentes no documento de domínio.

Criação, remoção e consolidação dos planos seguem exclusivamente o
[`ADR-015`](adr/ADR-015-living-documentation-and-qa.md).

## Evidência

Saída interrompida, timeout ou serviço indisponível é inconclusivo. Um gate passa somente com execução
terminal e código zero. Artefatos de falha do Playwright — trace, screenshot e vídeo — são retidos no
CI por sete dias somente quando a suíte falha; evidência verde não precisa ser acumulada no repositório.
No CI, os seis shards da matriz completa executam simultaneamente em runners Linux independentes. Cada
um recria a própria stack Supabase e mantém um único worker; o agregador protegido rejeita shard ou gate
Linux com resultado diferente de `success`.
