import { superviseDevelopmentProcesses } from "./development-process-tree.mjs";

const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function interruptionError(signal) {
  const error = new Error(
    `Preview local interrompido por ${signal} (código ${signalExitCodes[signal]}).`,
  );
  error.exitCode = signalExitCodes[signal];
  return error;
}

export async function runLocalProductionPreviewProcessFlow({
  clearShutdownTimeout = clearTimeout,
  forceShutdownMilliseconds = 5_000,
  platform = process.platform,
  prepareBuild,
  scheduleShutdownTimeout = setTimeout,
  signalProcessGroup = process.kill,
  signalSource = process,
  startBuild,
  startServer,
  systemRoot = process.env.SystemRoot,
  terminateWindowsTree,
  validateBuild,
} = {}) {
  for (const [label, operation] of [
    ["preparo", prepareBuild],
    ["build", startBuild],
    ["validação", validateBuild],
    ["servidor", startServer],
  ]) {
    if (typeof operation !== "function") {
      throw new Error(`O fluxo do preview exige uma operação válida de ${label}.`);
    }
  }

  let requestedSignal;
  const recordSignal = (signal) => {
    requestedSignal ??= signal;
  };
  const handleSighup = () => recordSignal("SIGHUP");
  const handleSigint = () => recordSignal("SIGINT");
  const handleSigterm = () => recordSignal("SIGTERM");

  // Esta camada existe antes de prepareBuild e, portanto, antes da primeira factory/spawn.
  signalSource.on("SIGHUP", handleSighup);
  signalSource.on("SIGINT", handleSigint);
  signalSource.on("SIGTERM", handleSigterm);

  async function runPhase(startProcess, phase, { requestShutdownOnSuccessfulExit = false } = {}) {
    let processState;
    let startFailure;
    try {
      startProcess((state) => {
        if (
          processState !== undefined ||
          state === null ||
          typeof state !== "object" ||
          state.child === undefined
        ) {
          throw new Error(`A factory de ${phase} retornou um processo inválido.`);
        }
        processState = state;
      });
    } catch (error) {
      startFailure = error;
    }

    if (processState === undefined) {
      if (requestedSignal !== undefined) {
        throw interruptionError(requestedSignal);
      }
      if (startFailure !== undefined) {
        throw startFailure;
      }
      throw new Error(`A factory de ${phase} não iniciou processo.`);
    }

    const exitTarget = {};
    let supervisor;
    if (requestShutdownOnSuccessfulExit) {
      // A fase finita registra sua conclusão esperada antes do handler genérico de serviços.
      processState.child.once("close", (code, signal) => {
        if (code === 0 && signal === null) {
          supervisor.beginShutdown("SIGTERM", 0);
        }
      });
    }
    supervisor = superviseDevelopmentProcesses({
      children: [{ child: processState.child, name: phase }],
      clearShutdownTimeout,
      exitTarget,
      forceShutdownMilliseconds,
      platform,
      retainExitedWindowsProcessTrees: true,
      scheduleShutdownTimeout,
      signalProcessGroup,
      signalSource,
      systemRoot,
      terminateWindowsTree,
      writeError: () => {},
    });

    if (requestedSignal !== undefined) {
      supervisor.beginShutdown(requestedSignal, signalExitCodes[requestedSignal]);
    } else if (startFailure !== undefined) {
      supervisor.beginShutdown("SIGTERM", 1);
    }
    const exitCode = await supervisor.completion;

    if (requestedSignal !== undefined) {
      throw interruptionError(requestedSignal);
    }
    if (startFailure !== undefined) {
      throw startFailure;
    }
    return exitCode;
  }

  try {
    prepareBuild();
    if (requestedSignal !== undefined) {
      throw interruptionError(requestedSignal);
    }

    const buildExitCode = await runPhase(startBuild, "build do preview", {
      requestShutdownOnSuccessfulExit: true,
    });
    if (buildExitCode !== 0) {
      throw new Error(`O build fresco do preview encerrou com código ${buildExitCode}.`);
    }

    validateBuild();
    if (requestedSignal !== undefined) {
      throw interruptionError(requestedSignal);
    }

    const serverExitCode = await runPhase(startServer, "servidor do preview");
    throw new Error(`O servidor do preview encerrou prematuramente com código ${serverExitCode}.`);
  } finally {
    signalSource.removeListener("SIGHUP", handleSighup);
    signalSource.removeListener("SIGINT", handleSigint);
    signalSource.removeListener("SIGTERM", handleSigterm);
  }
}
