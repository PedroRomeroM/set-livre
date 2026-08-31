-- Regressão transversal: timestamps de negócio não recuam com correções do relógio do host.

begin;

select plan(4);

select ok(
  pg_catalog.to_regprocedure('private.normalize_updated_at_monotonic()') is not null,
  'normalizador temporal canônico existe no schema privado'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'private.normalize_updated_at_monotonic()',
    'EXECUTE'
  )
    and not pg_catalog.has_function_privilege(
      'authenticated',
      'private.normalize_updated_at_monotonic()',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'service_role',
      'private.normalize_updated_at_monotonic()',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'app_dal',
      'private.normalize_updated_at_monotonic()',
      'EXECUTE'
    ),
  'normalizador temporal não expõe execução direta às roles de runtime'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_trigger as trigger
    join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace as relation_namespace
      on relation_namespace.oid = relation.relnamespace
    join pg_catalog.pg_proc as routine on routine.oid = trigger.tgfoid
    join pg_catalog.pg_namespace as routine_namespace
      on routine_namespace.oid = routine.pronamespace
    where not trigger.tgisinternal
      and trigger.tgname = 'zzzz_normalize_updated_at'
      and relation_namespace.nspname = 'public'
      and relation.relname = any(array[
        'profiles',
        'user_preferences',
        'owner_profiles',
        'owner_payment_recipients',
        'studio_types',
        'studios',
        'studio_revisions',
        'tags',
        'amenities',
        'studio_faqs'
      ]::text[])
      and routine_namespace.nspname = 'private'
      and routine.proname = 'normalize_updated_at_monotonic'
  ),
  10,
  'as dez tabelas com updated_at canônico usam o normalizador compartilhado'
);

savepoint future_catalog_timestamp;

alter table public.studio_types disable trigger user;
do $block$
begin
  perform pg_catalog.set_config(
    'set_livre.test.future_catalog_timestamp',
    (pg_catalog.clock_timestamp() + interval '2 seconds')::text,
    true
  );
end;
$block$;
update public.studio_types as studio_type
set
  created_at = pg_catalog.current_setting('set_livre.test.future_catalog_timestamp')::timestamptz,
  updated_at = pg_catalog.current_setting('set_livre.test.future_catalog_timestamp')::timestamptz
where studio_type.id = '60000000-0000-4000-8000-000000000001';
alter table public.studio_types enable trigger user;

update public.studio_types as studio_type
set sort_order = studio_type.sort_order
where studio_type.id = '60000000-0000-4000-8000-000000000001';

select ok(
  (
    select studio_type.updated_at >= studio_type.created_at
      and studio_type.updated_at >=
        pg_catalog.current_setting('set_livre.test.future_catalog_timestamp')::timestamptz
    from public.studio_types as studio_type
    where studio_type.id = '60000000-0000-4000-8000-000000000001'
  ),
  'catálogo continua atualizável quando o timestamp persistido está adiante do relógio observado'
);

rollback to savepoint future_catalog_timestamp;

select * from finish();
rollback;
