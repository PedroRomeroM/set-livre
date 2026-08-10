import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runLocalProductionServer } from "./local-development-server.mjs";

const signalExitCodes = new Set([129, 130, 143]);

export async function runLocalProductionServerCli({
  application,
  argumentCount,
  exitTarget = process,
  runServer = runLocalProductionServer,
  writeError = (message) => process.stderr.write(message),
} = {}) {
  try {
    if (argumentCount !== 3) {
      throw new Error("Uso inválido do launcher de preview de produção.");
    }
    exitTarget.exitCode = await runServer({ application });
  } catch (error) {
    writeError("O preview local de produção não pôde ser iniciado com segurança.\n");
    const exitCode = error instanceof Error && "exitCode" in error ? error.exitCode : undefined;
    exitTarget.exitCode =
      Number.isSafeInteger(exitCode) && signalExitCodes.has(exitCode) ? exitCode : 1;
  }
  return exitTarget.exitCode;
}

const executedPath = process.argv[1];
if (executedPath !== undefined && pathToFileURL(resolve(executedPath)).href === import.meta.url) {
  await runLocalProductionServerCli({
    application: process.argv[2],
    argumentCount: process.argv.length,
  });
}
