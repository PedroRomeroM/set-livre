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
- build standalone das duas aplicações.

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
permanente nem `waitForTimeout`.

## Segurança do E2E

Antes de qualquer mutação, os helpers exigem:

- `E2E_ALLOW_LOCAL=1`;
- web em `http://127.0.0.1:3000`;
- backoffice em `http://127.0.0.1:3001`;
- Supabase em `http://127.0.0.1:54321`;
- PostgreSQL em `127.0.0.1:54322`;
- login DAL `app_runtime_local` com `options=-c role=app_dal`;
- marcador aleatório gravado no comentário do banco pelo último reset.

Qualquer URL cloud ou representação alternativa falha antes do teste.

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
CI; evidência verde não precisa ser acumulada no repositório.
