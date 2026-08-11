import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

const localDatabaseHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const dalRoleOptions = "-c role=app_dal";
const expectedPsqlVersion = "18.4";
const maximumSymbolicLinkDepth = 40;
const trustedLaunchMarker = Symbol("trusted-local-psql-launch");

function parseLocalDatabaseUrl(databaseUrl, assumeDalRole) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("A URL destinada ao psql local é inválida.");
  }

  let username;
  let password;
  let databaseName;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("A identidade destinada ao psql local é inválida.");
  }

  const hasExpectedDalOptions =
    parsed.searchParams.size === 1 && parsed.searchParams.get("options") === dalRoleOptions;
  if (
    parsed.protocol !== "postgresql:" ||
    !localDatabaseHostnames.has(parsed.hostname) ||
    parsed.port !== "54322" ||
    username === "" ||
    username.includes("\0") ||
    password === "" ||
    password.includes("\0") ||
    databaseName !== "postgres" ||
    parsed.hash !== "" ||
    (assumeDalRole ? !hasExpectedDalOptions : parsed.search !== "")
  ) {
    throw new Error("O psql só pode acessar a instância PostgreSQL local esperada.");
  }

  return { databaseName, password, username };
}

function samePhysicalNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function snapshotInformation(path, kind, information, extra = {}) {
  return Object.freeze({
    path,
    kind,
    dev: information.dev.toString(),
    ino: information.ino.toString(),
    uid: information.uid.toString(),
    gid: information.gid.toString(),
    mode: information.mode.toString(),
    nlink: information.nlink.toString(),
    ...extra,
  });
}

function assertProtectedOwnership(path, information, trustedOwnerId, label) {
  if (information.uid !== BigInt(trustedOwnerId) || (information.mode & 0o022n) !== 0n) {
    throw new Error(`${label} de psql não é protegido pelo proprietário confiável: ${path}.`);
  }
}

function assertInsideTrustAnchor(path, trustAnchorPath) {
  const displacement = relative(trustAnchorPath, path);
  if (displacement === ".." || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)) {
    throw new Error("O caminho de psql escapou da raiz de confiança.");
  }
}

function inspectProtectedDirectory(path, trustedOwnerId) {
  let descriptor;
  try {
    const pathInformation = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (
      pathInformation === undefined ||
      !pathInformation.isDirectory() ||
      pathInformation.isSymbolicLink()
    ) {
      throw new Error(`O ancestral de psql precisa ser um diretório físico: ${path}.`);
    }
    assertProtectedOwnership(path, pathInformation, trustedOwnerId, "O ancestral");
    if ((pathInformation.mode & 0o111n) === 0n) {
      throw new Error(`O ancestral de psql não é atravessável: ${path}.`);
    }

    if (constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) {
      throw new Error("A plataforma não oferece abertura POSIX segura para o psql.");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const openedInformation = fstatSync(descriptor, { bigint: true });
    const finalInformation = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (
      !openedInformation.isDirectory() ||
      finalInformation === undefined ||
      !finalInformation.isDirectory() ||
      finalInformation.isSymbolicLink() ||
      !samePhysicalNode(pathInformation, openedInformation) ||
      !samePhysicalNode(openedInformation, finalInformation) ||
      pathInformation.mode !== openedInformation.mode ||
      openedInformation.mode !== finalInformation.mode ||
      pathInformation.uid !== openedInformation.uid ||
      openedInformation.uid !== finalInformation.uid ||
      pathInformation.gid !== openedInformation.gid ||
      openedInformation.gid !== finalInformation.gid ||
      pathInformation.nlink !== openedInformation.nlink ||
      openedInformation.nlink !== finalInformation.nlink
    ) {
      throw new Error(`O ancestral de psql mudou durante a inspeção: ${path}.`);
    }

    return snapshotInformation(path, "directory", openedInformation);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function inspectPhysicalAncestry(path, trustAnchorPath, trustedOwnerId, snapshots) {
  assertInsideTrustAnchor(path, trustAnchorPath);
  const parentPath = dirname(path);
  assertInsideTrustAnchor(parentPath, trustAnchorPath);
  const components = relative(trustAnchorPath, parentPath).split(sep).filter(Boolean);
  let current = trustAnchorPath;
  for (const component of [undefined, ...components]) {
    if (component !== undefined) {
      current = resolve(current, component);
    }
    const snapshot = inspectProtectedDirectory(current, trustedOwnerId);
    const previous = snapshots.get(current);
    if (previous !== undefined && !isDeepStrictEqual(previous, snapshot)) {
      throw new Error(`O ancestral de psql mudou entre inspeções: ${current}.`);
    }
    snapshots.set(current, snapshot);
  }
}

function inspectSymbolicLink(path, information, trustedOwnerId) {
  if (information.uid !== BigInt(trustedOwnerId) || information.nlink !== 1n) {
    throw new Error(`O link simbólico de psql não pertence à instalação confiável: ${path}.`);
  }
  const target = readlinkSync(path, "utf8");
  const finalInformation = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (
    target === "" ||
    target.includes("\0") ||
    finalInformation === undefined ||
    !finalInformation.isSymbolicLink() ||
    !samePhysicalNode(information, finalInformation) ||
    information.uid !== finalInformation.uid ||
    information.gid !== finalInformation.gid ||
    information.mode !== finalInformation.mode ||
    information.nlink !== finalInformation.nlink ||
    readlinkSync(path, "utf8") !== target
  ) {
    throw new Error(`O link simbólico de psql mudou durante a inspeção: ${path}.`);
  }
  return snapshotInformation(path, "symbolic-link", finalInformation, { target });
}

function inspectProtectedExecutable(path, information, trustedOwnerId) {
  let descriptor;
  try {
    assertProtectedOwnership(path, information, trustedOwnerId, "O executável");
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.nlink !== 1n ||
      (information.mode & 0o111n) === 0n ||
      (information.mode & 0o6000n) !== 0n
    ) {
      throw new Error(`O psql precisa ser um executável físico protegido: ${path}.`);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedInformation = fstatSync(descriptor, { bigint: true });
    const finalInformation = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (
      !openedInformation.isFile() ||
      finalInformation === undefined ||
      !finalInformation.isFile() ||
      finalInformation.isSymbolicLink() ||
      !samePhysicalNode(information, openedInformation) ||
      !samePhysicalNode(openedInformation, finalInformation) ||
      information.uid !== openedInformation.uid ||
      openedInformation.uid !== finalInformation.uid ||
      information.gid !== openedInformation.gid ||
      openedInformation.gid !== finalInformation.gid ||
      information.mode !== openedInformation.mode ||
      openedInformation.mode !== finalInformation.mode ||
      information.nlink !== openedInformation.nlink ||
      openedInformation.nlink !== finalInformation.nlink ||
      information.size !== openedInformation.size ||
      openedInformation.size !== finalInformation.size ||
      information.mtimeNs !== openedInformation.mtimeNs ||
      openedInformation.mtimeNs !== finalInformation.mtimeNs ||
      information.ctimeNs !== openedInformation.ctimeNs ||
      openedInformation.ctimeNs !== finalInformation.ctimeNs
    ) {
      throw new Error(`O executável psql mudou durante a inspeção: ${path}.`);
    }
    return snapshotInformation(path, "file", openedInformation, {
      ctimeNs: openedInformation.ctimeNs.toString(),
      mtimeNs: openedInformation.mtimeNs.toString(),
      size: openedInformation.size.toString(),
    });
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function inspectTrustedPsql(command, trustAnchorPath, trustedOwnerId) {
  const snapshots = new Map();
  const visitedLinks = new Set();
  let current = command;

  for (let depth = 0; depth <= maximumSymbolicLinkDepth; depth += 1) {
    inspectPhysicalAncestry(current, trustAnchorPath, trustedOwnerId, snapshots);
    const information = lstatSync(current, { bigint: true, throwIfNoEntry: false });
    if (information === undefined) {
      throw new Error(`O executável psql não existe: ${current}.`);
    }
    if (!information.isSymbolicLink()) {
      const fileSnapshot = inspectProtectedExecutable(current, information, trustedOwnerId);
      snapshots.set(current, fileSnapshot);
      return Object.freeze({
        command,
        nodes: Object.freeze([...snapshots.values()]),
        target: current,
      });
    }

    if (visitedLinks.has(current)) {
      throw new Error("A cadeia de links simbólicos do psql contém um ciclo.");
    }
    visitedLinks.add(current);
    const linkSnapshot = inspectSymbolicLink(current, information, trustedOwnerId);
    snapshots.set(current, linkSnapshot);
    current = isAbsolute(linkSnapshot.target)
      ? resolve(linkSnapshot.target)
      : resolve(dirname(current), linkSnapshot.target);
    assertInsideTrustAnchor(current, trustAnchorPath);
  }

  throw new Error("A cadeia de links simbólicos do psql excede o limite seguro.");
}

function canonicalAbsolutePath(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    !path.includes("\0") &&
    isAbsolute(path) &&
    resolve(path) === path
  );
}

function resolvePsqlCandidate(pathValue, trustAnchorPath, trustedOwnerId) {
  if (typeof pathValue !== "string" || pathValue === "" || pathValue.includes("\0")) {
    throw new Error("PATH precisa listar caminhos absolutos canônicos para localizar o psql.");
  }
  const searchDirectories = pathValue.split(":");
  if (searchDirectories.some((directory) => !canonicalAbsolutePath(directory))) {
    throw new Error("PATH precisa listar somente caminhos absolutos canônicos para o psql.");
  }

  for (const searchDirectory of searchDirectories) {
    const candidate = resolve(searchDirectory, "psql");
    const information = lstatSync(candidate, { bigint: true, throwIfNoEntry: false });
    if (information !== undefined) {
      return inspectTrustedPsql(candidate, trustAnchorPath, trustedOwnerId);
    }
  }
  throw new Error("Nenhum executável psql foi encontrado no PATH confiável.");
}

function assertSameSnapshot(expected, current) {
  if (!isDeepStrictEqual(expected, current)) {
    throw new Error("A instalação psql mudou depois do preflight confiável.");
  }
}

function assertTrustedLaunchSnapshot(launch) {
  if (
    launch?.[trustedLaunchMarker] !== true ||
    !canonicalAbsolutePath(launch.command) ||
    !canonicalAbsolutePath(launch.trustAnchorPath) ||
    launch.platform === "win32"
  ) {
    throw new Error("O preflight confiável do psql é obrigatório.");
  }
  assertSameSnapshot(
    launch.snapshot,
    inspectTrustedPsql(launch.command, launch.trustAnchorPath, launch.trustedOwnerId),
  );
}

function fixedPsqlLocaleEnvironment() {
  return { LANG: "C", LC_ALL: "C" };
}

export function redactLocalPsqlDiagnostics(stderr, redactions = []) {
  return (stderr ?? "")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/giu, "$1[REDACTED]@")
    .split("\n")
    .map((line) =>
      redactions.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), line),
    )
    .filter(Boolean)
    .slice(-12)
    .join("\n");
}

export function resolveTrustedLocalPsql({
  executeVersion = spawnSync,
  inheritedEnvironment = process.env,
  platform = process.platform,
  trustAnchorPath = parse(resolve(import.meta.dirname)).root,
  trustedOwnerId = 0,
} = {}) {
  if (platform === "win32" || process.platform === "win32") {
    throw new Error(
      "O setup local com psql exige POSIX; no Windows a prova sem reparse point não está disponível.",
    );
  }
  if (platform !== process.platform) {
    throw new Error("A plataforma informada para o preflight de psql não corresponde ao processo.");
  }
  if (!canonicalAbsolutePath(trustAnchorPath)) {
    throw new Error("A raiz de confiança do psql precisa ser absoluta e canônica.");
  }
  if (!Number.isSafeInteger(trustedOwnerId) || trustedOwnerId < 0) {
    throw new Error("O proprietário confiável do psql é inválido.");
  }
  if (constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) {
    throw new Error("A plataforma não oferece a inspeção POSIX exigida para o psql.");
  }

  const snapshot = resolvePsqlCandidate(inheritedEnvironment.PATH, trustAnchorPath, trustedOwnerId);
  const result = executeVersion(snapshot.command, ["--version"], {
    cwd: trustAnchorPath,
    encoding: "utf8",
    env: fixedPsqlLocaleEnvironment(),
    shell: false,
    stdio: "pipe",
    timeout: 5_000,
  });
  const versionMatch =
    typeof result.stdout === "string"
      ? /^psql \(PostgreSQL\) (18\.4)(?: \([^()\r\n]+\))?\r?\n?$/u.exec(result.stdout)
      : null;
  if (result.status !== 0 || result.stderr !== "" || versionMatch?.[1] !== expectedPsqlVersion) {
    throw new Error(
      `O executável psql precisa informar exatamente PostgreSQL ${expectedPsqlVersion}.`,
    );
  }
  assertSameSnapshot(
    snapshot,
    inspectTrustedPsql(snapshot.command, trustAnchorPath, trustedOwnerId),
  );

  return Object.freeze({
    [trustedLaunchMarker]: true,
    command: snapshot.command,
    platform,
    snapshot,
    trustAnchorPath,
    trustedOwnerId,
    version: expectedPsqlVersion,
  });
}

export function createLocalPsqlEnvironment(password, { assumeDalRole = false } = {}) {
  if (typeof password !== "string" || password === "" || password.includes("\0")) {
    throw new Error("A senha local do psql é obrigatória.");
  }

  return {
    ...fixedPsqlLocaleEnvironment(),
    ...(assumeDalRole ? { PGOPTIONS: dalRoleOptions } : {}),
    PGPASSWORD: password,
  };
}

export function localPsqlArguments(databaseUrl, { assumeDalRole = false } = {}) {
  const { databaseName, username } = parseLocalDatabaseUrl(databaseUrl, assumeDalRole);
  return [
    "--host",
    "127.0.0.1",
    "--port",
    "54322",
    "--username",
    username,
    "--dbname",
    databaseName,
    "--no-password",
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
  ];
}

export function spawnLocalPsql(
  trustedLaunch,
  databaseUrl,
  { assumeDalRole = false, command, executePsql = spawnSync, input } = {},
) {
  assertTrustedLaunchSnapshot(trustedLaunch);
  const { password } = parseLocalDatabaseUrl(databaseUrl, assumeDalRole);
  const argumentsList = localPsqlArguments(databaseUrl, { assumeDalRole });
  if (command !== undefined) {
    if (typeof command !== "string" || command === "" || command.includes("\0")) {
      throw new Error("O comando SQL local do psql é inválido.");
    }
    argumentsList.push("--tuples-only", "--no-align", "--command", command);
  }
  const environment = createLocalPsqlEnvironment(password, {
    assumeDalRole,
  });
  assertTrustedLaunchSnapshot(trustedLaunch);
  let result;
  try {
    result = executePsql(trustedLaunch.command, argumentsList, {
      cwd: trustedLaunch.trustAnchorPath,
      encoding: "utf8",
      env: environment,
      input,
      shell: false,
      stdio: "pipe",
    });
  } finally {
    assertTrustedLaunchSnapshot(trustedLaunch);
  }
  return { argumentsList, result };
}
