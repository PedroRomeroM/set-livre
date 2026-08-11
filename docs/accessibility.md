# Acessibilidade — WCAG 2.2 AA

## 1. Meta

Todas as rotas públicas, autenticadas e de backoffice devem atender WCAG 2.2 AA no escopo aplicável.

## 2. Requisitos

- landmarks;
- heading hierarchy;
- labels;
- instructions;
- error association/live announcements;
- visible focus;
- full keyboard;
- modal focus trap/restore;
- skip link;
- icon accessible names;
- toggle `aria-pressed`;
- no color-only meaning;
- contrast;
- reduced motion;
- zoom a 200% com layout viewport equivalente de aproximadamente 160 CSS px;
- reflow sem scroll horizontal em 320 px e no viewport reduzido pelo zoom;
- 44x44 targets;
- no hover-only;
- table alternatives;
- chart textual summary;
- calendar non-drag alternative;
- date picker keyboard;
- status messages.

## 3. Booking/payment

- price line items readable;
- expiry not conveyed only by animation;
- QR has textual copy option;
- provider fields labeled;
- errors announced;
- processing uses live region without spam;
- success/failure focus moves to heading.

## 4. Calendar

- each event has accessible text;
- keyboard create/edit manual block;
- drag is optional enhancement;
- time grid header relationships;
- conflicts announced;
- buffer label;
- mobile day view.

## 5. Media

- meaningful alt;
- decorative marked;
- lightbox keyboard;
- close button;
- focus restore;
- no autoplay video;
- captions controlled by YouTube availability, with title.

## 6. Testing

- axe in main feature scenario;
- manual keyboard checklist;
- screen reader spot checks;
- zoom 200% validado por layout viewport de 160x360 CSS px nos três engines, além da ampliação textual;
- safe areas com insets não nulos em cenário de device;
- Windows high contrast when practical;
- reduced motion;
- mobile touch target scan.

No feature closes with critical/serious axe violation.
