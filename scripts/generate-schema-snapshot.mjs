import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultDestination = resolve(repositoryRoot, "supabase/schema.generated.sql");
const requiredSchemaNames = ["audit", "private", "public"];

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularDestination(destinationPath) {
  const information = lstatSync(destinationPath, { throwIfNoEntry: false });
  if (information === undefined) {
    return 0o644;
  }
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("O destino do snapshot SQL precisa ser um arquivo físico regular.");
  }
  return information.mode & 0o777;
}

function assertRegularTemporary(temporaryPath, expectedInformation) {
  const information = lstatSync(temporaryPath, { throwIfNoEntry: false });
  if (
    information === undefined ||
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.nlink !== 1 ||
    (expectedInformation !== undefined && !samePhysicalFile(information, expectedInformation))
  ) {
    throw new Error("O dump do schema precisa permanecer em um arquivo físico regular.");
  }
  return information;
}

function removeTemporary(temporaryPath) {
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

export function normalizeSchemaSnapshot(contents) {
  return `${contents.trimEnd()}\n`;
}

function validateSchemaSnapshot(contents) {
  if (contents.trim() === "") {
    throw new Error("O dump do schema local está vazio.");
  }

  for (const schemaName of requiredSchemaNames) {
    const declaration = new RegExp(
      `^CREATE\\s+SCHEMA(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(?:"${schemaName}"|${schemaName})\\s*;`,
      "imu",
    );
    if (!declaration.test(contents)) {
      throw new Error(`O dump do schema local não declara o schema ${schemaName}.`);
    }
  }
}

export function generateSchemaSnapshot({
  destinationPath = defaultDestination,
  normalizeSnapshot = normalizeSchemaSnapshot,
  runDump,
} = {}) {
  if (typeof runDump !== "function") {
    throw new Error("O gerador do snapshot SQL exige um executor de dump.");
  }

  const resolvedDestination = resolve(destinationPath);
  const destinationMode = assertRegularDestination(resolvedDestination);
  const temporaryPath = resolve(
    dirname(resolvedDestination),
    `.${basename(resolvedDestination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryDescriptor;
  let temporaryOwned = false;

  try {
    temporaryDescriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryOwned = true;
    const createdInformation = fstatSync(temporaryDescriptor);
    if (!createdInformation.isFile() || createdInformation.nlink !== 1) {
      throw new Error("O temporário do snapshot SQL precisa ser um arquivo físico exclusivo.");
    }
    closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;

    runDump(temporaryPath);
    const pathInformation = assertRegularTemporary(temporaryPath, createdInformation);

    temporaryDescriptor = openSync(temporaryPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(temporaryDescriptor);
    if (
      !openedInformation.isFile() ||
      openedInformation.nlink !== 1 ||
      !samePhysicalFile(pathInformation, openedInformation)
    ) {
      throw new Error("O dump do schema mudou durante a abertura.");
    }

    const normalized = normalizeSnapshot(readFileSync(temporaryDescriptor, "utf8"));
    if (typeof normalized !== "string") {
      throw new Error("A normalização do snapshot SQL precisa retornar texto.");
    }
    validateSchemaSnapshot(normalized);

    const normalizedBuffer = Buffer.from(normalized, "utf8");
    ftruncateSync(temporaryDescriptor, 0);
    let writtenBytes = 0;
    while (writtenBytes < normalizedBuffer.length) {
      const currentWrite = writeSync(
        temporaryDescriptor,
        normalizedBuffer,
        writtenBytes,
        normalizedBuffer.length - writtenBytes,
        writtenBytes,
      );
      if (currentWrite === 0) {
        throw new Error("A publicação do snapshot SQL não conseguiu avançar a escrita.");
      }
      writtenBytes += currentWrite;
    }
    fchmodSync(temporaryDescriptor, destinationMode);
    fsyncSync(temporaryDescriptor);

    assertRegularTemporary(temporaryPath, openedInformation);
    closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    renameSync(temporaryPath, resolvedDestination);
    temporaryOwned = false;
  } finally {
    if (temporaryDescriptor !== undefined) {
      closeSync(temporaryDescriptor);
    }
    if (temporaryOwned) {
      removeTemporary(temporaryPath);
    }
  }
}
