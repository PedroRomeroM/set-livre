import { spawnSync } from "node:child_process";
import { cpSync, lstatSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const operationalEnvironmentNames = [
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
] as const;

const pathEnvironmentNames = new Set(["PATH", "Path"]);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const runnerPath = resolve(import.meta.dirname, "playwright-web-server.ts");

function shellArgument(value: string) {
  if (value === "" || /[\0\r\n]/u.test(value)) {
    throw new Error("Argumento inválido para o webServer do Playwright.");
  }
  if (process.platform === "win32") {
    if (/[%!"]/u.test(value)) {
      throw new Error("Path incompatível com a fronteira cmd.exe do Playwright.");
    }
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createPlaywrightWebServerCommand(argumentsList: readonly string[]) {
  return [process.execPath, runnerPath, ...argumentsList].map(shellArgument).join(" ");
}

export type ValidatedPlaywrightApplicationEnvironment = Readonly<{
  BACKOFFICE_RUNTIME_UNLOCK_KEY?: string;
  DATABASE_URL_APP_DAL: string;
  NEXT_PUBLIC_APP_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_SECRET_KEY?: string;
}>;

function sanitizedOperationalValue(name: string, value: string | undefined) {
  if (value === undefined || value === "" || value.includes("\0")) {
    return undefined;
  }
  if (!pathEnvironmentNames.has(name)) {
    return value;
  }

  const sanitizedPath = value
    .split(delimiter)
    .filter((entry) => entry !== "")
    .join(delimiter);
  return sanitizedPath === "" ? undefined : sanitizedPath;
}

export function createPlaywrightOperationalEnvironment(
  inheritedEnvironment: Readonly<Record<string, string | undefined>>,
) {
  const overlay: Record<string, string> = Object.fromEntries(
    Object.keys(inheritedEnvironment).map((name) => [name, ""]),
  );

  for (const name of operationalEnvironmentNames) {
    const value = sanitizedOperationalValue(name, inheritedEnvironment[name]);
    if (value !== undefined) {
      overlay[name] = value;
    }
  }

  return overlay;
}

export function createPlaywrightWebServerEnvironmentOverlay(
  inheritedEnvironment: Readonly<Record<string, string | undefined>>,
  applicationEnvironment: ValidatedPlaywrightApplicationEnvironment,
) {
  const overlay = createPlaywrightOperationalEnvironment(inheritedEnvironment);

  Object.assign(overlay, applicationEnvironment);
  overlay.APP_ENV = "test";
  overlay.APP_RELEASE_SHA = "local";
  overlay.NODE_ENV = "production";
  return overlay;
}

type PlaywrightApplication = "web" | "backoffice";
type PlaywrightBuildArguments = {
  application: PlaywrightApplication;
  root: string;
  inheritedEnvironment: NodeJS.ProcessEnv;
};

async function buildPlaywrightApplication({
  application,
  root,
  inheritedEnvironment,
}: PlaywrightBuildArguments) {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts/local-setup.mjs"), `build-${application}`],
    { cwd: root, env: inheritedEnvironment, shell: false, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    throw new Error("O build Playwright falhou; nenhum artefato anterior será iniciado.", {
      cause: result.error,
    });
  }
}

export async function preparePlaywrightStandalone(
  application: PlaywrightApplication,
  {
    root = repositoryRoot,
    environment = process.env,
    buildApplication = buildPlaywrightApplication,
  }: {
    root?: string;
    environment?: NodeJS.ProcessEnv;
    buildApplication?: (args: PlaywrightBuildArguments) => Promise<void>;
  } = {},
) {
  if (
    environment.APP_ENV !== "test" ||
    environment.APP_RELEASE_SHA !== "local" ||
    environment.NODE_ENV !== "production"
  ) {
    throw new Error("O standalone Playwright exige o ambiente test local compilado para produção.");
  }

  const applicationRoot = resolve(root, application === "web" ? "." : "apps/backoffice");
  const nextRoot = resolve(applicationRoot, ".next");
  const previousBuild = lstatSync(nextRoot, { throwIfNoEntry: false });
  if (previousBuild && (!previousBuild.isDirectory() || previousBuild.isSymbolicLink())) {
    throw new Error("O build Playwright exige um diretório Next físico.");
  }

  await buildApplication({ application, root, inheritedEnvironment: environment });

  const standaloneRoot = resolve(
    nextRoot,
    "standalone",
    application === "web" ? "." : "apps/backoffice",
  );
  const entrypoint = resolve(standaloneRoot, "server.js");
  const server = lstatSync(entrypoint, { throwIfNoEntry: false });
  if (!server?.isFile() || server.isSymbolicLink()) {
    throw new Error("O build Playwright não produziu um servidor standalone válido.");
  }
  cpSync(resolve(nextRoot, "static"), resolve(standaloneRoot, ".next/static"), { recursive: true });
  const publicAssets = resolve(applicationRoot, "public");
  if (lstatSync(publicAssets, { throwIfNoEntry: false }) !== undefined) {
    cpSync(publicAssets, resolve(standaloneRoot, "public"), { recursive: true });
  }
  return entrypoint;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const application = process.argv[2];
  if (application === "--help") {
    process.stdout.write("Usage: playwright-web-server <web|backoffice>\n");
  } else {
    if ((application !== "web" && application !== "backoffice") || process.argv.length !== 3) {
      throw new Error("Usage: playwright-web-server <web|backoffice>");
    }
    const entrypoint = await preparePlaywrightStandalone(application);
    process.env.HOSTNAME = "127.0.0.1";
    process.env.PORT = application === "web" ? "3000" : "3001";
    await import(pathToFileURL(entrypoint).href);
  }
}
