import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  authorizationCatalogSha256,
  authorizationCatalogSql,
  buildMigrationAuthorizationContract,
  canonicalAuthorizationFacts,
} from "../../scripts/release-manifest.mjs";

const repository = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repository, "scripts/production-deploy-agent.sh");
const script = readFileSync(scriptPath, "utf8");
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const linuxIt = process.platform === "linux" ? it : it.skip;
const temporaryDirectories = [];
const canonicalArchiveSha256 = "d".repeat(64);
const canonicalPublicBuildConfigSha256 = "e".repeat(64);

function windowsPythonPath() {
  if (process.platform !== "win32") return "";
  const installations = resolve(process.env.LOCALAPPDATA, "Programs/Python");
  const executable = readdirSync(installations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^Python\d+$/u.test(entry.name))
    .map((entry) => resolve(installations, entry.name, "python.exe"))
    .filter(existsSync)
    .sort()
    .at(-1);
  if (executable === undefined)
    throw new Error("Python oficial não encontrado para os testes Bash.");
  return executable;
}

const testPython = windowsPythonPath();
const bashPythonPrelude =
  'if [[ -n "${TEST_PYTHON:-}" ]]; then python3() { "$TEST_PYTHON" "$@"; }; fi';

function temporaryDirectory() {
  const directory = mkdtempSync(resolve(tmpdir(), "setlivre-pull-deployer-"));
  temporaryDirectories.push(directory);
  return directory;
}

function bashPath(path) {
  if (process.platform !== "win32") return path;
  return path
    .replace(/^([A-Za-z]):\\/u, (_, drive) => `/${drive.toLowerCase()}/`)
    .replaceAll("\\", "/");
}

function bashTestEnvironment(extra = {}) {
  return {
    ...process.env,
    ...(testPython === "" ? {} : { TEST_PYTHON: bashPath(testPython) }),
    ...extra,
  };
}

function callFunction(name, args) {
  return spawnSync(
    bash,
    [
      "-c",
      `${bashPythonPrelude}; source "$1"; shift; ci_github_workflow_id=987653; prd_github_workflow_id=987654; "$@"`,
      "setlivre-test",
      bashPath(scriptPath),
      name,
      ...args.map(bashPath),
    ],
    { encoding: "utf8", env: bashTestEnvironment() },
  );
}

function extractHeredoc(marker) {
  const expression = new RegExp(`<<'${marker}'\\r?\\n([\\s\\S]*?)\\r?\\n${marker}`);
  const match = expression.exec(script);
  expect(match).not.toBeNull();
  return match[1];
}

function runNodeHeredoc(marker, args) {
  return spawnSync(process.execPath, ["-", ...args], {
    encoding: "utf8",
    input: extractHeredoc(marker),
  });
}

function normalCandidate(
  runNumber,
  runAttempt,
  runId,
  releaseSha,
  updatedAt = "2026-08-18T00:00:00Z",
  artifactProviderHeadSha = releaseSha,
) {
  return [
    runNumber,
    runAttempt,
    runId,
    artifactProviderHeadSha,
    releaseSha,
    runNumber,
    runAttempt,
    runId,
    artifactProviderHeadSha,
    updatedAt,
    "normal",
    "none",
    "none",
  ].join(" ");
}

function recoveryCandidate(
  sourceRunNumber,
  sourceRunAttempt,
  sourceRunId,
  releaseSha,
  artifactProviderRunNumber,
  artifactProviderRunAttempt,
  artifactProviderRunId,
  artifactProviderHeadSha,
  updatedAt = "2026-08-18T00:00:00Z",
  archiveSha256 = canonicalArchiveSha256,
  publicBuildConfigSha256 = canonicalPublicBuildConfigSha256,
  sourceHeadSha = releaseSha,
) {
  return [
    sourceRunNumber,
    sourceRunAttempt,
    sourceRunId,
    sourceHeadSha,
    releaseSha,
    artifactProviderRunNumber,
    artifactProviderRunAttempt,
    artifactProviderRunId,
    artifactProviderHeadSha,
    updatedAt,
    "recovery",
    archiveSha256,
    publicBuildConfigSha256,
  ].join(" ");
}

function selectedArtifact(
  sourceRunNumber,
  sourceRunAttempt,
  sourceRunId,
  releaseSha,
  previousMigrationHead,
  artifactProviderRunNumber = sourceRunNumber,
  artifactProviderRunAttempt = sourceRunAttempt,
  artifactProviderRunId = sourceRunId,
  artifactId = 200,
  artifactDigest = "c".repeat(64),
  artifactSize = 1024,
  archiveSha256 = canonicalArchiveSha256,
  publicBuildConfigSha256 = canonicalPublicBuildConfigSha256,
) {
  return [
    sourceRunNumber,
    sourceRunAttempt,
    sourceRunId,
    releaseSha,
    artifactProviderRunNumber,
    artifactProviderRunAttempt,
    artifactProviderRunId,
    artifactId,
    artifactDigest,
    artifactSize,
    archiveSha256,
    publicBuildConfigSha256,
    previousMigrationHead,
  ].join(" ");
}

function candidateSet(...candidates) {
  return `${candidates.join("\n")}\n`;
}

function productionWorkflowRun({
  artifactProviderHeadSha,
  releaseSha,
  runId,
  runNumber,
  sourceRunAttempt = 1,
  sourceRunId,
  type = "normal",
  updatedAt = "2026-08-18T00:00:00Z",
  archiveSha256 = canonicalArchiveSha256,
  publicBuildConfigSha256 = canonicalPublicBuildConfigSha256,
}) {
  const recovery = type === "recovery";
  return {
    conclusion: "success",
    display_title: recovery
      ? `Recovered release ${releaseSha} approved ${sourceRunId}/${sourceRunAttempt} archive ${archiveSha256} config ${publicBuildConfigSha256}`
      : `Release ${releaseSha}`,
    event: "workflow_run",
    head_branch: "main",
    head_repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
    head_sha: artifactProviderHeadSha ?? releaseSha,
    id: runId,
    path: ".github/workflows/prd-deploy.yaml",
    repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
    run_attempt: 1,
    run_number: runNumber,
    status: "completed",
    updated_at: updatedAt,
    workflow_id: 987654,
  };
}

function recoveryWorkflowRun({
  conclusion = null,
  headSha,
  releaseSha,
  runId,
  runNumber,
  sourceRunAttempt = 1,
  sourceRunId,
  status = "queued",
  updatedAt = "2026-08-18T00:00:00Z",
  archiveSha256 = canonicalArchiveSha256,
  publicBuildConfigSha256 = canonicalPublicBuildConfigSha256,
}) {
  return {
    conclusion,
    display_title: `${releaseSha} approved ${sourceRunId}/${sourceRunAttempt} archive ${archiveSha256} config ${publicBuildConfigSha256}`,
    event: "workflow_dispatch",
    head_branch: "main",
    head_repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
    head_sha: headSha,
    id: runId,
    path: ".github/workflows/ci.yaml",
    repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
    run_attempt: 1,
    run_number: runNumber,
    status,
    updated_at: updatedAt,
    workflow_id: 987653,
  };
}

function writeWorkflowPage(path, totalCount, workflowRuns) {
  writeFileSync(path, JSON.stringify({ total_count: totalCount, workflow_runs: workflowRuns }));
}

function callCandidateRuns(expectedTotal, pagePaths, checkpoint = {}) {
  const sourceRunNumber = checkpoint.sourceRunNumber ?? 0;
  const sourceRunAttempt = checkpoint.sourceRunAttempt ?? 0;
  const sourceRunId = checkpoint.sourceRunId ?? 0;
  const releaseSha = checkpoint.releaseSha ?? "none";
  return spawnSync(
    bash,
    [
      "-c",
      [
        bashPythonPrelude,
        'source "$1"',
        "prd_github_workflow_id=987654",
        'checkpoint_source_run_number="$3"',
        'checkpoint_source_run_attempt="$4"',
        'checkpoint_source_run_id="$5"',
        'checkpoint_release_sha="$6"',
        'candidate_runs "$2" "${@:7}"',
      ].join("; "),
      "setlivre-candidate-runs-test",
      bashPath(scriptPath),
      String(expectedTotal),
      String(sourceRunNumber),
      String(sourceRunAttempt),
      String(sourceRunId),
      releaseSha,
      ...pagePaths.map(bashPath),
    ],
    { encoding: "utf8", env: bashTestEnvironment() },
  );
}

function callSelectArtifact(
  candidates,
  currentSha,
  relation = "ahead",
  metadata = "present",
  skippedRunId = "none",
  rejectedIdentity = "",
  rejectedMigrationHead = "20260818000200",
  appliedMigrationHead = "none",
  rootActivationResult = "none",
) {
  const directory = temporaryDirectory();
  const metadataCalls = resolve(directory, "metadata.calls");
  const result = spawnSync(
    bash,
    [
      "-c",
      [
        bashPythonPrelude,
        'source "$1"',
        'work_directory="$2"',
        'TEST_CANDIDATES="$3"',
        'TEST_RELATION="$5"',
        'TEST_METADATA="$6"',
        'TEST_SKIPPED_RUN_ID="$7"',
        'TEST_REJECTED_IDENTITY="$8"',
        'TEST_REJECTED_MIGRATION_HEAD="$9"',
        'TEST_APPLIED_MIGRATION_HEAD="${10}"',
        'TEST_ROOT_ACTIVATION_RESULT="${11}"',
        'TEST_METADATA_CALLS="$2/metadata.calls"',
        'checkpoint_release_sha="$4"',
        "checkpoint_migration_head=20260818000100",
        "checkpoint_source_run_number=9",
        "checkpoint_source_run_attempt=1",
        "checkpoint_source_run_id=90",
        'fetch_candidate_runs() { printf "%s" "$TEST_CANDIDATES" >"$1"; }',
        'classify_forward_relation() { printf "%s\\n" "$TEST_RELATION"; }',
        'manager_activation_result() { printf "%s\\n" "$TEST_ROOT_ACTIVATION_RESULT"; }',
        `fetch_artifact_metadata() {
          printf '%s\\n' "$1" >>"$TEST_METADATA_CALLS"
          if [[ "$TEST_METADATA" == missing || "$TEST_METADATA" == "missing:$1" ]]; then
            printf '%s\\n' missing-artifact >"$4"
            return 0
          fi
          printf '%s\\n' 200 '${"c".repeat(64)}' 1024 '${"d".repeat(64)}' '${"e".repeat(64)}' >"$4"
        }`,
        `fetch_publish_job_outcome() {
          if [[ "$1" == "$TEST_SKIPPED_RUN_ID" ]]; then
            printf '%s\\n' skipped
          else
            printf '%s\\n' success
          fi
        }
        request_artifact_recovery() { return 3; }`,
        `rejected_schema_head() {
          if [[ -n "$TEST_REJECTED_IDENTITY" ]]; then
            if [[ "$1" == none || "$TEST_REJECTED_MIGRATION_HEAD" > "$1" ]]; then
              printf '%s\\n' "$TEST_REJECTED_MIGRATION_HEAD"
              return 0
            fi
          fi
          printf '%s\\n' "$1"
        }
        rejected_run_identity_status() {
          if [[ -n "$TEST_REJECTED_IDENTITY" ]]; then
            local rejected_sha rejected_run_number rejected_run_attempt rejected_run_id
            local rejected_artifact_id rejected_artifact_digest
            read -r rejected_sha rejected_run_number rejected_run_attempt rejected_run_id rejected_artifact_id rejected_artifact_digest <<<"$TEST_REJECTED_IDENTITY"
            if [[ "$*" == "$rejected_sha $rejected_run_number $rejected_run_attempt $rejected_run_id" ]]; then
              printf 'rejected %s %s %s\\n' "$rejected_artifact_id" "$rejected_artifact_digest" "$TEST_REJECTED_MIGRATION_HEAD"
              return 0
            fi
          fi
          printf '%s\\n' eligible
        }
        applied_schema_head() {
          if [[ "$TEST_APPLIED_MIGRATION_HEAD" != none ]]; then
            if [[ "$1" == none || "$TEST_APPLIED_MIGRATION_HEAD" > "$1" ]]; then
              printf '%s\\n' "$TEST_APPLIED_MIGRATION_HEAD"
              return 0
            fi
          fi
          printf '%s\\n' "$1"
        }`,
        'select_artifact "$4"',
      ].join("; "),
      "setlivre-select-test",
      bashPath(scriptPath),
      bashPath(directory),
      candidates,
      currentSha,
      relation,
      metadata,
      skippedRunId,
      rejectedIdentity,
      rejectedMigrationHead,
      appliedMigrationHead,
      rootActivationResult,
    ],
    { encoding: "utf8", env: bashTestEnvironment() },
  );
  result.metadataCalls = existsSync(metadataCalls)
    ? readFileSync(metadataCalls, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return result;
}

function migrationTime(version) {
  return [
    `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}`,
    `${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}`,
  ].join(" ");
}

function migrationListPayload(versions, remoteVersions = versions) {
  const remote = new Set(remoteVersions);
  return {
    message: "Migrations listed",
    migrations: versions.map((version) => ({
      local: version,
      remote: remote.has(version) ? version : "",
      time: migrationTime(version),
    })),
  };
}

const productionSupabaseProjectRef = "abcdefghijklmnopqrst";
const productionPublicBuildConfig = {
  backofficeAppUrl: "https://ops.setlivre.com",
  publicAppUrl: "https://setlivre.com",
  supabaseAnonKey: `sb_publishable_${"a".repeat(22)}_${"B".repeat(8)}`,
  supabaseUrl: `https://${productionSupabaseProjectRef}.supabase.co`,
};

function publicBuildConfigDigest(configuration = productionPublicBuildConfig) {
  return createHash("sha256").update(JSON.stringify(configuration), "utf8").digest("hex");
}

function createReleaseContractFixture(directory) {
  const releaseRoot = resolve(directory, "release");
  const migrations = resolve(releaseRoot, "supabase/migrations");
  mkdirSync(migrations, { recursive: true });
  const releaseSha = "a".repeat(40);
  const migrationHead = "20260818000100";
  const lockPath = resolve(releaseRoot, "package-lock.json");
  const lockBytes = Buffer.from('{"lockfileVersion":3}\n', "utf8");
  writeFileSync(lockPath, lockBytes);
  const lockSha = createHash("sha256").update(lockBytes).digest("hex");
  writeFileSync(resolve(releaseRoot, "supabase/config.toml"), 'project_id = "set-livre"\n');
  writeFileSync(resolve(releaseRoot, "supabase/roles.sql"), "select 1;\n");
  writeFileSync(
    resolve(releaseRoot, "supabase/authorization-catalog.sql"),
    authorizationCatalogSql,
  );
  writeFileSync(resolve(migrations, `${migrationHead}_baseline.sql`), "select 1;\n");
  const authorization = buildMigrationAuthorizationContract({
    releaseCommit: releaseSha,
    previousHead: "20260816000200",
    head: migrationHead,
    beforeFacts: [],
    afterFacts: [],
    approvedAdditions: [],
  });
  const manifest = {
    applications: {
      backoffice: { entrypoint: "backoffice/apps/backoffice/server.js", port: 3001 },
      web: { entrypoint: "web/server.js", port: 3000 },
    },
    commit: releaseSha,
    lockfile: { path: "package-lock.json", sha256: lockSha },
    migrations: {
      directory: "supabase/migrations",
      head: migrationHead,
      mode: "expand-only",
    },
    publicBuildConfigSha256: publicBuildConfigDigest(),
    runtime: { arch: "x64", node: "v24.18.0", platform: "linux" },
    schemaVersion: 4,
  };
  const manifestPath = resolve(releaseRoot, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(
    resolve(releaseRoot, "supabase/authorization-contract.json"),
    JSON.stringify(authorization),
  );
  const baselineAuthorization = baselineAuthorizationContract({
    afterFacts: [],
    head: migrationHead,
  });
  const authorizationHead = authorizationHeadContract({ facts: [], head: migrationHead });
  writeFileSync(
    resolve(releaseRoot, "supabase/baseline-authorization-contract.json"),
    JSON.stringify(baselineAuthorization),
  );
  writeFileSync(
    resolve(releaseRoot, "supabase/authorization-head.json"),
    JSON.stringify(authorizationHead),
  );
  return { manifest, manifestPath, releaseRoot, releaseSha };
}

function authorizationRelationFact(name = "studios") {
  return { kind: "relation", objectType: "table", object: ["public", name] };
}

function authorizationRelationSecurityFact(name = "studios") {
  return {
    kind: "relationSecurity",
    objectType: "table",
    object: ["public", name],
    rowSecurity: true,
    forceRowSecurity: false,
  };
}

function authorizationPolicyFact({
  command = "SELECT",
  name = "studios_select",
  roles = ["authenticated"],
  using = "(( SELECT auth.uid() AS uid) = owner_id)",
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

function authorizationPrivilegeFact({
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

function signedAuthorizationContract({ additions, approvedAdditions = additions, removals = [] }) {
  const payload = {
    contractVersion: 1,
    catalogVersion: 1,
    catalogPath: "supabase/authorization-catalog.sql",
    catalogSha256: authorizationCatalogSha256,
    releaseCommit: "a".repeat(40),
    previousHead: "20260818000100",
    head: "20260819000100",
    additions: canonicalAuthorizationFacts(additions),
    removals: canonicalAuthorizationFacts(removals),
    approvedAdditions: canonicalAuthorizationFacts(approvedAdditions),
  };
  return {
    ...payload,
    sha256: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
  };
}

function baselineAuthorizationContract({ afterFacts, head = "20260819000100" }) {
  const after = canonicalAuthorizationFacts(afterFacts);
  const payload = {
    contractVersion: 1,
    catalogVersion: 1,
    catalogPath: "supabase/authorization-catalog.sql",
    catalogSha256: authorizationCatalogSha256,
    releaseCommit: "a".repeat(40),
    previousHead: "none",
    head,
    additions: after,
    removals: [],
    approvedAdditions: after.filter((fact) => fact.kind === "policy" || fact.kind === "privilege"),
  };
  return {
    ...payload,
    sha256: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
  };
}

function authorizationHeadContract({ facts, head = "20260819000100" }) {
  const canonicalFacts = canonicalAuthorizationFacts(facts);
  const payload = {
    releaseCommit: "a".repeat(40),
    head,
    catalogPath: "supabase/authorization-catalog.sql",
    catalogSha256: authorizationCatalogSha256,
    facts: canonicalFacts,
  };
  return {
    ...payload,
    sha256: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
  };
}

function writeAuthorizationManifest(directory, contract) {
  const manifest = resolve(directory, "manifest.json");
  const contractPath = resolve(directory, "authorization-contract.json");
  writeFileSync(
    manifest,
    JSON.stringify({ commit: contract.releaseCommit, migrations: { head: contract.head } }),
  );
  writeFileSync(contractPath, JSON.stringify(contract));
  return { contractPath, manifest };
}

function writeAuthorizationSnapshot(path, facts) {
  const canonical = canonicalAuthorizationFacts(facts);
  const serialized = canonical.map((fact) => JSON.stringify(fact)).join("\n");
  writeFileSync(path, serialized === "" ? "" : `${serialized}\n`);
}

function agentWithHostTools(directory, hostToolsRoot) {
  const transformedPath = resolve(directory, "production-deploy-agent.test.sh");
  const transformed = script.replace(
    /^readonly host_tools_root=.*$/mu,
    `readonly host_tools_root=${JSON.stringify(bashPath(hostToolsRoot))}`,
  );
  writeFileSync(transformedPath, transformed);
  return transformedPath;
}

function callReleaseContractGuards(cases) {
  const result = spawnSync(
    bash,
    [
      "-c",
      [
        bashPythonPrelude,
        'source "$1"',
        "shift",
        'node() { "$TEST_NODE" "$@"; }',
        `backoffice_app_url="${productionPublicBuildConfig.backofficeAppUrl}"`,
        `public_app_url="${productionPublicBuildConfig.publicAppUrl}"`,
        `supabase_anon_key="${productionPublicBuildConfig.supabaseAnonKey}"`,
        `supabase_project_ref="${productionSupabaseProjectRef}"`,
        `supabase_url="${productionPublicBuildConfig.supabaseUrl}"`,
        `run_release_contract_case() {
          local name="$1"
          local release_root="$2"
          local release_sha="$3"
          local mutation_marker="$4"
          local release_contract=
          local status=0
          if release_contract="$(assert_release_contract "$release_root" "$release_sha" '${publicBuildConfigDigest()}')"; then
            : >"$mutation_marker"
          else
            status=$?
          fi
          printf '%s\\t%s\\t%s\\n' "$name" "$status" "$release_contract"
        }`,
        "declare -a release_contract_case_pids=()",
        "declare -a release_contract_case_outcomes=()",
        `while [[ "$#" -ge 4 ]]; do
          outcome_path="$4.outcome"
          run_release_contract_case "$1" "$2" "$3" "$4" >"$outcome_path" &
          release_contract_case_pids+=("$!")
          release_contract_case_outcomes+=("$outcome_path")
          shift 4
        done`,
        '[[ "$#" -eq 0 ]]',
        `for case_pid in "\${release_contract_case_pids[@]}"; do
          wait "$case_pid"
        done`,
        `for outcome_path in "\${release_contract_case_outcomes[@]}"; do
          IFS= read -r outcome <"$outcome_path"
          printf '%s\\n' "$outcome"
        done`,
      ].join("\n"),
      "setlivre-release-contract-test",
      bashPath(scriptPath),
      ...cases.flatMap(({ mutationMarker, name, releaseRoot, releaseSha }) => [
        name,
        bashPath(releaseRoot),
        releaseSha,
        bashPath(mutationMarker),
      ]),
    ],
    {
      encoding: "utf8",
      env: bashTestEnvironment({ TEST_NODE: bashPath(process.execPath) }),
    },
  );
  result.outcomes = new Map(
    result.stdout
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, status, output = ""] = line.split("\t");
        return [name, { output, status: Number(status) }];
      }),
  );
  return result;
}

function callRunSupabaseMigrations({
  previousHead = "none",
  authorizationContractKind = previousHead === "none" ? "baseline" : "incremental",
  authorizationStateExists = false,
  crashAfterMigration = false,
  crashImmediatelyAfterPush = false,
  preflightIsEmpty = true,
  preflightRemoteVersions,
} = {}) {
  const directory = temporaryDirectory();
  const release = resolve(directory, "release");
  const work = resolve(directory, "work");
  const migrations = resolve(release, "supabase/migrations");
  const hostToolsRoot = resolve(directory, "host-tools");
  const hostTools = resolve(hostToolsRoot, "2.113.0");
  const cliSource = resolve(hostTools, "supabase");
  const cliCompanion = resolve(hostTools, "supabase-go");
  const cliLog = resolve(directory, "cli.log");
  const migrationPreflight = resolve(directory, "migration-preflight.json");
  const migrationOutput = resolve(directory, "migration-output.json");
  const migrationListSeen = resolve(directory, "migration-list-seen");
  const capturedOutput = resolve(directory, "captured-output.json");
  const appliedState = resolve(directory, "applied-schema.state");
  const operations = resolve(directory, "operations.log");
  const remoteApplied = resolve(directory, "remote-applied");
  mkdirSync(migrations, { recursive: true });
  mkdirSync(hostTools, { recursive: true });
  mkdirSync(work, { recursive: true });
  const previousVersion = "20260811000100";
  const head = "20260818000100";
  const versions = [previousVersion, head];
  for (const version of versions) {
    writeFileSync(resolve(migrations, `${version}_test.sql`), "select 1;\n");
  }
  const remoteBefore = preflightRemoteVersions ?? (preflightIsEmpty ? [] : versions);
  writeFileSync(migrationPreflight, JSON.stringify(migrationListPayload(versions, remoteBefore)));
  writeFileSync(migrationOutput, JSON.stringify(migrationListPayload(versions)));
  writeFileSync(
    cliSource,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${SUPABASE_ACCESS_TOKEN:-}" == access-secret ]]
[[ "\${SUPABASE_DB_PASSWORD:-}" == database-secret ]]
if [[ "$#" -eq 1 && "$1" == --version ]]; then
  printf '%s\\n' 2.113.0
  exit 0
fi
{
  for argument in "$@"; do
    printf '<%s>' "$argument"
  done
  printf '\\n'
} >>"${bashPath(cliLog)}"
if [[ "$1" == migration && "$2" == list ]]; then
  if [[ ! -e "${bashPath(migrationListSeen)}" ]]; then
    : >"${bashPath(migrationListSeen)}"
    command cat -- "${bashPath(migrationPreflight)}"
  else
    command cat -- "${bashPath(migrationOutput)}"
  fi
fi
if [[ "$1" == db && "$2" == push && "${String(crashImmediatelyAfterPush)}" == true ]]; then
  dry_run=false
  for argument in "$@"; do
    if [[ "$argument" == --dry-run ]]; then
      dry_run=true
    fi
  done
  if [[ "$dry_run" == false ]]; then
    : >"${bashPath(remoteApplied)}"
    kill -KILL "$PPID"
    exit 97
  fi
fi
`,
  );
  writeFileSync(cliCompanion, "companion fixture\n");
  chmodSync(cliSource, 0o755);
  chmodSync(cliCompanion, 0o755);
  const transformedAgent = agentWithHostTools(directory, hostToolsRoot);

  const result = spawnSync(
    bash,
    [
      "-c",
      [
        'source "$1"',
        `supabase_project_ref="${productionSupabaseProjectRef}"`,
        "assert_host_supabase_cli() { :; }",
        'node() { "$TEST_NODE" "$@"; }',
        'work_directory="$2"',
        'supabase_access_token="access-secret"',
        'supabase_db_password="database-secret"',
        "assert_expand_only_delta() { :; }",
        `authorization_contract_node() {
          case "$1" in
            manifest | baseline-manifest)
              printf '%s %s %s\\n' "$TEST_AUTH_PREVIOUS" "$TEST_AUTH_HEAD" "$TEST_AUTH_SHA"
              ;;
            head-compare)
              return 0
              ;;
            *) return 1 ;;
          esac
        }`,
        'authorization_preflight_state_exists() { [[ "$TEST_AUTH_STATE" == true ]]; }',
        `authorization_preflight_metadata() {
          printf '%s %s %s\\n' \
            "$TEST_AUTH_KIND" "$TEST_AUTH_PREVIOUS" "$TEST_AUTH_HEAD"
        }`,
        "capture_authorization_catalog() { :; }",
        "write_authorization_preflight_state() { :; }",
        "restore_authorization_preflight_snapshot() { :; }",
        "assert_authorization_delta() { :; }",
        "assert_authorization_snapshots_equal() { :; }",
        "assert_authorization_head() { :; }",
        "clear_authorization_preflight_state() { :; }",
        "configure_production_runtime_role() { :; }",
        `assert_database_readiness() {
          printf '%s\\n' readiness >>"$TEST_OPERATIONS"
        }`,
        `assert_remote_migration_history() {
          command cp -- "$1" "$TEST_CAPTURED_OUTPUT"
          printf '%s\\n' migration-history >>"$TEST_OPERATIONS"
        }`,
        `write_applied_schema_state() {
          printf 'schema=1\\nmigration_head=%s\\n' "$1" >"$TEST_APPLIED_STATE"
          printf '%s\\n' applied-schema >>"$TEST_OPERATIONS"
        }`,
        'run_supabase_migrations "$3" "$4" "$5"',
        '[[ "$6" != true ]] || exit 75',
      ].join("; "),
      "setlivre-migration-test",
      bashPath(transformedAgent),
      bashPath(work),
      bashPath(release),
      head,
      previousHead,
      String(crashAfterMigration),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_CAPTURED_OUTPUT: bashPath(capturedOutput),
        TEST_APPLIED_STATE: bashPath(appliedState),
        TEST_AUTH_HEAD: head,
        TEST_AUTH_KIND: authorizationContractKind,
        TEST_AUTH_PREVIOUS: authorizationContractKind === "baseline" ? "none" : previousVersion,
        TEST_AUTH_SHA: "d".repeat(64),
        TEST_AUTH_STATE: String(authorizationStateExists),
        TEST_OPERATIONS: bashPath(operations),
        TEST_NODE: bashPath(process.execPath),
      },
    },
  );
  return {
    appliedState,
    capturedOutput,
    cliLog,
    head,
    migrationOutput,
    operations,
    previousVersion,
    remoteApplied,
    result,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("pull-based production deploy agent", () => {
  it("is valid Bash and never checks out or executes repository tooling", () => {
    execFileSync(bash, ["-n", scriptPath]);
    expect(script).not.toContain("actions/checkout");
    expect(script).not.toContain("npm ci");
    expect(script).not.toContain("git checkout");
    expect(script).not.toContain("git clone");
    expect(script).not.toContain("node_modules/.bin/supabase");
    expect(script).toContain(
      "readonly production_smoke=/usr/local/libexec/setlivre/production-smoke.mjs",
    );
    expect(script).toContain("readonly host_tools_root=/usr/local/libexec/setlivre-host-tools");
    expect(script).toContain('local cli="$supabase_cli_path"');
    expect(script).not.toContain("deploy/supabase");
    const migrations = script.slice(
      script.indexOf("run_supabase_migrations() {"),
      script.indexOf(
        "\n}\n\nassert_database_readiness()",
        script.indexOf("run_supabase_migrations() {"),
      ),
    );
    expect(migrations).not.toContain("install -m");
  });

  it("requires the exact fail-closed production environment and redacts it from argv", () => {
    for (const name of [
      "GITHUB_DEPLOY_TOKEN",
      "GITHUB_REPOSITORY_ID",
      "CI_GITHUB_WORKFLOW_ID",
      "PRD_GITHUB_WORKFLOW_ID",
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_DB_PASSWORD",
      "PRD_DATABASE_URL_APP_DAL",
      "PRD_PUBLIC_APP_URL",
      "PRD_BACKOFFICE_APP_URL",
      "PRD_SUPABASE_PROJECT_REF",
      "PRD_SUPABASE_URL",
      "PRD_SUPABASE_ANON_KEY",
      "PRD_DEPLOY_ENABLED",
    ]) {
      expect(script).toContain(name);
    }
    expect(script).toContain('[[ "${PRD_DEPLOY_ENABLED:-}" != true ]]');
    expect(script).toContain('log "Deploy de produção desabilitado."');
    expect(script).toContain('[[ "$supabase_project_ref" =~ ^[a-z0-9]{20}$ ]]');
    expect(script).toContain(
      '[[ "$supabase_url" == "https://${supabase_project_ref}.supabase.co" ]]',
    );
    expect(script).toContain(
      "unset GITHUB_DEPLOY_TOKEN GITHUB_REPOSITORY_ID CI_GITHUB_WORKFLOW_ID",
    );
    expect(script).toContain(
      "unset PRD_GITHUB_WORKFLOW_ID SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD",
    );
    expect(script.match(/curl --disable --config -/gu)).toHaveLength(3);
    expect(script).not.toContain("curl --config -");
    expect(script).not.toContain('--header "Authorization: Bearer $github_token"');
    expect(script).not.toContain('psql "$database_url"');
    expect(script).not.toContain('export SUPABASE_ACCESS_TOKEN="$supabase_access_token"');
    expect(script).not.toContain('export SUPABASE_DB_PASSWORD="$supabase_db_password"');
    expect(script.match(/SUPABASE_ACCESS_TOKEN="\$supabase_access_token"/gu)).toHaveLength(5);
    expect(script.match(/SUPABASE_DB_PASSWORD="\$supabase_db_password"/gu)).toHaveLength(5);
  });

  it("reads systemd credentials byte-for-byte without shell quote or backslash rewriting", () => {
    const directory = temporaryDirectory();
    const credential = resolve(directory, "supabase-db-password");
    const value = `space quote' double" slash\\ dollar$ semicolon;`;
    writeFileSync(credential, value);
    const readCredential = () =>
      spawnSync(
        bash,
        [
          "-c",
          `${bashPythonPrelude}; source "$1"; CREDENTIALS_DIRECTORY="$2"; read_systemd_credential supabase-db-password`,
          "setlivre-credential-round-trip-test",
          bashPath(scriptPath),
          bashPath(directory),
        ],
        { encoding: "utf8", env: bashTestEnvironment() },
      );

    const exact = readCredential();
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.stdout).toBe(value);

    writeFileSync(credential, `${value}\n`);
    expect(readCredential().status).not.toBe(0);
    writeFileSync(credential, "");
    expect(readCredential().status).not.toBe(0);
  });

  it("serializes Node 24 runtime credentials without quote, slash or hash rewriting", () => {
    const directory = temporaryDirectory();
    const runtimeCredential = resolve(directory, "runtime.env");
    const value = ' leading #fragment double" slash\\ dollar$ backtick` trailing ';
    const writeAssignment = (candidate) =>
      spawnSync(
        bash,
        [
          "-c",
          `${bashPythonPrelude}; source "$1"; write_runtime_assignment SPECIAL "$2" >"$3"`,
          "setlivre-runtime-credential-round-trip-test",
          bashPath(scriptPath),
          candidate,
          bashPath(runtimeCredential),
        ],
        { encoding: "utf8", env: bashTestEnvironment() },
      );

    const written = writeAssignment(value);
    expect(written.status, written.stderr).toBe(0);
    expect(readFileSync(runtimeCredential, "utf8")).toBe(`SPECIAL='${value}'\n`);

    const parsed = spawnSync(
      process.execPath,
      [`--env-file=${runtimeCredential}`, "-e", "process.stdout.write(process.env.SPECIAL ?? '')"],
      { encoding: "utf8", env: {} },
    );
    expect(parsed.status, parsed.stderr).toBe(0);
    expect(parsed.stdout).toBe(value);

    expect(writeAssignment("contains'apostrophe").status).not.toBe(0);
    for (const shellLiteral of ["contains\\nnewline", "contains\\rcarriage-return"]) {
      const rejected = spawnSync(
        bash,
        [
          "-c",
          `${bashPythonPrelude}; source "$1"; candidate=$'${shellLiteral}'; write_runtime_assignment SPECIAL "$candidate"`,
          "setlivre-runtime-credential-control-character-test",
          bashPath(scriptPath),
        ],
        { encoding: "utf8", env: bashTestEnvironment() },
      );
      expect(rejected.status).not.toBe(0);
    }
  });

  it("rejects a same-version host CLI with different bytes before reading deployment secrets", () => {
    const directory = temporaryDirectory();
    const hostToolsRoot = resolve(directory, "host-tools");
    const hostTools = resolve(hostToolsRoot, "2.113.0");
    const cli = resolve(hostTools, "supabase");
    const companion = resolve(hostTools, "supabase-go");
    const cliMarker = resolve(directory, "cli-invoked");
    const captureMarker = resolve(directory, "secrets-captured");
    mkdirSync(hostTools, { recursive: true });
    writeFileSync(
      cli,
      `#!/usr/bin/env bash
: >${JSON.stringify(bashPath(cliMarker))}
printf '%s\\n' 2.113.0
`,
    );
    writeFileSync(companion, "different companion bytes\n");
    chmodSync(cli, 0o755);
    chmodSync(companion, 0o755);
    const transformedAgent = agentWithHostTools(directory, hostToolsRoot);

    const result = spawnSync(
      bash,
      [
        "-c",
        [
          'source "$1"',
          "assert_root_tool_directory() { :; }",
          'readlink() { printf "%s\\n" "${!#}"; }',
          'stat() { printf "%s\\n" root:root:755:1; }',
          'capture_environment() { : >"$TEST_CAPTURE_MARKER"; }',
          'SUPABASE_ACCESS_TOKEN="should-not-be-read"',
          'SUPABASE_DB_PASSWORD="should-not-be-read"',
          "main",
        ].join("; "),
        "setlivre-host-cli-digest-test",
        bashPath(transformedAgent),
      ],
      {
        encoding: "utf8",
        env: bashTestEnvironment({ TEST_CAPTURE_MARKER: bashPath(captureMarker) }),
      },
    );

    expect(result.status).not.toBe(0);
    expect(existsSync(cliMarker)).toBe(false);
    expect(existsSync(captureMarker)).toBe(false);
    const main = script.slice(script.indexOf("main() {"));
    expect(main.indexOf("assert_host_supabase_cli")).toBeLessThan(
      main.indexOf("capture_environment"),
    );
  });

  it("behaviorally accepts only the exact modern Supabase publishable-key format", () => {
    const valid = `sb_publishable_${"a".repeat(22)}_${"B".repeat(8)}`;
    expect(callFunction("assert_publishable_key", [valid]).status).toBe(0);
    for (const invalid of [
      `sb_secret_${"a".repeat(22)}_${"b".repeat(8)}`,
      "eyJhbGciOiJIUzI1NiJ9.payload.signature",
      `sb_publishable_${"a".repeat(21)}_${"b".repeat(8)}`,
      `sb_publishable_${"a".repeat(22)}_${"b".repeat(9)}`,
    ]) {
      expect(callFunction("assert_publishable_key", [invalid]).status).not.toBe(0);
    }
  });

  it("behaviorally bounds protocol counters to canonical positive signed-64-bit integers", () => {
    for (const valid of ["1", "9223372036854775807"]) {
      expect(callFunction("assert_positive_integer", [valid]).status).toBe(0);
    }
    for (const invalid of ["0", "01", "-1", "9223372036854775808"]) {
      expect(callFunction("assert_positive_integer", [invalid]).status).not.toBe(0);
    }
  });

  it("removes dead validation surfaces and validates repository identity where the API exposes it", () => {
    expect(script).not.toContain("rejected_artifact_status() {");
    expect(script).not.toContain('operation === "status"');
    const currentMain = script.slice(
      script.indexOf("current_main_sha() {"),
      script.indexOf("recovery_dispatch_decision() {"),
    );
    expect(currentMain).not.toContain("repository_id");
    expect(currentMain).not.toContain("expected_repository_id");
    expect(script).toContain('head_repository.get("id") != repository_id');
    expect(script).toContain('run_repository.get("id") != repository_id');
    expect(script).toContain('workflow_run.get("repository_id") != repository_id');
  });

  it("polls only successful main artifacts from the exact workflow and repository", () => {
    expect(script).toContain("readonly repository=PedroRomeroM/set-livre");
    expect(script).toContain("readonly expected_repository_id=1328339374");
    expect(script).toContain("readonly ci_workflow=ci.yaml");
    expect(script).toContain("readonly prd_workflow=prd-deploy.yaml");
    expect(script).toContain('"/actions/workflows/$prd_github_workflow_id/runs?branch=$branch');
    expect(script).toContain('runs?branch=$branch&status=completed"');
    expect(script).toContain('github_api "${endpoint}&per_page=$api_page_size&page=1"');
    expect(script).toContain("readonly maximum_run_pages=100");
    expect(script).toContain("readonly maximum_artifact_pages=100");
    expect(script).toContain('[[ "${page_summary[*]}" == "${first_summary[*]}" ]]');
    expect(script).toContain("readonly branch=main");
    expect(script).toContain('run.get("status") != "completed"');
    expect(script).toContain('run.get("conclusion") == "success"');
    expect(script).toContain('run.get("head_branch") != branch');
    expect(script).toContain('run.get("event") != "workflow_run"');
    expect(script).toContain('run.get("workflow_id") != workflow_id');
    expect(script).toContain('head_repository.get("full_name") != repository');
    expect(script).toContain('head_repository.get("id") != repository_id');
    expect(script).toContain('run_repository.get("full_name") != repository');
    expect(script).toContain('run_repository.get("id") != repository_id');
    expect(script).toContain('rf"set-livre-{sha}-([0-9a-f]{{64}})-([0-9a-f]{{64}})"');
    expect(script).toContain('artifact.get("expired") is True');
    expect(script).toContain("expires <= datetime.datetime.now(datetime.timezone.utc)");
    expect(script).toContain('workflow_run.get("repository_id") != repository_id');
    expect(script).toContain('re.fullmatch(r"sha256:[0-9a-f]{64}"');
    expect(script).toContain("len(artifacts) != expected_total");
    expect(script).toContain('artifact_page_summary "$stable_page"');
    expect(script).toContain('page_paths+=("$page_path")');
    expect(script).toContain("print(public_build_config_sha256)");
    expect(script).toContain(
      '"/actions/runs/$run_id/attempts/$run_attempt/jobs?per_page=100&page=1"',
    );
    expect(script).toContain('job.name !== "Verify and publish canonical Linux x64 release"');
    expect(script).toContain('job.workflow_name !== "Build production artifact"');
    expect(script).toContain('job.conclusion === "skipped" && job.steps.length === 0');
    expect(script).toContain('job.conclusion === "success" &&');
    expect(script).toContain('step.name === "Publish immutable release artifact"');
    expect(script).toContain('step.conclusion === "success"');
  });

  it("persists exact cleanup targets and blocks a new deploy until recovery completes", () => {
    const directory = temporaryDirectory();
    const workBase = resolve(directory, "work");
    const incomingBase = resolve(directory, "incoming");
    const state = resolve(directory, "cleanup-pending.state");
    mkdirSync(workBase);
    mkdirSync(incomingBase);
    const work = resolve(workBase, "deploy.A1b2C3d4");
    const incoming = resolve(incomingBase, "a".repeat(40));
    writeFileSync(
      state,
      [
        "schema=1",
        `work_directory=${bashPath(work)}`,
        `incoming_directory=${bashPath(incoming)}`,
        "",
      ].join("\n"),
    );
    const parsed = callFunction("parse_cleanup_pending_state", [state, workBase, incomingBase]);
    expect(parsed.status).toBe(0);
    expect(parsed.stdout.trim().split("\n")).toEqual([bashPath(work), bashPath(incoming)]);

    writeFileSync(
      state,
      [
        "schema=1",
        `work_directory=${bashPath(resolve(workBase, "../escape"))}`,
        "incoming_directory=none",
        "",
      ].join("\n"),
    );
    expect(
      callFunction("parse_cleanup_pending_state", [state, workBase, incomingBase]).status,
    ).not.toBe(0);
    expect(script).toContain('readonly cleanup_pending_state="$state_base/cleanup-pending.state"');
    expect(script).toContain("recover_pending_cleanup || fail");
    expect(script).toContain('write_cleanup_pending_state "$candidate_work" "$candidate_incoming"');
    expect(script.indexOf("cleanup_current_resources || fail")).toBeLessThan(
      script.indexOf('log "Release de produção confirmada: $release_sha"'),
    );
  });

  it("recovers only the durably authorized retired deploy tree after an abrupt kill", () => {
    const directory = temporaryDirectory();
    const deployerHome = resolve(directory, "deployer-home");
    const privateBase = resolve(deployerHome, ".setlivre");
    const workBase = resolve(privateBase, "work");
    const incomingBase = resolve(privateBase, "incoming");
    const stateBase = resolve(privateBase, "state");
    const work = resolve(workBase, "deploy.A1b2C3d4");
    const retired = resolve(workBase, ".cleanup-retired-deploy.A1b2C3d4");
    const unrelated = resolve(workBase, "unrelated");
    const transformedScript = resolve(directory, "production-deploy-agent.cleanup-test.sh");
    const user = execFileSync(
      bash,
      ["-c", 'stat -c %U -- "$1"', "setlivre-owner", bashPath(directory)],
      {
        encoding: "utf8",
      },
    ).trim();
    const group = execFileSync(
      bash,
      ["-c", 'stat -c %G -- "$1"', "setlivre-group", bashPath(directory)],
      { encoding: "utf8" },
    ).trim();
    const transformed = script
      .replace(/^readonly deployer_user=.*$/mu, `readonly deployer_user=${JSON.stringify(user)}`)
      .replace(/^readonly deployer_group=.*$/mu, `readonly deployer_group=${JSON.stringify(group)}`)
      .replace(
        /^readonly deployer_home=.*$/mu,
        `readonly deployer_home=${JSON.stringify(bashPath(deployerHome))}`,
      );
    writeFileSync(transformedScript, transformed);
    for (const path of [privateBase, workBase, incomingBase, stateBase, work, unrelated]) {
      mkdirSync(path, { recursive: true });
      chmodSync(path, 0o700);
    }
    writeFileSync(resolve(work, "payload"), "authorized\n");
    writeFileSync(resolve(unrelated, "keep"), "unrelated\n");

    const interrupted = spawnSync(
      bash,
      [
        "-c",
        [
          'source "$1"',
          'work_directory="$2"',
          "incoming_directory=",
          "assert_no_mount_at_or_below() { return 0; }",
          "sync() { return 0; }",
          'mv() { command mv "$@"; local destination="${@: -1}"; if [[ "$destination" == "$work_base/.cleanup-retired-"* ]]; then kill -KILL $$; fi; }',
          "cleanup_current_resources",
        ].join("; "),
        "setlivre-cleanup-crash",
        bashPath(transformedScript),
        bashPath(work),
      ],
      { encoding: "utf8", env: bashTestEnvironment() },
    );
    expect(interrupted.status).not.toBe(0);
    expect(existsSync(resolve(stateBase, "cleanup-pending.state"))).toBe(true);
    expect(existsSync(retired)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);

    const recovered = spawnSync(
      bash,
      [
        "-c",
        [
          'source "$1"',
          "assert_no_mount_at_or_below() { return 0; }",
          "sync() { return 0; }",
          "recover_pending_cleanup",
        ].join("; "),
        "setlivre-cleanup-recovery",
        bashPath(transformedScript),
      ],
      { encoding: "utf8", env: bashTestEnvironment() },
    );
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(existsSync(retired)).toBe(false);
    expect(existsSync(resolve(stateBase, "cleanup-pending.state"))).toBe(false);
    expect(readFileSync(resolve(unrelated, "keep"), "utf8")).toBe("unrelated\n");
  });

  it("retires and revalidates a private tree with no descendant mounts before deletion", () => {
    expect(script).toContain('[[ -d "$candidate" && ! -L "$candidate" ]] || return 1');
    expect(script).toContain(
      '[[ "$(readlink --canonicalize-existing -- "$candidate")" == "$candidate" ]] || return 1',
    );
    expect(script).toContain('== "$deployer_user:$deployer_group:700" ]] || return 1');
    expect(script).toContain(
      '[[ "$(stat -c \'%d\' -- "$candidate")" == "$(stat -c \'%d\' -- "$parent")" ]] || return 1',
    );
    expect(script).toContain('python3 - "$candidate" /proc/self/mountinfo');
    expect(script).toContain('assert_no_mount_at_or_below "$candidate" || return 1');
    expect(script).toContain('local retired="$parent/.cleanup-retired-${candidate##*/}"');
    expect(script.indexOf('cleanup_target_is_authorized "$candidate" "$parent"')).toBeLessThan(
      script.indexOf('mv --no-target-directory --no-clobber -- "$original" "$retired"'),
    );
    expect(script).toContain('[[ ! -e "$original" && ! -L "$original" ]] || return 1');
    expect(script).toContain('candidate="$retired"');
    expect(script).toContain(
      'mv --no-target-directory --no-clobber -- "$original" "$retired" || return 1',
    );
    expect(script.match(/assert_no_mount_at_or_below "\$retired" \|\| return 1/gu)).toHaveLength(2);
    expect(script).toContain('rm -rf --one-file-system -- "$retired" || return 1');
    expect(script).toContain('sync -f "$parent" || return 1');
    expect(script).toContain('[[ ! -e "$retired" && ! -L "$retired" ]] || return 1');
  });

  it("propagates producer failures without process substitution in security boundaries", () => {
    expect(script).not.toMatch(/< <\(/u);
    expect(script).toContain('parsed_targets="$(parse_cleanup_pending_state');
    expect(script).toContain('mapfile -t targets <<<"$parsed_targets" || return 1');
    expect(script).toContain('local connection_pipe="$work_directory/database-connection.pipe"');
    expect(script).toContain('mkfifo -m 0600 -- "$connection_pipe" || fail');
    expect(script).toContain('wait "$parser_pid" || parser_status=$?');
    expect(script).toContain('[[ "$read_status" -eq 0 && "$parser_status" -eq 0 ]] || fail');
  });

  it("fully paginates a first deployment and bounds later scans at the source checkpoint", () => {
    expect(script).toContain('if [[ "$boundary_run_number" -eq 0 ]]; then');
    expect(script).toContain("((page_count <= maximum_run_pages)) || fail");
    expect(script).toContain("page <= page_count && boundary_reached == 0");
    expect(script).toContain("((page <= maximum_run_pages)) || fail");
    expect(script).toContain("((previous_oldest > page_bounds[0])) || fail");
    expect(script).toContain('&& "$previous_oldest" -le "$boundary_run_number" ]]; then');
    expect(script).toContain('if [[ "$boundary_run_number" -gt 0 && "$boundary_reached" -eq 0');
    expect(script).toContain('candidate_runs "$total_count" "${page_paths[@]}"');
    expect(script).toContain("if checkpoint_source_number == 0:");
    expect(script).toContain("[max(normal_runs.values(), key=lambda value:");
  });

  it("finds the canonical source and recovery after one hundred recoveries on page one", () => {
    const directory = temporaryDirectory();
    const pageOne = resolve(directory, "runs-page-1.fixture.json");
    const pageTwo = resolve(directory, "runs-page-2.fixture.json");
    const destination = resolve(directory, "candidates");
    const calls = resolve(directory, "calls.log");
    const releaseSha = "d".repeat(40);
    const recoveryReleaseSha = "b".repeat(40);
    const artifactProviderHeadSha = "c".repeat(40);
    const pageOneRuns = Array.from({ length: 100 }, (_, index) =>
      productionWorkflowRun({
        artifactProviderHeadSha,
        releaseSha: recoveryReleaseSha,
        runId: 20_100 - index,
        runNumber: 202 - index,
        sourceRunId: 30_000 + index,
        type: "recovery",
      }),
    );
    const source = productionWorkflowRun({ releaseSha, runId: 10_100, runNumber: 101 });
    const recovery = productionWorkflowRun({
      artifactProviderHeadSha,
      releaseSha,
      runId: 10_200,
      runNumber: 102,
      sourceRunId: 10_100,
      type: "recovery",
    });
    writeWorkflowPage(pageOne, 102, pageOneRuns);
    writeWorkflowPage(pageTwo, 102, [recovery, source]);

    const result = spawnSync(
      bash,
      [
        "-c",
        [
          bashPythonPrelude,
          'source "$1"',
          'work_directory="$2"',
          'TEST_PAGE_ONE="$3"',
          'TEST_PAGE_TWO="$4"',
          'TEST_CALLS="$5"',
          "prd_github_workflow_id=987654",
          "checkpoint_source_run_number=0",
          `github_api() {
            local endpoint="$1"
            local output="$2"
            case "$endpoint" in
              *"&page=1") command cp -- "$TEST_PAGE_ONE" "$output"; printf '%s\n' 1 >>"$TEST_CALLS" ;;
              *"&page=2") command cp -- "$TEST_PAGE_TWO" "$output"; printf '%s\n' 2 >>"$TEST_CALLS" ;;
              *) return 1 ;;
            esac
          }`,
          'fetch_candidate_runs "$6"',
        ].join("; "),
        "setlivre-first-release-pagination-test",
        bashPath(scriptPath),
        bashPath(directory),
        bashPath(pageOne),
        bashPath(pageTwo),
        bashPath(calls),
        bashPath(destination),
      ],
      { encoding: "utf8", env: bashTestEnvironment() },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(destination, "utf8").trim()).toBe(
      recoveryCandidate(101, 1, 10_100, releaseSha, 102, 1, 10_200, artifactProviderHeadSha),
    );
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["1", "2", "1"]);
  });

  it("uses source identity for checkpoint order and provider identity for provenance", () => {
    const directory = temporaryDirectory();
    const firstSnapshot = resolve(directory, "source-10.json");
    const nextSnapshot = resolve(directory, "source-11.json");
    const sourceRelease = "a".repeat(40);
    const nextRelease = "b".repeat(40);
    const artifactProviderHeadSha = "c".repeat(40);
    const nextProviderHeadSha = "d".repeat(40);
    const sourceRun = productionWorkflowRun({
      artifactProviderHeadSha: nextRelease,
      releaseSha: sourceRelease,
      runId: 100,
      runNumber: 10,
    });
    const recoveryRun = productionWorkflowRun({
      artifactProviderHeadSha,
      releaseSha: sourceRelease,
      runId: 300,
      runNumber: 30,
      sourceRunId: 100,
      type: "recovery",
    });
    const nextRun = productionWorkflowRun({
      artifactProviderHeadSha: nextProviderHeadSha,
      releaseSha: nextRelease,
      runId: 110,
      runNumber: 11,
    });
    writeWorkflowPage(firstSnapshot, 2, [recoveryRun, sourceRun]);
    writeWorkflowPage(nextSnapshot, 3, [recoveryRun, nextRun, sourceRun]);

    const recoveredSource = callCandidateRuns(2, [firstSnapshot]);
    expect(recoveredSource.status, recoveredSource.stderr).toBe(0);
    expect(recoveredSource.stdout.trim()).toBe(
      recoveryCandidate(
        10,
        1,
        100,
        sourceRelease,
        30,
        1,
        300,
        artifactProviderHeadSha,
        undefined,
        undefined,
        undefined,
        nextRelease,
      ),
    );

    const nextSource = callCandidateRuns(3, [nextSnapshot], {
      releaseSha: sourceRelease,
      sourceRunAttempt: 1,
      sourceRunId: 100,
      sourceRunNumber: 10,
    });
    expect(nextSource.status, nextSource.stderr).toBe(0);
    expect(nextSource.stdout.trim()).toBe(
      normalCandidate(11, 1, 110, nextRelease, "2026-08-18T00:00:00Z", nextProviderHeadSha),
    );

    const invalidCheckpoint = resolve(directory, "invalid-checkpoint.json");
    writeWorkflowPage(invalidCheckpoint, 1, [{ ...sourceRun, conclusion: "failure" }]);
    expect(
      callCandidateRuns(1, [invalidCheckpoint], {
        releaseSha: sourceRelease,
        sourceRunAttempt: 1,
        sourceRunId: 100,
        sourceRunNumber: 10,
      }).status,
    ).not.toBe(0);

    const forgedRepository = resolve(directory, "forged-repository.json");
    writeWorkflowPage(forgedRepository, 1, [
      { ...nextRun, repository: { full_name: "PedroRomeroM/set-livre", id: 999 } },
    ]);
    expect(callCandidateRuns(1, [forgedRepository]).status).not.toBe(0);

    const selected = callSelectArtifact(
      candidateSet(
        recoveryCandidate(10, 1, 100, sourceRelease, 30, 1, 300, artifactProviderHeadSha),
      ),
      "none",
    );
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout.trim()).toBe(
      selectedArtifact(10, 1, 100, sourceRelease, "20260818000100", 30, 1, 300),
    );
    expect(selected.metadataCalls).toEqual(["100", "300"]);
  });

  it("finds a matching recovery on page two without dispatching a duplicate", () => {
    const directory = temporaryDirectory();
    const pageOne = resolve(directory, "recovery-page-1.fixture.json");
    const pageTwo = resolve(directory, "recovery-page-2.fixture.json");
    const calls = resolve(directory, "recovery-calls.log");
    const dispatchMarker = resolve(directory, "unexpected-dispatch");
    const releaseSha = "a".repeat(40);
    const mainSha = "f".repeat(40);
    const pageOneRuns = Array.from({ length: 100 }, (_, index) =>
      recoveryWorkflowRun({
        headSha: mainSha,
        releaseSha: "b".repeat(40),
        runId: 20_100 - index,
        runNumber: 201 - index,
        sourceRunId: 30_000 + index,
      }),
    );
    const matchingRecovery = recoveryWorkflowRun({
      headSha: mainSha,
      releaseSha,
      runId: 10_100,
      runNumber: 101,
      sourceRunId: 100,
    });
    writeWorkflowPage(pageOne, 101, pageOneRuns);
    writeWorkflowPage(pageTwo, 101, [matchingRecovery]);

    const result = spawnSync(
      bash,
      [
        "-c",
        [
          bashPythonPrelude,
          'source "$1"',
          'work_directory="$2"',
          'TEST_PAGE_ONE="$3"',
          'TEST_PAGE_TWO="$4"',
          'TEST_CALLS="$5"',
          'TEST_DISPATCH_MARKER="$6"',
          'TEST_MAIN_SHA="$7"',
          "ci_github_workflow_id=987653",
          'current_main_sha() { printf "%s\\n" "$TEST_MAIN_SHA"; }',
          `github_api() {
            local endpoint="$1"
            local output="$2"
            case "$endpoint" in
              *"&page=1") command cp -- "$TEST_PAGE_ONE" "$output"; printf '%s\n' 1 >>"$TEST_CALLS" ;;
              *"&page=2") command cp -- "$TEST_PAGE_TWO" "$output"; printf '%s\n' 2 >>"$TEST_CALLS" ;;
              *) return 1 ;;
            esac
          }`,
          'github_api_post() { : >"$TEST_DISPATCH_MARKER"; }',
          `request_artifact_recovery 100 1 "$8" '${canonicalArchiveSha256}' '${canonicalPublicBuildConfigSha256}' "2026-08-18T00:00:00Z"`,
        ].join("; "),
        "setlivre-recovery-pagination-test",
        bashPath(scriptPath),
        bashPath(directory),
        bashPath(pageOne),
        bashPath(pageTwo),
        bashPath(calls),
        bashPath(dispatchMarker),
        mainSha,
        releaseSha,
      ],
      { encoding: "utf8", env: bashTestEnvironment() },
    );

    expect(result.status, result.stderr).toBe(3);
    expect(existsSync(dispatchMarker)).toBe(false);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["1", "2", "1"]);
  });

  it("deploys only the oldest descendant after the authoritative durable checkpoint", () => {
    expect(script).toContain('github_api "/compare/${current_sha}...${release_sha}"');
    expect(script).toContain('status == "ahead" and merge_base.get("sha") == current');
    expect(script).toContain('status == "behind" and merge_base.get("sha") == target');
    expect(script).toContain('[[ "$relation" == ahead ]] || fail');
    expect(script).toContain('if [[ "$relation" == behind ]]');
    expect(script).not.toContain("checkpoint_seen");
    expect(script).toContain('if [[ "$current_sha" != none && "$release_sha" == "$current_sha" ]]');
    expect(script).toContain("load_deployed_state");
    expect(script).toContain("schema=2");
    expect(script).toContain('[[ ! -e "$deployed_state" && ! -L "$deployed_state" ]] || fail');
    expect(script).toContain("if run_number == checkpoint_source_number and (");
    expect(script).toContain("normal_match is None");
    expect(script).toContain("identifier != checkpoint_source_id");
    expect(script).toContain('run.get("conclusion") != "success"');
    expect(script).toContain("normal_match.group(1) != checkpoint_sha");
    expect(script).toContain('manager_checkpoint_payload="$(sudo -n "$dispatcher" checkpoint)"');
    expect(script).toContain(
      'printf \'%s\\n\' "$manager_checkpoint_payload" >"$manager_checkpoint"',
    );
    expect(script).toContain("parse_manager_checkpoint");
    expect(script).toContain('if [[ "$local_checkpoint" != "$authoritative" ]]');
  });

  it("behaviorally parses only the exact deployed.state schema 2 grammar", () => {
    const directory = temporaryDirectory();
    const state = resolve(directory, "deployed.state");
    const sha = "a".repeat(40);
    const digest = "b".repeat(64);
    const archive = "c".repeat(64);
    const lock = "d".repeat(64);
    writeFileSync(
      state,
      [
        "schema=2",
        `release_sha=${sha}`,
        "run_number=12",
        "run_attempt=2",
        "run_id=34",
        "artifact_id=56",
        `artifact_digest=${digest}`,
        `archive_sha=${archive}`,
        `lock_sha=${lock}`,
        "migration_head=20260818000100",
        "",
      ].join("\n"),
    );
    const valid = callFunction("parse_deployed_state", [state]);
    expect(valid.status).toBe(0);
    expect(valid.stdout.trim()).toBe(
      `${sha} 12 2 34 56 ${digest} ${archive} ${lock} 20260818000100`,
    );

    writeFileSync(
      state,
      [
        "schema=2",
        `release_sha=${sha}`,
        "run_attempt=2",
        "run_number=12",
        "run_id=34",
        "artifact_id=56",
        `artifact_digest=${digest}`,
        `archive_sha=${archive}`,
        `lock_sha=${lock}`,
        "migration_head=20260818000100",
        "",
      ].join("\n"),
    );
    expect(callFunction("parse_deployed_state", [state]).status).not.toBe(0);
  });

  it("behaviorally parses only an exact root-owned protocol-v3 checkpoint", () => {
    const directory = temporaryDirectory();
    const checkpoint = resolve(directory, "manager.checkpoint");
    const sha = "a".repeat(40);
    const artifact = "b".repeat(64);
    const archive = "c".repeat(64);
    const lock = "d".repeat(64);
    writeFileSync(
      checkpoint,
      [
        "protocol=3",
        `release_sha=${sha}`,
        `archive_sha=${archive}`,
        `lock_sha=${lock}`,
        "migration_head=20260818000100",
        "run_number=12",
        "run_attempt=2",
        "run_id=34",
        "artifact_id=56",
        `artifact_digest=${artifact}`,
        "",
      ].join("\n"),
    );
    const valid = callFunction("parse_manager_checkpoint", [checkpoint]);
    expect(valid.status).toBe(0);
    expect(valid.stdout.trim()).toBe(
      `${sha} 12 2 34 56 ${artifact} ${archive} ${lock} 20260818000100`,
    );

    writeFileSync(checkpoint, "none\n");
    const empty = callFunction("parse_manager_checkpoint", [checkpoint]);
    expect(empty.status).toBe(0);
    expect(empty.stdout.trim()).toBe("none");
  });

  it("tolerates aged-out checkpoints and duplicate current SHAs without accepting divergence", () => {
    const current = "a".repeat(40);
    const next = "b".repeat(40);
    const later = "d".repeat(40);
    const migrationHead = "20260818000100";
    const exactCheckpoint = normalCandidate(9, 1, 90, current);
    const forward = callSelectArtifact(
      candidateSet(exactCheckpoint, normalCandidate(10, 1, 100, next)),
      current,
    );
    expect(forward.status).toBe(0);
    expect(forward.stdout.trim()).toBe(selectedArtifact(10, 1, 100, next, migrationHead));

    const afterHarmlessRerun = callSelectArtifact(
      candidateSet(normalCandidate(9, 2, 90, current), normalCandidate(10, 1, 100, next)),
      current,
    );
    expect(afterHarmlessRerun.status).toBe(0);
    expect(afterHarmlessRerun.stdout.trim()).toBe(
      selectedArtifact(10, 1, 100, next, migrationHead),
    );

    const afterDuplicateCurrent = callSelectArtifact(
      candidateSet(normalCandidate(10, 1, 100, current), normalCandidate(11, 1, 110, later)),
      current,
    );
    expect(afterDuplicateCurrent.status).toBe(0);
    expect(afterDuplicateCurrent.stdout.trim()).toBe(
      selectedArtifact(11, 1, 110, later, migrationHead),
    );

    const duplicateOnly = callSelectArtifact(
      candidateSet(normalCandidate(10, 1, 100, current)),
      current,
    );
    expect(duplicateOnly.status).toBe(2);

    const agedOutCheckpoint = callSelectArtifact(
      candidateSet(normalCandidate(10, 1, 100, next)),
      current,
    );
    expect(agedOutCheckpoint.status).toBe(0);
    expect(agedOutCheckpoint.stdout.trim()).toBe(selectedArtifact(10, 1, 100, next, migrationHead));

    expect(
      callSelectArtifact(
        candidateSet(exactCheckpoint, normalCandidate(10, 1, 100, next)),
        current,
        "behind",
      ).status,
    ).not.toBe(0);
    expect(
      callSelectArtifact(
        candidateSet(exactCheckpoint, normalCandidate(10, 1, 100, next)),
        current,
        "ahead",
        "missing",
      ).status,
    ).not.toBe(0);

    const disabled = "e".repeat(40);
    const afterDisabled = callSelectArtifact(
      candidateSet(normalCandidate(10, 1, 100, disabled), normalCandidate(11, 1, 110, later)),
      current,
      "ahead",
      "missing:100",
      "100",
    );
    expect(afterDisabled.status).toBe(0);
    expect(afterDisabled.stdout.trim()).toBe(selectedArtifact(11, 1, 110, later, migrationHead));
    expect(
      callSelectArtifact(
        candidateSet(normalCandidate(10, 1, 100, disabled), normalCandidate(11, 1, 110, later)),
        current,
        "ahead",
        "missing:100",
      ).status,
    ).not.toBe(0);
  });

  it("skips only an exact rejected artifact identity and reaches its forward fix", () => {
    const current = "a".repeat(40);
    const rejected = "b".repeat(40);
    const forwardFix = "d".repeat(40);
    const digest = "c".repeat(64);
    const rejectedHead = "20260818000200";
    const rejectedIdentity = `${rejected} 10 1 100 200 ${digest}`;
    const candidates = candidateSet(
      normalCandidate(10, 1, 100, rejected),
      normalCandidate(11, 1, 110, forwardFix),
    );
    const selected = callSelectArtifact(
      candidates,
      current,
      "ahead",
      "present",
      "none",
      rejectedIdentity,
    );
    expect(selected.status).toBe(0);
    expect(selected.stdout.trim()).toBe(
      selectedArtifact(11, 1, 110, forwardFix, rejectedHead, 11, 1, 110, 200, digest),
    );
    expect(selected.metadataCalls).toEqual(["110"]);

    const afterRejectedArtifactAgedOut = callSelectArtifact(
      candidates,
      current,
      "ahead",
      "missing:100",
      "none",
      rejectedIdentity,
      rejectedHead,
    );
    expect(afterRejectedArtifactAgedOut.status).toBe(0);
    expect(afterRejectedArtifactAgedOut.stdout.trim()).toBe(
      selectedArtifact(11, 1, 110, forwardFix, rejectedHead, 11, 1, 110, 200, digest),
    );
    expect(afterRejectedArtifactAgedOut.metadataCalls).toEqual(["110"]);

    const distinctRun = callSelectArtifact(
      candidateSet(normalCandidate(10, 2, 101, rejected)),
      current,
      "ahead",
      "present",
      "none",
      rejectedIdentity,
    );
    expect(distinctRun.status).toBe(0);
    expect(distinctRun.stdout.trim()).toBe(
      selectedArtifact(10, 2, 101, rejected, rejectedHead, 10, 2, 101, 200, digest),
    );

    const sameDurableRunWithDifferentArtifact = callSelectArtifact(
      candidateSet(normalCandidate(10, 1, 100, rejected)),
      current,
      "ahead",
      "present",
      "none",
      `${rejected} 10 1 100 201 ${digest}`,
    );
    expect(sameDurableRunWithDifferentArtifact.status).toBe(2);
    expect(sameDurableRunWithDifferentArtifact.metadataCalls).toEqual([]);

    const appliedHead = "20260818000300";
    const selectedWithEverySchemaSource = callSelectArtifact(
      candidates,
      current,
      "ahead",
      "present",
      "none",
      rejectedIdentity,
      rejectedHead,
      appliedHead,
    );
    expect(selectedWithEverySchemaSource.status).toBe(0);
    expect(selectedWithEverySchemaSource.stdout.trim()).toBe(
      selectedArtifact(11, 1, 110, forwardFix, appliedHead, 11, 1, 110, 200, digest),
    );

    const staleRejectedHead = callSelectArtifact(
      candidates,
      current,
      "ahead",
      "present",
      "none",
      rejectedIdentity,
      "20260817000100",
    );
    expect(staleRejectedHead.status).toBe(0);
    expect(staleRejectedHead.stdout.trim()).toBe(
      selectedArtifact(11, 1, 110, forwardFix, "20260818000100", 11, 1, 110, 200, digest),
    );
  });

  it("parses a bounded exact rejected-artifact ledger", () => {
    const directory = temporaryDirectory();
    const state = resolve(directory, "rejected-artifacts.state");
    const release = "b".repeat(40);
    const digest = "c".repeat(64);
    const migrationHead = "20260818000200";
    const record = `${release} 10 1 100 200 ${digest} ${migrationHead}`;
    const durableStatus = (...identity) =>
      runNodeHeredoc("REJECTED_ARTIFACTS_NODE", [state, "100000", "identity-status", ...identity]);
    const head = (checkpoint) =>
      runNodeHeredoc("REJECTED_ARTIFACTS_NODE", [state, "100000", "head", checkpoint]);

    writeFileSync(state, `schema=1\n${record}\n`);
    const rejected = durableStatus(release, "10", "1", "100");
    expect(rejected.status).toBe(0);
    expect(rejected.stdout).toBe(`rejected 200 ${digest} ${migrationHead}\n`);
    expect(head("20260818000100").stdout).toBe(`${migrationHead}\n`);
    expect(head("20260818000300").stdout).toBe("20260818000300\n");

    expect(durableStatus(release, "10", "1", "101").stdout).toBe("eligible\n");

    writeFileSync(state, `schema=1\n${record}\n${record}\n`);
    expect(durableStatus(release, "10", "1", "100").status).not.toBe(0);
    writeFileSync(state, `schema=1\n${record}\n${release} 10 1 100 200 ${digest} 20260818000300\n`);
    expect(durableStatus(release, "10", "1", "100").status).not.toBe(0);
    writeFileSync(
      state,
      `schema=1\n${record}\n${release} 10 1 100 201 ${"d".repeat(64)} 20260818000300\n`,
    );
    expect(durableStatus(release, "10", "1", "100").status).not.toBe(0);
    writeFileSync(state, `schema=2\n${record}\n`);
    expect(durableStatus(release, "10", "1", "100").status).not.toBe(0);
    writeFileSync(state, `schema=1\n${record}`);
    expect(durableStatus(release, "10", "1", "100").status).not.toBe(0);
  });

  it("parses only an exact applied-schema checkpoint", () => {
    const directory = temporaryDirectory();
    const state = resolve(directory, "applied-schema.state");
    const head = "20260818000200";
    const parse = () => runNodeHeredoc("APPLIED_SCHEMA_NODE", [state]);

    writeFileSync(state, `schema=1\nmigration_head=${head}\n`);
    expect(parse().status).toBe(0);
    expect(parse().stdout).toBe(`${head}\n`);

    for (const invalid of [
      `schema=2\nmigration_head=${head}\n`,
      `schema=1\nmigration_head=${head}`,
      "schema=1\nmigration_head=none\n",
      `schema=1\nmigration_head=${head}\nunexpected=true\n`,
    ]) {
      writeFileSync(state, invalid);
      expect(parse().status).not.toBe(0);
    }
  });

  it("records rejection only after the manager proves its authoritative rollback smoke", () => {
    const directory = temporaryDirectory();
    const operations = resolve(directory, "operations.log");
    const failed = "b".repeat(40);
    const recovered = "a".repeat(40);
    const digest = "c".repeat(64);
    const result = spawnSync(
      bash,
      [
        "-c",
        [
          'source "$1"',
          "monotonic_seconds() { printf '%s\\n' 1; }",
          `sudo() {
            case "$3" in
              activate) printf '%s %s\\n' "$TEST_RECOVERED_SHA" 999999999999999999 ;;
              rollback) printf '%s\\n' rollback >>"$TEST_OPERATIONS" ;;
              activation-result) printf 'rejected %s\\n' "$TEST_RECOVERED_SHA" ;;
              confirm) printf '%s\\n' confirm >>"$TEST_OPERATIONS" ;;
              *) return 1 ;;
            esac
          }`,
          `run_smoke() {
            if [[ "$1" == "$TEST_FAILED_SHA" ]]; then
              printf '%s\\n' candidate-smoke-failed >>"$TEST_OPERATIONS"
              return 1
            fi
            return 1
          }`,
          `record_rejected_artifact() {
            printf 'recorded %s\\n' "$*" >>"$TEST_OPERATIONS"
          }`,
          'activate_release "$TEST_FAILED_SHA" "' +
            "d".repeat(64) +
            '" "' +
            "e".repeat(64) +
            '" 20260818000200 10 1 100 30 2 300 200 "$TEST_DIGEST"',
        ].join("; "),
        "setlivre-rejected-test",
        bashPath(scriptPath),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_DIGEST: digest,
          TEST_FAILED_SHA: failed,
          TEST_OPERATIONS: bashPath(operations),
          TEST_RECOVERED_SHA: recovered,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(operations, "utf8").trim().split("\n")).toEqual([
      "candidate-smoke-failed",
      "rollback",
      `recorded ${failed} 30 2 300 200 ${digest} 20260818000200`,
    ]);
  });

  it("records a failed first-deploy artifact immediately after the proven rollback", () => {
    const directory = temporaryDirectory();
    const operations = resolve(directory, "first-deploy-operations.log");
    const failed = "b".repeat(40);
    const digest = "c".repeat(64);
    const result = spawnSync(
      bash,
      [
        "-c",
        [
          'source "$1"',
          "monotonic_seconds() { printf '%s\\n' 1; }",
          `sudo() {
            case "$3" in
              activate) printf '%s %s\\n' none 999999999999999999 ;;
              rollback) printf '%s\\n' rollback >>"$TEST_OPERATIONS" ;;
              activation-result) printf '%s\\n' 'rejected none' ;;
              confirm) printf '%s\\n' confirm >>"$TEST_OPERATIONS" ;;
              *) return 1 ;;
            esac
          }`,
          `run_smoke() {
            [[ "$1" == "$TEST_FAILED_SHA" ]] || return 1
            printf '%s\\n' candidate-smoke-failed >>"$TEST_OPERATIONS"
            return 1
          }`,
          `record_rejected_artifact() {
            printf 'recorded %s\\n' "$*" >>"$TEST_OPERATIONS"
          }`,
          'activate_release "$TEST_FAILED_SHA" "' +
            "d".repeat(64) +
            '" "' +
            "e".repeat(64) +
            '" 20260818000200 10 1 100 30 2 300 200 "$TEST_DIGEST"',
        ].join("; "),
        "setlivre-first-deploy-rejected-test",
        bashPath(scriptPath),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_DIGEST: digest,
          TEST_FAILED_SHA: failed,
          TEST_OPERATIONS: bashPath(operations),
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(operations, "utf8").trim().split("\n")).toEqual([
      "candidate-smoke-failed",
      "rollback",
      `recorded ${failed} 30 2 300 200 ${digest} 20260818000200`,
    ]);
  });

  it("records only after green migrations when the N-1 compatibility smoke fails", () => {
    const directory = temporaryDirectory();
    const operations = resolve(directory, "compatibility-operations.log");
    const failed = "b".repeat(40);
    const current = "a".repeat(40);
    const digest = "c".repeat(64);
    const result = spawnSync(
      bash,
      [
        "-c",
        [
          'source "$1"',
          `run_supabase_migrations() {
            printf '%s\\n' migrations-green >>"$TEST_OPERATIONS"
          }`,
          `run_smoke() {
            [[ "$1" == "$TEST_CURRENT_SHA" ]] || return 1
            printf '%s\\n' compatibility-smoke-failed >>"$TEST_OPERATIONS"
            return 1
          }`,
          `record_rejected_artifact() {
            printf 'recorded %s\\n' "$*" >>"$TEST_OPERATIONS"
          }`,
          'prepare_release_schema /release 20260818000200 20260818000100 "$TEST_CURRENT_SHA" "$TEST_FAILED_SHA" 30 2 300 200 "$TEST_DIGEST"',
        ].join("; "),
        "setlivre-compatibility-rejected-test",
        bashPath(scriptPath),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_CURRENT_SHA: current,
          TEST_DIGEST: digest,
          TEST_FAILED_SHA: failed,
          TEST_OPERATIONS: bashPath(operations),
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(operations, "utf8").trim().split("\n")).toEqual([
      "migrations-green",
      "compatibility-smoke-failed",
      `recorded ${failed} 30 2 300 200 ${digest} 20260818000200`,
    ]);

    const ambiguousOperations = resolve(directory, "ambiguous-migrations.log");
    const ambiguous = spawnSync(
      bash,
      [
        "-c",
        [
          'source "$1"',
          `run_supabase_migrations() {
            printf '%s\\n' migrations-ambiguous >>"$TEST_OPERATIONS"
            return 1
          }`,
          `run_smoke() {
            printf '%s\\n' unexpected-smoke >>"$TEST_OPERATIONS"
          }`,
          `record_rejected_artifact() {
            printf '%s\\n' unexpected-record >>"$TEST_OPERATIONS"
          }`,
          'prepare_release_schema /release 20260818000200 20260818000100 "$TEST_CURRENT_SHA" "$TEST_FAILED_SHA" 30 2 300 200 "$TEST_DIGEST"',
        ].join("; "),
        "setlivre-ambiguous-migrations-test",
        bashPath(scriptPath),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_CURRENT_SHA: current,
          TEST_DIGEST: digest,
          TEST_FAILED_SHA: failed,
          TEST_OPERATIONS: bashPath(ambiguousOperations),
        },
      },
    );
    expect(ambiguous.status).not.toBe(0);
    expect(readFileSync(ambiguousOperations, "utf8")).toBe("migrations-ambiguous\n");
  });

  it("records an activation error only when the manager proves the prior checkpoint", () => {
    const failed = "b".repeat(40);
    const current = "a".repeat(40);
    const digest = "c".repeat(64);
    const checkpointDigest = "f".repeat(64);
    const archive = "1".repeat(64);
    const lock = "2".repeat(64);
    const safeCheckpoint = [
      "protocol=3",
      `release_sha=${current}`,
      `archive_sha=${archive}`,
      `lock_sha=${lock}`,
      "migration_head=20260818000100",
      "run_number=9",
      "run_attempt=1",
      "run_id=90",
      "artifact_id=190",
      `artifact_digest=${checkpointDigest}`,
    ].join("\n");
    const attempt = (checkpointPayload, label) => {
      const directory = temporaryDirectory();
      const operations = resolve(directory, `${label}.log`);
      const result = spawnSync(
        bash,
        [
          "-c",
          [
            'source "$1"',
            'work_directory="$2"',
            'checkpoint_release_sha="$TEST_CURRENT_SHA"',
            "checkpoint_source_run_number=9",
            "checkpoint_source_run_attempt=1",
            "checkpoint_source_run_id=90",
            "checkpoint_artifact_id=190",
            'checkpoint_artifact_digest="$TEST_CHECKPOINT_DIGEST"',
            'checkpoint_archive_sha="$TEST_ARCHIVE_SHA"',
            'checkpoint_lock_sha="$TEST_LOCK_SHA"',
            "checkpoint_migration_head=20260818000100",
            `sudo() {
              case "$3" in
                activate)
                  printf '%s\\n' activate-error >>"$TEST_OPERATIONS"
                  return 1
                  ;;
                checkpoint)
                  printf '%s\\n' checkpoint-proof >>"$TEST_OPERATIONS"
                  printf '%s\\n' "$TEST_CHECKPOINT_PAYLOAD"
                  ;;
                *) return 1 ;;
              esac
            }`,
            `record_rejected_artifact() {
              printf 'recorded %s\\n' "$*" >>"$TEST_OPERATIONS"
            }`,
            `run_smoke() {
              printf '%s\\n' unexpected-smoke >>"$TEST_OPERATIONS"
              return 1
            }`,
            'activate_release "$TEST_FAILED_SHA" "' +
              "d".repeat(64) +
              '" "' +
              "e".repeat(64) +
              '" 20260818000200 10 1 100 30 2 300 200 "$TEST_DIGEST"',
          ].join("; "),
          "setlivre-activation-error-test",
          bashPath(scriptPath),
          bashPath(directory),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_ARCHIVE_SHA: archive,
            TEST_CHECKPOINT_DIGEST: checkpointDigest,
            TEST_CHECKPOINT_PAYLOAD: checkpointPayload,
            TEST_CURRENT_SHA: current,
            TEST_DIGEST: digest,
            TEST_FAILED_SHA: failed,
            TEST_LOCK_SHA: lock,
            TEST_OPERATIONS: bashPath(operations),
          },
        },
      );
      return { operations, result };
    };

    const safe = attempt(safeCheckpoint, "safe-checkpoint");
    expect(safe.result.status).not.toBe(0);
    expect(readFileSync(safe.operations, "utf8").trim().split("\n")).toEqual([
      "activate-error",
      "checkpoint-proof",
      `recorded ${failed} 30 2 300 200 ${digest} 20260818000200`,
    ]);

    const ambiguous = attempt("none", "ambiguous-checkpoint");
    expect(ambiguous.result.status).not.toBe(0);
    expect(readFileSync(ambiguous.operations, "utf8").trim().split("\n")).toEqual([
      "activate-error",
      "checkpoint-proof",
    ]);
  });

  it("keeps applied schema across a pre-confirmation crash and resumes the same run", () => {
    const migrated = callRunSupabaseMigrations();
    expect(migrated.result.status, migrated.result.stderr).toBe(0);
    const appliedBeforeCrash = readFileSync(migrated.appliedState, "utf8");
    const migrationHead = "20260818000100";
    expect(appliedBeforeCrash).toBe(`schema=1\nmigration_head=${migrationHead}\n`);

    const directory = temporaryDirectory();
    const operations = resolve(directory, "pre-confirmation.log");
    const release = "b".repeat(40);
    const digest = "c".repeat(64);
    const activation = spawnSync(
      bash,
      [
        "-c",
        [
          'source "$1"',
          "monotonic_seconds() { printf '%s\\n' 1; }",
          `sudo() {
            case "$3" in
              activate)
                printf '%s\\n' activate >>"$TEST_OPERATIONS"
                printf '%s %s\\n' none 999999999999999999
                ;;
              confirm)
                printf '%s\\n' confirmation-crash >>"$TEST_OPERATIONS"
                return 75
                ;;
              *) return 1 ;;
            esac
          }`,
          `run_smoke() {
            printf '%s\\n' candidate-smoke-passed >>"$TEST_OPERATIONS"
          }`,
          'activate_release "$TEST_RELEASE_SHA" "' +
            "d".repeat(64) +
            '" "' +
            "e".repeat(64) +
            `" ${migrationHead} 10 1 100 30 2 300 200 "$TEST_DIGEST"`,
        ].join("; "),
        "setlivre-pre-confirmation-crash-test",
        bashPath(scriptPath),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_DIGEST: digest,
          TEST_OPERATIONS: bashPath(operations),
          TEST_RELEASE_SHA: release,
        },
      },
    );
    expect(activation.status).not.toBe(0);
    expect(readFileSync(operations, "utf8").trim().split("\n")).toEqual([
      "activate",
      "candidate-smoke-passed",
      "confirmation-crash",
    ]);
    expect(readFileSync(migrated.appliedState, "utf8")).toBe(appliedBeforeCrash);

    const selected = callSelectArtifact(
      candidateSet(normalCandidate(10, 1, 100, release)),
      "none",
      "ahead",
      "present",
      "none",
      "",
      "20260818000200",
      migrationHead,
    );
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout.trim()).toBe(
      selectedArtifact(10, 1, 100, release, migrationHead, 10, 1, 100, 200, digest),
    );

    const resumed = callRunSupabaseMigrations({
      preflightIsEmpty: false,
      previousHead: migrationHead,
    });
    expect(resumed.result.status, resumed.result.stderr).toBe(0);
    expect(readFileSync(resumed.cliLog, "utf8")).not.toContain("<db><push>");
  });

  it("behaviorally distinguishes skipped, successful and malformed publish jobs", () => {
    const directory = temporaryDirectory();
    const jobs = resolve(directory, "jobs.json");
    const sha = "a".repeat(40);
    const repositoryName = "PedroRomeroM/set-livre";
    const job = {
      conclusion: "skipped",
      head_branch: "main",
      head_sha: sha,
      id: 42,
      name: "Verify and publish canonical Linux x64 release",
      run_id: 9,
      run_url: `https://api.github.com/repos/${repositoryName}/actions/runs/9`,
      status: "completed",
      steps: [],
      url: `https://api.github.com/repos/${repositoryName}/actions/jobs/42`,
      workflow_name: "Build production artifact",
    };
    writeFileSync(jobs, JSON.stringify({ jobs: [job], total_count: 1 }));
    const exactJob = runNodeHeredoc("PUBLISH_JOB_NODE", [jobs, repositoryName, "9", sha]);
    expect(exactJob.status).toBe(0);
    expect(exactJob.stdout.trim()).toBe("skipped");

    writeFileSync(
      jobs,
      JSON.stringify({
        jobs: [
          {
            ...job,
            conclusion: "success",
            steps: [{ conclusion: "success", name: "Publish immutable release artifact" }],
          },
        ],
        total_count: 1,
      }),
    );
    const successful = runNodeHeredoc("PUBLISH_JOB_NODE", [jobs, repositoryName, "9", sha]);
    expect(successful.status).toBe(0);
    expect(successful.stdout.trim()).toBe("success");

    writeFileSync(
      jobs,
      JSON.stringify({ jobs: [{ ...job, conclusion: "success" }], total_count: 1 }),
    );
    expect(runNodeHeredoc("PUBLISH_JOB_NODE", [jobs, repositoryName, "9", sha]).status).not.toBe(0);
    writeFileSync(jobs, JSON.stringify({ jobs: [job, { ...job, id: 43 }], total_count: 2 }));
    expect(runNodeHeredoc("PUBLISH_JOB_NODE", [jobs, repositoryName, "9", sha]).status).not.toBe(0);
  });

  it("validates ZIP, sidecar, TAR, manifest, x86_64 CLI and migration head before execution", () => {
    expect(script).toContain("if len(members) != 2:");
    expect(script).toContain("member.flag_bits & 1");
    expect(script).toContain("member.file_size / member.compress_size > 200");
    expect(script).toContain('parts[0] != "release"');
    expect(script).toContain("not (member.isfile() or member.isdir())");
    expect(script).toContain("if set(manifest) != {");
    expect(script).toContain('manifest.get("schemaVersion") != 4');
    expect(script).toContain('manifest.get("publicBuildConfigSha256") !=');
    expect(script).toContain('re.fullmatch(r"[0-9a-f]{64}"');
    expect(script).not.toContain("supabaseCli");
    expect(script).not.toContain('manifest.get("deployment")');
    expect(script).toContain('manifest.get("runtime") != {"arch": "x64"');
    expect(script).toContain('config_path = os.path.join(root, "supabase", "config.toml")');
    expect(script).not.toContain('cli_path = os.path.join(root, "deploy", "supabase")');
    expect(script).toContain('struct.unpack("<H", header[18:20])[0] != 62');
    expect(script).toContain('[[ "$version" == "$expected_supabase_version" ]]');
    expect(script).toContain('assert_root_host_tool "$supabase_cli_path" "$supabase_cli_sha256"');
    expect(script).toContain('assert_root_host_tool "$supabase_go_path" "$supabase_go_sha256"');
    expect(script).toContain('migrations.get("mode") != "expand-only"');
    const contract = script.lastIndexOf('release_contract="$(assert_release_contract');
    const migrations = script.lastIndexOf("  prepare_release_schema \\");
    const staging = script.lastIndexOf('  stage_activation "$archive" "$release_sha"');
    const activation = script.lastIndexOf("  activate_release \\");
    expect(contract).toBeGreaterThan(-1);
    expect(contract).toBeLessThan(migrations);
    expect(contract).toBeLessThan(staging);
    expect(contract).toBeLessThan(activation);
    expect(script).toContain('metadata="$(validate_release_tree');
    expect(script).not.toContain(
      '"$release_root" "$release_sha" "$expected_node_version" "$expected_supabase_version"',
    );
  });

  it("rejects schema 3, divergent build identity and missing authorization contract before mutation", () => {
    const directory = temporaryDirectory();
    const definitions = [
      ["valid", () => {}],
      [
        "absent",
        ({ manifest, manifestPath }) => {
          const candidate = { ...manifest };
          delete candidate.publicBuildConfigSha256;
          writeFileSync(manifestPath, JSON.stringify(candidate));
        },
      ],
      [
        "malformed",
        ({ manifest, manifestPath }) => {
          writeFileSync(
            manifestPath,
            JSON.stringify({ ...manifest, publicBuildConfigSha256: "A".repeat(64) }),
          );
        },
      ],
      [
        "mismatch",
        ({ manifest, manifestPath }) => {
          writeFileSync(
            manifestPath,
            JSON.stringify({ ...manifest, publicBuildConfigSha256: "b".repeat(64) }),
          );
        },
      ],
      [
        "schema-3",
        ({ manifest, manifestPath }) => {
          writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 3 }));
        },
      ],
      [
        "missing-authorization",
        ({ releaseRoot }) => {
          rmSync(resolve(releaseRoot, "supabase/authorization-contract.json"));
        },
      ],
    ];
    const cases = definitions.map(([name, mutate]) => {
      const caseDirectory = resolve(directory, name);
      mkdirSync(caseDirectory);
      const fixture = createReleaseContractFixture(caseDirectory);
      mutate(fixture);
      return {
        ...fixture,
        mutationMarker: resolve(caseDirectory, "mutation.marker"),
        name,
      };
    });
    const result = callReleaseContractGuards(cases);
    expect(result.status, result.stderr).toBe(0);
    expect(result.outcomes.size, result.stderr).toBe(cases.length);

    const valid = cases[0];
    expect(result.outcomes.get(valid.name)).toEqual({
      output: `${valid.manifest.migrations.head} ${valid.manifest.lockfile.sha256}`,
      status: 0,
    });
    expect(existsSync(valid.mutationMarker)).toBe(true);

    for (const candidate of cases.slice(1)) {
      expect(result.outcomes.get(candidate.name), candidate.name).toEqual({
        output: "",
        status: 1,
      });
      expect(existsSync(candidate.mutationMarker), candidate.name).toBe(false);
    }
  });

  it("enforces the exact signed N-1/N authorization delta and durable preflight snapshot", () => {
    expect(script).toContain(
      `readonly expected_authorization_catalog_sha256=${authorizationCatalogSha256}`,
    );
    expect(script).toContain(
      "readonly authorization_contract_relative_path=supabase/authorization-contract.json",
    );
    const directory = temporaryDirectory();
    const before = [authorizationRelationFact(), authorizationRelationSecurityFact()];
    const selectPolicy = authorizationPolicyFact({});
    const selectGrant = authorizationPrivilegeFact({
      grantee: "authenticated",
      privilege: "SELECT",
    });
    const contract = buildMigrationAuthorizationContract({
      releaseCommit: "a".repeat(40),
      previousHead: "20260818000100",
      head: "20260819000100",
      beforeFacts: before,
      afterFacts: [...before, selectPolicy, selectGrant],
      approvedAdditions: [selectGrant, selectPolicy],
    });
    const { contractPath, manifest } = writeAuthorizationManifest(directory, contract);
    const beforePath = resolve(directory, "before.jsonl");
    const afterPath = resolve(directory, "after.jsonl");
    const statePath = resolve(directory, "authorization.state");
    const restoredPath = resolve(directory, "restored.jsonl");
    writeAuthorizationSnapshot(beforePath, before);
    writeAuthorizationSnapshot(afterPath, [...before, selectPolicy, selectGrant]);

    const metadata = runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
      "manifest",
      manifest,
      contractPath,
      authorizationCatalogSha256,
    ]);
    expect(metadata.status, metadata.stderr).toBe(0);
    expect(metadata.stdout).toBe(`${contract.previousHead} ${contract.head} ${contract.sha256}\n`);
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "compare",
        manifest,
        contractPath,
        authorizationCatalogSha256,
        beforePath,
        afterPath,
        contract.previousHead,
        contract.head,
      ]).status,
    ).toBe(0);
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "write-state",
        manifest,
        contractPath,
        authorizationCatalogSha256,
        beforePath,
        statePath,
      ]).status,
    ).toBe(0);
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "read-state",
        manifest,
        contractPath,
        authorizationCatalogSha256,
        statePath,
        restoredPath,
      ]).status,
    ).toBe(0);
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", ["snapshot-equal", beforePath, restoredPath])
        .status,
    ).toBe(0);

    writeAuthorizationSnapshot(afterPath, [
      ...before,
      selectPolicy,
      selectGrant,
      authorizationPrivilegeFact({
        grantee: "authenticated",
        object: ["public"],
        objectType: "schema",
        privilege: "USAGE",
      }),
    ]);
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "compare",
        manifest,
        contractPath,
        authorizationCatalogSha256,
        beforePath,
        afterPath,
        contract.previousHead,
        contract.head,
      ]).status,
    ).not.toBe(0);

    writeFileSync(
      manifest,
      JSON.stringify({ commit: "b".repeat(40), migrations: { head: contract.head } }),
    );
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "manifest",
        manifest,
        contractPath,
        authorizationCatalogSha256,
      ]).status,
    ).not.toBe(0);
  });

  it("pins the empty-Cloud baseline contract and resumes from the same semantic snapshot", () => {
    const directory = temporaryDirectory();
    const before = [];
    const policy = authorizationPolicyFact({});
    const grant = authorizationPrivilegeFact({
      grantee: "authenticated",
      privilege: "SELECT",
    });
    const contract = baselineAuthorizationContract({
      afterFacts: [authorizationRelationFact(), authorizationRelationSecurityFact(), policy, grant],
    });
    const { contractPath, manifest } = writeAuthorizationManifest(directory, contract);
    const beforePath = resolve(directory, "baseline-before.jsonl");
    const afterPath = resolve(directory, "baseline-after.jsonl");
    const statePath = resolve(directory, "baseline.state");
    const restoredPath = resolve(directory, "baseline-restored.jsonl");
    const headPath = resolve(directory, "authorization-head.json");
    const headContract = authorizationHeadContract({ facts: contract.additions });
    writeFileSync(headPath, JSON.stringify(headContract));
    writeAuthorizationSnapshot(beforePath, before);
    writeAuthorizationSnapshot(afterPath, contract.additions);

    const common = [manifest, contractPath, authorizationCatalogSha256];
    const metadata = runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
      "baseline-manifest",
      ...common,
    ]);
    expect(metadata.status, metadata.stderr).toBe(0);
    expect(metadata.stdout).toBe(`none ${contract.head} ${contract.sha256}\n`);
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "baseline-compare",
        ...common,
        beforePath,
        afterPath,
        contract.head,
      ]).status,
    ).toBe(0);
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "baseline-write-state",
        ...common,
        beforePath,
        statePath,
      ]).status,
    ).toBe(0);
    const stateMetadata = runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
      "state-metadata",
      statePath,
    ]);
    expect(stateMetadata.status, stateMetadata.stderr).toBe(0);
    expect(stateMetadata.stdout).toBe(`baseline none ${contract.head}\n`);
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "baseline-read-state",
        ...common,
        statePath,
        restoredPath,
      ]).status,
    ).toBe(0);
    expect(readFileSync(restoredPath, "utf8")).toBe(readFileSync(beforePath, "utf8"));
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "head-compare",
        manifest,
        headPath,
        authorizationCatalogSha256,
        afterPath,
      ]).status,
    ).toBe(0);

    writeFileSync(contractPath, JSON.stringify({ ...contract, sha256: "0".repeat(64) }));
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", ["baseline-manifest", ...common]).status,
    ).not.toBe(0);
    writeFileSync(contractPath, JSON.stringify(contract));
    const dirtyBefore = resolve(directory, "dirty-before.jsonl");
    writeAuthorizationSnapshot(dirtyBefore, [authorizationRelationFact("unexpected")]);
    expect(
      runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "baseline-compare",
        ...common,
        dirtyBefore,
        afterPath,
        contract.head,
      ]).status,
    ).not.toBe(0);
  });

  it("does not accept deploy-time backup attestations as release authority", () => {
    expect(script).not.toContain("BACKUP_RESTORE_ATTESTATION_NODE");
    expect(script).not.toContain("backup-restore-attestation.json");
    expect(script).not.toContain("validate_backup_restore_attestation");
  });

  it("rejects even correctly signed public write policies and dangerous grants", () => {
    const directory = temporaryDirectory();
    const unsafeFacts = [
      authorizationPolicyFact({
        command: "DELETE",
        name: "unsafe_delete",
        roles: ["anon"],
        using: "true",
      }),
      authorizationPrivilegeFact({ grantee: "anon", privilege: "DELETE" }),
      authorizationPrivilegeFact({ grantee: "anon", privilege: "INSERT" }),
      authorizationPrivilegeFact({
        grantee: "anon",
        object: ["16384"],
        objectType: "largeObject",
        privilege: "UPDATE",
      }),
      authorizationPrivilegeFact({
        grantee: "anon",
        object: ["public"],
        objectType: "schema",
        privilege: "CREATE",
      }),
      authorizationPrivilegeFact({
        grantee: "anon",
        object: ["postgres"],
        objectType: "database",
        privilege: "CREATE",
      }),
      authorizationPrivilegeFact({
        grantee: "anon",
        object: ["pg_default"],
        objectType: "tablespace",
        privilege: "CREATE",
      }),
    ];

    for (const [index, unsafeFact] of unsafeFacts.entries()) {
      const contract = signedAuthorizationContract({ additions: [unsafeFact] });
      const { contractPath, manifest } = writeAuthorizationManifest(directory, contract);
      const result = runNodeHeredoc("AUTHORIZATION_CONTRACT_NODE", [
        "manifest",
        manifest,
        contractPath,
        authorizationCatalogSha256,
      ]);
      expect(result.status, `unsafe fact ${index}: ${result.stderr}`).not.toBe(0);
    }
  });

  it("behaviorally accepts only marked expand-only migration deltas", () => {
    const directory = temporaryDirectory();
    const migrations = resolve(directory, "migrations");
    mkdirSync(migrations);
    const baseline = "20260818000100";
    const head = "20260818000200";
    const delta = resolve(migrations, `${head}_safe_expansion.sql`);
    const writeDelta = (body) =>
      writeFileSync(delta, `-- set-livre:migration-mode=expand-only\n${body}\n`);
    writeFileSync(resolve(migrations, `${baseline}_baseline.sql`), "drop table historical_only;\n");
    writeDelta(
      [
        "alter table public.studios add column if not exists notes text;",
        "alter table public.studios add constraint studios_notes_check check (notes <> '') not valid;",
        "create table public.new_expand_only_table (id bigint primary key);",
        "alter table public.new_expand_only_table enable row level security;",
        "alter table public.new_expand_only_table add constraint new_expand_only_table_id_check check (id > 0);",
        "create index new_expand_only_table_id_idx on public.new_expand_only_table (id);",
        "create policy new_expand_only_table_select on public.new_expand_only_table for select to authenticated using (true);",
        "comment on table public.new_expand_only_table is 'new table';",
        "grant select on table public.new_expand_only_table to authenticated;",
        "do $managed_rls_acl$",
        "begin",
        "  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null then",
        "    revoke all on function public.rls_auto_enable()",
        "      from public, anon, authenticated, service_role, app_dal;",
        "  end if;",
        "end",
        "$managed_rls_acl$;",
        "create or replace function private.check_readiness(expected_version text) returns boolean language sql stable security definer set search_path = '' as $function$",
        "  select expected_version = '20260818000100';",
        "$function$;",
        "revoke all on function private.check_readiness(text) from public, anon, authenticated, service_role, app_dal;",
        "grant execute on function private.check_readiness(text) to app_dal;",
        "create function private.new_example() returns void language plpgsql as $$",
        "begin",
        "  perform 'delete update merge disable row level security';",
        "end;",
        "$$;",
        "create procedure private.new_procedure() language plpgsql as $procedure$",
        "begin",
        "  null;",
        "end;",
        "$procedure$;",
        "create trigger new_expand_only_table_trigger before insert on public.new_expand_only_table for each row execute function private.new_example();",
        "",
      ].join("\n"),
    );

    expect(runNodeHeredoc("EXPAND_ONLY_NODE", [migrations, head, baseline]).status).toBe(0);
    expect(runNodeHeredoc("EXPAND_ONLY_NODE", [migrations, head, "none"]).status).not.toBe(0);

    writeDelta("drop table public.studios;");
    expect(runNodeHeredoc("EXPAND_ONLY_NODE", [migrations, head, baseline]).status).not.toBe(0);

    writeFileSync(delta, "alter table public.studios add column unsafe text;\n");
    expect(runNodeHeredoc("EXPAND_ONLY_NODE", [migrations, head, baseline]).status).not.toBe(0);

    for (const unsafe of [
      "alter table public.studios add column unsafe text not null;",
      "with removed as (delete from public.studios returning id) select id from removed;",
      "with recursive changed as (update public.studios set name = name returning id) select id from changed;",
      "with source as (select id from public.studios) merge into public.studios using source on false when not matched then insert (id) values (source.id);",
      "explain analyze with removed as (delete from public.studios returning id) select id from removed;",
      "explain analyze update public.studios set name = name;",
      "insert into public.studios (id) values ('00000000-0000-4000-8000-000000000001') on conflict (id) do update set name = excluded.name;",
      "alter table public.studios disable row level security;",
      "alter table public.studios no force row level security;",
      "alter table public.studios disable trigger all;",
      "alter table public.studios owner to postgres;",
      "alter table public.studios set schema private;",
      "alter table public.studios add column unsafe text default 'value';",
      "alter table public.studios add column unsafe text references public.owner_profiles(user_id);",
      "alter table public.studios add column safe text, alter column name type varchar(200);",
      "alter role app_dal superuser;",
      "create or replace trigger unsafe before insert on public.studios for each row execute function private.new_example();",
      "create trigger unsafe before insert on public.studios for each row execute function private.new_example();",
      "create or replace function private.existing() returns void language plpgsql as $$ begin null; end; $$;",
      "create or replace procedure private.existing() language plpgsql as $$ begin null; end; $$;",
      "revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role, app_dal;",
      "revoke all on function private.existing() from public, anon, authenticated, service_role, app_dal;",
      "do $$ begin null; end; $$;",
      "do $managed_rls_acl$ begin if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null then null; end if; end $managed_rls_acl$;",
      "alter function private.existing() owner to postgres;",
      "alter procedure private.existing() owner to postgres;",
      "alter routine private.existing() owner to postgres;",
      "insert into public.studios (name) values ('unexpected');",
      "analyze public.studios;",
      "notify deployment, 'unexpected';",
    ]) {
      writeDelta(unsafe);
      expect(runNodeHeredoc("EXPAND_ONLY_NODE", [migrations, head, baseline]).status).not.toBe(0);
    }
  });

  it("accepts the exact current Supabase hardening delta from its predecessor", () => {
    const result = runNodeHeredoc("EXPAND_ONLY_NODE", [
      resolve(repository, "supabase/migrations"),
      "20260819000100",
      "20260815000100",
    ]);
    expect(result.status, result.stderr).toBe(0);
  });

  it("continues exact contiguous migration prefixes and rejects gaps, divergence or ahead state", () => {
    const directory = temporaryDirectory();
    const migrations = resolve(directory, "migrations");
    const output = resolve(directory, "migration-preflight.json");
    const versions = ["20260811000100", "20260818000100", "20260818000200"];
    mkdirSync(migrations);
    for (const version of versions) {
      writeFileSync(resolve(migrations, `${version}_migration.sql`), "select 1;\n");
    }
    const preflight = (payload, previousHead, expectedHead = versions.at(-1)) => {
      writeFileSync(output, JSON.stringify(payload));
      return runNodeHeredoc("REMOTE_MIGRATIONS_PREFLIGHT_NODE", [
        output,
        migrations,
        expectedHead,
        previousHead,
      ]);
    };

    const baseline = preflight(migrationListPayload(versions, []), "none");
    expect(baseline.status).toBe(0);
    expect(baseline.stdout).toBe("baseline\n");
    const resumedBaseline = preflight(migrationListPayload(versions), "none");
    expect(resumedBaseline.status).toBe(0);
    expect(resumedBaseline.stdout).toBe("post-push-resume\n");
    const partiallyAppliedBaseline = preflight(
      migrationListPayload(versions, versions.slice(0, 1)),
      "none",
    );
    expect(partiallyAppliedBaseline.status).toBe(0);
    expect(partiallyAppliedBaseline.stdout).toBe("baseline-resume\n");

    const incremental = preflight(
      migrationListPayload(versions, versions.slice(0, 2)),
      versions[1],
    );
    expect(incremental.status).toBe(0);
    expect(incremental.stdout).toBe("incremental\n");
    const partiallyAppliedIncremental = preflight(
      migrationListPayload(versions, versions.slice(0, 2)),
      versions[0],
    );
    expect(partiallyAppliedIncremental.status).toBe(0);
    expect(partiallyAppliedIncremental.stdout).toBe("incremental-resume\n");
    const alreadyCurrent = preflight(migrationListPayload(versions), versions.at(-1));
    expect(alreadyCurrent.status).toBe(0);
    expect(alreadyCurrent.stdout).toBe("already-current\n");
    const resumedIncremental = preflight(migrationListPayload(versions), versions[1]);
    expect(resumedIncremental.status).toBe(0);
    expect(resumedIncremental.stdout).toBe("post-push-resume\n");
    expect(
      preflight(migrationListPayload(versions, versions.slice(0, 2)), versions.at(-1)).status,
    ).not.toBe(0);
    expect(
      preflight(migrationListPayload(versions, versions.slice(0, 1)), versions[1]).status,
    ).not.toBe(0);
    expect(preflight(migrationListPayload(versions, []), versions[1]).status).not.toBe(0);
    expect(
      preflight(migrationListPayload(versions, versions.slice(0, 2)), "20260817000100").status,
    ).not.toBe(0);
    expect(preflight(migrationListPayload(versions, []), "none", versions[1]).status).not.toBe(0);

    const nonContiguous = migrationListPayload(versions, [versions[0], versions[2]]);
    expect(preflight(nonContiguous, versions[1]).status).not.toBe(0);

    const divergent = migrationListPayload(versions);
    divergent.migrations[1].remote = "20260817000999";
    expect(preflight(divergent, versions[1]).status).not.toBe(0);

    const outOfBand = migrationListPayload(versions);
    outOfBand.migrations[1].local = "";
    expect(preflight(outOfBand, versions[1]).status).not.toBe(0);

    const remoteAhead = migrationListPayload([...versions, "20260819000100"]);
    expect(preflight(remoteAhead, versions[1]).status).not.toBe(0);
  });

  it("behaviorally requires the remote migration history to match every physical migration", () => {
    const directory = temporaryDirectory();
    const migrations = resolve(directory, "migrations");
    const output = resolve(directory, "migration-list.json");
    const versions = ["20260811000100", "20260818000100"];
    mkdirSync(migrations);
    for (const version of versions) {
      writeFileSync(resolve(migrations, `${version}_migration.sql`), "select 1;\n");
    }

    const assertHistory = (payload, head = versions.at(-1)) => {
      writeFileSync(output, JSON.stringify(payload));
      return runNodeHeredoc("REMOTE_MIGRATIONS_NODE", [output, migrations, head]);
    };

    const exact = assertHistory(migrationListPayload(versions));
    expect(exact.status).toBe(0);
    expect(exact.stdout).toBe("");

    const missing = migrationListPayload(versions);
    missing.migrations[1].remote = "";
    expect(assertHistory(missing).status).not.toBe(0);

    const divergent = migrationListPayload(versions);
    divergent.migrations[0].remote = "20260811000999";
    expect(assertHistory(divergent).status).not.toBe(0);

    const extraVersion = "20260819000100";
    const extra = migrationListPayload([...versions, extraVersion]);
    expect(assertHistory(extra).status).not.toBe(0);

    const wrongTime = migrationListPayload(versions);
    wrongTime.migrations[0].time = "2026-08-11 00:01:01";
    expect(assertHistory(wrongTime).status).not.toBe(0);

    expect(assertHistory({ ...migrationListPayload(versions), unexpected: true }).status).not.toBe(
      0,
    );
    expect(assertHistory(migrationListPayload(versions), versions[0]).status).not.toBe(0);
  });

  it("invokes Supabase non-interactively and captures migration JSON without leaking it", () => {
    const { appliedState, capturedOutput, cliLog, migrationOutput, operations, result } =
      callRunSupabaseMigrations();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(capturedOutput, "utf8")).toBe(readFileSync(migrationOutput, "utf8"));
    expect(readFileSync(appliedState, "utf8")).toBe("schema=1\nmigration_head=20260818000100\n");
    expect(readFileSync(operations, "utf8").trim().split("\n")).toEqual([
      "migration-history",
      "readiness",
      "applied-schema",
    ]);
    const invocations = readFileSync(cliLog, "utf8").trim().split("\n");
    expect(invocations).toEqual([
      `<link><--project-ref><${productionSupabaseProjectRef}>`,
      "<migration><list><--linked><--output-format><json><--yes>",
      "<db><push><--linked><--include-all><--include-roles><--dry-run><--yes>",
      "<db><push><--linked><--include-all><--include-roles><--yes>",
      "<migration><list><--linked><--output-format><json><--yes>",
    ]);
    expect(invocations.join("\n")).not.toMatch(/access-secret|database-secret/u);

    const partiallyAppliedBaseline = callRunSupabaseMigrations({
      preflightRemoteVersions: ["20260811000100"],
    });
    expect(partiallyAppliedBaseline.result.status).not.toBe(0);
    expect(readFileSync(partiallyAppliedBaseline.cliLog, "utf8").trim().split("\n")).toEqual([
      `<link><--project-ref><${productionSupabaseProjectRef}>`,
      "<migration><list><--linked><--output-format><json><--yes>",
    ]);

    const resumablePartialBaseline = callRunSupabaseMigrations({
      authorizationStateExists: true,
      preflightRemoteVersions: ["20260811000100"],
    });
    expect(resumablePartialBaseline.result.status, resumablePartialBaseline.result.stderr).toBe(0);
    expect(readFileSync(resumablePartialBaseline.cliLog, "utf8").trim().split("\n")).toEqual([
      `<link><--project-ref><${productionSupabaseProjectRef}>`,
      "<migration><list><--linked><--output-format><json><--yes>",
      "<db><push><--linked><--include-all><--include-roles><--dry-run><--yes>",
      "<db><push><--linked><--include-all><--include-roles><--yes>",
      "<migration><list><--linked><--output-format><json><--yes>",
    ]);

    const resumedBaseline = callRunSupabaseMigrations({
      authorizationStateExists: true,
      preflightIsEmpty: false,
    });
    expect(resumedBaseline.result.status, resumedBaseline.result.stderr).toBe(0);
    expect(readFileSync(resumedBaseline.cliLog, "utf8").trim().split("\n")).toEqual([
      `<link><--project-ref><${productionSupabaseProjectRef}>`,
      "<migration><list><--linked><--output-format><json><--yes>",
      "<migration><list><--linked><--output-format><json><--yes>",
    ]);

    const alreadyCurrent = callRunSupabaseMigrations({
      preflightIsEmpty: false,
      previousHead: "20260818000100",
    });
    expect(alreadyCurrent.result.status, alreadyCurrent.result.stderr).toBe(0);
    expect(readFileSync(alreadyCurrent.cliLog, "utf8").trim().split("\n")).toEqual([
      `<link><--project-ref><${productionSupabaseProjectRef}>`,
      "<migration><list><--linked><--output-format><json><--yes>",
      "<migration><list><--linked><--output-format><json><--yes>",
    ]);
    expect(readFileSync(alreadyCurrent.operations, "utf8").trim().split("\n")).toEqual([
      "migration-history",
      "readiness",
      "applied-schema",
    ]);
  });

  it("recovers after a crash immediately after push without a second push", () => {
    const previousVersion = "20260811000100";
    const head = "20260818000100";
    for (const scenario of [
      { name: "baseline", previousHead: "none", remoteBefore: [] },
      { name: "incremental", previousHead: previousVersion, remoteBefore: [previousVersion] },
    ]) {
      const crashed = callRunSupabaseMigrations({
        crashImmediatelyAfterPush: true,
        preflightRemoteVersions: scenario.remoteBefore,
        previousHead: scenario.previousHead,
      });
      expect(crashed.result.status, scenario.name).not.toBe(0);
      expect(existsSync(crashed.remoteApplied), scenario.name).toBe(true);
      expect(existsSync(crashed.appliedState), scenario.name).toBe(false);
      expect(existsSync(crashed.operations), scenario.name).toBe(false);
      expect(readFileSync(crashed.cliLog, "utf8").trim().split("\n")).toEqual([
        `<link><--project-ref><${productionSupabaseProjectRef}>`,
        "<migration><list><--linked><--output-format><json><--yes>",
        "<db><push><--linked><--include-all><--include-roles><--dry-run><--yes>",
        "<db><push><--linked><--include-all><--include-roles><--yes>",
      ]);

      const restarted = callRunSupabaseMigrations({
        authorizationContractKind: scenario.name,
        authorizationStateExists: true,
        preflightIsEmpty: false,
        previousHead: scenario.previousHead,
      });
      expect(restarted.result.status, restarted.result.stderr).toBe(0);
      const restartInvocations = readFileSync(restarted.cliLog, "utf8").trim().split("\n");
      expect(restartInvocations).toEqual([
        `<link><--project-ref><${productionSupabaseProjectRef}>`,
        "<migration><list><--linked><--output-format><json><--yes>",
        "<migration><list><--linked><--output-format><json><--yes>",
      ]);
      expect(restartInvocations.join("\n")).not.toContain("<db><push>");
      expect(readFileSync(restarted.operations, "utf8").trim().split("\n")).toEqual([
        "migration-history",
        "readiness",
        "applied-schema",
      ]);
      expect(readFileSync(restarted.appliedState, "utf8")).toBe(
        `schema=1\nmigration_head=${head}\n`,
      );
    }
  });

  it("persists applied schema before a post-migration pre-smoke crash and resumes current", () => {
    const crashed = callRunSupabaseMigrations({ crashAfterMigration: true });
    expect(crashed.result.status).toBe(75);
    const serialized = readFileSync(crashed.appliedState, "utf8");
    expect(serialized).toBe("schema=1\nmigration_head=20260818000100\n");
    expect(readFileSync(crashed.operations, "utf8").trim().split("\n")).toEqual([
      "migration-history",
      "readiness",
      "applied-schema",
    ]);

    const previousHead = /migration_head=(\d{14})\n$/u.exec(serialized)?.[1];
    expect(previousHead).toBe("20260818000100");
    const resumed = callRunSupabaseMigrations({ preflightIsEmpty: false, previousHead });
    expect(resumed.result.status, resumed.result.stderr).toBe(0);
    expect(readFileSync(resumed.cliLog, "utf8").trim().split("\n")).toEqual([
      `<link><--project-ref><${productionSupabaseProjectRef}>`,
      "<migration><list><--linked><--output-format><json><--yes>",
      "<migration><list><--linked><--output-format><json><--yes>",
    ]);
  });

  it("serializes expand-only migration, N-1 compatibility, activation and confirmation", () => {
    expect(script).toContain("flock -n 9");
    expect(script).toContain("assert_remote_migration_preflight");
    expect(script).toContain('"post-push-resume\\n"');
    expect(script).toContain(
      'assert_expand_only_delta "$release_root" "$migration_head" "$previous_head"',
    );
    expect(script).toContain(
      '"$cli" db push --linked --include-all --include-roles --dry-run --yes </dev/null',
    );
    expect(script).toContain(
      '"$cli" db push --linked --include-all --include-roles --yes </dev/null',
    );
    expect(script).toContain('|| "$migration_mode" == baseline-resume');
    expect(script).toContain('|| "$migration_mode" == incremental-resume');
    expect(script).toContain(
      '"$cli" migration list --linked --output-format json --yes \\\n      </dev/null >"$migration_output"',
    );
    expect(script).toContain("assert_remote_migration_history");
    expect(script).toContain("private.check_runtime_readiness('app_runtime_prod'::text)");
    expect(script).toContain("app_runtime_prod:app_dal:t:t");
    expect(script).toContain('incoming_directory="$incoming_base/$release_sha"');
    expect(script).toContain('sudo -n "$dispatcher" activate');
    expect(script).toContain('sudo -n "$dispatcher" preflight');
    expect(script).toContain('sudo -n "$dispatcher" discard-preflight "$root_preflight_sha"');
    expect(script).toContain(
      '"$source_run_number" "$source_run_attempt" "$source_run_id" \\\n    "$artifact_id" "$artifact_digest"',
    );
    expect(script).toContain(
      '"$artifact_provider_run_number" \\\n      "$artifact_provider_run_attempt" \\\n      "$artifact_provider_run_id"',
    );
    expect(script).toContain('"run_number=$source_run_number"');
    expect(script).toContain('timeout --signal=TERM --kill-after=30s "${timeout_seconds}s" \\');
    expect(script).toContain("readonly compatibility_smoke_attempts=1");
    expect(script).toContain("readonly compatibility_smoke_interval_ms=0");
    expect(script).toContain('sudo -n "$dispatcher" rollback "$release_sha"');
    expect(script).not.toContain('"$rollback_sha" "$smoke_attempts"');
    expect(script).toContain('terminal_result="$(manager_activation_result "$release_sha")"');
    expect(script).toContain('sudo -n "$dispatcher" confirm "$release_sha"');
    expect(script).toContain(
      'readonly rejected_artifacts_state="$state_base/rejected-artifacts.state"',
    );
    expect(script).toContain('readonly applied_schema_state="$state_base/applied-schema.state"');
    expect(script).toContain('assert_private_state_file "$rejected_artifacts_state"');
    expect(script).toContain(
      'assert_private_state_file "$applied_schema_state" "$maximum_applied_schema_bytes"',
    );
    expect(script).toContain('sync -f "$candidate"');
    expect(script).toContain('mv -Tf -- "$candidate" "$applied_schema_state"');
    expect(script).toContain('sync -f "$state_base"');
    expect(script).toContain("record_rejected_artifact");
    expect(script).toContain("prepare_release_schema");
    expect(script).toContain("assert_manager_checkpoint_unchanged");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain("trap 'exit 1' HUP INT TERM");
    const preflight = script.lastIndexOf(
      '    migration_mode="$(assert_remote_migration_preflight \\',
    );
    const dryRun = script.lastIndexOf(
      '    "$cli" db push --linked --include-all --include-roles --dry-run --yes </dev/null',
    );
    const migrationFunction = script.indexOf("run_supabase_migrations() {");
    const finalHistory = script.indexOf(
      "    assert_remote_migration_history \\",
      migrationFunction,
    );
    const authorizationBefore = script.indexOf(
      'capture_authorization_catalog "$release_root" "$authorization_before"',
      migrationFunction,
    );
    const authorizationStateWrite = script.indexOf(
      "write_authorization_preflight_state \\",
      migrationFunction,
    );
    const authorizationAfter = script.indexOf(
      'capture_authorization_catalog "$release_root" "$authorization_after"',
      migrationFunction,
    );
    const authorizationComparison = script.indexOf(
      "      assert_authorization_delta \\",
      migrationFunction,
    );
    const readiness = script.indexOf(
      '  assert_database_readiness "$migration_head"',
      migrationFunction,
    );
    const appliedWrite = script.indexOf(
      '  write_applied_schema_state "$migration_head"',
      migrationFunction,
    );
    const selectionFunction = script.indexOf("select_artifact() {");
    const durableRejectionLookup = script.indexOf(
      '    rejection_status="$(rejected_run_identity_status',
      selectionFunction,
    );
    const artifactMetadataLookup = script.indexOf(
      "    fetch_artifact_metadata \\",
      selectionFunction,
    );
    const schemaFunction = script.indexOf("prepare_release_schema() {");
    const migrationCall = script.indexOf(
      '  run_supabase_migrations "$release_root" "$migration_head" "$previous_head"',
      schemaFunction,
    );
    const compatibilitySmoke = script.indexOf(
      '    "$compatibility_smoke_attempts" \\',
      migrationCall,
    );
    const compatibilityRejection = script.indexOf(
      "    record_rejected_artifact \\",
      compatibilitySmoke,
    );
    const staging = script.lastIndexOf('  stage_activation "$archive" "$release_sha"');
    const rootPreflight = script.lastIndexOf("  preflight_release \\");
    const preparation = script.lastIndexOf("  prepare_release_schema \\");
    const activationCall = script.lastIndexOf("  activate_release \\");
    const stateWrite = script.lastIndexOf("  write_deployed_state \\");
    expect(preflight).toBeGreaterThan(-1);
    expect(authorizationBefore).toBeGreaterThan(preflight);
    expect(authorizationStateWrite).toBeGreaterThan(authorizationBefore);
    expect(dryRun).toBeGreaterThan(authorizationStateWrite);
    expect(dryRun).toBeGreaterThan(preflight);
    expect(finalHistory).toBeGreaterThan(dryRun);
    expect(authorizationAfter).toBeGreaterThan(finalHistory);
    expect(authorizationComparison).toBeGreaterThan(authorizationAfter);
    expect(readiness).toBeGreaterThan(authorizationComparison);
    expect(readiness).toBeGreaterThan(finalHistory);
    expect(appliedWrite).toBeGreaterThan(readiness);
    expect(durableRejectionLookup).toBeGreaterThan(selectionFunction);
    expect(artifactMetadataLookup).toBeGreaterThan(durableRejectionLookup);
    expect(schemaFunction).toBeGreaterThan(-1);
    expect(migrationCall).toBeGreaterThan(-1);
    expect(compatibilitySmoke).toBeGreaterThan(migrationCall);
    expect(compatibilityRejection).toBeGreaterThan(compatibilitySmoke);
    expect(staging).toBeGreaterThan(compatibilityRejection);
    expect(rootPreflight).toBeGreaterThan(staging);
    expect(preparation).toBeGreaterThan(rootPreflight);
    expect(activationCall).toBeGreaterThan(-1);
    expect(activationCall).toBeGreaterThan(preparation);
    expect(stateWrite).toBeGreaterThan(activationCall);
  });

  linuxIt("behaviorally filters workflow runs and artifact metadata", () => {
    const directory = temporaryDirectory();
    const sha = "a".repeat(40);
    const runs = resolve(directory, "runs.json");
    const artifacts = resolve(directory, "artifacts.json");
    writeFileSync(
      runs,
      JSON.stringify({
        total_count: 3,
        workflow_runs: [
          {
            conclusion: "failure",
            display_title: `Release ${"b".repeat(40)}`,
            event: "workflow_run",
            head_branch: "main",
            head_sha: "b".repeat(40),
            id: 8,
            path: ".github/workflows/prd-deploy.yaml",
            repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
            workflow_id: 987654,
            head_repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
            run_attempt: 1,
            run_number: 8,
            status: "completed",
            updated_at: "2026-08-18T00:00:00Z",
          },
          {
            conclusion: "success",
            display_title: `Release ${sha}`,
            event: "workflow_run",
            head_branch: "main",
            head_repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
            head_sha: sha,
            id: 9,
            path: ".github/workflows/prd-deploy.yaml",
            repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
            workflow_id: 987654,
            run_attempt: 1,
            run_number: 9,
            status: "completed",
            updated_at: "2026-08-18T00:01:00Z",
          },
          {
            conclusion: "success",
            display_title: `Release ${"d".repeat(40)}`,
            event: "workflow_run",
            head_branch: "main",
            head_repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
            head_sha: "d".repeat(40),
            id: 10,
            path: ".github/workflows/prd-deploy.yaml",
            repository: { full_name: "PedroRomeroM/set-livre", id: 1328339374 },
            workflow_id: 987654,
            run_attempt: 1,
            run_number: 10,
            status: "completed",
            updated_at: "2026-08-18T00:02:00Z",
          },
        ],
      }),
    );
    const runResult = callFunction("candidate_runs", ["3", runs]);
    expect(runResult.status).toBe(0);
    expect(runResult.stdout.trim()).toBe(
      normalCandidate(10, 1, 10, "d".repeat(40), "2026-08-18T00:02:00Z"),
    );

    writeFileSync(
      artifacts,
      JSON.stringify({
        total_count: 1,
        artifacts: [
          {
            archive_download_url:
              "https://api.github.com/repos/PedroRomeroM/set-livre/actions/artifacts/42/zip",
            digest: `sha256:${"c".repeat(64)}`,
            expired: false,
            expires_at: "2999-01-01T00:00:00Z",
            id: 42,
            name: `set-livre-${sha}-${canonicalArchiveSha256}-${canonicalPublicBuildConfigSha256}`,
            size_in_bytes: 1024,
            workflow_run: {
              head_branch: "main",
              head_repository_id: 1328339374,
              head_sha: sha,
              id: 9,
              repository_id: 1328339374,
            },
          },
        ],
      }),
    );
    const artifactResult = callFunction("artifact_metadata", [sha, "9", sha, "1", artifacts]);
    expect(artifactResult.status).toBe(0);
    expect(artifactResult.stdout.trim().split("\n")).toEqual([
      "42",
      "c".repeat(64),
      "1024",
      canonicalArchiveSha256,
      canonicalPublicBuildConfigSha256,
    ]);
  });

  linuxIt("behaviorally accepts an exact ZIP and rejects traversal", () => {
    const directory = temporaryDirectory();
    const sha = "d".repeat(40);
    const archiveName = `set-livre-${sha}.tar.gz`;
    const safeZip = resolve(directory, "safe.zip");
    const unsafeZip = resolve(directory, "unsafe.zip");
    const output = resolve(directory, "output");
    execFileSync("mkdir", [output]);
    const python = String.raw`
import sys, zipfile
safe, unsafe, archive = sys.argv[1:]
with zipfile.ZipFile(safe, "w", compression=zipfile.ZIP_STORED) as z:
    z.writestr(archive, b"archive")
    z.writestr(archive + ".sha256", b"0" * 64 + b"  " + archive.encode() + b"\n")
with zipfile.ZipFile(unsafe, "w", compression=zipfile.ZIP_STORED) as z:
    z.writestr("../" + archive, b"archive")
    z.writestr(archive + ".sha256", b"sidecar")
`;
    execFileSync("python3", ["-c", python, safeZip, unsafeZip, archiveName]);
    const safe = callFunction("extract_verified_zip", [safeZip, sha, output, "4294967296"]);
    expect(safe.status).toBe(0);
    expect(readFileSync(resolve(output, archiveName), "utf8")).toBe("archive");
    const unsafe = callFunction("extract_verified_zip", [unsafeZip, sha, output, "4294967296"]);
    expect(unsafe.status).not.toBe(0);
  });
});
