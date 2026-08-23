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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { databaseMigrationHead } from "../../packages/contracts/src/database-contract.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const syntheticSupabaseProjectRef = "abcdefghijklmnopqrst";
const syntheticSupabaseUrl = `https://${syntheticSupabaseProjectRef}.supabase.co`;
const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/prd-deploy.yaml"), "utf8");
const ciWorkflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yaml"), "utf8");
const releaseGenerator = readFileSync(
  resolve(repositoryRoot, "scripts/release-manifest.mjs"),
  "utf8",
);
const releaseManager = readFileSync(
  resolve(repositoryRoot, "scripts/production-release-manager.sh"),
  "utf8",
);
const deployAgent = readFileSync(
  resolve(repositoryRoot, "scripts/production-deploy-agent.sh"),
  "utf8",
);
const bootstrap = readFileSync(resolve(repositoryRoot, "scripts/bootstrap-oracle-host.sh"), "utf8");

const workflowJob = (name, nextName) => {
  const start = workflow.indexOf(`\n  ${name}:`);
  if (start < 0) return "";
  const end = nextName ? workflow.indexOf(`\n  ${nextName}:`, start + 1) : workflow.length;
  return workflow.slice(start, end < 0 ? workflow.length : end);
};

const workflowStep = (source, name, nextName) => {
  const start = source.indexOf(`\n      - name: ${name}`);
  if (start < 0) return "";
  const end = nextName ? source.indexOf(`\n      - name: ${nextName}`, start + 1) : source.length;
  return source.slice(start, end < 0 ? source.length : end);
};

const workflowShellBody = (source, name, nextName) => {
  const step = workflowStep(source, name, nextName);
  const lines = step.split(/\r?\n/u);
  const runIndex = lines.findIndex((line) => /^\s+run:\s*\|\s*$/u.test(line));
  if (runIndex < 0) throw new Error(`Unable to isolate workflow shell body ${name}`);
  const indentation = lines[runIndex].match(/^\s*/u)[0].length + 2;
  return lines
    .slice(runIndex + 1)
    .map((line) => line.slice(Math.min(indentation, line.length)))
    .join("\n");
};

const publishJob = workflowJob("publish");
const canonicalGenerationStep = workflowStep(
  ciWorkflow,
  "Build pull request or generate the canonical Linux x64 release",
  "Resolve and bind the immutable release digests",
);
const releaseDigestBody = workflowShellBody(
  ciWorkflow,
  "Resolve and bind the immutable release digests",
  "Supply-chain and dead-code gates",
);
const ciReleaseUploadStep = workflowStep(
  ciWorkflow,
  "Deliver canonical release artifact to the production workflow",
  "Write allowlisted CI failure report",
);
const releaseUploadStep = workflowStep(workflow, "Publish immutable release artifact");
const workflowToolingStep = workflowStep(
  ciWorkflow,
  "Lint workflows and shell scripts with pinned binaries",
  "Install Node.js 24.18.0",
);
const deliveryIdentityStep = workflowStep(
  ciWorkflow,
  "Validate immutable delivery identities and approved recovery source",
  "Lint workflows and shell scripts with pinned binaries",
);
const releaseIdentityStep = workflowStep(
  workflow,
  "Resolve and prove the immutable release identity",
  "Checkout the approved merged SHA",
);
const ciNpmToolchainStep = workflowStep(
  ciWorkflow,
  "Install and verify npm 11.19.0",
  "Install locked dependencies",
);
const windowsNpmToolchainStep = workflowStep(
  ciWorkflow,
  "Install and verify npm 11.19.0 on Windows",
  "Install locked dependencies on Windows",
);
const windowsPublicBuildStep = workflowStep(
  ciWorkflow,
  "Build the public application natively on Windows",
  "Build the backoffice natively on Windows",
);
const windowsBackofficeBuildStep = workflowStep(
  ciWorkflow,
  "Build the backoffice natively on Windows",
  "Prove Windows builds did not rewrite tracked environment declarations",
);
const windowsTrackedDeclarationsStep = workflowStep(
  ciWorkflow,
  "Prove Windows builds did not rewrite tracked environment declarations",
);
const productionNpmToolchainStep = workflowStep(
  workflow,
  "Install npm 11.19.0 and locked verifier dependencies",
  "Download the canonical artifact from the exact CI run",
);
const cleanupSupabaseStep = workflowStep(
  ciWorkflow,
  "Stop the scoped local Supabase stack",
  "Write allowlisted CI failure report",
);
const failureReportStep = workflowStep(
  ciWorkflow,
  "Write allowlisted CI failure report",
  "Upload allowlisted CI failure report",
);
const failureReportUploadStep = workflowStep(ciWorkflow, "Upload allowlisted CI failure report");

const shellFunction = (name, nextName) => {
  const marker = `\n${name}() {`;
  const start = releaseManager.indexOf(marker);
  const end = releaseManager.indexOf(`\n}\n\n${nextName}() {`, start);
  if (start < 0 || end < 0) throw new Error(`Unable to isolate shell function ${name}`);
  return releaseManager.slice(start + 1, end + 2);
};

const activateFunction = shellFunction("activate", "confirm");
const confirmFunction = shellFunction("confirm", "rollback");
const rollbackFunction = shellFunction("rollback", "rollback_confirmed");
const rollbackConfirmedFunction = shellFunction("rollback_confirmed", "watchdog");
const copyUploadFunction = shellFunction(
  "copy_upload_to_private_staging",
  "configure_preflight_resources",
);
const preflightFunction = shellFunction("preflight", "discard_preflight");
const cleanupActivationFunction = shellFunction("cleanup_activation", "pending_state_path");
const cleanupPrivateTreeFunction = shellFunction(
  "cleanup_private_tree",
  "cleanup_activation_resources",
);
const recoverCleanupFunction = shellFunction(
  "recover_pending_cleanup_locked",
  "cleanup_activation",
);
const restartFunction = shellFunction("restart_and_assert", "assert_service_inactive");
const firstReleaseStopFunction = shellFunction(
  "stop_failed_first_release",
  "validate_runtime_credential",
);
const scheduleWatchdogFunction = shellFunction("schedule_watchdog", "run_recovery_smoke");
const recoverySmokeFunction = shellFunction("run_recovery_smoke", "restore_previous_pointer");
const recoveryPointerFunction = shellFunction(
  "assert_recovery_pointer_state",
  "apply_recovery_active_release",
);
const atomicLinkFunction = shellFunction("atomic_link", "resolve_optional_link");
const stateWriteFunction = shellFunction("write_root_state_file", "release_provenance_path");
const provenanceWriteFunction = shellFunction(
  "write_release_provenance",
  "assert_release_provenance",
);
const assertRecoveryStateFunction = shellFunction(
  "assert_recovery_state_values",
  "write_recovery_state",
);
const rollbackPendingFunction = shellFunction(
  "rollback_pending_locked",
  "copy_upload_to_private_staging",
);
const applyRecoveryFunction = shellFunction(
  "apply_recovery_active_release",
  "finalize_recovery_state",
);
const finalizeRecoveryFunction = shellFunction(
  "finalize_recovery_state",
  "complete_recovery_locked",
);
const completeRecoveryFunction = shellFunction(
  "complete_recovery_locked",
  "rollback_pending_locked",
);
const watchdogFunction = shellFunction("watchdog", "activation_result");
const activationResultFunction = shellFunction("activation_result", "current");
const recoverPendingFunction = shellFunction("recover_pending_activation_locked", "checkpoint");
const bootPendingRecoveryFunction = shellFunction(
  "recover_pending_activation_at_boot_locked",
  "recover_boot",
);
const bootRecoveryFunction = shellFunction("recover_boot", "checkpoint");
const checkpointFunction = shellFunction("checkpoint", "main");

const bashExecutable =
  process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const windowsPython = (() => {
  if (process.platform !== "win32") return "";
  const installations = resolve(process.env.LOCALAPPDATA, "Programs/Python");
  const executable = readdirSync(installations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^Python\d+$/u.test(entry.name))
    .map((entry) => resolve(installations, entry.name, "python.exe"))
    .filter(existsSync)
    .sort()
    .at(-1);
  if (executable === undefined) throw new Error("Python oficial não encontrado para testes Bash.");
  return executable;
})();
const bashPythonPrelude =
  'if [[ -n "${TEST_PYTHON:-}" ]]; then python3() { "$TEST_PYTHON" "$@"; }; fi';

const runReleaseManagerPython = (marker, arguments_) => {
  const expression = new RegExp(`<<'${marker}'\\r?\\n([\\s\\S]*?)\\r?\\n${marker}`);
  const match = expression.exec(releaseManager);
  if (match === null) throw new Error(`Unable to isolate manager heredoc ${marker}`);
  return spawnSync(windowsPython === "" ? "python3" : windowsPython, ["-", ...arguments_], {
    encoding: "utf8",
    input: match[1],
  });
};

const workflowRunBlockSizes = (source) => {
  const lines = source.split(/\r?\n/u);
  const sizes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
    if (match === null) continue;
    const indentation = match[1].length;
    const content = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const lineIndentation = line.length - line.trimStart().length;
      if (line.trim().length > 0 && lineIndentation <= indentation) break;
      content.push(line);
    }
    sizes.push(Buffer.byteLength(content.join("\n"), "utf8"));
  }
  return sizes;
};

const spawnBashHarness = (commands, shellArguments = []) =>
  spawnSync(
    bashExecutable,
    ["-c", [bashPythonPrelude, ...commands].join("; "), "set-livre-shell-test", ...shellArguments],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...(windowsPython === "" ? {} : { TEST_PYTHON: toBashPath(windowsPython) }),
      },
    },
  );

const runBashHarness = (commands, shellArguments = []) => {
  const result = spawnBashHarness(commands, shellArguments);
  if (result.status !== 0) {
    throw new Error(`Shell harness failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
};

const toBashPath = (path) =>
  process.platform === "win32"
    ? path.replaceAll("\\", "/").replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`)
    : path;

const selectActivationHistory = (releaseSha, currentSha, previousSha) => {
  return runBashHarness(
    [
      "source scripts/production-release-manager.sh",
      'select_activation_history "$1" "$2" "$3"',
      'printf "%s|%s\\n" "$selected_rollback_sha" "$selected_prior_previous_sha"',
    ],
    [releaseSha, currentSha, previousSha],
  );
};

describe("production deployment contract", () => {
  it("generates and hands off the immutable artifact only on GitHub-hosted x86_64 runners", () => {
    expect(ciWorkflow).toContain("runs-on: ubuntu-24.04");
    expect(ciWorkflow).not.toContain("ubuntu-24.04-arm");
    expect(publishJob).toContain("runs-on: ubuntu-24.04");
    expect(publishJob).not.toContain("ubuntu-24.04-arm");
    expect(publishJob).toContain("environment: production");
    expect(canonicalGenerationStep).toContain(
      'node scripts/release-manifest.mjs generate "$RELEASE_SHA"',
    );
    expect(ciWorkflow).toContain("npm ci");
    expect(ciReleaseUploadStep).toContain(
      "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(publishJob).toContain(
      "uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(publishJob).toContain("node scripts/release-manifest.mjs verify");
    expect(publishJob).not.toContain("npm run build");
    expect(publishJob).not.toContain("supabase db push");
    expect(publishJob).not.toContain("setlivre-deploy-dispatch");
    expect(releaseUploadStep).toContain("retention-days: 30");

    expect(workflow).toContain("vars.PRD_DEPLOY_ENABLED == 'true'");
    expect(workflow).toContain("github.event.workflow_run.path == '.github/workflows/ci.yaml'");
    expect(workflow).toContain(
      "github.event.workflow_run.repository.full_name == github.repository",
    );
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain("vars.SET_LIVRE_REPOSITORY_ID");
    expect(workflow).not.toContain("vars.GITHUB_REPOSITORY_ID");
    expect(ciWorkflow).toContain("PRD_SUPABASE_ANON_KEY: ${{ vars.PRD_SUPABASE_ANON_KEY }}");
    expect(ciWorkflow).toContain("PRD_SUPABASE_PROJECT_REF: ${{ vars.PRD_SUPABASE_PROJECT_REF }}");
    expect(workflow).toContain("PRD_PUBLIC_APP_URL: ${{ vars.PRD_PUBLIC_APP_URL }}");
    expect(workflow).toContain("PRD_BACKOFFICE_APP_URL: ${{ vars.PRD_BACKOFFICE_APP_URL }}");
    expect(workflow).toContain("PRD_SUPABASE_URL: ${{ vars.PRD_SUPABASE_URL }}");
    expect(workflow).toContain("PRD_SUPABASE_PROJECT_REF: ${{ vars.PRD_SUPABASE_PROJECT_REF }}");
    expect(workflow).toContain("PRD_SUPABASE_ANON_KEY: ${{ vars.PRD_SUPABASE_ANON_KEY }}");
    expect(releaseGenerator).toContain(
      '/^sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$/u.test(supabaseAnonKey ?? "")',
    );
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("self-hosted");
    expect(workflow).toContain("actions/download-artifact");
    expect(workflow).not.toContain("supabase db push");
    expect(workflow).not.toContain("/usr/local/sbin/setlivre-release-manager");
    expect(workflow).not.toMatch(/^\s*concurrency:/mu);
    expect(workflow).not.toMatch(/PRD_SSH|known_hosts|StrictHostKeyChecking|\bssh\b|\bscp\b/u);
    expect(ciWorkflow).toContain(
      "group: ci-${{ github.workflow }}-${{ github.event_name == 'push' && github.sha || github.ref }}",
    );
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it("runs publication identity validation only for recovery or an enabled main push", () => {
    expect(deliveryIdentityStep).toContain(
      "if: >-\n          github.event_name == 'workflow_dispatch' ||\n          (github.event_name == 'push' && vars.PRD_DEPLOY_ENABLED == 'true')",
    );
    expect(deliveryIdentityStep).not.toContain(
      "github.event_name == 'workflow_dispatch' || vars.PRD_DEPLOY_ENABLED == 'true'",
    );

    const cases = [
      { event: "pull_request", enabled: false, expected: false },
      { event: "pull_request", enabled: true, expected: false },
      { event: "push", enabled: false, expected: false },
      { event: "push", enabled: true, expected: true },
      { event: "workflow_dispatch", enabled: false, expected: true },
      { event: "workflow_dispatch", enabled: true, expected: true },
    ];
    for (const scenario of cases) {
      const shouldValidate =
        scenario.event === "workflow_dispatch" ||
        (scenario.event === "push" && scenario.enabled === true);
      expect(shouldValidate, `${scenario.event}/${scenario.enabled}`).toBe(scenario.expected);
    }

    for (const step of [deliveryIdentityStep, releaseIdentityStep]) {
      expect(step).toContain(
        "uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      );
      expect(step).toContain("github-token: ${{ github.token }}");
      expect(step).toContain("github.request(route");
      expect(step).toContain("value?.id === expectedRepositoryId");
      expect(step).toContain('step?.name === "Publish immutable release artifact"');
      expect(step).not.toMatch(/\bGH_TOKEN\b|curl --|python3|run:\s*\|/u);
    }
    expect(deliveryIdentityStep).toContain(
      'await git("merge-base", "--is-ancestor", releaseSha, "refs/remotes/origin/main")',
    );
    expect(releaseIdentityStep).toContain('core.setOutput("release_sha", releaseSha)');
    expect(releaseIdentityStep).toContain("job.head_sha !== approved.head_sha");
    expect(releaseIdentityStep).not.toContain("approved.head_sha !== releaseSha");
    expect(releaseIdentityStep).not.toContain("job.head_sha !== releaseSha");
    expect(deliveryIdentityStep).toContain('!/^[a-f0-9]{40}$/u.test(approved.head_sha ?? "")');
    expect(deliveryIdentityStep).toContain("job.head_sha !== approved.head_sha");
    expect(deliveryIdentityStep).not.toContain("approved.head_sha !== releaseSha");
    expect(deliveryIdentityStep).not.toContain("job.head_sha !== releaseSha");
  });

  it("runs the full unit and native build contracts on a GitHub-hosted Windows x64 runner", () => {
    expect(ciWorkflow).toContain("windows-native:");
    expect(ciWorkflow).toContain("name: Windows native contracts");
    expect(ciWorkflow).toContain("runs-on: windows-2025");
    expect(ciWorkflow).toContain("run: npm run test:unit");
    expect(ciWorkflow).not.toContain("runs-on: self-hosted");
    expect(ciWorkflow).toContain(
      "ref: ${{ github.event_name == 'workflow_dispatch' && inputs.release_sha || github.sha }}",
    );
    expect(ciWorkflow).toContain('--proto "=https" --proto-redir "=https" --tlsv1.2');
    expect(ciWorkflow).toContain("Get-FileHash -LiteralPath $npmArchive -Algorithm SHA256");
    expect(ciWorkflow).toContain("Get-FileHash -LiteralPath $npmArchive -Algorithm SHA512");
    expect(windowsNpmToolchainStep).toContain(
      "$npmRootItem = Get-Item -LiteralPath $npmRoot -Force -ErrorAction Stop",
    );
    expect(windowsNpmToolchainStep).toContain("[IO.FileAttributes]::ReparsePoint");
    expect(windowsNpmToolchainStep).toContain(
      "Remove-Item -LiteralPath $npmRoot -Recurse -Force -ErrorAction Stop",
    );
    expect(windowsNpmToolchainStep).toContain("if (Test-Path -LiteralPath $npmRoot)");
    expect(windowsNpmToolchainStep).not.toContain("SilentlyContinue");
    for (const [step, command, buildId, standalone] of [
      [windowsPublicBuildStep, "npm run build:web", ".next/BUILD_ID", ".next/standalone"],
      [
        windowsBackofficeBuildStep,
        "npm run build:backoffice",
        "apps/backoffice/.next/BUILD_ID",
        "apps/backoffice/.next/standalone",
      ],
    ]) {
      expect(step).toContain(command);
      expect(step).toContain(`Get-Content -LiteralPath "${buildId}"`);
      expect(step).toContain(`Get-Item -LiteralPath "${standalone}"`);
      expect(step).toContain("[IO.FileAttributes]::ReparsePoint");
      expect(step).toContain("windows-ci.invalid");
      expect(step).not.toContain("PRD_");
      expect(step).not.toContain("secrets.");
    }
    expect(windowsTrackedDeclarationsStep).toContain(
      "git diff --exit-code -- next-env.d.ts apps/backoffice/next-env.d.ts",
    );
    expect(windowsTrackedDeclarationsStep).not.toContain("git checkout");
  });

  it("keeps every inline shell block bounded for native Actionlint and ShellCheck", () => {
    for (const source of [ciWorkflow, workflow]) {
      const sizes = workflowRunBlockSizes(source);
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.max(...sizes)).toBeLessThan(4096);
    }
  });

  it("keeps administrative tools out of the release and emits a basename-only sidecar", () => {
    expect(releaseGenerator).not.toContain("@supabase/cli-linux-x64");
    expect(releaseGenerator).not.toContain("expectedSupabaseCliVersion");
    expect(releaseGenerator).not.toContain("packagedSupabaseCliPath");
    expect(releaseGenerator).not.toContain("supabaseCli");
    expect(releaseGenerator).toContain("copyRequiredFile(\n    supabaseConfigSource");
    expect(releaseGenerator).toContain(
      "writeFileSync(incomingChecksumPath, `${sha256}  ${basename(archivePath)}\\n`",
    );
    expect(releaseGenerator).toContain("information.nlink !== 1");
  });

  it("uploads only the canonical archive and basename-only sidecar at both handoff boundaries", () => {
    expect(ciReleaseUploadStep).toContain("include-hidden-files: true");
    expect(releaseUploadStep).toContain("include-hidden-files: true");
    const ciPathBlock = ciReleaseUploadStep.match(
      /          path: \|\r?\n((?:            [^\r\n]+\r?\n)+)          if-no-files-found: error/u,
    )?.[1];
    const releasePathBlock = releaseUploadStep.match(
      /          path: \|\r?\n((?:            [^\r\n]+\r?\n)+)          if-no-files-found: error/u,
    )?.[1];
    expect(ciPathBlock).toBeDefined();
    expect(releasePathBlock).toBeDefined();
    const ciUploadPaths = (ciPathBlock ?? "")
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim());
    const releaseUploadPaths = (releasePathBlock ?? "")
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim());
    expect(ciUploadPaths).toEqual([
      ".artifacts/set-livre-${{ env.RELEASE_SHA }}.tar.gz",
      ".artifacts/set-livre-${{ env.RELEASE_SHA }}.tar.gz.sha256",
    ]);
    expect(releaseUploadPaths).toEqual([
      ".artifacts/production-handoff/set-livre-${{ steps.identity.outputs.release_sha }}.tar.gz",
      ".artifacts/production-handoff/set-livre-${{ steps.identity.outputs.release_sha }}.tar.gz.sha256",
    ]);
    for (const path of [...ciUploadPaths, ...releaseUploadPaths]) {
      expect(path.endsWith(".tar.gz") || path.endsWith(".tar.gz.sha256")).toBe(true);
    }
    expect(ciReleaseUploadStep).toContain(
      "name: set-livre-ci-${{ env.RELEASE_SHA }}-${{ steps.release_identity.outputs.archive_sha256 }}-${{ steps.release_identity.outputs.public_build_config_sha256 }}",
    );
    expect(releaseUploadStep).toContain(
      "name: set-livre-${{ steps.identity.outputs.release_sha }}-${{ steps.identity.outputs.archive_sha256 }}-${{ steps.identity.outputs.public_build_config_sha256 }}",
    );
    expect(deliveryIdentityStep).toContain("approved publication artifact identity");
    expect(deliveryIdentityStep).toContain("approved publication digests");
    expect(releaseIdentityStep).toContain("reconstructed artifact identity");
    expect(releaseIdentityStep).toContain('core.setOutput("archive_sha256"');
    expect(ciWorkflow.indexOf("Resolve and bind the immutable release digests")).toBeLessThan(
      ciWorkflow.indexOf("Deliver canonical release artifact to the production workflow"),
    );
    expect(
      workflow.indexOf("\n      - name: Verify the canonical archive and schema 4 contract"),
    ).toBeLessThan(workflow.indexOf("\n      - name: Publish immutable release artifact"));
  });

  it("rejects a same-SHA reconstruction when its public build configuration changes", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "setlivre-recovery-identity-"));
    const releaseSha = "a".repeat(40);
    const artifacts = resolve(directory, ".artifacts");
    const release = resolve(directory, "release");
    const manifest = resolve(release, "manifest.json");
    const archive = resolve(artifacts, `set-livre-${releaseSha}.tar.gz`);
    const output = resolve(directory, "github-output");
    const configA = "b".repeat(64);
    const configB = "c".repeat(64);
    const archiveSha256 = () => createHash("sha256").update(readFileSync(archive)).digest("hex");
    const buildArchive = (publicBuildConfigSha256) => {
      writeFileSync(manifest, JSON.stringify({ publicBuildConfigSha256 }), {
        encoding: "utf8",
        flag: "w",
      });
      rmSync(archive, { force: true });
      const result = spawnSync(
        bashExecutable,
        ["-c", 'tar -czf "$1" release', "setlivre-recovery-archive", toBashPath(archive)],
        { cwd: directory, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      writeFileSync(`${archive}.sha256`, `${archiveSha256()}  set-livre-${releaseSha}.tar.gz\n`);
    };
    const verify = (expectedArchiveSha256, expectedPublicBuildConfigSha256) =>
      spawnSync(
        bashExecutable,
        ["-c", `node() { "$TEST_NODE" "$@"; }; ${releaseDigestBody}`, "setlivre-recovery-identity"],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            EXPECTED_ARCHIVE_SHA256: expectedArchiveSha256,
            EXPECTED_PUBLIC_BUILD_CONFIG_SHA256: expectedPublicBuildConfigSha256,
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_OUTPUT: toBashPath(output),
            RELEASE_SHA: releaseSha,
            TEST_NODE: toBashPath(process.execPath),
          },
        },
      );

    try {
      mkdirSync(artifacts, { recursive: true });
      mkdirSync(release, { recursive: true });
      buildArchive(configA);
      const originalArchiveSha256 = archiveSha256();
      const original = verify(originalArchiveSha256, configA);
      expect(original.status, original.stderr).toBe(0);

      buildArchive(configB);
      const rebuiltArchiveSha256 = archiveSha256();
      expect(rebuiltArchiveSha256).not.toBe(originalArchiveSha256);
      const changedConfiguration = verify(rebuiltArchiveSha256, configA);
      expect(changedConfiguration.status).not.toBe(0);
      expect(readFileSync(output, "utf8")).toContain(`archive_sha256=${originalArchiveSha256}`);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("runs pinned actionlint and ShellCheck downloads from a private x64 tool directory", () => {
    expect(ciWorkflow).toContain("runs-on: ubuntu-24.04");
    expect(workflowToolingStep).toContain("id: workflow_tooling");
    expect(workflowToolingStep).toContain('test "$(uname -m)" = "x86_64"');
    expect(workflowToolingStep).toContain('test "${RUNNER_ARCH:-}" = "X64"');
    expect(workflowToolingStep).toContain("umask 077");
    expect(workflowToolingStep).toContain(
      'mktemp -d "${RUNNER_TEMP}/set-livre-workflow-tools.XXXXXX"',
    );
    expect(
      workflowToolingStep.match(/curl --fail --silent --show-error --location/gu),
    ).toHaveLength(2);
    expect(
      workflowToolingStep.match(/--proto '=https' --proto-redir '=https' --tlsv1\.2/gu),
    ).toHaveLength(2);
    expect(workflowToolingStep).toContain(
      "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
    );
    expect(workflowToolingStep).toContain(
      "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    );
    expect(workflowToolingStep).toContain(
      "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.xz",
    );
    expect(workflowToolingStep).toContain(
      "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198",
    );
    expect(workflowToolingStep).toContain("sha256sum --check --strict");
    expect(workflowToolingStep).toContain(
      'test "$("$actionlint_binary" -version | head -n 1)" = "1.7.12"',
    );
    expect(workflowToolingStep).toContain('= "0.11.0"');
    expect(workflowToolingStep).toContain('PATH="$(dirname "$shellcheck_binary"):$PATH"');
    expect(workflowToolingStep).toContain('"$shellcheck_binary" "${shell_scripts[@]}"');
    expect(workflowToolingStep).not.toMatch(/\bsudo\b|apt-get|\/usr\/local/iu);
  });

  it("installs npm only from the doubly verified official 11.19.0 tarball", () => {
    const npmVersion = "11.19.0";
    const npmTarballUrl = "https://registry.npmjs.org/npm/-/npm-11.19.0.tgz";
    const npmTarballSha256 = "31e9770f7dc71119a58509353b27917557aaf0ac9b5ef1a0465ee7d8ec67ae75";
    const npmTarballSha512 =
      "48377f8478372aa1c4e47b763475b135836da82436a5700f2e5e8eb5084fc840f93c7b117eb3ad3b5f7d3194c81b6710a10d59448f6ddbcb21ac3fb672bdc003";

    for (const source of [ciWorkflow, workflow]) {
      expect(source).toContain(`NPM_CLI_VERSION: "${npmVersion}"`);
      expect(source).toContain(`NPM_CLI_TARBALL_URL: ${npmTarballUrl}`);
      expect(source).toContain(`NPM_CLI_TARBALL_SHA256: ${npmTarballSha256}`);
      expect(source).toContain(`NPM_CLI_TARBALL_SHA512: ${npmTarballSha512}`);
      expect(source).not.toMatch(/npm install[^\r\n]*npm@11\.19\.0/iu);
    }

    for (const step of [ciNpmToolchainStep, productionNpmToolchainStep]) {
      const download = step.indexOf("curl --fail --silent --show-error --location");
      const sha512 = step.indexOf("sha512sum --check --strict");
      const sha256 = step.indexOf("sha256sum --check --strict");
      const install = step.indexOf(
        'npm install --global --ignore-scripts --offline --no-audit --no-fund "$npm_archive"',
      );
      expect(download).toBeGreaterThan(-1);
      expect(sha512).toBeGreaterThan(download);
      expect(sha256).toBeGreaterThan(sha512);
      expect(install).toBeGreaterThan(sha256);
      expect(step).toContain("--proto '=https' --proto-redir '=https' --tlsv1.2");
      expect(step).toContain('test "$(npm --version)" = "$NPM_CLI_VERSION"');
    }
  });

  it("uploads only an allowlisted JSON failure report after always-on cleanup", () => {
    const reportedStepIds = [
      "checkout",
      "workflow_tooling",
      "setup_node",
      "npm_toolchain",
      "dependencies",
      "static_unit",
      "supabase_reset",
      "database_docs",
      "playwright_install",
      "e2e_affected",
      "e2e_complete",
      "build",
      "supply_chain",
      "cleanup_supabase",
    ];
    for (const id of reportedStepIds) {
      expect(ciWorkflow).toContain(`id: ${id}`);
      expect(failureReportStep).toContain(`\${{ steps.${id}.outcome }}`);
    }
    expect(cleanupSupabaseStep).toContain("if: always()");
    expect(ciWorkflow.indexOf("- name: Stop the scoped local Supabase stack")).toBeLessThan(
      ciWorkflow.indexOf("- name: Write allowlisted CI failure report"),
    );
    expect(failureReportStep).toContain("if: failure()");
    expect(failureReportStep).toContain("report_root=ci-failure-artifact");
    expect(failureReportStep).toContain('install -d -m 0700 "$report_root"');
    expect(failureReportStep).toContain("mode: 0o600");
    expect(failureReportStep).toMatch(
      /const report = \{\s+sha,\s+run: \{ id: runId, number: runNumber, attempt: runAttempt \},\s+steps,\s+\};/u,
    );
    expect(failureReportStep).not.toMatch(
      /process\.env|toJSON\(|\b(?:logs?|traces?|screenshots?|cookies?)\b/iu,
    );

    expect(failureReportUploadStep).toContain(
      "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(failureReportUploadStep).toContain(
      "if: failure() && steps.failure_report.outcome == 'success'",
    );
    expect(failureReportUploadStep).toContain("path: ci-failure-artifact/ci-failure.json");
    expect(failureReportUploadStep).toContain("if-no-files-found: error");
    expect(failureReportUploadStep).toContain("include-hidden-files: false");
    expect(failureReportUploadStep).not.toContain("**");
    expect(failureReportUploadStep).not.toMatch(/\b(?:logs?|traces?|screenshots?|cookies?)\b/iu);
  });

  it("contains no mutation step because the outbound VM deployer owns that boundary", () => {
    expect(workflow).not.toMatch(/\bactivate\b|\bconfirm\b|\brollback\b/u);
    expect(workflow).not.toMatch(/SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD/u);
    expect(workflow).not.toMatch(/DATABASE_URL_APP_DAL/u);
  });

  it("binds the release to commit, x86_64 runtime, lock hash and migration head", () => {
    expect(releaseGenerator).toContain("schemaVersion: 4");
    expect(releaseGenerator).toContain("publicBuildConfigSha256: buildConfigSha256");
    expect(releaseGenerator).toContain(
      "publicBuildConfigurationFromBuildEnvironments(buildEnvironments)",
    );
    expect(releaseGenerator).toContain("productionPublicBuildConfigSha256()");
    expect(releaseGenerator).toContain(
      'lockfile: { path: "package-lock.json", sha256: lockSha256 }',
    );
    expect(releaseGenerator).toContain('directory: "supabase/migrations"');
    expect(releaseGenerator).toContain(
      'import { databaseMigrationHead } from "../packages/contracts/src/database-contract.ts"',
    );
    expect(releaseGenerator).not.toMatch(/const expected(?:Previous)?MigrationHead = "\d{14}"/u);
    expect(releaseGenerator).toContain("head: expectedMigrationHead");
    expect(releaseGenerator).toContain('mode: "expand-only"');
    expect(releaseGenerator).not.toContain("supabaseCli");
    expect(releaseManager).toContain(
      '"runtime": {"arch": "x64", "platform": "linux", "node": node_version}',
    );
    expect(releaseManager).toContain('"schemaVersion": 4');
    expect(releaseManager).toContain('"publicBuildConfigSha256": public_build_config_sha256');
    expect(releaseManager).not.toContain('"schemaVersion": 3');
    expect(deployAgent).toContain('manifest.get("schemaVersion") != 4');
    expect(deployAgent).not.toContain('manifest.get("schemaVersion") != 3');
    expect(releaseManager).toContain('"mode": "expand-only"');
    expect(releaseManager).not.toContain("readonly migration_head=");
    expect(releaseManager).toContain('[[ "$expected_migration_head" =~ ^[0-9]{14}$ ]]');
    expect(releaseManager).toContain('r"sb_publishable_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}"');
    expect(activateFunction).toContain('local run_number="$5"');
    expect(activateFunction).toContain('local run_attempt="$6"');
    expect(activateFunction).toContain('local run_id="$7"');
    expect(activateFunction).toContain('local artifact_id="$8"');
    expect(activateFunction).toContain('local artifact_digest="$9"');
    expect(activateFunction).toContain('assert_positive_integer "$run_number"');
    expect(activateFunction).toContain('assert_positive_integer "$run_attempt"');
    expect(activateFunction).toContain('assert_positive_integer "$run_id"');
    expect(activateFunction).toContain('assert_positive_integer "$artifact_id"');
    expect(releaseManager).toContain('[[ "$#" -eq 10 ]] || fail');
    expect(releaseManager).toContain('"${10}"');
  });

  it("accepts one schema-4 release across producer, agent and root manager and rejects schema 3", () => {
    const root = mkdtempSync(resolve(tmpdir(), "setlivre-schema4-"));
    const releaseSha = "a".repeat(40);
    const migrationHead = databaseMigrationHead;
    const packageLock = "{}\n";
    const lockSha = createHash("sha256").update(packageLock).digest("hex");
    const publicBuildConfiguration = {
      backofficeAppUrl: "https://ops.setlivre.com",
      publicAppUrl: "https://setlivre.com",
      supabaseAnonKey: `sb_publishable_${"a".repeat(22)}_${"b".repeat(8)}`,
      supabaseUrl: syntheticSupabaseUrl,
    };
    const publicBuildConfigSha = createHash("sha256")
      .update(JSON.stringify(publicBuildConfiguration))
      .digest("hex");
    const manifest = {
      schemaVersion: 4,
      commit: releaseSha,
      publicBuildConfigSha256: publicBuildConfigSha,
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
      lockfile: { path: "package-lock.json", sha256: lockSha },
    };

    try {
      for (const directory of [
        "web/.next",
        "backoffice/apps/backoffice/.next",
        "supabase/migrations",
      ]) {
        mkdirSync(resolve(root, directory), { recursive: true });
      }
      writeFileSync(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(resolve(root, "package-lock.json"), packageLock);
      writeFileSync(resolve(root, "web/server.js"), "export {};\n");
      writeFileSync(resolve(root, "web/.next/BUILD_ID"), `${releaseSha}\n`);
      writeFileSync(resolve(root, "backoffice/apps/backoffice/server.js"), "export {};\n");
      writeFileSync(resolve(root, "backoffice/apps/backoffice/.next/BUILD_ID"), `${releaseSha}\n`);
      writeFileSync(resolve(root, "supabase/config.toml"), 'project_id = "set-livre"\n');
      writeFileSync(resolve(root, "supabase/roles.sql"), "select 1;\n");
      writeFileSync(resolve(root, "supabase/authorization-catalog.sql"), "select 1;\n");
      writeFileSync(resolve(root, "supabase/authorization-contract.json"), "{}\n");
      writeFileSync(resolve(root, "supabase/baseline-authorization-contract.json"), "{}\n");
      writeFileSync(resolve(root, "supabase/authorization-head.json"), "{}\n");
      writeFileSync(
        resolve(root, `supabase/migrations/${migrationHead}_fixture.sql`),
        "select 1;\n",
      );
      const argumentsForManager = [
        toBashPath(root),
        releaseSha,
        lockSha,
        migrationHead,
        publicBuildConfigSha,
      ];
      const argumentsForAgent = [toBashPath(root), releaseSha, publicBuildConfigSha];
      const managerAcceptance = spawnBashHarness(
        [
          "source scripts/production-release-manager.sh",
          'validate_release_tree "$1" "$2" "$3" "$4" "$5"',
        ],
        argumentsForManager,
      );
      expect({
        status: managerAcceptance.status,
        stderr: managerAcceptance.stderr,
      }).toEqual({ status: 0, stderr: "" });
      expect(
        spawnBashHarness(
          ["source scripts/production-deploy-agent.sh", 'validate_release_tree "$1" "$2" "$3"'],
          argumentsForAgent,
        ).status,
      ).toBe(0);

      writeFileSync(
        resolve(root, "manifest.json"),
        `${JSON.stringify({ ...manifest, schemaVersion: 3 }, null, 2)}\n`,
      );
      expect(
        spawnBashHarness(
          [
            "source scripts/production-release-manager.sh",
            'validate_release_tree "$1" "$2" "$3" "$4" "$5"',
          ],
          argumentsForManager,
        ).status,
      ).not.toBe(0);
      expect(
        spawnBashHarness(
          ["source scripts/production-deploy-agent.sh", 'validate_release_tree "$1" "$2" "$3"'],
          argumentsForAgent,
        ).status,
      ).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recomputes the public build digest from the exact staged credential bytes", () => {
    const root = mkdtempSync(resolve(tmpdir(), "setlivre-public-config-"));
    const webEnvironment = resolve(root, "web.env");
    const backofficeEnvironment = resolve(root, "backoffice.env");
    const anonKey = `sb_publishable_${"a".repeat(22)}_${"b".repeat(8)}`;
    const alternateAnonKey = `sb_publishable_${"c".repeat(22)}_${"d".repeat(8)}`;
    const writeEnvironments = (lineEnding = "\n", key = anonKey) => {
      writeFileSync(
        webEnvironment,
        [
          "NEXT_PUBLIC_APP_URL='https://setlivre.com'",
          `NEXT_PUBLIC_SUPABASE_URL='${syntheticSupabaseUrl}'`,
          `NEXT_PUBLIC_SUPABASE_ANON_KEY='${key}'`,
          "",
        ].join(lineEnding),
      );
      writeFileSync(
        backofficeEnvironment,
        [
          "NEXT_PUBLIC_APP_URL='https://ops.setlivre.com'",
          `NEXT_PUBLIC_SUPABASE_URL='${syntheticSupabaseUrl}'`,
          `NEXT_PUBLIC_SUPABASE_ANON_KEY='${key}'`,
          "",
        ].join(lineEnding),
      );
    };
    const calculate = () =>
      spawnBashHarness(
        [
          "source scripts/production-release-manager.sh",
          'public_build_config_sha256_from_credentials "$1" "$2"',
        ],
        [toBashPath(webEnvironment), toBashPath(backofficeEnvironment)],
      );

    try {
      writeEnvironments();
      const expected = createHash("sha256")
        .update(
          JSON.stringify({
            backofficeAppUrl: "https://ops.setlivre.com",
            publicAppUrl: "https://setlivre.com",
            supabaseAnonKey: anonKey,
            supabaseUrl: syntheticSupabaseUrl,
          }),
        )
        .digest("hex");
      const accepted = calculate();
      expect(accepted.status).toBe(0);
      expect(accepted.stdout.trim()).toBe(expected);

      writeEnvironments("\n", alternateAnonKey);
      const changed = calculate();
      expect(changed.status).toBe(0);
      expect(changed.stdout.trim()).not.toBe(expected);

      writeEnvironments("\r\n");
      expect(calculate().status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the Supabase ref from runtime credentials and binds the DAL host to it", () => {
    const root = mkdtempSync(resolve(tmpdir(), "setlivre-runtime-supabase-"));
    const credential = resolve(root, "web.env");
    const releaseSha = "a".repeat(40);
    const anonKey = `sb_publishable_${"a".repeat(22)}_${"b".repeat(8)}`;
    const writeCredential = ({
      databaseProjectRef = syntheticSupabaseProjectRef,
      supabaseUrl = syntheticSupabaseUrl,
    } = {}) => {
      const databaseUrl =
        `postgresql://app_runtime_prod:synthetic-password@db.${databaseProjectRef}.supabase.co:5432/postgres` +
        "?options=-c%20role%3Dapp_dal";
      writeFileSync(
        credential,
        [
          "NODE_ENV='production'",
          "APP_ENV='production'",
          `APP_RELEASE_SHA='${releaseSha}'`,
          "NEXT_TELEMETRY_DISABLED='1'",
          "HOSTNAME='127.0.0.1'",
          "PORT='3000'",
          "NEXT_PUBLIC_APP_URL='https://setlivre.com'",
          `NEXT_PUBLIC_SUPABASE_URL='${supabaseUrl}'`,
          `NEXT_PUBLIC_SUPABASE_ANON_KEY='${anonKey}'`,
          "DATABASE_TLS_CA_PATH='/run/credentials/setlivre-web.service/supabase-server-ca.pem'",
          `DATABASE_TLS_CA_SHA256='${"c".repeat(64)}'`,
          `DATABASE_URL_APP_DAL='${databaseUrl}'`,
          "",
        ].join("\n"),
      );
    };
    const validate = () =>
      runReleaseManagerPython("RUNTIME_CREDENTIAL_PY", [credential, "web", releaseSha]);

    try {
      writeCredential();
      const accepted = validate();
      expect({
        status: accepted.status,
        stderr: accepted.stderr,
      }).toEqual({ status: 0, stderr: "" });
      expect(accepted.stdout.trim()).toMatch(/^[a-f0-9]{64}$/u);

      writeCredential({ databaseProjectRef: "z".repeat(20) });
      expect(validate().status).not.toBe(0);

      writeCredential({ supabaseUrl: `${syntheticSupabaseUrl}/` });
      expect(validate().status).not.toBe(0);

      expect(releaseManager).not.toContain("readonly supabase_project_ref=");
      expect(releaseManager).toContain("project_ref = supabase_match.group(1)");
      expect(releaseManager).toContain('direct_host = f"db.{project_ref}.supabase.co"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preflights deployer uploads as root before migrations and activates the same bytes", () => {
    expect(releaseManager).toContain("readonly deployer_user=setlivre-deployer");
    expect(releaseManager).toContain('readonly deployer_home="/var/lib/$deployer_user"');
    expect(releaseManager).toContain(
      'readonly deployer_incoming_base="$deployer_home/.setlivre/incoming"',
    );
    expect(releaseManager).not.toMatch(/readonly deployer_user=setlivre-deploy(?:\r?\n|$)/u);
    expect(releaseManager).toContain(
      'readonly private_staging_base="$base/shared/release-staging"',
    );
    expect(copyUploadFunction.match(/install -o root -g root -m 0600/gu)).toHaveLength(3);
    expect(copyUploadFunction).toContain(
      'assert_root_private_file "$private_staging/release.tar.gz"',
    );
    expect(copyUploadFunction).not.toContain("rm -rf");
    expect(releaseManager).not.toContain("cleanup_upload");
    expect(releaseManager).toContain('output="$(sha256sum -- "$path")" || fail');
    expect(releaseManager).toContain('digest="${output%% *}"');
    expect(releaseManager).not.toMatch(/sha256sum[^\n]*\|\s*cut/u);

    const privateCopy = preflightFunction.indexOf("copy_upload_to_private_staging");
    const privateArchive = preflightFunction.indexOf(
      'archive="$activation_private_staging/release.tar.gz"',
    );
    const checksum = preflightFunction.indexOf('file_sha256 "$archive"');
    const validation = preflightFunction.indexOf(
      'validate_runtime_credential "$web_runtime_credential"',
    );
    const publicConfigHash = preflightFunction.indexOf(
      "public_build_config_sha256_from_credentials",
    );
    const preparingState = preflightFunction.indexOf("write_preflight_state preparing");
    const extraction = preflightFunction.indexOf('tar --extract --gzip --file "$archive"');
    const releaseValidation = preflightFunction.indexOf("validate_release_tree");
    const readyState = preflightFunction.indexOf("write_preflight_state ready");
    expect(privateArchive).toBeGreaterThan(privateCopy);
    expect(checksum).toBeGreaterThan(privateArchive);
    expect(validation).toBeGreaterThan(checksum);
    expect(publicConfigHash).toBeGreaterThan(validation);
    expect(preparingState).toBeGreaterThan(publicConfigHash);
    expect(extraction).toBeGreaterThan(preparingState);
    expect(releaseValidation).toBeGreaterThan(extraction);
    expect(readyState).toBeGreaterThan(releaseValidation);
    expect(preflightFunction).toContain('validate_release_archive "$archive"');
    expect(activateFunction).not.toContain("copy_upload_to_private_staging");
    expect(activateFunction).not.toContain('tar --extract --gzip --file "$archive"');
    expect(activateFunction).toContain("load_preflight_state");
    expect(activateFunction).toContain("assert_preflight_identity");
    expect(activateFunction).toContain('file_sha256 "$web_runtime_credential"');
    expect(activateFunction).toContain('== "$preflight_web_runtime_credential_sha"');
    expect(activateFunction).toContain('file_sha256 "$backoffice_runtime_credential"');
    expect(activateFunction).toContain('== "$preflight_backoffice_runtime_credential_sha"');
    expect(activateFunction).toContain("public_build_config_sha256_from_credentials");
    expect(preflightFunction).toContain(
      'install -d -o root -g root -m 0700 "$activation_runtime_candidate"',
    );
    expect(preflightFunction.match(/install -o root -g root -m 0600/gu)).toHaveLength(2);
    expect(releaseManager).toContain(
      '[[ "$(stat -c \'%U:%G:%a\' -- "$target")" == root:root:700 ]]',
    );
    expect(releaseManager).toContain('assert_root_private_file "$target/web.env"');
    expect(releaseManager).toContain('assert_root_private_file "$target/backoffice.env"');
    expect(releaseManager).toContain('archive = tarfile.open(archive_path, mode="r:gz")');
    expect(releaseManager).toContain('parts[0] != "release"');
    expect(releaseManager).toContain("if not (member.isfile() or member.isdir()):");
    expect(releaseManager).toContain("if member.mode & 0o7000:");
    expect(releaseManager).toContain("information.st_nlink != 1");
    expect(preflightFunction).toContain("trap cleanup_activation EXIT");
    expect(activateFunction).toContain("trap cleanup_activation EXIT");
    expect(activateFunction).toContain("cleanup_activation_resources");
    expect(releaseManager).toContain(
      'readonly cleanup_pending_state="$state_base/cleanup-resources.state"',
    );
    expect(cleanupActivationFunction).toContain("write_cleanup_pending_state");
    expect(recoverCleanupFunction).toContain("cleanup_activation_resources || fail");
    expect(recoverCleanupFunction).toContain("clear_cleanup_pending_state || fail");
    expect(activateFunction.indexOf("recover_pending_cleanup_locked")).toBeLessThan(
      activateFunction.indexOf("recover_pending_activation_locked"),
    );
    expect(releaseManager).not.toContain("/tmp/set-livre-");
  });

  it("accepts only one exact release identity in durable cleanup recovery state", () => {
    const release = "a".repeat(40);
    const accepted = spawnBashHarness(
      [
        "source scripts/production-release-manager.sh",
        'assert_cleanup_resource_targets "$1" "$2" "$3" "$4" "$5"',
      ],
      [
        `/opt/setlivre/shared/release-staging/${release}`,
        `/opt/setlivre/releases/.incoming-${release}`,
        `/opt/setlivre/shared/runtime/releases/.incoming-${release}`,
        `/opt/setlivre/shared/release-state/${release}.pending`,
        "/opt/setlivre/shared/release-state/release-preflight.state",
      ],
    );
    expect(accepted.status).toBe(0);

    const mismatched = spawnBashHarness(
      [
        "source scripts/production-release-manager.sh",
        'assert_cleanup_resource_targets "$1" "$2" "$3" none none',
      ],
      [
        `/opt/setlivre/shared/release-staging/${release}`,
        `/opt/setlivre/releases/.incoming-${"b".repeat(40)}`,
        `/opt/setlivre/shared/runtime/releases/.incoming-${release}`,
      ],
    );
    expect(mismatched.status).not.toBe(0);
  });

  it("recovers only the manager tree authorized before an abrupt post-rename kill", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "setlivre-manager-cleanup-"));
    const base = resolve(directory, "setlivre");
    const releases = resolve(base, "releases");
    const runtimeReleases = resolve(base, "shared/runtime/releases");
    const privateStagingBase = resolve(base, "shared/release-staging");
    const stateBase = resolve(base, "shared/release-state");
    const releaseSha = "a".repeat(40);
    const staging = resolve(privateStagingBase, releaseSha);
    const retired = resolve(privateStagingBase, `.cleanup-retired-${releaseSha}`);
    const unrelated = resolve(privateStagingBase, "unrelated");
    const transformedScript = resolve(directory, "production-release-manager.cleanup-test.sh");
    const currentUser = spawnSync(bashExecutable, ["-c", "id -un"], {
      encoding: "utf8",
    }).stdout.trim();
    const transformed = releaseManager
      .replace(/^readonly base=.*$/mu, `readonly base=${JSON.stringify(toBashPath(base))}`)
      .replace(
        '[[ "$(stat -c \'%U\' -- "$candidate")" == root ]] || return 1',
        `[[ "$(stat -c '%U' -- "$candidate")" == ${JSON.stringify(currentUser)} ]] || return 1`,
      );
    writeFileSync(transformedScript, transformed);
    for (const path of [
      releases,
      runtimeReleases,
      privateStagingBase,
      stateBase,
      staging,
      unrelated,
    ]) {
      mkdirSync(path, { recursive: true });
      chmodSync(path, 0o700);
    }
    writeFileSync(resolve(staging, "payload"), "authorized\n");
    writeFileSync(resolve(unrelated, "keep"), "unrelated\n");
    const harnessPrelude = [
      'source "$1"',
      "assert_no_mount_at_or_below() { return 0; }",
      "durable_sync_directory() { return 0; }",
      'assert_root_private_file() { [[ -f "$1" && ! -L "$1" ]]; }',
      'write_root_state_file() { local destination="$1"; shift; local candidate="${destination}.tmp"; printf "%s\\n" "$@" >"$candidate"; chmod 0600 "$candidate"; command mv -f -- "$candidate" "$destination"; }',
    ];
    const interrupted = spawnSync(
      bashExecutable,
      [
        "-c",
        [
          ...harnessPrelude,
          `activation_private_staging=${JSON.stringify(toBashPath(staging))}`,
          "activation_release_candidate=",
          "activation_runtime_candidate=",
          "activation_pending_state=",
          "activation_preflight_state=",
          "activation_lease_armed=0",
          'mv() { command mv "$@"; local destination="${@: -1}"; if [[ "$destination" == "$private_staging_base/.cleanup-retired-"* ]]; then kill -KILL $$; fi; }',
          "cleanup_activation",
        ].join("; "),
        "setlivre-manager-cleanup-crash",
        toBashPath(transformedScript),
      ],
      { encoding: "utf8" },
    );
    expect(interrupted.status).not.toBe(0);
    expect(existsSync(resolve(stateBase, "cleanup-resources.state"))).toBe(true);
    expect(existsSync(retired)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);

    const recovered = spawnSync(
      bashExecutable,
      [
        "-c",
        [...harnessPrelude, "recover_pending_cleanup_locked"].join("; "),
        "setlivre-manager-cleanup-recovery",
        toBashPath(transformedScript),
      ],
      { encoding: "utf8" },
    );
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(existsSync(retired)).toBe(false);
    expect(existsSync(resolve(stateBase, "cleanup-resources.state"))).toBe(false);
    expect(readFileSync(resolve(unrelated, "keep"), "utf8")).toBe("unrelated\n");
    rmSync(directory, { force: true, recursive: true });
  });

  it("retires cleanup trees and revalidates descendant mounts immediately before removal", () => {
    expect(releaseManager).toContain("/proc/self/mountinfo");
    expect(releaseManager).toContain("os.path.commonpath((candidate, mount_point)) == candidate");
    expect(releaseManager).toContain(
      'escapes = {"011": "\\t", "012": "\\n", "040": " ", "134": "\\\\"}',
    );
    const firstMountCheck = cleanupPrivateTreeFunction.indexOf(
      'assert_no_mount_at_or_below "$candidate"',
    );
    const identityCapture = cleanupPrivateTreeFunction.indexOf("candidate_identity=");
    const authorization = cleanupPrivateTreeFunction.indexOf(
      'cleanup_private_target_is_authorized "$candidate" "$allowed_parent"',
    );
    const rename = cleanupPrivateTreeFunction.indexOf("mv --no-target-directory --");
    const identityRevalidation = cleanupPrivateTreeFunction.indexOf('== "$candidate_identity"');
    const retiredMountChecks = cleanupPrivateTreeFunction.match(
      /assert_no_mount_at_or_below "\$retired"/gu,
    );
    const removal = cleanupPrivateTreeFunction.indexOf("rm -rf --one-file-system --");
    expect(identityCapture).toBeGreaterThan(firstMountCheck);
    expect(authorization).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(authorization);
    expect(rename).toBeGreaterThan(identityCapture);
    expect(identityRevalidation).toBeGreaterThan(rename);
    expect(retiredMountChecks).toHaveLength(2);
    expect(cleanupPrivateTreeFunction).toContain(
      'local retired="$allowed_parent/.cleanup-retired-${candidate##*/}"',
    );
    expect(cleanupPrivateTreeFunction).toContain(
      '[[ ! -e "$original" && ! -L "$original" ]] || return 1',
    );
    expect(cleanupPrivateTreeFunction).toContain('candidate="$retired"');
    expect(
      cleanupPrivateTreeFunction.lastIndexOf('assert_no_mount_at_or_below "$retired"'),
    ).toBeLessThan(removal);
    expect(cleanupPrivateTreeFunction).not.toContain('rm -rf --one-file-system -- "$candidate"');
  });

  it("reverts pending activation under the manager lock before boot traffic", () => {
    const webInactive = bootRecoveryFunction.indexOf('assert_service_inactive "$web_service"');
    const backofficeInactive = bootRecoveryFunction.indexOf(
      'assert_service_inactive "$backoffice_service"',
    );
    const nginxInactive = bootRecoveryFunction.indexOf('assert_service_inactive "$nginx_service"');
    const recover = bootRecoveryFunction.indexOf("recover_pending_activation_at_boot_locked");
    expect(webInactive).toBeGreaterThan(bootRecoveryFunction.indexOf("flock -w 30 9 || fail"));
    expect(backofficeInactive).toBeGreaterThan(webInactive);
    expect(nginxInactive).toBeGreaterThan(backofficeInactive);
    expect(recover).toBeGreaterThan(nginxInactive);
    expect(bootRecoveryFunction).not.toContain("restart_and_assert");
    expect(bootRecoveryFunction).not.toContain("run_recovery_smoke");
    expect(bootPendingRecoveryFunction.indexOf("write_recovery_state")).toBeLessThan(
      bootPendingRecoveryFunction.indexOf("apply_boot_safe_links"),
    );
    expect(bootPendingRecoveryFunction).toContain('safe_active_sha="$recovery_requested_sha"');
    expect(bootPendingRecoveryFunction).toContain('safe_active_sha="$recovery_source_sha"');
    expect(bootPendingRecoveryFunction.indexOf("apply_boot_safe_links")).toBeLessThan(
      bootPendingRecoveryFunction.indexOf('"$(pending_state_path "$recovery_source_sha")"'),
    );
  });

  it("writes immutable exact per-release provenance before publishing the release directory", () => {
    const provenanceWrite = activateFunction.indexOf("ensure_release_provenance");
    const immutableMove = activateFunction.indexOf(
      'mv -- "$activation_release_candidate" "$release"',
    );
    expect(provenanceWrite).toBeGreaterThan(-1);
    expect(immutableMove).toBeGreaterThan(provenanceWrite);
    expect(activateFunction).toContain("assert_release_provenance");
    expect(releaseManager).toContain('assert_release_provenance_record "$release_sha"');
    expect(releaseManager).toContain("readonly provenance_base=");
    expect(releaseManager).toContain("mv -Tn --");
    expect(preflightFunction).toContain('assert_available_space "$private_staging_base"');
    expect(preflightFunction).toContain('assert_available_space "$releases"');

    const release = "a".repeat(40);
    const archive = "b".repeat(64);
    const lock = "c".repeat(64);
    const artifact = "d".repeat(64);
    const common = [
      "source scripts/production-release-manager.sh",
      'PROVENANCE="$(mktemp)"',
      "trap 'rm -f -- \"$PROVENANCE\"' EXIT",
      'release_provenance_path() { printf "%s" "$PROVENANCE"; }',
      "assert_root_private_file() { :; }",
      'printf \'%s\\n\' \'protocol=3\' "release_sha=$1" "archive_sha=$2" "lock_sha=$3" "migration_head=$4" "run_number=$5" "run_attempt=$6" "run_id=$7" "artifact_id=$8" "artifact_digest=$9" >"$PROVENANCE"',
    ];
    const values = [release, archive, lock, databaseMigrationHead, "12", "2", "34", "56", artifact];
    const accepted = spawnBashHarness(
      [...common, 'assert_release_provenance "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9"'],
      values,
    );
    expect(accepted.status).toBe(0);

    const divergent = spawnBashHarness(
      [...common, 'assert_release_provenance "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "${10}"'],
      [...values, "e".repeat(64)],
    );
    expect(divergent.status).not.toBe(0);
  });

  it("durably persists state, release trees and every atomic pointer transition", () => {
    expect(releaseManager).toContain("sync --file-system --");
    expect(atomicLinkFunction.indexOf("durable_sync_directory")).toBeGreaterThan(
      atomicLinkFunction.indexOf("mv -Tf --"),
    );
    expect(atomicLinkFunction).toContain('ln -s -- "$target" "$temporary" || fail');
    expect(atomicLinkFunction).toContain('mv -Tf -- "$temporary" "$destination" || fail');
    expect(stateWriteFunction.indexOf("durable_sync_directory")).toBeGreaterThan(
      stateWriteFunction.indexOf("mv -Tf --"),
    );
    expect(provenanceWriteFunction.indexOf("durable_sync_directory")).toBeGreaterThan(
      provenanceWriteFunction.indexOf("mv -Tn --"),
    );

    const releaseMove = activateFunction.indexOf(
      'mv -- "$activation_release_candidate" "$release"',
    );
    const releaseSync = activateFunction.indexOf('durable_sync_directory "$releases"');
    const runtimeMove = activateFunction.indexOf(
      'mv -- "$activation_runtime_candidate" "$runtime_release"',
    );
    const runtimeSync = activateFunction.indexOf('durable_sync_directory "$runtime_base/releases"');
    const pendingWrite = activateFunction.indexOf("write_pending_state");
    expect(releaseSync).toBeGreaterThan(releaseMove);
    expect(runtimeSync).toBeGreaterThan(runtimeMove);
    expect(pendingWrite).toBeGreaterThan(releaseSync);
    expect(pendingWrite).toBeGreaterThan(runtimeSync);
  });

  it("requires both services and both health endpoints after every restart", () => {
    expect(releaseManager).toContain(
      "curl --disable --noproxy '*' --proto '=http' --fail --silent --show-error",
    );
    expect(restartFunction).toContain('[[ "$(systemd_active_state "$web_service")" == active ]]');
    expect(restartFunction).toContain(
      '&& [[ "$(systemd_active_state "$backoffice_service")" == active ]]',
    );
    expect(restartFunction).toContain(
      "&& assert_health http://127.0.0.1:3000/api/health/ready web",
    );
    expect(restartFunction).toContain(
      "&& assert_health http://127.0.0.1:3001/api/health/ready backoffice",
    );
    expect(firstReleaseStopFunction).toContain(
      'assert_service_inactive "$web_service" || return 1',
    );
    expect(firstReleaseStopFunction).toContain(
      'assert_service_inactive "$backoffice_service" || return 1',
    );
    expect(firstReleaseStopFunction.indexOf("systemctl stop")).toBeLessThan(
      firstReleaseStopFunction.indexOf('rm -f -- "$base/current"'),
    );
    const pointerRemoval = firstReleaseStopFunction.indexOf('rm -f -- "$base/current"');
    expect(firstReleaseStopFunction.indexOf("|| return 1", pointerRemoval)).toBeGreaterThan(
      pointerRemoval,
    );
    expect(releaseManager).not.toContain("|| true");
    expect(releaseManager).not.toContain("journalctl");
  });

  it("shares a monotonic lease with margin and persists authoritative rollback results", () => {
    expect(releaseManager).toContain("readonly protocol_version=3");
    expect(releaseManager).toContain("readonly activation_lease_seconds=1800");
    expect(releaseManager).toContain("readonly confirmation_margin_seconds=120");
    expect(releaseManager).toContain("readonly smoke_timeout_seconds=1080");
    expect(releaseManager).toContain('readonly state_base="$base/shared/release-state"');
    expect(releaseManager).toContain(
      'env -i PATH="$PATH" LANG="$LANG" LC_ALL="$LC_ALL" systemd-run \\',
    );
    expect(scheduleWatchdogFunction).toContain("remaining_seconds=$((activation_deadline - now))");
    expect(scheduleWatchdogFunction).toContain('--on-active="${remaining_seconds}s"');
    expect(scheduleWatchdogFunction).toContain('"$manager_path" watchdog "$release_sha"');
    expect(scheduleWatchdogFunction).not.toContain('"$manager_path" rollback "$release_sha"');
    expect(releaseManager).toContain('"protocol=3"');
    expect(releaseManager).toContain('"rollback_sha=$rollback_sha"');
    expect(releaseManager).toContain('"activation_deadline=$activation_deadline"');
    expect(releaseManager).toContain("printf '%s/recovery.pending' \"$state_base\"");
    expect(releaseManager).toContain("write_confirmed_state");
    for (const lockedOperation of [preflightFunction, activateFunction, bootRecoveryFunction]) {
      expect(lockedOperation).toContain('exec 9>"/run/lock/setlivre-release-manager.lock"');
      expect(lockedOperation).toContain("flock -w 30 9 || fail");
    }
    expect(recoverySmokeFunction).toContain("assert_installed_smoke");
    expect(recoverySmokeFunction).toContain('[[ "$(node --version)" == "$node_version" ]]');
    expect(recoverySmokeFunction).toContain('PRD_PUBLIC_APP_URL="$public_app_url"');
    expect(recoverySmokeFunction).toContain('PRD_BACKOFFICE_APP_URL="$backoffice_app_url"');
    expect(recoverySmokeFunction).toContain(
      'timeout --signal=TERM --kill-after=30s "${smoke_timeout_seconds}s" \\',
    );
    expect(watchdogFunction).toContain('rollback_pending_locked "$failed_sha"');
    expect(watchdogFunction).not.toContain("run_recovery_smoke");
    expect(completeRecoveryFunction).toContain('run_recovery_smoke "$recovery_active_sha" || fail');
    expect(completeRecoveryFunction).toContain(
      'write_activation_result_state "$source_sha" rejected "$recovery_active_sha"',
    );
    const activationRecoveryBranch = completeRecoveryFunction.slice(
      completeRecoveryFunction.indexOf('if [[ "$operation" == activation ]]'),
      completeRecoveryFunction.indexOf('if [[ "$recovery_phase" == recovery ]]'),
    );
    expect(activationRecoveryBranch.match(/run_recovery_smoke/gu)).toHaveLength(1);
    expect(activationRecoveryBranch.indexOf('[[ -e "$terminal_path"')).toBeLessThan(
      activationRecoveryBranch.indexOf("run_recovery_smoke"),
    );
    expect(activationRecoveryBranch.indexOf("run_recovery_smoke")).toBeLessThan(
      activationRecoveryBranch.lastIndexOf("write_activation_result_state"),
    );
    expect(completeRecoveryFunction).toContain('assert_service_inactive "$web_service" || fail');
    expect(completeRecoveryFunction).toContain(
      'assert_service_inactive "$backoffice_service" || fail',
    );

    const lease = activateFunction.indexOf("schedule_watchdog");
    const currentSwitch = activateFunction.indexOf('atomic_link "$release" "$base/current"');
    expect(lease).toBeGreaterThan(-1);
    expect(currentSwitch).toBeGreaterThan(lease);
    expect(confirmFunction).toContain('[[ "$current_release_sha" == "$release_sha" ]] || fail');
    expect(confirmFunction).toContain("stop_watchdog_timer");
    expect(confirmFunction).toContain("write_confirmed_state");
    expect(confirmFunction).toContain('assert_confirmation_window "$pending_activation_deadline"');
    expect(confirmFunction).toContain(
      'write_activation_result_state "$release_sha" confirmed "$release_sha"',
    );
    const confirmedRetry = confirmFunction.indexOf('if is_confirmed "$release_sha"; then');
    const repairedConfirmTerminal = confirmFunction.indexOf(
      'write_activation_result_state "$release_sha" confirmed "$release_sha"',
      confirmedRetry,
    );
    expect(repairedConfirmTerminal).toBeGreaterThan(confirmedRetry);
    expect(repairedConfirmTerminal).toBeLessThan(
      confirmFunction.indexOf("return 0", confirmedRetry),
    );
    const confirmedRollbackRetry = rollbackPendingFunction.indexOf(
      'if is_confirmed "$failed_sha"; then',
    );
    expect(
      rollbackPendingFunction.indexOf(
        'write_activation_result_state "$failed_sha" confirmed "$failed_sha"',
        confirmedRollbackRetry,
      ),
    ).toBeGreaterThan(confirmedRollbackRetry);
    const durableConfirm = confirmFunction.indexOf('write_confirmed_state "$release_sha"');
    const disarmAfterConfirm = confirmFunction.indexOf("stop_watchdog_timer", durableConfirm);
    expect(durableConfirm).toBeGreaterThan(-1);
    expect(disarmAfterConfirm).toBeGreaterThan(durableConfirm);
    expect(confirmFunction).not.toContain("assert_watchdog_service_inactive");
    expect(rollbackFunction).toContain("rollback_pending_locked");
    const recoveryWrite = rollbackPendingFunction.indexOf("write_recovery_state");
    const recoveryStart = rollbackPendingFunction.indexOf(
      "complete_recovery_locked",
      recoveryWrite,
    );
    expect(recoveryWrite).toBeGreaterThan(-1);
    expect(recoveryStart).toBeGreaterThan(recoveryWrite);
    const externalRecoveryProof = completeRecoveryFunction.indexOf(
      'run_recovery_smoke "$recovery_active_sha" || fail',
    );
    const terminalRecovery = completeRecoveryFunction.indexOf(
      'finalize_recovery_state "$operation" "$source_sha"',
      externalRecoveryProof,
    );
    expect(externalRecoveryProof).toBeGreaterThan(-1);
    expect(terminalRecovery).toBeGreaterThan(externalRecoveryProof);
    expect(finalizeRecoveryFunction.indexOf('rm -f -- "$(recovery_pending_path)"')).toBeGreaterThan(
      finalizeRecoveryFunction.indexOf('rm -f -- "$(pending_state_path "$source_sha")"'),
    );
    expect(recoveryPointerFunction).toContain(
      '[[ "$current_release_sha" == "$active_sha" ]] || fail',
    );
    expect(recoveryPointerFunction).toContain(
      '[[ "$previous_release_sha" == "$previous_sha" ]] || fail',
    );
    expect(releaseManager).toContain("load_current_components");
    expect(applyRecoveryFunction).toContain('"$current_release_component_sha" == "$source_sha"');
    expect(applyRecoveryFunction).toContain('"$current_runtime_component_sha" == "$requested_sha"');
  });

  it("preserves a factual previous release when the same SHA is redeployed", () => {
    const releaseA = "a".repeat(40);
    const releaseB = "b".repeat(40);
    const releaseC = "c".repeat(40);
    expect(selectActivationHistory(releaseB, releaseA, releaseC)).toBe(`${releaseA}|${releaseC}`);
    expect(selectActivationHistory(releaseB, releaseB, releaseA)).toBe(`${releaseA}|none`);
    expect(selectActivationHistory(releaseB, releaseB, releaseB)).toBe("none|none");
    expect(selectActivationHistory(releaseB, "none", "none")).toBe("none|none");
    expect(activateFunction).toContain(
      'printf \'%s %s\\n\' "$selected_rollback_sha" "$activation_deadline"',
    );
  });

  it("rejects contradictory durable recovery state transitions", () => {
    const releaseA = "a".repeat(40);
    const releaseB = "b".repeat(40);
    const releaseC = "c".repeat(40);
    const harness = [
      assertRecoveryStateFunction,
      "fail() { exit 1; }",
      'assert_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail; }',
      'assert_optional_sha() { [[ "$1" == none ]] || assert_sha "$1"; }',
      'assert_recovery_state_values "$1" "$2" "$3" "$4" "$5" "$6"',
    ];

    expect(
      spawnBashHarness(harness, ["activation", releaseB, releaseA, releaseA, releaseC, "recovery"])
        .status,
    ).toBe(0);
    expect(
      spawnBashHarness(harness, ["activation", releaseB, releaseB, releaseB, releaseC, "recovery"])
        .status,
    ).not.toBe(0);
    expect(
      spawnBashHarness(harness, ["break-glass", releaseB, releaseA, releaseA, releaseB, "source"])
        .status,
    ).not.toBe(0);
  });

  it("durably starts recovery before repairing a pending activation", () => {
    const releaseA = "a".repeat(40);
    const releaseB = "b".repeat(40);
    const output = runBashHarness(
      [
        rollbackPendingFunction,
        'FAILED_SHA="$1"',
        'ROLLBACK_SHA="$2"',
        'pending_file="$(mktemp)"',
        'recovery_file="${pending_file}.recovery"',
        'trap \'rm -f -- "$pending_file" "$recovery_file"\' EXIT',
        'fail() { printf "fail\\n" >&2; exit 1; }',
        'assert_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail; }',
        "is_confirmed() { return 1; }",
        'pending_state_path() { printf "%s\\n" "$pending_file"; }',
        'recovery_pending_path() { printf "%s\\n" "$recovery_file"; }',
        'load_pending_state() { pending_rollback_sha="$ROLLBACK_SHA"; pending_prior_previous_sha=none; }',
        'write_recovery_state() { printf "state:%s:%s:%s\\n" "$1" "$2" "$3"; : >"$recovery_file"; }',
        'complete_recovery_locked() { [[ -f "$recovery_file" ]] || fail; printf "complete\\n"; }',
        'rollback_pending_locked "$FAILED_SHA"',
      ],
      [releaseB, releaseA],
    );
    expect(output).toBe(`state:activation:${releaseB}:${releaseA}\ncomplete`);
  });

  it("repairs split links and externally proves recovery before terminal cleanup", () => {
    const releaseA = "a".repeat(40);
    const releaseB = "b".repeat(40);
    const output = runBashHarness(
      [
        applyRecoveryFunction,
        completeRecoveryFunction,
        'FAILED_SHA="$1"',
        'ROLLBACK_SHA="$2"',
        'load_recovery_state() { recovery_operation=activation; recovery_source_sha="$FAILED_SHA"; recovery_requested_sha="$ROLLBACK_SHA"; recovery_active_sha="$ROLLBACK_SHA"; recovery_previous_sha=none; recovery_phase=recovery; }',
        'activation_result_path() { printf "/nonexistent/%s.activation-result\\n" "$1"; }',
        "write_activation_result_state() { :; }",
        "assert_recovery_state_values() { :; }",
        'load_current_components() { current_release_component_sha="$ROLLBACK_SHA"; current_runtime_component_sha="$FAILED_SHA"; }',
        'base="/opt/setlivre"',
        'releases="$base/releases"',
        'runtime_base="$base/shared/runtime"',
        "web_service=setlivre-web.service",
        "backoffice_service=setlivre-backoffice.service",
        "assert_release_target() { :; }",
        "assert_runtime_target() { :; }",
        'atomic_link() { printf "link:%s:%s\\n" "$1" "$2"; }',
        'restart_and_assert() { printf "ready:%s\\n" "$1"; }',
        'restore_previous_pointer() { printf "history:%s:%s\\n" "$1" "$2"; }',
        'run_recovery_smoke() { printf "smoke:%s\\n" "$1"; }',
        "assert_recovery_pointer_state() { :; }",
        'finalize_recovery_state() { printf "final:%s:%s\\n" "$1" "$2"; }',
        "fail() { exit 1; }",
        "complete_recovery_locked",
      ],
      [releaseB, releaseA],
    );
    expect(output).toBe(
      [
        `link:/opt/setlivre/releases/${releaseA}:/opt/setlivre/current`,
        `link:/opt/setlivre/shared/runtime/releases/${releaseA}:/opt/setlivre/shared/runtime/current`,
        `ready:${releaseA}`,
        `history:${releaseA}:none`,
        `smoke:${releaseA}`,
        `final:activation:${releaseB}`,
      ].join("\n"),
    );
  });

  it("keeps recovery.pending durable when the external recovery smoke fails", () => {
    const releaseA = "a".repeat(40);
    const releaseB = "b".repeat(40);
    const result = spawnBashHarness(
      [
        completeRecoveryFunction,
        'FAILED_SHA="$1"',
        'ROLLBACK_SHA="$2"',
        'recovery_file="$(mktemp)"',
        'trap \'[[ -f "$recovery_file" ]] && printf "durable\\n"; rm -f -- "$recovery_file"\' EXIT',
        'load_recovery_state() { recovery_operation=activation; recovery_source_sha="$FAILED_SHA"; recovery_requested_sha="$ROLLBACK_SHA"; recovery_active_sha="$ROLLBACK_SHA"; recovery_previous_sha=none; recovery_phase=recovery; }',
        'activation_result_path() { printf "/nonexistent/%s.activation-result\\n" "$1"; }',
        "apply_recovery_active_release() { :; }",
        "restore_previous_pointer() { :; }",
        "run_recovery_smoke() { return 1; }",
        "assert_recovery_pointer_state() { :; }",
        'finalize_recovery_state() { rm -f -- "$recovery_file"; printf "terminal\\n"; }',
        "fail() { exit 1; }",
        "complete_recovery_locked",
      ],
      [releaseB, releaseA],
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("durable");
    expect(result.stdout).not.toContain("terminal");
  });

  it("finalizes a durably proven rollback without running a second smoke after a crash", () => {
    const releaseA = "a".repeat(40);
    const releaseB = "b".repeat(40);
    const output = runBashHarness(
      [
        completeRecoveryFunction,
        'FAILED_SHA="$1"',
        'ROLLBACK_SHA="$2"',
        'terminal_file="$(mktemp)"',
        "trap 'rm -f -- \"$terminal_file\"' EXIT",
        'load_recovery_state() { recovery_operation=activation; recovery_source_sha="$FAILED_SHA"; recovery_requested_sha="$ROLLBACK_SHA"; recovery_active_sha="$ROLLBACK_SHA"; recovery_previous_sha=none; recovery_phase=recovery; }',
        'activation_result_path() { printf "%s\\n" "$terminal_file"; }',
        'assert_activation_result_state() { printf "terminal:%s:%s:%s\\n" "$1" "$2" "$3"; }',
        'assert_recovery_pointer_state() { printf "pointers:%s:%s\\n" "$1" "$2"; }',
        'finalize_recovery_state() { printf "final:%s:%s\\n" "$1" "$2"; }',
        'apply_recovery_active_release() { printf "unexpected-apply\\n"; exit 1; }',
        'run_recovery_smoke() { printf "unexpected-smoke\\n"; exit 1; }',
        "fail() { exit 1; }",
        "complete_recovery_locked",
      ],
      [releaseB, releaseA],
    );
    expect(output).toBe(
      [
        `terminal:${releaseB}:rejected:${releaseA}`,
        `pointers:${releaseA}:none`,
        `final:activation:${releaseB}`,
      ].join("\n"),
    );
    expect(output).not.toContain("unexpected");
  });

  it("resumes recovery.pending after reboot before reporting a checkpoint", () => {
    const releaseA = "a".repeat(40);
    const releaseB = "b".repeat(40);
    const output = runBashHarness(
      [
        recoverPendingFunction,
        'FAILED_SHA="$1"',
        'ROLLBACK_SHA="$2"',
        'state_base="$(mktemp -d)"',
        "trap 'rm -rf -- \"$state_base\"' EXIT",
        'touch "$state_base/recovery.pending"',
        'fail() { printf "fail\\n" >&2; exit 1; }',
        'recovery_pending_path() { printf "%s/recovery.pending\\n" "$state_base"; }',
        'load_recovery_state() { recovery_operation=activation; recovery_source_sha="$FAILED_SHA"; }',
        'rollback_pending_locked() { printf "resume:%s\\n" "$1"; }',
        "recover_pending_activation_locked",
      ],
      [releaseB, releaseA],
    );
    expect(output).toBe(`resume:${releaseB}`);
    expect(checkpointFunction.indexOf("recover_pending_activation_locked")).toBeLessThan(
      checkpointFunction.indexOf("load_current_links"),
    );

    const blocked = spawnBashHarness(
      [
        recoverPendingFunction,
        'FAILED_SHA="$1"',
        'state_base="$(mktemp -d)"',
        "trap 'rm -rf -- \"$state_base\"' EXIT",
        'touch "$state_base/recovery.pending"',
        'recovery_pending_path() { printf "%s/recovery.pending\\n" "$state_base"; }',
        'load_recovery_state() { recovery_operation=activation; recovery_source_sha="$FAILED_SHA"; }',
        "rollback_pending_locked() { return 1; }",
        "set -e",
        "recover_pending_activation_locked",
        'printf "reported\\n"',
      ],
      [releaseB],
    );
    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout).not.toContain("reported");
  });

  it("provides a root-only N-1 break-glass rollback with durable success or safe fallback", () => {
    expect(rollbackConfirmedFunction).toContain("require_root");
    expect(rollbackConfirmedFunction).toContain(
      '[[ ! -e "$(recovery_pending_path)" && ! -L "$(recovery_pending_path)" ]] || fail',
    );
    expect(rollbackConfirmedFunction).toContain(
      '[[ "${#activation_pending_paths[@]}" -eq 0 ]] || fail',
    );
    expect(rollbackConfirmedFunction).toContain(
      '[[ "$current_release_sha" == "$source_sha" ]] || fail',
    );
    expect(rollbackConfirmedFunction).toContain(
      '[[ "$previous_release_sha" == "$requested_sha" ]] || fail',
    );
    expect(rollbackConfirmedFunction.match(/is_confirmed/gu)).toHaveLength(2);
    expect(rollbackConfirmedFunction.indexOf("write_recovery_state")).toBeLessThan(
      rollbackConfirmedFunction.indexOf("complete_recovery_locked"),
    );
    expect(rollbackConfirmedFunction).toContain('[[ "$recovery_outcome" == confirmed ]] || fail');
    expect(releaseManager).toContain("rollback-confirmed)");
    expect(applyRecoveryFunction).toContain('restart_and_assert "$active_sha"');
    expect(applyRecoveryFunction).toContain(
      'atomic_link "$active_release" "$base/current" || fail',
    );
    expect(applyRecoveryFunction).toContain(
      'atomic_link "$active_runtime" "$runtime_base/current" || fail',
    );

    const successProof = completeRecoveryFunction.indexOf(
      'if run_recovery_smoke "$recovery_active_sha"; then',
    );
    const durableSuccess = completeRecoveryFunction.indexOf(
      "write_break_glass_result_state",
      successProof,
    );
    const successCleanup = completeRecoveryFunction.indexOf(
      'finalize_recovery_state "$operation" "$source_sha"',
      durableSuccess,
    );
    expect(successProof).toBeGreaterThan(-1);
    expect(durableSuccess).toBeGreaterThan(successProof);
    expect(successCleanup).toBeGreaterThan(durableSuccess);
    expect(finalizeRecoveryFunction.match(/assert_break_glass_result_state/gu)).toHaveLength(2);

    const releaseA = "a".repeat(40);
    const releaseB = "b".repeat(40);
    const output = runBashHarness(
      [
        completeRecoveryFunction,
        'SOURCE_SHA="$1"',
        'REQUESTED_SHA="$2"',
        "STATE_PHASE=recovery",
        'load_recovery_state() { recovery_operation=break-glass; recovery_source_sha="$SOURCE_SHA"; recovery_requested_sha="$REQUESTED_SHA"; if [[ "$STATE_PHASE" == recovery ]]; then recovery_active_sha="$REQUESTED_SHA"; recovery_previous_sha="$SOURCE_SHA"; recovery_phase=recovery; else recovery_active_sha="$SOURCE_SHA"; recovery_previous_sha="$REQUESTED_SHA"; recovery_phase=source; fi; }',
        'apply_recovery_active_release() { printf "ready:%s\\n" "$4"; }',
        'write_recovery_state() { STATE_PHASE=source; printf "state:source\\n"; }',
        'restore_previous_pointer() { printf "history:%s:%s\\n" "$1" "$2"; }',
        'run_recovery_smoke() { if [[ "$1" == "$REQUESTED_SHA" ]]; then printf "smoke-failed:%s\\n" "$1"; return 1; fi; printf "smoke:%s\\n" "$1"; }',
        "assert_recovery_pointer_state() { :; }",
        'write_break_glass_result_state() { printf "result:%s:%s:%s\\n" "$1" "$2" "$3"; }',
        'finalize_recovery_state() { printf "final:%s:%s\\n" "$1" "$2"; }',
        "fail() { exit 1; }",
        "complete_recovery_locked",
        'printf "outcome:%s\\n" "$recovery_outcome"',
      ],
      [releaseB, releaseA],
    );
    expect(output).toBe(
      [
        `ready:${releaseA}`,
        `history:${releaseA}:${releaseB}`,
        `smoke-failed:${releaseA}`,
        "state:source",
        `ready:${releaseB}`,
        `history:${releaseB}:${releaseA}`,
        `smoke:${releaseB}`,
        `result:${releaseB}:${releaseA}:rejected`,
        `final:break-glass:${releaseB}`,
        "outcome:rejected",
      ].join("\n"),
    );

    const successfulOutput = runBashHarness(
      [
        completeRecoveryFunction,
        'SOURCE_SHA="$1"',
        'REQUESTED_SHA="$2"',
        'load_recovery_state() { recovery_operation=break-glass; recovery_source_sha="$SOURCE_SHA"; recovery_requested_sha="$REQUESTED_SHA"; recovery_active_sha="$REQUESTED_SHA"; recovery_previous_sha="$SOURCE_SHA"; recovery_phase=recovery; }',
        'apply_recovery_active_release() { printf "ready:%s\\n" "$4"; }',
        'restore_previous_pointer() { printf "history:%s:%s\\n" "$1" "$2"; }',
        'run_recovery_smoke() { printf "smoke:%s\\n" "$1"; }',
        "assert_recovery_pointer_state() { :; }",
        'write_break_glass_result_state() { printf "result:%s:%s:%s\\n" "$1" "$2" "$3"; }',
        'finalize_recovery_state() { printf "final:%s:%s\\n" "$1" "$2"; }',
        "fail() { exit 1; }",
        "complete_recovery_locked",
        'printf "outcome:%s\\n" "$recovery_outcome"',
      ],
      [releaseB, releaseA],
    );
    expect(successfulOutput).toBe(
      [
        `ready:${releaseA}`,
        `history:${releaseA}:${releaseB}`,
        `smoke:${releaseA}`,
        `result:${releaseB}:${releaseA}:confirmed`,
        `final:break-glass:${releaseB}`,
        "outcome:confirmed",
      ].join("\n"),
    );
  });

  it("keeps command stdout restricted to protocol, current and activate results", () => {
    expect(activateFunction.match(/printf /gu)).toHaveLength(1);
    expect(confirmFunction).not.toContain("printf ");
    expect(rollbackFunction).not.toContain("printf ");
    expect(rollbackConfirmedFunction).not.toContain("printf ");
    expect(watchdogFunction).not.toContain("printf ");
    expect(activationResultFunction).toContain("assert_root_private_file");
    expect(activationResultFunction).toContain(
      'printf \'%s %s\\n\' "${lines[3]#result=}" "${lines[4]#active_sha=}"',
    );
    expect(checkpointFunction).toContain("assert_release_provenance_record");
    expect(checkpointFunction).toContain('is_confirmed "$current_release_sha" || fail');
    expect(checkpointFunction).toContain("printf '%s\\n' \"${lines[@]}\"");
    expect(releaseManager).toContain("--quiet \\");
    expect(releaseManager).toContain(
      "printf '%s\\n' \"Set Livre release manager rejected the operation.\" >&2",
    );
    expect(releaseManager).toContain(
      "unset DATABASE_URL_APP_DAL PRD_DATABASE_URL_APP_DAL PRD_SUPABASE_ANON_KEY",
    );
    expect(releaseManager).not.toMatch(/DATABASE_URL_APP_DAL.*(?:echo|printf)/u);
  });

  it("hardens the host and leaves application services non-root on loopback", () => {
    expect(bootstrap).toContain("User=setlivre");
    expect(bootstrap).toContain("NoNewPrivileges=true");
    expect(bootstrap).toContain("ProtectSystem=strict");
    expect(bootstrap).not.toContain("EnvironmentFile=");
    expect(bootstrap).toContain(
      "LoadCredential=runtime.env:/opt/setlivre/shared/runtime/current/web.env",
    );
    expect(bootstrap).toContain(
      "LoadCredential=runtime.env:/opt/setlivre/shared/runtime/current/backoffice.env",
    );
    expect(bootstrap.match(/^LoadCredential=supabase-server-ca\.pem:.*$/gmu)).toHaveLength(2);
    expect(bootstrap.match(/^UnsetEnvironment=.*$/gmu)).toHaveLength(2);
    expect(bootstrap).toContain(
      "ExecStart=/usr/local/bin/node --env-file=%d/runtime.env /opt/setlivre/current/web/server.js",
    );
    expect(bootstrap).toContain(
      "ExecStart=/usr/local/bin/node --env-file=%d/runtime.env /opt/setlivre/current/backoffice/apps/backoffice/server.js",
    );
    expect(bootstrap).toContain("postgresql-client");
    expect(bootstrap).not.toMatch(/apt-get install[\s\S]*\bgit\b/u);
    expect(releaseManager).toContain('values["HOSTNAME"] != "127.0.0.1"');
    expect(releaseManager).toContain('username == "app_runtime_prod"');
    expect(releaseManager).toContain('if set(query) != {"options"}');
    expect(releaseManager).toContain('values["DATABASE_TLS_CA_PATH"] != expected_ca_path');
    expect(releaseManager).toContain('query["options"][0] != "-c role=app_dal"');
    expect(bootstrap).toContain(
      'iptables -w -A SETLIVRE_INPUT -p tcp -s "$administrative_cidr" --dport 22',
    );
    expect(bootstrap).toContain("netfilter-persistent save");
    expect(bootstrap).not.toMatch(/^ufw\s/gmu);
    expect(bootstrap).toContain("PermitRootLogin no");
    expect(bootstrap).toContain("PasswordAuthentication no");
    expect(bootstrap).toContain("server_tokens off");
    expect(bootstrap).toMatch(/release-manager version \| grep -qx '[0-9]+'/u);
  });
});
