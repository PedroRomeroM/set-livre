# Backoffice separado

## 1. Fronteira

Aplicação em `apps/backoffice`, build/porta/domínio próprios. Não existe `/admin` no app público.

Acesso:

- rede/IP/VPN conforme operação;
- autenticação Supabase;
- papel server-side;
- sessão curta;
- confirmação forte para destruição;
- nenhum service role no browser.

## 2. Rotas

| Rota             | Função               |
| ---------------- | -------------------- |
| `/`              | overview operacional |
| `/estudios`      | fila e busca         |
| `/estudios/[id]` | revisão              |
| `/reservas`      | operação             |
| `/reservas/[id]` | caso                 |
| `/pagamentos`    | transações           |
| `/reembolsos`    | pendências           |
| `/repasses`      | agenda/falhas        |
| `/usuarios`      | usuários             |
| `/taxonomias`    | tipos/tags/amenities |
| `/fiscal`        | exportações          |
| `/operacao`      | jobs/saúde           |
| `/auditoria`     | eventos permitidos   |
| `/acessos`       | papéis, admin        |

## 3. Revisão de estúdio

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

- busca server-side;
- status;
- papéis;
- estúdios/reservas relacionados;
- suspender/restaurar;
- iniciar fluxo de exclusão;
- PII mascarada por padrão;
- acesso completo apenas quando função exige e auditado.

## 5. Financeiro

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

## 6. Operação

Painel:

- health app/DB/provider;
- fila de email;
- holds expirados atrasados;
- payments pendentes;
- payouts falhos;
- backups;
- release SHA.

Não expor secrets, payloads completos ou stack.

## 7. Auditoria

Filtros por:

- data;
- ator;
- ação;
- alvo;
- resultado;
- requestId.

Audit é append-only para operadores. Export controlado.

## 8. Segurança

- Nginx restringe;
- `robots noindex`;
- CSP própria;
- cookies próprios;
- role a cada command;
- AAL/reauth para role/deletion;
- inatividade expira;
- logs redigidos;
- actions idempotentes.

## 9. QA

- app público 404 em `/admin`;
- usuário comum não entra;
- role insuficiente;
- approve/reject;
- audit;
- refund/payout;
- confirmação destrutiva;
- mobile mínimo funcional para emergência, mas desktop é composição principal.
