# ADR-002 — Fronteiras do repositório e aplicações

## Status
Aceito.

## Contexto
A aplicação pública e a operação administrativa possuem superfícies, secrets, rotas e riscos diferentes.

## Decisão
Usar npm workspaces com:

- aplicação pública na raiz;
- `apps/backoffice` como aplicação Next.js separada;
- `packages/contracts` para DTOs/Zod compartilháveis;
- `packages/ui` apenas para primitives realmente compartilhadas.

Cada aplicação tem build, porta, sessão e variáveis próprias.

## Alternativas
- `/admin` no app público: rejeitado por ampliar superfície e misturar secrets.
- Repositórios separados: rejeitado inicialmente pelo overhead e necessidade de contratos sincronizados.
- Microfrontends: rejeitado por complexidade sem benefício.

## Consequências
- deploy e acesso do backoffice são independentes;
- public app não contém rotas administrativas;
- compartilhamento precisa evitar acoplamento circular;
- CI compila e testa as duas aplicações.
