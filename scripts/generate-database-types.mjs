import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { format, resolveConfig } from "prettier";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");
const localSupabaseCommand = resolve(repositoryRoot, "scripts/supabase-local-command.mjs");
const defaultDestination = resolve(repositoryRoot, "packages/contracts/src/database.generated.ts");

function assertRegularDestination(destinationPath) {
  if (!existsSync(destinationPath)) {
    return 0o644;
  }
  const information = lstatSync(destinationPath);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("O destino dos tipos gerados precisa ser um arquivo físico regular.");
  }
  return information.mode & 0o777;
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
    throw new Error("A saída do Supabase não é um contrato TypeScript sintaticamente válido.");
  }
}

function runLocalGenerator(outputDescriptor) {
  execFileSync(process.execPath, [localSupabaseCommand, "types"], {
    cwd: repositoryRoot,
    stdio: ["ignore", outputDescriptor, "inherit"],
  });
}

async function formatGeneratedTypes(contents, destinationPath) {
  const configuration = await resolveConfig(destinationPath, { editorconfig: true });
  if (configuration === null) {
    throw new Error("Não foi possível resolver a configuração Prettier do repositório.");
  }
  return format(contents, { ...configuration, filepath: destinationPath });
}

export async function generateDatabaseTypes({
  destinationPath = defaultDestination,
  formatTypes = formatGeneratedTypes,
  runGenerator = runLocalGenerator,
} = {}) {
  const resolvedDestination = resolve(destinationPath);
  const destinationMode = assertRegularDestination(resolvedDestination);

  const temporaryPath = resolve(
    dirname(resolvedDestination),
    `.${basename(resolvedDestination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let outputDescriptor;

  try {
    outputDescriptor = openSync(temporaryPath, "wx", 0o600);
    await runGenerator(outputDescriptor, temporaryPath);
    closeSync(outputDescriptor);
    outputDescriptor = undefined;

    const generated = readFileSync(temporaryPath, "utf8");
    validateGeneratedDatabaseTypes(generated);
    const formatted = await formatTypes(generated, resolvedDestination);
    validateGeneratedDatabaseTypes(formatted);
    writeFileSync(temporaryPath, formatted, "utf8");
    chmodSync(temporaryPath, destinationMode);
    const syncDescriptor = openSync(temporaryPath, "r+");
    try {
      fsyncSync(syncDescriptor);
    } finally {
      closeSync(syncDescriptor);
    }
    renameSync(temporaryPath, resolvedDestination);
  } finally {
    if (outputDescriptor !== undefined) {
      closeSync(outputDescriptor);
    }
    rmSync(temporaryPath, { force: true });
  }
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  await generateDatabaseTypes();
}
