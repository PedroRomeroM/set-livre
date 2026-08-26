import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { format, resolveConfig } from "prettier";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");
const databaseArtifactPaths = {
  schema: resolve(repositoryRoot, "supabase/schema.generated.sql"),
  types: resolve(repositoryRoot, "packages/contracts/src/database.generated.ts"),
};

function siblingTemporaryPath(destination) {
  return resolve(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function writeAtomic(destination, contents) {
  const temporary = siblingTemporaryPath(destination);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await chmod(temporary, 0o644);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function normalizeSchemaSnapshot(contents) {
  return `${contents.trimEnd()}\n`;
}

export function validateSchemaSnapshot(contents) {
  if (contents.trim() === "") {
    throw new Error("O dump do schema local está vazio.");
  }

  for (const schema of ["audit", "private", "public"]) {
    const declaration = new RegExp(
      `^CREATE\\s+SCHEMA(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(?:"${schema}"|${schema})\\s*;`,
      "imu",
    );
    if (!declaration.test(contents)) {
      throw new Error(`O dump do schema local não declara o schema ${schema}.`);
    }
  }
}

export function validateGeneratedDatabaseTypes(contents) {
  if (
    contents.trim() === "" ||
    !contents.includes("export type Json =") ||
    !contents.includes("export type Database =") ||
    !contents.includes("public:")
  ) {
    throw new Error("A saída do Supabase não contém o contrato TypeScript esperado.");
  }

  const source = ts.createSourceFile(
    "database.generated.ts",
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length > 0) {
    throw new Error("A saída do Supabase não é TypeScript sintaticamente válido.");
  }
}

async function generateSchemaContents(runSupabase) {
  const temporary = siblingTemporaryPath(databaseArtifactPaths.schema);
  try {
    runSupabase(["db", "dump", "--local", "--schema", "public,private,audit", "--file", temporary]);
    const contents = normalizeSchemaSnapshot(await readFile(temporary, "utf8"));
    validateSchemaSnapshot(contents);
    return contents;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function generateTypesContents(runSupabase) {
  const generated = runSupabase(["gen", "types", "typescript", "--local", "--schema", "public"], {
    capture: true,
  });
  validateGeneratedDatabaseTypes(generated);
  const configuration = (await resolveConfig(databaseArtifactPaths.types, {
    editorconfig: true,
  })) ?? { tabWidth: 2 };
  const formatted = await format(generated, {
    ...configuration,
    filepath: databaseArtifactPaths.types,
  });
  validateGeneratedDatabaseTypes(formatted);
  return formatted;
}

export async function generateDatabaseArtifacts(runSupabase, { schema = true, types = true } = {}) {
  const schemaContents = schema ? await generateSchemaContents(runSupabase) : undefined;
  const typesContents = types ? await generateTypesContents(runSupabase) : undefined;

  if (schemaContents !== undefined) {
    await writeAtomic(databaseArtifactPaths.schema, schemaContents);
  }
  if (typesContents !== undefined) {
    await writeAtomic(databaseArtifactPaths.types, typesContents);
  }
}

export async function verifyDatabaseArtifacts(runSupabase) {
  const [trackedSchema, trackedTypes, generatedSchema, generatedTypes] = await Promise.all([
    readFile(databaseArtifactPaths.schema, "utf8"),
    readFile(databaseArtifactPaths.types, "utf8"),
    generateSchemaContents(runSupabase),
    generateTypesContents(runSupabase),
  ]);
  const stale = [];
  if (trackedSchema !== generatedSchema) stale.push("supabase/schema.generated.sql");
  if (trackedTypes !== generatedTypes) {
    stale.push("packages/contracts/src/database.generated.ts");
  }
  if (stale.length > 0) {
    throw new Error(
      `Artefatos gerados desatualizados: ${stale.join(", ")}. Execute npm run supabase:generate.`,
    );
  }
}
