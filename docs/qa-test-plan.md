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

## Segurança do E2E

Antes de qualquer mutação, os helpers exigem:

- `E2E_ALLOW_LOCAL=1`;
- web em `http://127.0.0.1:3000`;
- backoffice em `http://127.0.0.1:3001`;
- Supabase em `http://127.0.0.1:54321`;
- chave pública Supabase `sb_publishable_...` ou JWT com role `anon`;
- PostgreSQL em `127.0.0.1:54322`;
- login DAL `app_runtime_local` com `options=-c role=app_dal`;
- marcador aleatório gravado no comentário do banco pelo último reset.

Qualquer URL cloud, representação alternativa ou chave de `service_role` falha antes do teste. Os
servidores web recebem explicitamente esse mesmo contrato validado, sem herdar valores de aplicação
potencialmente divergentes do shell. O arquivo opcional `.env.e2e.local` só é interpretado depois de
provar arquivo regular, inode exclusivo e metadados estáveis; em POSIX, abertura no-follow, owner
efetivo e modo `0600` também são obrigatórios.

## Matriz da FEAT-006

Os dezessete cenários estáveis `SL-F006-E2E-001..017` expandem para 61 execuções:

- P0 de criação, clone de publicado, isolamento entre donos, troca de sessão no editor e na criação
  ainda não salva e revogação da autoridade de dono durante a criação nos três engines;
- validação, tokens locais independentes de update/descarte preservados após refetch, estado terminal
  de criação, retry ambíguo, reconfirmação de descarte sem liberar save stale, bloqueio administrativo
  arquivamento concorrente do tipo em criação/edição, falha transitória na releitura de conflito,
  navegação terminal explícita após descarte e revogação de conta em desktop, mobile, 320 px e altura
  compacta;
- axe/teclado/toque/alvos em desktop, mobile, 320 px e tema escuro;
- reflow a 200% em Chromium, Firefox e WebKit.

O helper cria dono real pelo fluxo UI, prova pré-requisitos no banco e limita queries administrativas
ao ambiente E2E já validado. O teardown aguarda o documento carregado e fecha a página antes da
remoção transacional das fixtures; cada helper de comando já aguarda a resposta específica que gerou o
estado observado. A criação só retorna ao cenário depois da leitura inicial do editor responder `200`; assim a
fixture de conflito avança uma versão já observada, sem competir com o refetch de montagem. As specs
herdam a retenção global de
trace, screenshot e vídeo somente em falha; nenhuma desativa essa evidência localmente.

No banco, `0005_studio_core_revision.sql` possui 41 asserções de domínio/segurança. O setup
`0000_test_setup.sql` habilita pgTAP idempotentemente antes das suítes.

## Matriz da FEAT-007

Os onze cenários `SL-F007-E2E-001..011` expandem para 39 execuções:

- P0 salva conteúdo/taxonomia, rejeita catálogo inativo/externo e prova plain text nos três engines;
- FAQ mobile, YouTube permitido/bloqueado, handoff de revisão confirmada entre os painéis e reset
  integral após descarte em desktop, 390 px, 320 px e altura compacta;
- troca de sessão oculta editor e conteúdo comercial privados antes da releitura nos três engines;
- resposta ambígua congela ambos os formulários e repete o comando idempotente intacto nas quatro
  composições de regressão;
- refetch preserva a versão otimista associada aos valores locais, exige conflito explícito antes do
  rebase e impede sobrescrita concorrente silenciosa nas quatro composições de regressão;
- axe, teclado, toque e alvos em desktop, mobile, 320 px e tema escuro;
- reflow a 200% em Chromium, Firefox e WebKit.

`0006_studio_taxonomy_content.sql` possui 42 asserções para schema, grants/RLS, isolamento entre
donos, idempotência, concorrência, clone de publicado, taxonomia ativa, FAQ/vídeo e auditoria
redigida.

## Matriz da FEAT-031

Os sete cenários `SL-F031-E2E-001..007` expandem para 24 execuções:

- P0 de suspensão/restauração, bloqueio de comandos, papéis/último admin e taxonomia histórica nos
  três engines;
- PII mascarada até revelação justificada e busca/cursor server-side em desktop, 390 px, 320 px e
  altura compacta;
- axe, teclado, toque, contraste e ausência de overflow em desktop, mobile, 320 px e tema escuro.

Os testes provam a fronteira `support/admin` pela UI, rota, API e banco. PII efêmera nunca entra no
QueryCache nem em fixture persistida; o helper cria identidades reais no Supabase local, usa a role DAL
restrita e remove usuários/taxonomias após cada cenário. `0007_backoffice_users_taxonomy.sql` possui 46
asserções para grants/RLS, binding curto, expiração, bootstrap one-shot, papel/último admin, versão de
conta, PII redigida, idempotência, taxonomia histórica e encerramento de sessões. O runner completo
possui oito arquivos e 363 testes.

## Contrato por feature

Enquanto planejada ou em andamento, cada feature possui um arquivo em `docs/features/` com seus
cenários P0/P1. Para concluir:

1. implementar a fatia vertical e as regressões necessárias;
2. manter IDs estáveis nos títulos/comentários das specs quando úteis à rastreabilidade;
3. executar SQL, unitários e Playwright aplicáveis;
4. executar a suíte Playwright completa antes de release;
5. consolidar contratos permanentes no documento de domínio;
6. apagar o plano transitório da feature;
7. marcar a feature como concluída em `docs/roadmap.md`.

## Evidência

Saída interrompida, timeout ou serviço indisponível é inconclusivo. Um gate passa somente com execução
terminal e código zero. Artefatos de falha do Playwright — trace, screenshot e vídeo — são retidos no
CI por sete dias somente quando a suíte falha; evidência verde não precisa ser acumulada no repositório.
