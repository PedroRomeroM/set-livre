# Pendências externas da Set Livre

Somente dependências de negócio, conteúdo ou serviço externo ficam aqui. Dívida técnica pertence a
`docs/technical-debt.md`; ações humanas da entrega atual ficam em `configuration-steps.md`.

| ID       | Área            | Estado       | Dependência e critério de saída                                                                                                      |
| -------- | --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| PEND-001 | entrega         | em andamento | CI/CD, branch protection, PR/review limpo, merge e primeiro deploy público comprovados                                               |
| PEND-002 | dados           | em andamento | primeiro deploy exige migrations, role DAL e advisors verdes; backup gerenciado e restore são gates do go-live                       |
| PEND-003 | infraestrutura  | em andamento | VM, SSH e certificado TLS de IP prontos, com renovação simulada; falta o primeiro release e o readiness HTTPS do SHA; DNS foi adiado |
| PEND-004 | pagamentos      | aberta       | gateway/contrato aprovados para sandbox/live, recebedor, split, refund, webhooks e repasse                                           |
| PEND-005 | e-mail          | aberta       | provider SMTP/transacional, domínio remetente, reputação, credenciais e retenção aprovados                                           |
| PEND-006 | jurídico        | aberta       | Termos, Privacidade, Cancelamento e contrato do dono aprovados e versionados                                                         |
| PEND-007 | marca           | aberta       | logo, paleta, tipografia/licenças e guia final aprovados                                                                             |
| PEND-008 | observabilidade | aberta       | error tracking, canal/owners de alertas, retenção, orçamento e PII scrub aprovados                                                   |

## Regras

- Local/test nunca usa credencial, dado ou provider de produção.
- Adapter local ou fixture não pode ser promovido como integração real.
- Uma pendência só fecha com evidência, data e PR/deployment correspondente.
- Não criar schema, botão ou serviço “para o futuro” apenas por existir uma pendência.
