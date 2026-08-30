import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hostConfigurationFiles,
  packageRelease,
  releaseSensitiveValues,
} from "../../scripts/release.mjs";

const roots = [];
const commit = "a".repeat(40);

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-release-"));
  roots.push(root);
  for (const directory of [
    ".next/standalone",
    ".next/static",
    "apps/backoffice/.next/standalone/apps/backoffice",
    "apps/backoffice/.next/static",
    "node_modules",
  ]) {
    mkdirSync(resolve(root, directory), { recursive: true });
  }
  for (const path of hostConfigurationFiles) {
    mkdirSync(resolve(root, path, ".."), { recursive: true });
    writeFileSync(resolve(root, path), `${path}\n`);
  }
  writeFileSync(resolve(root, ".next/BUILD_ID"), commit);
  writeFileSync(resolve(root, ".next/standalone/server.js"), "web");
  writeFileSync(resolve(root, ".next/static/app.js"), "static-web");
  writeFileSync(resolve(root, "apps/backoffice/.next/BUILD_ID"), commit);
  writeFileSync(
    resolve(root, "apps/backoffice/.next/standalone/apps/backoffice/server.js"),
    "backoffice",
  );
  writeFileSync(resolve(root, "apps/backoffice/.next/static/app.js"), "static-backoffice");
  return root;
}

function existingRelease(root) {
  const outputDirectory = resolve(root, ".artifacts/release");
  const sentinel = resolve(outputDirectory, "must-survive.txt");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(sentinel, "preserved");
  const directoryMetadata = statSync(outputDirectory);
  const sentinelMetadata = statSync(sentinel);
  return {
    directoryMetadata: { mode: directoryMetadata.mode, mtimeMs: directoryMetadata.mtimeMs },
    outputDirectory,
    sentinel,
    sentinelMetadata: { mode: sentinelMetadata.mode, mtimeMs: sentinelMetadata.mtimeMs },
  };
}

function expectExistingReleasePreserved(previousRelease) {
  const directoryMetadata = statSync(previousRelease.outputDirectory);
  const sentinelMetadata = statSync(previousRelease.sentinel);
  expect(readFileSync(previousRelease.sentinel, "utf8")).toBe("preserved");
  expect({ mode: directoryMetadata.mode, mtimeMs: directoryMetadata.mtimeMs }).toEqual(
    previousRelease.directoryMetadata,
  );
  expect({ mode: sentinelMetadata.mode, mtimeMs: sentinelMetadata.mtimeMs }).toEqual(
    previousRelease.sentinelMetadata,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("release package", () => {
  it("packages both standalone applications under one immutable SHA", () => {
    const root = fixture();
    const outputDirectory = resolve(root, ".artifacts/release");
    const manifest = packageRelease({ commit, outputDirectory, root });

    expect(manifest).toMatchObject({
      commit,
      hostConfiguration: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      version: 2,
    });
    expect(readFileSync(resolve(outputDirectory, "web/server.js"), "utf8")).toBe("web");
    expect(
      readFileSync(resolve(outputDirectory, "backoffice/apps/backoffice/server.js"), "utf8"),
    ).toBe("backoffice");
  });

  it("rejects a build produced for another SHA", () => {
    const root = fixture();
    writeFileSync(resolve(root, ".next/BUILD_ID"), "b".repeat(40));

    expect(() =>
      packageRelease({ commit, outputDirectory: resolve(root, ".artifacts/release"), root }),
    ).toThrow("não");
  });

  it("rejects and removes an artifact that contains a configured secret", () => {
    const root = fixture();
    const outputDirectory = resolve(root, ".artifacts/release");
    writeFileSync(resolve(root, ".next/standalone/leak.txt"), "prefix-runtime-secret-suffix");

    expect(() =>
      packageRelease({
        commit,
        outputDirectory,
        root,
        sensitiveValues: ["runtime-secret"],
      }),
    ).toThrow("valor sensível");
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it("classifies the backoffice runtime unlock key as release-sensitive", () => {
    const runtimeUnlockKey = "A".repeat(43);

    expect(releaseSensitiveValues({ BACKOFFICE_RUNTIME_UNLOCK_KEY: runtimeUnlockKey })).toContain(
      runtimeUnlockKey,
    );
  });

  it("materializes internal symbolic and hard links as independent regular files", () => {
    const root = fixture();
    const standalone = resolve(root, ".next/standalone");
    const sharedDirectory = resolve(standalone, "shared-source");
    const sharedFile = resolve(sharedDirectory, "shared.js");
    const dependencyDirectory = resolve(root, "node_modules/release-dependency");
    mkdirSync(sharedDirectory);
    mkdirSync(dependencyDirectory);
    writeFileSync(sharedFile, "shared");
    writeFileSync(resolve(dependencyDirectory, "index.js"), "dependency");
    symlinkSync(
      sharedDirectory,
      resolve(standalone, "shared-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    linkSync(sharedFile, resolve(sharedDirectory, "shared-hardlink.js"));
    symlinkSync(
      dependencyDirectory,
      resolve(standalone, "dependency-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const outputDirectory = resolve(root, ".artifacts/release");
    packageRelease({ commit, outputDirectory, root });

    const linkedDirectory = resolve(outputDirectory, "web/shared-link");
    const copiedSource = resolve(outputDirectory, "web/shared-source/shared.js");
    const copiedHardlink = resolve(outputDirectory, "web/shared-source/shared-hardlink.js");
    expect(lstatSync(linkedDirectory).isSymbolicLink()).toBe(false);
    expect(readFileSync(resolve(linkedDirectory, "shared.js"), "utf8")).toBe("shared");
    expect(readFileSync(resolve(outputDirectory, "web/dependency-link/index.js"), "utf8")).toBe(
      "dependency",
    );
    expect(statSync(copiedSource).nlink).toBe(1);
    expect(statSync(copiedHardlink).nlink).toBe(1);
  });

  it("rejects a symbolic link whose target is outside its standalone root", () => {
    const root = fixture();
    const externalDirectory = resolve(root, "external-package");
    mkdirSync(externalDirectory);
    writeFileSync(resolve(externalDirectory, "outside.js"), "outside");
    symlinkSync(
      externalDirectory,
      resolve(root, ".next/standalone/external-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const outputDirectory = resolve(root, ".artifacts/release");
    expect(() => packageRelease({ commit, outputDirectory, root })).toThrow(
      "saiu da raiz permitida",
    );
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it.each([
    ".next/standalone",
    ".next/static",
    "apps/backoffice/.next/standalone",
    "apps/backoffice/.next/static",
    "node_modules",
    "public",
    "apps/backoffice/public",
  ])("rejects the linked release source root %s", (relativeSource) => {
    const root = fixture();
    const externalRoot = mkdtempSync(resolve(tmpdir(), "set-livre-release-source-"));
    roots.push(externalRoot);
    const source = resolve(root, relativeSource);
    rmSync(source, { force: true, recursive: true });
    symlinkSync(externalRoot, source, process.platform === "win32" ? "junction" : "dir");

    const previousRelease = existingRelease(root);
    expect(() =>
      packageRelease({ commit, outputDirectory: previousRelease.outputDirectory, root }),
    ).toThrow("não pode ser link simbólico ou junction");
    expectExistingReleasePreserved(previousRelease);
  });

  it("rejects a dangling optional public source instead of silently omitting it", () => {
    const root = fixture();
    symlinkSync(
      resolve(root, "missing-public-target"),
      resolve(root, "public"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const previousRelease = existingRelease(root);
    expect(() =>
      packageRelease({ commit, outputDirectory: previousRelease.outputDirectory, root }),
    ).toThrow("não pode ser link simbólico ou junction");
    expectExistingReleasePreserved(previousRelease);
  });

  it("rejects a source whose physical parent leaves the repository", () => {
    const root = fixture();
    const externalRoot = mkdtempSync(resolve(tmpdir(), "set-livre-release-parent-"));
    roots.push(externalRoot);
    const externalNext = resolve(externalRoot, ".next");
    renameSync(resolve(root, ".next"), externalNext);
    symlinkSync(
      externalNext,
      resolve(root, ".next"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const previousRelease = existingRelease(root);
    expect(() =>
      packageRelease({ commit, outputDirectory: previousRelease.outputDirectory, root }),
    ).toThrow("saiu da raiz física do repositório");
    expectExistingReleasePreserved(previousRelease);
  });

  it("rejects a linked artifacts ancestor without deleting its external target", () => {
    const root = fixture();
    const externalRoot = mkdtempSync(resolve(tmpdir(), "set-livre-release-external-"));
    roots.push(externalRoot);
    const externalRelease = resolve(externalRoot, "release");
    mkdirSync(externalRelease);
    const sentinel = resolve(externalRelease, "must-survive.txt");
    writeFileSync(sentinel, "preserved");
    symlinkSync(
      externalRoot,
      resolve(root, ".artifacts"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      packageRelease({
        commit,
        outputDirectory: resolve(root, ".artifacts/release"),
        root,
      }),
    ).toThrow("ancestral simbólico ou junction");
    expect(readFileSync(sentinel, "utf8")).toBe("preserved");
  });
});
