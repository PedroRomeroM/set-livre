import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep, win32 } from "node:path";

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathApi(platform) {
  return platform === "win32"
    ? win32
    : { basename, dirname, isAbsolute, parse, relative, resolve, sep };
}

function canonicalPath(value, api) {
  return api.resolve(value) === value && !value.includes("\0");
}

export function assertTrustedNpmPathShape({
  nodeExecutable,
  npmCliPath,
  platform = process.platform,
}) {
  const api = pathApi(platform);
  for (const [label, value] of [
    ["Node", nodeExecutable],
    ["npm CLI", npmCliPath],
  ]) {
    if (
      typeof value !== "string" ||
      value === "" ||
      !api.isAbsolute(value) ||
      !canonicalPath(value, api)
    ) {
      throw new Error(`${label} precisa usar caminho absoluto canônico.`);
    }
  }

  if (api.basename(npmCliPath).toLowerCase() !== "npm-cli.js") {
    throw new Error("A CLI npm precisa identificar npm-cli.js.");
  }
}

function assertPhysicalAncestry(filePath) {
  const root = parse(filePath).root;
  let current = root;
  const rootInformation = lstatSync(root, { throwIfNoEntry: false });
  if (
    rootInformation === undefined ||
    !rootInformation.isDirectory() ||
    rootInformation.isSymbolicLink()
  ) {
    throw new Error("A raiz do caminho npm precisa ser um diretório físico.");
  }

  const parentPath = dirname(filePath);
  const components = relative(root, parentPath).split(sep).filter(Boolean);
  for (const component of components) {
    current = resolve(current, component);
    const information = lstatSync(current, { throwIfNoEntry: false });
    if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("O caminho npm atravessa um diretório não físico.");
    }
  }
}

function inspectPhysicalFile(filePath, label, readContents = false) {
  assertPhysicalAncestry(filePath);
  let descriptor;

  try {
    const pathInformation = lstatSync(filePath, { throwIfNoEntry: false });
    if (
      pathInformation === undefined ||
      !pathInformation.isFile() ||
      pathInformation.isSymbolicLink() ||
      (process.platform !== "win32" && (pathInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(`${label} precisa ser um arquivo físico regular protegido.`);
    }

    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(descriptor);
    if (
      !openedInformation.isFile() ||
      !samePhysicalFile(pathInformation, openedInformation) ||
      (process.platform !== "win32" && (openedInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(`${label} mudou durante a abertura.`);
    }

    const contents = readContents ? readFileSync(descriptor, "utf8") : undefined;
    const finalInformation = lstatSync(filePath, { throwIfNoEntry: false });
    if (
      finalInformation === undefined ||
      !finalInformation.isFile() ||
      finalInformation.isSymbolicLink() ||
      !samePhysicalFile(openedInformation, finalInformation) ||
      (process.platform !== "win32" && (finalInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(`${label} mudou durante a leitura.`);
    }

    return { contents, information: openedInformation };
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function parsePackageJson(contents, label) {
  try {
    const value = JSON.parse(contents);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid-package");
    }
    return value;
  } catch {
    throw new Error(`${label} não contém package.json válido.`);
  }
}

function expectedToolchainVersions(repositoryRoot) {
  const packagePath = resolve(repositoryRoot, "package.json");
  const packageJson = parsePackageJson(
    inspectPhysicalFile(packagePath, "Manifesto raiz", true).contents,
    "Manifesto raiz",
  );
  const packageManager = packageJson.packageManager;
  const match =
    typeof packageManager === "string" ? /^npm@(\d+\.\d+\.\d+)$/u.exec(packageManager) : null;
  const devEngine = packageJson.devEngines?.packageManager;
  const runtimeEngine = packageJson.devEngines?.runtime;
  if (
    match === null ||
    devEngine?.name !== "npm" ||
    devEngine.version !== match[1] ||
    runtimeEngine?.name !== "node" ||
    !/^\d+\.\d+\.\d+$/u.test(runtimeEngine.version)
  ) {
    throw new Error("O manifesto raiz não fixa versões Node/npm válidas.");
  }
  return { node: runtimeEngine.version, npm: match[1] };
}

function validateNpmInstallation(npmCliPath, nodeExecutable, expectedVersion, platform) {
  inspectPhysicalFile(npmCliPath, "npm CLI");
  const npmPackageRoot = resolve(dirname(npmCliPath), "..");
  const expectedNpmPackageRoot =
    platform === "win32"
      ? resolve(dirname(nodeExecutable), "node_modules/npm")
      : resolve(dirname(nodeExecutable), "../lib/node_modules/npm");
  const normalizedNpmPackageRoot =
    platform === "win32" ? npmPackageRoot.toLowerCase() : npmPackageRoot;
  const normalizedExpectedRoot =
    platform === "win32" ? expectedNpmPackageRoot.toLowerCase() : expectedNpmPackageRoot;
  if (normalizedNpmPackageRoot !== normalizedExpectedRoot) {
    throw new Error("npm-cli.js não pertence à instalação do Node atual.");
  }
  const npmPackagePath = resolve(npmPackageRoot, "package.json");
  const npmPackage = parsePackageJson(
    inspectPhysicalFile(npmPackagePath, "Manifesto npm", true).contents,
    "Manifesto npm",
  );
  const declaredCli = npmPackage.bin?.npm;
  if (
    npmPackage.name !== "npm" ||
    npmPackage.version !== expectedVersion ||
    typeof declaredCli !== "string" ||
    resolve(npmPackageRoot, declaredCli) !== npmCliPath
  ) {
    throw new Error("npm-cli.js não corresponde à versão npm fixada pelo repositório.");
  }
}

export function bundledNpmCliPath(nodeExecutable = process.execPath, platform = process.platform) {
  const api = pathApi(platform);
  return platform === "win32"
    ? api.resolve(api.dirname(nodeExecutable), "node_modules/npm/bin/npm-cli.js")
    : api.resolve(api.dirname(nodeExecutable), "../lib/node_modules/npm/bin/npm-cli.js");
}

export function resolveTrustedNpmCliLaunch({
  nodeExecutable = process.execPath,
  nodeVersion = process.versions.node,
  platform = process.platform,
  repositoryRoot = resolve(import.meta.dirname, ".."),
} = {}) {
  const npmCliPath = bundledNpmCliPath(nodeExecutable, platform);
  assertTrustedNpmPathShape({ nodeExecutable, npmCliPath, platform });
  inspectPhysicalFile(nodeExecutable, "Node");

  const expectedVersions = expectedToolchainVersions(repositoryRoot);
  if (nodeVersion !== expectedVersions.node) {
    throw new Error("O Node atual não corresponde à versão fixada pelo repositório.");
  }
  validateNpmInstallation(npmCliPath, nodeExecutable, expectedVersions.npm, platform);
  return {
    argumentPrefix: [npmCliPath],
    command: nodeExecutable,
    npmCliPath,
    npmVersion: expectedVersions.npm,
  };
}
