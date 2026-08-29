# Desenvolvimento local

## Ambiente suportado

- Windows 11 nativo;
- Node.js `24.18.0` e npm `11.19.0`;
- Docker Desktop em Linux containers;
- Supabase CLI `2.116.0` instalada como dependência fixa do projeto;
- navegadores Playwright instalados pelo próprio Playwright.

WSL não é requisito. CI e produção continuam Linux x86_64, portanto build e release também são
comprovados nesse sistema.

## Primeiro setup

```powershell
npm ci
npm run supabase:reset
npm run test:e2e:install
```

`supabase:reset` inicia a stack oficial, reaplica migrations e seed, cria um login local restrito que
assume `app_dal` e grava três arquivos ignorados:

- `.env.local` para o web;
- `apps/backoffice/.env.local` para o backoffice;
- `.env.e2e.local` para testes destrutivos.

`npm run dev`, `dev:backoffice`, `start` e `start:backoffice` passam pelo mesmo wrapper local já
existente. Ele aceita somente o `.env.local` gerado para a aplicação, recusa os demais arquivos de
ambiente que o Next carregaria, valida as origens e a identidade DAL em `127.0.0.1` e não repassa
variáveis runtime ou credenciais herdadas do shell. A CLI Next fixada continua sendo chamada
diretamente, sem shell intermediário.

`build:web` e `build:backoffice` reutilizam esse wrapper somente para uma regra adicional: após sucesso
ou falha do Next, `.next/cache` precisa ser uma árvore física, é retirada por rename único e removida.
Assim, valores runtime usados durante a compilação não permanecem no cache e uma falha de limpeza
também invalida o build, sem criar um script adicional.

Os dados são descartáveis. O guardrail relevante não é um firewall especial: Playwright e helpers de
QA recusam endpoints que não sejam `127.0.0.1` nas portas fixas do projeto. A stack usa a bridge local
suportada pela CLI e, depois de cada `start`, `reset` ou `status`, o wrapper comprova a bridge, todos os
containers e exatamente as quatro portas publicadas. No Windows também exige o modo nativo
`local-only-port-binding` do Docker Desktop; no Linux, cada binding precisa ser `127.0.0.1`. Estado
divergente é parado e falha fechado. A existência da stack é inspecionada antes de validar a política
do Docker Desktop: se a configuração mudar ou ficar ilegível enquanto houver containers em execução,
o wrapper encerra a stack antes de propagar o erro e revalida a política imediatamente antes de qualquer
novo `start`.

Antes de qualquer chamada à CLI Supabase, o wrapper exige `DOCKER_HOST`/`DOCKER_CONTEXT` ausentes,
comprova o contexto local canônico (`desktop-linux`/named pipe no Windows ou `default`/socket no Linux),
confirma containers Linux e fixa explicitamente esse endpoint no processo filho. Assim, nenhum comando
alcança um daemon remoto selecionado pelo ambiente ou pelo contexto ativo.
O stdout dos comandos interativos permanece visível, mas stderr é sempre capturado; em falha, somente o
diagnóstico JSON reconhecido e com credenciais de conexão redigidas pode voltar ao terminal ou ao CI.

A versão fixa inclui a correção oficial para colisão do endpoint de controle quando Set Livre e outra
stack local coexistem. O `config.toml` também fixa `auto_expose_new_tables = false`: novas tabelas,
views, sequences e funções não recebem acesso implícito das roles da Data API.

## Comandos cotidianos

| Objetivo                    | Comando                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| web em `127.0.0.1:3000`     | `npm run dev`                                                     |
| backoffice em `:3001`       | `npm run dev:backoffice`                                          |
| iniciar/parar banco         | `npm run supabase:start` / `npm run supabase:stop`                |
| recriar banco e ambientes   | `npm run supabase:reset`                                          |
| lint oficial do banco       | `npm run supabase:lint`                                           |
| testes SQL/RLS              | `npm run test:db`                                                 |
| imutabilidade de migrations | `npm run migrations:check`                                        |
| regenerar schema e tipos    | `npm run supabase:generate`                                       |
| unitários                   | `npm run test:unit`                                               |
| Playwright afetado/completo | `npm run test:e2e:affected` / `npm run test:e2e`                  |
| gates estáticos             | `npm run format:check`, `lint`, `typecheck`, `docs:check`, `knip` |
| build das duas aplicações   | `npm run build`                                                   |

Os comandos usam diretamente Playwright e Prettier. O wrapper único chama as CLIs Next e Supabase
diretamente somente quando precisa coordenar uma regra do Set Livre que essas ferramentas não oferecem:
fronteira local, limpeza garantida do cache de build, bootstrap da role DAL e publicação atômica dos
contratos gerados.

O transformador TSX dos testes unitários pertence a `vitest.config.ts`; specs importam o componente
diretamente e não iniciam um servidor Vite aninhado.

No Windows, `npm run test:db` usa a imagem pinada
`public.ecr.aws/supabase/pg_prove:3.36` em um container efêmero na rede local oficial do Supabase.
Os testes são copiados com `docker cp`, sem bind mount sujeito a permissões/compartilhamento do
OneDrive; host, usuário, senha e database entram apenas no ambiente do processo/container. O runner
sempre remove o container no `finally` e preserva a primeira falha se a limpeza também falhar. Linux
continua usando o comando oficial `supabase test db --local`. Em ambos, `0000_test_setup.sql` cria a
extensão pgTAP idempotentemente antes das suítes, e o gate ainda valida readiness e artefatos gerados.

## Variáveis locais

Aplicações:

```text
APP_ENV=local
APP_RELEASE_SHA=local
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<gerada pela CLI>
DATABASE_URL_APP_DAL=<login app_runtime_local com options=-c role=app_dal>
```

O backoffice usa `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3001`. O arquivo E2E acrescenta as URLs dos dois
apps, a chave pública `anon`, a conexão administrativa local e um marcador aleatório do banco. Quando
esse arquivo existe, seus valores canônicos têm precedência sobre variáveis herdadas do shell; sem ele,
o guardrail ainda aceita somente o contrato local completo. O webServer do Playwright neutraliza o
ambiente herdado e repõe explicitamente em cada app somente os valores locais já validados, inclusive a
URL DAL que as fixtures usam. Os dois servidores chamam o executável Node corrente e o CLI Next fixado
no lockfile diretamente, com cwd explícito; `.npmrc` e `script-shell` do usuário não participam dessa
fronteira. Ela também fixa `APP_ENV=test`; somente nessa
fronteira as fixtures privadas e allowlisted dos adapters locais ficam disponíveis. Nunca copie esses
arquivos para produção.

## Estratégia de testes

- Playwright é a prova principal dos fluxos visíveis, responsividade e acessibilidade.
- SQL/pgTAP prova RLS, grants, concorrência e invariantes que pertencem ao PostgreSQL.
- Unitários cobrem regras puras, normalização, transições difíceis e tratamento de erro sem navegador.
- Não se testa wrapper, inode, árvore de processo ou chamada interna quando o comportamento final pode
  ser comprovado diretamente.
- Não se duplica o mesmo cenário em várias camadas sem risco diferente e explícito.

Ao concluir uma feature, seus cenários automatizados ficam nas specs Playwright e o plano transitório em
`docs/features/` é removido. Contratos permanentes relevantes são consolidados no documento de domínio.

## Arquivos gerados do banco

`supabase/schema.generated.sql` e `packages/contracts/src/database.generated.ts` são gerados apenas a
partir do banco local migrado. A geração valida o conteúdo antes de substituir os arquivos rastreados.
`supabase:lint` passa pelo mesmo guard local de daemon, stack e bindings antes de executar o linter
oficial nos schemas próprios `public`, `private` e `audit`, tratando qualquer warning como falha. O
schema `extensions` contém implementações de terceiros, inclusive pgTAP, e fica fora desse gate;
`test:db` roda
pgTAP e regenera candidatos temporários; qualquer diferença falha com orientação para executar
`npm run supabase:generate`.

## Diagnóstico

1. `docker desktop status` deve indicar `running`.
2. `npm run supabase:status` deve confirmar endpoints, bridge e bindings locais.
3. Se a API do Docker mantiver operações presas, use `docker desktop diagnose` e reinicie o engine com
   `docker desktop restart`; não crie uma rede paralela permanente para mascarar o runtime.
4. Reset, timeout ou serviço interrompido é inconclusivo até uma nova execução terminar com sucesso.
