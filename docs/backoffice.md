# Backoffice separado

## 1. Fronteira

Aplicação em `apps/backoffice`, build, porta, cookies e secrets próprios. Não existe `/admin` no app
público. Em produção, ela permanece somente em `127.0.0.1:3001` até uma mudança explícita de go-live;
acesso operacional provisório usa túnel SSH, sem criar host público escondido.

Acesso:

- autenticação Supabase;
- perfil ativo e completo;
- papel `support` ou `admin` revalidado no banco a cada leitura/comando;
- binding por `session_id` Auth com 30 minutos de inatividade e oito horas absolutas;
- revalidação client-side no mount, a cada 15 segundos, no foco e por evento entre abas; mudança de
  identidade ou papéis oculta o DOM privado, limpa o QueryCache e recompõe a rota;
- autenticação realizada há no máximo cinco minutos para alterar papéis;
- nenhum service role no browser.

`support` opera usuários. `admin` também administra acessos e taxonomias. `reviewer` e `finance` só
serão introduzidos pelas features proprietárias; não existem antecipadamente no schema ou na UI.

## 2. Rotas

| Rota             | Função                 | Estado                 |
| ---------------- | ---------------------- | ---------------------- |
| `/`              | redireciona por sessão | implementada           |
| `/entrar`        | login operacional      | implementada           |
| `/usuarios`      | contas e PII auditada  | implementada           |
| `/taxonomias`    | tipos/tags/comodidades | implementada, só admin |
| `/acessos`       | papéis                 | implementada, só admin |
| `/estudios[/id]` | fila e revisão         | FEAT-030               |
| `/reservas[/id]` | operação               | FEAT-033               |
| `/pagamentos`    | transações             | FEAT-032               |
| `/reembolsos`    | pendências             | FEAT-032               |
| `/repasses`      | agenda/falhas          | FEAT-032               |
| `/fiscal`        | exportações            | FEAT-032               |
| `/operacao`      | jobs/saúde             | FEAT-033               |
| `/auditoria`     | eventos permitidos     | FEAT-033               |

## 3. Revisão de estúdio planejada

Tela compara:

- versão pública, se houver;
- revisão pendente;
- dados;
- endereço;
- mídia;
- tags/amenities;
- FAQ/regras;
- preço/configurações relevantes.

Ações:

- aprovar;
- rejeitar com motivo;
- desabilitar em ação separada;
- abrir owner/studio context.

Aprovação é atômica e audita. Reviewer não altera conteúdo em nome do dono.

## 4. Usuários

- busca server-side por prefixo de nome/e-mail ou UUID exato, enviada por `POST` para não persistir o
  filtro na URL, logs ou histórico;
- paginação keyset de 50 itens por `created_at + id`, com cursor opaco e precisão de microssegundos;
- e-mail mascarado e nenhuma PII crua — inclusive nome — no read model;
- revelação explícita por motivo allowlisted, auditada, fora do QueryCache e removida após 60 segundos
  ou quando a aba fica oculta;
- actions explícitas de suspensão/restauração, sem aceitar status de destino do cliente, e
  `account_version` independente da versão da identidade;
- suspensão fecha bindings administrativos do alvo e os comandos de produto continuam bloqueados
  pela verificação canônica de `profiles.status`.

## 5. Acessos e taxonomias

Somente `admin` vê e abre `/acessos` e `/taxonomias`; chamada direta continua sendo recusada pelo
banco. Alterar papel usa versão esperada do conjunto atual, lock de autorização, idempotência e
reautenticação recente. A salvaguarda impede suspender ou remover o último administrador ativo. Remover
o último papel de uma conta encerra suas sessões de backoffice.

Tipos de estúdio, tags e comodidades possuem slug único por tabela, ordem e versão otimista. Admin pode
criar, editar, arquivar e reativar. Não existe exclusão física: a tela mostra a contagem autoritativa de
uso, e arquivamento remove o item de novas seleções sem apagar referências históricas. O catálogo
combinado aceita no máximo 500 itens; criação toma lock transacional e falha antes do item 501,
enquanto atualizações continuam disponíveis no limite. Conflito de versão fecha o editor/impacto
obsoleto e relê o catálogo antes de uma nova decisão.

O primeiro admin é criado uma única vez por `private.bootstrap_first_platform_admin(...)`, sob lock e
somente para perfil ativo/concluído enquanto nenhum papel existir. A função não é concedida à DAL; o
procedimento operacional usa acesso administrativo autorizado e deixa auditoria idempotente.

## 6. Financeiro planejado

- pagamentos por status;
- webhook/reconciliação;
- refunds;
- payouts;
- provider status;
- retry;
- bloqueio/desbloqueio;
- fallback manual;
- export fiscal.

Toda ação mostra impacto e requer confirmação. Não editar valor histórico diretamente.

## 7. Operação planejada

Painel:

- health app/DB/provider;
- fila de email;
- holds expirados atrasados;
- payments pendentes;
- payouts falhos;
- backups;
- release SHA.

Não expor secrets, payloads completos ou stack.

## 8. Auditoria

Filtros por:

- data;
- ator;
- ação;
- alvo;
- resultado;
- requestId.

Audit é append-only para operadores. Export controlado.

## 9. Segurança

- Nginx mantém o processo em loopback até o go-live;
- a origem de runtime desta fase é exatamente `http://127.0.0.1:3001`, alcançada por túnel SSH; o
  trecho de rede é cifrado pelo SSH e o cookie host-only/HttpOnly/SameSite permanece restrito ao
  loopback do navegador;
- `robots noindex`;
- CSP própria;
- cookie storage key próprio e headers `private, no-store`;
- claims, sessão Auth canônica, perfil e papéis são revalidados no servidor;
- tabelas administrativas usam RLS fechado e zero grants para browser;
- DAL executa somente as dez fachadas allowlisted e não lê tabelas diretamente;
- ledger idempotente guarda hash de payload/resultado, mas PII guarda apenas versões para detectar
  replay stale, nunca valor ou hash reutilizável;
- erros públicos são allowlisted e logs usam request ID sem e-mail, documento ou payload.

## 10. QA

- app público 404 em `/admin`;
- usuário comum não entra;
- `support` opera conta/PII, mas não enxerga nem chama acessos/taxonomias;
- admin recente gerencia papéis e o último admin permanece protegido;
- arquivamento preserva referência e bloqueia nova seleção;
- PII permanece mascarada, temporária e auditada;
- busca/cursor ficam no servidor e fora da URL;
- troca de sessão/papel elimina imediatamente a composição privada após a revalidação;
- conflitos de conta, papel e taxonomia exigem novo read model e nova confirmação;
- desktop é a composição principal, com operação íntegra em 390 px, 320 px e altura compacta;
- P0 roda em Chromium, Firefox e WebKit; axe cobre desktop, mobile, 320 px e tema escuro.
