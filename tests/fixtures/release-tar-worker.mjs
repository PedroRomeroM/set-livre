import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  deterministicReleaseTarArguments,
  operationalEnvironment,
} from "../../scripts/release-guards.mjs";

const [workspace, umaskValue] = process.argv.slice(2);
if (workspace === undefined || umaskValue === undefined || !/^[0-7]{3}$/u.test(umaskValue)) {
  throw new Error("Argumentos inválidos para o worker de modos da release.");
}

process.umask(Number.parseInt(umaskValue, 8));
const artifactsRoot = resolve(workspace, ".artifacts");
const releaseRoot = resolve(artifactsRoot, "release");
const nestedDirectory = resolve(releaseRoot, "app/bin");
const regularFile = resolve(releaseRoot, "app/config.json");
const executableFile = resolve(nestedDirectory, "start.sh");
const archivePath = resolve(workspace, "release.tar.gz");
mkdirSync(nestedDirectory, { recursive: true });
writeFileSync(regularFile, '{"status":"ready"}\n', "utf8");
writeFileSync(executableFile, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });

const commitTimestamp = "1700000000";
execFileSync(
  "tar",
  deterministicReleaseTarArguments({
    archivePath,
    artifactsRoot,
    commitTimestamp,
    releaseRoot,
  }),
  {
    env: { ...operationalEnvironment(process.env), SOURCE_DATE_EPOCH: commitTimestamp },
    stdio: "inherit",
  },
);

process.stdout.write(
  `${JSON.stringify({
    archivePath,
    directoryMode: lstatSync(nestedDirectory).mode & 0o777,
    executableMode: lstatSync(executableFile).mode & 0o777,
    regularMode: lstatSync(regularFile).mode & 0o777,
  })}\n`,
);
