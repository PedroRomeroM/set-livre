import { terminateWindowsProcessTree } from "./windows-process-tree.mjs";

const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };

function isMissingProcessError(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

export function superviseDevelopmentProcesses({
  children,
  clearShutdownTimeout = clearTimeout,
  exitTarget = process,
  forceShutdownMilliseconds = 5_000,
  platform = process.platform,
  scheduleShutdownTimeout = setTimeout,
  signalProcessGroup = process.kill,
  signalSource = process,
  systemRoot = process.env.SystemRoot,
  terminateWindowsTree = terminateWindowsProcessTree,
  writeError = (message) => process.stderr.write(message),
} = {}) {
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error("Ao menos um processo de desenvolvimento deve ser supervisionado.");
  }

  const processTrees = children.map(({ child }) => ({
    child,
    processGroupId: Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : undefined,
  }));
  const processTreeByChild = new Map(processTrees.map((tree) => [tree.child, tree]));
  const pendingPosixProcessGroups = new Set(
    platform === "win32"
      ? []
      : processTrees
          .map(({ processGroupId }) => processGroupId)
          .filter((processGroupId) => processGroupId !== undefined),
  );
  const runningChildren = new Set(children.map(({ child }) => child));
  let completionResolved = false;
  let forceShutdownTimer;
  let resolveCompletion;
  let shuttingDown = false;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  function reportTerminationFailure() {
    writeError("Não foi possível encerrar uma árvore de processos de desenvolvimento.\n");
  }

  function signalPosixProcessGroup(processGroupId, signal) {
    try {
      signalProcessGroup(-processGroupId, signal);
      return;
    } catch (error) {
      if (isMissingProcessError(error)) {
        pendingPosixProcessGroups.delete(processGroupId);
        return;
      }

      reportTerminationFailure();
    }
  }

  function signalProcessTree({ child, processGroupId }, signal) {
    if (platform !== "win32") {
      if (processGroupId !== undefined) {
        signalPosixProcessGroup(processGroupId, signal);
      }
      return;
    }

    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      return;
    }

    try {
      terminateWindowsTree(child.pid, { systemRoot });
    } catch (error) {
      if (!isMissingProcessError(error)) {
        reportTerminationFailure();
      }
    }
  }

  function forgetStoppedPosixProcessGroup(child) {
    if (platform === "win32") {
      return;
    }

    const processGroupId = processTreeByChild.get(child)?.processGroupId;
    if (processGroupId === undefined || !pendingPosixProcessGroups.has(processGroupId)) {
      return;
    }

    try {
      signalProcessGroup(-processGroupId, 0);
    } catch (error) {
      if (isMissingProcessError(error)) {
        pendingPosixProcessGroups.delete(processGroupId);
        return;
      }

      reportTerminationFailure();
    }
  }

  function removeSignalHandlers() {
    signalSource.removeListener("SIGINT", handleSigint);
    signalSource.removeListener("SIGTERM", handleSigterm);
  }

  function finishIfStopped() {
    if (completionResolved || runningChildren.size !== 0 || pendingPosixProcessGroups.size !== 0) {
      return;
    }

    if (forceShutdownTimer !== undefined) {
      clearShutdownTimeout(forceShutdownTimer);
    }
    removeSignalHandlers();
    completionResolved = true;
    resolveCompletion(exitTarget.exitCode ?? 0);
  }

  function beginShutdown(signal, exitCode) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    exitTarget.exitCode = exitCode;

    for (const processTree of processTrees) {
      if (platform !== "win32" || runningChildren.has(processTree.child)) {
        signalProcessTree(processTree, signal);
      }
    }

    forceShutdownTimer = scheduleShutdownTimeout(() => {
      if (platform === "win32") {
        for (const processTree of processTrees) {
          if (runningChildren.has(processTree.child)) {
            signalProcessTree(processTree, "SIGKILL");
          }
        }
      } else {
        for (const processGroupId of pendingPosixProcessGroups) {
          signalPosixProcessGroup(processGroupId, "SIGKILL");
        }
        pendingPosixProcessGroups.clear();
      }

      forceShutdownTimer = undefined;
      finishIfStopped();
    }, forceShutdownMilliseconds);
  }

  function handleSigint() {
    beginShutdown("SIGINT", signalExitCodes.SIGINT);
  }

  function handleSigterm() {
    beginShutdown("SIGTERM", signalExitCodes.SIGTERM);
  }

  signalSource.on("SIGINT", handleSigint);
  signalSource.on("SIGTERM", handleSigterm);

  for (const { child, name } of children) {
    child.once("error", (error) => {
      writeError(`Falha ao iniciar ${name}: ${error.message}\n`);
      beginShutdown("SIGTERM", 1);
    });

    child.once("close", (code, signal) => {
      runningChildren.delete(child);

      if (!shuttingDown) {
        const exitCode = code ?? 1;
        const reason = signal === null ? `código ${exitCode}` : `sinal ${signal}`;
        writeError(`${name} encerrou com ${reason}; encerrando os demais processos.\n`);
        beginShutdown("SIGTERM", exitCode);
      }

      forgetStoppedPosixProcessGroup(child);
      finishIfStopped();
    });
  }

  return { beginShutdown, completion };
}
