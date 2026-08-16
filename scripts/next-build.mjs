import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveTrustedNextCliLaunch } from "./local-development-server.mjs";
import {
  removeNextBuildCache,
  resolveAuthorizedNextApplicationRoot,
} from "./remove-next-build-cache.mjs";

const defaultRepositoryRoot = resolve(import.meta.dirname, "..");

export function runNextBuildWithCacheCleanup({
  applicationRoot = process.cwd(),
  buildEnvironment = process.env,
  executeBuild = execFileSync,
  removeCache = removeNextBuildCache,
  repositoryRoot = defaultRepositoryRoot,
  resolveNextLaunch = resolveTrustedNextCliLaunch,
} = {}) {
  const authorizedRoots = resolveAuthorizedNextApplicationRoot({
    applicationRoot,
    repositoryRoot,
  });

  let buildFailure;
  try {
    const trustedNext = resolveNextLaunch({
      applicationManifestPath: resolve(authorizedRoots.applicationRoot, "package.json"),
      repositoryRoot: authorizedRoots.repositoryRoot,
    });
    executeBuild(trustedNext.command, [...trustedNext.argumentPrefix, "build"], {
      cwd: authorizedRoots.applicationRoot,
      env: buildEnvironment,
      stdio: "inherit",
    });
  } catch (error) {
    buildFailure = error;
  }

  let cleanupFailure;
  try {
    removeCache({
      applicationRoot: authorizedRoots.applicationRoot,
      repositoryRoot: authorizedRoots.repositoryRoot,
    });
  } catch (error) {
    cleanupFailure = error;
  }

  if (buildFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [buildFailure, cleanupFailure],
      "O build Next falhou e o cache transitório também não pôde ser removido.",
    );
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
  if (buildFailure !== undefined) {
    throw buildFailure;
  }
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("O build Next protegido não aceita argumentos.");
    }
    runNextBuildWithCacheCleanup();
  } catch {
    process.stderr.write("O build Next protegido não pôde ser concluído.\n");
    process.exitCode = 1;
  }
}
