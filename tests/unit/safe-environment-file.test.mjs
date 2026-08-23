import { execFileSync } from "node:child_process";
import {
  existsSync,
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
import {
  assertWindowsPrivateFile,
  protectWindowsPrivateFile,
} from "../../scripts/windows-filesystem-security.mjs";

const temporaryRoots = [];
const repositoryRoot = resolve(import.meta.dirname, "../..");
const testTemporaryDirectory = resolve(repositoryRoot, "node_modules/.cache");
const logicalFilesystemSecurity =
  process.platform === "win32"
    ? {
        assertWindowsPath: () => undefined,
        assertWindowsPrivate: () => undefined,
        platform: "win32",
        protectWindowsPrivate: () => undefined,
      }
    : undefined;

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

function grantAuthenticatedUsersModify(path) {
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== "string" || systemRoot === "") {
    throw new Error("SystemRoot não está disponível para o teste Windows nativo.");
  }
  execFileSync(resolve(systemRoot, "System32/icacls.exe"), [path, "/grant", "*S-1-5-11:(OI)(CI)M"]);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("safe local environment files", () => {
  it(
    "publishes a private file atomically instead of writing the old inode",
    () => {
      const root = temporaryRoot();
      const destination = join(root, ".env.local");
      writeFileSync(destination, "OLD=value\n", { encoding: "utf8", mode: 0o644 });
      if (process.platform === "win32") {
        protectWindowsPrivateFile(destination, { trustedRoot: repositoryRoot });
      }
      const oldInode = statSync(destination).ino;

      writeEnvironmentFileAtomic(destination, "NEW=secret\n");

      const published = statSync(destination);
      expect(readFileSync(destination, "utf8")).toBe("NEW=secret\n");
      if (process.platform !== "win32") {
        expect(published.ino).not.toBe(oldInode);
        expect(published.mode & 0o777).toBe(0o600);
      } else {
        expect(() =>
          assertWindowsPrivateFile(destination, { trustedRoot: repositoryRoot }),
        ).not.toThrow();
      }
      expect(readdirSync(root)).toEqual([".env.local"]);
    },
    process.platform === "win32" ? 30_000 : 5_000,
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlink destination without changing its target",
    () => {
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
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects a junction destination without changing its target",
    () => {
      const root = temporaryRoot();
      const target = join(root, "user-owned-target");
      const destination = join(root, ".env.local");
      mkdirSync(target);
      writeFileSync(join(target, "marker"), "DO_NOT_TOUCH\n", "utf8");
      symlinkSync(target, destination, "junction");

      expect(() => writeEnvironmentFileAtomic(destination, "DATABASE_PASSWORD=secret\n")).toThrow(
        "reparse points",
      );
      expect(readFileSync(join(target, "marker"), "utf8")).toBe("DO_NOT_TOUCH\n");
    },
    15_000,
  );

  it("replaces a hard-linked regular destination without mutating the other link", () => {
    const root = temporaryRoot();
    const target = join(root, "user-owned-target");
    const destination = join(root, ".env.e2e.local");
    writeFileSync(target, "DO_NOT_TOUCH\n", "utf8");
    linkSync(target, destination);

    writeEnvironmentFileAtomic(
      destination,
      "E2E_DATABASE_URL=local-secret\n",
      logicalFilesystemSecurity,
    );

    expect(readFileSync(target, "utf8")).toBe("DO_NOT_TOUCH\n");
    expect(readFileSync(destination, "utf8")).toBe("E2E_DATABASE_URL=local-secret\n");
    expect(statSync(destination).ino).not.toBe(statSync(target).ino);
  });

  it("rejects a non-regular destination during preflight", () => {
    const root = temporaryRoot();
    const destination = join(root, ".env.local");
    mkdirSync(destination);

    expect(() =>
      assertSafeEnvironmentFileDestination(destination, logicalFilesystemSecurity),
    ).toThrow("não é um arquivo regular");
    expect(lstatSync(destination).isDirectory()).toBe(true);
  });

  it("rejects a symlinked parent without creating a credential file in its target", () => {
    const root = temporaryRoot();
    const physicalParent = join(root, "outside");
    const linkedParent = join(root, "linked-app");
    mkdirSync(physicalParent);
    symlinkSync(physicalParent, linkedParent, process.platform === "win32" ? "junction" : "dir");

    expect(() =>
      writeEnvironmentFileAtomic(
        join(linkedParent, ".env.local"),
        "DATABASE_PASSWORD=secret\n",
        logicalFilesystemSecurity,
      ),
    ).toThrow("não é um diretório físico");
    expect(readdirSync(physicalParent)).toEqual([]);
  });

  it("rejects a symlinked ancestor above an otherwise physical immediate parent", () => {
    const root = temporaryRoot();
    const physicalAncestor = join(root, "outside");
    const physicalParent = join(physicalAncestor, "backoffice");
    const linkedAncestor = join(root, "apps");
    mkdirSync(physicalParent, { recursive: true });
    symlinkSync(
      physicalAncestor,
      linkedAncestor,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      assertSafeEnvironmentFileDestination(
        join(linkedAncestor, "backoffice/.env.local"),
        logicalFilesystemSecurity,
      ),
    ).toThrow("ancestrais físicos");
    expect(() =>
      writeEnvironmentFileAtomic(
        join(linkedAncestor, "backoffice/.env.local"),
        "DATABASE_PASSWORD=secret\n",
        logicalFilesystemSecurity,
      ),
    ).toThrow("ancestrais físicos");
    expect(readdirSync(physicalParent)).toEqual([]);
  });

  it("keeps a nested physical destination inside the declared repository root", () => {
    const root = temporaryRoot();
    const parent = join(root, "apps/backoffice");
    const destination = join(parent, ".env.local");
    mkdirSync(parent, { recursive: true });

    writeEnvironmentFileAtomic(destination, "APP_ENV=local\n", logicalFilesystemSecurity);

    expect(readFileSync(destination, "utf8")).toBe("APP_ENV=local\n");
    expect(readdirSync(parent)).toEqual([".env.local"]);
  });

  it("protects the empty Windows temporary before writing and rechecks the published file", () => {
    const root = temporaryRoot();
    const destination = join(root, ".env.local");
    const events = [];

    writeEnvironmentFileAtomic(destination, "DATABASE_PASSWORD=secret\n", {
      assertWindowsPath: (path) => events.push(["path", path]),
      assertWindowsPrivate: (path, options) =>
        events.push(["private", path, existsSync(path) ? statSync(path).size : undefined, options]),
      platform: "win32",
      protectWindowsPrivate: (path) => events.push(["protect", path, statSync(path).size]),
    });

    const protectEvent = events.find(([event]) => event === "protect");
    const privateEvents = events.filter(([event]) => event === "private");
    expect(protectEvent?.[2]).toBe(0);
    expect(
      privateEvents.some(
        ([, path, size]) =>
          path !== destination && size === Buffer.byteLength("DATABASE_PASSWORD=secret\n"),
      ),
    ).toBe(true);
    expect(privateEvents.at(-1)?.slice(1, 3)).toEqual([
      destination,
      Buffer.byteLength("DATABASE_PASSWORD=secret\n"),
    ]);
    expect(privateEvents.every((event) => event[3]?.trustedRoot === repositoryRoot)).toBe(true);
    expect(readFileSync(destination, "utf8")).toBe("DATABASE_PASSWORD=secret\n");
  });

  it.runIf(process.platform === "win32")(
    "rejects an ancestor with broad Modify rights before creating an environment file",
    () => {
      const root = temporaryRoot();
      const parent = join(root, "application");
      const destination = join(parent, ".env.local");
      mkdirSync(parent);
      grantAuthenticatedUsersModify(parent);

      expect(() => writeEnvironmentFileAtomic(destination, "DATABASE_PASSWORD=secret\n")).toThrow(
        "ancestrais Windows confiáveis",
      );
      expect(readdirSync(parent)).toEqual([]);
    },
    20_000,
  );

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
          symlinkSync(
            replacementAncestor,
            originalAncestor,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return originalByteLength(...argumentsList);
      };

      expect(() =>
        writeEnvironmentFileAtomic(
          destination,
          "DATABASE_PASSWORD=secret\n",
          logicalFilesystemSecurity,
        ),
      ).toThrow("mudaram durante a operação");
    } finally {
      Buffer.byteLength = originalByteLength;
    }

    expect(readdirSync(join(retiredAncestor, "backoffice"))).toEqual([]);
    expect(readdirSync(replacementParent)).toEqual([]);
  });
});
