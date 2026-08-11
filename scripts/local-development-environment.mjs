import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { parseLiteralLocalIpv4Url } from "./local-network-contract.ts";

const localRuntimeEnvironmentNames = [
  "APP_ENV",
  "APP_RELEASE_SHA",
  "DATABASE_URL_APP_DAL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
];
const localRuntimeEnvironmentNameSet = new Set(localRuntimeEnvironmentNames);
const inheritedOperationalEnvironmentNames = [
  "CI",
  "COMSPEC",
  "HOME",
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
  "NEXT_TELEMETRY_DISABLED",
  "PATH",
  "PATHEXT",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
];
const pathEnvironmentNames = new Set(["PATH", "Path"]);
const localDatabaseProtocols = new Set(["postgres:", "postgresql:"]);

function sanitizeOperationalValue(name, value) {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    return undefined;
  }
  if (!pathEnvironmentNames.has(name)) {
    return value;
  }

  const separator = value.includes(";") || /^[A-Za-z]:[/\\]/u.test(value) ? ";" : ":";
  const searchPath = value
    .split(separator)
    .filter((entry) => entry !== "")
    .join(separator);
  return searchPath === "" ? undefined : searchPath;
}

function inheritedOperationalEnvironment(environment) {
  const operationalEnvironment = {};
  for (const name of inheritedOperationalEnvironmentNames) {
    const value = sanitizeOperationalValue(name, environment[name]);
    if (value !== undefined) {
      operationalEnvironment[name] = value;
    }
  }
  return operationalEnvironment;
}

function assertExactLocalRuntimeEnvironment(environment) {
  const unexpectedNames = Object.keys(environment).filter(
    (name) => !localRuntimeEnvironmentNameSet.has(name),
  );
  if (unexpectedNames.length > 0) {
    throw new Error(
      `O ambiente local contém nomes runtime não autorizados: ${unexpectedNames.sort().join(", ")}.`,
    );
  }

  const missingNames = localRuntimeEnvironmentNames.filter(
    (name) =>
      typeof environment[name] !== "string" ||
      environment[name] === "" ||
      environment[name].includes("\0"),
  );
  if (missingNames.length > 0) {
    throw new Error(
      `O ambiente local não contém todos os nomes runtime obrigatórios: ${missingNames.join(", ")}.`,
    );
  }
}

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readPhysicalEnvironmentFile(environmentPath) {
  let descriptor;

  try {
    const pathInformation = lstatSync(environmentPath, { throwIfNoEntry: false });
    if (
      pathInformation === undefined ||
      !pathInformation.isFile() ||
      pathInformation.isSymbolicLink()
    ) {
      throw new Error(
        `O ambiente local precisa ser um arquivo físico regular: ${environmentPath}.`,
      );
    }
    if (process.platform !== "win32" && (pathInformation.mode & 0o7777) !== 0o600) {
      throw new Error(`O ambiente local precisa usar modo 0600: ${environmentPath}.`);
    }

    descriptor = openSync(environmentPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(descriptor);
    if (
      !openedInformation.isFile() ||
      !samePhysicalFile(pathInformation, openedInformation) ||
      (process.platform !== "win32" && (openedInformation.mode & 0o7777) !== 0o600)
    ) {
      throw new Error(`O ambiente local mudou durante a abertura: ${environmentPath}.`);
    }

    const source = readFileSync(descriptor, "utf8");
    const finalInformation = lstatSync(environmentPath, { throwIfNoEntry: false });
    if (
      finalInformation === undefined ||
      finalInformation.isSymbolicLink() ||
      !finalInformation.isFile() ||
      !samePhysicalFile(openedInformation, finalInformation) ||
      (process.platform !== "win32" && (finalInformation.mode & 0o7777) !== 0o600)
    ) {
      throw new Error(`O ambiente local mudou durante a leitura: ${environmentPath}.`);
    }

    return source;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function validateLocalDalDatabaseUrl(value) {
  if (typeof value !== "string" || value === "") {
    throw new Error("DATABASE_URL_APP_DAL local é obrigatória.");
  }

  const parsed = parseLiteralLocalIpv4Url(value, "DATABASE_URL_APP_DAL local");

  if (
    !localDatabaseProtocols.has(parsed.protocol) ||
    parsed.port !== "54322" ||
    parsed.username !== "app_runtime_local" ||
    parsed.password === "" ||
    parsed.pathname !== "/postgres" ||
    parsed.hash !== "" ||
    parsed.searchParams.size !== 1 ||
    parsed.searchParams.get("options") !== "-c role=app_dal"
  ) {
    throw new Error(
      "DATABASE_URL_APP_DAL local precisa usar a identidade DAL restrita na instância Supabase local.",
    );
  }

  return value;
}

function validateLocalHttpOrigin(value, label, expectedOrigin) {
  const parsed = parseLiteralLocalIpv4Url(value, `${label} local`);

  if (
    parsed.protocol !== "http:" ||
    parsed.origin !== expectedOrigin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} local precisa usar a origem esperada ${expectedOrigin}.`);
  }

  return parsed.origin;
}

function validateLocalSupabaseUrl(value) {
  const parsed = parseLiteralLocalIpv4Url(value, "NEXT_PUBLIC_SUPABASE_URL local");

  if (
    parsed.protocol !== "http:" ||
    parsed.port !== "54321" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL local precisa usar HTTP no host 127.0.0.1 e na porta 54321.",
    );
  }

  return parsed.origin;
}

function validateLocalRuntimeEnvironment(localEnvironment, expectedApplicationUrl) {
  assertExactLocalRuntimeEnvironment(localEnvironment);
  if (localEnvironment.APP_ENV !== "local" || localEnvironment.APP_RELEASE_SHA !== "local") {
    throw new Error("APP_ENV e APP_RELEASE_SHA precisam ser local no launcher de desenvolvimento.");
  }

  let expectedApplicationOrigin;
  try {
    expectedApplicationOrigin = parseLiteralLocalIpv4Url(
      expectedApplicationUrl,
      "A origem esperada do app local",
    ).origin;
  } catch {
    throw new Error("A origem esperada do app local é inválida.");
  }
  const applicationUrl = validateLocalHttpOrigin(
    localEnvironment.NEXT_PUBLIC_APP_URL,
    "NEXT_PUBLIC_APP_URL",
    expectedApplicationOrigin,
  );
  const supabaseUrl = validateLocalSupabaseUrl(localEnvironment.NEXT_PUBLIC_SUPABASE_URL);

  return {
    ...localEnvironment,
    DATABASE_URL_APP_DAL: validateLocalDalDatabaseUrl(localEnvironment.DATABASE_URL_APP_DAL),
    NEXT_PUBLIC_APP_URL: applicationUrl,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  };
}

export function createLocalDevelopmentEnvironment(
  inheritedEnvironment,
  localEnvironment,
  expectedApplicationUrl,
) {
  const validatedLocalEnvironment = validateLocalRuntimeEnvironment(
    localEnvironment,
    expectedApplicationUrl,
  );

  return {
    ...inheritedOperationalEnvironment(inheritedEnvironment),
    ...Object.fromEntries(
      localRuntimeEnvironmentNames.map((name) => [name, validatedLocalEnvironment[name]]),
    ),
  };
}

export function readLocalDevelopmentEnvironmentFile(
  environmentPath,
  inheritedEnvironment,
  expectedApplicationUrl,
) {
  const source = readPhysicalEnvironmentFile(environmentPath);
  let localEnvironment;
  try {
    localEnvironment = parseEnv(source);
  } catch {
    throw new Error(`Não foi possível interpretar o ambiente local: ${environmentPath}.`);
  }

  return createLocalDevelopmentEnvironment(
    inheritedEnvironment,
    localEnvironment,
    expectedApplicationUrl,
  );
}
