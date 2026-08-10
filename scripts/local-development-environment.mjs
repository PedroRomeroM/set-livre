import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { parseEnv } from "node:util";

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
const localDatabaseHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const localDatabaseProtocols = new Set(["postgres:", "postgresql:"]);
const expectedProjectNpmConfigurationLines = [
  "engine-strict=true",
  "fund=false",
  "save-exact=true",
];
const controlledNpmConfigurationPaths = {
  global: "config/npm/dev-global.npmrc",
  project: ".npmrc",
  user: "config/npm/dev-user.npmrc",
};

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

function assertPhysicalConfigurationAncestry(repositoryRoot, configurationPath) {
  const resolvedRoot = resolve(repositoryRoot);
  const pathFromRoot = relative(resolvedRoot, configurationPath);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("A configuração npm precisa permanecer dentro do repositório.");
  }

  const rootInformation = lstatSync(resolvedRoot, { throwIfNoEntry: false });
  if (
    rootInformation === undefined ||
    !rootInformation.isDirectory() ||
    rootInformation.isSymbolicLink()
  ) {
    throw new Error("A raiz das configurações npm precisa ser um diretório físico.");
  }

  let currentParent = resolvedRoot;
  for (const component of pathFromRoot.split(sep).slice(0, -1)) {
    currentParent = resolve(currentParent, component);
    const parentInformation = lstatSync(currentParent, { throwIfNoEntry: false });
    if (
      parentInformation === undefined ||
      !parentInformation.isDirectory() ||
      parentInformation.isSymbolicLink()
    ) {
      throw new Error("O caminho da configuração npm atravessa um diretório não físico.");
    }
  }
}

function readControlledNpmConfiguration(repositoryRoot, configurationPath) {
  assertPhysicalConfigurationAncestry(repositoryRoot, configurationPath);
  let descriptor;

  try {
    const pathInformation = lstatSync(configurationPath, { throwIfNoEntry: false });
    if (
      pathInformation === undefined ||
      !pathInformation.isFile() ||
      pathInformation.isSymbolicLink()
    ) {
      throw new Error(
        `A configuração npm controlada precisa ser um arquivo físico regular: ${configurationPath}.`,
      );
    }
    if (process.platform !== "win32" && (pathInformation.mode & 0o002) !== 0) {
      throw new Error(
        `A configuração npm controlada não pode permitir escrita de outros: ${configurationPath}.`,
      );
    }

    descriptor = openSync(configurationPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = fstatSync(descriptor);
    if (
      !openedInformation.isFile() ||
      !samePhysicalFile(pathInformation, openedInformation) ||
      (process.platform !== "win32" && (openedInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(
        `A configuração npm controlada mudou durante a abertura: ${configurationPath}.`,
      );
    }

    const source = readFileSync(descriptor, "utf8");
    const finalInformation = lstatSync(configurationPath, { throwIfNoEntry: false });
    if (
      finalInformation === undefined ||
      finalInformation.isSymbolicLink() ||
      !finalInformation.isFile() ||
      !samePhysicalFile(openedInformation, finalInformation) ||
      (process.platform !== "win32" && (finalInformation.mode & 0o002) !== 0)
    ) {
      throw new Error(
        `A configuração npm controlada mudou durante a leitura: ${configurationPath}.`,
      );
    }

    return source;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function effectiveNpmConfigurationLines(source) {
  return source
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith(";"));
}

function validateControlledNpmConfigurations(repositoryRoot) {
  const projectConfigurationPath = resolve(repositoryRoot, controlledNpmConfigurationPaths.project);
  const userConfigurationPath = resolve(repositoryRoot, controlledNpmConfigurationPaths.user);
  const globalConfigurationPath = resolve(repositoryRoot, controlledNpmConfigurationPaths.global);
  const projectLines = effectiveNpmConfigurationLines(
    readControlledNpmConfiguration(repositoryRoot, projectConfigurationPath),
  );
  if (
    projectLines.length !== expectedProjectNpmConfigurationLines.length ||
    projectLines.some((line, index) => line !== expectedProjectNpmConfigurationLines[index])
  ) {
    throw new Error(
      "A configuração npm do projeto divergiu do contrato seguro de desenvolvimento.",
    );
  }

  for (const configurationPath of [userConfigurationPath, globalConfigurationPath]) {
    const lines = effectiveNpmConfigurationLines(
      readControlledNpmConfiguration(repositoryRoot, configurationPath),
    );
    if (lines.length > 0) {
      throw new Error(`A configuração npm isolada precisa permanecer vazia: ${configurationPath}.`);
    }
  }

  return { globalConfigurationPath, userConfigurationPath };
}

function localDevelopmentNpmScriptShell(environment) {
  if (process.platform !== "win32") {
    return "/bin/sh";
  }

  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (
    typeof systemRoot !== "string" ||
    systemRoot === "" ||
    systemRoot.includes("\0") ||
    !win32.isAbsolute(systemRoot)
  ) {
    throw new Error("SystemRoot absoluto é obrigatório para isolar o shell npm no Windows.");
  }

  const expectedShell = win32.resolve(systemRoot, "System32", "cmd.exe");
  const configuredShell = environment.COMSPEC ?? environment.ComSpec;
  if (
    typeof configuredShell === "string" &&
    win32.normalize(configuredShell).toLowerCase() !== expectedShell.toLowerCase()
  ) {
    throw new Error("COMSPEC diverge do cmd.exe controlado pelo SystemRoot.");
  }

  const shellInformation = lstatSync(expectedShell, { throwIfNoEntry: false });
  if (
    shellInformation === undefined ||
    !shellInformation.isFile() ||
    shellInformation.isSymbolicLink()
  ) {
    throw new Error("O cmd.exe controlado não é um arquivo físico regular.");
  }

  return expectedShell;
}

export function localDevelopmentNpmRunArguments(
  repositoryRoot,
  scriptName,
  environment,
  workspaceName,
) {
  if (!/^[a-z0-9:_-]+$/u.test(scriptName)) {
    throw new Error("O nome do script npm de desenvolvimento é inválido.");
  }
  if (workspaceName !== undefined && !/^@[a-z0-9-]+\/[a-z0-9-]+$/u.test(workspaceName)) {
    throw new Error("O workspace npm de desenvolvimento é inválido.");
  }

  const { globalConfigurationPath, userConfigurationPath } =
    validateControlledNpmConfigurations(repositoryRoot);
  return [
    `--userconfig=${userConfigurationPath}`,
    `--globalconfig=${globalConfigurationPath}`,
    "--ignore-scripts=true",
    "--node-options=",
    `--script-shell=${localDevelopmentNpmScriptShell(environment)}`,
    ...(workspaceName === undefined ? [] : [`--workspace=${workspaceName}`]),
    "run",
    scriptName,
  ];
}

export function validateLocalDalDatabaseUrl(value) {
  if (typeof value !== "string" || value === "") {
    throw new Error("DATABASE_URL_APP_DAL local é obrigatória.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL_APP_DAL local é inválida.");
  }

  if (
    !localDatabaseProtocols.has(parsed.protocol) ||
    !localDatabaseHostnames.has(parsed.hostname) ||
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
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} local é inválida.`);
  }

  if (
    parsed.protocol !== "http:" ||
    !localDatabaseHostnames.has(parsed.hostname) ||
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
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL local é inválida.");
  }

  if (
    parsed.protocol !== "http:" ||
    !localDatabaseHostnames.has(parsed.hostname) ||
    parsed.port !== "54321" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL local precisa usar HTTP em loopback na porta 54321.");
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
    expectedApplicationOrigin = new URL(expectedApplicationUrl).origin;
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
