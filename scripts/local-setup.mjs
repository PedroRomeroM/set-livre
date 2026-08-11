import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { databaseMigrationHead } from "../packages/contracts/src/database-contract.ts";

import { assertLocalDockerDaemon } from "./docker-local-context.mjs";
import {
  redactLocalPsqlDiagnostics,
  resolveTrustedLocalPsql,
  spawnLocalPsql,
} from "./local-psql-command.mjs";
import {
  assertSafeEnvironmentFileDestination,
  writeEnvironmentFileAtomic,
} from "./safe-environment-file.mjs";
import {
  assertSupabaseLoopbackBindings,
  assertSupabaseProjectStopped,
  ensureSupabaseLoopbackNetwork,
  supabaseLocalNetworkName,
  supabaseLocalProjectId,
  supabaseProjectContainersAreRunning,
} from "./supabase-local-network.mjs";

const root = resolve(import.meta.dirname, "..");
const localHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const applicationEnvironmentDestinations = [
  [resolve(root, ".env.local"), "http://127.0.0.1:3000"],
  [resolve(root, "apps/backoffice/.env.local"), "http://127.0.0.1:3001"],
];
const e2eEnvironmentPath = resolve(root, ".env.e2e.local");

for (const [path] of applicationEnvironmentDestinations) {
  assertSafeEnvironmentFileDestination(path);
}
assertSafeEnvironmentFileDestination(e2eEnvironmentPath);

const localDockerEnvironment = assertLocalDockerDaemon();
const trustedPsqlLaunch = resolveTrustedLocalPsql({
  inheritedEnvironment: localDockerEnvironment,
});

function successfulCommandOutput(command, argumentsList, result, options = {}) {
  if (result.status !== 0) {
    const diagnostics = options.safeStderr
      ? redactLocalPsqlDiagnostics(result.stderr, options.redactions)
      : "";
    throw new Error(
      `${command} ${argumentsList.join(" ")} falhou.${diagnostics === "" ? "" : `\n${diagnostics}`}`,
    );
  }

  return result.stdout ?? "";
}

function run(command, argumentsList, options = {}) {
  const commandEnvironment = {
    ...localDockerEnvironment,
    ...options.environment,
    DOCKER_HOST: localDockerEnvironment.DOCKER_HOST,
  };
  delete commandEnvironment.DOCKER_CONTEXT;

  const result = spawnSync(command, argumentsList, {
    cwd: root,
    encoding: "utf8",
    env: commandEnvironment,
    input: options.input,
    stdio: options.capture
      ? "pipe"
      : options.input === undefined
        ? "inherit"
        : ["pipe", "inherit", "inherit"],
  });
  return successfulCommandOutput(command, argumentsList, result, options);
}

function runPsql(databaseUrl, options = {}) {
  const { argumentsList, result } = spawnLocalPsql(trustedPsqlLaunch, databaseUrl, {
    assumeDalRole: options.assumeDalRole,
    command: options.command,
    input: options.input,
  });
  return successfulCommandOutput(trustedPsqlLaunch.command, argumentsList, result, options);
}

function stopScopedSupabaseStack() {
  run("supabase", ["stop", "--project-id", supabaseLocalProjectId], { capture: true });
  assertSupabaseProjectStopped(localDockerEnvironment);
}

run("docker", ["info"], { capture: true });
if (supabaseProjectContainersAreRunning(localDockerEnvironment)) {
  try {
    assertSupabaseLoopbackBindings(localDockerEnvironment);
  } catch {
    stopScopedSupabaseStack();
  }
}
ensureSupabaseLoopbackNetwork(localDockerEnvironment);
try {
  run("supabase", ["start", "--network-id", supabaseLocalNetworkName], { capture: true });
  assertSupabaseLoopbackBindings(localDockerEnvironment);
} catch (error) {
  if (supabaseProjectContainersAreRunning(localDockerEnvironment)) {
    stopScopedSupabaseStack();
  }
  throw error;
}
run("supabase", ["db", "reset", "--local", "--network-id", supabaseLocalNetworkName], {
  capture: true,
});
assertSupabaseLoopbackBindings(localDockerEnvironment);

const status = run(
  "supabase",
  ["status", "--output", "env", "--network-id", supabaseLocalNetworkName],
  { capture: true },
);
const values = Object.fromEntries(
  status
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) {
        return undefined;
      }

      const key = line.slice(0, separator);
      const rawValue = line.slice(separator + 1);
      if (!/^[A-Z_]+$/.test(key)) {
        return undefined;
      }

      return [key, rawValue.startsWith('"') ? JSON.parse(rawValue) : rawValue];
    })
    .filter((entry) => entry !== undefined),
);

const required = ["API_URL", "ANON_KEY", "DB_URL"];
for (const key of required) {
  if (values[key] === undefined || values[key] === "") {
    throw new Error(`Supabase local não retornou ${key}.`);
  }
}

function assertLocalEndpoint(value, label, protocol, port) {
  const parsed = new URL(value);
  if (
    !localHostnames.has(parsed.hostname) ||
    parsed.protocol !== protocol ||
    parsed.port !== port
  ) {
    throw new Error(`${label} não corresponde ao endpoint local esperado.`);
  }
}

assertLocalEndpoint(values.API_URL, "API_URL", "http:", "54321");
assertLocalEndpoint(values.DB_URL, "DB_URL", "postgresql:", "54322");

const runtimeRole = "app_runtime_local";
const runtimePassword = randomBytes(32).toString("base64url");
const e2eDatabaseMarker = randomBytes(32).toString("base64url");
const adminDatabaseUrl = new URL(values.DB_URL);
if (
  decodeURIComponent(adminDatabaseUrl.username) !== "postgres" ||
  adminDatabaseUrl.password === "" ||
  adminDatabaseUrl.pathname !== "/postgres" ||
  adminDatabaseUrl.search !== "" ||
  adminDatabaseUrl.hash !== ""
) {
  throw new Error("DB_URL não usa a identidade administrativa local esperada.");
}
const supabaseAdminDatabaseUrl = new URL(adminDatabaseUrl);
supabaseAdminDatabaseUrl.username = "supabase_admin";
const managedSchemaSql = `
begin;

do $block$
begin
  if current_user <> 'supabase_admin'
    or not (select rolsuper from pg_catalog.pg_roles where rolname = current_user)
  then
    raise exception 'A normalização de schemas gerenciados exige o superuser local esperado.';
  end if;
end
$block$;

revoke all on schema public from public;
grant usage on schema public to anon, authenticated, service_role;

do $block$
declare
  owner_role text;
begin
  if pg_catalog.to_regnamespace('net') is not null then
    if pg_catalog.current_setting('pg_net.username', true) <> 'postgres' then
      raise exception 'A identidade local do worker pg_net divergiu do contrato esperado.';
    end if;

    execute 'revoke all on schema net from public, anon, authenticated, service_role, app_dal';
    execute 'revoke all on all tables in schema net from public, anon, authenticated, service_role, app_dal';
    execute 'revoke all on all sequences in schema net from public, anon, authenticated, service_role, app_dal';
    execute 'revoke all on all functions in schema net from public, anon, authenticated, service_role, app_dal';
    execute 'grant usage on schema net to postgres';
    execute 'grant all on all tables in schema net to postgres';
    execute 'grant all on all sequences in schema net to postgres';
    execute 'grant execute on all functions in schema net to postgres';

    foreach owner_role in array array['supabase_admin', 'postgres']
    loop
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke all on tables from public, anon, authenticated, service_role, app_dal',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net grant all on tables to postgres',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke all on sequences from public, anon, authenticated, service_role, app_dal',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net grant all on sequences to postgres',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I revoke execute on functions from public, anon, authenticated, service_role, app_dal',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I revoke usage on types from public, anon, authenticated, service_role, app_dal',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke execute on functions from public, anon, authenticated, service_role, app_dal',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net grant execute on functions to postgres',
        owner_role
      );
    end loop;
  end if;
end
$block$;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = '${runtimeRole}') then
    create role ${runtimeRole}
      login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end
$block$;

revoke all privileges on table
  pg_catalog.pg_db_role_setting,
  pg_catalog.pg_roles,
  pg_catalog.pg_user
  from public, anon, authenticated, service_role, app_dal, ${runtimeRole};

do $block$
declare
  catalog_name text;
  column_list text;
begin
  foreach catalog_name in array array['pg_db_role_setting', 'pg_roles', 'pg_user']
  loop
    select pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' order by attribute.attnum)
      into column_list
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = pg_catalog.to_regclass(
        pg_catalog.format('pg_catalog.%I', catalog_name)
      )
      and attribute.attnum > 0
      and not attribute.attisdropped;

    execute pg_catalog.format(
      'revoke all privileges (%s) on table pg_catalog.%I from public, anon, authenticated, service_role, app_dal, %I',
      column_list,
      catalog_name,
      '${runtimeRole}'
    );
  end loop;
end
$block$;

grant all privileges on table
  pg_catalog.pg_db_role_setting,
  pg_catalog.pg_roles,
  pg_catalog.pg_user
  to supabase_admin;
grant select on table
  pg_catalog.pg_db_role_setting,
  pg_catalog.pg_roles,
  pg_catalog.pg_user
  to postgres, supabase_admin;

do $block$
declare
  membership_record record;
begin
  for membership_record in
    select
      granted.rolname as granted_role,
      member.rolname as member_role,
      grantor.rolname as grantor_role
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    join pg_catalog.pg_roles as grantor on grantor.oid = membership.grantor
    where granted.rolname = any (array['app_dal', '${runtimeRole}'])
    order by granted.rolname, (member.rolname = 'postgres'), member.rolname, grantor.rolname
  loop
    execute pg_catalog.format(
      'revoke %I from %I granted by %I cascade',
      membership_record.granted_role,
      membership_record.member_role,
      membership_record.grantor_role
    );
  end loop;
end
$block$;

do $block$
declare
  database_name text;
  managed_role text;
  setting_name text;
begin
  for managed_role in
    select role.rolname
    from pg_catalog.pg_roles as role
    where role.rolname = any (array['app_dal', '${runtimeRole}'])
    order by role.rolname
  loop
    for database_name in
      select database.datname
      from pg_catalog.pg_db_role_setting as setting
      join pg_catalog.pg_database as database on database.oid = setting.setdatabase
      join pg_catalog.pg_roles as role on role.oid = setting.setrole
      where role.rolname = managed_role
      order by database.datname
    loop
      execute pg_catalog.format(
        'alter role %I in database %I reset all',
        managed_role,
        database_name
      );
    end loop;
    execute pg_catalog.format('alter role %I reset all', managed_role);
    if managed_role = '${runtimeRole}' then
      execute pg_catalog.format(
        'alter role %I in database %I set "app.settings.jwt_secret" = %L',
        managed_role,
        pg_catalog.current_database(),
        ''
      );
    end if;
  end loop;

  for setting_name in
    select distinct pg_catalog.split_part(configuration.value, '=', 1)
    from pg_catalog.pg_db_role_setting as setting
    cross join lateral pg_catalog.unnest(setting.setconfig) as configuration(value)
    where setting.setrole = 0
      and setting.setdatabase = (
        select database.oid
        from pg_catalog.pg_database as database
        where database.datname = pg_catalog.current_database()
      )
      and pg_catalog.split_part(configuration.value, '=', 1)
        not in ('app.settings.jwt_exp', 'app.settings.jwt_secret')
    order by 1
  loop
    execute pg_catalog.format(
      'alter database %I reset %I',
      pg_catalog.current_database(),
      setting_name
    );
  end loop;
end
$block$;

do $block$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${runtimeRole}') then
    grant ${runtimeRole} to postgres with admin true, inherit false, set false;
  end if;
end
$block$;

grant app_dal to postgres with admin true, inherit false, set false;

commit;
`;
runPsql(supabaseAdminDatabaseUrl.toString(), {
  input: managedSchemaSql,
  redactions: [decodeURIComponent(supabaseAdminDatabaseUrl.password)],
  safeStderr: true,
});
const runtimeSql = `
begin;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = '${runtimeRole}') then
    raise exception 'A role local do runtime não foi criada pelo bootstrap privilegiado.';
  end if;
end
$block$;

do $block$
declare
  runtime_role_oid oid := (select oid from pg_catalog.pg_roles where rolname = '${runtimeRole}');
begin
  if exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = '${runtimeRole}' and (rolsuper or rolreplication or rolbypassrls)
  ) then
    raise exception 'A role local do runtime possui atributo que exige correção por superuser.';
  end if;

  if exists (
    select 1 from pg_catalog.pg_database where datdba = runtime_role_oid
    union all
    select 1 from pg_catalog.pg_namespace where nspowner = runtime_role_oid
    union all
    select 1 from pg_catalog.pg_class where relowner = runtime_role_oid
    union all
    select 1 from pg_catalog.pg_proc where proowner = runtime_role_oid
    union all
    select 1 from pg_catalog.pg_type where typowner = runtime_role_oid
  ) then
    raise exception 'A role local do runtime possui objetos e não pode ser normalizada automaticamente.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_default_acl as defaults
    cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
    where privilege.grantee = runtime_role_oid
  ) then
    raise exception 'A role local do runtime possui default privileges residuais.';
  end if;
end
$block$;

alter role ${runtimeRole}
  login noinherit nocreatedb nocreaterole
  connection limit 10 valid until 'infinity'
  password '${runtimePassword}';

revoke all privileges on database postgres from ${runtimeRole};

do $block$
declare
  schema_name text;
  type_name text;
begin
  for schema_name in
    select namespace.nspname
    from pg_catalog.pg_namespace as namespace
    where namespace.nspname = any (array['public', 'private', 'audit'])
  loop
    execute pg_catalog.format(
      'revoke all privileges on all tables in schema %I from %I',
      schema_name,
      '${runtimeRole}'
    );
    execute pg_catalog.format(
      'revoke all privileges on all sequences in schema %I from %I',
      schema_name,
      '${runtimeRole}'
    );
    execute pg_catalog.format(
      'revoke all privileges on all routines in schema %I from %I',
      schema_name,
      '${runtimeRole}'
    );
    execute pg_catalog.format(
      'revoke all privileges on schema %I from %I',
      schema_name,
      '${runtimeRole}'
    );
  end loop;

  for type_name in
    select pg_catalog.format('%I.%I', namespace.nspname, type_object.typname)
    from pg_catalog.pg_type as type_object
    join pg_catalog.pg_namespace as namespace on namespace.oid = type_object.typnamespace
    cross join lateral pg_catalog.aclexplode(type_object.typacl) as privilege
    where namespace.nspname = any (array['public', 'private', 'audit'])
      and privilege.grantee = (select oid from pg_catalog.pg_roles where rolname = '${runtimeRole}')
  loop
    execute pg_catalog.format(
      'revoke all privileges on type %s from %I',
      type_name,
      '${runtimeRole}'
    );
  end loop;
end
$block$;

do $block$
declare
  runtime_role_oid oid := (select oid from pg_catalog.pg_roles where rolname = '${runtimeRole}');
begin
  if exists (
    select 1
    from pg_catalog.pg_namespace as namespace
    cross join lateral pg_catalog.aclexplode(namespace.nspacl) as privilege
    where privilege.grantee = runtime_role_oid
    union all
    select 1
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(relation.relacl) as privilege
    where privilege.grantee = runtime_role_oid
    union all
    select 1
    from pg_catalog.pg_proc as routine
    cross join lateral pg_catalog.aclexplode(routine.proacl) as privilege
    where privilege.grantee = runtime_role_oid
    union all
    select 1
    from pg_catalog.pg_type as type_object
    cross join lateral pg_catalog.aclexplode(type_object.typacl) as privilege
    where privilege.grantee = runtime_role_oid
  ) then
    raise exception 'A role local do runtime preservou grants diretos fora do escopo normalizável.';
  end if;
end
$block$;

do $block$
declare
  granted_role text;
begin
  for granted_role in
    select granted.rolname
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as member on member.oid = membership.member
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    where member.rolname = '${runtimeRole}'
  loop
    execute pg_catalog.format('revoke %I from %I', granted_role, '${runtimeRole}');
  end loop;
end
$block$;

grant connect on database postgres to ${runtimeRole};
grant app_dal to ${runtimeRole} with admin false, inherit false, set true;
comment on database postgres is 'set-livre-e2e:${e2eDatabaseMarker}';

do $block$
begin
  if not (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(
        (
          member.rolname = '${runtimeRole}'
          and not membership.admin_option
          and not membership.inherit_option
          and membership.set_option
        )
        or (
          member.rolname = 'postgres'
          and membership.admin_option
          and not membership.inherit_option
          and not membership.set_option
        )
      )
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where granted.rolname = 'app_dal'
  ) then
    raise exception 'O manifesto de membros de app_dal não foi restaurado.';
  end if;

  if not (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        member.rolname = 'postgres'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      )
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where granted.rolname = '${runtimeRole}'
  ) then
    raise exception 'O manifesto administrativo do login restrito local divergiu.';
  end if;

  if not (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        setting.setdatabase = (
          select database.oid
          from pg_catalog.pg_database as database
          where database.datname = pg_catalog.current_database()
        )
        and setting.setconfig = array['app.settings.jwt_secret=']::text[]
      )
    from pg_catalog.pg_db_role_setting as setting
    join pg_catalog.pg_roles as role on role.oid = setting.setrole
    where role.rolname = '${runtimeRole}'
  ) then
    raise exception 'O login restrito local não preservou somente a máscara de segredo esperada.';
  end if;

  if not (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        dependency.dbid = 0
        and dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
        and dependency.objid = (
          select database.oid
          from pg_catalog.pg_database as database
          where database.datname = pg_catalog.current_database()
        )
        and dependency.objsubid = 0
      )
    from pg_catalog.pg_shdepend as dependency
    join pg_catalog.pg_roles as role on role.oid = dependency.refobjid
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and role.rolname = '${runtimeRole}'
      and dependency.deptype = 'a'
  ) then
    raise exception 'O login restrito local possui dependências ACL fora do CONNECT autorizado.';
  end if;

  if not (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        privilege.grantee = role.oid
        and privilege.grantor <> role.oid
        and privilege.privilege_type = 'CONNECT'
        and not privilege.is_grantable
      )
    from pg_catalog.pg_database as database
    cross join pg_catalog.pg_roles as role
    cross join lateral pg_catalog.aclexplode(database.datacl) as privilege
    where database.datname = pg_catalog.current_database()
      and role.rolname = '${runtimeRole}'
      and (privilege.grantee = role.oid or privilege.grantor = role.oid)
  ) then
    raise exception 'O CONNECT direto do login restrito local divergiu do manifesto.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_shdepend as dependency
    join pg_catalog.pg_roles as role on role.oid = dependency.refobjid
    where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      and role.rolname = '${runtimeRole}'
      and dependency.deptype = 'o'
  ) then
    raise exception 'O login restrito local possui ownership indevido.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_db_role_setting as setting
    cross join lateral pg_catalog.unnest(setting.setconfig) as configuration(value)
    where setting.setrole = 0
      and setting.setdatabase = (
        select database.oid
        from pg_catalog.pg_database as database
        where database.datname = pg_catalog.current_database()
      )
      and pg_catalog.split_part(configuration.value, '=', 1)
        not in ('app.settings.jwt_exp', 'app.settings.jwt_secret')
  ) then
    raise exception 'O banco local possui parâmetro global fora da allowlist.';
  end if;
end
$block$;

commit;
`;
runPsql(values.DB_URL, {
  input: runtimeSql,
  redactions: [runtimePassword, e2eDatabaseMarker, decodeURIComponent(adminDatabaseUrl.password)],
  safeStderr: true,
});

const dalDatabaseUrl = new URL(values.DB_URL);
dalDatabaseUrl.username = runtimeRole;
dalDatabaseUrl.password = runtimePassword;
dalDatabaseUrl.searchParams.set("options", "-c role=app_dal");
const identity = runPsql(dalDatabaseUrl.toString(), {
  assumeDalRole: true,
  command: `select current_user || ':' || session_user || ':'
    || private.check_readiness('${databaseMigrationHead}') || ':'
    || private.check_runtime_readiness('${runtimeRole}')`,
  redactions: [runtimePassword],
  safeStderr: true,
}).trim();
if (identity !== "app_dal:app_runtime_local:true:true") {
  throw new Error("A conexão DAL local não satisfez o manifesto restrito esperado.");
}

function applicationEnvironment(applicationUrl) {
  return [
    "APP_ENV=local",
    "APP_RELEASE_SHA=local",
    `NEXT_PUBLIC_APP_URL=${applicationUrl}`,
    `NEXT_PUBLIC_SUPABASE_URL=${values.API_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${values.ANON_KEY}`,
    `DATABASE_URL_APP_DAL=${dalDatabaseUrl.toString()}`,
    "",
  ].join("\n");
}
const e2eEnvironment = [
  "E2E_ALLOW_LOCAL=1",
  "E2E_BASE_URL=http://127.0.0.1:3000",
  "E2E_BACKOFFICE_URL=http://127.0.0.1:3001",
  `E2E_DATABASE_MARKER=${e2eDatabaseMarker}`,
  `NEXT_PUBLIC_SUPABASE_URL=${values.API_URL}`,
  `DATABASE_URL_APP_DAL=${dalDatabaseUrl.toString()}`,
  `E2E_DATABASE_URL=${values.DB_URL}`,
  "",
].join("\n");

for (const [path, applicationUrl] of applicationEnvironmentDestinations) {
  writeEnvironmentFileAtomic(path, applicationEnvironment(applicationUrl));
}
writeEnvironmentFileAtomic(e2eEnvironmentPath, e2eEnvironment);

process.stdout.write(
  "Supabase local pronto em http://127.0.0.1:54321. Runtime e E2E foram gravados separadamente em arquivos ignorados.\n",
);
