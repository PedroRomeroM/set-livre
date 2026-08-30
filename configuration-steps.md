# Configurações que dependem do responsável

Este checklist contém somente ações que não podem ser concluídas pelo repositório ou pelas CLIs já
autorizadas. O restante da infraestrutura é executado e validado pelo agente.

## Nesta entrega

Nenhuma ação humana permanece pendente para esta entrega.

Não cole senhas ou tokens neste arquivo. Secrets de GitHub, Supabase e SSH serão publicados por canais
próprios e validados sem exibir seus valores.

## Decisões futuras do responsável

- [ ] Antes de compartilhar implementação proprietária adicional, contratar GitHub Pro ou mover o
      repositório para um plano que preserve os mesmos checks e proteções de `main` em modo privado.
- [ ] Autorizar explicitamente o go-live e a retirada do bloqueio de indexação.
- [ ] Antes do primeiro uso do backoffice, criar/confirmar uma conta comum e concluir seu perfil pela
      aplicação pública; informar ao agente qual e-mail será o primeiro admin. O agente executará o
      bootstrap one-shot auditado, provará o papel e orientará o túnel SSH enquanto o backoffice
      permanecer somente em loopback. Não executar `insert` manual em `platform_roles`.

### DNS no go-live comercial

Somente depois da autorização de go-live, criar no provedor DNS com TTL 300:

- `A` para `@` apontando para `147.15.97.227`;
- `CNAME` para `www` apontando para `setlivre.com`;
- `A` para `ops` apontando para `147.15.97.227`.

O responsável apenas autoriza a mudança e fornece acesso ao provedor se necessário. O agente deve
versionar Nginx, URLs do GitHub e redirects do Supabase, emitir o certificado dos nomes e comprovar o
resultado público antes de concluir a etapa.

As demais decisões humanas de produto permanecem em [`pendencias.md`](pendencias.md).
