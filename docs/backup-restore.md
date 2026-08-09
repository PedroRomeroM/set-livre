# Backup, restore e continuidade

## 1. Objetivos

Referência inicial:

- RPO: 24 horas;
- RTO: 4 horas;
- retenção: 30 dias para backups operacionais;
- restore ensaiado mensalmente no início e trimestralmente após estabilidade.

Metas devem ser revistas com volume/receita.

## 2. Banco

Diariamente:

- Supabase CLI/`pg_dump` lógico;
- schema e data com opções compatíveis;
- checksum;
- criptografia;
- upload OCI Object Storage;
- manifesto com migration head;
- alerta em falha.

Backups do provider não substituem cópia operacional do projeto.

## 3. Storage

Backups do banco não cobrem objetos.

Estratégia:

- inventário diário de `studio-media`;
- cópia incremental para OCI Object Storage até limite/custo;
- checksum;
- associação media ID/path;
- teste de amostra.

Se volume ultrapassar Object Storage Always Free, migrar para tier pago; não deixar mídia sem backup por manter custo zero.

## 4. Configuração

Backup seguro de:

- Nginx;
- systemd;
- scripts de deploy;
- manifests;
- lista de secrets/owners sem valores;
- DNS/cert procedures.

Código está no Git e artifacts.

## 5. Restore DB

1. abrir incidente;
2. definir ponto;
3. criar projeto/DB de restore isolado;
4. aplicar versão compatível;
5. restaurar;
6. validar checks;
7. rodar smoke/read models/RLS;
8. reconciliar Storage;
9. definir cutover;
10. rotacionar credenciais se necessário.

Nunca testar restore em produção.

## 6. Restore mídia

- comparar inventário;
- restaurar paths;
- verificar checksum;
- garantir policies;
- invalidar cache se path alterou;
- registrar lacunas.

## 7. VM perdida

1. provisionar nova ARM64;
2. hardening;
3. instalar Node/Nginx/systemd;
4. restaurar env via cofre;
5. baixar release SHA;
6. configurar DNS;
7. health;
8. reativar workers;
9. verificar idempotência/filas.

Como dados canônicos estão no Supabase, perda da VM não deve perder domínio; pode haver logs locais ainda não exportados.

## 8. Teste

Relatório de restore contém:

- backup;
- data;
- duração;
- passos;
- falhas;
- RPO/RTO observado;
- checks de reserva/pagamento/mídia;
- ação corretiva.
