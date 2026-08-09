# Decisões abertas e defaults normativos

Este arquivo registra decisões que dependem de negócio, fornecedor ou material legal e conflitos documentais cuja explicitação é exigida pelo `AGENTS.md`. Conflitos resolvidos permanecem registrados com referência ao ADR autoritativo, sem competir com ele.

## OPEN-001 — Gateway de pagamento de produção

**Status:** bloqueador de produção.

**Default de implementação:** contrato `PaymentProvider` e adapter Pagar.me em sandbox, porque o escopo exige cartão, PIX, recebedores, split e reembolso. Um adapter Asaas pode substituir o provider sem alterar domínio.

**Antes de produção:** confirmar contrato comercial, onboarding de marketplace, regras de recebedor, responsabilidade por taxas, prazo de liquidação e capacidade de repasse após o uso.

**Não permitido:** codificar sem adapter, expor campos do provider ao domínio ou tratar o mock como produção.

## OPEN-002 — Textos jurídicos

**Status:** bloqueador de publicação.

Necessários:

- Termos de Uso;
- Política de Privacidade;
- Política de Cancelamento;
- contrato/aceite do dono;
- regra de responsabilidade pela agenda;
- aviso de tratamento de dados.

O sistema implementa versionamento e aceite, mas o conteúdo final deve vir de responsável jurídico.

## OPEN-003 — Identidade visual final

**Status:** não bloqueia fundação.

Default:

- tokens sem marca fechada;
- contraste WCAG AA;
- tipografia de sistema ou fonte licenciada definida no projeto;
- nenhuma cor hardcoded fora dos tokens.

## OPEN-004 — Limites comerciais de mídia

**Status:** default reversível.

Default de implementação:

- 1 a 20 fotos por estúdio;
- 15 MB por arquivo;
- JPEG, PNG, WebP ou AVIF;
- sem SVG/GIF;
- vídeo somente YouTube;
- capa obrigatória para revisão.

## OPEN-005 — Prazo de repasse

**Status:** depende do gateway/contrato.

Default de domínio: liberar repasse 24 horas após o fim da reserva, desde que não exista cancelamento, disputa, refund pendente ou bloqueio administrativo.

## OPEN-006 — Janela de lembrete

Default: 24 horas antes do início. Configurável em ambiente, não por usuário nesta versão.

## OPEN-007 — Ciclos e ordens concorrentes entre features

**Status:** resolvida em 2026-08-09 pelo ADR-017.

**Conflito registrado:** a seção genérica “Dependências” dos documentos de feature misturava pré-requisitos de início, integrações posteriores e bloqueios de produção. Sua leitura literal formava ciclos, enquanto `CODEX_HANDOFF.md` e `docs/implementation-order.md` agrupavam as features em ordens diferentes.

**Resolução:** o ADR-017 definiu `dependency-to-start`, `dependency-to-complete`, `dependency-to-release` e capacidades bootstrap. `docs/implementation-order.md` contém a única sequência executável das 34 features; o handoff apenas referencia essa fonte.

**Guardrail:** uma feature por branch/PR, nenhuma ação ou schema antecipado sem consumidor real e validação documental de unicidade, ordem e ausência de ciclos nas dependências fortes.

**Critério de reabertura:** reabrir somente se uma nova dependência forte tornar a sequência acíclica impossível ou se uma integração posterior ficar sem proprietário e cenário QA.
