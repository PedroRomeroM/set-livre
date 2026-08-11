import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertSafeEnvironmentFileDestination,
  writeEnvironmentFileAtomic,
} from "../../scripts/safe-environment-file.mjs";

const temporaryRoots = [];
const repositoryRoot = resolve(import.meta.dirname, "../..");
const testTemporaryDirectory = resolve(repositoryRoot, "node_modules/.cache");

function temporaryRoot() {
  mkdirSync(testTemporaryDirectory, { recursive: true });
  const root = mkdtempSync(join(testTemporaryDirectory, "set-livre-env-test-"));
  temporaryRoots.push(root);
  return root;
}

function externalTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "set-livre-env-external-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("safe local environment files", () => {
  it("publishes a private file atomically instead of writing the old inode", () => {
    const root = temporaryRoot();
    const destination = join(root, ".env.local");
    writeFileSync(destination, "OLD=value\n", { encoding: "utf8", mode: 0o644 });
    const oldInode = statSync(destination).ino;

    writeEnvironmentFileAtomic(destination, "NEW=secret\n");

    const published = statSync(destination);
    expect(readFileSync(destination, "utf8")).toBe("NEW=secret\n");
    if (process.platform !== "win32") {
      expect(published.ino).not.toBe(oldInode);
      expect(published.mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(root)).toEqual([".env.local"]);
  });

  it("rejects a symlink destination without changing its target", () => {
    const root = temporaryRoot();
    const target = join(root, "user-owned-target");
    const destination = join(root, ".env.local");
    writeFileSync(target, "DO_NOT_TOUCH\n", "utf8");
    symlinkSync(target, destination);

    expect(() => writeEnvironmentFileAtomic(destination, "DATABASE_PASSWORD=secret\n")).toThrow(
      "não é um arquivo regular",
    );

    expect(readFileSync(target, "utf8")).toBe("DO_NOT_TOUCH\n");
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(readdirSync(root).sort()).toEqual([".env.local", "user-owned-target"]);
  });

  it("replaces a hard-linked regular destination without mutating the other link", () => {
    const root = temporaryRoot();
    const target = join(root, "user-owned-target");
    const destination = join(root, ".env.e2e.local");
    writeFileSync(target, "DO_NOT_TOUCH\n", "utf8");
    linkSync(target, destination);

    writeEnvironmentFileAtomic(destination, "E2E_DATABASE_URL=local-secret\n");

    expect(readFileSync(target, "utf8")).toBe("DO_NOT_TOUCH\n");
    expect(readFileSync(destination, "utf8")).toBe("E2E_DATABASE_URL=local-secret\n");
    expect(statSync(destination).ino).not.toBe(statSync(target).ino);
  });

  it("rejects a non-regular destination during preflight", () => {
    const root = temporaryRoot();
    const destination = join(root, ".env.local");
    mkdirSync(destination);

    expect(() => assertSafeEnvironmentFileDestination(destination)).toThrow(
      "não é um arquivo regular",
    );
    expect(lstatSync(destination).isDirectory()).toBe(true);
  });

  it("rejects a symlinked parent without creating a credential file in its target", () => {
    const root = temporaryRoot();
    const physicalParent = join(root, "outside");
    const linkedParent = join(root, "linked-app");
    mkdirSync(physicalParent);
    symlinkSync(physicalParent, linkedParent);

    expect(() =>
      writeEnvironmentFileAtomic(join(linkedParent, ".env.local"), "DATABASE_PASSWORD=secret\n"),
    ).toThrow("não é um diretório físico");
    expect(readdirSync(physicalParent)).toEqual([]);
  });

  it("rejects a symlinked ancestor above an otherwise physical immediate parent", () => {
    const root = temporaryRoot();
    const physicalAncestor = join(root, "outside");
    const physicalParent = join(physicalAncestor, "backoffice");
    const linkedAncestor = join(root, "apps");
    mkdirSync(physicalParent, { recursive: true });
    symlinkSync(physicalAncestor, linkedAncestor);

    expect(() =>
      assertSafeEnvironmentFileDestination(join(linkedAncestor, "backoffice/.env.local")),
    ).toThrow("ancestrais físicos");
    expect(() =>
      writeEnvironmentFileAtomic(
        join(linkedAncestor, "backoffice/.env.local"),
        "DATABASE_PASSWORD=secret\n",
      ),
    ).toThrow("ancestrais físicos");
    expect(readdirSync(physicalParent)).toEqual([]);
  });

  it("keeps a nested physical destination inside the declared repository root", () => {
    const root = temporaryRoot();
    const parent = join(root, "apps/backoffice");
    const destination = join(parent, ".env.local");
    mkdirSync(parent, { recursive: true });

    writeEnvironmentFileAtomic(destination, "APP_ENV=local\n");

    expect(readFileSync(destination, "utf8")).toBe("APP_ENV=local\n");
    expect(readdirSync(parent)).toEqual([".env.local"]);
  });

  it("rejects a destination outside the repository root", () => {
    const outside = externalTemporaryRoot();
    const destination = join(outside, ".env.local");
    writeFileSync(destination, "DO_NOT_TOUCH\n", "utf8");

    expect(() => writeEnvironmentFileAtomic(destination, "DATABASE_PASSWORD=secret\n")).toThrow(
      "sob a raiz do repositório",
    );
    expect(readFileSync(destination, "utf8")).toBe("DO_NOT_TOUCH\n");
  });

  it("revalidates every physical ancestor before opening the temporary file", () => {
    const root = temporaryRoot();
    const originalAncestor = join(root, "apps");
    const originalParent = join(originalAncestor, "backoffice");
    const retiredAncestor = join(root, "apps-original");
    const replacementAncestor = join(root, "replacement");
    const replacementParent = join(replacementAncestor, "backoffice");
    const destination = join(originalParent, ".env.local");
    mkdirSync(originalParent, { recursive: true });
    mkdirSync(replacementParent, { recursive: true });

    const originalByteLength = Buffer.byteLength;
    let swapped = false;
    try {
      Buffer.byteLength = (...argumentsList) => {
        if (!swapped) {
          swapped = true;
          renameSync(originalAncestor, retiredAncestor);
          symlinkSync(replacementAncestor, originalAncestor);
        }
        return originalByteLength(...argumentsList);
      };

      expect(() => writeEnvironmentFileAtomic(destination, "DATABASE_PASSWORD=secret\n")).toThrow(
        "mudaram durante a operação",
      );
    } finally {
      Buffer.byteLength = originalByteLength;
    }

    expect(readdirSync(join(retiredAncestor, "backoffice"))).toEqual([]);
    expect(readdirSync(replacementParent)).toEqual([]);
  });
});
