# ADR-013 — CSS Modules, variables e primitives próprias

## Status
Aceito.

## Contexto
Frameworks utilitários e kits prontos podem criar dois sistemas visuais, dependências amplas e abstrações difíceis de controlar.

## Decisão
Usar CSS variables para tokens globais e CSS Modules para estilos locais. Criar primitives semânticas próprias em `packages/ui`.

Não usar Tailwind ou shadcn/ui. Bibliotecas headless só podem ser introduzidas por ADR quando reduzem risco de acessibilidade em comportamento complexo sem impor sistema visual paralelo.

## Alternativas
- Tailwind/shadcn: rejeitados por decisão do projeto.
- CSS global por tela: rejeitado.
- CSS-in-JS runtime: rejeitado.

## Consequências
- design system precisa de documentação e testes;
- composição responsiva é explícita;
- menos dependências, mais responsabilidade interna.
