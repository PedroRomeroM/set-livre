# Fundação de entrega cloud controlada

## Estado

Em implementação. A configuração versionada existe, mas nenhum workflow foi executado no GitHub, o MCP Supabase permanece sem autenticação nesta sessão e a VM ainda não foi lançada. Produção continua fail-closed.

## Motivação

O responsável criou o projeto Supabase `set-livre` (`klzxatkgiiznymzuzadd`), adquiriu `setlivre.com` e autorizou retomar CI/CD e infraestrutura cloud que o ADR-018 havia suspendido temporariamente. A mudança precisa preservar Supabase local para testes destrutivos, migrations append-only, DAL restrita, release Oracle ARM64 sem Docker e revisão humana antes de produção.

## Mudanças

- ADR-019 libera somente CI, Supabase Cloud, Oracle, DNS e TLS; providers externos continuam suspensos;
- o workflow CI copiado de outro projeto deixa de usar runner/nome/toolchain Spenses e passa a executar os gates normativos com Node 24.18/npm 11.19, PostgreSQL 18.4, Supabase local e Playwright;
- o workflow de produção deixa de disparar no fechamento bruto do PR: ele consome o SHA aprovado por CI no `push` de `main`, exige environment/flag, runner ARM64, ref Supabase exata, migrations dry-run/append-only, readiness da DAL, SSH com known_hosts e ativação atômica na Oracle;
- a release de produção contém web, backoffice e migrations por SHA; não contém runtime secret nem usa Docker na VM;
- `configuration-seteps.md` lista MCP/OAuth, Supabase Auth/banco, GitHub Environment/proteções, OCI/SSH, DNS/TLS, hardening, backup, monitoramento e verificações humanas;
- documentos vivos distinguem configuração em código de recursos realmente criados e preservam as pendências até evidência externa.

## Evidência externa desta rodada

- `codex mcp list/get` encontrou `supabase` global apontando para outro projeto; a tentativa de adicionar a URL Set Livre falhou ao gravar `~/.codex/config.toml` read-only. Nenhum OAuth MCP foi iniciado contra o projeto errado;
- OCI CLI oficial instalada anteriormente via pipx foi validada como `3.89.0`, SDK `2.181.0`; 13.665 hashes do RECORD conferiram, e um wrapper isolado corrigiu apenas o entrypoint quebrado do snap antigo;
- perfil OCI `SET_LIVRE` foi criado por browser, config `0600`, diretório `0700`; o bundle discovery read-only teve checksums verdes e nenhuma chamada mutante;
- discovery confirmou home region `sa-saopaulo-1`, uma AD, A1 Flex, Ubuntu 24.04 ARM64 e disponibilidade de limite A1. Também revelou resources de Spenses/outro projeto, que foram recusados como alvo;
- target novo Set Livre foi definido separadamente: compartment/VCN/subnet/NSG próprios, A1 2 OCPUs/12 GB, boot 50 GB e IMDSv2. Launch/capacidade/custo ainda precisam de prova no momento da criação.

Nenhum token, chave, senha, OCID completo ou URL de banco foi registrado no repositório.

## Segurança e rollback

- workflows têm `contents: read`, checkout sem credencial persistida, SHA/ref/projeto exatos e environment protegido;
- PR usa somente Supabase local; secrets aparecem apenas no job de produção e são escopados por etapa;
- produção nunca executa reset, seed ou `config push`; migrations aplicadas não recebem down automático;
- falha de migration impede deploy da aplicação; falha de health após troca restaura o symlink da aplicação anterior quando disponível;
- DNS/TLS e VM permanecem bloqueados até configuração humana e smoke;
- correção de workflow ou schema usa novo PR/migration, sem editar história aplicada.

## Validação

- `bash -n /tmp/set-livre-oci-discovery.sh`: verde para o helper efêmero não versionado;
- OCI discovery: chamadas read-only verdes e SHA256SUMS íntegro;
- Prettier dos arquivos tocados, parse YAML e `bash -n` de todos os blocos `run` dos dois workflows: verdes;
- `docs:check` sob Node 24.18/npm 11.19 ficou sem saída por 60 segundos neste sandbox e foi interrompido com `130`; não é gate verde nem falha documental comprovada;
- gates locais completos e primeiro run GitHub: pendentes após reconciliação com a FEAT-006 ativa;
- deploy Supabase/Oracle e smoke público: pendentes de secrets, environments, VM, DNS e TLS.

## Pendências para conclusão

1. concluir MCP Set Livre isolado e verificar `/mcp` em nova sessão;
2. criar/provar runtime DAL Cloud, configurações Auth e backups;
3. configurar GitHub Environment/secrets/proteções e validar disponibilidade ARM64;
4. concluir VM/hardening, IP, DNS, TLS e known_hosts;
5. executar CI em PR e acompanhar primeiro deploy de `main` até monitoramento terminal;
6. atualizar a evidência documental sem fechar PEND-001/002/003 antes dessas provas.
