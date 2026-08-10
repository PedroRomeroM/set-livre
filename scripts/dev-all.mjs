import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { superviseDevelopmentProcesses } from "./development-process-tree.mjs";
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
const supervisor = superviseDevelopmentProcesses({ children });
await supervisor.completion;
