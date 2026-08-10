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
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertTrustedNpmPathShape,
  bundledNpmCliPath,
  resolveTrustedNpmCliLaunch,
} from "../../scripts/trusted-npm-cli.mjs";

const temporaryRoots = [];

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
  const nodeExecutable = resolve(installationRoot, "bin/node");
  const npmPackageRoot = resolve(installationRoot, "lib/node_modules/npm");
  const npmCliPath = resolve(npmPackageRoot, "bin/npm-cli.js");
  mkdirSync(repositoryRoot);
  mkdirSync(resolve(installationRoot, "bin"), { recursive: true });
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
  return { nodeExecutable, npmCliPath, repositoryRoot, root };
}

describe("trusted npm CLI launch", () => {
  it("resolves the physical pinned npm installation used by the current Node", () => {
    const launch = resolveTrustedNpmCliLaunch();
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
          `import { resolveTrustedNpmCliLaunch } from ${JSON.stringify(moduleUrl)}; const launch = resolveTrustedNpmCliLaunch(); process.stdout.write(JSON.stringify({ npmCliPath: launch.npmCliPath, npmVersion: launch.npmVersion }));`,
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
        nodeExecutable: mismatchedVersion.nodeExecutable,
        repositoryRoot: mismatchedVersion.repositoryRoot,
      }),
    ).toThrow("versão npm fixada");

    expect(() =>
      resolveTrustedNpmCliLaunch({
        nodeExecutable: fixture.nodeExecutable,
        nodeVersion: "24.17.0",
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).toThrow("versão fixada");

    const outsidePackage = fakeInstallation();
    writeFileSync(
      resolve(outsidePackage.root, "runtime/lib/node_modules/npm/package.json"),
      `${JSON.stringify({ bin: { npm: "../outside/npm-cli.js" }, name: "npm", version: "11.19.0" })}\n`,
    );
    expect(() =>
      resolveTrustedNpmCliLaunch({
        nodeExecutable: outsidePackage.nodeExecutable,
        repositoryRoot: outsidePackage.repositoryRoot,
      }),
    ).toThrow("versão npm fixada");
  });

  it("rejects symbolic or world-writable npm CLI paths before execution", () => {
    const symbolicFixture = fakeInstallation();
    const physicalCli = resolve(symbolicFixture.root, "physical-cli.js");
    writeFileSync(physicalCli, "outside");
    rmSync(symbolicFixture.npmCliPath);
    symlinkSync(physicalCli, symbolicFixture.npmCliPath);
    expect(() =>
      resolveTrustedNpmCliLaunch({
        nodeExecutable: symbolicFixture.nodeExecutable,
        repositoryRoot: symbolicFixture.repositoryRoot,
      }),
    ).toThrow("arquivo físico regular");

    const writableFixture = fakeInstallation();
    chmodSync(writableFixture.npmCliPath, 0o666);
    expect(() =>
      resolveTrustedNpmCliLaunch({
        nodeExecutable: writableFixture.nodeExecutable,
        repositoryRoot: writableFixture.repositoryRoot,
      }),
    ).toThrow("protegido");
  });
});
