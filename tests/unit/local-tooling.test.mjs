import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  normalizeSchemaSnapshot,
  validateGeneratedDatabaseTypes,
  validateSchemaSnapshot,
} from "../../scripts/database-artifacts.mjs";
import { parseSupabaseCliError, parseSupabaseStatus } from "../../scripts/local-setup.mjs";
import { hostConfigurationFiles } from "../../scripts/release.mjs";

describe("local tooling contracts", () => {
  it("keeps Knip independent from the destructive E2E runtime environment", () => {
    const configuration = JSON.parse(
      readFileSync(new URL("../../knip.json", import.meta.url), "utf8"),
    );

    expect(configuration.playwright).toEqual({
      config: [],
      entry: ["playwright.config.ts", "tests/e2e/**/*.spec.ts"],
    });
  });

  it("keeps the Supabase CA valid and wired into CI and both production services", () => {
    const certificatePath = new URL(
      "../../ops/certificates/supabase-root-2021-ca.crt",
      import.meta.url,
    );
    const certificate = new X509Certificate(readFileSync(certificatePath));
    const expectedPath = "/etc/set-livre/supabase-root-2021-ca.crt";
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const webUnit = readFileSync(
      new URL("../../ops/systemd/set-livre-web.service", import.meta.url),
      "utf8",
    );
    const backofficeUnit = readFileSync(
      new URL("../../ops/systemd/set-livre-backoffice.service", import.meta.url),
      "utf8",
    );

    expect(certificate.ca).toBe(true);
    expect(certificate.subject).toContain("CN=Supabase Root 2021 CA");
    expect(certificate.issuer).toBe(certificate.subject);
    expect(certificate.fingerprint256.replaceAll(":", "")).toBe(
      "807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA",
    );
    expect(new Date(certificate.validTo).toISOString()).toBe("2031-04-26T10:56:53.000Z");
    expect(workflow).toContain(
      "NODE_EXTRA_CA_CERTS: ${{ github.workspace }}/ops/certificates/supabase-root-2021-ca.crt",
    );
    expect(bootstrap).toContain(expectedPath);
    expect(webUnit).toContain(`Environment=NODE_EXTRA_CA_CERTS=${expectedPath}`);
    expect(backofficeUnit).toContain(`Environment=NODE_EXTRA_CA_CERTS=${expectedPath}`);
  });

  it("removes checkout credentials and isolates the two service identities", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const webUnit = readFileSync(
      new URL("../../ops/systemd/set-livre-web.service", import.meta.url),
      "utf8",
    );
    const backofficeUnit = readFileSync(
      new URL("../../ops/systemd/set-livre-backoffice.service", import.meta.url),
      "utf8",
    );
    const recoveryUnit = readFileSync(
      new URL("../../ops/systemd/set-livre-release-recovery@.service", import.meta.url),
      "utf8",
    );
    const recoveryPath = readFileSync(
      new URL("../../ops/systemd/set-livre-release-recovery.path", import.meta.url),
      "utf8",
    );

    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(3);
    expect(webUnit).toContain("User=setlivre-web");
    expect(webUnit).not.toContain("User=setlivre-backoffice");
    expect(webUnit).toContain("ConditionPathExists=/opt/set-livre/current/web/server.js");
    expect(webUnit).toContain("EnvironmentFile=/opt/set-livre/current/.runtime/web.env");
    expect(backofficeUnit).toContain("User=setlivre-backoffice");
    expect(backofficeUnit).not.toContain("User=setlivre-web\n");
    expect(backofficeUnit).toContain(
      "ConditionPathExists=/opt/set-livre/current/backoffice/apps/backoffice/server.js",
    );
    expect(backofficeUnit).toContain(
      "EnvironmentFile=/opt/set-livre/current/.runtime/backoffice.env",
    );
    for (const unit of [webUnit, backofficeUnit]) {
      for (const hardening of [
        "AmbientCapabilities=",
        "CapabilityBoundingSet=",
        "PrivateDevices=true",
        "ProtectClock=true",
        "ProtectHostname=true",
        "ProtectKernelLogs=true",
        "RemoveIPC=true",
        "RestrictNamespaces=true",
        "RestrictRealtime=true",
        "StartLimitBurst=5",
        "StartLimitIntervalSec=60s",
        "UMask=0077",
      ]) {
        expect(unit).toContain(hardening);
      }
    }
    expect(bootstrap).toContain("systemctl stop set-livre-web.service");
    expect(bootstrap).toContain("systemctl reset-failed set-livre-web.service || true");
    expect(bootstrap).toContain("systemctl stop set-livre-backoffice.service");
    expect(bootstrap).toContain("systemctl reset-failed set-livre-backoffice.service || true");
    expect(recoveryUnit).toContain("ExecStart=/usr/local/sbin/set-livre-deploy --recover-%i");
    expect(recoveryUnit).not.toContain("ConditionPathExists=");
    expect(recoveryUnit).not.toContain("RemainAfterExit=yes");
    expect(recoveryUnit).not.toContain("Before=set-livre-web.service");
    expect(recoveryPath).toContain("PathExists=/opt/set-livre/.activation-rollback");
    expect(recoveryPath).toContain("Unit=set-livre-release-recovery@services.service");
    expect(webUnit).toContain("Requires=set-livre-release-recovery@link.service");
    expect(backofficeUnit).toContain("Requires=set-livre-release-recovery@link.service");
  });

  it("preserves Oracle networking while exposing only the production entrypoints", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");

    expect(bootstrap).not.toMatch(/apt-get install[\s\S]*\\\n\s+ufw\b/u);
    expect(bootstrap).toContain("iptables-persistent");
    expect(bootstrap).toContain("fail2ban");
    expect(bootstrap).toContain("InstanceServices");
    expect(bootstrap).toContain('[[ ${oracle_rules_after} == "${oracle_rules_before}" ]]');
    expect(bootstrap).toContain("iptables-restore --test");
    expect(bootstrap).toContain("ip6tables-restore --test");
    expect(bootstrap).toContain('re.fullmatch(r"# (Generated|Completed) .*", line)');
    expect(bootstrap).toContain("firewall_transition_active=true");
    expect(bootstrap).toContain('iptables-restore < "$previous_ipv4_rules"');
    expect(bootstrap).not.toContain("netfilter-persistent reload");
    expect(bootstrap).toContain("/etc/ssh/sshd_config.d/60-setlivre-hardening.conf");
    expect(bootstrap).not.toContain("rm -f -- /etc/ssh/sshd_config.d/60-setlivre-hardening.conf");
    expect(bootstrap).toContain("/etc/nginx/sites-enabled/setlivre");
    expect(bootstrap).toContain("for port in (22, 80, 443)");
    expect(bootstrap).toContain(
      'f"-A {chain} -p tcp --dport {port} -m conntrack --ctstate NEW -j ACCEPT"',
    );
  });

  it("rejects every retired pull-deployer surface before changing the host", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const guardCall = bootstrap.indexOf("assert_legacy_surface_absent\n");
    const digestCalculation = bootstrap.indexOf('host_configuration_digest="$(python3');

    for (const legacyPath of [
      "/etc/setlivre-deployer",
      "/etc/sudoers.d/setlivre-deployer",
      "/etc/systemd/system/setlivre-production-deployer.service",
      "/etc/systemd/system/setlivre-release-recovery.service",
      "/opt/node-v24.18.0",
      "/opt/setlivre",
      "/usr/local/libexec/setlivre-host-tools",
      "/usr/local/sbin/setlivre-release-manager",
      "/var/lib/setlivre-deployer",
    ]) {
      expect(bootstrap).toContain(legacyPath);
    }
    expect(bootstrap).toContain("! getent passwd setlivre-deployer");
    expect(bootstrap).toContain("! getent passwd setlivre");
    expect(bootstrap).toContain("! getent group setlivre-deployer");
    expect(bootstrap).toContain('sysctl --values "net.ipv6.conf.${setting}.disable_ipv6"');
    expect(bootstrap).not.toContain('rm -rf -- "/opt/setlivre"');
    expect(guardCall).toBeGreaterThan(-1);
    expect(digestCalculation).toBeGreaterThan(guardCall);
  });

  it("publishes only a fully validated Node runtime through an atomic rename", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const stagedValidation = bootstrap.indexOf(
      'node_installation_is_valid "$node_staging_directory"',
    );
    const atomicPublish = bootstrap.indexOf(
      'mv --no-target-directory -- "$node_staging_directory" "$NODE_INSTALLATION_DIRECTORY"',
    );

    expect(bootstrap).toContain(
      'if ! node_installation_is_valid "$NODE_INSTALLATION_DIRECTORY"; then',
    );
    expect(bootstrap).not.toContain('if [[ ! -x "/opt/${NODE_DIRECTORY}/bin/node" ]]');
    expect(bootstrap).toContain('mktemp --directory "/opt/.${NODE_DIRECTORY}.staging.XXXXXX"');
    expect(bootstrap).toContain("--strip-components=1");
    expect(bootstrap).toContain("path.resolve(strict=True)");
    expect(bootstrap).toContain("target.relative_to(resolved_root)");
    expect(bootstrap).toContain("stat.S_IMODE(root_stat.st_mode) != 0o755");
    expect(bootstrap).toContain("metadata.st_uid != 0 or metadata.st_gid != 0");
    expect(bootstrap).toContain("stat.S_IMODE(metadata.st_mode) & 0o022");
    expect(bootstrap).toContain('chmod 0755 "$node_staging_directory"');
    expect(bootstrap).toContain('"${directory}/bin/node" --version');
    expect(stagedValidation).toBeGreaterThan(-1);
    expect(atomicPublish).toBeGreaterThan(stagedValidation);
  });

  it("replaces a legacy Node alias through a staged symlink with recoverable quarantine", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const isolateLegacyAlias = bootstrap.indexOf(
      'mv --no-target-directory -- "$NODE_ALIAS_PATH" "$node_alias_previous_path"',
    );
    const publishAlias = bootstrap.indexOf(
      'mv --no-target-directory -- "$node_alias_staging_path" "$NODE_ALIAS_PATH"',
    );

    expect(bootstrap).toContain('readonly NODE_ALIAS_PATH="/opt/node"');
    expect(bootstrap).toContain("publish_node_alias() {");
    expect(bootstrap).toContain("node_alias_is_valid");
    expect(bootstrap).toContain("/opt/.node-alias.staging.XXXXXX");
    expect(bootstrap).toContain("/opt/.node-alias.previous.XXXXXX");
    expect(bootstrap).toContain('mountpoint --quiet -- "$NODE_ALIAS_PATH"');
    expect(bootstrap).toContain(
      'mv --no-target-directory -- "$node_alias_previous_path" "$NODE_ALIAS_PATH" || true',
    );
    expect(bootstrap).not.toContain(
      'ln --symbolic --force --no-dereference "$NODE_INSTALLATION_DIRECTORY" /opt/node',
    );
    expect(isolateLegacyAlias).toBeGreaterThan(-1);
    expect(publishAlias).toBeGreaterThan(isolateLegacyAlias);
  });

  it("recreates an unsafe swapfile without following or recursively deleting its path", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const stagedValidation = bootstrap.indexOf('swapfile_is_valid "$swap_staging_file"');
    const atomicPublish = bootstrap.indexOf(
      'mv --no-target-directory -- "$swap_staging_file" "$SWAPFILE_PATH"',
    );

    expect(bootstrap).toContain("[[ -f ${path} && ! -L ${path} ]]");
    expect(bootstrap).toContain("stat --format '%u %g %a %h %s' -- \"$path\"");
    expect(bootstrap).toContain("(( bytes >= MINIMUM_SWAPFILE_BYTES ))");
    expect(bootstrap).toContain("blkid --probe --match-tag TYPE --output value");
    expect(bootstrap).toContain('[[ ${path} == "$SWAPFILE_PATH" ]]');
    expect(bootstrap).toContain('rmdir -- "$path"');
    expect(bootstrap).toContain('mktemp "${SWAPFILE_PATH}.staging.XXXXXX"');
    expect(bootstrap).toContain('mkswap "$swap_staging_file"');
    expect(bootstrap).not.toContain("if [[ ! -f /swapfile ]]");
    expect(bootstrap).not.toContain('rm -rf -- "$SWAPFILE_PATH"');
    expect(stagedValidation).toBeGreaterThan(-1);
    expect(atomicPublish).toBeGreaterThan(stagedValidation);
  });

  it("fails HTTP closed before TLS and rate-limits sensitive endpoints at the trusted edge", () => {
    for (const configuration of ["set-livre-http.conf", "set-livre-tls.conf"]) {
      const nginx = readFileSync(
        new URL(`../../ops/nginx/${configuration}`, import.meta.url),
        "utf8",
      );

      expect(nginx).toContain("server_name _;");
      expect(nginx).toContain("return 444;");
      expect(nginx).toContain("server_name 147.15.97.227;");
      expect(nginx).toContain('X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;');
      expect(nginx).not.toContain("ops.setlivre.com");
    }

    const http = readFileSync(
      new URL("../../ops/nginx/set-livre-http.conf", import.meta.url),
      "utf8",
    );
    expect(http).toContain("/.well-known/acme-challenge/");
    expect(http).not.toContain("proxy_pass");
    expect(http).not.toContain("limit_req_zone");

    const tls = readFileSync(
      new URL("../../ops/nginx/set-livre-tls.conf", import.meta.url),
      "utf8",
    );
    expect(tls).toContain("map $uri $set_livre_edge_limit_key");
    expect(tls).toContain("~^/api/(?:auth/|commands$) $binary_remote_addr;");
    expect(tls).toContain(
      "limit_req_zone $set_livre_edge_limit_key zone=set_livre_edge:10m rate=1r/s;",
    );
    expect(tls).toContain("limit_req zone=set_livre_edge burst=30 nodelay;");
    expect(tls).toContain("limit_req_status 429;");
    expect(tls).toContain("Disallow: /");
    expect(tls).toContain("return 308 https://147.15.97.227$request_uri;");
    expect(tls).toContain("listen 443 ssl default_server;");
    expect(tls).not.toContain("ssl_reject_handshake");
    expect(tls).toContain("proxy_set_header X-Request-Id $http_x_request_id;");
    expect(tls).not.toContain("proxy_set_header X-Request-Id $request_id;");
    expect(
      tls.match(/ssl_certificate \/etc\/letsencrypt\/live\/147\.15\.97\.227\/fullchain\.pem;/gu),
    ).toHaveLength(2);

    const hostVerification = readFileSync(
      new URL("../../ops/verify-host-contracts.sh", import.meta.url),
      "utf8",
    );
    expect(hostVerification).toContain('--resolve "147.15.97.227:443:127.0.0.1"');
    expect(hostVerification).toContain('--cacert "$temporary_directory/ip.crt"');
    expect(hostVerification).toContain("https://147.15.97.227/robots.txt");
  });

  it("restricts deployment SSH and fences releases to the installed host contract", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const deploy = readFileSync(new URL("../../ops/deploy-release.sh", import.meta.url), "utf8");
    const hostVerification = readFileSync(
      new URL("../../ops/verify-host-contracts.sh", import.meta.url),
      "utf8",
    );
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const command = readFileSync(
      new URL("../../ops/deploy-ssh-command.sh", import.meta.url),
      "utf8",
    );

    expect(bootstrap).toContain('restrict,command="/usr/local/sbin/set-livre-deploy-ssh"');
    expect(bootstrap).toContain("/etc/set-livre/host-config.sha256");
    for (const path of hostConfigurationFiles) {
      expect(bootstrap).toContain(path.slice("ops/".length));
    }
    expect(bootstrap.indexOf("systemctl enable --now snap.certbot.renew.timer")).toBeLessThan(
      bootstrap.indexOf('mv --force -- "$digest_source" /etc/set-livre/host-config.sha256'),
    );
    expect(command).toContain("SSH_ORIGINAL_COMMAND");
    expect(command).toContain("cleanup_abandoned_uploads");
    expect(command).toContain(".incoming.lock");
    expect(command).not.toMatch(/\beval\b/u);
    const deployBranchStart = command.indexOf(
      "elif [[ ${original_command} =~ ^deploy\\ ([0-9a-f]{40})\\ ([0-9a-f]{64})$ ]]; then",
    );
    expect(deployBranchStart).toBeGreaterThan(-1);
    const deployBranch = command.slice(deployBranchStart);
    expect(deployBranch.indexOf('expected_checksum="${BASH_REMATCH[2]}"')).toBeLessThan(
      deployBranch.indexOf('cleanup_abandoned_uploads "$release_sha"'),
    );
    expect(deployBranch).toContain(
      'exec sudo /usr/local/sbin/set-livre-deploy "$release_sha" "$expected_checksum"',
    );
    expect(hostVerification).toContain(
      'SSH_ORIGINAL_COMMAND="deploy ${candidate_sha} ${candidate_checksum}"',
    );
    expect(hostVerification).toContain(
      'env_keep += "SET_LIVRE_TEST_CANDIDATE SET_LIVRE_TEST_PHASE SET_LIVRE_TEST_STATE"',
    );
    expect(hostVerification).toContain(
      'invoke_candidate_through_forced_command "$release_sha" "$candidate_checksum"',
    );
    expect(hostVerification).toContain("rollback-public-health-observed");
    expect(hostVerification.match(/tar --hard-dereference/gu)).toHaveLength(2);
    expect(workflow).toContain("LC_ALL=C tar --hard-dereference");
    expect(deploy).toContain("readiness HTTPS público");
    expect(deploy).toContain("RETAINED_RELEASES=4");
    expect(deploy).toContain("hostConfiguration.sha256");
    expect(deploy).toContain(".runtime/web.env");
    expect(deploy).toContain("write_rollback_marker");
    expect(deploy).toContain("recover_link_from_marker");
    expect(deploy).toContain("--recover-link");
    expect(deploy).toContain("--recover-services");
    expect(deploy).toContain("remove_stale_staging_directories");
    expect(deploy).toContain("remove_stale_trusted_files");
    expect(deploy).toContain("^\\.staging-[0-9a-f]{40}\\.[A-Za-z0-9]{6}$");
    expect(deploy).toContain("trap 'on_signal TERM 143' TERM");
    const rollbackStart = deploy.indexOf("rollback_activation() {");
    const rollbackEnd = deploy.indexOf("\non_exit() {", rollbackStart);
    const rollback = deploy.slice(rollbackStart, rollbackEnd);
    expect(rollback).toContain('wait_for_health "$recovered_release"');
    expect(rollback).toContain('wait_for_public_health "$recovered_release"');
    expect(bootstrap).toContain('active_host_digest} == "$host_configuration_digest"');
    expect(bootstrap).toContain('wait_for_active_health "$active_release_sha"');
    expect(bootstrap.indexOf('active_host_digest} == "$host_configuration_digest"')).toBeLessThan(
      bootstrap.indexOf("apt-get update"),
    );
  });

  it("builds the Linux release with production fixtures before packaging", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const buildStart = workflow.indexOf("- name: Build and package Linux release");
    const buildEnd = workflow.indexOf(
      "- name: Exercise host activation and rollback contracts",
      buildStart,
    );
    const buildStep = workflow.slice(buildStart, buildEnd);

    expect(buildStart).toBeGreaterThan(-1);
    expect(buildEnd).toBeGreaterThan(buildStart);
    expect(buildStep).toContain("APP_ENV: production");
    expect(buildStep).toContain("app_runtime_production.oirvvnojgkzdppkdvhej");
    expect(buildStep).toContain("NEXT_PUBLIC_SUPABASE_URL: ${{ env.PRODUCTION_SUPABASE_URL }}");
    expect(buildStep).toContain(
      'NEXT_PUBLIC_APP_URL="$PRODUCTION_PUBLIC_APP_URL" npm run build:web',
    );
    expect(buildStep).toContain(
      'NEXT_PUBLIC_APP_URL="$PRODUCTION_BACKOFFICE_APP_URL" npm run build:backoffice',
    );
    expect(buildStep.indexOf("npm run build:web")).toBeLessThan(
      buildStep.indexOf("npm run release"),
    );
  });

  it("retains Playwright traces and reports only when the browser gate fails", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const browserStart = workflow.indexOf("- name: Full browser suite");
    const buildStart = workflow.indexOf("- name: Build and package Linux release", browserStart);
    const browserDelivery = workflow.slice(browserStart, buildStart);

    expect(browserStart).toBeGreaterThan(-1);
    expect(buildStart).toBeGreaterThan(browserStart);
    expect(browserDelivery).toContain("id: browser_suite");
    expect(browserDelivery).toContain(
      "if: ${{ failure() && steps.browser_suite.outcome == 'failure' }}",
    );
    expect(browserDelivery).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    );
    expect(browserDelivery).toContain(".artifacts/playwright-report");
    expect(browserDelivery).toContain(".artifacts/test-results");
    expect(browserDelivery).toContain("if-no-files-found: error");
    expect(browserDelivery).toContain("include-hidden-files: true");
    expect(browserDelivery).toContain("retention-days: 7");
  });

  it("uses the supported Certbot distribution and automated IP-certificate renewal", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(bootstrap).toContain('readonly CERTBOT_MINIMUM_VERSION="5.4.0"');
    expect(bootstrap).toContain("snap install certbot --classic");
    expect(bootstrap).toContain("snap refresh certbot");
    expect(bootstrap).toContain("readonly CERTIFICATE_MINIMUM_VALIDITY_SECONDS=$((24 * 60 * 60))");
    expect(bootstrap).toContain(
      'openssl x509 -checkend "$CERTIFICATE_MINIMUM_VALIDITY_SECONDS" -noout',
    );
    expect(bootstrap).not.toContain("openssl x509 -checkend 0");
    expect(bootstrap).toContain("openssl x509 -checkip");
    expect(bootstrap).toContain("snap.certbot.renew.timer");
    expect(bootstrap).not.toMatch(/^\s+certbot \\\s*$/mu);
    expect(bootstrap).not.toContain("python3-certbot-nginx");
    expect(workflow).toContain("Verify public web health");
    expect(workflow).not.toContain("BACKOFFICE_URL: ${{ vars.PRD_BACKOFFICE_APP_URL }}");
    expect(workflow).toContain("github.com/rhysd/actionlint/cmd/actionlint@v1.7.12");
  });

  it("accepts the expected local Supabase endpoints", () => {
    expect(
      parseSupabaseStatus(
        JSON.stringify({
          ANON_KEY: "local-anon",
          API_URL: "http://127.0.0.1:54321",
          DB_URL: "postgresql://postgres:local-password@127.0.0.1:54322/postgres",
        }),
      ),
    ).toMatchObject({ API_URL: "http://127.0.0.1:54321" });
  });

  it("rejects a non-local Supabase endpoint", () => {
    expect(() =>
      parseSupabaseStatus(
        JSON.stringify({
          ANON_KEY: "cloud-anon",
          API_URL: "https://project.supabase.co",
          DB_URL: "postgresql://postgres:secret@db.example.com:5432/postgres",
        }),
      ),
    ).toThrow("endpoint local");
  });

  it("extracts structured CLI failures without exposing database credentials", () => {
    expect(
      parseSupabaseCliError(
        'progress\n{"error":{"message":"failed at postgresql://postgres:secret@127.0.0.1/postgres"}}\n',
      ),
    ).toBe("failed at postgresql://[REDACTED]@127.0.0.1/postgres");
    expect(parseSupabaseCliError("unstructured failure")).toBeUndefined();
  });

  it("normalizes and validates the tracked schema dump", () => {
    const schema = normalizeSchemaSnapshot(
      'CREATE SCHEMA "audit";\nCREATE SCHEMA "private";\nCREATE SCHEMA "public";\n\n',
    );
    expect(schema.endsWith("\n")).toBe(true);
    expect(() => validateSchemaSnapshot(schema)).not.toThrow();
    expect(() => validateSchemaSnapshot('CREATE SCHEMA "public";')).toThrow("audit");
  });

  it("validates the shape and syntax of generated database types", () => {
    expect(() =>
      validateGeneratedDatabaseTypes(
        "export type Json = string; export type Database = { public: {} };\n",
      ),
    ).not.toThrow();
    expect(() => validateGeneratedDatabaseTypes("export type Database = {")).toThrow();
  });
});
