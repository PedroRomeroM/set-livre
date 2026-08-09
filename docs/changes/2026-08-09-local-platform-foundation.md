# Mudança: fundação local da plataforma

- Data: 2026-08-09
- Autor/agente: Codex
- Issue/PR: branch `agent/foundation-local-platform`; PR criado após o commit desta mudança
- Features: fundação transversal
- ADRs: ADR-017, ADR-018
- Risco: médio
- Rollback: reverter o commit da fundação; a baseline documental permanece em `main`

## Resumo

Cria a fundação executável local da Set Livre: workspaces npm, aplicações pública e de backoffice, pacotes compartilhados, contratos de qualidade, Supabase local, guardrails documentais e smoke tests. CI/CD, Supabase Cloud, Oracle Cloud e providers externos permanecem deliberadamente fora desta etapa.

## Motivo

O repositório remoto estava vazio e o pacote recebido continha somente documentação. A plataforma precisa de uma base reproduzível antes da primeira feature vertical.

## Comportamento anterior

- nenhum repositório Git no diretório recebido;
- nenhum `package.json`, código, migration, teste ou configuração executável;
- remoto GitHub sem refs;
- 193 cenários Playwright somente planejados.

## Comportamento novo

- baseline documental publicada em `main` como commit bootstrap;
- fundação local isolada na branch `agent/foundation-local-platform`;
- aplicações e contratos mínimos executáveis;
- gates locais reproduzíveis;
- pendências externas e dependências instaladas rastreadas.

## Arquivos/componentes

- aplicação pública Next.js no package raiz e backoffice separado em `apps/backoffice`;
- workspaces `packages/contracts` e `packages/ui`, sem domínio ou sistema visual paralelo;
- contratos de health/release, readiness server-only e tipos gerados do banco;
- tokens claro/escuro e superfície técnica `FoundationStatus` responsiva;
- scripts de bootstrap Supabase, desenvolvimento conjunto, docs, formatação e release;
- release local com raiz física privada, ambientes isolados por app, `BUILD_ID` igual ao SHA, árvore pós-smoke exata e tar determinístico sem sobrescrita divergente;
- ESLint, TypeScript, Vitest, Playwright/axe, Knip, Prettier e audit com versões fixadas;
- configuração de segurança, CSP distinta entre desenvolvimento/produção e build standalone.

## Banco, migration, grants e RLS

Sem entidade de feature antecipada. Foram adicionadas as migrations imutáveis:

- `20260809000100_security_baseline.sql`: schemas privados, extensões, role DAL e privilégios fechados;
- `20260809000200_readiness_contract.sql`: função privada mínima vinculada à migration head;
- `20260809000300_security_default_privileges_hardening.sql`: default global de funções fechado e estado da role DAL normalizado.

O bootstrap cria fora das migrations um login local efêmero com atributos, memberships e grants diretos normalizados, que assume `app_dal` explicitamente. O snapshot SQL e os tipos são regeneráveis; 54 asserts pgTAP comprovam roles, deny-by-default, grants, extensões e função.

## Segurança e privacidade

- nenhum secret versionado;
- runtime e harness E2E usam arquivos separados com modo `0600`;
- guards validam origens exatas, identidades, porta e marcador efêmero conectado antes de qualquer suíte;
- a credencial administrativa é removida do ambiente dos processos Next;
- browsers recebem allowlist operacional mínima e não herdam secrets, banco, SSH, npm, loader, Node ou runtime Snap do host;
- build, tar e smoke herdam somente variáveis operacionais autorizadas; secrets conhecidos são redigidos e procurados na release inteira;
- backoffice permanece aplicação separada;
- CSP de produção não permite `unsafe-eval` nem conexões localhost;
- nenhuma integração cloud é configurada.

## Read models, comandos e invalidação

A fundação implementa somente o read contract de readiness via `private.check_readiness(text)`, com timeout, role DAL e retorno público não expositivo. Não existe comando de negócio, estado TanStack ou invalidação sem consumidor real.

## UX, mobile e acessibilidade

Tokens e a superfície técnica compartilhada possuem composição própria em 1440, 390 e 320 px, altura compacta, safe areas não nulas, claro/escuro, reflow e texto ampliado a 200% também nos viewports móveis. A tela não possui controles interativos, portanto não afirma evidência artificial de touch target/foco.

## Testes e IDs QA

- 62 testes unitários de docs, segurança E2E/browser, isolamento local, health/release e migration head;
- 54 asserts pgTAP;
- IDs técnicos estáveis `FOUNDATION-E2E-001` a `011`, fora da matriz das 34 features;
- 36 execuções Playwright: desktop, 390 px, 320 px, reflow equivalente ao zoom 200% em 160 CSS px nos três engines, altura compacta, backoffice, axe claro/escuro/mobile/narrow, safe-area não nula e Chromium/Firefox/WebKit críticos;
- caminho feliz e negativo (`/admin` público retorna 404), readiness real e propagação segura de request ID;
- build standalone das duas aplicações e smoke do pacote de release;
- guardrails adversariais para raiz simbólica/permissiva, herança de credenciais, separação de URLs e redaction do empacotamento.

## Correções do primeiro Codex review

- gates de documentação e formatação resolvem `origin/main`, `main` local e fallback conservador sem eliminar Markdown commitado;
- mudança técnica reconhece todos os configs raiz mantidos e exige change record com status Git `A`;
- Playwright diferencia as superfícies por heading exato e comprova reflow equivalente ao zoom de 200% nos três engines;
- readiness inválida falha fechada com JSON `503/unready`, `release=unknown`, headers autoritativos e sem consulta à DAL;
- threads efetivamente atendidas passam a ser resolvidas no PR antes de cada nova solicitação de review.

## Observabilidade e operação

`/live` e `/ready` expõem aplicação, release, timestamp e `requestId`, propagam somente UUID válido, desabilitam cache e não revelam falha de banco. Não há evento de domínio que justifique logger falso; logging JSON entra no primeiro comando real e provider externo permanece em PEND-008.

## Destaques da documentação atualizada

A lista abaixo destaca os contratos centrais alterados; o diff Git do PR continua sendo o inventário completo dos arquivos modificados.

- ADR-017;
- ADR-018;
- `README.md`, `PACKAGE_INDEX.md` e `CODEX_HANDOFF.md`;
- `docs/context.md`;
- `docs/database.md`;
- `docs/design-system.md`;
- `docs/environment-variables.md`;
- `docs/observability.md`;
- `docs/tooling.md`;
- `docs/implementation-order.md`;
- `docs/dependencias-utilizadas.md`;
- `docs/open-decisions.md` e `docs/feature-sequence.json`;
- `pendencias.md`.

## Rollback/correção

Reverter o commit da fundação antes de qualquer feature dependente. As migrations já aplicadas continuam append-only; não há dado de produção, migration de domínio ou recurso cloud para remover.

## Evidência de conclusão

Rodada final comprovada no runtime fixado Node `24.18.0`/npm `11.19.0`, na ordem de `AGENTS.md`:

- `npm ci`: 435 packages reproduzidos pelo lockfile, zero vulnerabilidades;
- `npm run format:check`, `lint` e `typecheck`: aprovados sem warning;
- `npm run test:unit`: 62 aprovados;
- `npm run supabase:reset`: banco vazio reaplicado e ambientes runtime/E2E separados;
- `npm run test:db`: 54 aprovados;
- `npm run docs:check`: 34 features, 193 cenários de produto e 18 ADRs coerentes;
- `npm run test:e2e:affected`: 36 aprovados;
- `npm run build`: aplicações pública e backoffice aprovadas;
- `npm run audit`: zero vulnerabilidades;
- `npm run knip`: aprovado sem hint.

`npm run release:manifest` exige um commit limpo por desenho e será a primeira validação pós-commit, antes do PR. O PR e seus ciclos de review registrarão a evidência remota.
