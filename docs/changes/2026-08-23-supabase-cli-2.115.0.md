# 2026-08-23 — Supabase CLI 2.115.0 no Windows e na produção

## Estado

CLI substituída de forma canônica e validada no ambiente Windows local; publicação em produção
permanece condicionada ao ciclo protegido de PR, merge e deploy.

## Motivo

Com a CLI `2.113.0`, duas execuções limpas reproduziram o mesmo bloqueio no Windows: `supabase
start`/`db reset` criava o container Postgres, mas não o iniciava. O stack ficava parcial e o comando
não concluía. A tentativa interrompida não foi aceita como evidência de teste.

A release oficial `2.115.0` corrige a sequência de health checks de `supabase start` e restaura o
batch de migrations, com redução explícita de minutos para segundos no Windows. O projeto não adota
variável de opt-out, start manual de container ou fallback para a implementação antiga.

## Alteração

- `supabase` e o pacote nativo do workspace foram fixados em `2.115.0`;
- bootstrap, configurador e agente da VM usam a mesma release Linux amd64;
- o archive oficial foi conferido contra `checksums.txt` da release;
- SHA-256 do archive: `ff099608ce758b625532ef03a61f4c9520b995e94ff6cd5480dc0428cad64cb3`;
- SHA-256 do binário `supabase`: `5986d84e4c7e251126f7579c686b302b3527bc4b2ac1517963930eb0780d3867`;
- SHA-256 do binário `supabase-go`: `c507c71c331ee9b4dd87b6ec6cc8a6e4f312a642ff0f9e44931129053c534eef`;
- os testes de supply chain, executor local, bootstrap, configurador e agente foram atualizados para
  rejeitar qualquer versão ou hash divergente.

O reset atual também confirmou que `pg_net` não é mais criado implicitamente. O projeto Cloud novo
mantém a extensão desabilitada. Como o ADR-018 suspende APIs externas, a baseline agora aceita
somente dois estados: extensão ausente, ou schema/objetos/funções `net` integralmente negados às
roles runtime. Habilitar a extensão apenas para satisfazer um teste seria ampliar autoridade sem
necessidade e foi rejeitado.

## Validação

- Docker Desktop atualizado para `4.87.0`, com engine Linux `29.7.2` operacional;
- `npm run local:setup` concluiu sem intervenção manual com a CLI `2.115.0`;
- baseline pgTAP aprovada: `361/361` assertions em quatro arquivos;
- geração de tipos e artefatos do banco concluída sem divergência;
- suíte Playwright aprovada: `114/114` cenários nos 16 projetos configurados;
- builds de produção do site público e do backoffice concluídos com sucesso.

Fonte primária: [release oficial v2.115.0](https://github.com/supabase/cli/releases/tag/v2.115.0).
