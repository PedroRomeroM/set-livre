import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

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
  };
}

export function assertPhysicalDirectoryTree(
  directory,
  {
    description = "A árvore física",
    messages: messageOverrides,
    platform = process.platform,
    readLinuxMountInformation = readCurrentLinuxMountInformation,
  } = {},
) {
  const resolvedDirectory = resolve(directory);
  const messages = removalMessages(description, messageOverrides);
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

export function removePhysicalTree(
  path,
  {
    allowRegularFile = false,
    description = "A árvore física",
    messages: messageOverrides,
    platform = process.platform,
    readLinuxMountInformation = readCurrentLinuxMountInformation,
    retiredNamePrefix = `.${basename(path)}.retired-`,
    uuid = randomUUID,
  } = {},
) {
  const resolvedPath = resolve(path);
  const initialInformation = lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (initialInformation === undefined) {
    return;
  }
  const messages = removalMessages(description, messageOverrides);
  if (dirname(resolvedPath) === resolvedPath) {
    throw new Error(messages.invalidPathMessage);
  }

  if (initialInformation.isFile() && !initialInformation.isSymbolicLink() && allowRegularFile) {
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
  if (platform !== "linux") {
    throw new Error(messages.unsupportedPlatformMessage);
  }

  const initialTree = assertPhysicalDirectoryTree(resolvedPath, {
    description,
    messages,
    platform,
    readLinuxMountInformation,
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

  assertNoLinuxMountAtOrBelow(retiredPath, {
    ...messages,
    readLinuxMountInformation,
  });
  assertSamePhysicalTree(
    initialTree.nodes,
    inspectPhysicalTree(retiredPath, initialTree.information.dev, messages),
    messages.changedRetirementMessage,
  );
  // A inspeção da forma pode levar tempo; confirme o namespace novamente no último instante
  // observável antes da única operação recursiva.
  assertNoLinuxMountAtOrBelow(retiredPath, {
    ...messages,
    readLinuxMountInformation,
  });

  rmSync(retiredPath, { recursive: true });
  if (lstatSync(retiredPath, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(messages.notRemovedMessage);
  }
}
