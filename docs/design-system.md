# Design system

## 1. Tecnologias

- CSS variables;
- CSS Modules;
- primitives próprias;
- lucide-react para ícones;
- sem Tailwind;
- sem shadcn/ui;
- sem CSS-in-JS runtime.

`lucide-react` será instalado somente no primeiro PR que tiver ícone real; não faz parte da fundação sem consumidor.

## 1.1 Estado da fundação

A fundação implementa apenas `packages/ui/src/tokens.css` e a superfície técnica `FoundationStatus`, compartilhada pelos dois apps para comprovar isolamento, responsividade e contraste. Ela não representa home, dashboard ou feature de produto.

Os tokens atuais usam prefixo `--sl-*` e cobrem cores neutras claro/escuro, tipografia, spacing, radius, foco, sombra e largura de conteúdo. A identidade é deliberadamente neutra enquanto PEND-007/OPEN-003 estiver aberta. Primitives do catálogo abaixo nascem somente junto ao primeiro uso real e devem ampliar os tokens sem criar um sistema paralelo.

A superfície técnica ativa `viewport-fit=cover`, consome os quatro `safe-area-inset-*` e permite quebra de palavras somente quando necessária para preservar reflow em 390 e 320 px, texto ampliado e layout viewport de aproximadamente 160 CSS px sob zoom a 200%.

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
