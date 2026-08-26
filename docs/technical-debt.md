# Dívida técnica

## 1. Regra

Nenhuma dívida existe apenas como TODO. Cada item contém:

- ID;
- data;
- impacto;
- evidência;
- owner;
- mitigação;
- revisão;
- critério de saída;
- link de issue/ADR.

## 2. Estados

- proposed;
- accepted;
- mitigating;
- resolved;
- rejected.

## 3. Registro inicial

| ID     | Estado   | Dívida/Risco aceito                 | Impacto                 | Evidência          | Owner    | Revisão           | Critério de saída             |
| ------ | -------- | ----------------------------------- | ----------------------- | ------------------ | -------- | ----------------- | ----------------------------- |
| TD-001 | accepted | VM única sem HA                     | indisponibilidade       | baseline free tier | infra    | após tração       | segunda instância/LB com SLO  |
| TD-002 | accepted | limiter em memória                  | perde estado/horizontal | VM única           | security | antes de escalar  | store compartilhado           |
| TD-003 | proposed | provider de e-mail ainda abstrato   | produção                | contrato pendente  | ops      | antes F029        | adapter live e contract test  |
| TD-004 | proposed | payment provider comercial pendente | bloqueia live           | OPEN-001           | finance  | antes F021        | contrato/ADR confirmado       |
| TD-005 | accepted | cidade/fuso fixos                   | expansão                | Curitiba           | product  | expansão regional | timezone/region ADR           |
| TD-006 | accepted | iCal manual sem sync                | operação do dono        | decisão de produto | product  | após validação    | demanda + ADR Google          |
| TD-007 | accepted | backoffice em mesma VM              | disputa recursos        | custo              | infra    | métricas          | VM separada quando necessário |

## 4. Template

Use `docs/templates/technical-debt.md`.
