# Fonte de verdade e governança documental

## 1. Cadeia de autoridade

A arquitetura e a implementação seguem esta cadeia:

```text
Blueprint de arquitetura
  ↓
ADRs aceitos
  ↓
Especificação de produto e implementação
  ↓
Documentos vivos especializados
  ↓
Migrations, contratos e testes
  ↓
Código
```

### 1.1 Blueprint

`docs/reference/architecture-blueprint.md` é a referência confiável fornecida pelo projeto. Ele define princípios gerais, contratos de leitura/escrita, segurança, banco, UX, qualidade, infraestrutura e documentação.

O arquivo de referência deve permanecer íntegro. Correções ou novas versões são adicionadas como novo arquivo de referência e registradas em ADR; não se edita silenciosamente a origem.

### 1.2 ADRs

ADRs registram como os princípios foram aplicados ao domínio Set Livre. Um ADR pode escolher entre alternativas aceitas pelo Blueprint. Divergência real exige:

- seção do Blueprint afetada;
- motivo;
- risco;
- alternativa;
- plano de revisão;
- aprovação humana.

### 1.3 Especificação

`docs/specification.md` fecha o produto desta versão: perfis, escopo, regras globais, rotas, estados e exclusões. Alterar requisito aprovado exige changelog, impacto em features, QA e estimativa.

### 1.4 Documentos vivos

Os documentos vivos descrevem o estado atual da solução. Eles não são notas históricas. Devem refletir o que o código e o banco fazem no mesmo commit.

### 1.5 Código e testes

Código não altera contrato por acidente. Quando o comportamento necessário divergir da documentação, a documentação é corrigida/aprovada antes ou no mesmo PR.

## 2. Resolução de conflitos

1. Identificar os documentos conflitantes.
2. Aplicar a ordem de autoridade.
3. Não escolher a opção “mais fácil” sem decisão.
4. Abrir registro em `docs/open-decisions.md`.
5. Criar ADR quando segurança, dados, custo, integração, infraestrutura ou fronteira de aplicação forem afetados.
6. Atualizar especificação, features, QA e contexto.
7. Só então implementar.

## 3. Linguagem normativa

- **DEVE / NÃO DEVE:** obrigatório.
- **DEVERIA / NÃO DEVERIA:** padrão esperado; exceção exige justificativa.
- **PODE:** opção permitida.
- **PADRÃO PROVISÓRIO:** decisão reversível adotada para eliminar ambiguidade; pode ser alterada por produto sem quebrar princípio arquitetural.
- **BLOQUEADOR DE PRODUÇÃO:** implementação pode avançar em sandbox, mas produção não pode ser ativada sem resolução.

## 4. Versionamento

- versão documental atual: `1.1.0`;
- data-base: `2026-08-09`;
- região de produto: Curitiba/PR;
- idioma: PT-BR;
- fuso: `America/Sao_Paulo`;
- moeda: BRL.

## 5. Documentos canônicos

| Tema | Documento |
|---|---|
| Produto | `docs/specification.md` |
| Arquitetura | `docs/architecture.md` |
| Domínio | `docs/domain-model.md` |
| Banco | `docs/database.md` |
| Comandos e leituras | `docs/api-contracts.md` |
| Calendário/reserva | `docs/calendar-reservations.md` |
| Pagamento | `docs/payments.md` |
| Segurança/LGPD | `docs/security-privacy.md` |
| UX/rotas | `docs/ux-blueprint.md` |
| Design | `docs/design-system.md` |
| Infraestrutura | `docs/infrastructure.md` |
| QA | `docs/qa-test-plan.md` |
| Features | `docs/features/` |
| Riscos | `docs/risks.md` |
| Dívida | `docs/technical-debt.md` |
