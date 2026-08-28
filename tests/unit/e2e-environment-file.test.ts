import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  localE2EEnvironmentValue,
  readOptionalE2EEnvironmentFile,
} from "../helpers/e2e-environment-file";

const temporaryDirectories: string[] = [];

function temporaryRepository() {
  const directory = mkdtempSync(resolve(tmpdir(), "set-livre-e2e-env-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("E2E environment file", () => {
  it("returns an empty environment when the optional file does not exist", () => {
    expect(readOptionalE2EEnvironmentFile(temporaryRepository())).toEqual({});
  });

  it("parses the local environment file", () => {
    const repository = temporaryRepository();
    writeFileSync(resolve(repository, ".env.e2e.local"), "E2E_ALLOW_LOCAL=1\nVALUE=ok\n", {
      mode: 0o600,
    });

    expect(readOptionalE2EEnvironmentFile(repository)).toEqual({
      E2E_ALLOW_LOCAL: "1",
      VALUE: "ok",
    });
  });

  it("rejects malformed contents", () => {
    const repository = temporaryRepository();
    writeFileSync(resolve(repository, ".env.e2e.local"), "INVALID='unterminated\n", {
      mode: 0o600,
    });

    expect(() => readOptionalE2EEnvironmentFile(repository)).toThrow("interpretar");
  });

  it.runIf(process.platform !== "win32")(
    "rejects group/world-readable environment files before parsing",
    () => {
      const repository = temporaryRepository();
      const environmentPath = resolve(repository, ".env.e2e.local");
      writeFileSync(environmentPath, "INVALID='would-reach-parser\n", { mode: 0o600 });
      chmodSync(environmentPath, 0o644);

      expect(() => readOptionalE2EEnvironmentFile(repository)).toThrow("privado");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects environment files owned by a user other than the effective user",
    () => {
      const repository = temporaryRepository();
      const environmentPath = resolve(repository, ".env.e2e.local");
      writeFileSync(environmentPath, "E2E_ALLOW_LOCAL=1\n", { mode: 0o600 });
      const readEffectiveUserId = process.geteuid;
      if (readEffectiveUserId === undefined) {
        throw new Error("O teste exige process.geteuid em sistemas POSIX.");
      }
      const effectiveUserId = readEffectiveUserId();
      const getEffectiveUserId = vi.spyOn(process, "geteuid").mockReturnValue(effectiveUserId + 1);

      try {
        expect(() => readOptionalE2EEnvironmentFile(repository)).toThrow("privado");
      } finally {
        getEffectiveUserId.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symbolic and hard-linked environment files before parsing",
    () => {
      const symbolicRepository = temporaryRepository();
      const hardLinkRepository = temporaryRepository();
      const symbolicTarget = resolve(symbolicRepository, "symbolic-target.env");
      const hardLinkTarget = resolve(hardLinkRepository, "hard-link-target.env");
      writeFileSync(symbolicTarget, "INVALID='symbolic-target\n", { mode: 0o600 });
      symlinkSync(symbolicTarget, resolve(symbolicRepository, ".env.e2e.local"));
      writeFileSync(hardLinkTarget, "INVALID='hard-link-target\n", { mode: 0o600 });
      linkSync(hardLinkTarget, resolve(hardLinkRepository, ".env.e2e.local"));

      expect(() => readOptionalE2EEnvironmentFile(symbolicRepository)).toThrow("privado");
      expect(() => readOptionalE2EEnvironmentFile(hardLinkRepository)).toThrow("privado");
    },
  );

  it("prefers the generated local contract over divergent inherited values", () => {
    const localEnvironment = {
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_local_contract_key",
    };
    const inheritedEnvironment = {
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_production_contract_key",
      VALUE_WITHOUT_LOCAL_ENTRY: "inherited",
    };

    expect(
      localE2EEnvironmentValue(
        localEnvironment,
        inheritedEnvironment,
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      ),
    ).toBe("sb_publishable_local_contract_key");
    expect(
      localE2EEnvironmentValue(localEnvironment, inheritedEnvironment, "VALUE_WITHOUT_LOCAL_ENTRY"),
    ).toBe("inherited");
  });
});
