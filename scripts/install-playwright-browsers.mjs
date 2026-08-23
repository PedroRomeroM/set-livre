import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createTrustedCliEnvironment,
  resolveTrustedRepositoryCliLaunch,
} from "./trusted-npm-cli.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const playwrightCliEntrypoint = resolve(repositoryRoot, "node_modules/@playwright/test/cli.js");
const browserNames = ["chromium", "firefox", "webkit"];

export function playwrightBrowserInstallArguments(platform = process.platform) {
  if (platform === "win32") {
    return ["install", ...browserNames];
  }
  if (platform === "linux") {
    return ["install", "--with-deps", ...browserNames];
  }
  throw new Error(`A instalação dos browsers Playwright não suporta a plataforma ${platform}.`);
}

function validateInstalledPlaywrightCli({ platform = process.platform } = {}) {
  const launch = resolveTrustedRepositoryCliLaunch({
    cliRelativePath: "cli.js",
    dependencyName: "@playwright/test",
    platform,
    repositoryRoot,
  });
  if (launch.cliPath !== playwrightCliEntrypoint || launch.command !== process.execPath) {
    throw new Error("A CLI Playwright instalada diverge do contrato físico esperado.");
  }
}

export function installPlaywrightBrowsers({
  environment = process.env,
  executeCommand = execFileSync,
  platform = process.platform,
  validateCli = validateInstalledPlaywrightCli,
} = {}) {
  const argumentsList = playwrightBrowserInstallArguments(platform);
  validateCli({ platform });
  executeCommand(process.execPath, [playwrightCliEntrypoint, ...argumentsList], {
    cwd: repositoryRoot,
    env: createTrustedCliEnvironment(environment, { platform }),
    stdio: "inherit",
  });
}

const invokedModuleUrl =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (import.meta.url === invokedModuleUrl) {
  installPlaywrightBrowsers();
}
