# ADR-022 — Técnicas temporárias e qualidade de produção

## Status

Aceito em 2026-08-24 por esclarecimento humano explícito do princípio “sem gambiarras”.

## Contexto

“Sem gambiarras” foi interpretado como proibição de qualquer solução intermediária. Essa leitura
transformou problemas locais em implementações definitivas e superdimensionadas antes de conhecermos
a necessidade real. O princípio pretendido é impedir improvisação em produção, não impedir
experimentação responsável durante desenvolvimento e diagnóstico.

## Decisão

Existem três estados distintos:

1. **Experimento ou diagnóstico:** pode ser criativo, incompleto ou temporário, desde que seja local,
   explícito, reversível, sem segredo/dado real e sem produzir evidência falsa.
2. **Candidato a merge:** remove o expediente ou o transforma em solução suportada; testes e
   documentação comprovam o contrato relevante.
3. **Produção:** aceita somente solução suportada, segura, observável, com rollback e operação
   compreensível.

Regras adicionais:

- um expediente temporário deve ter fronteira e critério de saída conhecidos;
- ele não pode enfraquecer teste, ocultar erro, fabricar sucesso ou atravessar o artifact de produção;
- local adapters e fixtures precisam falhar fechados fora de `local | test`;
- antes de endurecer um protótipo, comparar remoção, ferramenta suportada e solução menor;
- preferir bibliotecas e serviços maduros a frameworks próprios quando reduzem código e operação;
- dependência nova exige avaliação proporcional, mas essa regra não pode incentivar reinvenção;
- complexidade precisa de ameaça, requisito ou métrica concreta. “Pode acontecer” não basta;
- rollback é mecanismo normal; indisponibilidade externa continua inconclusiva, não aprovação.

## Alternativas

- proibir toda técnica temporária: rejeitado porque atrasa aprendizado e incentiva overengineering;
- permitir workaround silencioso em produção: rejeitado por confiabilidade e segurança;
- manter protótipos indefinidamente atrás de flags: rejeitado porque transforma temporário em dívida
  invisível.

## Consequências

- desenvolvimento pode avançar em passos menores e corrigíveis;
- review deve distinguir dívida temporária visível de risco produtivo;
- nenhum código é promovido apenas porque “funcionou uma vez”; a fronteira de produção continua forte;
- documentação e testes devem provar comportamento, não cada detalhe interno de uma solução transitória.
