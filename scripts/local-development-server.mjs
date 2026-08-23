import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  spawnSupervisedProcess,
  superviseDevelopmentProcesses,
} from "./development-process-tree.mjs";
import { readLocalDevelopmentEnvironmentFile } from "./local-development-environment.mjs";
import { runLocalProductionPreviewProcessFlow } from "./local-production-process-tree.mjs";
import { removeNextBuildCache } from "./remove-next-build-cache.mjs";
import { readCurrentLinuxMountInformation, removePhysicalTree } from "./physical-tree-removal.mjs";
import {
  assertWindowsTrustedPathIntegrity,
  resolveTrustedNpmCliLaunch,
} from "./trusted-npm-cli.mjs";

const defaultRepositoryRoot = resolve(import.meta.dirname, "..");
const applicationContracts = {
  backoffice: {
    environmentPath: "apps/backoffice/.env.local",
    expectedApplicationUrl: "http://127.0.0.1:3001",
    manifestPath: "apps/backoffice/package.json",
    name: "backoffice",
    port: "3001",
    workingDirectory: "apps/backoffice",
  },
  web: {
    environmentPath: ".env.local",
    expectedApplicationUrl: "http://127.0.0.1:3000",
    manifestPath: "package.json",
    name: "aplicação pública",
    port: "3000",
    workingDirectory: ".",
  },
};

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function removePreviousBuildOutput(
  buildOutputPath,
  {
    assertWindowsPath,
    platform = process.platform,
    readLinuxMountInformation = readCurrentLinuxMountInformation,
  } = {},
) {
  removePhysicalTree(buildOutputPath, {
    authorizedWindowsPaths: [resolve(buildOutputPath)],
    description: "A saída .next anterior",
    messages: {
      ancestryMessage: "O caminho da CLI Next atravessa um diretório não físico.",
      ancestryRootMessage: "A raiz da CLI Next precisa ser um diretório físico.",
      notRemovedMessage: "A saída .next anterior não pôde ser removida integralmente.",
      retirementCollisionMessage:
        "Não foi possível reservar o retiro físico da saída .next anterior.",
      unsupportedPlatformMessage:
        "A saída .next anterior precisa ser removida manualmente nesta plataforma antes do preview.",
    },
    platform,
    readLinuxMountInformation,
    retiredNamePrefix: `.next.preview-retired-${process.pid}-`,
    ...(assertWindowsPath === undefined ? {} : { assertWindowsPath }),
  });
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
    throw new Error("A raiz da CLI Next precisa ser um diretório físico.");
  }

  for (const component of relative(root, dirname(filePath)).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const information = lstatSync(current, { throwIfNoEntry: false });
    if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("O caminho da CLI Next atravessa um diretório não físico.");
    }
  }
}

function readProtectedFile(
  filePath,
  label,
  {
    assertWindowsIntegrity = assertWindowsTrustedPathIntegrity,
    platform = process.platform,
    trustedRoot = dirname(filePath),
  } = {},
) {
  assertPhysicalAncestry(filePath);
  let descriptor;

  try {
    const pathInformation = lstatSync(filePath, { throwIfNoEntry: false });
    if (
      pathInformation === undefined ||
      !pathInformation.isFile() ||
      pathInformation.isSymbolicLink() ||
      (platform !== "win32" && (pathInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(`${label} precisa ser um arquivo físico regular protegido.`);
    }

    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(descriptor);
    if (
      !openedInformation.isFile() ||
      !samePhysicalFile(pathInformation, openedInformation) ||
      (platform !== "win32" && (openedInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(`${label} mudou durante a abertura.`);
    }

    const contents = readFileSync(descriptor, "utf8");
    const finalInformation = lstatSync(filePath, { throwIfNoEntry: false });
    if (
      finalInformation === undefined ||
      !finalInformation.isFile() ||
      finalInformation.isSymbolicLink() ||
      !samePhysicalFile(openedInformation, finalInformation) ||
      (platform !== "win32" && (finalInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(`${label} mudou durante a leitura.`);
    }

    if (platform === "win32") {
      assertWindowsIntegrity(filePath, { trustedRoot });
    }

    return contents;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function parsePackageJson(source, label) {
  try {
    const value = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid-package");
    }
    return value;
  } catch {
    throw new Error(`${label} não contém package.json válido.`);
  }
}

function applicationContract(application, repositoryRoot) {
  if (typeof application !== "string" || !Object.hasOwn(applicationContracts, application)) {
    throw new Error("A aplicação de desenvolvimento solicitada é inválida.");
  }

  const contract = applicationContracts[application];
  return {
    ...contract,
    environmentPath: resolve(repositoryRoot, contract.environmentPath),
    manifestPath: resolve(repositoryRoot, contract.manifestPath),
    workingDirectory: resolve(repositoryRoot, contract.workingDirectory),
  };
}

function assertNoUnexpectedNextEnvironmentFiles(workingDirectory, nextCommand) {
  const names =
    nextCommand === "dev"
      ? [".env", ".env.development", ".env.development.local"]
      : [".env", ".env.production", ".env.production.local"];

  for (const name of names) {
    const environmentPath = resolve(workingDirectory, name);
    if (lstatSync(environmentPath, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(
        `O servidor Next local aceita somente .env.local; remova ${environmentPath}.`,
      );
    }
  }
}

export function resolveTrustedNextCliLaunch({
  applicationManifestPath,
  assertWindowsIntegrity = assertWindowsTrustedPathIntegrity,
  nodeExecutable = process.execPath,
  nodeVersion = process.versions.node,
  platform = process.platform,
  repositoryRoot = defaultRepositoryRoot,
} = {}) {
  const resolvedApplicationManifestPath =
    applicationManifestPath ?? resolve(repositoryRoot, "package.json");
  const trustedRuntime = resolveTrustedNpmCliLaunch({
    assertWindowsIntegrity,
    nodeExecutable,
    nodeVersion,
    platform,
    repositoryRoot,
  });
  const nextFileSecurity = { assertWindowsIntegrity, platform, trustedRoot: repositoryRoot };
  const rootManifest = parsePackageJson(
    readProtectedFile(resolve(repositoryRoot, "package.json"), "Manifesto raiz", nextFileSecurity),
    "Manifesto raiz",
  );
  const expectedNextVersion = rootManifest.dependencies?.next;
  if (typeof expectedNextVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(expectedNextVersion)) {
    throw new Error("O manifesto raiz não fixa uma versão Next válida.");
  }
  const applicationManifest =
    resolvedApplicationManifestPath === resolve(repositoryRoot, "package.json")
      ? rootManifest
      : parsePackageJson(
          readProtectedFile(
            resolvedApplicationManifestPath,
            "Manifesto da aplicação",
            nextFileSecurity,
          ),
          "Manifesto da aplicação",
        );
  if (applicationManifest.dependencies?.next !== expectedNextVersion) {
    throw new Error("A aplicação não usa a versão Next fixada pelo repositório.");
  }

  const nextPackageRoot = resolve(repositoryRoot, "node_modules/next");
  const nextManifest = parsePackageJson(
    readProtectedFile(resolve(nextPackageRoot, "package.json"), "Manifesto Next", nextFileSecurity),
    "Manifesto Next",
  );
  const declaredCli = nextManifest.bin?.next;
  const nextCliPath = resolve(nextPackageRoot, "dist/bin/next");
  if (
    nextManifest.name !== "next" ||
    nextManifest.version !== expectedNextVersion ||
    typeof declaredCli !== "string" ||
    resolve(nextPackageRoot, declaredCli) !== nextCliPath
  ) {
    throw new Error("A CLI Next não corresponde à versão fixada pelo repositório.");
  }
  readProtectedFile(nextCliPath, "CLI Next", nextFileSecurity);

  return {
    argumentPrefix: [nextCliPath],
    command: trustedRuntime.command,
    nextCliPath,
    nextVersion: expectedNextVersion,
  };
}

function createLocalApplicationServerLaunch({
  application,
  detached = process.platform !== "win32",
  environmentOptions,
  fileSecurityOptions,
  inheritedEnvironment = process.env,
  nextCommand,
  platform = process.platform,
  repositoryRoot = defaultRepositoryRoot,
  runtimeMode = "local",
} = {}) {
  if (runtimeMode !== "local" && runtimeMode !== "test") {
    throw new Error("O modo do servidor de desenvolvimento é inválido.");
  }

  const contract = applicationContract(application, repositoryRoot);
  if (nextCommand !== "dev" && nextCommand !== "start") {
    throw new Error("O comando do servidor local é inválido.");
  }
  assertNoUnexpectedNextEnvironmentFiles(contract.workingDirectory, nextCommand);
  const environment = {
    ...readLocalDevelopmentEnvironmentFile(
      contract.environmentPath,
      inheritedEnvironment,
      contract.expectedApplicationUrl,
      { ...fileSecurityOptions, trustedRoot: repositoryRoot },
      { ...environmentOptions, platform },
    ),
    APP_ENV: runtimeMode,
  };
  const trustedNext = resolveTrustedNextCliLaunch({
    applicationManifestPath: contract.manifestPath,
    assertWindowsIntegrity: fileSecurityOptions?.assertWindowsIntegrity,
    platform: fileSecurityOptions?.platform ?? process.platform,
    repositoryRoot,
  });

  return {
    argumentsList: [
      ...trustedNext.argumentPrefix,
      nextCommand,
      "--hostname",
      "127.0.0.1",
      "--port",
      contract.port,
    ],
    command: trustedNext.command,
    name: contract.name,
    options: {
      cwd: contract.workingDirectory,
      detached,
      env: environment,
      shell: false,
      stdio: "inherit",
    },
  };
}

export function createLocalDevelopmentServerLaunch(options = {}) {
  return createLocalApplicationServerLaunch({
    ...options,
    nextCommand: "dev",
  });
}

export function createLocalProductionServerLaunch(options = {}) {
  return createLocalProductionPreviewLaunches(options).start;
}

export function createLocalProductionPreviewLaunches(options = {}) {
  const start = createLocalApplicationServerLaunch({
    ...options,
    nextCommand: "start",
    runtimeMode: "local",
  });
  return {
    build: {
      argumentsList: [start.argumentsList[0], "build"],
      command: start.command,
      name: `build de ${start.name}`,
      options: {
        ...start.options,
        env: start.options.env,
      },
    },
    buildOutputPath: resolve(start.options.cwd, ".next"),
    start,
  };
}

async function runLocalServer({
  application,
  createLaunch,
  fileSecurityOptions,
  inheritedEnvironment = process.env,
  platform = process.platform,
  repositoryRoot = defaultRepositoryRoot,
  spawnManagedProcess = spawnSupervisedProcess,
  spawnProcess = spawn,
}) {
  const launch = createLaunch({
    application,
    fileSecurityOptions,
    inheritedEnvironment,
    platform,
    repositoryRoot,
  });
  const child = spawnManagedProcess(launch.command, launch.argumentsList, launch.options, {
    platform,
    spawnProcess,
  });
  const exitTarget = {};
  const supervisor = superviseDevelopmentProcesses({
    children: [{ child, name: launch.name }],
    exitTarget,
  });
  return supervisor.completion;
}

export async function runLocalDevelopmentServer({
  application,
  fileSecurityOptions,
  inheritedEnvironment = process.env,
  platform = process.platform,
  repositoryRoot = defaultRepositoryRoot,
  spawnManagedProcess = spawnSupervisedProcess,
  spawnProcess = spawn,
} = {}) {
  return runLocalServer({
    application,
    createLaunch: createLocalDevelopmentServerLaunch,
    fileSecurityOptions,
    inheritedEnvironment,
    platform,
    repositoryRoot,
    spawnManagedProcess,
    spawnProcess,
  });
}

export async function runLocalProductionServer({
  application,
  assertWindowsPath,
  clearShutdownTimeout = clearTimeout,
  forceShutdownMilliseconds = 5_000,
  fileSecurityOptions,
  inheritedEnvironment = process.env,
  platform = process.platform,
  readLinuxMountInformation = readCurrentLinuxMountInformation,
  repositoryRoot = defaultRepositoryRoot,
  scheduleShutdownTimeout = setTimeout,
  signalProcessGroup = process.kill,
  signalSource = process,
  spawnManagedProcess = spawnSupervisedProcess,
  spawnProcess = spawn,
} = {}) {
  const preview = createLocalProductionPreviewLaunches({
    application,
    fileSecurityOptions,
    inheritedEnvironment,
    platform,
    repositoryRoot,
  });

  return runLocalProductionPreviewProcessFlow({
    cleanupBuild: () =>
      removeNextBuildCache({
        applicationRoot: preview.start.options.cwd,
        filesystemSecurityOptions:
          assertWindowsPath === undefined ? undefined : { assertWindowsPath },
        repositoryRoot,
      }),
    clearShutdownTimeout,
    forceShutdownMilliseconds,
    platform,
    prepareBuild: () => {
      removePreviousBuildOutput(preview.buildOutputPath, {
        assertWindowsPath,
        platform,
        readLinuxMountInformation,
      });
    },
    scheduleShutdownTimeout,
    signalProcessGroup,
    signalSource,
    startBuild: (registerProcess) => {
      registerProcess({
        child: spawnManagedProcess(
          preview.build.command,
          preview.build.argumentsList,
          preview.build.options,
          { platform, spawnProcess },
        ),
      });
    },
    startServer: (registerProcess) => {
      registerProcess({
        child: spawnManagedProcess(
          preview.start.command,
          preview.start.argumentsList,
          preview.start.options,
          { platform, spawnProcess },
        ),
      });
    },
    validateBuild: () => {
      const buildId = readProtectedFile(
        resolve(preview.buildOutputPath, "BUILD_ID"),
        "BUILD_ID fresco do preview",
      );
      if (buildId.trim() === "" || buildId.includes("\0")) {
        throw new Error("O build fresco do preview não produziu BUILD_ID válido.");
      }
    },
  });
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Uso inválido do launcher de desenvolvimento.");
    }
    process.exitCode = await runLocalDevelopmentServer({ application: process.argv[2] });
  } catch {
    process.stderr.write("O servidor local não pôde ser iniciado com segurança.\n");
    process.exitCode = 1;
  }
}
