import { execFileSync } from "node:child_process";

export const supabaseLocalNetworkName = "set-livre-loopback";
export const supabaseLocalProjectId = "set-livre";

const loopbackBindingOption = "com.docker.network.bridge.host_binding_ipv4";
const expectedPublishedPorts = new Set(["54321", "54322", "54323", "54324"]);

function docker(argumentsList, environment = process.env) {
  return execFileSync("docker", argumentsList, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

export function assertLoopbackContainerInspections(inspections) {
  if (!Array.isArray(inspections) || inspections.length === 0) {
    throw new Error("Nenhum container Supabase local em execução foi encontrado.");
  }

  const publishedPorts = new Set();
  for (const inspection of inspections) {
    if (inspection?.NetworkSettings?.Networks?.[supabaseLocalNetworkName] === undefined) {
      throw new Error(
        `O container ${inspection?.Name ?? "desconhecido"} não pertence à rede local restrita.`,
      );
    }

    for (const bindings of Object.values(inspection.NetworkSettings.Ports ?? {})) {
      if (bindings === null) {
        continue;
      }
      if (!Array.isArray(bindings)) {
        throw new Error("O Docker retornou um contrato de portas local inválido.");
      }

      for (const binding of bindings) {
        if (binding?.HostIp !== "127.0.0.1" || typeof binding.HostPort !== "string") {
          throw new Error(
            `O container ${inspection.Name} publicou uma porta fora do loopback IPv4.`,
          );
        }
        if (publishedPorts.has(binding.HostPort)) {
          throw new Error(`A porta local ${binding.HostPort} foi publicada mais de uma vez.`);
        }
        publishedPorts.add(binding.HostPort);
      }
    }
  }

  if (
    publishedPorts.size !== expectedPublishedPorts.size ||
    [...expectedPublishedPorts].some((port) => !publishedPorts.has(port))
  ) {
    throw new Error("A stack Supabase não publicou exatamente as portas locais esperadas.");
  }
}

export function ensureSupabaseLoopbackNetwork(environment = process.env) {
  const existingNames = docker(
    ["network", "ls", "--filter", `name=^${supabaseLocalNetworkName}$`, "--format", "{{.Name}}"],
    environment,
  )
    .split("\n")
    .filter(Boolean);

  if (existingNames.length === 0) {
    docker(
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
    docker(["network", "inspect", supabaseLocalNetworkName], environment),
  );
  assertLoopbackNetworkInspection(inspections);
}

function supabaseProjectContainerIds(environment = process.env) {
  return docker(
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

export function supabaseProjectContainersAreRunning(environment = process.env) {
  return supabaseProjectContainerIds(environment).length > 0;
}

export function assertSupabaseProjectStopped(environment = process.env) {
  if (supabaseProjectContainersAreRunning(environment)) {
    throw new Error("A stack Supabase insegura não pôde ser encerrada integralmente.");
  }
}

export function assertSupabaseLoopbackBindings(environment = process.env) {
  const containerIds = supabaseProjectContainerIds(environment);

  if (containerIds.length === 0) {
    throw new Error("Nenhum container da stack Set Livre está em execução.");
  }

  const inspections = JSON.parse(docker(["inspect", ...containerIds], environment));
  assertLoopbackContainerInspections(inspections);
}
