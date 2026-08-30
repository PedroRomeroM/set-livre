# Design system

## 1. Tecnologias

- CSS variables;
- CSS Modules;
- primitives próprias;
- lucide-react para ícones;
- sem Tailwind;
- sem shadcn/ui;
- sem CSS-in-JS runtime.

`lucide-react` só será instalado quando uma feature tiver ícone real; não faz parte da fundação sem
consumidor.

## 1.1 Estado implementado

A superfície técnica `FoundationStatus` continua exportada para comprovar a fundação nos dois apps.
Seu rótulo é neutro ao ambiente: identifica a aplicação e a fundação técnica sem apresentar um deploy
como local. A FEAT-002 acrescentou as primitives compartilhadas consumidas pelos fluxos de
autenticação. A FEAT-003 reutiliza essa base para a conta e acrescenta somente o `Select` nativo já
consumido pela preferência visual e pelas ações explícitas sobre documentos. Nenhuma delas antecipa
home, dashboard ou domínio posterior.

Os tokens usam prefixo `--sl-*` e cobrem cores neutras claro/escuro, estados de autenticação, tipografia, spacing, radius, altura mínima de controle, foco, sombra e larguras de conteúdo. `data-color-scheme="light|dark|system"` no elemento raiz seleciona os mesmos tokens: `light` e `dark` são explícitos; `system` acompanha `prefers-color-scheme`. O banco é canônico, `sl-color-scheme` é somente uma projeção `HttpOnly` allowlisted para a primeira pintura e a resposta autoritativa pode atualizar o atributo no cliente sem criar paleta paralela. A tinta neutra `--sl-color-ink-muted` preserva contraste AA sobre canvas/superfícies em claro e escuro; cabeçalhos escuros podem sobrescrever somente os tokens locais necessários. A identidade segue neutra enquanto PEND-007/OPEN-003 estiver aberta. Novas primitives do catálogo abaixo continuam nascendo somente com uso real e sem sistema paralelo.

A superfície técnica ativa `viewport-fit=cover`, consome os quatro `safe-area-inset-*` e permite quebra de palavras somente quando necessária para preservar reflow em 390 e 320 px, texto ampliado e layout viewport de aproximadamente 160 CSS px sob zoom a 200%.

As páginas jurídicas da FEAT-002 compõem o conteúdo dentro de `PageFrame`/`Panel` e estilizam somente elementos semânticos gerados pelo subset Markdown local: `h2`–`h6`, `p`, `ul`, `ol`, `li`, `strong`, `em` e `a`. O título da rota continua sendo o único `h1`; listas conservam marcador/ordem, links mantêm foco global e sublinhado, texto longo quebra sem overflow e nenhum HTML bruto entra na árvore.

## 2. Tokens

Definir em `packages/ui/src/tokens.css`:

- `--color-surface-*`;
- `--color-text-*`;
- `--color-border-*`;
- `--color-action-*`;
- `--color-success/warning/danger/info`;
- escala de spacing;
- radius;
- control heights;
- focus ring;
- shadows;
- z-index nomeados;
- typography;
- content widths;
- safe area;
- calendar event semantics.

Nenhuma cor semântica é redefinida por tema.

## 3. Primitives obrigatórias

### Ações

- Button;
- ButtonLink;
- InlineLink;
- IconButton;
- SplitButton somente se comprovado.

### Formulários

- Field;
- Input;
- Textarea;
- Select;
- Checkbox;
- Switch;
- PasswordInput;
- DatePicker;
- TimeSelect;
- QuantityInput;
- ChoiceGroup;
- MoneyInput;
- FilePicker.

### Layout

- PageFrame;
- Stack;
- Cluster;
- ResponsiveGrid;
- FormGrid;
- SplitPane;
- StickyActionBar;
- AppShell.

### Superfícies

- Panel;
- PageHeader;
- EmptyState;
- Alert;
- Badge;
- Progress;
- Skeleton;
- DataList;
- Table/ResponsiveRows.

### Entidades

- StudioCard;
- ReservationCard;
- CalendarEvent;
- MediaTile;
- StatusTimeline.

### Overlays

- Modal;
- Drawer;
- BottomSheet;
- Popover;
- Tooltip;
- ToastViewport;
- Lightbox.

### Navegação

- PublicHeader;
- OwnerSidebar;
- AccountNav;
- MobileBottomNavigation;
- Breadcrumb;
- CursorPagination.

### 3.1 Primitives implementadas na FEAT-002

- `Button`: elemento `button` com `primary`, `secondary` e `ghost`. `loading` bloqueia duplo submit, aplica `aria-busy`, troca o nome acessível e mantém a largura medida pelo conteúdo original.
- `Field` + `Input`: `Field` associa label persistente, descrição, obrigatório e erro ao controle filho por `id`, `aria-describedby`, `aria-required` e `aria-invalid`; `Input` preserva toda a API nativa.
- `Checkbox`: checkbox nativo com label clicável e descrição associada. O alvo completo possui no mínimo 44 px.
- `ChoiceGroup`: grupo de radios nativos limitado ao recorte real `individual | company`, com modos controlado e não controlado mutuamente exclusivos, legend, descrição, obrigatório e erro de grupo.
- `PasswordInput`: Client Component que preserva a API nativa, usa botão textual `Mostrar senha`/`Ocultar senha` com `aria-controls` e `aria-pressed` e recebe requisitos tipados com estado textual `Requisito`, `Pendente` ou `Atendido`.
- `Alert`: feedback de seção `status` (`role=status`) ou `error` (`role=alert`), com conteúdo atômico e significado independente de cor.
- `Panel`, `Stack`, `PageFrame` e `AuthFrame`: superfícies e composição responsiva; `PageFrame` é o landmark `main`, aplica safe areas e limita largura, enquanto `AuthFrame` fornece um único `h1` e reflow próprio para autenticação.

Todos os controles têm foco visível, fonte de input de 16 px, alvo mínimo de 44 px, contraste em temas claro/escuro e fallback para forced colors. Bordas necessárias para identificar controles e painéis usam tokens próprios com contraste não textual mínimo de 3:1; linhas meramente estruturais permanecem separadas. As composições quebram em 320 px e no viewport equivalente a aproximadamente 160 CSS px, onde ações resetam o `flex-basis` horizontal e labels de loading podem ocupar mais de uma linha sem perder conteúdo; não há animação que precise ser preservada quando `prefers-reduced-motion` estiver ativo.

Exemplo mínimo:

```tsx
<Field label="Senha" required>
  <PasswordInput autoComplete="new-password" requirements={passwordRequirements} />
</Field>
<Button loading={isSubmitting} loadingLabel="Criando conta" type="submit">
  Criar conta
</Button>
```

O estado de formulário e de rota permanece no consumidor. Não usar `Alert` no lugar de erro de campo, `Panel` para envolver cada bloco, `ChoiceGroup` para valores fora de PF/PJ ou `PasswordInput` para definir a política do provider. Typecheck e lint validam a API compartilhada; teclado, axe, reflow e estados devem ser exercitados nos cenários Playwright SL-F002 da feature consumidora.

O `RegistrationForm` possui um boundary nativo próprio para o intervalo SSR → hidratação sem criar primitive paralela. `useSyncExternalStore` projeta o estado fechado no servidor e aberto no cliente. Antes da hidratação, o texto **Preparando o formulário seguro…** usa `role=status` fora do único `form`; o formulário fica `inert`, com `method=post` e `aria-busy`, e um `fieldset` sem borda, seus sete controles nomeados e o submit permanecem disabled. Depois do snapshot de cliente, o status some, o estado inerte é removido e os controles voltam à composição normal. O `fieldset` reutiliza o mesmo grid/gap do formulário, sem token ou sistema visual novo.

### 3.2 Extensão implementada na FEAT-003

- `Select`: elemento `select` nativo que preserva toda a API do HTML, compartilha altura, borda, erro, disabled, foco e forced colors de `Input` e permanece associado ao `Field` por label/descrição/erro. A aparência nativa é contida por um wrapper e uma seta decorativa `aria-hidden`, evitando que o texto intrínseco de uma opção aumente o `scrollWidth` no WebKit em reflow de 160 CSS px sem substituir a semântica do controle.
- composição de conta: `PageFrame` e `Panel` existentes recebem uma navegação semântica com `aria-current`; o conteúdo usa duas colunas somente quando há espaço e passa a uma coluna em 320 px e no layout viewport de 160 CSS px.
- aviso de privacidade: texto usa o token de tinta regular sobre a superfície suave de marca, preservando contraste textual WCAG AA nos temas claro e escuro.
- tema: a seleção `system | light | dark` usa `Select`, não `ChoiceGroup`; a mudança reaproveita os tokens existentes e nunca aceita cor de marca ou valor arbitrário.

Documentos continuam em inputs nativos não controlados e são limpos após qualquer desfecho remoto. Máscaras de CPF/CNPJ/telefone são somente apresentação; validação e normalização pertencem ao contrato tipado.

### 3.3 Composição da FEAT-004

A área do dono reutiliza `PageFrame`, `Panel`, `Stack`, `Alert`, `Button` e `Checkbox`; não cria primitive ou sistema visual paralelo. `/dono` e `/dono/recebimentos` compartilham uma navegação semântica com `aria-current`, checklist factual e uma única superfície de conteúdo. A composição passa a uma coluna em mobile e no layout viewport de 160 CSS px, preserva alvos de 44 px e não usa cor como única indicação de estado.

O contrato do dono reutiliza o renderer jurídico promovido ao domínio compartilhado `legal`: mantém um único `h1` da rota, restringe o corpo a `h2`–`h6`, parágrafos, listas, ênfase e links seguros e identifica `local_fixture` com `Alert` textual explícito. Quando `ownerActivationCapability=available`, o checkbox de aceite nunca começa selecionado e o erro de campo recebe foco e associação por `aria-describedby`/`aria-invalid`.

Quando `ownerActivationCapability=unavailable`, o mesmo documento e o aviso de fixture permanecem visíveis, mas formulário, checkbox e CTA não são montados nem substituídos por controles disabled. A composição reutiliza `Alert` na variante `status`, sem primitive, token ou estilo paralelo, com o título **Ativação como dono indisponível** e o corpo **A versão aprovada do contrato do dono ainda não está disponível neste ambiente. O contrato atual permanece somente para consulta.** O alerta não transforma a fixture em versão aprovada e não desmonta o conteúdo consultivo.

Status de ativação e recebedor são texto factual, não badge ornamental nem simulação de gateway. Loading inicial, refetch e troca de escopo substituem toda a superfície privada por um boundary neutro; erro ambíguo conserva o último snapshot e oferece `Verificar estado atual`, sem reenviar o comando. Essa verificação fecha novamente a superfície enquanto o GET está ativo e, ao terminar, transfere foco programático ao heading do checklist no sucesso ou ao alerta seguro na falha. `Tentar novamente` reutiliza o mesmo intent e restaura o heading somente após o retry bem-sucedido. Sucesso de comando continua usando `Alert` focável, e estados bloqueado, suspenso, recusado ou com contrato/perfil divergente exibem somente a ação autorizada pelo read model.

Os controles de onboarding também são gated por `recipientOnboardingCapability`. Em `local_adapter`, o notice local e o CTA compatível com `nextAction` permanecem visíveis. Em `unavailable`, ambos os CTAs de início/refresh e o notice são **ausentes**, não renderizados como disabled; o estado factual continua consultável e um `Alert` `status` (`role=status`) apresenta o título **Cadastro de recebimentos indisponível** e o corpo **A integração de recebimentos ainda não está disponível neste ambiente. O estado atual permanece somente para consulta.** A composição não inventa provider, prontidão ou ação que o servidor não autorizou.

### 3.4 Extensão da FEAT-006

- `ButtonLink`: âncora nativa para transições de rota com as variantes e dimensões de `Button`;
  preserva `href`, foco e o retry do navegador sem aninhar controles interativos;
- `Textarea`: textarea nativo que preserva toda a API HTML, herda borda, erro, disabled, foco e forced
  colors de `Input`, possui altura mínima de 9 rem e resize vertical. O contador de descrição pertence
  ao `Field`, não à primitive;
- editor de estúdio: seções semânticas de identidade/endereço, grid responsivo, preview local
  explicitamente não publicado e comparação de conflito em tabela acessível. A navegação do dono
  reutiliza os links e estilos existentes e passa a três colunas somente quando há espaço;
- hidratação: `StudioCorePanel` é o boundary inteiro. O servidor e o primeiro cliente exibem somente
  `Alert` com **Preparando o editor seguro**; depois do commit, um efeito cancelável libera de uma vez o
  formulário e o preview. Nenhum input existe antes dos handlers, evitando perda de digitação e
  mismatch sem duplicar estado de controle;
- o editor preserva 44 px, 320 px, tema escuro, forced colors e reflow a 160 CSS px. Erro de campo
  permanece no `Field`; conflito/timeout/sucesso usam `Alert` e ações explícitas. Em largura móvel, o
  cabeçalho semântico da comparação continua disponível a tecnologia assistiva e cada valor recebe
  rótulo visual **Sua versão**/**Versão salva**, sem depender da posição da coluna;
- depois da hidratação, uma segunda fronteira mantém formulário e preview privados fora do DOM enquanto
  o GET autoritativo está em curso ou falha. Criação aceita, retry ambíguo, bloqueio administrativo e
  taxonomia arquivada usam estados factuais e controles realmente desabilitados, não apenas aparência.

### 3.5 Extensão da FEAT-007

- taxonomias usam `fieldset`/`legend`, busca local por `Input type=search` e `Checkbox`; seleção mostra
  contagem factual e nunca cria opção improvisada;
- FAQ usa cards em fluxo normal e botões explícitos `Subir`, `Descer` e `Excluir`, todos com nome
  contextual. Arrastar não é requisito e a ordem continua operável por teclado e toque;
- regras, FAQ e vídeo ficam em um segundo formulário para não misturar intents idempotentes. A prévia
  renderiza nós React de plain text, sem HTML arbitrário;
- grids colapsam para uma coluna conforme o espaço disponível; iframe mantém proporção, título e
  largura máxima. A composição passou pela mesma matriz de 320 px, alvos de 44 px, tema escuro, axe e
  reflow a 160 CSS px.

### 3.6 Composição da FEAT-031

- o backoffice reutiliza `Button`, `Field`, `Input`, `PasswordInput`, `Select` e `Alert`, mas mantém
  shell/CSS Module próprios por ser uma aplicação separada;
- navegação mostra somente superfícies autorizadas; a ausência visual não substitui o fence do banco;
- usuários e taxonomias usam cards em grid, badges textuais, confirmação em fluxo normal e impacto
  factual. PII permanece em um painel temporário com `dl`, sem modal ou cache paralelo;
- grids externos e internos usam tracks `minmax(0, 1fr)`, descendentes encolhíveis e quebra de
  identificadores longos. Em 320 px, cada grupo vira uma coluna sem scroll horizontal; 390 px, altura
  compacta e tema escuro preservam os mesmos controles e alvos de 44 px;
- resposta ambígua bloqueia os campos afetados e apresenta repetição da mesma tentativa idempotente,
  sem spinner permanente nem criação de um novo comando silencioso.

## 4. Contratos

### 4.1 Botões

Variantes por semântica, não por cor arbitrária:

- primary;
- secondary;
- ghost;
- danger;
- link.

Loading mantém largura e desabilita duplo submit.

### 4.2 Form fields

- label persistente;
- description opcional;
- erro ligado por `aria-describedby`;
- required claro;
- contador quando texto longo;
- valor não desaparece em erro;
- server field errors mapeados.

### 4.3 Cards

- card clicável não contém ação interativa interna;
- nomes longos;
- imagem com aspect ratio;
- nenhum card dentro de card;
- foco visível;
- mobile densidade adequada.

### 4.4 Modais

- foco;
- restore;
- Escape;
- scroll lock;
- sem stack acidental;
- mobile fullscreen para fluxo longo;
- ação destrutiva explica impacto.

### 4.5 Calendar

- grid semântico;
- teclado para navegação;
- evento com texto;
- drag-and-drop tem alternativa por formulário;
- cor não é única informação;
- conflito anunciado.

### 4.6 Tabelas

Desktop pode usar tabela. Mobile usa rows/cards sem perder labels. Não criar scroll horizontal de página.

## 5. Breakpoints

Referência:

- compact: `<600px`;
- medium: `600–1023px`;
- desktop: `>=1024px`;
- height compact adicional.

Breakpoints são tokens/queries documentados; não espalhar valores sem motivo.

## 6. Acessibilidade

- WCAG 2.2 AA;
- 44 px;
- 320 px;
- 200% zoom;
- reduced motion;
- focus visible;
- semantic HTML;
- axe;
- contrast;
- screen reader labels.

## 7. Date/time

- UI local PT-BR;
- contrato ISO;
- timezone explícito;
- date picker com teclado;
- year navigation;
- min/max;
- portal/containment;
- mobile bottom sheet.

## 8. Money

MoneyInput:

- digitação amigável;
- normalização central;
- centavos;
- nenhum float;
- valor bruto no form;
- erro server-side.

## 9. Feedback

- campo: erro local;
- seção: alert;
- global: status page;
- toast: sucesso temporário;
- nunca usar toast como única chance de desfazer;
- mutation confirmada não “falha” porque refetch falhou.

## 10. Documentação

Toda primitive registra:

- objetivo;
- API;
- variantes;
- a11y;
- desktop/mobile;
- exemplos;
- teste;
- antiuso.
