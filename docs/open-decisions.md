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

**Superfícies entregues pela FEAT-002:** `/cadastro`, `/entrar`, `/recuperar-senha`, `/auth/callback`, `/termos` e `/privacidade`. O único retorno autenticado permitido naquela fatia era a própria superfície de sessão de `/entrar`; `/conta`, `/reservar` e restauração de draft não foram antecipados.

**Fronteira de sessão:** Auth usa cliente SSR por request, validação autoritativa server-side e cookies `HttpOnly`/`SameSite`; `Secure` é obrigatório em produção e fica desativado apenas no HTTP loopback local. Confirmação e recovery usam `TokenHash` exclusivamente no fragmento de templates locais; o fragmento não entra na request inicial e é removido antes da chamada JSON ao servidor. A sessão criada por recovery recebe binding/tombstone privada pelo `session_id` assinado e nunca é aceita como login comum. Seu `session_scope` UUID é público, opaco e serve apenas ao cache; a autorização exige JWT validado, linha canônica de Auth, binding e grant vigente de 15 minutos. A expiração JWT fica pinada em `3600` segundos, e ausência em `auth.sessions` inicia retenção conservadora antes de qualquer purge da tombstone.

**Critério de reabertura:** somente uma necessidade comprovada da FEAT-003, FEAT-019 ou FEAT-034 que não caiba nos contratos extensíveis acima, ou aprovação dos textos reais que encerre o bloqueio jurídico.

## OPEN-009 — CPF e CNPJ alfanumérico no perfil

**Status:** resolvida em 2026-08-11 para a FEAT-003, dentro dos ADRs 003, 005, 015 e 017.

**Conflito registrado:** o documento original da FEAT-003 dizia que CPF e CNPJ teriam valor canônico composto somente por dígitos. Esse contrato deixou de representar o cadastro oficial brasileiro: desde julho de 2026, novas inscrições de CNPJ podem combinar letras de `A` a `Z` e números nas doze primeiras posições, enquanto as duas últimas continuam sendo dígitos verificadores. CNPJs numéricos existentes permanecem válidos e os dois formatos coexistem.

**Resolução:** CPF continua normalizado em onze dígitos. CNPJ passa a ser normalizado em quatorze caracteres maiúsculos, com `A-Z`/`0-9` nas doze primeiras posições e dois dígitos ao final. Ambos validam os dígitos verificadores no contrato TypeScript e no PostgreSQL. Pontuação é somente apresentação; o banco guarda a forma canônica sem separadores. A referência normativa e técnica é o [programa CNPJ Alfanumérico da Receita Federal](https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/acoes-e-programas/programas-e-atividades/cnpj-alfanumerico) e seu [manual de cálculo do DV](https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/cnpj).

**Defaults reversíveis da FEAT-003:** o documento adicional é texto opaco opcional de até quarenta caracteres, nunca arquivo nem prova de identidade; a única preferência visual inicial é `system | light | dark`; PF/PJ pode ser corrigido durante a conclusão, mas fica imutável depois dela. Nome, telefone e substituição ou remoção explícita dos documentos permanecem editáveis pelo próprio titular sem reescrever fatos históricos.

**Critério de reabertura:** alteração normativa da Receita Federal, necessidade comprovada de um tipo documental canônico ou exigência de verificação documental. Upload, verificação e direitos LGPD completos continuam fora da FEAT-003.

## OPEN-010 — Fronteira local do dono e do recebedor

**Status:** resolvida em 2026-08-12 para a FEAT-004, dentro dos ADRs 003, 004, 005, 009, 011, 015, 016, 017 e 018.

**Conflitos registrados:** o documento original da FEAT-004 divergia da especificação entre `/dono/inicio` e `/dono`; `terms_versions` só comportava Termos e Privacidade apesar de a ativação exigir contrato próprio do dono; `owner_profiles` planejava nome e telefone sem contrato de coleta/correção distinto do perfil; `recipient.bank.update` não possuía payload provider-independent; e as referências a sandbox, fallback administrativo e bloqueio de checkout misturavam a fatia local com integrações pertencentes a features posteriores.

**Resolução:**

- a rota canônica é `/dono`, conforme a especificação superior; `/dono/inicio` não ganha alias. `/dono/recebimentos` permanece a superfície específica do recebedor;
- `owner_contract` é um tipo jurídico próprio. O seed local continua explicitamente `local_fixture`, a versão aprovada continua bloqueada por PEND-006 e o read model público de cadastro permanece limitado a `terms | privacy`;
- `owner_profiles` materializa somente autoridade, status, versão e referência à versão contratual atualmente aceita; cada aceite permanece imutável no histórico de `terms_acceptances`. Nome, telefone e documentos continuam canônicos em `profiles` e não são duplicados nem editados separadamente;
- o estado interno do recebedor usa `not_started | pending | active | refused | suspended | blocked`. `blocked` é terminal nesta fatia; os demais estados só mudam por resultado provider mapeado e validado. Requisitos e próxima ação são códigos internos allowlisted, nunca texto, URL ou payload externo;
- os únicos requisitos públicos desta fatia são `identity_review | additional_information | provider_contact`, e a próxima ação é `activate_owner | start_onboarding | refresh_status | none`. A matriz aceita `not_started -> pending`; `pending -> pending | active | refused | suspended | blocked`; `active -> active | refused | suspended | blocked`; `refused -> pending | refused | blocked`; `suspended -> pending | active | suspended | blocked`; e `blocked -> blocked`;
- a referência do provider e o estado de idempotência ficam em tabelas `private`. A projeção autenticada expõe somente estado seguro, versões e elegibilidade;
- a elegibilidade é derivada no servidor: dono ativo, versão vigente do `owner_contract` aceita, recebedor ativo e `profile_version_synced` igual à versão canônica atual do perfil. Qualquer ausência ou divergência falha fechada. Uma nova versão do contrato preserva o aceite histórico, marca a projeção como pendente e exige novo aceite idempotente; a FEAT-020 revalida esse fato antes de cobrar;
- o adapter local determinístico implementa somente start/refresh e é recusado fora de `local | test`. A ativação com contrato `source=local_fixture` também falha fechada fora desses ambientes; uma futura versão `approved` continua dependente de PEND-006. Pagar.me/Asaas, SDK, HTTP, credenciais, webhook e sandbox remoto continuam suspensos pelo ADR-018 e bloqueados por PEND-004;
- o caminho nominal local faz `start -> pending` e `refresh -> active`. Recusa, suspensão, bloqueio, indisponibilidade e timeout são comprovados por mapper/serviço e por fixtures locais de teste, sem comportamento mágico baseado em e-mail, UUID ou payload do navegador;
- `recipient.bank.update` e campos bancários não entram até existir token ou handoff provider-owned aprovado. Não haverá formulário, botão desabilitado ou payload provisório;
- esta fatia audita somente ativação e transições do recebedor em `audit.events`. RBAC e liberação administrativa pertencem à FEAT-031/032; fallback financeiro e sua auditoria não são antecipados;
- correções, exportação, anonimização e retenção dos novos fatos permanecem integração posterior da FEAT-034;
- os DALs de comando do app público compartilham um pool restrito de no máximo seis conexões. Somados ao pool de readiness do app público e ao pool de readiness do backoffice, ambos limitados a duas conexões, os processos simultâneos preservam o teto do login runtime: `6 + 2 + 2 = 10`. Nenhum processo possui orçamento implícito além desse limite.

**Critério de reabertura:** contrato comercial ou jurídico aprovado, handoff provider-owned que exija novos campos, mudança da matriz de status, necessidade comprovada de dados comerciais distintos do perfil ou requisito de fallback antes das features administrativas proprietárias.
