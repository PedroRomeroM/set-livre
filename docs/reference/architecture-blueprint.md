**# Blueprint de Arquitetura para uma Plataforma SaaS**

**## 1. Proposito deste documento**

Este documento descreve uma formula reutilizavel para construir uma plataforma SaaS moderna, segura, eficiente e agradavel de usar. Ele nao define um produto especifico. Em vez disso, consolida principios, contratos, tecnologias, estruturas e criterios de qualidade que podem ser aplicados a diferentes dominios.

O objetivo e permitir que uma nova plataforma comece com:

\- uma arquitetura simples de explicar e dificil de usar incorretamente;
\- dados canonicos separados de previsoes, snapshots e apresentacoes;
\- seguranca por camadas, sem depender apenas do frontend;
\- operacoes criticas atomicas e auditaveis;
\- UX flexivel, que orienta sem prender o usuario;
\- desktop e mobile tratados como composicoes completas;
\- testes que protegem contratos, nao apenas linhas de codigo;
\- deploy reproduzivel, observavel e reversivel;
\- documentacao viva que acompanha cada decisao relevante;
\- custos proporcionais ao uso real da plataforma.

Esta formula deve ser adaptada ao dominio. Copiar estruturas sem validar as regras do novo produto apenas troca um tipo de improviso por outro.

**### Como usar**

1\. Leia os principios antes de escolher entidades ou telas.
2\. Use a arquitetura de referencia como ponto de partida, nao como dogma.
3\. Classifique os dados do novo dominio com a matriz da secao 7.
4\. Implemente o primeiro corte vertical seguindo a secao 23.
5\. Use os checklists da secao 24 em cada PR.
6\. Considere a Definition of Done da secao 26 como gate de entrega.

**### Mapa do documento**

\- [Principios fundamentais]\(#2-principios-fundamentais)
\- [Arquitetura de referencia]\(#3-arquitetura-de-referencia)
\- [Stack recomendada]\(#4-stack-recomendada)
\- [Estrutura do repositorio]\(#5-estrutura-do-repositorio)
\- [Modelo de ambientes]\(#6-modelo-de-ambientes)
\- [Modelagem de dominio]\(#7-modelagem-de-dominio)
\- [Banco de dados e Supabase]\(#8-banco-de-dados-e-supabase)
\- [Contrato de leitura]\(#9-contrato-de-leitura-no-frontend)
\- [Contrato de escrita]\(#10-contrato-de-escrita)
\- [Autenticacao e seguranca]\(#11-autenticacao-e-seguranca)
\- [Design system]\(#12-design-system)
\- [Responsividade e mobile]\(#13-responsividade-e-mobile)
\- [UX e linguagem]\(#14-ux-e-linguagem)
\- [Acessibilidade]\(#15-acessibilidade)
\- [Performance e custos]\(#16-performance-e-eficiencia-de-custos)
\- [Observabilidade]\(#17-observabilidade)
\- [Testes e QA]\(#18-testes-e-qa)
\- [Infraestrutura e deploy]\(#19-infraestrutura-e-deploy)
\- [Backoffice]\(#20-backoffice)
\- [Documentacao viva]\(#21-documentacao-viva)
\- [Anti-padroes]\(#22-anti-padroes-a-evitar)
\- [Fluxo de implementacao]\(#23-fluxo-de-implementacao-de-uma-nova-plataforma)
\- [Checklists]\(#24-checklists-de-mudanca)
\- [Templates tecnicos]\(#25-templates-tecnicos)
\- [Definition of Done]\(#26-definition-of-done)
\- [Formula resumida]\(#27-formula-resumida)

**---**

**## 2. Principios fundamentais**

**### 2.1 O sistema ajuda; ele nao aprisiona**

Regras de negocio devem proteger consistencia real, seguranca e integridade. Elas nao devem transformar hipoteses do produto em bloqueios artificiais.

Quando mais de uma interpretacao for plausivel:

1\. mostre ao usuario o que foi identificado;
2\. explique o impacto em linguagem simples;
3\. ofereca escolhas explicitas;
4\. registre a escolha;
5\. permita corrigir depois, quando for seguro.

Automacao silenciosa so deve existir quando o resultado for inequivoco, reversivel e esperado.

**### 2.2 Fatos, previsoes e apresentacoes sao coisas diferentes**

\- **\*\*Fato canonico:\*\*** algo que realmente aconteceu e afeta o estado do dominio.
\- **\*\*Configuracao:\*\*** regra usada para orientar ou gerar fatos futuros.
\- **\*\*Previsao:\*\*** estimativa baseada em configuracoes ou historico.
\- **\*\*Evento operacional:\*\*** registro de uma decisao, transicao ou acao relevante.
\- **\*\*Snapshot:\*\*** retrato materializado para revisao, comparacao ou exportacao.
\- **\*\*Read model:\*\*** representacao derivada e otimizada para uma tela ou fluxo.

Uma previsao nunca deve ser apresentada como fato. Um snapshot nunca deve substituir silenciosamente a origem. Um read model nao deve virar uma segunda fonte canonica.

**### 2.3 Correcao e uma funcionalidade central**

Usuarios erram, mudam de ideia e descobrem informacoes depois. A arquitetura deve prever:

\- edicao direta enquanto nao houver impacto dependente;
\- exclusao fisica apenas quando for comprovadamente segura;
\- arquivamento para entidades historicas;
\- remocao logica para fatos operacionais reversiveis;
\- ajustes explicitos quando reescrever o passado quebraria rastreabilidade;
\- desfazer ou compensar uma acao confirmada quando o dominio permitir;
\- explicacao clara quando uma acao estiver realmente bloqueada.

O usuario nunca deve ficar preso a um estado incorreto apenas porque percebeu o erro tarde.

**### 2.4 Rotas representam intencoes, nao tabelas**

A navegacao deve refletir tarefas que o usuario entende. Uma rota pode combinar varias tabelas e read models se isso produzir um fluxo coerente. Da mesma forma, uma tabela nao precisa ganhar uma tela propria.

**### 2.5 Leitura e escrita tem contratos diferentes**

\- Leituras usam read models pequenos, filtrados e orientados a tela.
\- Escritas criticas passam por comandos server-side autenticados.
\- O navegador nao coordena varias mutacoes para simular atomicidade.
\- O banco preserva invariantes e concorrencia.
\- O frontend apresenta resultado, progresso e erro acionavel.

**### 2.6 Seguranca e o estado padrao**

Uma nova tabela, rota ou acao nasce sem acesso ate que grants, policies, ownership e validacoes sejam definidos explicitamente. A ausencia de configuracao nunca deve significar acesso amplo.

**### 2.7 Qualidade inclui custo e operabilidade**

Uma solucao tecnicamente correta pode continuar ruim se:

\- transfere dados demais;
\- exige infraestrutura ociosa;
\- nao permite diagnosticar falhas;
\- gera deploys irreversiveis;
\- depende de conhecimento tribal;
\- cria componentes impossiveis de manter.

Performance, custo, observabilidade, recuperacao e clareza fazem parte do produto.

**---**

**## 3. Arquitetura de referencia**

\`\`\`mermaid
flowchart LR
    U[Usuario] --> W[Next.js App Router]
    W --> UI[React UI e Design System]
    UI --> Q[TanStack Query]
    Q --> R[Read Models]
    UI --> A[Route Handler de comandos]
    A --> AUTH[Validacao de sessao]
    A --> DAL[DAL server-only]
    DAL --> C[Funcoes privadas de comando]
    R --> DB[(PostgreSQL)]
    C --> DB
    DB --> RLS[RLS, grants e constraints]
    A --> LOG[Logs estruturados]
    W --> OBS[Metricas e rastreamento]
\`\`\`

**### 3.1 Camadas**

1\. **\*\*Experiencia:\*\*** rotas, composicao responsiva, formularios, modais e feedback.
2\. **\*\*Estado remoto:\*\*** cache, query keys, normalizacao, paginacao e invalidacao.
3\. **\*\*Fachada HTTP:\*\*** autenticacao, limite de corpo, rate limit, validacao e erros seguros.
4\. **\*\*DAL server-only:\*\*** conexoes restritas e chamada de comandos atomicos.
5\. **\*\*Banco:\*\*** fatos, constraints, RLS, grants, funcoes, read models e locks.
6\. **\*\*Operacao:\*\*** logs, metricas, deploy, rollback, backup e backoffice.

**### 3.2 Regra de dependencia**

As dependencias apontam para dentro:

\- componentes conhecem contratos de UI, nao SQL;
\- hooks conhecem queries e comandos, nao credenciais;
\- a API conhece validacao e DAL, nao markup;
\- o DAL conhece contratos do banco, nao estado visual;
\- o banco nao depende de detalhes de uma tela especifica, apenas de invariantes e read models publicados.

**---**

**## 4. Stack recomendada**

**### 4.1 Aplicacao**

\| Camada | Tecnologia | Motivo |
\|---|---|---|
\| Framework | Next.js 16 com App Router | SSR, Route Handlers, layouts, streaming e deploy standalone |
\| UI | React 19 | composicao declarativa e ecossistema maduro |
\| Linguagem | TypeScript em modo \`strict\` | contratos explicitos entre frontend, API e dados |
\| Estilos | CSS Modules + CSS variables | isolamento local com tokens globais, sem DSL paralela |
\| Estado remoto | TanStack Query | cache, invalidacao, retries e estados de carregamento |
\| Icones | \`lucide-react\` | biblioteca consistente e acessivel |
\| Graficos | \`recharts\` | visualizacoes declarativas quando agregam valor |
\| PDF | renderer server-side ou React PDF | exportacao reproduzivel sem depender do DOM visivel |

**### 4.2 Dados e autenticacao**

\| Camada | Tecnologia | Motivo |
\|---|---|---|
\| Banco | PostgreSQL | constraints, transacoes, locks, JSONB e funcoes robustas |
\| Plataforma | Supabase | Auth, Postgres, RLS, API e ambiente local integrado |
\| Cliente browser | \`@supabase/supabase-js\` | sessao e leituras permitidas por RLS |
\| SSR de auth | \`@supabase/ssr\` | cookies e validacao de usuario no servidor |
\| DAL critico | driver \`pg\` server-only | acesso por role restrita a funcoes privadas |
\| Desenvolvimento | Supabase CLI + Docker | banco local descartavel e seguro para testes destrutivos |

O nucleo de modelagem permanece portavel para PostgreSQL fora do Supabase. Auth, RLS e deploy devem ser reavaliados se o provedor mudar.

**### 4.3 Qualidade**

\| Necessidade | Tecnologia |
\|---|---|
\| Unitarios e guardrails | Vitest |
\| E2E | Playwright |
\| Lint | ESLint |
\| Tipos | \`tsc --noEmit\` |
\| Codigo morto | Knip |
\| Dependencias | \`npm audit\` e atualizacao controlada |
\| CI/CD | GitHub Actions |

**### 4.4 Versoes e reproducibilidade**

\- Fixar uma faixa suportada de Node.js no \`package.json\`.
\- Usar lockfile versionado e \`npm ci\` em CI.
\- Atualizar frameworks deliberadamente, lendo guias da versao instalada.
\- Nao copiar padroes de versoes antigas do framework sem verificar compatibilidade.
\- Fixar actions de CI por SHA quando possivel.

**---**

**## 5. Estrutura do repositorio**

\`\`\`text
.
\|-- apps/
\|   \`-- backoffice/              # aplicacao operacional separada
\|-- docs/
\|   |-- context.md               # estado tecnico vivo
\|   |-- architecture.md          # arquitetura e ADRs consolidados
\|   |-- database.md              # modelo, RLS, grants e indices
\|   |-- design-system.md         # tokens, primitives e responsividade
\|   |-- ux-blueprint.md          # rotas e fluxos do usuario
\|   |-- infrastructure.md        # ambientes, deploy e operacao
\|   |-- qa-test-plan.md          # catalogo de cenarios
\|   \`-- technical-debt.md        # dividas com criterio de saida
\|-- src/
\|   |-- app/
\|   |   |-- api/                 # Route Handlers
\|   |   \`-- app/                 # rotas autenticadas do produto
\|   |-- components/ui/           # design system compartilhado
\|   |-- domains/                 # codigo por dominio quando crescer
\|   |-- lib/
\|   |   |-- api/                 # limites, erros e request IDs
\|   |   |-- auth/                # sessao e autorizacao
\|   |   |-- queries/             # query keys e invalidacao
\|   |   |-- server/              # DAL e integracoes server-only
\|   |   \`-- supabase/            # clientes browser/server
\|   \`-- types/                   # contratos compartilhados
\|-- supabase/
\|   |-- migrations/              # fonte de verdade versionada
\|   |-- seed.sql                 # dados locais previsiveis
\|   \`-- schema.generated.sql     # snapshot gerado, nunca fonte manual
\|-- tests/
\|   |-- e2e/
\|   |   |-- smoke/
\|   |   |-- critical/
\|   |   \`-- regression/
\|   \`-- helpers/
\`-- scripts/                     # setup local, auditorias e relatorios
\`\`\`

**### 5.1 Evolucao modular**

Comece com poucos modulos, mas defina limites claros. Quando um provider ou arquivo passar a coordenar dominios independentes, separe por comportamento, nao apenas por quantidade de linhas.

Cada dominio maduro pode conter:

\`\`\`text
domains/example/
\|-- components/
\|-- queries.ts
\|-- mutations.ts
\|-- normalizers.ts
\|-- types.ts
\|-- validation.ts
\`-- server/
\`\`\`

Evite um unico contexto React que carregue toda a aplicacao, todas as mutacoes e todos os dados. Isso aumenta rerenders, acoplamento e risco de regressao.

**---**

**## 6. Modelo de ambientes**

**### 6.1 Ambientes recomendados**

\- **\*\*Local:\*\*** aplicacao, banco e autenticacao locais; unico alvo de E2E destrutivo.
\- **\*\*Acceptance:\*\*** ambiente efemero ou ativado sob demanda para validacao integrada.
\- **\*\*Production:\*\*** ambiente persistente, protegido e com deploy automatizado.

Nao mantenha ambientes remotos ociosos apenas por costume. O custo fixo deve ser justificado por uso real.

**### 6.2 Regras de isolamento**

\- Credenciais nunca sao compartilhadas entre ambientes.
\- O bundle publico recebe apenas variaveis explicitamente publicas.
\- URLs de banco e roles privadas existem somente no runtime server-side.
\- Testes E2E abortam antes de abrir o navegador se detectarem host, banco ou marcadores nao locais.
\- Seeds e usuarios de QA usam namespace identificavel e cleanup restrito.
\- Nenhum script de desenvolvimento aponta para producao por default.

**### 6.3 Configuracao local**

Um unico comando deve:

1\. validar Docker;
2\. iniciar a stack local;
3\. aplicar migrations do zero;
4\. criar roles restritas;
5\. gerar arquivos \`.env\` ignorados;
6\. criar usuario e dados de QA;
7\. exibir apenas endpoints nao secretos.

**---**

**## 7. Modelagem de dominio**

**### 7.1 Classifique cada dado antes de criar uma tabela**

\| Classe | Pergunta | Exemplo generico |
\|---|---|---|
\| Fato | Algo aconteceu? | registro operacional confirmado |
\| Entidade | Algo existe e e reutilizado? | conta, projeto, recurso |
\| Regra | Algo deve acontecer? | agenda ou configuracao recorrente |
\| Evento | Uma decisao/transicao ocorreu? | confirmacao, cancelamento, ajuste |
\| Previsao | O que provavelmente acontecera? | estimativa futura |
\| Snapshot | Como estava em um momento? | revisao mensal ou relatorio salvo |
\| Read model | Como uma tela precisa ler? | overview agregado e paginado |

Se duas classes forem misturadas, a interface tende a mostrar previsao como realidade ou a sobrescrever fatos para corrigir relatorios.

**### 7.2 Fonte canonica unica**

Cada conceito deve ter uma origem identificavel. Outras tabelas podem guardar referencias, materializacoes ou snapshots, mas nao podem competir pela verdade.

Perguntas obrigatorias:

\- Qual tabela e dona do ciclo de vida?
\- Quem pode criar, corrigir, arquivar e remover?
\- Quais dados sao derivados?
\- O que acontece se o derivado atrasar?
\- Como reconstruir a leitura a partir dos fatos?

**### 7.3 Ownership e tenancy**

Escolha o modelo mais simples que atende o produto:

\- **\*\*Produto individual:\*\*** \`user\_id\` em toda linha de usuario.
\- **\*\*Workspace compartilhado:\*\*** \`tenant\_id\` em toda linha e tabela de membros com papeis.

Nao introduza organizacoes, papeis e convites em um produto individual apenas por antecipacao. Tambem nao use \`user\_id\` como atalho se colaboracao faz parte do escopo real.

Regras:

\- ownership e \`not null\`;
\- FKs apontam para tabelas canonicas;
\- policies filtram pelo tenant autenticado;
\- unicidades relevantes incluem o tenant;
\- comandos verificam ownership de todas as referencias recebidas.

**### 7.4 Identificadores**

\- Use UUID para entidades expostas externamente.
\- Nunca aceite um ID do cliente como prova de ownership.
\- IDs tecnicos nao devem aparecer em copy, exportacao comum ou logs publicos.
\- Se ordenacao temporal for dominante, avalie UUID v7 somente com suporte consistente em toda a stack.

**### 7.5 Dinheiro e quantidades**

Nunca use ponto flutuante para valores monetarios.

Opcoes:

1\. \`numeric(14,2)\` no banco e string no limite TypeScript;
2\. inteiro em menor unidade monetaria quando o dominio tiver moeda e precisao fixas.

Defina uma politica unica. Centralize:

\- parse de entrada;
\- arredondamento;
\- formatacao;
\- soma e comparacao;
\- serializacao do banco;
\- tratamento de moeda.

**### 7.6 Datas e tempo**

\- Use \`date\` para fatos cujo significado e o dia civil.
\- Use \`timestamptz\` para eventos e auditoria.
\- Armazene timestamps em UTC.
\- Defina um unico contrato para "hoje" no fuso do usuario.
\- Nao derive dia local separadamente no servidor e no cliente.
\- Retorne precisao temporal quando a UI puder receber tanto dia quanto instante.
\- Teste virada de dia, horario de verao e clientes em fusos diferentes.

**### 7.7 Status**

Persista apenas estados que representam decisao ou ciclo de vida. Derive estados temporais como "atrasado", "vence em breve" ou "precisa de atencao" em read models.

Para status que evoluem com frequencia, prefira \`text\` com \`check\` versionado a enums PostgreSQL dificeis de alterar. Toda transicao deve ter:

\- origem permitida;
\- destino permitido;
\- invariantes;
\- efeito colateral;
\- evento de auditoria quando relevante.

**### 7.8 JSONB**

Use JSONB para:

\- metadata limitada;
\- snapshots;
\- checklists variaveis;
\- payloads de eventos;
\- configuracoes que nao participam de joins centrais.

Nao use JSONB para esconder um modelo relacional indefinido. Campos consultados, filtrados ou relacionados frequentemente merecem colunas e constraints.

**### 7.9 Texto livre**

Todo texto livre deve ter limite coerente em tres camadas:

\- \`maxLength\` e contador opcional no frontend;
\- validacao no Route Handler;
\- \`check (char\_length(...) <= N)\` no banco.

Normalize apenas o necessario. Preserve o texto do usuario, mas remova caracteres de controle quando puderem quebrar exportacoes ou logs.

**### 7.10 Exclusao, arquivamento e correcao**

Use esta matriz:

\| Situacao | Estrategia |
\|---|---|
\| Nunca teve dependencia ou impacto | hard delete |
\| Tem historico, mas nao aceita novos usos | archive |
\| Fato operacional pode ser restaurado | soft delete |
\| Ja gerou efeito confirmado | ajuste/compensacao explicita |
\| Regra futura ainda nao executada | editar ou cancelar parte futura |

O backend decide se a exclusao e segura. O frontend nao deve inferir por contagens incompletas.

**### 7.11 Agendas e acordos renegociaveis**

Quando uma regra pode ser renegociada varias vezes, inclua versao ou periodo de vigencia na identidade. Uma unicidade apenas por entidade e numero de parcela, por exemplo, pode impedir uma segunda renegociacao legitima.

**### 7.12 Snapshot com override**

Snapshots servem para revisao e relatorio, nao para reescrever fatos.

Um snapshot robusto guarda:

\- periodo;
\- valores vivos no momento;
\- checklist;
\- ajustes de apresentacao;
\- motivo e observacao;
\- autor e instante;
\- status de revisao.

Se os fatos mudarem depois, o read model deriva que o snapshot divergiu. Nao persista um booleano que possa ficar desatualizado.

**---**

**## 8. Banco de dados e Supabase**

**### 8.1 Migrations como fonte de verdade**

Adote migrations versionadas desde o primeiro dia.

\- Uma migration e imutavel depois de aplicada em ambiente compartilhado.
\- Toda mudanca de schema, RLS, grant, funcao ou seed estrutural entra em migration.
\- Um snapshot de schema pode ser gerado para leitura e auditoria, mas nao e editado manualmente.
\- CI recria um banco vazio e aplica toda a cadeia.
\- Rollback de dados deve ser planejado; nao dependa apenas de \`down migration\` destrutiva.
\- Mudancas incompativeis usam expandir, migrar e contrair quando ja houver usuarios ativos.

**### 8.2 Schemas**

Estrutura recomendada:

\- \`public\`: tabelas e read models expostos deliberadamente pela Data API;
\- \`private\`: funcoes de comando, helpers e objetos internos;
\- \`auth\`: gerenciado pelo provedor de autenticacao;
\- schema opcional de auditoria se o volume justificar.

Objetos internos nunca devem ficar em \`public\` por conveniencia.

**### 8.3 Grants explicitos**

Para cada tabela publica:

1\. revogue acesso implicito;
2\. conceda apenas operacoes necessarias;
3\. nao conceda escrita ao browser se ela passar pelo DAL;
4\. nao conceda nada a \`anon\` sem caso publico real;
5\. registre a tabela em um manifesto testado de grants.

RLS nao substitui grants. Grants nao substituem RLS.

**### 8.4 RLS**

Toda tabela publica com dados privados deve:

\- habilitar RLS;
\- ter policy de leitura por ownership;
\- ter policies de escrita apenas se o browser realmente escrever;
\- validar ownership em \`using\` e \`with check\`;
\- testar isolamento entre dois usuarios;
\- evitar funcoes caras por linha nas policies.

Prefira comparar o ID autenticado uma vez por statement, conforme o plano do PostgreSQL permitir. Meca policies complexas com \`EXPLAIN\`.

**### 8.5 Read models**

Read models devem ser funcoes SQL pequenas e orientadas ao fluxo:

\- \`security invoker\` explicito;
\- \`search\_path\` controlado;
\- filtro obrigatorio pelo usuario autenticado;
\- retorno tipado e limitado;
\- sem \`select \*\`;
\- arrays top-N acompanhados de totais quando necessario;
\- filtros aplicados no servidor;
\- paginacao keyset;
\- grants de \`execute\` explicitos.

Um overview nao deve retornar todos os registros para o frontend recalcular totais.

**### 8.6 Comandos privados**

Escritas criticas devem usar funcoes privadas atomicas chamadas por uma role DAL restrita.

Regras:

\- \`security definer\` somente quando necessario;
\- \`search\_path = ''\` e objetos qualificados por schema;
\- \`execute\` revogado de \`public\`, \`anon\` e \`authenticated\`;
\- role DAL recebe apenas \`execute\` nas funcoes permitidas;
\- usuario autenticado e passado pelo servidor, nunca aceito sem verificacao;
\- referencias sao revalidadas por ownership;
\- constraints continuam sendo a ultima defesa;
\- retorno descreve o resultado autoritativo da acao.

Uma unica rota HTTP pode usar um registry de actions. No banco, prefira comandos por dominio. Se existir um dispatcher SQL, ele deve ser fino; nao transforme uma funcao gigante no backend inteiro.

**### 8.7 Atomicidade e concorrencia**

\- Alteracoes que dependem do estado atual usam transacao.
\- Use \`select ... for update\` quando duas chamadas concorrentes puderem duplicar ou corromper um efeito.
\- Defina chaves de idempotencia para comandos que possam ser repetidos por timeout ou retry.
\- Constraints unicas devem representar a invariavel final.
\- O frontend nao e lock.
\- Teste duplo clique, retry, duas abas e concorrencia real.

**### 8.8 Paginacao**

Use keyset, nao offset, em historicos crescentes.

Cursor recomendado:

\`\`\`text
(occurred\_at, id) ou (occurred\_on, sort\_key, id)
\`\`\`

Contrato:

\`\`\`ts
type Page\<T> = {
  items: T[];
  nextCursor: string | null;
};
\`\`\`

\- limite defensivo maximo, por exemplo 100;
\- filtros fazem parte da identidade da pagina;
\- mudar filtro reseta cursor;
\- \`Carregar mais\` preserva o mesmo recorte;
\- total absoluto so e calculado se a UX realmente precisar;
\- a UI deixa claro quando o contador representa itens carregados.

**### 8.9 Indices**

Nao crie indices compostos por intuicao.

Crie ou mantenha indice quando houver:

\- FK central sem cobertura adequada;
\- consulta frequente medida;
\- sort/filtro dominante comprovado;
\- policy RLS com custo relevante;
\- plano ruim observado com volume representativo.

Antes de adicionar:

1\. capture consulta real;
2\. use dados de volume plausivel;
3\. rode \`EXPLAIN (ANALYZE, BUFFERS)\`;
4\. compare escrita, armazenamento e leitura;
5\. verifique se \`unique\` ja criou indice equivalente.

**### 8.10 Auditoria**

Audite eventos que nao podem ser reconstruidos apenas pelo estado atual:

\- criacao e exclusao sensivel;
\- mudanca de configuracao relevante;
\- transicao de status;
\- correcao e restauracao;
\- acao administrativa;
\- mudanca de acesso.

Nao replique cada linha de fato em uma segunda tabela de auditoria sem necessidade. Logs de auditoria devem evitar PII desnecessaria e usar horario consistente.

**---**

**## 9. Contrato de leitura no frontend**

**### 9.1 Query keys**

Toda query key inclui o recorte que muda o resultado:

\`\`\`ts
const queryKeys = {
  overview: (userId: string, period: string) =>
    ["overview", userId, period] as const,
  history: (userId: string, filterKey: string, cursor?: string) =>
    ["history", userId, filterKey, cursor ?? "first"] as const,
};
\`\`\`

Nunca misture no mesmo cache:

\- usuarios diferentes;
\- periodos diferentes;
\- filtros diferentes;
\- modo ativo e arquivado;
\- pagina inicial e pagina seguinte.

**### 9.2 Normalizacao**

Crie normalizers na fronteira de dados para:

\- converter \`snake\_case\` em contrato local, se adotado;
\- preservar \`numeric\` com precisao;
\- validar enums/status;
\- normalizar datas sem trocar fuso;
\- preencher defaults apenas quando semanticamente seguros;
\- rejeitar payload impossivel cedo.

Componentes nao devem conhecer peculiaridades da resposta SQL.

**### 9.3 Cache e invalidacao**

Mapeie comandos para prefixos de read models afetados.

Exemplo:

\`\`\`ts
const invalidationByAction = {
  "record.create": ["overview", "history", "activity"],
  "record.update": ["overview", "history", "activity"],
  "record.delete": ["overview", "history", "activity"],
} as const;
\`\`\`

Principios:

\- create, update, delete, restore e correction invalidam os mesmos dominios derivados;
\- nao dependa de reload global;
\- o sucesso autoritativo da mutacao fecha o estado de submit;
\- invalidacoes secundarias podem ocorrer em background;
\- controles estaveis nao desaparecem durante refetch;
\- erro de refetch nao deve fingir que a mutacao falhou se ela ja foi confirmada.

**### 9.4 Server state versus UI state**

\- TanStack Query guarda estado remoto.
\- Estado React local guarda modal, modo, selecao temporaria e formulario.
\- URL guarda filtros e foco compartilhavel.
\- Preferencias de sessao usam \`sessionStorage\` quando devem morrer com a aba.
\- Preferencias visuais duraveis podem usar \`localStorage\`, sincronizadas de forma explicita.
\- Dados canonicos nunca vivem apenas em contexto React.

**### 9.5 Parametros de foco consumiveis**

Deep links podem abrir uma entidade ou aplicar um filtro. Depois de consumidos:

1\. abra/aplique uma vez;
2\. remova o parametro com replace;
3\. permita fechar o modal sem reabrir;
4\. preserve os demais filtros relevantes.

**---**

**## 10. Contrato de escrita**

**### 10.1 Fluxo de comando**

\`\`\`text
Formulario
  -> validacao local
  -> POST para Route Handler
  -> autenticacao server-side
  -> limite de corpo e rate limit
  -> validacao de action/payload
  -> DAL restrito
  -> comando transacional no banco
  -> resultado autoritativo
  -> feedback local
  -> invalidacao de read models
\`\`\`

**### 10.2 Route Handler**

Responsabilidades:

\- aceitar apenas \`POST\` para comandos;
\- validar \`Content-Type\`;
\- limitar o corpo durante o streaming, nao depois de carregar tudo;
\- validar sessao com consulta autoritativa ao provedor;
\- verificar \`Origin\`/host para requests baseados em cookie;
\- aplicar rate limit;
\- validar action e payload;
\- gerar \`requestId\`;
\- chamar DAL;
\- mapear erros sem vazar SQL, stack ou secrets.

**### 10.3 Payload de erro**

\`\`\`ts
type ApiError = {
  error: {
    code: string;
    message: string;
    requestId: string;
    fieldErrors?: Record\<string, string>;
  };
};
\`\`\`

A mensagem ao usuario e curta e acionavel. O log interno recebe contexto tecnico com dados sensiveis removidos.

**### 10.4 Rate limit**

\- Em uma unica VM, um limiter em memoria pode ser aceitavel como primeira camada.
\- Em multiplas instancias, serverless ou edge, use armazenamento compartilhado.
\- Chaves devem combinar usuario, IP normalizado e classe de acao quando adequado.
\- A falha do limiter deve ter estrategia definida: fail-open para baixo risco ou fail-closed para operacao sensivel.
\- Rate limit nao substitui CAPTCHA, RLS ou validacao.

**### 10.5 Excecoes para escrita direta do browser**

Nem toda escrita precisa atravessar o DAL privado. Escrita direta pelo cliente pode ser aceitavel para dados de baixo risco, como preferencia visual, leitura de notificacao ou progresso de onboarding, quando:

\- nao afeta fatos centrais;
\- nao coordena mais de uma tabela;
\- nao exige segredo;
\- grants e RLS limitam a linha ao proprio usuario;
\- constraints validam o contrato;
\- uma falha nao produz estado financeiro ou operacional inconsistente.

Essa e uma excecao deliberada, registrada por dominio. Na duvida, use o comando server-side.

**---**

**## 11. Autenticacao e seguranca**

**### 11.1 Sessao**

\- O browser pode observar a sessao para UX.
\- O servidor valida o usuario em toda escrita critica.
\- Nao confie apenas em dados decodificados localmente quando o provedor oferece validacao autoritativa.
\- Cookies usam \`Secure\`, \`HttpOnly\` quando aplicavel e \`SameSite\` coerente.
\- Logout invalida estado remoto e caches privados.

**### 11.2 Cadastro e recuperacao**

\- Validacao de senha local deve refletir regras reais do provedor.
\- Traduza erros conhecidos: senha fraca, email existente, link expirado, limite de tentativas.
\- Erros desconhecidos continuam genericos, acompanhados de request ID quando server-side.
\- Fluxo de reset valida o token antes de mostrar formulario de nova senha.
\- Nao revele se um email existe em fluxos de recuperacao.
\- Protecao anti-bot deve falhar de forma compreensivel e acessivel.

**### 11.3 Secrets**

\- Nunca usar role administrativa no frontend.
\- Nunca prefixar secret com convencao de variavel publica.
\- Arquivos \`.env\*\` locais ficam ignorados.
\- CI usa secrets por ambiente.
\- Logs possuem redaction para tokens, cookies, URLs de banco e chaves.
\- Rotacao e revogacao devem estar documentadas.

**### 11.4 Headers**

Centralize:

\- Content Security Policy;
\- HSTS em producao;
\- \`X-Content-Type-Options: nosniff\`;
\- politica de referrer;
\- permissions policy;
\- protecao de framing;
\- remocao de headers que revelam tecnologia.

Uma CSP deve ser testada contra scripts, estilos, fontes, CAPTCHA e conexoes realmente utilizadas. Evite liberar origens amplas para resolver erros pontuais.

**### 11.5 Dependencias e supply chain**

\- lockfile obrigatorio;
\- \`npm audit\` no gate;
\- dependencias novas exigem justificativa;
\- bibliotecas de dominio substituem implementacao caseira apenas quando reduzem risco real;
\- actions de CI fixadas;
\- builds reproduziveis;
\- nenhum pacote executa no client sem necessidade.

**### 11.6 Privacidade**

Defina cedo:

\- inventario de dados pessoais;
\- finalidade e base de tratamento;
\- retencao;
\- exportacao do usuario;
\- exclusao da conta;
\- backups e prazo de expurgo;
\- politica de logs;
\- acesso administrativo;
\- resposta a incidente.

Observabilidade nunca deve virar coleta indiscriminada de conteudo privado.

**---**

**## 12. Design system**

**### 12.1 Objetivo**

O design system deve tornar a decisao correta mais facil que uma implementacao improvisada. Ele e composto por tokens, primitives, composicoes e regras semanticas.

**### 12.2 Tokens**

Defina em CSS variables:

\- superficies e elevacoes;
\- texto primario, secundario e discreto;
\- bordas e divisores;
\- acao primaria e secundaria;
\- sucesso, aviso, perigo e informacao;
\- espacamentos em escala;
\- raios;
\- alturas de controles;
\- foco;
\- sombras de overlay;
\- camadas \`z-index\` nomeadas;
\- cores de graficos;
\- safe areas e dimensoes responsivas.

Tema e cor de destaque sao eixos separados. Tema nunca redefine cores semanticas de sucesso, aviso ou perigo.

Preferencias visuais devem ser aplicadas antes da hidratacao para evitar flicker. O bootstrap le apenas valores presentes em allowlists, aplica atributos no elemento raiz e nunca injeta texto livre em script ou CSS.

**### 12.3 Primitives essenciais**

**\*\*Acoes\*\***

\- \`Button\`
\- \`ButtonLink\`
\- \`InlineLink\`
\- \`IconButton\`

**\*\*Formularios\*\***

\- \`Field\`
\- \`Input\`
\- \`Select\`
\- \`Checkbox\`
\- \`Switch\`
\- \`PasswordInput\`
\- \`DatePicker\`
\- \`ChoiceGroup\`

**\*\*Superficies e dados\*\***

\- \`Panel\`
\- \`PageHeader\`
\- \`EmptyState\`
\- \`DataList\`
\- \`Table\`
\- \`ProgressBar\`
\- \`Badge\`
\- \`Alert\`
\- \`InfoHint\`

**\*\*Entidades\*\***

\- \`EntityCard\`: abre detalhe; nao contem botoes, links, inputs ou acoes internas.
\- \`SelectableCard\`: seleciona contexto local; usa \`aria-pressed\` ou semantica equivalente.
\- \`DataCard\`: leitura estatica ou item repetido sem comportamento de entidade.

**\*\*Layout\*\***

\- \`PageFrame\`
\- \`Stack\`
\- \`Cluster\`
\- \`ResponsiveGrid\`
\- \`FormGrid\`
\- \`ManagementSection\`

**\*\*Overlays\*\***

\- \`Modal\`
\- \`Drawer\`
\- \`BottomSheet\`
\- \`ResponsiveFilterPanel\`
\- \`Popover\`
\- \`ToastViewport\`

**\*\*Navegacao\*\***

\- \`AppShell\`
\- \`SidebarNav\`
\- \`MobileBottomNavigation\`
\- \`CursorPagination\`

**### 12.4 Cards**

\- Cards devem representar objetos ou unidades repetidas, nao cada secao da pagina.
\- Nao colocar card dentro de card.
\- O card inteiro e clicavel quando abre uma entidade.
\- Acoes ficam no modal de detalhe.
\- Titulo suporta nomes longos sem explodir layout.
\- Meta trunca de forma previsivel; detalhe mostra texto completo.
\- Badges nao espremem valor principal.
\- Grids usam colunas estaveis e largura maxima coerente.

**### 12.5 Modais**

Contrato recomendado:

\- abre primeiro em detalhe;
\- \`Editar\` muda de modo explicitamente;
\- \`Salvar\` e \`Descartar\` ficam em posicao previsivel;
\- fechar durante edicao descarta por default ou confirma quando houver perda relevante;
\- acoes destrutivas ficam dentro do modal e mostram impacto;
\- foco inicial vai para painel ou campo intencional, nunca rouba digitacao;
\- foco e restaurado ao trigger;
\- \`Escape\` fecha quando seguro;
\- scroll do fundo e bloqueado;
\- overlays portados respeitam o modal ativo;
\- stack de modais e deliberada, nao acidental.

No celular:

\- fluxo curto usa bottom sheet;
\- fluxo longo usa fullscreen;
\- CTA permanece acessivel;
\- teclado nao cobre o campo ativo;
\- safe area inferior e respeitada.

**### 12.6 Popovers, tooltips e info hints**

\- Hover nunca pode ser a unica forma de acesso.
\- No touch, icone de informacao abre conteudo por tap.
\- Popover usa portal, contencao na viewport e inversao vertical.
\- Clique fora e \`Escape\` fecham.
\- O conteudo nao cria scroll estranho no modal.
\- Tooltips nomeiam icones; nao carregam informacao essencial longa.

**### 12.7 Formularios**

\- Labels continuam visiveis; placeholder nao substitui label.
\- Erro aparece junto ao campo.
\- Inputs numericos preservam foco durante atualizacao.
\- Dependencia vazia mostra mensagem factual e CTA para criar o requisito.
\- Criacao rapida preserva o formulario original e seleciona o novo item.
\- Validacao evita envio impossivel, mas o servidor continua autoritativo.
\- Textos de ajuda so existem quando reduzem duvida real.

**### 12.8 Datas**

Use um date picker operacional compartilhado:

\- data unica;
\- intervalo opcional;
\- mes;
\- navegacao direta por ano;
\- destaque para hoje/mes atual;
\- limites minimo e maximo;
\- portal e posicionamento adaptativo;
\- teclado e leitores de tela;
\- formato visual local, valor de contrato ISO.

**### 12.9 Feedback**

\- Erro de formulario fica no formulario.
\- Toast comunica sucesso ou evento global temporario.
\- Toast nao cobre navegacao, notificacao ou safe area.
\- Toast nao e mecanismo principal de desfazer acao importante.
\- Loading inicial ocupa a secao de modo estavel.
\- Refetch em background nao desmonta controles.
\- Empty state explica o que falta e oferece proxima acao.

**### 12.10 Graficos**

Use grafico apenas quando ele melhora comparacao ou tendencia.

\- Sempre forneca valor textual equivalente.
\- Tooltip precisa de contraste em todos os temas.
\- Mobile nao depende de hover.
\- Poucos dados nao devem produzir um grafico visualmente quebrado.
\- Escalas, zeros e valores negativos precisam de tratamento explicito.
\- Paleta respeita semantica, daltonismo e contraste.

**### 12.11 Secoes operacionais**

Telas de gerenciamento repetem um contrato previsivel:

\- header com titulo, descricao curta, contador e acao de criar;
\- filtro discreto no header quando o formulario esta fechado;
\- formulario a esquerda e lista a direita no desktop, quando aberto;
\- filtro no subheader da lista quando o formulario ocupa a lateral;
\- lista usa toda a largura quando o formulario fecha;
\- estado vazio abre a criacao e explica o proximo passo;
\- mobile abre criacao em modal ou tela dedicada, nunca espreme o formulario ao lado da lista;
\- preferencia temporaria de aberto/fechado pode sobreviver durante a aba, sem virar dado remoto;
\- filtros ficam acima das colunas que controlam em listas tabulares;
\- rows de historico possuem colunas estaveis no desktop e composicao empilhada no mobile;
\- altura minima decorativa e permitida somente no desktop e nao centraliza conteudo no eixo vertical.

Com keyset pagination, a interface usa \`Carregar mais\`, \`Anterior/Proximo\` ou cursores navegaveis. Nao apresente numeros de pagina falsos sem um total e uma semantica de offset confiaveis.

**---**

**## 13. Responsividade e mobile**

**### 13.1 Mobile nao e desktop encolhido**

Preserve contratos funcionais, mas permita composicao diferente.

Classes de referencia:

\- telefone compacto: abaixo de 600px;
\- tablet/intermediario: 600px a 1023px;
\- desktop: 1024px ou mais;
\- altura compacta: media query adicional para teclados e paisagem.

**### 13.2 Regras**

\- Alvos de toque com pelo menos 44px; controles primarios preferencialmente 48px.
\- Fonte de input com 16px para evitar zoom automatico no iOS.
\- Suporte a 320px de largura sem scroll horizontal da pagina.
\- Suporte a zoom de texto de 200%.
\- Use \`dvh\` e safe-area insets.
\- Bottom navigation contem poucas rotas primarias.
\- Drawer \`Mais\` pode listar todas as rotas, inclusive as primarias.
\- Barra inferior nao flutua acima da borda por erro de viewport/safe area.
\- Tabelas viram rows compactas ou listas sem perder significado.
\- Formularios inline de desktop viram modal ou tela dedicada.
\- Cards perdem altura decorativa e priorizam densidade.

**### 13.3 Filtros mobile**

Filtros complexos nao devem ocupar o topo inteiro da lista.

Padrao:

1\. botao \`Filtros\` com quantidade ativa;
2\. bottom sheet/fullscreen com todos os campos;
3\. \`Aplicar\` e \`Limpar\` persistentes;
4\. chips resumem filtros ativos quando util;
5\. estado pertence a rota, nao ao primitive;
6\. abrir/fechar painel nao dispara consulta incompleta;
7\. deep links aparecem nos controles, nao apenas em um aviso generico.

**### 13.4 Protecao do desktop**

Uma refatoracao mobile deve provar que desktop nao mudou:

\- classes mobile dentro de media queries explicitas;
\- screenshots desktop antes/depois;
\- cenarios E2E nas duas composicoes;
\- sem alterar tokens globais para corrigir apenas telefone;
\- primitives compartilham semantica, mas podem renderizar estruturas responsivas distintas.

**---**

**## 14. UX e linguagem**

**### 14.1 Ensine no fluxo**

O produto deve explicar:

\- o que esta acontecendo;
\- por que isso importa;
\- qual e a proxima acao.

Evite textos que descrevem implementacao, banco, sincronizacao ou termos internos.

**### 14.2 Copy**

\- curta;
\- natural;
\- factual;
\- sem jargao desnecessario;
\- com verbos de acao claros;
\- sem explicar o obvio;
\- sem prometer resultado que depende de configuracao faltante.

Uma boa mensagem de dependencia vazia e: "Nenhum item cadastrado" acompanhada de \`Criar item\`. Nao use frases artificiais como "crie primeiro" se a ordem ja estiver clara.

**### 14.3 Onboarding**

\- separado da tela principal;
\- nao bloqueia uso normal;
\- conclusao deriva de dados reais;
\- etapas opcionais aceitam \`Pular\`;
\- volta a consultar estado ao entrar na rota;
\- permite refresh explicito se houver latencia inevitavel;
\- orienta uma sequencia recomendada sem transforma-la em regra.

**### 14.4 Dependencias opcionais**

Quando o dominio permitir, registros podem existir sem relacionamento auxiliar. A UI explica a perda de contexto ou insight, mas nao impede o usuario.

Quando a dependencia for obrigatoria:

\- explique a ausencia;
\- ofereca criacao no contexto;
\- preserve os dados ja digitados;
\- retorne e selecione o novo item.

**### 14.5 Historico e atividade**

Uma timeline agregada serve para transparencia e navegacao, nao para editar todos os dominios em um lugar.

\- mostra data, dominio, acao, impacto, status e origem;
\- suporta filtros server-side e paginacao;
\- links levam ao dono da correcao;
\- filtros recebidos por deep link ficam visiveis;
\- horarios respeitam fuso e precisao;
\- exclusao no dominio nao apaga necessariamente a evidencia auditavel.

**### 14.6 Guias**

Guias internos sao documentacao de produto:

\- escritos para leigos;
\- visuais e curtos;
\- mostram a tela e a tarefa;
\- nao citam tecnologia;
\- mudam no mesmo PR que o fluxo correspondente;
\- usam o mesmo design system da aplicacao.

**### 14.7 Exportacao**

Exportacoes devem ser produtos de informacao, nao dumps de tabela.

\- ofereca um relatorio consolidado quando varios arquivos fragmentados nao agregarem valor;
\- permita escolher periodo;
\- diferencie visao viva de snapshot revisado;
\- use titulos, secoes, moeda, datas e totais compreensiveis;
\- remova IDs tecnicos e colunas internas;
\- CSV possui cabecalhos estaveis, encoding conhecido e uma linha por unidade util;
\- PDF e gerado com layout proprio, nao por screenshot da pagina;
\- exportacoes grandes podem ser processadas assincronamente;
\- acesso e ownership sao revalidados no servidor.

**### 14.8 Notificacoes**

Notificacoes existem para levar a uma decisao:

\- copy informa o motivo e a acao;
\- CTA usa deep link consumivel;
\- abrir o alvo nao repete indefinidamente o evento;
\- concluir a acao atualiza a notificacao e os read models relacionados;
\- falha permanece visivel e permite nova tentativa;
\- notificacoes nao substituem estados de atencao na tela dona do dominio.

**### 14.9 Superficie publica**

A pagina publica e a aplicacao autenticada possuem objetivos visuais diferentes.

\- landing page comunica publico, problema, beneficio e confianca;
\- metadata, canonical, sitemap e dados estruturados apoiam SEO;
\- conteudo publico nao depende de sessao ou JavaScript para ser indexado;
\- CTA principal e claro;
\- imagens mostram o produto ou resultado real;
\- a area operacional continua densa e orientada a trabalho, sem herdar composicao de marketing;
\- uma demo read-only pode reduzir friccao, desde que writes encaminhem claramente para autenticacao.

**---**

**## 15. Acessibilidade**

Minimo obrigatorio:

\- landmarks e headings em ordem;
\- labels associados;
\- foco visivel;
\- navegacao completa por teclado;
\- trap e restauracao de foco em modal;
\- nome acessivel para icon buttons;
\- \`aria-pressed\` em selecao toggle;
\- mensagens de erro anunciadas;
\- contraste WCAG AA;
\- informacao nao depende apenas de cor;
\- animacao respeita \`prefers-reduced-motion\`;
\- layout funciona com zoom e texto ampliado;
\- touch target adequado;
\- graficos possuem resumo textual.

Teste acessibilidade tanto no primitive quanto no fluxo completo.

**---**

**## 16. Performance e eficiencia de custos**

**### 16.1 Principios**

\- Calcule perto dos dados quando isso reduz transferencia e duplicacao.
\- Retorne apenas o necessario para a tela.
\- Cacheie por recorte correto.
\- Nao mantenha infraestrutura remota ociosa.
\- Nao crie index, fila, cache distribuido ou materialized view sem evidencia.
\- Nao espere um incidente para instrumentar o caminho critico.

**### 16.2 Banco**

\- leituras agregadas em read models;
\- filtros server-side;
\- keyset pagination;
\- arrays limitados;
\- conexao pequena e adequada ao runtime;
\- transaction pooling em serverless;
\- pool persistente limitado em VM;
\- queries sem N+1;
\- plano medido antes de indexar;
\- jobs pesados fora da request quando necessario.

**### 16.3 Frontend**

\- componentes de servidor por default quando nao precisam de interacao;
\- client components nas bordas interativas;
\- lazy load para modais/graficos pesados quando mensuravelmente util;
\- cache remoto com stale time coerente;
\- evitar provider global que rerenderiza tudo;
\- nao duplicar arrays grandes em varios estados;
\- imagens dimensionadas e otimizadas;
\- loading estavel para evitar layout shift.

**### 16.4 Custos observaveis**

Monitore separadamente:

\- compute da aplicacao;
\- conexoes e compute do banco;
\- armazenamento e backup;
\- egress da VM;
\- egress do banco;
\- logs e retencao;
\- servicos externos;
\- ambientes nao produtivos.

Uma metrica total de custo sem origem dificulta acao corretiva.

**---**

**## 17. Observabilidade**

**### 17.1 Logs estruturados**

Todo log server-side relevante inclui:

\- timestamp;
\- level;
\- environment;
\- service;
\- requestId;
\- route/action;
\- duracao;
\- resultado;
\- codigo de erro seguro;
\- user/tenant pseudonimizado quando indispensavel.

Nunca inclua token, cookie, URL com credencial, senha, payload livre completo ou segredo.

**### 17.2 Metricas minimas**

\- taxa de requests por rota;
\- latencia p50/p95/p99;
\- erros 4xx e 5xx;
\- falhas por action;
\- saturacao de CPU/memoria;
\- conexoes do banco;
\- queries lentas;
\- tamanho e crescimento do banco;
\- sucesso/falha de deploy;
\- sucesso de jobs;
\- funil tecnico de cadastro/login/reset sem PII;
\- Core Web Vitals.

**### 17.3 Alertas**

Alertar apenas quando houver acao:

\- indisponibilidade;
\- taxa de 5xx acima do baseline;
\- latencia sustentada;
\- falha de backup;
\- disco/memoria perto do limite;
\- erro anormal de autenticacao;
\- deploy sem health check;
\- expiracao de certificado.

**### 17.4 Rastreamento de erros**

Uma ferramenta de error tracking pode ser adotada com:

\- sourcemaps protegidos;
\- sampling;
\- scrub de PII;
\- environment e release identificados;
\- breadcrumbs limitados;
\- custo e retencao controlados.

Comece com saude tecnica, nao com analytics comportamental excessivo.

**---**

**## 18. Testes e QA**

**### 18.1 Piramide de protecao**

1\. **\*\*Lint e tipos:\*\*** erros de contrato e padrao.
2\. **\*\*Unitarios:\*\*** helpers, normalizers, validacoes e decisoes puras.
3\. **\*\*Guardrails de schema:\*\*** RLS, grants, funcoes, constraints, indices e ausencia de legado.
4\. **\*\*Integracao local:\*\*** comandos, read models, concorrencia e isolamento.
5\. **\*\*E2E:\*\*** jornadas reais e regressao visual/responsiva.
6\. **\*\*Smoke de deploy:\*\*** processo, health endpoint e HTTPS.

**### 18.2 Catalogo de cenarios**

Cada comportamento possui:

\- ID estavel;
\- prioridade \`P0\`, \`P1\` ou \`P2\`;
\- suite;
\- tipo;
\- rota/dominio;
\- pre-condicao;
\- passos;
\- resultado esperado;
\- status de automacao;
\- spec responsavel.

Exemplo:

\`\`\`markdown
\| ID | Prioridade | Suite | Tipo | Cenario | Automatizado | Spec |
\|---|---|---|---|---|---|---|
\| DOM-010 | P0 | critical | funcional | comando cria fato uma unica vez | sim | domain.spec.ts |
\`\`\`

**### 18.3 Guardrails de banco**

Testes devem falhar quando:

\- uma tabela publica nao esta no manifesto;
\- falta RLS ou policy;
\- existe grant amplo;
\- \`anon\` recebeu acesso privado;
\- funcao privilegiada tem \`search\_path\` inseguro;
\- alias legado reaparece;
\- read model perde filtro de ownership;
\- paginacao perde cursor/limite;
\- input perde constraint;
\- migration e snapshot divergem.

**### 18.4 E2E**

Suites:

\- **\*\*smoke:\*\*** paginas publicas, demo e disponibilidade basica;
\- **\*\*critical:\*\*** auth e jornadas P0;
\- **\*\*regression:\*\*** fluxos amplos, correcoes, mobile e edge cases.

Regras:

\- somente localhost e banco local;
\- falhar antes do browser se o ambiente for inseguro;
\- UI para o comportamento em teste;
\- helper de banco apenas para setup, cleanup ou evidencia impossivel pela UI;
\- locators por papel/nome antes de CSS;
\- nomes de dados com prefixo de QA;
\- cleanup restrito ao prefixo e ambiente local;
\- traces, screenshots e videos apenas em falha e ignorados pelo Git;
\- uma unica worker quando o estado compartilhado exigir previsibilidade.

**### 18.5 Matriz responsiva**

No minimo:

\- telefone estreito;
\- telefone comum;
\- tablet;
\- desktop;
\- desktop largo;
\- altura curta;
\- zoom/texto ampliado nos fluxos centrais.

Valide:

\- ausencia de overflow;
\- CTA acessivel;
\- teclado e safe area;
\- modal/popover;
\- filtros;
\- nomes longos;
\- estados vazio/loading/erro;
\- graficos nao vazios;
\- desktop nao alterado por CSS mobile.

**### 18.6 Relatorio de QA**

O pipeline gera um relatorio consolidado com:

\- comandos;
\- duracao;
\- suites e cenarios;
\- falhas e artefatos;
\- ambiente;
\- commit;
\- pendencias conhecidas.

Timeout sem resumo do runner e inconclusivo. Encerre processos orfaos, estabilize ambiente e execute novamente.

**---**

**## 19. Infraestrutura e deploy**

**### 19.1 Runtime**

Uma implantacao simples e robusta pode usar:

\- build standalone do Next.js;
\- VM Linux;
\- processo systemd sem root;
\- porta interna em loopback;
\- Nginx como reverse proxy;
\- HTTPS automatizado;
\- firewall expondo apenas o necessario.

**### 19.2 Releases atomicos**

\`\`\`text
/opt/app/
\|-- releases/\<git-sha>/
\|-- current -> releases/\<git-sha>/
\`-- shared/.env
\`\`\`

Fluxo:

1\. build em CI;
2\. upload para diretorio do SHA;
3\. instalar/copiar artefatos necessarios;
4\. apontar symlink \`current\` atomicamente;
5\. reiniciar servico;
6\. executar health check interno;
7\. executar smoke HTTPS;
8\. reverter symlink se falhar.

**### 19.3 Hardening**

\- usuario dedicado sem shell administrativo;
\- \`NoNewPrivileges\`;
\- \`PrivateTmp\`;
\- protecao de home e sistema;
\- limites de memoria/processo quando apropriados;
\- logs em journald com retencao;
\- SSH restrito;
\- atualizacoes de seguranca;
\- certificados monitorados.

**### 19.4 Pipeline**

PR:

\- install reproduzivel;
\- lint;
\- unitarios;
\- typecheck;
\- build;
\- audit;
\- knip;
\- schema/grants;
\- E2E conforme custo e criticidade.

Deploy:

\- concurrency por ambiente;
\- approval para producao quando necessario;
\- migration antes de ativar codigo dependente;
\- secrets de environment;
\- release por SHA;
\- health check;
\- rollback.

**### 19.5 Migrations em producao**

\- Nunca editar banco manualmente como fluxo normal.
\- Migration destrutiva requer backup e plano de recuperacao.
\- Para mudanca incompativel: adicionar novo contrato, backfill, migrar leitores/escritores, verificar, remover antigo depois.
\- Registre versao aplicada.
\- Bloqueie deploy se migration falhar.
\- Nao use acceptance/production para E2E destrutivo.

**### 19.6 Backup e recuperacao**

\- politica de backup documentada;
\- retencao proporcional ao risco;
\- restore testado periodicamente;
\- RPO e RTO conhecidos;
\- backup antes de migration critica;
\- procedimento de incidente acessivel sem depender de uma pessoa.

**---**

**## 20. Backoffice**

O backoffice e uma aplicacao separada, nao uma rota escondida da aplicacao publica.

Regras:

\- pasta/app independente;
\- build e porta proprios;
\- nenhuma rota publicada no app principal;
\- acesso local, VPN ou rede administrativa;
\- secrets somente server-side;
\- role administrativa nunca enviada ao browser;
\- sessao curta e confirmacao forte para destruicao;
\- preview de impacto antes de executar;
\- auditoria de operador, acao, alvo, instante e resultado;
\- nenhuma PII desnecessaria no log;
\- operacoes idempotentes quando possivel;
\- exclusao de usuario cobre Auth, dados, storage e integracoes;
\- dry-run para limpezas complexas;
\- testes garantem que o app publico nao expoe rotas administrativas.

Uma chave local de desbloqueio protege contra operacao acidental naquele runtime; ela nao substitui controle de acesso ao host e aos secrets.

**---**

**## 21. Documentacao viva**

**### 21.1 Contrato documental**

\| Documento | Responsabilidade |
\|---|---|
\| README | setup, comandos, status e deploy de alto nivel |
\| Contexto | estado tecnico atual suficiente para continuidade |
\| Roadmap | prioridades e escopo de produto |
\| UX blueprint | rotas, intencoes e fluxos |
\| Design system | tokens, primitives e regras visuais |
\| Banco | tabelas, relacoes, RLS, grants, funcoes e indices |
\| Infraestrutura | ambientes, hosting, CI/CD e operacao |
\| QA plan | catalogo de cenarios e cobertura |
\| Divida tecnica | risco, prioridade e criterio de resolucao |
\| ADRs | decisoes arquiteturais com alternativas e consequencias |

**### 21.2 Regra de atualizacao**

No mesmo PR:

\- schema muda -> banco, contexto, tipos e QA;
\- fluxo muda -> UX, guia interno e QA;
\- primitive muda -> design system e testes;
\- infraestrutura muda -> README, contexto e infraestrutura;
\- divida nasce ou termina -> registro de dividas;
\- decisao estrutural muda -> ADR.

Documentos temporarios de estudo devem ser removidos ou convertidos em decisao viva quando deixam de ter valor operacional.

**### 21.3 ADR minimo**

\`\`\`markdown
**# ADR-NNN: Titulo**

**## Contexto**
Qual problema exige decisao?

**## Decisao**
Qual contrato foi escolhido?

**## Alternativas**
O que foi considerado e por que nao foi escolhido?

**## Consequencias**
Custos, beneficios, riscos e criterio de revisao.
\`\`\`

**---**

**## 22. Anti-padroes a evitar**

**### Arquitetura**

\- provider global que concentra todos os dominios;
\- pagina que baixa toda a base para calcular um KPI;
\- frontend coordenando transacoes multipasso;
\- uma tabela/read model virando fonte canonica paralela;
\- dispatcher SQL monolitico sem modulos;
\- compatibilidade legada sem consumidor real;
\- regra rigida baseada em uma suposicao de UX.

**### Banco**

\- nova tabela publica sem grant e RLS explicitos;
\- \`security definer\` com \`search\_path\` aberto;
\- \`select \*\` em contrato publicado;
\- offset pagination em historico grande;
\- indice preventivo sem plano;
\- JSONB para relacoes centrais;
\- timestamps usados para fatos que sao apenas datas;
\- texto livre sem limite;
\- hard delete de dado com impacto.

**### Frontend**

\- card com botoes internos e clique no card;
\- card dentro de card;
\- hover como unico acesso a informacao;
\- filtro invisivel aplicado por deep link;
\- loading que remove controles estaveis;
\- erro global para problema de um campo;
\- toast como unica chance de desfazer;
\- desktop apenas espremido no celular;
\- mudanca global de token para corrigir um breakpoint.

**### Operacao**

\- testar contra producao;
\- secret em variavel publica;
\- deploy sem health check ou rollback;
\- migration manual nao versionada;
\- logs com payloads e tokens;
\- backup nunca restaurado;
\- ambiente remoto ocioso sem justificativa;
\- backoffice escondido na aplicacao publica.

**---**

**## 23. Fluxo de implementacao de uma nova plataforma**

**### Fase 0 - Definicao**

\- definir persona, problema e limite do produto;
\- listar fatos, regras, previsoes e snapshots;
\- decidir tenancy;
\- escrever principios de flexibilidade e correcao;
\- mapear rotas por intencao;
\- criar ADRs iniciais.

**### Fase 1 - Fundacao**

\- scaffold Next.js/TypeScript strict;
\- lint, Vitest, Playwright e Knip;
\- tokens e primitives basicos;
\- Supabase local e migrations;
\- autenticacao;
\- headers e tratamento de erro;
\- CI inicial.

**### Fase 2 - Primeiro corte vertical**

Implemente um fluxo completo:

1\. tabela com ownership, grants e RLS;
2\. read model;
3\. comando privado;
4\. API autenticada;
5\. query/cache;
6\. tela responsiva;
7\. correcao/exclusao;
8\. testes unitarios, banco e E2E;
9\. docs.

Esse corte valida a formula antes de multiplicar dominios.

**### Fase 3 - Sistema operacional do produto**

\- onboarding;
\- navegacao;
\- atividade/auditoria;
\- filtros e paginacao;
\- exportacao;
\- preferencias visuais;
\- empty/loading/error states;
\- guias do usuario.

**### Fase 4 - Producao**

\- deploy standalone;
\- migrations automatizadas;
\- health checks e rollback;
\- observabilidade;
\- backup e restore;
\- privacy/export/delete;
\- backoffice separado;
\- teste de carga dos caminhos centrais.

**### Fase 5 - Escala orientada por evidencia**

Somente depois de medir:

\- novos indices;
\- cache distribuido;
\- filas;
\- materialized views;
\- replicas;
\- horizontal scaling;
\- particionamento;
\- CDN/edge adicional.

**---**

**## 24. Checklists de mudanca**

**### 24.1 Nova tabela publica**

\- [ ] classe do dado definida;
\- [ ] ownership/tenant \`not null\`;
\- [ ] FKs e \`on delete\` deliberados;
\- [ ] checks e limites;
\- [ ] migration versionada;
\- [ ] grants minimos;
\- [ ] RLS habilitada;
\- [ ] policies de isolamento;
\- [ ] manifesto de schema/grants;
\- [ ] tipos atualizados;
\- [ ] docs de banco;
\- [ ] QA plan;
\- [ ] teste entre dois usuarios;
\- [ ] estrategia de delete/archive/correction.

**### 24.2 Novo comando**

\- [ ] action nomeada por intencao;
\- [ ] sessao server-side;
\- [ ] payload limitado e validado;
\- [ ] ownership de referencias;
\- [ ] transacao/lock quando necessario;
\- [ ] idempotencia avaliada;
\- [ ] retorno autoritativo;
\- [ ] erro seguro com request ID;
\- [ ] invalidacoes mapeadas;
\- [ ] evento de auditoria avaliado;
\- [ ] testes de sucesso, erro, concorrencia e retry.

**### 24.3 Novo read model**

\- [ ] necessidade da tela definida;
\- [ ] sem fonte canonica paralela;
\- [ ] \`security invoker\`;
\- [ ] ownership;
\- [ ] colunas explicitas;
\- [ ] filtro server-side;
\- [ ] limite defensivo;
\- [ ] keyset se paginado;
\- [ ] total apenas se necessario;
\- [ ] query key completa;
\- [ ] normalizer;
\- [ ] plano medido se consulta relevante.

**### 24.4 Nova rota ou fluxo**

\- [ ] intencao do usuario clara;
\- [ ] empty, loading, error e success;
\- [ ] desktop, mobile e altura curta;
\- [ ] teclado e leitor de tela;
\- [ ] dependencias vazias;
\- [ ] correcao e acao destrutiva;
\- [ ] deep link/foco;
\- [ ] copy para leigos;
\- [ ] guia interno;
\- [ ] cenarios QA catalogados.

**### 24.5 Novo primitive**

\- [ ] problema aparece em mais de um fluxo;
\- [ ] API pequena e semantica;
\- [ ] CSS variables existentes;
\- [ ] estados e variantes necessarios;
\- [ ] acessibilidade;
\- [ ] mobile e desktop;
\- [ ] nomes longos e zoom;
\- [ ] testes;
\- [ ] documentacao no design system;
\- [ ] nenhuma abstracao criada apenas para esconder uma classe.

**### 24.6 Antes do merge**

\- [ ] diff revisado e sem artefatos/secrets;
\- [ ] lint;
\- [ ] unitarios;
\- [ ] typecheck;
\- [ ] build;
\- [ ] audit;
\- [ ] knip;
\- [ ] diff check;
\- [ ] schema/grants se aplicavel;
\- [ ] E2E relevante;
\- [ ] docs atualizadas;
\- [ ] comentarios de review avaliados e resolvidos;
\- [ ] rollback conhecido.

**---**

**## 25. Templates tecnicos**

**### 25.1 Tabela tenant-owned**

\`\`\`sql
create table public.domain\_records (
  id uuid primary key default gen\_random\_uuid(),
  user\_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char\_length(name) between 1 and 120),
  period date not null check (period = date\_trunc('month', period)::date),
  amount numeric(14,2) not null default 0,
  notes text check (notes is null or char\_length(notes) <= 2000),
  archived\_at timestamptz,
  created\_at timestamptz not null default now(),
  updated\_at timestamptz not null default now(),
  unique (user\_id, name)
);

create index domain\_records\_user\_period\_created\_idx
on public.domain\_records (user\_id, period, created\_at desc);

alter table public.domain\_records enable row level security;

revoke all on table public.domain\_records from anon, authenticated;
grant select on table public.domain\_records to authenticated;

create policy domain\_records\_select\_own
on public.domain\_records
for select
to authenticated
using ((select auth.uid()) = user\_id);
\`\`\`

Se o browser precisar escrever, adicione policies e grants por operacao. Caso contrario, mantenha escrita apenas no DAL.

O indice do exemplo existe porque o read model seguinte filtra por \`user\_id\` e \`period\` e ordena por criacao. Remova ou altere o indice se esse nao for o caminho real. Atualizacoes devem definir \`updated\_at = now()\` no comando ou usar um trigger compartilhado e testado.

**### 25.2 Read model**

\`\`\`sql
create or replace function public.get\_domain\_overview(p\_period date)
returns table (
  total numeric,
  active\_count bigint,
  items jsonb
)
language sql
stable
security invoker
set search\_path = public
as $$
  select
    coalesce(sum(r.amount), 0)::numeric as total,
    count(\*) filter (where r.archived\_at is null) as active\_count,
    coalesce(
      jsonb\_agg(
        jsonb\_build\_object('id', r.id, 'name', r.name)
        order by r.created\_at desc
      ) filter (where r.position <= 10),
      '[]'::jsonb
    ) as items
  from (
    select d.\*, row\_number() over (order by d.created\_at desc) as position
    from public.domain\_records d
    where d.user\_id = (select auth.uid())
      and d.period = p\_period
  ) r;
$$;

revoke all on function public.get\_domain\_overview(date) from public, anon;
grant execute on function public.get\_domain\_overview(date) to authenticated;
\`\`\`

O exemplo deve ser adaptado ao schema real e validado com plano de execucao.

**### 25.3 Comando privado**

\`\`\`sql
create or replace function private.create\_domain\_record(
  p\_user\_id uuid,
  p\_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search\_path = ''
as $$
declare
  v\_record public.domain\_records;
begin
  if p\_user\_id is null then
    raise exception using errcode = '22023', message = 'invalid\_user';
  end if;

  insert into public.domain\_records (user\_id, name, period, amount, notes)
  values (
    p\_user\_id,
    nullif(btrim(p\_payload->>'name'), ''),
    (p\_payload->>'period')::date,
    (p\_payload->>'amount')::numeric,
    nullif(btrim(p\_payload->>'notes'), '')
  )
  returning \* into v\_record;

  return jsonb\_build\_object('id', v\_record.id, 'created', true);
end;
$$;

revoke all on function private.create\_domain\_record(uuid, jsonb)
from public, anon, authenticated;
grant execute on function private.create\_domain\_record(uuid, jsonb)
to app\_dal;
\`\`\`

**### 25.4 Route Handler simplificado**

\`\`\`ts
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  try {
    assertTrustedOrigin(request);
    const user = await requireAuthenticatedUser();
    await enforceRateLimit({ request, userId: user.id });
    const body = await readLimitedJson(request, 128 \* 1024);
    const command = parseCommand(body);
    const result = await executeCommand(user.id, command);

    return Response.json({ data: result, requestId });
  } catch (error) {
    const safe = mapSafeApiError(error, requestId);
    logServerError({ error, requestId, route: "commands" });
    return Response.json(safe.body, { status: safe.status });
  }
}
\`\`\`

**### 25.5 Registry de comandos**

\`\`\`ts
const commandHandlers = {
  "record.create": createRecord,
  "record.update": updateRecord,
  "record.archive": archiveRecord,
  "record.deleteSafe": deleteRecordSafe,
} satisfies Record\<string, CommandHandler>;
\`\`\`

O registry fica modular. Actions removidas nao ganham alias indefinido.

**---**

**## 26. Definition of Done**

Uma feature esta concluida quando:

**### Produto**

\- resolve uma intencao clara;
\- copy e fluxo sao compreensiveis;
\- nao introduz bloqueio desnecessario;
\- permite correcao coerente;
\- previsao e fato estao distintos;
\- estados vazios orientam.

**### Arquitetura**

\- fonte canonica e ownership estao claros;
\- leitura e escrita seguem os contratos;
\- cache e invalidacao estao corretos;
\- nao existe duplicacao desnecessaria;
\- legado removido quando nao ha compatibilidade exigida.

**### Banco e seguranca**

\- migration versionada;
\- constraints, grants e RLS;
\- comandos atomicos;
\- inputs limitados;
\- secrets protegidos;
\- erros seguros;
\- auditoria avaliada.

**### UI**

\- usa primitives do design system;
\- desktop e mobile completos;
\- acessivel por teclado e touch;
\- sem overflow, sobreposicao ou foco quebrado;
\- loading, erro e feedback adequados;
\- nomes longos e zoom testados.

**### Qualidade**

\- cenarios catalogados;
\- testes relevantes verdes;
\- schema guard atualizado;
\- E2E local;
\- build e audit verdes;
\- codigo morto removido;
\- docs e guias atualizados.

**### Operacao**

\- logs e metricas suficientes;
\- deploy e rollback conhecidos;
\- custo adicional entendido;
\- suporte/backoffice cobrem o novo comportamento quando necessario.

**---**

**## 27. Formula resumida**

1\. Modele fatos, regras, previsoes, eventos e snapshots separadamente.
2\. Escolha uma fonte canonica por conceito.
3\. Proteja toda linha por ownership, grants explicitos e RLS.
4\. Leia por read models pequenos, filtrados e paginados.
5\. Escreva por comandos server-side atomicos e restritos.
6\. Trate correcao, arquivamento e reversao como parte do dominio.
7\. Use cache por usuario, periodo, filtro e cursor; invalide por impacto.
8\. Construa um design system semantico antes de multiplicar telas.
9\. Trate mobile como composicao propria e preserve desktop por contrato.
10\. Oriente o usuario em linguagem simples; pergunte quando houver ambiguidade.
11\. Automatize schema, seguranca, fluxos P0 e responsividade.
12\. Use migrations, deploy atomico, health check, rollback e backup testado.
13\. Observe saude e custos sem coletar dados excessivos.
14\. Separe backoffice e secrets da aplicacao publica.
15\. Atualize documentacao e QA no mesmo PR da mudanca.
16\. Escale infraestrutura apenas depois de medir.

Essa combinacao produz uma plataforma que continua simples para o usuario, explicavel para a equipe e segura para evoluir.