import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, posix, resolve, win32 } from "node:path";

import { canonicalDockerCliPath, resolveTrustedDockerCli } from "./docker-local-context.mjs";
import { supabaseLocalNetworkName } from "./supabase-local-network.mjs";
import {
  assertWindowsTrustedPathIntegrity,
  createTrustedCliEnvironment,
} from "./trusted-npm-cli.mjs";

const safeSignalPattern = /^SIG[A-Z0-9]+$/u;
const repositoryRoot = resolve(import.meta.dirname, "..");
const supportedCliContracts = {
  linux: {
    x64: {
      executableRelativePath: "bin/supabase",
      packageName: "@supabase/cli-linux-x64",
    },
  },
  win32: {
    x64: {
      executableRelativePath: "bin/supabase.exe",
      packageName: "@supabase/cli-windows-x64",
    },
  },
};

function platformPathApi(platform) {
  return platform === "win32" ? win32 : posix;
}

function cliContract(platform, architecture) {
  const contract = supportedCliContracts[platform]?.[architecture];
  if (contract === undefined) {
    throw new Error("A CLI Supabase nativa só possui contrato para Windows/Linux x64.");
  }
  return contract;
}

export function canonicalSupabaseNativeCliPath({
  architecture = process.arch,
  platform = process.platform,
  root = repositoryRoot,
} = {}) {
  const pathApi = platformPathApi(platform);
  const contract = cliContract(platform, architecture);
  return pathApi.resolve(
    root,
    "node_modules",
    ...contract.packageName.split("/"),
    contract.executableRelativePath,
  );
}

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function physicalPathChain(filePath, pathApi) {
  const root = pathApi.parse(filePath).root;
  const components = pathApi.relative(root, filePath).split(pathApi.sep).filter(Boolean);
  const chain = [root];
  let current = root;
  for (const component of components) {
    current = pathApi.resolve(current, component);
    chain.push(current);
  }
  return chain;
}

function assertPhysicalPathEntry(information, path, { file, platform }) {
  if (
    information === undefined ||
    information.isSymbolicLink() ||
    (file ? !information.isFile() : !information.isDirectory())
  ) {
    throw new Error(`A cadeia física da CLI Supabase contém um caminho inválido: ${path}`);
  }
  if (platform !== "win32" && (information.mode & 0o022) !== 0) {
    throw new Error("A CLI Supabase nativa ou um ancestral possui permissões inseguras.");
  }
}

function inspectPhysicalFile(
  filePath,
  {
    assertWindowsIntegrity,
    closeFile,
    inspectDescriptor,
    inspectPath,
    openFile,
    platform,
    readFile,
    trustedRoot,
  },
) {
  const pathApi = platformPathApi(platform);
  const chain = physicalPathChain(filePath, pathApi);
  let initialInformation;
  for (const [index, path] of chain.entries()) {
    const information = inspectPath(path, { throwIfNoEntry: false });
    const file = index === chain.length - 1;
    assertPhysicalPathEntry(information, path, { file, platform });
    if (file) {
      initialInformation = information;
    }
  }

  let descriptor;
  try {
    descriptor = openFile(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = inspectDescriptor(descriptor);
    assertPhysicalPathEntry(openedInformation, filePath, { file: true, platform });
    if (!samePhysicalFile(initialInformation, openedInformation)) {
      throw new Error("A CLI Supabase nativa mudou durante a abertura.");
    }
    const contents = readFile === undefined ? undefined : readFile(descriptor, "utf8");

    if (platform === "win32") {
      assertWindowsIntegrity(filePath, { trustedRoot });
    }

    const finalDescriptorInformation = inspectDescriptor(descriptor);
    const finalPathInformation = inspectPath(filePath, { throwIfNoEntry: false });
    assertPhysicalPathEntry(finalDescriptorInformation, filePath, { file: true, platform });
    assertPhysicalPathEntry(finalPathInformation, filePath, { file: true, platform });
    if (
      !samePhysicalFile(openedInformation, finalDescriptorInformation) ||
      !samePhysicalFile(openedInformation, finalPathInformation)
    ) {
      throw new Error("A CLI Supabase nativa mudou durante a validação.");
    }
    return contents;
  } finally {
    if (descriptor !== undefined) {
      closeFile(descriptor);
    }
  }
}

function parsePackageJson(contents, label) {
  try {
    const parsed = JSON.parse(contents);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid-package");
    }
    return parsed;
  } catch {
    throw new Error(`${label} não contém package.json válido.`);
  }
}

export function resolveTrustedSupabaseNativeCli({
  architecture = process.arch,
  assertWindowsIntegrity = assertWindowsTrustedPathIntegrity,
  closeFile = closeSync,
  inspectDescriptor = fstatSync,
  inspectPath = lstatSync,
  openFile = openSync,
  platform = process.platform,
  readFile = readFileSync,
  root = repositoryRoot,
} = {}) {
  const pathApi = platformPathApi(platform);
  const contract = cliContract(platform, architecture);
  const packageRoot = pathApi.resolve(root, "node_modules", ...contract.packageName.split("/"));
  const executable = canonicalSupabaseNativeCliPath({ architecture, platform, root });
  const expectedExecutable = pathApi.resolve(packageRoot, contract.executableRelativePath);
  if (
    !pathApi.isAbsolute(executable) ||
    executable !== expectedExecutable ||
    pathApi.resolve(executable) !== executable ||
    executable.includes("\0")
  ) {
    throw new Error("A CLI Supabase nativa precisa usar o caminho absoluto canônico do pacote.");
  }

  const inspectionOptions = {
    assertWindowsIntegrity,
    closeFile,
    inspectDescriptor,
    inspectPath,
    openFile,
    platform,
    trustedRoot: root,
  };
  const rootManifest = parsePackageJson(
    inspectPhysicalFile(pathApi.resolve(root, "package.json"), {
      ...inspectionOptions,
      readFile,
    }),
    "O manifesto raiz",
  );
  const supabaseVersion = rootManifest.devDependencies?.supabase;
  if (typeof supabaseVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(supabaseVersion)) {
    throw new Error("A versão da CLI Supabase precisa estar fixada no manifesto raiz.");
  }

  const shimPackage = parsePackageJson(
    inspectPhysicalFile(pathApi.resolve(root, "node_modules/supabase/package.json"), {
      ...inspectionOptions,
      readFile,
    }),
    "O manifesto do pacote Supabase",
  );
  if (
    shimPackage.name !== "supabase" ||
    shimPackage.version !== supabaseVersion ||
    shimPackage.optionalDependencies?.[contract.packageName] !== supabaseVersion
  ) {
    throw new Error("O pacote Supabase instalado não fixa o binário nativo esperado.");
  }

  const nativePackage = parsePackageJson(
    inspectPhysicalFile(pathApi.resolve(packageRoot, "package.json"), {
      ...inspectionOptions,
      readFile,
    }),
    "O manifesto da CLI Supabase nativa",
  );
  if (
    nativePackage.name !== contract.packageName ||
    nativePackage.version !== supabaseVersion ||
    !Array.isArray(nativePackage.os) ||
    !nativePackage.os.includes(platform) ||
    !Array.isArray(nativePackage.cpu) ||
    !nativePackage.cpu.includes(architecture)
  ) {
    throw new Error("A CLI Supabase nativa instalada diverge de plataforma, CPU ou versão.");
  }

  inspectPhysicalFile(executable, inspectionOptions);
  return executable;
}

function sanitizedSupabaseFailure(error) {
  if (error !== null && typeof error === "object") {
    if (Number.isInteger(error.status)) {
      return new Error(`O comando Supabase local falhou com código ${error.status}.`);
    }
    if (typeof error.signal === "string" && safeSignalPattern.test(error.signal)) {
      return new Error(`O comando Supabase local falhou com sinal ${error.signal}.`);
    }
  }
  return new Error("O comando Supabase local falhou sem diagnóstico público.");
}

function closedSupabaseEnvironment(environment, platform, dockerDirectory) {
  const inherited = createTrustedCliEnvironment(environment, {
    additionalWindowsNames: ["DOCKER_HOST"],
    platform,
  });
  const allowedNames = new Set([
    "APPDATA",
    "CI",
    "DOCKER_HOST",
    "HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LANG",
    "LANGUAGE",
    "LC_ADDRESS",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_IDENTIFICATION",
    "LC_MEASUREMENT",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NAME",
    "LC_NUMERIC",
    "LC_PAPER",
    "LC_TELEPHONE",
    "LC_TIME",
    "LOCALAPPDATA",
    "NO_PROXY",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
  ]);
  const closedEnvironment = Object.fromEntries(
    Object.entries(inherited).filter(([name]) =>
      allowedNames.has(platform === "win32" ? name.toUpperCase() : name),
    ),
  );
  closedEnvironment.PATH = dockerDirectory;
  return closedEnvironment;
}

function executeInstalledSupabase(command, argumentsList, options) {
  return execFileSync(command, argumentsList, options);
}

export function executeSupabaseLocalCommand(
  argumentsList,
  {
    architecture = process.arch,
    capture = false,
    environment = process.env,
    executeCommand = executeInstalledSupabase,
    includeNetwork = true,
    platform = process.platform,
    resolveCli = resolveTrustedSupabaseNativeCli,
    resolveDockerCli = resolveTrustedDockerCli,
  } = {},
) {
  const networkArguments = includeNetwork ? ["--network-id", supabaseLocalNetworkName] : [];

  try {
    const command = resolveCli({ architecture, platform });
    const expectedCommand = canonicalSupabaseNativeCliPath({ architecture, platform });
    if (command !== expectedCommand) {
      throw new Error("A CLI Supabase validada diverge do caminho nativo canônico.");
    }
    const dockerCommand = resolveDockerCli({ platform });
    const expectedDockerCommand = canonicalDockerCliPath(platform);
    if (dockerCommand !== expectedDockerCommand) {
      throw new Error("A CLI Docker validada diverge do caminho canônico permitido.");
    }
    const dockerDirectory = dirname(dockerCommand);
    return executeCommand(
      command,
      ["--workdir", repositoryRoot, ...argumentsList, ...networkArguments],
      {
        cwd: dockerDirectory,
        encoding: "utf8",
        env: closedSupabaseEnvironment(environment, platform, dockerDirectory),
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"],
      },
    );
  } catch (error) {
    throw sanitizedSupabaseFailure(error);
  }
}
