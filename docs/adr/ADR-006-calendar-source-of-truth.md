# ADR-006 — Calendário próprio como fonte de verdade

## Status
Aceito.

## Contexto
A plataforma precisa de disponibilidade real, buffers, exceções, conflitos, reservas e operação segura. Dependência obrigatória de agenda externa aumentaria risco.

## Decisão
O calendário interno é a única fonte canônica de disponibilidade e alocações.

A baseline inclui:

- horário semanal;
- exceções;
- bloqueios manuais;
- reservas e holds;
- buffer;
- calendário semana/mês/dia;
- drag-and-drop somente para objetos editáveis;
- agenda consolidada;
- importação/exportação manual iCal.

Google Calendar automático fica fora da versão 1.1.

## Alternativas
- Google como fonte principal: rejeitado.
- sincronização bidirecional na baseline: rejeitada por risco/custo.
- somente calendário básico: rejeitado pelo escopo comercial completo.

## Consequências
- plataforma controla invariantes;
- donos precisam manter a agenda interna;
- iCal oferece interoperabilidade manual;
- integração externa futura exige ADR e mapeamento explícito.
