import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

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

function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.environment },
    input: options.input,
    stdio: options.capture
      ? "pipe"
      : options.input === undefined
        ? "inherit"
        : ["pipe", "inherit", "inherit"],
  });

  if (result.status !== 0) {
    const diagnostics = options.safeStderr
      ? (result.stderr ?? "")
          .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/giu, "$1[REDACTED]@")
          .split("\n")
          .map((line) =>
            (options.redactions ?? []).reduce(
              (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
              line,
            ),
          )
          .filter(Boolean)
          .slice(-12)
          .join("\n")
      : "";
    throw new Error(
      `${command} ${argumentsList.join(" ")} falhou.${diagnostics === "" ? "" : `\n${diagnostics}`}`,
    );
  }

  return result.stdout ?? "";
}

function stopScopedSupabaseStack() {
  run("supabase", ["stop", "--project-id", supabaseLocalProjectId], { capture: true });
  assertSupabaseProjectStopped();
}

run("docker", ["info"], { capture: true });
if (supabaseProjectContainersAreRunning()) {
  try {
    assertSupabaseLoopbackBindings();
  } catch {
    stopScopedSupabaseStack();
  }
}
ensureSupabaseLoopbackNetwork();
try {
  run("supabase", ["start", "--network-id", supabaseLocalNetworkName], { capture: true });
  assertSupabaseLoopbackBindings();
} catch (error) {
  if (supabaseProjectContainersAreRunning()) {
    stopScopedSupabaseStack();
  }
  throw error;
}
run("supabase", ["db", "reset", "--local", "--network-id", supabaseLocalNetworkName], {
  capture: true,
});
assertSupabaseLoopbackBindings();

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

function psqlArguments(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return [
    "--host",
    parsed.hostname,
    "--port",
    parsed.port,
    "--username",
    decodeURIComponent(parsed.username),
    "--dbname",
    decodeURIComponent(parsed.pathname.slice(1)),
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
  ];
}

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
const runtimeSql = `
begin;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = '${runtimeRole}') then
    create role ${runtimeRole} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
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
alter role ${runtimeRole} reset all;

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

commit;
`;
run("psql", psqlArguments(values.DB_URL), {
  capture: true,
  environment: { PGPASSWORD: decodeURIComponent(adminDatabaseUrl.password) },
  input: runtimeSql,
  redactions: [runtimePassword, decodeURIComponent(adminDatabaseUrl.password)],
  safeStderr: true,
});

const dalDatabaseUrl = new URL(values.DB_URL);
dalDatabaseUrl.username = runtimeRole;
dalDatabaseUrl.password = runtimePassword;
dalDatabaseUrl.searchParams.set("options", "-c role=app_dal");
const identity = run(
  "psql",
  [
    ...psqlArguments(dalDatabaseUrl.toString()),
    "--tuples-only",
    "--no-align",
    "--command",
    "select current_user || ':' || session_user",
  ],
  {
    capture: true,
    environment: {
      PGOPTIONS: "-c role=app_dal",
      PGPASSWORD: runtimePassword,
    },
  },
).trim();
if (identity !== "app_dal:app_runtime_local") {
  throw new Error("A conexão DAL local não assumiu a role restrita esperada.");
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
