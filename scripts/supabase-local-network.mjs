import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

import { canonicalDockerCliPath, resolveTrustedDockerCli } from "./docker-local-context.mjs";
import { assertWindowsPathWithoutReparse } from "./windows-filesystem-security.mjs";

export const supabaseLocalNetworkName = "set-livre-loopback";
export const supabaseLocalProjectId = "set-livre";

const loopbackBindingOption = "com.docker.network.bridge.host_binding_ipv4";
const expectedPublishedPortMatrix = new Map([
  [`supabase_kong_${supabaseLocalProjectId}`, { containerPort: "8000/tcp", hostPort: "54321" }],
  [`supabase_db_${supabaseLocalProjectId}`, { containerPort: "5432/tcp", hostPort: "54322" }],
  [`supabase_studio_${supabaseLocalProjectId}`, { containerPort: "3000/tcp", hostPort: "54323" }],
  [`supabase_inbucket_${supabaseLocalProjectId}`, { containerPort: "8025/tcp", hostPort: "54324" }],
]);
const windowsDockerPortBindingBehavior = "local-only-port-binding";
const maximumDockerSettingsBytes = 1024 * 1024;

export function describeSupabaseLocalPublication(platform = process.platform) {
  return platform === "win32"
    ? "restrita ao localhost pelo port binding oficial do Docker Desktop"
    : "restrita a 127.0.0.1";
}

function samePhysicalFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function assertWindowsDockerDesktopSettingsPayload(serialized) {
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > maximumDockerSettingsBytes ||
    (serialized.match(/"PortBindingBehavior"\s*:/gu) ?? []).length !== 1
  ) {
    throw new Error("A configuração do Docker Desktop não possui contrato local inequívoco.");
  }
  let settings;
  try {
    settings = JSON.parse(serialized);
  } catch {
    throw new Error("A configuração do Docker Desktop não contém JSON válido.");
  }
  if (
    settings === null ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    settings.PortBindingBehavior !== windowsDockerPortBindingBehavior
  ) {
    throw new Error(
      "O Docker Desktop precisa usar o Port binding behavior oficial Localhost only.",
    );
  }
}

export function assertWindowsDockerDesktopLocalPortBinding(
  environment = process.env,
  {
    assertPhysicalPath = assertWindowsPathWithoutReparse,
    closeFile = closeSync,
    inspectDescriptor = fstatSync,
    inspectPath = lstatSync,
    openFile = openSync,
    platform = process.platform,
    readFile = readFileSync,
  } = {},
) {
  if (platform !== "win32") {
    return;
  }
  const appData = environment.APPDATA;
  const userProfile = environment.USERPROFILE;
  if (
    typeof appData !== "string" ||
    typeof userProfile !== "string" ||
    appData.includes("\0") ||
    userProfile.includes("\0") ||
    !win32.isAbsolute(appData) ||
    !win32.isAbsolute(userProfile)
  ) {
    throw new Error("O perfil Windows não permite localizar o Docker Desktop com segurança.");
  }
  const canonicalProfile = win32.resolve(userProfile);
  const canonicalAppData = win32.resolve(canonicalProfile, "AppData", "Roaming");
  if (
    win32.resolve(appData).toLocaleLowerCase("en-US") !==
    canonicalAppData.toLocaleLowerCase("en-US")
  ) {
    throw new Error("APPDATA não corresponde ao perfil Windows canônico.");
  }
  const settingsPath = win32.resolve(canonicalAppData, "Docker", "settings-store.json");
  assertPhysicalPath(settingsPath, {
    description: "A configuração do Docker Desktop",
    leafKind: "file",
  });
  const initialInformation = inspectPath(settingsPath, { throwIfNoEntry: false });
  if (
    initialInformation === undefined ||
    !initialInformation.isFile() ||
    initialInformation.isSymbolicLink() ||
    initialInformation.size > maximumDockerSettingsBytes
  ) {
    throw new Error("A configuração do Docker Desktop não é um arquivo físico regular.");
  }

  let descriptor;
  try {
    descriptor = openFile(settingsPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInformation = inspectDescriptor(descriptor);
    if (!samePhysicalFile(initialInformation, openedInformation)) {
      throw new Error("A configuração do Docker Desktop mudou durante a abertura.");
    }
    const serialized = readFile(descriptor, "utf8");
    assertWindowsDockerDesktopSettingsPayload(serialized);
    const finalDescriptorInformation = inspectDescriptor(descriptor);
    const finalPathInformation = inspectPath(settingsPath, { throwIfNoEntry: false });
    if (
      finalPathInformation === undefined ||
      !samePhysicalFile(openedInformation, finalDescriptorInformation) ||
      !samePhysicalFile(openedInformation, finalPathInformation) ||
      finalDescriptorInformation.size !== openedInformation.size
    ) {
      throw new Error("A configuração do Docker Desktop mudou durante a validação.");
    }
  } finally {
    if (descriptor !== undefined) {
      closeFile(descriptor);
    }
  }
}

function createTrustedDockerCommand({
  executeDocker = execFileSync,
  platform = process.platform,
  resolveDockerCli = resolveTrustedDockerCli,
} = {}) {
  const executable = resolveDockerCli({ platform });
  if (executable !== canonicalDockerCliPath(platform)) {
    throw new Error("A resolução da CLI Docker diverge do caminho canônico permitido.");
  }
  return { executable, executeDocker, platform };
}

function docker(command, argumentsList, environment = process.env) {
  return command
    .executeDocker(command.executable, argumentsList, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
    .trim();
}

export function assertLoopbackNetworkInspection(inspections) {
  if (!Array.isArray(inspections) || inspections.length !== 1) {
    throw new Error("A rede Docker local precisa ter uma única inspeção autoritativa.");
  }

  const [inspection] = inspections;
  if (
    inspection?.Name !== supabaseLocalNetworkName ||
    inspection.Driver !== "bridge" ||
    inspection.Scope !== "local" ||
    inspection.Internal !== false ||
    inspection.Options?.[loopbackBindingOption] !== "127.0.0.1"
  ) {
    throw new Error(
      `A rede ${supabaseLocalNetworkName} existe com configuração insegura; remova-a somente após parar a stack local.`,
    );
  }
}

function bindingMode(bindings, hostPort, hostConfigBindings, platform, windowsDockerDesktop) {
  const canonicalHostConfigBinding =
    Array.isArray(hostConfigBindings) &&
    hostConfigBindings.length === 1 &&
    hostConfigBindings[0]?.HostIp === "" &&
    hostConfigBindings[0]?.HostPort === hostPort;
  if (
    bindings.length === 1 &&
    bindings[0]?.HostIp === "127.0.0.1" &&
    bindings[0]?.HostPort === hostPort &&
    canonicalHostConfigBinding
  ) {
    return "literal-loopback";
  }

  const hostIps = bindings.map((binding) => binding?.HostIp).sort();
  const desktopLocalOnly =
    platform === "win32" &&
    windowsDockerDesktop === true &&
    bindings.length === 2 &&
    hostIps[0] === "127.0.0.1" &&
    hostIps[1] === "::" &&
    bindings.every((binding) => binding?.HostPort === hostPort) &&
    canonicalHostConfigBinding;
  if (desktopLocalOnly) {
    return "windows-desktop-local-only";
  }

  throw new Error("O Docker publicou uma porta fora do contrato local permitido.");
}

export function assertLoopbackContainerInspections(
  inspections,
  { platform = "linux", windowsDockerDesktop = false } = {},
) {
  if (!Array.isArray(inspections) || inspections.length === 0) {
    throw new Error("Nenhum container Supabase local em execução foi encontrado.");
  }

  const publishedPorts = new Set();
  const inspectedContainerNames = new Set();
  const publishedContainerNames = new Set();
  const modes = new Set();
  for (const inspection of inspections) {
    const rawContainerName = inspection?.Name;
    const containerName =
      typeof rawContainerName === "string" && rawContainerName.startsWith("/")
        ? rawContainerName.slice(1)
        : rawContainerName;
    if (
      typeof containerName !== "string" ||
      containerName.length === 0 ||
      inspectedContainerNames.has(containerName) ||
      inspection?.Config?.Labels?.["com.supabase.cli.project"] !== supabaseLocalProjectId
    ) {
      throw new Error("O Docker retornou uma identidade de container Supabase inválida.");
    }
    inspectedContainerNames.add(containerName);
    if (inspection?.NetworkSettings?.Networks?.[supabaseLocalNetworkName] === undefined) {
      throw new Error(`O container ${containerName} não pertence à rede local restrita.`);
    }

    const networkPorts = inspection.NetworkSettings.Ports ?? {};
    const hostConfigPorts = inspection.HostConfig?.PortBindings ?? {};
    if (
      networkPorts === null ||
      typeof networkPorts !== "object" ||
      Array.isArray(networkPorts) ||
      hostConfigPorts === null ||
      typeof hostConfigPorts !== "object" ||
      Array.isArray(hostConfigPorts)
    ) {
      throw new Error("O Docker retornou um contrato de portas local inválido.");
    }
    const expectedPublication = expectedPublishedPortMatrix.get(containerName);
    const configuredPublications = Object.entries(hostConfigPorts).filter(
      ([, bindings]) => bindings !== null,
    );
    const effectivePublications = Object.entries(networkPorts).filter(
      ([, bindings]) => bindings !== null,
    );
    if (
      expectedPublication === undefined
        ? configuredPublications.length !== 0 || effectivePublications.length !== 0
        : configuredPublications.length !== 1 ||
          configuredPublications[0][0] !== expectedPublication.containerPort ||
          effectivePublications.length !== 1 ||
          effectivePublications[0][0] !== expectedPublication.containerPort
    ) {
      throw new Error("A publicação Docker diverge da matriz exata do Supabase local.");
    }

    for (const [containerPort, bindings] of effectivePublications) {
      if (bindings === null) {
        continue;
      }
      if (!Array.isArray(bindings)) {
        throw new Error("O Docker retornou um contrato de portas local inválido.");
      }

      if (
        bindings.length === 0 ||
        bindings.some((binding) => typeof binding?.HostPort !== "string")
      ) {
        throw new Error("O Docker retornou um contrato de portas local inválido.");
      }
      const hostPort = bindings[0].HostPort;
      if (
        expectedPublication === undefined ||
        containerPort !== expectedPublication.containerPort ||
        hostPort !== expectedPublication.hostPort ||
        publishedContainerNames.has(containerName)
      ) {
        throw new Error("A publicação Docker diverge da matriz exata do Supabase local.");
      }
      if (publishedPorts.has(hostPort)) {
        throw new Error(`A porta local ${hostPort} foi publicada mais de uma vez.`);
      }
      const hostConfigBindings = hostConfigPorts[containerPort];
      modes.add(
        bindingMode(bindings, hostPort, hostConfigBindings, platform, windowsDockerDesktop),
      );
      publishedPorts.add(hostPort);
      publishedContainerNames.add(containerName);
    }
  }

  if (
    publishedContainerNames.size !== expectedPublishedPortMatrix.size ||
    [...expectedPublishedPortMatrix.entries()].some(
      ([containerName, publication]) =>
        !publishedContainerNames.has(containerName) || !publishedPorts.has(publication.hostPort),
    )
  ) {
    throw new Error("A stack Supabase não publicou a matriz local completa esperada.");
  }
  if (modes.size !== 1) {
    throw new Error("A stack Supabase misturou modos de publicação local incompatíveis.");
  }
  return modes;
}

export function ensureSupabaseLoopbackNetwork(environment = process.env, options = {}) {
  const command = createTrustedDockerCommand(options);
  assertWindowsDockerDesktopLocalPortBinding(environment, {
    assertPhysicalPath: options.assertWindowsDockerSettingsPath,
    closeFile: options.closeDockerSettingsFile,
    inspectDescriptor: options.inspectDockerSettingsDescriptor,
    inspectPath: options.inspectDockerSettingsPath,
    openFile: options.openDockerSettingsFile,
    platform: command.platform,
    readFile: options.readDockerSettingsFile,
  });
  const existingNames = docker(
    command,
    ["network", "ls", "--filter", `name=^${supabaseLocalNetworkName}$`, "--format", "{{.Name}}"],
    environment,
  )
    .split("\n")
    .filter(Boolean);

  if (existingNames.length === 0) {
    docker(
      command,
      [
        "network",
        "create",
        "--driver",
        "bridge",
        "--opt",
        `${loopbackBindingOption}=127.0.0.1`,
        supabaseLocalNetworkName,
      ],
      environment,
    );
  } else if (existingNames.length !== 1 || existingNames[0] !== supabaseLocalNetworkName) {
    throw new Error(
      `A rede Docker ${supabaseLocalNetworkName} não pôde ser identificada com segurança.`,
    );
  }

  const inspections = JSON.parse(
    docker(command, ["network", "inspect", supabaseLocalNetworkName], environment),
  );
  assertLoopbackNetworkInspection(inspections);
}

function supabaseProjectContainerIds(command, environment = process.env) {
  return docker(
    command,
    [
      "ps",
      "--filter",
      `label=com.supabase.cli.project=${supabaseLocalProjectId}`,
      "--format",
      "{{.ID}}",
    ],
    environment,
  )
    .split("\n")
    .filter(Boolean);
}

export function supabaseProjectContainersAreRunning(environment = process.env, options = {}) {
  const command = createTrustedDockerCommand(options);
  return supabaseProjectContainerIds(command, environment).length > 0;
}

export function assertSupabaseProjectStopped(environment = process.env, options = {}) {
  if (supabaseProjectContainersAreRunning(environment, options)) {
    throw new Error("A stack Supabase insegura não pôde ser encerrada integralmente.");
  }
}

export function assertSupabaseLoopbackBindings(environment = process.env, options = {}) {
  const command = createTrustedDockerCommand(options);
  assertWindowsDockerDesktopLocalPortBinding(environment, {
    assertPhysicalPath: options.assertWindowsDockerSettingsPath,
    closeFile: options.closeDockerSettingsFile,
    inspectDescriptor: options.inspectDockerSettingsDescriptor,
    inspectPath: options.inspectDockerSettingsPath,
    openFile: options.openDockerSettingsFile,
    platform: command.platform,
    readFile: options.readDockerSettingsFile,
  });
  const containerIds = supabaseProjectContainerIds(command, environment);

  if (containerIds.length === 0) {
    throw new Error("Nenhum container da stack Set Livre está em execução.");
  }

  const inspections = JSON.parse(docker(command, ["inspect", ...containerIds], environment));
  assertLoopbackContainerInspections(inspections, {
    platform: command.platform,
    // O chamador já recebeu este ambiente de assertLocalDockerDaemon(), que prova
    // o named pipe local canônico e OSType=linux antes de qualquer operação.
    windowsDockerDesktop: command.platform === "win32",
  });
}
