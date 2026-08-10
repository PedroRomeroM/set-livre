import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  localDevelopmentNpmRunArguments,
  readLocalDevelopmentEnvironmentFile,
} from "./local-development-environment.mjs";
import { resolveTrustedNpmCliLaunch } from "./trusted-npm-cli.mjs";

const defaultRepositoryRoot = resolve(import.meta.dirname, "..");
const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function playwrightWebServerApplication(application, repositoryRoot) {
  if (application === "web") {
    return {
      environmentPath: resolve(repositoryRoot, ".env.local"),
      expectedApplicationUrl: "http://127.0.0.1:3000",
      scriptName: "dev",
    };
  }
  if (application === "backoffice") {
    return {
      environmentPath: resolve(repositoryRoot, "apps/backoffice/.env.local"),
      expectedApplicationUrl: "http://127.0.0.1:3001",
      scriptName: "dev",
      workspaceName: "@set-livre/backoffice",
    };
  }
  throw new Error("A aplicação solicitada pelo webServer Playwright é inválida.");
}

export function createPlaywrightWebServerLaunch({
  application,
  inheritedEnvironment = process.env,
  repositoryRoot = defaultRepositoryRoot,
} = {}) {
  const contract = playwrightWebServerApplication(application, repositoryRoot);
  const trustedNpm = resolveTrustedNpmCliLaunch({ repositoryRoot });
  const environment = {
    ...readLocalDevelopmentEnvironmentFile(
      contract.environmentPath,
      inheritedEnvironment,
      contract.expectedApplicationUrl,
    ),
    APP_ENV: "test",
  };

  return {
    argumentsList: [
      ...trustedNpm.argumentPrefix,
      ...localDevelopmentNpmRunArguments(
        repositoryRoot,
        contract.scriptName,
        environment,
        contract.workspaceName,
      ),
    ],
    command: trustedNpm.command,
    options: {
      cwd: repositoryRoot,
      detached: false,
      env: environment,
      stdio: "inherit",
    },
  };
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
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          env: launch.options.env,
          stdio: "ignore",
          windowsHide: true,
        });
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
      if (code !== null) {
        resolveRun(code);
        return;
      }
      resolveRun(signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143);
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
