import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "pg";

import {
  databaseMigrationHead,
  parseDalDatabaseUrl,
} from "../packages/contracts/src/database-contract.ts";

const productionRole = "app_runtime_production";
const productionRoleNames = "app_dal,app_runtime_production";
const migrationVersionPattern = /^[0-9]{14}$/u;
export const productionCoordinates = Object.freeze({
  backofficeUrl: "https://ops.setlivre.com",
  databaseHost: "aws-0-sa-east-1.pooler.supabase.com",
  databasePort: 5432,
  projectRef: "oirvvnojgkzdppkdvhej",
  publicUrl: "https://147.15.97.227",
  supabaseUrl: "https://oirvvnojgkzdppkdvhej.supabase.co",
  vmHost: "147.15.97.227",
});
const projectRefPattern = /^[a-z]{20}$/u;
const publishableKeyPattern = /^sb_publishable_[A-Za-z0-9_-]{12,}$/u;

function requiredValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} não foi configurado.`);
  }
  return value;
}

function decodedUrlPart(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${label} possui encoding inválido.`);
  }
}

export function assertSupabasePublishableKey(value) {
  if (typeof value !== "string" || value.startsWith("sb_secret_")) {
    throw new Error("PRD_SUPABASE_PUBLISHABLE_KEY não pode ser uma chave privilegiada.");
  }
  if (value.includes("\n") || value.includes("\r") || value.length > 4096) {
    throw new Error("PRD_SUPABASE_PUBLISHABLE_KEY possui formato inválido.");
  }
  const jwtParts = value.split(".");
  if (jwtParts.length === 3) {
    let role;
    try {
      const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString("utf8"));
      role = payload?.role;
    } catch {
      role = undefined;
    }
    if (role === "service_role") {
      throw new Error("PRD_SUPABASE_PUBLISHABLE_KEY não pode ser uma chave privilegiada.");
    }
    throw new Error("PRD_SUPABASE_PUBLISHABLE_KEY precisa usar o formato sb_publishable_.");
  }
  if (!publishableKeyPattern.test(value)) {
    throw new Error("PRD_SUPABASE_PUBLISHABLE_KEY possui formato inválido.");
  }
}

export function productionRoleConnections(environment = process.env) {
  const projectRef = requiredValue(environment, "SUPABASE_PROJECT_REF");
  const adminPassword = requiredValue(environment, "SUPABASE_DB_PASSWORD");
  const runtimeUrl = requiredValue(environment, "PRD_DATABASE_URL_APP_DAL");
  if (!projectRefPattern.test(projectRef)) {
    throw new Error("SUPABASE_PROJECT_REF possui formato inválido.");
  }
  if (projectRef !== productionCoordinates.projectRef) {
    throw new Error("SUPABASE_PROJECT_REF não identifica o projeto Set Livre de produção.");
  }

  const contract = parseDalDatabaseUrl(runtimeUrl);
  if (contract.sessionRole !== productionRole || contract.projectRef !== projectRef) {
    throw new Error("A URL DAL não identifica a role e o projeto de produção esperados.");
  }

  const parsed = new URL(contract.connectionString);
  const database = decodedUrlPart(parsed.pathname.slice(1), "database");
  const runtimePassword = decodedUrlPart(parsed.password, "senha DAL");
  const runtimeUser = decodedUrlPart(parsed.username, "usuário DAL");
  if (
    parsed.hostname !== productionCoordinates.databaseHost ||
    Number(parsed.port) !== productionCoordinates.databasePort ||
    database !== "postgres"
  ) {
    throw new Error("A conexão de produção diverge do pooler session exato do projeto Set Livre.");
  }

  const shared = {
    application_name: "set-livre-production-role",
    connectionTimeoutMillis: 15_000,
    database,
    host: parsed.hostname,
    port: Number(parsed.port),
    query_timeout: 20_000,
    ssl: { rejectUnauthorized: true },
    statement_timeout: 15_000,
  };
  return {
    admin: {
      ...shared,
      password: adminPassword,
      user: `postgres.${projectRef}`,
    },
    runtime: {
      ...shared,
      options: "-c role=app_dal",
      password: runtimePassword,
      user: runtimeUser,
    },
  };
}

export function assertProductionDeploymentContract(environment = process.env) {
  const connections = productionRoleConnections(environment);
  const expectedValues = [
    ["PRODUCTION_SUPABASE_URL", productionCoordinates.supabaseUrl],
    ["PRODUCTION_PUBLIC_APP_URL", productionCoordinates.publicUrl],
    ["PRODUCTION_BACKOFFICE_APP_URL", productionCoordinates.backofficeUrl],
    ["PRODUCTION_VM_HOST", productionCoordinates.vmHost],
  ];
  for (const [name, expected] of expectedValues) {
    if (requiredValue(environment, name) !== expected) {
      throw new Error(`${name} diverge da coordenada versionada de produção.`);
    }
  }

  const publishableKey = requiredValue(environment, "PRD_SUPABASE_PUBLISHABLE_KEY");
  assertSupabasePublishableKey(publishableKey);
  return connections;
}

export async function verifyProductionDeploymentContract(
  environment = process.env,
  { createClient = createPostgresClient, fetchImplementation = globalThis.fetch } = {},
) {
  const connections = assertProductionDeploymentContract(environment);
  const publishableKey = requiredValue(environment, "PRD_SUPABASE_PUBLISHABLE_KEY");
  if (typeof fetchImplementation !== "function") {
    throw new Error("O cliente HTTP do probe Supabase não está disponível.");
  }

  let response;
  try {
    response = await fetchImplementation(`${productionCoordinates.supabaseUrl}/auth/v1/settings`, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        apikey: publishableKey,
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error("Não foi possível validar a chave publishable no projeto de produção.", {
      cause: error,
    });
  }
  if (response.status !== 200) {
    throw new Error(`O projeto de produção recusou a chave publishable (${response.status}).`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("O endpoint Auth do projeto de produção retornou um payload inválido.");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.disable_signup !== "boolean" ||
    payload.external === null ||
    typeof payload.external !== "object" ||
    Array.isArray(payload.external)
  ) {
    throw new Error("O endpoint Auth do projeto de produção retornou um contrato inválido.");
  }
  await verifyProductionRuntimeCredentialBeforeMigrations(connections, { createClient });
  return connections;
}

function assertSingleExpectedMembership(rows) {
  if (
    rows.length !== 1 ||
    rows[0]?.roleName !== "app_dal" ||
    rows[0]?.adminOption !== false ||
    rows[0]?.inheritOption !== false ||
    rows[0]?.setOption !== true
  ) {
    throw new Error("A role de produção possui membership inesperado.");
  }
}

function assertSingleExpectedRuntimeMember(rows) {
  if (
    rows.length !== 1 ||
    rows[0]?.roleName !== "postgres" ||
    rows[0]?.adminOption !== true ||
    rows[0]?.inheritOption !== false ||
    rows[0]?.setOption !== false
  ) {
    throw new Error("A role de produção foi concedida a uma identidade inesperada.");
  }
}

async function readProductionRoles(admin) {
  const roles = await admin.query(`
    select
      role.rolname as "roleName",
      role.rolcanlogin as "canLogin",
      role.rolinherit as "inherit",
      role.rolconnlimit as "connectionLimit",
      role.rolsuper as "superuser",
      role.rolcreatedb as "createDatabase",
      role.rolcreaterole as "createRole",
      role.rolreplication as "replication",
      role.rolbypassrls as "bypassRls",
      role.rolvaliduntil = 'infinity'::timestamptz as "validUntilIsInfinite",
      role.rolconfig is null as "settingsAreEmpty"
    from pg_catalog.pg_roles as role
    where role.rolname in ('app_dal', 'app_runtime_production')
    order by role.rolname
  `);
  return roles.rows;
}

function hasExactRestrictedAttributes(role) {
  return (
    role !== null &&
    typeof role === "object" &&
    !Array.isArray(role) &&
    role.inherit === false &&
    role.superuser === false &&
    role.createDatabase === false &&
    role.createRole === false &&
    role.replication === false &&
    role.bypassRls === false &&
    role.validUntilIsInfinite === true &&
    role.settingsAreEmpty === true
  );
}

function assertProductionRoleSet(rows, { allowAbsent }) {
  if (!Array.isArray(rows)) {
    throw new Error("As roles de produção retornaram um contrato inválido.");
  }
  if (rows.length === 0 && allowAbsent) return null;
  if (rows.map((row) => row?.roleName).join(",") !== productionRoleNames) {
    throw new Error(
      allowAbsent
        ? "As roles de produção existentes possuem estado parcial ou ambíguo."
        : "As migrations ainda não criaram as roles de produção.",
    );
  }

  const appDalRole = rows[0];
  if (
    !hasExactRestrictedAttributes(appDalRole) ||
    appDalRole.canLogin !== false ||
    appDalRole.connectionLimit !== -1
  ) {
    throw new Error("A role DAL diverge do contrato restrito NOLOGIN/NOINHERIT.");
  }

  const runtimeRole = rows[1];
  return {
    activationMode: productionRoleActivationMode(runtimeRole),
  };
}

async function readProductionRuntimeMemberships(admin) {
  const memberships = await admin.query(`
    select
      granted.rolname as "roleName",
      membership.admin_option as "adminOption",
      membership.inherit_option as "inheritOption",
      membership.set_option as "setOption"
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where member.rolname = 'app_runtime_production'
    order by granted.rolname
  `);
  return memberships.rows;
}

async function readProductionRuntimeMembers(admin) {
  const runtimeMembers = await admin.query(`
    select
      member.rolname as "roleName",
      membership.admin_option as "adminOption",
      membership.inherit_option as "inheritOption",
      membership.set_option as "setOption"
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member on member.oid = membership.member
    where granted.rolname = 'app_runtime_production'
    order by member.rolname
  `);
  return runtimeMembers.rows;
}

export function productionRoleActivationMode(role) {
  if (
    !hasExactRestrictedAttributes(role) ||
    role.roleName !== productionRole ||
    typeof role.canLogin !== "boolean" ||
    role.connectionLimit !== 10
  ) {
    throw new Error("A role de runtime diverge dos atributos restritos esperados.");
  }
  return role.canLogin === true ? "validate" : "initialize";
}

async function assertProductionMemberships(admin) {
  assertSingleExpectedMembership(await readProductionRuntimeMemberships(admin));
  assertSingleExpectedRuntimeMember(await readProductionRuntimeMembers(admin));
}

async function verifyCurrentDatabaseBoundaryBeforeMigrations(admin) {
  const boundary = await admin.query(`
    with current_head as (
      select pg_catalog.max(migration.version)::text as version
      from supabase_migrations.schema_migrations as migration
    )
    select
      current_head.version as "currentMigrationHead",
      private.managed_runtime_boundaries_are_ready() as "managedBoundariesReady",
      private.check_readiness(current_head.version) as ready
    from current_head
  `);
  const row = boundary.rows[0];
  if (
    boundary.rowCount !== 1 ||
    !migrationVersionPattern.test(row?.currentMigrationHead ?? "") ||
    row?.managedBoundariesReady !== true ||
    row?.ready !== true
  ) {
    throw new Error("A fronteira DAL implantada diverge do seu migration head atual.");
  }
}

async function verifyRuntimeReadiness(runtime) {
  const readiness = await runtime.query(
    `
      select
        current_user as "currentRole",
        session_user as "sessionRole",
        private.check_runtime_readiness($1) as ready
    `,
    [productionRole],
  );
  const row = readiness.rows[0];
  if (
    readiness.rowCount !== 1 ||
    row?.currentRole !== "app_dal" ||
    row?.sessionRole !== productionRole ||
    row?.ready !== true
  ) {
    throw new Error("A role de produção não passou no readiness restrito.");
  }
}

async function assertPristineDatabaseBeforeBootstrap(admin) {
  const registry = await admin.query(`
    select pg_catalog.to_regclass(
      'supabase_migrations.schema_migrations'
    )::text as "migrationTable"
  `);
  const migrationTable = registry.rows[0]?.migrationTable;
  if (
    registry.rowCount !== 1 ||
    (migrationTable !== null && migrationTable !== "supabase_migrations.schema_migrations")
  ) {
    throw new Error("O ledger de migrations de produção não pôde ser identificado.");
  }
  if (migrationTable !== null) {
    const history = await admin.query(`
      select
        pg_catalog.count(*)::integer as "migrationCount",
        pg_catalog.max(migration.version)::text as "currentMigrationHead"
      from supabase_migrations.schema_migrations as migration
    `);
    const row = history.rows[0];
    if (history.rowCount !== 1 || row?.migrationCount !== 0 || row?.currentMigrationHead !== null) {
      throw new Error("Roles ausentes só são permitidas antes da primeira migration de produção.");
    }
  }

  const applicationObjects = await admin.query(`
    with extension_objects as (
      select dependency.classid, dependency.objid
      from pg_catalog.pg_depend as dependency
      where dependency.deptype = 'e'
    ),
    application_objects as (
      select namespace.oid
      from pg_catalog.pg_namespace as namespace
      where namespace.nspname in ('audit', 'private')

      union all

      select relation.oid
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      left join extension_objects as extension
        on extension.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
       and extension.objid = relation.oid
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
        and extension.objid is null

      union all

      select routine.oid
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
      left join extension_objects as extension
        on extension.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
       and extension.objid = routine.oid
      where namespace.nspname = 'public'
        and extension.objid is null

      union all

      select data_type.oid
      from pg_catalog.pg_type as data_type
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = data_type.typnamespace
      left join extension_objects as extension
        on extension.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
       and extension.objid = data_type.oid
      where namespace.nspname = 'public'
        and data_type.typtype in ('d', 'e', 'm', 'r')
        and extension.objid is null
    )
    select pg_catalog.count(*)::integer as "applicationObjectCount"
    from application_objects
  `);
  if (
    applicationObjects.rowCount !== 1 ||
    applicationObjects.rows[0]?.applicationObjectCount !== 0
  ) {
    throw new Error(
      "Roles ausentes exigem banco sem schemas ou objetos de aplicação antes do bootstrap.",
    );
  }
}

function createPostgresClient(configuration) {
  return new Client(configuration);
}

export async function verifyProductionRuntimeCredentialBeforeMigrations(
  connections,
  { createClient = createPostgresClient } = {},
) {
  const admin = createClient(connections.admin);
  let runtimeIsActive = false;
  try {
    await admin.connect();
    const roleSet = assertProductionRoleSet(await readProductionRoles(admin), {
      allowAbsent: true,
    });
    if (roleSet === null) {
      await assertPristineDatabaseBeforeBootstrap(admin);
      return;
    }
    runtimeIsActive = roleSet.activationMode === "validate";
    await assertProductionMemberships(admin);
    await verifyCurrentDatabaseBoundaryBeforeMigrations(admin);
  } catch (error) {
    throw new Error("Não foi possível validar a role de produção antes das migrations.", {
      cause: error,
    });
  } finally {
    await admin.end().catch(() => undefined);
  }

  if (!runtimeIsActive) return;

  const runtime = createClient(connections.runtime);
  try {
    await runtime.connect();
    await verifyRuntimeReadiness(runtime);
  } catch (error) {
    throw new Error("A credencial runtime ativa não autenticou antes das migrations.", {
      cause: error,
    });
  } finally {
    await runtime.end().catch(() => undefined);
  }
}

async function productionRoleLoginIsDisabled(adminConnection, createClient) {
  const verifier = createClient(adminConnection);
  try {
    await verifier.connect();
    const result = await verifier.query(`
      select role.rolcanlogin as "canLogin"
      from pg_catalog.pg_roles as role
      where role.rolname = 'app_runtime_production'
    `);
    if (result.rowCount !== 1 || typeof result.rows[0]?.canLogin !== "boolean") {
      throw new Error("A role de produção não pôde ser relida após a compensação.");
    }
    return result.rows[0].canLogin === false;
  } finally {
    await verifier.end().catch(() => undefined);
  }
}

export async function forceProductionRoleDisabled({
  adminConnection,
  createClient = createPostgresClient,
  maximumAttempts = 2,
}) {
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3) {
    throw new Error("Quantidade de tentativas de compensação inválida.");
  }

  let lastError = new Error("A role de produção ainda aceita login.");
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const recovery = createClient(adminConnection);
    try {
      await recovery.connect();
      await recovery.query("begin");
      await recovery.query("set local statement_timeout = '15s'");
      await recovery.query("set local lock_timeout = '5s'");
      await recovery.query("alter role app_runtime_production nologin password null");
      await recovery.query("commit");
    } catch (error) {
      lastError = error;
      await recovery.query("rollback").catch(() => undefined);
    } finally {
      await recovery.end().catch(() => undefined);
    }

    try {
      if (await productionRoleLoginIsDisabled(adminConnection, createClient)) return;
      lastError = new Error("A role de produção permaneceu com LOGIN após a compensação.");
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error("Não foi possível comprovar a desativação da role de produção.", {
    cause: lastError,
  });
}

export async function provisionProductionRole(
  environment = process.env,
  { createClient = createPostgresClient } = {},
) {
  const connections = productionRoleConnections(environment);
  const admin = createClient(connections.admin);
  let runtime;
  let activationMayHaveCommitted = false;

  await admin.connect();
  try {
    await admin.query("begin");
    await admin.query("set local statement_timeout = '15s'");
    await admin.query("set local lock_timeout = '5s'");

    const { activationMode } = assertProductionRoleSet(await readProductionRoles(admin), {
      allowAbsent: false,
    });

    await assertProductionMemberships(admin);

    const managedBoundaries = await admin.query(
      "select private.managed_runtime_boundaries_are_ready() as ready",
    );
    if (managedBoundaries.rowCount !== 1 || managedBoundaries.rows[0]?.ready !== true) {
      throw new Error("As fronteiras gerenciadas do Supabase não estão restritas para o runtime.");
    }

    const databaseReadiness = await admin.query(
      `
        select
          private.check_readiness($1::text) as ready,
          (
            select pg_catalog.max(migration.version)::text = $1::text
            from supabase_migrations.schema_migrations as migration
          ) as "migrationHeadIsCurrent"
      `,
      [databaseMigrationHead],
    );
    if (
      databaseReadiness.rowCount !== 1 ||
      databaseReadiness.rows[0]?.ready !== true ||
      databaseReadiness.rows[0]?.migrationHeadIsCurrent !== true
    ) {
      throw new Error("A migration head de produção ou a fronteira DAL diverge do candidato.");
    }

    if (activationMode === "initialize") {
      const passwordStatement = await admin.query(
        "select pg_catalog.format('alter role app_runtime_production login password %L', $1::text) as statement",
        [connections.runtime.password],
      );
      await admin.query(passwordStatement.rows[0].statement);
      activationMayHaveCommitted = true;
    }
    await admin.query("commit");

    runtime = createClient(connections.runtime);
    await runtime.connect();
    await verifyRuntimeReadiness(runtime);
    activationMayHaveCommitted = false;
  } catch (error) {
    await admin.query("rollback").catch(() => undefined);
    if (activationMayHaveCommitted) {
      try {
        await forceProductionRoleDisabled({
          adminConnection: connections.admin,
          createClient,
        });
      } catch (recoveryError) {
        throw new Error("A inicialização falhou e a role não pôde ser desativada com segurança.", {
          cause: new AggregateError([error, recoveryError]),
        });
      }
    }
    throw error;
  } finally {
    await runtime?.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

function redactedError(error, environment) {
  let message = error instanceof Error ? error.message : "falha desconhecida";
  for (const value of [
    environment.SUPABASE_DB_PASSWORD,
    environment.PRD_DATABASE_URL_APP_DAL,
    environment.PRD_SUPABASE_PUBLISHABLE_KEY,
  ]) {
    if (typeof value === "string" && value !== "")
      message = message.replaceAll(value, "[REDACTED]");
  }
  return message;
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  try {
    if (process.argv[2] === "--preflight") {
      await verifyProductionDeploymentContract();
      process.stdout.write("Contrato fixo de produção validado.\n");
    } else {
      await provisionProductionRole();
      process.stdout.write(
        "Role restrita de produção inicializada quando necessário e validada.\n",
      );
    }
  } catch (error) {
    process.stderr.write(`production-role: ${redactedError(error, process.env)}\n`);
    process.exitCode = 1;
  }
}
