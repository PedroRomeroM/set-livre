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
  identidade ou autorização oculta o DOM privado, limpa o QueryCache e recompõe a rota; esse polling
  passivo valida a sessão sem renovar a janela de inatividade;
- autenticação realizada há no máximo cinco minutos para alterar papéis;
- desbloqueio local de cinco minutos, assinado e vinculado à sessão Auth, antes de qualquer mutação;
- papéis são mantidos no Server Component e não entram no DTO de sessão ou lista enviado ao browser;
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
| `/acessos/[id]`  | detalhe server-only    | implementada, só admin |
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
  ou quando a aba fica oculta; resposta que termina enquanto a aba já está oculta é descartada antes de
  alcançar o estado/renderização;
- actions explícitas de suspensão/restauração, sem aceitar status de destino do cliente, e
  `account_version` independente da versão da identidade;
- suspensão fecha bindings administrativos do alvo e os comandos de produto continuam bloqueados
  pela verificação canônica de `profiles.status`.

## 5. Acessos e taxonomias

Somente `admin` vê e abre `/acessos`, `/acessos/[userId]` e `/taxonomias`; chamada direta continua sendo
recusada pelo banco. A lista de contas não devolve papéis. O detalhe consulta uma única conta no servidor,
deriva somente as transições explícitas `grant/revoke support/admin` e envia ao cliente a ação permitida,
o alvo mascarado e a versão opaca da conta. Alterar papel usa `expectedAccountVersion`, lock de
autorização, idempotência e reautenticação recente; o browser nunca propõe um conjunto arbitrário de
papéis. Os botões de transição permanecem desabilitados no HTML inicial e só aceitam interação depois
da hidratação, evitando perda silenciosa de um clique antecipado. A salvaguarda impede suspender ou
remover o último administrador ativo. Remover o último papel de uma conta encerra suas sessões de
backoffice.

O binding curto mantém `last_seen_at` e `closed_at` monotônicos em relação à abertura. A fronteira do
banco normaliza correções regressivas do relógio de parede, e a validação usa o maior valor entre o
horário observado e a última atividade; um ajuste de relógio não quebra a sessão nem amplia sua janela.

O login e o formulário global de desbloqueio permanecem `inert`, com controles nativos desabilitados,
até o snapshot client-side de hidratação; assim, digitação antecipada nunca é apagada quando o React
assume a tela e a ausência de JavaScript não publica segredo por fallback HTML, mas explica que o
recurso precisa ser habilitado antes de recarregar. O formulário global de
desbloqueio envia a chave local somente ao endpoint de autenticação. O valor não
é guardado em state, cache, storage ou cookie: após comparação em tempo constante, o servidor emite um
cookie HttpOnly/SameSite estrito, assinado, não renovável por polling e vinculado ao usuário e ao
`session_id` Auth. Ele expira em cinco minutos e é apagado em login, logout ou invalidação da sessão.
Sem cookie válido, `/api/commands` falha fechado com `423/RUNTIME_LOCKED` antes de chamar a DAL.
O formulário possui nome acessível próprio e constitui um landmark entre a navegação e o conteúdo
principal.

Tipos de estúdio, tags e comodidades possuem slug único por tabela, ordem e versão otimista. Admin pode
criar, editar, arquivar e reativar. Não existe exclusão física: a tela mostra a contagem autoritativa de
uso, e arquivamento remove o item de novas seleções sem apagar referências históricas. O catálogo
combinado aceita no máximo 500 itens; criação toma lock transacional e falha antes do item 501,
enquanto atualizações continuam disponíveis no limite. Conflito de versão fecha o editor/impacto
obsoleto e relê o catálogo antes de uma nova decisão. Arquivamento e reativação são actions distintas;
o payload não aceita `active` e a função privada deriva o destino da action validada.

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
- DAL executa somente as onze fachadas allowlisted e não lê tabelas diretamente;
- ledger idempotente guarda hash de payload/resultado, mas PII guarda apenas versões para detectar
  replay stale, nunca valor ou hash reutilizável;
- erros públicos são allowlisted e logs usam request ID sem e-mail, documento ou payload; falha
  anterior ao parse é registrada como `backoffice.command`, nunca como uma mutação específica falsa.

## 10. QA

- app público 404 em `/admin`;
- usuário comum não entra;
- `support` opera conta/PII, mas não enxerga nem chama acessos/taxonomias;
- admin recente gerencia papéis e o último admin permanece protegido;
- lista/sessão do browser não expõem papéis e o detalhe de acesso é composto no servidor;
- login e desbloqueio permanecem fechados antes da hidratação, sem perder entrada antecipada;
- runtime bloqueado não executa mutação; desbloqueio expira, não atravessa sessão e nunca persiste a chave;
- arquivamento preserva referência e bloqueia nova seleção;
- PII permanece mascarada, temporária e auditada;
- resposta de PII concluída em aba oculta nunca é renderizada;
- busca/cursor ficam no servidor e fora da URL;
- troca de sessão/papel elimina imediatamente a composição privada após a revalidação;
- polling passivo não mantém uma sessão inativa viva;
- correção regressiva do relógio preserva atividade/encerramento monotônicos sem violar constraints;
- conflitos de conta, papel e taxonomia exigem novo read model e nova confirmação;
- status, acesso e taxonomia bloqueiam cancelamento/troca enquanto a requisição está em voo; se a
  resposta se perder, conservam a mesma chave/tentativa até o replay autoritativo;
- desktop é a composição principal, com operação íntegra em 390 px, 320 px e altura compacta;
- P0 roda em Chromium, Firefox e WebKit; axe cobre desktop, mobile, 320 px e tema escuro.
