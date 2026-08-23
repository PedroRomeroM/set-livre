import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repository, "scripts/configure-production-deployer.sh");
const script = readFileSync(scriptPath, "utf8");
const deployAgent = readFileSync(resolve(repository, "scripts/production-deploy-agent.sh"), "utf8");
const releaseManager = readFileSync(
  resolve(repository, "scripts/production-release-manager.sh"),
  "utf8",
);
const bootstrap = readFileSync(resolve(repository, "scripts/bootstrap-oracle-host.sh"), "utf8");
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(resolve(tmpdir(), "setlivre-deployer-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

function bashPath(path) {
  if (process.platform !== "win32") return path;
  return path
    .replace(/^([A-Za-z]):\\/u, (_, drive) => `/${drive.toLowerCase()}/`)
    .replaceAll("\\", "/");
}

function extractShellFunction(name) {
  const start = script.indexOf(`\n${name}() {\n`);
  const end = script.indexOf("\n}\n", start);
  expect(start, `função ${name}`).toBeGreaterThanOrEqual(0);
  expect(end, `fim da função ${name}`).toBeGreaterThan(start);
  return script.slice(start + 1, end + 2);
}

function extractHeredoc(marker) {
  const expression = new RegExp(`<<'${marker}'\\r?\\n([\\s\\S]*?)\\r?\\n${marker}`);
  const match = expression.exec(script);
  expect(match).not.toBeNull();
  return match[1];
}

function expectValidBash(source) {
  const result = spawnSync(bash, ["-n"], { encoding: "utf8", input: source });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

function runNodeHeredoc(marker, args) {
  return spawnSync(process.execPath, ["-", ...args], {
    encoding: "utf8",
    input: extractHeredoc(marker),
  });
}

function numericShellConstant(source, name) {
  const match = new RegExp(`^readonly ${name}=([0-9]+)$`, "mu").exec(source);
  expect(match, `constante ${name}`).not.toBeNull();
  return Number(match[1]);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("pull-based production deployer configuration", () => {
  it("is valid Bash and installs no GitHub Actions runner", () => {
    execFileSync(bash, ["-n", scriptPath]);
    expect(script).toContain("readonly deployer_user=setlivre-deployer");
    expect(script).toContain("readonly deployer_home=/var/lib/setlivre-deployer");
    expect(script).toContain("--shell /usr/sbin/nologin");
    expect(script).toContain("assert_no_actions_runner");
    expect(script).not.toContain("config.sh --url");
    expect(script).not.toContain("RUNNER_REGISTRATION_TOKEN");
    expect(script).not.toContain("github-actions");
  });

  it("requires Ubuntu 24.04 x86_64 and physical root-owned hashed inputs", () => {
    expect(script).toContain('[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]]');
    expect(script).toContain('[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]');
    expect(script).toContain('[[ "$(dpkg --print-architecture)" == amd64 ]]');
    expect(script).toContain("assert_install_source");
    expect(script).toContain("awk bash cat chmod chown curl cut");
    expect(script).toContain("groupadd id install mktemp mv");
    expect(script).toContain("root:root:1");
    expect(script).toContain('sha256sum -- "$path"');
    expect(script).toContain("freeze_install_source");
    expect(script).toContain('install -o root -g root -m 0600 -- "$source" "$frozen"');
    expect(script).toContain('assert_owned_file "$frozen" root root 600');
    expect(script).toContain("setlivre-production-deployer-config.lock");
    expect(script).toContain("installation.state");
    expect(script).toContain("dispatcher_sha256=");
    expect(script).toContain("sudoers_sha256=");
    expect(script).toContain("service_sha256=");
    expect(script).toContain("timer_sha256=");
    expect(script).toContain("readonly installation_schema=5");
    expect(script).toContain("supabase_cli_path=");
    expect(script).toContain("supabase_cli_version=");
    expect(script).toContain("supabase_cli_sha256=");
    expect(script).toContain("supabase_go_path=");
    expect(script).toContain("supabase_go_sha256=");
  });

  it("validates the immutable root-owned host CLI and companion before install or secrets", () => {
    expect(script).toContain(
      "readonly supabase_cli_sha256=c8dcd16db0bab7c27a1cc984aa6abbc8f5b2e36b90f58a579eacfbe719dd345d",
    );
    expect(script).toContain(
      "readonly supabase_go_sha256=08fcb0d4e1eddc9bbc8d74553cb1883aa3ac9985789dc8d39306c278844a29d4",
    );
    expect(script).toContain('[[ "$(stat -c \'%U:%G:%a:%h\' -- "$path")" == root:root:755:1 ]]');
    expect(script).toContain('assert_root_host_tool "$supabase_cli_path" "$supabase_cli_sha256"');
    expect(script).toContain('assert_root_host_tool "$supabase_go_path" "$supabase_go_sha256"');
    expect(script).toContain('[[ "$version" == "$supabase_cli_version" ]]');
    const main = script.slice(script.indexOf("main() {"));
    expect(main.indexOf("assert_host_supabase_cli")).toBeLessThan(
      main.indexOf('temporary_root="$(mktemp'),
    );
    const verification = script.slice(
      script.indexOf("verify_installation() {"),
      script.indexOf("\n}\n\ninstall_deployer()", script.indexOf("verify_installation() {")),
    );
    expect(verification.indexOf("assert_host_supabase_cli")).toBeLessThan(
      verification.indexOf("assert_environment_shape"),
    );
  });

  it("fails closed on a pending reboot before install and verify dispatch", () => {
    const directory = temporaryDirectory();
    const marker = resolve(directory, "reboot-required");
    const guard = extractShellFunction("require_no_pending_reboot").replaceAll(
      "/var/run/reboot-required",
      bashPath(marker),
    );
    const runGuard = () =>
      spawnSync(
        bash,
        ["-c", `set -euo pipefail; fail() { exit 1; }; ${guard}; require_no_pending_reboot`],
        { encoding: "utf8" },
      );

    expect(runGuard().status).toBe(0);
    writeFileSync(marker, "restart required\n");
    expect(existsSync(marker)).toBe(true);
    expect(runGuard().status).not.toBe(0);

    const main = script.slice(script.indexOf("main() {"));
    expect(main.indexOf("require_no_pending_reboot")).toBeLessThan(main.indexOf('case "${1:-}"'));
    const verification = script.slice(
      script.indexOf("verify_installation() {"),
      script.indexOf("\n}\n\ninstall_deployer()", script.indexOf("verify_installation() {")),
    );
    expect(verification).toContain("require_no_pending_reboot");
  });

  it("keeps only public configuration in EnvironmentFile and loads secrets as credentials", () => {
    expect(script).toContain("readonly environment_path=");
    expect(script).toContain(
      'atomic_install "$candidate" "$environment_path" root "$deployer_group" 640',
    );
    expect(script).not.toContain("GITHUB_DEPLOY_TOKEN=");
    expect(script).not.toContain("SUPABASE_ACCESS_TOKEN=");
    expect(script).not.toContain("SUPABASE_DB_PASSWORD=");
    expect(script).not.toContain("PRD_DATABASE_URL_APP_DAL=");
    expect(script).toContain(
      "GITHUB_REPOSITORY_ID=\nCI_GITHUB_WORKFLOW_ID=\nPRD_GITHUB_WORKFLOW_ID=",
    );
    expect(script).not.toContain("GITHUB_REPOSITORY_ID=1328339374");
    expect(script).toContain("PRD_SUPABASE_PROJECT_REF=\nPRD_SUPABASE_URL=");
    expect(script).toContain('re.fullmatch(r"[a-z0-9]{20}", supabase_project_ref)');
    expect(script).toContain('supabase_url != f"https://{supabase_project_ref}.supabase.co"');
    expect(script).toContain('enabled == "true" and not supabase_configured');
    expect(script).toContain("PRD_DEPLOY_ENABLED=false");
    expect(script).toContain("SUPABASE_SERVER_CA_SHA256=");
    expect(script).toContain('-z "${GITHUB_DEPLOY_TOKEN+x}"');
    expect(script).toContain('-z "${SUPABASE_ACCESS_TOKEN+x}"');
    expect(script).toContain("assert_environment_shape");
    expect(script).toContain(
      'readonly credentials_directory="$configuration_directory/credentials"',
    );
    expect(script).toContain("install_credential_templates");
    expect(script).toContain("assert_credential_sources");
    expect(script).toContain("assert_systemd_credential_round_trip");
    for (const credential of [
      "github-deploy-token",
      "supabase-access-token",
      "supabase-db-password",
      "database-url-app-dal",
      "supabase-server-ca.pem",
    ]) {
      expect(script).toContain(`LoadCredential=${credential}:`);
    }
  });

  it("configures all delivery identities in one validated atomic replacement", () => {
    const directory = temporaryDirectory();
    const environment = resolve(directory, "production.env");
    const configured = resolve(directory, "configured.env");
    const partial = resolve(directory, "partial.env");
    const rejected = resolve(directory, "rejected.env");
    const supabaseConfigured = resolve(directory, "supabase-configured.env");
    const syntheticProjectRef = "abcdefghijklmnopqrst";
    const template = [
      "GITHUB_REPOSITORY_ID=",
      "CI_GITHUB_WORKFLOW_ID=",
      "PRD_GITHUB_WORKFLOW_ID=",
      "PRD_PUBLIC_APP_URL=https://setlivre.com",
      "PRD_BACKOFFICE_APP_URL=https://ops.setlivre.com",
      "PRD_SUPABASE_PROJECT_REF=",
      "PRD_SUPABASE_URL=",
      "PRD_SUPABASE_ANON_KEY=",
      "SUPABASE_SERVER_CA_SHA256=",
      "PRD_DEPLOY_ENABLED=false",
      "",
    ].join("\n");
    writeFileSync(environment, template);

    const accepted = runNodeHeredoc("ENVIRONMENT_IDENTITY_NODE", [
      environment,
      configured,
      "delivery",
      "1328339374",
      "111",
      "222",
    ]);
    expect(accepted.status).toBe(0);
    expect(readFileSync(configured, "utf8")).toBe(
      template
        .replace("GITHUB_REPOSITORY_ID=", "GITHUB_REPOSITORY_ID=1328339374")
        .replace("CI_GITHUB_WORKFLOW_ID=", "CI_GITHUB_WORKFLOW_ID=111")
        .replace("PRD_GITHUB_WORKFLOW_ID=", "PRD_GITHUB_WORKFLOW_ID=222"),
    );

    writeFileSync(
      partial,
      template.replace("GITHUB_REPOSITORY_ID=", "GITHUB_REPOSITORY_ID=1328339374"),
    );
    expect(
      runNodeHeredoc("ENVIRONMENT_IDENTITY_NODE", [
        partial,
        rejected,
        "delivery",
        "1328339374",
        "111",
        "222",
      ]).status,
    ).not.toBe(0);
    expect(existsSync(rejected)).toBe(false);

    const configuredSupabase = runNodeHeredoc("ENVIRONMENT_IDENTITY_NODE", [
      configured,
      supabaseConfigured,
      "supabase",
      syntheticProjectRef,
    ]);
    expect(configuredSupabase.status).toBe(0);
    const supabaseConfiguration = readFileSync(supabaseConfigured, "utf8");
    expect(supabaseConfiguration).toContain(`PRD_SUPABASE_PROJECT_REF=${syntheticProjectRef}\n`);
    expect(supabaseConfiguration).toContain(
      `PRD_SUPABASE_URL=https://${syntheticProjectRef}.supabase.co\n`,
    );
    expect(
      runNodeHeredoc("ENVIRONMENT_IDENTITY_NODE", [
        supabaseConfigured,
        rejected,
        "supabase",
        "short",
      ]).status,
    ).not.toBe(0);
    expect(existsSync(rejected)).toBe(false);

    const configure = extractShellFunction("configure_environment_identity");
    const verification = configure.indexOf("verify_installation");
    const candidateWrite = configure.indexOf("write_environment_identity_candidate");
    const candidateValidation = configure.indexOf('assert_environment_file_shape "$candidate"');
    const replacement = configure.indexOf(
      'atomic_install "$candidate" "$environment_path" root "$deployer_group" 640',
    );
    const finalValidation = configure.indexOf("assert_environment_shape");
    expect(
      Math.min(verification, candidateWrite, candidateValidation, replacement),
    ).toBeGreaterThan(-1);
    expect(verification).toBeLessThan(candidateWrite);
    expect(candidateWrite).toBeLessThan(candidateValidation);
    expect(candidateValidation).toBeLessThan(replacement);
    expect(replacement).toBeLessThan(finalValidation);
    expect(configure.match(/atomic_install/gu)).toHaveLength(1);
    expect(script).toContain("configure-delivery-identity)");
    expect(script).toContain("configure-supabase-identity)");
    expect(script).toContain('[[ "$#" -eq 4 ]] || usage');
    expect(script).toContain('[[ "$#" -eq 2 ]] || usage');
  });

  it("fails closed unless web and backoffice consume root-only runtime credentials", () => {
    expect(script).toContain('readonly web_runtime_credential="$runtime_current/web.env"');
    expect(script).toContain(
      'readonly backoffice_runtime_credential="$runtime_current/backoffice.env"',
    );
    expect(script).not.toContain("EnvironmentFile=/opt/setlivre/shared/runtime/current");
    expect(script).toContain("assert_effective_application_services_contract");
    expect(script).toContain('systemd_property_allow_empty "$unit_name" EnvironmentFiles');
    expect(script).toContain('"runtime.env:$runtime_credential"');
    expect(script).toContain(
      'local effective_runtime_credential="/run/credentials/$unit_name/runtime.env"',
    );
    expect(script).toContain('"--env-file=$effective_runtime_credential"');
    expect(script).toContain('[[ "$exec_start" != *"--env-file-if-exists"* ]]');
    expect(script).toContain('systemd_property_allow_empty "$unit_name" DropInPaths');
    expect(script).toContain('systemd_property "$unit_name" LoadCredential');
    expect(script).toContain('systemd_property "$unit_name" UnsetEnvironment');
    expect(script).toContain("APP_ENV APP_RELEASE_SHA DATABASE_TLS_CA_PATH DATABASE_TLS_CA_SHA256");
    expect(script).toContain('"supabase-server-ca.pem:$supabase_server_ca_credential"');
    expect(script).toContain('assert_root_file "$web_service_path" 644');
    expect(script).toContain('assert_root_file "$backoffice_service_path" 644');
  });

  it("installs an outbound oneshot service and a serialized timer", () => {
    expect(script).toContain("Type=oneshot");
    expect(script).toContain("User=${deployer_user}");
    expect(script).toContain("EnvironmentFile=${environment_path}");
    expect(script).toContain("TimeoutStartSec=60min");
    // sudo needs setuid; the closed dispatcher and sudoers grammar are the privilege boundary.
    expect(script).toContain("NoNewPrivileges=false");
    expect(script).toContain("ProtectSystem=strict");
    expect(script).toContain("ReadWritePaths=${private_base} /opt/setlivre /run/lock");
    expect(script).toContain("RestrictAddressFamilies=AF_INET AF_UNIX");
    expect(script).toContain("OnUnitInactiveSec=2min");
    expect(script).toContain("RandomizedDelaySec=30s");
    expect(script).toContain('systemctl enable "$timer_name"');
    expect(script).toContain('"$service_path" "$timer_path" "$web_service_path"');
    expect(script).toContain('"$backoffice_service_path" >/dev/null');
    expect(script).toContain("assert_effective_systemd_contract");
    expect(script).toContain('systemd_property_allow_empty "$service_name" DropInPaths');
    expect(script).toContain('systemd_property_allow_empty "$timer_name" DropInPaths');
    expect(script).toContain('systemd_property "$service_name" LoadCredential');
    expect(script).not.toContain("ListenStream=");
    expect(script).not.toContain("ListenDatagram=");
    expect(script).toContain("actions-runner-units");
    expect(script).toContain("--no-legend --no-pager");
    expect(script).toContain('[[ ! -s "$listing" ]] || fail');
  });

  it("enforces the shared E2 Micro memory budget on web, backoffice and deployer", () => {
    const constantNames = [
      "e2_micro_minimum_memtotal_mib",
      "e2_micro_maximum_memtotal_mib",
      "minimum_host_memory_reserve_mib",
      "web_memory_high_mib",
      "web_memory_max_mib",
      "web_memory_swap_max_mib",
      "backoffice_memory_high_mib",
      "backoffice_memory_max_mib",
      "backoffice_memory_swap_max_mib",
      "deployer_memory_high_mib",
      "deployer_memory_max_mib",
      "deployer_memory_swap_max_mib",
    ];
    for (const name of constantNames) {
      expect(numericShellConstant(script, name)).toBe(numericShellConstant(bootstrap, name));
    }

    const managedMaximum =
      numericShellConstant(script, "web_memory_max_mib") +
      numericShellConstant(script, "backoffice_memory_max_mib") +
      numericShellConstant(script, "deployer_memory_max_mib");
    expect(managedMaximum).toBe(592);
    expect(
      managedMaximum + numericShellConstant(script, "minimum_host_memory_reserve_mib"),
    ).toBeLessThanOrEqual(numericShellConstant(script, "e2_micro_minimum_memtotal_mib"));
    expect(script).toContain("MemoryAccounting=true");
    expect(script).toContain("MemoryHigh=${deployer_memory_high_mib}M");
    expect(script).toContain("MemoryMax=${deployer_memory_max_mib}M");
    expect(script).toContain("MemorySwapMax=${deployer_memory_swap_max_mib}M");
    expect(script).toContain("OOMPolicy=kill");
    expect(script).toContain(
      "Environment=NODE_OPTIONS=--max-old-space-size=${deployer_node_old_space_mib}",
    );
    expect(script).toContain("assert_e2_micro_memory_budget");
    expect(script).toContain("assert_managed_service_memory_contracts");
    expect(script).toContain('systemd_property "$unit_name" MemoryHigh');
    expect(script).toContain('systemd_property "$unit_name" MemoryMax');
    expect(script).toContain('systemd_property "$unit_name" MemorySwapMax');
    expect(script).toContain('systemd_property "$unit_name" OOMPolicy');
    expect(script).not.toContain("AF_INET6");
  });

  it("recovers a durable install transaction under the agent lock before replacing frozen sources", () => {
    const installStart = script.indexOf("install_deployer() {");
    const installEnd = script.indexOf("\n}\n\nmain() {", installStart);
    const installation = script.slice(installStart, installEnd);
    const lock = installation.indexOf("  acquire_deploy_lock");
    const recovery = installation.indexOf("  recover_installation_transaction");
    const freeze = installation.indexOf(
      'freeze_install_source "$agent_source" "$agent_sha" "$frozen_agent"',
    );
    const capture = installation.indexOf("  capture_timer_state");
    const prepare = installation.indexOf("  prepare_installation_transaction");
    const quiesce = installation.indexOf("  quiesce_deployer");
    const revalidate = installation.indexOf('assert_frozen_source "$frozen_agent" "$agent_sha"');
    const replace = installation.indexOf(
      'atomic_install "$frozen_agent" "$agent_path" root "$deployer_group" 750',
    );
    const verify = installation.indexOf("  verify_installation");
    const restore = installation.indexOf("  restore_timer_state");

    expect(
      Math.min(
        lock,
        recovery,
        freeze,
        capture,
        prepare,
        quiesce,
        revalidate,
        replace,
        verify,
        restore,
      ),
    ).toBeGreaterThan(0);
    expect(lock).toBeLessThan(recovery);
    expect(recovery).toBeLessThan(freeze);
    expect(freeze).toBeLessThan(capture);
    expect(capture).toBeLessThan(prepare);
    expect(prepare).toBeLessThan(quiesce);
    expect(capture).toBeLessThan(quiesce);
    expect(quiesce).toBeLessThan(revalidate);
    expect(revalidate).toBeLessThan(replace);
    expect(replace).toBeLessThan(verify);
    expect(verify).toBeLessThan(restore);

    expect(script).toContain('systemctl disable --now "$timer_name"');
    expect(script).toContain('systemctl stop "$service_name"');
    expect(script).toContain('readonly deploy_lock_path="$private_base/deploy.lock"');
    expect(script).toContain('exec 8>>"$deploy_lock_path"');
    expect(script).toContain("flock -w 300 8");
    expect(script).toContain("/proc/self/fd/8");
    expect(deployAgent).toContain('exec 9>"$private_base/deploy.lock"');
    expect(installation).toContain("set_installation_transaction_phase committed");
    expect(installation).toContain("cleanup_installation_transaction");
    expect(installation).not.toContain(
      'install -o root -g "$deployer_group" -m 0750 -- "$agent_source" "$agent_path"',
    );
    expect(installation).not.toContain(
      'install -o root -g "$deployer_group" -m 0640 -- "$smoke_source" "$smoke_path"',
    );
  });

  it("atomically replaces files in root-controlled destination directories", () => {
    expect(script).toContain(
      'local candidate="$destination_directory/.${destination_name}.setlivre-installing"',
    );
    expect(script).toContain(
      '[[ "$directory_owner" == root && "$directory_mode" =~ ^[0-7]{3,4}$ ]]',
    );
    expect(script).toContain("[[ $((8#$directory_mode & 8#022)) -eq 0 ]]");
    expect(script).toContain('[[ ! -e "$candidate" && ! -L "$candidate" ]] || fail');
    expect(script).toContain('sync -- "$candidate"');
    expect(script).toContain('mv --no-target-directory -- "$candidate" "$destination"');
    expect(script).toContain('sync -- "$destination"');
    expect(script).toContain('source_sha="$(file_sha256 "$source")"');
    expect(script).toContain('candidate_sha="$(file_sha256 "$candidate")"');
    expect(script).toContain('destination_sha="$(file_sha256 "$destination")"');
    expect(script).toContain('[[ "$candidate_sha" == "$source_sha" ]] || fail');
    expect(script).toContain('[[ "$destination_sha" == "$source_sha" ]] || fail');
    expect(script).toContain('assert_owned_file "$destination" "$owner" "$group" "$mode"');
    expect(script).toContain('atomic_install "$service_candidate" "$service_path" root root 644');
    expect(script).toContain('atomic_install "$candidate" "$installation_state" root root 600');
    expect(script).toContain('readonly transaction_directory="$transaction_base/active"');
    expect(script).toContain("prepare_installation_transaction");
    expect(script).toContain("set_installation_transaction_phase committed");
    expect(script).toContain("backup_managed_installation");
    expect(script).toContain("restore_managed_installation");
    expect(script).toContain("recover_orphaned_transaction_preparations");
    expect(script).toContain('find "$transaction_base" -mindepth 1 -maxdepth 1');
    expect(script).toContain('>"$inventory" || fail');
    expect(script).toContain("mapfile -d '' -t paths <\"$inventory\" || fail");
    expect(script).not.toMatch(/< <\(/u);
    expect(script).toContain("readonly -a managed_installation_paths=(");
    expect(script).toContain('for path in "${managed_installation_paths[@]}"');
    expect(script).toContain('installation_state_payload="$(read_installation_state)" || fail');
    expect(script).toContain('mapfile -t hashes <<<"$installation_state_payload" || fail');
    expect(script).toContain('output="$(sha256sum -- "$path")" || fail');
    expect(script).toContain('digest="${output%% *}"');
    expect(script).toContain('[[ "$(stat -c \'%d\' -- "$candidate")"');
    expect(script).toContain('python3 - "$candidate" /proc/self/mountinfo');
    expect(script).toContain('assert_no_mount_at_or_below "$candidate" || return 1');
    expect(script).toContain('local retired="$parent/.cleanup-retired-${candidate##*/}"');
    expect(script).toContain('[[ ! -e "$original" && ! -L "$original" ]] || return 1');
    expect(script).toContain('candidate="$retired"');
    expect(script).toContain(
      'mv --no-target-directory --no-clobber -- "$original" "$retired" || return 1',
    );
    expect(script.match(/assert_no_mount_at_or_below "\$retired" \|\| return 1/gu)).toHaveLength(2);
    expect(script).toContain('rm -rf --one-file-system -- "$retired" || return 1');
    expect(script).toContain('remove_root_private_tree "$path" "$transaction_base"');
    expect(script).toContain(
      'remove_root_private_tree "$transaction_discarding" "$transaction_base"',
    );
    expect(script).toContain("assert_no_pending_installation_transaction");
    expect(script).toContain('pending="$(find "$transaction_base"');
    expect(script).toContain('[[ -z "$pending" ]] || fail');
    expect(script).toContain("transaction_installation_state_sha");
    expect(script).toContain('assert_sha256 "$hash"');
    expect(script).toContain(
      'mv --no-target-directory -- "$transaction_directory" "$transaction_discarding"',
    );
  });

  it("restores the exact previous timer state only after installation verification", () => {
    const unitsStart = script.indexOf("install_systemd_units() {");
    const unitsEnd = script.indexOf("\n}\n\nwrite_installation_state() {", unitsStart);
    const unitInstallation = script.slice(unitsStart, unitsEnd);
    expect(unitInstallation).not.toContain("systemctl enable");
    expect(script).toContain(
      'timer_previous_enabled="$(systemd_enabled_state "$timer_name")" || fail',
    );
    expect(script).toContain(
      'timer_previous_active="$(systemd_active_state "$timer_name")" || fail',
    );
    expect(script).toContain('if [[ "$timer_previous_enabled" == enabled ]]');
    expect(script).toContain('if [[ "$timer_previous_active" == active ]]');
    expect(script).toContain('"$timer_previous_enabled" ]] || fail');
    expect(script).toContain('"$timer_previous_active" ]] || fail');
    expect(script).not.toContain("|| true");
  });

  it("uses only the root-owned closed-grammar dispatcher through sudo", () => {
    const dispatcher = extractHeredoc("DISPATCHER");
    expectValidBash(dispatcher);
    expect(dispatcher).toContain("version | current | checkpoint");
    expect(dispatcher).toContain("preflight | activate)");
    expect(dispatcher).toContain("confirm | rollback | discard-preflight");
    expect(dispatcher).toContain('[[ "$#" -eq 10 ]]');
    expect(dispatcher).toContain('assert_positive_integer "$6"');
    expect(dispatcher).toContain('assert_positive_integer "$9"');
    expect(dispatcher).toContain('assert_checksum "${10}"');
    expect(dispatcher).toContain("/usr/bin/env -i");
    expect(dispatcher).not.toContain("bash -c");
    expect(dispatcher).not.toContain("watchdog)");
    expect(script).toContain("readonly release_manager_protocol=3");
    expect(script).toContain("${deployer_user} ALL=(root) NOPASSWD: ${dispatcher_path}");
    expect(script).not.toMatch(/NOPASSWD:\s+ALL/u);
    expect(script).toContain('sudo -ll -U "$deployer_user"');
    expect(script).toContain("assert_sudo_policy_exact");
    expect(script).not.toContain('sudo -l -U "$deployer_user"');
  });

  it("updates the root manager only through a separate durable administrative transaction", () => {
    const start = script.indexOf("update_release_manager() {");
    const end = script.indexOf("\n}\n\nassert_no_actions_runner() {", start);
    const update = script.slice(start, end);
    const sourceValidation = update.indexOf('assert_install_source "$source" "$expected_sha"');
    const deployLock = update.indexOf("acquire_deploy_lock");
    const managerLock = update.indexOf("flock -w 30 7");
    const managerRecovery = update.indexOf("recover_manager_update_transaction");
    const installationRecovery = update.indexOf("recover_installation_transaction");
    const prepare = update.indexOf("prepare_manager_update_transaction");
    const replacement = update.indexOf(
      'atomic_install "$manager_update_directory/replacement" "$release_manager_path" root root 750',
    );
    const verification = update.indexOf(
      'verify_release_manager_bytes "$release_manager_path" "$expected_sha"',
    );
    const commit = update.indexOf("cleanup_manager_update_transaction");

    expect(
      Math.min(
        sourceValidation,
        deployLock,
        managerLock,
        managerRecovery,
        installationRecovery,
        prepare,
      ),
    ).toBeGreaterThan(0);
    expect(sourceValidation).toBeLessThan(deployLock);
    expect(deployLock).toBeLessThan(managerLock);
    expect(managerLock).toBeLessThan(managerRecovery);
    expect(managerRecovery).toBeLessThan(installationRecovery);
    expect(installationRecovery).toBeLessThan(prepare);
    expect(prepare).toBeLessThan(replacement);
    expect(replacement).toBeLessThan(verification);
    expect(verification).toBeLessThan(commit);
    expect(script).toContain("previous_sha256=");
    expect(script).toContain("replacement_sha256=");
    expect(script).toContain("recover_manager_update_transaction");
    expect(script).toContain('atomic_install "$manager_update_directory/previous"');
    expect(script).toContain(
      '"  $0 update-manager /absolute/path/production-release-manager.sh <sha256>"',
    );
    expect(deployAgent).not.toContain("update-manager");
    expect(releaseManager).toContain(
      "readonly manager_update_directory=/var/lib/setlivre-deployer-config/manager-update",
    );
    expect(releaseManager).toContain("assert_no_pending_manager_update");
    expect(releaseManager).toContain('if [[ "${1:-}" != version ]]');
  });

  it("behaviorally requires exactly one effective deployer-group member", () => {
    const directory = temporaryDirectory();
    const group = resolve(directory, "group");
    const passwd = resolve(directory, "passwd");
    writeFileSync(group, "setlivre-deployer:x:998:\n");
    writeFileSync(
      passwd,
      [
        "root:x:0:0:root:/root:/bin/bash",
        "setlivre-deployer:x:997:998:deployer:/var/lib/setlivre-deployer:/usr/sbin/nologin",
        "",
      ].join("\n"),
    );
    expect(
      runNodeHeredoc("EXCLUSIVE_GROUP_NODE", [
        group,
        passwd,
        "setlivre-deployer",
        "setlivre-deployer",
      ]).status,
    ).toBe(0);

    writeFileSync(group, "setlivre-deployer:x:998:unexpected-user\n");
    expect(
      runNodeHeredoc("EXCLUSIVE_GROUP_NODE", [
        group,
        passwd,
        "setlivre-deployer",
        "setlivre-deployer",
      ]).status,
    ).not.toBe(0);

    writeFileSync(group, "setlivre-deployer:x:0:\n");
    writeFileSync(
      passwd,
      [
        "root:x:0:0:root:/root:/bin/bash",
        "setlivre-deployer:x:0:0:deployer:/var/lib/setlivre-deployer:/usr/sbin/nologin",
        "",
      ].join("\n"),
    );
    expect(
      runNodeHeredoc("EXCLUSIVE_GROUP_NODE", [
        group,
        passwd,
        "setlivre-deployer",
        "setlivre-deployer",
      ]).status,
    ).not.toBe(0);

    expect(script).toContain('[[ "$(id -u "$deployer_user")" == "$deployer_uid" ]]');
    expect(script).toContain('[[ "$(id -g "$deployer_user")" == "$deployer_gid" ]]');
  });

  it("behaviorally rejects every sudo -ll grant except the root dispatcher", () => {
    const directory = temporaryDirectory();
    const listing = resolve(directory, "sudo-listing");
    const dispatcher = "/usr/local/sbin/setlivre-deploy-dispatch";
    const policy = "/etc/sudoers.d/setlivre-deployer";
    const exact = [
      "Matching Defaults entries for setlivre-deployer on host:",
      "    env_reset, !setenv",
      "",
      `Sudoers entry: ${policy}`,
      "    RunAsUsers: root",
      "    Options: !authenticate",
      "    Commands:",
      `        ${dispatcher}`,
      "",
    ].join("\n");
    writeFileSync(listing, exact);
    expect(runNodeHeredoc("SUDO_LISTING_NODE", [listing, dispatcher, policy]).status).toBe(0);

    writeFileSync(
      listing,
      exact.replace(`${dispatcher}\n`, `${dispatcher}\n        /usr/bin/id\n`),
    );
    expect(runNodeHeredoc("SUDO_LISTING_NODE", [listing, dispatcher, policy]).status).not.toBe(0);

    writeFileSync(
      listing,
      exact.replace("Options: !authenticate", "Options: !authenticate, setenv"),
    );
    expect(runNodeHeredoc("SUDO_LISTING_NODE", [listing, dispatcher, policy]).status).not.toBe(0);

    writeFileSync(
      listing,
      exact.replace("RunAsUsers: root", "RunAsUsers: root\n    RunAsGroups: root"),
    );
    expect(runNodeHeredoc("SUDO_LISTING_NODE", [listing, dispatcher, policy]).status).not.toBe(0);

    writeFileSync(listing, `${exact}\nSudoers entry:\n    RunAsUsers: root\n`);
    expect(runNodeHeredoc("SUDO_LISTING_NODE", [listing, dispatcher, policy]).status).not.toBe(0);
  });

  it("creates only private deployer staging and verifies installed ownership", () => {
    expect(script).toContain('readonly incoming_base="$private_base/incoming"');
    expect(script).toContain('readonly work_base="$private_base/work"');
    expect(script).toContain('readonly state_base="$private_base/state"');
    expect(script).toContain('"$deployer_home" "$private_base" "$incoming_base"');
    expect(script).toContain('assert_directory "$incoming_base" "$deployer_user"');
    expect(script).toContain('assert_deployer_file "$agent_path" 750');
    expect(script).toContain('assert_deployer_file "$smoke_path" 640');
    expect(script).toMatch(/\bfind\b/u);
    expect(script).toMatch(/\bsync\b/u);
  });
});
