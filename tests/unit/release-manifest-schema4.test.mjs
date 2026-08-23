import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { databaseMigrationHead } from "../../packages/contracts/src/database-contract.ts";
import {
  assertCanonicalAuthorizationHeadContract,
  assertCanonicalBaselineAuthorizationContract,
  assertCanonicalMigrationAuthorizationContract,
  assertCanonicalReleaseAuthorizationContracts,
  assertCanonicalReleaseManifest,
  assertCanonicalReleaseRuntime,
  authorizationCatalogSha256,
  authorizationCatalogSql,
  buildAuthorizationHeadContract,
  buildBaselineAuthorizationContract,
  buildMigrationAuthorizationContract,
  buildReleaseAuthorizationContracts,
  canonicalAuthorizationFact,
  canonicalReleaseMigrationTransition,
  canonicalReleaseManifest,
  canonicalSupabaseProjectRef,
  publicBuildConfigSha256,
} from "../../scripts/release-manifest.mjs";

const repository = resolve(import.meta.dirname, "../..");
const migrationFiles = readdirSync(resolve(repository, "supabase/migrations"), {
  withFileTypes: true,
});
const migrationVersions = migrationFiles
  .map((entry) => {
    const match = /^(\d{14})_[a-z0-9_]+\.sql$/u.exec(entry.name);
    expect(entry.isFile() && !entry.isSymbolicLink() && match !== null).toBe(true);
    return match[1];
  })
  .sort();
const migrationHead = migrationVersions.at(-1);
const previousMigrationHead = migrationVersions.at(-2);
const source = readFileSync(resolve(repository, "scripts/release-manifest.mjs"), "utf8");
const packageManifest = JSON.parse(readFileSync(resolve(repository, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(resolve(repository, "package-lock.json"), "utf8"));
const commit = "a".repeat(40);
const lockSha256 = "b".repeat(64);
const supabaseProjectRef = "abcdefghijklmnopqrst";
const supabaseUrl = `https://${supabaseProjectRef}.supabase.co`;
const supabaseAnonKey = `sb_publishable_${"a".repeat(22)}_${"b".repeat(8)}`;
const publicBuildConfig = {
  supabaseUrl,
  publicAppUrl: "https://setlivre.com",
  supabaseAnonKey,
  backofficeAppUrl: "https://ops.setlivre.com",
};
const canonicalPublicBuildConfigJson = `{"backofficeAppUrl":"https://ops.setlivre.com","publicAppUrl":"https://setlivre.com","supabaseAnonKey":"${supabaseAnonKey}","supabaseUrl":"${supabaseUrl}"}`;
const buildConfigSha256 = createHash("sha256")
  .update(canonicalPublicBuildConfigJson, "utf8")
  .digest("hex");
const migrationAuthorization = buildMigrationAuthorizationContract({
  releaseCommit: commit,
  previousHead: previousMigrationHead,
  head: migrationHead,
  beforeFacts: [],
  afterFacts: [],
  approvedAdditions: [],
});

function relationFact(name = "studios") {
  return { kind: "relation", objectType: "table", object: ["public", name] };
}

function relationSecurityFact(name = "studios") {
  return {
    kind: "relationSecurity",
    objectType: "table",
    object: ["public", name],
    rowSecurity: true,
    forceRowSecurity: false,
  };
}

function policyFact({
  command = "SELECT",
  name = "studios_select",
  roles = ["authenticated"],
  using,
}) {
  return {
    kind: "policy",
    objectType: "table",
    object: ["public", "studios"],
    name,
    command,
    permissive: true,
    roles,
    using,
    withCheck: null,
  };
}

function privilegeFact({
  grantee,
  object = ["public", "studios"],
  objectType = "table",
  privilege,
}) {
  return {
    kind: "privilege",
    objectType,
    object,
    grantor: "postgres",
    grantee,
    privilege,
    grantable: false,
  };
}

describe("release manifest schema 4 migration", () => {
  it("emits the exact Linux x64 deployment contract", () => {
    const manifest = canonicalReleaseManifest(commit, lockSha256, buildConfigSha256);

    expect(manifest).toEqual({
      schemaVersion: 4,
      commit,
      publicBuildConfigSha256: buildConfigSha256,
      runtime: { arch: "x64", platform: "linux", node: "v24.18.0" },
      applications: {
        web: { entrypoint: "web/server.js", port: 3000 },
        backoffice: { entrypoint: "backoffice/apps/backoffice/server.js", port: 3001 },
      },
      migrations: {
        directory: "supabase/migrations",
        head: migrationHead,
        mode: "expand-only",
      },
      lockfile: { path: "package-lock.json", sha256: lockSha256 },
    });
    expect(assertCanonicalReleaseManifest(manifest, commit, lockSha256, buildConfigSha256)).toBe(
      manifest,
    );
    expect(JSON.stringify(manifest)).not.toContain(supabaseAnonKey);
    expect(JSON.stringify(manifest)).not.toContain("https://setlivre.com");
    expect(JSON.stringify(manifest)).not.toContain("https://ops.setlivre.com");
    expect(JSON.stringify(manifest)).not.toContain(supabaseUrl);
  });

  it("hashes the exact whitespace-free lexicographic JSON contract", () => {
    expect(JSON.stringify(publicBuildConfig)).not.toBe(canonicalPublicBuildConfigJson);
    expect(canonicalPublicBuildConfigJson).not.toMatch(/\s/u);
    expect(createHash("sha256").update(canonicalPublicBuildConfigJson, "utf8").digest("hex")).toBe(
      buildConfigSha256,
    );
    expect(publicBuildConfigSha256(publicBuildConfig)).toBe(buildConfigSha256);
    expect(canonicalSupabaseProjectRef(supabaseUrl)).toBe(supabaseProjectRef);
    for (const invalidUrl of [
      `http://${supabaseProjectRef}.supabase.co`,
      `https://${supabaseProjectRef}.supabase.co/`,
      "https://short.supabase.co",
      `https://${supabaseProjectRef}.example.com`,
    ]) {
      expect(() =>
        publicBuildConfigSha256({ ...publicBuildConfig, supabaseUrl: invalidUrl }),
      ).toThrow(/Supabase/u);
    }
  });

  it("rejects schema 3, extra fields, divergent hashes and non-canonical values", () => {
    const withExtraField = {
      ...canonicalReleaseManifest(commit, lockSha256, buildConfigSha256),
      legacy: true,
    };
    const schema3 = canonicalReleaseManifest(commit, lockSha256, buildConfigSha256);
    schema3.schemaVersion = 3;
    const wrongRuntime = canonicalReleaseManifest(commit, lockSha256, buildConfigSha256);
    wrongRuntime.runtime.arch = "arm64";

    for (const invalidManifest of [withExtraField, schema3, wrongRuntime]) {
      expect(() =>
        assertCanonicalReleaseManifest(invalidManifest, commit, lockSha256, buildConfigSha256),
      ).toThrow(/schema 4 canônico/u);
    }
    expect(() => canonicalReleaseManifest(commit, "c".repeat(63), buildConfigSha256)).toThrow(
      /Identidade inválida/u,
    );
    expect(() => canonicalReleaseManifest(commit, lockSha256, "c".repeat(63))).toThrow(
      /Identidade inválida/u,
    );
    expect(() =>
      publicBuildConfigSha256({ ...publicBuildConfig, supabaseAnonKey: "sb_secret_invalid" }),
    ).toThrow(/configuração pública canônica/u);
    expect(() => publicBuildConfigSha256({ ...publicBuildConfig, raw: true })).toThrow(
      /campos ausentes ou inesperados/u,
    );
  });

  it("requires an exact semantic approval for every authorization expansion", () => {
    const beforeFacts = [relationFact(), relationSecurityFact()];
    const selectPolicy = policyFact({
      using: "(( SELECT auth.uid() AS uid) = owner_id)",
    });
    const selectGrant = privilegeFact({ grantee: "authenticated", privilege: "SELECT" });

    expect(() =>
      buildMigrationAuthorizationContract({
        releaseCommit: commit,
        previousHead: previousMigrationHead,
        head: migrationHead,
        beforeFacts,
        afterFacts: [...beforeFacts, selectPolicy, selectGrant],
        approvedAdditions: [],
      }),
    ).toThrow(/aprovação semântica exata/u);

    const approved = buildMigrationAuthorizationContract({
      releaseCommit: commit,
      previousHead: previousMigrationHead,
      head: migrationHead,
      beforeFacts,
      afterFacts: [...beforeFacts, selectPolicy, selectGrant],
      approvedAdditions: [selectGrant, selectPolicy],
    });
    expect(assertCanonicalMigrationAuthorizationContract(approved)).toBe(approved);
    expect(approved.approvedAdditions).toEqual(approved.additions);
  });

  it("derives the baseline and complete head snapshot from the same canonical facts", () => {
    const selectPolicy = policyFact({
      using: "(( SELECT auth.uid() AS uid) = owner_id)",
    });
    const selectGrant = privilegeFact({ grantee: "authenticated", privilege: "SELECT" });
    const headFacts = [selectGrant, relationSecurityFact(), relationFact(), selectPolicy];
    const contracts = buildReleaseAuthorizationContracts({
      releaseCommit: commit,
      previousHead: previousMigrationHead,
      head: migrationHead,
      beforeFacts: headFacts,
      afterFacts: headFacts,
      approvedAdditions: [],
    });
    const { migrationAuthorization, baselineAuthorization, authorizationHead } = contracts;
    const headPayload = {
      releaseCommit: commit,
      head: migrationHead,
      catalogPath: "supabase/authorization-catalog.sql",
      catalogSha256: authorizationCatalogSha256,
      facts: authorizationHead.facts,
    };
    const baselinePayload = {
      contractVersion: 1,
      catalogVersion: 1,
      catalogPath: "supabase/authorization-catalog.sql",
      catalogSha256: authorizationCatalogSha256,
      releaseCommit: commit,
      previousHead: "none",
      head: migrationHead,
      additions: authorizationHead.facts,
      removals: [],
      approvedAdditions: authorizationHead.facts.filter(
        (fact) => fact.kind === "policy" || fact.kind === "privilege",
      ),
    };

    expect(authorizationHead).toEqual({
      ...headPayload,
      sha256: createHash("sha256").update(JSON.stringify(headPayload), "utf8").digest("hex"),
    });
    expect(baselineAuthorization).toEqual({
      ...baselinePayload,
      sha256: createHash("sha256").update(JSON.stringify(baselinePayload), "utf8").digest("hex"),
    });
    expect(baselineAuthorization.additions).toEqual(authorizationHead.facts);
    expect(baselineAuthorization.removals).toEqual([]);
    expect(baselineAuthorization.approvedAdditions).toEqual(
      baselineAuthorization.additions.filter(
        (fact) => fact.kind === "policy" || fact.kind === "privilege",
      ),
    );
    expect(migrationAuthorization.additions).toEqual([]);
    expect(migrationAuthorization.removals).toEqual([]);
    expect(JSON.stringify(contracts)).not.toContain("projectRef");
    expect(assertCanonicalAuthorizationHeadContract(authorizationHead)).toBe(authorizationHead);
    expect(assertCanonicalBaselineAuthorizationContract(baselineAuthorization)).toBe(
      baselineAuthorization,
    );
    expect(assertCanonicalReleaseAuthorizationContracts(contracts, commit)).toBe(contracts);

    expect(() =>
      assertCanonicalAuthorizationHeadContract({ ...authorizationHead, facts: [] }),
    ).toThrow(/hash/u);
    expect(() =>
      assertCanonicalBaselineAuthorizationContract({
        ...baselineAuthorization,
        previousHead: previousMigrationHead,
      }),
    ).toThrow(/baseline/u);
  });

  it("rejects public DELETE policy and dangerous table, schema and database grants", () => {
    const beforeFacts = [relationFact(), relationSecurityFact()];
    const unsafeFacts = [
      policyFact({
        command: "DELETE",
        name: "unsafe_delete",
        roles: ["anon"],
        using: "true",
      }),
      privilegeFact({ grantee: "anon", privilege: "DELETE" }),
      privilegeFact({
        grantee: "anon",
        object: ["16384"],
        objectType: "largeObject",
        privilege: "UPDATE",
      }),
      privilegeFact({
        grantee: "anon",
        object: ["public"],
        objectType: "schema",
        privilege: "CREATE",
      }),
      privilegeFact({
        grantee: "anon",
        object: ["postgres"],
        objectType: "database",
        privilege: "CREATE",
      }),
      privilegeFact({
        grantee: "anon",
        object: ["pg_default"],
        objectType: "tablespace",
        privilege: "CREATE",
      }),
    ];

    for (const unsafeFact of unsafeFacts) {
      expect(() =>
        buildMigrationAuthorizationContract({
          releaseCommit: commit,
          previousHead: previousMigrationHead,
          head: migrationHead,
          beforeFacts,
          afterFacts: [...beforeFacts, unsafeFact],
          approvedAdditions: [unsafeFact],
        }),
      ).toThrow(/proibid|proibida|proibido/u);
      expect(() =>
        buildBaselineAuthorizationContract({
          releaseCommit: commit,
          head: migrationHead,
          afterFacts: [...beforeFacts, unsafeFact],
        }),
      ).toThrow(/proibid|proibida|proibido/u);
      expect(() =>
        buildAuthorizationHeadContract({
          releaseCommit: commit,
          head: migrationHead,
          facts: [...beforeFacts, unsafeFact],
        }),
      ).toThrow(/proibid|proibida|proibido/u);
    }
  });

  it("binds the exact read-only catalog query to the semantic contract", () => {
    expect(authorizationCatalogSql).toContain("from pg_catalog.pg_policy as policy");
    expect(authorizationCatalogSql).toContain("pg_catalog.aclexplode");
    expect(authorizationCatalogSql).toContain("pg_catalog.pg_database as database");
    expect(authorizationCatalogSql).toContain("pg_catalog.pg_foreign_data_wrapper as wrapper");
    expect(authorizationCatalogSql).toContain("pg_catalog.pg_foreign_server as server");
    expect(authorizationCatalogSql).toContain("pg_catalog.pg_largeobject_metadata as metadata");
    expect(authorizationCatalogSql).toContain("pg_catalog.pg_tablespace as tablespace");
    expect(authorizationCatalogSql).toContain(
      "'(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')'",
    );
    expect(authorizationCatalogSql).toContain("scoped_authorization_facts as (");
    expect(authorizationCatalogSql).toContain(
      "fact->>'kind' in ('relation', 'relationSecurity', 'policy')",
    );
    expect(authorizationCatalogSql).toContain(
      "fact->'object'->>0 = any (array['public', 'private', 'audit'])",
    );
    expect(authorizationCatalogSql).toContain("pg_catalog.jsonb_build_array('$currentDatabase')");
    expect(authorizationCatalogSql).toMatch(
      /when (?:role\.rolname|fact->>'grantor'|fact->>'grantee') in \('app_runtime_local', 'app_runtime_prod'\)[\s\S]*?then 'app_runtime'/gu,
    );
    expect(authorizationCatalogSql).toContain(
      "array['app_dal', 'app_runtime_local', 'app_runtime_prod']",
    );
    expect(authorizationCatalogSql).not.toMatch(
      /^\s*(?:alter|create|delete|drop|grant|insert|revoke|update)\s/imu,
    );
    expect(authorizationCatalogSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(migrationAuthorization.catalogPath).toBe("supabase/authorization-catalog.sql");
    expect(migrationAuthorization.catalogSha256).toBe(authorizationCatalogSha256);
    expect(migrationAuthorization.releaseCommit).toBe(commit);
    expect(
      canonicalAuthorizationFact(
        privilegeFact({
          grantee: "authenticated",
          object: ["auth", "uid", "()"],
          objectType: "routine",
          privilege: "EXECUTE",
        }),
      ),
    ).toEqual(
      privilegeFact({
        grantee: "authenticated",
        object: ["auth", "uid", "()"],
        objectType: "routine",
        privilege: "EXECUTE",
      }),
    );
  });

  it("fails the entrypoint before artifact setup outside exact Linux x64 and Node 24", () => {
    expect(() =>
      assertCanonicalReleaseRuntime({
        arch: "x64",
        nodeVersion: "v24.18.0",
        platform: "win32",
      }),
    ).toThrow(/Linux x64 nativo/u);
    expect(() =>
      assertCanonicalReleaseRuntime({
        arch: "arm64",
        nodeVersion: "v24.18.0",
        platform: "linux",
      }),
    ).toThrow(/Linux x64 nativo/u);
    expect(() =>
      assertCanonicalReleaseRuntime({
        arch: "x64",
        nodeVersion: "v24.17.0",
        platform: "linux",
      }),
    ).toThrow(/Node v24\.18\.0/u);

    const entrypoint = source.slice(source.indexOf("async function runGenerator"));
    expect(entrypoint.indexOf("assertCanonicalReleaseRuntime();")).toBeLessThan(
      entrypoint.indexOf("ensurePhysicalArtifactsRoot(root, artifactsRoot);"),
    );
  });

  it("packages only application data, lock, migration head and the physical archive", () => {
    expect(migrationVersions).toHaveLength(new Set(migrationVersions).size);
    expect(migrationHead).toBe(databaseMigrationHead);
    expect(canonicalReleaseMigrationTransition()).toEqual({
      head: migrationHead,
      previousHead: previousMigrationHead,
    });
    expect(source).toContain(
      'import { databaseMigrationHead } from "../packages/contracts/src/database-contract.ts"',
    );
    expect(source).not.toMatch(/const expected(?:Previous)?MigrationHead = "\d{14}"/u);
    expect(packageManifest.optionalDependencies).toBeUndefined();
    expect(
      packageLock.packages[""].optionalDependencies?.["@supabase/cli-linux-x64"],
    ).toBeUndefined();
    expect(source).not.toContain("@supabase/cli-linux-x64");
    expect(source).not.toContain("deploy/supabase");
    expect(source).not.toContain("supabaseCli");
    expect(source).toContain("copyRequiredFile(\n    supabaseConfigSource");
    expect(source).toContain("generateReleaseAuthorizationContracts(commit)");
    expect(source).toContain("authorization-catalog.sql");
    expect(source).toContain("authorization-contract.json");
    expect(source).toContain("baseline-authorization-contract.json");
    expect(source).toContain("authorization-head.json");
    expect(source).toContain("resetLocalSupabaseToMigration(expectedPreviousMigrationHead");
    expect(source).toContain("resetLocalSupabaseToMigration(expectedMigrationHead");
    expect(source).toMatch(/canonicalMigrationVersions\(\s*packagedMigrationsRoot,/u);
    expect(source).toContain("entry.isSymbolicLink() || match === null");
    expect(source).toContain("await smokePackagedApplications(commit, localEnvironments)");
    expect(source).toContain("validateArchiveMembers(archivePath)");
    expect(source).toContain("await validateCanonicalReleaseTree");
    const releaseTreeValidation = source.slice(
      source.indexOf("async function validateCanonicalReleaseTree"),
      source.indexOf("async function verifyReleaseArchive"),
    );
    expect(releaseTreeValidation).toContain("baselineAuthorizationContractPath");
    expect(releaseTreeValidation).toContain("authorizationHeadPath");
    expect(releaseTreeValidation).toContain(
      "assertCanonicalReleaseAuthorizationContracts(authorizationContracts, commit)",
    );
    const authorizationGeneration = source.slice(
      source.indexOf("export async function generateReleaseAuthorizationContracts"),
      source.indexOf("async function artifactEntry"),
    );
    expect(authorizationGeneration.match(/captureLocalAuthorizationFacts/gu)).toHaveLength(2);
    expect(authorizationGeneration).toContain("afterFacts");
    expect(source).toContain("const cleanupCandidates = [\n      releaseRoot,");
    expect(source).toContain("schemaVersion: 4");
    expect(source).not.toMatch(/schemaVersion:\s*[13]/gu);
  });

  it("binds the exact public build configuration while keeping local smoke DAL", () => {
    expect(source).toContain("process.env.PRD_PUBLIC_APP_URL");
    expect(source).toContain("process.env.PRD_BACKOFFICE_APP_URL");
    expect(source).toContain("environment.PRD_SUPABASE_PROJECT_REF");
    expect(source).toContain("environment.PRD_SUPABASE_URL");
    expect(source).toContain("process.env.PRD_SUPABASE_ANON_KEY");
    expect(source).not.toContain("expectedProjectRef");
    expect(source).not.toContain("expectedSupabaseUrl");
    expect(source).toContain("supabaseUrl !== `https://${projectRef}.supabase.co`");
    expect(source).toContain("productionBuildEnvironment(application");
    expect(source).toContain("buildEnvironments[application.application]");
    expect(source).toContain("publicBuildConfigurationFromBuildEnvironments(buildEnvironments)");
    expect(source).toContain("productionPublicBuildConfigSha256()");
    expect(source).toContain("publicBuildConfigSha256: buildConfigSha256");
    expect(source).toContain("await smokePackagedApplications(commit, localEnvironments)");
    for (const entrypointName of ["verifyReleaseArchive", "runGenerator"]) {
      const start = source.indexOf(`async function ${entrypointName}`);
      const end = source.indexOf("\n}\n", start);
      const entrypoint = source.slice(start, end);
      expect(entrypoint.indexOf("assertCanonicalReleaseRuntime();")).toBeLessThan(
        entrypoint.indexOf("productionSupabaseIdentity(process.env);"),
      );
      expect(entrypoint).toContain("productionSupabaseIdentity(process.env);");
    }
  });
});
