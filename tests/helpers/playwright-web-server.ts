import { lstatSync, type Stats } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";

const operationalEnvironmentNames = [
  "CI",
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

const windowsOperationalEnvironmentNames = new Map(
  [...operationalEnvironmentNames, "LOCALAPPDATA"].map((name) => [name.toUpperCase(), name]),
);
const supportedApplications = new Set(["web", "backoffice"]);
type PhysicalPathInformation = Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">;
type InspectPhysicalPath = (path: string) => PhysicalPathInformation | undefined;

function sanitizedOperationalValue(
  name: string,
  value: string | undefined,
  platform: NodeJS.Platform,
) {
  if (value === undefined || value === "" || value.includes("\0")) {
    return undefined;
  }
  if (name !== "PATH") {
    return value;
  }

  const pathDelimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
  const sanitizedPath = value
    .split(pathDelimiter)
    .filter((entry) => entry !== "")
    .join(pathDelimiter);
  return sanitizedPath === "" ? undefined : sanitizedPath;
}

function inspectLocalPath(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function canonicalWindowsSystemRoot(
  inheritedEnvironment: Readonly<Record<string, string | undefined>>,
) {
  const candidates = Object.entries(inheritedEnvironment)
    .filter(([name]) => name.toUpperCase() === "SYSTEMROOT")
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined && value !== "");
  if (
    candidates.length === 0 ||
    new Set(candidates.map((value) => value.toLowerCase())).size !== 1
  ) {
    throw new Error("SystemRoot precisa ser único no ambiente Windows do webServer.");
  }

  const systemRoot = candidates[0];
  if (
    systemRoot === undefined ||
    systemRoot.includes("\0") ||
    !win32.isAbsolute(systemRoot) ||
    win32.resolve(systemRoot) !== systemRoot ||
    !/^[A-Za-z]:\\[^\\]/u.test(systemRoot)
  ) {
    throw new Error("SystemRoot não identifica um diretório Windows absoluto canônico.");
  }
  return systemRoot;
}

function assertPhysicalWindowsComSpec(
  systemRoot: string,
  inspectPhysicalPath: InspectPhysicalPath,
) {
  const system32 = win32.join(systemRoot, "System32");
  const commandProcessor = win32.join(system32, "cmd.exe");
  for (const directoryPath of [systemRoot, system32]) {
    const information = inspectPhysicalPath(directoryPath);
    if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("O caminho físico do ComSpec do Windows não pôde ser comprovado.");
    }
  }
  const executableInformation = inspectPhysicalPath(commandProcessor);
  if (
    executableInformation === undefined ||
    !executableInformation.isFile() ||
    executableInformation.isSymbolicLink()
  ) {
    throw new Error("O ComSpec do Windows precisa ser um executável físico regular.");
  }
  return commandProcessor;
}

function setWindowsCaseFoldedValue(
  overlay: Record<string, string>,
  inheritedEnvironment: Readonly<Record<string, string | undefined>>,
  canonicalName: string,
  value: string,
) {
  overlay[canonicalName] = value;
  for (const inheritedName of Object.keys(inheritedEnvironment)) {
    if (inheritedName.toUpperCase() === canonicalName.toUpperCase()) {
      overlay[inheritedName] = value;
    }
  }
}

export function createPlaywrightWebServerEnvironmentOverlay(
  inheritedEnvironment: Readonly<Record<string, string | undefined>>,
  {
    inspectPhysicalPath = inspectLocalPath,
    platform = process.platform,
  }: { inspectPhysicalPath?: InspectPhysicalPath; platform?: NodeJS.Platform } = {},
) {
  const overlay: Record<string, string> = Object.fromEntries(
    Object.keys(inheritedEnvironment).map((name) => [name, ""]),
  );

  if (platform !== "win32") {
    for (const name of operationalEnvironmentNames) {
      const value = sanitizedOperationalValue(name, inheritedEnvironment[name], platform);
      if (value !== undefined) {
        overlay[name] = value;
      }
    }
    return overlay;
  }

  const valuesByCanonicalName = new Map<string, string>();
  for (const [inheritedName, inheritedValue] of Object.entries(inheritedEnvironment)) {
    const canonicalName = windowsOperationalEnvironmentNames.get(inheritedName.toUpperCase());
    if (
      canonicalName === undefined ||
      canonicalName === "SystemRoot" ||
      canonicalName === "WINDIR"
    ) {
      continue;
    }
    const value = sanitizedOperationalValue(canonicalName, inheritedValue, platform);
    if (value === undefined) {
      continue;
    }
    const previousValue = valuesByCanonicalName.get(canonicalName);
    if (previousValue !== undefined && previousValue !== value) {
      throw new Error(`O ambiente Windows contém variantes conflitantes de ${canonicalName}.`);
    }
    valuesByCanonicalName.set(canonicalName, value);
  }
  for (const [canonicalName, value] of valuesByCanonicalName) {
    setWindowsCaseFoldedValue(overlay, inheritedEnvironment, canonicalName, value);
  }

  const systemRoot = canonicalWindowsSystemRoot(inheritedEnvironment);
  const commandProcessor = assertPhysicalWindowsComSpec(systemRoot, inspectPhysicalPath);
  setWindowsCaseFoldedValue(overlay, inheritedEnvironment, "SystemRoot", systemRoot);
  setWindowsCaseFoldedValue(overlay, inheritedEnvironment, "WINDIR", systemRoot);
  setWindowsCaseFoldedValue(overlay, inheritedEnvironment, "ComSpec", commandProcessor);
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
