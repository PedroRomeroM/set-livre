# Ciclo obrigatório de review e deploy

Este contrato vale para toda mudança destinada a `main`. Ele usa recursos nativos do GitHub; não
existe um segundo sistema de aprovação dentro do Supabase ou do repositório.

## 1. Preparação

1. Atualizar `main` a partir de `origin/main`.
2. Criar uma branch `codex/<slug>` para uma única mudança coerente.
3. Implementar código, migrations, testes e documentação permanente afetada.
4. Executar os gates proporcionais durante o desenvolvimento e todos os gates obrigatórios antes do
   commit candidato.

Correção de bug visível exige teste de regressão no nível mais próximo do comportamento. Não se cria
teste apenas para espelhar detalhes internos sem risco demonstrado.

## 2. Pull request

1. Fazer commit e push somente depois dos gates locais aplicáveis.
2. Abrir PR não draft para `main`.
3. Aguardar todos os checks obrigatórios em estado terminal e verde.
4. Comentar `@codex review` e registrar o horário da solicitação.
5. Esperar pelo menos 60 minutos reais antes de avaliar o resultado.

Timeout, interrupção, ausência de resposta ou indisponibilidade externa são inconclusivos. Nenhum
deles equivale a aprovação.

## 3. Superfícies de review

Depois da espera, inspecionar todas as superfícies disponíveis:

- reviews formais;
- comentários gerais do PR;
- comentários inline;
- threads de review, inclusive minimizadas;
- checks e anotações dos workflows.

Cada finding aplicável é corrigido na causa. A mesma falha deve ser procurada em superfícies
equivalentes e, quando faria diferença, coberta por teste de regressão. Finding rejeitado recebe uma
justificativa técnica curta no PR.

Threads corrigidas ou justificadas são resolvidas. Não se resolve thread sem tratar ou responder ao
conteúdo.

## 4. Novo ciclo após qualquer push

Qualquer push invalida o review anterior:

1. executar novamente os gates afetados e os obrigatórios de candidato;
2. fazer commit e push;
3. comentar novamente `@codex review`;
4. esperar mais 60 minutos completos;
5. reinspecionar todas as superfícies.

O ciclo termina somente quando o Codex declarar explicitamente não ter encontrado problema relevante
no SHA atual, todos os checks estiverem verdes e não houver conversa pendente.

Depois dessas três condições, o agente publica pela credencial confiável do mantenedor o commit status
`Codex review contract` no SHA atual, com `target_url` apontando para a resposta limpa. Workflows têm
permissões somente de leitura e não publicam esse status. A proteção de `main` exige o contexto; um novo
push cria outro SHA sem status e reinicia todo o ciclo. Até existir evidência limpa, o contexto
permanece sem sucesso e bloqueia o merge. Não se publica status pendente, verde ou substituto quando a
evidência é inconclusiva.

## 5. Merge e produção

O merge é feito pela interface/API protegida do GitHub, sem bypass. Depois dele:

1. acompanhar o workflow de produção até estado terminal;
2. comprovar a aplicação das migrations no projeto Supabase configurado;
3. comprovar a release imutável por SHA e o readiness interno dos dois apps na VM Oracle;
4. verificar o health público do web; o backoffice permanece deliberadamente em loopback;
5. registrar o resultado no PR ou deployment do GitHub.

Falha pós-merge é corrigida em nova branch e novo PR, repetindo este contrato integralmente. Rollback
operacional pode restaurar a release anterior para reduzir impacto, mas não substitui a correção.

## 6. Evidência suficiente

Uma etapa só passa com evidência positiva e atual. Exemplos:

- comando com código zero e saída esperada;
- check independente verde no SHA candidato;
- review limpo explícito no SHA candidato;
- deployment terminal bem-sucedido;
- health público respondendo com release e readiness esperados.

Um comando agregado verde não prova que etapas internas ocultas passaram. Os gates de CI permanecem
independentes e identificáveis.
