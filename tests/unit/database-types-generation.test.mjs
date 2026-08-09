import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  generateDatabaseTypes,
  validateGeneratedDatabaseTypes,
} from "../../scripts/generate-database-types.mjs";

const temporaryRoots = [];
const validGeneratedContract = `
export type Json = string | number | boolean | null;
export type Database = {
  public: {
    Tables: Record<string, never>;
  };
};
`;

function temporaryDestination() {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-database-types-"));
  temporaryRoots.push(root);
  const destination = resolve(root, "database.generated.ts");
  writeFileSync(destination, "known-good-contract\n", "utf8");
  return { destination, root };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("atomic database type generation", () => {
  it("publishes validated output and removes the sibling temporary file", async () => {
    const { destination, root } = temporaryDestination();

    await generateDatabaseTypes({
      destinationPath: destination,
      formatTypes: async (contents) => contents.trimStart(),
      runGenerator: (outputDescriptor, temporaryPath) => {
        expect(dirname(temporaryPath)).toBe(root);
        writeSync(outputDescriptor, validGeneratedContract);
      },
    });

    expect(readFileSync(destination, "utf8")).toBe(validGeneratedContract.trimStart());
    expect(readdirSync(root)).toEqual(["database.generated.ts"]);
  });

  it("preserves the tracked contract and cleans partial output when generation fails", async () => {
    const { destination, root } = temporaryDestination();

    await expect(
      generateDatabaseTypes({
        destinationPath: destination,
        formatTypes: async (contents) => contents,
        runGenerator: (outputDescriptor) => {
          writeSync(outputDescriptor, "partial generated output");
          throw new Error("supabase generation failed");
        },
      }),
    ).rejects.toThrow("supabase generation failed");

    expect(readFileSync(destination, "utf8")).toBe("known-good-contract\n");
    expect(readdirSync(root)).toEqual(["database.generated.ts"]);
  });

  it("preserves the tracked contract and cleans generated output when formatting fails", async () => {
    const { destination, root } = temporaryDestination();

    await expect(
      generateDatabaseTypes({
        destinationPath: destination,
        formatTypes: async () => {
          throw new Error("formatting failed");
        },
        runGenerator: (outputDescriptor) => {
          writeSync(outputDescriptor, validGeneratedContract);
        },
      }),
    ).rejects.toThrow("formatting failed");

    expect(readFileSync(destination, "utf8")).toBe("known-good-contract\n");
    expect(readdirSync(root)).toEqual(["database.generated.ts"]);
  });

  it("preserves the tracked contract when generated output is invalid", async () => {
    const { destination, root } = temporaryDestination();

    await expect(
      generateDatabaseTypes({
        destinationPath: destination,
        formatTypes: async (contents) => contents,
        runGenerator: (outputDescriptor) => {
          writeSync(outputDescriptor, "export type Database = { public:");
        },
      }),
    ).rejects.toThrow("contrato TypeScript esperado");

    expect(readFileSync(destination, "utf8")).toBe("known-good-contract\n");
    expect(readdirSync(root)).toEqual(["database.generated.ts"]);
  });

  it("rejects syntactically invalid output even when its contract markers are present", () => {
    expect(() =>
      validateGeneratedDatabaseTypes(
        "export type Json = string; export type Database = { public: ;",
      ),
    ).toThrow("sintaticamente válido");
  });
});
