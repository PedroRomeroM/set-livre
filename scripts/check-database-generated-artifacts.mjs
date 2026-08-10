import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultSchemaPath = resolve(repositoryRoot, "supabase/schema.generated.sql");
const defaultTypesPath = resolve(repositoryRoot, "packages/contracts/src/database.generated.ts");

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPhysicalAncestors(trustedRootPath, filePath, label) {
  const relativePath = relative(trustedRootPath, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${label} precisa permanecer dentro da raiz confiável.`);
  }

  const directoryParts = dirname(relativePath).split(sep).filter(Boolean);
  let currentDirectory = trustedRootPath;
  for (const directoryPart of [".", ...directoryParts]) {
    if (directoryPart !== ".") {
      currentDirectory = resolve(currentDirectory, directoryPart);
    }
    const information = lstatSync(currentDirectory, { throwIfNoEntry: false });
    if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
      throw new Error(`${label} exige diretórios ancestrais físicos.`);
    }
  }
}

function readPhysicalFile(filePath, label, expectedInformation) {
  const pathInformation = lstatSync(filePath, { throwIfNoEntry: false });
  if (
    pathInformation === undefined ||
    !pathInformation.isFile() ||
    pathInformation.isSymbolicLink() ||
    pathInformation.nlink !== 1
  ) {
    throw new Error(`${label} precisa ser um arquivo físico regular e exclusivo.`);
  }

  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedInformation = fstatSync(descriptor);
    if (
      !openedInformation.isFile() ||
      openedInformation.nlink !== 1 ||
      !samePhysicalFile(pathInformation, openedInformation) ||
      (expectedInformation !== undefined &&
        !samePhysicalFile(expectedInformation, openedInformation))
    ) {
      throw new Error(`${label} mudou durante a leitura segura.`);
    }
    return { contents: readFileSync(descriptor), information: openedInformation };
  } finally {
    closeSync(descriptor);
  }
}

function reserveSiblingTemporary(trustedRootPath, trackedPath, label) {
  assertPhysicalAncestors(trustedRootPath, trackedPath, label);
  const trackedExtension = extname(trackedPath);
  const temporaryPath = resolve(
    dirname(trackedPath),
    `.${basename(trackedPath)}.check.${process.pid}.${randomUUID()}.tmp${trackedExtension}`,
  );
  const descriptor = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const information = fstatSync(descriptor);
    if (!information.isFile() || information.nlink !== 1) {
      throw new Error("O destino temporário do gate precisa ser um arquivo físico exclusivo.");
    }
  } finally {
    closeSync(descriptor);
  }
  return temporaryPath;
}

function removeSiblingTemporary(trustedRootPath, temporaryPath) {
  if (temporaryPath === undefined) {
    return undefined;
  }
  try {
    assertPhysicalAncestors(trustedRootPath, temporaryPath, "O temporário do gate");
    unlinkSync(temporaryPath);
    return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    return new Error("Não foi possível remover um destino temporário do gate.", { cause: error });
  }
}

function assertStableContents(initialFile, currentFile, label) {
  if (!initialFile.contents.equals(currentFile.contents)) {
    throw new Error(`${label} mudou durante o gate.`);
  }
}

function primaryErrorMessage(error) {
  return error instanceof Error ? error.message : "O gate de contratos gerados falhou.";
}

export async function assertDatabaseGeneratedArtifactsCurrent({
  generateSchema,
  generateTypes,
  schemaPath = defaultSchemaPath,
  trustedRootPath = repositoryRoot,
  typesPath = defaultTypesPath,
} = {}) {
  if (typeof generateSchema !== "function" || typeof generateTypes !== "function") {
    throw new Error("O gate de contratos gerados exige os dois geradores locais.");
  }

  const resolvedTrustedRoot = resolve(trustedRootPath);
  const resolvedSchemaPath = resolve(schemaPath);
  const resolvedTypesPath = resolve(typesPath);
  assertPhysicalAncestors(resolvedTrustedRoot, resolvedSchemaPath, "O snapshot SQL rastreado");
  assertPhysicalAncestors(
    resolvedTrustedRoot,
    resolvedTypesPath,
    "O contrato TypeScript rastreado",
  );
  const trackedSchema = readPhysicalFile(resolvedSchemaPath, "O snapshot SQL rastreado");
  const trackedTypes = readPhysicalFile(resolvedTypesPath, "O contrato TypeScript rastreado");
  let temporarySchemaPath;
  let temporaryTypesPath;
  let primaryError;

  try {
    temporarySchemaPath = reserveSiblingTemporary(
      resolvedTrustedRoot,
      resolvedSchemaPath,
      "O snapshot SQL rastreado",
    );
    temporaryTypesPath = reserveSiblingTemporary(
      resolvedTrustedRoot,
      resolvedTypesPath,
      "O contrato TypeScript rastreado",
    );

    await generateSchema(temporarySchemaPath);
    assertPhysicalAncestors(resolvedTrustedRoot, temporarySchemaPath, "O snapshot SQL verificado");
    const generatedSchema = readPhysicalFile(temporarySchemaPath, "O snapshot SQL verificado");

    await generateTypes(temporaryTypesPath);
    assertPhysicalAncestors(
      resolvedTrustedRoot,
      temporaryTypesPath,
      "O contrato TypeScript verificado",
    );
    const generatedTypes = readPhysicalFile(temporaryTypesPath, "O contrato TypeScript verificado");

    assertPhysicalAncestors(resolvedTrustedRoot, temporarySchemaPath, "O snapshot SQL verificado");
    const finalGeneratedSchema = readPhysicalFile(
      temporarySchemaPath,
      "O snapshot SQL verificado",
      generatedSchema.information,
    );
    assertPhysicalAncestors(
      resolvedTrustedRoot,
      temporaryTypesPath,
      "O contrato TypeScript verificado",
    );
    const finalGeneratedTypes = readPhysicalFile(
      temporaryTypesPath,
      "O contrato TypeScript verificado",
      generatedTypes.information,
    );
    assertStableContents(generatedSchema, finalGeneratedSchema, "O snapshot SQL verificado");
    assertStableContents(generatedTypes, finalGeneratedTypes, "O contrato TypeScript verificado");

    assertPhysicalAncestors(resolvedTrustedRoot, resolvedSchemaPath, "O snapshot SQL rastreado");
    assertPhysicalAncestors(
      resolvedTrustedRoot,
      resolvedTypesPath,
      "O contrato TypeScript rastreado",
    );
    const finalTrackedSchema = readPhysicalFile(
      resolvedSchemaPath,
      "O snapshot SQL rastreado",
      trackedSchema.information,
    );
    const finalTrackedTypes = readPhysicalFile(
      resolvedTypesPath,
      "O contrato TypeScript rastreado",
      trackedTypes.information,
    );
    assertStableContents(trackedSchema, finalTrackedSchema, "O snapshot SQL rastreado");
    assertStableContents(trackedTypes, finalTrackedTypes, "O contrato TypeScript rastreado");

    const staleArtifacts = [];

    if (!finalTrackedSchema.contents.equals(finalGeneratedSchema.contents)) {
      staleArtifacts.push("supabase/schema.generated.sql");
    }
    if (!finalTrackedTypes.contents.equals(finalGeneratedTypes.contents)) {
      staleArtifacts.push("packages/contracts/src/database.generated.ts");
    }

    if (staleArtifacts.length > 0) {
      throw new Error(
        `Artefatos gerados do banco desatualizados: ${staleArtifacts.join(", ")}. Execute npm run supabase:generate e versione o resultado.`,
      );
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [
    removeSiblingTemporary(resolvedTrustedRoot, temporarySchemaPath),
    removeSiblingTemporary(resolvedTrustedRoot, temporaryTypesPath),
  ].filter((error) => error !== undefined);

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        primaryErrorMessage(primaryError),
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "A verificação passou, mas o cleanup seguro falhou.");
  }
}
