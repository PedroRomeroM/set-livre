import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";

import {
  createLocalDevelopmentEnvironment,
  validateLocalDalDatabaseUrl,
} from "./local-development-environment.mjs";
import {
  assertPhysicalDirectoryTree,
  readCurrentLinuxMountInformation,
} from "./physical-tree-removal.mjs";

const alwaysSensitiveEnvironmentNames = [
  "CURSOR_SIGNING_SECRET",
  "DATABASE_URL_APP_DAL",
  "E2E_DATABASE_URL",
  "EMAIL_SECRET",
  "FIELD_ENCRYPTION_KEY",
  "PAYMENT_PROVIDER_SECRET_KEY",
  "PAYMENT_WEBHOOK_SECRET",
  "PGPASSFILE",
  "PGPASSWORD",
  "REQUEST_ID_SECRET",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_DSN",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const alwaysSensitiveEnvironmentNameSet = new Set(alwaysSensitiveEnvironmentNames);
const additionalSensitiveEnvironmentNameSet = new Set(["SSH_AUTH_SOCK"]);
const secretNamePattern =
  /(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH_TOKEN|CREDENTIALS?|DATABASE_URL|DSN|PASSFILE|PASSWORD|PRIVATE_KEY|SECRET|SERVICE_ROLE_KEY|TOKEN)(?:_|$)/u;
const forbiddenPublicSecretPattern =
  /(?:^|_)(?:PASSWORD|PRIVATE_KEY|SECRET|SERVICE_ROLE_KEY)(?:_|$)/u;
const operationalEnvironmentNames = new Set([
  "CI",
  "COMSPEC",
  "HOME",
  "LANG",
  "LANGUAGE",
  "NEXT_TELEMETRY_DISABLED",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
]);
const childProcessControlEnvironmentNames = new Set([
  ...operationalEnvironmentNames,
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TAR_OPTIONS",
]);
const childProcessControlPrefixes = ["DYLD_", "GIT_", "LD_", "NPM_CONFIG_"];
const releaseArchiveMode = "u+rwX,go+rX,go-w,a-s,a-t";

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPhysicalReleaseRuntimeFile(information, environmentPath, stage) {
  if (
    information === undefined ||
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.nlink !== 1
  ) {
    throw new Error(
      `O ambiente runtime da release precisa ser um arquivo físico regular exclusivo ${stage}: ${environmentPath}.`,
    );
  }
  if (process.platform !== "win32" && (information.mode & 0o7777) !== 0o600) {
    throw new Error(`O ambiente runtime da release precisa usar modo 0600: ${environmentPath}.`);
  }
}

export function readReleaseRuntimeEnvironmentFile(
  environmentPath,
  expectedApplicationUrl,
  { readDescriptor = (descriptor) => readFileSync(descriptor, "utf8") } = {},
) {
  let descriptor;
  try {
    const pathInformation = lstatSync(environmentPath, { throwIfNoEntry: false });
    assertPhysicalReleaseRuntimeFile(pathInformation, environmentPath, "antes da abertura");

    descriptor = openSync(environmentPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(descriptor);
    assertPhysicalReleaseRuntimeFile(openedInformation, environmentPath, "durante a abertura");
    if (!samePhysicalFile(pathInformation, openedInformation)) {
      throw new Error(
        `O ambiente runtime da release mudou durante a abertura: ${environmentPath}.`,
      );
    }

    const source = readDescriptor(descriptor);
    if (typeof source !== "string" || source === "") {
      throw new Error(`O ambiente runtime da release está vazio: ${environmentPath}.`);
    }

    const finalInformation = lstatSync(environmentPath, { throwIfNoEntry: false });
    assertPhysicalReleaseRuntimeFile(finalInformation, environmentPath, "após a leitura");
    if (!samePhysicalFile(openedInformation, finalInformation)) {
      throw new Error(`O ambiente runtime da release mudou durante a leitura: ${environmentPath}.`);
    }

    let localEnvironment;
    try {
      localEnvironment = parseEnv(source);
    } catch {
      throw new Error(
        `Não foi possível interpretar o ambiente runtime da release: ${environmentPath}.`,
      );
    }
    return createLocalDevelopmentEnvironment({}, localEnvironment, expectedApplicationUrl);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function isInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !pathFromParent.startsWith("/") &&
      !pathFromParent.startsWith("\\"))
  );
}

export function isSensitiveEnvironmentName(name) {
  const normalizedName = name.toUpperCase();
  if (normalizedName.startsWith("E2E_")) {
    return true;
  }
  if (
    alwaysSensitiveEnvironmentNameSet.has(normalizedName) ||
    additionalSensitiveEnvironmentNameSet.has(normalizedName)
  ) {
    return true;
  }
  if (normalizedName.startsWith("NEXT_PUBLIC_")) {
    return forbiddenPublicSecretPattern.test(normalizedName);
  }
  return (
    secretNamePattern.test(normalizedName) ||
    normalizedName.endsWith("AUTHTOKEN") ||
    normalizedName.endsWith("PASSWORD") ||
    normalizedName.endsWith("PASSFILE")
  );
}

export function operationalEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        typeof value === "string" &&
        (operationalEnvironmentNames.has(name.toUpperCase()) ||
          name.toUpperCase().startsWith("LC_")),
    ),
  );
}

export function environmentWithoutSecrets(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => typeof value === "string" && !isSensitiveEnvironmentName(name),
    ),
  );
}

function isChildProcessControlEnvironmentName(name) {
  const normalizedName = name.toUpperCase();
  return (
    childProcessControlEnvironmentNames.has(normalizedName) ||
    childProcessControlPrefixes.some((prefix) => normalizedName.startsWith(prefix))
  );
}

function applicationEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name, value]) => {
      const normalizedName = name.toUpperCase();
      return (
        typeof value === "string" &&
        !normalizedName.startsWith("E2E_") &&
        !isChildProcessControlEnvironmentName(normalizedName)
      );
    }),
  );
}

export function releaseBuildEnvironment(inheritedEnvironment, localEnvironment, commit) {
  const environment = {
    ...operationalEnvironment(inheritedEnvironment),
    ...environmentWithoutSecrets(applicationEnvironment(localEnvironment)),
    APP_RELEASE_SHA: commit,
    NODE_ENV: "production",
  };
  for (const name of new Set([
    ...alwaysSensitiveEnvironmentNames,
    ...Object.keys(localEnvironment).filter(
      (name) => isSensitiveEnvironmentName(name) || isChildProcessControlEnvironmentName(name),
    ),
  ])) {
    environment[name] = "";
  }
  return environment;
}

export function releaseRuntimeEnvironment(inheritedEnvironment, localEnvironment, overrides) {
  return {
    ...operationalEnvironment(inheritedEnvironment),
    ...applicationEnvironment(localEnvironment),
    ...overrides,
  };
}

export function releaseSmokeEnvironment(inheritedEnvironment, localEnvironment, overrides) {
  const databaseUrl = validateLocalDalDatabaseUrl(localEnvironment.DATABASE_URL_APP_DAL);
  return releaseRuntimeEnvironment(inheritedEnvironment, localEnvironment, {
    ...overrides,
    DATABASE_URL_APP_DAL: databaseUrl,
  });
}

export function deterministicReleaseTarArguments({
  archivePath,
  artifactsRoot,
  commitTimestamp,
  releaseRoot,
}) {
  if (!/^\d+$/u.test(commitTimestamp)) {
    throw new Error("O timestamp da release precisa ser um epoch inteiro.");
  }
  return [
    "--sort=name",
    `--mtime=@${commitTimestamp}`,
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    `--mode=${releaseArchiveMode}`,
    "--format=gnu",
    "-czf",
    archivePath,
    "-C",
    artifactsRoot,
    basename(releaseRoot),
  ];
}

function openReleaseLock(
  artifactsRoot,
  {
    platform = process.platform,
    readLinuxMountInformation = readCurrentLinuxMountInformation,
  } = {},
) {
  const resolvedArtifactsRoot = resolve(artifactsRoot);
  const { information: rootInformation } = assertPhysicalDirectoryTree(resolvedArtifactsRoot, {
    description: "A raiz de artefatos do lock de release",
    messages: {
      directoryRequiredMessage: "O lock de release exige uma raiz de artefatos física.",
      mountDetectedMessage:
        "O lock de release recusa uma raiz de artefatos montada ou com mounts internos.",
      mountUnverifiedMessage:
        "Não foi possível comprovar que a raiz de artefatos do lock não contém mounts.",
    },
    platform,
    readLinuxMountInformation,
  });

  const lockPath = resolve(resolvedArtifactsRoot, "release.lock");
  let descriptor;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const openedInformation = fstatSync(descriptor);
    const pathInformation = lstatSync(lockPath);
    const finalRootInformation = lstatSync(resolvedArtifactsRoot, { throwIfNoEntry: false });
    if (
      !openedInformation.isFile() ||
      !pathInformation.isFile() ||
      pathInformation.isSymbolicLink() ||
      openedInformation.nlink !== 1 ||
      openedInformation.dev !== pathInformation.dev ||
      openedInformation.ino !== pathInformation.ino ||
      finalRootInformation === undefined ||
      !finalRootInformation.isDirectory() ||
      finalRootInformation.isSymbolicLink() ||
      !samePhysicalFile(rootInformation, finalRootInformation)
    ) {
      throw new Error("O lock de release precisa ser um arquivo físico exclusivo.");
    }
    if (process.platform !== "win32") {
      fchmodSync(descriptor, 0o600);
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (error instanceof Error && error.message.includes("lock de release")) {
      throw error;
    }
    throw new Error("Não foi possível abrir o lock físico da release.", { cause: error });
  }
}

export async function withExclusiveReleaseLock(artifactsRoot, operation, options) {
  const descriptor = openReleaseLock(artifactsRoot, options);
  try {
    try {
      // O filho trava a mesma open-file description; o descritor do pai mantém o lock após o exit.
      execFileSync("flock", ["--exclusive", "3"], {
        env: operationalEnvironment(process.env),
        stdio: ["ignore", "ignore", "inherit", descriptor],
      });
    } catch (error) {
      throw new Error("util-linux flock é obrigatório para serializar a release.", {
        cause: error,
      });
    }
    return await operation();
  } finally {
    closeSync(descriptor);
  }
}

export function secretEnvironmentEntries(...environments) {
  const entries = [];
  const seen = new Set();
  for (const environment of environments) {
    for (const [name, value] of Object.entries(environment)) {
      if (typeof value === "string" && value.length >= 8 && isSensitiveEnvironmentName(name)) {
        const key = `${name}\0${value}`;
        if (!seen.has(key)) {
          seen.add(key);
          entries.push([name, value]);
        }
      }
    }
  }
  return entries;
}

export function redactEnvironmentSecrets(value, environment) {
  let redacted = value;
  for (const [, secret] of secretEnvironmentEntries(environment)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/giu, "$1[REDACTED]@")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]");
}

export function throwIfPrimaryOrCleanupFailed(
  primaryFailure,
  cleanupFailures,
  {
    combinedMessage = "A operação principal e o cleanup físico falharam.",
    multipleCleanupMessage = "O cleanup físico falhou em múltiplos caminhos.",
  } = {},
) {
  if (primaryFailure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupFailures], combinedMessage, {
      cause: primaryFailure,
    });
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
  if (cleanupFailures.length === 1) {
    throw cleanupFailures[0];
  }
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, multipleCleanupMessage);
  }
}

export function collectCleanupFailures(paths, pathExists, removePath) {
  const failures = [];
  for (const path of paths) {
    try {
      if (pathExists(path)) {
        removePath(path);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export function ensurePhysicalArtifactsRoot(
  repositoryRoot,
  artifactsRoot,
  {
    platform = process.platform,
    readLinuxMountInformation = readCurrentLinuxMountInformation,
  } = {},
) {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedArtifactsRoot = resolve(artifactsRoot);
  if (dirname(resolvedArtifactsRoot) !== resolvedRepositoryRoot) {
    throw new Error("A raiz de artefatos precisa ser filha direta do repositório.");
  }

  const repositoryInformation = lstatSync(resolvedRepositoryRoot, { throwIfNoEntry: false });
  let physicalRepositoryRoot;
  try {
    physicalRepositoryRoot = realpathSync(resolvedRepositoryRoot);
  } catch {
    throw new Error("O repositório da release precisa ter ancestralidade física válida.");
  }
  if (
    repositoryInformation === undefined ||
    !repositoryInformation.isDirectory() ||
    repositoryInformation.isSymbolicLink() ||
    physicalRepositoryRoot !== resolvedRepositoryRoot
  ) {
    throw new Error("O repositório da release precisa ter ancestralidade física válida.");
  }

  if (lstatSync(resolvedArtifactsRoot, { throwIfNoEntry: false }) === undefined) {
    mkdirSync(resolvedArtifactsRoot, { mode: 0o700 });
  }

  const { information } = assertPhysicalDirectoryTree(resolvedArtifactsRoot, {
    description: "A raiz de artefatos",
    messages: {
      directoryRequiredMessage: "A raiz de artefatos precisa ser um diretório físico regular.",
      mountDetectedMessage: "A raiz de artefatos não pode ser um mount nem conter mounts.",
      mountUnverifiedMessage:
        "Não foi possível comprovar que a raiz de artefatos não contém mounts.",
    },
    platform,
    readLinuxMountInformation,
  });

  let descriptor;
  try {
    descriptor = openSync(
      resolvedArtifactsRoot,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const openedInformation = fstatSync(descriptor);
    if (
      !openedInformation.isDirectory() ||
      openedInformation.isSymbolicLink() ||
      !samePhysicalFile(information, openedInformation)
    ) {
      throw new Error("A raiz de artefatos mudou antes da restrição de acesso.");
    }
    if (platform !== "win32") {
      fchmodSync(descriptor, 0o700);
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }

  const finalInformation = lstatSync(resolvedArtifactsRoot, { throwIfNoEntry: false });
  if (
    finalInformation === undefined ||
    !finalInformation.isDirectory() ||
    finalInformation.isSymbolicLink() ||
    !samePhysicalFile(information, finalInformation)
  ) {
    throw new Error("A raiz de artefatos mudou durante a restrição de acesso.");
  }
  if (platform !== "win32" && (finalInformation.mode & 0o077) !== 0) {
    throw new Error("A raiz de artefatos não pôde ser restringida ao usuário atual.");
  }

  const physicalArtifactsRoot = realpathSync(resolvedArtifactsRoot);
  const expectedPhysicalRoot = resolve(
    physicalRepositoryRoot,
    relative(resolvedRepositoryRoot, resolvedArtifactsRoot),
  );
  if (
    physicalArtifactsRoot !== expectedPhysicalRoot ||
    !isInside(physicalRepositoryRoot, physicalArtifactsRoot)
  ) {
    throw new Error("A raiz de artefatos física escapou do repositório.");
  }
  return physicalArtifactsRoot;
}
