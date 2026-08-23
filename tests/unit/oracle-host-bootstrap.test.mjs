import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const bootstrap = readFileSync(
  resolve(repositoryRoot, "scripts/bootstrap-oracle-host.sh"),
  "utf8",
).replaceAll("\r\n", "\n");

const extractHeredoc = (opening) => {
  const start = bootstrap.indexOf(opening);
  if (start < 0) {
    throw new Error(`Heredoc não encontrado: ${opening}`);
  }
  const contentStart = bootstrap.indexOf("\n", start) + 1;
  const contentEnd = bootstrap.indexOf("\nNGINX\n", contentStart);
  if (contentStart === 0 || contentEnd < 0) {
    throw new Error(`Heredoc incompleto: ${opening}`);
  }
  return bootstrap.slice(contentStart, contentEnd);
};

const extractNamedHeredoc = (marker) => {
  const expression = new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n${marker}`);
  const match = expression.exec(bootstrap);
  if (match === null) {
    throw new Error(`Heredoc não encontrado: ${marker}`);
  }
  return match[1];
};

const extractShellFunction = (name) => {
  const start = bootstrap.indexOf(`\n${name}() {\n`);
  const end = bootstrap.indexOf("\n}\n", start);
  if (start < 0 || end < 0) {
    throw new Error(`Função shell não encontrada: ${name}`);
  }
  return bootstrap.slice(start + 1, end + 2);
};

const extractBraceBlockAt = (input, start) => {
  const openingBrace = input.indexOf("{", start);
  if (openingBrace < 0) {
    throw new Error("Bloco sem chave de abertura.");
  }
  let depth = 0;
  for (let index = openingBrace; index < input.length; index += 1) {
    if (input[index] === "{") {
      depth += 1;
    } else if (input[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, index + 1).trim();
      }
    }
  }
  throw new Error("Bloco sem chave de fechamento.");
};

const extractBraceBlock = (input, marker) => {
  const start = input.indexOf(marker);
  if (start < 0) {
    throw new Error(`Bloco não encontrado: ${marker}`);
  }
  return extractBraceBlockAt(input, start);
};

const extractServerBlocks = (input) =>
  [...input.matchAll(/^server \{/gmu)].map((match) => extractBraceBlockAt(input, match.index));

const proxyConfiguration = extractHeredoc("cat >/etc/nginx/conf.d/setlivre-proxy.conf <<'NGINX'");
const bootstrapSiteTemplate = extractNamedHeredoc("NGINX_BOOTSTRAP");
const siteTemplate = extractNamedHeredoc("NGINX_TLS");
const tlsActivation = extractNamedHeredoc("TLS_ENABLE");
const tlsIssuance = extractNamedHeredoc("TLS_ISSUE");
const tlsRenewalHook = extractNamedHeredoc("TLS_RENEWAL_HOOK");
const nodeTreeVerificationProgram = extractNamedHeredoc("NODE_TREE_PY");
const runtimeIdentityProgram = extractNamedHeredoc("RUNTIME_IDENTITY_NODE");
const serverBlocks = extractServerBlocks(siteTemplate);
const opsServer = serverBlocks.find(
  (block) => block.includes("server_name ops.setlivre.com;") && block.includes("listen 443 ssl;"),
);

if (opsServer === undefined) {
  throw new Error("Servidor Nginx do backoffice não encontrado.");
}

const accessRules = (block) =>
  (block.match(/^\s*allow [^;]+;$/gmu) ?? []).map((line) => line.trim());

const numericShellConstant = (name) => {
  const match = new RegExp(`^readonly ${name}=([0-9]+)$`, "mu").exec(bootstrap);
  if (match === null) {
    throw new Error(`Constante numérica não encontrada: ${name}`);
  }
  return Number(match[1]);
};

const runRuntimeIdentity = ({ group, passwd, target }) => {
  const directory = mkdtempSync(resolve(tmpdir(), "setlivre-runtime-identity-"));
  try {
    const groupPath = resolve(directory, "group");
    const passwdPath = resolve(directory, "passwd");
    const targetPath = resolve(directory, "target-passwd");
    writeFileSync(groupPath, group);
    writeFileSync(passwdPath, passwd);
    writeFileSync(targetPath, target);
    return spawnSync(
      process.execPath,
      ["-", groupPath, passwdPath, targetPath, "setlivre", "setlivre", "/nonexistent"],
      { encoding: "utf8", input: runtimeIdentityProgram },
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const bashCandidates =
  process.platform === "win32"
    ? [
        resolve(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe"),
        resolve(process.env.ProgramFiles ?? "C:/Program Files", "Git/usr/bin/bash.exe"),
      ]
    : ["/bin/bash", "/usr/bin/bash"];
const bashPath = bashCandidates.find((candidate) => existsSync(candidate));

const runNodePublicationScenario = (scenario) => {
  if (bashPath === undefined) {
    throw new Error("Bash não encontrado para o teste de publicação atômica do Node.js.");
  }
  const harness = [
    "set -euo pipefail",
    "node_version=24.18.0",
    "node_binary_sha256=trusted-node-digest",
    "node_parent=/uninitialized",
    "node_root=/uninitialized",
    'node_install_staging=""',
    "fail() { return 1; }",
    "sync() { :; }",
    'file_sha256() { printf "%s\\n" "$node_binary_sha256"; }',
    "assert_linux_x64_elf() { :; }",
    "assert_node_tree_matches_archive() {",
    '  printf "verify:%s\\n" "$2" >>"$verification_log"',
    '  [[ ! -e "$2/.unverified" && ! -e "$2/.tampered" ]]',
    "}",
    extractShellFunction("publish_or_reuse_node_tree"),
    extractShellFunction("assert_installed_node_runtime"),
    'sandbox="$(mktemp -d)"',
    '[[ -d "$sandbox" && ! -L "$sandbox" ]]',
    "trap 'rm -rf --one-file-system -- \"$sandbox\"' EXIT",
    'verification_log="$sandbox/verifications"',
    'execution_marker="$sandbox/executed"',
    'node_parent="$sandbox/opt"',
    'node_root="$node_parent/node-v${node_version}"',
    'mkdir -p -- "$node_parent"',
    scenario,
  ].join("\n");
  return spawnSync(bashPath, ["-c", harness], { encoding: "utf8" });
};

describe("Oracle host one-shot and runtime identity bootstrap", () => {
  it("targets the fixed E2.1.Micro x86_64 host and provisions bounded swap and services", () => {
    expect(bootstrap).toContain('readonly node_archive="node-v${node_version}-linux-x64.tar.xz"');
    expect(bootstrap).toContain(
      "readonly node_archive_sha256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
    );
    expect(bootstrap).toContain('[[ "$(uname -m)" == x86_64 ]] || fail');
    expect(bootstrap).toContain("readonly swap_path=/swapfile");
    expect(bootstrap).toContain('fallocate --length 2G -- "$swap_path"');
    expect(bootstrap).toContain("/swapfile none swap sw 0 0");
    expect(bootstrap.match(/^MemoryAccounting=.*$/gmu)).toEqual([
      "MemoryAccounting=true",
      "MemoryAccounting=true",
    ]);
    expect(bootstrap.match(/^MemoryHigh=.*$/gmu)).toEqual([
      "MemoryHigh=${web_memory_high_mib}M",
      "MemoryHigh=${backoffice_memory_high_mib}M",
    ]);
    expect(bootstrap.match(/^MemoryMax=.*$/gmu)).toEqual([
      "MemoryMax=${web_memory_max_mib}M",
      "MemoryMax=${backoffice_memory_max_mib}M",
    ]);
    expect(bootstrap.match(/^MemorySwapMax=.*$/gmu)).toEqual([
      "MemorySwapMax=${web_memory_swap_max_mib}M",
      "MemorySwapMax=${backoffice_memory_swap_max_mib}M",
    ]);
    expect(bootstrap.match(/^OOMPolicy=.*$/gmu)).toEqual(["OOMPolicy=kill", "OOMPolicy=kill"]);
    expect(bootstrap).toContain(
      "Environment=NODE_OPTIONS=--max-old-space-size=${web_node_old_space_mib}",
    );
    expect(bootstrap).toContain(
      "Environment=NODE_OPTIONS=--max-old-space-size=${backoffice_node_old_space_mib}",
    );
    expect(bootstrap.match(/^LoadCredential=runtime\.env:.*$/gmu)).toEqual([
      "LoadCredential=runtime.env:/opt/setlivre/shared/runtime/current/web.env",
      "LoadCredential=runtime.env:/opt/setlivre/shared/runtime/current/backoffice.env",
    ]);
    expect(bootstrap.match(/^UnsetEnvironment=.*$/gmu)).toEqual([
      "UnsetEnvironment=APP_ENV APP_RELEASE_SHA DATABASE_TLS_CA_PATH DATABASE_TLS_CA_SHA256 DATABASE_URL_APP_DAL HOSTNAME NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_TELEMETRY_DISABLED NODE_ENV PORT",
      "UnsetEnvironment=APP_ENV APP_RELEASE_SHA DATABASE_TLS_CA_PATH DATABASE_TLS_CA_SHA256 DATABASE_URL_APP_DAL HOSTNAME NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_URL NEXT_TELEMETRY_DISABLED NODE_ENV PORT",
    ]);
    expect(bootstrap).toContain(
      "ExecStart=/usr/local/bin/node --env-file=%d/runtime.env /opt/setlivre/current/web/server.js",
    );
    expect(bootstrap).toContain(
      "ExecStart=/usr/local/bin/node --env-file=%d/runtime.env /opt/setlivre/current/backoffice/apps/backoffice/server.js",
    );
    expect(bootstrap).not.toContain("EnvironmentFile=");

    const managedMaximum =
      numericShellConstant("web_memory_max_mib") +
      numericShellConstant("backoffice_memory_max_mib") +
      numericShellConstant("deployer_memory_max_mib");
    const managedHigh =
      numericShellConstant("web_memory_high_mib") +
      numericShellConstant("backoffice_memory_high_mib") +
      numericShellConstant("deployer_memory_high_mib");
    expect(managedMaximum).toBe(592);
    expect(managedHigh).toBe(416);
    expect(
      managedMaximum + numericShellConstant("minimum_host_memory_reserve_mib"),
    ).toBeLessThanOrEqual(numericShellConstant("e2_micro_minimum_memtotal_mib"));
    expect(
      numericShellConstant("e2_micro_nominal_memory_mib") - managedMaximum,
    ).toBeGreaterThanOrEqual(400);
    expect(bootstrap).toContain("assert_e2_micro_memory_budget");
    expect(bootstrap).toContain("assert_service_memory_contract");
    expect(bootstrap).toContain("install -d -o root -g root -m 0755 /run/sshd");
    expect(bootstrap.indexOf("install -d -o root -g root -m 0755 /run/sshd")).toBeLessThan(
      bootstrap.indexOf("\nsshd -t\n"),
    );
    expect(bootstrap).not.toMatch(/(?:linux-arm64|aarch64)/u);
  });

  it("validates and publishes the pinned Node.js tree without trusting preexisting content", () => {
    expect(bootstrap).toContain(
      "readonly node_binary_sha256=41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c",
    );
    expect(nodeTreeVerificationProgram).toContain(
      'operation not in {"archive", "normalize", "verify"}',
    );
    expect(nodeTreeVerificationProgram).toContain("member.islnk()");
    expect(nodeTreeVerificationProgram).toContain("actual.keys() != members.keys()");
    expect(nodeTreeVerificationProgram).toContain("information.st_nlink != 1");
    expect(nodeTreeVerificationProgram).toContain("read_digest(path) != expected_hashes[name]");
    expect(nodeTreeVerificationProgram).toContain("information.st_uid != 0");
    expect(nodeTreeVerificationProgram).toContain("information.st_gid != 0");
    expect(nodeTreeVerificationProgram).not.toMatch(/subprocess|os\.system|os\.popen/u);

    const installation = extractShellFunction("install_node_runtime");
    const publication = extractShellFunction("publish_or_reuse_node_tree");
    const assertion = extractShellFunction("assert_installed_node_runtime");
    expect(installation.indexOf('file_sha256 "$archive"')).toBeLessThan(
      installation.indexOf("verify_node_distribution archive"),
    );
    expect(installation.indexOf("verify_node_distribution archive")).toBeLessThan(
      installation.indexOf("tar \\\n"),
    );
    expect(installation.indexOf("verify_node_distribution normalize")).toBeLessThan(
      installation.indexOf("publish_or_reuse_node_tree"),
    );
    expect(installation.indexOf("publish_or_reuse_node_tree")).toBeLessThan(
      installation.indexOf("assert_installed_node_runtime"),
    );
    expect(publication).toContain('[[ -d "$node_root" && ! -L "$node_root" ]] || fail');
    expect(
      publication.indexOf('assert_node_tree_matches_archive "$archive" "$candidate"'),
    ).toBeLessThan(publication.indexOf('mv --no-target-directory -- "$candidate" "$node_root"'));
    expect(publication).not.toContain("$node_root/bin/node");
    expect(assertion.indexOf("assert_node_tree_matches_archive")).toBeLessThan(
      assertion.indexOf('"$node_root/bin/node" --version'),
    );
    expect(bootstrap).not.toContain('if [[ ! -d "$node_root" ]]');
    expect(installation).not.toContain("ln -sfn");
  });

  it("never executes a preexisting unverified Node.js stub", () => {
    const result = runNodePublicationScenario(
      [
        'node_install_staging="$sandbox/staging"',
        'candidate="$node_install_staging/node-v${node_version}-linux-x64"',
        'mkdir -p -- "$candidate" "$node_root/bin"',
        'printf \'#!/usr/bin/env bash\\nprintf executed\\ >%q\\nprintf "v24.18.0\\\\n"\\n\' "$execution_marker" >"$node_root/bin/node"',
        'chmod 0755 -- "$node_root/bin/node"',
        'touch -- "$node_root/.unverified"',
        "set +e",
        '(set -e; publish_or_reuse_node_tree archive "$candidate"; assert_installed_node_runtime archive)',
        'status="$?"',
        "set -e",
        '[[ "$status" -ne 0 ]]',
        '[[ ! -e "$execution_marker" ]]',
        '[[ -d "$candidate" ]]',
        '[[ -f "$node_root/bin/node" ]]',
        '[[ "$(wc -l <"$verification_log")" -eq 1 ]]',
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a preexisting symlink before validation, installation or execution", () => {
    const result = runNodePublicationScenario(
      [
        'node_install_staging="$sandbox/staging"',
        'candidate="$node_install_staging/node-v${node_version}-linux-x64"',
        'target="$sandbox/untrusted-target"',
        'mkdir -p -- "$candidate" "$target/bin"',
        'printf \'#!/usr/bin/env bash\\nprintf executed\\ >%q\\nprintf "v24.18.0\\\\n"\\n\' "$execution_marker" >"$target/bin/node"',
        'chmod 0755 -- "$target/bin/node"',
        "if command -v cygpath >/dev/null 2>&1 && command -v powershell.exe >/dev/null 2>&1; then",
        '  export SETLIVRE_TEST_LINK_WIN="$(cygpath -w "$node_root")"',
        '  export SETLIVRE_TEST_TARGET_WIN="$(cygpath -w "$target")"',
        "  powershell.exe -NoProfile -NonInteractive -Command 'New-Item -ItemType Junction -Path $env:SETLIVRE_TEST_LINK_WIN -Target $env:SETLIVRE_TEST_TARGET_WIN | Out-Null'",
        "else",
        '  ln --symbolic -- "$target" "$node_root"',
        "fi",
        "set +e",
        '(set -e; publish_or_reuse_node_tree archive "$candidate"; assert_installed_node_runtime archive)',
        'status="$?"',
        "set -e",
        '[[ "$status" -ne 0 ]]',
        '[[ ! -e "$execution_marker" ]]',
        '[[ ! -e "$verification_log" ]]',
        '[[ -d "$candidate" ]]',
        '[[ -L "$node_root" ]]',
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a tampered preexisting tree before replacement or execution", () => {
    const result = runNodePublicationScenario(
      [
        'node_install_staging="$sandbox/staging"',
        'candidate="$node_install_staging/node-v${node_version}-linux-x64"',
        'mkdir -p -- "$candidate" "$node_root/bin"',
        'printf \'#!/usr/bin/env bash\\nprintf executed\\ >%q\\nprintf "v24.18.0\\\\n"\\n\' "$execution_marker" >"$node_root/bin/node"',
        'chmod 0755 -- "$node_root/bin/node"',
        'touch -- "$node_root/.tampered"',
        "set +e",
        '(set -e; publish_or_reuse_node_tree archive "$candidate"; assert_installed_node_runtime archive)',
        'status="$?"',
        "set -e",
        '[[ "$status" -ne 0 ]]',
        '[[ ! -e "$execution_marker" ]]',
        '[[ -e "$node_root/.tampered" ]]',
        '[[ -d "$candidate" ]]',
        '[[ "$(wc -l <"$verification_log")" -eq 1 ]]',
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("publishes once by rename and reuses only a tree that verifies again", () => {
    const result = runNodePublicationScenario(
      [
        'node_install_staging="$sandbox/staging"',
        'candidate="$node_install_staging/node-v${node_version}-linux-x64"',
        'mkdir -p -- "$candidate/bin"',
        'printf \'#!/usr/bin/env bash\\nprintf executed\\ >%q\\nprintf "v24.18.0\\\\n"\\n\' "$execution_marker" >"$candidate/bin/node"',
        'chmod 0755 -- "$candidate/bin/node"',
        'publish_or_reuse_node_tree archive "$candidate"',
        "assert_installed_node_runtime archive",
        '[[ -d "$node_root" && ! -L "$node_root" ]]',
        '[[ ! -e "$node_install_staging" ]]',
        '[[ -e "$execution_marker" ]]',
        '[[ "$(wc -l <"$verification_log")" -eq 3 ]]',
        'rm -- "$execution_marker" "$verification_log"',
        'node_install_staging="$sandbox/unused-staging"',
        'publish_or_reuse_node_tree archive "$sandbox/missing-candidate"',
        "assert_installed_node_runtime archive",
        '[[ -e "$execution_marker" ]]',
        '[[ "$(wc -l <"$verification_log")" -eq 2 ]]',
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("installs the exact official Supabase CLI pair as an immutable root-owned host tool", () => {
    expect(bootstrap).toContain(
      "readonly supabase_cli_archive_url=https://github.com/supabase/cli/releases/download/v2.115.0/supabase_2.115.0_linux_amd64.tar.gz",
    );
    expect(bootstrap).toContain(
      "readonly supabase_cli_archive_sha256=ff099608ce758b625532ef03a61f4c9520b995e94ff6cd5480dc0428cad64cb3",
    );
    expect(bootstrap).toContain(
      "readonly supabase_cli_sha256=5986d84e4c7e251126f7579c686b302b3527bc4b2ac1517963930eb0780d3867",
    );
    expect(bootstrap).toContain(
      "readonly supabase_go_sha256=c507c71c331ee9b4dd87b6ec6cc8a6e4f312a642ff0f9e44931129053c534eef",
    );
    expect(bootstrap).toContain('expected = {"supabase", "supabase-go"}');
    expect(bootstrap).toContain("if len(members) != len(expected)");
    expect(bootstrap).toContain("if not member.isfile()");
    for (const flag of [
      "--disable",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto '=https'",
      "--proto-redir '=https'",
      "--tlsv1.2",
      "--connect-timeout 10",
      "--max-time 300",
      "--retry 0",
    ]) {
      expect(extractShellFunction("install_supabase_cli")).toContain(flag);
    }
    const installation = extractShellFunction("install_supabase_cli");
    expect(installation.indexOf('file_sha256 "$archive"')).toBeLessThan(
      installation.indexOf("python3 - \"$archive\" <<'SUPABASE_ARCHIVE_PY'"),
    );
    expect(installation.indexOf("SUPABASE_ARCHIVE_PY")).toBeLessThan(
      installation.indexOf("tar \\\n    --extract"),
    );
    expect(installation.indexOf('file_sha256 "$extracted_cli"')).toBeLessThan(
      installation.indexOf('mv --no-target-directory -- "$candidate"'),
    );
    expect(bootstrap).toContain(
      'readonly supabase_tools_directory="$host_tools_root/$supabase_cli_version"',
    );
    expect(bootstrap).toContain(
      'install -o root -g root -m 0755 -- "$extracted_cli" "$candidate/supabase"',
    );
    expect(bootstrap).toContain(
      'install -o root -g root -m 0755 -- "$extracted_go" "$candidate/supabase-go"',
    );
    expect(bootstrap).toContain(
      'mv --no-target-directory -- "$candidate" "$supabase_tools_directory"',
    );
    expect(bootstrap).toContain('[[ "$(stat -c \'%U:%G:%a:%h\' -- "$path")" == root:root:755:1 ]]');
    expect(bootstrap.match(/^\s*assert_installed_supabase_cli$/gmu)).toHaveLength(2);
    expect(bootstrap).not.toMatch(/curl[^\n]*\|\s*(?:bash|sh)/u);
    expect(bootstrap).not.toMatch(/supabase\/cli\/releases\/(?:latest|download\/latest)/u);
  });

  it("claims a root-only sentinel before mutations and completes it only after verification", () => {
    const claimCall = bootstrap.lastIndexOf("\nclaim_bootstrap\n");
    const completionCall = bootstrap.lastIndexOf("\ncomplete_bootstrap\n");
    expect(bootstrap).toContain('readonly bootstrap_sentinel="$bootstrap_state_directory/state"');
    expect(bootstrap).toContain(
      '[[ ! -e "$bootstrap_state_directory" && ! -L "$bootstrap_state_directory" ]] || fail',
    );
    expect(bootstrap).toContain(
      '[[ "$(stat -c \'%U:%G:%a:%h\' -- "$bootstrap_sentinel")" == root:root:600:1 ]]',
    );
    expect(bootstrap).toContain(
      'install -o root -g root -m 0600 -- "$candidate" "$bootstrap_sentinel"',
    );
    expect(claimCall).toBeGreaterThan(0);
    expect(claimCall).toBeLessThan(bootstrap.indexOf("\napt-get update\n"));
    expect(claimCall).toBeLessThan(bootstrap.indexOf("\nconfigure_host_firewall "));
    expect(claimCall).toBeLessThan(bootstrap.indexOf(`\ncat >"$nginx_bootstrap_site"`));
    expect(completionCall).toBeGreaterThan(bootstrap.indexOf("\nnginx -t\n"));
    expect(completionCall).toBeGreaterThan(bootstrap.indexOf("\nconfigure_host_firewall "));
    expect(bootstrap).toContain("assert_bootstrap_sentinel in-progress");
    expect(bootstrap).toContain("assert_bootstrap_sentinel completed");
    expect(bootstrap).not.toMatch(/rm .*bootstrap_(?:sentinel|state_directory)/u);
  });

  it("accepts only the minimal locked system runtime identity", () => {
    const target = "setlivre:x:997:998:Set Livre runtime:/nonexistent:/usr/sbin/nologin\n";
    const valid = {
      group: "setlivre:x:998:\n",
      passwd: `root:x:0:0:root:/root:/bin/bash\n${target}`,
      target,
    };
    expect(runRuntimeIdentity(valid).status).toBe(0);

    const invalid = [
      { ...valid, group: "setlivre:x:998:unexpected-user\n" },
      {
        ...valid,
        passwd: `${valid.passwd}unexpected:x:996:998::/nonexistent:/usr/sbin/nologin\n`,
      },
      { ...valid, target: target.replace(":997:998:", ":1000:998:") },
      { ...valid, target: target.replace(":997:998:", ":997:1000:") },
      { ...valid, target: target.replace("/nonexistent", "/home/setlivre") },
      { ...valid, target: target.replace("/usr/sbin/nologin", "/bin/bash") },
    ];
    for (const candidate of invalid) {
      expect(runRuntimeIdentity(candidate).status).not.toBe(0);
    }

    expect(bootstrap).toContain('passwd --lock "$runtime_user"');
    expect(bootstrap).toContain(
      '[[ "$(passwd --status "$runtime_user" | awk \'{print $2}\')" == L ]]',
    );
    expect(bootstrap).toContain('[[ "$(id -Gn "$runtime_user")" == "$runtime_group" ]]');
    expect(bootstrap.match(/\nassert_runtime_identity\n/gu)).toHaveLength(2);
  });
});

describe("Oracle host Nginx bootstrap", () => {
  it("uses one dedicated access log format without request secrets or query strings", () => {
    expect(proxyConfiguration).toContain(
      [
        "log_format setlivre_sanitized escape=json",
        `  '$remote_addr [$time_iso8601] "$request_method $uri $server_protocol" '`,
        `  '$status $body_bytes_sent request_id=$request_id';`,
      ].join("\n"),
    );
    expect(proxyConfiguration).not.toMatch(/^access_log /gmu);
    for (const server of serverBlocks) {
      expect(server.match(/^\s*access_log .+;$/gmu)?.map((line) => line.trim())).toEqual([
        "access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;",
      ]);
    }
    expect(proxyConfiguration).not.toMatch(
      /\$(?:request_uri|args|http_referer|http_cookie|http_authorization)\b/iu,
    );
    expect(bootstrap).not.toMatch(/\breferer\b/iu);
  });

  it("canonicalizes unknown HTTP hosts and rejects unknown TLS handshakes", () => {
    expect(serverBlocks).toHaveLength(7);
    expect(serverBlocks.filter((block) => block.includes("default_server"))).toHaveLength(2);
    expect(serverBlocks.find((block) => block.includes("listen 80 default_server;"))).toBe(
      [
        "server {",
        "  listen 80 default_server;",
        "  server_name _;",
        "  access_log /var/log/nginx/setlivre-access.log setlivre_sanitized buffer=32k flush=5s;",
        "  server_tokens off;",
        "  return 308 https://setlivre.com$request_uri;",
        "}",
      ].join("\n"),
    );
    const defaultTls = serverBlocks.find((block) =>
      block.includes("listen 443 ssl default_server;"),
    );
    expect(defaultTls).toContain("server_name _;");
    expect(defaultTls).toContain("ssl_reject_handshake on;");
    expect(defaultTls).toContain(
      "ssl_certificate /etc/letsencrypt/live/setlivre.com/fullchain.pem;",
    );
  });

  it("uses a complete IPv4-only host policy with persistent kernel enforcement", () => {
    expect(extractNamedHeredoc("SYSCTL")).toBe(
      [
        "net.ipv6.conf.all.disable_ipv6 = 1",
        "net.ipv6.conf.default.disable_ipv6 = 1",
        "net.ipv6.conf.lo.disable_ipv6 = 1",
      ].join("\n"),
    );
    expect(bootstrap).toContain(
      "readonly ipv6_sysctl_path=/etc/sysctl.d/60-setlivre-ipv6-disabled.conf",
    );
    expect(bootstrap).toContain('sysctl --load="$ipv6_sysctl_path"');
    expect(bootstrap).toContain('$(</proc/sys/net/ipv6/conf/all/disable_ipv6)" == 1');
    expect(bootstrap).toContain('$(</proc/sys/net/ipv6/conf/default/disable_ipv6)" == 1');
    expect(bootstrap).toContain('$(</proc/sys/net/ipv6/conf/lo/disable_ipv6)" == 1');
    expect(bootstrap.match(/^RestrictAddressFamilies=.*$/gmu)).toEqual([
      "RestrictAddressFamilies=AF_UNIX",
      "RestrictAddressFamilies=AF_INET AF_UNIX",
      "RestrictAddressFamilies=AF_INET AF_UNIX",
    ]);
    expect(siteTemplate).not.toContain("[::]");
    expect(bootstrap).not.toContain("AF_INET6");
    expect(bootstrap).toContain("AddressFamily inet");
    expect(bootstrap.lastIndexOf("\nassert_ipv6_disabled\n")).toBeGreaterThan(
      bootstrap.indexOf("\nconfigure_host_firewall "),
    );
  });

  it("renders only a strictly validated administrative IPv4 /32 into Nginx", () => {
    expect(bootstrap).toContain(`cat >"$nginx_tls_site" <<'NGINX_TLS'`);
    expect(bootstrap).not.toContain("allow ${administrative_cidr};");
    expect(siteTemplate.match(/__SETLIVRE_ADMINISTRATIVE_CIDR__/gu)).toHaveLength(3);

    const interpolationStart = bootstrap.indexOf(
      `python3 - "$nginx_tls_site" "$administrative_cidr" <<'PY'`,
    );
    const interpolationEnd = bootstrap.indexOf("\nPY\n", interpolationStart);
    const interpolation = bootstrap.slice(interpolationStart, interpolationEnd);
    expect(interpolationStart).toBeGreaterThan(bootstrap.indexOf('cat >"$nginx_tls_site"'));
    expect(interpolation).toContain("network = ipaddress.ip_network(sys.argv[2], strict=True)");
    expect(interpolation).toContain("network.version != 4 or network.prefixlen != 32");
    expect(interpolation).toContain("if configuration.count(placeholder) != 3:");
    expect(interpolation).toContain(
      "configuration = configuration.replace(placeholder, network.with_prefixlen)",
    );
  });

  it("keeps port 80 limited to ACME and exact canonical redirects before and after TLS", () => {
    for (const configuration of [bootstrapSiteTemplate, siteTemplate]) {
      const httpServers = extractServerBlocks(configuration).filter((block) =>
        block.includes("listen 80"),
      );
      expect(httpServers).toHaveLength(3);
      expect(httpServers.join("\n")).not.toContain("proxy_pass");
      expect(httpServers.join("\n")).not.toContain("return 444;");
      for (const server of httpServers) {
        expect(server).toContain("return 308 https://");
      }
      expect(httpServers.join("\n")).toContain("location ^~ /.well-known/acme-challenge/");
      expect(httpServers.join("\n")).toContain("try_files $uri =404;");
      expect(httpServers.join("\n")).toContain("return 308 https://setlivre.com$request_uri;");
      expect(httpServers.join("\n")).toContain("return 308 https://ops.setlivre.com$request_uri;");
    }
    expect(tlsActivation).toContain('openssl x509 -in "$certificate" -noout -checkhost');
    expect(tlsActivation).toContain(
      'expected = {"setlivre.com", "www.setlivre.com", "ops.setlivre.com"}',
    );
    expect(tlsActivation).toContain('restore_site "$previous_site" || fail');
    expect(tlsActivation).toContain("nginx -t >/dev/null 2>&1 || fail");
    expect(tlsActivation).not.toContain("certbot --nginx");
  });

  it("installs only the canonical webroot certificate helper and root-owned renewal hook", () => {
    const aptInstall = bootstrap.slice(
      bootstrap.indexOf("apt-get install -y --no-install-recommends"),
      bootstrap.indexOf("! dpkg-query --show --showformat='${db:Status-Abbrev}' ufw"),
    );
    expect(aptInstall).toContain("ca-certificates certbot curl");
    expect(aptInstall).not.toContain("python3-certbot-nginx");
    expect(bootstrap).toContain(
      "! dpkg-query --show --showformat='${db:Status-Abbrev}' python3-certbot-nginx",
    );
    expect(tlsIssuance).toContain("exec /usr/bin/certbot certonly");
    expect(tlsIssuance).toContain("--webroot");
    expect(tlsIssuance).toContain('--webroot-path "$webroot"');
    expect(tlsIssuance).toContain("--cert-name setlivre.com");
    expect(tlsIssuance.match(/^  --domain .+$/gmu)).toEqual([
      "  --domain setlivre.com \\",
      "  --domain www.setlivre.com \\",
      "  --domain ops.setlivre.com",
    ]);
    expect(tlsIssuance).not.toContain("--nginx");
    expect(bootstrap.replace(tlsIssuance, "")).not.toContain("certbot certonly");

    expect(tlsRenewalHook).toContain("readonly tls_enable=/usr/local/sbin/setlivre-enable-tls");
    expect(tlsRenewalHook).toContain('exec "$tls_enable"');
    expect(bootstrap).toContain(
      'install -o root -g root -m 0750 -- "$tls_renewal_hook_candidate" "$tls_renewal_hook"',
    );
    expect(bootstrap).toContain(
      '[[ "$(stat -c \'%U:%G:%a:%h\' -- "$tls_renewal_hook")" == root:root:750:1 ]]',
    );
    expect(bootstrap).toContain(
      'cmp --silent -- "$tls_renewal_hook_candidate" "$tls_renewal_hook" || fail',
    );
    expect(bootstrap).not.toContain("certbot --nginx");
  });

  it("requires root-owned boot recovery before web, backoffice and Nginx", () => {
    const recoveryUnit = extractNamedHeredoc("UNIT");
    expect(recoveryUnit).toContain(
      "Before=setlivre-web.service setlivre-backoffice.service nginx.service",
    );
    expect(recoveryUnit).toContain(
      "ExecStart=/usr/local/sbin/setlivre-release-manager recover-boot",
    );
    expect(recoveryUnit).toContain("RemainAfterExit=yes");
    expect(bootstrap.match(/^Requires=\$\{recovery_service\}$/gmu)).toHaveLength(3);
    expect(bootstrap.match(/^After=.*\$\{recovery_service\}$/gmu)).toHaveLength(3);
    expect(bootstrap).toContain('[[ "$(systemctl is-active "$recovery_service")" == active ]]');
  });

  it.each(["live", "ready"])(
    "limits and restricts the ops %s health endpoint to the two exact networks",
    (kind) => {
      const health = extractBraceBlock(opsServer, `location = /api/health/${kind} {`);
      expect(health.match(/^\s*limit_req .+;$/gmu)).toEqual([
        "    limit_req zone=setlivre_ops_health burst=10 nodelay;",
      ]);
      expect(accessRules(health)).toEqual([
        "allow __SETLIVRE_ADMINISTRATIVE_CIDR__;",
        "allow 10.20.1.0/24;",
      ]);
      expect(health.match(/^\s*deny all;$/gmu)).toEqual(["    deny all;"]);
    },
  );

  it("keeps the rest of the backoffice administrative-only and outbound smoke reachable", () => {
    expect(proxyConfiguration.match(/^limit_req_zone .+;$/gmu)).toEqual([
      "limit_req_zone $binary_remote_addr zone=setlivre_public:10m rate=20r/s;",
      "limit_req_zone $binary_remote_addr zone=setlivre_ops_health:1m rate=5r/s;",
    ]);
    const backoffice = extractBraceBlock(opsServer, "location / {");
    expect(accessRules(backoffice)).toEqual(["allow __SETLIVRE_ADMINISTRATIVE_CIDR__;"]);
    expect(backoffice).not.toContain("10.20.1.0/24");
    expect(backoffice.match(/^\s*deny all;$/gmu)).toEqual(["    deny all;"]);
    expect(bootstrap).not.toMatch(/^ufw\s/gmu);
    expect(bootstrap).not.toContain("unattended-upgrades ufw");
    expect(bootstrap).toContain("apt-get purge -y ufw");
    expect(bootstrap).toContain("iptables-persistent netfilter-persistent");
    const firewall = extractShellFunction("configure_host_firewall");
    expect(firewall).not.toContain("iptables -w -F");
    expect(firewall).not.toContain("iptables-restore");
    expect(firewall.indexOf("iptables -w -N SETLIVRE_INPUT")).toBeLessThan(
      firewall.indexOf("iptables -w -I INPUT 1 -j SETLIVRE_INPUT"),
    );
    expect(firewall).toContain('cmp --silent -- "$essential_before"');
    expect(firewall).toContain("netfilter-persistent save");
    expect(bootstrap).toContain("169[.]254[.]0[.]2");
    expect(bootstrap).toContain("169[.]254[.]2[.]0/24");
  });
});
