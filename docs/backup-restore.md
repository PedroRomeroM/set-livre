# Backup, restore e continuidade

## 1. Objetivos

Referência inicial:

- RPO de até 24 horas enquanto a proteção canônica for o backup diário gerenciado do Supabase;
- RTO alvo de 4 horas;
- retenção efetiva de 7 backups diários no plano Pro;
- restore isolado antes de liberar produção, mensalmente nos três primeiros meses e trimestralmente
  depois de três exercícios consecutivos aprovados.

Essas metas devem ser revistas com volume, receita e criticidade. Se o RPO de 24 horas deixar de ser
aceitável, habilitar Point-in-Time Recovery somente após revisar o custo e executar outro restore drill;
PITR é add-on pago e não integra o baseline atual.

## 2. Banco

O projeto produtivo deve permanecer no plano Pro. O Supabase cria backups diários gerenciados e
disponibiliza os últimos 7 dias; o operador verifica a existência e a data do ponto mais recente em
**Database > Backups**. A política oficial está em
[Database Backups](https://supabase.com/docs/guides/platform/backups).

Um deploy expand-only comum não gera nem consome um "atestado de backup" manual. Os contratos de
autorização são gerados, assinados e empacotados no próprio artifact da release. Mudança destrutiva ou
operação excepcional de dados continua bloqueada pelo fluxo normal e exige plano separado revisado,
backup lógico fresco, checksum, criptografia e restore completo em banco/projeto isolado antes de ser
autorizada.

Uma cópia independente em OCI Object Storage é defesa adicional desejável, mas ainda não está
implementada e não pode ser descrita como ativa. Ao implementá-la, usar uma credencial própria de menor
privilégio, criptografia, lifecycle/retention, manifesto com migration head e alerta de falha. A deleção do
projeto Supabase também remove os backups mantidos pelo provider; esse risco precisa orientar a
priorização da cópia independente.

## 3. Storage

Backups do banco não cobrem os objetos gravados pela Storage API; preservam somente os metadados.

Estratégia:

- bloquear a liberação de uploads persistentes até existir uma cópia independente implementada e
  comprovada;
- inventário diário de `studio-media`;
- cópia incremental para OCI Object Storage depois de validar limite e custo;
- checksum;
- associação media ID/path;
- teste de amostra.

Se o volume ultrapassar Object Storage Always Free, migrar para tier pago; não deixar mídia sem backup
para manter custo zero. Até a automação existir, este item é pendência explícita, não controle operacional.

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
8. redefinir senhas dos papéis customizados, porque backups diários não preservam essas senhas;
9. reconciliar Storage;
10. definir cutover;
11. rotacionar credenciais se necessário.

Nunca testar restore em produção.

## 6. Restore mídia

- comparar inventário;
- restaurar paths;
- verificar checksum;
- garantir policies;
- invalidar cache se path alterou;
- registrar lacunas.

## 7. VM perdida

1. provisionar nova VM Oracle `VM.Standard.E2.1.Micro` Always Free x86_64;
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
