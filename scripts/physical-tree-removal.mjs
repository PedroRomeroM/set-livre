import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import {
  assertWindowsPathWithoutReparse,
  assertWindowsPrivateFile,
} from "./windows-filesystem-security.mjs";

const linuxMountEscapes = new Map([
  ["011", "\t"],
  ["012", "\n"],
  ["040", " "],
  ["134", "\\"],
]);

function samePhysicalNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function decodeLinuxMountField(value) {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    const escape = value.slice(index + 1, index + 4);
    const replacement = linuxMountEscapes.get(escape);
    if (replacement === undefined) {
      throw new Error("mountinfo inválido");
    }
    decoded += replacement;
    index += 3;
  }
  if (decoded.includes("\0")) {
    throw new Error("mountinfo inválido");
  }
  return decoded;
}

function parseLinuxMountPoints(source) {
  if (typeof source !== "string" || source === "") {
    throw new Error("mountinfo inválido");
  }

  const rawLines = source.split("\n");
  if (rawLines.at(-1) === "") {
    rawLines.pop();
  }
  if (rawLines.length === 0 || rawLines.some((line) => line === "")) {
    throw new Error("mountinfo inválido");
  }

  return rawLines.map((line) => {
    const fields = line.split(" ");
    const separatorIndex = fields.indexOf("-");
    if (
      fields.some((field) => field === "") ||
      separatorIndex < 6 ||
      separatorIndex !== fields.lastIndexOf("-") ||
      separatorIndex + 4 !== fields.length ||
      !/^\d+$/u.test(fields[0] ?? "") ||
      !/^\d+$/u.test(fields[1] ?? "") ||
      !/^\d+:\d+$/u.test(fields[2] ?? "") ||
      fields[5] === ""
    ) {
      throw new Error("mountinfo inválido");
    }

    const mountRoot = decodeLinuxMountField(fields[3] ?? "");
    const mountPoint = decodeLinuxMountField(fields[4] ?? "");
    const fileSystemType = fields[separatorIndex + 1];
    const mountSource = fields[separatorIndex + 2];
    const canonicalMountRoot = isAbsolute(mountRoot) && resolve(mountRoot) === mountRoot;
    const namespaceMountRoot =
      fileSystemType === "nsfs" &&
      mountSource === "nsfs" &&
      /^[a-z][a-z0-9_-]*:\[\d+\]$/u.test(mountRoot);
    if (
      (!canonicalMountRoot && !namespaceMountRoot) ||
      !isAbsolute(mountPoint) ||
      resolve(mountPoint) !== mountPoint
    ) {
      throw new Error("mountinfo inválido");
    }
    return mountPoint;
  });
}

export function readCurrentLinuxMountInformation() {
  return readFileSync("/proc/self/mountinfo", "utf8");
}

function sameStablePhysicalFileSnapshot(left, right) {
  return (
    samePhysicalNode(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function privateFileMessages(description) {
  return {
    ancestryChanged: `${description} mudou de caminho durante a leitura segura.`,
    ancestryRequired: `${description} precisa permanecer sob ancestrais físicos.`,
    fileChanged: `${description} mudou durante a leitura segura.`,
    fileRequired: `${description} precisa ser um arquivo físico regular exclusivo.`,
    invalidPath: `${description} precisa usar um caminho absoluto canônico.`,
    ownershipRequired: `${description} precisa pertencer ao usuário efetivo em sistemas POSIX.`,
    privateModeRequired: `${description} precisa usar modo 0600 em sistemas POSIX.`,
    textRequired: `${description} precisa ser lido como texto.`,
  };
}

function captureStablePhysicalAncestry(filePath, messages) {
  const pathRoot = parse(filePath).root;
  let current = pathRoot;
  const ancestry = [];

  for (const component of [
    "",
    ...relative(pathRoot, dirname(filePath)).split(sep).filter(Boolean),
  ]) {
    if (component !== "") {
      current = resolve(current, component);
    }
    const information = lstatSync(current, { bigint: true, throwIfNoEntry: false });
    if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
      throw new Error(messages.ancestryRequired);
    }
    ancestry.push({ information, path: current });
  }

  return ancestry;
}

function assertStablePhysicalAncestry(ancestry, messages) {
  for (const { information, path } of ancestry) {
    const currentInformation = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (
      currentInformation === undefined ||
      !currentInformation.isDirectory() ||
      currentInformation.isSymbolicLink() ||
      !samePhysicalNode(information, currentInformation)
    ) {
      throw new Error(messages.ancestryChanged);
    }
  }
}

function assertPrivatePhysicalFile(information, messages, platform, expectedPosixUserId) {
  if (
    information === undefined ||
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.nlink !== 1n
  ) {
    throw new Error(messages.fileRequired);
  }
  if (platform !== "win32" && (information.mode & 0o7777n) !== 0o600n) {
    throw new Error(messages.privateModeRequired);
  }
  if (
    platform !== "win32" &&
    (!Number.isSafeInteger(expectedPosixUserId) ||
      expectedPosixUserId < 0 ||
      information.uid !== BigInt(expectedPosixUserId))
  ) {
    throw new Error(messages.ownershipRequired);
  }
}

export function readPrivatePhysicalFile(
  filePath,
  {
    allowMissing = false,
    assertWindowsPrivate = assertWindowsPrivateFile,
    description = "O arquivo privado",
    expectedPosixUserId = process.geteuid?.(),
    platform = process.platform,
    readDescriptor = (descriptor) => readFileSync(descriptor, "utf8"),
  } = {},
) {
  const messages = privateFileMessages(description);
  if (
    typeof filePath !== "string" ||
    filePath === "" ||
    filePath.includes("\0") ||
    !isAbsolute(filePath) ||
    resolve(filePath) !== filePath ||
    dirname(filePath) === filePath
  ) {
    throw new Error(messages.invalidPath);
  }

  if (platform === "win32") {
    assertWindowsPrivate(filePath, {
      allowMissing,
      description,
    });
  }

  const ancestry = captureStablePhysicalAncestry(filePath, messages);
  const pathInformation = lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
  if (pathInformation === undefined && allowMissing) {
    assertStablePhysicalAncestry(ancestry, messages);
    return undefined;
  }
  assertPrivatePhysicalFile(pathInformation, messages, platform, expectedPosixUserId);
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(descriptor, { bigint: true });
    assertPrivatePhysicalFile(openedInformation, messages, platform, expectedPosixUserId);
    if (!sameStablePhysicalFileSnapshot(pathInformation, openedInformation)) {
      throw new Error(messages.fileChanged);
    }
    assertStablePhysicalAncestry(ancestry, messages);

    const source = readDescriptor(descriptor);
    if (typeof source !== "string") {
      throw new Error(messages.textRequired);
    }

    const finalDescriptorInformation = fstatSync(descriptor, { bigint: true });
    const finalPathInformation = lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    assertPrivatePhysicalFile(finalDescriptorInformation, messages, platform, expectedPosixUserId);
    assertPrivatePhysicalFile(finalPathInformation, messages, platform, expectedPosixUserId);
    if (
      !sameStablePhysicalFileSnapshot(openedInformation, finalDescriptorInformation) ||
      !sameStablePhysicalFileSnapshot(openedInformation, finalPathInformation)
    ) {
      throw new Error(messages.fileChanged);
    }
    assertStablePhysicalAncestry(ancestry, messages);
    if (platform === "win32") {
      assertWindowsPrivate(filePath, { description });
    }
    return source;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function assertPhysicalAncestry(path, { ancestryMessage, ancestryRootMessage }) {
  const pathRoot = parse(path).root;
  let current = pathRoot;
  const rootInformation = lstatSync(pathRoot, { throwIfNoEntry: false });
  if (
    rootInformation === undefined ||
    !rootInformation.isDirectory() ||
    rootInformation.isSymbolicLink()
  ) {
    throw new Error(ancestryRootMessage);
  }

  for (const component of relative(pathRoot, dirname(path)).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const information = lstatSync(current, { throwIfNoEntry: false });
    if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
      throw new Error(ancestryMessage);
    }
  }
}

function assertNoLinuxMountAtOrBelow(
  directory,
  { mountDetectedMessage, mountUnverifiedMessage, readLinuxMountInformation },
) {
  let mountPoints;
  try {
    mountPoints = parseLinuxMountPoints(readLinuxMountInformation());
  } catch {
    throw new Error(mountUnverifiedMessage);
  }

  if (mountPoints.some((mountPoint) => isInside(directory, mountPoint))) {
    throw new Error(mountDetectedMessage);
  }
}

function physicalNodeKind(information, unsafeNodeMessage) {
  if (information.isSymbolicLink()) {
    return "link";
  }
  if (information.isDirectory()) {
    return "directory";
  }
  if (information.isFile()) {
    return "file";
  }
  throw new Error(unsafeNodeMessage);
}

function inspectPhysicalTree(
  directory,
  expectedDevice,
  { changedInspectionMessage, invalidPathMessage, mountDetectedMessage, unsafeNodeMessage },
) {
  const nodes = new Map();
  const pending = [{ path: directory, relativePath: "" }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    const information = lstatSync(current.path, { throwIfNoEntry: false });
    if (information === undefined) {
      throw new Error(changedInspectionMessage);
    }
    const kind = physicalNodeKind(information, unsafeNodeMessage);
    if (information.dev !== expectedDevice) {
      throw new Error(mountDetectedMessage);
    }
    nodes.set(current.relativePath, {
      dev: information.dev,
      ino: information.ino,
      kind,
    });

    // Links, inclusive junctions reconhecidas pelo runtime, são folhas e nunca são atravessados.
    if (kind !== "directory") {
      continue;
    }

    const names = readdirSync(current.path).sort();
    const finalInformation = lstatSync(current.path, { throwIfNoEntry: false });
    if (
      finalInformation === undefined ||
      finalInformation.isSymbolicLink() ||
      !finalInformation.isDirectory() ||
      !samePhysicalNode(information, finalInformation) ||
      finalInformation.dev !== expectedDevice
    ) {
      throw new Error(changedInspectionMessage);
    }

    for (const name of names.toReversed()) {
      const childPath = resolve(current.path, name);
      if (name === "" || dirname(childPath) !== current.path) {
        throw new Error(invalidPathMessage);
      }
      pending.push({
        path: childPath,
        relativePath: current.relativePath === "" ? name : `${current.relativePath}${sep}${name}`,
      });
    }
  }

  return nodes;
}

function assertSamePhysicalTree(expected, actual, changedRetirementMessage) {
  if (expected.size !== actual.size) {
    throw new Error(changedRetirementMessage);
  }
  for (const [relativePath, expectedNode] of expected) {
    const actualNode = actual.get(relativePath);
    if (
      actualNode === undefined ||
      actualNode.dev !== expectedNode.dev ||
      actualNode.ino !== expectedNode.ino ||
      actualNode.kind !== expectedNode.kind
    ) {
      throw new Error(changedRetirementMessage);
    }
  }
}

function removalMessages(description, overrides = {}) {
  return {
    ancestryMessage:
      overrides.ancestryMessage ?? `${description} atravessa um diretório ancestral não físico.`,
    ancestryRootMessage:
      overrides.ancestryRootMessage ?? `${description} possui uma raiz de caminho não física.`,
    changedInspectionMessage:
      overrides.changedInspectionMessage ?? `${description} mudou durante a inspeção física.`,
    changedRetirementMessage:
      overrides.changedRetirementMessage ?? `${description} mudou durante o retiro atômico.`,
    directoryRequiredMessage:
      overrides.directoryRequiredMessage ?? `${description} precisa ser um diretório físico.`,
    invalidPathMessage:
      overrides.invalidPathMessage ?? `${description} contém um caminho inválido.`,
    mountDetectedMessage:
      overrides.mountDetectedMessage ?? `${description} não pode ser um mount nem conter mounts.`,
    mountUnverifiedMessage:
      overrides.mountUnverifiedMessage ??
      `Não foi possível comprovar que ${description.toLocaleLowerCase("pt-BR")} não contém mounts.`,
    notRemovedMessage:
      overrides.notRemovedMessage ?? `${description} não pôde ser removido integralmente.`,
    retirementCollisionMessage:
      overrides.retirementCollisionMessage ??
      `Não foi possível reservar o retiro físico de ${description.toLocaleLowerCase("pt-BR")}.`,
    unsafeNodeMessage:
      overrides.unsafeNodeMessage ?? `${description} contém um nó não removível com segurança.`,
    unsupportedPlatformMessage:
      overrides.unsupportedPlatformMessage ??
      `${description} precisa ser removido manualmente nesta plataforma.`,
    windowsUnauthorizedPathMessage:
      overrides.windowsUnauthorizedPathMessage ??
      `${description} não é um alvo autorizado para remoção física no Windows.`,
  };
}

function assertAuthorizedWindowsRemoval(path, authorizedWindowsPaths, messages) {
  if (
    !Array.isArray(authorizedWindowsPaths) ||
    !authorizedWindowsPaths.some(
      (authorizedPath) =>
        typeof authorizedPath === "string" &&
        authorizedPath !== "" &&
        !authorizedPath.includes("\0") &&
        isAbsolute(authorizedPath) &&
        resolve(authorizedPath) === authorizedPath &&
        resolve(authorizedPath).toLowerCase() === path.toLowerCase(),
    )
  ) {
    throw new Error(messages.windowsUnauthorizedPathMessage);
  }
}

function assertWindowsPhysicalTree(path, description, assertWindowsPath) {
  assertWindowsPath(path, {
    description,
    leafKind: "directory",
    recursive: true,
  });
}

function inspectPhysicalDirectoryTree(
  directory,
  {
    description = "A árvore física",
    assertWindowsPath = assertWindowsPathWithoutReparse,
    messages: messageOverrides,
    platform = process.platform,
    readLinuxMountInformation = readCurrentLinuxMountInformation,
    windowsPathAlreadyInspected = false,
  } = {},
) {
  const resolvedDirectory = resolve(directory);
  const messages = removalMessages(description, messageOverrides);
  if (platform === "win32" && !windowsPathAlreadyInspected) {
    assertWindowsPhysicalTree(resolvedDirectory, description, assertWindowsPath);
  }
  assertPhysicalAncestry(resolvedDirectory, messages);
  const information = lstatSync(resolvedDirectory, { throwIfNoEntry: false });
  if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(messages.directoryRequiredMessage);
  }
  const parentInformation = lstatSync(dirname(resolvedDirectory), { throwIfNoEntry: false });
  if (
    parentInformation === undefined ||
    !parentInformation.isDirectory() ||
    parentInformation.isSymbolicLink() ||
    information.dev !== parentInformation.dev
  ) {
    throw new Error(messages.mountDetectedMessage);
  }
  if (platform === "linux") {
    assertNoLinuxMountAtOrBelow(resolvedDirectory, {
      ...messages,
      readLinuxMountInformation,
    });
  }
  const nodes = inspectPhysicalTree(resolvedDirectory, information.dev, messages);
  return { information, nodes, path: resolvedDirectory };
}

export function assertPhysicalDirectoryTree(directory, options = {}) {
  return inspectPhysicalDirectoryTree(directory, options);
}

export function removePhysicalTree(
  path,
  {
    allowRegularFile = false,
    assertWindowsPath = assertWindowsPathWithoutReparse,
    authorizedWindowsPaths = [],
    description = "A árvore física",
    messages: messageOverrides,
    platform = process.platform,
    readLinuxMountInformation = readCurrentLinuxMountInformation,
    retiredNamePrefix = `.${basename(path)}.retired-`,
    uuid = randomUUID,
  } = {},
) {
  const resolvedPath = resolve(path);
  const messages = removalMessages(description, messageOverrides);
  if (platform === "win32") {
    assertWindowsPath(resolvedPath, {
      allowMissingLeaf: true,
      description,
      leafKind: "any",
      recursive: true,
    });
  }
  const initialInformation = lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (initialInformation === undefined) {
    return;
  }
  if (dirname(resolvedPath) === resolvedPath) {
    throw new Error(messages.invalidPathMessage);
  }

  if (initialInformation.isFile() && !initialInformation.isSymbolicLink() && allowRegularFile) {
    if (platform === "win32") {
      assertAuthorizedWindowsRemoval(resolvedPath, authorizedWindowsPaths, messages);
    }
    assertPhysicalAncestry(resolvedPath, messages);
    unlinkSync(resolvedPath);
    if (lstatSync(resolvedPath, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(messages.notRemovedMessage);
    }
    return;
  }

  if (!initialInformation.isDirectory() || initialInformation.isSymbolicLink()) {
    throw new Error(messages.directoryRequiredMessage);
  }
  if (platform !== "linux" && platform !== "win32") {
    throw new Error(messages.unsupportedPlatformMessage);
  }
  if (platform === "win32") {
    assertAuthorizedWindowsRemoval(resolvedPath, authorizedWindowsPaths, messages);
  }

  const initialTree = inspectPhysicalDirectoryTree(resolvedPath, {
    assertWindowsPath,
    description,
    messages,
    platform,
    readLinuxMountInformation,
    windowsPathAlreadyInspected: platform === "win32",
  });
  const retiredPath = resolve(dirname(resolvedPath), `${retiredNamePrefix}${uuid()}`);
  if (dirname(retiredPath) !== dirname(resolvedPath)) {
    throw new Error(messages.invalidPathMessage);
  }
  if (lstatSync(retiredPath, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(messages.retirementCollisionMessage);
  }

  renameSync(resolvedPath, retiredPath);
  const retiredInformation = lstatSync(retiredPath, { throwIfNoEntry: false });
  if (
    retiredInformation === undefined ||
    !retiredInformation.isDirectory() ||
    retiredInformation.isSymbolicLink() ||
    !samePhysicalNode(initialTree.information, retiredInformation) ||
    lstatSync(resolvedPath, { throwIfNoEntry: false }) !== undefined
  ) {
    throw new Error(messages.changedRetirementMessage);
  }

  if (platform === "linux") {
    assertNoLinuxMountAtOrBelow(retiredPath, {
      ...messages,
      readLinuxMountInformation,
    });
  } else {
    assertWindowsPhysicalTree(retiredPath, description, assertWindowsPath);
  }
  assertSamePhysicalTree(
    initialTree.nodes,
    inspectPhysicalTree(retiredPath, initialTree.information.dev, messages),
    messages.changedRetirementMessage,
  );
  // A inspeção da forma pode levar tempo; confirme o namespace novamente no último instante
  // observável antes da única operação recursiva.
  if (platform === "linux") {
    assertNoLinuxMountAtOrBelow(retiredPath, {
      ...messages,
      readLinuxMountInformation,
    });
  } else {
    assertWindowsPhysicalTree(retiredPath, description, assertWindowsPath);
  }

  rmSync(retiredPath, { recursive: true });
  if (lstatSync(retiredPath, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(messages.notRemovedMessage);
  }
}
