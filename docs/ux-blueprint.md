# UX Blueprint, rotas e fluxos

## 1. Princípios

- rotas representam intenções;
- mobile tem composição própria;
- nenhuma informação essencial depende de hover;
- erro explica ação;
- reserva nunca promete vaga antes do hold;
- preço sempre explicável;
- mudanças de estado importantes ficam visíveis;
- filtros pertencem à URL;
- login preserva intenção, não preço/garantia.

## 2. Navegação pública

Header:

- marca;
- `Encontrar estúdio`;
- `Anuncie seu estúdio`;
- login/conta;
- menu mobile.

Footer:

- produto;
- cidade;
- termos/privacidade/cancelamento;
- contato;
- acessibilidade.

## 3. Home

A home não lista estúdios.

Seções:

1. hero com proposta de valor;
2. formulário inicial:
   - data;
   - bairro opcional;
   - tipo opcional;
   - CTA;
3. categorias de uso;
4. como funciona para locatário;
5. como funciona para dono;
6. diferenciais/confiança;
7. CTA final;
8. conteúdo comercial fixo.

O submit navega para `/estudios?...`.

Estados:

- data inválida;
- ausência de opções;
- mobile teclado/date picker;
- sem JavaScript: conteúdo e links continuam.

## 4. Listagem

Desktop:

- header de resultados;
- filtros laterais ou barra;
- ordem;
- grid;
- `Carregar mais`.

Mobile:

- resumo;
- botão Filtros com contador;
- bottom sheet/fullscreen;
- chips;
- grid/lista de uma coluna.

Filtros:

- bairro;
- data;
- preço;
- tipo;
- capacidade;
- comodidades/tags.

Card:

- imagem/capa;
- nome;
- bairro;
- preço exato/h;
- capacidade;
- tipo;
- até 4 destaques;
- disponibilidade da data;
- card inteiro abre detalhe;
- sem botões internos conflitantes.

## 5. Detalhe

Ordem:

1. breadcrumb;
2. título/endereço/preço;
3. galeria;
4. resumo e capacidade;
5. descrição;
6. comodidades;
7. vídeo;
8. regras;
9. FAQ;
10. calendário/configurador;
11. CTA sticky mobile quando apropriado.

Sem mapa. Endereço completo visível.

Galeria:

- grid desktop;
- carousel mobile;
- lightbox acessível;
- contador;
- alt;
- foco.

## 6. Configuração

Campos:

- data;
- hora inicial;
- duração;
- pessoas;
- adicionais;
- observações.

Painel de resumo:

- horas;
- multiplicadores;
- adicionais;
- total;
- validade;
- aviso de disponibilidade.

CTA:

- anônimo: `Entrar para continuar`;
- autenticado: `Ir para pagamento`.

## 7. Auth no contexto

### 7.1 Superfície implementada na FEAT-002

- `/cadastro`: escolha PF/PJ, e-mail, senha com requisitos, confirmação e dois aceites legais não pré-marcados;
- `/entrar`: formulário quando anônimo e resumo da sessão SSR com logout quando autenticado; conta suspensa recebe bloqueio explícito;
- `/recuperar-senha`: resposta genérica para qualquer e-mail e formulário de nova senha somente após callback válido;
- `/auth/callback`: estado de validação, remoção imediata do fragmento sensível, falha recuperável e redirecionamento allowlisted;
- `/termos` e `/privacidade`: versão/data vigentes, headings, parágrafos, listas, `strong`, `em` e links semanticamente preservados por um subset Markdown seguro, com `h1` único e alerta forte quando a fonte é `local_fixture`; HTML e sintaxe fora do subset aparecem como texto, enquanto links inseguros preservam apenas o rótulo;
- todos os formulários têm labels persistentes, erros associados, loading sem duplo submit, sucesso recuperável, teclado, 320 px e reflow de 160 CSS px.

### 7.2 Retorno à intenção de reserva (FEAT-019)

Ao clicar:

- salvar draft;
- navegar `/entrar?returnTo=...`;
- após auth voltar;
- mostrar “Recalculamos disponibilidade e preço”;
- se indisponível, manter escolhas e sugerir horários;
- não apagar observações sem necessidade.

### 7.3 Conta implementada na FEAT-003

- `/conta`: Server Component valida a sessão, lê o perfil próprio e entrega um boundary fechado; anônimo retorna a `/entrar?retorno=%2Fconta`;
- `/conta/seguranca`: exibe o e-mail Auth somente leitura e oferece apenas os fluxos reais de recuperação de senha e logout; anônimo preserva o retorno allowlisted;
- `/entrar`: a query `retorno` somente atravessa a borda Server/Client quando for exatamente `/conta`, `/conta/seguranca`, `/dono` ou `/dono/recebimentos`; depois da validação ela vira o campo interno `returnTo`. Login bem-sucedido volta ao destino exato, e um resultado ambíguo preserva o mesmo destino na recomposição SSR. URL externa/protocol-relative, query ou fragmento extra, traversal, barra invertida, codificação alternativa e valor repetido são descartados; o servidor Auth continua sendo a decisão final;
- perfil incompleto: PF/PJ, nome, telefone, CPF/CNPJ e documento adicional opcional em uma coluna no mobile e grade no desktop;
- perfil completo: tipo PF/PJ somente leitura, documentos já salvos apenas mascarados e ações explícitas `manter | substituir | remover` quando aplicáveis;
- preferência: seletor nativo `Dispositivo | Claro | Escuro`, persistência autoritativa e aplicação sem paleta customizável;
- conta suspensa: status e dados próprios podem ser apresentados depois da revalidação, mas nenhum formulário de perfil ou aparência é montado.

Durante carregamento inicial, refetch, pausa offline ou divergência de escopo, nome, telefone, e-mail e documentos mascarados ficam ocultos por inteiro. Conflito oferece carregar a versão atual; timeout e erro mantêm recuperação explícita. CPF/CNPJ e documento novo vivem somente no formulário/ref efêmero, são apagados após todo desfecho remoto e nunca voltam em claro no DTO.

O logout de `/entrar` autenticado e `/conta/seguranca` usa o mesmo comportamento: a ação fecha imediatamente a superfície privada, nunca fica aguardando em fila offline e termina com limpeza integral do cache e composição SSR. Se a sessão mudou de A para B antes do servidor decidir, a ação antiga não encerra B; `getClaims` pode renovar ou manter a sessão internamente, mas a classificação de indisponibilidade, ausência e divergência termina antes de o fluxo obter explicitamente o cookie store e antes de fechar recovery, deletar cookies ou chamar `signOut`. Esses ramos têm zero efeitos destrutivos explícitos de logout. Durante login, a preferência visual pode aguardar no máximo um segundo no servidor; falha ou timeout usa `Dispositivo`, sem alterar o cookie tardiamente.

## 8. Checkout

### Cartão

- resumo;
- dados do pagador;
- componente/tokenização provider;
- botão com estado;
- sem duplo submit;
- mensagem de processamento;
- sucesso só após confirmação.

### PIX

- QR;
- copia/cola;
- contador;
- estado aguardando;
- polling sem spam;
- expiração;
- `Gerar novo PIX`.

### Conflito

Mensagem:

“O horário ficou indisponível antes da confirmação do pagamento. Nenhuma reserva foi criada. Escolha outro horário.”

Se provider cobrou indevidamente, não usar essa mensagem; abrir estado de reembolso/incidente.

## 9. Área do locatário

`/conta/reservas`:

- próximas;
- passadas;
- canceladas;
- cursor;
- status;
- data, estúdio, valor.

Detalhe:

- período;
- endereço;
- adicionais;
- pagamento;
- cancelamento;
- comprovantes/status;
- política usada.

## 10. Área do dono

Bootstrap da FEAT-004:

- `/dono` apresenta checklist factual, perfil canônico e contrato vigente; perfil incompleto aponta para `/conta`, contrato local é identificado como fixture e o checkbox nunca inicia marcado;
- `/dono/recebimentos` apresenta somente estado interno, requisitos e próxima ação allowlisted, versões e elegibilidade derivada; nunca exibe provider ID, payload, KYC ou dados bancários;
- a ação de onboarding exige `recipientOnboardingCapability=local_adapter`, além de `nextAction`. Quando a capability é `unavailable`, a interface preserva o estado factual, omite o aviso do adapter local e os CTAs de start/refresh e mostra um alerta com `role=status`: título `Cadastro de recebimentos indisponível` e texto `A integração de recebimentos ainda não está disponível neste ambiente. O estado atual permanece somente para consulta.`; nenhum controle desabilitado ou provider falso substitui a ação ausente;
- desktop pode compor checklist e conteúdo lado a lado; mobile, 320 px e reflow 160x360 usam uma coluna sem sidebar comprimida nem CTA sticky que cubra o contrato;
- loading/refetch/pausa/troca de sessão fecham status, elegibilidade e ações privados. Timeout ou resultado ambíguo oferece `Verificar estado atual`, sem afirmar falha nem reenviar cegamente; durante esse GET, a superfície privada fecha sob boundary neutro e, ao terminar, o foco programático vai ao heading do checklist no sucesso ou ao alerta seguro na falha. Nesse alerta, `Tentar novamente` repete o boundary e devolve foco ao heading somente após novo GET bem-sucedido;
- se uma nova versão do contrato surgir entre a tela e `start | refresh`, a API devolve `409 CONFLICT` e conduz ao mesmo `Verificar estado atual`; nenhuma tentativa é repetida. Dono ou recebedor realmente bloqueado continua proibido e não é apresentado como simples estado stale recuperável;
- `pending`, `active`, `refused`, `suspended` e `blocked` são apresentados por texto, não somente cor. Mudança assíncrona usa `role=status`, erro usa `role=alert` e foco retorna ao heading/alerta pertinente;
- não há link para estúdios, checkout, financeiro, suporte inventado, fallback administrativo nem formulário bancário enquanto essas superfícies não existirem.

Dashboard:

- estúdios/status;
- próximas reservas;
- pendências de revisão/recipient;
- próximos repasses;
- alertas operacionais.

Editor de estúdio:

- navegação por etapas;
- progresso derivado;
- autosave somente se seguro; baseline usa salvar explícito;
- status da revisão;
- preview aprovado/draft;
- submit com checklist.

Agenda:

- views;
- filtros;
- create/move block;
- eventos;
- iCal.

Financeiro:

- valores a receber;
- pagos;
- bloqueados;
- reserva relacionada;
- sem dados do cartão.

## 11. Backoffice

Definido em documento próprio. Composição densa, filtros server-side, preview de impacto e confirmação forte.

## 12. Estados obrigatórios

Toda rota:

- loading inicial estável;
- background refresh sem desmontar;
- vazio com CTA;
- erro de campo;
- erro de seção;
- erro global recuperável;
- 404 segura;
- 403;
- conflito;
- sucesso;
- offline/timeout quando relevante.

## 13. Copy crítica

- `Disponível` significa resultado atual, não garantia.
- `Preço estimado` até snapshot; `Total` quando quote.
- `Reserva confirmada` somente após pagamento.
- `Pagamento pendente` não é reserva.
- `Repasse programado` não é pago.
- `Alterações em análise` mantém versão pública anterior.

## 14. Deep links

- filtros na URL;
- date/slot em reserva;
- backoffice alvo;
- parâmetros de foco consumidos e removidos;
- nenhuma URL aberta pode executar ação destrutiva.

## 15. Mobile

- 320 px sem overflow;
- bottom nav só em áreas autenticadas se necessário;
- CTA respeita safe area;
- filtros em sheet;
- editor longo em páginas/steps;
- calendário adapta view padrão para dia;
- teclado não cobre ação;
- input 16 px;
- touch 44 px.
