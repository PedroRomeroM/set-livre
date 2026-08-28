import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";

const PRIVATE_POSIX_MODE = 0o600n;

function sameStableFile(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertPrivateEnvironmentFile(
  information: BigIntStats | undefined,
): asserts information is BigIntStats {
  if (
    information === undefined ||
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.nlink !== 1n
  ) {
    throw new Error("O ambiente E2E local precisa ser um arquivo regular exclusivo.");
  }

  if (process.platform === "win32") {
    return;
  }

  if ((information.mode & 0o7777n) !== PRIVATE_POSIX_MODE) {
    throw new Error("O ambiente E2E local precisa usar modo 0600 em sistemas POSIX.");
  }

  const effectiveUserId = process.geteuid?.();
  if (
    effectiveUserId === undefined ||
    !Number.isSafeInteger(effectiveUserId) ||
    effectiveUserId < 0 ||
    information.uid !== BigInt(effectiveUserId)
  ) {
    throw new Error("O ambiente E2E local precisa pertencer ao usuário efetivo.");
  }
}

function privateReadFlags() {
  if (process.platform === "win32") {
    return constants.O_RDONLY;
  }
  if (constants.O_NOFOLLOW === undefined) {
    throw new Error("A plataforma POSIX não oferece abertura no-follow.");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
}

function readPrivateEnvironmentFile(environmentPath: string) {
  const pathInformation = lstatSync(environmentPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (pathInformation === undefined) {
    return undefined;
  }
  assertPrivateEnvironmentFile(pathInformation);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(environmentPath, privateReadFlags());
    const openedInformation = fstatSync(descriptor, { bigint: true });
    assertPrivateEnvironmentFile(openedInformation);
    if (!sameStableFile(pathInformation, openedInformation)) {
      throw new Error("O ambiente E2E local mudou antes da leitura.");
    }

    const source = readFileSync(descriptor, "utf8");
    const finalDescriptorInformation = fstatSync(descriptor, { bigint: true });
    const finalPathInformation = lstatSync(environmentPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    assertPrivateEnvironmentFile(finalDescriptorInformation);
    assertPrivateEnvironmentFile(finalPathInformation);
    if (
      !sameStableFile(openedInformation, finalDescriptorInformation) ||
      !sameStableFile(openedInformation, finalPathInformation)
    ) {
      throw new Error("O ambiente E2E local mudou durante a leitura.");
    }
    return source;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function parseStrictEnvironment(source: string) {
  const environment: Record<string, string> = {};
  for (const line of source.split(/\r?\n/u)) {
    if (line === "") continue;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([^\s'"]+)$/u.exec(line);
    const name = assignment?.[1];
    const value = assignment?.[2];
    if (name === undefined || value === undefined || Object.hasOwn(environment, name)) {
      throw new Error("Atribuição E2E inválida.");
    }
    environment[name] = value;
  }
  return environment;
}

export function readOptionalE2EEnvironmentFile(repositoryRoot: string) {
  let source: string;
  try {
    const privateSource = readPrivateEnvironmentFile(resolve(repositoryRoot, ".env.e2e.local"));
    if (privateSource === undefined) {
      return {};
    }
    source = privateSource;
  } catch (error) {
    throw new Error(
      "Não foi possível ler o ambiente E2E local como arquivo regular exclusivo e privado.",
      { cause: error },
    );
  }

  try {
    return parseStrictEnvironment(source);
  } catch (error) {
    throw new Error("Não foi possível interpretar o ambiente E2E local.", { cause: error });
  }
}

export function localE2EEnvironmentValue(
  localEnvironment: Readonly<Record<string, string>>,
  inheritedEnvironment: Readonly<Record<string, string | undefined>>,
  name: string,
) {
  return localEnvironment[name] ?? inheritedEnvironment[name];
}
