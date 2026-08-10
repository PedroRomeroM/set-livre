import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { withExclusiveReleaseLock } from "../../scripts/release-guards.mjs";

const [artifactsRoot, readyPath, goPath, resultPath, archivePath, candidate] =
  process.argv.slice(2);
if (
  artifactsRoot === undefined ||
  readyPath === undefined ||
  goPath === undefined ||
  resultPath === undefined ||
  archivePath === undefined ||
  candidate === undefined
) {
  throw new Error("Argumentos incompletos para o worker de concorrência da release.");
}

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

writeFileSync(readyPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
const barrierDeadline = Date.now() + 5_000;
while (!existsSync(goPath)) {
  if (Date.now() >= barrierDeadline) {
    throw new Error("A barreira do teste concorrente não foi liberada.");
  }
  await delay(10);
}

await withExclusiveReleaseLock(artifactsRoot, async () => {
  const startedAt = Date.now();
  if (existsSync(archivePath)) {
    if (readFileSync(archivePath, "utf8") !== candidate) {
      throw new Error("A release imutável concorrente possui conteúdo divergente.");
    }
  } else {
    writeFileSync(archivePath, candidate, { encoding: "utf8", flag: "wx" });
  }

  await delay(200);
  writeFileSync(
    resultPath,
    `${JSON.stringify({ finishedAt: Date.now(), pid: process.pid, startedAt })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
});
