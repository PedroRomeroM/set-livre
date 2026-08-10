import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runLocalProductionPreviewProcessFlow } from "../../scripts/local-production-process-tree.mjs";

const temporaryRoots = [];
const processGroups = [];
const descendantPids = [];

afterEach(() => {
  for (const processGroupId of processGroups.splice(0)) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // O fluxo deve ter encerrado o grupo completo.
    }
  }
  for (const pid of descendantPids.splice(0)) {
    if (processExists(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function missingProcessGroup() {
  const error = new Error("missing process group");
  error.code = "ESRCH";
  return error;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitFor(predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("O processo de preview não atingiu o estado esperado no prazo.");
}

async function assertPortCanBeRebound(port) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

function closingChild(pid, exitCode) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = pid;
  child.signalCode = null;
  queueMicrotask(() => {
    child.exitCode = exitCode;
    child.emit("close", exitCode, null);
  });
  return child;
}

describe("local production preview process flow", () => {
  it("preserves signal exits in the real CLI wrapper and maps ordinary failures to 1", () => {
    const workerPath = resolve(import.meta.dirname, "../fixtures/local-production-cli-worker.mjs");
    for (const exitCode of [129, 130, 143]) {
      expect(spawnSync(process.execPath, [workerPath, String(exitCode)]).status).toBe(exitCode);
    }
    expect(spawnSync(process.execPath, [workerPath, "premature"]).status).toBe(1);
    expect(spawnSync(process.execPath, [workerPath, "ordinary"]).status).toBe(1);
  });

  it("accepts build code 0 but rejects a natural server exit with code 0", async () => {
    let buildValidated = false;
    let serverStarted = false;

    await expect(
      runLocalProductionPreviewProcessFlow({
        platform: "linux",
        prepareBuild: () => {},
        signalProcessGroup: (_pid, signal) => {
          if (signal === 0) {
            throw missingProcessGroup();
          }
        },
        signalSource: new EventEmitter(),
        startBuild: (registerProcess) => registerProcess({ child: closingChild(611_001, 0) }),
        startServer: (registerProcess) => {
          serverStarted = true;
          registerProcess({ child: closingChild(611_002, 0) });
        },
        validateBuild: () => {
          buildValidated = true;
        },
      }),
    ).rejects.toThrow("servidor do preview encerrou prematuramente com código 1");

    expect(buildValidated).toBe(true);
    expect(serverStarted).toBe(true);
  });

  it("attempts cleanup for both retained Windows trees after their roots exit with code 0", async () => {
    const logicalDescendants = new Map([
      [611_101, 711_101],
      [611_102, 711_102],
    ]);
    const terminatedWindowsTrees = [];

    await expect(
      runLocalProductionPreviewProcessFlow({
        platform: "win32",
        prepareBuild: () => {},
        signalSource: new EventEmitter(),
        startBuild: (registerProcess) => registerProcess({ child: closingChild(611_101, 0) }),
        startServer: (registerProcess) => registerProcess({ child: closingChild(611_102, 0) }),
        systemRoot: "C:\\Windows",
        terminateWindowsTree: (pid, options) => {
          const descendantPid = logicalDescendants.get(pid);
          logicalDescendants.delete(pid);
          terminatedWindowsTrees.push({ descendantPid, options, pid });
        },
        validateBuild: () => {},
      }),
    ).rejects.toThrow("servidor do preview encerrou prematuramente com código 1");

    expect(terminatedWindowsTrees).toEqual([
      { descendantPid: 711_101, options: { systemRoot: "C:\\Windows" }, pid: 611_101 },
      { descendantPid: 711_102, options: { systemRoot: "C:\\Windows" }, pid: 611_102 },
    ]);
    expect(logicalDescendants.size).toBe(0);
  });

  it("records SIGHUP inside the build factory before a process can escape supervision", async () => {
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    child.exitCode = null;
    child.pid = 622_001;
    child.signalCode = null;
    let handlersWereInstalledBeforeFactory = false;
    let serverStarted = false;

    await expect(
      runLocalProductionPreviewProcessFlow({
        platform: "linux",
        prepareBuild: () => {},
        signalProcessGroup: (_pid, signal) => {
          if (signal === "SIGHUP") {
            queueMicrotask(() => {
              child.exitCode = 0;
              child.emit("close", 0, null);
            });
            return;
          }
          if (signal === 0) {
            throw missingProcessGroup();
          }
        },
        signalSource,
        startBuild: (registerProcess) => {
          handlersWereInstalledBeforeFactory = signalSource.listenerCount("SIGHUP") > 0;
          signalSource.emit("SIGHUP");
          registerProcess({ child });
        },
        startServer: () => {
          serverStarted = true;
        },
        validateBuild: () => {},
      }),
    ).rejects.toMatchObject({ exitCode: 129 });

    expect(handlersWereInstalledBeforeFactory).toBe(true);
    expect(serverStarted).toBe(false);
    expect(signalSource.listenerCount("SIGHUP")).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "removes a detached descendant and releases its port after SIGHUP",
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), "set-livre-preview-process-"));
      temporaryRoots.push(root);
      const parentPidPath = resolve(root, "parent.pid");
      const leafPidPath = resolve(root, "leaf.pid");
      const portPath = resolve(root, "leaf.port");
      const leafSignalPath = resolve(root, "leaf.sighup");
      const leafScriptPath = resolve(root, "leaf.cjs");
      const parentScriptPath = resolve(root, "parent.cjs");
      writeFileSync(
        leafScriptPath,
        `const fs = require("node:fs"); const { createServer } = require("node:net"); fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(process.pid)); const server = createServer(); server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port))); process.on("SIGHUP", () => fs.writeFileSync(${JSON.stringify(leafSignalPath)}, "seen"));\n`,
      );
      writeFileSync(
        parentScriptPath,
        `const fs = require("node:fs"); const { spawn } = require("node:child_process"); fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid)); spawn(process.execPath, [${JSON.stringify(leafScriptPath)}], { stdio: "ignore" }); process.on("SIGHUP", () => process.exit(0)); setInterval(() => {}, 1000);\n`,
      );

      const signalSource = new EventEmitter();
      let handlersWereInstalledBeforeServerSpawn = false;
      const run = runLocalProductionPreviewProcessFlow({
        forceShutdownMilliseconds: 150,
        prepareBuild: () => {},
        signalSource,
        startBuild: (registerProcess) => {
          const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
            detached: true,
            stdio: "ignore",
          });
          processGroups.push(child.pid);
          registerProcess({ child });
        },
        startServer: (registerProcess) => {
          handlersWereInstalledBeforeServerSpawn = signalSource.listenerCount("SIGHUP") > 0;
          const child = spawn(process.execPath, [parentScriptPath], {
            detached: true,
            stdio: "ignore",
          });
          processGroups.push(child.pid);
          registerProcess({ child });
          void waitFor(() => existsSync(leafPidPath) && existsSync(portPath)).then(() => {
            descendantPids.push(Number(readFileSync(leafPidPath, "utf8")));
            signalSource.emit("SIGHUP");
          });
        },
        validateBuild: () => {},
      });

      await expect(run).rejects.toMatchObject({ exitCode: 129 });
      expect(handlersWereInstalledBeforeServerSpawn).toBe(true);
      const parentPid = Number(readFileSync(parentPidPath, "utf8"));
      const leafPid = Number(readFileSync(leafPidPath, "utf8"));
      const port = Number(readFileSync(portPath, "utf8"));
      await waitFor(() => !processExists(parentPid) && !processExists(leafPid));
      await assertPortCanBeRebound(port);
      expect(readFileSync(leafSignalPath, "utf8")).toBe("seen");
      expect(signalSource.listenerCount("SIGHUP")).toBe(0);
    },
    10_000,
  );
});
