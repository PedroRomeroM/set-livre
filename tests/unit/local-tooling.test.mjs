import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeSchemaSnapshot,
  validateGeneratedDatabaseTypes,
  validateSchemaSnapshot,
  verifyDatabaseArtifacts,
} from "../../scripts/database-artifacts.mjs";
import {
  assertDockerPolicyOrStopRunningStack,
  assertLocalStatusOrStopRunningStack,
  assertLoopbackContainerInspections,
  assertLoopbackNetworkInspection,
  assertNoUnexpectedNextEnvironmentFiles,
  createLocalApplicationEnvironment,
  parseSupabaseCliError,
  parseSupabaseStatus,
  runNextBuildWithCacheCleanup,
  runSupabase,
  supabaseLocalNetworkName,
  validateLocalDockerContext,
  validateDockerDesktopPortBindingPolicy,
  withSupabaseLocalNetwork,
} from "../../scripts/local-setup.mjs";
import { hostConfigurationFiles } from "../../scripts/release.mjs";

describe("local tooling contracts", () => {
  const localApplicationEnvironment = {
    APP_ENV: "local",
    APP_RELEASE_SHA: "local",
    DATABASE_URL_APP_DAL:
      "postgresql://app_runtime_local:local-secret@127.0.0.1:54322/postgres?options=-c%20role%3Dapp_dal",
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_local-contract",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  };

  it("launches local apps only with the generated runtime contract", () => {
    const environment = createLocalApplicationEnvironment({
      expectedApplicationUrl: "http://127.0.0.1:3000",
      inheritedEnvironment: {
        DATABASE_URL_APP_DAL: "postgresql://production.example/unsafe",
        NEXT_PUBLIC_SUPABASE_URL: "https://production.supabase.co",
        NODE_EXTRA_CA_CERTS: "production-ca.pem",
        PATH: "C:\\Windows\\System32",
        PRD_DATABASE_URL_APP_DAL: "production-secret",
        SUPABASE_ACCESS_TOKEN: "production-token",
      },
      localEnvironment: localApplicationEnvironment,
    });

    expect(environment).toMatchObject(localApplicationEnvironment);
    expect(environment.PATH).toBe("C:\\Windows\\System32");
    expect(environment).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    expect(environment).not.toHaveProperty("PRD_DATABASE_URL_APP_DAL");
    expect(environment).not.toHaveProperty("SUPABASE_ACCESS_TOKEN");
    expect(() =>
      createLocalApplicationEnvironment({
        expectedApplicationUrl: "http://127.0.0.1:3000",
        localEnvironment: {
          ...localApplicationEnvironment,
          DATABASE_URL_APP_DAL:
            "postgresql://app_runtime_local:secret@remote.example:54322/postgres?options=-c%20role%3Dapp_dal",
        },
      }),
    ).toThrow("identidade DAL local");
  });

  it("routes development scripts through the local guard and rejects extra Next env files", () => {
    const rootManifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const backofficeManifest = JSON.parse(
      readFileSync(new URL("../../apps/backoffice/package.json", import.meta.url), "utf8"),
    );
    expect(rootManifest.scripts.dev).toBe("node scripts/local-setup.mjs dev-web");
    expect(rootManifest.scripts["dev:backoffice"]).toBe(
      "node scripts/local-setup.mjs dev-backoffice",
    );
    expect(rootManifest.scripts.start).toBe("node scripts/local-setup.mjs start-web");
    expect(rootManifest.scripts["start:backoffice"]).toBe(
      "node scripts/local-setup.mjs start-backoffice",
    );
    expect(rootManifest.scripts["build:web"]).toBe("node scripts/local-setup.mjs build-web");
    expect(backofficeManifest.scripts.dev).toBe(
      "node ../../scripts/local-setup.mjs dev-backoffice",
    );
    expect(backofficeManifest.scripts.start).toBe(
      "node ../../scripts/local-setup.mjs start-backoffice",
    );
    expect(backofficeManifest.scripts.build).toBe(
      "node ../../scripts/local-setup.mjs build-backoffice",
    );

    const directory = mkdtempSync(resolve(tmpdir(), "set-livre-next-env-"));
    try {
      expect(() => assertNoUnexpectedNextEnvironmentFiles(directory, "dev")).not.toThrow();
      writeFileSync(resolve(directory, ".env.development"), "APP_ENV=unsafe\n", "utf8");
      expect(() => assertNoUnexpectedNextEnvironmentFiles(directory, "dev")).toThrow(
        "aceita somente .env.local",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("removes secret-bearing Next caches after successful and failed builds", async () => {
    for (const status of [0, 1]) {
      const directory = mkdtempSync(resolve(tmpdir(), "set-livre-next-build-"));
      const nextDirectory = resolve(directory, ".next");
      const cacheDirectory = resolve(nextDirectory, "cache");
      const secret = resolve(cacheDirectory, "compiler-secret.txt");
      const executeBuild = () => {
        mkdirSync(cacheDirectory, { recursive: true });
        writeFileSync(secret, "postgresql://runtime:secret@database.example/postgres", "utf8");
        return { status };
      };

      try {
        const build = runNextBuildWithCacheCleanup({
          application: "web",
          executeBuild,
          root: directory,
        });
        if (status === 0) await expect(build).resolves.toBeUndefined();
        else await expect(build).rejects.toThrow("encerrou o build sem sucesso");
        expect(readdirSync(nextDirectory)).toEqual([]);
        expect(() => readFileSync(secret, "utf8")).toThrow();
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  });

  it("cleans a completed schema dump before propagating a later type-generation failure", async () => {
    const supabaseDirectory = new URL("../../supabase/", import.meta.url);
    const temporarySchemaPattern = /^\.schema\.generated\.sql\..+\.tmp$/u;
    const temporarySchemas = () =>
      readdirSync(supabaseDirectory)
        .filter((name) => temporarySchemaPattern.test(name))
        .sort();
    const before = temporarySchemas();
    const trackedSchema = readFileSync(
      new URL("../../supabase/schema.generated.sql", import.meta.url),
      "utf8",
    );
    const runSupabase = (argumentsList) => {
      if (argumentsList[0] === "db" && argumentsList[1] === "dump") {
        const destination = argumentsList[argumentsList.indexOf("--file") + 1];
        writeFileSync(destination, trackedSchema, "utf8");
        return "";
      }
      if (argumentsList[0] === "gen" && argumentsList[1] === "types") {
        throw new Error("falha de geração simulada");
      }
      throw new Error("comando Supabase inesperado no teste");
    };

    await expect(verifyDatabaseArtifacts(runSupabase)).rejects.toThrow("falha de geração simulada");
    expect(temporarySchemas()).toEqual(before);
  });

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
    const applicationStartUnit = readFileSync(
      new URL("../../ops/systemd/set-livre-application-start.service", import.meta.url),
      "utf8",
    );
    const recoveryUnit = readFileSync(
      new URL("../../ops/systemd/set-livre-release-recovery.service", import.meta.url),
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
    expect(webUnit).toContain("ConditionPathExists=/etc/set-livre/host-config.sha256");
    expect(webUnit).toContain("ConditionPathExists=!/etc/set-livre/bootstrap-in-progress.sha256");
    expect(webUnit).toContain("EnvironmentFile=/opt/set-livre/current/.runtime/web.env");
    expect(backofficeUnit).toContain("User=setlivre-backoffice");
    expect(backofficeUnit).not.toContain("User=setlivre-web\n");
    expect(backofficeUnit).toContain(
      "ConditionPathExists=/opt/set-livre/current/backoffice/apps/backoffice/server.js",
    );
    expect(backofficeUnit).toContain("ConditionPathExists=/etc/set-livre/host-config.sha256");
    expect(backofficeUnit).toContain(
      "ConditionPathExists=!/etc/set-livre/bootstrap-in-progress.sha256",
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
    for (const unit of [webUnit, backofficeUnit]) {
      expect(unit).not.toContain("[Install]");
      expect(unit).not.toContain("WantedBy=multi-user.target");
      expect(unit).not.toContain("set-livre-release-recovery@link.service");
    }
    expect(applicationStartUnit).toContain("Requires=set-livre-release-recovery.service");
    expect(applicationStartUnit).toContain("After=set-livre-release-recovery.service");
    expect(applicationStartUnit).toContain(
      "ExecStart=/usr/bin/systemctl start set-livre-web.service set-livre-backoffice.service",
    );
    expect(applicationStartUnit).toContain("RemainAfterExit=yes");
    expect(applicationStartUnit).toContain("WantedBy=multi-user.target");
    expect(recoveryUnit).toContain("ExecStart=/usr/local/sbin/set-livre-deploy --recover-services");
    expect(recoveryUnit).toContain("TimeoutStartSec=12min");
    expect(recoveryUnit).not.toContain("ConditionPathExists=");
    expect(recoveryUnit).not.toContain("RemainAfterExit=yes");
    expect(recoveryUnit).not.toContain("set-livre-application-start.service");
    expect(recoveryUnit).toContain("Wants=network-online.target");
    expect(recoveryUnit).toContain("Requires=nginx.service");
    expect(recoveryUnit).toContain("After=network-online.target nginx.service");
    expect(recoveryUnit).toContain("ExecStopPost=/usr/local/sbin/set-livre-deploy --seal-services");
    expect(recoveryUnit).toContain("ReadWritePaths=/etc/set-livre /opt/set-livre /run/lock");
    expect(recoveryPath).toContain("PathExists=/opt/set-livre/.activation-rollback");
    expect(recoveryPath).toContain("Unit=set-livre-release-recovery.service");
    expect(bootstrap).toContain(
      "systemctl disable set-livre-web.service set-livre-backoffice.service",
    );
    expect(bootstrap).toContain("set-livre-application-start.service");
  });

  it("authenticates and consumes a paired bootstrap recovery state", () => {
    const deploy = readFileSync(new URL("../../ops/deploy-release.sh", import.meta.url), "utf8");
    const hostVerification = readFileSync(
      new URL("../../ops/verify-host-contracts.sh", import.meta.url),
      "utf8",
    );
    const authorizationStart = deploy.indexOf("authorize_interrupted_bootstrap_recovery() {");
    const authorizationEnd = deploy.indexOf(
      "\nensure_bootstrap_recovery_blocker() {",
      authorizationStart,
    );
    const authorization = deploy.slice(authorizationStart, authorizationEnd);
    const beginStart = deploy.indexOf("begin_interrupted_bootstrap_recovery() {");
    const beginEnd = deploy.indexOf("\nseal_interrupted_bootstrap_recovery() {", beginStart);
    const begin = deploy.slice(beginStart, beginEnd);

    expect(authorizationStart).toBeGreaterThan(-1);
    expect(authorizationEnd).toBeGreaterThan(authorizationStart);
    expect(authorization).toContain("read_bootstrap_recovery_digest");
    expect(deploy).toContain(
      'read_host_state_digest "$HOST_BOOTSTRAP_IN_PROGRESS" "root:root:600"',
    );
    expect(deploy).toContain(
      'read_host_state_digest "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS" "root:root:600"',
    );
    expect(authorization).toContain(
      'read_host_state_digest "$HOST_CONFIGURATION_DIGEST" "root:setlivre:640"',
    );
    expect(authorization).toContain('[[ ${bootstrap_digest} == "$installed_digest" ]]');
    expect(authorization).toContain('manifest.get("commit") != expected_release');
    expect(authorization).toContain("not isinstance(host_configuration, dict)");
    expect(authorization).toContain('host_configuration.get("sha256") != expected_digest');
    expect(authorization).not.toContain('rm -f -- "$HOST_BOOTSTRAP_IN_PROGRESS"');
    expect(beginStart).toBeGreaterThan(-1);
    expect(beginEnd).toBeGreaterThan(beginStart);
    expect(begin.indexOf("publish_bootstrap_recovery_phase")).toBeLessThan(
      begin.indexOf('rm -f -- "$HOST_BOOTSTRAP_IN_PROGRESS"'),
    );
    expect(deploy).toContain("ensure_bootstrap_recovery_blocker");
    expect(deploy).not.toContain("--recover-link");
    expect(deploy).not.toContain("--seal-link");
    const recoveryBranchStart = deploy.indexOf(
      'if [[ $# -eq 1 && ${1:-} == "--recover-services" ]]',
    );
    const recoveryBranchEnd = deploy.indexOf("\n  exit 0\nfi\n", recoveryBranchStart) + 13;
    const recoveryBranch = deploy.slice(recoveryBranchStart, recoveryBranchEnd);
    expect(recoveryBranchStart).toBeGreaterThan(-1);
    expect(recoveryBranchEnd).toBeGreaterThan(recoveryBranchStart);
    expect(recoveryBranch).toContain("managed_release_directories_are_valid");
    expect(recoveryBranch.indexOf("managed_release_directories_are_valid")).toBeLessThan(
      recoveryBranch.indexOf("read_rollback_marker"),
    );
    const sealStart = deploy.indexOf('if [[ $# -eq 1 && ${1:-} == "--seal-services" ]]');
    const sealEnd = deploy.indexOf("\n  exit 0\nfi\n", sealStart);
    expect(deploy.slice(sealStart, sealEnd)).toContain("managed_release_directories_are_valid");
    const servicesStart = deploy.indexOf('if [[ $# -eq 1 && ${1:-} == "--recover-services" ]]');
    const servicesEnd = deploy.indexOf("\n  exit 0\nfi\n", servicesStart);
    const servicesRecovery = deploy.slice(servicesStart, servicesEnd);
    expect(servicesRecovery.indexOf("read_rollback_marker")).toBeLessThan(
      servicesRecovery.indexOf("begin_interrupted_bootstrap_recovery"),
    );
    expect(servicesRecovery.indexOf("begin_interrupted_bootstrap_recovery")).toBeLessThan(
      servicesRecovery.indexOf("activate_recovered_link"),
    );
    expect(hostVerification).toContain("privileged_regular_file_exists");
    expect(hostVerification).toContain(
      "recovery ${recovery_mode} aceitou digests divergentes no bootstrap",
    );
    expect(hostVerification).toContain(
      "recovery selado não restaurou o bloqueio autenticado de bootstrap",
    );
    expect(hostVerification).toContain("SIGKILL consumiu a fase durável do recovery");
    expect(hostVerification).toContain("selamento pós-SIGKILL comum não interrompeu os serviços");
    expect(deploy).toContain("seal_interrupted_release_recovery() {");
  });

  it("preserves Oracle networking while exposing only the production entrypoints", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const fail2banRestart = bootstrap.indexOf("systemctl restart fail2ban");
    const firewallSnapshot = bootstrap.indexOf('previous_ipv4_rules="$(mktemp)"');
    const fail2banContractChecks = [...bootstrap.matchAll(/&& fail2ban_contract_is_ready;/gu)].map(
      (match) => match.index,
    );

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
    expect(bootstrap).not.toContain("systemctl stop fail2ban");
    expect(bootstrap).not.toContain("fail2ban_stopped");
    expect(fail2banRestart).toBeGreaterThan(-1);
    expect(fail2banRestart).toBeLessThan(firewallSnapshot);
    expect(bootstrap).toContain("Fail2ban não ficou pronto antes da transição");
    expect(bootstrap).toContain("fail2ban-client status sshd");
    expect(bootstrap).toContain("banaction = nftables[actionstart_on_demand=false]");
    expect(bootstrap).toContain(
      "banaction_allports = nftables[type=allports, actionstart_on_demand=false]",
    );
    expect(bootstrap).toContain("fail2ban_contract_is_ready() {");
    expect(bootstrap).toContain("fail2ban-client get sshd action nftables actionban");
    expect(bootstrap).toContain("nft list table inet f2b-table");
    expect(fail2banContractChecks).toHaveLength(2);
    expect(fail2banContractChecks[0]).toBeLessThan(firewallSnapshot);
    expect(fail2banContractChecks[1]).toBeGreaterThan(
      bootstrap.indexOf('ip6tables-restore < "$ipv6_rules"'),
    );
    expect(bootstrap).toContain("/etc/ssh/sshd_config.d/60-setlivre-hardening.conf");
    expect(bootstrap).not.toContain("rm -f -- /etc/ssh/sshd_config.d/60-setlivre-hardening.conf");
    expect(bootstrap).toContain("/etc/nginx/sites-enabled/setlivre");
    expect(bootstrap).toContain("for port in (22, 80, 443)");
    expect(bootstrap).toContain(
      'f"-A {chain} -p tcp --dport {port} -m conntrack --ctstate NEW -j ACCEPT"',
    );
  });

  it("verifies the effective SSH policy before reloading the daemon", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const hostVerification = readFileSync(
      new URL("../../ops/verify-host-contracts.sh", import.meta.url),
      "utf8",
    );
    const unconditional = bootstrap.indexOf(
      "assert_unconditional_sshd_policy_surface /etc/ssh/sshd_config",
    );
    const validation = bootstrap.indexOf("assert_effective_sshd_policy /etc/ssh/sshd_config");
    const reload = bootstrap.indexOf("systemctl reload ssh", validation);

    expect(bootstrap).toContain('sshd -T -f "$configuration"');
    expect(bootstrap).toContain('keyword == "match"');
    expect(bootstrap).toContain('expected_include="${drop_in_directory}/*.conf"');
    expect(bootstrap).toContain('effective_allow_users_are_exact "$effective"');
    expect(bootstrap).toContain('root_owned_without_unprivileged_write "$configuration"');
    expect(bootstrap).toContain('root_owned_without_unprivileged_write "$drop_in_directory"');
    expect(bootstrap).toContain(
      '-C "user=${context_user},host=set-livre,addr=203.0.113.1,laddr=${PRODUCTION_IP},lport=22"',
    );
    expect(bootstrap).toContain("for context_user in ubuntu deploy-setlivre root");
    for (const expected of [
      "authenticationmethods publickey",
      "kbdinteractiveauthentication no",
      "passwordauthentication no",
      "permitrootlogin no",
      "pubkeyauthentication yes",
    ]) {
      expect(bootstrap).toContain(expected);
    }
    expect(bootstrap).toContain("AllowUsers ubuntu deploy-setlivre");
    expect(hostVerification).toContain("$'allowusers ubuntu\\nallowusers deploy-setlivre'");
    expect(hostVerification).toContain("'allowusers ubuntu deploy-setlivre'");
    expect(hostVerification).toContain("política Match condicional foi aceita");
    expect(hostVerification).toContain(
      "drop-in SSH gravável por identidade não privilegiada foi aceito",
    );
    expect(hostVerification).toContain("configuração SSH sem ownership root foi aceita");
    expect(hostVerification).toContain("diretório de drop-ins SSH gravável por grupo foi aceito");
    expect(hostVerification).toContain("diretório principal SSH gravável por grupo foi aceito");
    expect(unconditional).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(unconditional);
    expect(reload).toBeGreaterThan(validation);
  });

  it("rejects every retired pull-deployer surface before changing the host", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const guardCall = bootstrap.indexOf('assert_legacy_surface_absent "$managed_host_contract"');
    const digestCalculation = bootstrap.indexOf('host_configuration_digest="$(python3');
    const guardDefinitionStart = bootstrap.indexOf("assert_legacy_surface_absent() {");
    const guardDefinitionEnd = bootstrap.indexOf(
      "\nhost_state_marker_is_valid() {",
      guardDefinitionStart,
    );
    const guardDefinition = bootstrap.slice(guardDefinitionStart, guardDefinitionEnd);

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
    expect(bootstrap).toContain("/etc/fail2ban/jail.d/setlivre-sshd.local");
    expect(bootstrap).toContain(
      "publish_managed_content /etc/fail2ban/jail.d/set-livre-sshd.local",
    );
    expect(bootstrap).toContain('local managed_nginx_link="/etc/nginx/sites-enabled/setlivre"');
    expect(bootstrap).toContain(
      'local managed_nginx_target="/etc/nginx/sites-available/set-livre"',
    );
    expect(bootstrap).toContain('$(readlink -- "$managed_nginx_link") == "$managed_nginx_target"');
    expect(bootstrap).toContain("[[ ${managed_host_contract} == true \\");
    expect(guardDefinitionStart).toBeGreaterThan(-1);
    expect(guardDefinitionEnd).toBeGreaterThan(guardDefinitionStart);
    expect(guardDefinition.match(/\/etc\/nginx\/sites-enabled\/setlivre/gu) ?? []).toHaveLength(1);
    expect(guardCall).toBeGreaterThan(-1);
    expect(digestCalculation).toBeGreaterThan(guardCall);
  });

  it("permits reused runtime paths only after validating a retryable host state", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const markerValidation = bootstrap.indexOf("host_state_marker_is_valid() {");
    const lockAcquired = bootstrap.indexOf(
      'exec python3 "$DEPLOY_LOCK_SOURCE" run blocking "${SCRIPT_DIRECTORY}/bootstrap-host.sh"',
    );
    const stateDirectoryPrepared = bootstrap.indexOf(
      'ensure_bootstrap_state_directory "$HOST_STATE_DIRECTORY" \\',
      lockAcquired,
    );
    const installedDetection = bootstrap.indexOf(
      '"$HOST_CONFIGURATION_DIGEST" "root:setlivre:640"',
      markerValidation,
    );
    const previousDetection = bootstrap.indexOf(
      '"$HOST_CONFIGURATION_PREVIOUS_DIGEST" "root:setlivre:640"',
      installedDetection,
    );
    const pendingDetection = bootstrap.indexOf(
      '"$HOST_BOOTSTRAP_IN_PROGRESS" "root:root:600"',
      previousDetection,
    );
    const guardCall = bootstrap.indexOf('assert_legacy_surface_absent "$managed_host_contract"');
    const pendingPublish = bootstrap.indexOf(
      'publish_bootstrap_in_progress "$host_configuration_digest"',
      guardCall,
    );
    const stateDirectorySecured = bootstrap.indexOf(
      'ensure_managed_directory "$HOST_STATE_DIRECTORY" root root 0700',
      pendingPublish,
    );
    const activeReleaseInspection = bootstrap.indexOf(
      "if [[ -e /opt/set-livre/current || -L /opt/set-livre/current ]]; then",
    );
    const finalDigestPublish = bootstrap.indexOf(
      'mv --no-target-directory --force -- "$digest_source" "$HOST_CONFIGURATION_DIGEST"',
    );
    const previousMarkerRemoved = bootstrap.indexOf(
      'rm -f -- "$HOST_CONFIGURATION_PREVIOUS_DIGEST"',
      finalDigestPublish,
    );
    const compatibleGateReleased = bootstrap.indexOf(
      'rm -f -- "$HOST_BOOTSTRAP_IN_PROGRESS"',
      previousMarkerRemoved,
    );

    expect(markerValidation).toBeGreaterThan(-1);
    expect(lockAcquired).toBeGreaterThan(markerValidation);
    expect(stateDirectoryPrepared).toBeGreaterThan(lockAcquired);
    expect(stateDirectoryPrepared).toBeLessThan(installedDetection);
    expect(bootstrap).toContain("root:setlivre:640");
    expect(bootstrap).toContain("root:root:600");
    expect(bootstrap).toContain("${#marker_lines[@]} -eq 1");
    expect(bootstrap).toContain("if [[ ${managed_host_contract} == false ]]; then");
    expect(bootstrap).toContain("for path in /opt/node-v24.18.0 /opt/set-livre /opt/setlivre; do");
    expect(bootstrap).toContain("existing_release_directories_are_valid() {");
    expect(bootstrap).toContain("os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW");
    const existingRootsValidation = bootstrap.indexOf(
      "existing_release_directories_are_valid",
      bootstrap.indexOf("managed_host_contract=true"),
    );
    expect(existingRootsValidation).toBeGreaterThan(pendingDetection);
    expect(bootstrap).toContain(
      'ensure_managed_directory "$HOST_STATE_DIRECTORY" root setlivre 0750',
    );
    expect(existingRootsValidation).toBeLessThan(guardCall);
    expect(existingRootsValidation).toBeLessThan(
      bootstrap.indexOf("\nclear_dangling_current_link\n", guardCall),
    );
    expect(installedDetection).toBeGreaterThan(markerValidation);
    expect(previousDetection).toBeGreaterThan(installedDetection);
    expect(pendingDetection).toBeGreaterThan(previousDetection);
    expect(guardCall).toBeGreaterThan(pendingDetection);
    expect(pendingPublish).toBeGreaterThan(guardCall);
    expect(stateDirectorySecured).toBeGreaterThan(pendingPublish);
    expect(pendingPublish).toBeLessThan(activeReleaseInspection);
    expect(stateDirectorySecured).toBeLessThan(activeReleaseInspection);
    expect(previousMarkerRemoved).toBeGreaterThan(finalDigestPublish);
    expect(compatibleGateReleased).toBeGreaterThan(previousMarkerRemoved);
  });

  it("publishes every managed host leaf without following links", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const hostVerification = readFileSync(
      new URL("../../ops/verify-host-contracts.sh", import.meta.url),
      "utf8",
    );
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const primitiveStart = bootstrap.indexOf("publish_managed_file() {");
    const primitiveEnd = bootstrap.indexOf("\npublish_managed_content() {", primitiveStart);
    const primitive = bootstrap.slice(primitiveStart, primitiveEnd);

    expect(primitiveStart).toBeGreaterThan(-1);
    expect(primitiveEnd).toBeGreaterThan(primitiveStart);
    expect(primitive).toContain("[[ -f ${source} && ! -L ${source} && ${target} == /* ]]");
    expect(primitive).toContain("[[ -f ${target} && ! -L ${target}");
    expect(primitive).toContain("stat --format '%h'");
    expect(bootstrap).toContain(
      'readonly MANAGED_FILE_STAGING_DIRECTORY="${HOST_STATE_DIRECTORY}/.managed-file-staging"',
    );
    expect(primitive).toContain(
      'ensure_managed_directory "$MANAGED_FILE_STAGING_DIRECTORY" root root 0700',
    );
    expect(primitive).toContain("stat --format '%d'");
    expect(primitive).toContain('mktemp "${staging_prefix}.XXXXXX"');
    expect(primitive).toContain('install -o root -g root -m 0600 "$source"');
    const stagedModePublished = primitive.indexOf('chmod "$mode" "$managed_file_staging"');
    const stagedOwnerPublished = primitive.indexOf(
      'chown "${owner}:${group}" "$managed_file_staging"',
    );
    expect(stagedModePublished).toBeGreaterThan(-1);
    expect(stagedOwnerPublished).toBeGreaterThan(-1);
    expect(stagedModePublished).toBeLessThan(stagedOwnerPublished);
    expect(primitive).toContain('${identity} == "root:root:${expected_mode}:1"');
    expect(primitive).toContain("mv --no-target-directory --force");
    expect(primitive).toContain('$(realpath -e -- "$parent") == "$parent"');

    for (const managedLeaf of [
      "/etc/fail2ban/jail.d/set-livre-sshd.local",
      "/etc/fstab",
      "/etc/letsencrypt/renewal-hooks/deploy/set-livre-reload-nginx",
      "/etc/nginx/sites-available/set-livre",
      "/etc/ssh/sshd_config.d/60-set-livre.conf",
      "/etc/sudoers.d/set-livre-deploy",
      "/etc/systemd/system/${systemd_unit}",
      "/usr/local/sbin/set-livre-deploy",
    ]) {
      expect(bootstrap).toContain(managedLeaf);
    }
    expect(bootstrap).not.toMatch(/cat\s*>\s*\/etc\//u);
    expect(bootstrap).not.toMatch(/>>\s*\/etc\/fstab/u);
    expect(bootstrap).toContain("ensure_fstab_swap_entry || fail");
    expect(bootstrap).toContain('publish_managed_file "$source" /etc/fstab root root 0644');
    expect(bootstrap).toContain("stale_suffix");
    expect(bootstrap).toContain("managed_file_staging");
    expect(hostVerification).toContain("symlink existente foi aceito como folha gerenciada");
    expect(hostVerification).toContain("dangling symlink foi aceito como folha gerenciada");
    expect(hostVerification).toContain("hardlink foi aceito como folha gerenciada");
    expect(hostVerification).toContain("arquivo especial foi aceito como folha gerenciada");
    expect(hostVerification).toContain("staging executável permaneceu após retry");
    expect(hostVerification).toContain(
      "staging intermediário root:root com modo final não foi recuperado",
    );
    expect(hostVerification).toContain("SIGKILL anterior à restrição não foi exercitado");
    expect(hostVerification).toContain("SIGKILL posterior à restrição não foi exercitado");
    expect(hostVerification).toContain(
      "ação nftables efetiva do Fail2ban não ficou pronta no laboratório",
    );
    expect(hostVerification).toContain("override local da ação nftables foi aceito no laboratório");
    expect(workflow).toContain("curl fail2ban nftables nginx openssh-server shellcheck");
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
      const logFormatStart = nginx.indexOf("log_format set_livre_redacted escape=json");
      const logFormatEnd = nginx.indexOf(";\n", logFormatStart);
      const logFormat = nginx.slice(logFormatStart, logFormatEnd);
      const serverCount = nginx.match(/^server \{/gmu)?.length ?? 0;
      expect(logFormatStart).toBeGreaterThan(-1);
      expect(logFormatEnd).toBeGreaterThan(logFormatStart);
      expect(nginx).toContain("map $request_id $set_livre_request_id");
      expect(logFormat).toContain("$set_livre_request_id");
      expect(logFormat).not.toContain("$sent_http_x_request_id");
      expect(logFormat).not.toMatch(
        /\$(?:args|binary_remote_addr|http_referer|http_user_agent|remote_addr|request_uri|uri)\b/u,
      );
      expect(
        nginx.match(/access_log \/var\/log\/nginx\/set-livre-access\.log set_livre_redacted;/gu),
      ).toHaveLength(serverCount);
      expect(nginx.match(/add_header X-Request-Id \$set_livre_request_id always;/gu)).toHaveLength(
        serverCount,
      );
      expect(nginx).toContain("error_log /var/log/nginx/set-livre-error.log crit;");
      expect(nginx).toContain("disable_symlinks on from=/var/www/set-livre-acme;");
      expect(nginx).toContain("error_log /dev/null crit;");
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
    expect(tls).toContain("limit_req_log_level info;");
    expect(tls).not.toContain("limit_req_log_level warn;");
    expect(tls).toContain("limit_req_status 429;");
    expect(tls).toContain("Disallow: /");
    expect(tls).toContain("return 308 https://147.15.97.227$request_uri;");
    expect(tls).toContain("listen 443 ssl default_server;");
    expect(tls).not.toContain("ssl_reject_handshake");
    expect(tls).toContain("proxy_set_header X-Request-Id $set_livre_request_id;");
    expect(tls).toContain("proxy_hide_header X-Request-Id;");
    expect(tls).not.toContain("proxy_set_header X-Request-Id $http_x_request_id;");
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
    expect(hostVerification).toContain("rate limiter não retornou 429 no laboratório");
    expect(hostVerification).toContain("error log expôs diagnóstico do request limitado");
    expect(hostVerification).toContain(
      "Nginx não recusou o arquivo symlink dentro do webroot ACME",
    );
    expect(hostVerification).toContain(
      "http://147.15.97.227/.well-known/acme-challenge/regular-probe",
    );
    expect(hostVerification).toContain(
      "http://147.15.97.227/.well-known/acme-challenge/symlink-probe",
    );
    expect(hostVerification).toContain(
      "error log persistiu diagnóstico bruto da falha de upstream",
    );
  });

  it("validates canonical host identities before publishing the deploy key", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const deployAccountStart = bootstrap.indexOf("if ! getent passwd deploy-setlivre");
    const deployIdentityValidation = bootstrap.indexOf(
      "deploy-setlivre deploy-setlivre /home/deploy-setlivre /bin/bash",
      deployAccountStart,
    );
    const deployGroupValidation = bootstrap.indexOf(
      "account_groups_are_exact deploy-setlivre deploy-setlivre",
      deployAccountStart,
    );
    const deployReverseGroupValidation = bootstrap.indexOf(
      "group_members_are_exact deploy-setlivre deploy-setlivre",
      deployAccountStart,
    );
    const deployPasswordValidation = bootstrap.indexOf(
      "account_password_is_locked deploy-setlivre",
      deployAccountStart,
    );
    const keyPublication = bootstrap.indexOf(
      'authorized_keys_source" /home/deploy-setlivre/.ssh/authorized_keys',
      deployAccountStart,
    );

    expect(bootstrap).toContain("account_identity_is_canonical() {");
    expect(bootstrap).toContain("account_groups_are_exact() {");
    expect(bootstrap).toContain("group_members_are_exact() {");
    expect(bootstrap).toContain("account_password_is_locked() {");
    expect(bootstrap).toContain("ensure_managed_directory() {");
    expect(bootstrap).toContain("os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW");
    expect(bootstrap).toContain('directory_fd = os.open("/", flags)');
    expect(bootstrap).toContain("for index, component in enumerate(components):");
    expect(bootstrap).toContain(
      "group_members_are_exact setlivre setlivre-web setlivre-backoffice",
    );
    expect(bootstrap).toContain('group_members_are_exact "$service_identity" "$service_identity"');
    expect(bootstrap).toContain(
      "ensure_managed_directory /home/deploy-setlivre root deploy-setlivre 0750",
    );
    expect(bootstrap).toContain(
      "ensure_managed_directory /home/deploy-setlivre/.ssh root deploy-setlivre 0750",
    );
    expect(bootstrap).toContain(
      "ensure_managed_directory /home/deploy-setlivre/incoming deploy-setlivre deploy-setlivre 0700",
    );
    expect(bootstrap).toContain("ensure_managed_directory /opt/set-livre root setlivre 0750");
    expect(bootstrap).toContain(
      "ensure_managed_directory /opt/set-livre/releases root setlivre 0750",
    );
    expect(bootstrap).toContain("/var/www/set-livre-acme/.well-known/acme-challenge; do");
    expect(bootstrap).toContain('ensure_managed_directory "$acme_directory" root root 0755');
    expect(bootstrap).not.toContain(
      "install -d -o root -g root -m 0755 /var/www/set-livre-acme/.well-known/acme-challenge",
    );
    expect(bootstrap).toContain(
      '"$authorized_keys_source" /home/deploy-setlivre/.ssh/authorized_keys',
    );
    expect(bootstrap).toContain("root deploy-setlivre 0640");
    expect(bootstrap).not.toContain(
      "install -d -o deploy-setlivre -g deploy-setlivre -m 0700 /home/deploy-setlivre/.ssh",
    );
    expect(bootstrap).toContain("identidade ${service_identity} divergiu do contrato canônico");
    expect(deployIdentityValidation).toBeGreaterThan(deployAccountStart);
    expect(deployGroupValidation).toBeGreaterThan(deployAccountStart);
    expect(deployReverseGroupValidation).toBeGreaterThan(deployAccountStart);
    expect(deployPasswordValidation).toBeGreaterThan(deployAccountStart);
    expect(keyPublication).toBeGreaterThan(deployIdentityValidation);
    expect(keyPublication).toBeGreaterThan(deployGroupValidation);
    expect(keyPublication).toBeGreaterThan(deployReverseGroupValidation);
    expect(keyPublication).toBeGreaterThan(deployPasswordValidation);
  });

  it("derives integrity from the complete installed release tree before SHA reuse", () => {
    const deploy = readFileSync(new URL("../../ops/deploy-release.sh", import.meta.url), "utf8");
    const hostVerification = readFileSync(
      new URL("../../ops/verify-host-contracts.sh", import.meta.url),
      "utf8",
    );
    const existingReleaseBranch = deploy.indexOf("if [[ -e ${release_directory} ]]");
    const installedDigest = deploy.indexOf(
      'installed_tree_digest="$(release_tree_digest "$release_directory")"',
      existingReleaseBranch,
    );
    const stagingDiscard = deploy.indexOf('rm -rf -- "$staging_directory"', existingReleaseBranch);

    expect(deploy).toContain("release_tree_digest() {");
    expect(deploy).toContain("--sort=name");
    expect(deploy).toContain("--mtime='@0'");
    expect(deploy).toContain("--numeric-owner");
    expect(deploy).toContain("SHA já existe com árvore instalada divergente");
    expect(installedDigest).toBeGreaterThan(existingReleaseBranch);
    expect(stagingDiscard).toBeGreaterThan(installedDigest);
    expect(hostVerification).toContain(
      "release existente adulterada foi reutilizada pelo mesmo SHA",
    );
  });

  it("accepts current only when it resolves to an exact SHA release root", () => {
    const deploy = readFileSync(new URL("../../ops/deploy-release.sh", import.meta.url), "utf8");
    const hostVerification = readFileSync(
      new URL("../../ops/verify-host-contracts.sh", import.meta.url),
      "utf8",
    );

    expect(deploy).toContain("[[ ${previous_release} =~ ^${RELEASES_DIRECTORY}/[0-9a-f]{40}$");
    expect(hostVerification).toContain("current aninhado foi aceito como raiz de release anterior");
    expect(hostVerification).toContain("current aninhado publicou marcador de rollback inválido");
  });

  it("clears a dangling current link before validating an active release", () => {
    const bootstrap = readFileSync(new URL("../../ops/bootstrap-host.sh", import.meta.url), "utf8");
    const gatePublish = bootstrap.indexOf(
      'publish_bootstrap_in_progress "$host_configuration_digest"',
    );
    const stopInvocation = bootstrap.indexOf("\nstop_application_services \\", gatePublish);
    const cleanupDeclaration = bootstrap.indexOf("clear_dangling_current_link() {");
    const cleanupInvocation = bootstrap.indexOf(
      "\nclear_dangling_current_link\n",
      cleanupDeclaration + 1,
    );
    const activeReleaseValidation = bootstrap.indexOf(
      "if [[ -e /opt/set-livre/current || -L /opt/set-livre/current ]]; then",
      cleanupInvocation,
    );

    expect(bootstrap).toContain("clear_dangling_current_link() {");
    expect(bootstrap).toContain("if [[ -L ${current_link} && ! -e ${current_link} ]]; then");
    expect(bootstrap).toContain('rm -f -- "$current_link"');
    expect(cleanupDeclaration).toBeGreaterThan(-1);
    expect(stopInvocation).toBeGreaterThan(gatePublish);
    expect(stopInvocation).toBeLessThan(cleanupInvocation);
    expect(cleanupInvocation).toBeGreaterThan(cleanupDeclaration);
    expect(activeReleaseValidation).toBeGreaterThan(cleanupInvocation);
    expect(activeReleaseValidation).toBeLessThan(bootstrap.indexOf("\napt-get update\n"));
    expect(bootstrap).toContain('systemctl show --property=LoadState --value "$service"');
    expect(bootstrap).toContain('if [[ ${load_state} != "not-found" ]]; then');
    expect(bootstrap).toContain('systemctl stop "$service"');
    expect(bootstrap).toContain('! systemctl is-active --quiet "$service"');
    expect(bootstrap).toContain("if [[ ${bootstrap_gate_published} == true ]]; then");
    expect(
      bootstrap.match(
        /if \[\[ -e \/opt\/set-livre\/current \|\| -L \/opt\/set-livre\/current \]\]; then/gu,
      ),
    ).toHaveLength(2);
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
    const deployLock = readFileSync(new URL("../../ops/deploy-lock.py", import.meta.url), "utf8");

    expect(bootstrap).toContain('restrict,command="/usr/local/sbin/set-livre-deploy-ssh"');
    expect(bootstrap).toContain("base64.b64decode(match.group(1), validate=True)");
    expect(bootstrap).toContain('algorithm != b"ssh-ed25519"');
    expect(bootstrap).toContain("len(public_key) != 32");
    expect(bootstrap).toContain("offset != len(blob)");
    expect(bootstrap).toContain(
      'readonly HOST_CONFIGURATION_DIGEST="${HOST_STATE_DIRECTORY}/host-config.sha256"',
    );
    for (const path of hostConfigurationFiles) {
      expect(bootstrap).toContain(path.slice("ops/".length));
    }
    expect(deployLock).toContain("os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | no_follow");
    expect(deployLock).toContain("os.fstat(file_descriptor)");
    expect(deployLock).toContain("os.lstat(LOCK_PATH)");
    expect(deployLock).toContain("descriptor.st_nlink != 1");
    expect(deploy).not.toContain("exec 9>/run/lock/set-livre-deploy.lock");
    expect(hostVerification).toContain("entrypoint protegido seguiu o symlink do lock de deploy");
    expect(bootstrap.indexOf("systemctl enable --now snap.certbot.renew.timer")).toBeLessThan(
      bootstrap.indexOf(
        'mv --no-target-directory --force -- "$digest_source" "$HOST_CONFIGURATION_DIGEST"',
      ),
    );
    expect(command).toContain("SSH_ORIGINAL_COMMAND");
    expect(command).toContain('if [[ ${original_command} == "preflight" ]]');
    expect(command).toContain("set-livre-deploy-ready-v1");
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
    expect(deployBranch.indexOf("flock --unlock 9")).toBeLessThan(
      deployBranch.indexOf("exec 9>&-"),
    );
    expect(deployBranch.indexOf("exec 9>&-")).toBeLessThan(
      deployBranch.indexOf("exec sudo /usr/local/sbin/set-livre-deploy"),
    );
    expect(hostVerification).toContain(
      'SSH_ORIGINAL_COMMAND="deploy ${candidate_sha} ${candidate_checksum}"',
    );
    expect(hostVerification).toContain("SSH_ORIGINAL_COMMAND=preflight");
    expect(hostVerification).toContain(
      'env_keep += "SET_LIVRE_TEST_CANDIDATE SET_LIVRE_TEST_PHASE SET_LIVRE_TEST_STATE"',
    );
    expect(hostVerification).toContain(
      'invoke_candidate_through_forced_command "$release_sha" "$candidate_checksum"',
    );
    expect(hostVerification).toContain("rollback-public-health-observed");
    expect(hostVerification).toContain("archive com mais de 20.000 entradas foi aceito");
    expect(hostVerification).toContain("archive com metadata PAX excessiva foi aceito");
    expect(hostVerification.match(/tar --hard-dereference/gu)).toHaveLength(2);
    expect(hostVerification.match(/--sort=name/gu)).toHaveLength(2);
    expect(hostVerification.match(/--mtime='@0'/gu)).toHaveLength(2);
    expect(hostVerification.match(/gzip --best --no-name/gu)).toHaveLength(2);
    expect(workflow).toContain("LC_ALL=C tar --hard-dereference");
    const publishableFixtures = [
      ...workflow.matchAll(/NEXT_PUBLIC_SUPABASE_ANON_KEY: (sb_publishable_[A-Za-z0-9_-]+)/gu),
      ...hostVerification.matchAll(
        /NEXT_PUBLIC_SUPABASE_ANON_KEY=(sb_publishable_[A-Za-z0-9_-]+)/gu,
      ),
    ].map((match) => match[1]);
    expect(publishableFixtures).toHaveLength(4);
    for (const publishableFixture of publishableFixtures) {
      expect(publishableFixture).toMatch(/^sb_publishable_[A-Za-z0-9_-]{12,}$/u);
    }
    expect(deploy).toContain("readiness HTTPS público");
    expect(deploy).toContain("managed_release_directories_are_valid() {");
    expect(deploy).toContain("os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW");
    expect(deploy).toContain('readonly UPLOAD_LOCK="${INCOMING_DIRECTORY}/.incoming.lock"');
    expect(deploy).toContain('exec 8<>"$UPLOAD_LOCK"');
    expect(deploy).toContain('flock --exclusive --timeout "$UPLOAD_LOCK_TIMEOUT_SECONDS" 8');
    expect(deploy.indexOf('exec 8<>"$UPLOAD_LOCK"')).toBeLessThan(
      deploy.indexOf('trusted_archive="$(trust_incoming_file'),
    );
    expect(deploy).not.toContain('install -d -o root -g setlivre -m 0750 "$RELEASES_DIRECTORY"');
    expect(hostVerification).toContain("verify_privileged_installer_upload_lock");
    expect(hostVerification).toContain("upload concorrente alterou inputs");
    expect(hostVerification).toContain("assert_symlinked_release_component_rejected root");
    expect(hostVerification).toContain("assert_symlinked_release_component_rejected releases");
    expect(deploy).toContain("RETAINED_RELEASES=4");
    expect(deploy).toContain("hostConfiguration.sha256");
    expect(deploy).toContain(".runtime/web.env");
    expect(deploy).toContain("write_rollback_marker");
    expect(deploy).toContain("recover_link_from_marker");
    expect(deploy).not.toContain("--recover-link");
    expect(deploy).toContain("--recover-services");
    expect(deploy).toContain(
      'readonly HOST_BOOTSTRAP_IN_PROGRESS="/etc/set-livre/bootstrap-in-progress.sha256"',
    );
    expect(deploy).toContain(
      'readonly HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS="/etc/set-livre/bootstrap-recovery-in-progress.sha256"',
    );
    expect(deploy).toContain("o bootstrap do host ainda não atingiu estado terminal");
    const recoveryFunctionStart = deploy.indexOf("recover_link_from_marker() {");
    const recoveryFunctionEnd = deploy.indexOf(
      "\nwrite_rollback_marker() {",
      recoveryFunctionStart,
    );
    expect(deploy.slice(recoveryFunctionStart, recoveryFunctionEnd)).not.toContain(
      'rm -f -- "$ROLLBACK_MARKER"',
    );
    const serviceRecoveryStart = deploy.indexOf(
      'if [[ $# -eq 1 && ${1:-} == "--recover-services" ]]',
    );
    const serviceRecoveryEnd = deploy.indexOf("\nverify_only=false", serviceRecoveryStart);
    const serviceRecovery = deploy.slice(serviceRecoveryStart, serviceRecoveryEnd);
    expect(serviceRecovery.indexOf('wait_for_public_health "$recovered_release"')).toBeLessThan(
      serviceRecovery.indexOf('rm -f -- "$ROLLBACK_MARKER"'),
    );
    expect(deploy).toContain('lock_policy="timeout=${RECOVERY_LOCK_TIMEOUT_SECONDS}"');
    expect(serviceRecovery).not.toContain("set-livre-deploy.lock");
    expect(hostVerification).toContain("recuperação falha consumiu o marcador necessário ao retry");
    expect(hostVerification.match(/recover_services_successfully "\$release_sha"/gu)).toHaveLength(
      6,
    );
    expect(deploy).toContain("remove_stale_staging_directories");
    expect(deploy).toContain("remove_stale_trusted_files");
    expect(deploy).not.toContain("bundle.getmembers()");
    expect(deploy).toContain("for entry_count, member in enumerate(bundle, start=1):");
    expect(deploy).toContain("if entry_count > maximum_entries:");
    expect(deploy).toContain("def validate_tar_headers(path):");
    expect(deploy).toContain("if raw_member.size > maximum_extended_header_bytes:");
    expect(deploy).toContain('raise ValueError("metadata estendida excede o limite")');
    expect(deploy).toContain("^\\.staging-[0-9a-f]{40}\\.[A-Za-z0-9]{6}$");
    expect(deploy).toContain("trap 'on_signal TERM 143' TERM");
    const rollbackStart = deploy.indexOf("rollback_activation() {");
    const rollbackEnd = deploy.indexOf("\non_exit() {", rollbackStart);
    const rollback = deploy.slice(rollbackStart, rollbackEnd);
    expect(rollback).toContain('wait_for_health "$recovered_release"');
    expect(rollback).toContain('wait_for_public_health "$recovered_release"');
    expect(rollback.indexOf('wait_for_public_health "$recovered_release"')).toBeLessThan(
      rollback.lastIndexOf('rm -f -- "$ROLLBACK_MARKER"'),
    );
    expect(deploy.match(/wait_for_public_health "\$recovered_release"/gu)).toHaveLength(3);
    expect(deploy).toContain('re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{12,}", publishable_key)');
    expect(bootstrap).toContain('active_host_digest} == "$host_configuration_digest"');
    expect(bootstrap).toContain('wait_for_active_health "$active_release_sha"');
    expect(bootstrap).toContain('wait_for_active_public_health "$active_release_sha"');
    const bootstrapCleanup = bootstrap.slice(
      bootstrap.indexOf("cleanup() {"),
      bootstrap.indexOf("\ntrap cleanup EXIT"),
    );
    expect(bootstrapCleanup.indexOf("stop_application_services")).toBeLessThan(
      bootstrapCleanup.indexOf('rm -f -- "$HOST_CONFIGURATION_DIGEST"'),
    );
    expect(bootstrapCleanup).toContain("HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS");
    expect(bootstrapCleanup.indexOf('rm -f -- "$ROLLBACK_MARKER"')).toBeLessThan(
      bootstrapCleanup.indexOf('rm -f -- "$HOST_CONFIGURATION_DIGEST"'),
    );
    expect(bootstrap).not.toContain("bootstrap_recovery_armed");
    expect(bootstrap).toContain("[[ ! -e ${ROLLBACK_MARKER} && ! -L ${ROLLBACK_MARKER} ]]");
    expect(
      deploy.match(/if \[\[ -e \$\{ROLLBACK_MARKER\} \|\| -L \$\{ROLLBACK_MARKER\} \]\]; then/gu),
    ).toHaveLength(2);
    const bootstrapDigestPublished = bootstrap.indexOf(
      'mv --no-target-directory --force -- "$digest_source" "$HOST_CONFIGURATION_DIGEST"',
    );
    const recoveryArmed = bootstrap.indexOf(
      'write_bootstrap_recovery_marker "/opt/set-livre/releases/${active_release_sha}"',
    );
    const recoveryPhaseArmed = bootstrap.indexOf(
      'publish_bootstrap_recovery_in_progress "$host_configuration_digest"',
      recoveryArmed,
    );
    const previousDigestRemoved = bootstrap.indexOf(
      'rm -f -- "$HOST_CONFIGURATION_PREVIOUS_DIGEST"',
      recoveryPhaseArmed,
    );
    const bootstrapGateReleased = bootstrap.indexOf(
      'rm -f -- "$HOST_BOOTSTRAP_IN_PROGRESS"',
      previousDigestRemoved,
    );
    const bootstrapRestart = bootstrap.indexOf("systemctl restart set-livre-web.service");
    const bootstrapReadiness = bootstrap.indexOf(
      'wait_for_active_public_health "$active_release_sha"',
      bootstrapRestart,
    );
    const terminalGateCommitted = bootstrap.indexOf(
      "bootstrap_gate_published=false",
      bootstrapReadiness,
    );
    const terminalBootstrap = bootstrap.indexOf(
      "host_configuration_published=false",
      terminalGateCommitted,
    );
    const recoveryPhaseDisarmed = bootstrap.indexOf(
      'rm -f -- "$HOST_BOOTSTRAP_RECOVERY_IN_PROGRESS"',
      terminalBootstrap,
    );
    const recoveryDisarmed = bootstrap.indexOf(
      'rm -f -- "$ROLLBACK_MARKER"',
      recoveryPhaseDisarmed,
    );
    const emptyHostGateReleased = bootstrap.indexOf(
      'rm -f -- "$HOST_BOOTSTRAP_IN_PROGRESS"',
      recoveryDisarmed,
    );
    for (const position of [
      bootstrapDigestPublished,
      recoveryArmed,
      recoveryPhaseArmed,
      previousDigestRemoved,
      bootstrapGateReleased,
      bootstrapRestart,
      bootstrapReadiness,
      terminalGateCommitted,
      terminalBootstrap,
      recoveryPhaseDisarmed,
      recoveryDisarmed,
      emptyHostGateReleased,
    ]) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(bootstrapDigestPublished).toBeLessThan(bootstrapRestart);
    expect(bootstrapDigestPublished).toBeLessThan(recoveryArmed);
    expect(recoveryArmed).toBeLessThan(recoveryPhaseArmed);
    expect(recoveryPhaseArmed).toBeLessThan(previousDigestRemoved);
    expect(previousDigestRemoved).toBeLessThan(bootstrapGateReleased);
    expect(bootstrapGateReleased).toBeLessThan(bootstrapRestart);
    expect(bootstrapRestart).toBeLessThan(bootstrapReadiness);
    expect(bootstrapReadiness).toBeLessThan(terminalGateCommitted);
    expect(terminalGateCommitted).toBeLessThan(terminalBootstrap);
    expect(terminalBootstrap).toBeLessThan(recoveryPhaseDisarmed);
    expect(recoveryPhaseDisarmed).toBeLessThan(recoveryDisarmed);
    expect(recoveryDisarmed).toBeLessThan(emptyHostGateReleased);
    expect(bootstrapCleanup).toContain(
      "if [[ ${bootstrap_gate_published} == true ]]; then\n    stop_application_services",
    );
    expect(bootstrap.slice(previousDigestRemoved, bootstrapRestart)).toContain(
      "if [[ -n ${active_release_sha} && ${active_release_compatible} == true ]]; then",
    );
    expect(
      bootstrap.match(/publish_bootstrap_in_progress "\$host_configuration_digest"/gu),
    ).toHaveLength(4);
    expect(bootstrap).toContain(
      'fail "release compatível não recuperou readiness; reenvie uma release aprovada."',
    );
    expect(hostVerification).toContain("recovery-public-health-observed");
    expect(hostVerification.indexOf('retention_sha="$(printf')).toBeLessThan(
      hostVerification.indexOf('recovery_public_sha="$(printf'),
    );
    expect(hostVerification.indexOf('rollback_source="$temporary_directory')).toBeLessThan(
      hostVerification.indexOf('recovery_public_sha="$(printf'),
    );
    expect(bootstrap.indexOf('active_host_digest} == "$host_configuration_digest"')).toBeLessThan(
      bootstrap.indexOf("apt-get update"),
    );
    expect(bootstrap.indexOf('rm -f -- "$HOST_CONFIGURATION_DIGEST"')).toBeLessThan(
      bootstrap.indexOf("apt-get update"),
    );
    expect(bootstrap).toContain(
      "if [[ -n ${active_release_sha} && ${active_release_compatible} == false ]]; then",
    );
    expect(bootstrap).toContain("rm -f -- /opt/set-livre/current");
    expect(bootstrap).toContain("host_configuration_published=true");
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

  it("allows a manual CI retry without authorizing a manual production deploy", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const deployJob = workflow.slice(workflow.indexOf("  deploy:"));

    expect(workflow).toContain("  workflow_dispatch:\n");
    expect(deployJob).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.PRD_DEPLOY_ENABLED == 'true'",
    );
    expect(deployJob).not.toContain("github.event_name == 'workflow_dispatch'");
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

  it("keeps the static guard against prohibited Playwright constructs", () => {
    const docsCheck = readFileSync(
      new URL("../../scripts/docs-check.mjs", import.meta.url),
      "utf8",
    );

    expect(docsCheck).toContain('walk(resolve(repositoryRoot, "tests/e2e"))');
    expect(docsCheck).toContain("pattern: /\\.only\\s*\\(/u");
    expect(docsCheck).toContain("pattern: /\\.skip\\s*\\(/u");
    expect(docsCheck).toContain("pattern: /waitForTimeout\\s*\\(/u");
    expect(docsCheck).toContain("for (const path of playwrightFiles)");
    for (const root of [
      ".github",
      "apps",
      "ops",
      "packages",
      "scripts",
      "src",
      "supabase",
      "tests",
    ]) {
      expect(docsCheck).toContain(`"${root}"`);
    }
    expect(docsCheck).toContain('".py"');
    expect(docsCheck).toContain('${"TO" + "DO"}|${"FIX" + "ME"}');
    expect(docsCheck).toContain("for (const path of implementationFiles)");
  });

  it("disables ambient curl configuration for every operational invocation", () => {
    const sources = [
      "../../.github/workflows/ci.yml",
      "../../ops/bootstrap-host.sh",
      "../../ops/deploy-release.sh",
      "../../ops/verify-host-contracts.sh",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

    for (const source of sources) {
      const invocations = source
        .split("\n")
        .filter((line) => /^\s*(?:(?:if|&&)\s+)?curl\s+--/u.test(line));
      expect(invocations.length).toBeGreaterThan(0);
      for (const invocation of invocations) {
        expect(invocation).toMatch(/\bcurl --disable\b/u);
      }
    }

    for (const path of ["../../ops/bootstrap-host.sh", "../../ops/deploy-release.sh"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const invocations = source
        .split("\n")
        .filter((line) => /^\s*(?:(?:if|&&)\s+)?curl\s+--/u.test(line));
      for (const invocation of invocations) {
        expect(invocation).toContain("--noproxy '*'");
      }
    }
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

  it("requires the dedicated loopback network and exact published Supabase ports", () => {
    expect(withSupabaseLocalNetwork(["test", "db", "--local"])).toEqual([
      "test",
      "db",
      "--local",
      "--network-id",
      supabaseLocalNetworkName,
    ]);
    assertLoopbackNetworkInspection([
      {
        Driver: "bridge",
        Internal: false,
        Name: supabaseLocalNetworkName,
        Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" },
        Scope: "local",
      },
    ]);
    const inspections = [
      ["kong", "54321"],
      ["db", "54322"],
      ["studio", "54323"],
      ["inbucket", "54324"],
    ].map(([name, port]) => ({
      Name: `supabase_${name}_set-livre`,
      NetworkSettings: {
        Networks: { [supabaseLocalNetworkName]: {} },
        Ports: { "service/tcp": [{ HostIp: "127.0.0.1", HostPort: port }] },
      },
    }));

    expect(() => assertLoopbackContainerInspections(inspections)).not.toThrow();
    inspections[0].NetworkSettings.Ports["service/tcp"][0].HostIp = "0.0.0.0";
    expect(() => assertLoopbackContainerInspections(inspections)).toThrow(
      "fora da fronteira local",
    );
    inspections[0].NetworkSettings.Ports["service/tcp"][0].HostIp = "127.0.0.1";
    inspections[0].NetworkSettings.Ports["service/tcp"].push({ HostIp: "::", HostPort: "54321" });
    expect(() => assertLoopbackContainerInspections(inspections)).toThrow(
      "fora da fronteira local",
    );
    expect(() =>
      assertLoopbackContainerInspections(inspections, { dockerDesktopLocalOnly: true }),
    ).not.toThrow();
  });

  it("accepts Docker Desktop IPv6 forwarding only under its native local-only policy", () => {
    expect(() =>
      validateDockerDesktopPortBindingPolicy({ PortBindingBehavior: "local-only-port-binding" }),
    ).not.toThrow();
    expect(() =>
      validateDockerDesktopPortBindingPolicy({ PortBindingBehavior: "default-port-binding" }),
    ).toThrow("Local only");
  });

  it("stops a running Supabase stack before propagating an unverifiable Docker policy", () => {
    const actions = [];

    expect(() =>
      assertDockerPolicyOrStopRunningStack({
        assertPolicy: () => {
          actions.push("validate-policy");
          throw new Error("política Docker ilegível");
        },
        isStackRunning: () => {
          actions.push("inspect-stack");
          return true;
        },
        stopStack: () => actions.push("stop-stack"),
      }),
    ).toThrow("política Docker ilegível");
    expect(actions).toEqual(["inspect-stack", "validate-policy", "stop-stack"]);
  });

  it("stops a running Supabase stack when status or binding validation fails", () => {
    const actions = [];
    expect(() =>
      assertLocalStatusOrStopRunningStack({
        assertBindings: () => {
          actions.push("validate-bindings");
          throw new Error("binding externo");
        },
        isStackRunning: () => {
          actions.push("inspect-stack");
          return true;
        },
        readStatus: () => {
          actions.push("read-status");
          return { API_URL: "http://127.0.0.1:54321" };
        },
        stopStack: () => actions.push("stop-stack"),
      }),
    ).toThrow("binding externo");
    expect(actions).toEqual(["read-status", "validate-bindings", "inspect-stack", "stop-stack"]);
  });

  it("accepts only the canonical local Docker contexts", () => {
    expect(
      validateLocalDockerContext({
        contextName: "desktop-linux",
        dockerContextOverride: undefined,
        dockerHostOverride: undefined,
        endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine",
        engineOperatingSystem: "linux",
        platform: "win32",
      }),
    ).toBe("npipe:////./pipe/dockerDesktopLinuxEngine");
    expect(
      validateLocalDockerContext({
        contextName: "default",
        dockerContextOverride: undefined,
        dockerHostOverride: undefined,
        endpoint: "unix:///var/run/docker.sock",
        engineOperatingSystem: "linux",
        platform: "linux",
      }),
    ).toBe("unix:///var/run/docker.sock");
  });

  it("rejects remote Docker selectors before a destructive local command", () => {
    const localContext = {
      contextName: "default",
      dockerContextOverride: undefined,
      dockerHostOverride: undefined,
      endpoint: "unix:///var/run/docker.sock",
      engineOperatingSystem: "linux",
      platform: "linux",
    };

    expect(() =>
      validateLocalDockerContext({
        ...localContext,
        dockerHostOverride: "ssh://operator@remote.example.com",
      }),
    ).toThrow("DOCKER_HOST e DOCKER_CONTEXT precisam estar ausentes");
    expect(() =>
      validateLocalDockerContext({
        ...localContext,
        dockerContextOverride: "remote-production",
      }),
    ).toThrow("DOCKER_HOST e DOCKER_CONTEXT precisam estar ausentes");
    expect(() =>
      validateLocalDockerContext({
        ...localContext,
        contextName: "remote-production",
        endpoint: "ssh://operator@remote.example.com",
      }),
    ).toThrow("daemon local permitido");
    expect(() =>
      validateLocalDockerContext({
        ...localContext,
        engineOperatingSystem: "windows",
      }),
    ).toThrow("containers Linux");
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

  it("pipes Supabase stderr and emits only its redacted structured failure", () => {
    let invocationOptions;
    let thrown;
    try {
      runSupabase(["test", "db", "--local"], {
        execute: (_command, _argumentsList, options) => {
          invocationOptions = options;
          return {
            status: 1,
            stderr:
              "raw postgresql://postgres:raw-secret@127.0.0.1/postgres\n" +
              '{"error":{"message":"failed at postgresql://postgres:raw-secret@127.0.0.1/postgres"}}\n',
            stdout: "",
          };
        },
        resolveLocalDockerEnvironment: () => ({ PATH: "trusted" }),
      });
    } catch (error) {
      thrown = String(error);
    }
    expect(invocationOptions?.stdio).toEqual(["ignore", "inherit", "pipe"]);
    expect(thrown).toContain("postgresql://[REDACTED]@127.0.0.1/postgres");
    expect(thrown).not.toContain("raw-secret");
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
