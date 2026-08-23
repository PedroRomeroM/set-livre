# ADR-014 — Produção em Oracle VM com systemd, Nginx e releases por SHA

## Status

Aceito. Shape e arquitetura atualizados pelo ADR-021 em 2026-08-18.

## Contexto

A produção precisa ser barata, reproduzível e reversível, sem orquestração desnecessária.

## Decisão

Usar uma VM Oracle Cloud elegível ao Free Tier, com shape e arquitetura definidos pelo ADR-021:

- `VM.Standard.E2.1.Micro` x86_64, 1 OCPU e aproximadamente 1 GB de RAM;
- Ubuntu 24.04 x86_64;
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

- pipeline deve produzir artefato Linux x86_64 compatível;
- host precisa de hardening e patching;
- a memória limitada exige budgets, monitoramento e smoke de carga;
- uma VM é ponto único de falha e possui gatilhos de migração;
- quando ativa, a VM Set Livre ocupa a segunda e última posição E2 Micro Always Free da tenancy. A instância diagnóstica foi terminada; na última evidência preservada (`2026-08-19T09:45:42Z`), a posição lógica estava liberada e o Plan E2 reportava falta de capacidade física, conforme o ADR-021.
