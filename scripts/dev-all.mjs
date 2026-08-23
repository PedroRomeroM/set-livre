import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  spawnSupervisedProcess,
  superviseDevelopmentProcesses,
} from "./development-process-tree.mjs";
import { createLocalDevelopmentServerLaunch } from "./local-development-server.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const launches = ["web", "backoffice"].map((application) =>
  createLocalDevelopmentServerLaunch({
    application,
    inheritedEnvironment: process.env,
    repositoryRoot,
  }),
);

const children = launches.map(({ argumentsList, command, name, options }) => ({
  child: spawnSupervisedProcess(command, argumentsList, options, { spawnProcess: spawn }),
  name,
}));
const exitTarget = {};
const supervisor = superviseDevelopmentProcesses({ children, exitTarget });
process.exitCode = await supervisor.completion;
