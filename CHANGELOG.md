# Changelog documental

## 1.1.0 — 2026-08-09

### Alterado

- substituído o escopo do mini fórum pela plataforma completa de aluguel de estúdios;
- adotada a cadeia de autoridade Blueprint → ADRs → especificação → documentos vivos → código;
- adotado npm no lugar de pnpm;
- removidos Tailwind e shadcn/ui;
- adotados CSS Modules, CSS variables e primitives próprias;
- formalizado TanStack Query, query keys, cursores e invalidação;
- centralizadas escritas críticas em `POST /api/commands`;
- definido DAL server-only com role restrita e comandos SQL privados;
- formalizadas migrations append-only, grants mínimos, RLS e testes entre usuários;
- adotados read models pequenos e paginação keyset;
- substituídos enums PostgreSQL evolutivos por `text` com `check`;
- separado o backoffice em aplicação própria;
- substituído Docker/Caddy/GHCR por standalone, systemd, Nginx e releases por SHA;
- formalizados mobile a 320 px, safe areas, toque de 44 px e WCAG 2.2 AA;
- criado catálogo QA com IDs e rastreabilidade por feature;
- criada política estruturada de dívida técnica e documentação viva.

### Adicionado

- calendário próprio avançado;
- modelo de reservas e concorrência;
- integração de pagamento com cartão/PIX/split/repasse;
- backoffice completo;
- especificações feature a feature;
- ADRs iniciais;
- runbooks de deploy, backup, restore e incidentes.

### Estado de repositório recebido

- primeiro commit local informado: `d755c9f chore: initialize repository architecture foundation`;
- commit contém Git e Blueprint;
- nenhum push informado;
- documentação de governança preparada para commit separado;
- nenhum arquivo do projeto Spenses foi alterado.
