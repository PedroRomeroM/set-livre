import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

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
const localDatabaseHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const localDatabaseProtocols = new Set(["postgres:", "postgresql:"]);

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

function validatedLocalDalDatabaseUrl(value) {
  if (typeof value !== "string" || value === "") {
    throw new Error("DATABASE_URL_APP_DAL local é obrigatória para o smoke da release.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL_APP_DAL local é inválida para o smoke da release.");
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
      "DATABASE_URL_APP_DAL do smoke precisa usar a identidade DAL restrita na instância Supabase local.",
    );
  }

  return value;
}

export function releaseSmokeEnvironment(inheritedEnvironment, localEnvironment, overrides) {
  const databaseUrl = validatedLocalDalDatabaseUrl(localEnvironment.DATABASE_URL_APP_DAL);
  return releaseRuntimeEnvironment(inheritedEnvironment, localEnvironment, {
    ...overrides,
    DATABASE_URL_APP_DAL: databaseUrl,
  });
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

export function ensurePhysicalArtifactsRoot(repositoryRoot, artifactsRoot) {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedArtifactsRoot = resolve(artifactsRoot);
  if (dirname(resolvedArtifactsRoot) !== resolvedRepositoryRoot) {
    throw new Error("A raiz de artefatos precisa ser filha direta do repositório.");
  }

  if (!existsSync(resolvedArtifactsRoot)) {
    mkdirSync(resolvedArtifactsRoot, { mode: 0o700 });
  }

  const information = lstatSync(resolvedArtifactsRoot);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("A raiz de artefatos precisa ser um diretório físico regular.");
  }
  if (process.platform !== "win32") {
    chmodSync(resolvedArtifactsRoot, 0o700);
    if ((lstatSync(resolvedArtifactsRoot).mode & 0o077) !== 0) {
      throw new Error("A raiz de artefatos não pôde ser restringida ao usuário atual.");
    }
  }

  const physicalRepositoryRoot = realpathSync(resolvedRepositoryRoot);
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
