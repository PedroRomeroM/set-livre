import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const lockWorker = resolve(import.meta.dirname, "../fixtures/release-lock-worker.mjs");
const tarWorker = resolve(import.meta.dirname, "../fixtures/release-tar-worker.mjs");
const temporaryRoots = [];
const children = [];

function temporaryRoot(prefix) {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function startLockWorker(argumentsList) {
  const child = spawn(process.execPath, [lockWorker, ...argumentsList], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const completion = new Promise((resolveCompletion) => {
    child.on("close", (code, signal) => {
      resolveCompletion({ code, signal, stderr, stdout });
    });
  });
  return { child, completion };
}

async function waitForPaths(paths) {
  const deadline = Date.now() + 5_000;
  while (paths.some((path) => !existsSync(path))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timeout aguardando fixtures: ${paths.join(", ")}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("release process serialization", () => {
  it("serializes two real processes before they publish the same immutable artifact", async () => {
    const root = temporaryRoot("set-livre-release-lock-");
    const artifactsRoot = resolve(root, ".artifacts");
    const archivePath = resolve(artifactsRoot, "release.tar.gz");
    const goPath = resolve(root, "go");
    const workers = ["first", "second"].map((name) => {
      const readyPath = resolve(root, `${name}.ready`);
      const resultPath = resolve(root, `${name}.json`);
      return {
        readyPath,
        resultPath,
        ...startLockWorker([
          artifactsRoot,
          readyPath,
          goPath,
          resultPath,
          archivePath,
          "canonical-release",
        ]),
      };
    });
    mkdirSync(artifactsRoot, { mode: 0o700 });

    await waitForPaths(workers.map(({ readyPath }) => readyPath));
    writeFileSync(goPath, "go\n", { encoding: "utf8", flag: "wx" });
    const outcomes = await Promise.all(workers.map(({ completion }) => completion));

    expect(outcomes).toEqual([
      expect.objectContaining({ code: 0, signal: null }),
      expect.objectContaining({ code: 0, signal: null }),
    ]);
    const intervals = workers
      .map(({ resultPath }) => JSON.parse(readFileSync(resultPath, "utf8")))
      .sort((left, right) => left.startedAt - right.startedAt);
    expect(intervals[1].startedAt).toBeGreaterThanOrEqual(intervals[0].finishedAt);
    expect(readFileSync(archivePath, "utf8")).toBe("canonical-release");
    const lockInformation = lstatSync(resolve(artifactsRoot, "release.lock"));
    expect(lockInformation.isFile()).toBe(true);
    expect(lockInformation.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(lockInformation.mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the first immutable artifact when concurrent candidates diverge", async () => {
    const root = temporaryRoot("set-livre-release-divergent-");
    const artifactsRoot = resolve(root, ".artifacts");
    const archivePath = resolve(artifactsRoot, "release.tar.gz");
    const goPath = resolve(root, "go");
    mkdirSync(artifactsRoot, { mode: 0o700 });
    const workers = ["candidate-a", "candidate-b"].map((candidate) => {
      const readyPath = resolve(root, `${candidate}.ready`);
      return {
        readyPath,
        ...startLockWorker([
          artifactsRoot,
          readyPath,
          goPath,
          resolve(root, `${candidate}.json`),
          archivePath,
          candidate,
        ]),
      };
    });

    await waitForPaths(workers.map(({ readyPath }) => readyPath));
    writeFileSync(goPath, "go\n", { encoding: "utf8", flag: "wx" });
    const outcomes = await Promise.all(workers.map(({ completion }) => completion));

    expect(outcomes.map(({ code }) => code).sort()).toEqual([0, 1]);
    expect(outcomes.find(({ code }) => code === 1)?.stderr).toContain("conteúdo divergente");
    expect(["candidate-a", "candidate-b"]).toContain(readFileSync(archivePath, "utf8"));
  });
});

describe("release archive modes", () => {
  it("produces identical archives from source trees created under different umasks", () => {
    const workspaces = ["022", "077"].map((umaskValue) => {
      const workspace = temporaryRoot(`set-livre-release-umask-${umaskValue}-`);
      const result = spawnSync(process.execPath, [tarWorker, workspace, umaskValue], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout.trim());
    });

    expect(workspaces[0].directoryMode).not.toBe(workspaces[1].directoryMode);
    expect(workspaces[0].regularMode).not.toBe(workspaces[1].regularMode);
    expect(workspaces[0].executableMode).not.toBe(workspaces[1].executableMode);
    expect(sha256(workspaces[0].archivePath)).toBe(sha256(workspaces[1].archivePath));

    const listings = workspaces.map(({ archivePath }) =>
      spawnSync("tar", ["--numeric-owner", "-tvzf", archivePath], { encoding: "utf8" }),
    );
    expect(listings.map(({ status }) => status)).toEqual([0, 0]);
    expect(listings[0].stdout).toBe(listings[1].stdout);
    expect(listings[0].stdout).toContain("drwxr-xr-x");
    expect(listings[0].stdout).toContain("-rw-r--r--");
    expect(listings[0].stdout).toContain("-rwxr-xr-x");
  });
});
