import { spawn } from "node:child_process";
import { constants as operatingSystemConstants } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createLocalDevelopmentServerLaunch } from "./local-development-server.mjs";
import { terminateWindowsProcessTree } from "./windows-process-tree.mjs";

const defaultRepositoryRoot = resolve(import.meta.dirname, "..");
const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function exitCodeForUnexpectedClose(code, signal) {
  if (code !== null) {
    return code === 0 ? 1 : code;
  }

  const signalNumber = signal === null ? undefined : operatingSystemConstants.signals[signal];
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}

export function createPlaywrightWebServerLaunch({
  application,
  inheritedEnvironment = process.env,
  repositoryRoot = defaultRepositoryRoot,
} = {}) {
  return createLocalDevelopmentServerLaunch({
    application,
    detached: false,
    inheritedEnvironment,
    repositoryRoot,
    runtimeMode: "test",
  });
}

export async function runPlaywrightWebServer({
  application,
  forceShutdownMilliseconds = 5_000,
  inheritedEnvironment = process.env,
  platform = process.platform,
  repositoryRoot = defaultRepositoryRoot,
  signalProcessGroup = process.kill,
  signalSource = process,
  spawnProcess = spawn,
  terminateWindowsTree = terminateWindowsProcessTree,
} = {}) {
  const launch = createPlaywrightWebServerLaunch({
    application,
    inheritedEnvironment,
    repositoryRoot,
  });
  return new Promise((resolveRun, rejectRun) => {
    let child;
    let forceShutdownTimer;
    let requestedSignal;
    let settled = false;

    function signalChildTree(signal) {
      if (child?.pid === undefined) {
        return;
      }
      if (platform === "win32") {
        try {
          terminateWindowsTree(child.pid, {
            systemRoot: launch.options.env.SystemRoot ?? launch.options.env.SYSTEMROOT,
          });
        } catch {
          // O timeout repetirá a tentativa sem expor ambiente ou detalhes do processo.
        }
        return;
      }

      try {
        signalProcessGroup(-process.pid, signal);
      } catch {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill(signal);
          } catch {
            // O timeout ainda tentará o encerramento forçado sem expor detalhes do processo.
          }
        }
      }
    }

    function removeSignalHandlers() {
      signalSource.removeListener("SIGHUP", handleSighup);
      signalSource.removeListener("SIGINT", handleSigint);
      signalSource.removeListener("SIGTERM", handleSigterm);
    }

    function cleanup() {
      removeSignalHandlers();
      if (forceShutdownTimer !== undefined) {
        clearTimeout(forceShutdownTimer);
      }
    }

    function requestShutdown(signal) {
      if (requestedSignal !== undefined) {
        return;
      }
      requestedSignal = signal;
      signalChildTree(signal);
      forceShutdownTimer = setTimeout(() => signalChildTree("SIGKILL"), forceShutdownMilliseconds);
      forceShutdownTimer.unref();
    }

    function handleSighup() {
      requestShutdown("SIGHUP");
    }

    function handleSigint() {
      requestShutdown("SIGINT");
    }

    function handleSigterm() {
      requestShutdown("SIGTERM");
    }

    signalSource.on("SIGHUP", handleSighup);
    signalSource.on("SIGINT", handleSigint);
    signalSource.on("SIGTERM", handleSigterm);

    try {
      child = spawnProcess(launch.command, launch.argumentsList, launch.options);
    } catch {
      settled = true;
      cleanup();
      rejectRun(new Error("Não foi possível iniciar o webServer Playwright isolado."));
      return;
    }

    child.once("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectRun(new Error("Não foi possível iniciar o webServer Playwright isolado."));
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      if (requestedSignal !== undefined) {
        if (platform !== "win32") {
          try {
            signalProcessGroup(-process.pid, "SIGKILL");
            return;
          } catch {
            // O fallback preserva o código do sinal se o processo não liderar um grupo POSIX.
          }
        }
        resolveRun(signalExitCodes[requestedSignal]);
        return;
      }
      resolveRun(exitCodeForUnexpectedClose(code, signal));
    });
  });
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Uso inválido do wrapper Playwright.");
    }
    process.exitCode = await runPlaywrightWebServer({
      application: process.argv[2],
    });
  } catch {
    process.stderr.write("O webServer Playwright isolado não pôde ser iniciado.\n");
    process.exitCode = 1;
  }
}
