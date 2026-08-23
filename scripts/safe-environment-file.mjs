import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import {
  assertWindowsPathWithoutReparse,
  assertWindowsPrivateFile,
  protectWindowsPrivateFile,
} from "./windows-filesystem-security.mjs";

const defaultRepositoryRoot = resolve(import.meta.dirname, "..");

function samePhysicalNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertCanonicalAbsolutePath(path, label) {
  if (typeof path === "string" && path !== "" && !path.includes("\0") && !isAbsolute(path)) {
    throw new Error(`${label} precisa usar caminho absoluto.`);
  }
  if (
    typeof path !== "string" ||
    path === "" ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    throw new Error(`${label} precisa usar caminho absoluto canônico.`);
  }
}

function assertDestinationInsideRepository(destinationPath) {
  assertCanonicalAbsolutePath(defaultRepositoryRoot, "A raiz do repositório");
  assertCanonicalAbsolutePath(destinationPath, "O destino do ambiente");

  const displacement = relative(defaultRepositoryRoot, destinationPath);
  if (
    displacement === "" ||
    displacement === ".." ||
    displacement.startsWith(`..${sep}`) ||
    isAbsolute(displacement)
  ) {
    throw new Error("O destino do ambiente precisa permanecer sob a raiz do repositório.");
  }
}

function inspectPhysicalDirectory(path) {
  const pathInformation = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (
    pathInformation === undefined ||
    !pathInformation.isDirectory() ||
    pathInformation.isSymbolicLink()
  ) {
    throw new Error(
      "O diretório do ambiente não é um diretório físico; raiz e ancestrais físicos são obrigatórios.",
    );
  }

  let descriptor;
  try {
    if (constants.O_DIRECTORY !== undefined && constants.O_NOFOLLOW !== undefined) {
      descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    }
    const openedInformation =
      descriptor === undefined ? pathInformation : fstatSync(descriptor, { bigint: true });
    const finalInformation = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (
      !openedInformation.isDirectory() ||
      finalInformation === undefined ||
      !finalInformation.isDirectory() ||
      finalInformation.isSymbolicLink() ||
      !samePhysicalNode(pathInformation, openedInformation) ||
      !samePhysicalNode(openedInformation, finalInformation)
    ) {
      throw new Error("Os ancestrais físicos do ambiente mudaram durante a inspeção.");
    }

    return { descriptor, information: openedInformation, path };
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    throw error;
  }
}

function closePhysicalAncestry(ancestry) {
  let closeError;
  for (const entry of ancestry.toReversed()) {
    if (entry.descriptor === undefined) {
      continue;
    }
    try {
      closeSync(entry.descriptor);
    } catch (error) {
      closeError ??= error;
    }
  }
  return closeError;
}

function capturePhysicalAncestry(destinationPath, security) {
  assertDestinationInsideRepository(destinationPath);
  if (security.platform === "win32") {
    security.assertWindowsPath(destinationPath, {
      allowMissingLeaf: true,
      description: "O destino do ambiente",
      leafKind: "any",
    });
    security.assertWindowsPrivate(destinationPath, {
      allowMissing: true,
      description: "O destino do ambiente",
      trustedRoot: security.trustedRoot,
    });
  }

  const fileSystemRoot = parse(defaultRepositoryRoot).root;
  const destinationParent = dirname(destinationPath);
  const ancestry = [];
  let current = fileSystemRoot;

  try {
    ancestry.push(inspectPhysicalDirectory(current));
    for (const component of relative(fileSystemRoot, destinationParent)
      .split(sep)
      .filter(Boolean)) {
      current = resolve(current, component);
      ancestry.push(inspectPhysicalDirectory(current));
    }
    assertStablePhysicalAncestry(ancestry);
    return ancestry;
  } catch (error) {
    closePhysicalAncestry(ancestry);
    throw error;
  }
}

function assertStablePhysicalAncestry(ancestry) {
  for (const entry of ancestry) {
    const descriptorInformation =
      entry.descriptor === undefined
        ? entry.information
        : fstatSync(entry.descriptor, { bigint: true });
    const pathInformation = lstatSync(entry.path, { bigint: true, throwIfNoEntry: false });
    if (
      !descriptorInformation.isDirectory() ||
      pathInformation === undefined ||
      !pathInformation.isDirectory() ||
      pathInformation.isSymbolicLink() ||
      !samePhysicalNode(entry.information, descriptorInformation) ||
      !samePhysicalNode(descriptorInformation, pathInformation)
    ) {
      throw new Error("Os ancestrais físicos do ambiente mudaram durante a operação.");
    }
  }
}

function destinationState(destinationPath) {
  const destination = lstatSync(destinationPath, { bigint: true, throwIfNoEntry: false });
  if (destination === undefined) {
    return undefined;
  }
  if (!destination.isFile() || destination.isSymbolicLink()) {
    throw new Error(`O destino do ambiente não é um arquivo regular: ${destinationPath}.`);
  }

  return {
    ctimeNs: destination.ctimeNs,
    device: destination.dev,
    inode: destination.ino,
    mode: destination.mode,
    modifiedAtNs: destination.mtimeNs,
    links: destination.nlink,
    size: destination.size,
  };
}

function destinationIsUnchanged(before, after) {
  if (before === undefined || after === undefined) {
    return before === after;
  }

  return (
    before.ctimeNs === after.ctimeNs &&
    before.device === after.device &&
    before.inode === after.inode &&
    before.mode === after.mode &&
    before.modifiedAtNs === after.modifiedAtNs &&
    before.links === after.links &&
    before.size === after.size
  );
}

function assertTemporaryFile(
  descriptor,
  temporaryPath,
  parentDevice,
  expectedSize,
  security,
  verifyWindowsPrivacy = false,
) {
  const descriptorInformation = fstatSync(descriptor, { bigint: true });
  const pathInformation = lstatSync(temporaryPath, { bigint: true, throwIfNoEntry: false });
  if (
    !descriptorInformation.isFile() ||
    descriptorInformation.nlink !== 1n ||
    descriptorInformation.dev !== parentDevice ||
    pathInformation === undefined ||
    !pathInformation.isFile() ||
    pathInformation.isSymbolicLink() ||
    pathInformation.nlink !== 1n ||
    !samePhysicalNode(descriptorInformation, pathInformation) ||
    (expectedSize !== undefined &&
      (descriptorInformation.size !== expectedSize || pathInformation.size !== expectedSize)) ||
    (security.platform !== "win32" &&
      ((descriptorInformation.mode & 0o7777n) !== 0o600n ||
        (pathInformation.mode & 0o7777n) !== 0o600n))
  ) {
    throw new Error("O temporário do ambiente mudou durante a escrita segura.");
  }

  if (verifyWindowsPrivacy && security.platform === "win32") {
    security.assertWindowsPrivate(temporaryPath, {
      description: "O temporário do ambiente",
      trustedRoot: security.trustedRoot,
    });
  }

  return descriptorInformation;
}

function assertPublishedTemporary(
  descriptor,
  destinationPath,
  temporaryInformation,
  expectedSize,
  security,
) {
  const descriptorInformation = fstatSync(descriptor, { bigint: true });
  const publishedInformation = lstatSync(destinationPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    !descriptorInformation.isFile() ||
    descriptorInformation.nlink !== 1n ||
    descriptorInformation.size !== expectedSize ||
    !samePhysicalNode(temporaryInformation, descriptorInformation) ||
    publishedInformation === undefined ||
    !publishedInformation.isFile() ||
    publishedInformation.isSymbolicLink() ||
    publishedInformation.nlink !== 1n ||
    publishedInformation.size !== expectedSize ||
    !samePhysicalNode(descriptorInformation, publishedInformation) ||
    (security.platform !== "win32" &&
      ((descriptorInformation.mode & 0o7777n) !== 0o600n ||
        (publishedInformation.mode & 0o7777n) !== 0o600n))
  ) {
    throw new Error("O destino do ambiente mudou durante a publicação atômica.");
  }
  if (security.platform === "win32") {
    security.assertWindowsPrivate(destinationPath, {
      description: "O destino publicado do ambiente",
      trustedRoot: security.trustedRoot,
    });
  }
}

function removeOwnedTemporary(temporaryPath, temporaryInformation, ancestry, security) {
  if (temporaryInformation === undefined) {
    return;
  }
  assertStablePhysicalAncestry(ancestry);
  const pathInformation = lstatSync(temporaryPath, { bigint: true, throwIfNoEntry: false });
  if (pathInformation === undefined) {
    return;
  }
  if (
    !pathInformation.isFile() ||
    pathInformation.isSymbolicLink() ||
    pathInformation.nlink !== 1n ||
    !samePhysicalNode(temporaryInformation, pathInformation)
  ) {
    throw new Error("O temporário do ambiente não pode ser removido com segurança.");
  }
  if (security.platform === "win32") {
    security.assertWindowsPrivate(temporaryPath, {
      description: "O temporário do ambiente",
      trustedRoot: security.trustedRoot,
    });
  }
  unlinkSync(temporaryPath);
  assertStablePhysicalAncestry(ancestry);
}

function environmentFileSecurity(options = {}) {
  return {
    assertWindowsPath: options.assertWindowsPath ?? assertWindowsPathWithoutReparse,
    assertWindowsPrivate: options.assertWindowsPrivate ?? assertWindowsPrivateFile,
    platform: options.platform ?? process.platform,
    protectWindowsPrivate: options.protectWindowsPrivate ?? protectWindowsPrivateFile,
    trustedRoot: defaultRepositoryRoot,
  };
}

export function assertSafeEnvironmentFileDestination(destinationPath, options = {}) {
  const security = environmentFileSecurity(options);
  const ancestry = capturePhysicalAncestry(destinationPath, security);
  let failure;
  try {
    destinationState(destinationPath);
    assertStablePhysicalAncestry(ancestry);
  } catch (error) {
    failure = error;
  }

  const closeError = closePhysicalAncestry(ancestry);
  if (failure !== undefined) {
    throw failure;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
}

export function writeEnvironmentFileAtomic(destinationPath, contents, options = {}) {
  if (typeof contents !== "string") {
    throw new TypeError("O conteúdo do ambiente precisa ser texto.");
  }

  const security = environmentFileSecurity(options);
  const ancestry = capturePhysicalAncestry(destinationPath, security);
  let before;
  let descriptor;
  let failure;
  let published = false;
  let temporaryPath;
  let temporaryInformation;

  try {
    before = destinationState(destinationPath);
    const parentPath = dirname(destinationPath);
    temporaryPath = resolve(
      parentPath,
      `.${basename(destinationPath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    const openFlags =
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    const parentDevice = ancestry.at(-1).information.dev;
    const expectedSize = BigInt(Buffer.byteLength(contents, "utf8"));

    assertStablePhysicalAncestry(ancestry);
    if (security.platform === "win32") {
      security.assertWindowsPrivate(destinationPath, {
        allowMissing: before === undefined,
        description: "O destino do ambiente",
        trustedRoot: security.trustedRoot,
      });
    }
    descriptor = openSync(temporaryPath, openFlags, 0o600);
    if (security.platform !== "win32") {
      fchmodSync(descriptor, 0o600);
    }
    temporaryInformation = assertTemporaryFile(
      descriptor,
      temporaryPath,
      parentDevice,
      undefined,
      security,
    );
    if (security.platform === "win32") {
      security.protectWindowsPrivate(temporaryPath, {
        description: "O temporário do ambiente",
        trustedRoot: security.trustedRoot,
      });
    }
    assertStablePhysicalAncestry(ancestry);

    writeFileSync(descriptor, contents, { encoding: "utf8" });
    if (security.platform !== "win32") {
      fchmodSync(descriptor, 0o600);
    }
    fsyncSync(descriptor);
    temporaryInformation = assertTemporaryFile(
      descriptor,
      temporaryPath,
      parentDevice,
      expectedSize,
      security,
      true,
    );
    assertStablePhysicalAncestry(ancestry);

    const after = destinationState(destinationPath);
    if (!destinationIsUnchanged(before, after)) {
      throw new Error(`O destino do ambiente mudou durante a escrita: ${destinationPath}.`);
    }
    if (security.platform === "win32") {
      security.assertWindowsPrivate(destinationPath, {
        allowMissing: after === undefined,
        description: "O destino do ambiente",
        trustedRoot: security.trustedRoot,
      });
    }
    assertStablePhysicalAncestry(ancestry);
    temporaryInformation = assertTemporaryFile(
      descriptor,
      temporaryPath,
      parentDevice,
      expectedSize,
      security,
    );

    renameSync(temporaryPath, destinationPath);
    assertPublishedTemporary(
      descriptor,
      destinationPath,
      temporaryInformation,
      expectedSize,
      security,
    );
    assertStablePhysicalAncestry(ancestry);
    closeSync(descriptor);
    descriptor = undefined;
    published = true;
  } catch (error) {
    failure = error;
  }

  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  if (!published && temporaryPath !== undefined) {
    try {
      removeOwnedTemporary(temporaryPath, temporaryInformation, ancestry, security);
    } catch (error) {
      failure ??= error;
    }
  }
  const closeError = closePhysicalAncestry(ancestry);
  failure ??= closeError;
  if (failure !== undefined) {
    throw failure;
  }
}
