# Soluções canônicas como princípio de excelência

## Estado

Implementado em fonte; validação integral, PR, review, merge e publicação permanecem pendentes.

## Motivação

O responsável do produto determinou que o Set Livre não aceite gambiarras ou workarounds. Uma
incompatibilidade precisa ser removida na origem e substituída por solução suportada, testada e
documentada.

## Alterações

- o ADR-022 formaliza a regra para produto, banco, infraestrutura, CI/CD, segurança e ambiente local;
- o contrato operacional proíbe bypass, supressão de erro, edição manual de gerados e enfraquecimento
  de testes;
- a documentação operacional distingue correção canônica de sucesso aparente e mantém bloqueios
  externos visíveis;
- indisponibilidade externa continua fail-closed e não autoriza fallback de custo, shape, região,
  segurança ou provedor.
- a reconciliação documental pós-ADR-021 mantém A1/ARM64 somente em snapshots históricos datados e
  usa `VM.Standard.E2.1.Micro` Linux x86_64 em todo claim operacional vivo;
- identidades GitHub do host são consultadas pelos paths registrados e verificadas como positivas e
  distintas; adivinhar ID, aceitar `404`/path divergente ou habilitar antes da prova é bypass proibido;
- a sandbox systemd do agente libera `/run/lock`, não `/run` inteiro; ampliar a fronteira para fazer a
  instalação passar seria workaround proibido;
- o responsável do produto confirmou novamente que essa regra vale para todo o Set Livre: nenhuma
  suppression, bypass, fallback silencioso, downgrade oportunista ou edição manual de artefato gerado
  constitui solução ou evidência de sucesso.

## Validação exigida

- `npm run format:check`;
- `npm run docs:check`;
- auditoria leve por código morto, fallback silencioso, supressão e incompatibilidade residual;
- `git diff --check`.

Esses gates não são declarados concluídos por este registro. A indisponibilidade da VM, o projeto
Supabase de São Paulo ainda não criado e a ausência de PR/deploy permanecem estados fail-closed, não
motivos para usar o projeto canadense, outro shape, outra região ou qualquer bypass.
