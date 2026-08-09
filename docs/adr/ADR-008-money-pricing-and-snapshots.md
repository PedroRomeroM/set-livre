# ADR-008 — Dinheiro, precificação e snapshots

## Status
Aceito.

## Contexto
Preço pode variar por dia, faixa horária e adicionais. Regras podem mudar depois de uma reserva.

## Decisão
Armazenar dinheiro em centavos inteiros. Multiplicadores usam `numeric(8,4)`.

Preço de cada bloco de uma hora:

`base_cents × day_multiplier × time_band_multiplier`.

Cada bloco é calculado no fuso do estúdio, arredondado uma vez para centavos; adicionais são por unidade. A cotação persiste snapshot e line items. Reserva e pagamento referenciam o snapshot, nunca recalculam histórico com regra atual.

## Alternativas
- float: rejeitado.
- guardar somente total: rejeitado por auditoria.
- alterar reserva quando preço muda: rejeitado.

## Consequências
- quote expira e é recalculada no início do pagamento;
- histórico permanece explicável;
- alterações de preço afetam somente novas cotações.
