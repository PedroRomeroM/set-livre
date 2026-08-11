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

## OPEN-008 — Bootstrap de identidade e núcleo legal

**Status:** resolvida em 2026-08-11 para a FEAT-002, dentro dos ADRs 004, 005, 016, 017 e 018.

**Conflito registrado:** a FEAT-002 exigia cadastro PF/PJ, perfil parcial e aceite legal, mas seu texto citava `profile.complete`, cuja conclusão e dados pessoais pertencem à FEAT-003. A FEAT-019 é proprietária do retorno a uma reserva, enquanto a FEAT-034 é proprietária dos direitos LGPD completos e dos textos jurídicos aprovados.

**Resolução:** a FEAT-002 cria somente uma identidade mínima (`person_type`, status e conclusão nula) e o `legal-core`. O comando convidado `identity.register` cria no DAL uma intenção jurídica opaca, temporária e de uso único; o trigger de `auth.users` consome essa intenção na mesma transação que cria o perfil mínimo e os dois fatos de aceite. O navegador nunca escreve perfil ou aceite diretamente. Os documentos ficam versionados no banco; o seed local é marcado como `local_fixture` e não vale como conteúdo jurídico aprovado.

**Superfícies atuais:** `/cadastro`, `/entrar`, `/recuperar-senha`, `/auth/callback`, `/termos` e `/privacidade`. O único retorno autenticado permitido nesta fatia é a própria superfície de sessão de `/entrar`; `/conta`, `/reservar` e restauração de draft não são antecipados.

**Fronteira de sessão:** Auth usa cliente SSR por request, validação autoritativa server-side e cookies `HttpOnly`/`SameSite`; `Secure` é obrigatório em produção e fica desativado apenas no HTTP loopback local. Confirmação e recovery usam `TokenHash` exclusivamente no fragmento de templates locais; o fragmento não entra na request inicial e é removido antes da chamada JSON ao servidor. A sessão criada por recovery recebe binding/tombstone privada pelo `session_id` assinado e nunca é aceita como login comum. Seu `session_scope` UUID é público, opaco e serve apenas ao cache; a autorização exige JWT validado, linha canônica de Auth, binding e grant vigente de 15 minutos. A expiração JWT fica pinada em `3600` segundos, e ausência em `auth.sessions` inicia retenção conservadora antes de qualquer purge da tombstone.

**Critério de reabertura:** somente uma necessidade comprovada da FEAT-003, FEAT-019 ou FEAT-034 que não caiba nos contratos extensíveis acima, ou aprovação dos textos reais que encerre o bloqueio jurídico.
