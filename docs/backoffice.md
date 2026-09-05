# Backoffice separado

## 1. Fronteira

Aplicação em `apps/backoffice`, build, porta, cookies e secrets próprios. Não existe `/admin` no app
público. Em produção, ela permanece somente em `127.0.0.1:3001` até uma mudança explícita de go-live;
acesso operacional provisório usa túnel SSH, sem criar host público escondido.

Acesso:

- autenticação Supabase;
- perfil ativo e completo;
- ao menos um papel `support`, `reviewer` ou `admin`, sempre revalidado no banco; cada superfície
  exige ainda sua capacidade explícita;
- binding por `session_id` Auth com 30 minutos de inatividade e oito horas absolutas;
- revalidação client-side no mount, a cada 15 segundos, no foco e por evento entre abas; login
  concluído ou inconclusivo também publica esse evento. Mudança de identidade ou autorização oculta o
  DOM privado, limpa o QueryCache e recompõe a rota; esse polling passivo valida a sessão sem renovar a
  janela de inatividade;
- respostas de atividade operacional solicitam imediatamente uma nova leitura passiva da sessão;
  no vencimento do prazo em cache, a shell oculta e torna inerte a composição enquanto verifica o
  prazo autoritativo, sem descartar formulários ou navegar se a atividade já renovou a sessão.
  Uma leitura substituída por atividade mais recente não decide expiração: a verificação aguarda
  a geração atual, inclusive quando o refetch anterior é cancelado. A consulta também executa
  offline para concluir em erro limitado, sem ficar pausada indefinidamente no QueryCache.
  Falha de verificação, expiração real ou mudança de identidade/autorização fecha a fronteira;
- autenticação realizada há no máximo cinco minutos para alterar papéis;
- desbloqueio local de cinco minutos, assinado e vinculado à sessão Auth, antes de qualquer mutação;
- papéis são mantidos no Server Component e não entram no DTO de sessão ou lista enviado ao browser;
- nenhum service role no browser.

Leituras e mutações HTTP no browser têm deadline de dez segundos, incluindo o consumo do corpo.
O deadline é combinado com o sinal de cancelamento do chamador: substituição de query preserva o
cancelamento original, enquanto expiração retorna erro recuperável, sem deixar loading indefinido.
Resultados privados são validados antes do sucesso: comandos de conta/acesso exigem o UUID do alvo;
taxonomias exigem o grupo solicitado e, em edição/arquivamento/reativação, também o UUID do item.
Criação exige ainda nome e slug normalizados pelo contrato, ordem enviada e estado inicial ativo;
um item do mesmo grupo com valores divergentes não confirma a tentativa idempotente.
Resposta de outro alvo ou grupo falha fechada e solicita recomposição da sessão privada.
O detalhe de acessos também compara, no serviço server-only, o ID devolvido pelo DAL com o UUID
canônico solicitado antes de renderizar a conta e suas ações no Server Component. Divergência não
produz tela de outro usuário nem revela o registro na mensagem de erro.

`support` opera usuários. `reviewer` revisa candidatas editoriais. `admin` substitui deliberadamente
ambos e também administra acessos, taxonomias e moderação de estúdios. As capacidades não são
hierárquicas por acidente: a função privada recebe o papel exigido em cada chamada. `finance` continua
fora do schema e da UI até sua feature proprietária.

## 2. Rotas

| Rota             | Função                 | Estado                 |
| ---------------- | ---------------------- | ---------------------- |
| `/`              | redireciona por sessão | implementada           |
| `/entrar`        | login operacional      | implementada           |
| `/usuarios`      | contas e PII auditada  | implementada           |
| `/taxonomias`    | tipos/tags/comodidades | implementada, só admin |
| `/acessos`       | papéis                 | implementada, só admin |
| `/acessos/[id]`  | detalhe server-only    | implementada, só admin |
| `/estudios[/id]` | fila e revisão         | implementada           |
| `/reservas[/id]` | operação               | FEAT-033               |
| `/pagamentos`    | transações             | FEAT-032               |
| `/reembolsos`    | pendências             | FEAT-032               |
| `/repasses`      | agenda/falhas          | FEAT-032               |
| `/fiscal`        | exportações            | FEAT-032               |
| `/operacao`      | jobs/saúde             | FEAT-033               |
| `/auditoria`     | eventos permitidos     | FEAT-033               |

## 3. Revisão e moderação de estúdio

A fila usa paginação keyset e deriva seus casos dos ponteiros, revisões e eventos editoriais já
canônicos; não existe tabela paralela de caso. `reviewer` vê candidatas pendentes. `admin` vê também
estúdios publicados/pausados sem submissão pendente para moderação e os desabilitados que podem ser
restaurados. Um draft ainda não submetido nunca aparece nem tem mídia assinada nessa superfície.

O detalhe compara:

- versão pública, se houver;
- revisão submetida pendente ou, em moderação/restauração, a revisão publicada exata;
- dados;
- endereço;
- mídia;
- tags/amenities;
- FAQ/regras;
- checklist editorial derivado.

Preço não aparece enquanto a FEAT-016 não existir. Mídia continua em bucket privado e recebe URLs
assinadas por cinco minutos somente depois de a sessão, o papel e o vínculo editorial serem validados.
Somente a operação Storage de assinatura em lote atravessa a policy; listagem/download autenticado
direto permanecem negados. O refresh Auth necessário para obter o token e a assinatura Storage usam o
mesmo `AbortSignal` e o mesmo deadline de dois segundos; timeout ou desconexão cancela a chamada em voo
antes de responder `503`. O path privado e qualquer chave privilegiada permanecem fora do DTO.

O detalhe automático relê em segundo plano a cada quatro minutos, no foco e na reconexão com atividade
`passive`: sessão, papel e conteúdo continuam autoritativos, mas `last_seen_at` não muda. Carregamento
SSR, tentativa manual e recuperação explícita usam atividade `interactive`; comandos já renovam a
atividade na própria transação. Portanto polling nunca estende os 30 minutos de inatividade.

Ações:

- aprovar;
- rejeitar com motivo;
- desabilitar em ação separada;
- restaurar exatamente o estado guardado antes da desativação.

Aprovação/rejeição recebem a revisão e a versão editorial esperadas; desativação/restauração recebem a
versão editorial. Todas usam idempotência, lock, evento de auditoria e retorno autoritativo na mesma
transação. Antes de aprovar, o banco bloqueia as taxonomias referenciadas e recalcula o checklist
canônico; item arquivado depois da submissão remove `canApprove` e impede publicação sem efeito parcial.
Aprovar preserva `paused` quando esse era o estado operacional. Rejeitar conserva a versão pública e
clona integralmente a candidata rejeitada para um novo draft do dono. Reviewer não altera conteúdo em
nome do dono.

## 4. Usuários

- busca server-side por prefixo de e-mail ou UUID exato, enviada por `POST` para não persistir o filtro
  na URL, logs ou histórico; nome bruto nunca participa desse filtro para não criar um oráculo fora da
  revelação auditada;
- paginação keyset de 50 itens por `created_at + id`, com cursor opaco e precisão de microssegundos;
- busca, fingerprint do cache, parâmetros SQL e binding do cursor usam o mesmo filtro sem espaços
  externos e em minúsculas (`pt-BR`); filtro vazio equivale à ausência de filtro;
- e-mail mascarado e nenhuma PII crua — inclusive nome — no read model;
- revelação explícita por motivo allowlisted, auditada, fora do QueryCache e removida após 60 segundos,
  quando a aba fica oculta ou quando o motivo muda; resposta que termina enquanto a aba já está oculta
  é descartada antes de alcançar o estado/renderização;
- actions explícitas de suspensão/restauração, sem aceitar status de destino do cliente, e
  `account_version` independente da versão da identidade;
- suspensão fecha bindings administrativos do alvo e os comandos de produto continuam bloqueados
  pela verificação canônica de `profiles.status`.

Enquanto uma suspensão/restauração estiver em voo ou com resultado ambíguo, a busca permanece
bloqueada, inclusive no handler de submit, preservando alvo, payload e chave para replay. Nova busca
só descarta uma confirmação ainda não enviada ou uma tentativa já conclusiva.

## 5. Acessos e taxonomias

Somente `admin` vê e abre `/acessos`, `/acessos/[userId]` e `/taxonomias`; chamada direta continua sendo
recusada pelo banco. A lista de contas não devolve papéis. O detalhe consulta uma única conta no servidor,
deriva somente as transições explícitas `grant/revoke support/reviewer/admin` e envia ao cliente a ação permitida,
o alvo mascarado e a versão opaca da conta. Alterar papel usa `expectedAccountVersion`, lock de
autorização, idempotência e reautenticação recente; o browser nunca propõe um conjunto arbitrário de
papéis. Os botões de transição permanecem desabilitados no HTML inicial e só aceitam interação depois
da hidratação, evitando perda silenciosa de um clique antecipado. A salvaguarda impede suspender ou
remover o último administrador ativo. Remover o último papel de uma conta encerra suas sessões de
backoffice.

Depois de uma alteração de papel confirmada ou de conflito de versão, o detalhe oculta o estado
anterior e bloqueia novas ações até receber pelo RSC o mesmo alvo numa versão autoritativa que cubra
o resultado. Sucesso só é anunciado junto dessa composição verificada; uma versão posterior é
apresentada como o estado mais recente, sem atribuir-lhe o resultado antigo. Após dez segundos sem
confirmação da leitura, a superfície oferece nova tentativa de verificação, sem reenviar o comando
já aplicado. Os papéis continuam no Server Component, passados como composição, não como DTO.

O binding curto mantém `last_seen_at` e `closed_at` monotônicos em relação à abertura. A fronteira do
banco normaliza correções regressivas do relógio de parede, e a validação usa o maior valor entre o
horário observado e a última atividade; um ajuste de relógio não quebra a sessão nem amplia sua janela.

Login, logout global, desbloqueio, busca de usuários e gestão de taxonomias permanecem `inert`, com
controles nativos desabilitados, até o snapshot client-side de hidratação; assim, uma interação
antecipada nunca executa sem handler ativo, a digitação não é apagada quando o React assume a tela e
a ausência de JavaScript
não publica segredo por fallback HTML, mas explica que o recurso precisa ser habilitado antes de
recarregar. O formulário global de
desbloqueio envia a chave local somente ao endpoint de autenticação. O valor não
é guardado em state, cache, storage ou cookie: após comparação em tempo constante, o servidor emite um
cookie HttpOnly/SameSite estrito, assinado, não renovável por polling e vinculado ao usuário e ao
`session_id` Auth. Ele expira em cinco minutos e é apagado em login, logout ou invalidação da sessão.
Sem cookie válido, `/api/commands` falha fechado com `423/RUNTIME_LOCKED` antes de chamar a DAL.
Comandos, diretório, taxonomias e revisão editorial autenticam a binding administrativa antes de consumir o bucket de
rede ou ler qualquer body privado; o serviço recebe esse mesmo contexto verificado até a DAL.
O formulário possui nome acessível próprio e constitui um landmark entre a navegação e o conteúdo
principal.

Tipos de estúdio, tags e comodidades possuem slug único por tabela, ordem e versão otimista. Admin pode
criar, editar, arquivar e reativar. Não existe exclusão física: a tela mostra a contagem autoritativa de
uso, e arquivamento remove o item de novas seleções sem apagar referências históricas. O catálogo
combinado aceita no máximo 500 itens; criação toma lock transacional e falha antes do item 501,
enquanto atualizações continuam disponíveis no limite. Conflito de versão fecha o editor/impacto
obsoleto e relê o catálogo antes de uma nova decisão. Arquivamento e reativação são actions distintas;
o payload não aceita `active` e a função privada deriva o destino da action validada. Ordem exige
inteiro entre 0 e 32767; entrada vazia é rejeitada junto ao campo antes de qualquer comando, sem
conversão implícita para zero. Zero explícito permanece válido.

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
- DAL executa somente as fachadas allowlisted e não lê tabelas diretamente;
- ledger idempotente guarda hash de payload/resultado, mas PII guarda apenas versões para detectar
  replay stale, nunca valor ou hash reutilizável;
- erros públicos são allowlisted e logs usam request ID sem e-mail, documento ou payload; falha
  anterior ao parse é registrada como `backoffice.command`, nunca como uma mutação específica falsa.

## 10. QA

- app público 404 em `/admin`;
- usuário comum não entra;
- `support` opera conta/PII, mas não enxerga nem chama acessos, taxonomias ou revisão editorial;
- `reviewer` acessa somente fila/detalhe e decide candidatas; `admin` substitui esse papel de forma
  explícita e é o único que desabilita/restaura;
- admin recente gerencia os três papéis e o último admin permanece protegido;
- lista/sessão do browser não expõem papéis e o detalhe de acesso é composto no servidor;
- login, logout global, desbloqueio, busca e taxonomias permanecem fechados antes da hidratação, sem
  perder entrada antecipada nem aceitar ação sem handler;
- runtime bloqueado não executa mutação; desbloqueio expira, não atravessa sessão e nunca persiste a chave;
- arquivamento preserva referência e bloqueia nova seleção;
- PII permanece mascarada, temporária e auditada;
- resposta de PII concluída em aba oculta nunca é renderizada;
- busca/cursor ficam no servidor e fora da URL;
- troca de sessão/papel elimina imediatamente a composição privada após a revalidação;
- polling passivo não mantém uma sessão inativa viva;
- atividade próxima do prazo em cache republica a validade da sessão; a verificação no vencimento
  não encerra uma binding renovada nem mantém expiração real ou falha de leitura aberta;
- criação de taxonomia rejeita respostas válidas de outro conteúdo do mesmo grupo;
- atualização de acesso aguarda a versão RSC verificada, com recuperação de leitura sem repetir
  a mutação (`SL-F031-E2E-030`);
- correção regressiva do relógio preserva atividade/encerramento monotônicos sem violar constraints;
- conflitos de conta, papel, taxonomia e revisão exigem novo read model e nova confirmação;
- aprovação/rejeição concorrentes produzem uma única decisão; rejeição preserva publicação e cria a
  correção completa, enquanto desativação/restauração recuperam `published`, `changes_pending` ou
  `paused` sem inferência;
- status, acesso e taxonomia bloqueiam cancelamento/troca enquanto a requisição está em voo; se a
  resposta se perder, conservam a mesma chave/tentativa até o replay autoritativo;
- desktop é a composição principal, com operação íntegra em 390 px, 320 px e altura compacta;
- P0 roda em Chromium, Firefox e WebKit; axe cobre desktop, mobile, 320 px e tema escuro.
