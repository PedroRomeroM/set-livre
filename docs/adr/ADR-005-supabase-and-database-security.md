# ADR-005 — Supabase Cloud, RLS e DAL restrito

## Status
Aceito.

## Contexto
A plataforma precisa de Auth, Postgres e Storage com baixo custo, mas não pode depender apenas de regras no frontend ou service role ampla.

## Decisão
Usar Supabase Cloud. O browser recebe chave pública e acessa somente leituras/gravações deliberadamente expostas por grants e RLS.

Comandos críticos usam `pg` em módulo `server-only`, conectando com role `app_dal`, que recebe somente `execute` em funções privadas aprovadas. Funções privilegiadas ficam em schema `private`, com `search_path = ''`.

## Alternativas
- service role para todo backend: rejeitado por blast radius.
- ORM com usuário amplo: rejeitado.
- self-host Supabase na VM: rejeitado por operação e custo oculto.

## Consequências
- grants, policies e funções precisam de testes automáticos;
- conexões DAL são limitadas;
- núcleo permanece portável para PostgreSQL.
