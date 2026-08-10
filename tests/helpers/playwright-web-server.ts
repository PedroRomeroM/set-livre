import { delimiter, isAbsolute, win32 } from "node:path";

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
const supportedApplications = new Set(["web", "backoffice"]);

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

export function createPlaywrightWebServerEnvironmentOverlay(
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

function quoteShellArgument(value: string, platform: NodeJS.Platform) {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("O comando do webServer contém um caminho inválido.");
  }

  if (platform === "win32") {
    if (/[%!"^&|<>]/u.test(value)) {
      throw new Error("O caminho do webServer contém metacaractere inseguro no Windows.");
    }
    return `"${value}"`;
  }

  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createPlaywrightWebServerCommand({
  application,
  nodeExecutable,
  platform = process.platform,
  wrapperPath,
}: {
  application: "backoffice" | "web";
  nodeExecutable: string;
  platform?: NodeJS.Platform;
  wrapperPath: string;
}) {
  if (!supportedApplications.has(application)) {
    throw new Error("A aplicação do webServer Playwright é inválida.");
  }

  const absolutePath = platform === "win32" ? win32.isAbsolute : isAbsolute;
  if (!absolutePath(nodeExecutable) || !absolutePath(wrapperPath)) {
    throw new Error("Node e wrapper do webServer precisam usar caminhos absolutos.");
  }

  const command = [nodeExecutable, wrapperPath, application]
    .map((value) => quoteShellArgument(value, platform))
    .join(" ");
  return platform === "win32" ? command : `exec ${command}`;
}
