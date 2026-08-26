import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { Client } from "pg";

import { databaseMigrationHead } from "../packages/contracts/src/database-contract.ts";

import { generateDatabaseArtifacts, verifyDatabaseArtifacts } from "./database-artifacts.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const supabasePackagePath = require.resolve("supabase/package.json");
const supabasePackage = JSON.parse(readFileSync(supabasePackagePath, "utf8"));
const supabaseBin = supabasePackage.bin?.supabase;

if (typeof supabaseBin !== "string" || supabaseBin === "") {
  throw new Error("O pacote Supabase instalado não declara sua CLI.");
}

const supabaseCliPath = resolve(dirname(supabasePackagePath), supabaseBin);

const localDockerContracts = {
  linux: new Map([["default", "unix:///var/run/docker.sock"]]),
  win32: new Map([
    ["default", "npipe:////./pipe/docker_engine"],
    ["desktop-linux", "npipe:////./pipe/dockerDesktopLinuxEngine"],
  ]),
};

function runDocker(argumentsList, environment = process.env) {
  const result = spawnSync("docker", argumentsList, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("A CLI Docker não comprovou o daemon local esperado.");
  }
  return (result.stdout ?? "").trim();
}

function assertDockerOverridesAbsent(dockerHostOverride, dockerContextOverride) {
  if (
    (typeof dockerHostOverride === "string" && dockerHostOverride.trim() !== "") ||
    (typeof dockerContextOverride === "string" && dockerContextOverride.trim() !== "")
  ) {
    throw new Error("DOCKER_HOST e DOCKER_CONTEXT precisam estar ausentes para operações locais.");
  }
}

export function validateLocalDockerContext({
  contextName,
  dockerContextOverride,
  dockerHostOverride,
  endpoint,
  engineOperatingSystem,
  platform,
}) {
  assertDockerOverridesAbsent(dockerHostOverride, dockerContextOverride);

  const contracts = localDockerContracts[platform];
  if (contracts === undefined) {
    throw new Error("O Supabase local possui contrato Docker somente para Windows e Linux.");
  }
  if (contracts.get(contextName) !== endpoint) {
    throw new Error("O contexto Docker ativo não aponta para o daemon local permitido.");
  }
  if (engineOperatingSystem !== "linux") {
    throw new Error("O daemon Docker local precisa executar containers Linux.");
  }
  return endpoint;
}

export function assertLocalDockerDaemon(environment = process.env, platform = process.platform) {
  const dockerHostOverride = environment.DOCKER_HOST;
  const dockerContextOverride = environment.DOCKER_CONTEXT;
  assertDockerOverridesAbsent(dockerHostOverride, dockerContextOverride);

  const contextName = runDocker(["context", "show"], environment);
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(contextName)) {
    throw new Error("O nome do contexto Docker ativo é inválido.");
  }

  let endpoint;
  try {
    endpoint = JSON.parse(
      runDocker(
        ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"],
        environment,
      ),
    );
  } catch {
    throw new Error("Não foi possível inspecionar o endpoint Docker local.");
  }
  if (typeof endpoint !== "string") {
    throw new Error("O endpoint Docker inspecionado é inválido.");
  }

  const localEnvironment = { ...environment, DOCKER_HOST: endpoint };
  delete localEnvironment.DOCKER_CONTEXT;
  delete localEnvironment.DOCKER_CERT_PATH;
  delete localEnvironment.DOCKER_TLS_VERIFY;

  let engineOperatingSystem;
  try {
    engineOperatingSystem = JSON.parse(
      runDocker(["info", "--format", "{{json .OSType}}"], localEnvironment),
    );
  } catch {
    throw new Error("Não foi possível inspecionar o daemon Docker local.");
  }

  validateLocalDockerContext({
    contextName,
    dockerContextOverride,
    dockerHostOverride,
    endpoint,
    engineOperatingSystem,
    platform,
  });
  return localEnvironment;
}

export function runSupabase(argumentsList, { capture = false } = {}) {
  const localDockerEnvironment = assertLocalDockerDaemon();
  const result = spawnSync(process.execPath, [supabaseCliPath, ...argumentsList], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: localDockerEnvironment,
    maxBuffer: 128 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined || result.status !== 0) {
    const status = result.status === null ? "sem código" : `código ${result.status}`;
    const diagnostic = parseSupabaseCliError(`${result.stderr ?? ""}\n${result.stdout ?? ""}`);
    const suffix = diagnostic === undefined ? "" : `: ${diagnostic}`;
    throw new Error(
      `Supabase CLI falhou em ${argumentsList.slice(0, 2).join(" ")} (${status})${suffix}.`,
    );
  }
  return result.stdout ?? "";
}

export function parseSupabaseCliError(rawError) {
  if (typeof rawError !== "string" || rawError.trim() === "") return undefined;
  const lines = rawError.trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try {
      const payload = JSON.parse(line);
      const message = payload?.error?.message ?? payload?.message;
      if (typeof message === "string" && message !== "") {
        return message.replaceAll(/postgres(?:ql)?:\/\/[^\s@]+@/giu, "postgresql://[REDACTED]@");
      }
    } catch {
      // A CLI mistura progresso textual e um erro JSON final; somente o JSON é seguro para diagnóstico.
    }
  }
  return undefined;
}

function assertLocalEndpoint(value, label, protocol, port) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== protocol ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== port ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} não corresponde ao endpoint local esperado.`);
  }
  return parsed;
}

export function parseSupabaseStatus(rawStatus) {
  const values = JSON.parse(rawStatus);
  for (const name of ["ANON_KEY", "API_URL", "DB_URL"]) {
    if (typeof values[name] !== "string" || values[name] === "") {
      throw new Error(`Supabase local não retornou ${name}.`);
    }
  }

  const apiUrl = assertLocalEndpoint(values.API_URL, "API_URL", "http:", "54321");
  if (
    apiUrl.username !== "" ||
    apiUrl.password !== "" ||
    apiUrl.pathname !== "/" ||
    apiUrl.search !== ""
  ) {
    throw new Error("API_URL local precisa ser uma origem sem credenciais ou path.");
  }

  const databaseUrl = assertLocalEndpoint(values.DB_URL, "DB_URL", "postgresql:", "54322");
  if (
    decodeURIComponent(databaseUrl.username) !== "postgres" ||
    databaseUrl.password === "" ||
    databaseUrl.pathname !== "/postgres" ||
    databaseUrl.search !== ""
  ) {
    throw new Error("DB_URL local não usa a identidade administrativa esperada.");
  }

  return values;
}

function localStatus() {
  return parseSupabaseStatus(runSupabase(["status", "--output", "json"], { capture: true }));
}

async function writePrivateEnvironment(destination, contents) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function runtimeRoleSql(password, marker) {
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(password) || !/^[A-Za-z0-9_-]{32,128}$/u.test(marker)) {
    throw new Error("As credenciais locais geradas não atendem ao formato seguro.");
  }

  return `
begin;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'app_runtime_local') then
    create role app_runtime_local;
  end if;
end
$block$;

do $block$
declare
  owner_role text;
begin
  if pg_catalog.to_regnamespace('net') is not null then
    execute 'revoke all on schema net from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production';
    execute 'revoke all on all tables in schema net from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production';
    execute 'revoke all on all sequences in schema net from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production';
    execute 'revoke all on all functions in schema net from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production';
    execute 'grant usage on schema net to postgres';
    execute 'grant all on all tables in schema net to postgres';
    execute 'grant all on all sequences in schema net to postgres';
    execute 'grant execute on all functions in schema net to postgres';

    foreach owner_role in array array['supabase_admin', 'postgres']
    loop
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke all on tables from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke all on sequences from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke execute on functions from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
        owner_role
      );
      execute pg_catalog.format(
        'alter default privileges for role %I in schema net revoke usage on types from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
        owner_role
      );
    end loop;
  end if;
end
$block$;

revoke all privileges on table
  pg_catalog.pg_db_role_setting,
  pg_catalog.pg_roles,
  pg_catalog.pg_user
from public, anon, authenticated, service_role, app_dal,
  app_runtime_local, app_runtime_production;

do $block$
declare
  catalog_name text;
  column_list text;
begin
  foreach catalog_name in array array['pg_db_role_setting', 'pg_roles', 'pg_user']
  loop
    select pg_catalog.string_agg(
        pg_catalog.format('%I', attribute.attname),
        ', ' order by attribute.attnum
      )
      into column_list
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = pg_catalog.to_regclass(
        pg_catalog.format('pg_catalog.%I', catalog_name)
      )
      and attribute.attnum > 0
      and not attribute.attisdropped;

    execute pg_catalog.format(
      'revoke all privileges (%s) on table pg_catalog.%I from public, anon, authenticated, service_role, app_dal, app_runtime_local, app_runtime_production',
      column_list,
      catalog_name
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
grant select on table pg_catalog.pg_roles to supabase_storage_admin;

do $block$
declare
  membership record;
begin
  for membership in
    select granted.rolname as granted_role, member.rolname as member_role,
      grantor.rolname as grantor_role
    from pg_catalog.pg_auth_members as relation
    join pg_catalog.pg_roles as granted on granted.oid = relation.roleid
    join pg_catalog.pg_roles as member on member.oid = relation.member
    join pg_catalog.pg_roles as grantor on grantor.oid = relation.grantor
    where member.rolname = 'app_runtime_local'
       or granted.rolname = 'app_runtime_local'
       or (granted.rolname = 'app_dal' and member.rolname = 'postgres')
  loop
    execute pg_catalog.format(
      'revoke %I from %I granted by %I cascade',
      membership.granted_role,
      membership.member_role,
      membership.grantor_role
    );
  end loop;
end
$block$;

alter role app_runtime_local
  login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
  connection limit 10 valid until 'infinity' password '${password}';
alter role app_runtime_local reset all;
alter role app_runtime_local in database postgres reset all;
alter role app_runtime_local in database postgres set "app.settings.jwt_secret" = '';

revoke all privileges on database postgres from app_runtime_local;
grant connect on database postgres to app_runtime_local;
grant app_dal to app_runtime_local with admin false, inherit false, set true;
grant app_dal to postgres with admin true, inherit false, set false;
grant app_dal to app_runtime_production with admin false, inherit false, set true;
grant app_runtime_local to postgres with admin true, inherit false, set false;

comment on database postgres is 'set-livre-e2e:${marker}';

commit;
`;
}

async function provisionLocalRuntime(values) {
  const runtimePassword = randomBytes(32).toString("base64url");
  const databaseMarker = randomBytes(32).toString("base64url");
  const administratorUrl = new URL(values.DB_URL);
  administratorUrl.username = "supabase_admin";
  const administrator = new Client({ connectionString: administratorUrl.toString() });
  await administrator.connect();
  try {
    await administrator.query(runtimeRoleSql(runtimePassword, databaseMarker));
  } finally {
    await administrator.end();
  }

  const dalDatabaseUrl = new URL(values.DB_URL);
  dalDatabaseUrl.username = "app_runtime_local";
  dalDatabaseUrl.password = runtimePassword;
  dalDatabaseUrl.searchParams.set("options", "-c role=app_dal");

  const runtime = new Client({ connectionString: dalDatabaseUrl.toString() });
  await runtime.connect();
  try {
    const result = await runtime.query(
      `select current_user, session_user,
        private.check_readiness($1::text) as ready,
        private.check_runtime_readiness($2::text) as runtime_ready`,
      [databaseMigrationHead, "app_runtime_local"],
    );
    const identity = result.rows[0];
    if (
      identity?.current_user !== "app_dal" ||
      identity?.session_user !== "app_runtime_local" ||
      identity?.ready !== true ||
      identity?.runtime_ready !== true
    ) {
      throw new Error(
        `A role DAL local não satisfez o contrato de readiness (role=${identity?.current_user}, session=${identity?.session_user}, database=${String(identity?.ready)}, runtime=${String(identity?.runtime_ready)}).`,
      );
    }
  } finally {
    await runtime.end();
  }

  return { dalDatabaseUrl: dalDatabaseUrl.toString(), databaseMarker };
}

function applicationEnvironment(values, dalDatabaseUrl, appUrl) {
  return [
    "APP_ENV=local",
    "APP_RELEASE_SHA=local",
    `NEXT_PUBLIC_APP_URL=${appUrl}`,
    `NEXT_PUBLIC_SUPABASE_URL=${values.API_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${values.ANON_KEY}`,
    `DATABASE_URL_APP_DAL=${dalDatabaseUrl}`,
    "",
  ].join("\n");
}

async function resetLocalEnvironment() {
  process.stdout.write("Iniciando a stack Supabase local...\n");
  runSupabase(["start"], { capture: true });
  process.stdout.write("Reaplicando migrations e seed...\n");
  runSupabase(["db", "reset", "--local"], { capture: true });
  const values = localStatus();
  process.stdout.write("Provisionando a role DAL local...\n");
  const { dalDatabaseUrl, databaseMarker } = await provisionLocalRuntime(values);

  await Promise.all([
    writePrivateEnvironment(
      resolve(repositoryRoot, ".env.local"),
      applicationEnvironment(values, dalDatabaseUrl, "http://127.0.0.1:3000"),
    ),
    writePrivateEnvironment(
      resolve(repositoryRoot, "apps/backoffice/.env.local"),
      applicationEnvironment(values, dalDatabaseUrl, "http://127.0.0.1:3001"),
    ),
    writePrivateEnvironment(
      resolve(repositoryRoot, ".env.e2e.local"),
      [
        "E2E_ALLOW_LOCAL=1",
        "E2E_BASE_URL=http://127.0.0.1:3000",
        "E2E_BACKOFFICE_URL=http://127.0.0.1:3001",
        `E2E_DATABASE_MARKER=${databaseMarker}`,
        `NEXT_PUBLIC_SUPABASE_URL=${values.API_URL}`,
        `DATABASE_URL_APP_DAL=${dalDatabaseUrl}`,
        `E2E_DATABASE_URL=${values.DB_URL}`,
        "",
      ].join("\n"),
    ),
  ]);
  process.stdout.write("Supabase local reiniciado e ambientes de desenvolvimento atualizados.\n");
}

export async function main(command = "reset") {
  if (command === "start") {
    runSupabase(["start"], { capture: true });
    localStatus();
    process.stdout.write("Supabase local ativo em 127.0.0.1:54321.\n");
    return;
  }
  if (command === "stop") {
    runSupabase(["stop"]);
    return;
  }
  if (command === "status") {
    localStatus();
    process.stdout.write("Supabase local ativo em 127.0.0.1:54321.\n");
    return;
  }
  if (command === "reset") {
    await resetLocalEnvironment();
    return;
  }

  localStatus();
  if (command === "generate-schema") {
    await generateDatabaseArtifacts(runSupabase, { schema: true, types: false });
  } else if (command === "generate-types") {
    await generateDatabaseArtifacts(runSupabase, { schema: false, types: true });
  } else if (command === "generate") {
    await generateDatabaseArtifacts(runSupabase);
  } else if (command === "test") {
    runSupabase(["test", "db", "--local"]);
    await verifyDatabaseArtifacts(runSupabase);
    process.stdout.write("Testes SQL e artefatos gerados estão consistentes.\n");
  } else {
    throw new Error(`Comando local desconhecido: ${command}.`);
  }
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  await main(process.argv[2]);
}
