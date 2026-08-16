-- FEAT-006: núcleo do estúdio, revisão, RLS, grants e comandos privados.

-- As sessões dblink precisam enxergar um owner e dois agregados committed.
-- O precleanup exato torna uma interrupção anterior recuperável sem reset.
do $cleanup_concurrency_fixture$
begin
  delete from audit.events
  where actor_user_id = '66000000-0000-4000-8000-000000000010'
    or target_id in (
      '66000000-0000-4000-8000-000000000010',
      '67000000-0000-4000-8000-000000000010',
      '67000000-0000-4000-8000-000000000020',
      '67000000-0000-4000-8000-000000000030'
    );

  delete from private.studio_command_requests
  where owner_user_id = '66000000-0000-4000-8000-000000000010'
    or studio_id in (
      '67000000-0000-4000-8000-000000000010',
      '67000000-0000-4000-8000-000000000020',
      '67000000-0000-4000-8000-000000000030'
    );

  delete from public.studios
  where owner_user_id = '66000000-0000-4000-8000-000000000010'
    and id in (
      '67000000-0000-4000-8000-000000000010',
      '67000000-0000-4000-8000-000000000020',
      '67000000-0000-4000-8000-000000000030'
    );

  delete from auth.users
  where id = '66000000-0000-4000-8000-000000000010'
    and email = 'qa_f006_db_concurrency@setlivre.local';

  delete from private.signup_legal_intents
  where request_id = '66100000-0000-4000-8000-000000000010';
end;
$cleanup_concurrency_fixture$;

do $create_concurrency_fixture$
declare
  legal_intent uuid;
begin
  legal_intent := private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    '66100000-0000-4000-8000-000000000010',
    '{}'::jsonb
  );

  insert into auth.users (
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  ) values (
    '66000000-0000-4000-8000-000000000010',
    'authenticated',
    'authenticated',
    'qa_f006_db_concurrency@setlivre.local',
    '',
    pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    pg_catalog.jsonb_build_object('sl_legal_intent', legal_intent::text),
    pg_catalog.now(),
    pg_catalog.now()
  );

  perform 1
  from private.complete_profile(
    '66000000-0000-4000-8000-000000000010',
    0,
    'individual',
    'Owner QA F006 Concorrência DB',
    '+5541996006010',
    '74628319022',
    null
  );

  perform 1
  from private.activate_owner(
    '66000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000204',
    '66200000-0000-4000-8000-000000000010',
    '66300000-0000-4000-8000-000000000010',
    null
  );

  perform 1
  from private.create_studio(
    '66000000-0000-4000-8000-000000000010',
    '67000000-0000-4000-8000-000000000010',
    '67100000-0000-4000-8000-000000000010',
    '68100000-0000-4000-8000-000000000010',
    'qa_f006_db_same_initial',
    'Fixture committed inicial para concorrência idempotente da FEAT-006.',
    'Rua QA F006 Same',
    '6010',
    'Sala 10',
    'Centro',
    '80010010',
    10,
    '00000000-0000-4000-8000-000000000603'
  );

  perform 1
  from private.create_studio(
    '66000000-0000-4000-8000-000000000010',
    '67000000-0000-4000-8000-000000000020',
    '67100000-0000-4000-8000-000000000020',
    '68100000-0000-4000-8000-000000000020',
    'qa_f006_db_conflict_initial',
    'Fixture committed inicial para conflito otimista real da FEAT-006.',
    'Rua QA F006 Conflict',
    '6020',
    'Sala 20',
    'Centro',
    '80010020',
    20,
    '00000000-0000-4000-8000-000000000603'
  );
end;
$create_concurrency_fixture$;

begin;

create function private.feat006_capture_error(command text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
begin
  execute command;
  return 'NO_ERROR';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$function$;

create function private.feat006_create_user(
  user_id uuid,
  email_address text,
  tax_id text,
  legal_request_id uuid,
  activate_as_owner boolean,
  activation_key uuid,
  activation_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  legal_intent uuid;
begin
  legal_intent := private.create_signup_legal_intent(
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    'individual',
    legal_request_id,
    '{}'::jsonb
  );

  insert into auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    user_id,
    'authenticated',
    'authenticated',
    email_address,
    '',
    pg_catalog.now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    pg_catalog.jsonb_build_object('sl_legal_intent', legal_intent::text),
    pg_catalog.now(),
    pg_catalog.now()
  );

  perform 1
  from private.complete_profile(
    user_id,
    0,
    'individual',
    'Pessoa QA Estúdio',
    case
      when email_address like '%-a@%' then '+5541998112233'
      when email_address like '%-b@%' then '+5541998223344'
      else '+5541998334455'
    end,
    tax_id,
    null
  );

  if activate_as_owner then
    perform 1
    from private.activate_owner(
      user_id,
      '00000000-0000-4000-8000-000000000204',
      activation_key,
      activation_request_id,
      null
    );
  end if;
end;
$function$;

revoke all on function private.feat006_capture_error(text)
  from public, anon, authenticated, service_role, app_dal;
revoke all on function private.feat006_create_user(
  uuid, text, text, uuid, boolean, uuid, uuid
) from public, anon, authenticated, service_role, app_dal;

create temporary table feat006_concurrency_results (
  scenario text not null,
  label text not null,
  was_busy boolean not null,
  edit_version bigint,
  error_message text,
  primary key (scenario, label)
) on commit drop;

select plan(83);

create extension if not exists dblink with schema extensions;

do $connect_concurrency$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat006_same_a',
    'feat006_same_b',
    'feat006_conflict_a',
    'feat006_conflict_b'
  ]
  loop
    perform extensions.dblink_connect(
      connection_name,
      pg_catalog.format(
        'host=%s port=%s dbname=%I user=%I password=%s',
        pg_catalog.inet_server_addr(),
        pg_catalog.inet_server_port(),
        pg_catalog.current_database(),
        'supabase_admin',
        'postgres'
      )
    );
  end loop;
end;
$connect_concurrency$;

do $dispatch_same_key_concurrency$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat006_same_a',
    'feat006_same_b'
  ]
  loop
    perform extensions.dblink_send_query(
      connection_name,
      pg_catalog.format(
        $remote$
        with overlap as materialized (
          select
            pg_catalog.pg_sleep(0.25) as sleep_completed,
            'qa_f006_db_same_updated'::text as studio_name
        )
        select result.edit_version
        from overlap
        cross join lateral private.update_studio_revision_core(
          '66000000-0000-4000-8000-000000000010',
          '67000000-0000-4000-8000-000000000010',
          1,
          '67200000-0000-4000-8000-000000000010',
          %L::uuid,
          overlap.studio_name,
          'Payload idêntico submetido em duas conexões assíncronas reais.',
          'Rua QA F006 Same Updated',
          '6011',
          'Sala 11',
          'Centro',
          '80010011',
          11,
          '00000000-0000-4000-8000-000000000603'
        ) as result
        $remote$,
        case connection_name
          when 'feat006_same_a'
            then '68200000-0000-4000-8000-000000000010'
          else '68200000-0000-4000-8000-000000000011'
        end
      )
    );
  end loop;
end;
$dispatch_same_key_concurrency$;

insert into feat006_concurrency_results (scenario, label, was_busy)
values
  (
    'same-key',
    'a',
    extensions.dblink_is_busy('feat006_same_a') = 1
  ),
  (
    'same-key',
    'b',
    extensions.dblink_is_busy('feat006_same_b') = 1
  );

do $collect_same_key_concurrency$
begin
  begin
    update feat006_concurrency_results as stored
    set edit_version = remote.edit_version
    from extensions.dblink_get_result('feat006_same_a')
      as remote(edit_version bigint)
    where stored.scenario = 'same-key'
      and stored.label = 'a';
  exception when others then
    update feat006_concurrency_results
    set error_message = sqlstate || ':' || sqlerrm
    where scenario = 'same-key'
      and label = 'a';
  end;

  begin
    update feat006_concurrency_results as stored
    set edit_version = remote.edit_version
    from extensions.dblink_get_result('feat006_same_b')
      as remote(edit_version bigint)
    where stored.scenario = 'same-key'
      and stored.label = 'b';
  exception when others then
    update feat006_concurrency_results
    set error_message = sqlstate || ':' || sqlerrm
    where scenario = 'same-key'
      and label = 'b';
  end;
end;
$collect_same_key_concurrency$;

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(result.was_busy)
      and pg_catalog.bool_and(
        result.edit_version is not null
        and result.edit_version = 2
      )
      and pg_catalog.bool_and(result.error_message is null)
    from feat006_concurrency_results as result
    where result.scenario = 'same-key'
  )
    and coalesce((
      select studio.edit_version = 2
        and studio.last_revision_number = 1
        and studio.published_revision_id is null
        and studio.draft_revision_id is not null
        and (
          select pg_catalog.count(*) = 1
          from public.studio_revisions as revision
          where revision.studio_id = studio.id
            and revision.id = studio.draft_revision_id
            and revision.revision_number = 1
            and revision.status = 'draft'
            and revision.name = 'qa_f006_db_same_updated'
            and revision.description =
              'Payload idêntico submetido em duas conexões assíncronas reais.'
            and revision.street = 'Rua QA F006 Same Updated'
            and revision.street_number = '6011'
            and revision.address_complement = 'Sala 11'
            and revision.neighborhood = 'Centro'
            and revision.city = 'Curitiba'
            and revision.state = 'PR'
            and revision.postal_code = '80010011'
            and revision.capacity = 11
            and revision.studio_type_id =
              '00000000-0000-4000-8000-000000000603'
        )
      from public.studios as studio
      where studio.id = '67000000-0000-4000-8000-000000000010'
        and studio.owner_user_id = '66000000-0000-4000-8000-000000000010'
    ), false)
    and (
      select pg_catalog.count(*) = 1
      from private.studio_command_requests as request
      where request.owner_user_id = '66000000-0000-4000-8000-000000000010'
        and request.studio_id = '67000000-0000-4000-8000-000000000010'
        and request.action = 'studio.revision.updateCore'
        and request.idempotency_key = '67200000-0000-4000-8000-000000000010'
        and request.result_kind = 'editor'
        and request.resulting_edit_version = 2
    )
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          event.actor_user_id = '66000000-0000-4000-8000-000000000010'
          and event.actor_role = 'authenticated'
          and event.target_type = 'studio'
          and event.result = 'succeeded'
          and event.request_id in (
            '68200000-0000-4000-8000-000000000010',
            '68200000-0000-4000-8000-000000000011'
          )
          and event.ip_hash is null
          and event.metadata = pg_catalog.jsonb_build_object(
            'draftCreated', false,
            'editVersion', 2,
            'revisionNumber', 1
          )
        )
      from audit.events as event
      where event.action = 'studio.revision.updated'
        and event.target_id = '67000000-0000-4000-8000-000000000010'
        and event.idempotency_key =
          '67200000-0000-4000-8000-000000000010'
    ),
  'update concorrente same-key converge, incrementa uma vez e grava um ledger'
);

do $dispatch_conflicting_key_concurrency$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat006_conflict_a',
    'feat006_conflict_b'
  ]
  loop
    perform extensions.dblink_send_query(
      connection_name,
      pg_catalog.format(
        $remote$
          with overlap as materialized (
            select
              pg_catalog.pg_sleep(0.25) as sleep_completed,
              %L::text as studio_name
          )
          select result.edit_version
          from overlap
          cross join lateral private.update_studio_revision_core(
            '66000000-0000-4000-8000-000000000010',
            '67000000-0000-4000-8000-000000000020',
            1,
            %L::uuid,
            %L::uuid,
            overlap.studio_name,
            %L::text,
            %L::text,
            %L::text,
            %L::text,
            %L::text,
            %L::text,
            %s,
            '00000000-0000-4000-8000-000000000603'
          ) as result
        $remote$,
        case connection_name
          when 'feat006_conflict_a' then 'qa_f006_db_conflict_payload_a'
          else 'qa_f006_db_conflict_payload_b'
        end,
        case connection_name
          when 'feat006_conflict_a'
            then '67300000-0000-4000-8000-000000000010'
          else '67300000-0000-4000-8000-000000000011'
        end,
        case connection_name
          when 'feat006_conflict_a'
            then '68300000-0000-4000-8000-000000000010'
          else '68300000-0000-4000-8000-000000000011'
        end,
        case connection_name
          when 'feat006_conflict_a'
            then 'Payload concorrente A deve vencer ou receber conflito otimista.'
          else 'Payload concorrente B deve vencer ou receber conflito otimista.'
        end,
        case connection_name
          when 'feat006_conflict_a' then 'Rua QA F006 Conflict A'
          else 'Rua QA F006 Conflict B'
        end,
        case connection_name
          when 'feat006_conflict_a' then '6021'
          else '6022'
        end,
        case connection_name
          when 'feat006_conflict_a' then 'Sala A'
          else 'Sala B'
        end,
        case connection_name
          when 'feat006_conflict_a' then 'Bairro A'
          else 'Bairro B'
        end,
        case connection_name
          when 'feat006_conflict_a' then '80010021'
          else '80010022'
        end,
        case connection_name
          when 'feat006_conflict_a' then 21
          else 22
        end
      )
    );
  end loop;
end;
$dispatch_conflicting_key_concurrency$;

insert into feat006_concurrency_results (scenario, label, was_busy)
values
  (
    'different-key',
    'a',
    extensions.dblink_is_busy('feat006_conflict_a') = 1
  ),
  (
    'different-key',
    'b',
    extensions.dblink_is_busy('feat006_conflict_b') = 1
  );

do $collect_conflicting_key_concurrency$
begin
  begin
    update feat006_concurrency_results as stored
    set edit_version = remote.edit_version
    from extensions.dblink_get_result('feat006_conflict_a')
      as remote(edit_version bigint)
    where stored.scenario = 'different-key'
      and stored.label = 'a';
  exception when others then
    update feat006_concurrency_results
    set error_message = sqlstate || ':' || sqlerrm
    where scenario = 'different-key'
      and label = 'a';
  end;

  begin
    update feat006_concurrency_results as stored
    set edit_version = remote.edit_version
    from extensions.dblink_get_result('feat006_conflict_b')
      as remote(edit_version bigint)
    where stored.scenario = 'different-key'
      and stored.label = 'b';
  exception when others then
    update feat006_concurrency_results
    set error_message = sqlstate || ':' || sqlerrm
    where scenario = 'different-key'
      and label = 'b';
  end;
end;
$collect_conflicting_key_concurrency$;

select ok(
  coalesce((
    with winner as (
      select pg_catalog.max(result.label) as label
      from feat006_concurrency_results as result
      where result.scenario = 'different-key'
        and result.edit_version = 2
        and result.error_message is null
    )
    select
      (
        select pg_catalog.count(*) = 2
          and pg_catalog.bool_and(result.was_busy)
          and pg_catalog.count(*) filter (
            where result.edit_version = 2
              and result.error_message is null
          ) = 1
          and pg_catalog.count(*) filter (
            where result.edit_version is null
              and result.error_message =
                '40001:studio_edit_version_conflict'
          ) = 1
        from feat006_concurrency_results as result
        where result.scenario = 'different-key'
      )
        and studio.edit_version = 2
        and studio.last_revision_number = 1
        and studio.published_revision_id is null
        and studio.draft_revision_id is not null
        and (
          select pg_catalog.count(*) = 1
          from public.studio_revisions as revision_count
          where revision_count.studio_id = studio.id
        )
        and (
          select pg_catalog.count(*) = 1
          from private.studio_command_requests as request
          where request.owner_user_id = studio.owner_user_id
            and request.studio_id = studio.id
            and request.action = 'studio.revision.updateCore'
            and request.idempotency_key in (
              '67300000-0000-4000-8000-000000000010',
              '67300000-0000-4000-8000-000000000011'
            )
            and request.result_kind = 'editor'
            and request.resulting_edit_version = 2
        )
        and (
          (
            winner.label = 'a'
            and revision.name = 'qa_f006_db_conflict_payload_a'
            and revision.description =
              'Payload concorrente A deve vencer ou receber conflito otimista.'
            and revision.street = 'Rua QA F006 Conflict A'
            and revision.street_number = '6021'
            and revision.address_complement = 'Sala A'
            and revision.neighborhood = 'Bairro A'
            and revision.postal_code = '80010021'
            and revision.capacity = 21
            and exists (
              select 1
              from private.studio_command_requests as request
              where request.owner_user_id = studio.owner_user_id
                and request.studio_id = studio.id
                and request.idempotency_key =
                  '67300000-0000-4000-8000-000000000010'
            )
            and not exists (
              select 1
              from private.studio_command_requests as request
              where request.owner_user_id = studio.owner_user_id
                and request.studio_id = studio.id
                and request.idempotency_key =
                  '67300000-0000-4000-8000-000000000011'
            )
          )
          or (
            winner.label = 'b'
            and revision.name = 'qa_f006_db_conflict_payload_b'
            and revision.description =
              'Payload concorrente B deve vencer ou receber conflito otimista.'
            and revision.street = 'Rua QA F006 Conflict B'
            and revision.street_number = '6022'
            and revision.address_complement = 'Sala B'
            and revision.neighborhood = 'Bairro B'
            and revision.postal_code = '80010022'
            and revision.capacity = 22
            and exists (
              select 1
              from private.studio_command_requests as request
              where request.owner_user_id = studio.owner_user_id
                and request.studio_id = studio.id
                and request.idempotency_key =
                  '67300000-0000-4000-8000-000000000011'
            )
            and not exists (
              select 1
              from private.studio_command_requests as request
              where request.owner_user_id = studio.owner_user_id
                and request.studio_id = studio.id
                and request.idempotency_key =
                  '67300000-0000-4000-8000-000000000010'
            )
          )
        )
        and (
          select pg_catalog.count(*) = 1
            and pg_catalog.bool_and(
              event.actor_user_id = studio.owner_user_id
              and event.actor_role = 'authenticated'
              and event.target_type = 'studio'
              and event.result = 'succeeded'
              and event.request_id = case winner.label
                when 'a' then '68300000-0000-4000-8000-000000000010'::uuid
                else '68300000-0000-4000-8000-000000000011'::uuid
              end
              and event.idempotency_key = case winner.label
                when 'a' then '67300000-0000-4000-8000-000000000010'::uuid
                else '67300000-0000-4000-8000-000000000011'::uuid
              end
              and event.ip_hash is null
              and event.metadata = pg_catalog.jsonb_build_object(
                'draftCreated', false,
                'editVersion', 2,
                'revisionNumber', 1
              )
            )
          from audit.events as event
          where event.action = 'studio.revision.updated'
            and event.target_id = studio.id
        )
      from winner
      join public.studios as studio
        on studio.id = '67000000-0000-4000-8000-000000000020'
       and studio.owner_user_id = '66000000-0000-4000-8000-000000000010'
      join public.studio_revisions as revision
        on revision.studio_id = studio.id
       and revision.id = studio.draft_revision_id
       and revision.revision_number = 1
       and revision.status = 'draft'
       and revision.city = 'Curitiba'
       and revision.state = 'PR'
       and revision.studio_type_id =
         '00000000-0000-4000-8000-000000000603'
  ), false),
  'update concorrente different-key elege um vencedor e rejeita o perdedor'
);

do $prove_studio_type_share_locks$
declare
  archive_backend_pid integer;
  archive_completed boolean;
  attempt integer;
  command_backend_pid integer;
  create_blocked boolean := false;
  update_blocked boolean := false;
begin
  select remote.backend_pid
  into command_backend_pid
  from extensions.dblink(
    'feat006_same_a',
    'select pg_catalog.pg_backend_pid()'
  ) as remote(backend_pid integer);

  select remote.backend_pid
  into archive_backend_pid
  from extensions.dblink(
    'feat006_same_b',
    'select pg_catalog.pg_backend_pid()'
  ) as remote(backend_pid integer);

  perform extensions.dblink_exec('feat006_same_a', 'begin');
  perform remote.edit_version
  from extensions.dblink(
    'feat006_same_a',
    $remote$
      select result.edit_version
      from private.update_studio_revision_core(
        '66000000-0000-4000-8000-000000000010',
        '67000000-0000-4000-8000-000000000010',
        2,
        '67400000-0000-4000-8000-000000000010',
        '68400000-0000-4000-8000-000000000010',
        'qa_f006_db_type_lock_updated',
        'Efeito real mantém SHARE no tipo até o commit remoto.',
        'Rua QA F006 Type Lock',
        '6030',
        null,
        'Centro',
        '80010030',
        30,
        '00000000-0000-4000-8000-000000000603'
      ) as result
    $remote$
  ) as remote(edit_version bigint);

  perform extensions.dblink_send_query(
    'feat006_same_b',
    $remote$
      update public.studio_types
      set active = false,
          updated_at = pg_catalog.clock_timestamp()
      where id = '00000000-0000-4000-8000-000000000603'
      returning not active
    $remote$
  );

  for attempt in 1..100 loop
    select remote.is_blocked
    into update_blocked
    from extensions.dblink(
      'feat006_conflict_a',
      pg_catalog.format(
        'select %s = any(pg_catalog.pg_blocking_pids(%s))',
        command_backend_pid,
        archive_backend_pid
      )
    ) as remote(is_blocked boolean);

    exit when update_blocked;
    perform pg_catalog.pg_sleep(0.01);
  end loop;

  perform extensions.dblink_exec('feat006_same_a', 'commit');
  select remote.archive_completed
  into archive_completed
  from extensions.dblink_get_result('feat006_same_b')
    as remote(archive_completed boolean);

  if not archive_completed then
    raise exception using
      errcode = 'P0001',
      message = 'feat006_update_type_archive_not_completed';
  end if;

  perform extensions.dblink_exec(
    'feat006_same_b',
    $remote$
      update public.studio_types
      set active = true,
          updated_at = pg_catalog.clock_timestamp()
      where id = '00000000-0000-4000-8000-000000000603'
    $remote$
  );

  perform extensions.dblink_exec('feat006_same_a', 'begin');
  perform remote.edit_version
  from extensions.dblink(
    'feat006_same_a',
    $remote$
      select result.edit_version
      from private.create_studio(
        '66000000-0000-4000-8000-000000000010',
        '67000000-0000-4000-8000-000000000030',
        '67500000-0000-4000-8000-000000000030',
        '68500000-0000-4000-8000-000000000030',
        'qa_f006_db_create_type_lock',
        'Create mantém SHARE no tipo ativo até o commit remoto.',
        'Rua QA F006 Create Lock',
        '6040',
        null,
        'Centro',
        '80010040',
        40,
        '00000000-0000-4000-8000-000000000604'
      ) as result
    $remote$
  ) as remote(edit_version bigint);

  perform extensions.dblink_send_query(
    'feat006_same_b',
    $remote$
      update public.studio_types
      set active = false,
          updated_at = pg_catalog.clock_timestamp()
      where id = '00000000-0000-4000-8000-000000000604'
      returning not active
    $remote$
  );

  for attempt in 1..100 loop
    select remote.is_blocked
    into create_blocked
    from extensions.dblink(
      'feat006_conflict_a',
      pg_catalog.format(
        'select %s = any(pg_catalog.pg_blocking_pids(%s))',
        command_backend_pid,
        archive_backend_pid
      )
    ) as remote(is_blocked boolean);

    exit when create_blocked;
    perform pg_catalog.pg_sleep(0.01);
  end loop;

  perform extensions.dblink_exec('feat006_same_a', 'commit');
  select remote.archive_completed
  into archive_completed
  from extensions.dblink_get_result('feat006_same_b')
    as remote(archive_completed boolean);

  if not archive_completed then
    raise exception using
      errcode = 'P0001',
      message = 'feat006_create_type_archive_not_completed';
  end if;

  perform extensions.dblink_exec(
    'feat006_same_b',
    $remote$
      update public.studio_types
      set active = true,
          updated_at = pg_catalog.clock_timestamp()
      where id = '00000000-0000-4000-8000-000000000604'
    $remote$
  );

  perform pg_catalog.set_config(
    'set_livre.test.feat006_create_type_blocked',
    create_blocked::text,
    true
  );
  perform pg_catalog.set_config(
    'set_livre.test.feat006_update_type_blocked',
    update_blocked::text,
    true
  );
end;
$prove_studio_type_share_locks$;

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_create_type_blocked'
  )::boolean
    and pg_catalog.current_setting(
      'set_livre.test.feat006_update_type_blocked'
    )::boolean
    and (
      select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(studio_type.active)
      from public.studio_types as studio_type
      where studio_type.id in (
        '00000000-0000-4000-8000-000000000603',
        '00000000-0000-4000-8000-000000000604'
      )
    )
    and (
      select pg_catalog.count(*) = 2
        and pg_catalog.bool_and(
          event.actor_user_id = '66000000-0000-4000-8000-000000000010'
          and event.actor_role = 'authenticated'
          and event.target_type = 'studio'
          and event.result = 'succeeded'
          and event.ip_hash is null
          and (
            (
              event.action = 'studio.revision.updated'
              and event.target_id = '67000000-0000-4000-8000-000000000010'
              and event.request_id = '68400000-0000-4000-8000-000000000010'
              and event.idempotency_key = '67400000-0000-4000-8000-000000000010'
              and event.metadata = pg_catalog.jsonb_build_object(
                'draftCreated', false,
                'editVersion', 3,
                'revisionNumber', 1
              )
            )
            or (
              event.action = 'studio.created'
              and event.target_id = '67000000-0000-4000-8000-000000000030'
              and event.request_id = '68500000-0000-4000-8000-000000000030'
              and event.idempotency_key = '67500000-0000-4000-8000-000000000030'
              and event.metadata = pg_catalog.jsonb_build_object(
                'editVersion', 1,
                'revisionNumber', 1
              )
            )
          )
        )
      from audit.events as event
      where event.idempotency_key in (
        '67400000-0000-4000-8000-000000000010',
        '67500000-0000-4000-8000-000000000030'
      )
    ),
  'create/update bloqueiam archive até commit, liberam sem deadlock e auditam'
);

do $disconnect_concurrency$
declare
  connection_name text;
begin
  foreach connection_name in array array[
    'feat006_same_a',
    'feat006_same_b',
    'feat006_conflict_a',
    'feat006_conflict_b'
  ]
  loop
    if connection_name = any(coalesce(
      extensions.dblink_get_connections(),
      array[]::text[]
    )) then
      perform extensions.dblink_disconnect(connection_name);
    end if;
  end loop;

  if pg_catalog.cardinality(coalesce(
    extensions.dblink_get_connections(),
    array[]::text[]
  )) <> 0 then
    raise exception using
      errcode = 'P0001',
      message = 'feat006_dblink_cleanup_failed';
  end if;
end;
$disconnect_concurrency$;

select ok(
  pg_catalog.to_regclass('public.studio_types') is not null
    and pg_catalog.to_regclass('public.studios') is not null
    and pg_catalog.to_regclass('public.studio_revisions') is not null
    and pg_catalog.to_regclass('private.studio_command_requests') is not null,
  'as quatro relações canônicas da FEAT-006 existem'
);

select is(
  (
    select pg_catalog.array_agg(attribute.attname::text order by attribute.attnum)
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.studio_types'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
  ),
  array[
    'id','name','slug','description','active','sort_order','created_at','updated_at'
  ]::text[],
  'studio_types não antecipa taxonomia ou conteúdo fora da FEAT-006'
);

select is(
  (
    select pg_catalog.array_agg(attribute.attname::text order by attribute.attnum)
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.studios'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
  ),
  array[
    'id','owner_user_id','status','published_revision_id','draft_revision_id',
    'edit_version','last_revision_number','created_at','updated_at'
  ]::text[],
  'studios mantém somente raiz, ponteiros e versão otimista'
);

select is(
  (
    select pg_catalog.array_agg(attribute.attname::text order by attribute.attnum)
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.studio_revisions'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
  ),
  array[
    'id','studio_id','revision_number','status','name','description','street',
    'street_number','address_complement','neighborhood','city','state',
    'postal_code','capacity','studio_type_id','created_at','updated_at'
  ]::text[],
  'studio_revisions contém exatamente o core aprovado da feature'
);

select is(
  (
    select pg_catalog.array_agg(attribute.attname::text order by attribute.attnum)
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'private.studio_command_requests'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
  ),
  array[
    'owner_user_id','idempotency_key','action','studio_id','payload_hash',
    'result_kind','resulting_edit_version','created_at'
  ]::text[],
  'ledger privado guarda somente deduplicação e resultado mínimo'
);

select ok(
  (
    select constraint_record.convalidated
      and (
        select pg_catalog.array_agg(matched.value[1] order by matched.value[1])
        from pg_catalog.regexp_matches(
          pg_catalog.pg_get_constraintdef(constraint_record.oid),
          $pattern$'([^']+)'$pattern$,
          'g'
        ) as matched(value)
      ) = array[
        'owner.activated',
        'owner.contract_renewed',
        'recipient.status_transitioned',
        'studio.created',
        'studio.deleted',
        'studio.draft.discarded',
        'studio.revision.updated'
      ]::text[]
    from pg_catalog.pg_constraint as constraint_record
    where constraint_record.conrelid = 'audit.events'::regclass
      and constraint_record.conname = 'events_action_check'
  )
    and (
      select constraint_record.convalidated
        and (
          select pg_catalog.array_agg(matched.value[1] order by matched.value[1])
          from pg_catalog.regexp_matches(
            pg_catalog.pg_get_constraintdef(constraint_record.oid),
            $pattern$'([^']+)'$pattern$,
            'g'
          ) as matched(value)
        ) = array[
          'owner_payment_recipient',
          'owner_profile',
          'studio'
        ]::text[]
      from pg_catalog.pg_constraint as constraint_record
      where constraint_record.conrelid = 'audit.events'::regclass
        and constraint_record.conname = 'events_target_type_check'
    ),
  'checks de auditoria admitem exatamente ações legadas e fatos de estúdio'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('studios_status_revision_shape_check'::name),
        ('studio_revisions_name_shape_check'::name),
        ('studio_revisions_description_shape_check'::name),
        ('studio_revisions_street_number_shape_check'::name),
        ('studio_revisions_neighborhood_shape_check'::name),
        ('studio_revisions_city_check'::name),
        ('studio_revisions_state_check'::name),
        ('studio_revisions_postal_code_check'::name),
        ('studio_revisions_capacity_check'::name),
        ('studio_command_requests_result_check'::name)
    ) as expected(constraint_name)
    where not exists (
      select 1
      from pg_catalog.pg_constraint as constraint_record
      where constraint_record.conname = expected.constraint_name
    )
  )
    and (
      select pg_catalog.count(*) = 4
        and pg_catalog.bool_and(
          pg_catalog.strpos(
            pg_catalog.pg_get_constraintdef(constraint_record.oid),
            '9007199254740991'
          ) > 0
        )
      from pg_catalog.pg_constraint as constraint_record
      where constraint_record.conname in (
        'studios_edit_version_check',
        'studios_last_revision_number_check',
        'studio_revisions_revision_number_check',
        'studio_command_requests_result_check'
      )
    ),
  'constraints de domínio e tetos numéricos seguros existem'
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(constraint_record.condeferrable)
      and pg_catalog.bool_and(constraint_record.condeferred)
      and pg_catalog.bool_and(
        pg_catalog.array_length(constraint_record.conkey, 1) = 2
      )
    from pg_catalog.pg_constraint as constraint_record
    where constraint_record.conrelid = 'public.studios'::regclass
      and constraint_record.conname in (
        'studios_published_revision_fk',
        'studios_draft_revision_fk'
      )
  ),
  'ponteiros circulares usam FKs compostas diferidas para a mesma raiz'
);

select ok(
  pg_catalog.to_regclass('public.studios_owner_user_id_idx') is not null
    and pg_catalog.to_regclass(
      'public.studio_revisions_one_draft_per_studio_idx'
    ) is not null
    and pg_catalog.to_regclass(
      'public.studio_revisions_studio_type_id_idx'
    ) is not null
    and pg_catalog.to_regclass(
      'private.studio_command_requests_create_studio_id_key'
    ) is not null,
  'índices estruturais cobrem ownership, draft, FK de tipo e reserva anti-ABA'
);

select ok(
  (
    select pg_catalog.count(*) = 4
      and pg_catalog.bool_and(relation.relrowsecurity)
    from pg_catalog.pg_class as relation
    where relation.oid in (
      'public.studio_types'::regclass,
      'public.studios'::regclass,
      'public.studio_revisions'::regclass,
      'private.studio_command_requests'::regclass
    )
  ),
  'RLS está habilitada nas quatro relações'
);

select ok(
  (
    select pg_catalog.array_agg(policy.polname order by policy.polname)
    from pg_catalog.pg_policy as policy
    where policy.polrelid in (
      'public.studio_types'::regclass,
      'public.studios'::regclass,
      'public.studio_revisions'::regclass
    )
  ) = array[
    'studio_revisions_select_owner',
    'studio_types_select_authenticated',
    'studios_select_owner'
  ]::name[]
    and not exists (
      select 1
      from pg_catalog.pg_policy as policy
      where policy.polrelid = 'private.studio_command_requests'::regclass
    ),
  'políticas públicas são exatas e o ledger privado permanece fail-closed'
);

select ok(
  pg_catalog.has_any_column_privilege(
    'authenticated', 'public.studio_types', 'SELECT'
  )
    and pg_catalog.has_any_column_privilege(
      'authenticated', 'public.studios', 'SELECT'
    )
    and pg_catalog.has_any_column_privilege(
      'authenticated', 'public.studio_revisions', 'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'authenticated', 'public.studio_types', 'SELECT'
    )
    and not exists (
      select 1
      from (
        values ('anon'::name), ('service_role'::name), ('app_dal'::name)
      ) as monitored(role_name)
      cross join (
        values
          ('public.studio_types'::regclass),
          ('public.studios'::regclass),
          ('public.studio_revisions'::regclass)
      ) as relation(relation_oid)
      where pg_catalog.has_any_column_privilege(
        monitored.role_name, relation.relation_oid, 'SELECT'
      )
    ),
  'authenticated recebe somente SELECT por coluna nas fontes públicas'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('anon'::name),
        ('authenticated'::name),
        ('service_role'::name),
        ('app_dal'::name)
    ) as monitored(role_name)
    cross join (
      values
        ('public.studio_types'::regclass),
        ('public.studios'::regclass),
        ('public.studio_revisions'::regclass)
    ) as relation(relation_oid)
    where pg_catalog.has_table_privilege(
      monitored.role_name, relation.relation_oid, 'INSERT'
    )
      or pg_catalog.has_table_privilege(
        monitored.role_name, relation.relation_oid, 'UPDATE'
      )
      or pg_catalog.has_table_privilege(
        monitored.role_name, relation.relation_oid, 'DELETE'
      )
  ),
  'nenhuma role runtime escreve diretamente nas fontes canônicas'
);

select ok(
  not pg_catalog.has_any_column_privilege(
    'anon', 'private.studio_command_requests', 'SELECT'
  )
    and not pg_catalog.has_any_column_privilege(
      'authenticated', 'private.studio_command_requests', 'SELECT'
    )
    and not pg_catalog.has_any_column_privilege(
      'service_role', 'private.studio_command_requests', 'SELECT'
    )
    and not pg_catalog.has_any_column_privilege(
      'app_dal', 'private.studio_command_requests', 'SELECT'
    ),
  'ledger idempotente não possui leitura direta runtime'
);

select ok(
  pg_catalog.to_regprocedure('public.list_active_studio_types()') is not null
    and pg_catalog.to_regprocedure(
      'public.get_owner_studio_editor(uuid)'
    ) is not null
    and pg_catalog.to_regprocedure(
      'private.create_studio(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) is not null
    and pg_catalog.to_regprocedure(
      'private.update_studio_revision_core(uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) is not null
    and pg_catalog.to_regprocedure(
      'private.discard_studio_draft(uuid,uuid,bigint,uuid,uuid)'
    ) is not null
    and pg_catalog.to_regprocedure(
      'private.create_studio(uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) is null
    and pg_catalog.to_regprocedure(
      'private.update_studio_revision_core(uuid,uuid,bigint,uuid,text,text,text,text,text,text,text,integer,uuid)'
    ) is null
    and pg_catalog.to_regprocedure(
      'private.discard_studio_draft(uuid,uuid,bigint,uuid)'
    ) is null,
  'read models e comandos expõem só as assinaturas correlacionadas exatas'
);

select ok(
  not exists (
    select 1
    from (
      values
        (
          'private.create_studio(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'::text,
          array[
            'p_user_id','p_studio_id','p_idempotency_key','p_request_id',
            'p_name','p_description','p_street','p_street_number',
            'p_address_complement','p_neighborhood','p_postal_code',
            'p_capacity','p_studio_type_id'
          ]::text[]
        ),
        (
          'private.update_studio_revision_core(uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'::text,
          array[
            'p_user_id','p_studio_id','p_expected_edit_version',
            'p_idempotency_key','p_request_id','p_name','p_description',
            'p_street','p_street_number','p_address_complement',
            'p_neighborhood','p_postal_code','p_capacity','p_studio_type_id'
          ]::text[]
        ),
        (
          'private.discard_studio_draft(uuid,uuid,bigint,uuid,uuid)'::text,
          array[
            'p_user_id','p_studio_id','p_expected_edit_version',
            'p_idempotency_key','p_request_id'
          ]::text[]
        )
    ) as expected(signature, input_names)
    join pg_catalog.pg_proc as routine
      on routine.oid = pg_catalog.to_regprocedure(expected.signature)
    where routine.proargnames[1:routine.pronargs] is distinct from
      expected.input_names
  ),
  'request_id sucede imediatamente a chave nas três assinaturas privadas'
);

select ok(
  (
    select pg_catalog.strpos(
      routine.prosrc,
      'for share of studio_type'
    ) > 0
    from pg_catalog.pg_proc as routine
    where routine.oid = pg_catalog.to_regprocedure(
      'private.create_studio(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
    )
  )
    and (
      select pg_catalog.strpos(
        routine.prosrc,
        'for share of studio_type'
      ) > 0
        and pg_catalog.strpos(
          routine.prosrc,
          'if current_studio.draft_revision_id is not null'
        ) > 0
      from pg_catalog.pg_proc as routine
      where routine.oid = pg_catalog.to_regprocedure(
        'private.update_studio_revision_core(uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'
      )
    ),
  'efeitos reais travam tipo ativo e no-op permanece exclusivo de draft'
);

select is(
  (
    select pg_catalog.array_agg(
      parameter.parameter_name::text order by parameter.ordinal_position
    )
    from information_schema.parameters as parameter
    where parameter.specific_schema = 'public'
      and parameter.specific_name like 'get_owner_studio_editor_%'
      and parameter.parameter_mode = 'OUT'
  ),
  array[
    'scope','studio_id','studio_status','edit_version',
    'draft_revision_id','draft_revision_number','draft_name',
    'draft_description','draft_street','draft_street_number',
    'draft_address_complement','draft_neighborhood','draft_city','draft_state',
    'draft_postal_code','draft_capacity','draft_studio_type_id',
    'draft_studio_type_name','published_revision_id',
    'published_revision_number','published_name','published_description',
    'published_street','published_street_number','published_address_complement',
    'published_neighborhood','published_city','published_state',
    'published_postal_code','published_capacity','published_studio_type_id',
    'published_studio_type_name'
  ]::text[],
  'editor expõe simultaneamente os grupos completos draft e published'
);

select ok(
  (
    select pg_catalog.count(*) = 3
      and pg_catalog.bool_and(routine.prosecdef)
      and pg_catalog.bool_and('search_path=""' = any(routine.proconfig))
    from pg_catalog.pg_proc as routine
    where routine.oid in (
      'private.create_studio(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'::regprocedure,
      'private.update_studio_revision_core(uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'::regprocedure,
      'private.discard_studio_draft(uuid,uuid,bigint,uuid,uuid)'::regprocedure
    )
  ),
  'comandos privados são security definer com search_path vazio'
);

select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(not routine.prosecdef)
      and pg_catalog.bool_and('search_path=""' = any(routine.proconfig))
    from pg_catalog.pg_proc as routine
    where routine.oid in (
      'public.list_active_studio_types()'::regprocedure,
      'public.get_owner_studio_editor(uuid)'::regprocedure
    )
  ),
  'read models públicos são security invoker com search_path vazio'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('private.create_studio(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'::text),
        ('private.update_studio_revision_core(uuid,uuid,bigint,uuid,uuid,text,text,text,text,text,text,text,integer,uuid)'::text),
        ('private.discard_studio_draft(uuid,uuid,bigint,uuid,uuid)'::text)
    ) as command(signature)
    where not pg_catalog.has_function_privilege(
      'app_dal', command.signature, 'EXECUTE'
    )
      or pg_catalog.has_function_privilege(
        'public', command.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'anon', command.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'authenticated', command.signature, 'EXECUTE'
      )
      or pg_catalog.has_function_privilege(
        'service_role', command.signature, 'EXECUTE'
      )
  ),
  'somente app_dal executa os três comandos da feature'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated', 'public.list_active_studio_types()', 'EXECUTE'
  )
    and pg_catalog.has_function_privilege(
      'authenticated', 'public.get_owner_studio_editor(uuid)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'anon', 'public.list_active_studio_types()', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'service_role', 'public.get_owner_studio_editor(uuid)', 'EXECUTE'
    ),
  'somente authenticated executa os read models públicos'
);

select ok(
  not pg_catalog.has_function_privilege(
    'app_dal', 'private.owner_studio_editor_row(uuid,uuid)', 'EXECUTE'
  )
    and not pg_catalog.has_function_privilege(
      'authenticated', 'private.owner_studio_editor_row(uuid,uuid)', 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'service_role', 'private.assert_studio_owner_authority(uuid)', 'EXECUTE'
    ),
  'helpers internos não ampliam a superfície executável'
);

select ok(
  (select pg_catalog.count(*) = 4 from public.studio_types)
    and (
      select pg_catalog.count(*) = 4
        and pg_catalog.bool_and(studio_type.active)
        and pg_catalog.array_agg(studio_type.name order by studio_type.sort_order)
          = array['Fotografia','Vídeo','Podcast','Multifuncional']::text[]
        and pg_catalog.bool_and(
          studio_type.description like 'Fixture local%'
        )
      from public.studio_types as studio_type
      where studio_type.id in (
        '00000000-0000-4000-8000-000000000601',
        '00000000-0000-4000-8000-000000000602',
        '00000000-0000-4000-8000-000000000603',
        '00000000-0000-4000-8000-000000000604'
      )
    ),
  'seed local contém somente as quatro fixtures explícitas e ativas'
);

select is(
  (
    select pg_catalog.array_agg(option.name)
    from public.list_active_studio_types() as option
  ),
  array['Fotografia','Vídeo','Podcast','Multifuncional']::text[],
  'read model de tipos preserva ordenação administrativa local'
);

select ok(
  private.check_readiness('20260816000200'),
  'readiness aceita o head FEAT-006'
);

select ok(
  not private.check_readiness('20260816000100'),
  'readiness rejeita o predecessor imediato do head FEAT-006'
);

select ok(
  (
    with runtime_role as (
      select role.oid
      from pg_catalog.pg_roles as role
      where role.rolname = 'app_dal'
    )
    select (
      select pg_catalog.count(*) = 20
      from pg_catalog.pg_shdepend as dependency
      join runtime_role on runtime_role.oid = dependency.refobjid
      where dependency.refclassid = 'pg_catalog.pg_authid'::regclass
        and dependency.deptype = 'a'
    ) and (
      select pg_catalog.count(*) = 19
      from pg_catalog.pg_proc as routine
      cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
      cross join runtime_role
      where privilege.grantee = runtime_role.oid
        and privilege.privilege_type = 'EXECUTE'
    )
  ),
  'manifesto app_dal possui exatamente vinte dependências e dezenove rotinas'
);

select private.feat006_create_user(
  '60000000-0000-4000-8000-000000000001',
  'qa-feat006-a@setlivre.local',
  '28001238938',
  '61000000-0000-4000-8000-000000000001',
  true,
  '62000000-0000-4000-8000-000000000001',
  '62500000-0000-4000-8000-000000000001'
);
select private.feat006_create_user(
  '60000000-0000-4000-8000-000000000002',
  'qa-feat006-b@setlivre.local',
  '52998224725',
  '61000000-0000-4000-8000-000000000002',
  true,
  '62000000-0000-4000-8000-000000000002',
  '62500000-0000-4000-8000-000000000002'
);
select private.feat006_create_user(
  '60000000-0000-4000-8000-000000000003',
  'qa-feat006-admin@setlivre.local',
  '39053344705',
  '61000000-0000-4000-8000-000000000003',
  false,
  '62000000-0000-4000-8000-000000000003',
  '62500000-0000-4000-8000-000000000003'
);

update auth.users
set raw_app_meta_data = raw_app_meta_data ||
  '{"set_livre_test_persona":"application_admin"}'::jsonb
where id = '60000000-0000-4000-8000-000000000003';

select ok(
  coalesce((
    select
      result.scope = '60000000-0000-4000-8000-000000000001'
      and result.studio_id = '63000000-0000-4000-8000-000000000001'
      and result.studio_status = 'draft'
      and result.edit_version = 1
      and result.draft_revision_number = 1
      and result.draft_name = 'Estúdio A inicial'
      and result.draft_city = 'Curitiba'
      and result.draft_state = 'PR'
      and result.draft_studio_type_name = 'Fotografia'
      and result.published_revision_id is null
    from private.create_studio(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001',
      'Estúdio A inicial',
      'Estúdio completo para ensaios e testes locais.',
      'Rua das Câmeras',
      '100',
      'Sala 2',
      'Centro Cívico',
      '80530000',
      12,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), false),
  'create deriva Curitiba e PR e retorna draft autoritativo completo'
);

select ok(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        studio.draft_revision_id = revision.id
        and studio.published_revision_id is null
        and studio.edit_version = 1
        and revision.studio_id = studio.id
        and revision.revision_number = 1
        and revision.status = 'draft'
      )
    from public.studios as studio
    join public.studio_revisions as revision
      on revision.id = studio.draft_revision_id
      and revision.studio_id = studio.id
    where studio.id = '63000000-0000-4000-8000-000000000001'
  ),
  'create resolve o ciclo com ponteiro pertencente ao mesmo agregado'
);

select ok(
  coalesce((
    select result.edit_version = 1
      and result.draft_revision_number = 1
    from private.create_studio(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000101',
      'Estúdio A inicial',
      'Estúdio completo para ensaios e testes locais.',
      'Rua das Câmeras',
      '100',
      'Sala 2',
      'Centro Cívico',
      '80530000',
      12,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), false),
  'replay exato de create retorna o estado autoritativo sem duplicar'
);

select ok(
  (
    select pg_catalog.count(*) = 1
    from private.studio_command_requests as request
    where request.owner_user_id = '60000000-0000-4000-8000-000000000001'
      and request.idempotency_key = '64000000-0000-4000-8000-000000000001'
  )
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          event.actor_user_id = '60000000-0000-4000-8000-000000000001'
          and event.actor_role = 'authenticated'
          and event.target_type = 'studio'
          and event.result = 'succeeded'
          and event.request_id = '65000000-0000-4000-8000-000000000001'
          and event.idempotency_key = '64000000-0000-4000-8000-000000000001'
          and event.ip_hash is null
          and event.metadata = pg_catalog.jsonb_build_object(
            'editVersion', 1,
            'revisionNumber', 1
          )
        )
      from audit.events as event
      where event.action = 'studio.created'
        and event.target_id = '63000000-0000-4000-8000-000000000001'
    ),
  'create preserva primeira request e metadata técnica exata sem PII'
);

select is(
  private.feat006_capture_error($command$
    select * from private.create_studio(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000102',
      'Estúdio A divergente',
      'Estúdio completo para ensaios e testes locais.',
      'Rua das Câmeras', '100', 'Sala 2', 'Centro Cívico',
      '80530000', 12,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$),
  '40001:studio_idempotency_conflict',
  'reuso da chave de create com payload divergente conflita'
);

select is(
  private.feat006_capture_error($command$
    select * from private.create_studio(
      '60000000-0000-4000-8000-000000000002',
      '63000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000002',
      '65000000-0000-4000-8000-000000000002',
      'Tentativa de colisão',
      'Estúdio completo para ensaios e testes locais.',
      'Rua B', '20', null, 'Batel', '80420000', 8,
      '00000000-0000-4000-8000-000000000602'
    )
  $command$),
  '40001:studio_identifier_unavailable',
  'studioId colidido retorna erro uniforme sem revelar ownership'
);

select is(
  private.feat006_capture_error($command$
    select * from private.create_studio(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000003',
      '64000000-0000-4000-8000-000000000003',
      '65000000-0000-4000-8000-000000000003',
      'x',
      'curta',
      'R', '1', null, 'B', 'abc', 0,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$),
  '22023:studio_core_invalid',
  'create rejeita core fora dos limites canônicos'
);

select is(
  private.feat006_capture_error($command$
    select * from private.create_studio(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000004',
      '64000000-0000-4000-8000-000000000004',
      '65000000-0000-4000-8000-000000000004',
      'Estúdio sem tipo',
      'Estúdio completo para ensaios e testes locais.',
      'Rua C', '30', null, 'Mercês', '80710000', 9,
      '69999999-0000-4000-8000-000000000001'
    )
  $command$),
  '23514:studio_type_unavailable',
  'create rejeita tipo inexistente sem antecipar taxonomia'
);

select is(
  private.feat006_capture_error($command$
    select * from private.create_studio(
      '60000000-0000-4000-8000-000000000003',
      '63000000-0000-4000-8000-000000000005',
      '64000000-0000-4000-8000-000000000005',
      '65000000-0000-4000-8000-000000000005',
      'Estúdio admin indevido',
      'Estúdio completo para ensaios e testes locais.',
      'Rua D', '40', null, 'Água Verde', '80240000', 10,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$),
  '42501:owner_authority_required',
  'persona admin sem owner canônico não cria estúdio'
);

select ok(
  coalesce((
    select result.studio_id = '63000000-0000-4000-8000-000000000002'
      and result.edit_version = 1
      and result.draft_studio_type_name = 'Vídeo'
    from private.create_studio(
      '60000000-0000-4000-8000-000000000002',
      '63000000-0000-4000-8000-000000000002',
      '64000000-0000-4000-8000-000000000006',
      '65000000-0000-4000-8000-000000000006',
      'Estúdio B inicial',
      'Estúdio completo do segundo dono para testes.',
      'Rua do Vídeo', '200', null, 'Batel', '80420000', 8,
      '00000000-0000-4000-8000-000000000602'
    ) as result
  ), false),
  'segundo dono cria agregado isolado com tipo distinto'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.feat006_owner_a_visible',
  ((select pg_catalog.count(*) = 1 from public.studios)
    and (select pg_catalog.count(*) = 1 from public.get_owner_studio_editor(
      '63000000-0000-4000-8000-000000000001'
    )))::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_owner_a_visible'
  )::boolean,
  'RLS permite ao dono A ler somente seu agregado e editor'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.feat006_owner_b_isolated',
  ((select pg_catalog.count(*) = 1 from public.studios)
    and (select pg_catalog.count(*) = 0 from public.get_owner_studio_editor(
      '63000000-0000-4000-8000-000000000001'
    )))::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_owner_b_isolated'
  )::boolean,
  'RLS retorna zero linhas para editor de outro dono'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.feat006_admin_isolated',
  ((select pg_catalog.count(*) = 0 from public.studios)
    and (select pg_catalog.count(*) = 0 from public.studio_revisions))::text,
  true
);
reset role;

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_admin_isolated'
  )::boolean,
  'persona admin não bypassa ownership por metadata do JWT'
);

set constraints studios_draft_revision_fk immediate;

select is(
  private.feat006_capture_error($command$
    update public.studios
    set draft_revision_id = (
      select foreign_studio.draft_revision_id
      from public.studios as foreign_studio
      where foreign_studio.id = '63000000-0000-4000-8000-000000000002'
    )
    where id = '63000000-0000-4000-8000-000000000001'
  $command$),
  '23503:insert or update on table "studios" violates foreign key constraint "studios_draft_revision_fk"',
  'FK composta rejeita ponteiro para revisão de outro agregado'
);

set constraints studios_draft_revision_fk deferred;

select ok(
  coalesce((
    select result.edit_version = 2
      and result.draft_revision_number = 1
      and result.draft_name = 'Estúdio A atualizado'
      and result.draft_capacity = 18
      and result.draft_city = 'Curitiba'
      and result.draft_state = 'PR'
    from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      1,
      '64000000-0000-4000-8000-000000000007',
      '65000000-0000-4000-8000-000000000007',
      'Estúdio A atualizado',
      'Descrição atualizada do estúdio para os testes locais.',
      'Rua das Câmeras', '101', 'Sala 3', 'Centro Cívico',
      '80530000', 18,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), false),
  'update altera o draft e incrementa edit_version exatamente uma vez'
);

select ok(
  (
    select studio.edit_version = 2
      and (
        select pg_catalog.count(*) = 1
        from public.studio_revisions as revision
        where revision.studio_id = studio.id
      )
    from public.studios as studio
    where studio.id = '63000000-0000-4000-8000-000000000001'
  ),
  'edição do draft existente não cria revisão extra'
);

select is(
  private.feat006_capture_error($command$
    select * from private.create_studio(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000103',
      'Estúdio A inicial',
      'Estúdio completo para ensaios e testes locais.',
      'Rua das Câmeras', '100', 'Sala 2', 'Centro Cívico',
      '80530000', 12,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$),
  '40001:studio_result_no_longer_available',
  'replay tardio de create não mascara versão avançada'
);

select ok(
  coalesce((
    select result.edit_version = 2
      and result.draft_name = 'Estúdio A atualizado'
    from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      1,
      '64000000-0000-4000-8000-000000000007',
      '65000000-0000-4000-8000-000000000107',
      'Estúdio A atualizado',
      'Descrição atualizada do estúdio para os testes locais.',
      'Rua das Câmeras', '101', 'Sala 3', 'Centro Cívico',
      '80530000', 18,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), false)
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          event.actor_user_id = '60000000-0000-4000-8000-000000000001'
          and event.actor_role = 'authenticated'
          and event.target_type = 'studio'
          and event.result = 'succeeded'
          and event.request_id = '65000000-0000-4000-8000-000000000007'
          and event.idempotency_key = '64000000-0000-4000-8000-000000000007'
          and event.ip_hash is null
          and event.metadata = pg_catalog.jsonb_build_object(
            'draftCreated', false,
            'editVersion', 2,
            'revisionNumber', 1
          )
        )
      from audit.events as event
      where event.action = 'studio.revision.updated'
        and event.target_id = '63000000-0000-4000-8000-000000000001'
        and event.idempotency_key = '64000000-0000-4000-8000-000000000007'
    ),
  'replay de update preserva versão e primeira correlação sem novo evento'
);

select ok(
  coalesce((
    select result.edit_version = 2
      and result.draft_name = 'Estúdio A atualizado'
    from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      1,
      '64000000-0000-4000-8000-000000000008',
      '65000000-0000-4000-8000-000000000008',
      'Estúdio A atualizado',
      'Descrição atualizada do estúdio para os testes locais.',
      'Rua das Câmeras', '101', 'Sala 3', 'Centro Cívico',
      '80530000', 18,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), false)
    and not exists (
      select 1
      from audit.events as event
      where event.action = 'studio.revision.updated'
        and event.target_id = '63000000-0000-4000-8000-000000000001'
        and event.idempotency_key = '64000000-0000-4000-8000-000000000008'
    ),
  'no-op idêntico de draft converge sem versão ou auditoria nova'
);

select is(
  private.feat006_capture_error($command$
    select * from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 1,
      '64000000-0000-4000-8000-000000000009',
      '65000000-0000-4000-8000-000000000009',
      'Estúdio A divergente',
      'Descrição divergente do estúdio para testar conflito otimista.',
      'Rua das Câmeras', '102', null, 'Centro Cívico',
      '80530000', 19,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$),
  '40001:studio_edit_version_conflict',
  'payload divergente com versão antiga conflita'
);

select is(
  private.feat006_capture_error($command$
    select * from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 2,
      '64000000-0000-4000-8000-000000000007',
      '65000000-0000-4000-8000-000000000207',
      'Outro payload na mesma chave',
      'Descrição divergente do estúdio para testar idempotência.',
      'Rua das Câmeras', '103', null, 'Centro Cívico',
      '80530000', 20,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$),
  '40001:studio_idempotency_conflict',
  'reuso de chave update com payload diferente conflita antes da escrita'
);

update public.studio_types
set active = false,
    updated_at = pg_catalog.clock_timestamp()
where id = '00000000-0000-4000-8000-000000000603';

select is(
  private.feat006_capture_error($command$
    select * from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 2,
      '64000000-0000-4000-8000-000000000010',
      '65000000-0000-4000-8000-000000000010',
      'Estúdio A tipo inativo',
      'Descrição válida tentando selecionar um tipo de estúdio inativo.',
      'Rua das Câmeras', '101', 'Sala 3', 'Centro Cívico',
      '80530000', 18,
      '00000000-0000-4000-8000-000000000603'
    )
  $command$),
  '23514:studio_type_unavailable',
  'update rejeita seleção de tipo inativo'
);

update public.studio_types
set active = true,
    updated_at = pg_catalog.clock_timestamp()
where id = '00000000-0000-4000-8000-000000000603';

update public.studio_types
set active = false,
    updated_at = pg_catalog.clock_timestamp()
where id = '00000000-0000-4000-8000-000000000601';

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.feat006_archived_owner_visible',
  (select (pg_catalog.count(*) = 1)::text
   from public.studio_types
   where id = '00000000-0000-4000-8000-000000000601'),
  true
);
reset role;

select pg_catalog.set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;
select pg_catalog.set_config(
  'set_livre.test.feat006_archived_other_hidden',
  (select (pg_catalog.count(*) = 0)::text
   from public.studio_types
   where id = '00000000-0000-4000-8000-000000000601'),
  true
);
reset role;

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_archived_owner_visible'
  )::boolean
    and pg_catalog.current_setting(
      'set_livre.test.feat006_archived_other_hidden'
    )::boolean,
  'tipo arquivado preserva histórico somente para dono que o referencia'
);

select ok(
  coalesce((
    select result.edit_version = 2
      and result.draft_revision_number = 1
      and result.draft_studio_type_id =
        '00000000-0000-4000-8000-000000000601'
    from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      1,
      '64000000-0000-4000-8000-000000000023',
      '65000000-0000-4000-8000-000000000023',
      'Estúdio A atualizado',
      'Descrição atualizada do estúdio para os testes locais.',
      'Rua das Câmeras', '101', 'Sala 3', 'Centro Cívico',
      '80530000', 18,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), false)
    and not exists (
      select 1
      from audit.events as event
      where event.target_id = '63000000-0000-4000-8000-000000000001'
        and event.idempotency_key = '64000000-0000-4000-8000-000000000023'
    ),
  'no-op de draft preserva tipo histórico inativo sem novo evento'
);

update public.studio_types
set active = true,
    updated_at = pg_catalog.clock_timestamp()
where id = '00000000-0000-4000-8000-000000000601';

select is(
  private.feat006_capture_error($command$
    select * from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000002',
      '63000000-0000-4000-8000-000000000001', 2,
      '64000000-0000-4000-8000-000000000011',
      '65000000-0000-4000-8000-000000000011',
      'Tentativa cross owner',
      'Descrição válida para tentativa de edição por outro dono.',
      'Rua B', '20', null, 'Batel', '80420000', 8,
      '00000000-0000-4000-8000-000000000602'
    )
  $command$),
  'P0002:studio_not_found',
  'update cross-owner usa o mesmo not-found de recurso ausente'
);

select ok(
  not exists (
    select 1
    from audit.events as event
    where event.idempotency_key in (
      '64000000-0000-4000-8000-000000000002',
      '64000000-0000-4000-8000-000000000003',
      '64000000-0000-4000-8000-000000000004',
      '64000000-0000-4000-8000-000000000005',
      '64000000-0000-4000-8000-000000000008',
      '64000000-0000-4000-8000-000000000009',
      '64000000-0000-4000-8000-000000000010',
      '64000000-0000-4000-8000-000000000011',
      '64000000-0000-4000-8000-000000000023'
    )
  )
    and (
      select pg_catalog.count(*) = 1
      from audit.events as event
      where event.target_id = '63000000-0000-4000-8000-000000000001'
        and event.action = 'studio.revision.updated'
        and event.idempotency_key = '64000000-0000-4000-8000-000000000007'
    ),
  'no-op e falhas não escrevem auditoria nem duplicam efeito anterior'
);

select ok(
  (
    select pg_catalog.array_agg(outcome.error_message order by outcome.command_name)
      = array[
        '22023:studio_core_invalid',
        '22023:studio_core_invalid',
        '22023:studio_core_invalid'
      ]::text[]
    from (
      values
        (
          'create',
          private.feat006_capture_error($command$
            select * from private.create_studio(
              '60000000-0000-4000-8000-000000000001',
              '63000000-0000-4000-8000-000000000006',
              '64000000-0000-4000-8000-000000000024',
              null,
              'Estúdio request nulo',
              'Payload válido que deve falhar antes de qualquer efeito real.',
              'Rua das Câmeras', '124', null, 'Centro Cívico',
              '80530000', 12,
              '00000000-0000-4000-8000-000000000601'
            )
          $command$)
        ),
        (
          'discard',
          private.feat006_capture_error($command$
            select * from private.discard_studio_draft(
              '60000000-0000-4000-8000-000000000001',
              '63000000-0000-4000-8000-000000000001',
              2,
              '64000000-0000-4000-8000-000000000026',
              null
            )
          $command$)
        ),
        (
          'update',
          private.feat006_capture_error($command$
            select * from private.update_studio_revision_core(
              '60000000-0000-4000-8000-000000000001',
              '63000000-0000-4000-8000-000000000001',
              2,
              '64000000-0000-4000-8000-000000000025',
              null,
              'Estúdio A atualizado',
              'Descrição atualizada do estúdio para os testes locais.',
              'Rua das Câmeras', '101', 'Sala 3', 'Centro Cívico',
              '80530000', 18,
              '00000000-0000-4000-8000-000000000601'
            )
          $command$)
        )
    ) as outcome(command_name, error_message)
  )
    and not exists (
      select 1
      from private.studio_command_requests as request
      where request.idempotency_key in (
        '64000000-0000-4000-8000-000000000024',
        '64000000-0000-4000-8000-000000000025',
        '64000000-0000-4000-8000-000000000026'
      )
    )
    and not exists (
      select 1
      from audit.events as event
      where event.idempotency_key in (
        '64000000-0000-4000-8000-000000000024',
        '64000000-0000-4000-8000-000000000025',
        '64000000-0000-4000-8000-000000000026'
      )
    ),
  'request_id nulo falha fechado nos três comandos sem ledger ou auditoria'
);

set constraints all immediate;
set constraints all deferred;

alter table public.studio_revisions
  disable trigger studio_revisions_enforce_lifecycle;

update public.studio_revisions as revision
set status = 'approved',
    updated_at = pg_catalog.clock_timestamp()
where revision.id = (
  select studio.draft_revision_id
  from public.studios as studio
  where studio.id = '63000000-0000-4000-8000-000000000001'
);

update public.studios as studio
set status = 'published',
    published_revision_id = studio.draft_revision_id,
    draft_revision_id = null,
    updated_at = pg_catalog.clock_timestamp()
where studio.id = '63000000-0000-4000-8000-000000000001';

set constraints all immediate;

alter table public.studio_revisions
  enable trigger studio_revisions_enforce_lifecycle;

set constraints all deferred;

update public.studio_types
set active = false,
    updated_at = pg_catalog.clock_timestamp()
where id = '00000000-0000-4000-8000-000000000601';

select ok(
  private.feat006_capture_error($command$
    select * from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      2,
      '64000000-0000-4000-8000-000000000027',
      '65000000-0000-4000-8000-000000000027',
      'Estúdio A atualizado',
      'Descrição atualizada do estúdio para os testes locais.',
      'Rua das Câmeras', '101', 'Sala 3', 'Centro Cívico',
      '80530000', 18,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$) = '23514:studio_type_unavailable'
    and coalesce((
      select studio.edit_version = 2
        and studio.draft_revision_id is null
        and studio.published_revision_id is not null
      from public.studios as studio
      where studio.id = '63000000-0000-4000-8000-000000000001'
    ), false)
    and not exists (
      select 1
      from private.studio_command_requests as request
      where request.idempotency_key = '64000000-0000-4000-8000-000000000027'
    )
    and not exists (
      select 1
      from audit.events as event
      where event.idempotency_key = '64000000-0000-4000-8000-000000000027'
    ),
  'publicado idêntico com tipo histórico inativo falha sem criar draft'
);

update public.studio_types
set active = true,
    updated_at = pg_catalog.clock_timestamp()
where id = '00000000-0000-4000-8000-000000000601';

select ok(
  coalesce((
    select result.edit_version = 3
      and result.studio_status = 'published'
      and result.published_revision_number = 1
      and result.published_name = 'Estúdio A atualizado'
      and result.draft_revision_number = 2
      and result.draft_name = 'Estúdio A atualizado'
      and result.draft_city = 'Curitiba'
      and result.draft_state = 'PR'
    from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 2,
      '64000000-0000-4000-8000-000000000012',
      '65000000-0000-4000-8000-000000000012',
      'Estúdio A atualizado',
      'Descrição atualizada do estúdio para os testes locais.',
      'Rua das Câmeras', '101', 'Sala 3', 'Centro Cívico',
      '80530000', 18,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), false)
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          event.actor_user_id = '60000000-0000-4000-8000-000000000001'
          and event.actor_role = 'authenticated'
          and event.target_type = 'studio'
          and event.result = 'succeeded'
          and event.request_id = '65000000-0000-4000-8000-000000000012'
          and event.idempotency_key = '64000000-0000-4000-8000-000000000012'
          and event.ip_hash is null
          and event.metadata = pg_catalog.jsonb_build_object(
            'draftCreated', true,
            'editVersion', 3,
            'revisionNumber', 2
          )
        )
      from audit.events as event
      where event.action = 'studio.revision.updated'
        and event.target_id = '63000000-0000-4000-8000-000000000001'
        and event.idempotency_key = '64000000-0000-4000-8000-000000000012'
    ),
  'publicado idêntico clona e audita metadata técnica exata sem PII'
);

select ok(
  (
    select studio.edit_version = 3
      and studio.published_revision_id <> studio.draft_revision_id
      and (
        select pg_catalog.array_agg(revision.status order by revision.revision_number)
        from public.studio_revisions as revision
        where revision.studio_id = studio.id
      ) = array['approved','draft']::text[]
      and (
        select revision.name = 'Estúdio A atualizado'
        from public.studio_revisions as revision
        where revision.id = studio.published_revision_id
      )
      and (
        select
          pg_catalog.to_jsonb(draft_revision)
            - array['id','revision_number','status','created_at','updated_at']
          = pg_catalog.to_jsonb(published_revision)
            - array['id','revision_number','status','created_at','updated_at']
        from public.studio_revisions as draft_revision
        join public.studio_revisions as published_revision
          on published_revision.id = studio.published_revision_id
         and published_revision.studio_id = studio.id
        where draft_revision.id = studio.draft_revision_id
          and draft_revision.studio_id = studio.id
      )
    from public.studios as studio
    where studio.id = '63000000-0000-4000-8000-000000000001'
  ),
  'clone idêntico incrementa uma vez e mantém o snapshot aprovado imutável'
);

select is(
  private.feat006_capture_error($command$
    select * from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      1,
      '64000000-0000-4000-8000-000000000007',
      '65000000-0000-4000-8000-000000000307',
      'Estúdio A atualizado',
      'Descrição atualizada do estúdio para os testes locais.',
      'Rua das Câmeras', '101', 'Sala 3', 'Centro Cívico',
      '80530000', 18,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$),
  '40001:studio_result_no_longer_available',
  'replay tardio de update não mascara versão avançada'
);

select is(
  private.feat006_capture_error($command$
    update public.studio_revisions
    set name = 'Tentativa de mutação aprovada'
    where studio_id = '63000000-0000-4000-8000-000000000001'
      and status = 'approved'
  $command$),
  'P0001:studio_revision_is_immutable',
  'revisão aprovada rejeita update'
);

select is(
  private.feat006_capture_error($command$
    delete from public.studio_revisions
    where studio_id = '63000000-0000-4000-8000-000000000001'
      and status = 'approved'
  $command$),
  'P0001:studio_revision_is_immutable',
  'revisão aprovada rejeita delete'
);

select ok(
  coalesce((
    select not result.studio_deleted
      and result.draft_discarded
      and result.edit_version = 4
    from private.discard_studio_draft(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      3,
      '64000000-0000-4000-8000-000000000013',
      '65000000-0000-4000-8000-000000000013'
    ) as result
  ), false),
  'discard de publicado remove somente draft e retorna versão positiva'
);

select ok(
  (
    select studio.status = 'published'
      and studio.edit_version = 4
      and studio.published_revision_id is not null
      and studio.draft_revision_id is null
      and (
        select pg_catalog.count(*) = 1
        from public.studio_revisions as revision
        where revision.studio_id = studio.id
          and revision.status = 'approved'
      )
    from public.studios as studio
    where studio.id = '63000000-0000-4000-8000-000000000001'
  ),
  'discard preserva snapshot publicado e remove fisicamente só o draft'
);

select ok(
  coalesce((
    select not result.studio_deleted
      and result.draft_discarded
      and result.edit_version = 4
    from private.discard_studio_draft(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      3,
      '64000000-0000-4000-8000-000000000013',
      '65000000-0000-4000-8000-000000000113'
    ) as result
  ), false)
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          event.actor_user_id = '60000000-0000-4000-8000-000000000001'
          and event.actor_role = 'authenticated'
          and event.target_type = 'studio'
          and event.result = 'succeeded'
          and event.request_id = '65000000-0000-4000-8000-000000000013'
          and event.idempotency_key = '64000000-0000-4000-8000-000000000013'
          and event.ip_hash is null
          and event.metadata = pg_catalog.jsonb_build_object(
            'editVersion', 4,
            'revisionNumber', 2
          )
        )
      from audit.events as event
      where event.action = 'studio.draft.discarded'
        and event.target_id = '63000000-0000-4000-8000-000000000001'
        and event.idempotency_key = '64000000-0000-4000-8000-000000000013'
    ),
  'discard preserva primeira request e metadata técnica exata sem PII'
);

select is(
  private.feat006_capture_error($command$
    select * from private.discard_studio_draft(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 4,
      '64000000-0000-4000-8000-000000000014',
      '65000000-0000-4000-8000-000000000014'
    )
  $command$),
  '23514:studio_draft_missing',
  'novo discard sem draft retorna erro factual recuperável'
);

select pg_catalog.set_config(
  'set_livre.test.feat006_revision_three_created',
  coalesce((
    select (
      result.edit_version = 5
        and result.published_revision_number = 1
        and result.draft_revision_number = 3
        and result.draft_name = 'Estúdio A terceira revisão'
    )::text
    from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 4,
      '64000000-0000-4000-8000-000000000017',
      '65000000-0000-4000-8000-000000000017',
      'Estúdio A terceira revisão',
      'Novo rascunho após descarte mantém numeração monotônica.',
      'Rua das Câmeras', '120', null, 'Centro Cívico',
      '80530000', 24,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), 'false'),
  true
);

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_revision_three_created'
  )::boolean
    and coalesce((
      select studio.last_revision_number = 3
      from public.studios as studio
      where studio.id = '63000000-0000-4000-8000-000000000001'
    ), false),
  'clone após descartar rev2 aloca rev3 sem reutilizar revision_number'
);

select is(
  private.feat006_capture_error($command$
    select * from private.discard_studio_draft(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 3,
      '64000000-0000-4000-8000-000000000013',
      '65000000-0000-4000-8000-000000000213'
    )
  $command$),
  '40001:studio_result_no_longer_available',
  'replay de discard antigo não mascara versão avançada com novo draft'
);

update public.studios
set edit_version = 9007199254740990,
    updated_at = pg_catalog.clock_timestamp()
where id = '63000000-0000-4000-8000-000000000001';

select pg_catalog.set_config(
  'set_livre.test.feat006_edit_version_max_transition',
  coalesce((
    select (
      result.edit_version = 9007199254740991
        and result.draft_revision_number = 3
        and result.draft_name = 'Estúdio A no teto de edição'
    )::text
    from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 9007199254740990,
      '64000000-0000-4000-8000-000000000019',
      '65000000-0000-4000-8000-000000000019',
      'Estúdio A no teto de edição',
      'Transição controlada que alcança exatamente o teto numérico seguro.',
      'Rua das Câmeras', '121', null, 'Centro Cívico',
      '80530000', 25,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), 'false'),
  true
);

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_edit_version_max_transition'
  )::boolean
    and coalesce((
      select studio.edit_version = 9007199254740991
        and studio.last_revision_number = 3
        and revision.revision_number = 3
        and revision.name = 'Estúdio A no teto de edição'
        and revision.capacity = 25
      from public.studios as studio
      join public.studio_revisions as revision
        on revision.id = studio.draft_revision_id
        and revision.studio_id = studio.id
      where studio.id = '63000000-0000-4000-8000-000000000001'
    ), false)
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          request.action = 'studio.revision.updateCore'
          and request.result_kind = 'editor'
          and request.resulting_edit_version = 9007199254740991
        )
      from private.studio_command_requests as request
      where request.owner_user_id = '60000000-0000-4000-8000-000000000001'
        and request.idempotency_key = '64000000-0000-4000-8000-000000000019'
    ),
  'update real permite MAX_SAFE-1 para MAX_SAFE e persiste ledger exato'
);

select pg_catalog.set_config(
  'set_livre.test.feat006_edit_version_max_snapshot',
  (
    select pg_catalog.jsonb_build_object(
      'studio', pg_catalog.to_jsonb(studio),
      'draft', pg_catalog.to_jsonb(revision)
    )::text
    from public.studios as studio
    join public.studio_revisions as revision
      on revision.id = studio.draft_revision_id
      and revision.studio_id = studio.id
    where studio.id = '63000000-0000-4000-8000-000000000001'
  ),
  true
);

select pg_catalog.set_config(
  'set_livre.test.feat006_edit_version_max_replay',
  coalesce((
    select (
      result.edit_version = 9007199254740991
        and result.draft_revision_number = 3
        and result.draft_name = 'Estúdio A no teto de edição'
    )::text
    from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 9007199254740990,
      '64000000-0000-4000-8000-000000000019',
      '65000000-0000-4000-8000-000000000119',
      'Estúdio A no teto de edição',
      'Transição controlada que alcança exatamente o teto numérico seguro.',
      'Rua das Câmeras', '121', null, 'Centro Cívico',
      '80530000', 25,
      '00000000-0000-4000-8000-000000000601'
    ) as result
  ), 'false'),
  true
);

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_edit_version_max_replay'
  )::boolean
    and pg_catalog.current_setting(
      'set_livre.test.feat006_edit_version_max_snapshot'
    ) = (
      select pg_catalog.jsonb_build_object(
        'studio', pg_catalog.to_jsonb(studio),
        'draft', pg_catalog.to_jsonb(revision)
      )::text
      from public.studios as studio
      join public.studio_revisions as revision
        on revision.id = studio.draft_revision_id
        and revision.studio_id = studio.id
      where studio.id = '63000000-0000-4000-8000-000000000001'
    )
    and (
      select pg_catalog.count(*) = 1
      from private.studio_command_requests as request
      where request.owner_user_id = '60000000-0000-4000-8000-000000000001'
        and request.idempotency_key = '64000000-0000-4000-8000-000000000019'
    ),
  'replay imediato retorna MAX_SAFE sem mutar raiz, draft ou ledger'
);

select pg_catalog.set_config(
  'set_livre.test.feat006_edit_version_ceiling_error',
  private.feat006_capture_error($command$
    select * from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 9007199254740991,
      '64000000-0000-4000-8000-000000000020',
      '65000000-0000-4000-8000-000000000020',
      'Estúdio acima do teto de edição',
      'Tentativa controlada de editar um draft no teto numérico seguro.',
      'Rua das Câmeras', '123', null, 'Centro Cívico',
      '80530000', 27,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$),
  true
);

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_edit_version_ceiling_error'
  ) = '22003:studio_edit_version_exhausted'
    and pg_catalog.current_setting(
      'set_livre.test.feat006_edit_version_max_snapshot'
    ) = (
      select pg_catalog.jsonb_build_object(
        'studio', pg_catalog.to_jsonb(studio),
        'draft', pg_catalog.to_jsonb(revision)
      )::text
      from public.studios as studio
      join public.studio_revisions as revision
        on revision.id = studio.draft_revision_id
        and revision.studio_id = studio.id
      where studio.id = '63000000-0000-4000-8000-000000000001'
    )
    and not exists (
      select 1
      from private.studio_command_requests as request
      where request.owner_user_id = '60000000-0000-4000-8000-000000000001'
        and request.idempotency_key = '64000000-0000-4000-8000-000000000020'
    )
    and not exists (
      select 1
      from audit.events as event
      where event.idempotency_key = '64000000-0000-4000-8000-000000000020'
    ),
  'nova chave no MAX_SAFE falha sem mutar raiz, draft, ledger ou auditoria'
);

select pg_catalog.set_config(
  'set_livre.test.feat006_discard_version_ceiling_error',
  private.feat006_capture_error($command$
    select * from private.discard_studio_draft(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001',
      9007199254740991,
      '64000000-0000-4000-8000-000000000021',
      '65000000-0000-4000-8000-000000000021'
    )
  $command$),
  true
);

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_discard_version_ceiling_error'
  ) = '22003:studio_edit_version_exhausted'
    and pg_catalog.current_setting(
      'set_livre.test.feat006_edit_version_max_snapshot'
    ) = (
      select pg_catalog.jsonb_build_object(
        'studio', pg_catalog.to_jsonb(studio),
        'draft', pg_catalog.to_jsonb(revision)
      )::text
      from public.studios as studio
      join public.studio_revisions as revision
        on revision.id = studio.draft_revision_id
        and revision.studio_id = studio.id
      where studio.id = '63000000-0000-4000-8000-000000000001'
    )
    and not exists (
      select 1
      from private.studio_command_requests as request
      where request.owner_user_id = '60000000-0000-4000-8000-000000000001'
        and request.idempotency_key = '64000000-0000-4000-8000-000000000021'
    )
    and not exists (
      select 1
      from audit.events as event
      where event.idempotency_key = '64000000-0000-4000-8000-000000000021'
    ),
  'discard no teto falha sem mutação, ledger ou auditoria'
);

delete from private.studio_command_requests
where owner_user_id = '60000000-0000-4000-8000-000000000001'
  and idempotency_key = '64000000-0000-4000-8000-000000000019';

update public.studios
set edit_version = 5,
    updated_at = pg_catalog.clock_timestamp()
where id = '63000000-0000-4000-8000-000000000001';

select pg_catalog.set_config(
  'set_livre.test.feat006_revision_three_discarded',
  coalesce((
    select (
      not result.studio_deleted
        and result.draft_discarded
        and result.edit_version = 6
    )::text
    from private.discard_studio_draft(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 5,
      '64000000-0000-4000-8000-000000000018',
      '65000000-0000-4000-8000-000000000018'
    ) as result
  ), 'false'),
  true
);

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_revision_three_discarded'
  )::boolean
    and coalesce((
      select studio.last_revision_number = 3
        and studio.draft_revision_id is null
      from public.studios as studio
      where studio.id = '63000000-0000-4000-8000-000000000001'
    ), false),
  'novo descarte preserva contador rev3 para a próxima alocação'
);

select ok(
  coalesce((
    select result.studio_deleted
      and not result.draft_discarded
      and result.edit_version is null
    from private.discard_studio_draft(
      '60000000-0000-4000-8000-000000000002',
      '63000000-0000-4000-8000-000000000002',
      1,
      '64000000-0000-4000-8000-000000000015',
      '65000000-0000-4000-8000-000000000015'
    ) as result
  ), false)
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          event.actor_user_id = '60000000-0000-4000-8000-000000000002'
          and event.actor_role = 'authenticated'
          and event.target_type = 'studio'
          and event.result = 'succeeded'
          and event.request_id = '65000000-0000-4000-8000-000000000015'
          and event.idempotency_key = '64000000-0000-4000-8000-000000000015'
          and event.ip_hash is null
          and event.metadata = pg_catalog.jsonb_build_object(
            'lastRevisionNumber', 1
          )
        )
      from audit.events as event
      where event.action = 'studio.deleted'
        and event.target_id = '63000000-0000-4000-8000-000000000002'
        and event.idempotency_key = '64000000-0000-4000-8000-000000000015'
    ),
  'shell removido preserva auditoria técnica exata sem PII'
);

select ok(
  not exists (
    select 1
    from public.studios as studio
    where studio.id = '63000000-0000-4000-8000-000000000002'
  )
    and not exists (
      select 1
      from public.studio_revisions as revision
      where revision.studio_id = '63000000-0000-4000-8000-000000000002'
    ),
  'remoção de nunca publicado elimina raiz e revisão draft'
);

select ok(
  exists (
    select 1
    from private.studio_command_requests as request
    where request.owner_user_id = '60000000-0000-4000-8000-000000000002'
      and request.idempotency_key = '64000000-0000-4000-8000-000000000015'
      and request.studio_id = '63000000-0000-4000-8000-000000000002'
      and request.result_kind = 'studio_deleted'
      and request.resulting_edit_version is null
  ),
  'ledger sem FK preserva tombstone do estúdio removido'
);

select ok(
  coalesce((
    select result.studio_deleted
      and not result.draft_discarded
      and result.edit_version is null
    from private.discard_studio_draft(
      '60000000-0000-4000-8000-000000000002',
      '63000000-0000-4000-8000-000000000002',
      1,
      '64000000-0000-4000-8000-000000000015',
      '65000000-0000-4000-8000-000000000115'
    ) as result
  ), false)
    and (
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          event.request_id = '65000000-0000-4000-8000-000000000015'
        )
      from audit.events as event
      where event.action = 'studio.deleted'
        and event.target_id = '63000000-0000-4000-8000-000000000002'
        and event.idempotency_key = '64000000-0000-4000-8000-000000000015'
    ),
  'replay de remoção usa tombstone sem substituir a primeira request'
);

select is(
  private.feat006_capture_error($command$
    select * from private.create_studio(
      '60000000-0000-4000-8000-000000000002',
      '63000000-0000-4000-8000-000000000002',
      '64000000-0000-4000-8000-000000000006',
      '65000000-0000-4000-8000-000000000106',
      'Estúdio B inicial',
      'Estúdio completo do segundo dono para testes.',
      'Rua do Vídeo', '200', null, 'Batel', '80420000', 8,
      '00000000-0000-4000-8000-000000000602'
    )
  $command$),
  '40001:studio_result_no_longer_available',
  'replay do create removido não fabrica estado autoritativo'
);

select is(
  private.feat006_capture_error($command$
    select * from private.create_studio(
      '60000000-0000-4000-8000-000000000002',
      '63000000-0000-4000-8000-000000000002',
      '64000000-0000-4000-8000-000000000016',
      '65000000-0000-4000-8000-000000000016',
      'Tentativa de recriar UUID removido',
      'Estúdio válido que tenta reutilizar identificador já removido.',
      'Rua do Vídeo', '201', null, 'Batel', '80420000', 8,
      '00000000-0000-4000-8000-000000000602'
    )
  $command$),
  '40001:studio_identifier_unavailable',
  'nova chave não reutiliza studioId tombstonado e evita ABA'
);

update public.studios
set last_revision_number = 9007199254740991,
    updated_at = pg_catalog.clock_timestamp()
where id = '63000000-0000-4000-8000-000000000001';

select pg_catalog.set_config(
  'set_livre.test.feat006_revision_number_ceiling_error',
  private.feat006_capture_error($command$
    select * from private.update_studio_revision_core(
      '60000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000001', 6,
      '64000000-0000-4000-8000-000000000022',
      '65000000-0000-4000-8000-000000000022',
      'Estúdio acima do teto de revisão',
      'Tentativa controlada de clonar uma revisão além do teto seguro.',
      'Rua das Câmeras', '122', null, 'Centro Cívico',
      '80530000', 26,
      '00000000-0000-4000-8000-000000000601'
    )
  $command$),
  true
);

select ok(
  pg_catalog.current_setting(
    'set_livre.test.feat006_revision_number_ceiling_error'
  ) = '22003:studio_revision_number_exhausted'
    and coalesce((
      select studio.edit_version = 6
        and studio.last_revision_number = 9007199254740991
        and studio.draft_revision_id is null
        and (
          select pg_catalog.count(*) = 1
          from public.studio_revisions as revision
          where revision.studio_id = studio.id
        )
      from public.studios as studio
      where studio.id = '63000000-0000-4000-8000-000000000001'
    ), false)
    and not exists (
      select 1
      from private.studio_command_requests as request
      where request.idempotency_key in (
          '64000000-0000-4000-8000-000000000014',
          '64000000-0000-4000-8000-000000000016',
          '64000000-0000-4000-8000-000000000022'
        )
    )
    and not exists (
      select 1
      from audit.events as event
      where event.idempotency_key in (
        '64000000-0000-4000-8000-000000000014',
        '64000000-0000-4000-8000-000000000016',
        '64000000-0000-4000-8000-000000000022'
      )
    ),
  'falhas de discard, tombstone e teto não deixam ledger ou auditoria'
);

select ok(
  private.check_readiness('20260816000200'),
  'readiness permanece verde após todos os fluxos destrutivos locais'
);

select * from finish();
rollback;

-- As mutações dblink são committed fora da transação pgTAP. O cleanup final
-- remove somente a identidade e os agregados QA reservados desta prova.
do $cleanup_concurrency_fixture$
begin
  delete from audit.events
  where actor_user_id = '66000000-0000-4000-8000-000000000010'
    or target_id in (
      '66000000-0000-4000-8000-000000000010',
      '67000000-0000-4000-8000-000000000010',
      '67000000-0000-4000-8000-000000000020',
      '67000000-0000-4000-8000-000000000030'
    );

  delete from private.studio_command_requests
  where owner_user_id = '66000000-0000-4000-8000-000000000010'
    or studio_id in (
      '67000000-0000-4000-8000-000000000010',
      '67000000-0000-4000-8000-000000000020',
      '67000000-0000-4000-8000-000000000030'
    );

  delete from public.studios
  where owner_user_id = '66000000-0000-4000-8000-000000000010'
    and id in (
      '67000000-0000-4000-8000-000000000010',
      '67000000-0000-4000-8000-000000000020',
      '67000000-0000-4000-8000-000000000030'
    );

  delete from auth.users
  where id = '66000000-0000-4000-8000-000000000010'
    and email = 'qa_f006_db_concurrency@setlivre.local';

  delete from private.signup_legal_intents
  where request_id = '66100000-0000-4000-8000-000000000010';
end;
$cleanup_concurrency_fixture$;

do $verify_concurrency_cleanup$
begin
  if exists (
    select 1
    from auth.users as auth_user
    where auth_user.id = '66000000-0000-4000-8000-000000000010'
       or auth_user.email = 'qa_f006_db_concurrency@setlivre.local'
  )
    or exists (
      select 1
      from public.profiles as profile
      where profile.id = '66000000-0000-4000-8000-000000000010'
    )
    or exists (
      select 1
      from public.user_preferences as preference
      where preference.user_id = '66000000-0000-4000-8000-000000000010'
    )
    or exists (
      select 1
      from public.terms_acceptances as acceptance
      where acceptance.user_id = '66000000-0000-4000-8000-000000000010'
    )
    or exists (
      select 1
      from public.owner_profiles as owner
      where owner.user_id = '66000000-0000-4000-8000-000000000010'
    )
    or exists (
      select 1
      from public.owner_payment_recipients as recipient
      where recipient.owner_user_id = '66000000-0000-4000-8000-000000000010'
    )
    or exists (
      select 1
      from private.owner_activation_requests as activation
      where activation.owner_user_id = '66000000-0000-4000-8000-000000000010'
    )
    or exists (
      select 1
      from private.owner_recipient_operations as operation
      where operation.owner_user_id = '66000000-0000-4000-8000-000000000010'
    )
    or exists (
      select 1
      from public.studios as studio
      where studio.id in (
        '67000000-0000-4000-8000-000000000010',
        '67000000-0000-4000-8000-000000000020',
        '67000000-0000-4000-8000-000000000030'
      )
        or studio.owner_user_id = '66000000-0000-4000-8000-000000000010'
    )
    or exists (
      select 1
      from public.studio_revisions as revision
      where revision.studio_id in (
        '67000000-0000-4000-8000-000000000010',
        '67000000-0000-4000-8000-000000000020'
      )
    )
    or exists (
      select 1
      from private.studio_command_requests as request
      where request.owner_user_id = '66000000-0000-4000-8000-000000000010'
         or request.studio_id in (
           '67000000-0000-4000-8000-000000000010',
           '67000000-0000-4000-8000-000000000020',
           '67000000-0000-4000-8000-000000000030'
         )
    )
    or exists (
      select 1
      from private.signup_legal_intents as intent
      where intent.request_id = '66100000-0000-4000-8000-000000000010'
    )
    or exists (
      select 1
      from audit.events as event
      where event.actor_user_id = '66000000-0000-4000-8000-000000000010'
         or event.target_id in (
           '66000000-0000-4000-8000-000000000010',
           '67000000-0000-4000-8000-000000000010',
           '67000000-0000-4000-8000-000000000020'
         )
    )
    or pg_catalog.to_regprocedure(
      'private.feat006_capture_error(text)'
    ) is not null
    or pg_catalog.to_regprocedure(
      'private.feat006_create_user(uuid,text,text,uuid,boolean,uuid,uuid)'
    ) is not null
    or pg_catalog.to_regclass(
      'pg_temp.feat006_concurrency_results'
    ) is not null
    or exists (
      select 1
      from pg_catalog.pg_extension as extension
      where extension.extname = 'dblink'
    )
  then
    raise exception using
      errcode = 'P0001',
      message = 'feat006_concurrency_cleanup_failed';
  end if;
end;
$verify_concurrency_cleanup$;
