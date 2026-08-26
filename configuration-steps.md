# Configurações que dependem do responsável

Este checklist contém somente ações que não podem ser concluídas pelo repositório ou pelas CLIs já
autorizadas. O restante da infraestrutura é executado e validado pelo agente.

## Nesta entrega

Nenhuma ação humana permanece pendente para esta entrega.

- [x] Cadastro ACME concluído em 2026-08-26 com o endereço administrativo já disponível na conta
      local do responsável, sem registrar seu valor no repositório.

`147.15.97.227` é o IPv4 público reservado da produção, não um endereço efêmero. VM, NSG, firewall,
SSH de administração/deploy, variables e os demais secrets do GitHub já foram configurados e
verificados. A senha administrativa armazenada autenticou o projeto de produção, passou pelo dry-run
da baseline e foi republicada no environment protegido do GitHub sem exposição do valor.
O certificado curto de IP foi emitido e sua renovação simulada passou. O acesso desta fase será
exclusivamente por `https://147.15.97.227`; Nginx envia `X-Robots-Tag: noindex` em toda resposta e
serve um `robots.txt` que bloqueia crawling. O backoffice permanece apenas em loopback e não recebe
URL pública. A aplicação será disponibilizada nesse endereço somente depois do merge e do primeiro
deploy comprovado.

DNS foi adiado por decisão do responsável e não é uma pendência desta entrega. Nenhuma alteração deve
ser feita na Hostinger antes do go-live oficial.

Não cole senhas ou tokens neste arquivo. Secrets de GitHub, Supabase e SSH serão publicados por canais
próprios e validados sem exibir seus valores.

## Antes do go-live comercial

Quando o responsável liberar o domínio, criar no provedor DNS com TTL 300:

- `A` para `@` apontando para `147.15.97.227`;
- `CNAME` para `www` apontando para `setlivre.com`;
- `A` para `ops` apontando para `147.15.97.227`.

Essa futura ativação exige uma mudança versionada de Nginx, URLs do GitHub e redirects do Supabase,
novo certificado para os nomes e validação pública. O bloqueio de indexação só poderá ser removido por
decisão explícita de go-live.

As decisões de gateway, SMTP, textos jurídicos, identidade visual e observabilidade externa estão em
[`pendencias.md`](pendencias.md). Elas não bloqueiam a conclusão da fundação técnica, mas bloqueiam as
features e o go-live que as consomem.
