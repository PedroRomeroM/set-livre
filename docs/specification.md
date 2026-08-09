# Set Livre — Especificação canônica da plataforma completa

## 1. Identificação

- Produto: Set Livre.
- Versão: 1.1.0.
- Tipo: marketplace web de aluguel de estúdios audiovisuais.
- Mercado inicial: Curitiba/PR.
- Idioma: PT-BR.
- Moeda: BRL.
- Fuso canônico do lançamento: `America/Sao_Paulo`.
- Aplicações: site público/autenticado e backoffice separado.
- Stack: Next.js, React, Supabase e Oracle Cloud VM.

## 2. Objetivos

### 2.1 Negócio

1. cadastrar os primeiros estúdios;
2. concluir as primeiras reservas pagas;
3. validar disponibilidade, calendário, pagamento, split e repasse;
4. oferecer produto comercializável, não apenas demonstração;
5. medir número de estúdios, conversão visita→reserva e estabilidade.

### 2.2 Produto

A plataforma conecta:

- pessoas e empresas que precisam de espaço para fotografia, vídeo, podcast, live, entrevista, ensaio ou produção;
- donos que cadastram, publicam, precificam e operam estúdios;
- equipe Set Livre que revisa anúncios, acompanha reservas, pagamentos, reembolsos e suporte.

### 2.3 Qualidade

- alta confiabilidade no calendário;
- nenhuma dupla reserva confirmada;
- pagamento idempotente;
- fotos com qualidade e entrega responsiva;
- mobile funcional a partir de 320 px;
- WCAG 2.2 AA;
- SEO completo nas superfícies públicas;
- deploy reproduzível e reversível;
- documentação e QA rastreáveis.

## 3. Perfis

### 3.1 Visitante

Pode:

- acessar home;
- abrir listagem;
- filtrar;
- consultar disponibilidade;
- visualizar detalhes, endereço, fotos, vídeo, preço e regras;
- iniciar configuração de reserva;
- criar conta ou entrar para continuar.

Não pode:

- concluir reserva;
- acessar dados privados;
- alterar disponibilidade;
- acessar backoffice.

### 3.2 Locatário

Uma conta autenticada pode atuar como pessoa física ou jurídica.

Dados:

- nome/nome empresarial;
- e-mail do Auth;
- telefone;
- CPF ou CNPJ;
- número de documento adicional quando aplicável;
- aceites legais.

Pode:

- configurar e pagar reserva;
- consultar reservas;
- cancelar conforme política;
- acompanhar pagamento/reembolso;
- exportar dados;
- solicitar exclusão.

### 3.3 Dono do estúdio

É uma conta autenticada com perfil de dono.

Pode:

- cadastrar múltiplos estúdios;
- editar revisão;
- enviar para aprovação;
- pausar/despublicar;
- gerenciar fotos, vídeo, tags, comodidades, FAQ e regras;
- configurar calendário, preços e adicionais;
- acompanhar reservas, pagamentos e repasses;
- realizar onboarding do recebedor do gateway.

Regra: um estúdio possui um único dono nesta versão. Não existem colaboradores ou múltiplos administradores por estúdio.

### 3.4 Operador do backoffice

Papéis mínimos:

- `reviewer`: revisão de estúdios;
- `support`: reservas/usuários;
- `finance`: pagamentos, reembolsos, repasses e fiscal;
- `admin`: todas as permissões e gestão de papéis.

Papéis são cumulativos apenas quando explicitamente atribuídos. O backoffice não confia em proteção visual.

## 4. Escopo incluído

### 4.1 Público

- home sem listagem de estúdios;
- filtros de entrada;
- banners e conteúdo comercial fixo;
- listagem separada;
- filtros por bairro, data, faixa de preço, tipo, capacidade e tags/comodidades;
- ordenação por menor ou maior preço;
- disponibilidade real;
- paginação por cursor;
- cards com foto, nome, bairro, preço, capacidade, tipo, tags e disponibilidade;
- detalhe público;
- endereço completo sem mapa;
- galeria, YouTube, descrição, regras, FAQ, comodidades, calendário e preço;
- SEO, sitemap, Open Graph e JSON-LD.

### 4.2 Identidade

- cadastro PF/PJ;
- confirmação de e-mail;
- login/logout;
- recuperação de senha;
- retorno pós-login à reserva;
- perfil;
- termos e consentimentos versionados;
- exportação e exclusão de dados.

### 4.3 Estúdios

- múltiplos estúdios por dono;
- rascunho e revisão;
- aprovação de todo o conteúdo;
- edição de publicado em nova revisão;
- manutenção da versão aprovada até nova aprovação;
- pausa/despublicação;
- fotos, capa e ordenação;
- vídeo YouTube;
- tipo, tags e comodidades;
- capacidade;
- horário;
- regras e FAQ.

### 4.4 Calendário

- calendário próprio como fonte interna de verdade;
- blocos de uma hora;
- horário cheio;
- horário padrão por dia;
- múltiplas janelas por dia;
- exceções;
- bloqueios;
- buffer em horas;
- duração mínima/máxima;
- reservas e cancelamentos;
- views semana/mês/dia;
- drag-and-drop de objetos editáveis;
- conflitos;
- agenda consolidada;
- importação/exportação manual iCal.

### 4.5 Preço e adicionais

- preço base por hora;
- multiplicador por dia da semana;
- multiplicador por faixa horária;
- adicionais por unidade;
- cotação detalhada;
- snapshot do preço.

### 4.6 Reserva e pagamento

- uma reserva por checkout;
- múltiplos blocos consecutivos;
- data, início, duração, pessoas, adicionais e observações;
- reserva instantânea após pagamento;
- hold após confirmação de início pelo gateway;
- duração do hold de 15 minutos ou expiração do método;
- cartão;
- PIX;
- webhook e reconciliação;
- split 80/20 sobre bruto;
- gateway pago pela plataforma;
- repasse após o uso;
- fallback manual;
- retentativa;
- reembolso total;
- comprovantes e estados.

### 4.7 Operação

- e-mails transacionais;
- painel do dono;
- backoffice separado;
- revisão, usuários, tags/categorias;
- reservas, pagamentos, reembolso, repasse;
- exportação fiscal para emissão manual;
- logs, métricas, jobs, backup e restore.

## 5. Fora de escopo

- mini fórum;
- aplicativo nativo;
- chat/WhatsApp;
- avaliações;
- busca textual;
- mapa/geolocalização;
- ordenação por relevância;
- destaques comerciais dinâmicos;
- assinatura;
- seguro;
- cupom;
- caução;
- denúncia pública;
- múltiplos gestores;
- carrinho multiestúdio;
- upload de vídeo;
- Google Calendar automático;
- emissão automática de NFS-e;
- multi-idioma;
- múltiplos fusos;
- relatórios BI;
- recomendação algorítmica.

## 6. Jornada principal

```text
Home
→ Listagem filtrada
→ Detalhe
→ Configuração da reserva
→ Autenticação, se necessário
→ Revalidação de cotação/disponibilidade
→ Início do pagamento
→ Hold transacional
→ Pagamento aprovado
→ Reserva confirmada
→ E-mails e painéis
→ Uso do estúdio
→ Repasse
```

Se o usuário se autenticar no meio:

1. o rascunho não canônico permanece em `sessionStorage` com versão e TTL;
2. `returnTo` usa allowlist;
3. após autenticação, servidor revalida identidade;
4. a tela restaura a intenção;
5. preço e disponibilidade são recalculados;
6. nenhuma promessa anterior garante a vaga.

## 7. Regras globais

### 7.1 Estúdio e revisão

- `studios` é a entidade operacional.
- Conteúdo público vive em revisões.
- Um publicado possui `published_revision_id`.
- Editar cria/usa `draft_revision_id`.
- Enviar revisão altera para pendente.
- Aprovação troca o ponteiro publicado atomicamente.
- Rejeição mantém a versão pública anterior.
- Primeiro anúncio só fica público após aprovação.
- Pausa remove de listagem e bloqueia novas reservas, preservando reservas existentes.
- Desativação administrativa impede operações e registra auditoria.

### 7.2 Disponibilidade

Uma cotação só é válida quando:

- estúdio publicado e reservável;
- recebedor apto ou fallback permitido;
- período dentro do horário semanal ou exceção aberta;
- duração dentro dos limites;
- início/fim em hora cheia;
- não há alocação ativa sobre o período bloqueado com buffer;
- data está dentro do horizonte de 365 dias;
- quantidade de pessoas não excede capacidade.

### 7.3 Calendário

- O calendário interno é canônico.
- Reservas confirmadas não podem ser movidas por drag-and-drop.
- Manual blocks e exceções podem ser editados se não afetarem reserva.
- Eventos iCal importados são bloqueios identificáveis e removíveis por lote.
- Um arquivo iCal não substitui reserva nem fato financeiro.
- Importação não é sincronização automática.

### 7.4 Preço

- Dinheiro em centavos.
- Multiplicador padrão `1.0000`.
- Cada hora é precificada no dia/faixa correspondente.
- Multiplicadores se multiplicam.
- Arredondamento por linha horária.
- Adicionais: `unit_price × quantity`.
- Total bruto = horas + adicionais.
- Snapshot preserva regras, nomes e valores.
- Mudança futura não altera reserva.

### 7.5 Pagamento e hold

- Iniciar checkout não bloqueia o horário.
- O provider precisa confirmar criação/início.
- Só então o banco tenta adquirir hold.
- Se houver conflito, o provider é cancelado/invalidado e o usuário recebe indisponibilidade.
- Hold de cartão: 15 minutos.
- Hold de PIX: até `expires_at` do provider, com default de 15 minutos.
- Webhook pago é idempotente.
- No máximo uma reserva confirma por alocação.
- Evento duplicado não duplica reserva, e-mail, split ou repasse.

### 7.6 Split e taxas

- 80% do valor bruto pertence ao dono.
- 20% pertence à plataforma.
- Taxas do gateway são atribuídas à plataforma.
- A configuração real depende do contrato do provider.
- Se automação falhar, registrar pendência de operação, nunca fingir repasse.
- Repasse padrão: 24h após fim, sem bloqueio/reembolso/disputa.
- Todo repasse possui estado e evento.

### 7.7 Cancelamento e reembolso

- Cancelamento antes do início gera reembolso total.
- Após o início, somente backoffice pode decidir, preservando regra jurídica.
- Cancelamento libera alocação.
- Reembolso falho fica `refund_pending` e alerta financeiro.
- Reserva não volta a confirmada silenciosamente.
- Histórico financeiro não é apagado.

### 7.8 Fiscal

- A plataforma organiza dados e gera exportação.
- Emissão é manual.
- Exportação inclui período, reserva, partes, valores, split e status.
- Não incluir segredo, token ou IDs desnecessários.

## 8. Rotas públicas e autenticadas

### 8.1 Públicas

| Rota | Intenção |
|---|---|
| `/` | entender o produto e iniciar busca |
| `/estudios` | filtrar e comparar |
| `/estudios/[studioId]` | avaliar um estúdio |
| `/entrar` | autenticar |
| `/cadastro` | criar conta |
| `/recuperar-senha` | recuperar acesso |
| `/auth/callback` | concluir Auth |
| `/termos` | termos vigentes |
| `/privacidade` | política de privacidade |
| `/cancelamento` | política de cancelamento |

### 8.2 Locatário

| Rota | Intenção |
|---|---|
| `/reservar/[studioId]` | configurar |
| `/checkout/[attemptId]` | pagar |
| `/conta` | perfil e segurança |
| `/conta/reservas` | listar reservas |
| `/conta/reservas/[reservationId]` | ver/cancelar |
| `/conta/dados` | exportar/excluir |

### 8.3 Dono

| Rota | Intenção |
|---|---|
| `/dono` | overview |
| `/dono/estudios` | portfólio |
| `/dono/estudios/novo` | criar |
| `/dono/estudios/[studioId]/dados` | conteúdo |
| `/dono/estudios/[studioId]/midia` | mídia |
| `/dono/estudios/[studioId]/publicacao` | revisão/status |
| `/dono/estudios/[studioId]/disponibilidade` | regras |
| `/dono/estudios/[studioId]/precos` | precificação |
| `/dono/estudios/[studioId]/adicionais` | adicionais |
| `/dono/agenda` | agenda consolidada |
| `/dono/reservas` | operação |
| `/dono/pagamentos` | financeiro |
| `/dono/recebimentos` | onboarding/repasse |

### 8.4 Backoffice

Definidas em `docs/backoffice.md`; nenhuma existe no app público.

## 9. Requisitos não funcionais

### 9.1 Segurança

- grants mínimos;
- RLS;
- DAL restrito;
- Zod;
- proteção de origem;
- rate limit;
- CSP e headers;
- webhook assinado;
- nenhum cartão armazenado;
- PII com acesso mínimo;
- auditoria de ações sensíveis.

### 9.2 Performance

Metas de referência em produção saudável:

- LCP p75 ≤ 2,5 s nas páginas públicas;
- CLS p75 ≤ 0,1;
- INP p75 ≤ 200 ms;
- resposta p95 de read model comum ≤ 500 ms, excluindo rede externa;
- comando comum p95 ≤ 800 ms, excluindo provider;
- listagem retorna no máximo 24 itens;
- calendário carrega janela limitada;
- nenhuma tela baixa base inteira.

### 9.3 Disponibilidade

- health live/ready;
- rollback por symlink;
- backup diário lógico;
- restauração ensaiada;
- jobs idempotentes;
- alertas acionáveis;
- falha do provider não corrompe reserva.

### 9.4 Acessibilidade

WCAG 2.2 AA, teclado, foco, leitores de tela, contraste, 200% zoom, touch 44 px e axe.

### 9.5 SEO

- SSR/SSG conforme página;
- metadata;
- canonical;
- sitemap;
- robots;
- OG;
- JSON-LD;
- filtros combinatórios sem index bloat;
- imagens dimensionadas.

## 10. Defaults normativos

| Regra | Default |
|---|---|
| Fotos | 1–20, 15 MB cada |
| Slot | 60 min |
| Buffer | 0–4 horas inteiras |
| Duração | mínimo 1h, máximo 24h |
| Horizonte | 365 dias |
| PIX | expiração 15 min, salvo provider |
| Hold cartão | 15 min |
| Lembrete | 24h antes |
| Repasse | 24h após fim |
| Página listagem | 24 itens |
| Página backoffice | 50 itens |
| iCal | 2 MB, -30/+365 dias |
| Timezone | America/Sao_Paulo |

## 11. Critério de aceitação global

A versão está pronta quando todos os P0 estão automatizados e:

- usuário completa reserva real em sandbox;
- duas reservas concorrentes não confirmam o mesmo período;
- dono publica e opera agenda;
- admin revisa e processa exceções;
- split/reembolso/repasse possuem reconciliação;
- dados privados não vazam entre usuários;
- app público não expõe admin;
- mobile/desktop e axe passam;
- deploy/rollback/restore foram ensaiados;
- docs refletem a release.
