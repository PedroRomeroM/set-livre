import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readOptionalE2EEnvironmentFile } from "../helpers/e2e-environment-file";
import { protectWindowsPrivateFile } from "../../scripts/windows-filesystem-security.mjs";

const privateEnvironment = "E2E_ALLOW_LOCAL=1\nE2E_DATABASE_MARKER=private-marker\n";
const logicalFileSecurity =
  process.platform === "win32"
    ? {
        assertWindowsPath: () => undefined,
        assertWindowsPrivate: () => undefined,
        platform: "win32" as const,
      }
    : undefined;

function temporaryRepository() {
  const root = mkdtempSync(join(tmpdir(), "set-livre-e2e-environment-"));
  return {
    environmentPath: join(root, ".env.e2e.local"),
    root,
  };
}

function errorMessage(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("A operação de teste deveria falhar.");
}

function writePrivateEnvironment(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o600 });
}

describe("private E2E environment file", () => {
  it("reads a private file, accepts absence and models the Windows permission branch", () => {
    const privateRepository = temporaryRepository();
    const missingRepository = temporaryRepository();
    const windowsRepository = temporaryRepository();

    try {
      writePrivateEnvironment(privateRepository.environmentPath, privateEnvironment);
      expect(readOptionalE2EEnvironmentFile(privateRepository.root, logicalFileSecurity)).toEqual({
        E2E_ALLOW_LOCAL: "1",
        E2E_DATABASE_MARKER: "private-marker",
      });
      expect(readOptionalE2EEnvironmentFile(missingRepository.root, logicalFileSecurity)).toEqual(
        {},
      );

      writeFileSync(windowsRepository.environmentPath, privateEnvironment, { mode: 0o644 });
      expect(
        readOptionalE2EEnvironmentFile(windowsRepository.root, {
          assertWindowsPath: () => undefined,
          assertWindowsPrivate: () => undefined,
          platform: "win32",
        }),
      ).toEqual({
        E2E_ALLOW_LOCAL: "1",
        E2E_DATABASE_MARKER: "private-marker",
      });
    } finally {
      rmSync(privateRepository.root, { force: true, recursive: true });
      rmSync(missingRepository.root, { force: true, recursive: true });
      rmSync(windowsRepository.root, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects mode 0644 before reading and never includes file contents in the error",
    () => {
      const repository = temporaryRepository();
      let descriptorWasRead = false;

      try {
        writeFileSync(repository.environmentPath, privateEnvironment, { mode: 0o600 });
        chmodSync(repository.environmentPath, 0o644);
        const message = errorMessage(() =>
          readOptionalE2EEnvironmentFile(repository.root, {
            readDescriptor: () => {
              descriptorWasRead = true;
              return privateEnvironment;
            },
          }),
        );

        expect(descriptorWasRead).toBe(false);
        expect(message).toContain("modo 0600");
        expect(message).not.toContain("private-marker");
        expect(message).not.toContain(repository.root);
      } finally {
        rmSync(repository.root, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects a broad Windows DACL and accepts the protected equivalent",
    () => {
      const repository = temporaryRepository();
      try {
        expect(readOptionalE2EEnvironmentFile(repository.root)).toEqual({});
        writeFileSync(repository.environmentPath, privateEnvironment, "utf8");
        expect(() => readOptionalE2EEnvironmentFile(repository.root)).toThrow(
          "DACL privada protegida",
        );

        protectWindowsPrivateFile(repository.environmentPath);
        expect(readOptionalE2EEnvironmentFile(repository.root)).toEqual({
          E2E_ALLOW_LOCAL: "1",
          E2E_DATABASE_MARKER: "private-marker",
        });
      } finally {
        rmSync(repository.root, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform !== "win32" && typeof process.geteuid === "function")(
    "rejects a divergent POSIX owner before reading without requiring chown",
    () => {
      const repository = temporaryRepository();
      let descriptorWasRead = false;
      const effectiveUserId = process.geteuid?.();
      if (effectiveUserId === undefined) {
        throw new Error("O teste POSIX exige geteuid.");
      }

      try {
        writeFileSync(repository.environmentPath, privateEnvironment, { mode: 0o600 });
        const message = errorMessage(() =>
          readOptionalE2EEnvironmentFile(repository.root, {
            expectedPosixUserId: effectiveUserId + 1,
            readDescriptor: () => {
              descriptorWasRead = true;
              return privateEnvironment;
            },
          }),
        );

        expect(descriptorWasRead).toBe(false);
        expect(message).toContain("usuário efetivo");
        expect(message).not.toContain("private-marker");
      } finally {
        rmSync(repository.root, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symbolic and hard-linked environment files before reading their targets",
    () => {
      const symbolicRepository = temporaryRepository();
      const hardLinkRepository = temporaryRepository();
      const symbolicTarget = join(symbolicRepository.root, "symbolic-target.env");
      const hardLinkTarget = join(hardLinkRepository.root, "hard-link-target.env");
      let descriptorReads = 0;
      const readDescriptor = () => {
        descriptorReads += 1;
        return privateEnvironment;
      };

      try {
        writeFileSync(symbolicTarget, privateEnvironment, { mode: 0o600 });
        symlinkSync(symbolicTarget, symbolicRepository.environmentPath);
        writeFileSync(hardLinkTarget, privateEnvironment, { mode: 0o600 });
        linkSync(hardLinkTarget, hardLinkRepository.environmentPath);

        expect(() =>
          readOptionalE2EEnvironmentFile(symbolicRepository.root, { readDescriptor }),
        ).toThrow("arquivo regular exclusivo");
        expect(() =>
          readOptionalE2EEnvironmentFile(hardLinkRepository.root, { readDescriptor }),
        ).toThrow("arquivo regular exclusivo");
        expect(descriptorReads).toBe(0);
        expect(readFileSync(symbolicTarget, "utf8")).toBe(privateEnvironment);
        expect(readFileSync(hardLinkTarget, "utf8")).toBe(privateEnvironment);
      } finally {
        rmSync(symbolicRepository.root, { force: true, recursive: true });
        rmSync(hardLinkRepository.root, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symbolic repository ancestor without reading the environment",
    () => {
      const testRoot = mkdtempSync(join(tmpdir(), "set-livre-e2e-ancestor-"));
      const physicalRepository = join(testRoot, "physical-repository");
      const symbolicRepository = join(testRoot, "symbolic-repository");
      let descriptorWasRead = false;

      try {
        mkdirSync(physicalRepository);
        writeFileSync(join(physicalRepository, ".env.e2e.local"), privateEnvironment, {
          mode: 0o600,
        });
        symlinkSync(physicalRepository, symbolicRepository, "dir");

        expect(() =>
          readOptionalE2EEnvironmentFile(symbolicRepository, {
            readDescriptor: () => {
              descriptorWasRead = true;
              return privateEnvironment;
            },
          }),
        ).toThrow("ancestrais físicos");
        expect(descriptorWasRead).toBe(false);
      } finally {
        rmSync(testRoot, { force: true, recursive: true });
      }
    },
  );

  it("rejects a file replacement race and discards the already-read secret", () => {
    const repository = temporaryRepository();
    const retiredPath = join(repository.root, "original.env.e2e.local");
    const replacement = "E2E_DATABASE_MARKER=replacement-marker\n";

    try {
      writePrivateEnvironment(repository.environmentPath, privateEnvironment);
      const message = errorMessage(() =>
        readOptionalE2EEnvironmentFile(repository.root, {
          ...logicalFileSecurity,
          readDescriptor: (descriptor) => {
            const source = readFileSync(descriptor, "utf8");
            renameSync(repository.environmentPath, retiredPath);
            writeFileSync(repository.environmentPath, replacement, { mode: 0o600 });
            return source;
          },
        }),
      );

      expect(message).not.toContain("private-marker");
      expect(message).not.toContain("replacement-marker");
      expect(message).toContain("arquivo regular exclusivo");
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects an ancestor replacement race before returning parsed secrets",
    () => {
      const testRoot = mkdtempSync(join(tmpdir(), "set-livre-e2e-ancestor-race-"));
      const repository = join(testRoot, "repository");
      const retiredRepository = join(testRoot, "retired-repository");
      const environmentPath = join(repository, ".env.e2e.local");

      try {
        mkdirSync(repository);
        writeFileSync(environmentPath, privateEnvironment, { mode: 0o600 });
        const message = errorMessage(() =>
          readOptionalE2EEnvironmentFile(repository, {
            readDescriptor: (descriptor) => {
              const source = readFileSync(descriptor, "utf8");
              renameSync(repository, retiredRepository);
              symlinkSync(retiredRepository, repository, "dir");
              return source;
            },
          }),
        );

        expect(message).toContain("ancestrais físicos");
        expect(message).not.toContain("private-marker");
      } finally {
        rmSync(testRoot, { force: true, recursive: true });
      }
    },
  );
});
