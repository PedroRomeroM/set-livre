import {
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

import { afterEach, describe, expect, it } from "vitest";

import { resolveTrustedNextCliLaunch } from "../../scripts/local-development-server.mjs";
import { removeNextBuildCache as removeNextBuildCacheNative } from "../../scripts/remove-next-build-cache.mjs";
import { runNextBuildWithCacheCleanup as runNextBuildWithCacheCleanupNative } from "../../scripts/next-build.mjs";

const temporaryRoots = [];
const assertLogicalWindowsPath = () => undefined;

function removeNextBuildCache(options = {}) {
  return removeNextBuildCacheNative({
    ...options,
    filesystemSecurityOptions: { assertWindowsPath: assertLogicalWindowsPath },
  });
}

function runNextBuildWithCacheCleanup(options = {}) {
  return runNextBuildWithCacheCleanupNative({
    ...options,
    removeCache: options.removeCache ?? removeNextBuildCache,
  });
}

function resolveFixtureNextLaunch({ repositoryRoot }) {
  const nextCliPath = resolve(repositoryRoot, "node_modules/next/dist/bin/next");
  return {
    argumentPrefix: [nextCliPath],
    command: process.execPath,
    nextCliPath,
    nextVersion: "16.3.0",
  };
}

function resolveFixtureTrustedNextLaunch(options) {
  return resolveTrustedNextCliLaunch({
    ...options,
    assertWindowsIntegrity: assertLogicalWindowsPath,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function createRepositoryFixture() {
  const repositoryRoot = mkdtempSync(resolve(tmpdir(), "set-livre-next-cache-"));
  temporaryRoots.push(repositoryRoot);
  const applicationRoots = [repositoryRoot, resolve(repositoryRoot, "apps/backoffice")];

  for (const applicationRoot of applicationRoots) {
    mkdirSync(resolve(applicationRoot, ".next/cache/turbopack"), { recursive: true });
    mkdirSync(resolve(applicationRoot, ".next/standalone"), { recursive: true });
    mkdirSync(resolve(applicationRoot, ".next/static"), { recursive: true });
    writeFileSync(resolve(applicationRoot, ".next/cache/turbopack/private.bin"), "credential");
    writeFileSync(resolve(applicationRoot, ".next/standalone/server.js"), "standalone");
    writeFileSync(resolve(applicationRoot, ".next/static/build.css"), "static");
  }
  mkdirSync(resolve(repositoryRoot, "node_modules/next/dist/bin"), { recursive: true });
  writeFileSync(
    resolve(repositoryRoot, "package.json"),
    JSON.stringify({
      dependencies: { next: "16.3.0" },
      devEngines: {
        packageManager: { name: "npm", version: "11.19.0" },
        runtime: { name: "node", version: "24.18.0" },
      },
      packageManager: "npm@11.19.0",
    }),
  );
  writeFileSync(
    resolve(repositoryRoot, "apps/backoffice/package.json"),
    JSON.stringify({ dependencies: { next: "16.3.0" } }),
  );
  writeFileSync(
    resolve(repositoryRoot, "node_modules/next/package.json"),
    JSON.stringify({ bin: { next: "./dist/bin/next" }, name: "next", version: "16.3.0" }),
  );
  writeFileSync(resolve(repositoryRoot, "node_modules/next/dist/bin/next"), "next");

  return { applicationRoots, repositoryRoot };
}

describe("Next build cache cleanup", () => {
  it("removes only the transient cache for the two authorized applications", () => {
    const fixture = createRepositoryFixture();

    for (const applicationRoot of fixture.applicationRoots) {
      removeNextBuildCache({ applicationRoot, repositoryRoot: fixture.repositoryRoot });
      expect(existsSync(resolve(applicationRoot, ".next/cache"))).toBe(false);
      expect(readFileSync(resolve(applicationRoot, ".next/standalone/server.js"), "utf8")).toBe(
        "standalone",
      );
      expect(readFileSync(resolve(applicationRoot, ".next/static/build.css"), "utf8")).toBe(
        "static",
      );
    }
  });

  it("refuses a cache path outside the two application roots", () => {
    const fixture = createRepositoryFixture();
    const outsideRoot = resolve(fixture.repositoryRoot, "packages/ui");
    mkdirSync(resolve(outsideRoot, ".next/cache"), { recursive: true });

    expect(() =>
      removeNextBuildCache({
        applicationRoot: outsideRoot,
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).toThrow("fora das aplicações autorizadas");
    expect(existsSync(resolve(outsideRoot, ".next/cache"))).toBe(true);
  });

  it("is idempotent when the authorized cache is already absent", () => {
    const fixture = createRepositoryFixture();
    const applicationRoot = fixture.applicationRoots[0];

    removeNextBuildCache({ applicationRoot, repositoryRoot: fixture.repositoryRoot });
    expect(() =>
      removeNextBuildCache({ applicationRoot, repositoryRoot: fixture.repositoryRoot }),
    ).not.toThrow();
  });

  it.runIf(process.platform === "win32")(
    "removes one authorized Windows cache through the native reparse guard",
    () => {
      const fixture = createRepositoryFixture();
      const applicationRoot = fixture.applicationRoots[0];

      removeNextBuildCacheNative({
        applicationRoot,
        repositoryRoot: fixture.repositoryRoot,
      });

      expect(existsSync(resolve(applicationRoot, ".next/cache"))).toBe(false);
      expect(existsSync(resolve(applicationRoot, ".next/standalone/server.js"))).toBe(true);
    },
    20_000,
  );

  it("passes only the exact authorized Windows cache target to the physical remover", () => {
    const fixture = createRepositoryFixture();
    const applicationRoot = fixture.applicationRoots[0];
    const cachePath = resolve(applicationRoot, ".next/cache");
    const calls = [];

    removeNextBuildCache({
      applicationRoot,
      removeTree: (...arguments_) => calls.push(arguments_),
      repositoryRoot: fixture.repositoryRoot,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(cachePath);
    expect(calls[0][1].authorizedWindowsPaths).toEqual([cachePath]);
  });

  it.runIf(process.platform === "win32")(
    "rejects a Windows junction inside cache without traversing or retiring the tree",
    () => {
      const fixture = createRepositoryFixture();
      const applicationRoot = fixture.applicationRoots[0];
      const externalRoot = resolve(fixture.repositoryRoot, "external-cache-target");
      const externalMarker = resolve(externalRoot, "must-remain");
      mkdirSync(externalRoot);
      writeFileSync(externalMarker, "preserve", "utf8");
      symlinkSync(externalRoot, resolve(applicationRoot, ".next/cache/junction"), "junction");

      expect(() =>
        removeNextBuildCacheNative({
          applicationRoot,
          repositoryRoot: fixture.repositoryRoot,
        }),
      ).toThrow("reparse points");
      expect(readFileSync(externalMarker, "utf8")).toBe("preserve");
      expect(existsSync(resolve(applicationRoot, ".next/cache"))).toBe(true);
    },
    15_000,
  );

  it("keeps the canonical build scripts coupled to the cache guard", () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const rootManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    const backofficeManifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, "apps/backoffice/package.json"), "utf8"),
    );

    expect(rootManifest.scripts["build:web"]).toBe("node scripts/next-build.mjs");
    expect(backofficeManifest.scripts.build).toBe("node ../../scripts/next-build.mjs");

    const releaseSource = readFileSync(
      resolve(repositoryRoot, "scripts/release-manifest.mjs"),
      "utf8",
    );
    expect(releaseSource).toContain("runNextBuildWithCacheCleanup({");
    expect(releaseSource).not.toContain('[nextExecutable, "build"]');
  });

  it("runs the fixed Next CLI and removes cache after a successful build", () => {
    const fixture = createRepositoryFixture();
    const applicationRoot = fixture.applicationRoots[0];
    const calls = [];

    runNextBuildWithCacheCleanup({
      applicationRoot,
      buildEnvironment: { APP_RELEASE_SHA: "local" },
      executeBuild: (...arguments_) => calls.push(arguments_),
      repositoryRoot: fixture.repositoryRoot,
      resolveNextLaunch: resolveFixtureNextLaunch,
    });

    expect(calls).toEqual([
      [
        process.execPath,
        [resolve(fixture.repositoryRoot, "node_modules/next/dist/bin/next"), "build"],
        {
          cwd: applicationRoot,
          env: { APP_RELEASE_SHA: "local" },
          stdio: "inherit",
        },
      ],
    ]);
    expect(existsSync(resolve(applicationRoot, ".next/cache"))).toBe(false);
    expect(existsSync(resolve(applicationRoot, ".next/standalone/server.js"))).toBe(true);
    expect(existsSync(resolve(applicationRoot, ".next/static/build.css"))).toBe(true);
  });

  it("removes cache and preserves the original failure when Next fails", () => {
    const fixture = createRepositoryFixture();
    const applicationRoot = fixture.applicationRoots[1];
    const buildFailure = new Error("falha sintética do build");

    expect(() =>
      runNextBuildWithCacheCleanup({
        applicationRoot,
        executeBuild: () => {
          throw buildFailure;
        },
        repositoryRoot: fixture.repositoryRoot,
        resolveNextLaunch: resolveFixtureNextLaunch,
      }),
    ).toThrow(buildFailure);

    expect(existsSync(resolve(applicationRoot, ".next/cache"))).toBe(false);
    expect(existsSync(resolve(applicationRoot, ".next/standalone/server.js"))).toBe(true);
  });

  it("removes cache when the fixed Next CLI is unavailable", () => {
    const fixture = createRepositoryFixture();
    const applicationRoot = fixture.applicationRoots[0];
    rmSync(resolve(fixture.repositoryRoot, "node_modules/next/dist/bin/next"));

    expect(() =>
      runNextBuildWithCacheCleanup({
        applicationRoot,
        repositoryRoot: fixture.repositoryRoot,
        resolveNextLaunch: resolveFixtureTrustedNextLaunch,
      }),
    ).toThrow("CLI Next precisa ser um arquivo físico regular protegido");

    expect(existsSync(resolve(applicationRoot, ".next/cache"))).toBe(false);
    expect(existsSync(resolve(applicationRoot, ".next/standalone/server.js"))).toBe(true);
  });

  it("rejects a symbolic Next package ancestor without spawning and still removes cache", () => {
    const fixture = createRepositoryFixture();
    const applicationRoot = fixture.applicationRoots[0];
    const nextPackageRoot = resolve(fixture.repositoryRoot, "node_modules/next");
    const externalNextPackageRoot = resolve(fixture.repositoryRoot, "external-next");
    const calls = [];

    mkdirSync(resolve(externalNextPackageRoot, "dist/bin"), { recursive: true });
    writeFileSync(
      resolve(externalNextPackageRoot, "package.json"),
      JSON.stringify({ bin: { next: "./dist/bin/next" }, name: "next", version: "16.3.0" }),
    );
    writeFileSync(resolve(externalNextPackageRoot, "dist/bin/next"), "next");
    rmSync(nextPackageRoot, { recursive: true });
    symlinkSync(
      externalNextPackageRoot,
      nextPackageRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      runNextBuildWithCacheCleanup({
        applicationRoot,
        executeBuild: (...arguments_) => calls.push(arguments_),
        repositoryRoot: fixture.repositoryRoot,
        resolveNextLaunch: resolveFixtureTrustedNextLaunch,
      }),
    ).toThrow("caminho da CLI Next atravessa um diretório não físico");

    expect(calls).toEqual([]);
    expect(existsSync(resolve(applicationRoot, ".next/cache"))).toBe(false);
  });

  it("does not traverse a symbolic authorized application root", () => {
    const fixture = createRepositoryFixture();
    const applicationRoot = fixture.applicationRoots[1];
    const externalApplicationRoot = resolve(fixture.repositoryRoot, "external-backoffice");
    const calls = [];

    rmSync(applicationRoot, { recursive: true });
    mkdirSync(resolve(externalApplicationRoot, ".next/cache"), { recursive: true });
    writeFileSync(
      resolve(externalApplicationRoot, "package.json"),
      JSON.stringify({ dependencies: { next: "16.3.0" } }),
    );
    writeFileSync(resolve(externalApplicationRoot, ".next/cache/private.bin"), "credential");
    symlinkSync(
      externalApplicationRoot,
      applicationRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    let failure;
    try {
      runNextBuildWithCacheCleanup({
        applicationRoot,
        executeBuild: (...arguments_) => calls.push(arguments_),
        repositoryRoot: fixture.repositoryRoot,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(calls).toEqual([]);
    expect(existsSync(resolve(externalApplicationRoot, ".next/cache/private.bin"))).toBe(true);
  });

  it("fails the build command when cache cleanup fails", () => {
    const fixture = createRepositoryFixture();
    const cleanupFailure = new Error("falha sintética do cleanup");

    expect(() =>
      runNextBuildWithCacheCleanup({
        applicationRoot: fixture.applicationRoots[0],
        executeBuild: () => undefined,
        removeCache: () => {
          throw cleanupFailure;
        },
        repositoryRoot: fixture.repositoryRoot,
        resolveNextLaunch: resolveFixtureNextLaunch,
      }),
    ).toThrow(cleanupFailure);
  });

  it("preserves build and cleanup failures together", () => {
    const fixture = createRepositoryFixture();
    const buildFailure = new Error("falha sintética do build");
    const cleanupFailure = new Error("falha sintética do cleanup");
    let combinedFailure;

    try {
      runNextBuildWithCacheCleanup({
        applicationRoot: fixture.applicationRoots[1],
        executeBuild: () => {
          throw buildFailure;
        },
        removeCache: () => {
          throw cleanupFailure;
        },
        repositoryRoot: fixture.repositoryRoot,
        resolveNextLaunch: resolveFixtureNextLaunch,
      });
    } catch (error) {
      combinedFailure = error;
    }

    expect(combinedFailure).toBeInstanceOf(AggregateError);
    expect(combinedFailure.errors).toEqual([buildFailure, cleanupFailure]);
  });

  it("refuses an unauthorized application before spawning Next", () => {
    const fixture = createRepositoryFixture();
    const executeBuild = () => {
      throw new Error("o build não deveria iniciar");
    };

    expect(() =>
      runNextBuildWithCacheCleanup({
        applicationRoot: resolve(fixture.repositoryRoot, "packages/ui"),
        executeBuild,
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).toThrow("fora das aplicações autorizadas");
  });
});
