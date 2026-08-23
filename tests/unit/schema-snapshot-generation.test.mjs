import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fileSymbolicLinksSupported } from "../fixtures/filesystem-capabilities.mjs";

import {
  generateSchemaSnapshot,
  normalizeSchemaSnapshot,
} from "../../scripts/generate-schema-snapshot.mjs";

const temporaryRoots = [];
const linkIt = fileSymbolicLinksSupported ? it : it.skip;
const validSchemaDump = `CREATE SCHEMA IF NOT EXISTS "audit";
CREATE SCHEMA IF NOT EXISTS "private";
CREATE SCHEMA IF NOT EXISTS "public";`;

function temporaryDestination({ createDestination = true } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-schema-snapshot-"));
  temporaryRoots.push(root);
  const destination = resolve(root, "schema.generated.sql");
  if (createDestination) {
    writeFileSync(destination, "known-good-snapshot\n", "utf8");
    chmodSync(destination, 0o640);
  }
  return { destination, root };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("atomic schema snapshot generation", () => {
  it("normalizes and publishes a successful dump from an exclusive sibling temporary", () => {
    const { destination, root } = temporaryDestination();
    let generatedPath;

    generateSchemaSnapshot({
      destinationPath: destination,
      runDump: (temporaryPath) => {
        generatedPath = temporaryPath;
        expect(dirname(temporaryPath)).toBe(root);
        expect(basename(temporaryPath)).toMatch(/^\.schema\.generated\.sql\..+\.tmp$/u);
        expect(lstatSync(temporaryPath).isFile()).toBe(true);
        if (process.platform !== "win32") {
          expect(statSync(temporaryPath).mode & 0o777).toBe(0o600);
        }
        writeFileSync(temporaryPath, `${validSchemaDump}\n\n\t`, "utf8");
      },
    });

    expect(generatedPath).not.toBe(destination);
    expect(readFileSync(destination, "utf8")).toBe(`${validSchemaDump}\n`);
    if (process.platform !== "win32") {
      expect(statSync(destination).mode & 0o777).toBe(0o640);
    }
    expect(readdirSync(root)).toEqual(["schema.generated.sql"]);
  });

  it("preserves the tracked snapshot and removes partial output when dump fails", () => {
    const { destination, root } = temporaryDestination();

    expect(() =>
      generateSchemaSnapshot({
        destinationPath: destination,
        runDump: (temporaryPath) => {
          writeFileSync(temporaryPath, "partial dump", "utf8");
          throw new Error("local database disconnected");
        },
      }),
    ).toThrow("local database disconnected");

    expect(readFileSync(destination, "utf8")).toBe("known-good-snapshot\n");
    expect(readdirSync(root)).toEqual(["schema.generated.sql"]);
  });

  it("preserves the tracked snapshot and cleans the dump when normalization fails", () => {
    const { destination, root } = temporaryDestination();

    expect(() =>
      generateSchemaSnapshot({
        destinationPath: destination,
        normalizeSnapshot: () => {
          throw new Error("normalization failed");
        },
        runDump: (temporaryPath) => {
          writeFileSync(temporaryPath, validSchemaDump, "utf8");
        },
      }),
    ).toThrow("normalization failed");

    expect(readFileSync(destination, "utf8")).toBe("known-good-snapshot\n");
    expect(readdirSync(root)).toEqual(["schema.generated.sql"]);
  });

  it("rejects a non-text normalization result without publishing it", () => {
    const { destination, root } = temporaryDestination();

    expect(() =>
      generateSchemaSnapshot({
        destinationPath: destination,
        normalizeSnapshot: () => undefined,
        runDump: (temporaryPath) => {
          writeFileSync(temporaryPath, validSchemaDump, "utf8");
        },
      }),
    ).toThrow("normalização do snapshot SQL precisa retornar texto");

    expect(readFileSync(destination, "utf8")).toBe("known-good-snapshot\n");
    expect(readdirSync(root)).toEqual(["schema.generated.sql"]);
  });

  it.each([
    ["empty", " \n\t", "dump do schema local está vazio"],
    [
      "missing a required schema",
      'CREATE SCHEMA "audit";\nCREATE SCHEMA "public";\n',
      "dump do schema local não declara o schema private",
    ],
  ])("preserves the tracked snapshot when successful output is %s", (_name, output, message) => {
    const { destination, root } = temporaryDestination();

    expect(() =>
      generateSchemaSnapshot({
        destinationPath: destination,
        runDump: (temporaryPath) => {
          writeFileSync(temporaryPath, output, "utf8");
        },
      }),
    ).toThrow(message);

    expect(readFileSync(destination, "utf8")).toBe("known-good-snapshot\n");
    expect(readdirSync(root)).toEqual(["schema.generated.sql"]);
  });

  linkIt("rejects a dump that replaces its temporary with a symlink", () => {
    const { destination, root } = temporaryDestination();
    const external = resolve(root, "external.sql");
    writeFileSync(external, "external remains unchanged\n", "utf8");

    expect(() =>
      generateSchemaSnapshot({
        destinationPath: destination,
        runDump: (temporaryPath) => {
          rmSync(temporaryPath);
          symlinkSync(external, temporaryPath);
        },
      }),
    ).toThrow("dump do schema precisa permanecer em um arquivo físico regular");

    expect(readFileSync(destination, "utf8")).toBe("known-good-snapshot\n");
    expect(readFileSync(external, "utf8")).toBe("external remains unchanged\n");
    expect(readdirSync(root).sort()).toEqual(["external.sql", "schema.generated.sql"]);
  });

  it("rejects a dump that replaces the exclusive temporary with another regular file", () => {
    const { destination, root } = temporaryDestination();

    expect(() =>
      generateSchemaSnapshot({
        destinationPath: destination,
        runDump: (temporaryPath) => {
          rmSync(temporaryPath);
          writeFileSync(temporaryPath, validSchemaDump, "utf8");
        },
      }),
    ).toThrow("dump do schema precisa permanecer em um arquivo físico regular");

    expect(readFileSync(destination, "utf8")).toBe("known-good-snapshot\n");
    expect(readdirSync(root)).toEqual(["schema.generated.sql"]);
  });

  it("rejects a non-regular destination before invoking the dump", () => {
    const { destination, root } = temporaryDestination({ createDestination: false });
    const runDump = vi.fn();
    mkdirSync(destination);

    expect(() => generateSchemaSnapshot({ destinationPath: destination, runDump })).toThrow(
      "destino do snapshot SQL precisa ser um arquivo físico regular",
    );

    expect(runDump).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(["schema.generated.sql"]);
  });

  linkIt("rejects a symbolic destination before invoking the dump", () => {
    const { destination, root } = temporaryDestination({ createDestination: false });
    const external = resolve(root, "external.sql");
    const runDump = vi.fn();
    writeFileSync(external, "external remains unchanged\n", "utf8");
    symlinkSync(external, destination);

    expect(() => generateSchemaSnapshot({ destinationPath: destination, runDump })).toThrow(
      "destino do snapshot SQL precisa ser um arquivo físico regular",
    );

    expect(runDump).not.toHaveBeenCalled();
    expect(readFileSync(external, "utf8")).toBe("external remains unchanged\n");
    expect(readdirSync(root).sort()).toEqual(["external.sql", "schema.generated.sql"]);
  });

  it("publishes a new snapshot with the repository file mode", () => {
    const { destination, root } = temporaryDestination({ createDestination: false });

    generateSchemaSnapshot({
      destinationPath: destination,
      runDump: (temporaryPath) => {
        writeFileSync(temporaryPath, `${validSchemaDump}\n\n`, "utf8");
      },
    });

    expect(readFileSync(destination, "utf8")).toBe(`${validSchemaDump}\n`);
    if (process.platform !== "win32") {
      expect(statSync(destination).mode & 0o777).toBe(0o644);
    }
    expect(readdirSync(root)).toEqual(["schema.generated.sql"]);
  });
});

describe("schema snapshot normalization", () => {
  it("keeps exactly one trailing newline", () => {
    expect(normalizeSchemaSnapshot("select 1;\n\n \t")).toBe("select 1;\n");
  });
});
