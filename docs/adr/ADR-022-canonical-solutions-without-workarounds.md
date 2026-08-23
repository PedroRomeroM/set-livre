# ADR-022 — Soluções canônicas sem workarounds

## Status

Aceito em 2026-08-18 por instrução humana explícita.

## Contexto

A migração para Windows e a preparação de Supabase Cloud, GitHub Actions e Oracle Cloud expuseram
situações em que seria possível mascarar incompatibilidades: ignorar um erro da CLI, transplantar um
artefato gerado, enfraquecer um teste obsoleto, manter uma ferramenta inadequada ou contornar um
guard de segurança apenas para avançar um gate. Essas opções reduzem a confiabilidade do sistema e
transformam uma falha conhecida em dívida invisível.

Excelência é um princípio explícito do Set Livre. Um gate verde só tem valor quando comprova a
solução suportada e factual.

## Decisão

- gambiarras, workarounds, bypasses, supressões de erro e relaxamentos de teste não são aceitos como
  solução versionada ou condição de conclusão;
- a causa raiz precisa ser identificada. Ferramenta, versão, dependência ou configuração incompatível
  é removida integralmente da fronteira afetada e substituída pela alternativa canônica suportada;
- testes são atualizados somente para expressar o contrato correto. Não se altera produto ou proteção
  para satisfazer uma expectativa obsoleta;
- artefatos gerados são produzidos exclusivamente pelo gerador canônico e por seus gates. Cópia manual
  ou edição direta não substitui geração, comparação integral ou evidência;
- erro, indisponibilidade de fornecedor e falta de capacidade permanecem fail-closed. Não se troca
  silenciosamente shape, custo, região, segurança, versão ou provedor para obter sucesso aparente;
- uma correção que não possa ser implementada e comprovada de forma correta bloqueia PR, merge ou
  deploy e é registrada como pendência factual;
- rollback para a última release comprovada é mecanismo canônico de recuperação, não workaround;
- compatibilidade deliberada só é permitida quando for um requisito real de produto ou migração,
  estiver descrita em ADR, tiver prazo/fronteira claros e preservar todos os invariantes de segurança,
  dados, testes e rollback.

## Alternativas rejeitadas

- manter uma versão problemática com patch local não suportado: rejeitado por não ser reproduzível;
- ignorar warnings ou erros conhecidos para concluir um gate: rejeitado por produzir evidência falsa;
- editar snapshot, dump ou tipo gerado manualmente: rejeitado por romper a cadeia de autoridade;
- reduzir a força de um teste para conservar implementação inadequada: rejeitado por inverter a fonte
  de verdade;
- usar fallback pago, menos seguro ou de outro projeto sem decisão humana: rejeitado por custo,
  isolamento e governança.

## Consequências

- correções podem levar mais tempo, mas removem a causa em vez de ocultá-la;
- bloqueios externos permanecem visíveis e não são reclassificados como sucesso;
- cada substituição de ferramenta ou abordagem precisa remover configuração e código morto do caminho
  anterior;
- reviews e auditorias devem procurar explicitamente supressões, fallbacks silenciosos, duplicação
  temporária permanente e testes acomodados;
- a regra se aplica a produto, banco, infraestrutura, CI/CD, segurança, documentação e ambiente local.
