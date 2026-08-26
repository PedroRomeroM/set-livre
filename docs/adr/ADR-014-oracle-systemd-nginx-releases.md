# ADR-014 — Produção em Oracle VM com systemd, Nginx e releases por SHA

## Status

Aceito. O shape e a arquitetura de CPU são definidos pelo ADR-021.

## Contexto

A produção precisa ser barata, reproduzível e reversível, sem orquestração desnecessária.

## Decisão

Usar uma VM Oracle Cloud elegível ao Free Tier, com:

- Ubuntu 24.04;
- Nginx;
- TLS automatizado;
- processos Node sem root geridos por systemd;
- app público e backoffice separados;
- build standalone;
- releases imutáveis em `/opt/set-livre/releases/<sha>`;
- symlink `current`;
- health check e rollback atômico.

Produção não usa Docker Compose, Caddy ou registry de imagem.

## Alternativas

- containers em produção: rejeitados nesta escala.
- serverless: rejeitado pelo custo/arquitetura definida.
- deploy in-place: rejeitado por rollback frágil.

## Consequências

- pipeline deve produzir artifact compatível com a CPU definida no ADR-021;
- host precisa de hardening e patching;
- uma VM é ponto único de falha e possui gatilhos de migração.
