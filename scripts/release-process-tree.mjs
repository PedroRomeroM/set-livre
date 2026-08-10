import { superviseDevelopmentProcesses } from "./development-process-tree.mjs";

const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export async function runPackagedReleaseSmokeWithProcessCleanup({
  clearShutdownTimeout = clearTimeout,
  forceShutdownMilliseconds = 5_000,
  platform = process.platform,
  scheduleShutdownTimeout = setTimeout,
  signalProcessGroup = process.kill,
  signalSource = process,
  smokeOperation,
  startProcesses,
  systemRoot = process.env.SystemRoot,
  terminateWindowsTree,
} = {}) {
  if (typeof startProcesses !== "function" || typeof smokeOperation !== "function") {
    throw new Error("O smoke da release exige processos empacotados e uma operação válida.");
  }

  let requestedSignal;
  const recordSignal = (signal) => {
    requestedSignal ??= signal;
  };
  const handleSighup = () => recordSignal("SIGHUP");
  const handleSigint = () => recordSignal("SIGINT");
  const handleSigterm = () => recordSignal("SIGTERM");
  // Esta primeira camada impede a terminação padrão antes de a factory registrar o primeiro PGID.
  signalSource.on("SIGHUP", handleSighup);
  signalSource.on("SIGINT", handleSigint);
  signalSource.on("SIGTERM", handleSigterm);

  try {
    const states = [];
    let startFailure;
    try {
      startProcesses((state) => {
        if (
          state === null ||
          typeof state !== "object" ||
          typeof state.application !== "string" ||
          state.application === "" ||
          state.child === undefined
        ) {
          throw new Error("A factory do smoke retornou um processo empacotado inválido.");
        }
        states.push(state);
      });
    } catch (error) {
      startFailure = error;
    }
    if (states.length === 0) {
      if (startFailure !== undefined) {
        throw startFailure;
      }
      throw new Error("O smoke da release não iniciou nenhum processo empacotado.");
    }

    const exitTarget = {};
    const supervisor = superviseDevelopmentProcesses({
      children: states.map((state) => ({
        child: state.child,
        name: `processo empacotado ${state.application}`,
      })),
      clearShutdownTimeout,
      exitTarget,
      forceShutdownMilliseconds,
      platform,
      scheduleShutdownTimeout,
      signalProcessGroup,
      signalSource,
      systemRoot,
      terminateWindowsTree,
      writeError: () => {},
    });
    let exitCode;
    let processesFinishedBeforeSmoke = false;
    let smokeFailure;
    let smokeFailed = false;
    if (requestedSignal !== undefined) {
      supervisor.beginShutdown(requestedSignal, signalExitCodes[requestedSignal]);
      exitCode = await supervisor.completion;
    } else if (startFailure !== undefined) {
      smokeFailed = true;
      smokeFailure = startFailure;
      supervisor.beginShutdown("SIGTERM", 1);
      exitCode = await supervisor.completion;
    } else {
      const smokeOutcome = Promise.resolve()
        .then(() => smokeOperation(states))
        .then(
          () => ({ error: undefined, failed: false, kind: "smoke" }),
          (error) => ({ error, failed: true, kind: "smoke" }),
        );
      const processOutcome = supervisor.completion.then((processExitCode) => ({
        exitCode: processExitCode,
        kind: "processes",
      }));
      const firstOutcome = await Promise.race([smokeOutcome, processOutcome]);

      if (firstOutcome.kind === "smoke") {
        smokeFailed = firstOutcome.failed;
        smokeFailure = firstOutcome.error;
        supervisor.beginShutdown("SIGTERM", smokeFailed ? 1 : 0);
        exitCode = await supervisor.completion;
      } else {
        exitCode = firstOutcome.exitCode;
        processesFinishedBeforeSmoke = true;
      }
    }

    if (requestedSignal !== undefined) {
      const interruptedError = new Error(
        `Smoke test interrompido por ${requestedSignal} (código ${signalExitCodes[requestedSignal]}).`,
      );
      interruptedError.exitCode = signalExitCodes[requestedSignal];
      throw interruptedError;
    }
    if (smokeFailed) {
      throw smokeFailure;
    }
    if (processesFinishedBeforeSmoke || exitCode !== 0) {
      throw new Error(`Um processo empacotado encerrou durante o smoke (código ${exitCode}).`);
    }
  } finally {
    signalSource.removeListener("SIGHUP", handleSighup);
    signalSource.removeListener("SIGINT", handleSigint);
    signalSource.removeListener("SIGTERM", handleSigterm);
  }
}
