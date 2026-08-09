# ADR-009 — Fronteira do provedor de pagamento

## Status
Aceito com decisão comercial pendente para produção.

## Contexto
O escopo exige cartão, PIX, split, recebedores, reembolso e repasse após o uso. Fornecedores e contratos podem mudar.

## Decisão
Criar interface `PaymentProvider` server-only com contratos de:

- customer/recipient onboarding;
- início de cartão;
- início de PIX;
- cancelamento de tentativa;
- consulta de status;
- reembolso;
- criação/consulta de split;
- transferência/repasse;
- verificação de webhook.

A implementação de referência é Pagar.me em sandbox. Provider IDs ficam em tabelas de integração e não vazam para DTOs públicos. Webhook é a principal origem de transição, complementado por reconciliação.

## Alternativas
- acoplar domínio ao JSON do provider: rejeitado.
- implementar dois providers na baseline: rejeitado.
- captura manual fora da aplicação: rejeitada para o fluxo principal.

## Consequências
- produção depende de contrato/onboarding;
- testes de contrato usam fixtures sanitizadas;
- adapter alternativo não altera estados de domínio.
