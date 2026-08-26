import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readOptionalE2EEnvironmentFile } from "../helpers/e2e-environment-file";

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
    writeFileSync(resolve(repository, ".env.e2e.local"), "E2E_ALLOW_LOCAL=1\nVALUE=ok\n");

    expect(readOptionalE2EEnvironmentFile(repository)).toEqual({
      E2E_ALLOW_LOCAL: "1",
      VALUE: "ok",
    });
  });

  it("rejects malformed contents", () => {
    const repository = temporaryRepository();
    writeFileSync(resolve(repository, ".env.e2e.local"), "INVALID='unterminated\n");

    expect(() => readOptionalE2EEnvironmentFile(repository)).toThrow("interpretar");
  });
});
