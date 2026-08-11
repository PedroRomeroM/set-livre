import { execFileSync } from "node:child_process";

const localDockerContextName = "default";

export function localDockerDaemonEndpoint(platform = process.platform) {
  return platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
}

export function assertLocalDockerEnvironment(environment, platform = process.platform) {
  const expectedEndpoint = localDockerDaemonEndpoint(platform);
  const dockerHost = environment.DOCKER_HOST;
  if (dockerHost !== undefined && dockerHost !== "" && dockerHost !== expectedEndpoint) {
    throw new Error("DOCKER_HOST precisa estar ausente ou apontar para o daemon Docker local.");
  }

  const dockerContext = environment.DOCKER_CONTEXT;
  if (
    dockerContext !== undefined &&
    dockerContext !== "" &&
    dockerContext !== localDockerContextName
  ) {
    throw new Error("DOCKER_CONTEXT precisa estar ausente ou selecionar o contexto default.");
  }
}

export function assertLocalDockerContext(
  activeContext,
  contextInspection,
  platform = process.platform,
) {
  if (activeContext !== localDockerContextName) {
    throw new Error(
      "O contexto Docker ativo precisa ser default para operações locais destrutivas.",
    );
  }

  if (
    contextInspection?.Name !== localDockerContextName ||
    contextInspection?.Endpoints?.docker?.Host !== localDockerDaemonEndpoint(platform)
  ) {
    throw new Error("O contexto Docker default não aponta para o daemon local documentado.");
  }
}

function localDockerCommandEnvironment(environment, platform = process.platform) {
  const localEnvironment = {
    ...environment,
    DOCKER_HOST: localDockerDaemonEndpoint(platform),
  };
  delete localEnvironment.DOCKER_CONTEXT;
  return localEnvironment;
}

export function assertLocalDockerDaemon({
  environment = process.env,
  executeDocker = execFileSync,
  platform = process.platform,
} = {}) {
  assertLocalDockerEnvironment(environment, platform);
  const contextInspectionEnvironment = { ...environment };
  delete contextInspectionEnvironment.DOCKER_CONTEXT;
  delete contextInspectionEnvironment.DOCKER_HOST;

  let activeContext;
  let contextInspection;
  try {
    activeContext = executeDocker("docker", ["context", "show"], {
      encoding: "utf8",
      env: contextInspectionEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (activeContext !== localDockerContextName) {
      throw new Error("unsafe-context");
    }

    const inspectionOutput = executeDocker(
      "docker",
      ["context", "inspect", localDockerContextName, "--format", "{{json .}}"],
      {
        encoding: "utf8",
        env: contextInspectionEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    contextInspection = JSON.parse(inspectionOutput);
  } catch (error) {
    if (error instanceof Error && error.message === "unsafe-context") {
      throw new Error("O contexto Docker ativo precisa ser default para o setup local.");
    }
    throw new Error("Não foi possível comprovar o contexto Docker local com segurança.");
  }

  assertLocalDockerContext(activeContext, contextInspection, platform);
  return localDockerCommandEnvironment(environment, platform);
}
