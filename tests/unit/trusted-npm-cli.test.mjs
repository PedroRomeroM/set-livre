import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { fileSymbolicLinksSupported } from "../fixtures/filesystem-capabilities.mjs";

import {
  assertWindowsTrustedPathIntegrity,
  assertTrustedNpmPathShape,
  bundledNpmCliPath,
  createTrustedCliEnvironment,
  resolveTrustedNpmCliLaunch,
  resolveTrustedRepositoryCliLaunch,
} from "../../scripts/trusted-npm-cli.mjs";

const temporaryRoots = [];
const linkIt = fileSymbolicLinksSupported ? it : it.skip;
const posixPermissionIt = process.platform === "win32" ? it.skip : it;
const bypassWindowsIntegrity = () => {};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fakeInstallation({ npmVersion = "11.19.0", repositoryVersion = "11.19.0" } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-trusted-npm-"));
  temporaryRoots.push(root);
  const repositoryRoot = resolve(root, "repository");
  const installationRoot = resolve(root, "runtime");
  const nodeExecutable =
    process.platform === "win32"
      ? resolve(installationRoot, "node.exe")
      : resolve(installationRoot, "bin/node");
  const npmPackageRoot =
    process.platform === "win32"
      ? resolve(installationRoot, "node_modules/npm")
      : resolve(installationRoot, "lib/node_modules/npm");
  const npmCliPath = resolve(npmPackageRoot, "bin/npm-cli.js");
  mkdirSync(repositoryRoot);
  mkdirSync(dirname(nodeExecutable), { recursive: true });
  mkdirSync(resolve(npmPackageRoot, "bin"), { recursive: true });
  writeFileSync(
    resolve(repositoryRoot, "package.json"),
    `${JSON.stringify({ devEngines: { packageManager: { name: "npm", version: repositoryVersion }, runtime: { name: "node", version: process.versions.node } }, packageManager: `npm@${repositoryVersion}` })}\n`,
  );
  writeFileSync(nodeExecutable, "physical-node", { mode: 0o700 });
  writeFileSync(npmCliPath, "physical-npm-cli");
  writeFileSync(
    resolve(npmPackageRoot, "package.json"),
    `${JSON.stringify({ bin: { npm: "bin/npm-cli.js" }, name: "npm", version: npmVersion })}\n`,
  );
  return { nodeExecutable, npmCliPath, npmPackageRoot, repositoryRoot, root };
}

describe("trusted npm CLI launch", () => {
  it("resolves the physical pinned npm installation used by the current Node", () => {
    const launch = resolveTrustedNpmCliLaunch({
      assertWindowsIntegrity: bypassWindowsIntegrity,
    });
    const expectedCliPath = bundledNpmCliPath();

    expect(launch).toMatchObject({
      argumentPrefix: [expectedCliPath],
      command: process.execPath,
      npmCliPath: expectedCliPath,
    });
    expect(
      execFileSync(launch.command, [...launch.argumentPrefix, "--version"], {
        encoding: "utf8",
        env: process.env,
      }).trim(),
    ).toBe("11.19.0");
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    );
    expect(packageJson).not.toHaveProperty("scripts.dev:all");
    expect(packageJson).not.toHaveProperty("scripts.release:manifest");
    expect(packageJson).toHaveProperty("scripts.knip", "knip");
    for (const manifestPath of [
      "../../package.json",
      "../../apps/backoffice/package.json",
      "../../packages/contracts/package.json",
      "../../packages/ui/package.json",
    ]) {
      const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, manifestPath), "utf8"));
      expect(Object.values(manifest.scripts ?? {}).join("\n")).not.toMatch(
        /(?:E2E_DATABASE_URL|DATABASE_URL_APP_DAL|postgres(?:ql)?:\/\/)/u,
      );
    }

    const hostileHome = mkdtempSync(resolve(tmpdir(), "set-livre-hostile-npm-home-"));
    temporaryRoots.push(hostileHome);
    const sentinelPath = resolve(hostileHome, "loader-ran");
    const loaderPath = resolve(hostileHome, "loader.cjs");
    writeFileSync(
      loaderPath,
      `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "executed");\n`,
    );
    writeFileSync(resolve(hostileHome, ".npmrc"), `node-options=--require=${loaderPath}\n`);
    const moduleUrl = pathToFileURL(
      resolve(import.meta.dirname, "../../scripts/trusted-npm-cli.mjs"),
    ).href;
    const directResult = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { resolveTrustedNpmCliLaunch } from ${JSON.stringify(moduleUrl)}; const launch = resolveTrustedNpmCliLaunch({ assertWindowsIntegrity: () => {} }); process.stdout.write(JSON.stringify({ npmCliPath: launch.npmCliPath, npmVersion: launch.npmVersion }));`,
        ],
        {
          encoding: "utf8",
          env: {
            HOME: hostileHome,
            NPM_CONFIG_USERCONFIG: resolve(hostileHome, ".npmrc"),
            npm_execpath: resolve(hostileHome, "fake/npm-cli.js"),
            npm_node_execpath: resolve(hostileHome, "fake/node"),
          },
        },
      ),
    );
    expect(directResult).toEqual({ npmCliPath: expectedCliPath, npmVersion: "11.19.0" });
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("models the Windows Node plus npm-cli.js contract without npm.cmd or a shell", () => {
    expect(bundledNpmCliPath("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    );
    expect(() =>
      assertTrustedNpmPathShape({
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        npmCliPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        platform: "win32",
      }),
    ).not.toThrow();
    for (const contract of [
      {
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        npmCliPath: "C:\\Program Files\\nodejs\\npm.cmd",
      },
      {
        nodeExecutable: "node.exe",
        npmCliPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      },
    ]) {
      expect(() => assertTrustedNpmPathShape({ ...contract, platform: "win32" })).toThrow();
    }
  });

  it("accepts only the matching physical npm package beside the selected Node", () => {
    const fixture = fakeInstallation();
    expect(
      resolveTrustedNpmCliLaunch({
        assertWindowsIntegrity: bypassWindowsIntegrity,
        nodeExecutable: fixture.nodeExecutable,
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).toMatchObject({
      argumentPrefix: [fixture.npmCliPath],
      command: fixture.nodeExecutable,
    });

    const mismatchedVersion = fakeInstallation({ npmVersion: "11.18.0" });
    expect(() =>
      resolveTrustedNpmCliLaunch({
        assertWindowsIntegrity: bypassWindowsIntegrity,
        nodeExecutable: mismatchedVersion.nodeExecutable,
        repositoryRoot: mismatchedVersion.repositoryRoot,
      }),
    ).toThrow("versão npm fixada");

    expect(() =>
      resolveTrustedNpmCliLaunch({
        assertWindowsIntegrity: bypassWindowsIntegrity,
        nodeExecutable: fixture.nodeExecutable,
        nodeVersion: "24.17.0",
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).toThrow("versão fixada");

    const outsidePackage = fakeInstallation();
    writeFileSync(
      resolve(outsidePackage.npmPackageRoot, "package.json"),
      `${JSON.stringify({ bin: { npm: "../outside/npm-cli.js" }, name: "npm", version: "11.19.0" })}\n`,
    );
    expect(() =>
      resolveTrustedNpmCliLaunch({
        assertWindowsIntegrity: bypassWindowsIntegrity,
        nodeExecutable: outsidePackage.nodeExecutable,
        repositoryRoot: outsidePackage.repositoryRoot,
      }),
    ).toThrow("versão npm fixada");
  });

  linkIt("rejects a symbolic npm CLI path before execution", () => {
    const symbolicFixture = fakeInstallation();
    const physicalCli = resolve(symbolicFixture.root, "physical-cli.js");
    writeFileSync(physicalCli, "outside");
    rmSync(symbolicFixture.npmCliPath);
    symlinkSync(physicalCli, symbolicFixture.npmCliPath);
    expect(() =>
      resolveTrustedNpmCliLaunch({
        assertWindowsIntegrity: bypassWindowsIntegrity,
        nodeExecutable: symbolicFixture.nodeExecutable,
        repositoryRoot: symbolicFixture.repositoryRoot,
      }),
    ).toThrow("arquivo físico regular");
  });

  posixPermissionIt("rejects a world-writable npm CLI path before execution", () => {
    const writableFixture = fakeInstallation();
    chmodSync(writableFixture.npmCliPath, 0o666);
    expect(() =>
      resolveTrustedNpmCliLaunch({
        assertWindowsIntegrity: bypassWindowsIntegrity,
        nodeExecutable: writableFixture.nodeExecutable,
        repositoryRoot: writableFixture.repositoryRoot,
      }),
    ).toThrow("protegido");
  });

  it("rebuilds a Windows CLI environment from a case-insensitive allowlist", () => {
    const inherited = {
      ComSpec: "C:\\attacker\\cmd.exe",
      DOCKER_HOST: "npipe:////./pipe/dockerDesktopLinuxEngine",
      nOdE_oPtIoNs: "--require=C:\\attacker\\loader.cjs",
      Path: "C:\\Program Files\\nodejs;;C:\\Windows\\System32",
      supabase_cli_binary_override: "C:\\attacker\\supabase.exe",
      UNKNOWN_SECRET: "must-not-cross",
    };

    expect(
      createTrustedCliEnvironment(inherited, {
        additionalWindowsNames: ["DOCKER_HOST"],
        platform: "win32",
      }),
    ).toEqual({
      DOCKER_HOST: "npipe:////./pipe/dockerDesktopLinuxEngine",
      PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
    });
    expect(inherited.nOdE_oPtIoNs).toContain("loader.cjs");
    expect(() =>
      createTrustedCliEnvironment(
        { PATH: "C:\\trusted", Path: "C:\\hostile" },
        { platform: "win32" },
      ),
    ).toThrow("variantes conflitantes de PATH");
  });

  it("uses only the physical absolute Windows PowerShell for read-only DACL inspection", () => {
    let invocation;
    const physicalFile = {
      isFile: () => true,
      isSymbolicLink: () => false,
    };

    expect(() =>
      assertWindowsTrustedPathIntegrity("C:\\repository\\node_modules\\tool\\cli.js", {
        execute: (command, argumentsList, options) => {
          invocation = { argumentsList, command, options };
          return { signal: null, status: 0, stdout: "ok" };
        },
        inspectPath: () => physicalFile,
        systemRoot: "C:\\Windows",
        trustedRoot: "C:\\repository",
      }),
    ).not.toThrow();

    expect(invocation.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(invocation.argumentsList).toContain("-EncodedCommand");
    expect(invocation.argumentsList).not.toContain("-ExecutionPolicy");
    expect(invocation.argumentsList).not.toContain("Bypass");
    expect(invocation.options).toMatchObject({
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      shell: false,
      windowsHide: true,
    });
    expect(JSON.parse(invocation.options.input)).toEqual({
      path: "C:\\repository\\node_modules\\tool\\cli.js",
      trustedRoot: "C:\\repository",
    });
    expect(String(invocation.options.input)).not.toContain("attacker");
    expect(() =>
      assertWindowsTrustedPathIntegrity("C:\\repository\\node_modules\\tool\\cli.js", {
        execute: () => ({ signal: null, status: 1, stdout: "" }),
        inspectPath: () => physicalFile,
        systemRoot: "C:\\Windows",
        trustedRoot: "C:\\repository",
      }),
    ).toThrow("integridade DACL");
  });

  it("validates repository-local CLIs against their exact pinned package", () => {
    expect(
      resolveTrustedRepositoryCliLaunch({
        assertWindowsIntegrity: bypassWindowsIntegrity,
        cliRelativePath: "dist/supabase.js",
        dependencyName: "supabase",
      }),
    ).toMatchObject({
      command: process.execPath,
      version: "2.113.0",
    });
  });
});
