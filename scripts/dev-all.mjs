import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  localDevelopmentNpmRunArguments,
  readLocalDevelopmentEnvironmentFile,
} from "./local-development-environment.mjs";
import { resolveTrustedNpmCliLaunch } from "./trusted-npm-cli.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const trustedNpm = resolveTrustedNpmCliLaunch({ repositoryRoot });
const commands = [
  {
    environmentPath: resolve(repositoryRoot, ".env.local"),
    expectedApplicationUrl: "http://127.0.0.1:3000",
    name: "aplicação pública",
    scriptName: "dev",
  },
  {
    environmentPath: resolve(repositoryRoot, "apps/backoffice/.env.local"),
    expectedApplicationUrl: "http://127.0.0.1:3001",
    name: "backoffice",
    scriptName: "dev",
    workspaceName: "@set-livre/backoffice",
  },
].map(({ environmentPath, expectedApplicationUrl, scriptName, workspaceName, ...command }) => {
  const environment = readLocalDevelopmentEnvironmentFile(
    environmentPath,
    process.env,
    expectedApplicationUrl,
  );
  return {
    ...command,
    argumentsList: localDevelopmentNpmRunArguments(
      repositoryRoot,
      scriptName,
      environment,
      workspaceName,
    ),
    environment,
  };
});

const children = commands.map(({ argumentsList, environment, name }) => ({
  child: spawn(trustedNpm.command, [...trustedNpm.argumentPrefix, ...argumentsList], {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "inherit",
  }),
  name,
}));

const runningChildren = new Set(children.map(({ child }) => child));
let forceShutdownTimer;
let shuttingDown = false;

function signalChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }

    child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      process.stderr.write(
        `Não foi possível encerrar um processo de desenvolvimento: ${String(error)}\n`,
      );
    }
  }
}

function beginShutdown(signal, exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  process.exitCode = exitCode;

  for (const child of runningChildren) {
    signalChild(child, signal);
  }

  forceShutdownTimer = setTimeout(() => {
    for (const child of runningChildren) {
      signalChild(child, "SIGKILL");
    }
  }, 5_000);
}

for (const { child, name } of children) {
  child.once("error", (error) => {
    process.stderr.write(`Falha ao iniciar ${name}: ${error.message}\n`);
    beginShutdown("SIGTERM", 1);
  });

  child.once("close", (code, signal) => {
    runningChildren.delete(child);

    if (!shuttingDown) {
      const exitCode = code ?? 1;
      const reason = signal === null ? `código ${exitCode}` : `sinal ${signal}`;
      process.stderr.write(`${name} encerrou com ${reason}; encerrando os demais processos.\n`);
      beginShutdown("SIGTERM", exitCode);
    }

    if (runningChildren.size === 0 && forceShutdownTimer !== undefined) {
      clearTimeout(forceShutdownTimer);
    }
  });
}

process.on("SIGINT", () => beginShutdown("SIGINT", 130));
process.on("SIGTERM", () => beginShutdown("SIGTERM", 143));
