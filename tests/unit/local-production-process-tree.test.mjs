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

function closingChild(pid, exitCode, receivedSignals = []) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = (signal) => {
    receivedSignals.push(signal);
    return true;
  };
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
    const phaseOrder = [];
    let serverStarted = false;

    await expect(
      runLocalProductionPreviewProcessFlow({
        cleanupBuild: () => phaseOrder.push("cleanup"),
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
          phaseOrder.push("server");
          serverStarted = true;
          registerProcess({ child: closingChild(611_002, 0) });
        },
        validateBuild: () => {
          phaseOrder.push("validate");
          buildValidated = true;
        },
      }),
    ).rejects.toThrow("servidor do preview encerrou prematuramente com código 1");

    expect(buildValidated).toBe(true);
    expect(phaseOrder).toEqual(["cleanup", "validate", "server"]);
    expect(serverStarted).toBe(true);
  });

  it("does not signal Windows guardians whose Job Objects already closed", async () => {
    const buildSignals = [];
    const serverSignals = [];

    await expect(
      runLocalProductionPreviewProcessFlow({
        cleanupBuild: () => {},
        platform: "win32",
        prepareBuild: () => {},
        signalSource: new EventEmitter(),
        startBuild: (registerProcess) =>
          registerProcess({ child: closingChild(611_101, 0, buildSignals) }),
        startServer: (registerProcess) =>
          registerProcess({ child: closingChild(611_102, 0, serverSignals) }),
        validateBuild: () => {},
      }),
    ).rejects.toThrow("servidor do preview encerrou prematuramente com código 1");

    expect(buildSignals).toEqual([]);
    expect(serverSignals).toEqual([]);
  });

  it("records SIGHUP inside the build factory before a process can escape supervision", async () => {
    const signalSource = new EventEmitter();
    const child = new EventEmitter();
    child.exitCode = null;
    child.pid = 622_001;
    child.signalCode = null;
    let cleanupCount = 0;
    let handlersWereInstalledBeforeFactory = false;
    let serverStarted = false;

    await expect(
      runLocalProductionPreviewProcessFlow({
        cleanupBuild: () => {
          cleanupCount += 1;
        },
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
    expect(cleanupCount).toBe(1);
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
        cleanupBuild: () => {},
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

  it("always cleans the build cache before validating or starting the server", async () => {
    let cleanupCount = 0;
    let serverStarted = false;

    await expect(
      runLocalProductionPreviewProcessFlow({
        cleanupBuild: () => {
          cleanupCount += 1;
        },
        platform: "linux",
        prepareBuild: () => {},
        signalProcessGroup: (_pid, signal) => {
          if (signal === 0) {
            throw missingProcessGroup();
          }
        },
        signalSource: new EventEmitter(),
        startBuild: (registerProcess) => registerProcess({ child: closingChild(633_001, 1) }),
        startServer: () => {
          serverStarted = true;
        },
        validateBuild: () => {
          throw new Error("a validação não deveria iniciar");
        },
      }),
    ).rejects.toThrow("build fresco do preview encerrou com código 1");

    expect(cleanupCount).toBe(1);
    expect(serverStarted).toBe(false);
  });

  it("stops a successful build when cache cleanup fails", async () => {
    let serverStarted = false;

    await expect(
      runLocalProductionPreviewProcessFlow({
        cleanupBuild: () => {
          throw new Error("falha sintética do cleanup");
        },
        platform: "linux",
        prepareBuild: () => {},
        signalProcessGroup: (_pid, signal) => {
          if (signal === 0) {
            throw missingProcessGroup();
          }
        },
        signalSource: new EventEmitter(),
        startBuild: (registerProcess) => registerProcess({ child: closingChild(633_101, 0) }),
        startServer: () => {
          serverStarted = true;
        },
        validateBuild: () => {
          throw new Error("a validação não deveria iniciar");
        },
      }),
    ).rejects.toThrow("falha sintética do cleanup");

    expect(serverStarted).toBe(false);
  });

  it("preserves simultaneous preview build and cache cleanup failures", async () => {
    let failure;

    try {
      await runLocalProductionPreviewProcessFlow({
        cleanupBuild: () => {
          throw new Error("falha sintética do cleanup");
        },
        platform: "linux",
        prepareBuild: () => {},
        signalProcessGroup: (_pid, signal) => {
          if (signal === 0) {
            throw missingProcessGroup();
          }
        },
        signalSource: new EventEmitter(),
        startBuild: (registerProcess) => registerProcess({ child: closingChild(633_201, 1) }),
        startServer: () => {
          throw new Error("o servidor não deveria iniciar");
        },
        validateBuild: () => {
          throw new Error("a validação não deveria iniciar");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error) => error.message)).toEqual([
      "O build fresco do preview encerrou com código 1.",
      "falha sintética do cleanup",
    ]);
  });
});
