import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hostConfigurationFiles, packageRelease } from "../../scripts/release.mjs";

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
});
