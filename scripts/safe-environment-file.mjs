import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

function destinationState(destinationPath) {
  const parentPath = dirname(destinationPath);
  const parent = lstatSync(parentPath, { throwIfNoEntry: false });
  if (parent === undefined || !parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error(`O diretório do ambiente não é um diretório físico: ${parentPath}.`);
  }

  const destination = lstatSync(destinationPath, { throwIfNoEntry: false });
  if (destination === undefined) {
    return undefined;
  }
  if (!destination.isFile() || destination.isSymbolicLink()) {
    throw new Error(`O destino do ambiente não é um arquivo regular: ${destinationPath}.`);
  }

  return {
    ctimeMs: destination.ctimeMs,
    device: destination.dev,
    inode: destination.ino,
    modifiedAtMs: destination.mtimeMs,
    size: destination.size,
  };
}

function destinationIsUnchanged(before, after) {
  if (before === undefined || after === undefined) {
    return before === after;
  }

  return (
    before.ctimeMs === after.ctimeMs &&
    before.device === after.device &&
    before.inode === after.inode &&
    before.modifiedAtMs === after.modifiedAtMs &&
    before.size === after.size
  );
}

export function assertSafeEnvironmentFileDestination(destinationPath) {
  if (!isAbsolute(destinationPath)) {
    throw new Error("O destino do ambiente precisa usar caminho absoluto.");
  }

  destinationState(destinationPath);
}

export function writeEnvironmentFileAtomic(destinationPath, contents) {
  if (typeof contents !== "string") {
    throw new TypeError("O conteúdo do ambiente precisa ser texto.");
  }
  if (!isAbsolute(destinationPath)) {
    throw new Error("O destino do ambiente precisa usar caminho absoluto.");
  }

  const before = destinationState(destinationPath);
  const parentPath = dirname(destinationPath);
  const temporaryPath = join(
    parentPath,
    `.${basename(destinationPath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const openFlags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let descriptor;
  let published = false;

  try {
    descriptor = openSync(temporaryPath, openFlags, 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    const after = destinationState(destinationPath);
    if (!destinationIsUnchanged(before, after)) {
      throw new Error(`O destino do ambiente mudou durante a escrita: ${destinationPath}.`);
    }

    renameSync(temporaryPath, destinationPath);
    published = true;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (!published) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
  }
}
