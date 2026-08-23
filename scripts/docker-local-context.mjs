import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { posix, win32 } from "node:path";

import {
  assertWindowsTrustedPathIntegrity,
  createTrustedCliEnvironment,
} from "./trusted-npm-cli.mjs";

const defaultContextName = "default";
const desktopLinuxContextName = "desktop-linux";
const posixLocalEndpoint = "unix:///var/run/docker.sock";
const windowsDefaultEndpoint = "npipe:////./pipe/docker_engine";
const windowsDesktopLinuxEndpoint = "npipe:////./pipe/dockerDesktopLinuxEngine";
const windowsDockerDesktopRoot = String.raw`C:\Program Files`;
const windowsDockerDesktopCli = win32.resolve(
  windowsDockerDesktopRoot,
  "Docker/Docker/resources/bin/docker.exe",
);
const linuxDockerCli = "/usr/bin/docker";

function dockerCliContract(platform) {
  if (platform === "win32") {
    return {
      executable: windowsDockerDesktopCli,
      pathApi: win32,
      trustedRoot: windowsDockerDesktopRoot,
    };
  }
  if (platform === "linux") {
    return { executable: linuxDockerCli, pathApi: posix, trustedRoot: "/" };
  }
  throw new Error("A CLI Docker local só possui contrato canônico para Windows e Linux.");
}

export function canonicalDockerCliPath(platform = process.platform) {
  return dockerCliContract(platform).executable;
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

function assertPhysicalDockerPathEntry(information, path, { file, platform }) {
  if (
    information === undefined ||
    information.isSymbolicLink() ||
    (file ? !information.isFile() : !information.isDirectory())
  ) {
    throw new Error(`A cadeia física da CLI Docker contém um caminho inválido: ${path}`);
  }
  if (platform === "linux" && (information.uid !== 0 || (information.mode & 0o022) !== 0)) {
    throw new Error("A CLI Docker canônica ou um ancestral possui owner/permissões inseguros.");
  }
}

export function resolveTrustedDockerCli({
  assertWindowsIntegrity = assertWindowsTrustedPathIntegrity,
  closeFile = closeSync,
  inspectDescriptor = fstatSync,
  inspectPath = lstatSync,
  openFile = openSync,
  platform = process.platform,
} = {}) {
  const contract = dockerCliContract(platform);
  const { executable, pathApi, trustedRoot } = contract;
  if (
    !pathApi.isAbsolute(executable) ||
    pathApi.resolve(executable) !== executable ||
    executable.includes("\0")
  ) {
    throw new Error("A CLI Docker canônica precisa usar caminho físico absoluto.");
  }

  const chain = physicalPathChain(executable, pathApi);
  let initialFileInformation;
  for (const [index, path] of chain.entries()) {
    const information = inspectPath(path, { throwIfNoEntry: false });
    const file = index === chain.length - 1;
    assertPhysicalDockerPathEntry(information, path, { file, platform });
    if (file) {
      initialFileInformation = information;
    }
  }

  let descriptor;
  try {
    descriptor = openFile(executable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = inspectDescriptor(descriptor);
    assertPhysicalDockerPathEntry(openedInformation, executable, { file: true, platform });
    if (!samePhysicalFile(initialFileInformation, openedInformation)) {
      throw new Error("A CLI Docker canônica mudou durante a abertura.");
    }

    if (platform === "win32") {
      assertWindowsIntegrity(executable, {
        systemRoot: String.raw`C:\Windows`,
        trustedRoot,
      });
    }

    const finalDescriptorInformation = inspectDescriptor(descriptor);
    const finalPathInformation = inspectPath(executable, { throwIfNoEntry: false });
    assertPhysicalDockerPathEntry(finalDescriptorInformation, executable, {
      file: true,
      platform,
    });
    assertPhysicalDockerPathEntry(finalPathInformation, executable, { file: true, platform });
    if (
      !samePhysicalFile(openedInformation, finalDescriptorInformation) ||
      !samePhysicalFile(openedInformation, finalPathInformation)
    ) {
      throw new Error("A CLI Docker canônica mudou durante a validação.");
    }
  } finally {
    if (descriptor !== undefined) {
      closeFile(descriptor);
    }
  }

  return executable;
}

function localDockerContracts(platform = process.platform) {
  return platform === "win32"
    ? [
        { endpoint: windowsDefaultEndpoint, name: defaultContextName },
        { endpoint: windowsDesktopLinuxEndpoint, name: desktopLinuxContextName },
      ]
    : [{ endpoint: posixLocalEndpoint, name: defaultContextName }];
}

function contractForContext(contextName, platform) {
  return localDockerContracts(platform).find(({ name }) => name === contextName);
}

export function localDockerDaemonEndpoint(
  platform = process.platform,
  contextName = defaultContextName,
) {
  const contract = contractForContext(contextName, platform);
  if (contract === undefined) {
    throw new Error("O contexto Docker informado não pertence à allowlist local.");
  }
  return contract.endpoint;
}

export function assertLocalDockerEnvironment(environment, platform = process.platform) {
  const contracts = localDockerContracts(platform);
  const dockerHost = environment.DOCKER_HOST;
  const hostContract = contracts.find(({ endpoint }) => endpoint === dockerHost);
  if (dockerHost !== undefined && dockerHost !== "" && hostContract === undefined) {
    throw new Error("DOCKER_HOST precisa estar ausente ou apontar para um daemon Docker local.");
  }

  const dockerContext = environment.DOCKER_CONTEXT;
  const contextContract = contracts.find(({ name }) => name === dockerContext);
  if (dockerContext !== undefined && dockerContext !== "" && contextContract === undefined) {
    throw new Error("DOCKER_CONTEXT precisa estar ausente ou selecionar um contexto local.");
  }

  if (
    hostContract !== undefined &&
    contextContract !== undefined &&
    hostContract.name !== contextContract.name
  ) {
    throw new Error("DOCKER_HOST e DOCKER_CONTEXT selecionam contratos locais diferentes.");
  }
}

export function assertLocalDockerContext(
  activeContext,
  contextInspection,
  platform = process.platform,
) {
  const contract = contractForContext(activeContext, platform);
  if (contract === undefined) {
    throw new Error(
      "O contexto Docker ativo precisa pertencer à allowlist de operações locais destrutivas.",
    );
  }

  if (
    contextInspection?.Name !== contract.name ||
    contextInspection?.Endpoints?.docker?.Host !== contract.endpoint
  ) {
    throw new Error("O contexto Docker local não aponta para o named pipe ou socket documentado.");
  }

  return contract;
}

export function assertLocalDockerEngineInspection(engineInspection) {
  if (engineInspection?.OSType !== "linux") {
    throw new Error("O daemon Docker local precisa executar containers Linux.");
  }
}

function contextInspectionEnvironment(environment, platform) {
  const inspectionEnvironment = closedDockerEnvironment(environment, platform);
  delete inspectionEnvironment.DOCKER_HOST;
  return inspectionEnvironment;
}

function localDockerCommandEnvironment(environment, contract, platform) {
  const localEnvironment = closedDockerEnvironment(environment, platform);
  delete localEnvironment.DOCKER_CONTEXT;
  return {
    ...localEnvironment,
    DOCKER_HOST: contract.endpoint,
  };
}

function closedDockerEnvironment(environment, platform = process.platform) {
  const inherited = createTrustedCliEnvironment(environment, {
    additionalWindowsNames: ["DOCKER_CONTEXT", "DOCKER_HOST"],
    platform,
  });
  const allowedNames = new Set([
    "APPDATA",
    "CI",
    "DOCKER_CONTEXT",
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
  return Object.fromEntries(
    Object.entries(inherited).filter(([name]) =>
      allowedNames.has(platform === "win32" ? name.toUpperCase() : name),
    ),
  );
}

function dockerOutput(executeDocker, dockerCliPath, argumentsList, environment) {
  const output = executeDocker(dockerCliPath, argumentsList, {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (typeof output !== "string") {
    throw new Error("invalid-docker-output");
  }
  return output.trim();
}

export function assertLocalDockerDaemon({
  environment = process.env,
  executeDocker = execFileSync,
  platform = process.platform,
  resolveDockerCli = resolveTrustedDockerCli,
} = {}) {
  assertLocalDockerEnvironment(environment, platform);
  const dockerCliPath = resolveDockerCli({ platform });
  if (dockerCliPath !== canonicalDockerCliPath(platform)) {
    throw new Error("A resolução da CLI Docker diverge do caminho canônico permitido.");
  }
  const inspectionEnvironment = contextInspectionEnvironment(environment, platform);

  let activeContext;
  try {
    activeContext = dockerOutput(
      executeDocker,
      dockerCliPath,
      ["context", "show"],
      inspectionEnvironment,
    );
  } catch {
    throw new Error("Não foi possível identificar o contexto Docker ativo com segurança.");
  }
  if (contractForContext(activeContext, platform) === undefined) {
    throw new Error("O contexto Docker ativo não pertence à allowlist local.");
  }

  let contextInspection;
  try {
    contextInspection = JSON.parse(
      dockerOutput(
        executeDocker,
        dockerCliPath,
        ["context", "inspect", activeContext, "--format", "{{json .}}"],
        inspectionEnvironment,
      ),
    );
  } catch {
    throw new Error("Não foi possível inspecionar o contexto Docker local com segurança.");
  }
  const contract = assertLocalDockerContext(activeContext, contextInspection, platform);

  if (
    environment.DOCKER_HOST !== undefined &&
    environment.DOCKER_HOST !== "" &&
    environment.DOCKER_HOST !== contract.endpoint
  ) {
    throw new Error("DOCKER_HOST não corresponde ao contexto Docker local ativo.");
  }
  if (
    environment.DOCKER_CONTEXT !== undefined &&
    environment.DOCKER_CONTEXT !== "" &&
    environment.DOCKER_CONTEXT !== contract.name
  ) {
    throw new Error("DOCKER_CONTEXT não corresponde ao contexto Docker local ativo.");
  }

  const commandEnvironment = localDockerCommandEnvironment(environment, contract, platform);
  let engineInspection;
  try {
    engineInspection = JSON.parse(
      dockerOutput(
        executeDocker,
        dockerCliPath,
        ["info", "--format", "{{json .}}"],
        commandEnvironment,
      ),
    );
  } catch {
    throw new Error("Não foi possível comprovar o daemon Docker local com segurança.");
  }
  assertLocalDockerEngineInspection(engineInspection);

  return commandEnvironment;
}
