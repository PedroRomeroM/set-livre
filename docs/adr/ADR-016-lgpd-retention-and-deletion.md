# ADR-016 — LGPD, retenção e exclusão

## Status
Aceito.

## Contexto
Usuários podem solicitar exportação e exclusão, mas reservas, pagamentos, fiscal e auditoria possuem obrigações de retenção.

## Decisão
Implementar exclusão como processo de domínio:

- bloquear novos acessos;
- revogar sessões;
- remover mídia e preferências sem obrigação;
- anonimizar perfil quando registros históricos precisam permanecer;
- manter valores, datas e IDs internos necessários à contabilidade/defesa;
- separar PII de fatos operacionais;
- registrar solicitação e conclusão;
- documentar expurgo de backups.

Exportação gera pacote legível com dados pessoais e histórico autorizado.

## Alternativas
- cascade delete de tudo: rejeitado.
- negar exclusão por existir histórico: rejeitado.
- manter PII indefinidamente: rejeitado.

## Consequências
- schema precisa de snapshots mínimos;
- políticas de retenção dependem de validação jurídica;
- backoffice possui fluxo auditado, sem acesso irrestrito.
