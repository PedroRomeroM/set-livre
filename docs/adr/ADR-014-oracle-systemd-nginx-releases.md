# ADR-014 — Produção em Oracle VM com systemd, Nginx e releases por SHA

## Status
Aceito.

## Contexto
A produção precisa ser barata, reproduzível e reversível, sem orquestração desnecessária.

## Decisão
Usar uma VM Oracle Cloud ARM64 elegível ao Free Tier, com:

- Ubuntu ARM64;
- Nginx;
- TLS automatizado;
- processos Node sem root geridos por systemd;
- app público, backoffice e workers separados;
- build standalone;
- releases imutáveis em `/opt/setlivre/releases/<sha>`;
- symlink `current`;
- health check e rollback atômico.

Produção não usa Docker Compose, Caddy ou registry de imagem.

## Alternativas
- containers em produção: rejeitados nesta escala.
- serverless: rejeitado pelo custo/arquitetura definida.
- deploy in-place: rejeitado por rollback frágil.

## Consequências
- pipeline deve produzir artefato ARM64 compatível;
- host precisa de hardening e patching;
- uma VM é ponto único de falha e possui gatilhos de migração.
