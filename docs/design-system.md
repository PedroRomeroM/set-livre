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

## 1.1 Estado implementado

A superfície técnica `FoundationStatus` continua exportada para comprovar a fundação nos dois apps. A FEAT-002 acrescentou as primitives compartilhadas consumidas pelos fluxos de autenticação. A FEAT-003 reutiliza essa base para a conta e acrescenta somente o `Select` nativo já consumido pela preferência visual e pelas ações explícitas sobre documentos. Nenhuma delas antecipa home, dashboard ou domínio posterior.

Os tokens usam prefixo `--sl-*` e cobrem cores neutras claro/escuro, estados de autenticação, tipografia, spacing, radius, altura mínima de controle, foco, sombra e larguras de conteúdo. `data-color-scheme="light|dark|system"` no elemento raiz seleciona os mesmos tokens: `light` e `dark` são explícitos; `system` acompanha `prefers-color-scheme`. O banco é canônico, `sl-color-scheme` é somente uma projeção `HttpOnly` allowlisted para a primeira pintura e a resposta autoritativa pode atualizar o atributo no cliente sem criar paleta paralela. A identidade segue neutra enquanto PEND-007/OPEN-003 estiver aberta. Novas primitives do catálogo abaixo continuam nascendo somente com uso real e sem sistema paralelo.

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

A focada race-fixed validou essa composição em 23/23 por quatro specs/14 projetos, e seu reuse foi aceito pela auditoria final. A rodada attribute-fixed coletou 114 testes em 17 specs/16 projetos e sua única execução passou em 114/114 em 5,6 minutos, com zero retry, erro ou attachment. A FEAT-004 preservou 23/23 em `3 + 3 + 3 + 4 + 3 + 4 + 3`, e o boundary no-JS da FEAT-002 passou nos três engines sem criar cenário. A auditoria encontrou 140 ocorrências dos 88 e-mails QA somente em títulos allowlisted — FEAT-002 60, FEAT-003 54, FEAT-004 26; `Fill` 110, `Type` 8 e `Expect` 22 —, zero secret/PII e cleanup zero. Evidência segura: `.artifacts/p5-owner-activation-capability-attribute-fixed/full.audit.json`, SHA-256 `5704c67cf21bdcc6e92b733bfdb8788972c216d48f850c885200b6d4d78a37d6`. As rejeições anteriores ficam como histórico diagnóstico do defeito já corrigido e do harness/oráculo, não como falha visual ou funcional atual. Static 749/749, DB 358/358, focada 23/23 e integral 114/114 estão verdes. Uma única build posterior compilou 26 + 4 rotas, mas seu standalone foi recusado por strings locais copiadas do antigo `scripts.knip`; nenhum smoke iniciou. O script foi limpo, a guarda cobre os quatro manifests canônicos e o Knip passou com as sete variáveis E2E explicitamente unset; a execução pós-manifesto que testou esse fix está registrada abaixo. Esse blocker é de empacotamento, não altera a composição visual validada.

A build pós-manifesto seguinte também foi recusada: apesar do exit `0`, restou uma ocorrência DAL em cada cache Turbopack; standalone/static/log ficaram limpos e o smoke continuou em zero. O wrapper único de build agora valida app/toolchain física antes do spawn e sempre tenta remover somente esse cache, inclusive em falha da validação/build, sem tocar standalone/static; o preview limpa antes de validar/startar. O run direcionado final passou em 40/40. O ajuste permanece estritamente operacional e não reabre os contratos visuais já verdes.

A cadeia estática final única passou em 764/764 por 76 arquivos, preservando DB 358/358 e browser 23/23 + 114/114. Após a remoção física dos dois `.next`, a build final via wrapper rodou exatamente uma vez, exit `0` em 14,733 s; log SHA-256 `44006829f25e63549e9e65ea17abbc483c891996130da34677ec67c932290ec9`. A auditoria independente SHA-256 `a1bb244bd53cb09034644bf7a5151cc887abbfb08eed5eceb8a8b7905157081d` terminou `NO-BLOCKER`, com 26 + 4 rotas, zero warnings/cache/retired e standalone/static/privacy/cleanup verdes. Esse era o fechamento pré-release.

O gerador canônico executou uma única vez para `2045d1a00c15889007b3c5c04c08d0467fc3d9b3`; o primeiro smoke P5 embutido ficou verde, e duas auditorias `NO-BLOCKER` validaram release local de 2.871 artefatos sem mismatch/segredo/PII/resíduo. O fechamento pós-release não altera os contratos visuais. ARM64 e remoto continuam pendentes.

### 3.4 Composição da FEAT-006

A FEAT-006 acrescenta somente a primitive nativa `Textarea`, com a mesma fonte de 16 px, borda,
foco, erro, estado disabled e fallback de forced colors de `Input`; o crescimento vertical é livre e
o redimensionamento horizontal não pode quebrar o reflow. `Field`, `Input`, `Select`, `Button`,
`Alert`, `Panel` e `Stack` continuam sendo reutilizados, sem card ou sistema visual paralelo.

O editor usa seções semânticas **Identificação**, **Apresentação**, **Endereço**, **Capacidade** e
**Pré-visualização**. Cidade/UF aparecem como texto factual `Curitiba · PR`, não controles. Descrição
possui contador; o formulário é não controlado e só monta depois de o seed SSR autoritativo fechar o
boundary de hidratação/refetch. Loading, pausa e troca de sessão omitem formulário, endereço,
descrição e preview em vez de exibir snapshot privado sob key incorreta.

Quando o form está dirty ou uma mutation está pendente, foco/online/visibilidade fecham de novo a
superfície durante o GET de escopo. O controller do formulário permanece montado por baixo do
boundary apenas para conservar hooks/callbacks; ele devolve DOM nulo, e os valores crus dos nove
controles ficam em refs efêmeras. Resposta same-scope restaura os mesmos valores e, se a mutation
ainda estiver pendente, mantém campos/CTA disabled. Troca A→B, unmount ou retorno pós-`await` arma o
latch e impede sucesso, foco ou comparação tardios. Nada desse payload vai para URL, storage ou
QueryCache.

Depois de qualquer save aceito, o painel remonta `StudioCoreForm` com uma revisão visual local além da
`editVersion`. Assim, até o no-op de um draft idêntico limpa dirty, erros e valores não canônicos a
partir do DTO retornado. Esse token não aparece na UI, no cache remoto ou no contrato de domínio;
publicado sem draft sempre cria revisão e não percorre o no-op.

Conflito usa `Alert` e comparação explícita entre **Versão atual** e **Sua tentativa**; reaplicar
somente repopula campos sobre a nova versão e nunca reenvia o comando. Descarte usa confirmação
inline com **Confirmar descarte** e **Cancelar**, nunca `window.confirm`. Sem tipos ativos, a UI
mostra o estado factual **Tipos de estúdio indisponíveis** e não monta select vazio, formulário ou
CTA disabled. A navegação do dono ganha apenas **Cadastrar estúdio**; portfólio e página pública
continuam ausentes até suas features proprietárias.

Na recuperação de create ambíguo, S1/A e a tentativa B permanecem visíveis sem perda. **Editar a
partir da versão atual** é a escolha explícita que navega ao editor canônico; **Reaplicar meus campos
ao formulário** preserva B e prepara um update de S1 com a versão autoritativa; o usuário ainda faz
um save explícito. A fonte desktop-chromium do ID 005 fixa K1/S1/A ambígua → GET 404 → usuário B →
commit tardio K1 → K2/S1/B 409 → comparação A/B → reaplicação → save K3, encerrando com um único S1.
A UI não serializa B. O roteiro está implementado na fonte, mas ainda não foi executado e não é verde.

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

### 10.1 FEAT-006 no snapshot atual

O editor privado usa boundary fechado, estados de loading/vazio/erro/conflito/sucesso e recuperação,
com composição própria para desktop/mobile. A fonte atual possui seis IDs: amplia 001 com probe
pending/same-scope, 002 com descarte `draft_removed`, 003 com dirty A→B, 004 com Tab/Enter e foco,
preserva 005 para comparação e adiciona 006 para reflow 160x360 nos três engines. Ela projeta 20
execuções por três specs/dez projetos e ainda não foi executada. O 17/17 por duas specs/sete projetos
é histórico, anterior às extensões; a coleta integral 131/19/16 não foi verde e a fonte atual projeta 134. As provas 23/23, 114/114 e builds descritas acima pertencem a outras features.

Os contratos de teclado, zoom e descarte existem agora em fonte, mas não são evidência runtime. O
`docs:check` canônico, integral unitária, DB 441 + gerados, browser 20/134, build das duas apps,
smoke/release e ARM64 permanecem pendentes. A tentativa histórica de build rejeitada pelo sandbox
não é falha visual/produto nem build verde.
