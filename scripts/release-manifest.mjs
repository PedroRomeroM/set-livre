import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { databaseMigrationHead } from "../packages/contracts/src/database-contract.ts";
import {
  collectCleanupFailures,
  deterministicReleaseTarArguments,
  ensurePhysicalArtifactsRoot,
  operationalEnvironment,
  readReleaseRuntimeEnvironmentFile,
  redactEnvironmentSecrets,
  releaseBuildEnvironment,
  releaseSmokeEnvironment,
  secretEnvironmentEntries,
  throwIfPrimaryOrCleanupFailed,
  withExclusiveReleaseLock,
} from "./release-guards.mjs";
import { runPackagedReleaseSmokeWithProcessCleanup } from "./release-process-tree.mjs";
import { runNextBuildWithCacheCleanup } from "./next-build.mjs";
import { assertLocalDockerDaemon } from "./docker-local-context.mjs";
import { executeLocalPostgresSql } from "./local-postgres-command.mjs";
import { removePhysicalTree } from "./physical-tree-removal.mjs";
import { executeSupabaseLocalCommand } from "./supabase-command-executor.mjs";
import { resolveTrustedNpmCliLaunch } from "./trusted-npm-cli.mjs";

const root = resolve(import.meta.dirname, "..");
const artifactsRoot = resolve(root, ".artifacts");
const releaseRoot = resolve(artifactsRoot, "release");
const manifestPath = resolve(releaseRoot, "manifest.json");
const migrationsSource = resolve(root, "supabase/migrations");
const supabaseConfigSource = resolve(root, "supabase/config.toml");
const supabaseRolesSource = resolve(root, "supabase/roles.sql");
const { head: expectedMigrationHead, previousHead: expectedPreviousMigrationHead } =
  canonicalReleaseMigrationTransition();
const expectedNodeVersion = "v24.18.0";
const expectedNpmVersion = "11.19.0";
const expectedPublicAppUrl = "https://setlivre.com";
const expectedBackofficeAppUrl = "https://ops.setlivre.com";
const publicBuildConfigKeys = [
  "backofficeAppUrl",
  "publicAppUrl",
  "supabaseAnonKey",
  "supabaseUrl",
];
const migrationAuthorizationCatalogVersion = 1;
const migrationAuthorizationContractVersion = 1;
const authorizationCatalogRelativePath = "supabase/authorization-catalog.sql";
const authorizationContractRelativePath = "supabase/authorization-contract.json";
const baselineAuthorizationContractRelativePath = "supabase/baseline-authorization-contract.json";
const authorizationHeadRelativePath = "supabase/authorization-head.json";
const maximumAuthorizationFacts = 100_000;
const maximumAuthorizationIdentityParts = 4;
const maximumAuthorizationStringLength = 65_536;
const forbiddenRuntimeGrantees = new Set([
  "PUBLIC",
  "anon",
  "authenticated",
  "service_role",
  "app_dal",
  "app_runtime",
  "app_runtime_local",
  "app_runtime_prod",
]);
const explicitMigrationAuthorizationApprovals = new Map([
  [`${expectedPreviousMigrationHead}:${expectedMigrationHead}`, Object.freeze([])],
]);
const applications = [
  {
    application: "web",
    buildIdDestination: ".next/BUILD_ID",
    buildIdSource: resolve(root, ".next/BUILD_ID"),
    entrypoint: "server.js",
    expectedApplicationUrl: "http://127.0.0.1:3000",
    packageRoot: resolve(releaseRoot, "web"),
    projectRoot: root,
    publicDestination: "public",
    publicSource: resolve(root, "public"),
    runtimeEnvironmentSource: resolve(root, ".env.local"),
    standaloneSource: resolve(root, ".next/standalone"),
    staticDestination: ".next/static",
    staticSource: resolve(root, ".next/static"),
  },
  {
    application: "backoffice",
    buildIdDestination: "apps/backoffice/.next/BUILD_ID",
    buildIdSource: resolve(root, "apps/backoffice/.next/BUILD_ID"),
    entrypoint: "apps/backoffice/server.js",
    expectedApplicationUrl: "http://127.0.0.1:3001",
    packageRoot: resolve(releaseRoot, "backoffice"),
    projectRoot: resolve(root, "apps/backoffice"),
    publicDestination: "apps/backoffice/public",
    publicSource: resolve(root, "apps/backoffice/public"),
    runtimeEnvironmentSource: resolve(root, "apps/backoffice/.env.local"),
    standaloneSource: resolve(root, "apps/backoffice/.next/standalone"),
    staticDestination: "apps/backoffice/.next/static",
    staticSource: resolve(root, "apps/backoffice/.next/static"),
  },
];

export function assertCanonicalReleaseRuntime({
  arch = process.arch,
  platform = process.platform,
  nodeVersion = process.version,
} = {}) {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error("A release canônica exige Linux x64 nativo.");
  }
  if (nodeVersion !== expectedNodeVersion) {
    throw new Error(`A release canônica exige Node ${expectedNodeVersion}.`);
  }
}

export const authorizationCatalogSql = String.raw`
with authorization_facts as (
  select pg_catalog.jsonb_build_object(
    'kind', 'relation',
    'objectType', case relation.relkind
      when 'r' then 'table'
      when 'p' then 'partitionedTable'
      when 'v' then 'view'
      when 'm' then 'materializedView'
      when 'S' then 'sequence'
      when 'f' then 'foreignTable'
      else 'relation'
    end,
    'object', pg_catalog.jsonb_build_array(namespace.nspname, relation.relname)
  ) as fact
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where relation.relkind = any (array['r', 'p', 'v', 'm', 'S', 'f']::"char"[])
    and namespace.nspname = any (array['public', 'private', 'audit'])

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'relationSecurity',
    'objectType', case relation.relkind
      when 'r' then 'table'
      when 'p' then 'partitionedTable'
      when 'v' then 'view'
      when 'm' then 'materializedView'
      when 'S' then 'sequence'
      when 'f' then 'foreignTable'
      else 'relation'
    end,
    'object', pg_catalog.jsonb_build_array(namespace.nspname, relation.relname),
    'rowSecurity', relation.relrowsecurity,
    'forceRowSecurity', relation.relforcerowsecurity
  ) as fact
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where relation.relkind = any (array['r', 'p', 'v', 'm', 'S', 'f']::"char"[])
    and namespace.nspname = any (array['public', 'private', 'audit'])

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'policy',
    'objectType', 'table',
    'object', pg_catalog.jsonb_build_array(namespace.nspname, relation.relname),
    'name', policy.polname,
    'command', case policy.polcmd
      when 'r' then 'SELECT'
      when 'a' then 'INSERT'
      when 'w' then 'UPDATE'
      when 'd' then 'DELETE'
      when '*' then 'ALL'
      else 'UNKNOWN'
    end,
    'permissive', policy.polpermissive,
    'roles', (
      select coalesce(
        pg_catalog.jsonb_agg(
          case
            when role_oid = 0 then 'PUBLIC'
            when role.rolname in ('app_runtime_local', 'app_runtime_prod') then 'app_runtime'
            else role.rolname
          end
          order by case
            when role_oid = 0 then 'PUBLIC'
            when role.rolname in ('app_runtime_local', 'app_runtime_prod') then 'app_runtime'
            else role.rolname
          end
        ),
        '[]'::pg_catalog.jsonb
      )
      from pg_catalog.unnest(policy.polroles) as role_oid
      left join pg_catalog.pg_roles as role on role.oid = role_oid
    ),
    'using', pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
    'withCheck', pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
  ) as fact
  from pg_catalog.pg_policy as policy
  join pg_catalog.pg_class as relation on relation.oid = policy.polrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = any (array['public', 'private', 'audit'])

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'database',
    'object', pg_catalog.jsonb_build_array(database.datname),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_database as database
  cross join lateral pg_catalog.aclexplode(
    coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
  ) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where database.datname = pg_catalog.current_database()
    and privilege.grantee <> database.datdba

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'schema',
    'object', pg_catalog.jsonb_build_array(namespace.nspname),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_namespace as namespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
  ) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where privilege.grantee <> namespace.nspowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', case relation.relkind
      when 'S' then 'sequence'
      when 'v' then 'view'
      when 'm' then 'materializedView'
      when 'f' then 'foreignTable'
      else 'table'
    end,
    'object', pg_catalog.jsonb_build_array(namespace.nspname, relation.relname),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_class as relation
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      relation.relacl,
      pg_catalog.acldefault(
        case when relation.relkind = 'S' then 's' else 'r' end::"char",
        relation.relowner
      )
    )
  ) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where relation.relkind = any (array['r', 'p', 'v', 'm', 'S', 'f']::"char"[])
    and privilege.grantee <> relation.relowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'column',
    'object', pg_catalog.jsonb_build_array(
      namespace.nspname,
      relation.relname,
      attribute.attname
    ),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_attribute as attribute
  join pg_catalog.pg_class as relation on relation.oid = attribute.attrelid
  join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
  cross join lateral pg_catalog.aclexplode(attribute.attacl) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where attribute.attnum > 0
    and not attribute.attisdropped
    and attribute.attacl is not null
    and privilege.grantee <> relation.relowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'routine',
    'object', pg_catalog.jsonb_build_array(
      namespace.nspname,
      routine.proname,
      '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')'
    ),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_proc as routine
  join pg_catalog.pg_namespace as namespace on namespace.oid = routine.pronamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
  ) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where privilege.grantee <> routine.proowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'type',
    'object', pg_catalog.jsonb_build_array(namespace.nspname, type.typname),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_type as type
  join pg_catalog.pg_namespace as namespace on namespace.oid = type.typnamespace
  cross join lateral pg_catalog.aclexplode(type.typacl) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where type.typacl is not null
    and privilege.grantee <> type.typowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'language',
    'object', pg_catalog.jsonb_build_array(language.lanname),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_language as language
  cross join lateral pg_catalog.aclexplode(
    coalesce(language.lanacl, pg_catalog.acldefault('l', language.lanowner))
  ) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where privilege.grantee <> language.lanowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'foreignDataWrapper',
    'object', pg_catalog.jsonb_build_array(wrapper.fdwname),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_foreign_data_wrapper as wrapper
  cross join lateral pg_catalog.aclexplode(wrapper.fdwacl) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where wrapper.fdwacl is not null
    and privilege.grantee <> wrapper.fdwowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'foreignServer',
    'object', pg_catalog.jsonb_build_array(server.srvname),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_foreign_server as server
  cross join lateral pg_catalog.aclexplode(server.srvacl) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where server.srvacl is not null
    and privilege.grantee <> server.srvowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'largeObject',
    'object', pg_catalog.jsonb_build_array(metadata.oid::pg_catalog.text),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_largeobject_metadata as metadata
  cross join lateral pg_catalog.aclexplode(metadata.lomacl) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where metadata.lomacl is not null
    and privilege.grantee <> metadata.lomowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'tablespace',
    'object', pg_catalog.jsonb_build_array(tablespace.spcname),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_tablespace as tablespace
  cross join lateral pg_catalog.aclexplode(tablespace.spcacl) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where tablespace.spcacl is not null
    and privilege.grantee <> tablespace.spcowner

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'defaultPrivilege',
    'object', pg_catalog.jsonb_build_array(
      owner.rolname,
      coalesce(namespace.nspname, ''),
      defaults.defaclobjtype::pg_catalog.text
    ),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_default_acl as defaults
  join pg_catalog.pg_roles as owner on owner.oid = defaults.defaclrole
  left join pg_catalog.pg_namespace as namespace on namespace.oid = defaults.defaclnamespace
  cross join lateral pg_catalog.aclexplode(defaults.defaclacl) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
  where privilege.grantee <> defaults.defaclrole

  union all

  select pg_catalog.jsonb_build_object(
    'kind', 'privilege',
    'objectType', 'parameter',
    'object', pg_catalog.jsonb_build_array(parameter.parname),
    'grantor', grantor.rolname,
    'grantee', case when privilege.grantee = 0 then 'PUBLIC' else grantee.rolname end,
    'privilege', privilege.privilege_type,
    'grantable', privilege.is_grantable
  ) as fact
  from pg_catalog.pg_parameter_acl as parameter
  cross join lateral pg_catalog.aclexplode(parameter.paracl) as privilege
  join pg_catalog.pg_roles as grantor on grantor.oid = privilege.grantor
  left join pg_catalog.pg_roles as grantee on grantee.oid = privilege.grantee
),
scoped_authorization_facts as (
  select case
    when fact->>'kind' = 'privilege' then
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          case
            when fact->>'objectType' = 'database' then
              pg_catalog.jsonb_set(
                fact,
                '{object}',
                pg_catalog.jsonb_build_array('$currentDatabase')
              )
            else fact
          end,
          '{grantor}',
          pg_catalog.to_jsonb(
            case
              when fact->>'grantor' in ('app_runtime_local', 'app_runtime_prod')
                then 'app_runtime'
              else fact->>'grantor'
            end
          )
        ),
        '{grantee}',
        pg_catalog.to_jsonb(
          case
            when fact->>'grantee' in ('app_runtime_local', 'app_runtime_prod')
              then 'app_runtime'
            else fact->>'grantee'
          end
        )
      )
    else fact
  end as fact
  from authorization_facts
  where fact->>'kind' in ('relation', 'relationSecurity', 'policy')
    or (
      fact->>'kind' = 'privilege'
      and fact->>'grantee' = any (
        array[
          'PUBLIC',
          'anon',
          'authenticated',
          'service_role',
          'app_dal',
          'app_runtime_local',
          'app_runtime_prod'
        ]
      )
      and (
        (
          fact->>'objectType' = any (
            array[
              'table',
              'partitionedTable',
              'foreignTable',
              'view',
              'materializedView',
              'sequence',
              'column',
              'routine',
              'type'
            ]
          )
          and fact->'object'->>0 = any (array['public', 'private', 'audit'])
        )
        or (
          fact->>'grantee' = any (
            array['app_dal', 'app_runtime_local', 'app_runtime_prod']
          )
          and (
            fact->>'objectType' = 'database'
            or (
              fact->>'objectType' = 'schema'
              and fact->'object'->>0 = any (array['public', 'private', 'audit'])
            )
            or (
              fact->>'objectType' = 'defaultPrivilege'
              and fact->'object'->>1 = any (array['public', 'private', 'audit'])
            )
            or fact->>'objectType' = any (
              array[
                'language',
                'foreignDataWrapper',
                'foreignServer',
                'largeObject',
                'tablespace',
                'parameter'
              ]
            )
          )
        )
      )
    )
)
select fact
from scoped_authorization_facts
order by fact::pg_catalog.text
`;
export const authorizationCatalogSha256 = createHash("sha256")
  .update(authorizationCatalogSql, "utf8")
  .digest("hex");

function hasExactKeys(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalAuthorizationString(value, description) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\0") ||
    value.length > maximumAuthorizationStringLength
  ) {
    throw new Error(`${description} é inválida.`);
  }
  return value;
}

function canonicalAuthorizationObject(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximumAuthorizationIdentityParts
  ) {
    throw new Error("A identidade do objeto de autorização é inválida.");
  }
  return value.map((part) => canonicalAuthorizationString(part, "Parte da identidade"));
}

const authorizationObjectTypes = new Set([
  "column",
  "database",
  "defaultPrivilege",
  "foreignDataWrapper",
  "foreignServer",
  "foreignTable",
  "language",
  "largeObject",
  "materializedView",
  "parameter",
  "partitionedTable",
  "routine",
  "schema",
  "sequence",
  "table",
  "tablespace",
  "type",
  "view",
]);
const authorizationPrivileges = new Set([
  "ALTER SYSTEM",
  "CONNECT",
  "CREATE",
  "DELETE",
  "EXECUTE",
  "INSERT",
  "MAINTAIN",
  "REFERENCES",
  "SELECT",
  "SET",
  "TEMPORARY",
  "TRIGGER",
  "TRUNCATE",
  "UPDATE",
  "USAGE",
]);
const policyCommands = new Set(["ALL", "DELETE", "INSERT", "SELECT", "UPDATE"]);

export function canonicalAuthorizationFact(fact) {
  if (fact?.kind === "relation") {
    if (!hasExactKeys(fact, ["kind", "objectType", "object"])) {
      throw new Error("O fato de relação possui campos inválidos.");
    }
    if (!authorizationObjectTypes.has(fact.objectType)) {
      throw new Error("O tipo da relação é inválido.");
    }
    return {
      kind: "relation",
      objectType: fact.objectType,
      object: canonicalAuthorizationObject(fact.object),
    };
  }
  if (fact?.kind === "relationSecurity") {
    if (
      !hasExactKeys(fact, ["kind", "objectType", "object", "rowSecurity", "forceRowSecurity"]) ||
      !authorizationObjectTypes.has(fact.objectType) ||
      typeof fact.rowSecurity !== "boolean" ||
      typeof fact.forceRowSecurity !== "boolean"
    ) {
      throw new Error("O fato de segurança da relação é inválido.");
    }
    return {
      kind: "relationSecurity",
      objectType: fact.objectType,
      object: canonicalAuthorizationObject(fact.object),
      rowSecurity: fact.rowSecurity,
      forceRowSecurity: fact.forceRowSecurity,
    };
  }
  if (fact?.kind === "policy") {
    if (
      !hasExactKeys(fact, [
        "kind",
        "objectType",
        "object",
        "name",
        "command",
        "permissive",
        "roles",
        "using",
        "withCheck",
      ]) ||
      fact.objectType !== "table" ||
      !policyCommands.has(fact.command) ||
      typeof fact.permissive !== "boolean" ||
      !Array.isArray(fact.roles) ||
      fact.roles.length === 0 ||
      fact.roles.length > 1_000 ||
      !(fact.using === null || typeof fact.using === "string") ||
      !(fact.withCheck === null || typeof fact.withCheck === "string")
    ) {
      throw new Error("O fato de policy é inválido.");
    }
    const roles = fact.roles.map((role) => canonicalAuthorizationString(role, "Role da policy"));
    const sortedRoles = [...roles].sort();
    if (
      new Set(roles).size !== roles.length ||
      JSON.stringify(roles) !== JSON.stringify(sortedRoles)
    ) {
      throw new Error("As roles da policy não estão em ordem canônica.");
    }
    return {
      kind: "policy",
      objectType: "table",
      object: canonicalAuthorizationObject(fact.object),
      name: canonicalAuthorizationString(fact.name, "Nome da policy"),
      command: fact.command,
      permissive: fact.permissive,
      roles,
      using:
        fact.using === null
          ? null
          : canonicalAuthorizationString(fact.using, "Expressão USING da policy"),
      withCheck:
        fact.withCheck === null
          ? null
          : canonicalAuthorizationString(fact.withCheck, "Expressão WITH CHECK da policy"),
    };
  }
  if (fact?.kind === "privilege") {
    if (
      !hasExactKeys(fact, [
        "kind",
        "objectType",
        "object",
        "grantor",
        "grantee",
        "privilege",
        "grantable",
      ]) ||
      !authorizationObjectTypes.has(fact.objectType) ||
      !authorizationPrivileges.has(fact.privilege) ||
      typeof fact.grantable !== "boolean"
    ) {
      throw new Error("O fato de privilégio é inválido.");
    }
    return {
      kind: "privilege",
      objectType: fact.objectType,
      object: canonicalAuthorizationObject(fact.object),
      grantor: canonicalAuthorizationString(fact.grantor, "Grantor"),
      grantee: canonicalAuthorizationString(fact.grantee, "Grantee"),
      privilege: fact.privilege,
      grantable: fact.grantable,
    };
  }
  throw new Error("O catálogo contém um tipo de fato de autorização desconhecido.");
}

export function canonicalAuthorizationFacts(facts) {
  if (!Array.isArray(facts) || facts.length > maximumAuthorizationFacts) {
    throw new Error("O snapshot de autorização excede o contrato canônico.");
  }
  const canonical = facts.map(canonicalAuthorizationFact);
  canonical.sort((left, right) => {
    const leftSerialized = JSON.stringify(left);
    const rightSerialized = JSON.stringify(right);
    return leftSerialized < rightSerialized ? -1 : leftSerialized > rightSerialized ? 1 : 0;
  });
  const serialized = canonical.map((fact) => JSON.stringify(fact));
  if (new Set(serialized).size !== serialized.length) {
    throw new Error("O snapshot de autorização contém fatos duplicados.");
  }
  return canonical;
}

function isAuthorizationAddition(fact) {
  return fact.kind === "policy" || fact.kind === "privilege";
}

function assertNoUnconditionallyForbiddenAuthorization(fact) {
  if (fact.kind === "policy") {
    const publicRole = fact.roles.includes("PUBLIC") || fact.roles.includes("anon");
    if (publicRole && ["ALL", "DELETE", "INSERT", "UPDATE"].includes(fact.command)) {
      throw new Error("Policies públicas de escrita são proibidas pelo contrato de deploy.");
    }
    if (publicRole && fact.command === "DELETE" && fact.using === "true") {
      throw new Error("Policy DELETE pública irrestrita é proibida.");
    }
    return;
  }
  if (fact.kind !== "privilege") return;
  const runtimeGrantee = forbiddenRuntimeGrantees.has(fact.grantee);
  if (runtimeGrantee && fact.grantable) {
    throw new Error("Grant option para role de runtime é proibido.");
  }
  if (
    runtimeGrantee &&
    ["table", "partitionedTable", "foreignTable", "view", "materializedView", "column"].includes(
      fact.objectType,
    ) &&
    ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "TRIGGER", "TRUNCATE", "UPDATE"].includes(
      fact.privilege,
    ) &&
    (fact.grantee === "PUBLIC" || fact.grantee === "anon")
  ) {
    throw new Error("Privilégio público de escrita em relação é proibido.");
  }
  if (
    runtimeGrantee &&
    fact.objectType === "largeObject" &&
    fact.privilege === "UPDATE" &&
    (fact.grantee === "PUBLIC" || fact.grantee === "anon")
  ) {
    throw new Error("Privilégio público de escrita em large object é proibido.");
  }
  if (
    runtimeGrantee &&
    ["schema", "tablespace"].includes(fact.objectType) &&
    fact.privilege === "CREATE"
  ) {
    throw new Error("CREATE estrutural para role de runtime é proibido.");
  }
  if (
    runtimeGrantee &&
    fact.objectType === "database" &&
    ["CREATE", "TEMPORARY"].includes(fact.privilege)
  ) {
    throw new Error("Privilégio de criação em database para role de runtime é proibido.");
  }
}

function canonicalAuthorizationDelta(beforeFacts, afterFacts) {
  const before = canonicalAuthorizationFacts(beforeFacts);
  const after = canonicalAuthorizationFacts(afterFacts);
  const beforeSerialized = new Set(before.map((fact) => JSON.stringify(fact)));
  const afterSerialized = new Set(after.map((fact) => JSON.stringify(fact)));
  const additions = after.filter((fact) => !beforeSerialized.has(JSON.stringify(fact)));
  const removals = before.filter((fact) => !afterSerialized.has(JSON.stringify(fact)));

  const afterRelations = new Set(
    after
      .filter((fact) => fact.kind === "relation")
      .map((fact) => JSON.stringify([fact.objectType, fact.object])),
  );
  for (const removed of removals) {
    if (
      removed.kind === "relationSecurity" &&
      (removed.rowSecurity || removed.forceRowSecurity) &&
      afterRelations.has(JSON.stringify([removed.objectType, removed.object]))
    ) {
      throw new Error("O delta desabilita RLS em uma relação preservada.");
    }
  }
  for (const addition of additions) {
    assertNoUnconditionallyForbiddenAuthorization(addition);
  }
  return { additions, removals };
}

function migrationAuthorizationPayload(contract) {
  return {
    contractVersion: migrationAuthorizationContractVersion,
    catalogVersion: migrationAuthorizationCatalogVersion,
    catalogPath: authorizationCatalogRelativePath,
    catalogSha256: authorizationCatalogSha256,
    releaseCommit: contract.releaseCommit,
    previousHead: contract.previousHead,
    head: contract.head,
    additions: contract.additions,
    removals: contract.removals,
    approvedAdditions: contract.approvedAdditions,
  };
}

export function buildMigrationAuthorizationContract({
  releaseCommit,
  previousHead,
  head,
  beforeFacts,
  afterFacts,
  approvedAdditions,
}) {
  if (
    !/^[a-f0-9]{40}$/u.test(releaseCommit ?? "") ||
    !/^\d{14}$/u.test(previousHead ?? "") ||
    !/^\d{14}$/u.test(head ?? "") ||
    previousHead >= head
  ) {
    throw new Error("A transição de autorização entre migrations é inválida.");
  }
  const { additions, removals } = canonicalAuthorizationDelta(beforeFacts, afterFacts);
  const approvals = canonicalAuthorizationFacts(approvedAdditions);
  const requiredApprovals = additions.filter(isAuthorizationAddition);
  if (JSON.stringify(approvals) !== JSON.stringify(requiredApprovals)) {
    throw new Error("Toda ampliação de autorização precisa de aprovação semântica exata.");
  }
  const payload = migrationAuthorizationPayload({
    releaseCommit,
    previousHead,
    head,
    additions,
    removals,
    approvedAdditions: approvals,
  });
  return { ...payload, sha256: sha256Buffer(Buffer.from(JSON.stringify(payload), "utf8")) };
}

export function buildBaselineAuthorizationContract({ releaseCommit, head, afterFacts }) {
  if (!/^[a-f0-9]{40}$/u.test(releaseCommit ?? "") || !/^\d{14}$/u.test(head ?? "")) {
    throw new Error("A identidade do contrato baseline de autorização é inválida.");
  }
  const { additions, removals } = canonicalAuthorizationDelta([], afterFacts);
  if (removals.length !== 0) {
    throw new Error("O contrato baseline de autorização não pode conter remoções.");
  }
  const approvedAdditions = additions.filter(isAuthorizationAddition);
  const payload = migrationAuthorizationPayload({
    releaseCommit,
    previousHead: "none",
    head,
    additions,
    removals,
    approvedAdditions,
  });
  return { ...payload, sha256: sha256Buffer(Buffer.from(JSON.stringify(payload), "utf8")) };
}

export function assertCanonicalMigrationAuthorizationContract(contract) {
  if (
    !hasExactKeys(contract, [
      "contractVersion",
      "catalogVersion",
      "catalogPath",
      "catalogSha256",
      "releaseCommit",
      "previousHead",
      "head",
      "additions",
      "removals",
      "approvedAdditions",
      "sha256",
    ]) ||
    contract.contractVersion !== migrationAuthorizationContractVersion ||
    contract.catalogVersion !== migrationAuthorizationCatalogVersion ||
    contract.catalogPath !== authorizationCatalogRelativePath ||
    contract.catalogSha256 !== authorizationCatalogSha256 ||
    !/^[a-f0-9]{40}$/u.test(contract.releaseCommit ?? "") ||
    !/^\d{14}$/u.test(contract.previousHead ?? "") ||
    !/^\d{14}$/u.test(contract.head ?? "") ||
    contract.previousHead >= contract.head ||
    !/^[a-f0-9]{64}$/u.test(contract.sha256 ?? "")
  ) {
    throw new Error("O contrato semântico de autorização é inválido.");
  }
  const additions = canonicalAuthorizationFacts(contract.additions);
  const removals = canonicalAuthorizationFacts(contract.removals);
  const approvedAdditions = canonicalAuthorizationFacts(contract.approvedAdditions);
  if (
    JSON.stringify(additions) !== JSON.stringify(contract.additions) ||
    JSON.stringify(removals) !== JSON.stringify(contract.removals) ||
    JSON.stringify(approvedAdditions) !== JSON.stringify(contract.approvedAdditions)
  ) {
    throw new Error("O delta semântico de autorização não está em forma canônica.");
  }
  for (const addition of additions) {
    assertNoUnconditionallyForbiddenAuthorization(addition);
  }
  if (
    JSON.stringify(approvedAdditions) !== JSON.stringify(additions.filter(isAuthorizationAddition))
  ) {
    throw new Error("As aprovações do delta semântico são incompletas ou excedentes.");
  }
  const payload = migrationAuthorizationPayload({
    ...contract,
    additions,
    removals,
    approvedAdditions,
  });
  if (sha256Buffer(Buffer.from(JSON.stringify(payload), "utf8")) !== contract.sha256) {
    throw new Error("O hash do contrato semântico de autorização diverge.");
  }
  return contract;
}

export function assertCanonicalBaselineAuthorizationContract(contract) {
  if (
    !hasExactKeys(contract, [
      "contractVersion",
      "catalogVersion",
      "catalogPath",
      "catalogSha256",
      "releaseCommit",
      "previousHead",
      "head",
      "additions",
      "removals",
      "approvedAdditions",
      "sha256",
    ]) ||
    contract.contractVersion !== migrationAuthorizationContractVersion ||
    contract.catalogVersion !== migrationAuthorizationCatalogVersion ||
    contract.catalogPath !== authorizationCatalogRelativePath ||
    contract.catalogSha256 !== authorizationCatalogSha256 ||
    !/^[a-f0-9]{40}$/u.test(contract.releaseCommit ?? "") ||
    contract.previousHead !== "none" ||
    !/^\d{14}$/u.test(contract.head ?? "") ||
    !/^[a-f0-9]{64}$/u.test(contract.sha256 ?? "")
  ) {
    throw new Error("O contrato baseline semântico de autorização é inválido.");
  }
  const additions = canonicalAuthorizationFacts(contract.additions);
  const removals = canonicalAuthorizationFacts(contract.removals);
  const approvedAdditions = canonicalAuthorizationFacts(contract.approvedAdditions);
  if (
    JSON.stringify(additions) !== JSON.stringify(contract.additions) ||
    JSON.stringify(removals) !== JSON.stringify(contract.removals) ||
    JSON.stringify(approvedAdditions) !== JSON.stringify(contract.approvedAdditions)
  ) {
    throw new Error("O contrato baseline de autorização não está em forma canônica.");
  }
  if (removals.length !== 0) {
    throw new Error("O contrato baseline de autorização não pode conter remoções.");
  }
  for (const addition of additions) {
    assertNoUnconditionallyForbiddenAuthorization(addition);
  }
  if (
    JSON.stringify(approvedAdditions) !== JSON.stringify(additions.filter(isAuthorizationAddition))
  ) {
    throw new Error("As aprovações do contrato baseline são incompletas ou excedentes.");
  }
  const payload = migrationAuthorizationPayload({
    ...contract,
    additions,
    removals,
    approvedAdditions,
  });
  if (sha256Buffer(Buffer.from(JSON.stringify(payload), "utf8")) !== contract.sha256) {
    throw new Error("O hash do contrato baseline de autorização diverge.");
  }
  return contract;
}

function authorizationHeadPayload(contract) {
  return {
    releaseCommit: contract.releaseCommit,
    head: contract.head,
    catalogPath: authorizationCatalogRelativePath,
    catalogSha256: authorizationCatalogSha256,
    facts: contract.facts,
  };
}

export function buildAuthorizationHeadContract({ releaseCommit, head, facts }) {
  if (!/^[a-f0-9]{40}$/u.test(releaseCommit ?? "") || !/^\d{14}$/u.test(head ?? "")) {
    throw new Error("A identidade do snapshot de autorização do head é inválida.");
  }
  const canonicalFacts = canonicalAuthorizationFacts(facts);
  for (const fact of canonicalFacts) {
    assertNoUnconditionallyForbiddenAuthorization(fact);
  }
  const payload = authorizationHeadPayload({ releaseCommit, head, facts: canonicalFacts });
  return { ...payload, sha256: sha256Buffer(Buffer.from(JSON.stringify(payload), "utf8")) };
}

export function assertCanonicalAuthorizationHeadContract(contract) {
  if (
    !hasExactKeys(contract, [
      "releaseCommit",
      "head",
      "catalogPath",
      "catalogSha256",
      "facts",
      "sha256",
    ]) ||
    !/^[a-f0-9]{40}$/u.test(contract.releaseCommit ?? "") ||
    !/^\d{14}$/u.test(contract.head ?? "") ||
    contract.catalogPath !== authorizationCatalogRelativePath ||
    contract.catalogSha256 !== authorizationCatalogSha256 ||
    !/^[a-f0-9]{64}$/u.test(contract.sha256 ?? "")
  ) {
    throw new Error("O snapshot canônico de autorização do head é inválido.");
  }
  const facts = canonicalAuthorizationFacts(contract.facts);
  if (JSON.stringify(facts) !== JSON.stringify(contract.facts)) {
    throw new Error("Os fatos do snapshot de autorização do head não estão em forma canônica.");
  }
  for (const fact of facts) {
    assertNoUnconditionallyForbiddenAuthorization(fact);
  }
  const payload = authorizationHeadPayload({ ...contract, facts });
  if (sha256Buffer(Buffer.from(JSON.stringify(payload), "utf8")) !== contract.sha256) {
    throw new Error("O hash do snapshot de autorização do head diverge.");
  }
  return contract;
}

export function buildReleaseAuthorizationContracts({
  releaseCommit,
  previousHead,
  head,
  beforeFacts,
  afterFacts,
  approvedAdditions,
}) {
  const authorizationHead = buildAuthorizationHeadContract({
    releaseCommit,
    head,
    facts: afterFacts,
  });
  const baselineAuthorization = buildBaselineAuthorizationContract({
    releaseCommit,
    head,
    afterFacts: authorizationHead.facts,
  });
  const migrationAuthorization = buildMigrationAuthorizationContract({
    releaseCommit,
    previousHead,
    head,
    beforeFacts,
    afterFacts: authorizationHead.facts,
    approvedAdditions,
  });
  if (JSON.stringify(baselineAuthorization.additions) !== JSON.stringify(authorizationHead.facts)) {
    throw new Error("O contrato baseline diverge do snapshot canônico do head.");
  }
  return Object.freeze({ migrationAuthorization, baselineAuthorization, authorizationHead });
}

export function canonicalSupabaseProjectRef(supabaseUrl) {
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/u.exec(supabaseUrl ?? "");
  if (match === null) {
    throw new Error("A URL pública do Supabase não possui identidade canônica.");
  }
  return match[1];
}

function productionSupabaseIdentity(environment) {
  const projectRef = environment.PRD_SUPABASE_PROJECT_REF;
  const supabaseUrl = environment.PRD_SUPABASE_URL;
  if (
    !/^[a-z0-9]{20}$/u.test(projectRef ?? "") ||
    supabaseUrl !== `https://${projectRef}.supabase.co` ||
    canonicalSupabaseProjectRef(supabaseUrl) !== projectRef
  ) {
    throw new Error("A identidade Supabase de produção é inválida ou ausente.");
  }
  return Object.freeze({ projectRef, supabaseUrl });
}

function canonicalPublicBuildConfig(configuration) {
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error("A configuração pública do build precisa ser um objeto canônico.");
  }
  const keys = Object.keys(configuration).sort();
  if (JSON.stringify(keys) !== JSON.stringify(publicBuildConfigKeys)) {
    throw new Error("A configuração pública do build possui campos ausentes ou inesperados.");
  }

  const canonical = {
    backofficeAppUrl: configuration.backofficeAppUrl,
    publicAppUrl: configuration.publicAppUrl,
    supabaseAnonKey: configuration.supabaseAnonKey,
    supabaseUrl: configuration.supabaseUrl,
  };
  canonicalSupabaseProjectRef(canonical.supabaseUrl);
  if (
    canonical.backofficeAppUrl !== expectedBackofficeAppUrl ||
    canonical.publicAppUrl !== expectedPublicAppUrl ||
    !/^sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/u.test(canonical.supabaseAnonKey ?? "")
  ) {
    throw new Error("A configuração pública canônica do build é inválida.");
  }
  return canonical;
}

export function publicBuildConfigSha256(configuration) {
  const canonicalJson = JSON.stringify(canonicalPublicBuildConfig(configuration));
  return sha256Buffer(Buffer.from(canonicalJson, "utf8"));
}

function assertReleaseMigrationAuthorization(contract, releaseCommit) {
  assertCanonicalMigrationAuthorizationContract(contract);
  if (
    contract.releaseCommit !== releaseCommit ||
    contract.previousHead !== expectedPreviousMigrationHead ||
    contract.head !== expectedMigrationHead
  ) {
    throw new Error("O contrato semântico não corresponde ao head canônico da release.");
  }
  const expectedApprovals = explicitMigrationAuthorizationApprovals.get(
    `${contract.previousHead}:${contract.head}`,
  );
  if (
    expectedApprovals === undefined ||
    JSON.stringify(contract.approvedAdditions) !== JSON.stringify(expectedApprovals)
  ) {
    throw new Error("As aprovações semânticas não correspondem à decisão versionada.");
  }
  return contract;
}

function assertReleaseBaselineAuthorization(contract, releaseCommit) {
  assertCanonicalBaselineAuthorizationContract(contract);
  if (contract.releaseCommit !== releaseCommit || contract.head !== expectedMigrationHead) {
    throw new Error("O contrato baseline não corresponde ao head canônico da release.");
  }
  return contract;
}

function assertReleaseAuthorizationHead(contract, releaseCommit) {
  assertCanonicalAuthorizationHeadContract(contract);
  if (contract.releaseCommit !== releaseCommit || contract.head !== expectedMigrationHead) {
    throw new Error("O snapshot de autorização não corresponde ao head canônico da release.");
  }
  return contract;
}

export function assertCanonicalReleaseAuthorizationContracts(contracts, releaseCommit) {
  if (
    !hasExactKeys(contracts, [
      "migrationAuthorization",
      "baselineAuthorization",
      "authorizationHead",
    ]) ||
    !/^[a-f0-9]{40}$/u.test(releaseCommit ?? "")
  ) {
    throw new Error("O conjunto de contratos de autorização da release é inválido.");
  }
  assertReleaseMigrationAuthorization(contracts.migrationAuthorization, releaseCommit);
  assertReleaseBaselineAuthorization(contracts.baselineAuthorization, releaseCommit);
  assertReleaseAuthorizationHead(contracts.authorizationHead, releaseCommit);
  if (
    JSON.stringify(contracts.baselineAuthorization.additions) !==
    JSON.stringify(contracts.authorizationHead.facts)
  ) {
    throw new Error("O contrato baseline diverge do snapshot canônico do head.");
  }
  return contracts;
}

export function canonicalReleaseManifest(commit, lockSha256, buildConfigSha256) {
  if (
    !/^[a-f0-9]{40}$/u.test(commit) ||
    !/^[a-f0-9]{64}$/u.test(lockSha256) ||
    !/^[a-f0-9]{64}$/u.test(buildConfigSha256)
  ) {
    throw new Error("Identidade inválida para o manifesto canônico da release.");
  }
  return {
    schemaVersion: 4,
    commit,
    publicBuildConfigSha256: buildConfigSha256,
    runtime: { arch: "x64", platform: "linux", node: expectedNodeVersion },
    applications: {
      web: { entrypoint: "web/server.js", port: 3000 },
      backoffice: { entrypoint: "backoffice/apps/backoffice/server.js", port: 3001 },
    },
    migrations: {
      directory: "supabase/migrations",
      head: expectedMigrationHead,
      mode: "expand-only",
    },
    lockfile: { path: "package-lock.json", sha256: lockSha256 },
  };
}

export function assertCanonicalReleaseManifest(manifest, commit, lockSha256, buildConfigSha256) {
  const expected = canonicalReleaseManifest(commit, lockSha256, buildConfigSha256);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error("O manifesto da release não corresponde exatamente ao schema 4 canônico.");
  }
  return manifest;
}

function git(arguments_) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: operationalEnvironment(process.env),
  }).trim();
}

function assertCleanWorktree(stage) {
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status !== "") {
    throw new Error(`O checkout precisa permanecer limpo ${stage}.`);
  }
}

function currentCommit() {
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Não foi possível capturar um SHA Git completo para a release.");
  }
  return commit;
}

function currentCommitTimestamp(commit) {
  const timestamp = git(["show", "-s", "--format=%ct", commit]);
  if (!/^\d+$/u.test(timestamp)) {
    throw new Error("Não foi possível capturar o timestamp do commit da release.");
  }
  return timestamp;
}

function currentNpmVersion() {
  return resolveTrustedNpmCliLaunch({ repositoryRoot: root }).npmVersion;
}

function assertSameCommit(expectedCommit, stage) {
  if (currentCommit() !== expectedCommit) {
    throw new Error(`O SHA do checkout mudou ${stage}; a release foi interrompida.`);
  }
}

function isInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function normalizedRelative(parent, child) {
  const pathFromParent = relative(parent, child);
  if (!isInside(parent, child) || pathFromParent === "") {
    throw new Error(`Caminho inválido fora da raiz esperada: ${child}`);
  }
  return pathFromParent.split(sep).join("/");
}

function compareDirectoryEntries(left, right) {
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
}

function nodes(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort(compareDirectoryEntries)
    .flatMap((entry) => {
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return [child, ...nodes(child)];
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        return [child];
      }
      throw new Error(`Artefato com tipo não suportado: ${child}`);
    });
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requireDirectory(path, description) {
  if (!pathExists(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`${description} não é um diretório regular: ${path}`);
  }
}

function requireRegularFile(path, description) {
  if (!pathExists(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`${description} não é um arquivo regular: ${path}`);
  }
  if (lstatSync(path).size === 0) {
    throw new Error(`${description} está vazio: ${path}`);
  }
}

function assertSafeTree(directory, description) {
  requireDirectory(directory, description);
  for (const path of nodes(directory)) {
    if (basename(path).startsWith(".env")) {
      throw new Error(`${description} contém configuração local proibida: ${path}`);
    }

    const information = lstatSync(path);
    if (information.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(path);
      } catch {
        throw new Error(`${description} contém link simbólico quebrado: ${path}`);
      }
      if (!isInside(directory, target)) {
        throw new Error(`${description} contém link simbólico que escapa do pacote: ${path}`);
      }
    }
  }
}

function assertPhysicalTree(directory, description) {
  assertSafeTree(directory, description);
  for (const path of nodes(directory)) {
    const information = lstatSync(path);
    if (information.isSymbolicLink()) {
      throw new Error(`${description} contém link simbólico: ${path}`);
    }
    if (information.isFile() && information.nlink !== 1) {
      throw new Error(`${description} contém hardlink: ${path}`);
    }
  }
}

function assertNoUnexpectedNextEnvironmentFiles(application) {
  const applicationRoot = dirname(application.runtimeEnvironmentSource);
  for (const name of [".env", ".env.production", ".env.production.local"]) {
    const path = resolve(applicationRoot, name);
    if (pathExists(path)) {
      throw new Error(
        `${application.application} contém ${name}; a release local aceita somente .env.local.`,
      );
    }
  }
}

function runtimeEnvironment(application, commit, port, localEnvironment) {
  return releaseSmokeEnvironment(process.env, localEnvironment, {
    APP_ENV: "production",
    APP_RELEASE_SHA: commit,
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    PORT: String(port),
  });
}

function productionBuildEnvironment(application, localEnvironment) {
  const applicationUrl =
    application.application === "web"
      ? process.env.PRD_PUBLIC_APP_URL
      : process.env.PRD_BACKOFFICE_APP_URL;
  const expectedApplicationUrl =
    application.application === "web" ? expectedPublicAppUrl : expectedBackofficeAppUrl;
  const { supabaseUrl } = productionSupabaseIdentity(process.env);
  const supabaseAnonKey = process.env.PRD_SUPABASE_ANON_KEY;
  if (
    applicationUrl !== expectedApplicationUrl ||
    !/^sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/u.test(supabaseAnonKey ?? "")
  ) {
    throw new Error("As variáveis públicas canônicas de produção são inválidas ou ausentes.");
  }
  return {
    ...localEnvironment,
    APP_ENV: "production",
    NEXT_PUBLIC_APP_URL: applicationUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  };
}

function publicBuildConfigurationFromBuildEnvironments(buildEnvironments) {
  const webEnvironment = buildEnvironments.web;
  const backofficeEnvironment = buildEnvironments.backoffice;
  if (
    webEnvironment === null ||
    typeof webEnvironment !== "object" ||
    backofficeEnvironment === null ||
    typeof backofficeEnvironment !== "object" ||
    webEnvironment.NEXT_PUBLIC_SUPABASE_URL !== backofficeEnvironment.NEXT_PUBLIC_SUPABASE_URL ||
    webEnvironment.NEXT_PUBLIC_SUPABASE_ANON_KEY !==
      backofficeEnvironment.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    throw new Error("Os builds web e backoffice divergem na configuração pública do Supabase.");
  }
  return {
    backofficeAppUrl: backofficeEnvironment.NEXT_PUBLIC_APP_URL,
    publicAppUrl: webEnvironment.NEXT_PUBLIC_APP_URL,
    supabaseAnonKey: webEnvironment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    supabaseUrl: webEnvironment.NEXT_PUBLIC_SUPABASE_URL,
  };
}

function productionPublicBuildConfigSha256(environment = process.env) {
  const { supabaseUrl } = productionSupabaseIdentity(environment);
  return publicBuildConfigSha256({
    backofficeAppUrl: environment.PRD_BACKOFFICE_APP_URL,
    publicAppUrl: environment.PRD_PUBLIC_APP_URL,
    supabaseAnonKey: environment.PRD_SUPABASE_ANON_KEY,
    supabaseUrl,
  });
}

function assertKnownSecretsAbsent(directory, description, environments) {
  const sensitiveValues = secretEnvironmentEntries(...environments);
  if (sensitiveValues.length === 0) {
    return;
  }

  for (const path of nodes(directory)) {
    if (!lstatSync(path).isFile()) {
      continue;
    }
    const contents = readFileSync(path);
    for (const [name, value] of sensitiveValues) {
      if (contents.includes(Buffer.from(value))) {
        throw new Error(`${description} incorporou o secret ${name} em ${path}.`);
      }
    }
  }
}

function prepareDestination(sourceInformation, destination) {
  if (!pathExists(destination)) {
    return;
  }

  const destinationInformation = lstatSync(destination);
  if (sourceInformation.isDirectory()) {
    if (!destinationInformation.isDirectory() || destinationInformation.isSymbolicLink()) {
      throw new Error(`Colisão insegura ao criar diretório de release: ${destination}`);
    }
    return;
  }
  if (destinationInformation.isDirectory() && !destinationInformation.isSymbolicLink()) {
    throw new Error(`Colisão insegura ao criar arquivo de release: ${destination}`);
  }
  unlinkSync(destination);
}

function copyNode(source, destination, sourceRoot, ancestorDirectories = new Set()) {
  if (basename(source).startsWith(".env")) {
    throw new Error(`Tentativa de empacotar configuração local proibida: ${source}`);
  }

  let materializedSource = source;
  let information = lstatSync(source);
  if (information.isSymbolicLink()) {
    materializedSource = realpathSync(source);
    if (!isInside(sourceRoot, materializedSource)) {
      throw new Error(`Link simbólico de origem escapa do pacote: ${source}`);
    }
    information = lstatSync(materializedSource);
  }
  prepareDestination(information, destination);

  if (information.isDirectory()) {
    const physicalDirectory = realpathSync(materializedSource);
    if (ancestorDirectories.has(physicalDirectory)) {
      throw new Error(`Ciclo de diretório detectado ao materializar a release: ${source}`);
    }
    const nextAncestors = new Set(ancestorDirectories);
    nextAncestors.add(physicalDirectory);
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(materializedSource, { withFileTypes: true }).sort(
      compareDirectoryEntries,
    )) {
      copyNode(
        resolve(materializedSource, entry.name),
        resolve(destination, entry.name),
        sourceRoot,
        nextAncestors,
      );
    }
    return;
  }

  mkdirSync(dirname(destination), { recursive: true });
  if (information.isFile()) {
    copyFileSync(materializedSource, destination);
    return;
  }

  throw new Error(`Tipo de artefato não suportado: ${source}`);
}

function copyTree(source, destination, description) {
  assertSafeTree(source, description);
  copyNode(source, destination, source);
  assertPhysicalTree(destination, `${description} empacotado`);
}

function copyRequiredFile(source, destination, description) {
  requireRegularFile(source, description);
  if (basename(source).startsWith(".env") || basename(destination).startsWith(".env")) {
    throw new Error(`Tentativa de empacotar configuração local proibida: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  prepareDestination(lstatSync(source), destination);
  copyFileSync(source, destination);
}

function readBuildId(path, description) {
  requireRegularFile(path, description);
  const buildId = readFileSync(path, "utf8").trim();
  if (buildId === "" || buildId.includes("\n") || buildId.includes("\r")) {
    throw new Error(`${description} é inválido.`);
  }
  return buildId;
}

function removeGeneratedPath(path, allowedPaths) {
  ensurePhysicalArtifactsRoot(root, artifactsRoot);
  if (!allowedPaths.has(path) || !isInside(artifactsRoot, path)) {
    throw new Error(`Recusa de remoção fora do artefato exato autorizado: ${path}`);
  }
  removePhysicalTree(path, {
    allowRegularFile: true,
    description: `O caminho gerado de release ${path}`,
    messages: {
      directoryRequiredMessage: `O caminho gerado de release não é removível com segurança: ${path}`,
      mountDetectedMessage: `O caminho gerado de release não pode conter mounts: ${path}`,
      mountUnverifiedMessage: `Não foi possível comprovar que o caminho gerado de release não contém mounts: ${path}`,
      unsupportedPlatformMessage: `O diretório gerado de release precisa ser removido manualmente nesta plataforma: ${path}`,
    },
    retiredNamePrefix: `.${basename(path)}.release-retired-`,
  });
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function canonicalMigrationVersions(directory, description, expectedHead) {
  if (!/^\d{14}$/u.test(expectedHead ?? "")) {
    throw new Error("O head canônico de migrations é inválido.");
  }
  requireDirectory(directory, description);
  const versions = readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const match = /^(\d{14})_[a-z0-9_]+\.sql$/u.exec(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        throw new Error(`${description} contém entrada inválida: ${entry.name}`);
      }
      return match[1];
    })
    .sort();
  if (
    versions.length === 0 ||
    new Set(versions).size !== versions.length ||
    versions.at(-1) !== expectedHead
  ) {
    throw new Error(`${description} precisa terminar na migration ${expectedHead}.`);
  }
  return versions;
}

export function canonicalReleaseMigrationTransition({
  canonicalHead = databaseMigrationHead,
  description = "Migrations atuais",
  directory = migrationsSource,
} = {}) {
  const versions = canonicalMigrationVersions(directory, description, canonicalHead);
  if (versions.length < 2) {
    throw new Error(`${description} precisa conter a transição N-1/N da release.`);
  }
  return Object.freeze({ head: canonicalHead, previousHead: versions.at(-2) });
}

function localSupabaseDatabaseUrl(statusOutput) {
  if (typeof statusOutput !== "string" || statusOutput.includes("\0")) {
    throw new Error("O status do Supabase local é inválido.");
  }
  const values = new Map();
  for (const line of statusOutput.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator);
    if (!/^[A-Z_]+$/u.test(name) || values.has(name)) {
      throw new Error("O status do Supabase local contém chave inválida ou duplicada.");
    }
    const serialized = line.slice(separator + 1);
    let value;
    try {
      value = serialized.startsWith('"') ? JSON.parse(serialized) : serialized;
    } catch {
      throw new Error("O status do Supabase local contém valor inválido.");
    }
    if (typeof value !== "string" || value === "" || value.includes("\0")) {
      throw new Error("O status do Supabase local contém valor vazio ou inválido.");
    }
    values.set(name, value);
  }
  const databaseUrl = values.get("DB_URL");
  if (databaseUrl === undefined) {
    throw new Error("O Supabase local não publicou DB_URL para a auditoria semântica.");
  }
  return databaseUrl;
}

async function captureLocalAuthorizationFacts(localDockerEnvironment) {
  const status = executeSupabaseLocalCommand(["status", "--output", "env"], {
    capture: true,
    environment: localDockerEnvironment,
  });
  const databaseUrl = localSupabaseDatabaseUrl(status);
  const result = await executeLocalPostgresSql(databaseUrl, { sql: authorizationCatalogSql });
  if (
    !Array.isArray(result?.rows) ||
    result.rows.some((row) => !Array.isArray(row) || row.length !== 1)
  ) {
    throw new Error("O catálogo de autorização local retornou shape inesperado.");
  }
  return canonicalAuthorizationFacts(result.rows.map(([fact]) => fact));
}

function resetLocalSupabaseToMigration(version, localDockerEnvironment) {
  if (!/^\d{14}$/u.test(version)) {
    throw new Error("A versão solicitada para o reset semântico é inválida.");
  }
  executeSupabaseLocalCommand(["db", "reset", "--local", "--version", version, "--no-seed"], {
    capture: true,
    environment: localDockerEnvironment,
  });
}

function restoreCanonicalLocalSupabase() {
  execFileSync(process.execPath, [resolve(root, "scripts/local-setup.mjs")], {
    cwd: root,
    env: operationalEnvironment(process.env),
    stdio: "inherit",
    windowsHide: true,
  });
}

export async function generateReleaseAuthorizationContracts(releaseCommit) {
  if (!/^[a-f0-9]{40}$/u.test(releaseCommit ?? "")) {
    throw new Error("O SHA da release semântica é inválido.");
  }
  const migrationVersions = canonicalMigrationVersions(
    migrationsSource,
    "Migrations atuais",
    expectedMigrationHead,
  );
  if (
    migrationVersions.length < 2 ||
    migrationVersions.at(-2) !== expectedPreviousMigrationHead ||
    migrationVersions.at(-1) !== expectedMigrationHead
  ) {
    throw new Error("A cadeia não contém exatamente a transição N-1/N esperada.");
  }
  const localDockerEnvironment = assertLocalDockerDaemon();
  let beforeFacts;
  let afterFacts;
  let captureFailure;
  try {
    resetLocalSupabaseToMigration(expectedPreviousMigrationHead, localDockerEnvironment);
    beforeFacts = await captureLocalAuthorizationFacts(localDockerEnvironment);
    resetLocalSupabaseToMigration(expectedMigrationHead, localDockerEnvironment);
    afterFacts = await captureLocalAuthorizationFacts(localDockerEnvironment);
  } catch (error) {
    captureFailure = error;
  }

  let restorationFailure;
  try {
    restoreCanonicalLocalSupabase();
  } catch (error) {
    restorationFailure = error;
  }
  if (captureFailure !== undefined && restorationFailure !== undefined) {
    throw new AggregateError(
      [captureFailure, restorationFailure],
      "A prova semântica falhou e o Supabase local não pôde ser restaurado.",
    );
  }
  if (captureFailure !== undefined) throw captureFailure;
  if (restorationFailure !== undefined) throw restorationFailure;

  return buildReleaseAuthorizationContracts({
    releaseCommit,
    previousHead: expectedPreviousMigrationHead,
    head: expectedMigrationHead,
    beforeFacts,
    afterFacts,
    approvedAdditions:
      explicitMigrationAuthorizationApprovals.get(
        `${expectedPreviousMigrationHead}:${expectedMigrationHead}`,
      ) ?? [],
  });
}

async function artifactEntry(base, path) {
  const information = lstatSync(path);
  const entryPath = normalizedRelative(base, path);
  if (information.isFile()) {
    return {
      path: entryPath,
      sha256: await sha256File(path),
      size: information.size,
      type: "file",
    };
  }
  if (information.isSymbolicLink()) {
    const target = readlinkSync(path);
    return {
      path: entryPath,
      sha256: sha256Buffer(Buffer.from(target)),
      size: Buffer.byteLength(target),
      target,
      type: "symlink",
    };
  }
  throw new Error(`Artefato não manifestável: ${path}`);
}

async function artifactEntries(base) {
  const entries = [];
  for (const path of nodes(base)) {
    const information = lstatSync(path);
    if (information.isFile() || information.isSymbolicLink()) {
      entries.push(await artifactEntry(base, path));
    }
  }
  return entries;
}

function treeShape(base) {
  return nodes(base)
    .map((path) => {
      const information = lstatSync(path);
      const type = information.isDirectory()
        ? "directory"
        : information.isSymbolicLink()
          ? "symlink"
          : "file";
      return `${type}:${normalizedRelative(base, path)}`;
    })
    .sort();
}

function assertTreeShape(base, expectedShape, description) {
  if (JSON.stringify(treeShape(base)) !== JSON.stringify(expectedShape)) {
    throw new Error(`${description} contém nó ausente, extra ou com tipo divergente.`);
  }
}

async function verifyEntries(base, entries, description) {
  const expectedPaths = entries.map((entry) => `${entry.type}:${entry.path}`).sort();
  const actualPaths = nodes(base)
    .filter((path) => {
      const information = lstatSync(path);
      return information.isFile() || information.isSymbolicLink();
    })
    .map((path) => {
      const information = lstatSync(path);
      return `${information.isSymbolicLink() ? "symlink" : "file"}:${normalizedRelative(base, path)}`;
    })
    .sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`${description} contém artefato ausente, extra ou com tipo divergente.`);
  }

  for (const entry of entries) {
    const path = resolve(base, entry.path);
    if (!isInside(base, path) || normalizedRelative(base, path) !== entry.path) {
      throw new Error(`${description} possui caminho inseguro no manifesto: ${entry.path}`);
    }
    if (!pathExists(path)) {
      throw new Error(`${description} perdeu o artefato: ${entry.path}`);
    }

    const information = lstatSync(path);
    if (entry.type === "file") {
      if (!information.isFile() || information.isSymbolicLink()) {
        throw new Error(`${description} mudou o tipo de ${entry.path}.`);
      }
      if (information.size !== entry.size || (await sha256File(path)) !== entry.sha256) {
        throw new Error(`${description} falhou na verificação de ${entry.path}.`);
      }
      continue;
    }

    if (entry.type !== "symlink" || !information.isSymbolicLink()) {
      throw new Error(`${description} mudou o tipo de ${entry.path}.`);
    }
    const target = readlinkSync(path);
    if (
      target !== entry.target ||
      Buffer.byteLength(target) !== entry.size ||
      sha256Buffer(Buffer.from(target)) !== entry.sha256 ||
      !isInside(base, realpathSync(path))
    ) {
      throw new Error(`${description} falhou na verificação do link ${entry.path}.`);
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
}

function close(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

async function availablePorts(count) {
  const reservations = Array.from({ length: count }, () => createServer());
  try {
    await Promise.all(reservations.map((server) => listen(server)));
    return reservations.map((server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Não foi possível reservar uma porta local para o smoke test.");
      }
      return address.port;
    });
  } finally {
    await Promise.all(
      reservations.filter((server) => server.listening).map((server) => close(server)),
    );
  }
}

function startPackagedServer(application, environment) {
  const entrypoint = resolve(application.packageRoot, application.entrypoint);
  requireRegularFile(entrypoint, `Entrypoint empacotado de ${application.application}`);
  const child = spawn(process.execPath, [entrypoint], {
    cwd: dirname(entrypoint),
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = {
    application: application.application,
    child,
    exited: false,
    logs: "",
    runtimeEnvironment: environment,
    spawnError: undefined,
  };
  const capture = (chunk) => {
    state.logs = `${state.logs}${chunk.toString("utf8")}`.slice(-16_384);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (error) => {
    state.exited = true;
    state.spawnError = error;
  });
  child.once("exit", () => {
    state.exited = true;
  });
  return state;
}

async function waitUntilListening(state, baseUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (state.exited) {
      throw new Error(
        `O processo ${state.application} encerrou antes do smoke test${
          state.spawnError === undefined ? "" : `: ${state.spawnError.message}`
        }.\n${redactEnvironmentSecrets(state.logs, state.runtimeEnvironment)}`,
      );
    }
    try {
      const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // A porta ainda não está aceitando conexões.
    }
    await delay(200);
  }
  throw new Error(
    `Timeout ao iniciar o processo empacotado ${state.application}.\n${redactEnvironmentSecrets(state.logs, state.runtimeEnvironment)}`,
  );
}

async function expectPage(url, description, expectedStatus = 200, headers = {}) {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${description} retornou HTTP ${response.status}, esperado ${expectedStatus}.`);
  }
  if (!response.headers.get("content-type")?.includes("text/html") || body.trim() === "") {
    throw new Error(`${description} não apresentou um documento HTML válido.`);
  }
  return { body, response };
}

async function expectHealth(baseUrl, application, status, commit) {
  const path = `/api/health/${status === "live" ? "live" : "ready"}`;
  const requestId = randomUUID();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "x-request-id": requestId },
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200) {
    throw new Error(`${application}${path} retornou HTTP ${response.status}, esperado 200.`);
  }
  const payload = await response.json();
  if (
    payload?.application !== application ||
    payload?.status !== status ||
    payload?.release !== commit ||
    payload?.requestId !== requestId
  ) {
    throw new Error(`${application}${path} violou o contrato de health da release.`);
  }
  if (response.headers.get("x-request-id") !== payload.requestId) {
    throw new Error(`${application}${path} não preservou o requestId autoritativo.`);
  }
}

function staticAssetPath(application) {
  const staticRoot = resolve(application.packageRoot, application.staticDestination);
  const staticFile = nodes(staticRoot).find((path) => lstatSync(path).isFile());
  if (staticFile === undefined) {
    throw new Error(`${application.application} não possui asset estático empacotado.`);
  }
  return `/_next/static/${normalizedRelative(staticRoot, staticFile)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

async function expectStaticAsset(baseUrl, application) {
  const path = staticAssetPath(application);
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.arrayBuffer();
  if (
    response.status !== 200 ||
    body.byteLength === 0 ||
    !(response.headers.get("cache-control") ?? "").includes("immutable")
  ) {
    throw new Error(`${application.application}${path} não serviu o asset empacotado.`);
  }
  return {
    nonce: expectProductionPolicy(application.application, response),
    path,
  };
}

function scriptSourceDirective(contentSecurityPolicy) {
  return (
    contentSecurityPolicy
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src ")) ?? ""
  );
}

function expectProductionPolicy(application, response) {
  const contentSecurityPolicy = response.headers.get("content-security-policy") ?? "";
  const scriptSource = scriptSourceDirective(contentSecurityPolicy);
  const nonceMatches = [...scriptSource.matchAll(/'nonce-([a-f0-9]{32})'/gu)];
  if (
    response.headers.has("x-powered-by") ||
    response.headers.get("x-content-type-options") !== "nosniff" ||
    response.headers.get("x-frame-options") !== "DENY" ||
    !contentSecurityPolicy.includes("frame-ancestors 'none'") ||
    !contentSecurityPolicy.includes("object-src 'none'") ||
    nonceMatches.length !== 1 ||
    !scriptSource.includes("'strict-dynamic'") ||
    scriptSource.includes("'unsafe-inline'") ||
    scriptSource.includes("'unsafe-eval'") ||
    contentSecurityPolicy.includes("127.0.0.1") ||
    contentSecurityPolicy.includes("ws:")
  ) {
    throw new Error(`${application} não serviu a CSP de produção esperada.`);
  }
  return nonceMatches[0]?.[1] ?? "";
}

function expectProductionSecurityDocument(application, { body, response }) {
  const nonce = expectProductionPolicy(application, response);
  const scriptTags = body.match(/<script(?:\s[^>]*)?>/gu) ?? [];
  if (
    !(response.headers.get("cache-control") ?? "").includes("no-store") ||
    scriptTags.length === 0 ||
    scriptTags.some((scriptTag) => !scriptTag.includes(`nonce="${nonce}"`))
  ) {
    throw new Error(
      `${application} não serviu HTML e headers CSP de produção coerentes com nonce.`,
    );
  }
  return nonce;
}

function expectProductionGlobalErrorDocument(application, { body, response }) {
  const nonce = expectProductionPolicy(application, response);
  const scriptTags = body.match(/<script(?:\s[^>]*)?>/gu) ?? [];
  if (
    !(response.headers.get("cache-control") ?? "").includes("no-store") ||
    scriptTags.length !== 0 ||
    !body.includes("Tente novamente")
  ) {
    throw new Error(`${application} não serviu o fallback global seguro de produção.`);
  }
  return nonce;
}

async function expectStaticAssetErrorsCannotBypassProductionPolicy(
  baseUrl,
  application,
  assetPath,
  assetNonce,
) {
  const assetUrl = `${baseUrl}${assetPath}`;
  const probes = [
    { description: "método inválido", init: { method: "POST" }, url: assetUrl },
    {
      description: "range inválido",
      init: { headers: { range: "bytes=999999999999999999-" } },
      url: assetUrl,
    },
    {
      description: "path inválido",
      init: {},
      url: `${baseUrl}/_next/static/%2F`,
    },
  ];
  const nonces = [assetNonce];
  for (const probe of probes) {
    const response = await fetch(probe.url, {
      ...probe.init,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.text();
    if (response.status < 400) {
      throw new Error(
        `${application} aceitou ${probe.description} no asset com HTTP ${response.status}.`,
      );
    }
    const nonce = expectProductionPolicy(application, response);
    nonces.push(nonce);
    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      const scriptTags = body.match(/<script(?:\s[^>]*)?>/gu) ?? [];
      if (
        !(response.headers.get("cache-control") ?? "").includes("no-store") ||
        scriptTags.some((scriptTag) => !scriptTag.includes(`nonce="${nonce}"`))
      ) {
        throw new Error(`${application} serviu erro HTML de asset sem nonce e no-store.`);
      }
    }
  }
  if (new Set(nonces).size !== nonces.length) {
    throw new Error(`${application} reutilizou nonce CSP entre asset e respostas adversariais.`);
  }
}

async function smokePackagedApplications(commit, localEnvironments) {
  const ports = await availablePorts(applications.length);
  await runPackagedReleaseSmokeWithProcessCleanup({
    smokeOperation: async (states) => {
      await Promise.all(
        states.map((state, index) => waitUntilListening(state, `http://127.0.0.1:${ports[index]}`)),
      );
      const rootPages = [];
      for (const [index, application] of applications.entries()) {
        const baseUrl = `http://127.0.0.1:${ports[index]}`;
        const firstDocument = await expectPage(baseUrl, `${application.application}/`);
        const secondDocument = await expectPage(baseUrl, `${application.application}/ novamente`);
        const purposePrefetchDocument = await expectPage(
          baseUrl,
          `${application.application}/ com Purpose: prefetch`,
          200,
          { purpose: "prefetch" },
        );
        const routerPrefetchDocument = await expectPage(
          baseUrl,
          `${application.application}/ com next-router-prefetch`,
          200,
          { "next-router-prefetch": "1" },
        );
        const lookalikeDocument = await expectPage(
          `${baseUrl}/apiary`,
          `${application.application}/apiary`,
          404,
        );
        const globalErrorDocument = await expectPage(
          `${baseUrl}/_global-error`,
          `${application.application}/_global-error`,
          500,
        );
        const firstNonce = expectProductionSecurityDocument(application.application, firstDocument);
        const secondNonce = expectProductionSecurityDocument(
          application.application,
          secondDocument,
        );
        const purposePrefetchNonce = expectProductionSecurityDocument(
          application.application,
          purposePrefetchDocument,
        );
        const routerPrefetchNonce = expectProductionSecurityDocument(
          application.application,
          routerPrefetchDocument,
        );
        const lookalikeNonce = expectProductionSecurityDocument(
          application.application,
          lookalikeDocument,
        );
        const globalErrorNonce = expectProductionGlobalErrorDocument(
          application.application,
          globalErrorDocument,
        );
        const requestNonces = [
          firstNonce,
          secondNonce,
          purposePrefetchNonce,
          routerPrefetchNonce,
          lookalikeNonce,
          globalErrorNonce,
        ];
        if (new Set(requestNonces).size !== requestNonces.length) {
          throw new Error(`${application.application} reutilizou o nonce CSP entre requests.`);
        }
        rootPages.push(firstDocument.body);
        await expectHealth(baseUrl, application.application, "live", commit);
        await expectHealth(baseUrl, application.application, "ready", commit);
        const staticAsset = await expectStaticAsset(baseUrl, application);
        await expectStaticAssetErrorsCannotBypassProductionPolicy(
          baseUrl,
          application.application,
          staticAsset.path,
          staticAsset.nonce,
        );
      }
      if (rootPages[0] === rootPages[1]) {
        throw new Error("Web e backoffice serviram o mesmo documento na raiz.");
      }
      await expectPage(`http://127.0.0.1:${ports[0]}/admin`, "web/admin", 404);
    },
    startProcesses: (registerState) => {
      for (const [index, application] of applications.entries()) {
        const port = ports[index];
        if (port === undefined) {
          throw new Error(`Porta local ausente para ${application.application}.`);
        }
        registerState(
          startPackagedServer(
            application,
            runtimeEnvironment(
              application,
              commit,
              port,
              localEnvironments[application.application],
            ),
          ),
        );
      }
    },
  });
}

function expectedArchiveListing() {
  return [
    `${basename(releaseRoot)}/`,
    ...nodes(releaseRoot).map((path) => {
      const suffix = lstatSync(path).isDirectory() ? "/" : "";
      return `${basename(releaseRoot)}/${normalizedRelative(releaseRoot, path)}${suffix}`;
    }),
  ].sort();
}

async function validateExistingArchive(archivePath, checksumPath) {
  const archiveExists = pathExists(archivePath);
  const checksumExists = pathExists(checksumPath);
  if (archiveExists !== checksumExists) {
    throw new Error("A release existente possui arquivo ou checksum órfão.");
  }
  if (!archiveExists) {
    return undefined;
  }
  requireRegularFile(archivePath, "Arquivo global existente da release");
  requireRegularFile(checksumPath, "Checksum existente da release");
  const sha256 = await sha256File(archivePath);
  if (readFileSync(checksumPath, "utf8").trim() !== `${sha256}  ${basename(archivePath)}`) {
    throw new Error("O checksum da release imutável existente é inválido.");
  }
  return { sha256, size: lstatSync(archivePath).size };
}

async function createArchive(
  commit,
  commitTimestamp,
  archivePath,
  checksumPath,
  incomingArchivePath,
  incomingChecksumPath,
  archiveVerificationRoot,
  expectedReleaseArtifacts,
  expectedReleaseShape,
) {
  let tarVersion;
  try {
    tarVersion = execFileSync("tar", ["--version"], {
      encoding: "utf8",
      env: operationalEnvironment(process.env),
    });
  } catch {
    throw new Error("GNU tar é obrigatório para criar o pacote global da release.");
  }
  if (!tarVersion.includes("GNU tar")) {
    throw new Error("A release reproduzível exige GNU tar.");
  }

  const existingArchive = await validateExistingArchive(archivePath, checksumPath);
  execFileSync(
    "tar",
    deterministicReleaseTarArguments({
      archivePath: incomingArchivePath,
      artifactsRoot,
      commitTimestamp,
      releaseRoot,
    }),
    {
      cwd: root,
      env: { ...operationalEnvironment(process.env), SOURCE_DATE_EPOCH: commitTimestamp },
      stdio: "inherit",
    },
  );
  requireRegularFile(incomingArchivePath, "Arquivo global candidato da release");
  const sha256 = await sha256File(incomingArchivePath);
  const size = lstatSync(incomingArchivePath).size;
  writeFileSync(incomingChecksumPath, `${sha256}  ${basename(archivePath)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (
    readFileSync(incomingChecksumPath, "utf8").trim() !== `${sha256}  ${basename(archivePath)}` ||
    (await sha256File(incomingArchivePath)) !== sha256
  ) {
    throw new Error("A verificação SHA-256 do arquivo global candidato falhou.");
  }

  const listing = execFileSync("tar", ["-tzf", incomingArchivePath], {
    cwd: root,
    encoding: "utf8",
    env: operationalEnvironment(process.env),
    maxBuffer: 128 * 1024 * 1024,
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  if (JSON.stringify(listing) !== JSON.stringify(expectedArchiveListing())) {
    throw new Error("O conteúdo do arquivo global da release é inseguro ou incompleto.");
  }

  mkdirSync(archiveVerificationRoot, { mode: 0o700 });
  execFileSync(
    "tar",
    [
      "-xzf",
      incomingArchivePath,
      "-C",
      archiveVerificationRoot,
      "--no-same-owner",
      "--no-same-permissions",
    ],
    {
      cwd: root,
      env: operationalEnvironment(process.env),
      stdio: "inherit",
    },
  );
  const extractedReleaseRoot = resolve(archiveVerificationRoot, basename(releaseRoot));
  assertPhysicalTree(extractedReleaseRoot, "Release reextraída do arquivo global");
  assertTreeShape(
    extractedReleaseRoot,
    expectedReleaseShape,
    "Release reextraída do arquivo global",
  );
  await verifyEntries(
    extractedReleaseRoot,
    expectedReleaseArtifacts,
    "Release reextraída do arquivo global",
  );

  if (existingArchive !== undefined) {
    if (existingArchive.sha256 !== sha256 || existingArchive.size !== size) {
      throw new Error(`A release imutável ${commit} já existe com conteúdo diferente.`);
    }
    unlinkSync(incomingArchivePath);
    unlinkSync(incomingChecksumPath);
  } else {
    renameSync(incomingArchivePath, archivePath);
    renameSync(incomingChecksumPath, checksumPath);
  }

  return {
    path: relative(root, archivePath).split(sep).join("/"),
    sha256,
    size,
  };
}

function validateArchiveMembers(archivePath) {
  const commonOptions = {
    cwd: root,
    encoding: "utf8",
    env: operationalEnvironment(process.env),
    maxBuffer: 128 * 1024 * 1024,
  };
  const listing = execFileSync("tar", ["-tzf", archivePath], commonOptions)
    .split("\n")
    .filter(Boolean);
  if (
    listing.length === 0 ||
    listing.length > 100_000 ||
    new Set(listing).size !== listing.length
  ) {
    throw new Error("A listagem do arquivo de release é vazia, duplicada ou excede o limite.");
  }
  for (const rawPath of listing) {
    const memberPath = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    if (
      memberPath === "" ||
      memberPath.includes("\\") ||
      memberPath.includes("\0") ||
      !/^[A-Za-z0-9@+._/-]+$/u.test(memberPath) ||
      posix.isAbsolute(memberPath) ||
      posix.normalize(memberPath) !== memberPath ||
      (memberPath !== "release" && !memberPath.startsWith("release/"))
    ) {
      throw new Error(`O archive contém caminho inseguro: ${rawPath}`);
    }
  }
  if (!listing.some((member) => member === "release/" || member === "release")) {
    throw new Error("O archive não contém a raiz release.");
  }

  const verbose = execFileSync(
    "tar",
    ["-tvzf", archivePath, "--numeric-owner", "--full-time", "--quoting-style=escape"],
    commonOptions,
  )
    .split("\n")
    .filter(Boolean);
  if (verbose.length !== listing.length) {
    throw new Error("As listagens simples e tipadas do archive divergem.");
  }
  let expandedBytes = 0;
  for (const line of verbose) {
    const fields = line.trim().split(/\s+/u);
    const mode = fields[0] ?? "";
    const size = fields[2] ?? "";
    if (!/^[d-][rwx-]{9}$/u.test(mode) || !/^\d+$/u.test(size)) {
      throw new Error("O archive contém link, modo especial ou metadado inválido.");
    }
    expandedBytes += Number(size);
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > 4_294_967_296) {
      throw new Error("O archive excede o limite de expansão da release.");
    }
  }
  return listing;
}

async function validateCanonicalReleaseTree(directory, commit) {
  assertPhysicalTree(directory, "Release canônica extraída");
  const lockPath = resolve(directory, "package-lock.json");
  const configPath = resolve(directory, "supabase/config.toml");
  const rolesPath = resolve(directory, "supabase/roles.sql");
  const authorizationCatalogPath = resolve(directory, authorizationCatalogRelativePath);
  const authorizationContractPath = resolve(directory, authorizationContractRelativePath);
  const baselineAuthorizationContractPath = resolve(
    directory,
    baselineAuthorizationContractRelativePath,
  );
  const authorizationHeadPath = resolve(directory, authorizationHeadRelativePath);
  const releaseManifestPath = resolve(directory, "manifest.json");
  for (const [path, description] of [
    [lockPath, "Lockfile empacotado"],
    [configPath, "Configuração Supabase empacotada"],
    [rolesPath, "Papéis Supabase empacotados"],
    [authorizationCatalogPath, "Catálogo semântico de autorização empacotado"],
    [authorizationContractPath, "Contrato semântico de autorização empacotado"],
    [baselineAuthorizationContractPath, "Contrato baseline de autorização empacotado"],
    [authorizationHeadPath, "Snapshot canônico de autorização do head empacotado"],
    [releaseManifestPath, "Manifesto schema 4 empacotado"],
  ]) {
    requireRegularFile(path, description);
  }

  const lockSha256 = await sha256File(lockPath);
  const manifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
  assertCanonicalReleaseManifest(manifest, commit, lockSha256, productionPublicBuildConfigSha256());
  const authorizationContracts = {
    migrationAuthorization: JSON.parse(readFileSync(authorizationContractPath, "utf8")),
    baselineAuthorization: JSON.parse(readFileSync(baselineAuthorizationContractPath, "utf8")),
    authorizationHead: JSON.parse(readFileSync(authorizationHeadPath, "utf8")),
  };
  assertCanonicalReleaseAuthorizationContracts(authorizationContracts, commit);
  if (
    authorizationContracts.migrationAuthorization.head !== manifest.migrations.head ||
    authorizationContracts.baselineAuthorization.head !== manifest.migrations.head ||
    authorizationContracts.authorizationHead.head !== manifest.migrations.head
  ) {
    throw new Error("Os contratos semânticos divergem do head da release.");
  }
  const packagedAuthorizationCatalogSha256 = await sha256File(authorizationCatalogPath);
  if (
    packagedAuthorizationCatalogSha256 !==
      authorizationContracts.migrationAuthorization.catalogSha256 ||
    packagedAuthorizationCatalogSha256 !==
      authorizationContracts.baselineAuthorization.catalogSha256 ||
    packagedAuthorizationCatalogSha256 !== authorizationContracts.authorizationHead.catalogSha256
  ) {
    throw new Error("A consulta semântica empacotada diverge do contrato da release.");
  }

  const migrationsDirectory = resolve(directory, manifest.migrations.directory);
  requireDirectory(migrationsDirectory, "Diretório empacotado de migrations");
  canonicalMigrationVersions(
    migrationsDirectory,
    "Diretório empacotado de migrations",
    expectedMigrationHead,
  );

  for (const application of applications) {
    const packagedRoot = resolve(directory, application.application);
    const entrypoint = resolve(packagedRoot, application.entrypoint);
    const buildId = resolve(packagedRoot, application.buildIdDestination);
    requireRegularFile(entrypoint, `Entrypoint de ${application.application}`);
    if (readBuildId(buildId, `BUILD_ID de ${application.application}`) !== commit) {
      throw new Error(`BUILD_ID de ${application.application} diverge do SHA da release.`);
    }
  }
  assertKnownSecretsAbsent(directory, "Release canônica extraída", [process.env]);
}

async function verifyReleaseArchive(archivePathArgument, expectedCommit) {
  assertCanonicalReleaseRuntime();
  productionSupabaseIdentity(process.env);
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit)) {
    throw new Error("O SHA esperado para verificar a release é inválido.");
  }
  ensurePhysicalArtifactsRoot(root, artifactsRoot);
  const archivePath = resolve(archivePathArgument);
  const checksumPath = `${archivePath}.sha256`;
  if (
    !isInside(artifactsRoot, archivePath) ||
    basename(archivePath) !== `set-livre-${expectedCommit}.tar.gz`
  ) {
    throw new Error("O archive a verificar precisa estar sob .artifacts e usar o SHA aprovado.");
  }
  requireRegularFile(archivePath, "Archive canônico recebido");
  requireRegularFile(checksumPath, "Sidecar canônico recebido");
  if (
    lstatSync(archivePath).nlink !== 1 ||
    lstatSync(checksumPath).nlink !== 1 ||
    lstatSync(archivePath).size > 2_147_483_648
  ) {
    throw new Error("Archive ou sidecar recebido possui identidade física inválida.");
  }
  const archiveSha256 = await sha256File(archivePath);
  const expectedSidecar = `${archiveSha256}  ${basename(archivePath)}\n`;
  if (readFileSync(checksumPath, "utf8") !== expectedSidecar) {
    throw new Error("O sidecar não corresponde exatamente ao archive recebido.");
  }
  validateArchiveMembers(archivePath);

  const verificationRoot = resolve(
    artifactsRoot,
    `received-release-verification-${expectedCommit}-${randomUUID()}`,
  );
  const generatedPaths = new Set([verificationRoot]);
  let verificationFailure;
  try {
    mkdirSync(verificationRoot, { mode: 0o700 });
    execFileSync(
      "tar",
      ["-xzf", archivePath, "-C", verificationRoot, "--no-same-owner", "--no-same-permissions"],
      { cwd: root, env: operationalEnvironment(process.env), stdio: "inherit" },
    );
    await validateCanonicalReleaseTree(resolve(verificationRoot, "release"), expectedCommit);
  } catch (error) {
    verificationFailure = error;
  }
  const cleanupFailures = collectCleanupFailures([verificationRoot], pathExists, (path) =>
    removeGeneratedPath(path, generatedPaths),
  );
  throwIfPrimaryOrCleanupFailed(verificationFailure, cleanupFailures, {
    combinedMessage: "A verificação do archive falhou e o cleanup também foi interrompido.",
    multipleCleanupMessage: "O cleanup da verificação do archive foi interrompido.",
  });
  process.stdout.write(`Archive ${expectedCommit} validado (${archiveSha256}).\n`);
}

async function generateRelease(commit) {
  assertCanonicalReleaseRuntime();
  ensurePhysicalArtifactsRoot(root, artifactsRoot);
  const npmVersion = currentNpmVersion();
  if (npmVersion !== expectedNpmVersion) {
    throw new Error(`A release canônica exige npm ${expectedNpmVersion}.`);
  }
  const authorizationContracts = await generateReleaseAuthorizationContracts(commit);
  const { migrationAuthorization, baselineAuthorization, authorizationHead } =
    authorizationContracts;
  const commitTimestamp = currentCommitTimestamp(commit);
  const archivePath = resolve(artifactsRoot, `set-livre-${commit}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;
  const incomingArchivePath = `${archivePath}.incoming`;
  const incomingChecksumPath = `${checksumPath}.incoming`;
  const archiveVerificationRoot = resolve(artifactsRoot, `archive-verification-${commit}.incoming`);
  const generatedPaths = new Set([
    releaseRoot,
    incomingArchivePath,
    incomingChecksumPath,
    archiveVerificationRoot,
  ]);
  for (const application of applications) {
    assertNoUnexpectedNextEnvironmentFiles(application);
  }
  const localEnvironments = Object.fromEntries(
    applications.map((application) => [
      application.application,
      readReleaseRuntimeEnvironmentFile(
        application.runtimeEnvironmentSource,
        application.expectedApplicationUrl,
      ),
    ]),
  );
  const buildEnvironments = Object.fromEntries(
    applications.map((application) => [
      application.application,
      Object.freeze(
        releaseBuildEnvironment(
          process.env,
          productionBuildEnvironment(application, localEnvironments[application.application]),
          commit,
        ),
      ),
    ]),
  );
  const buildConfigSha256 = publicBuildConfigSha256(
    publicBuildConfigurationFromBuildEnvironments(buildEnvironments),
  );
  const secretSourceEnvironments = [process.env, ...Object.values(localEnvironments)];

  for (const application of applications) {
    runNextBuildWithCacheCleanup({
      applicationRoot: application.projectRoot,
      buildEnvironment: buildEnvironments[application.application],
    });
  }
  if (
    publicBuildConfigSha256(publicBuildConfigurationFromBuildEnvironments(buildEnvironments)) !==
    buildConfigSha256
  ) {
    throw new Error("A configuração pública mudou durante o build da release.");
  }
  assertSameCommit(commit, "durante o build");
  assertCleanWorktree("após o build");

  for (const application of applications) {
    requireDirectory(
      application.standaloneSource,
      `Standalone atual de ${application.application}`,
    );
    requireDirectory(application.staticSource, `Static atual de ${application.application}`);
    requireRegularFile(
      resolve(application.standaloneSource, application.entrypoint),
      `Entrypoint atual de ${application.application}`,
    );
    readBuildId(application.buildIdSource, `BUILD_ID atual de ${application.application}`);
  }
  assertSafeTree(migrationsSource, "Migrations atuais");

  for (const path of generatedPaths) {
    removeGeneratedPath(path, generatedPaths);
  }
  mkdirSync(releaseRoot, { recursive: true });

  const applicationManifests = {};
  for (const application of applications) {
    copyTree(
      application.standaloneSource,
      application.packageRoot,
      `Standalone de ${application.application}`,
    );
    copyTree(
      application.staticSource,
      resolve(application.packageRoot, application.staticDestination),
      `Static de ${application.application}`,
    );
    const publicDestination = resolve(application.packageRoot, application.publicDestination);
    if (existsSync(application.publicSource)) {
      copyTree(application.publicSource, publicDestination, `Public de ${application.application}`);
    } else {
      mkdirSync(publicDestination, { recursive: true });
    }
    copyRequiredFile(
      application.buildIdSource,
      resolve(application.packageRoot, application.buildIdDestination),
      `BUILD_ID de ${application.application}`,
    );

    const sourceBuildId = readBuildId(
      application.buildIdSource,
      `BUILD_ID atual de ${application.application}`,
    );
    const packagedBuildId = readBuildId(
      resolve(application.packageRoot, application.buildIdDestination),
      `BUILD_ID empacotado de ${application.application}`,
    );
    if (sourceBuildId !== commit || packagedBuildId !== commit) {
      throw new Error(
        `BUILD_ID de ${application.application} precisa ser igual ao SHA da release.`,
      );
    }
    requireRegularFile(
      resolve(application.packageRoot, application.entrypoint),
      `Entrypoint empacotado de ${application.application}`,
    );
    assertSafeTree(application.packageRoot, `Pacote ${application.application}`);
    assertKnownSecretsAbsent(
      application.packageRoot,
      `Pacote ${application.application}`,
      secretSourceEnvironments,
    );
    applicationManifests[application.application] = {
      artifacts: await artifactEntries(application.packageRoot),
      buildId: packagedBuildId,
      entrypoint: application.entrypoint,
      publicRoot: application.publicDestination,
      staticRoot: application.staticDestination,
    };
  }

  const packagedMigrationsRoot = resolve(releaseRoot, "supabase/migrations");
  copyTree(migrationsSource, packagedMigrationsRoot, "Migrations");
  canonicalMigrationVersions(
    packagedMigrationsRoot,
    "Migrations empacotadas",
    expectedMigrationHead,
  );
  const migrationArtifacts = await artifactEntries(packagedMigrationsRoot);

  const packagedSupabaseConfigPath = resolve(releaseRoot, "supabase/config.toml");
  copyRequiredFile(
    supabaseConfigSource,
    packagedSupabaseConfigPath,
    "Configuração versionada do Supabase",
  );
  const packagedSupabaseRolesPath = resolve(releaseRoot, "supabase/roles.sql");
  copyRequiredFile(
    supabaseRolesSource,
    packagedSupabaseRolesPath,
    "Papéis versionados do Supabase",
  );
  const packagedAuthorizationCatalogPath = resolve(releaseRoot, authorizationCatalogRelativePath);
  writeFileSync(packagedAuthorizationCatalogPath, authorizationCatalogSql, {
    encoding: "utf8",
    mode: 0o600,
  });
  if ((await sha256File(packagedAuthorizationCatalogPath)) !== authorizationCatalogSha256) {
    throw new Error("A consulta semântica empacotada diverge da fonte canônica.");
  }
  assertCanonicalReleaseAuthorizationContracts(authorizationContracts, commit);
  const packagedAuthorizationContractPath = resolve(releaseRoot, authorizationContractRelativePath);
  writeFileSync(
    packagedAuthorizationContractPath,
    `${JSON.stringify(migrationAuthorization, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const packagedBaselineAuthorizationContractPath = resolve(
    releaseRoot,
    baselineAuthorizationContractRelativePath,
  );
  writeFileSync(
    packagedBaselineAuthorizationContractPath,
    `${JSON.stringify(baselineAuthorization, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const packagedAuthorizationHeadPath = resolve(releaseRoot, authorizationHeadRelativePath);
  writeFileSync(packagedAuthorizationHeadPath, `${JSON.stringify(authorizationHead, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  assertCanonicalReleaseAuthorizationContracts(
    {
      migrationAuthorization: JSON.parse(readFileSync(packagedAuthorizationContractPath, "utf8")),
      baselineAuthorization: JSON.parse(
        readFileSync(packagedBaselineAuthorizationContractPath, "utf8"),
      ),
      authorizationHead: JSON.parse(readFileSync(packagedAuthorizationHeadPath, "utf8")),
    },
    commit,
  );

  const packageLockPath = resolve(root, "package-lock.json");
  requireRegularFile(packageLockPath, "Lockfile da release");
  const packagedLockPath = resolve(releaseRoot, "package-lock.json");
  copyRequiredFile(packageLockPath, packagedLockPath, "Lockfile da release");
  const packageLock = {
    path: "package-lock.json",
    sha256: await sha256File(packagedLockPath),
    size: lstatSync(packagedLockPath).size,
  };
  const manifest = canonicalReleaseManifest(commit, packageLock.sha256, buildConfigSha256);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  assertCanonicalReleaseManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    commit,
    packageLock.sha256,
    buildConfigSha256,
  );

  for (const application of applications) {
    await verifyEntries(
      application.packageRoot,
      applicationManifests[application.application].artifacts,
      `Pacote ${application.application}`,
    );
  }
  await verifyEntries(packagedMigrationsRoot, migrationArtifacts, "Migrations");
  if (
    lstatSync(packagedLockPath).size !== packageLock.size ||
    (await sha256File(packagedLockPath)) !== packageLock.sha256
  ) {
    throw new Error("O lockfile mudou durante a geração da release.");
  }
  assertPhysicalTree(releaseRoot, "Release completa");
  assertKnownSecretsAbsent(releaseRoot, "Release completa", secretSourceEnvironments);
  const releaseArtifactsBeforeSmoke = await artifactEntries(releaseRoot);
  const releaseShapeBeforeSmoke = treeShape(releaseRoot);

  await smokePackagedApplications(commit, localEnvironments);
  for (const application of applications) {
    await verifyEntries(
      application.packageRoot,
      applicationManifests[application.application].artifacts,
      `Pacote ${application.application} após smoke`,
    );
  }
  await verifyEntries(packagedMigrationsRoot, migrationArtifacts, "Migrations após smoke");
  if (
    lstatSync(packagedLockPath).size !== packageLock.size ||
    (await sha256File(packagedLockPath)) !== packageLock.sha256
  ) {
    throw new Error("O lockfile empacotado mudou durante o smoke.");
  }
  assertPhysicalTree(releaseRoot, "Release completa após smoke");
  assertKnownSecretsAbsent(releaseRoot, "Release completa após smoke", secretSourceEnvironments);
  assertTreeShape(releaseRoot, releaseShapeBeforeSmoke, "Release completa após smoke");
  await verifyEntries(releaseRoot, releaseArtifactsBeforeSmoke, "Release completa após smoke");

  let archive;
  let archiveFailure;
  try {
    ensurePhysicalArtifactsRoot(root, artifactsRoot);
    archive = await createArchive(
      commit,
      commitTimestamp,
      archivePath,
      checksumPath,
      incomingArchivePath,
      incomingChecksumPath,
      archiveVerificationRoot,
      releaseArtifactsBeforeSmoke,
      releaseShapeBeforeSmoke,
    );
  } catch (error) {
    archiveFailure = error;
  }

  const cleanupFailures = collectCleanupFailures(
    [incomingArchivePath, incomingChecksumPath, archiveVerificationRoot],
    pathExists,
    (path) => removeGeneratedPath(path, generatedPaths),
  );
  throwIfPrimaryOrCleanupFailed(archiveFailure, cleanupFailures, {
    combinedMessage:
      "A criação do arquivo global falhou e o cleanup físico também foi interrompido.",
    multipleCleanupMessage: "O cleanup físico de múltiplos caminhos gerados foi interrompido.",
  });
  assertSameCommit(commit, "durante o empacotamento");
  assertCleanWorktree("após o empacotamento");

  const fileCount = releaseArtifactsBeforeSmoke.length;
  process.stdout.write(
    `Release ${commit} validada com ${fileCount} artefatos; arquivo global ${archive.path} (${archive.sha256}).\n`,
  );
}

async function runGenerator(expectedCommit) {
  assertCanonicalReleaseRuntime();
  productionSupabaseIdentity(process.env);
  if (expectedCommit !== undefined && !/^[a-f0-9]{40}$/u.test(expectedCommit)) {
    throw new Error("O SHA solicitado para geração é inválido.");
  }
  ensurePhysicalArtifactsRoot(root, artifactsRoot);
  await withExclusiveReleaseLock(artifactsRoot, async () => {
    assertCleanWorktree("antes da release");
    const releaseCommit = currentCommit();
    if (expectedCommit !== undefined && releaseCommit !== expectedCommit) {
      throw new Error("O checkout não corresponde ao SHA solicitado para geração.");
    }
    let generationFailure;
    try {
      await generateRelease(releaseCommit);
    } catch (error) {
      generationFailure = error;
    }

    const archivePath = resolve(artifactsRoot, `set-livre-${releaseCommit}.tar.gz`);
    const cleanupCandidates = [
      releaseRoot,
      `${archivePath}.incoming`,
      `${archivePath}.sha256.incoming`,
      resolve(artifactsRoot, `archive-verification-${releaseCommit}.incoming`),
    ];
    const generatedPaths = new Set(cleanupCandidates);
    const cleanupFailures = collectCleanupFailures(cleanupCandidates, pathExists, (path) =>
      removeGeneratedPath(path, generatedPaths),
    );
    try {
      throwIfPrimaryOrCleanupFailed(generationFailure, cleanupFailures, {
        combinedMessage: "A release falhou e o cleanup físico dos temporários também falhou.",
        multipleCleanupMessage: "O cleanup físico dos temporários da release falhou.",
      });
      generationFailure = undefined;
    } catch (error) {
      generationFailure = error;
    }

    let finalStateFailure;
    try {
      assertSameCommit(releaseCommit, "ao finalizar a release");
      assertCleanWorktree("ao finalizar a release");
    } catch (error) {
      finalStateFailure = error;
    }

    if (generationFailure !== undefined && finalStateFailure !== undefined) {
      throw new AggregateError(
        [generationFailure, finalStateFailure],
        "A release falhou e o estado final do checkout também é inválido.",
      );
    }
    if (generationFailure !== undefined) {
      if (generationFailure.exitCode !== undefined) {
        process.stderr.write(`${generationFailure.message}\n`);
        process.exitCode = generationFailure.exitCode;
      } else {
        throw generationFailure;
      }
    }
    if (finalStateFailure !== undefined) {
      throw finalStateFailure;
    }
  });
}

async function main(arguments_) {
  const [command = "generate", ...parameters] = arguments_;
  if (command === "generate" && parameters.length <= 1) {
    await runGenerator(parameters[0]);
    return;
  }
  if (command === "verify" && parameters.length === 2) {
    await verifyReleaseArchive(parameters[0], parameters[1]);
    return;
  }
  throw new Error("Uso: node scripts/release-manifest.mjs generate [sha] | verify <archive> <sha>");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
