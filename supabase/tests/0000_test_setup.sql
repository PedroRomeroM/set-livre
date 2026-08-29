-- Pré-condição explícita e idempotente para todo runner pgTAP após um reset limpo.

create extension if not exists pgtap with schema extensions;

begin;

select plan(1);

select has_extension('pgtap', 'pgTAP está disponível para a suíte SQL');

select * from finish();

rollback;
